import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS } from "../../src/coordination/redis-credential-lease.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveAimgrLocalStatePath,
} from "../../src/io/paths.js";
import { loadLocalState, writeLocalState } from "../../src/state/local-state.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

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
  if (credentialRecord) {
    await importCredentialsSnapshot(
      store,
      { credentials: [credentialRecord] },
      { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
    );
  }
  return store;
}

function buildAnthropicPolicyCandidate({
  label = "pro7",
  email = "boss@example.com",
  credential = {},
} = {}) {
  return {
    provider: "anthropic",
    label,
    identity: {},
    credential,
    policy: { expect: { email }, pool: { enabled: true } },
    health: { status: "candidate", reason: "credential_missing" },
  };
}

function buildTestClaudeResolver(onPrepare = null) {
  const resolve = () => process.execPath;
  resolve.prepareClaudeCliLaunchImpl = (options) => {
    onPrepare?.(options);
    return {
      command: path.resolve(options.command),
      userHomeDir: options.userHomeDir,
      homeDir: options.homeDir,
      configDir: options.configDir,
    };
  };
  return resolve;
}

function resolveClaudeLoginStagingHome(home, label) {
  return path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label }),
    ".login-staging",
  );
}

function writeStagedClaudeLogin(configDir, {
  accessToken = "LOGIN_ACCESS",
  refreshToken = "LOGIN_REFRESH",
  expiresAt = Date.now() + 7_200_000,
  emailAddress = "boss@example.com",
  accountUuid = "acct_boss",
  organizationUuid = "org_boss",
} = {}) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, ".credentials.json"), `${JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: "max_20x",
      scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(configDir, ".claude.json"), `${JSON.stringify({
    oauthAccount: {
      accountUuid,
      displayName: "Boss",
      emailAddress,
      organizationName: "Boss Org",
      organizationUuid,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(configDir, ".credentials.json"), 0o600);
  fs.chmodSync(path.join(configDir, ".claude.json"), 0o600);
}

function hasClaudeRotationFence(client) {
  return [...client.values.keys()].some((key) => key.includes(":fence:claude-rotation:"));
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

test("Redis generic Anthropic login uses contained file staging and publishes without Keychain calls", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-login-success-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");
  const pendingLocalState = loadLocalState({ homeDir: home });
  pendingLocalState.targets.claudeCli.rotationPublicationPendingByLabel = {
    pro7: {
      pending: true,
      observedAt: "2026-05-30T13:00:00.000Z",
    },
  };
  writeLocalState({ homeDir: home, localState: pendingLocalState });
  let keychainCalls = 0;
  let preflightCalls = 0;
  const stdout = await runCli(["login", "pro7", "--home", home], {
    env: {
      BROWSER: "/unexpected/browser",
      DISPLAY: ":99",
      WAYLAND_DISPLAY: "wayland-99",
    },
    connectRedisStoreImpl: () => connectRedisStore({
      client,
      keyPrefix: "aimgr:claude-login-success-test",
    }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(({ userHomeDir, homeDir, configDir }) => {
      preflightCalls += 1;
      assert.equal(userHomeDir, home);
      assert.equal(homeDir, stagingHome);
      assert.equal(configDir, path.join(stagingHome, ".claude"));
      assert.equal(fs.existsSync(stagingHome), false);
    }),
    runClaudeCliImpl: ({ userHomeDir, homeDir, configDir, args, env, preparedLaunch }) => {
      assert.equal(userHomeDir, home);
      assert.equal(homeDir, stagingHome);
      assert.equal(configDir, path.join(stagingHome, ".claude"));
      assert.equal(preparedLaunch.configDir, configDir);
      assert.deepEqual(args, ["auth", "login", "--claudeai"]);
      assert.equal(env.BROWSER, undefined);
      assert.equal(env.DISPLAY, undefined);
      assert.equal(env.WAYLAND_DISPLAY, undefined);
      writeStagedClaudeLogin(configDir, {
        accessToken: "LOGIN_ACCESS_NEW",
        refreshToken: "LOGIN_REFRESH_NEW",
      });
      return { status: 0, signal: null };
    },
    readClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("generic Claude login must not read Keychain");
    },
    writeClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("generic Claude login must not write Keychain");
    },
    deleteClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("generic Claude login must not delete Keychain");
    },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.redis.credentialVersion, 2);
  assert.equal(preflightCalls, 1);
  assert.equal(keychainCalls, 0);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 2);
  assert.equal(snapshot.credentials[0].credential.refresh, "LOGIN_REFRESH_NEW");
  assert.equal(snapshot.credentials[0].provenance.lastSourceType, "login-maintenance");
  const localState = loadLocalState({ homeDir: home });
  assert.equal(localState.targets.claudeCli.rotationPublicationPendingByLabel, undefined);
  assert.doesNotMatch(stdout, /LOGIN_(?:ACCESS|REFRESH)_NEW|boss@example\.com/);
});

