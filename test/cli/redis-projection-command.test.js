import { ClaudeRouteError } from "../../src/network/claude-egress-policy.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig as writeConfig } from "../../src/config/aimgr-config.js";
import {
  connectRedisStore,
  importCredentialsSnapshot as importSnapshot,
  publishCredential,
  readSnapshot,
  writeAccountNote,
} from "../../src/coordination/redis-store.js";
import {
  closeRedisRuntime,
  loadRedisRuntime,
} from "../../src/coordination/runtime.js";
import { publishMaintainedCredential } from "../../src/coordination/login-publish.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import {
  resolveAimgrLocalStatePath,
  resolveAimgrClaudeLabelHomeDir,
  resolveClaudeAuthFilePath,
  resolveCodexAuthFilePath,
  resolveManagedCodexHomeDir,
  resolveManagedPiAgentDir,
  resolvePiAuthFilePath,
} from "../../src/io/paths.js";
import { maintainRedisClaudeCredential } from "../../src/credentials/claude-maintenance.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { readClaudeOfflineBinding, acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";
import { assertLocalClaudeProfileStopped } from "../../src/network/claude-native-route.js";
import { registerCliRedisFixture, runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { CLAUDE_TEST_ENVIRONMENT, localClaudeFixture, readClaudeTestEnvironment } from "../helpers/claude-local.js";
import { readLocalClaudeCredential, markLocalClaudeGrantRejected } from "../../src/credentials/claude-local.js";
import { joinLocalClaudeSessions } from "../../src/targets/claude-machine-lease.js";

import { activeCodexAuthFile, localCodexFixture, readCodexTestEnvironment } from "../helpers/codex-local.js";
import { readLocalCodexCredential } from "../../src/credentials/codex-local.js";

const PREFIX = "aimgr:projection-test";

async function proxyAssignmentFixture(t) {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  writeConfig({ homeDir: home, config: {
    redis: { url: "redis://fake:6379", keyPrefix: PREFIX },
    claudeProxyProfiles: {
      a: { socksPort: 1085, expectedExits: ["127.0.0.2"] },
      b: { socksPort: 1086, expectedExits: ["127.0.0.3"] },
    },
  } });
  const record = {
    provider: "anthropic", label: "claude", credential: buildAnthropicClaudeCredential(),
    identity: { accountUuid: "acct_boss", emailAddress: "boss@example.com", organizationUuid: "org_boss" },
    policy: { expect: { email: "boss@example.com" }, pool: { enabled: true }, egress: { profileRef: "a" } },
    health: { status: "ready", reason: null },
  };
  await importSnapshot(store, { credentials: [record] }, { updatedBy: "proxy-assignment-test" });
  await localClaudeFixture(home, record);
  const deps = {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
  };
  return {
    home, client, store,
    set: overrides => runCli(["claude", "proxy", "set", "claude", "b"], { ...deps, assertLocalClaudeProfileStoppedImpl: async () => {}, ...overrides }),
    run: runClaudeCliImpl => runCli(["claude", "run", "claude"], { ...deps, runClaudeCliImpl }),
    offline: () => runCli(["claude", "run", "claude"], { ...deps,
      connectRedisStoreImpl: async () => { throw new Error("Redis unavailable"); },
      runClaudeCliImpl: () => { throw new Error("stale offline assignment reached spawn"); },
    }),
  };
}

test("Claude launches offline with its local grant and cached assigned proxy", async t => {
  const lane = await proxyAssignmentFixture(t);
  await lane.run(({ egressProfile }) => {
    assert.equal(egressProfile.profileRef, "a");
    return { status: 0, signal: null };
  });
  const binding = readClaudeOfflineBinding(lane.home, "claude");
  assert.equal(binding.egress.profileRef, "a");
  const metadata = (await readSnapshot(lane.store)).credentials[0];
  assert.equal(readLocalClaudeCredential({ homeDir: lane.home, label: "claude", metadata,
    environment: CLAUDE_TEST_ENVIRONMENT }).status, "ready");

  let launches = 0;
  const output = await runCli(["claude", "run", "claude", "--", "--model", "offline-model"], {
    env: { HOME: lane.home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: async () => { throw new Error("Redis unavailable"); },
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ egressProfile, args }) => {
      launches += 1;
      assert.equal(egressProfile.profileRef, "a");
      assert.equal(egressProfile.socksPort, 1085);
      assert.deepEqual(args, ["--model", "offline-model"]);
      return { status: 0, signal: null };
    },
  });
  assert.equal(output, "[aim] Account notes unavailable.\n");
  assert.equal(launches, 1);
  assert.deepEqual(readClaudeOfflineBinding(lane.home, "claude"), binding);
});

