import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { listen, startSocks } from "./socks-fixture.js";
import { createClaudeAccountTransport, checkClaudeRouteExit } from "../../src/network/claude-transport.js";
import { fetchJsonWithTimeout } from "../../src/io/fetch.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { normalizeCredentialRecord } from "../../src/coordination/records.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { resolveOptionalClaudeEgressProfile } from "../../src/network/claude-egress-policy.js";
import { prepareClaudeNativeRoute, resolveNativeAccountProfile } from "../../src/network/claude-native-route.js";
import { invalidateClaudeOfflineBinding, readClaudeOfflineBinding } from "../../src/network/claude-offline-binding.js";
import { runClaudeCli as realRunClaudeCli, runClaudeCliNoninteractive as realRunClaudeCliNoninteractive, prepareClaudeCliLaunch } from "../../src/targets/claude-runner.js";
import { fetchClaudeUsageSnapshot, probeUsageSnapshotsByProvider } from "../../src/pool/usage.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import { collectClaudeRedisAccountUsageStatus, selectLeastUsedUnlockedClaudeAccount } from "../../src/status/claude-redis-view.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { mkTempHome } from "../helpers/files.js";
import { installFixtureSecurityAdapter } from "./native-routine-fixture.js";

import { verifySyntheticExecutable, prepareSyntheticNativeInvocation, spawnSyntheticSupervisor, resolveSyntheticSecurityAdapter } from "../helpers/claude-native-invocation.js";
const runClaudeCli = options => realRunClaudeCli({ prepareClaudeNativeInvocationImpl: prepareSyntheticNativeInvocation, ...options });
const runClaudeCliNoninteractive = options => realRunClaudeCliNoninteractive({ verifyInstalledClaudeExecutableImpl: verifySyntheticExecutable,
  resolveInstalledClaudeSecurityAdapterImpl: resolveSyntheticSecurityAdapter,
  prepareClaudeNativeInvocationImpl: prepareSyntheticNativeInvocation, ...options });

const prefix = "optional-privacy-test:";
const forbidden = () => { throw new Error("ordinary account reached privacy machinery"); };
function paths(home) {
  const homeDir = path.join(home, ".aimgr", "claude-homes", "ordinary");
  return { command: process.execPath, userHomeDir: home, homeDir, configDir: path.join(homeDir, ".claude") };
}
async function fixture(t) {
  const home = mkTempHome();
  // Existing macOS credential storage dependency, unrelated to proxy opt-in.
  installFixtureSecurityAdapter(home);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix: prefix } } });
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: prefix });
  const credential = buildAnthropicClaudeCredential();
  const record = { provider: "anthropic", label: "ordinary", credential,
    identity: buildStableIdentityForCredential("anthropic", credential),
    policy: { expect: { email: "boss@example.com" }, pool: { enabled: true } }, health: { status: "ready" } };
  await importCredentialsSnapshot(store, { credentials: [record] }, { updatedBy: "optional-test" });
  return { home, record, client, store, connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: prefix }) };
}

test("ordinary account opts in only through an explicit valid policy, not local profile availability", () => {
  const profiles = { office: { socksPort: 1085, expectedExits: ["127.0.0.2"] } };
  assert.equal(resolveOptionalClaudeEgressProfile({ account: {}, profiles }), null);
  for (const egress of [null, {}, { profileRef: "" }, { profileRef: "direct" }, false,
    ...["manifest", "install", "a-sing-box", "a".repeat(129)].map(profileRef => ({ profileRef }))]) {
    assert.throws(() => normalizeCredentialRecord({ provider: "anthropic", label: "a", policy: { egress } }), { code: "invalid_proxy_assignment" });
    assert.throws(() => resolveOptionalClaudeEgressProfile({ account: { egress }, profiles }), { code: "invalid_proxy_assignment" });
  }
  assert.throws(() => resolveOptionalClaudeEgressProfile({ account: {}, previouslyProtected: true }), { code: "missing_proxy_assignment" });
  assert.throws(() => resolveOptionalClaudeEgressProfile({ account: { egress: { profileRef: "office" } } }), { code: "proxy_profile_unavailable" });
  assert.equal(resolveOptionalClaudeEgressProfile({ account: { egress: { profileRef: "office" } }, profiles }).profileRef, "office");
});

