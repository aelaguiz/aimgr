import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../src/core/constants.js";
import { resolveAimgrRedisCachePath } from "../../src/io/paths.js";
import { writeLocalState } from "../../src/state/local-state.js";
import {
  AIMGR_REDIS_STATUS_CACHE_KIND,
  buildRedisDiagnosticCacheView,
  buildRedisStatusView,
} from "../../src/status/redis-view.js";
import { CODEX_TEST_ENVIRONMENT, localCodexFixture, readCodexTestEnvironment } from "../helpers/codex-local.js";
import { logoutLocalCodexCredential, maintainLocalCodexCredential } from "../../src/credentials/codex-local.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { localClaudeFixture, readClaudeTestEnvironment } from "../helpers/claude-local.js";
import { renderStatusText } from "../../src/status/render.js";
import { invalidateClaudeOfflineBinding } from "../../src/network/claude-offline-binding.js";
import { writeCachedRedisStatusView } from "../../src/status/redis-cache.js";

test("Codex cache projects the legacy 168h window as Week", () => {
  const view = buildRedisDiagnosticCacheView({
    generatedAt: "2026-09-05T12:00:00.000Z",
    nowMs: Date.parse("2026-09-05T12:00:00.000Z"),
    accounts: [
      {
        label: "codex",
        provider: OPENAI_CODEX_PROVIDER,
        usage: {
          ok: true,
          windows: [{ label: "168h", usedPercent: 42 }],
        },
      },
      {
        label: "claude",
        provider: ANTHROPIC_PROVIDER,
        usage: {
          ok: true,
          windows: [{ label: "168h", usedPercent: 42 }],
        },
      },
    ],
  });

  assert.equal(view.accounts[0].usage.windows[0].label, "Week");
  assert.equal(view.accounts[1].usage.windows[0].label, "168h");
});

async function seedRedis(client, home, { plan = "pro" } = {}) {
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:status-test" });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: plan,
    },
  });
  localCodexFixture(home, "acct_boss", { access: token, idToken: token, refresh: "REFRESH_BOSS", accountId: "acct_boss", expiresAt: new Date(exp * 1000).toISOString() });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: OPENAI_CODEX_PROVIDER,
          label: "boss",
          identity: {
            accountId: "acct_boss",
            emailAddress: "cache-private@example.test",
            organizationUuid: "org-cache-private",
          },
          credential: {
            access: token,
            refresh: "REFRESH_BOSS",
            idToken: token,
            accountId: "acct_boss",
            expiresAt: new Date(exp * 1000).toISOString(),
          },
          policy: {
            expect: { email: "cache-private@example.test" },
            reauth: { mode: "manual-callback" },
            browser: { userDataDir: "/private/cache/browser/path" },
            pool: { enabled: true },
          },
          health: { status: "ready", reason: "RAW_PRIVATE_HEALTH_REASON" },
        },
      ],
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
}