test("Redis generic Anthropic login enrolls an exact-empty policy candidate", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-candidate-login-test",
    credentialRecord: buildAnthropicPolicyCandidate(),
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");
  let keychainCalls = 0;

  const stdout = await runCli(["login", "pro7", "--home", home], {
    connectRedisStoreImpl: () => connectRedisStore({
      client,
      keyPrefix: "aimgr:claude-candidate-login-test",
    }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir }) => {
      writeStagedClaudeLogin(configDir, {
        accessToken: "CANDIDATE_ACCESS",
        refreshToken: "CANDIDATE_REFRESH",
      });
      return { status: 0, signal: null };
    },
    readClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
    },
    writeClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
    },
    deleteClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
    },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.redis.credentialVersion, 2);
  assert.equal(keychainCalls, 0);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, "CANDIDATE_REFRESH");
  assert.equal(snapshot.credentials[0].health.status, "ready");
});

test("Redis generic login enrolls an unknown Anthropic label in one flow", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-unknown-login-test",
    credentialRecord: null,
  });
  const answers = ["2", " New@Example.com "];
  const prompts = [];

  const stdout = await runCli(["login", "fresh", "--home", home], {
    connectRedisStoreImpl: () => connectRedisStore({
      client,
      keyPrefix: "aimgr:claude-unknown-login-test",
    }),
    promptLineImpl: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir }) => {
      writeStagedClaudeLogin(configDir, {
        accessToken: "UNKNOWN_ACCESS",
        refreshToken: "UNKNOWN_REFRESH",
        emailAddress: "new@example.com",
        accountUuid: "acct_new",
        organizationUuid: "org_new",
      });
      return { status: 0, signal: null };
    },
  });

  const result = JSON.parse(stdout.slice(stdout.indexOf("{")));
  assert.equal(result.ok, true);
  assert.equal(result.label, "fresh");
  assert.equal(result.provider, "anthropic");
  assert.deepEqual(prompts.map((prompt) => String(prompt)), [
    'Provider for "fresh" (1-2 or id) [1]:',
    'Expected Claude email for "fresh":',
  ]);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.length, 1);
  assert.equal(snapshot.credentials[0].version, 2);
  assert.equal(snapshot.credentials[0].policy.expect.email, "new@example.com");
  assert.equal(snapshot.credentials[0].credential.refresh, "UNKNOWN_REFRESH");
  assert.equal(fs.existsSync(resolveClaudeLoginStagingHome(home, "fresh")), false);
  assert.equal(hasClaudeRotationFence(client), false);
  assert.doesNotMatch(stdout, /UNKNOWN_(?:ACCESS|REFRESH)|new@example\.com/i);
});

test("Redis generic Anthropic login rejects partial candidate credentials before launch", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-partial-login-test",
    credentialRecord: buildAnthropicPolicyCandidate({
      credential: { access: "PARTIAL_ACCESS" },
    }),
  });
  let launchCalls = 0;

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], {
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-partial-login-test",
      }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: () => {
        launchCalls += 1;
        return { status: 0, signal: null };
      },
    }),
    /no valid Redis lineage/,
  );

  assert.equal(launchCalls, 0);
  assert.equal(hasClaudeRotationFence(client), false);
  assert.equal(fs.existsSync(resolveClaudeLoginStagingHome(home, "pro7")), false);
  const snapshot = await readSnapshot(store);
  assert.deepEqual(snapshot.credentials[0].credential, { access: "PARTIAL_ACCESS" });
});

test("Redis generic Anthropic enrollment cleans its fence and staging on candidate drift", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-candidate-drift-test",
    credentialRecord: buildAnthropicPolicyCandidate(),
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], {
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-candidate-drift-test",
      }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: ({ configDir }) => {
        writeStagedClaudeLogin(configDir, {
          accessToken: "DRIFT_ACCESS",
          refreshToken: "DRIFT_REFRESH",
        });
        const credentialKey = [...client.values.keys()].find((key) =>
          key.includes(":credential:anthropic:pro7"));
        const current = JSON.parse(client.values.get(credentialKey));
        current.version += 1;
        current.policy.expect.email = "changed@example.com";
        client.values.set(credentialKey, JSON.stringify(current));
        return { status: 0, signal: null };
      },
    }),
    /changed outside its login fence/,
  );

  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 2);
  assert.equal(snapshot.credentials[0].policy.expect.email, "changed@example.com");
  assert.deepEqual(snapshot.credentials[0].credential, {});
});

