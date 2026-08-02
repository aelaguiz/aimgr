import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { writeHermesAuthFile } from "../helpers/hermes.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";

test("hermes watch --once fails loud when a discovered Hermes home is missing auth.json", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const hermesHome = path.join(home, ".hermes", "profiles", "agent_missing");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "model:\n  provider: openai-codex\n", "utf8");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: makeFakeJwt({
            email: "boss@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_boss",
              chatgpt_plan_type: "pro",
            },
          }),
          refresh: "REFRESH_BOSS",
          idToken: "id",
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
              used_percent: 5,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  const result = await runCliWithExitCode(["hermes", "watch", "--once", "--home", home], { fetchImpl });
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.watched.status, "blocked");
  assert.equal(parsed.watched.receipt.blockers[0].reason, "hermes_home_missing_auth_file");

  const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
  assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "blocked");
});

test("hermes watch --once blocks usage-token failures without rebalancing or rewriting auth", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const authPath = writeHermesAuthFile(home, "agent_boss", { accessToken: bossJwt, refreshToken: "REFRESH_BOSS" });
  const originalAuth = fs.readFileSync(authPath, "utf8");

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
        ok: false,
        status: 401,
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  const result = await runCliWithExitCode(["hermes", "watch", "--once", "--home", home], { fetchImpl });
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);

  // Hermes watch only decides whether to call rebalance. If usage auth is invalid,
  // it must fail closed before any fake or real Hermes auth writer can run.
  assert.equal(parsed.ok, false);
  assert.equal(parsed.watched.status, "blocked");
  assert.equal(parsed.watched.receipt.triggeredRebalance, false);
  assert.equal(parsed.watched.receipt.blockers[0].reason, "hermes_home_usage_unavailable");
  assert.equal(parsed.watched.receipt.blockers[0].homeId, "agent_boss");
  assert.equal(parsed.watched.receipt.blockers[0].label, "boss");
  assert.equal(parsed.watched.receipt.blockers[0].status, 401);
  assert.equal(parsed.watched.receipt.blockers[0].tokenExpired, true);

  const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
  assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "blocked");
  assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.triggeredRebalance, false);
  assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastApplyReceipt, undefined);
  assert.equal(fs.readFileSync(authPath, "utf8"), originalAuth);
});

test("hermes watch loop reuses the one-shot path on every interval", async () => {
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

    const stdout = await runCli(
      ["hermes", "watch", "--interval-seconds", "1", "--home", home],
      {
        fetchImpl,
        watchLoopMaxIterations: 2,
        sleepImpl: async () => {},
      },
    );
    assert.equal((stdout.match(/"action": "hermes_watch"/g) ?? []).length, 2);
    assert.equal((stdout.match(/"triggeredRebalance": false/g) ?? []).length, 2);

    const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.lastWatchReceipt.status, "noop");
    assert.equal(updatedState.pool.openaiCodex.hermesFleet.homes, undefined);
});
