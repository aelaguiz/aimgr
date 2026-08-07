import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import {
  connectRedisStore,
  importCredentialsSnapshot,
  publishCredential,
  readSnapshot,
} from "../../src/coordination/redis-store.js";
import {
  acquireRedisCredentialLease,
  DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS,
} from "../../src/coordination/redis-credential-lease.js";
import {
  closeRedisRuntime,
  loadRedisRuntime,
} from "../../src/coordination/runtime.js";
import { publishMaintainedCredential } from "../../src/coordination/login-publish.js";
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
import { handleClaude } from "../../src/cli/commands/claude.js";
import { maintainRedisClaudeCredential } from "../../src/credentials/claude-maintenance.js";
import { buildClaudeTokenLineageFingerprint } from "../../src/targets/claude-cli.js";
import { writeLocalState } from "../../src/state/local-state.js";
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

function codexCredential(
  accountId = "acct_boss",
  refresh = "REFRESH_BOSS",
  expiresAtMs = Date.now() + 3600_000,
) {
  return {
    access: token(accountId, Math.floor(expiresAtMs / 1000)),
    refresh,
    idToken: token(accountId, Math.floor(expiresAtMs / 1000)),
    accountId,
    expiresAt: new Date(expiresAtMs).toISOString(),
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

function assertCanonicalAnthropicCredential(record, expectedRefreshToken) {
  const credential = record?.credential;
  assert.equal(credential?.nativeClaudeBundle?.claudeAiOauth?.refreshToken, expectedRefreshToken);
  for (const field of [
    "access",
    "refresh",
    "expiresAt",
    "subscriptionType",
    "rateLimitTier",
    "scopes",
    "emailAddress",
    "organizationName",
    "organizationUuid",
  ]) {
    assert.equal(Object.hasOwn(credential, field), false, `unexpected duplicated Anthropic field: ${field}`);
  }
}

function buildFakeCodexSpawn({ exitCode = 0 } = {}) {
  const calls = [];
  const spawnCodexImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    process.nextTick(() => {
      child.emit("spawn");
      process.nextTick(() => child.emit("exit", exitCode, null));
    });
    return child;
  };
  spawnCodexImpl.calls = calls;
  return spawnCodexImpl;
}

test("redis-configured codex run projects from Redis and writes only local adjunct state", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({ home, client });

  const out = await runCli(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
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
  // Run output stays label/reason/boolean only.
  assert.doesNotMatch(out, /acct_boss|REFRESH_BOSS|wss:\/\//);
});

test("redis-configured automatic codex run selects the lowest current 5h usage", async () => {
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

  const out = await runCli(["codex", "run", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
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

test("redis-configured codex run does not publish stale local auth before projection", async () => {
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

  const out = await runCli(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
  });

  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.reconciliation.status, "redis_newer");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
  const auth = JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(auth.tokens.refresh_token, "REFRESH_BOSS");
});

test("redis-configured codex run publishes a newer local auth rotation before selection", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home, client });

  await runCli(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
  });
  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED", Date.now() + 2 * 3600_000);
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  const out = await runCli(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.reconciliation.status, "local_newer");
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
  const depsFor = () => ({
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    spawnCodexImpl: buildFakeCodexSpawn(),
  });

  await runCli(["codex", "run", "boss", "--home", homeA], depsFor());
  await runCli(["codex", "run", "boss", "--home", homeB], depsFor());

  const rotated = codexCredential(
    "acct_boss",
    "REFRESH_ROTATED_BY_HOME_A",
    Date.now() + 2 * 3600_000,
  );
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: homeA, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  const runAOut = await runCli(["codex", "run", "boss", "--home", homeA], depsFor());
  assert.equal(JSON.parse(runAOut).reconciliation.status, "local_newer");

  await runCli(["codex", "run", "boss", "--home", homeB], depsFor());
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
  assert.equal(piAuth["openai-codex"].type, "external");
  assert.equal(piAuth["openai-codex"].binding, "boss");
  assert.equal(piAuth["openai-codex"].source, "aimgr");
  assert.equal("access" in piAuth["openai-codex"], false);
  assert.equal("refresh" in piAuth["openai-codex"], false);

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
  assertCanonicalAnthropicCredential(credentialRecord, "CLAUDE_REFRESH");
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
  assertCanonicalAnthropicCredential(credentialRecord, "CLAUDE_REFRESH_ROTATED");
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
  assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.lastRunLabel, "claude");
  assert.equal(local.targets.claudeCli.credentialsPath, undefined);
  assert.equal(local.targets.claudeCli.projectionReceiptsByLabel, undefined);
  assert.doesNotMatch(JSON.stringify(local), /CLAUDE_REFRESH_ROTATED/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("explicit Claude run uses a complete offline cache and treats Redis as online authority", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const firstNowMs = Date.parse("2026-08-02T18:00:00.000Z");
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
        expiresAtMs: firstNowMs + 7_200_000,
      }),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  const onlineDeps = {
    env: {},
    nowImpl: () => firstNowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: () => ({ status: 0, signal: null }),
  };
  assert.equal(await runCli(["claude", "run", "claude", "--home", home], onlineDeps), "");

  let offlineLaunches = 0;
  const offlineDeps = {
    ...onlineDeps,
    nowImpl: () => firstNowMs + 90_000,
    connectRedisStoreImpl: async () => {
      throw new Error("simulated Redis outage");
    },
    runClaudeCliImpl: ({ configDir }) => {
      offlineLaunches += 1;
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
      return { status: 0, signal: null };
    },
  };
  const offlineOut = await runCli(["claude", "run", "claude", "--home", home], offlineDeps);
  assert.equal(
    offlineOut,
    "AIM coordination=offline label=claude cache=complete\n",
  );
  assert.equal(offlineLaunches, 1);

  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" }),
    ".claude",
  );
  rotateProjectedClaudeCredential(configDir, {
    accessToken: "CLAUDE_ACCESS_UNPUBLISHED",
    refreshToken: "CLAUDE_REFRESH_UNPUBLISHED",
    expiresAt: firstNowMs + 10_800_000,
  });
  assert.equal(
    await runCli(["claude", "run", "claude", "--home", home], offlineDeps),
    "AIM coordination=offline label=claude cache=complete\n",
  );
  assert.equal(offlineLaunches, 2);

  // A strictly newer same-account local rotation is published before Redis is
  // projected back into the managed cache.
  assert.equal(await runCli(["claude", "run", "claude", "--home", home], onlineDeps), "");
  let snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 2);
  assertCanonicalAnthropicCredential(snapshot.credentials[0], "CLAUDE_REFRESH_UNPUBLISHED");

  // A newer Redis version replaces an older local cache without another
  // publication.
  const redisNewerCredential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS_REDIS_NEWER",
    refresh: "CLAUDE_REFRESH_REDIS_NEWER",
    expiresAtMs: firstNowMs + 14_400_000,
  });
  const redisNewer = await publishCredential(store, {
    expectedVersion: snapshot.credentials[0].version,
    updatedBy: "test",
    observedAt: new Date(firstNowMs + 120_000).toISOString(),
    credentialRecord: {
      ...snapshot.credentials[0],
      credential: redisNewerCredential,
    },
  });
  assert.equal(redisNewer.ok, true);
  assert.equal(await runCli(["claude", "run", "claude", "--home", home], {
    ...onlineDeps,
    nowImpl: () => firstNowMs + 120_000,
  }), "");
  snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 3);
  assertCanonicalAnthropicCredential(snapshot.credentials[0], "CLAUDE_REFRESH_REDIS_NEWER");

  // If Redis and the local cache differ, Redis wins unless the local cache is
  // the strictly newer same-account credential already handled above.
  rotateProjectedClaudeCredential(configDir, {
    accessToken: "CLAUDE_ACCESS_LOCAL_BRANCH",
    refreshToken: "CLAUDE_REFRESH_LOCAL_BRANCH",
    expiresAt: firstNowMs + 18_000_000,
  });
  const redisOtherBranch = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS_REDIS_BRANCH",
    refresh: "CLAUDE_REFRESH_REDIS_BRANCH",
    expiresAtMs: firstNowMs + 21_600_000,
  });
  const conflictingRedis = await publishCredential(store, {
    expectedVersion: snapshot.credentials[0].version,
    updatedBy: "test",
    observedAt: new Date(firstNowMs + 180_000).toISOString(),
    credentialRecord: {
      ...snapshot.credentials[0],
      credential: redisOtherBranch,
    },
  });
  assert.equal(conflictingRedis.ok, true);
  let conflictedLaunches = 0;
  assert.equal(await runCli(["claude", "run", "claude", "--home", home], {
    ...onlineDeps,
    nowImpl: () => firstNowMs + 180_000,
    runClaudeCliImpl: () => {
      conflictedLaunches += 1;
      return { status: 0, signal: null };
    },
  }), "");
  assert.equal(conflictedLaunches, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8")).claudeAiOauth.refreshToken,
    "CLAUDE_REFRESH_REDIS_BRANCH",
  );
});

