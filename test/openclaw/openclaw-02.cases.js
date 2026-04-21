import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildOpenclawModelSyncOps, extractOpenclawConfigAgentModelPrimary, partitionOpenclawPinsByConfiguredAgents } from "../../src/openclaw/models.js";
import { refreshOpenclawAgentDemandLedger } from "../../src/pool/demand-ledger.js";
import { readOpenclawAgentTokenUsage } from "../../src/pool/token-usage.js";
import { planOpenclawRebalance, planWeightedOpenclawRebalance } from "../../src/pool/weighted-planner.js";
import { discoverStatusConfiguredOpenclawCodexAgents } from "../../src/state/accounts.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome, writeJson, writeOpenclawSessionsStore } from "../helpers/files.js";

test("aim claude capture-native fails when the live Claude login is missing oauthAccount", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeJson(path.join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: {
      accessToken: "ACCESS_BOSS",
      refreshToken: "REFRESH_BOSS",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "max",
      rateLimitTier: "max_20x",
      scopes: ["user:profile", "user:inference"],
    },
  });
  writeJson(path.join(home, ".claude.json"), {
    theme: "dark",
  });

  await assert.rejects(
    () => runCli(["claude", "capture-native", "boss", "--home", home]),
    /missing\soauthAccount/i,
  );

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.credentials.anthropic.boss, undefined);
});

test("extractOpenclawConfigAgentModelPrimary handles string/object/null", () => {
  assert.equal(extractOpenclawConfigAgentModelPrimary(null), null);
  assert.equal(extractOpenclawConfigAgentModelPrimary(undefined), null);
  assert.equal(extractOpenclawConfigAgentModelPrimary(" openai/gpt-5.4 "), "openai/gpt-5.4");
  assert.equal(extractOpenclawConfigAgentModelPrimary({ primary: "openai-codex/gpt-5.4" }), "openai-codex/gpt-5.4");
  assert.equal(extractOpenclawConfigAgentModelPrimary({ primary: 123 }), null);
});

test("buildOpenclawModelSyncOps enforces openai-codex/gpt-5.4 for pinned agents", () => {
  const agentsList = [
    { id: "agent_boss", model: "openai/gpt-5.4" },
    { id: "agent_coder", model: { primary: "openai-codex/gpt-5.4" } },
    { id: "agent_lessons", model: null },
    { id: "agent_growth_analyst", model: { primary: "openai-codex/gpt-5.3-codex", fallbacks: ["openai/gpt-5.4"] } },
  ];

  const ops = buildOpenclawModelSyncOps({
    agentsList,
    pinnedAgentIds: ["agent_boss", "agent_coder", "agent_lessons", "agent_growth_analyst"],
  });

  assert.deepEqual(ops, [
    { path: "agents.list[0].model", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[2].model", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[3].model.primary", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[3].model.fallbacks", value: "[]" },
  ]);
});

test("buildOpenclawModelSyncOps supports per-agent desired model refs", () => {
  const agentsList = [
    { id: "agent_boss", model: "openai-codex/gpt-5.4" },
    { id: "agent_claudalyst", model: "openai-codex/gpt-5.4" },
  ];

  const ops = buildOpenclawModelSyncOps({
    agentsList,
    pinnedAgentIds: ["agent_boss", "agent_claudalyst"],
    modelRefByAgentId: {
      agent_boss: "openai-codex/gpt-5.4",
      agent_claudalyst: "anthropic/claude-opus-4-6",
    },
  });

  assert.deepEqual(ops, [{ path: "agents.list[1].model", value: "\"anthropic/claude-opus-4-6\"" }]);
});

test("partitionOpenclawPinsByConfiguredAgents separates stale pins from active pins", () => {
  const partition = partitionOpenclawPinsByConfiguredAgents({
    pinsByAgentId: {
      agent_boss: "boss",
      agent_lessons: "lessons",
      agent_growth_analyst: "growth",
    },
    agentsList: [
      { id: "agent_boss", model: "openai-codex/gpt-5.4" },
      { id: "agent_growth_analyst", model: "openai-codex/gpt-5.4" },
    ],
  });

  assert.deepEqual(partition.activePins, {
    agent_boss: "boss",
    agent_growth_analyst: "growth",
  });
  assert.deepEqual(partition.stalePins, [{ agentId: "agent_lessons", label: "lessons" }]);
});

test("refreshOpenclawAgentDemandLedger imports OpenClaw session counters and seeds cold-start demand", () => {
  const home = mkTempHome();
  const now = Date.parse("2026-03-21T12:00:00Z");
  const recent = now - 60_000;
  const stale = now - 10 * 24 * 60 * 60 * 1000;
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {
          agent_removed: {
            updatedAt: new Date(now - 3600_000).toISOString(),
            lookbackDays: 7,
            source: "openclaw-session-tokens",
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 999,
            demandWeight: 999,
          },
        },
      },
    },
  };

  writeOpenclawSessionsStore(home, "agent_heavy", {
    s1: { updatedAt: recent, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    s2: { updatedAt: recent, inputTokens: 60, outputTokens: 10, totalTokens: 70 },
    stale: { updatedAt: stale, inputTokens: 999, outputTokens: 999, totalTokens: 999 },
  });
  writeOpenclawSessionsStore(home, "agent_cold", {
    s1: { updatedAt: recent, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });

  const refreshed = refreshOpenclawAgentDemandLedger({
    state,
    homeDir: home,
    configuredAgents: ["agent_heavy", "agent_cold"],
    now,
    lookbackDays: 7,
  });

  assert.equal(refreshed.allocationMode, "demand_weighted");
  assert.equal(readOpenclawAgentTokenUsage({ homeDir: home, agentId: "agent_heavy", now, lookbackDays: 7 }).totalTokens, 220);
  assert.deepEqual(state.pool.openaiCodex.agentDemand.agent_heavy, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "openclaw-session-tokens",
    inputTokens: 180,
    outputTokens: 40,
    totalTokens: 220,
    demandWeight: 220,
  });
  assert.deepEqual(state.pool.openaiCodex.agentDemand.agent_cold, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "cold-start-equal-share",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    demandWeight: 220,
  });
  // The demand ledger feeds status/projection when live OpenClaw config is not
  // re-read there. Removed agents must disappear on refresh or capacity math keeps ghost load.
  assert.equal(state.pool.openaiCodex.agentDemand.agent_removed, undefined);
  assert.equal(refreshed.demandByAgent.agent_removed, undefined);
  assert.deepEqual(discoverStatusConfiguredOpenclawCodexAgents(state), ["agent_cold", "agent_heavy"]);
});