test("Redis status view uses local Codex credentials, writes redacted cache, and has no session matrix", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: {
      redis: {
        url: "redis://cache-user:cache-password@fake:6379/0?token=cache-query-secret",
        keyPrefix: "aimgr:status-test",
        primaryHost: "fake",
        transport: "test",
      },
    },
  });
  writeLocalState({
    homeDir: home,
    localState: {
      targets: {
        codexCli: {
          activeLabel: "boss",
          expectedAccountId: "acct_boss",
        },
      },
    },
  });
  await seedRedis(client, home);

  const result = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    nowMs: Date.parse("2026-05-30T14:01:00.000Z"),
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });

  assert.equal(result.used, true);
  assert.equal(result.view.statePath, "redis:aimgr:status-test:");
  assert.equal(result.view.redis.status, "live");
  assert.equal(result.view.redis.url, "redis://fake:6379/0");
  assert.equal(result.view.redis.credentialCount, 1);
  assert.equal(result.view.accounts[0].label, "boss");
  assert.equal(result.view.accounts[0].plan, "pro");
  assert.equal(result.view.codexCli.activeLabel, "boss");
  assert.equal(result.view.redisCredentials[0].status, "ready");
  assert.equal(Object.hasOwn(result.view, "redisSessionMatrix"), false);
  assert.equal(Object.hasOwn(result.view, "redisMachines"), false);
  assert.equal(result.view.warnings.some((warning) => warning.kind === "codex_import_missing"), false);

  const cachePath = resolveAimgrRedisCachePath({ homeDir: home });
  const cache = fs.readFileSync(cachePath, "utf8");
  const cacheEnvelope = JSON.parse(cache);
  assert.equal(cacheEnvelope.statusView.kind, AIMGR_REDIS_STATUS_CACHE_KIND);
  assert.equal(cacheEnvelope.statusView.accounts[0].plan, "pro");
  assert.doesNotMatch(cache, /REFRESH_BOSS/);
  assert.doesNotMatch(
    cache,
    /cache-user|cache-password|cache-query-secret|cache-private@example|acct_boss|org-cache-private|private\/cache\/browser|RAW_PRIVATE_HEALTH_REASON/,
  );
  assert.doesNotMatch(cache, /"identity"|"policy"|"reason"/);
});

test("Codex Pro Max is shown from account credentials when usage has no plan", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } } });
  await seedRedis(client, home, { plan: "promax" });
  const result = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });
  assert.equal(result.view.accounts[0].plan, "promax");
  assert.match(renderStatusText(result.view), /boss\s+ready\s+promax/);
});

test("Redis status view uses diagnostic cache when Redis is unavailable", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } },
  });
  await seedRedis(client, home);
  const observedAtMs = Date.parse("2026-07-22T18:00:00.000Z");

  const live = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    nowMs: observedAtMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      [OPENAI_CODEX_PROVIDER]: {
        boss: {
          provider: OPENAI_CODEX_PROVIDER,
          ok: true,
          plan: "promax ($12.50)",
          resetCreditsAvailable: 4,
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      },
    }),
  });
  assert.equal(live.view.accounts[0].plan, "promax");
  const freshCache = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    nowMs: observedAtMs + 10_000,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => { throw new Error("unexpected probe"); },
  });
  assert.equal(freshCache.view.accounts[0].plan, "promax");
  const cached = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    nowMs: observedAtMs + 60_000,
    connectRedisStoreImpl: async () => {
      throw new Error("redis down");
    },
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });

  assert.equal(cached.used, true);
  assert.equal(cached.view.redis.status, "cache");
  assert.equal(cached.view.redis.error, "unavailable");
  assert.equal(cached.view.accounts[0].usage.resetCreditsAvailable, 4);
  assert.equal(cached.view.accounts[0].plan, "promax");
  assert.equal(cached.view.warnings.at(-1).kind, "redis_status_cache_used");

  const oldCached = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    nowMs: observedAtMs + 24 * 60 * 60_000,
    connectRedisStoreImpl: async () => {
      throw new Error("RAW_STALE_CACHE_ERROR");
    },
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });
  assert.equal(oldCached.view.redis.status, "cache");
  assert.equal(oldCached.view.redis.cacheAgeMs, 24 * 60 * 60_000 - 10_000);
});

test("live and offline status report the same local reauthorization requirement", async t => {
  const home = mkTempHome(), client = new FakeRedisClient();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } } });
  await seedRedis(client, home);
  await maintainLocalCodexCredential({ homeDir: home, accountId: "acct_boss", environment: CODEX_TEST_ENVIRONMENT }, {
    refreshBeforeMs: 24 * 3600_000, fetchJsonWithTimeoutImpl: async () => ({ ok: false, json: async () => ({ error: "invalid_grant" }) }),
  });
  const options = { homeDir: home, readCodexEnvironmentImpl: readCodexTestEnvironment,
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }) };
  const online = await buildRedisStatusView({ ...options, connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }) });
  const offline = await buildRedisStatusView({ ...options, connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  for (const { view } of [online, offline]) {
    assert.equal(view.accounts[0].credentials.status, "reauth_required");
    assert.equal(view.accounts[0].operator.status, "reauth");
    assert.equal(view.accounts[0].operator.eligible, false);
  }
});