test("online Claude run ignores a stale legacy receipt and replaces its predecessor cache from Redis", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.parse("2026-08-03T12:00:00.000Z");
  const legacyReceiptCredential = buildAnthropicClaudeCredential({
    access: "PRO11_LEGACY_V31_ACCESS",
    refresh: "PRO11_LEGACY_V31_REFRESH",
    expiresAtMs: nowMs + 1_800_000,
    emailAddress: "pro11@example.com",
    organizationUuid: "org_pro11",
  });
  legacyReceiptCredential.nativeClaudeBundle.oauthAccount.accountUuid = "acct_pro11";
  const localPredecessor = buildAnthropicClaudeCredential({
    access: "PRO11_LOCAL_V32_ACCESS",
    refresh: "PRO11_LOCAL_V32_REFRESH",
    expiresAtMs: nowMs + 3_600_000,
    emailAddress: "pro11@example.com",
    organizationUuid: "org_pro11",
  });
  localPredecessor.nativeClaudeBundle.oauthAccount.accountUuid = "acct_pro11";
  const redisCanonical = buildAnthropicClaudeCredential({
    access: "PRO11_REDIS_V33_ACCESS",
    refresh: "PRO11_REDIS_V33_REFRESH",
    expiresAtMs: nowMs + 7_200_000,
    emailAddress: "pro11@example.com",
    organizationUuid: "org_pro11",
  });
  redisCanonical.nativeClaudeBundle.oauthAccount.accountUuid = "acct_pro11";
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "pro11",
      credential: legacyReceiptCredential,
      identity: {
        accountUuid: "acct_pro11",
        emailAddress: "pro11@example.com",
        organizationUuid: "org_pro11",
      },
      policy: { expect: { email: "pro11@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  let snapshot = await readSnapshot(store);
  const version2 = await publishCredential(store, {
    expectedVersion: 1,
    updatedBy: "test",
    observedAt: "2026-08-03T10:30:00.000Z",
    credentialRecord: { ...snapshot.credentials[0], credential: localPredecessor },
  });
  assert.equal(version2.ok, true);
  const version3 = await publishCredential(store, {
    expectedVersion: 2,
    updatedBy: "test",
    observedAt: "2026-08-03T11:00:00.000Z",
    credentialRecord: {
      ...version2.record,
      credential: redisCanonical,
      provenance: {
        lastSourceType: "native-claude-rotation",
        claudeRotationBaseCredentialVersion: 2,
      },
    },
  });
  assert.equal(version3.ok, true);
  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "pro11" }),
    ".claude",
  );
  writeJson(path.join(configDir, ".credentials.json"), {
    claudeAiOauth: localPredecessor.nativeClaudeBundle.claudeAiOauth,
  });
  writeJson(path.join(configDir, ".claude.json"), {
    oauthAccount: localPredecessor.nativeClaudeBundle.oauthAccount,
  });
  writeLocalState({
    homeDir: home,
    localState: {
      targets: {
        claudeCli: {
          projectionReceiptsByLabel: {
            pro11: {
              label: "pro11",
              redisCredentialVersion: 1,
              committedLineageFingerprint: buildClaudeTokenLineageFingerprint(legacyReceiptCredential),
              credentialsPath: resolveClaudeAuthFilePath(configDir),
              reconciledAt: "2026-08-03T10:00:00.000Z",
            },
          },
        },
      },
    },
  });

  let launches = 0;
  assert.equal(await runCli(["claude", "run", "pro11", "--home", home], {
    env: {},
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir: launchConfigDir }) => {
      launches += 1;
      const projected = JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(launchConfigDir), "utf8"));
      assert.equal(projected.claudeAiOauth.refreshToken, "PRO11_REDIS_V33_REFRESH");
      return { status: 0, signal: null };
    },
  }), "");
  assert.equal(launches, 1);
  snapshot = await readSnapshot(store);
  assert.equal(findSnapshotCredential(snapshot, "anthropic", "pro11").version, 3);
  assertCanonicalAnthropicCredential(
    findSnapshotCredential(snapshot, "anthropic", "pro11"),
    "PRO11_REDIS_V33_REFRESH",
  );
  const localState = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(localState.targets.claudeCli.projectionReceiptsByLabel, undefined);
});

test("another machine accepts a centrally published Claude rotation from Redis", async () => {
  const m5Home = mkTempHome();
  const m3Home = mkTempHome();
  const client = new FakeRedisClient();
  const firstNowMs = Date.now();
  for (const homeDir of [m5Home, m3Home]) {
    writeAimgrConfig({
      homeDir,
      config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
    });
  }
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "qa",
      credential: buildAnthropicClaudeCredential({
        access: "QA_M5_OLD_ACCESS",
        refresh: "QA_M5_OLD_REFRESH",
        expiresAtMs: firstNowMs + 7_200_000,
        emailAddress: "qa@example.com",
        organizationUuid: "org_qa",
      }),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "qa@example.com",
        organizationUuid: "org_qa",
      },
      policy: { expect: { email: "qa@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  const deps = {
    env: {},
    nowImpl: () => firstNowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: () => ({ status: 0, signal: null }),
  };
  assert.equal(await runCli(["claude", "run", "qa", "--home", m5Home], deps), "");

  let snapshot = await readSnapshot(store);
  const m3Runtime = await loadRedisRuntime({
    homeDir: m3Home,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    provider: "anthropic",
  });
  m3Runtime.state.credentials.anthropic.qa = buildAnthropicClaudeCredential({
    access: "QA_M3_NEW_ACCESS",
    refresh: "QA_M3_NEW_REFRESH",
    expiresAtMs: firstNowMs + 14_400_000,
    emailAddress: "qa@example.com",
    organizationUuid: "org_qa",
  });
  const successor = await publishMaintainedCredential({
    store: m3Runtime.store,
    snapshot: m3Runtime.snapshot,
    state: m3Runtime.state,
    label: "qa",
    provider: "anthropic",
    updatedBy: "m3-login",
    observedAt: new Date(firstNowMs + 60_000).toISOString(),
  });
  assert.equal(successor.ok, true);
  assert.equal(successor.credential.record.provenance.lastSourceType, "login-maintenance");

  let launches = 0;
  assert.equal(await runCli(["claude", "run", "qa", "--home", m5Home], {
    ...deps,
    nowImpl: () => firstNowMs + 60_000,
    runClaudeCliImpl: () => {
      launches += 1;
      return { status: 0, signal: null };
    },
  }), "");
  assert.equal(launches, 1);

  snapshot = await readSnapshot(store);
  const currentRecord = snapshot.credentials.find(
    (record) => record.provider === "anthropic" && record.label === "qa",
  );
  assert.equal(currentRecord.version, 2);
  assertCanonicalAnthropicCredential(currentRecord, "QA_M3_NEW_REFRESH");
  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: m5Home, label: "qa" }),
    ".claude",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8")).claudeAiOauth.refreshToken,
    "QA_M3_NEW_REFRESH",
  );
  await closeRedisRuntime(m3Runtime);
});