test("proxy reassignment refuses surviving local children and invalidates its old offline binding", async t => {
  const lane = await proxyAssignmentFixture(t);
  await lane.run(() => ({ status: 0, signal: null }));
  assert.equal(readClaudeOfflineBinding(lane.home, "claude").egress.profileRef, "a");
  const root = path.join(lane.home, "cgroup");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  const events = path.join(root, "a", "cgroup.events");
  fs.writeFileSync(events, "populated 1\nfrozen 0\n");
  const assertLocalClaudeProfileStoppedImpl = profileRef => assertLocalClaudeProfileStopped(profileRef, { cgroupRoot: root, platform: "linux" });
  await assert.rejects(lane.set({ assertLocalClaudeProfileStoppedImpl }), /still has local native work/);
  assert.equal((await readSnapshot(lane.store)).credentials[0].policy.egress.profileRef, "a");
  assert.equal(readClaudeOfflineBinding(lane.home, "claude").egress.profileRef, "a");
  fs.writeFileSync(events, "populated 0\nfrozen 0\n");
  await lane.set({ assertLocalClaudeProfileStoppedImpl });
  assert.equal((await readSnapshot(lane.store)).credentials[0].policy.egress.profileRef, "b");
  assert.deepEqual(readClaudeOfflineBinding(lane.home, "claude"), { required: true, invalidated: true });
  // An unrelated account can save a stale aggregate state without reviving A.
  writeLocalState({ homeDir: lane.home, localState: { targets: { claudeCli: { egressByLabel: { claude: { egress: { profileRef: "a" } } } } } } });
  await assert.rejects(lane.offline(), /no verified local account metadata/i);
});

test("Darwin proxy reassignment refuses missing installed metadata before changing policy or cache", async t => {
  const lane = await proxyAssignmentFixture(t);
  await lane.run(() => ({ status: 0, signal: null }));
  const before = await readSnapshot(lane.store);
  const cached = readClaudeOfflineBinding(lane.home, "claude");
  await assert.rejects(lane.set({ assertLocalClaudeProfileStoppedImpl: () => assertLocalClaudeProfileStopped("missing-reassignment-fixture", { platform: "darwin" }) }), /cannot verify stopped native work.*metadata.*Repair/);
  assert.deepEqual((await readSnapshot(lane.store)).credentials, before.credentials);
  assert.deepEqual(readClaudeOfflineBinding(lane.home, "claude"), cached);
  await assertLocalClaudeProfileStopped(undefined, { platform: "darwin" });
});

test("proxy setter refuses an active launcher, preserves credential writes, and round-trips assignment", async t => {
  const lane = await proxyAssignmentFixture(t);
  const original = await readSnapshot(lane.store);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const running = lane.run(async ({ egressProfile }) => {
    assert.equal(egressProfile.profileRef, "a");
    started.resolve();
    await finish.promise;
    return { status: 0, signal: null };
  });
  try {
    await started.promise;
    await assert.rejects(lane.set(), /local assignment lock is unavailable/);
    assert.equal((await readSnapshot(lane.store)).credentials[0].policy.egress.profileRef, "a");
  } finally { finish.resolve(); await running; }
  await lane.set();
  const assigned = await readSnapshot(lane.store);
  assert.equal(assigned.credentials[0].policy.egress.profileRef, "b");
  assert.deepEqual(assigned.credentials[0].credential, original.credentials[0].credential);
  assert.deepEqual(assigned.credentials[0].policy.expect, original.credentials[0].policy.expect);
  assert.deepEqual(assigned.credentials[0].policy.pool, original.credentials[0].policy.pool);

  const staleState = buildCoordinationView(original);
  const stale = await publishMaintainedCredential({ store: lane.store, snapshot: original,
    state: staleState, label: "claude", provider: "anthropic" });
  assert.equal(stale.ok, false, "stale credential publication must lose CAS");
  // After re-reading Redis, even an old account view cannot restore route A.
  const fresh = await publishMaintainedCredential({ store: lane.store, snapshot: assigned,
    state: staleState, label: "claude", provider: "anthropic" });
  assert.equal(fresh.ok, true);
  const exported = await readSnapshot(lane.store);
  assert.equal(exported.credentials[0].policy.egress.profileRef, "b");
  const independent = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "second-machine" });
  await importSnapshot(independent, exported, { updatedBy: "restore-test" });
  assert.deepEqual((await readSnapshot(independent)).credentials[0].policy.egress, { profileRef: "b" });
  await lane.run(({ egressProfile }) => {
    assert.equal(egressProfile.profileRef, "b");
    return { status: 0, signal: null };
  });
});