test("offline status revalidates local login after logout and complete user-state copying", async t => {
  const home = mkTempHome(), destination = mkTempHome(), client = new FakeRedisClient();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(destination, { recursive: true, force: true }); });
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } } });
  await seedRedis(client, home);
  const deps = { homeDir: home, readCodexEnvironmentImpl: readCodexTestEnvironment,
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }) };
  await buildRedisStatusView({ ...deps, connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }) });
  const offline = { ...deps, connectRedisStoreImpl: async () => { throw new Error("offline"); } };
  const healthy = await buildRedisStatusView(offline);
  assert.equal(healthy.view.accounts[0].credentials.status, "ok");
  fs.cpSync(home, destination, { recursive: true });
  const copied = await buildRedisStatusView({ ...offline, homeDir: destination,
    readCodexEnvironmentImpl: () => ({ binding: "d".repeat(64) }) });
  assert.equal(copied.view.accounts[0].credentials.status, "login_required");
  assert.equal(copied.view.accounts[0].operator.status, "blocked");
  logoutLocalCodexCredential({ homeDir: home, accountId: "acct_boss", environment: CODEX_TEST_ENVIRONMENT });
  const loggedOut = await buildRedisStatusView(offline);
  assert.equal(loggedOut.view.accounts[0].credentials.status, "login_required");
  assert.equal(loggedOut.view.accounts[0].operator.eligible, false);
  const missingRuntime = await buildRedisStatusView({ ...offline, readCodexEnvironmentImpl: () => { throw new Error("unconfigured"); } });
  assert.equal(missingRuntime.view.accounts[0].credentials.status, "runtime_required");
});