test("managed Claude retries transient lease loss without pausing but aborts for a replacement owner", async () => {
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
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const heartbeatTimers = [];
  const rotationTimers = [];
  let resolveLaunch = null;
  let launchSignal = null;
  let exitCode = null;
  let markLaunchStarted;
  const launchStarted = new Promise((resolve) => {
    markLaunchStarted = resolve;
  });
  globalThis.setTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      unref() {},
    };
    heartbeatTimers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const command = handleClaude({
      opts: { afterDoubleDash: [] },
      positional: ["claude", "run", "claude"],
      homeDir: home,
      env: {},
      stdout: { write() {} },
      setExitCode: (value) => {
        exitCode = value;
      },
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      nowMs: Date.now(),
      setTimeoutImpl: (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        rotationTimers.push(timer);
        return timer;
      },
      clearTimeoutImpl(timer) {
        timer.cleared = true;
      },
      runClaudeCliImpl: ({ signal, registerProcessControl }) => {
        launchSignal = signal;
        assert.equal(registerProcessControl, undefined);
        markLaunchStarted();
        return new Promise((resolve) => {
          resolveLaunch = resolve;
          signal.addEventListener("abort", () => {
            resolve({ status: 1, signal: null });
          }, { once: true });
        });
      },
    });

    await launchStarted;
    const heartbeatTimer = heartbeatTimers.find(
      (timer) => timer.delay === 10_000 && timer.cleared === false,
    );
    assert.ok(heartbeatTimer);
    const originalEval = client.eval.bind(client);
    let rejectNextRecovery = true;
    let recoveryEvalCount = 0;
    client.eval = async (script, options) => {
      if (script.includes("AIMGR_CREDENTIAL_LEASE_RENEW_OR_REACQUIRE_V1")) {
        recoveryEvalCount += 1;
        if (rejectNextRecovery) {
          rejectNextRecovery = false;
          throw new Error("temporary Redis transport failure");
        }
      }
      return originalEval(script, options);
    };
    heartbeatTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchSignal.aborted, false);
    const recoveryCountAfterFailure = recoveryEvalCount;
    const retryTimer = heartbeatTimers.find(
      (timer) => timer !== heartbeatTimer && timer.delay === 10_000 && timer.cleared === false,
    );
    assert.ok(retryTimer);
    client.advanceTime(DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS + 1);
    retryTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchSignal.aborted, false);
    assert.ok(recoveryEvalCount > recoveryCountAfterFailure);
    assert.equal(
      [...client.values.keys()].some((key) => key.includes(":lease:credential:anthropic:claude")),
      true,
    );

    const contentionTimer = heartbeatTimers.find(
      (timer) => (
        timer !== heartbeatTimer
        && timer !== retryTimer
        && timer.delay === 10_000
        && timer.cleared === false
      ),
    );
    assert.ok(contentionTimer);
    client.advanceTime(DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS + 1);
    const replacement = await acquireRedisCredentialLease(store, {
      provider: "anthropic",
      label: "claude",
    });
    assert.ok(replacement);
    contentionTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchSignal.aborted, true);
    assert.equal(await replacement.renew(), true);
    await command;
    assert.equal(exitCode, 1);
    assert.equal(await replacement.release(), true);
  } finally {
    resolveLaunch?.({ status: 1, signal: null });
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("automatic Fable run skips a locked account and launches the lowest Fable usage", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const record = (label) => {
    const emailAddress = `${label}@example.com`;
    const organizationUuid = `org_${label}`;
    const credential = buildAnthropicClaudeCredential({
      access: `ACCESS_${label.toUpperCase()}`,
      refresh: `REFRESH_${label.toUpperCase()}`,
      expiresAtMs: nowMs + 3_600_000,
      emailAddress,
      organizationName: `${label} Org`,
      organizationUuid,
    });
    credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
    return {
      provider: "anthropic",
      label,
      credential,
      identity: {
        accountUuid: `acct_${label}`,
        emailAddress,
        organizationUuid,
      },
      policy: {
        expect: { email: emailAddress },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    };
  };
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  const records = [record("locked"), record("low"), record("high")];
  await importCredentialsSnapshot(store, {
    credentials: records,
  });
  const selectedConfigDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "high" }),
    ".claude",
  );
  const emptyTokens = structuredClone(records[2].credential.nativeClaudeBundle.claudeAiOauth);
  emptyTokens.accessToken = "";
  emptyTokens.refreshToken = "";
  writeJson(path.join(selectedConfigDir, ".credentials.json"), { claudeAiOauth: emptyTokens });
  writeJson(path.join(selectedConfigDir, ".claude.json"), {
    oauthAccount: records[2].credential.nativeClaudeBundle.oauthAccount,
  });
  const lockedLease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "locked",
  });
  const usageByAccessToken = {
    ACCESS_LOCKED: { fiveHour: 0, fable: 0 },
    ACCESS_LOW: { fiveHour: 10, fable: 80 },
    ACCESS_HIGH: { fiveHour: 70, fable: 10 },
  };
  let launchedLabel = null;

  const out = await runCli(["claude", "run", "fable", "--resume"], {
    env: { HOME: home },
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    fetchJsonWithTimeoutImpl: async (_url, options) => {
      const accessToken = String(options?.headers?.Authorization ?? "").replace(/^Bearer /, "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: {
            utilization: usageByAccessToken[accessToken].fiveHour,
            resets_at: new Date(nowMs + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(nowMs + 86_400_000).toISOString(),
          },
          seven_day_sonnet: {
            utilization: usageByAccessToken[accessToken].fable,
            resets_at: new Date(nowMs + 86_400_000).toISOString(),
          },
        }),
      };
    },
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ homeDir: launchHome, args }) => {
      launchedLabel = path.basename(launchHome);
      const projected = JSON.parse(
        fs.readFileSync(path.join(selectedConfigDir, ".credentials.json"), "utf8"),
      );
      assert.equal(projected.claudeAiOauth.accessToken, "ACCESS_HIGH");
      assert.equal(projected.claudeAiOauth.refreshToken, "REFRESH_HIGH");
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        "claude-fable-5",
        "--effort",
        "xhigh",
        "--resume",
      ]);
      return { status: 0, signal: null };
    },
  });

  assert.equal(out, "");
  assert.equal(launchedLabel, "high");
  await lockedLease.release();
});