test("ordinary interactive and Darwin noninteractive launch preserve environment without privacy prerequisites", async t => {
  const { home } = await fixture(t);
  const prepared = paths(home);
  const env = { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://existing.example:3128", ALL_PROXY: "socks5://existing.example:1080", NO_PROXY: "localhost", DISABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "0", ORDINARY_TOOL_TOKEN: "synthetic" };
  const inspect = (command, args, options) => {
    assert.equal(command, process.execPath);
    for (const [key, value] of Object.entries(env)) assert.equal(options.env[key], value, key);
    assert.equal(options.cwd, home);
    return { status: 0, signal: null };
  };
  await runClaudeCli({ ...prepared, preparedLaunch: prepared, cwd: home, env, args: ["--resume", "synthetic-session"], prepareClaudeNativeRouteImpl: forbidden, spawnImpl: (command, args, options) => {
    assert.match(args[0], /claude-supervisor\.js$/);
    assert.deepEqual(args.slice(-2), ["--resume", "synthetic-session"]);
    return inspect(command, args, options);
  } });
  await runClaudeCliNoninteractive({ ...prepared, cwd: home, env, args: ["--version"], platform: "darwin",
    verifyInstalledClaudeExecutableImpl: async () => process.execPath,
    resolveInstalledClaudeSecurityAdapterImpl: () => null,
    prepareClaudeNativeRouteImpl: forbidden, spawnImpl: inspect });
  await assert.rejects(prepareClaudeNativeRoute({ profile: { label: "protected", profileRef: "missing-optional-test-profile" }, platform: "darwin", command: process.execPath, args: [] }), { code: "native_proxy_unavailable" });
});

test("ordinary synthetic CLI launch and pre-change offline cache work without proxy configuration", async t => {
  const { home, connectRedisStoreImpl } = await fixture(t);
  const proof = path.join(home, "child.json");
  const command = path.join(home, "synthetic-claude");
  fs.writeFileSync(command, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),proxy:process.env.HTTPS_PROXY,telemetry:process.env.DISABLE_TELEMETRY}));`, { mode: 0o700 });
  const resolveExecutableOnPathImpl = () => command;
  resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl = options => prepareClaudeCliLaunch({ ...options,
    verifyInstalledClaudeExecutableImpl: verifySyntheticExecutable, resolveInstalledClaudeSecurityAdapterImpl: resolveSyntheticSecurityAdapter });
  const deps = { env: { HOME: home, PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://existing.example:3128" }, connectRedisStoreImpl, resolveExecutableOnPathImpl,
    runClaudeCliImpl: options => runClaudeCli({ ...options, spawnImpl: spawnSyntheticSupervisor }) };
  await runCli(["claude", "run", "ordinary", "--", "--model", "preserved-model"], deps);
  const first = JSON.parse(fs.readFileSync(proof));
  assert.deepEqual(first.args.slice(-2), ["--model", "preserved-model"]);
  assert.equal(first.proxy, "http://existing.example:3128");
  assert.equal(first.telemetry, undefined);
  assert.equal(readClaudeOfflineBinding(home, "ordinary"), null);
  fs.unlinkSync(proof);
  await runCli(["claude", "run", "ordinary", "--", "--resume", "saved-session"], { ...deps, connectRedisStoreImpl: async () => { throw new Error("Redis offline"); } });
  assert.deepEqual(JSON.parse(fs.readFileSync(proof)).args.slice(-2), ["--resume", "saved-session"]);
  assert.equal(readClaudeOfflineBinding(home, "ordinary"), null, "ordinary cache acquires only local coordination, never a proxy assignment");
  invalidateClaudeOfflineBinding(home, "ordinary");
  fs.unlinkSync(proof);
  await assert.rejects(runCli(["claude", "run", "ordinary"], { ...deps, connectRedisStoreImpl: async () => { throw new Error("Redis offline"); } }), /cached proxy assignment/);
  await assert.rejects(runCli(["claude", "run", "ordinary"], deps), { code: "missing_proxy_assignment" });
  assert.equal(fs.existsSync(proof), false, "invalidated protected cache never spawns an ordinary child");
});

test("ordinary fresh usage/status/selection use existing fetch; protected missing config never reaches it", async t => {
  const { home, record, connectRedisStoreImpl } = await fixture(t);
  let calls = 0;
  const fetchJsonWithTimeoutImpl = async (...args) => {
    calls++;
    assert.equal(args.length, 3, "ordinary fetch has no account proxy dispatcher");
    assert.equal(args[0], "https://api.anthropic.com/api/oauth/usage");
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }) };
  };
  const usage = await fetchClaudeUsageSnapshot({ record, homeDir: home, fetchJsonWithTimeoutImpl, createClaudeAccountTransportImpl: forbidden });
  assert.equal(usage.ok, true);
  const status = await collectClaudeRedisAccountUsageStatus({ homeDir: home, fresh: true, connectRedisStoreImpl, fetchJsonWithTimeoutImpl });
  assert.equal(status.accounts[0].usage.ok, true);
  assert.equal(status.accounts[0].source, "live");
  assert.equal(selectLeastUsedUnlockedClaudeAccount(status, { preset: "sonnet" }).label, "ordinary");
  const count = calls;
  await assert.rejects(fetchClaudeUsageSnapshot({ record: { ...record, policy: { ...record.policy, egress: { profileRef: "missing" } } }, homeDir: home, fetchJsonWithTimeoutImpl }), { code: "proxy_profile_unavailable" });
  invalidateClaudeOfflineBinding(home, "ordinary");
  await assert.rejects(fetchClaudeUsageSnapshot({ record, homeDir: home, fetchJsonWithTimeoutImpl }), { code: "missing_proxy_assignment" });
  assert.equal(calls, count, "protected failures never call the ordinary fetch");
});

test("ordinary usage origin failure is not a proxy failure", async t => {
  const { home, record } = await fixture(t);
  const error = new Error("origin stalled"); error.name = "TimeoutError";
  await assert.rejects(fetchClaudeUsageSnapshot({ record, homeDir: home, fetchJsonWithTimeoutImpl: async () => { throw error; }, createClaudeAccountTransportImpl: forbidden }), value => value === error);
});

test("ordinary and protected HTTP accounts coexist and a down proxy cannot fall back to ordinary fetch", async t => {
  const { home, record } = await fixture(t);
  const receipts = [];
  const origin = http.createServer((req, res) => {
    if (req.url === "/exit") return res.end(JSON.stringify({ ip: req.socket.remoteAddress }));
    receipts.push({ label: req.url.slice(1), source: req.socket.remoteAddress });
    res.end(JSON.stringify({ five_hour: { utilization: 12 } }));
  });
  const port = await listen(origin);
  const socks = await startSocks({ sourceAddress: "127.0.0.2", destinations: { "mixed.test": port } });
  t.after(async () => { await socks.stop(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
  const protectedRecord = { ...record, label: "protected", policy: { ...record.policy, egress: { profileRef: "office" } } };
  const fetchUsage = record => fetchClaudeUsageSnapshot({ record, homeDir: home,
    profiles: { office: { socksPort: socks.port, expectedExits: ["127.0.0.2"] } }, timeoutMs: 250,
    createClaudeAccountTransportImpl: options => createClaudeAccountTransport({ ...options,
      checkRouteExitImpl: (profile, options) => checkClaudeRouteExit({ ...profile, exitCheckUrl: "http://mixed.test/exit" }, options) }),
    fetchJsonWithTimeoutImpl: (_url, init, timeout, options) => fetchJsonWithTimeout(
      record.label === "ordinary" ? `http://127.0.0.1:${port}/ordinary` : "http://mixed.test/protected", init, timeout, options),
  });
  const results = await Promise.all([fetchUsage(record), fetchUsage(protectedRecord)]);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(receipts.find(row => row.label === "ordinary"), { label: "ordinary", source: "127.0.0.1" });
  assert.deepEqual(receipts.find(row => row.label === "protected"), { label: "protected", source: "127.0.0.2" });
  await socks.stop();
  await assert.rejects(fetchUsage(protectedRecord), { code: "proxy_unavailable" });
  assert.equal((await fetchUsage(record)).ok, true);
  assert.equal(receipts.filter(row => row.label === "protected").length, 1);
});

