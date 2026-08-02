import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRedisConnectionPolicy,
  connectRedisStore,
  importCredentialsSnapshot,
  publishCredential,
  readSnapshot,
  REDIS_CONNECTION_POLICY_LEASED,
  REDIS_CONNECTION_POLICY_OBSERVE,
  REDIS_CONNECTION_POLICY_ONE_SHOT,
} from "../../src/coordination/redis-store.js";

class FakeRedisClient {
  constructor({ failExecOnce = false } = {}) {
    this.values = new Map();
    this.sets = new Map();
    this.isOpen = true;
    this.failExecOnce = failExecOnce;
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

  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of list) {
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
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
        if (client.failExecOnce) {
          client.failExecOnce = false;
          const err = new Error("One (or more) of the watched keys has been changed");
          err.name = "WatchError";
          throw err;
        }
        const results = [];
        for (const [op, key, value] of ops) {
          if (op === "set") {
            results.push(await client.set(key, value));
          } else if (op === "sAdd") {
            results.push(await client.sAdd(key, value));
          }
        }
        return results;
      },
    };
    return tx;
  }
}

test("Redis connection policies bound observations and initial leased acquisition", async () => {
  const observe = buildRedisConnectionPolicy(REDIS_CONNECTION_POLICY_OBSERVE);
  const oneShot = buildRedisConnectionPolicy(REDIS_CONNECTION_POLICY_ONE_SHOT);
  const leased = buildRedisConnectionPolicy(REDIS_CONNECTION_POLICY_LEASED);

  assert.equal(observe.clientOptions.socket.reconnectStrategy, false);
  assert.equal(observe.initialConnectTimeoutMs, 2_000);
  assert.equal(oneShot.clientOptions.socket.reconnectStrategy, false);
  assert.equal(oneShot.initialConnectTimeoutMs, 5_000);
  assert.equal(typeof leased.clientOptions.socket.reconnectStrategy, "function");
  assert.equal(leased.clientOptions.socket.socketTimeout, undefined);
  assert.equal(leased.clientOptions.disableOfflineQueue, true);
  assert.equal(leased.initialConnectTimeoutMs, 5_000);

  let destroyed = false;
  const stalledClient = {
    on() {},
    connect: () => new Promise(() => {}),
    destroy() { destroyed = true; },
  };
  await assert.rejects(
    () => connectRedisStore({
      url: "redis://example.invalid:6379",
      keyPrefix: "aimgr:timeout-test",
      connectionPolicy: REDIS_CONNECTION_POLICY_LEASED,
      initialConnectTimeoutMs: 5,
      createClientImpl: () => stalledClient,
    }),
    /initial connection timed out/,
  );
  assert.equal(destroyed, true);
});

test("Redis store publishes one indexed credential record per provider and label", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:test" });

  const result = await publishCredential(store, {
    expectedVersion: null,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:02:00.000Z",
    credentialRecord: {
      provider: "openai-codex",
      label: "boss",
      identity: { accountId: "acct-1" },
      credential: { access: "a", refresh: "r", accountId: "acct-1", expiresAt: "2026-05-30T20:00:00.000Z" },
      policy: { pool: { enabled: true } },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.version, 1);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.keyPrefix, "aimgr:test:");
  assert.equal(snapshot.credentials.length, 1);
  assert.equal(snapshot.credentials[0].provider, "openai-codex");
  assert.equal(snapshot.credentials[0].label, "boss");
  assert.deepEqual(snapshot.credentials[0].identity, { accountId: "acct-1" });
});

test("Redis credential CAS rejects stale writes and preserves createdAt on updates", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:test" });
  const first = await publishCredential(store, {
    expectedVersion: null,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:00:00.000Z",
    credentialRecord: { provider: "anthropic", label: "writer", policy: { pool: { enabled: true } } },
  });
  const duplicateCreate = await publishCredential(store, {
    expectedVersion: null,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:01:00.000Z",
    credentialRecord: { provider: "anthropic", label: "writer" },
  });
  const staleUpdate = await publishCredential(store, {
    expectedVersion: 99,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:02:00.000Z",
    credentialRecord: { provider: "anthropic", label: "writer" },
  });
  const update = await publishCredential(store, {
    expectedVersion: first.record.version,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:03:00.000Z",
    credentialRecord: { provider: "anthropic", label: "writer", policy: { pool: { enabled: false } } },
  });

  assert.equal(duplicateCreate.ok, false);
  assert.equal(duplicateCreate.code, "stale_version");
  assert.equal(staleUpdate.ok, false);
  assert.equal(staleUpdate.currentVersion, 1);
  assert.equal(update.ok, true);
  assert.equal(update.record.version, 2);
  assert.equal(update.record.createdAt, "2026-05-30T14:00:00.000Z");
  assert.equal(update.record.updatedAt, "2026-05-30T14:03:00.000Z");
  assert.equal(update.record.updatedBy, "aimgr-cli");
  assert.deepEqual(update.record.policy.pool, { enabled: false });
});

test("Redis store reports stale version after a WATCH conflict", async () => {
  const store = await connectRedisStore({
    client: new FakeRedisClient({ failExecOnce: true }),
    keyPrefix: "aimgr:test",
  });

  const result = await publishCredential(store, {
    expectedVersion: null,
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:00:00.000Z",
    credentialRecord: { provider: "openai-codex", label: "boss" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_version");
});

test("Redis store imports credential snapshots into an empty namespace", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:import-test" });
  const results = await importCredentialsSnapshot(
    store,
    {
      meta: { migration: { id: "import-1" } },
      credentials: [{ provider: "openai-codex", label: "boss", credential: { ok: true } }],
    },
    { updatedBy: "importer", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  assert.equal(results.every((result) => result.ok), true);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.meta.migration.id, "import-1");
  assert.equal(snapshot.credentials[0].label, "boss");
  assert.deepEqual(snapshot.credentials[0].credential, { ok: true });
});