test("explicit Claude run replaces incomplete credentials and malformed app state from Redis", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const credential = buildAnthropicClaudeCredential({
    access: "ACCESS_PRO4",
    refresh: "REFRESH_PRO4",
    expiresAtMs: nowMs + 3_600_000,
    emailAddress: "pro4@example.com",
    organizationName: "Pro4 Org",
    organizationUuid: "org_pro4",
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = "acct_pro4";
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "pro4",
      credential,
      identity: {
        accountUuid: "acct_pro4",
        emailAddress: "pro4@example.com",
        organizationUuid: "org_pro4",
      },
      policy: {
        expect: { email: "pro4@example.com" },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });
  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "pro4" }),
    ".claude",
  );
  const emptyOauth = structuredClone(credential.nativeClaudeBundle.claudeAiOauth);
  emptyOauth.accessToken = "";
  emptyOauth.refreshToken = "";
  writeJson(path.join(configDir, ".credentials.json"), { claudeAiOauth: emptyOauth });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ".claude.json"), "{malformed\n", { mode: 0o600 });
  let launched = false;
  const out = await runCli(["claude", "run", "pro4", "--home", home], {
    env: { HOME: home },
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ configDir: launchConfigDir }) => {
      const projected = JSON.parse(
        fs.readFileSync(path.join(launchConfigDir, ".credentials.json"), "utf8"),
      );
      assert.equal(projected.claudeAiOauth.accessToken, "ACCESS_PRO4");
      assert.equal(projected.claudeAiOauth.refreshToken, "REFRESH_PRO4");
      const appState = JSON.parse(fs.readFileSync(path.join(launchConfigDir, ".claude.json"), "utf8"));
      assert.equal(appState.oauthAccount.emailAddress, "pro4@example.com");
      launched = true;
      return { status: 0, signal: null };
    },
  });

  assert.equal(out, "");
  assert.equal(launched, true);
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.lastRunLabel, "pro4");
  assert.equal(local.targets.claudeCli.projectionReceiptsByLabel, undefined);
  assert.equal(fs.existsSync(path.join(configDir, ".credentials.json")), true);
});

test("claude resume reuses the exact recorded Fable model and effort", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const threadId = "11111111-1111-4111-8111-111111111111";
  const launchCwd = path.join(home, "workspace", "selected-project");
  fs.mkdirSync(launchCwd, { recursive: true });
  const sessionPath = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "claude",
    ".claude",
    "projects",
    "selected-project",
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      type: "user",
      sessionId: threadId,
      cwd: launchCwd,
      timestamp: "2026-07-24T17:00:00.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { model: "claude-fable-5" },
      effort: "xhigh",
      timestamp: "2026-07-24T17:00:01.000Z",
    }),
    "",
  ].join("\n"), "utf8");

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
      policy: {
        expect: { email: "boss@example.com" },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });

  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" });
  const configDir = path.join(claudeHome, ".claude");
  const out = await runCli(["claude", "resume", "1", "--home", home], {
    env: { HOME: home },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({
      userHomeDir,
      homeDir: actualClaudeHome,
      configDir: actualConfigDir,
      cwd,
      args,
    }) => {
      assert.equal(userHomeDir, home);
      assert.equal(actualClaudeHome, claudeHome);
      assert.equal(actualConfigDir, configDir);
      assert.equal(cwd, launchCwd);
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        "claude-fable-5",
        "--effort",
        "xhigh",
        "--resume",
        threadId,
      ]);
      return { status: 0, signal: null };
    },
  });

  assert.equal(out, "");
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
});

test("claude resume by name selects the lowest Fable account and honors an exact destination account", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const threadId = "66666666-6666-4666-8666-666666666666";
  const launchCwd = path.join(home, "workspace", "selected-project");
  const sourcePath = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "boss",
    ".claude",
    "projects",
    "selected-project",
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(launchCwd, { recursive: true });
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const sourceContent = [
    JSON.stringify({
      type: "user",
      sessionId: threadId,
      cwd: launchCwd,
      timestamp: "2026-07-24T17:00:00.000Z",
    }),
    JSON.stringify({
      type: "custom-title",
      customTitle: "Continue rate-limited work",
      timestamp: "2026-07-24T17:00:01.000Z",
    }),
    "",
  ].join("\n");
  fs.writeFileSync(sourcePath, sourceContent, "utf8");

  const record = (label) => {
    const emailAddress = `${label}@example.com`;
    const organizationUuid = `org_${label}`;
    const credential = buildAnthropicClaudeCredential({
      access: `ACCESS_${label.toUpperCase()}`,
      refresh: `REFRESH_${label.toUpperCase()}`,
      expiresAtMs: nowMs + 3_600_000,
      emailAddress,
      organizationName: `${label} Org`,
      organizationUuid,
    });
    credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
    return {
      provider: "anthropic",
      label,
      credential,
      identity: {
        accountUuid: `acct_${label}`,
        emailAddress,
        organizationUuid,
      },
      policy: {
        expect: { email: emailAddress },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    };
  };
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [record("boss"), record("fablelow"), record("opuslow"), record("specific")],
  });
  const usageByAccessToken = {
    ACCESS_BOSS: { fiveHour: 1, fable: 1 },
    ACCESS_FABLELOW: { fiveHour: 80, fable: 5 },
    ACCESS_OPUSLOW: { fiveHour: 10, fable: 60 },
    ACCESS_SPECIFIC: { fiveHour: 90, fable: 95 },
  };
  let launchedLabel = null;
  let targetConfigDir = null;
  const cliDeps = {
    env: { HOME: home },
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    fetchJsonWithTimeoutImpl: async (_url, options) => {
      const accessToken = String(options?.headers?.Authorization ?? "").replace(/^Bearer /, "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: {
            utilization: usageByAccessToken[accessToken].fiveHour,
            resets_at: new Date(nowMs + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(nowMs + 86_400_000).toISOString(),
          },
          seven_day_sonnet: {
            utilization: usageByAccessToken[accessToken].fable,
            resets_at: new Date(nowMs + 86_400_000).toISOString(),
          },
        }),
      };
    },
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ homeDir: launchHome, configDir, cwd, args }) => {
      launchedLabel = path.basename(launchHome);
      targetConfigDir = configDir;
      assert.equal(cwd, launchCwd);
      assert.equal(
        fs.readFileSync(path.join(
          configDir,
          "projects",
          "selected-project",
          `${threadId}.jsonl`,
        ), "utf8"),
        sourceContent,
      );
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        "claude-fable-5",
        "--effort",
        "xhigh",
        "--resume",
        threadId,
        "--fork-session",
        "--name",
        "[fork from boss/66666666] Continue rate-limited work",
      ]);
      return { status: 0, signal: null };
    },
  };
  const out = await runCli([
    "claude",
    "resume",
    "Continue rate-limited work",
    "--switch-account",
    "fable",
    "--home",
    home,
  ], cliDeps);

  assert.equal(
    out,
    "Switching session from boss to fablelow using fable as "
      + "\"[fork from boss/66666666] Continue rate-limited work\".\n",
  );
  assert.equal(launchedLabel, "fablelow");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
  assert.equal(
    fs.existsSync(path.join(
      targetConfigDir,
      "projects",
      "selected-project",
      `${threadId}.jsonl`,
    )),
    false,
  );

  const explicitOut = await runCli([
    "claude",
    "resume",
    "Continue rate-limited work",
    "--account",
    "specific",
    "--switch-account",
    "fable",
    "--home",
    home,
  ], cliDeps);
  assert.equal(
    explicitOut,
    "Switching session from boss to specific using fable as "
      + "\"[fork from boss/66666666] Continue rate-limited work\".\n",
  );
  assert.equal(launchedLabel, "specific");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
  assert.equal(
    fs.existsSync(path.join(
      targetConfigDir,
      "projects",
      "selected-project",
      `${threadId}.jsonl`,
    )),
    false,
  );
});

