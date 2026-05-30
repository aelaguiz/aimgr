import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { resolveAimgrMachineIdPath, resolveAimgrLocalStatePath } from "../../src/io/paths.js";
import { runCli } from "../helpers/cli-runner.js";
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

function token(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
}

test("redis-configured login refreshes and publishes this machine session without writing secrets.json", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:login-test" } },
  });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:login-test" });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }],
      labels: [{ provider: "openai-codex", label: "boss", reauth: { mode: "manual-callback" }, pool: { enabled: true } }],
      sessions: [
        {
          provider: "openai-codex",
          label: "boss",
          machineId: "studio",
          credential: {
            access: token("acct_123"),
            refresh: "OLD_REFRESH",
            idToken: token("acct_123"),
            accountId: "acct_123",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          identity: { accountId: "acct_123" },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  const refreshedAccess = token("acct_123");
  const stdout = await runCli(["login", "boss", "--home", home], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:login-test" }),
    refreshOpenAICodexImpl: async (refresh) => {
      assert.equal(refresh, "OLD_REFRESH");
      return {
        access: refreshedAccess,
        refresh: "NEW_REFRESH",
        expires: Date.now() + 7200_000,
        accountId: "acct_123",
      };
    },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.redis.machineId, "studio");
  assert.equal(result.redis.labelVersion, 2);
  assert.equal(result.redis.sessionVersion, 2);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.sessions[0].credential.refresh, "NEW_REFRESH");
  assert.equal(snapshot.sessions[0].credential.access, refreshedAccess);
  const localState = fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8");
  assert.doesNotMatch(localState, /NEW_REFRESH/);
});

test("redis-configured shorthand panel persists Redis session and local-only browser paths", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, "agent-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const client = new FakeRedisClient();
  writeMachineId(home, "laptop");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:panel-test" } },
  });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:panel-test" });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "laptop" }],
      labels: [
        {
          provider: "openai-codex",
          label: "boss",
          stableIdentity: { accountId: "acct_panel" },
          reauth: { mode: "browser-managed" },
          browser: { mode: "agent-browser" },
          pool: { enabled: true },
        },
      ],
      sessions: [],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  await runCli(["boss", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:panel-test" }),
    runLabelControlPanelImpl: async ({ state, label, persistStateImpl }) => {
      state.accounts[label].reauth = { mode: "browser-managed" };
      state.accounts[label].browser = {
        mode: "agent-browser",
        agentBrowserProfile: profileDir,
        agentBrowserSession: "agent-boss",
      };
      state.credentials["openai-codex"][label] = {
        access: token("acct_panel"),
        refresh: "PANEL_REFRESH",
        idToken: token("acct_panel"),
        accountId: "acct_panel",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      await persistStateImpl({ state, label });
    },
  });

  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
  const snapshot = await readSnapshot(store);
  const label = snapshot.labels.find((record) => record.label === "boss");
  assert.deepEqual(label.browser, { mode: "agent-browser" });
  assert.equal(label.browser.agentBrowserProfile, undefined);
  assert.equal(snapshot.sessions[0].credential.refresh, "PANEL_REFRESH");
  const localState = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.deepEqual(localState.browserBindings.boss, {
    agentBrowserProfile: profileDir,
    agentBrowserSession: "agent-boss",
  });
  assert.doesNotMatch(JSON.stringify(localState), /PANEL_REFRESH/);
});

test("redis-configured login refuses to overwrite a label with a different account identity", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:identity-test" } },
  });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:identity-test" });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }],
      labels: [
        {
          provider: "openai-codex",
          label: "boss",
          stableIdentity: { accountId: "acct_expected" },
          reauth: { mode: "manual-callback" },
          pool: { enabled: true },
        },
      ],
      sessions: [
        {
          provider: "openai-codex",
          label: "boss",
          machineId: "studio",
          credential: {
            access: token("acct_expected"),
            refresh: "OLD_REFRESH",
            idToken: token("acct_expected"),
            accountId: "acct_expected",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          identity: { accountId: "acct_expected" },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  await assert.rejects(
    () => runCli(["boss", "--home", home], {
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:identity-test" }),
      runLabelControlPanelImpl: async ({ state, label, persistStateImpl }) => {
        state.credentials["openai-codex"][label] = {
          access: token("acct_other"),
          refresh: "WRONG_REFRESH",
          idToken: token("acct_other"),
          accountId: "acct_other",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        await persistStateImpl({ state, label });
      },
    }),
    /Redis label identity mismatch/,
  );
  const snapshot = await readSnapshot(store);
  const session = snapshot.sessions.find((entry) => entry.label === "boss");
  assert.equal(session.credential.refresh, "OLD_REFRESH");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});
