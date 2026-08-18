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
  buildRedisStatusView,
} from "../../src/status/redis-view.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

async function seedRedis(client) {
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:status-test" });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
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

test("Redis status view reads shared credentials, writes redacted cache, and has no session matrix", async () => {
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
  await seedRedis(client);

  const result = await buildRedisStatusView({
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
  assert.equal(result.view.codexCli.activeLabel, "boss");
  assert.equal(result.view.redisCredentials[0].status, "ready");
  assert.equal(Object.hasOwn(result.view, "redisSessionMatrix"), false);
  assert.equal(Object.hasOwn(result.view, "redisMachines"), false);
  assert.equal(result.view.warnings.some((warning) => warning.kind === "codex_import_missing"), false);

  const cachePath = resolveAimgrRedisCachePath({ homeDir: home });
  const cache = fs.readFileSync(cachePath, "utf8");
  const cacheEnvelope = JSON.parse(cache);
  assert.equal(cacheEnvelope.statusView.kind, AIMGR_REDIS_STATUS_CACHE_KIND);
  assert.doesNotMatch(cache, /REFRESH_BOSS/);
  assert.doesNotMatch(
    cache,
    /cache-user|cache-password|cache-query-secret|cache-private@example|acct_boss|org-cache-private|private\/cache\/browser|RAW_PRIVATE_HEALTH_REASON/,
  );
  assert.doesNotMatch(cache, /"identity"|"policy"|"reason"/);
});

test("Redis status view uses diagnostic cache when Redis is unavailable", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } },
  });
  await seedRedis(client);
  const observedAtMs = Date.parse("2026-07-22T18:00:00.000Z");

  await buildRedisStatusView({
    homeDir: home,
    nowMs: observedAtMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      [OPENAI_CODEX_PROVIDER]: {
        boss: {
          provider: OPENAI_CODEX_PROVIDER,
          ok: true,
          resetCreditsAvailable: 4,
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      },
    }),
  });
  const cached = await buildRedisStatusView({
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
  assert.equal(cached.view.warnings.at(-1).kind, "redis_status_cache_used");

  const oldCached = await buildRedisStatusView({
    homeDir: home,
    nowMs: observedAtMs + 24 * 60 * 60_000,
    connectRedisStoreImpl: async () => {
      throw new Error("RAW_STALE_CACHE_ERROR");
    },
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });
  assert.equal(oldCached.view.redis.status, "cache");
  assert.equal(oldCached.view.redis.cacheAgeMs, 24 * 60 * 60_000);
});

test("ordinary Redis status routes Claude through the bounded canonical cache", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-claude-test" } },
  });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:status-claude-test" });
  const credential = buildAnthropicClaudeCredential({ expiresAtMs: nowMs + 3_600_000 });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: ANTHROPIC_PROVIDER,
      label: "claude",
      credential,
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  await acquireRedisCredentialLease(store, {
    provider: ANTHROPIC_PROVIDER,
    label: "claude",
  });

  let directProbeCalls = 0;
  let claudeRequests = 0;
  const deps = {
    homeDir: home,
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

  const first = await buildRedisStatusView({ ...deps, nowMs });
  const second = await buildRedisStatusView({ ...deps, nowMs: nowMs + 60_000 });

  assert.equal(first.view.accounts[0].usage.ok, true);
  assert.equal(first.view.accounts[0].usage.status, "usage_readable");
  assert.equal(first.view.accounts[0].lock.status, "held");
  assert.equal(first.claudeUsageStatus.accounts[0].label, "claude");
  assert.equal(first.claudeUsageStatus.accounts[0].locked, true);
  assert.equal(first.claudeUsageStatus.accounts[0].usage.ok, true);
  assert.equal(second.view.accounts[0].usage.ok, true);
  assert.equal(second.claudeUsageStatus.accounts[0].source, "cache");
  assert.equal(directProbeCalls, 0);
  assert.equal(claudeRequests, 1);
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

  const result = await buildRedisStatusView({ homeDir: home, nowMs: Date.now() });

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
  await seedRedis(client);

  const result = await buildRedisStatusView({
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