test("protected launch failure never retries the ordinary executable and keeps account/proxy in the error", async t => {
  const { home } = await fixture(t);
  const prepared = paths(home);
  const profile = { label: "protected", profileRef: "missing-install", socksHost: "127.0.0.1", socksPort: 1, expectedExits: ["127.0.0.2"] };
  let spawns = 0;
  await assert.rejects(runClaudeCli({ ...prepared, preparedLaunch: prepared, cwd: home, egressProfile: profile, spawnImpl: () => { spawns++; return { status: 0 }; } }), error => {
    assert.equal(error.code, "native_proxy_unavailable");
    assert.match(error.message, /protected.*missing-install/);
    return true;
  });
  assert.equal(spawns, 0);
  assert.throws(() => resolveNativeAccountProfile({ homeDir: home, label: "protected", state: { accounts: { protected: { egress: { profileRef: "missing" } } } } }), { code: "proxy_profile_unavailable" });
});

test("shared provider labels retain Claude policy and never send Claude tokens through ordinary fetch", async t => {
  const { home, record } = await fixture(t);
  const state = buildCoordinationView({ credentials: [
    { ...record, policy: { ...record.policy, egress: { profileRef: "missing" } } },
    { provider: "openai-codex", label: record.label, credential: { access: "CODEX_ONLY" }, policy: {} },
  ] });
  const seen = [];
  const fetchJsonWithTimeoutImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    return { ok: true, json: async () => ({}) };
  };
  const result = await probeUsageSnapshotsByProvider(state, { homeDir: home, fetchJsonWithTimeoutImpl });
  assert.equal(result.anthropic.ordinary.routeError.code, "proxy_profile_unavailable");
  assert.deepEqual(seen, ["Bearer CODEX_ONLY"]);
  delete state.accountsByProvider;
  await assert.rejects(fetchClaudeUsageSnapshot({ state, label: record.label, homeDir: home, fetchJsonWithTimeoutImpl }), { code: "missing_proxy_assignment" });
  assert.deepEqual(seen, ["Bearer CODEX_ONLY"]);
});
