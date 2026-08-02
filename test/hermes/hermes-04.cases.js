import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { writeHermesAuthFile, writeHermesStateDb } from "../helpers/hermes.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";

test("hermes watch --once repairs drifted mapped homes even when they stay above the threshold", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const staleJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const freshJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
    sub: "fresh",
  });

  writeHermesAuthFile(home, "agent_boss", {
    accessToken: staleJwt,
    refreshToken: "OLD_REFRESH",
  });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: freshJwt,
          refresh: "NEW_REFRESH",
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
    assert.equal(result.watched.status, "applied");
    assert.equal(result.watched.receipt.triggeredRebalance, true);
    assert.deepEqual(result.watched.receipt.needsSyncHomeIds, ["agent_boss"]);
    assert.deepEqual(result.watched.receipt.belowThresholdHomeIds, []);
    assert.deepEqual(result.watched.receipt.ineligibleHomeIds, []);
    assert.equal(result.watched.receipt.rebalanceReceipt.resynced[0].homeId, "agent_boss");
    assert.equal(result.watched.receipt.currentAssignmentsAfter.agent_boss, "boss");

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "applied");
    assert.deepEqual(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.needsSyncHomeIds, ["agent_boss"]);
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "applied");
});

test("hermes watch --once routes through rebalance hermes when a live home drops below the threshold", async () => {
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

  writeHermesAuthFile(home, "agent_ops", { accessToken: pro1Jwt, refreshToken: "REFRESH_PRO1" });
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
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
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
              used_percent: accountId === "acct_pro1" ? 85 : 5,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_pro1" ? 70 : 5,
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
    assert.equal(result.watched.status, "applied");
    assert.equal(result.watched.receipt.triggeredRebalance, true);
    assert.equal(result.watched.receipt.rebalanceReceipt.action, "rebalance_hermes");
    assert.equal(result.watched.receipt.currentAssignmentsAfter.agent_ops, "pro2");

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "applied");
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "applied");
});

test("hermes watch --once routes through rebalance hermes when a current label loses pool eligibility above the threshold", async () => {
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

  writeHermesAuthFile(home, "agent_ops", { accessToken: pro1Jwt, refreshToken: "REFRESH_PRO1" });
  writeHermesStateDb(home, "agent_ops", [
    { id: "s1", startedAt: Date.now() / 1000 - 60, inputTokens: 100, outputTokens: 10 },
  ]);
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
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
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
              used_percent: accountId === "acct_pro1" ? 10 : 5,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_pro1" ? 97 : 5,
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
    assert.equal(result.watched.status, "applied");
    assert.equal(result.watched.receipt.triggeredRebalance, true);
    assert.deepEqual(result.watched.receipt.belowThresholdHomeIds, []);
    assert.deepEqual(result.watched.receipt.ineligibleHomeIds, ["agent_ops"]);
    assert.equal(result.watched.receipt.currentAssignmentsAfter.agent_ops, "pro2");

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "applied");
    assert.deepEqual(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.ineligibleHomeIds, ["agent_ops"]);
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt.status, "applied");
});
