import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rebalanceHermesPool, syncHermesHomesForLabel } from "../../src/pool/hermes-rebalance.js";
import { writeHermesAuthFromState } from "../../src/targets/hermes-auth.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { writeHermesAuthFile } from "../helpers/hermes.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";

test("rebalance hermes rewrites live home auth via the shared planner and settles to noop on repeat", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const pro1Jwt = makeFakeJwt({
    email: "pro1@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro1",
      chatgpt_plan_type: "pro",
    },
  });
  const pro2Jwt = makeFakeJwt({
    email: "pro2@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro2",
      chatgpt_plan_type: "pro",
    },
  });

  writeHermesAuthFile(home, "agent_alpha", { accessToken: pro1Jwt, refreshToken: "REFRESH_PRO1" });
  writeHermesAuthFile(home, "agent_beta", { accessToken: pro1Jwt, refreshToken: "REFRESH_PRO1" });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
      pro2: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        pro1: {
          access: pro1Jwt,
          refresh: "REFRESH_PRO1",
          idToken: pro1Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro1",
        },
        pro2: {
          access: pro2Jwt,
          refresh: "REFRESH_PRO2",
          idToken: pro2Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro2",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["pro1", "pro2"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
  });
  await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const fetchImpl = async (url, init) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const accountId =
        init && init.headers && typeof init.headers["ChatGPT-Account-Id"] === "string"
          ? init.headers["ChatGPT-Account-Id"]
          : "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: accountId === "acct_pro1" ? 10 : 15,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_pro1" ? 70 : 10,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const first = JSON.parse(await runCli(["rebalance", "hermes", "--home", home], { fetchImpl }));
    assert.equal(first.ok, true);
    assert.equal(first.rebalanced.status, "applied");
    assert.equal(first.rebalanced.receipt.action, "rebalance_hermes");
    assert.ok(first.rebalanced.receipt.moved.length >= 1);

    const second = JSON.parse(await runCli(["rebalance", "hermes", "--home", home], { fetchImpl }));
    assert.equal(second.ok, true);
    assert.equal(second.rebalanced.status, "noop");

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "noop");
});

test("rebalance hermes blocks with a truthful receipt when Hermes session demand cannot be read", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });

  writeHermesAuthFile(home, "agent_boss", { accessToken: bossJwt, refreshToken: "REFRESH_BOSS" });
  fs.writeFileSync(path.join(home, ".hermes", "profiles", "agent_boss", "state.db"), "not a sqlite database", "utf8");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
  });
  await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const result = await runCliWithExitCode(["rebalance", "hermes", "--home", home], { fetchImpl });
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.rebalanced.status, "blocked");
    assert.equal(parsed.rebalanced.receipt.blockers[0].reason, "hermes_home_demand_unreadable");
    assert.equal(parsed.rebalanced.receipt.blockers[0].homeId, "agent_boss");
    assert.match(parsed.rebalanced.receipt.blockers[0].detail, /Failed to read Hermes session demand/);

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "blocked");
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.blockers[0].reason, "hermes_home_demand_unreadable");
});

