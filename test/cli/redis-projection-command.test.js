import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import {
  resolveAimgrLocalStatePath,
  resolveAimgrClaudeLabelHomeDir,
  resolveClaudeAuthFilePath,
  resolveCodexAuthFilePath,
  resolveManagedCodexHomeDir,
  resolveManagedPiAgentDir,
  resolvePiAuthFilePath,
} from "../../src/io/paths.js";
import { writeClaudeNativeBundleExportFile } from "../../src/credentials/claude-native.js";
import { handleClaude, maintainRedisClaudeCredential } from "../../src/cli/commands/claude.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

const PREFIX = "aimgr:projection-test";

function token(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
}

function codexCredential(accountId = "acct_boss", refresh = "REFRESH_BOSS") {
  return {
    access: token(accountId),
    refresh,
    idToken: token(accountId),
    accountId,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

function codexRecord(label, accountId) {
  return {
    provider: "openai-codex",
    label,
    credential: codexCredential(accountId, `REFRESH_${label.toUpperCase()}`),
    identity: { accountId },
    policy: { pool: { enabled: true } },
    health: { status: "ready", reason: null },
  };
}

async function seedOpenAiRedis({ home, client, records = [codexRecord("boss", "acct_boss")] }) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(
    store,
    {
      credentials: records,
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

function prepareTestClaudeLaunch({ command, userHomeDir, homeDir, configDir }) {
  return {
    command: path.resolve(command),
    userHomeDir,
    homeDir,
    configDir,
  };
}

function buildTestClaudeResolver(prepareImpl = prepareTestClaudeLaunch) {
  const resolve = () => process.execPath;
  resolve.prepareClaudeCliLaunchImpl = prepareImpl;
  return resolve;
}

function rotateProjectedClaudeCredential(configDir, {
  accessToken,
  refreshToken,
  expiresAt = Date.now() + 7_200_000,
}) {
  const credentialsPath = resolveClaudeAuthFilePath(configDir);
  const projected = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  projected.claudeAiOauth.accessToken = accessToken;
  projected.claudeAiOauth.refreshToken = refreshToken;
  projected.claudeAiOauth.expiresAt = expiresAt;
  fs.writeFileSync(credentialsPath, `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(credentialsPath, 0o600);
}

test("redis-configured codex use projects from Redis and writes only local adjunct state", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({ home, client });

  const out = await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.activated.receipt.label, "boss");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);

  const auth = JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.codexCli.activeLabel, "boss");
  assert.doesNotMatch(JSON.stringify(local), /REFRESH_BOSS/);
});

test("redis-configured automatic codex use selects the lowest current 5h usage", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({
    home,
    client,
    records: [
      codexRecord("qa", "acct_qa"),
      codexRecord("pro2", "acct_pro2"),
    ],
  });

  const out = await runCli(["codex", "use", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        qa: {
          ok: true,
          windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 92 }],
        },
        pro2: {
          ok: true,
          windows: [{ kind: "primary", usedPercent: 2 }, { kind: "secondary", usedPercent: 1 }],
        },
      },
    }),
  });

  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.activated.receipt.label, "qa");
  assert.deepEqual(result.activated.receipt.reasons, ["lowest_5h_used"]);
});

test("redis-configured codex use does not publish stale local auth before projection", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home, client });
  const stale = codexCredential("acct_boss", "REFRESH_STALE_LOCAL");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: stale.access,
      refresh_token: stale.refresh,
      id_token: stale.idToken,
      account_id: stale.accountId,
    },
    last_refresh: new Date().toISOString(),
  });
  writeJson(resolveAimgrLocalStatePath({ homeDir: home }), {
    targets: {
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
      },
    },
  });

  const out = await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });

  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.preserved.reason, "codex_use_projects_from_redis");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
  const auth = JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(auth.tokens.refresh_token, "REFRESH_BOSS");
});

test("redis-configured codex watch publishes live auth rotation before exit", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home, client });

  await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  const out = await runCli(["codex", "watch", "--once", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: { ok: true, windows: [{ usedPercent: 1 }] },
      },
    }),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.preserved.status, "updated");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_ROTATED");
});

test("two Redis-configured AIM homes read and update the same shared credential", async () => {
  const homeA = mkTempHome();
  const homeB = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home: homeA, client });
  writeAimgrConfig({
    homeDir: homeB,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });

  await runCli(["codex", "use", "boss", "--home", homeA], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  await runCli(["codex", "use", "boss", "--home", homeB], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });

  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED_BY_HOME_A");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: homeA, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  const watchOut = await runCli(["codex", "watch", "--once", "--home", homeA], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: { ok: true, windows: [{ usedPercent: 1 }] },
      },
    }),
  });
  assert.equal(JSON.parse(watchOut).preserved.status, "updated");

  await runCli(["codex", "use", "boss", "--home", homeB], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const homeBAuth = JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: homeB, env: {} })), "utf8"));
  assert.equal(homeBAuth.tokens.refresh_token, "REFRESH_ROTATED_BY_HOME_A");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_ROTATED_BY_HOME_A");
  assert.equal(fs.existsSync(path.join(homeA, ".aimgr", "secrets.json")), false);
  assert.equal(fs.existsSync(path.join(homeB, ".aimgr", "secrets.json")), false);
});

test("redis-configured pi use and hermes auth write read shared Redis credentials", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({ home, client });

  const piOut = await runCli(["pi", "use", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: { ok: true, windows: [{ usedPercent: 1 }] },
      },
    }),
  });
  assert.equal(JSON.parse(piOut).ok, true);
  const piAuth = JSON.parse(fs.readFileSync(resolvePiAuthFilePath(resolveManagedPiAgentDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(piAuth["openai-codex"].accountId, "acct_boss");

  const hermesPath = path.join(home, "hermes", "auth.json");
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  const hermesOut = await runCli(["auth", "write", "hermes", "boss", "--auth-file", hermesPath, "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  assert.equal(JSON.parse(hermesOut).ok, true);
  const hermesAuth = JSON.parse(fs.readFileSync(hermesPath, "utf8"));
  assert.equal(hermesAuth.providers["openai-codex"].tokens.refresh_token, "REFRESH_BOSS");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude import-native publishes the native bundle to Redis", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: "anthropic",
          label: "claude",
          policy: {
            expect: { email: "boss@example.com" },
            pool: { enabled: true },
          },
        },
        {
          provider: "openai-codex",
          label: "claude",
          credential: {
            access: "CODEX_ACCESS",
            refresh: "CODEX_REFRESH",
            expiresAt: "2026-07-23T18:00:00.000Z",
            accountId: "acct_codex",
          },
          policy: {
            expect: { email: "codex@example.com" },
            pool: { enabled: true },
          },
        },
      ],
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  const bundleFile = path.join(home, "bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: bundleFile,
    nativeClaudeBundle: buildAnthropicClaudeCredential({
      access: "CLAUDE_ACCESS",
      refresh: "CLAUDE_REFRESH",
    }).nativeClaudeBundle,
    labelHint: "claude",
    sourceHome: home,
  });

  const out = await runCli(["claude", "import-native", "claude", "--in", bundleFile, "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  assert.equal(JSON.parse(out).ok, true);
  assert.equal(JSON.parse(out).imported.identityPolicyMatched, true);
  assert.doesNotMatch(out, /CLAUDE_(?:ACCESS|REFRESH)|boss@example\.com|bundle\.json|organization/i);
  const snapshot = await readSnapshot(store);
  const credentialRecord = snapshot.credentials.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  const codexRecord = snapshot.credentials.find((entry) => entry.provider === "openai-codex" && entry.label === "claude");
  assert.equal(credentialRecord.credential.refresh, "CLAUDE_REFRESH");
  assert.equal(codexRecord.credential.refresh, "CODEX_REFRESH");
  assert.equal(codexRecord.version, 1);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude run projects into a per-label home and publishes post-run rotation", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
  });
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: "anthropic",
          label: "claude",
          credential,
          identity: {
            accountUuid: "acct_boss",
            emailAddress: "boss@example.com",
            organizationUuid: "org_boss",
          },
          policy: {
            expect: { email: "boss@example.com" },
            pool: { enabled: true },
          },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" });
  const configDir = path.join(claudeHome, ".claude");
  let preflightCount = 0;
  let keychainCalls = 0;
  const out = await runCli(["claude", "run", "claude", "opus", "--resume"], {
    env: { HOME: home },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver((options) => {
      preflightCount += 1;
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), false);
      return prepareTestClaudeLaunch(options);
    }),
    readClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("managed run must not read Keychain");
    },
    writeClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("managed run must not write Keychain");
    },
    deleteClaudeNativeKeychainOauthImpl: () => {
      keychainCalls += 1;
      throw new Error("managed run must not delete Keychain");
    },
    runClaudeCliImpl: ({
      userHomeDir,
      homeDir: launchHome,
      configDir: launchConfigDir,
      cwd,
      args,
      preparedLaunch,
    }) => {
      assert.equal(userHomeDir, home);
      assert.equal(launchHome, claudeHome);
      assert.equal(launchConfigDir, configDir);
      assert.equal(cwd, process.cwd());
      assert.equal(preparedLaunch.configDir, configDir);
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--effort",
        "max",
        "--resume",
      ]);
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
      });
      return { status: 0, signal: null };
    },
  });

  assert.equal(out, "");
  assert.equal(preflightCount, 1);
  assert.equal(keychainCalls, 0);
  const snapshot = await readSnapshot(store);
  const credentialRecord = snapshot.credentials.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  assert.equal(credentialRecord.credential.refresh, "CLAUDE_REFRESH_ROTATED");
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), false);
  assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.activeLabel, "claude");
  assert.match(local.targets.claudeCli.credentialsPath, /claude-homes\/claude\/\.claude\/\.credentials\.json$/);
  assert.doesNotMatch(JSON.stringify(local), /CLAUDE_REFRESH_ROTATED/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude run publishes each token rotation before exit without duplicating same-lineage ticks", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "claude",
      credential: buildAnthropicClaudeCredential({
        access: "CLAUDE_ACCESS",
        refresh: "CLAUDE_REFRESH",
      }),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: {
        expect: { email: "boss@example.com" },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });

  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" });
  const configDir = path.join(claudeHome, ".claude");
  const timers = [];
  const clearedTimers = [];
  let resolveLaunch;
  let markLaunchStarted;
  let launchResolved = false;
  const launchStarted = new Promise((resolve) => {
    markLaunchStarted = resolve;
  });
  const launchResult = new Promise((resolve) => {
    resolveLaunch = () => {
      launchResolved = true;
      resolve({ status: 0, signal: null });
    };
  });

  const command = handleClaude({
    opts: { afterDoubleDash: ["--model", "opus"] },
    positional: ["claude", "run", "claude"],
    homeDir: home,
    env: {},
    stdout: { write() {} },
    setExitCode: () => {
      throw new Error("the successful run must not set an exit code");
    },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    nowMs: Date.now(),
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      clearedTimers.push(timer);
    },
    runClaudeCliImpl: ({ args }) => {
      assert.deepEqual(args, ["--model", "opus"]);
      markLaunchStarted();
      return launchResult;
    },
  });

  await launchStarted;
  assert.equal(launchResolved, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30_000);
  assert.equal((await readSnapshot(store)).credentials[0].version, 1);

  rotateProjectedClaudeCredential(configDir, {
    accessToken: "CLAUDE_ACCESS_ROTATED",
    refreshToken: "CLAUDE_REFRESH_ROTATED",
  });
  await timers.shift().callback();
  const rotated = await readSnapshot(store);
  assert.equal(launchResolved, false);
  assert.equal(rotated.credentials[0].version, 2);
  assert.equal(rotated.credentials[0].credential.refresh, "CLAUDE_REFRESH_ROTATED");

  rotateProjectedClaudeCredential(configDir, {
    accessToken: "CLAUDE_ACCESS_ROTATED",
    refreshToken: "CLAUDE_REFRESH_ROTATED",
    expiresAt: Date.now() + 10_800_000,
  });
  assert.equal(timers.length, 1);
  await timers.shift().callback();
  assert.equal((await readSnapshot(store)).credentials[0].version, 2);

  rotateProjectedClaudeCredential(configDir, {
    accessToken: "CLAUDE_ACCESS_ROTATED_AGAIN",
    refreshToken: "CLAUDE_REFRESH_ROTATED_AGAIN",
    expiresAt: Date.now() + 14_400_000,
  });
  assert.equal(timers.length, 1);
  await timers.shift().callback();
  const rotatedAgain = await readSnapshot(store);
  assert.equal(rotatedAgain.credentials[0].version, 3);
  assert.equal(rotatedAgain.credentials[0].credential.refresh, "CLAUDE_REFRESH_ROTATED_AGAIN");

  assert.equal(timers.length, 1);
  await timers.shift().callback();
  assert.equal((await readSnapshot(store)).credentials[0].version, 3);

  resolveLaunch();
  await command;
  assert.equal(
    [...client.values.keys()].some((key) => key.includes(":fence:claude-rotation:claude")),
    false,
  );
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), false);
  assert.equal(clearedTimers.length, 1);
});

test("Claude maintenance uses the exact bounded no-model run and returns a result without changing interactive behavior", async () => {
  const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
    expiresAtMs: nowMs + 4 * 60_000,
  });
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "claude",
      credential,
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: {
        expect: { email: "boss@example.com" },
        reauth: { mode: "native-claude" },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });
  const timerDelays = [];
  const clearedTimers = [];
  let launches = 0;
  let exitCodeChanges = 0;
  const context = {
    opts: { afterDoubleDash: [] },
    positional: ["claude", "run", "claude"],
    homeDir: home,
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    setExitCode: () => {
      exitCodeChanges += 1;
    },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    nowMs,
    setTimeoutImpl: (_callback, delay) => {
      timerDelays.push(delay);
      return { unref() {} };
    },
    clearTimeoutImpl: (timer) => {
      clearedTimers.push(timer);
    },
    runClaudeCliImpl: ({ configDir, args, env, signal }) => {
      launches += 1;
      assert.deepEqual(args, [
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--print",
        "--output-format",
        "json",
        "/usage",
      ]);
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
      assert.ok(signal instanceof AbortSignal);
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
        expiresAt: nowMs + 2 * 60 * 60_000,
      });
      return { status: 0, signal: null };
    },
  };

  assert.deepEqual(
    await maintainRedisClaudeCredential(context, { label: "claude" }),
    { outcome: "refreshed", timedOut: false, status: 0, signal: null },
  );
  assert.deepEqual(timerDelays, [30_000]);
  assert.equal(clearedTimers.length, 1);
  assert.equal(exitCodeChanges, 0);
  assert.equal(launches, 1);

  assert.deepEqual(
    await maintainRedisClaudeCredential(context, { label: "claude" }),
    { outcome: "skipped", timedOut: false, status: 0, signal: null },
  );
  assert.equal(launches, 1, "the under-lease freshness recheck must skip the provider");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].credential.refresh, "CLAUDE_REFRESH_ROTATED");
});

test("Claude maintenance marks only a clean exact missing-token result as reauth_required", async () => {
  const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
  const runCase = async ({ clean }) => {
    const home = mkTempHome();
    const client = new FakeRedisClient();
    const credential = buildAnthropicClaudeCredential({
      expiresAtMs: nowMs + 4 * 60_000,
    });
    writeAimgrConfig({
      homeDir: home,
      config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
    });
    const store = await connectRedisStore({ client, keyPrefix: PREFIX });
    await importCredentialsSnapshot(store, {
      credentials: [{
        provider: "anthropic",
        label: "claude",
        credential,
        identity: {
          accountUuid: "acct_boss",
          emailAddress: "boss@example.com",
          organizationUuid: "org_boss",
        },
        policy: {
          expect: { email: "boss@example.com" },
          reauth: { mode: "native-claude" },
          pool: { enabled: true },
        },
      }],
    });
    const result = await maintainRedisClaudeCredential({
      opts: { afterDoubleDash: [] },
      positional: ["claude", "run", "claude"],
      homeDir: home,
      env: {},
      setExitCode: () => {
        throw new Error("maintenance must not set the parent exit code");
      },
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      nowMs,
      runClaudeCliImpl: ({ configDir }) => {
        if (clean) {
          fs.unlinkSync(resolveClaudeAuthFilePath(configDir));
          return { status: 0, signal: null };
        }
        return { status: 2, signal: null };
      },
    }, { label: "claude" });
    return {
      client,
      home,
      result,
      snapshot: await readSnapshot(store),
    };
  };

  const terminal = await runCase({ clean: true });
  assert.equal(terminal.result.outcome, "reauth_required");
  assert.equal(
    terminal.snapshot.credentials[0].policy.reauth.blockedReason,
    "oauth_reauth_required",
  );
  assert.equal(
    [...terminal.client.values.keys()].some((key) => key.includes(":fence:claude-rotation:claude")),
    false,
  );

  const transient = await runCase({ clean: false });
  assert.equal(transient.result.outcome, "failed");
  assert.equal(transient.snapshot.credentials[0].policy.reauth.blockedReason, undefined);
  assert.equal(
    [...transient.client.values.keys()].some((key) => key.includes(":fence:claude-rotation:claude")),
    true,
  );
});

test("redis-configured claude run preserves a terminating signal and resumes its exact fence", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "claude",
      credential: buildAnthropicClaudeCredential(),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signals.push({ pid, signal });
    return true;
  };
  try {
    const out = await runCli(["claude", "run", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: () => ({ status: null, signal: "SIGTERM" }),
    });
    assert.equal(out, "");
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(signals, [{ pid: process.pid, signal: "SIGTERM" }]);
  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" }),
    ".claude",
  );
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
  const fenceKey = [...client.values.keys()].find((key) => key.includes(":fence:claude-rotation:claude"));
  assert.ok(fenceKey);
  const interruptedFence = client.values.get(fenceKey);
  let resumedLaunches = 0;
  const resumedOut = await runCli(["claude", "run", "claude", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: () => {
      resumedLaunches += 1;
      assert.equal(client.values.get(fenceKey), interruptedFence);
      return { status: 0, signal: null };
    },
  });
  assert.equal(resumedOut, "");
  assert.equal(resumedLaunches, 1);
  assert.equal(client.values.has(fenceKey), false);
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), false);
});

test("redis-configured Claude import requires expected identity policy and rejects candidate identity aliases", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [
      {
        provider: "anthropic",
        label: "claude",
        policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      },
      {
        provider: "anthropic",
        label: "alias",
        identity: {
          accountUuid: "acct_boss",
          emailAddress: "boss@example.com",
          organizationUuid: "org_boss",
        },
        policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      },
    ],
  });
  const bundleFile = path.join(home, "bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: bundleFile,
    nativeClaudeBundle: buildAnthropicClaudeCredential().nativeClaudeBundle,
  });

  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", bundleFile, "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    /already stored on label=alias/,
  );
  const snapshot = await readSnapshot(store);
  assert.deepEqual(snapshot.credentials.find((entry) => entry.label === "claude").credential, {});

  const noPolicyHome = mkTempHome();
  const noPolicyClient = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: noPolicyHome,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const noPolicyStore = await connectRedisStore({ client: noPolicyClient, keyPrefix: PREFIX });
  await importCredentialsSnapshot(noPolicyStore, {
    credentials: [{ provider: "anthropic", label: "claude", policy: { pool: { enabled: true } } }],
  });
  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", bundleFile, "--home", noPolicyHome], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client: noPolicyClient, keyPrefix: PREFIX }),
    }),
    /missing its canonical expected-email policy/,
  );
});

test("all Redis Claude credential writers refuse work while the rotating credential lease is held", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "claude",
      credential: buildAnthropicClaudeCredential(),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
    }],
  });
  const lease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "claude",
  });
  await assert.rejects(
    runCli(["claude", "run", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    /busy on another AIM process or machine/,
  );
  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", path.join(home, "must-not-be-read.json"), "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    /busy on another AIM process or machine/,
  );
  let keychainReads = 0;
  await assert.rejects(
    runCli(["claude", "capture-native", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
      readClaudeNativeKeychainOauthImpl: async () => {
        keychainReads += 1;
        return { ok: false, errorKind: "must_not_run" };
      },
    }),
    /busy on another AIM process or machine/,
  );
  assert.equal(keychainReads, 0);
  assert.equal(await lease.release(), true);
  assert.equal(fs.existsSync(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" })), false);
});

test("failed post-run publication fences other machines until the originating home repairs Redis", async () => {
  const home = mkTempHome();
  const otherHome = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
  });
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  writeAimgrConfig({
    homeDir: otherHome,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
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
  const deps = {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
  };

  await assert.rejects(
    runCli(["claude", "run", "claude", "--home", home], {
      ...deps,
      runClaudeCliImpl: ({ configDir }) => {
        rotateProjectedClaudeCredential(configDir, {
          accessToken: "CLAUDE_ACCESS_ROTATED",
          refreshToken: "CLAUDE_REFRESH_ROTATED",
        });
        for (const [key, raw] of client.values) {
          if (!key.includes(":credential:anthropic:claude") || key.includes(":lease:")) continue;
          const record = JSON.parse(raw);
          record.version += 1;
          client.values.set(key, JSON.stringify(record));
        }
        return { status: 0, signal: null };
      },
    }),
    /rotation publication is pending/,
  );
  let local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.rotationPublicationPendingByLabel.claude.pending, true);
  const sharedFenceKey = [...client.values.keys()].find((key) => key.includes(":fence:claude-rotation:claude"));
  assert.ok(sharedFenceKey);
  assert.doesNotMatch(client.values.get(sharedFenceKey), /CLAUDE_(?:ACCESS|REFRESH)/);

  const staleBundleFile = path.join(otherHome, "stale-bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: staleBundleFile,
    nativeClaudeBundle: credential.nativeClaudeBundle,
    labelHint: "claude",
  });
  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", staleBundleFile, "--home", otherHome], deps),
    /did not replace the unresolved rotating-token lineage/,
  );
  assert.ok(client.values.has(sharedFenceKey));

  let otherHomeLaunches = 0;
  await assert.rejects(
    runCli(["claude", "run", "claude", "--home", otherHome], {
      ...deps,
      runClaudeCliImpl: () => {
        otherHomeLaunches += 1;
        return { status: 0, signal: null };
      },
    }),
    /unresolved rotation on another machine/,
  );
  assert.equal(otherHomeLaunches, 0);
  assert.ok(client.values.has(sharedFenceKey));
  const otherLocal = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: otherHome }), "utf8"));
  assert.match(local.installationId, /^[0-9a-f-]{36}$/);
  assert.match(otherLocal.installationId, /^[0-9a-f-]{36}$/);
  assert.notEqual(otherLocal.installationId, local.installationId);

  const repairedOut = await runCli(["claude", "run", "claude", "--home", home], {
    ...deps,
    runClaudeCliImpl: () => ({ status: 0, signal: null }),
  });
  assert.equal(repairedOut, "");
  local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.rotationPublicationPendingByLabel, undefined);
  const snapshot = await readSnapshot(store);
  const record = snapshot.credentials.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  assert.equal(record.credential.refresh, "CLAUDE_REFRESH_ROTATED");
  assert.equal(client.values.has(sharedFenceKey), false);

  const failedRun = await runCliWithExitCode(
    ["claude", "run", "claude", "--home", home],
    {
      ...deps,
      runClaudeCliImpl: () => ({ status: 2, signal: null }),
    },
  );
  assert.deepEqual(failedRun, { stdout: "", exitCode: 2 });
  const failedRunFenceKey = [...client.values.keys()].find((key) => key.includes(":fence:claude-rotation:claude"));
  assert.ok(failedRunFenceKey, "a nonclean exit with unchanged tokens must retain the uncertainty fence");
  let sameHomeRelaunches = 0;
  const interruptedAgain = await runCliWithExitCode(
    ["claude", "run", "claude", "--home", home],
    {
      ...deps,
      runClaudeCliImpl: () => {
        sameHomeRelaunches += 1;
        assert.ok(client.values.has(failedRunFenceKey));
        return { status: 2, signal: null };
      },
    },
  );
  assert.deepEqual(interruptedAgain, { stdout: "", exitCode: 2 });
  assert.equal(sameHomeRelaunches, 1);
  assert.ok(client.values.has(failedRunFenceKey));

  const expiryOnlyBundle = structuredClone(record.credential.nativeClaudeBundle);
  expiryOnlyBundle.claudeAiOauth.expiresAt += 3_600_000;
  const expiryOnlyFile = path.join(home, "expiry-only-bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: expiryOnlyFile,
    nativeClaudeBundle: expiryOnlyBundle,
    labelHint: "claude",
  });
  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", expiryOnlyFile, "--home", home], deps),
    /did not replace the unresolved rotating-token lineage/,
  );
  assert.ok(client.values.has(failedRunFenceKey));

  for (const [key, raw] of client.values) {
    if (!key.includes(":credential:anthropic:claude")) continue;
    const arbitrary = JSON.parse(raw);
    arbitrary.version += 1;
    arbitrary.credential.access = "ARBITRARY_ACCESS";
    arbitrary.credential.refresh = "ARBITRARY_REFRESH";
    arbitrary.credential.expiresAt = new Date(Date.now() + 10_800_000).toISOString();
    arbitrary.credential.nativeClaudeBundle.claudeAiOauth.accessToken = "ARBITRARY_ACCESS";
    arbitrary.credential.nativeClaudeBundle.claudeAiOauth.refreshToken = "ARBITRARY_REFRESH";
    arbitrary.credential.nativeClaudeBundle.claudeAiOauth.expiresAt = Date.now() + 10_800_000;
    client.values.set(key, JSON.stringify(arbitrary));
  }
  let unsafeRelaunches = 0;
  await assert.rejects(
    runCli(["claude", "run", "claude", "--home", home], {
      ...deps,
      runClaudeCliImpl: () => {
        unsafeRelaunches += 1;
        return { status: 0, signal: null };
      },
    }),
    /not a proven successor to its shared rotation fence/,
  );
  assert.equal(unsafeRelaunches, 0);
  assert.ok(client.values.has(failedRunFenceKey));
});

test("redis-configured claude use is retired in favor of claude run", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  await assert.rejects(
    () => runCli(["claude", "use", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    /`aim claude use` was retired for Redis installs/,
  );
});
