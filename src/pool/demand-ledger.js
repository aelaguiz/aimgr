import { spawnSync } from "node:child_process";
import { COLD_START_EQUAL_SHARE_DEMAND_SOURCE, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS, HERMES_SESSION_DEMAND_SOURCE, MIN_AGENT_DEMAND_WEIGHT } from "../core/constants.js";
import { normalizeAgentId, normalizeHermesHomeId } from "../core/normalize.js";
import { readHermesHomeTokenUsage, readOpenclawAgentTokenUsage } from "./token-usage.js";
import { getHermesFleetDemandState, getOpenclawAgentDemandState } from "../state/accounts.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";

export function refreshHermesHomeDemandLedger({
  state,
  homeDir,
  homes,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
  spawnImpl = spawnSync,
}) {
  // AIM owns the durable Hermes demand ledger; live Hermes state.db files are read-only inputs.
  // Keep demand normalization here so Hermes rebalance/watch/status do not drift.
  ensureStateShape(state);
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const homeIds = [...new Set((Array.isArray(homes) ? homes : []).map((home) => normalizeHermesHomeId(typeof home === "string" ? home : home?.homeId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ledger = getHermesFleetDemandState(state);
  const activeHomeIds = new Set(homeIds);
  for (const existingHomeId of Object.keys(ledger)) {
    if (!activeHomeIds.has(normalizeHermesHomeId(existingHomeId))) {
      delete ledger[existingHomeId];
    }
  }
  const usageByHome = new Map();
  const observedWeights = [];

  for (const homeId of homeIds) {
    const usage = readHermesHomeTokenUsage({
      homeDir,
      homeId,
      now: snapshotNow,
      lookbackDays: normalizedLookbackDays,
      spawnImpl,
    });
    usageByHome.set(homeId, usage);
    if (usage.totalTokens > 0) {
      observedWeights.push(usage.totalTokens);
    }
  }

  const fallbackDemandWeight = Math.max(
    MIN_AGENT_DEMAND_WEIGHT,
    observedWeights.length > 0
      ? observedWeights.reduce((sum, weight) => sum + weight, 0) / observedWeights.length
      : MIN_AGENT_DEMAND_WEIGHT,
  );
  const allocationMode = observedWeights.length > 0 ? "demand_weighted" : "cold_start_equal_share";
  const updatedAt = new Date(snapshotNow).toISOString();

  for (const homeId of homeIds) {
    const usage = usageByHome.get(homeId);
    const source = usage && usage.totalTokens > 0 ? HERMES_SESSION_DEMAND_SOURCE : COLD_START_EQUAL_SHARE_DEMAND_SOURCE;
    ledger[homeId] = {
      updatedAt,
      lookbackDays: normalizedLookbackDays,
      source,
      inputTokens: roundDemandWeight(usage?.inputTokens ?? 0),
      outputTokens: roundDemandWeight(usage?.outputTokens ?? 0),
      cacheReadTokens: roundDemandWeight(usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: roundDemandWeight(usage?.cacheWriteTokens ?? 0),
      reasoningTokens: roundDemandWeight(usage?.reasoningTokens ?? 0),
      totalTokens: roundDemandWeight(usage?.totalTokens ?? 0),
      demandWeight: roundDemandWeight(source === HERMES_SESSION_DEMAND_SOURCE ? usage.totalTokens : fallbackDemandWeight),
    };
  }

  return {
    allocationMode,
    lookbackDays: normalizedLookbackDays,
    observedHomeCount: observedWeights.length,
    coldStartHomeCount: homeIds.length - observedWeights.length,
    demandByHome: Object.fromEntries(homeIds.map((homeId) => [homeId, ledger[homeId]])),
  };
}

export function refreshOpenclawAgentDemandLedger({
  state,
  homeDir,
  configuredAgents,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
}) {
  // AIM owns the durable demand ledger; OpenClaw session stores are read-only inputs.
  // Do not rebalance directly from raw session files in multiple places or the allocator will drift.
  ensureStateShape(state);
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const agentIds = [...new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ledger = getOpenclawAgentDemandState(state);
  const activeAgentIds = new Set(agentIds);
  for (const existingAgentId of Object.keys(ledger)) {
    if (!activeAgentIds.has(normalizeAgentId(existingAgentId))) {
      delete ledger[existingAgentId];
    }
  }
  const usageByAgent = new Map();
  const observedWeights = [];

  for (const agentId of agentIds) {
    const usage = readOpenclawAgentTokenUsage({
      homeDir,
      agentId,
      now: snapshotNow,
      lookbackDays: normalizedLookbackDays,
    });
    usageByAgent.set(agentId, usage);
    if (usage.totalTokens > 0) {
      observedWeights.push(usage.totalTokens);
    }
  }

  const fallbackDemandWeight = Math.max(
    MIN_AGENT_DEMAND_WEIGHT,
    observedWeights.length > 0
      ? observedWeights.reduce((sum, weight) => sum + weight, 0) / observedWeights.length
      : MIN_AGENT_DEMAND_WEIGHT,
  );
  const allocationMode = observedWeights.length > 0 ? "demand_weighted" : "cold_start_equal_share";
  const updatedAt = new Date(snapshotNow).toISOString();

  for (const agentId of agentIds) {
    const usage = usageByAgent.get(agentId);
    const source = usage && usage.totalTokens > 0 ? "openclaw-session-tokens" : "cold-start-equal-share";
    ledger[agentId] = {
      updatedAt,
      lookbackDays: normalizedLookbackDays,
      source,
      inputTokens: roundDemandWeight(usage?.inputTokens ?? 0),
      outputTokens: roundDemandWeight(usage?.outputTokens ?? 0),
      totalTokens: roundDemandWeight(usage?.totalTokens ?? 0),
      demandWeight: roundDemandWeight(source === "openclaw-session-tokens" ? usage.totalTokens : fallbackDemandWeight),
    };
  }

  return {
    allocationMode,
    lookbackDays: normalizedLookbackDays,
    observedAgentCount: observedWeights.length,
    coldStartAgentCount: agentIds.length - observedWeights.length,
    demandByAgent: Object.fromEntries(agentIds.map((agentId) => [agentId, ledger[agentId]])),
  };
}
