import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { OPENAI_CODEX_PROVIDER } from "../../src/core/constants.js";
import { resolveAimgrRedisCachePath } from "../../src/io/paths.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { buildRedisStatusView } from "../../src/status/redis-view.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

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
          identity: { accountId: "acct_boss" },
          credential: {
            access: token,
            refresh: "REFRESH_BOSS",
            idToken: token,
            accountId: "acct_boss",
            expiresAt: new Date(exp * 1000).toISOString(),
          },
          policy: {
            reauth: { mode: "manual-callback" },
            pool: { enabled: true },
          },
          health: { status: "ready", reason: null },
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
        url: "redis://fake:6379",
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
  assert.equal(result.view.redis.credentialCount, 1);
  assert.equal(result.view.accounts[0].label, "boss");
  assert.equal(result.view.codexCli.activeLabel, "boss");
  assert.equal(result.view.redisCredentials[0].status, "ready");
  assert.equal(Object.hasOwn(result.view, "redisSessionMatrix"), false);
  assert.equal(Object.hasOwn(result.view, "redisMachines"), false);
  assert.equal(result.view.warnings.some((warning) => warning.kind === "codex_import_missing"), false);

  const cachePath = resolveAimgrRedisCachePath({ homeDir: home });
  const cache = fs.readFileSync(cachePath, "utf8");
  assert.doesNotMatch(cache, /REFRESH_BOSS/);
});

test("Redis status view uses diagnostic cache when Redis is unavailable", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:status-test" } },
  });
  await seedRedis(client);

  await buildRedisStatusView({
    homeDir: home,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:status-test" }),
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });
  const cached = await buildRedisStatusView({
    homeDir: home,
    connectRedisStoreImpl: async () => {
      throw new Error("redis down");
    },
    probeUsageSnapshotsByProviderImpl: async () => ({ [OPENAI_CODEX_PROVIDER]: {} }),
  });

  assert.equal(cached.used, true);
  assert.equal(cached.view.redis.status, "cache");
  assert.match(cached.view.redis.error, /redis down/);
  assert.equal(cached.view.warnings.at(-1).kind, "redis_status_cache_used");
});