test("rebalance hermes records blocked receipt when a later auth write fails after a prior home changed", async () => {
  const home = mkTempHome();
  const observedAt = new Date().toISOString();
  const bossStaleJwt = makeFakeJwt({
    email: "boss@example.com",
    nonce: "stale",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const bossFreshJwt = makeFakeJwt({
    email: "boss@example.com",
    nonce: "fresh",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const qaStaleJwt = makeFakeJwt({
    email: "qa@example.com",
    nonce: "stale",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });
  const qaFreshJwt = makeFakeJwt({
    email: "qa@example.com",
    nonce: "fresh",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });

  const alphaAuthPath = writeHermesAuthFile(home, "agent_alpha", {
    accessToken: bossStaleJwt,
    refreshToken: "STALE_BOSS",
  });
  const betaAuthPath = writeHermesAuthFile(home, "agent_beta", {
    accessToken: qaStaleJwt,
    refreshToken: "STALE_QA",
  });

  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossFreshJwt,
          refresh: "FRESH_BOSS",
          idToken: bossFreshJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaFreshJwt,
          refresh: "FRESH_QA",
          idToken: qaFreshJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: observedAt,
          labels: ["boss", "qa"],
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
  };

  let writesAttempted = 0;
  const result = await rebalanceHermesPool(
    {
      homeDir: home,
      observedAt,
      usageByProvider: {
        "openai-codex": {
          boss: { ok: true, windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }] },
          qa: { ok: true, windows: [{ kind: "primary", usedPercent: 20 }, { kind: "secondary", usedPercent: 20 }] },
        },
      },
    },
    state,
    {
      refreshHermesHomeDemandLedgerImpl: () => ({ demandByHome: {} }),
      writeHermesAuthFromStateImpl: (params, nextState) => {
        writesAttempted += 1;
        if (writesAttempted === 2) {
          throw new Error("simulated Hermes write failure");
        }
        return writeHermesAuthFromState(params, nextState);
      },
    },
  );

  // Rebalance can touch multiple Hermes homes and cannot roll back a write that already landed.
  // The observable contract is a persisted blocked receipt that names the failed home and exposes the partial state.
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.status, "blocked");
  assert.equal(result.receipt.blockers[0].reason, "hermes_home_auth_write_failed");
  assert.equal(result.receipt.blockers[0].homeId, "agent_beta");
  assert.match(result.receipt.blockers[0].detail, /simulated Hermes write failure/);
  assert.equal(result.receipt.resynced[0].homeId, "agent_alpha");
  assert.equal(result.receipt.writes.length, 1);
  assert.equal(state.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "blocked");
  assert.equal(state.pool.openaiCodex.hermesFleet.lastApplyReceipt.blockers[0].homeId, "agent_beta");

  const alphaAuth = JSON.parse(fs.readFileSync(alphaAuthPath, "utf8"));
  assert.equal(alphaAuth.providers["openai-codex"].tokens.refresh_token, "FRESH_BOSS");
  const betaAuth = JSON.parse(fs.readFileSync(betaAuthPath, "utf8"));
  assert.equal(betaAuth.providers["openai-codex"].tokens.refresh_token, "STALE_QA");
});

test("syncHermesHomesForLabel returns a blocked partial sync when a later home write fails", () => {
  const home = mkTempHome();
  const staleJwt = makeFakeJwt({
    email: "boss@example.com",
    nonce: "stale",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const freshJwt = makeFakeJwt({
    email: "boss@example.com",
    nonce: "fresh",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const alphaAuthPath = writeHermesAuthFile(home, "agent_alpha", {
    accessToken: staleJwt,
    refreshToken: "STALE_BOSS_ALPHA",
  });
  const betaAuthPath = writeHermesAuthFile(home, "agent_beta", {
    accessToken: staleJwt,
    refreshToken: "STALE_BOSS_BETA",
  });
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: freshJwt,
          refresh: "FRESH_BOSS",
          idToken: freshJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
  };

  let writesAttempted = 0;
  const result = syncHermesHomesForLabel(
    { state, label: "boss", homeDir: home },
    {
      writeHermesAuthFromStateImpl: (params, nextState) => {
        writesAttempted += 1;
        if (writesAttempted === 2) {
          throw new Error("simulated maintenance sync failure");
        }
        return writeHermesAuthFromState(params, nextState);
      },
    },
  );

  // Refresh-time Hermes sync is best-effort across multiple live homes.
  // When rollback is impossible, the caller needs a blocked partial result instead of an uncaught throw.
  assert.equal(result.status, "blocked");
  assert.equal(result.checkedHomeCount, 2);
  assert.equal(result.matchedHomeCount, 2);
  assert.deepEqual(result.syncedHomeIds, ["agent_alpha"]);
  assert.equal(result.blockers[0].reason, "hermes_home_auth_write_failed");
  assert.equal(result.blockers[0].homeId, "agent_beta");
  assert.match(result.blockers[0].detail, /simulated maintenance sync failure/);
  assert.equal(result.writes.length, 1);

  const alphaAuth = JSON.parse(fs.readFileSync(alphaAuthPath, "utf8"));
  assert.equal(alphaAuth.providers["openai-codex"].tokens.refresh_token, "FRESH_BOSS");
  const betaAuth = JSON.parse(fs.readFileSync(betaAuthPath, "utf8"));
  assert.equal(betaAuth.providers["openai-codex"].tokens.refresh_token, "STALE_BOSS_BETA");
});

test("hermes watch --once noops when every live home stays above the 5h remaining threshold", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });

  writeHermesAuthFile(home, "agent_boss", { accessToken: bossJwt, refreshToken: "REFRESH_BOSS" });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
  });
  await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 15,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: 40,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const result = JSON.parse(await runCli(["hermes", "watch", "--once", "--home", home], { fetchImpl }));
    assert.equal(result.ok, true);
    assert.equal(result.watched.status, "noop");
    assert.equal(result.watched.receipt.triggeredRebalance, false);
    assert.equal(result.watched.receipt.homeCount, 1);

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "noop");
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt, undefined);
});