test("local assignment fence permits shared cached sessions and excludes only their account's setter", async t => {
  const lane = await proxyAssignmentFixture(t);
  const one = await acquireClaudeAssignmentLock(lane.home, "claude");
  const two = await acquireClaudeAssignmentLock(lane.home, "claude");
  const unrelated = await acquireClaudeAssignmentLock(lane.home, "other");
  try {
    await assert.rejects(lane.set(), /local assignment lock is unavailable/);
    await one.release();
    await assert.rejects(lane.set(), /local assignment lock is unavailable/);
    await two.release();
    await lane.set();
    assert.equal((await readSnapshot(lane.store)).credentials[0].policy.egress.profileRef, "b");
  } finally { await one.release(); await two.release(); await unrelated.release(); }
});

test("online Claude holds the local shared lock and refuses exclusive migration before launch", async t => {
  const lane = await proxyAssignmentFixture(t);
  await lane.run(async ({ assignmentLock }) => {
    assignmentLock.assertOwned();
    await assert.rejects(acquireClaudeAssignmentLock(lane.home, "claude", { exclusive: true }), /lock is unavailable/);
    const sibling = await acquireClaudeAssignmentLock(lane.home, "claude");
    await sibling.release();
    return { status: 0, signal: null };
  });
  const exclusive = await acquireClaudeAssignmentLock(lane.home, "claude", { exclusive: true });
  try {
    await assert.rejects(lane.run(() => assert.fail("exclusive migration reached launch")), /lock is unavailable/);
  } finally { await exclusive.release(); }
  await lane.run(() => ({ status: 0, signal: null }));
});

test("releasing the locally owned assignment descriptor invalidates its guard", async t => {
  const lane = await proxyAssignmentFixture(t);
  const lock = await acquireClaudeAssignmentLock(lane.home, "claude");
  lock.assertOwned();
  await lock.release();
  assert.equal(lock.signal.aborted, true);
  assert.throws(lock.assertOwned, /assignment lock is unavailable/);
  await lock.release();
  const next = await acquireClaudeAssignmentLock(lane.home, "claude", { exclusive: true });
  await next.release();
});

test("proxy setter holding the local assignment lock prevents admission until the new assignment is published", async t => {
  const lane = await proxyAssignmentFixture(t);
  await lane.run(() => ({ status: 0, signal: null }));
  const acquired = Promise.withResolvers();
  const publish = Promise.withResolvers();
  const setting = lane.set({
    assertLocalClaudeProfileStoppedImpl: async () => {
      acquired.resolve();
      await publish.promise;
    },
  });
  try {
    await Promise.race([acquired.promise, setting.then(() => { throw new Error("setter finished before taking the assignment lock"); })]);
    await assert.rejects(lane.run(() => { throw new Error("busy launcher reached process spawn"); }),
      /local assignment lock is unavailable/);
    await assert.rejects(lane.offline(), /local assignment lock is unavailable/);
  } finally { publish.resolve(); await setting; }
  await lane.run(({ egressProfile }) => {
    assert.equal(egressProfile.profileRef, "b");
    return { status: 0, signal: null };
  });
});

