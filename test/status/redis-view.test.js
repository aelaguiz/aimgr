import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { OPENAI_CODEX_PROVIDER } from "../../src/core/constants.js";
import { resolveAimgrMachineIdPath, resolveAimgrRedisCachePath } from "../../src/io/paths.js";
import { buildRedisStatusView } from "../../src/status/redis-view.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

class FakeRedisClient {
  constructor() {
    this.values = new Map();
    this.sets = new Map();
    this.isOpen = true;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
    return "OK";
  }

  async sAdd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }

  async sMembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async mGet(keys) {
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async watch() {
    return "OK";
  }

  async unwatch() {
    return "OK";
  }

  multi() {
    const ops = [];
    const client = this;
    const tx = {
      set(key, value) {
        ops.push(["set", key, value]);
        return tx;
      },
      sAdd(key, member) {
        ops.push(["sAdd", key, member]);
        return tx;
      },
      async exec() {
        const results = [];
        for (const [op, key, value] of ops) {
          results.push(op === "set" ? await client.set(key, value) : await client.sAdd(key, value));
        }
        return results;
      },
    };
    return tx;
  }
}

function writeMachineId(home, machineId) {
  const machineIdPath = resolveAimgrMachineIdPath({ homeDir: home });
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
  fs.writeFileSync(machineIdPath, `${machineId}\n`, "utf8");
}

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
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }, { machineId: "laptop" }],
      labels: [
        {
          provider: OPENAI_CODEX_PROVIDER,
          label: "boss",
          stableIdentity: { accountId: "acct_boss" },
          reauth: { mode: "manual-callback" },
          pool: { enabled: true },
        },
      ],
      sessions: [
        {
          provider: OPENAI_CODEX_PROVIDER,
          label: "boss",
          machineId: "studio",
          credential: {
            access: token,
            refresh: "REFRESH_BOSS",
            idToken: token,
            accountId: "acct_boss",
            expiresAt: new Date(exp * 1000).toISOString(),
          },
          identity: { accountId: "acct_boss" },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
}

test("Redis status view reads Redis snapshot, writes redacted cache, and exposes session matrix", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
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
  assert.equal(result.view.redis.machineCount, 2);
  assert.equal(result.view.redis.labelCount, 1);
  assert.equal(result.view.redis.sessionCount, 1);
  assert.equal(result.view.accounts[0].label, "boss");
  assert.equal(result.view.redisSessionMatrix[0].sessions.studio.status, "ready");
  assert.equal(result.view.redisSessionMatrix[0].sessions.laptop.status, "missing");

  const cachePath = resolveAimgrRedisCachePath({ homeDir: home });
  const cache = fs.readFileSync(cachePath, "utf8");
  assert.doesNotMatch(cache, /REFRESH_BOSS/);
});

test("Redis status view uses diagnostic cache when Redis is unavailable", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
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
