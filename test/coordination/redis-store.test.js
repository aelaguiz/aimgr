import test from "node:test";
import assert from "node:assert/strict";
import {
  connectRedisStore,
  importSnapshot,
  publishLabel,
  publishSession,
  readSnapshot,
  registerMachine,
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

test("Redis store publishes indexed labels, sessions, and machine records", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:test" });

  const machine = await registerMachine(store, {
    machineId: "studio",
    hostname: "amirs-mac-studio",
    displayName: "Mac Studio",
    platform: "darwin",
    observedAt: "2026-05-30T14:00:00.000Z",
  });
  const label = await publishLabel(store, {
    expectedVersion: null,
    machineId: "studio",
    observedAt: "2026-05-30T14:01:00.000Z",
    labelRecord: {
      provider: "openai-codex",
      label: "boss",
      stableIdentity: { email: "boss@example.com" },
    },
  });
  const session = await publishSession(store, {
    expectedVersion: null,
    machineId: "studio",
    observedAt: "2026-05-30T14:02:00.000Z",
    sessionRecord: {
      provider: "openai-codex",
      label: "boss",
      machineId: "studio",
      credential: { authFile: "~/.codex/auth.json" },
    },
  });

  assert.equal(machine.ok, true);
  assert.equal(machine.record.version, 1);
  assert.equal(label.ok, true);
  assert.equal(label.record.version, 1);
  assert.equal(session.ok, true);
  assert.equal(session.record.version, 1);

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.keyPrefix, "aimgr:test:");
  assert.equal(snapshot.machines.length, 1);
  assert.equal(snapshot.labels.length, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].sessionId, "openai-codex:boss:studio");
});

test("Redis store retries machine registration after a WATCH conflict", async () => {
  const store = await connectRedisStore({
    client: new FakeRedisClient({ failExecOnce: true }),
    keyPrefix: "aimgr:test",
  });

  const result = await registerMachine(store, {
    machineId: "studio",
    hostname: "amirs-mac-studio",
    observedAt: "2026-05-30T14:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.version, 1);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.machines.length, 1);
  assert.equal(snapshot.machines[0].machineId, "studio");
});

test("Redis store CAS rejects stale writes and preserves createdAt on updates", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:test" });
  const first = await publishLabel(store, {
    expectedVersion: null,
    machineId: "studio",
    observedAt: "2026-05-30T14:00:00.000Z",
    labelRecord: { provider: "anthropic", label: "writer" },
  });
  const duplicateCreate = await publishLabel(store, {
    expectedVersion: null,
    machineId: "laptop",
    observedAt: "2026-05-30T14:01:00.000Z",
    labelRecord: { provider: "anthropic", label: "writer" },
  });
  const staleUpdate = await publishLabel(store, {
    expectedVersion: 99,
    machineId: "laptop",
    observedAt: "2026-05-30T14:02:00.000Z",
    labelRecord: { provider: "anthropic", label: "writer" },
  });
  const update = await publishLabel(store, {
    expectedVersion: first.record.version,
    machineId: "laptop",
    observedAt: "2026-05-30T14:03:00.000Z",
    labelRecord: { provider: "anthropic", label: "writer", pool: { enabled: false } },
  });

  assert.equal(duplicateCreate.ok, false);
  assert.equal(duplicateCreate.code, "stale_version");
  assert.equal(staleUpdate.ok, false);
  assert.equal(staleUpdate.currentVersion, 1);
  assert.equal(update.ok, true);
  assert.equal(update.record.version, 2);
  assert.equal(update.record.createdAt, "2026-05-30T14:00:00.000Z");
  assert.equal(update.record.updatedAt, "2026-05-30T14:03:00.000Z");
  assert.equal(update.record.updatedBy, "laptop");
  assert.deepEqual(update.record.pool, { enabled: false });
});

test("Redis store imports snapshot records into an empty namespace", async () => {
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:import-test" });
  const results = await importSnapshot(
    store,
    {
      meta: { migration: { id: "import-1" } },
      machines: [{ machineId: "studio" }],
      labels: [{ provider: "openai-codex", label: "boss" }],
      sessions: [{ provider: "openai-codex", label: "boss", machineId: "studio", credential: { ok: true } }],
    },
    { machineId: "importer", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  assert.equal(results.every((result) => result.ok), true);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.meta.migration.id, "import-1");
  assert.equal(snapshot.machines[0].machineId, "studio");
  assert.equal(snapshot.labels[0].label, "boss");
  assert.deepEqual(snapshot.sessions[0].credential, { ok: true });
});
