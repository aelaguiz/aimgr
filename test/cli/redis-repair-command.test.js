import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { resolveAimgrMachineIdPath } from "../../src/io/paths.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

class FakeRedisClient {
  constructor() {
    this.values = new Map();
    this.sets = new Map();
    this.isOpen = true;
  }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, value); return "OK"; }
  async sAdd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }
  async sMembers(key) { return [...(this.sets.get(key) ?? new Set())]; }
  async mGet(keys) { return keys.map((key) => this.values.get(key) ?? null); }
  async watch() { return "OK"; }
  async unwatch() { return "OK"; }
  multi() {
    const ops = [];
    const client = this;
    const tx = {
      set(key, value) { ops.push(["set", key, value]); return tx; },
      sAdd(key, member) { ops.push(["sAdd", key, member]); return tx; },
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

async function seed(client) {
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:repair-test" });
  const token = makeFakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_new" },
  });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }, { machineId: "laptop" }],
      labels: [{ provider: "openai-codex", label: "boss", stableIdentity: { accountId: "acct_old" } }],
      sessions: [
        {
          provider: "openai-codex",
          label: "boss",
          machineId: "studio",
          credential: {
            access: token,
            refresh: "REFRESH_BOSS",
            idToken: token,
            accountId: "acct_new",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          identity: { accountId: "acct_new" },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

test("label rebind and session handoff are explicit Redis CAS repair commands", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:repair-test" } },
  });
  const store = await seed(client);

  const rebindOut = await runCli(["label", "rebind", "boss", "--home", home, "--machine", "studio", "--confirm"], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:repair-test" }),
  });
  const rebind = JSON.parse(rebindOut);
  assert.equal(rebind.ok, true);
  let snapshot = await readSnapshot(store);
  assert.deepEqual(snapshot.labels[0].stableIdentity, { accountId: "acct_new" });

  const handoffOut = await runCli(["session", "handoff", "boss", "--home", home, "--from", "studio", "--to", "laptop", "--confirm"], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:repair-test" }),
  });
  const handoff = JSON.parse(handoffOut);
  assert.equal(handoff.ok, true);
  snapshot = await readSnapshot(store);
  const studio = snapshot.sessions.find((session) => session.machineId === "studio");
  const laptop = snapshot.sessions.find((session) => session.machineId === "laptop");
  assert.equal(studio.health.status, "stale");
  assert.equal(laptop.health.status, "ready");
  assert.equal(laptop.lineage.mode, "handoff");
  assert.equal(laptop.credential.accountId, "acct_new");
});

test("repair commands require confirmation", async () => {
  await assert.rejects(
    () => runCli(["label", "rebind", "boss", "--home", mkTempHome(), "--machine", "studio"]),
    /requires --confirm/,
  );
});

test("redis-configured browser set publishes shared policy without local secrets", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:repair-test" } },
  });
  const store = await seed(client);

  const out = await runCli(["browser", "set", "boss", "--home", home, "--mode", "manual-callback"], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:repair-test" }),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.browser.source, "redis");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.labels[0].reauth.mode, "manual-callback");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);

  const shown = JSON.parse(await runCli(["browser", "show", "boss", "--home", home], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:repair-test" }),
  }));
  assert.equal(shown.source, "redis");
  assert.equal(shown.reauthMode, "manual-callback");
});