test("ordinary Redis status routes Claude through the bounded canonical cache", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  writeAimgrConfig({
    homeDir: home,
    config: { claudeProxyProfiles: { test: { socksPort: 1085, expectedExits: ["127.0.0.2"] } }, redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-claude-test" } },
  });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:status-claude-test" });
  const credential = buildAnthropicClaudeCredential({ expiresAtMs: nowMs + 3_600_000 });
  const record = {
    provider: ANTHROPIC_PROVIDER, label: "claude", credential,
    identity: { accountUuid: "acct_boss", emailAddress: "boss@example.com", organizationUuid: "org_boss" },
    policy: { egress: { profileRef: "test" }, expect: { email: "boss@example.com" }, pool: { enabled: true } },
    health: { status: "ready", reason: null },
  };
  await importCredentialsSnapshot(store, { credentials: [record] });
  await localClaudeFixture(home, record);
  await acquireRedisCredentialLease(store, {
    provider: ANTHROPIC_PROVIDER,
    label: "claude",
  });

  let directProbeCalls = 0;
  let claudeRequests = 0;
  let proxyHealth = "running";
  const deps = {
    homeDir: home,
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    readClaudeProxyHealthImpl: async () => ({ test: proxyHealth }),
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-claude-test" }),
    probeUsageSnapshotsByProviderImpl: async (state) => {
      directProbeCalls += 1;
      assert.deepEqual(state.credentials[ANTHROPIC_PROVIDER], {});
      return { [OPENAI_CODEX_PROVIDER]: {}, [ANTHROPIC_PROVIDER]: { forbidden: true } };
    },
    fetchJsonWithTimeoutImpl: async (url, options) => {
      claudeRequests += 1;
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.match(options.headers.Authorization, /^Bearer /);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: new Date(nowMs + 3_600_000).toISOString() },
          seven_day: { utilization: 34, resets_at: new Date(nowMs + 7 * 86_400_000).toISOString() },
        }),
      };
    },
  };

  const first = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs });
  const second = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 60_000 });

  assert.equal(first.view.accounts[0].usage.ok, true);
  assert.equal(first.view.accounts[0].plan, "max/max_20x");
  assert.equal(first.view.accounts[0].usage.status, "usage_readable");
  assert.notEqual(first.view.accounts[0].lock.status, "held");
  assert.equal(first.claudeUsageStatus.accounts[0].label, "claude");
  assert.equal(first.claudeUsageStatus.accounts[0].locked, false);
  assert.equal(first.claudeUsageStatus.accounts[0].usage.ok, true);
  assert.deepEqual(first.view.accounts[0].egress, { mode: "proxy", profileRef: "test", localStatus: "configured", health: "running" });
  assert.deepEqual(first.claudeUsageStatus.accounts[0].egress, first.view.accounts[0].egress);
  const text = renderStatusText(first.view, { claudeUsageStatus: first.claudeUsageStatus });
  assert.match(text, /updated\s+proxy\s+health\s+next/);
  assert.match(text, /claude\s+READY.*\s+test\s+running\s+use now/);
  assert.equal(second.view.accounts[0].usage.ok, true);
  assert.equal(second.claudeUsageStatus.accounts[0].source, "cache");
  assert.equal(buildRedisDiagnosticCacheView(first.view).accounts[0].plan, "max/max_20x");
  assert.deepEqual(second.view.accounts[0].egress, first.view.accounts[0].egress);
  // A fresh usage cache cannot hide a service that has stopped since that read.
  proxyHealth = "stopped";
  const stopped = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 61_000 });
  assert.equal(stopped.claudeUsageStatus.accounts[0].source, "cache");
  assert.equal(stopped.view.accounts[0].egress.health, "stopped");
  assert.deepEqual(stopped.view.accounts[0].operator, { status: "proxy_down", eligible: false });
  assert.match(renderStatusText(stopped.view, { claudeUsageStatus: stopped.claudeUsageStatus }), /claude\s+PROXY DOWN.*test\s+stopped\s+restart assigned proxy/);
  assert.match(renderStatusText(stopped.view), /claude\s+proxy_down.*proxy_health=stopped/);
  const offline = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 120_000,
    connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual(offline.view.accounts[0].egress, { mode: "proxy", profileRef: "test", localStatus: "configured", health: "stopped" });
  assert.deepEqual(offline.view.accounts[0].operator, { status: "proxy_down", eligible: false });
  assert.match(renderStatusText(offline.view), /proxy=test/);
  // Local recovery is visible even without Redis, but does not claim fresh account readiness.
  proxyHealth = "running";
  const recovered = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 120_000,
    connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  assert.equal(recovered.view.accounts[0].egress.health, "running");
  assert.deepEqual(recovered.view.accounts[0].operator, { status: "unknown", eligible: false });
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-claude-test" } } });
  const absentOffline = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 120_001,
    connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  assert.equal(absentOffline.view.accounts[0].egress.localStatus, "not_configured");
  assert.deepEqual(absentOffline.view.accounts[0].operator, { status: "no_route", eligible: false });
  assert.match(renderStatusText(absentOffline.view), /don't have a route to this account/);

  // Persist a NO ROUTE view, then install the profile while Redis is offline.
  await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 120_002 });
  writeAimgrConfig({ homeDir: home, config: {
    redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-claude-test" },
    claudeProxyProfiles: { test: { socksPort: 1085, expectedExits: ["127.0.0.2"] } },
  } });
  const installedOffline = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, ...deps, nowMs: nowMs + 120_003,
    connectRedisStoreImpl: async () => { throw new Error("offline"); } });
  assert.equal(installedOffline.view.accounts[0].egress.localStatus, "configured");
  assert.deepEqual(installedOffline.view.accounts[0].operator, { status: "unknown", eligible: false });
  assert.equal(directProbeCalls, 0);
  assert.equal(claudeRequests, 1);
});