// These projection tests inject the native launcher and HTTP responses. Supply
// the required account assignment; the network suite exercises real routing.
function writeAimgrConfig(options) {
  return writeConfig({ ...options, config: { ...options.config,
    claudeProxyProfiles: { test: { socksPort: 1085, expectedExits: ["127.0.0.2"] } },
  } });
}
function importCredentialsSnapshot(store, snapshot, options) {
  return importSnapshot(store, { ...snapshot, credentials: snapshot.credentials.map(record =>
    record.provider === "anthropic"
      ? { ...record, policy: { ...record.policy, egress: { profileRef: "test" } } }
      : record) }, options);
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
  for (const record of records) localCodexFixture(home, record.identity.accountId, record.credential);
  registerCliRedisFixture(home, { readCodexEnvironmentImpl: readCodexTestEnvironment });
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

test("redis-configured codex use selects its separate local grant and keeps secrets out of adjunct state", async () => {
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

  const auth = JSON.parse(fs.readFileSync(activeCodexAuthFile(home), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.codexCli.activeLabel, "boss");
  assert.doesNotMatch(JSON.stringify(local), /REFRESH_BOSS/);
});

test("redis-configured automatic codex use selects the lowest current weekly usage", async () => {
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
  assert.deepEqual(result.activated.receipt.reasons, ["lowest_weekly_used"]);
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
  assert.equal(Object.hasOwn(result, "reconciliation"), false);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
  const auth = JSON.parse(fs.readFileSync(activeCodexAuthFile(home), "utf8"));
  assert.equal(auth.tokens.refresh_token, "LOCAL_REFRESH_BOSS");
});

test("codex watch reads native rotation from its environment without publishing it", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home, client });

  await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED", Date.now() + 2 * 3600_000);
  writeJson(activeCodexAuthFile(home), {
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
  assert.equal(Object.hasOwn(result, "reconciliation"), false);
  assert.equal(readLocalCodexCredential({ homeDir: home, accountId: "acct_boss", environment: readCodexTestEnvironment() }).credential.refresh, "REFRESH_ROTATED");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
});

test("two Redis-configured AIM homes keep separate authorizations when one rotates", async () => {
  const homeA = mkTempHome();
  const homeB = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home: homeA, client });
  writeAimgrConfig({
    homeDir: homeB,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });

  localCodexFixture(homeB, "acct_boss", codexCredential("acct_boss", "REFRESH_HOME_B"));
  registerCliRedisFixture(homeB, { readCodexEnvironmentImpl: readCodexTestEnvironment });

  await runCli(["codex", "use", "boss", "--home", homeA], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  await runCli(["codex", "use", "boss", "--home", homeB], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });

  const rotated = codexCredential(
    "acct_boss",
    "REFRESH_ROTATED_BY_HOME_A",
    Date.now() + 2 * 3600_000,
  );
  writeJson(activeCodexAuthFile(homeA), {
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
  assert.equal(Object.hasOwn(JSON.parse(watchOut), "reconciliation"), false);

  await runCli(["codex", "use", "boss", "--home", homeB], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const homeBAuth = JSON.parse(fs.readFileSync(activeCodexAuthFile(homeB), "utf8"));
  assert.equal(homeBAuth.tokens.refresh_token, "LOCAL_REFRESH_HOME_B");
  assert.equal(JSON.parse(fs.readFileSync(activeCodexAuthFile(homeA), "utf8")).tokens.refresh_token, "REFRESH_ROTATED_BY_HOME_A");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
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

test("redis-configured claude run keeps its per-label login and rotation local", async () => {
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
  const initial = await readSnapshot(store);
  await localClaudeFixture(home, initial.credentials[0]);

  await writeAccountNote(store, { provider: "anthropic", label: "claude", note: "Reserved for Mac Mini 1", expectedVersion: null });

  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" });
  const configDir = path.join(claudeHome, ".claude");
  let preflightCount = 0;
  let keychainCalls = 0;
  const out = await runCli(["claude", "run", "claude", "opus", "--resume"], {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver((options) => {
      preflightCount += 1;
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
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
        "xhigh",
        "--resume",
      ]);
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
      });
      const localStatePath = resolveAimgrLocalStatePath({ homeDir: home });
      const concurrent = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      concurrent.targets.primeAgent = { liveBindingMarker: "newer-prime-state" };
      writeJson(localStatePath, concurrent);
      return { status: 0, signal: null };
    },
  });

  assert.match(out, /anthropic \/ claude: "Reserved for Mac Mini 1"/);
  assert.equal(preflightCount, 1);
  assert.equal(keychainCalls, 0);
  const snapshot = await readSnapshot(store);
  const credentialRecord = snapshot.credentials.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  assert.deepEqual(credentialRecord, initial.credentials[0]);
  assert.equal(JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8")).claudeAiOauth.refreshToken, "CLAUDE_REFRESH_ROTATED");
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
  assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.lastRunLabel, "claude");
  assert.equal(local.targets.claudeCli.credentialsPath, undefined);
  assert.equal(local.targets.claudeCli.projectionReceiptsByLabel, undefined);
  assert.deepEqual(local.targets.primeAgent, { liveBindingMarker: "newer-prime-state" });
  assert.doesNotMatch(JSON.stringify(local), /CLAUDE_REFRESH_ROTATED/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("automatic Fable run accounts for local sessions and launches the account with more capacity", async (t) => {
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
  for (const account of records) await localClaudeFixture(home, account);
  const selectedConfigDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "low" }),
    ".claude",
  );
  const leaveSession = await joinLocalClaudeSessions({ homeDir: home, label: "locked", pid: process.pid });
  t.after(leaveSession);
  const usageByAccessToken = {
    ACCESS_LOCKED: { fiveHour: 0, fable: 0 },
    ACCESS_LOW: { fiveHour: 10, fable: 80 },
    ACCESS_HIGH: { fiveHour: 70, fable: 10 },
  };
  let launchedLabel = null;

  const out = await runCli(["claude", "run", "fable", "--resume"], {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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
      assert.equal(projected.claudeAiOauth.accessToken, "ACCESS_LOW");
      assert.equal(projected.claudeAiOauth.refreshToken, "REFRESH_LOW");
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        "fable",
        "--effort",
        "xhigh",
        "--resume",
      ]);
      return { status: 0, signal: null };
    },
  });

  assert.equal(out, "");
  assert.equal(launchedLabel, "low");
});

