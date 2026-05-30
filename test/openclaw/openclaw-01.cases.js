import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { installFakeOpenclaw, readFakeOpenclawRestarts, readFakeOpenclawSessionPatches } from "../helpers/fakes.js";
import { makeFakeJwt, mkTempHome, withEnv, writeJson, writeOpenclawAuthStore, writeOpenclawSessionsStore } from "../helpers/files.js";

test("apply is removed after the Redis cutover", async () => {
  await assert.rejects(
    () => runCli(["apply", "--home", mkTempHome()]),
    /aim apply.*removed in the Redis cutover/s,
  );
});

test("rebalance openclaw applies the weekly-share target at the real CLI boundary", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [
      { id: "agent_boss", model: "openai/gpt-5.4" },
      { id: "agent_light", model: "openai-codex/gpt-5.4" },
      { id: "agent_idle", model: "openai-codex/gpt-5.4" },
    ],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss", agent_light: "qa", agent_idle: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const now = Date.now();
  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: { updatedAt: now, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  });
  writeOpenclawSessionsStore(home, "agent_light", {
    s1: { updatedAt: now, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  });
  writeOpenclawSessionsStore(home, "agent_idle", {
    s1: { updatedAt: now, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  });
  const fetchImpl = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 50 : 90;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    await withEnv(
      {
        HOME: home,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
      async () => {
        const out = await runCli(["rebalance", "openclaw"], { fetchImpl });
        const parsed = JSON.parse(out);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.rebalanced.status, "applied");
        assert.deepEqual(parsed.rebalanced.receipt.skipped, []);
        assert.equal(parsed.rebalanced.receipt.allocationMode, "demand_weighted");
        assert.equal(parsed.rebalanced.receipt.perAccountLoad.find((entry) => entry.label === "boss")?.carriedAgentCount, 2);
        assert.equal(parsed.rebalanced.receipt.perAccountLoad.find((entry) => entry.label === "qa")?.carriedAgentCount, 1);
        assert.deepEqual(parsed.rebalanced.receipt.moved.map(({ agentId, from, to }) => ({ agentId, from, to })), [
          { agentId: "agent_idle", from: "qa", to: "boss" },
        ]);

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "applied");
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.allocationMode, "demand_weighted");
        assert.deepEqual(updatedState.targets.openclaw.lastApplyReceipt.skipped, []);
        assert.deepEqual(updatedState.targets.openclaw.assignments, {
          agent_boss: "boss",
          agent_light: "qa",
          agent_idle: "boss",
        });
      },
    );
	});

test("rebalance openclaw persists a blocked receipt when live sync fails after writes", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    failGatewayRestart: true,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [], agentDemand: {} } },
  });

  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: {
      updatedAt: Date.now(),
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      modelProvider: "openai",
      model: "gpt-5.4",
      authProfileOverride: "openai-codex:qa",
    },
  });

  const fetchImpl = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 10 : 88;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  await withEnv(
    {
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
    async () => {
      const result = await runCliWithExitCode(["rebalance", "openclaw"], { fetchImpl });
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);

      // Gateway restart happens after auth/config/session files can already be
      // rewritten, so the CLI must persist a blocked receipt instead of throwing before state save.
      assert.equal(parsed.ok, false);
      assert.equal(parsed.rebalanced.status, "blocked");
      assert.equal(parsed.rebalanced.receipt.blockers[0].reason, "openclaw_sync_failed");
      assert.match(parsed.rebalanced.receipt.blockers[0].detail, /openclaw gateway restart failed/);
      assert.deepEqual(parsed.rebalanced.receipt.assignments, { agent_boss: "boss" });
      assert.equal(readFakeOpenclawRestarts(home).length, 1);

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
      assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "blocked");
      assert.equal(updatedState.targets.openclaw.lastApplyReceipt.blockers[0].reason, "openclaw_sync_failed");
      assert.equal(updatedState.pool.openaiCodex.history.at(-1).reason, "openclaw_sync_failed");

      const sessions = JSON.parse(
        fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_boss", "sessions", "sessions.json"), "utf8"),
      );
      assert.equal(sessions.s1.authProfileOverride, undefined);
    },
  );
});

test("rebalance openclaw records a blocked receipt when session demand cannot be read", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [
      { id: "agent_boss", model: "openai/gpt-5.4" },
    ],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [], agentDemand: {} } },
  });
  const sessionsPath = path.join(home, ".openclaw", "agents", "agent_boss", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  fs.writeFileSync(sessionsPath, "{not-json", "utf8");

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
              reset_at: Math.floor(Date.now() / 1000) + 6 * 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  await withEnv(
    {
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
    async () => {
      const result = await runCliWithExitCode(["rebalance", "openclaw"], { fetchImpl });
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);

      // Demand files are read-only inputs to the allocator. A malformed store must
      // block before OpenClaw sync/restart and still persist a receipt operators can inspect.
      assert.equal(parsed.ok, false);
      assert.equal(parsed.rebalanced.status, "blocked");
      assert.equal(parsed.rebalanced.receipt.blockers[0].reason, "openclaw_agent_demand_unreadable");
      assert.equal(parsed.rebalanced.receipt.blockers[0].agentId, "agent_boss");
      assert.match(parsed.rebalanced.receipt.blockers[0].detail, /Failed to read OpenClaw session demand/);
      assert.equal(readFakeOpenclawRestarts(home).length, 0);

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
      assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "blocked");
      assert.equal(updatedState.targets.openclaw.lastRebalancedAt, updatedState.targets.openclaw.lastApplyReceipt.observedAt);
      assert.equal(updatedState.targets.openclaw.lastApplyReceipt.blockers[0].reason, "openclaw_agent_demand_unreadable");
      assert.equal(updatedState.pool.openaiCodex.history.at(-1).reason, "openclaw_agent_demand_unreadable");
    },
  );
});
