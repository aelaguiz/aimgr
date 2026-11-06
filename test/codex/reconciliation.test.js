import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  activateCodexLabelSelection,
  activateCodexPoolSelection,
} from "../../src/targets/codex-cli.js";
import { CODEX_TEST_ENVIRONMENT, localCodexFixture } from "../helpers/codex-local.js";
import { codexAccountPaths } from "../../src/privacy/codex-account-state.js";
import { logoutLocalCodexCredential } from "../../src/credentials/codex-local.js";
import { localCodexRecords } from "../../src/coordination/codex-runtime.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { collectCodexUsageSnapshots } from "../../src/pool/usage.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

function credential(accountId, expiresAtMs, marker) {
  const token = makeFakeJwt({
    exp: Math.floor(expiresAtMs / 1000),
    marker,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  return {
    access: token,
    refresh: `REFRESH_${marker}`,
    idToken: token,
    expiresAt: new Date(Math.floor(expiresAtMs / 1000) * 1000).toISOString(),
    accountId,
  };
}

function stateFor(credentials, home) {
  if (home) credentials = Object.fromEntries(Object.entries(credentials).map(([label, value]) => [label, localCodexFixture(home, value.accountId, value).credential]));
  const accounts = Object.fromEntries(
    Object.keys(credentials).map((label) => [
      label,
      { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    ]),
  );
  return {
    schemaVersion: "0.2",
    codexEnvironment: CODEX_TEST_ENVIRONMENT,
    accounts,
    credentials: { "openai-codex": credentials, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };
}

test("pool metadata never hydrates or replaces environment-local grants, regardless of global expiry", async () => {
  const home = mkTempHome(), client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "fixture:local-authority" });
  const foreign = credential("acct_boss", Date.now() + 8 * 3_600_000, "foreign");
  await importCredentialsSnapshot(store, { credentials: [{ provider: "openai-codex", label: "boss",
    identity: { accountId: foreign.accountId }, credential: foreign, policy: { pool: { enabled: true } } }] }, { updatedBy: "test" });
  // A client-side GET would transfer the foreign tokens before any filtering.
  client.get = async () => assert.fail("Codex metadata must be projected inside Redis");
  const options = { homeDir: home, environment: CODEX_TEST_ENVIRONMENT, store };
  assert.equal((await localCodexRecords(options))[0].health.reason, "login_required");
  const local = credential("acct_boss", Date.now() + 3_600_000, "independent");
  const saved = localCodexFixture(home, local.accountId, local);
  const record = (await localCodexRecords(options))[0];
  assert.equal(record.credential.refresh, "LOCAL_REFRESH_independent");
  assert.equal(record.health.status, "ready");
  logoutLocalCodexCredential({ ...options, accountId: local.accountId });
  assert.equal((await localCodexRecords(options))[0].health.reason, "login_required");
  assert.equal(fs.existsSync(path.join(saved.paths.accountRoot, "auth.json")), false);
});

test("account selection preserves the previous account's authorization and installation identity", () => {
  const home = mkTempHome(), expiresAtMs = Date.now() + 4 * 3_600_000;
  const state = stateFor({ boss: credential("acct_boss", expiresAtMs, "boss"),
    pro3: credential("acct_pro3", expiresAtMs, "pro3") }, home);
  const previous = activateCodexLabelSelection({ state, homeDir: home, label: "pro3" });
  const previousAuth = path.join(previous.prepared.accountRoot, "auth.json");
  const before = fs.readFileSync(previousAuth, "utf8");
  const result = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });
  assert.equal(result.receipt.previousLabel, "pro3");
  assert.equal(result.receipt.label, "boss");
  assert.notEqual(result.prepared.accountRoot, previous.prepared.accountRoot);
  assert.notEqual(result.prepared.installationId, previous.prepared.installationId);
  assert.equal(fs.readFileSync(previousAuth, "utf8"), before);
});

test("damaged active authorization cannot prevent selecting a healthy account", async t => {
  for (const corruption of ["invalid-json", "permissions"]) for (const selection of ["explicit", "pool"]) {
    await t.test(`${corruption}, ${selection}`, async () => {
      const home = mkTempHome(), expiry = Date.now() + 4 * 3_600_000;
      const state = stateFor({ boss: credential("acct_boss", expiry, "boss"), writer: credential("acct_writer", expiry, "writer") }, home);
      const first = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });
      const auth = path.join(first.prepared.accountRoot, "auth.json");
      if (corruption === "invalid-json") fs.writeFileSync(auth, "{bad");
      else fs.chmodSync(auth, 0o644);
      const result = selection === "explicit"
        ? activateCodexLabelSelection({ state, homeDir: home, label: "writer" })
        : await activateCodexPoolSelection({ state, homeDir: home, avoidCurrentLabel: true,
          selectLeastUsed: true, usageByProvider: { "openai-codex": {
            boss: { ok: true, windows: [{ label: "Week", usedPercent: 20 }] },
            writer: { ok: true, windows: [{ label: "Week", usedPercent: 10 }] },
          } } });
      assert.equal(result.status, "activated");
      assert.equal(result.prepared.accountId, "acct_writer");
      assert.equal(result.receipt.previousLabel, "boss");
      fs.rmSync(home, { recursive: true, force: true });
    });
  }
});