test("offline status does not call an account ordinary when a local protection binding exists", async () => {
  const homeDir = mkTempHome();
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix: "test" } } });
  invalidateClaudeOfflineBinding(homeDir, "protected");
  for (const egress of [undefined, { mode: "direct" }]) {
    writeCachedRedisStatusView({ homeDir, view: buildRedisDiagnosticCacheView({
      nowMs: Date.now(), accounts: [{ label: "protected", provider: ANTHROPIC_PROVIDER,
        egress, operator: { status: "ready", eligible: true } }],
    }) });
    const result = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, homeDir,
      connectRedisStoreImpl: async () => { throw new Error("offline"); } });
    assert.deepEqual(result.view.accounts[0].egress, { mode: "missing_assignment" });
    assert.deepEqual(result.view.accounts[0].operator, { status: "blocked", eligible: false });
    assert.doesNotMatch(renderStatusText(result.view), /proxy=none|proxy=unknown/);
  }
});

test("diagnostic status never invents direct routing from an old cache or exposes proxy configuration", () => {
  const view = buildRedisDiagnosticCacheView({ accounts: [
    { label: "old", provider: ANTHROPIC_PROVIDER },
    { label: "ordinary", provider: ANTHROPIC_PROVIDER, egress: { mode: "direct" } },
    { label: "proxied", provider: ANTHROPIC_PROVIDER,
      egress: { mode: "proxy", profileRef: "office", socksHost: "PRIVATE_IP", chrome: { userDataDir: "PRIVATE_PATH" }, token: "SECRET" } },
    { label: "invalid", provider: ANTHROPIC_PROVIDER, egress: { mode: "proxy", profileRef: "https://SECRET@example.test" } },
  ] });
  assert.deepEqual(view.accounts.map(account => account.egress), [
    { mode: "unknown" }, { mode: "direct" }, { mode: "proxy", profileRef: "office" }, { mode: "invalid" },
  ]);
  const text = renderStatusText(view);
  assert.match(text, /old.*proxy=unknown/);
  assert.match(text, /ordinary.*proxy=none/);
  assert.match(text, /proxied.*proxy=office/);
  assert.match(text, /invalid.*proxy=invalid/);
  assert.doesNotMatch(JSON.stringify(view) + text, /PRIVATE_|SECRET/);
});

test("unconfigured status returns local active facts without reading legacy credentials", async () => {
  const home = mkTempHome();
  writeLocalState({
    homeDir: home,
    localState: {
      targets: {
        codexCli: { activeLabel: "boss" },
        claudeCli: { lastRunLabel: "writer" },
      },
    },
  });

  const result = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment, homeDir: home, nowMs: Date.now() });

  assert.equal(result.used, true);
  assert.equal(result.view.redis.status, "unconfigured");
  assert.equal(result.view.codexCli.activeLabel, "boss");
  assert.equal(result.view.claudeCli.lastRunLabel, "writer");
  assert.deepEqual(result.view.accounts, []);
});

test("lock observation failure degrades independently from Redis credentials and usage", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } },
  });
  await seedRedis(client, home);

  const result = await buildRedisStatusView({ readCodexEnvironmentImpl: readCodexTestEnvironment,
    homeDir: home,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      [OPENAI_CODEX_PROVIDER]: {
        boss: {
          provider: OPENAI_CODEX_PROVIDER,
          ok: true,
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      },
    }),
    readHeldRedisCredentialLeaseLabelsImpl: async () => {
      throw new Error("lease backend unavailable");
    },
  });

  assert.equal(result.view.redis.status, "live");
  assert.equal(result.view.accounts[0].credentials.status, "ok");
  assert.equal(result.view.accounts[0].usage.ok, true);
  assert.deepEqual(result.view.accounts[0].lock, { status: "unknown", source: "unavailable" });
});