test("Redis generic Anthropic enrollment recovers candidate staging after publish uncertainty", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-candidate-recovery-test",
    credentialRecord: buildAnthropicPolicyCandidate(),
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");
  const originalMulti = client.multi.bind(client);
  let failNextExec = false;
  client.multi = () => {
    const tx = originalMulti();
    if (failNextExec) {
      failNextExec = false;
      tx.exec = async () => null;
    }
    return tx;
  };
  let launchCalls = 0;

  const deps = {
    connectRedisStoreImpl: () => connectRedisStore({
      client,
      keyPrefix: "aimgr:claude-candidate-recovery-test",
    }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir }) => {
      launchCalls += 1;
      writeStagedClaudeLogin(configDir, {
        accessToken: "RECOVERY_ACCESS",
        refreshToken: "RECOVERY_REFRESH",
      });
      failNextExec = true;
      return { status: 0, signal: null };
    },
  };

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], deps),
    /Redis publish failed/,
  );
  assert.equal(fs.existsSync(path.join(stagingHome, ".claude", ".credentials.json")), true);
  assert.equal(hasClaudeRotationFence(client), true);

  const stdout = await runCli(["login", "pro7", "--home", home], {
    ...deps,
    runClaudeCliImpl: () => {
      launchCalls += 1;
      throw new Error("recovery must not start a second Claude login");
    },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.maintenance.action, "recovered-native-login");
  assert.equal(result.redis.credentialVersion, 2);
  assert.equal(launchCalls, 1);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, "RECOVERY_REFRESH");
});

test("Redis generic Anthropic login rejects wrong identity and removes staging", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-login-identity-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], {
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-login-identity-test",
      }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: ({ configDir }) => {
        writeStagedClaudeLogin(configDir, {
          accessToken: "OTHER_ACCESS",
          refreshToken: "OTHER_REFRESH",
          emailAddress: "other@example.com",
          accountUuid: "acct_other",
          organizationUuid: "org_other",
        });
        return { status: 0, signal: null };
      },
    }),
    /identity_mismatch/,
  );

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 1);
  assert.equal(snapshot.credentials[0].credential.refresh, credential.refresh);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
});

test("Redis generic Anthropic login cancellation clears its fence and staging", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-login-cancel-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], {
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-login-cancel-test",
      }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: () => ({ status: 1, signal: null }),
    }),
    /cancelled or failed/,
  );

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 1);
  assert.equal(snapshot.credentials[0].credential.refresh, credential.refresh);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
});

test("Redis generic Anthropic login reacquires its lease after a long browser wait", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-login-long-wait-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");

  const stdout = await runCli(["login", "pro7", "--home", home], {
    connectRedisStoreImpl: () => connectRedisStore({
      client,
      keyPrefix: "aimgr:claude-login-long-wait-test",
    }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir }) => {
      client.advanceTime(DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS + 1);
      writeStagedClaudeLogin(configDir, {
        accessToken: "LONG_WAIT_ACCESS",
        refreshToken: "LONG_WAIT_REFRESH",
      });
      return { status: 0, signal: null };
    },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.redis.credentialVersion, 2);
  assert.equal(fs.existsSync(stagingHome), false);
  assert.equal(hasClaudeRotationFence(client), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, "LONG_WAIT_REFRESH");
});

test("Redis generic Anthropic login retains fenced staging on publish uncertainty", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-login-publish-failure-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  const stagingHome = resolveClaudeLoginStagingHome(home, "pro7");

  await assert.rejects(
    runCli(["login", "pro7", "--home", home], {
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-login-publish-failure-test",
      }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: ({ configDir }) => {
        writeStagedClaudeLogin(configDir, {
          accessToken: "UNCERTAIN_ACCESS",
          refreshToken: "UNCERTAIN_REFRESH",
        });
        const credentialKey = [...client.values.keys()].find((key) =>
          key.includes(":credential:anthropic:pro7"));
        const current = JSON.parse(client.values.get(credentialKey));
        current.version += 1;
        client.values.set(credentialKey, JSON.stringify(current));
        return { status: 0, signal: null };
      },
    }),
    /changed outside its login fence/,
  );

  assert.equal(fs.existsSync(path.join(stagingHome, ".claude", ".credentials.json")), true);
  assert.equal(hasClaudeRotationFence(client), true);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, credential.refresh);
});

test("Redis shorthand panel remains closed for Anthropic labels", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential();
  const store = await seedLoginRedis({
    home,
    client,
    keyPrefix: "aimgr:claude-panel-block-test",
    credentialRecord: {
      provider: "anthropic",
      label: "pro7",
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      credential,
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  });
  let panelCalls = 0;

  await assert.rejects(
    runCli(["pro7", "--home", home], {
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      connectRedisStoreImpl: () => connectRedisStore({
        client,
        keyPrefix: "aimgr:claude-panel-block-test",
      }),
      runLabelControlPanelImpl: async () => {
        panelCalls += 1;
      },
    }),
    /Redis-backed Claude maintenance.*aim claude run/,
  );

  assert.equal(panelCalls, 0);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 1);
  assert.equal(snapshot.credentials[0].credential.refresh, credential.refresh);
});
