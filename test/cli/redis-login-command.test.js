import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { resolveAimgrLocalStatePath } from "../../src/io/paths.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

function token(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
}

async function seedLoginRedis({ home, client, keyPrefix, credentialRecord }) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix } },
  });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(
    store,
    { credentials: [credentialRecord] },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

test("redis-configured login refreshes and publishes the shared credential without writing secrets.json", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:login-test",
    credentialRecord: {
      provider: "openai-codex",
      label: "boss",
      identity: { accountId: "acct_123" },
      credential: {
        access: token("acct_123"),
        refresh: "OLD_REFRESH",
        idToken: token("acct_123"),
        accountId: "acct_123",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      policy: { reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
  });

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
  assert.equal(result.redis.credentialVersion, 2);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, "NEW_REFRESH");
  assert.equal(snapshot.credentials[0].credential.access, refreshedAccess);
  const localState = fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8");
  assert.doesNotMatch(localState, /NEW_REFRESH/);
});

test("redis-configured shorthand panel persists shared credential and local-only browser paths", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, "agent-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:panel-test",
    credentialRecord: {
      provider: "openai-codex",
      label: "boss",
      identity: { accountId: "acct_panel" },
      credential: {},
      policy: {
        reauth: { mode: "browser-managed" },
        browser: { mode: "agent-browser" },
        pool: { enabled: true },
      },
    },
  });

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
  const credential = snapshot.credentials.find((record) => record.label === "boss");
  assert.deepEqual(credential.policy.browser, { mode: "agent-browser" });
  assert.equal(credential.policy.browser.agentBrowserProfile, undefined);
  assert.equal(credential.credential.refresh, "PANEL_REFRESH");
  const localState = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.deepEqual(localState.browserBindings.boss, {
    agentBrowserProfile: profileDir,
    agentBrowserSession: "agent-boss",
  });
  assert.doesNotMatch(JSON.stringify(localState), /PANEL_REFRESH/);
});

test("redis-configured login refuses to overwrite a credential with a different account identity", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:identity-test",
    credentialRecord: {
      provider: "openai-codex",
      label: "boss",
      identity: { accountId: "acct_expected" },
      credential: {
        access: token("acct_expected"),
        refresh: "OLD_REFRESH",
        idToken: token("acct_expected"),
        accountId: "acct_expected",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      policy: { reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
  });

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
    /Redis credential identity mismatch/,
  );
  const snapshot = await readSnapshot(store);
  const credential = snapshot.credentials.find((entry) => entry.label === "boss");
  assert.equal(credential.credential.refresh, "OLD_REFRESH");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});