test("reselecting the current Codex account is a true file no-op", () => {
  const home = mkTempHome();
  const boss = credential("acct_boss", Date.now() + 4 * 3_600_000, "boss");
  const state = stateFor({ boss }, home);

  const first = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });
  const authPath = path.join(codexAccountPaths({ homeDir: home, accountId: "acct_boss", environment: CODEX_TEST_ENVIRONMENT }).accountRoot, "auth.json");
  const before = fs.readFileSync(authPath, "utf8");
  const second = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });

  assert.equal(first.status, "activated");
  assert.equal(second.status, "noop");
  assert.equal(second.wrote, false);
  assert.equal(second.receipt.wroteAuthJson, false);
  assert.equal(fs.readFileSync(authPath, "utf8"), before);
});

test("Codex snapshot is cache-first, probes stale labels only, and binds cache to the credential", async () => {
  const home = mkTempHome();
  const nowMs = Date.now();
  const boss = credential("acct_boss", nowMs + 4 * 3_600_000, "boss");
  const state = stateFor({ boss });
  const live = await collectCodexUsageSnapshots({
    state,
    homeDir: home,
    nowMs,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: {
          provider: "openai-codex",
          ok: true,
          resetCreditsAvailable: 4,
          windows: [{ label: "5h", usedPercent: 12 }],
        },
      },
      anthropic: {},
    }),
  });
  assert.equal(live["openai-codex"].boss.source, "live");

  let freshProbeCalls = 0;
  const cached = await collectCodexUsageSnapshots({
    state,
    homeDir: home,
    nowMs: nowMs + 90_000,
    probeUsageSnapshotsByProviderImpl: async () => {
      freshProbeCalls += 1;
      throw new Error("fresh cache must prevent telemetry work");
    },
  });
  assert.equal(cached["openai-codex"].boss.source, "cache");
  assert.equal(cached["openai-codex"].boss.stale, false);
  assert.equal(cached["openai-codex"].boss.ageMs, 90_000);
  assert.equal(cached["openai-codex"].boss.resetCreditsAvailable, 4);
  assert.equal(freshProbeCalls, 0);

  const staleFallback = await collectCodexUsageSnapshots({
    state,
    homeDir: home,
    nowMs: nowMs + 6 * 60_000,
    probeUsageSnapshotsByProviderImpl: async (reducedState) => {
      assert.deepEqual(Object.keys(reducedState.credentials["openai-codex"]), ["boss"]);
      throw new Error("telemetry unavailable");
    },
  });
  assert.equal(staleFallback["openai-codex"].boss.source, "cache");
  assert.equal(staleFallback["openai-codex"].boss.stale, true);
  assert.equal(staleFallback["openai-codex"].boss.ageMs, 6 * 60_000);

  state.credentials["openai-codex"].boss = credential("acct_boss", nowMs + 5 * 3_600_000, "rotated");
  const rejectedStale = await collectCodexUsageSnapshots({
    state,
    homeDir: home,
    nowMs: nowMs + 120_000,
    probeUsageSnapshotsByProviderImpl: async () => ({}),
  });
  assert.equal(rejectedStale["openai-codex"].boss.ok, false);
  assert.equal(rejectedStale["openai-codex"].boss.source, "unavailable");
});

test("automatic Codex choice keeps a valid local target when telemetry and cache are unavailable", async () => {
  const home = mkTempHome();
  const boss = credential("acct_boss", Date.now() + 4 * 3_600_000, "boss");
  const state = stateFor({ boss }, home);
  assert.notEqual(activateCodexLabelSelection({ state, homeDir: home, label: "boss" }).status, "blocked");
  const authPath = path.join(codexAccountPaths({ homeDir: home, accountId: "acct_boss", environment: CODEX_TEST_ENVIRONMENT }).accountRoot, "auth.json");
  const before = fs.readFileSync(authPath, "utf8");

  const result = await activateCodexPoolSelection({
    state,
    homeDir: home,
    probeUsageSnapshotsByProviderImpl: async () => {
      throw new Error("telemetry unavailable");
    },
    selectLeastUsed: true,
  });

  assert.equal(result.status, "noop");
  assert.deepEqual(result.receipt.reasons, ["kept_current_usage_unavailable"]);
  assert.equal(fs.readFileSync(authPath, "utf8"), before);
});
