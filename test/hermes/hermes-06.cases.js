import test from "node:test";
import assert from "node:assert/strict";
import { refreshHermesHomeDemandLedger } from "../../src/pool/demand-ledger.js";
import { readHermesHomeTokenUsage } from "../../src/pool/token-usage.js";
import { planWeightedHermesRebalance } from "../../src/pool/weighted-planner.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";
import { writeHermesStateDb } from "../helpers/hermes.js";

test("sync codex is removed after the Redis cutover", async () => {
  await assert.rejects(
    () => runCli(["sync", "codex", "--from", "/tmp/authority.json", "--home", mkTempHome()]),
    /sync codex.*removed in the Redis cutover/s,
  );
});

test("readHermesHomeTokenUsage and refreshHermesHomeDemandLedger import Hermes state.db session counters", () => {
  const home = mkTempHome();
  const now = Date.parse("2026-03-21T12:00:00Z");
  const recent = now / 1000 - 60;
  const stale = now / 1000 - 10 * 24 * 60 * 60;
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
        hermesFleet: {
          demandByHome: {
            agent_removed: {
              updatedAt: new Date(now - 3600_000).toISOString(),
              lookbackDays: 7,
              source: "hermes-session-tokens",
              inputTokens: 999,
              outputTokens: 999,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 1998,
              demandWeight: 1998,
            },
          },
        },
      },
      anthropic: { history: [] },
    },
  };

  writeHermesStateDb(home, "agent_heavy", [
    { id: "s1", startedAt: recent, inputTokens: 120, outputTokens: 30, cacheReadTokens: 20, reasoningTokens: 10 },
    { id: "s2", startedAt: recent, inputTokens: 60, outputTokens: 10 },
    { id: "stale", startedAt: stale, inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 },
  ]);
  writeHermesStateDb(home, "agent_cold", [
    { id: "s1", startedAt: recent, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
  ]);

  const usage = readHermesHomeTokenUsage({ homeDir: home, homeId: "agent_heavy", now, lookbackDays: 7 });
  assert.equal(usage.totalTokens, 250);
  assert.equal(usage.inputTokens, 180);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.cacheReadTokens, 20);
  assert.equal(usage.reasoningTokens, 10);

  const refreshed = refreshHermesHomeDemandLedger({
    state,
    homeDir: home,
    homes: [{ homeId: "agent_heavy" }, { homeId: "agent_cold" }],
    now,
    lookbackDays: 7,
  });

  assert.equal(refreshed.allocationMode, "demand_weighted");
  assert.deepEqual(state.pool.openaiCodex.hermesFleet.demandByHome.agent_heavy, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "hermes-session-tokens",
    inputTokens: 180,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 250,
    demandWeight: 250,
  });
  assert.deepEqual(state.pool.openaiCodex.hermesFleet.demandByHome.agent_cold, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "cold-start-equal-share",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    demandWeight: 250,
  });
  // Removed Hermes homes are no longer allocator inputs. Refresh must prune their
  // stale demand rows so future rebalance/status projections do not count ghost load.
  assert.equal(state.pool.openaiCodex.hermesFleet.demandByHome.agent_removed, undefined);
  assert.equal(refreshed.demandByHome.agent_removed, undefined);
});

test("planWeightedHermesRebalance supports many-to-one cold-start spread without inventing a second allocator", () => {
  const plan = planWeightedHermesRebalance({
    configuredHomes: ["agent_a", "agent_b", "agent_c"],
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
    homeDemand: {},
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.equal(plan.allocationMode, "cold_start_equal_share");
  assert.deepEqual(plan.assignments, {
    agent_a: "boss",
    agent_b: "qa",
    agent_c: "boss",
  });
  assert.deepEqual(plan.unchanged[0], {
    homeId: "agent_a",
    label: "boss",
    reason: "kept_current_hysteresis",
    demandWeight: 1,
    demandSource: "cold-start-equal-share",
    targetDemandWeight: 1.8,
    projectedDemandWeight: 1,
  });
});
