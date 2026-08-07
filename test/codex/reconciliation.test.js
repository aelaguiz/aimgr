import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  activateCodexLabelSelection,
  activateCodexPoolSelection,
  reconcileCodexCliAuth,
} from "../../src/targets/codex-cli.js";
import { collectCodexUsageSnapshots } from "../../src/pool/usage.js";
import { resolveCodexAuthFilePath, resolveManagedCodexHomeDir, resolveNativeCodexHomeDir } from "../../src/io/paths.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

// AIM's rotating projection lives only in the managed home. The native
// Desktop home gets a sentinel in each test and must stay byte-identical.
function managedAuthPath(home) {
  return resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
}

const NATIVE_SENTINEL = `${JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { account_id: "acct_desktop_native" },
  last_refresh: "2026-01-01T00:00:00.000Z",
}, null, 2)}\n`;

function seedNativeSentinel(home) {
  const nativePath = resolveCodexAuthFilePath(resolveNativeCodexHomeDir({ homeDir: home }));
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.writeFileSync(nativePath, NATIVE_SENTINEL, "utf8");
  return nativePath;
}

function assertNativeUntouched(nativePath) {
  assert.equal(fs.readFileSync(nativePath, "utf8"), NATIVE_SENTINEL);
}

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

function stateFor(credentials) {
  const accounts = Object.fromEntries(
    Object.keys(credentials).map((label) => [
      label,
      { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    ]),
  );
  return {
    schemaVersion: "0.2",
    accounts,
    credentials: { "openai-codex": credentials, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };
}

function writeAuth(home, value) {
  writeJson(managedAuthPath(home), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: value.idToken,
      access_token: value.access,
      refresh_token: value.refresh,
      account_id: value.accountId,
    },
    last_refresh: new Date().toISOString(),
  });
}

test("Codex reconciliation chooses identical, newer-local, newer-Redis, and conflict deterministically", () => {
  const baseMs = Date.now() + 4 * 3_600_000;

  {
    const home = mkTempHome();
    const nativePath = seedNativeSentinel(home);
    const stored = credential("acct_boss", baseMs, "same");
    const state = stateFor({ boss: stored });
    state.targets.codexCli = { activeLabel: "boss", expectedAccountId: "acct_boss" };
    writeAuth(home, stored);
    assert.equal(reconcileCodexCliAuth({ state, homeDir: home }).status, "identical");
    assertNativeUntouched(nativePath);
  }

  {
    const home = mkTempHome();
    const stored = credential("acct_boss", baseMs, "old");
    const local = credential("acct_boss", baseMs + 3_600_000, "new");
    const state = stateFor({ boss: stored });
    state.targets.codexCli = { activeLabel: "boss", expectedAccountId: "acct_boss" };
    writeAuth(home, local);
    const nativePath = seedNativeSentinel(home);
    const result = reconcileCodexCliAuth({ state, homeDir: home });
    assert.equal(result.status, "local_newer");
    assert.equal(state.credentials["openai-codex"].boss.refresh, "REFRESH_new");
    assertNativeUntouched(nativePath);
  }

  {
    const home = mkTempHome();
    const stored = credential("acct_boss", baseMs + 3_600_000, "new");
    const local = credential("acct_boss", baseMs, "old");
    const state = stateFor({ boss: stored });
    state.targets.codexCli = { activeLabel: "boss", expectedAccountId: "acct_boss" };
    writeAuth(home, local);
    const nativePath = seedNativeSentinel(home);
    const result = reconcileCodexCliAuth({ state, homeDir: home });
    assert.equal(result.status, "redis_newer");
    const projected = JSON.parse(fs.readFileSync(managedAuthPath(home), "utf8"));
    assert.equal(projected.tokens.refresh_token, "REFRESH_new");
    assertNativeUntouched(nativePath);
  }

  {
    const home = mkTempHome();
    const stored = credential("acct_boss", baseMs, "redis");
    const local = credential("acct_boss", baseMs, "local");
    const state = stateFor({ boss: stored });
    state.targets.codexCli = { activeLabel: "boss", expectedAccountId: "acct_boss" };
    writeAuth(home, local);
    const result = reconcileCodexCliAuth({ state, homeDir: home });
    assert.deepEqual(
      { status: result.status, reason: result.reason },
      { status: "conflict", reason: "token_conflict_at_equal_expiry" },
    );
    assert.equal(state.credentials["openai-codex"].boss.refresh, "REFRESH_redis");
  }
});

test("Codex activation receipt reports the managed-home account as the true previous label", () => {
  const home = mkTempHome();
  const expiresAtMs = Date.now() + 4 * 3_600_000;
  const boss = credential("acct_boss", expiresAtMs, "boss");
  const pro3 = credential("acct_pro3", expiresAtMs, "pro3");
  const state = stateFor({ boss, pro3 });
  state.targets.codexCli = { activeLabel: "boss", expectedAccountId: "acct_boss" };
  writeAuth(home, pro3);

  const result = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });

  assert.equal(result.receipt.previousLabel, "pro3");
  assert.equal(result.receipt.label, "boss");
});

test("reselecting the current Codex account is a true file no-op", () => {
  const home = mkTempHome();
  const boss = credential("acct_boss", Date.now() + 4 * 3_600_000, "boss");
  const state = stateFor({ boss });

  const first = activateCodexLabelSelection({ state, homeDir: home, label: "boss" });
  const authPath = managedAuthPath(home);
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
        boss: { provider: "openai-codex", ok: true, windows: [{ label: "5h", usedPercent: 12 }] },
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

test("automatic Codex choice keeps a valid projected target when telemetry and cache are unavailable", async () => {
  const home = mkTempHome();
  const boss = credential("acct_boss", Date.now() + 4 * 3_600_000, "boss");
  const state = stateFor({ boss });
  assert.notEqual(activateCodexLabelSelection({ state, homeDir: home, label: "boss" }).status, "blocked");
  const authPath = managedAuthPath(home);
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