test("protected Claude preserves corrupt app state and launches after local state is restored", async () => {
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
  await localClaudeFixture(home, (await readSnapshot(store)).credentials[0]);
  const configDir = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "pro4" }),
    ".claude",
  );
  const originalCredential = fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8");
  const originalAppState = fs.readFileSync(path.join(configDir, ".claude.json"), "utf8");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ".claude.json"), "{malformed\n", { mode: 0o600 });
  await assert.rejects(runCli(["claude", "run", "pro4", "--home", home], {
    env: { HOME: home }, nowImpl: () => nowMs,
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: () => assert.fail("corrupt private identity reached native launch"),
  }), /needs local sign-in.*aim claude login pro4/);
  assert.equal(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8"), "{malformed\n");
  assert.equal(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8"), originalCredential);
  fs.writeFileSync(path.join(configDir, ".claude.json"), originalAppState, { mode: 0o600 });
  let launched = false;
  const out = await runCli(["claude", "run", "pro4", "--home", home], {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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

for (const picker of [false, true]) {
test(`claude resume ${picker ? "picker" : "row selector"} reuses the exact recorded Fable model and effort`, async () => {
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
  await localClaudeFixture(home, (await readSnapshot(store)).credentials[0]);
  const configDir = path.join(claudeHome, ".claude");
  let launches = 0;
  const out = await runCli(["claude", "resume", ...(picker ? [] : ["1"]), "--home", home], {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => {
      // A different session becomes newest after the picker has rendered.
      // Choosing row 1 must still resume the session that was displayed there.
      fs.writeFileSync(path.join(path.dirname(sessionPath), "22222222-2222-4222-8222-222222222222.jsonl"), JSON.stringify({
        type: "user", cwd: launchCwd, timestamp: new Date().toISOString(),
      }) + "\n");
      return "1";
    },
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({
      userHomeDir,
      homeDir: actualClaudeHome,
      configDir: actualConfigDir,
      cwd,
      args,
    }) => {
      launches += 1;
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

  if (picker) assert.match(out, /Claude sessions · newest first/);
  else assert.equal(out, "");
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(resolveClaudeAuthFilePath(configDir)), true);
});
}

for (const preset of ["fable", "opus", "sonnet"]) {
for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
test(`claude resume --switch-account ${preset} preserves ${effort} effort with automatic and exact account selection`, async () => {
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
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { model: "claude-opus-5-5" },
      effort,
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
    credentials: [record("boss"), record("fablelow"), record("opuslow"), record("specific")],
  });
  for (const account of (await readSnapshot(store)).credentials) await localClaudeFixture(home, account);
  const usageByAccessToken = {
    ACCESS_BOSS: { fiveHour: 1, fable: 1 },
    ACCESS_FABLELOW: { fiveHour: 80, fable: 5 },
    ACCESS_OPUSLOW: { fiveHour: 10, fable: 60 },
    ACCESS_SPECIFIC: { fiveHour: 90, fable: 95 },
  };
  let launchedLabel = null;
  let targetConfigDir = null;
  let stagedPath = null;
  const cliDeps = {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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
      const resumeIndex = args.findIndex((arg) => arg === "--resume" || arg === "-r" || arg.startsWith("--resume="));
      stagedPath = args[resumeIndex].startsWith("--resume=")
        ? args[resumeIndex].slice("--resume=".length)
        : args[resumeIndex + 1];
      assert.equal(stagedPath.startsWith(path.join(configDir, "projects")), true);
      assert.notEqual(path.basename(stagedPath), `${threadId}.jsonl`);
      const stagedEntries = fs.readFileSync(stagedPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(stagedEntries[0].cwd, launchCwd);
      assert.notEqual(stagedEntries[0].sessionId, threadId);
      assert.deepEqual(args, [
        "--dangerously-skip-permissions",
        "--model",
        { fable: "fable", opus: "opus", sonnet: "sonnet" }[preset],
        "--effort",
        effort,
        "--resume",
        stagedPath,
        "--fork-session",
        "--name",
        "Continue rate-limited work",
      ]);
      return { status: 0, signal: null };
    },
  };
  const out = await runCli([
    "claude",
    "resume",
    "Continue rate-limited work",
    "--switch-account",
    preset,
    "--home",
    home,
  ], cliDeps);

  assert.equal(
    out,
    `Switching session from boss to opuslow using ${preset} as `
      + "\"Continue rate-limited work\".\n",
  );
  assert.equal(launchedLabel, "opuslow");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
  assert.equal(fs.existsSync(stagedPath), false);
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
    preset,
    "--home",
    home,
  ], cliDeps);
  assert.equal(
    explicitOut,
    `Switching session from boss to specific using ${preset} as `
      + "\"Continue rate-limited work\".\n",
  );
  assert.equal(launchedLabel, "specific");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
  assert.equal(fs.existsSync(stagedPath), false);
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
}
}

for (const sourceState of ["reauth_required", "not_signed_in"]) {
test(`claude resume preserves model, effort and history when the recorded account is ${sourceState}`, async () => {
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
  const sourceRecord = record("boss");
  const lowRecord = record("low");
  const highRecord = record("high");
  await importCredentialsSnapshot(store, {
    credentials: [sourceRecord, lowRecord, highRecord],
  });
  await localClaudeFixture(home, lowRecord);
  await localClaudeFixture(home, highRecord);
  if (sourceState === "reauth_required") {
    await localClaudeFixture(home, sourceRecord);
    const local = readLocalClaudeCredential({ homeDir: home, label: "boss", metadata: sourceRecord, environment: CLAUDE_TEST_ENVIRONMENT });
    await markLocalClaudeGrantRejected({ homeDir: home, label: "boss", metadata: sourceRecord, environment: CLAUDE_TEST_ENVIRONMENT,
      grantId: local.owner.grant.id, generation: local.generation });
  }
  const usage = {
    ACCESS_BOSS: { fiveHour: 0, fable: 0 },
    ACCESS_LOW: { fiveHour: 10, fable: 70 },
    ACCESS_HIGH: { fiveHour: 70, fable: 5 },
  };
  let launchedLabel = null;
  let targetConfigDir = null;
  let stagedPath = null;

  try {
    {
      await assert.rejects(runCli(["claude", "run", "boss", "--home", home], {
        readClaudeEnvironmentImpl: readClaudeTestEnvironment,
        connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
        resolveExecutableOnPathImpl: () => { throw new Error("Must reject before client preparation"); },
        runClaudeCliImpl: () => { throw new Error("Must never open a logged-out client"); },
      }), /needs local sign-in.*aim claude login boss/);
    }
    const out = await runCli(["claude", "resume", threadId, "--home", home], {
      env: { HOME: home },
      readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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
        stagedPath = args[args.indexOf("--resume") + 1];
        const stagedMarkerPath = stagedPath.replace(/\.jsonl$/, ".aimgr-staged-fork");
        const stagedEntries = fs.readFileSync(stagedPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(stagedEntries.length, 3);
        assert.notEqual(stagedEntries[0].sessionId, threadId);
        assert.equal(fs.existsSync(stagedMarkerPath), true);
        assert.equal(cwd, launchCwd);
        assert.deepEqual(args, [
          "--dangerously-skip-permissions",
          "--model",
          "claude-fable-5",
          "--effort",
          "xhigh",
          "--resume",
          stagedPath,
          "--fork-session",
          "--name",
          "Review puzzle quality",
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
            customTitle: "Review puzzle quality",
            timestamp: "2026-07-24T18:00:01.000Z",
          })}\n`,
          "utf8",
        );
        return { status: 0, signal: null };
      },
    });

    assert.equal(
      out,
      'boss requires login; forking session onto low as "Review puzzle quality".\n',
    );
    assert.equal(launchedLabel, "low");
    assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
    assert.equal(fs.existsSync(stagedPath), false);
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
    assert.equal(fork.account, "low");
    assert.equal(
      fork.threadName,
      "Review puzzle quality",
    );
  } finally {
    // The temporary fork is cleaned by the launcher even when assertions fail.
  }
});
}

test("raw Claude resume stages a cross-account transcript and keeps same-account resume direct", async (t) => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  const threadId = "77777777-7777-4777-8777-777777777777";
  const toolId = "toolu_01RawResumeSourceToolABC";
  const sourcePath = path.join(
    home, ".aimgr", "claude-homes", "source", ".claude", "projects", "project", `${threadId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const sourceContent = [
    JSON.stringify({ type: "user", sessionId: threadId, cwd: process.cwd(), timestamp: new Date(nowMs).toISOString(),
      message: { role: "user", content: "Continue this exact history" } }),
    JSON.stringify({ type: "assistant", sessionId: threadId, cwd: process.cwd(),
      message: { id: "msg_01RawResumeMessageABCDEF", content: [{ type: "tool_use", id: toolId, name: "Read", input: {} }] } }),
    JSON.stringify({ type: "user", sessionId: threadId, cwd: process.cwd(),
      message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "prior result" }] } }),
    "",
  ].join("\n");
  fs.writeFileSync(sourcePath, sourceContent, "utf8");
  const unrelated = path.join(path.dirname(sourcePath), "88888888-8888-4888-8888-888888888888.jsonl");
  fs.writeFileSync(unrelated, sourceContent);
  for (const method of ["readFileSync", "openSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (...args) => {
      assert.notEqual(args[0], unrelated, "native resume opened unrelated history");
      return original(...args);
    });
  }
  const record = (label) => {
    const emailAddress = `${label}@example.com`;
    const credential = buildAnthropicClaudeCredential({
      access: `ACCESS_${label.toUpperCase()}`,
      refresh: `REFRESH_${label.toUpperCase()}`,
      expiresAtMs: nowMs + 3_600_000,
      emailAddress,
      organizationName: `${label} Org`,
      organizationUuid: `org_${label}`,
    });
    credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
    return {
      provider: "anthropic", label, credential,
      identity: { accountUuid: `acct_${label}`, emailAddress, organizationUuid: `org_${label}` },
      policy: { expect: { email: emailAddress }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    };
  };
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, { credentials: [record("source"), record("dest")] });
  for (const account of (await readSnapshot(store)).credentials) await localClaudeFixture(home, account);
  let stagedPath = null;
  let launches = 0;
  const deps = {
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    env: {
      HOME: home,
      ANTHROPIC_CUSTOM_HEADERS: "x-account-link: stable-id",
      CLAUDE_CODE_EXTRA_BODY: '{"stable_id":"same-on-both-accounts"}',
      AIMGR_TEST_SAFE_ENV: "keep",
    },
    nowImpl: () => nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: ({ homeDir: launchHome, args, env }) => {
      launches += 1;
      if (path.basename(launchHome) === "source") {
        assert.deepEqual(args, ["--resume", sourcePath]);
        assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-account-link: stable-id");
        return { status: 0, signal: null };
      }
      const resumeIndex = args.findIndex((arg) => arg === "--resume" || arg === "-r" || arg.startsWith("--resume="));
      stagedPath = args[resumeIndex].startsWith("--resume=")
        ? args[resumeIndex].slice("--resume=".length)
        : args[resumeIndex + 1];
      assert.equal(stagedPath.startsWith(path.join(home, ".aimgr", "claude-homes", "dest")), true);
      assert.notEqual(stagedPath, sourcePath);
      assert.equal(args.includes("--fork-session"), true);
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
      assert.equal(env.CLAUDE_CODE_EXTRA_BODY, undefined);
      assert.equal(env.AIMGR_TEST_SAFE_ENV, "keep");
      const staged = fs.readFileSync(stagedPath, "utf8");
      assert.equal(staged.includes(threadId), false);
      assert.equal(staged.includes(toolId), false);
      assert.equal(staged.includes("Continue this exact history"), true);
      const entries = staged.trim().split("\n").map(JSON.parse);
      assert.equal(entries[1].message.content[0].id, entries[2].message.content[0].tool_use_id);
      return { status: 0, signal: null };
    },
  };

  await runCli(["claude", "run", "dest", "--home", home, "--", "--resume", sourcePath], deps);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
  await runCli(["claude", "run", "dest", "--home", home, "--", "--resume", threadId], deps);
  assert.equal(fs.existsSync(stagedPath), false);
  await runCli(["claude", "run", "dest", "--home", home, "--", `--resume=${sourcePath}`], deps);
  assert.equal(fs.existsSync(stagedPath), false);
  await runCli(["claude", "run", "source", "--home", home, "--", "--resume", sourcePath], deps);
  const offline = await runCli(
    ["claude", "run", "dest", "--home", home, "--", "-r", sourcePath],
    { ...deps, connectRedisStoreImpl: async () => { throw new Error("simulated Redis outage"); } },
  );
  assert.equal(offline, "[aim] Account notes unavailable.\n");
  assert.equal(fs.existsSync(stagedPath), false);
  await assert.rejects(
    runCli(["claude", "run", "dest", "--home", home, "--", "--session-id", threadId], deps),
    /belongs to another account.*fresh ID/,
  );
  await assert.rejects(
    runCli(["claude", "run", "dest", "--home", home, "--", "--resume", sourcePath,
      "--session-id", "99999999-9999-4999-8999-999999999999"], deps),
    /Cross-account Claude resume cannot reuse an explicit session ID/,
  );
  assert.equal(launches, 5);
});

test("claude resume fails safely when the recorded account is signed out and no destination is available", async () => {
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
  const cliDeps = {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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

  await assert.rejects(
    runCli(["claude", "resume", threadId, "--home", home], cliDeps),
    /requires login and no other unlocked Claude account/,
  );

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
    /No other unlocked Claude account with usage left is available/,
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
  await localClaudeFixture(home, (await readSnapshot(store)).credentials[0]);
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signals.push({ pid, signal });
    return true;
  };
  try {
    const out = await runCli(["claude", "run", "claude", "--home", home], {
      env: {},
      readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
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

test("redis-configured claude use reports the supported commands", async () => {
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
    /Unsupported claude subcommand: use\. Use login, logout, list, resume, inventory, status, usage, run/,
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

async function seedSharedClaudeLabel(home, client) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "anthropic",
      label: "claude",
      credential: buildAnthropicClaudeCredential({ access: "CLAUDE_ACCESS", refresh: "CLAUDE_REFRESH" }),
      identity: {
        accountUuid: "acct_boss",
        emailAddress: "boss@example.com",
        organizationUuid: "org_boss",
      },
      policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    }],
  });
  await localClaudeFixture(home, (await readSnapshot(store)).credentials[0]);
  return store;
}

test("two Claude sessions on one machine share an account without rewriting its newer login", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedSharedClaudeLabel(home, client);
  const initial = await readSnapshot(store);
  const configDir = path.join(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" }), ".claude");
  const leaseHeld = () => [...client.values.keys()].some((key) => key.includes(":lease:credential:anthropic:claude"));
  const deps = {
    env: { HOME: home },
    readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
  };
  let secondSawRefreshToken = null;

  const out = await runCli(["claude", "run", "claude"], {
    ...deps,
    runClaudeCliImpl: async () => {
      // The first session's Claude refreshes the shared login.
      rotateProjectedClaudeCredential(configDir, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
      });
      const secondOut = await runCli(["claude", "run", "claude"], {
        ...deps,
        processId: process.ppid,
        // It refreshes again between the second launch's pre-run check and
        // its login write; that write must not put the older login back.
        resolveExecutableOnPathImpl: buildTestClaudeResolver((options) => {
          rotateProjectedClaudeCredential(configDir, {
            accessToken: "CLAUDE_ACCESS_ROTATED_AGAIN",
            refreshToken: "CLAUDE_REFRESH_ROTATED_AGAIN",
            expiresAt: Date.now() + 9_000_000,
          });
          return prepareTestClaudeLaunch(options);
        }),
        runClaudeCliImpl: () => {
          secondSawRefreshToken = JSON.parse(
            fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8"),
          ).claudeAiOauth.refreshToken;
          return { status: 0, signal: null };
        },
      });
      assert.doesNotMatch(secondOut, /busy|degraded/);
      assert.equal(leaseHeld(), false, "local Claude sessions do not acquire a Redis credential lease");
      return { status: 0, signal: null };
    },
  });

  assert.doesNotMatch(out, /busy|degraded/);
  assert.equal(secondSawRefreshToken, "CLAUDE_REFRESH_ROTATED_AGAIN");
  assert.equal(leaseHeld(), false);
  const record = (await readSnapshot(store)).credentials.find(
    (entry) => entry.provider === "anthropic" && entry.label === "claude",
  );
  assert.deepEqual(record, initial.credentials[0]);
  assert.equal(JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8")).claudeAiOauth.refreshToken, "CLAUDE_REFRESH_ROTATED_AGAIN");
});

test("a running local Claude session continues when Redis becomes unavailable", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedSharedClaudeLabel(home, client);
  const initial = await readSnapshot(store);
  const configDir = path.join(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" }), ".claude");
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let finished = false;
  let redisCalls = 0;
  const originalEval = client.eval;
  const command = runCli(["claude", "run", "claude"], {
    env: { HOME: home }, readClaudeEnvironmentImpl: readClaudeTestEnvironment,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    resolveExecutableOnPathImpl: buildTestClaudeResolver(),
    runClaudeCliImpl: async () => {
      client.eval = async () => { redisCalls += 1; throw new Error("Redis unavailable"); };
      started.resolve();
      await finish.promise;
      finished = true;
      return { status: 0, signal: null };
    },
  });
  try {
    await Promise.race([started.promise, command.then(() => { throw new Error("session exited before starting"); })]);
    rotateProjectedClaudeCredential(configDir, { accessToken: "SIBLING_ACCESS", refreshToken: "SIBLING_REFRESH" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(redisCalls, 0);
  } finally {
    finish.resolve();
    await command;
    client.eval = originalEval;
  }
  assert.equal(finished, true);
  assert.deepEqual((await readSnapshot(store)).credentials, initial.credentials);
  assert.equal(JSON.parse(fs.readFileSync(resolveClaudeAuthFilePath(configDir), "utf8")).claudeAiOauth.refreshToken, "SIBLING_REFRESH");
});

test("Claude maintenance reports proxy failures without escalating them to account reauthentication", async () => {
  const lane = await setupClaudeMaintenanceLane();
  for (const elapsed of [0, 3 * 60 * 60_000]) {
    const result = await runMaintenancePass(lane, buildMaintenanceContext(lane, {
      nowMs: MAINTENANCE_NOW_MS + elapsed,
      runClaudeCliNoninteractiveImpl: () => { throw new ClaudeRouteError("proxy_unavailable", { label: lane.label }); },
    }));
    assert.equal(result.outcome, "retryable");
    assert.equal(result.reason, "proxy_unavailable");
    const record = findSnapshotCredential(await readSnapshot(lane.store), "anthropic");
    assert.notEqual(record.policy.reauth?.blockedReason, "oauth_reauth_required");
  }
});