test("claude resume preserves Fable and uses Fable usage when the recorded account is busy", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const threadId = "33333333-3333-4333-8333-333333333333";
  const forkThreadId = "44444444-4444-4444-8444-444444444444";
  const launchCwd = path.join(home, "workspace", "selected-project");
  const sourceProjectDir = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "boss",
    ".claude",
    "projects",
    "selected-project",
  );
  const sourcePath = path.join(sourceProjectDir, `${threadId}.jsonl`);
  fs.mkdirSync(launchCwd, { recursive: true });
  fs.mkdirSync(sourceProjectDir, { recursive: true });
  const sourceContent = [
    JSON.stringify({
      type: "user",
      sessionId: threadId,
      cwd: launchCwd,
      timestamp: "2026-07-24T17:00:00.000Z",
    }),
    JSON.stringify({
      type: "custom-title",
      customTitle: "Review puzzle quality",
      timestamp: "2026-07-24T17:00:01.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { model: "claude-fable-5" },
      effort: "xhigh",
      timestamp: "2026-07-24T17:00:02.000Z",
    }),
    "",
  ].join("\n");
  fs.writeFileSync(sourcePath, sourceContent, "utf8");

  const record = (label) => {
    const emailAddress = `${label}@example.com`;
    const organizationUuid = `org_${label}`;
    const credential = buildAnthropicClaudeCredential({
      access: `ACCESS_${label.toUpperCase()}`,
      refresh: `REFRESH_${label.toUpperCase()}`,
      expiresAtMs: nowMs + 3_600_000,
      emailAddress,
      organizationName: `${label} Org`,
      organizationUuid,
    });
    credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
    return {
      provider: "anthropic",
      label,
      credential,
      identity: {
        accountUuid: `acct_${label}`,
        emailAddress,
        organizationUuid,
      },
      policy: {
        expect: { email: emailAddress },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    };
  };
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [record("boss"), record("low"), record("high")],
  });
  const sourceLease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "boss",
  });
  const usage = {
    ACCESS_BOSS: { fiveHour: 0, fable: 0 },
    ACCESS_LOW: { fiveHour: 10, fable: 70 },
    ACCESS_HIGH: { fiveHour: 70, fable: 5 },
  };
  let launchedLabel = null;
  let targetConfigDir = null;

  try {
    const out = await runCli(["claude", "resume", threadId, "--home", home], {
      env: { HOME: home },
      nowImpl: () => nowMs,
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
      fetchJsonWithTimeoutImpl: async (_url, options) => {
        const accessToken = String(options?.headers?.Authorization ?? "").replace(/^Bearer /, "");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: {
              utilization: usage[accessToken].fiveHour,
              resets_at: new Date(nowMs + 3_600_000).toISOString(),
            },
            seven_day: {
              utilization: 20,
              resets_at: new Date(nowMs + 86_400_000).toISOString(),
            },
            seven_day_sonnet: {
              utilization: usage[accessToken].fable,
              resets_at: new Date(nowMs + 86_400_000).toISOString(),
            },
          }),
        };
      },
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliImpl: ({
        homeDir: launchHome,
        configDir,
        cwd,
        args,
      }) => {
        launchedLabel = path.basename(launchHome);
        targetConfigDir = configDir;
        const stagedPath = path.join(
          configDir,
          "projects",
          "selected-project",
          `${threadId}.jsonl`,
        );
        const stagedMarkerPath = path.join(
          configDir,
          "projects",
          "selected-project",
          `${threadId}.aimgr-staged-fork`,
        );
        assert.equal(fs.readFileSync(stagedPath, "utf8"), sourceContent);
        assert.equal(fs.existsSync(stagedMarkerPath), true);
        assert.equal(cwd, launchCwd);
        assert.deepEqual(args, [
          "--dangerously-skip-permissions",
          "--model",
          "claude-fable-5",
          "--effort",
          "xhigh",
          "--resume",
          threadId,
          "--fork-session",
          "--name",
          "[fork from boss/33333333] Review puzzle quality",
        ]);
        fs.writeFileSync(
          path.join(configDir, "projects", "selected-project", `${forkThreadId}.jsonl`),
          `${JSON.stringify({
            type: "user",
            sessionId: forkThreadId,
            cwd: launchCwd,
            timestamp: "2026-07-24T18:00:00.000Z",
          })}\n${JSON.stringify({
            type: "custom-title",
            customTitle: "[fork from boss/33333333] Review puzzle quality",
            timestamp: "2026-07-24T18:00:01.000Z",
          })}\n`,
          "utf8",
        );
        return { status: 0, signal: null };
      },
    });

    assert.equal(
      out,
      'boss is busy; forking session onto high as "[fork from boss/33333333] Review puzzle quality".\n',
    );
    assert.equal(launchedLabel, "high");
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
    assert.equal(
      fs.existsSync(path.join(
        targetConfigDir,
        "projects",
        "selected-project",
        `${threadId}.jsonl`,
      )),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(
        targetConfigDir,
        "projects",
        "selected-project",
        `${threadId}.aimgr-staged-fork`,
      )),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(
        targetConfigDir,
        "projects",
        "selected-project",
        `${forkThreadId}.jsonl`,
      )),
      true,
    );

    const listed = JSON.parse(await runCli(["claude", "list", "--json", "--home", home]));
    const fork = listed.sessions.find((session) => session.threadId === forkThreadId);
    assert.equal(fork.account, "high");
    assert.equal(
      fork.threadName,
      "[fork from boss/33333333] Review puzzle quality",
    );
  } finally {
    await sourceLease.release();
  }
});

test("claude resume fails safely when the recorded account is busy and no destination is unlocked", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const threadId = "55555555-5555-4555-8555-555555555555";
  const launchCwd = path.join(home, "workspace", "selected-project");
  const sessionPath = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "boss",
    ".claude",
    "projects",
    "selected-project",
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(launchCwd, { recursive: true });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      type: "user",
      sessionId: threadId,
      cwd: launchCwd,
      timestamp: "2026-07-24T17:00:00.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { model: "claude-opus-5" },
      effort: "max",
      timestamp: "2026-07-24T17:00:01.000Z",
    }),
    "",
  ].join("\n"), "utf8");

  const credential = buildAnthropicClaudeCredential({
    expiresAtMs: nowMs + 3_600_000,
  });
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "boss",
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
    }],
  });
  const sourceLease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "boss",
  });
  const cliDeps = {
    env: { HOME: home },
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    fetchJsonWithTimeoutImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: {
          utilization: 0,
          resets_at: new Date(nowMs + 3_600_000).toISOString(),
        },
        seven_day: {
          utilization: 0,
          resets_at: new Date(nowMs + 86_400_000).toISOString(),
        },
      }),
    }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
  };

  try {
    await assert.rejects(
      runCli(["claude", "resume", threadId, "--home", home], cliDeps),
      /busy and no other unlocked Claude account/,
    );
  } finally {
    await sourceLease.release();
  }

  await assert.rejects(
    runCli([
      "claude",
      "resume",
      threadId,
      "--switch-account",
      "fable",
      "--home",
      home,
    ], cliDeps),
    /No other unlocked Claude account with readable Fable usage is available/,
  );
});

