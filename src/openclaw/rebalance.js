import { DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { normalizeAgentId } from "../core/normalize.js";
import { resolveHomeDir } from "../io/paths.js";
import { readOpenclawAgentsListFromConfig } from "./config.js";
import { syncOpenclawFromState } from "./sync.js";
import { refreshOpenclawAgentDemandLedger } from "../pool/demand-ledger.js";
import { appendOpenaiCodexHistory, collectCodexPoolStatusWithExhaustionHistory } from "../pool/history.js";
import { buildOpenclawDemandUnreadableBlocker } from "../pool/token-usage.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverConfiguredOpenclawCodexAgents, planWeightedOpenclawRebalance } from "../pool/weighted-planner.js";
import { getOpenclawAssignments, getOpenclawExclusions, getOpenclawTargetState } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";
import { sanitizeForStatus } from "../core/sanitize.js";

function buildOpenclawSyncFailedBlocker(error) {
  const blocker = {
    reason: "openclaw_sync_failed",
  };
  const detail = String(error?.message ?? error ?? "").trim();
  if (detail) {
    blocker.detail = detail;
  }
  return blocker;
}

export async function rebalanceOpenclawPool(
  params,
  state,
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
    syncOpenclawFromStateImpl = syncOpenclawFromState,
  } = {},
) {
  ensureStateShape(state);
  const homeDir = typeof params.homeDir === "string" && params.homeDir.trim()
    ? params.homeDir
    : resolveHomeDir(params.home, { env: params.env });
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env: params.env });
  const usageByLabel = usageByProvider[OPENAI_CODEX_PROVIDER];
  const poolStatus = collectCodexPoolStatusWithExhaustionHistory({
    state,
    homeDir,
    usageByLabel,
    observedAt,
  });

  const target = getOpenclawTargetState(state);
  const agentsList = readOpenclawAgentsListFromConfigImpl();
  const currentAssignments = getOpenclawAssignments(state);
  const configuredAgentIds = new Set(
    (Array.isArray(agentsList) ? agentsList : [])
      .map((entry) => (typeof entry?.id === "string" ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const configuredAgents = discoverConfiguredOpenclawCodexAgents({
    agentsList,
    exclusions: getOpenclawExclusions(state),
  });
  const codexManagedAgentIds = new Set(configuredAgents.map((agentId) => normalizeAgentId(agentId)));
  const exclusions = getOpenclawExclusions(state);
  const preservedAssignments = Object.fromEntries(
    Object.entries(currentAssignments).filter(([agentIdRaw]) => {
      const agentId = normalizeAgentId(agentIdRaw);
      if (codexManagedAgentIds.has(agentId)) {
        return false;
      }
      if (typeof exclusions?.[agentId] === "string" && exclusions[agentId].trim()) {
        return true;
      }
      return configuredAgentIds.has(agentId);
    }),
  );
  target.lastRebalancedAt = observedAt;
  let demandRefresh;
  try {
    demandRefresh = refreshOpenclawAgentDemandLedger({
      state,
      homeDir,
      configuredAgents,
      now: Date.parse(observedAt),
      lookbackDays: DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
    });
  } catch (error) {
    const receipt = {
      action: "rebalance_openclaw",
      status: "blocked",
      observedAt,
      cleanupMode: null,
      allocationMode: null,
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      moved: [],
      unchanged: [],
      skipped: [],
      perAccountLoad: [],
      warnings: [],
      blockers: [buildOpenclawDemandUnreadableBlocker(error)],
    };
    target.lastApplyReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "rebalance",
        status: "blocked",
        reason: "openclaw_agent_demand_unreadable",
        hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      },
    ]);
    return { status: "blocked", receipt };
  }
  const plan = planWeightedOpenclawRebalance({
    configuredAgents,
    currentAssignments,
    eligibleLabels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    agentDemand: demandRefresh.demandByAgent,
    now: Date.parse(observedAt),
  });
  const nextAssignments = { ...preservedAssignments, ...plan.assignments };

  if (plan.status === "blocked") {
    const blockerReason = typeof plan.blockers?.[0]?.reason === "string" ? plan.blockers[0].reason : "no_eligible_pool_account";
    const receipt = {
      action: "rebalance_openclaw",
      status: "blocked",
      observedAt,
      cleanupMode: null,
      allocationMode: plan.allocationMode,
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      moved: [],
      unchanged: [],
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: [],
      blockers: plan.blockers,
    };
    target.lastApplyReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "rebalance",
        status: "blocked",
        reason: blockerReason,
        hadSpareEligibleCapacity: false,
      },
    ]);
    return { status: "blocked", receipt };
  }

  target.assignments = nextAssignments;
  let synced;
  try {
    synced = await syncOpenclawFromStateImpl(params, state);
  } catch (error) {
    const receipt = {
      action: "rebalance_openclaw",
      status: "blocked",
      observedAt,
      allocationMode: plan.allocationMode,
      cleanupMode: null,
      assignments: sanitizeForStatus(nextAssignments),
      moved: plan.moved,
      unchanged: plan.unchanged,
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: [],
      blockers: [buildOpenclawSyncFailedBlocker(error)],
    };
    target.lastApplyReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "rebalance",
        status: "blocked",
        reason: "openclaw_sync_failed",
        hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      },
    ]);
    return { status: "blocked", receipt };
  }
  const warnings = Array.isArray(synced.warnings) ? synced.warnings : [];
  let status = "applied";
  if (plan.status === "noop") {
    status = warnings.length > 0 ? "applied_with_warnings" : "noop";
  } else if (plan.status === "applied_with_warnings" || warnings.length > 0) {
    status = "applied_with_warnings";
  }

  const receipt = {
    action: "rebalance_openclaw",
    status,
    observedAt,
    allocationMode: plan.allocationMode,
    cleanupMode:
      typeof synced.sessions?.mode === "string"
        ? synced.sessions.mode
        : typeof synced.sessions?.reason === "string"
          ? synced.sessions.reason
          : null,
    assignments: sanitizeForStatus(nextAssignments),
    moved: plan.moved,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    perAccountLoad: plan.perAccountLoad,
    warnings,
    blockers: [],
  };
  target.lastApplyReceipt = receipt;
  appendOpenaiCodexHistory(state, [
    {
      observedAt,
      kind: "rebalance",
      status,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason:
        plan.skipped.some((entry) => entry.reason === "projected_demand_exceeds_eligible_supply")
          ? "projected_demand_exceeds_eligible_supply"
          : status === "noop"
            ? "unchanged_assignments"
            : "rebalanced",
    },
  ]);

  return { status, receipt, synced };
}
