import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import {
  connectRedisStore,
  importCredentialsSnapshot,
  readCredentialRecordsByProvider,
} from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import { createRedisClaudeRotationFence } from "../../src/coordination/redis-claude-rotation-fence.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../src/core/constants.js";
import { resolveAimgrLocalStatePath, resolveAimgrRedisCachePath } from "../../src/io/paths.js";
import { fetchClaudeUsageSnapshot } from "../../src/pool/usage.js";
import {
  collectClaudeRedisAccountInventory,
  collectClaudeRedisAccountUsageStatus,
  renderClaudeRedisAccountInventory,
  renderClaudeRedisAccountUsageStatus,
  selectLeastUsedUnlockedClaudeAccount,
} from "../../src/status/claude-redis-view.js";
import {
  AIMGR_REDIS_CACHE_MAX_BYTES,
  AIMGR_REDIS_STATUS_CACHE_KIND,
  readRedisCacheEnvelope,
  writeCachedProviderUsage,
  writeCachedRedisStatusView,
} from "../../src/status/redis-cache.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-22T18:00:00.000Z");
const KEY_PREFIX = "aimgr:claude-redis-view";

function buildCredential(label, index = 0) {
  const credential = buildAnthropicClaudeCredential({
    access: `ACCESS_SECRET_${label}`,
    refresh: `REFRESH_SECRET_${label}`,
    expiresAtMs: NOW_MS + 2 * 60 * 60_000,
    emailAddress: `${label}@private.example.test`,
    organizationName: `Private ${label}`,
    organizationUuid: `org-private-${label}`,
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct-private-${label}-${index}`;
  return credential;
}

function anthropicRecord(label, { credential = buildCredential(label), health } = {}) {
  return {
    provider: ANTHROPIC_PROVIDER,
    label,
    credential,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, credential),
    policy: {
      expect: { email: `${label}@private.example.test` },
      reauth: { mode: "native-claude" },
      pool: { enabled: true },
    },
    ...(health ? { health } : {}),
  };
}

async function setup(records) {
  const homeDir = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(
    store,
    { credentials: records },
    { updatedBy: "test", observedAt: new Date(NOW_MS - 60_000).toISOString() },
  );
  const connectRedisStoreImpl = () => connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  return { homeDir, client, connectRedisStoreImpl };
}

function successSnapshot(percent = 12, resetAt = NOW_MS + 60 * 60_000) {
  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows: [
      { label: "5h", kind: "session", usedPercent: percent, resetAt, active: true },
      { label: "Week", kind: "weekly_all", usedPercent: 31, resetAt: NOW_MS + 24 * 60 * 60_000, active: true },
    ],
  };
}

test("Claude automatic selection ranks Fable separately from Opus five-hour usage", () => {
  const account = (label, fiveHourUsedPercent, fableUsedPercent, options = {}) => ({
    label,
    authState: options.authState ?? "usage_readable",
    locked: options.locked === true,
    usage: {
      ok: true,
      windows: [
        { label: "5h", kind: "session", usedPercent: fiveHourUsedPercent, active: false },
        { label: "Week", kind: "weekly_all", usedPercent: 40, active: true },
        ...(fableUsedPercent === null
          ? []
          : [{ label: "Fable", kind: "weekly_scoped", usedPercent: fableUsedPercent, active: true }]),
      ],
    },
  });
  const result = {
    accounts: [
      account("locked", 0, 0, { locked: true }),
      account("limited", 1, 1, { authState: "usage_limited" }),
      account("missing", 0, null),
      account("lower-five-hour", 2, 70),
      account("fable-tie-high-five-hour", 50, 10),
      account("fable-winner", 20, 10),
    ],
  };

  assert.deepEqual(selectLeastUsedUnlockedClaudeAccount(result, { preset: "fable" }), {
    label: "fable-winner",
    usedPercent: 10,
  });
  assert.deepEqual(selectLeastUsedUnlockedClaudeAccount(result, { preset: "opus" }), {
    label: "missing",
    usedPercent: 0,
  });
  assert.equal(selectLeastUsedUnlockedClaudeAccount({
    accounts: [account("locked", 0, 0, { locked: true })],
  }, { preset: "fable" }), null);
  assert.throws(
    () => selectLeastUsedUnlockedClaudeAccount(result),
    /requires the fable or opus preset/,
  );
});

test("Redis Claude inventory is provider-filtered, offline, candidate-safe, and strictly allowlisted", async () => {
  const ready = anthropicRecord("ready");
  ready.provenance = {
    evidenceGrade: "provider-current",
    evidenceAsOf: "2026-07-22",
    privateNote: "DO_NOT_EXPOSE_PROVENANCE_NOTE",
  };
  const candidate = {
    provider: ANTHROPIC_PROVIDER,
    label: "candidate",
    credential: {},
    identity: {},
    policy: { expect: { email: "candidate@private.example.test" }, pool: { enabled: true } },
    provenance: {
      evidenceGrade: "contradictory",
      evidenceAsOf: "2026-07-20",
    },
  };
  const { homeDir, connectRedisStoreImpl } = await setup([
    ready,
    candidate,
    {
      provider: OPENAI_CODEX_PROVIDER,
      label: "codex-only",
      credential: { access: "CODEX_ACCESS_SECRET" },
      identity: { accountId: "codex-private-id" },
    },
  ]);

  const result = await collectClaudeRedisAccountInventory({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
  });

  assert.deepEqual(result.accounts.map((account) => account.label), ["candidate", "ready"]);
  assert.equal(result.requestCount, 0);
  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.credentialReady, 1);
  assert.equal(result.counts.credentialMissing, 1);
  assert.equal(result.accounts[0].state, "credential_missing");
  assert.equal(result.accounts[0].evidenceGrade, "contradictory");
  assert.equal(result.accounts[0].evidenceAsOf, "2026-07-20");
  assert.equal(result.accounts[1].credentialReady, true);
  assert.equal(result.accounts[1].evidenceGrade, "provider-current");
  assert.deepEqual(Object.keys(result).sort(), [
    "accounts", "cacheState", "checkedAtMs", "complete", "counts", "ok", "requestCount", "source",
  ]);
  assert.deepEqual(Object.keys(result.accounts[1]).sort(), [
    "credentialReady", "evidenceAsOf", "evidenceGrade", "identityPolicyMatched", "label", "rateLimitTier",
    "source", "stale", "state", "subscriptionType", "usage", "usageObservedAtMs",
  ]);

  const serialized = `${JSON.stringify(result)}\n${renderClaudeRedisAccountInventory(result)}`;
  assert.doesNotMatch(serialized, /ACCESS_SECRET|REFRESH_SECRET|private\.example|acct-private|org-private|codex-private/i);
  assert.doesNotMatch(serialized, /"identity"|"policy"|"credential"|nativeClaudeBundle|emailAddress|organizationUuid/);
  assert.doesNotMatch(serialized, /DO_NOT_EXPOSE_PROVENANCE_NOTE|privateNote/);
});

test("Claude Redis views expose reauth_required without probing and preserve ordinary expiry", async () => {
  const marked = anthropicRecord("marked");
  marked.policy.reauth.blockedReason = "oauth_reauth_required";
  const expiredCredential = buildCredential("expired");
  expiredCredential.nativeClaudeBundle.claudeAiOauth.expiresAt = NOW_MS - 1;
  const expired = anthropicRecord("expired", { credential: expiredCredential });
  const { homeDir, connectRedisStoreImpl } = await setup([marked, expired]);

  const inventory = await collectClaudeRedisAccountInventory({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
  });
  const inventoryByLabel = new Map(inventory.accounts.map((account) => [account.label, account]));
  assert.equal(inventoryByLabel.get("marked").state, "reauth_required");
  assert.equal(inventoryByLabel.get("expired").state, "credential_expired");
  assert.equal(inventory.counts.reauthRequired, 1);
  assert.match(renderClaudeRedisAccountInventory(inventory), /reauth_required/);

  let providerRequests = 0;
  const status = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    records: [marked, expired],
    nowMs: NOW_MS,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerRequests += 1;
      throw new Error("terminal and expired rows must not probe");
    },
  });
  const statusByLabel = new Map(status.accounts.map((account) => [account.label, account]));
  assert.equal(statusByLabel.get("marked").authState, "reauth_required");
  assert.equal(statusByLabel.get("expired").authState, "credential_expired");
  assert.equal(status.requestCount, 0);
  assert.equal(providerRequests, 0);
  const rendered = renderClaudeRedisAccountUsageStatus(status);
  assert.match(rendered, /marked\s+NEEDS YOU.*aim login marked/);
  assert.match(rendered, /expired\s+AIM FIXING.*AIM will retry/);
  assert.match(rendered, /^expired\s+AIM FIXING.*\s--\s+AIM will retry$/m);
  assert.doesNotMatch(rendered, /reauth_required|credential_expired/);
  const verbose = renderClaudeRedisAccountUsageStatus(status, { verbose: true });
  assert.match(verbose, /reauth_required/);
  assert.match(verbose, /credential_expired/);
});

test("Redis Claude status skips candidates, shows live locks, disables web fallback, and reuses the shared cache", async () => {
  const { homeDir, client, connectRedisStoreImpl } = await setup([
    anthropicRecord("ready"),
    {
      provider: ANTHROPIC_PROVIDER,
      label: "candidate",
      credential: {},
      identity: {},
      policy: { expect: { email: "candidate@private.example.test" }, pool: { enabled: true } },
    },
  ]);
  writeJson(resolveAimgrLocalStatePath({ homeDir }), { targets: { claudeCli: {} } });
  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  writeCachedRedisStatusView({
    homeDir,
    cachePath,
    view: { kind: AIMGR_REDIS_STATUS_CACHE_KIND, generatedAt: "safe", accounts: [] },
  });
  const leaseStore = await connectRedisStoreImpl();
  await acquireRedisCredentialLease(leaseStore, {
    provider: ANTHROPIC_PROVIDER,
    label: "ready",
  });
  await createRedisClaudeRotationFence(leaseStore, {
    label: "ready",
    recoveryStorageId: `sha256:${"a".repeat(64)}`,
    baseTokenLineageFingerprint: `sha256:${"b".repeat(64)}`,
    baseCredentialVersion: 1,
    observedAt: "2026-07-22T17:00:00.000Z",
  });

  const calls = [];
  const fetchClaudeUsageSnapshotImpl = async (options) => {
    calls.push(options);
    return successSnapshot();
  };
  const first = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["candidate", "ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl,
  });

  assert.equal(first.requestCount, 1);
  assert.deepEqual(Object.keys(first).sort(), [
    "accounts", "cacheState", "cacheTtlSeconds", "cacheWriteFailed", "checkedAtMs", "freshRequested",
    "missingAccounts", "ok", "refreshInProgress", "requestCount", "source", "staleMaxSeconds",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].allowWebFallback, false);
  assert.deepEqual(calls[0].env, {});
  assert.equal(first.accounts[0].authState, "credential_missing");
  assert.equal(first.accounts[0].locked, false);
  assert.equal(first.accounts[0].rotationPending, false);
  assert.equal(first.accounts[1].authState, "usage_readable");
  assert.equal(first.accounts[1].locked, true);
  assert.equal(first.accounts[1].rotationPending, true);
  assert.deepEqual(first.missingAccounts, ["candidate"]);
  assert.deepEqual(Object.keys(first.accounts[1]).sort(), [
    "ageMs", "authState", "credentialExpiresAt", "credentialReady", "credentialState", "errorKind", "label",
    "lastAttemptAtMs", "localProjection", "lock", "locked", "rateLimitTier", "rotation", "rotationPending",
    "source", "stale", "subscriptionType", "usage", "usageObservedAtMs",
  ]);

  const second = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl,
  });
  assert.equal(second.requestCount, 0);
  assert.equal(calls.length, 1);
  assert.equal(second.accounts[0].source, "cache");

  const cache = readRedisCacheEnvelope({ homeDir, cachePath });
  assert.equal(cache.envelope.statusView.generatedAt, "safe");
  assert.equal(cache.envelope.providerUsage.version, 1);
  assert.ok(cache.envelope.providerUsage.providers.anthropic.ready);
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  const serializedCache = fs.readFileSync(cachePath, "utf8");
  assert.doesNotMatch(serializedCache, /ACCESS_SECRET|REFRESH_SECRET|private\.example|acct-private|org-private/i);
  const rendered = renderClaudeRedisAccountUsageStatus(first);
  assert.match(rendered, /^CLAUDE: 0 ready · 1 in use · 0 AIM fixing · 1 needs you · 0 unknown/m);
  assert.match(rendered, /candidate\s+NEEDS YOU.*aim login candidate/);
  assert.match(rendered, /ready\s+IN USE.*session active/);
  assert.doesNotMatch(rendered, /max\/max_20x|usage_readable|pending/);
  assert.match(
    renderClaudeRedisAccountUsageStatus(first, { verbose: true }),
    /ready\s+max\/max_20x\s+usage_readable\s+yes\s+pending/,
  );
  assert.ok(client.values.size > 0);
});

test("Claude human status renders the five operator states with frozen precedence", () => {
  const account = (label, overrides = {}) => ({
    label,
    authState: "usage_readable",
    credentialState: "credential_ready",
    credentialReady: true,
    locked: false,
    rotationPending: false,
    source: "cache",
    ageMs: 120_000,
    usage: { provider: ANTHROPIC_PROVIDER, ok: false, windows: [] },
    ...overrides,
  });
  const rendered = renderClaudeRedisAccountUsageStatus({
    checkedAtMs: NOW_MS,
    accounts: [
      account("ready"),
      account("active", {
        locked: true,
        authState: "reauth_required",
        credentialState: "reauth_required",
        rotationPending: true,
      }),
      account("fixing", {
        authState: "credential_expired",
        credentialState: "credential_expired",
        credentialReady: false,
      }),
      account("needs", {
        authState: "reauth_required",
        credentialState: "reauth_required",
        credentialReady: false,
        rotationPending: true,
      }),
      account("unknown", { locked: null, rotationPending: null }),
    ],
  });

  assert.match(rendered, /^CLAUDE: 1 ready · 1 in use · 1 AIM fixing · 1 needs you · 1 unknown/m);
  assert.match(rendered, /ready\s+READY.*2m\s+use now/);
  assert.match(rendered, /active\s+IN USE.*session active/);
  assert.match(rendered, /fixing\s+AIM FIXING.*AIM will retry/);
  assert.match(rendered, /needs\s+NEEDS YOU.*aim login needs/);
  assert.match(rendered, /unknown\s+UNKNOWN.*retry status/);
});

test("Claude usage status renders one fleet average across every readable window column", () => {
  const rendered = renderClaudeRedisAccountUsageStatus({
    checkedAtMs: NOW_MS,
    accounts: [
      {
        label: "alpha",
        subscriptionType: "max",
        rateLimitTier: "max_20x",
        authState: "usage_readable",
        credentialState: "credential_ready",
        credentialReady: true,
        locked: false,
        rotationPending: false,
        source: "live",
        ageMs: 0,
        usage: {
          ok: true,
          windows: [
            { label: "5h", kind: "session", usedPercent: 10, resetAt: NOW_MS + 1 * 60 * 60_000 },
            { label: "Week", kind: "weekly_all", usedPercent: 20, resetAt: NOW_MS + 2 * 24 * 60 * 60_000 },
            { label: "Fable", kind: "weekly_scoped", usedPercent: 40, resetAt: NOW_MS + 4 * 24 * 60 * 60_000 },
            { label: "Context", kind: "weekly_scoped", usedPercent: 60, resetAt: NOW_MS + 6 * 24 * 60 * 60_000 },
          ],
        },
      },
      {
        label: "beta",
        subscriptionType: "max",
        rateLimitTier: "max_20x",
        authState: "usage_readable",
        credentialState: "credential_ready",
        credentialReady: true,
        locked: false,
        rotationPending: false,
        source: "cache",
        ageMs: 120_000,
        usage: {
          ok: true,
          windows: [
            { label: "5h", kind: "session", usedPercent: 30, resetAt: NOW_MS + 3 * 60 * 60_000 },
            { label: "Fable", kind: "weekly_scoped", usedPercent: 80, resetAt: NOW_MS + 6 * 24 * 60 * 60_000 },
            { label: "Opus", kind: "weekly_scoped", usedPercent: 50 },
          ],
        },
      },
    ],
  });

  assert.match(
    rendered,
    /average\s+--\s+20%\s+2\.0h\s+20%\s+2\.0d\s+60%\s+5\.0d\s+50%\s+--\s+60%\s+6\.0d\s+--\s+--/,
  );
  assert.equal(rendered.match(/^average\s/gm)?.length, 1);
});

test("failed refresh keeps one-hour stale usage and caches provider backoff without re-aging it", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  let calls = 0;
  const success = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      return successSnapshot();
    },
  });
  assert.equal(success.accounts[0].usageObservedAtMs, NOW_MS);

  const failedAt = NOW_MS + 6 * 60_000;
  const failed = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: failedAt,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      return { provider: ANTHROPIC_PROVIDER, ok: false, status: 503, error: "RAW_PRIVATE_ERROR" };
    },
  });
  assert.equal(failed.requestCount, 1);
  assert.equal(failed.accounts[0].authState, "provider_error");
  assert.equal(failed.accounts[0].usageObservedAtMs, NOW_MS);
  assert.equal(failed.accounts[0].lastAttemptAtMs, failedAt);
  assert.equal(failed.accounts[0].source, "stale-cache");

  const repeat = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: failedAt + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      throw new Error("must not run inside backoff");
    },
  });
  assert.equal(repeat.requestCount, 0);
  assert.equal(calls, 2);
  assert.equal(repeat.accounts[0].authState, "provider_error");
  assert.equal(repeat.accounts[0].usageObservedAtMs, NOW_MS);
  assert.equal(repeat.accounts[0].ageMs, 7 * 60_000);
  assert.doesNotMatch(JSON.stringify(repeat), /RAW_PRIVATE_ERROR/);

  const offlineInventory = await collectClaudeRedisAccountInventory({
    homeDir,
    nowMs: failedAt + 6 * 60_000,
    connectRedisStoreImpl,
  });
  assert.equal(offlineInventory.accounts[0].state, "credential_ready");
  assert.equal(offlineInventory.accounts[0].usage.ok, true);
  assert.equal(offlineInventory.accounts[0].stale, true);

  const tooOld = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS + 61 * 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => ({ provider: ANTHROPIC_PROVIDER, ok: false, status: 429 }),
  });
  assert.equal(tooOld.accounts[0].usage.ok, false);
  assert.equal(tooOld.accounts[0].usageObservedAtMs, null);
});

test("fresh and an expired active window each force one bounded refresh", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  let calls = 0;
  await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      return successSnapshot(12, NOW_MS + 30_000);
    },
  });

  const resetRefresh = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      return successSnapshot(13, NOW_MS + 60 * 60_000);
    },
  });
  assert.equal(resetRefresh.requestCount, 1);

  const freshRefresh = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    fresh: true,
    nowMs: NOW_MS + 2 * 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      return successSnapshot(14, NOW_MS + 60 * 60_000);
    },
  });
  assert.equal(freshRefresh.requestCount, 1);
  assert.equal(freshRefresh.freshRequested, true);
  assert.equal(calls, 3);
});

test("unknown selected labels fail before provider work and simultaneous refreshes single-flight", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  let providerCalls = 0;
  await assert.rejects(
    collectClaudeRedisAccountUsageStatus({
      homeDir,
      selectedLabels: ["unknown"],
      nowMs: NOW_MS,
      connectRedisStoreImpl,
      fetchClaudeUsageSnapshotImpl: async () => {
        providerCalls += 1;
        return successSnapshot();
      },
    }),
    (error) => {
      assert.equal(error.message, "Unknown Claude account label.");
      return true;
    },
  );
  assert.equal(providerCalls, 0);

  let releaseProvider;
  const providerGate = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const firstPromise = collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      await providerGate;
      return successSnapshot();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
  });
  assert.equal(second.requestCount, 0);
  assert.equal(second.refreshInProgress, true);
  assert.equal(providerCalls, 1);
  releaseProvider();
  const first = await firstPromise;
  assert.equal(first.requestCount, 1);
  assert.equal(providerCalls, 1);
});

test("invalid selections fail before Redis I/O and Redis availability errors are value-free", async () => {
  const homeDir = mkTempHome();
  writeAimgrConfig({
    homeDir,
    config: { redis: { url: "redis://private-user:private-password@fake:6379", keyPrefix: KEY_PREFIX } },
  });
  let connectCalls = 0;
  for (const selectedLabels of ["ready", ["status"]]) {
    await assert.rejects(
      collectClaudeRedisAccountUsageStatus({
        homeDir,
        selectedLabels,
        connectRedisStoreImpl: async () => {
          connectCalls += 1;
          throw new Error("must not connect");
        },
      }),
      /Invalid Claude account label selection|Invalid Claude account label/,
    );
  }
  assert.equal(connectCalls, 0);

  let connectOptions;
  await assert.rejects(
    collectClaudeRedisAccountInventory({
      homeDir,
      connectRedisStoreImpl: async (options) => {
        connectOptions = options;
        throw new Error("redis://private-user:private-password@fake:6379 RAW_REDIS_ERROR");
      },
    }),
    (error) => {
      assert.equal(error.message, "Claude Redis account inventory is unavailable.");
      assert.doesNotMatch(error.message, /private|password|RAW_REDIS_ERROR/);
      return true;
    },
  );
  assert.equal(connectOptions.connectionPolicy, "observe");
  assert.equal(connectOptions.initialConnectTimeoutMs, 2_000);
});

test("uncached Redis Claude status caps concurrency at three and performs one request per account", async () => {
  const labels = ["one", "two", "three", "four", "five"];
  const { homeDir, connectRedisStoreImpl } = await setup(labels.map((label, index) =>
    anthropicRecord(label, { credential: buildCredential(label, index) })));
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async ({ allowWebFallback }) => {
      assert.equal(allowWebFallback, false);
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return successSnapshot();
    },
  });

  assert.equal(result.requestCount, 5);
  assert.equal(calls, 5);
  assert.equal(maxActive, 3);
  assert.ok(result.accounts.every((account) => account.authState === "usage_readable"));
});

test("canonical credential lineage, identity, and generation gate provider work", async () => {
  const mixedCredential = buildCredential("mixed");
  const mixed = anthropicRecord("mixed", { credential: mixedCredential });
  const partial = anthropicRecord("partial");
  partial.identity = { emailAddress: "partial@private.example.test" };
  const noExpectedEmail = anthropicRecord("no-expected-email");
  noExpectedEmail.policy.expect = {};
  const mixedPlanCredential = buildCredential("mixed-plan");
  const mixedPlan = anthropicRecord("mixed-plan", { credential: mixedPlanCredential });
  const invalidGeneration = anthropicRecord("invalid-generation");
  const { homeDir, client, connectRedisStoreImpl } = await setup([
    mixed,
    partial,
    noExpectedEmail,
    mixedPlan,
    invalidGeneration,
  ]);

  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  const invalidGenerationKey = store.keys.credential({
    provider: ANTHROPIC_PROVIDER,
    label: "invalid-generation",
  });
  const invalidGenerationRecord = JSON.parse(await client.get(invalidGenerationKey));
  invalidGenerationRecord.version = 0;
  await client.set(invalidGenerationKey, JSON.stringify(invalidGenerationRecord));

  let providerCalls = 0;
  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
  });

  assert.equal(providerCalls, 2);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(
    Object.fromEntries(result.accounts.map((account) => [account.label, account.authState])),
    {
      "invalid-generation": "credential_generation_invalid",
      mixed: "usage_readable",
      "mixed-plan": "usage_readable",
      "no-expected-email": "identity_unverified",
      partial: "identity_unverified",
    },
  );
});

test("credential generation invalidates cached auth status after an authoritative Redis update", async () => {
  const { homeDir, client, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  const seenTokens = [];
  const fetchClaudeUsageSnapshotImpl = async ({ accessToken }) => {
    seenTokens.push(accessToken);
    return successSnapshot();
  };
  await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl,
  });
  const before = readRedisCacheEnvelope({ homeDir }).envelope.providerUsage.providers.anthropic.ready.identityBinding;

  const rotatedCredential = buildCredential("ready");
  rotatedCredential.nativeClaudeBundle.claudeAiOauth.accessToken = "ROTATED_ACCESS_SECRET";
  rotatedCredential.nativeClaudeBundle.claudeAiOauth.refreshToken = "ROTATED_REFRESH_SECRET";
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  const update = await importCredentialsSnapshot(
    store,
    { credentials: [anthropicRecord("ready", { credential: rotatedCredential })] },
    {
      replaceExisting: true,
      updatedBy: "test-rotation",
      observedAt: new Date(NOW_MS + 30_000).toISOString(),
    },
  );
  assert.equal(update[0].record.version, 2);

  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["ready"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl,
  });
  const after = readRedisCacheEnvelope({ homeDir }).envelope.providerUsage.providers.anthropic.ready.identityBinding;

  assert.equal(result.requestCount, 1);
  assert.equal(seenTokens.length, 2);
  assert.equal(seenTokens[1], "ROTATED_ACCESS_SECRET");
  assert.notEqual(after, before);
});

test("duplicate stable identities fail closed even when only one alias is selected", async () => {
  const sharedCredential = buildCredential("shared");
  const one = anthropicRecord("one", { credential: sharedCredential });
  const expiredDuplicateCredential = structuredClone(sharedCredential);
  expiredDuplicateCredential.nativeClaudeBundle.claudeAiOauth.expiresAt = NOW_MS - 1_000;
  const two = anthropicRecord("two", { credential: expiredDuplicateCredential });
  one.policy.expect.email = "shared@private.example.test";
  two.policy.expect.email = "shared@private.example.test";
  const { homeDir, client, connectRedisStoreImpl } = await setup([one]);
  let providerCalls = 0;

  await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["one"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(
    store,
    { credentials: [two] },
    { updatedBy: "test-duplicate", observedAt: new Date(NOW_MS + 30_000).toISOString() },
  );

  const inventory = await collectClaudeRedisAccountInventory({
    homeDir,
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
  });
  assert.ok(inventory.accounts.every((account) => account.state === "duplicate_account"));
  assert.ok(inventory.accounts.every((account) => account.usage.ok === false));

  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["one"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.requestCount, 0);
  assert.equal(result.accounts[0].authState, "duplicate_account");
});

test("limited usage is readable and expired provider windows back off", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([
    anthropicRecord("limited"),
    anthropicRecord("expired-window"),
  ]);
  let calls = 0;
  const first = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["limited", "expired-window"],
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async ({ accessToken }) => {
      calls += 1;
      return accessToken.includes("limited")
        ? successSnapshot(100)
        : {
            provider: ANTHROPIC_PROVIDER,
            ok: true,
            windows: [
              { label: "5h", kind: "session", usedPercent: 12, resetAt: NOW_MS - 1, active: true },
              {
                label: "Week",
                kind: "weekly_all",
                usedPercent: 31,
                resetAt: NOW_MS + 24 * 60 * 60_000,
                active: true,
              },
            ],
          };
    },
  });

  assert.equal(first.requestCount, 2);
  assert.equal(first.accounts[0].authState, "usage_limited");
  assert.equal(first.accounts[1].authState, "malformed_response");
  assert.equal(first.ok, false);
  assert.deepEqual(first.missingAccounts, ["expired-window"]);

  const limitedOnly = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["limited"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      throw new Error("cached limited usage should be readable");
    },
  });
  assert.equal(limitedOnly.requestCount, 0);
  assert.equal(limitedOnly.ok, true);
  assert.deepEqual(limitedOnly.missingAccounts, []);

  const expiredRepeat = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    selectedLabels: ["expired-window"],
    nowMs: NOW_MS + 60_000,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      calls += 1;
      throw new Error("malformed provider window should back off");
    },
  });
  assert.equal(expiredRepeat.requestCount, 0);
  assert.equal(expiredRepeat.accounts[0].authState, "malformed_response");
  assert.equal(calls, 2);
});

test("unsafe cache files fail closed without probing", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  writeCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER, entries: {} });
  fs.chmodSync(cachePath, 0o644);
  let providerCalls = 0;

  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.requestCount, 0);
  assert.equal(result.accounts[0].authState, "cache_unsafe");
});

test("cache write failures are explicit after a single live provider attempt", async () => {
  const { homeDir, connectRedisStoreImpl } = await setup([anthropicRecord("ready")]);
  let providerCalls = 0;
  const result = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    nowMs: NOW_MS,
    connectRedisStoreImpl,
    fetchClaudeUsageSnapshotImpl: async () => {
      providerCalls += 1;
      return successSnapshot();
    },
    writeCachedProviderUsageImpl: () => {
      throw new Error("RAW_CACHE_WRITE_ERROR");
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.requestCount, 1);
  assert.equal(result.cacheWriteFailed, true);
  assert.equal(result.cacheState, "write_failed");
  assert.doesNotMatch(JSON.stringify(result), /RAW_CACHE_WRITE_ERROR/);
  assert.match(renderClaudeRedisAccountUsageStatus(result, { verbose: true }), /cache_write=failed/);
});

test("Redis cache envelope writers preserve each other's sections in both orders", () => {
  const homeDir = mkTempHome();
  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  const safeEntry = {
    ready: {
      identityBinding: `sha256:${"a".repeat(64)}`,
      subscriptionType: "max",
      rateLimitTier: "max_20x",
      authState: "usage_readable",
      errorKind: null,
      usageObservedAtMs: NOW_MS,
      lastAttemptAtMs: NOW_MS,
      usage: successSnapshot(),
    },
  };

  writeCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER, entries: safeEntry });
  writeCachedRedisStatusView({
    homeDir,
    cachePath,
    view: { kind: AIMGR_REDIS_STATUS_CACHE_KIND, generatedAt: "first", accounts: [] },
  });
  let envelope = readRedisCacheEnvelope({ homeDir, cachePath }).envelope;
  assert.equal(envelope.statusView.generatedAt, "first");
  assert.deepEqual(envelope.providerUsage.providers.anthropic, safeEntry);

  writeCachedRedisStatusView({
    homeDir,
    cachePath,
    view: { kind: AIMGR_REDIS_STATUS_CACHE_KIND, generatedAt: "second", accounts: [] },
  });
  writeCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER, entries: safeEntry });
  envelope = readRedisCacheEnvelope({ homeDir, cachePath }).envelope;
  assert.equal(envelope.statusView.generatedAt, "second");
  assert.deepEqual(envelope.providerUsage.providers.anthropic, safeEntry);

  writeCachedProviderUsage({
    homeDir,
    cachePath,
    provider: ANTHROPIC_PROVIDER,
    entries: {
      ready: {
        ...safeEntry.ready,
        accessToken: "CACHE_ACCESS_SECRET",
        arbitraryPrivateField: "CACHE_PRIVATE_VALUE",
        usage: {
          ...safeEntry.ready.usage,
          privateNote: "CACHE_USAGE_PRIVATE_VALUE",
        },
      },
    },
  });
  envelope = readRedisCacheEnvelope({ homeDir, cachePath }).envelope;
  assert.deepEqual(envelope.providerUsage.providers.anthropic, safeEntry);
  assert.doesNotMatch(
    fs.readFileSync(cachePath, "utf8"),
    /CACHE_ACCESS_SECRET|CACHE_PRIVATE_VALUE|CACHE_USAGE_PRIVATE_VALUE|accessToken|arbitraryPrivateField|privateNote/,
  );

  const beforeOversizedWrite = fs.readFileSync(cachePath, "utf8");
  assert.throws(
    () => writeCachedRedisStatusView({
      homeDir,
      cachePath,
      view: {
        kind: AIMGR_REDIS_STATUS_CACHE_KIND,
        generatedAt: "oversized",
        payload: "x".repeat(AIMGR_REDIS_CACHE_MAX_BYTES),
      },
    }),
    /oversized AIM Redis cache/,
  );
  assert.equal(fs.readFileSync(cachePath, "utf8"), beforeOversizedWrite);
  envelope = readRedisCacheEnvelope({ homeDir, cachePath }).envelope;
  assert.deepEqual(envelope.providerUsage.providers.anthropic, safeEntry);
});

test("provider-index reads reject records stored under inconsistent Redis keys", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  const record = {
    ...anthropicRecord("ready"),
    version: 1,
  };
  const wrongKey = `${store.keyPrefix}credential:${ANTHROPIC_PROVIDER}:wrong-label`;
  await client.set(wrongKey, JSON.stringify(record));
  await client.sAdd(store.keys.credentialsByProvider(ANTHROPIC_PROVIDER), wrongKey);

  await assert.rejects(
    readCredentialRecordsByProvider(store, ANTHROPIC_PROVIDER),
    /provider credential index is inconsistent/,
  );
});

test("Claude OAuth usage never falls back to claude.ai cookies", async () => {
  const calls = [];
  const result = await fetchClaudeUsageSnapshot({
    accessToken: "ACCESS_SECRET_MUST_NOT_ESCAPE",
    timeoutMs: 1000,
    allowWebFallback: true,
    env: {
      CLAUDE_WEB_COOKIE: "sessionKey=COOKIE_SECRET_MUST_NOT_ESCAPE",
    },
    fetchJsonWithTimeoutImpl: async (url) => {
      calls.push(url);
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "scope requirement user:profile" } }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://api.anthropic.com/api/oauth/usage");
  assert.equal(result.ok, false);
  assert.equal(result.missingScope, true);
  assert.doesNotMatch(JSON.stringify(result), /ACCESS_SECRET|COOKIE_SECRET/);
});