test("planWeightedOpenclawRebalance supports many-to-one cold-start spread without burning labels after one use", () => {
  const plan = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_a", "agent_b", "agent_c"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 40 }, { kind: "secondary", usedPercent: 40 }],
      },
    },
    agentDemand: {},
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.equal(plan.allocationMode, "cold_start_equal_share");
  assert.deepEqual(plan.assignments, {
    agent_a: "boss",
    agent_b: "qa",
    agent_c: "boss",
  });
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "boss")?.carriedAgentCount, 2);
  assert.deepEqual(plan.unchanged[0], {
    agentId: "agent_a",
    label: "boss",
    reason: "kept_current_hysteresis",
    demandWeight: 1,
    demandSource: "cold-start-equal-share",
    targetDemandWeight: 1.8,
    projectedDemandWeight: 1,
  });

  const blocked = planOpenclawRebalance({
    configuredAgents: ["agent_a"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: [],
    usage: {},
    agentDemand: {},
    now: Date.now(),
  });

  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.assignments, {});
  assert.deepEqual(blocked.skipped, [{ agentId: "agent_a", reason: "no_eligible_pool_account" }]);
  assert.deepEqual(blocked.blockers, [{ reason: "no_eligible_pool_account" }]);
});

test("planWeightedOpenclawRebalance spreads by weekly remaining before short-window headroom", () => {
  const plan = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_a", "agent_b", "agent_c"],
    currentAssignments: {},
    eligibleLabels: ["boss", "office"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 20 }, { kind: "secondary", usedPercent: 60 }],
      },
      office: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 80 }, { kind: "secondary", usedPercent: 0 }],
      },
    },
    agentDemand: {},
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.deepEqual(plan.assignments, {
    agent_a: "office",
    agent_b: "office",
    agent_c: "boss",
  });
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "office")?.carriedAgentCount, 2);
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "boss")?.carriedAgentCount, 1);
});

test("planWeightedOpenclawRebalance spreads demand across the weekly pool without burning lower-headroom labels", () => {
  const plan = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_heavy", "agent_medium", "agent_light", "agent_idle"],
    currentAssignments: {
      agent_heavy: "boss",
      agent_medium: "boss",
      agent_light: "qa",
      agent_idle: "qa",
    },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 50 }, { kind: "secondary", usedPercent: 50 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 90 }, { kind: "secondary", usedPercent: 90 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_medium: { source: "openclaw-session-tokens", demandWeight: 50 },
      agent_light: { source: "openclaw-session-tokens", demandWeight: 30 },
      agent_idle: { source: "openclaw-session-tokens", demandWeight: 20 },
    },
    now: Date.now(),
  });

  assert.equal(plan.status, "noop");
  assert.equal(plan.allocationMode, "demand_weighted");
  assert.deepEqual(plan.assignments, {
    agent_heavy: "boss",
    agent_medium: "boss",
    agent_light: "qa",
    agent_idle: "qa",
  });
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.moved.length, 0);
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "boss")?.carriedDemandWeight, 200);
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "qa")?.carriedDemandWeight, 50);
});