test("claude resume rejects a missing recorded directory before connecting to Redis", async () => {
  const home = mkTempHome();
  const threadId = "22222222-2222-4222-8222-222222222222";
  const sessionPath = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "claude",
    ".claude",
    "projects",
    "missing-project",
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({
    type: "user",
    sessionId: threadId,
    cwd: path.join(home, "workspace", "missing-project"),
    timestamp: "2026-07-24T17:00:00.000Z",
  })}\n`, "utf8");

  let redisCalls = 0;
  await assert.rejects(
    runCli(["claude", "resume", threadId, "--home", home], {
      env: { HOME: home },
      connectRedisStoreImpl: () => {
        redisCalls += 1;
        throw new Error("Redis must not be contacted");
      },
    }),
    /working directory is unavailable/,
  );
  assert.equal(redisCalls, 0);
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
  const originalMulti = client.multi.bind(client);
  let failNextPublication = false;
  client.multi = () => {
    const transaction = originalMulti();
    const execute = transaction.exec.bind(transaction);
    transaction.exec = async () => {
      if (failNextPublication) {
        failNextPublication = false;
        throw new Error("simulated Redis publication transport failure");
      }
      return execute();
    };
    return transaction;
  };
  let resolveLaunch;
  let markLaunchStarted;
  let launchResolved = false;
  let launchSignal = null;
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
    runClaudeCliImpl: ({ args, signal }) => {
      assert.deepEqual(args, ["--model", "opus"]);
      launchSignal = signal;
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
  failNextPublication = true;
  await timers.shift().callback();
  assert.equal(launchSignal.aborted, false);
  assert.equal(launchResolved, false);
  assert.equal((await readSnapshot(store)).credentials[0].version, 1);
  assert.equal(timers.length, 1);

  await timers.shift().callback();
  const rotated = await readSnapshot(store);
  assert.equal(launchResolved, false);
  assert.equal(rotated.credentials[0].version, 2);
  assertCanonicalAnthropicCredential(rotated.credentials[0], "CLAUDE_REFRESH_ROTATED");

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
  assertCanonicalAnthropicCredential(rotatedAgain.credentials[0], "CLAUDE_REFRESH_ROTATED_AGAIN");

  assert.equal(timers.length, 1);
  await timers.shift().callback();
  assert.equal((await readSnapshot(store)).credentials[0].version, 3);

  resolveLaunch();
  await command;
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
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
  let launches = 0;
  const context = {
    opts: { afterDoubleDash: [] },
    positional: ["claude", "run", "claude"],
    homeDir: home,
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    nowMs,
    runClaudeCliNoninteractiveImpl: (options) => {
      const { configDir, args, env, timeoutMs } = options;
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
      assert.equal(timeoutMs, 30_000);
      assert.equal(Object.hasOwn(options, "signal"), true);
      assert.equal(Object.hasOwn(options, "preparedLaunch"), false);
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
        expiresAt: nowMs + 2 * 60 * 60_000,
      });
      return { status: 0, signal: null, timedOut: false };
    },
  };
  const runtime = await loadRedisRuntime({
    homeDir: home,
    connectRedisStoreImpl: context.connectRedisStoreImpl,
  });

  try {
    assert.deepEqual(
      await maintainRedisClaudeCredential(context, { runtime, label: "claude" }),
      { outcome: "refreshed", reason: "credential_rotated" },
    );
    assert.equal(launches, 1);

    assert.deepEqual(
      await maintainRedisClaudeCredential(context, { runtime, label: "claude" }),
      { outcome: "skipped", reason: "not_due" },
    );
    assert.equal(launches, 1, "the under-lease freshness recheck must skip the provider");
    const snapshot = await readSnapshot(store);
    assertCanonicalAnthropicCredential(snapshot.credentials[0], "CLAUDE_REFRESH_ROTATED");
  } finally {
    await closeRedisRuntime(runtime);
  }
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
    const context = {
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
      runClaudeCliNoninteractiveImpl: ({ configDir }) => {
        if (clean) {
          fs.unlinkSync(resolveClaudeAuthFilePath(configDir));
          return { status: 0, signal: null, timedOut: false };
        }
        return { status: 2, signal: null, timedOut: false };
      },
    };
    const runtime = await loadRedisRuntime({
      homeDir: home,
      connectRedisStoreImpl: context.connectRedisStoreImpl,
    });
    try {
      const result = await maintainRedisClaudeCredential(context, {
        runtime,
        label: "claude",
      });
      return {
        client,
        home,
        result,
        snapshot: await readSnapshot(store),
      };
    } finally {
      await closeRedisRuntime(runtime);
    }
  };

  const terminal = await runCase({ clean: true });
  assert.equal(terminal.result.outcome, "reauth_required");
  assert.equal(
    terminal.snapshot.credentials[0].policy.reauth.blockedReason,
    "oauth_reauth_required",
  );

  const transient = await runCase({ clean: false });
  assert.deepEqual(transient.result, {
    outcome: "retryable",
    reason: "client_failed",
    detail: "claude /usage exited with status 2",
  });
  assert.equal(transient.snapshot.credentials[0].policy.reauth.blockedReason, undefined);
});

test("redis-configured claude run preserves a terminating signal and can relaunch", async () => {
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
  let resumedLaunches = 0;
  const resumedOut = await runCli(["claude", "run", "claude", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: () => {
      resumedLaunches += 1;
      return { status: 0, signal: null };
    },
  });
  assert.equal(resumedOut, "");
  assert.equal(resumedLaunches, 1);
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
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
  const assertAccountBusy = (error) => {
    assert.equal(error.code, "AIMGR_CREDENTIAL_BUSY");
    assert.equal(
      error.message,
      "Claude account \"claude\" is busy: another AIM process or machine is using or refreshing it. "
        + "Nothing started here. Wait up to one minute, then try again.",
    );
    return true;
  };
  await assert.rejects(
    runCli(["claude", "run", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    assertAccountBusy,
  );
  await assert.rejects(
    runCli(["claude", "import-native", "claude", "--in", path.join(home, "must-not-be-read.json"), "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    assertAccountBusy,
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
    assertAccountBusy,
  );
  assert.equal(keychainReads, 0);
  assert.equal(await lease.release(), true);
  assert.equal(fs.existsSync(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" })), false);
});

test("failed post-run publication retains the newer local candidate for the next run", async () => {
  const home = mkTempHome();
  const otherHome = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
  });
  for (const homeDir of [home, otherHome]) {
    writeAimgrConfig({
      homeDir,
      config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
    });
  }
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
  const originalMulti = client.multi.bind(client);
  let failNextPublication = false;
  client.multi = () => {
    const transaction = originalMulti();
    const execute = transaction.exec.bind(transaction);
    transaction.exec = async () => {
      if (failNextPublication) {
        failNextPublication = false;
        throw new Error("simulated Redis publication transport failure");
      }
      return execute();
    };
    return transaction;
  };

  const degradedOut = await runCli(["claude", "run", "claude", "--home", home], {
    ...deps,
    runClaudeCliImpl: ({ configDir }) => {
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
      });
      failNextPublication = true;
      return { status: 0, signal: null };
    },
  });
  assert.equal(
    degradedOut,
    "AIM coordination=degraded label=claude publication=retryable local_candidate=retained\n",
  );
  let snapshot = await readSnapshot(store);
  assertCanonicalAnthropicCredential(
    findSnapshotCredential(snapshot, "anthropic"),
    "CLAUDE_REFRESH",
  );

  let otherHomeLaunches = 0;
  assert.equal(await runCli(["claude", "run", "claude", "--home", otherHome], {
    ...deps,
    runClaudeCliImpl: ({ configDir }) => {
      otherHomeLaunches += 1;
      const projected = JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8"));
      assert.equal(projected.claudeAiOauth.refreshToken, "CLAUDE_REFRESH");
      return { status: 0, signal: null };
    },
  }), "");
  assert.equal(otherHomeLaunches, 1);

  let repairedLaunches = 0;
  assert.equal(await runCli(["claude", "run", "claude", "--home", home], {
    ...deps,
    runClaudeCliImpl: ({ configDir }) => {
      repairedLaunches += 1;
      const projected = JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8"));
      assert.equal(projected.claudeAiOauth.refreshToken, "CLAUDE_REFRESH_ROTATED");
      return { status: 0, signal: null };
    },
  }), "");
  assert.equal(repairedLaunches, 1);
  snapshot = await readSnapshot(store);
  assertCanonicalAnthropicCredential(
    findSnapshotCredential(snapshot, "anthropic"),
    "CLAUDE_REFRESH_ROTATED",
  );

  assert.deepEqual(
    await runCliWithExitCode(["claude", "run", "claude", "--home", home], {
      ...deps,
      runClaudeCliImpl: () => ({ status: 2, signal: null }),
    }),
    { stdout: "", exitCode: 2 },
  );
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

const MAINTENANCE_NOW_MS = Date.parse("2026-08-02T12:00:00.000Z");
const LANE_INSTALLATION_ID = "3f6b2a90-1234-4cde-8abc-0123456789ab";

async function setupClaudeMaintenanceLane({
  label = "claude",
  credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
    expiresAtMs: MAINTENANCE_NOW_MS + 4 * 60_000,
  }),
  reauthPolicy = { mode: "native-claude" },
} = {}) {
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
      label,
      credential,
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: {
        expect: { email: "boss@example.com" },
        reauth: reauthPolicy,
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    }],
  });
  return {
    home,
    client,
    store,
    label,
    credential,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  };
}

async function addSameLabelCodexTwin(lane) {
  const twin = codexRecord(lane.label, "acct_codex_twin");
  twin.policy = {
    expect: {},
    reauth: { mode: "codex-oauth" },
    browser: { mode: "isolated" },
    pool: { enabled: false },
  };
  await importCredentialsSnapshot(lane.store, {
    credentials: [twin],
  }, {
    updatedBy: "test",
    observedAt: new Date(MAINTENANCE_NOW_MS - 30_000).toISOString(),
  });
}

function findSnapshotCredential(snapshot, provider, label = "claude") {
  return snapshot.credentials.find(
    (record) => record.provider === provider && record.label === label,
  ) ?? null;
}

async function assertSameLabelCodexShadowsUnscopedView(lane) {
  const runtime = await loadRedisRuntime({
    homeDir: lane.home,
    connectRedisStoreImpl: lane.connectRedisStoreImpl,
  });
  try {
    assert.equal(runtime.state.accounts[lane.label].provider, "openai-codex");
    assert.deepEqual(runtime.state.accounts[lane.label].expect, {});
    assert.ok(findSnapshotCredential(runtime.snapshot, "anthropic", lane.label));
    assert.ok(findSnapshotCredential(runtime.snapshot, "openai-codex", lane.label));
  } finally {
    await closeRedisRuntime(runtime);
  }
}

function buildMaintenanceContext(lane, overrides = {}) {
  return {
    homeDir: lane.home,
    env: {},
    connectRedisStoreImpl: lane.connectRedisStoreImpl,
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    nowMs: MAINTENANCE_NOW_MS,
    runClaudeCliNoninteractiveImpl: () => ({ status: 0, signal: null, timedOut: false }),
    ...overrides,
  };
}

function maintenanceConfigDir(home, label = "claude") {
  return path.join(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label }), ".claude");
}


async function runMaintenancePass(lane, context, label = "claude") {
  const runtime = await loadRedisRuntime({
    homeDir: lane.home,
    connectRedisStoreImpl: lane.connectRedisStoreImpl,
  });
  try {
    return await maintainRedisClaudeCredential(context, { runtime, label });
  } finally {
    await closeRedisRuntime(runtime);
  }
}

test("Claude maintenance uses Anthropic policy under a same-label Codex shadow", async () => {
  const lane = await setupClaudeMaintenanceLane();
  const browserBinding = {
    userDataDir: path.join(lane.home, "browser-profile"),
    profileDirectory: "Default",
  };
  writeLocalState({
    homeDir: lane.home,
    localState: {
      installationId: LANE_INSTALLATION_ID,
      browserBindings: { [lane.label]: browserBinding },
    },
  });
  await addSameLabelCodexTwin(lane);
  const runtime = await loadRedisRuntime({
    homeDir: lane.home,
    connectRedisStoreImpl: lane.connectRedisStoreImpl,
  });
  const shadowedAccount = structuredClone(runtime.state.accounts[lane.label]);
  assert.equal(shadowedAccount.provider, "openai-codex");
  assert.deepEqual(shadowedAccount.expect, {});
  assert.deepEqual(runtime.localState.browserBindings[lane.label], browserBinding);
  let launches = 0;

  try {
    assert.deepEqual(await maintainRedisClaudeCredential(buildMaintenanceContext(lane, {
      runClaudeCliNoninteractiveImpl: () => {
        launches += 1;
        return { status: 0, signal: null, timedOut: false };
      },
    }), { runtime, label: lane.label }), {
      outcome: "unchanged",
      reason: "tokens_unchanged",
    });
    assert.deepEqual(runtime.state.accounts[lane.label], shadowedAccount);
  } finally {
    await closeRedisRuntime(runtime);
  }
  assert.equal(launches, 1);
  const localState = JSON.parse(fs.readFileSync(
    resolveAimgrLocalStatePath({ homeDir: lane.home }),
    "utf8",
  ));
  assert.deepEqual(localState.browserBindings[lane.label], browserBinding);
});

test("Claude maintenance publishes reauth under a same-label Codex collision", async () => {
  const firstFailedAt = new Date(MAINTENANCE_NOW_MS - 3 * 60 * 60_000).toISOString();
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: { firstFailedAt, reason: "client_failed", count: 12 },
    },
  });
  await addSameLabelCodexTwin(lane);
  await assertSameLabelCodexShadowsUnscopedView(lane);
  const before = await readSnapshot(lane.store);
  const beforeAnthropic = findSnapshotCredential(before, "anthropic");
  const beforeCodex = findSnapshotCredential(before, "openai-codex");

  const result = await runMaintenancePass(lane, buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: () => ({ status: 2, signal: null, timedOut: false }),
  }));
  assert.equal(result.outcome, "reauth_required");
  assert.equal(result.reason, "escalated_persistent_failure");
  assert.match(result.detail, /client_failed/);

  const after = await readSnapshot(lane.store);
  const afterAnthropic = findSnapshotCredential(after, "anthropic");
  const afterCodex = findSnapshotCredential(after, "openai-codex");
  assert.equal(afterAnthropic.version, beforeAnthropic.version + 1);
  assert.deepEqual(afterAnthropic.credential, beforeAnthropic.credential);
  assert.deepEqual(afterAnthropic.identity, beforeAnthropic.identity);
  assert.deepEqual(afterAnthropic.provenance, beforeAnthropic.provenance);
  assert.deepEqual(afterAnthropic.policy.expect, beforeAnthropic.policy.expect);
  assert.deepEqual(afterAnthropic.policy.browser, beforeAnthropic.policy.browser);
  assert.deepEqual(afterAnthropic.policy.pool, beforeAnthropic.policy.pool);
  assert.equal(afterAnthropic.policy.reauth.mode, "native-claude");
  assert.equal(afterAnthropic.policy.reauth.blockedReason, "oauth_reauth_required");
  assert.deepEqual(afterAnthropic.policy.reauth.maintenance, {
    firstFailedAt,
    reason: "client_failed",
    count: 13,
  });
  assert.deepEqual(afterCodex, beforeCodex);
});

test("Claude maintenance preserves Anthropic policy on rotation under a same-label Codex collision", async () => {
  const lane = await setupClaudeMaintenanceLane();
  await addSameLabelCodexTwin(lane);
  await assertSameLabelCodexShadowsUnscopedView(lane);
  const before = await readSnapshot(lane.store);
  const beforeAnthropic = findSnapshotCredential(before, "anthropic");
  const beforeCodex = findSnapshotCredential(before, "openai-codex");

  assert.deepEqual(await runMaintenancePass(lane, buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: ({ configDir }) => {
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
        expiresAt: MAINTENANCE_NOW_MS + 2 * 60 * 60_000,
      });
      return { status: 0, signal: null, timedOut: false };
    },
  })), {
    outcome: "refreshed",
    reason: "credential_rotated",
  });

  const after = await readSnapshot(lane.store);
  const afterAnthropic = findSnapshotCredential(after, "anthropic");
  const afterCodex = findSnapshotCredential(after, "openai-codex");
  assert.equal(afterAnthropic.version, beforeAnthropic.version + 1);
  assert.deepEqual(afterAnthropic.policy, beforeAnthropic.policy);
  assertCanonicalAnthropicCredential(afterAnthropic, "CLAUDE_REFRESH_ROTATED");
  assert.deepEqual(afterCodex, beforeCodex);
});

test("Claude maintenance rejects stale reauth CAS under a same-label Codex collision", async () => {
  const firstFailedAt = new Date(MAINTENANCE_NOW_MS - 3 * 60 * 60_000).toISOString();
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: { firstFailedAt, reason: "client_failed", count: 12 },
    },
  });
  await addSameLabelCodexTwin(lane);
  const before = await readSnapshot(lane.store);
  const beforeCodex = findSnapshotCredential(before, "openai-codex");

  const result = await runMaintenancePass(lane, buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: async () => {
      const snapshot = await readSnapshot(lane.store);
      const current = findSnapshotCredential(snapshot, "anthropic");
      const concurrent = await publishCredential(lane.store, {
        expectedVersion: current.version,
        updatedBy: "concurrent-test",
        observedAt: new Date(MAINTENANCE_NOW_MS).toISOString(),
        credentialRecord: {
          ...current,
          policy: {
            ...current.policy,
            reauth: { ...current.policy.reauth, concurrentMarker: "preserved" },
          },
        },
      });
      assert.equal(concurrent.ok, true);
      return { status: 2, signal: null, timedOut: false };
    },
  }));
  assert.deepEqual(result, {
    outcome: "retryable",
    reason: "client_failed",
    detail: "claude /usage exited with status 2",
  });

  const after = await readSnapshot(lane.store);
  const afterAnthropic = findSnapshotCredential(after, "anthropic");
  const afterCodex = findSnapshotCredential(after, "openai-codex");
  assert.equal(afterAnthropic.version, 2);
  assert.equal(afterAnthropic.policy.reauth.concurrentMarker, "preserved");
  assert.equal(afterAnthropic.policy.reauth.blockedReason, undefined);
  assert.deepEqual(afterAnthropic.policy.reauth.maintenance, {
    firstFailedAt,
    reason: "client_failed",
    count: 12,
  });
  assert.deepEqual(afterCodex, beforeCodex);
});

test("Claude maintenance escalates a persistent identical failure to reauth_required past the window", async () => {
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: {
        firstFailedAt: new Date(MAINTENANCE_NOW_MS - 3 * 60 * 60_000).toISOString(),
        reason: "client_failed",
        count: 12,
      },
    },
  });
  const context = buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: () => ({ status: 2, signal: null, timedOut: false }),
  });

  const result = await runMaintenancePass(lane, context);
  assert.equal(result.outcome, "reauth_required");
  assert.equal(result.reason, "escalated_persistent_failure");
  assert.match(result.detail, /client_failed/);
  let snapshot = await readSnapshot(lane.store);
  const reauth = snapshot.credentials[0].policy.reauth;
  assert.equal(reauth.blockedReason, "oauth_reauth_required");
  assert.equal(reauth.maintenance.reason, "client_failed");
  assert.equal(reauth.maintenance.count, 13);

  assert.deepEqual(await runMaintenancePass(lane, context), {
    outcome: "skipped",
    reason: "reauth_already_required",
  });
  snapshot = await readSnapshot(lane.store);
  assert.equal(snapshot.credentials[0].policy.reauth.blockedReason, "oauth_reauth_required");
});

test("Claude maintenance only advances the failure streak inside the escalation window", async () => {
  const firstFailedAt = new Date(MAINTENANCE_NOW_MS - 30 * 60_000).toISOString();
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: { firstFailedAt, reason: "client_failed", count: 1 },
    },
  });
  const context = buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: () => ({ status: 2, signal: null, timedOut: false }),
  });

  assert.deepEqual(await runMaintenancePass(lane, context), {
    outcome: "retryable",
    reason: "client_failed",
    detail: "claude /usage exited with status 2",
  });
  const snapshot = await readSnapshot(lane.store);
  const reauth = snapshot.credentials[0].policy.reauth;
  assert.equal(reauth.blockedReason, undefined);
  assert.deepEqual(reauth.maintenance, { firstFailedAt, reason: "client_failed", count: 2 });
});

test("Claude maintenance resets the failure streak when the failure reason changes", async () => {
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: {
        firstFailedAt: new Date(MAINTENANCE_NOW_MS - 3 * 60 * 60_000).toISOString(),
        reason: "local_state_conflict",
        count: 40,
      },
    },
  });
  const context = buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: () => ({ status: 2, signal: null, timedOut: false }),
  });

  const result = await runMaintenancePass(lane, context);
  assert.equal(result.outcome, "retryable");
  assert.equal(result.reason, "client_failed");
  const snapshot = await readSnapshot(lane.store);
  const reauth = snapshot.credentials[0].policy.reauth;
  assert.equal(reauth.blockedReason, undefined);
  assert.deepEqual(reauth.maintenance, {
    firstFailedAt: new Date(MAINTENANCE_NOW_MS).toISOString(),
    reason: "client_failed",
    count: 1,
  });
});

test("Claude maintenance clears the failure streak on a successful refresh", async () => {
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: {
      mode: "native-claude",
      maintenance: {
        firstFailedAt: new Date(MAINTENANCE_NOW_MS - 30 * 60_000).toISOString(),
        reason: "client_failed",
        count: 7,
      },
    },
  });
  const context = buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: ({ configDir }) => {
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
        expiresAt: MAINTENANCE_NOW_MS + 2 * 60 * 60_000,
      });
      return { status: 0, signal: null, timedOut: false };
    },
  });

  assert.deepEqual(await runMaintenancePass(lane, context), {
    outcome: "refreshed",
    reason: "credential_rotated",
  });
  const snapshot = await readSnapshot(lane.store);
  const reauth = snapshot.credentials[0].policy.reauth;
  assert.equal(reauth.blockedReason, undefined);
  assert.equal(reauth.maintenance, undefined);
  assertCanonicalAnthropicCredential(snapshot.credentials[0], "CLAUDE_REFRESH_ROTATED");
});

test("Claude maintenance never escalates an infrastructure-class failure", async () => {
  const streak = {
    firstFailedAt: new Date(MAINTENANCE_NOW_MS - 3 * 60 * 60_000).toISOString(),
    reason: "client_failed",
    count: 50,
  };
  const lane = await setupClaudeMaintenanceLane({
    reauthPolicy: { mode: "native-claude", maintenance: streak },
  });
  const context = buildMaintenanceContext(lane, {
    runClaudeCliNoninteractiveImpl: () => ({ status: null, signal: null, timedOut: true }),
  });

  assert.deepEqual(await runMaintenancePass(lane, context), {
    outcome: "retryable",
    reason: "client_timeout",
    detail: "claude /usage timed out after 30000ms",
  });
  const snapshot = await readSnapshot(lane.store);
  const reauth = snapshot.credentials[0].policy.reauth;
  assert.equal(reauth.blockedReason, undefined);
  assert.deepEqual(reauth.maintenance, streak, "an infra failure must not touch the streak");
});

test("redis-configured claude import-native clears the escalation marker and failure streak", async () => {
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
      policy: {
        expect: { email: "boss@example.com" },
        reauth: {
          blockedReason: "oauth_reauth_required",
          maintenance: {
            firstFailedAt: "2026-08-02T08:00:00.000Z",
            reason: "local_state_conflict",
            count: 200,
          },
        },
        pool: { enabled: true },
      },
    }],
  });
  const bundleFile = path.join(home, "bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: bundleFile,
    nativeClaudeBundle: buildAnthropicClaudeCredential().nativeClaudeBundle,
  });

  await runCli(["claude", "import-native", "claude", "--in", bundleFile, "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const snapshot = await readSnapshot(store);
  const reauth = snapshot.credentials.find((entry) => entry.label === "claude").policy.reauth;
  assert.equal(reauth.blockedReason, undefined);
  assert.equal(reauth.maintenance, undefined);
  assert.equal(snapshot.credentials[0].health.status, "ready");
});
