import { isObject, normalizeLabel } from "../core/normalize.js";
import { getCodexPoolLabels } from "../pool/ranking.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";
import { buildAssignedDemandByLabel, buildStatusDemandByAgent, buildStatusLabelWeights, deriveDemandBucketWeights, roundMetric, summarizePoolWindow } from "./metrics.js";

export function buildPoolInstrumentSummary({
  state,
  accounts,
  codexPool,
  liveUsage,
  agentDemand,
  currentAssignments,
  lastApplyReceipt,
  configuredCodexAgents,
  now = Date.now(),
}) {
  const poolLabels = getCodexPoolLabels(state).map((label) => normalizeLabel(label)).toSorted((a, b) => a.localeCompare(b));
  const accountMap = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [account.label, account]));
  const readyLabels = poolLabels.filter((label) => accountMap.get(label)?.operator?.status === "ready");
  const observableLabels = readyLabels.filter((label) => {
    const windows = Array.isArray(liveUsage?.[label]?.windows) ? liveUsage[label].windows : [];
    return liveUsage?.[label]?.ok === true && windows.length > 0;
  });
  const receiptPerAccountLoad = Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : [];
  const readyAccounts = readyLabels.length;
  const totalAccounts = poolLabels.length;
  const totalAgents = Array.isArray(configuredCodexAgents) ? configuredCodexAgents.length : 0;
  const demandByAgent = buildStatusDemandByAgent({ configuredAgents: configuredCodexAgents, agentDemand });
  const labelWeights = buildStatusLabelWeights({
    eligibleLabels: observableLabels,
    liveUsage,
    demandByAgent,
    lastApplyReceipt,
  });
  const { assignedDemandByLabel, assignedCountsByLabel } = buildAssignedDemandByLabel({
    eligibleLabels: poolLabels,
    configuredAgents: configuredCodexAgents,
    currentAssignments,
    demandByAgent,
  });
  const receiptAssignedLoadW = roundDemandWeight(
    receiptPerAccountLoad.reduce((sum, entry) => sum + normalizeDemandWeight(entry?.carriedDemandWeight, 0), 0),
  );
  const receiptActiveAgents = Math.max(
    0,
    Math.round(receiptPerAccountLoad.reduce((sum, entry) => sum + normalizeDemandWeight(entry?.carriedAgentCount, 0), 0)),
  );
  const assignedLoadW = receiptAssignedLoadW > 0
    ? receiptAssignedLoadW
    : roundDemandWeight(
        Object.values(assignedDemandByLabel).reduce((sum, weight) => sum + normalizeDemandWeight(weight, 0), 0),
      );
  const usableCapacityW = roundDemandWeight(
    observableLabels.reduce((sum, label) => sum + normalizeDemandWeight(labelWeights[label], 0), 0),
  );
  const spareW = roundDemandWeight(Math.max(0, usableCapacityW - assignedLoadW));
  const activeAgents = receiptActiveAgents > 0
    ? receiptActiveAgents
    : poolLabels.reduce((sum, label) => sum + Math.max(0, Math.round(normalizeDemandWeight(assignedCountsByLabel[label], 0))), 0);
  const poolLoadPct = usableCapacityW > 0 ? roundMetric((assignedLoadW / usableCapacityW) * 100, 1) ?? 0 : 0;
  const bucketWeights = deriveDemandBucketWeights(demandByAgent);
  const window5 = summarizePoolWindow({ eligibleLabels: observableLabels, liveUsage, labelWeights, index: 0, now });
  const window7 = summarizePoolWindow({ eligibleLabels: observableLabels, liveUsage, labelWeights, index: 1, now });
  const overTargetAccounts = receiptPerAccountLoad.filter((entry) => {
    if (!isObject(entry)) return false;
    return roundDemandWeight(Math.max(0, normalizeDemandWeight(entry.carriedDemandWeight, 0) - normalizeDemandWeight(entry.targetDemandWeight, 0))) > 0;
  }).length;
  const projectionRateWph = window7.rateWeightPerHour > 0 ? window7.rateWeightPerHour : window5.rateWeightPerHour;
  const projectLoadPct = (hours) => (
    usableCapacityW > 0 ? roundMetric(((assignedLoadW + projectionRateWph * hours) / usableCapacityW) * 100, 1) ?? 0 : 0
  );
  const overflowEtaH =
    projectionRateWph > 0
      ? (spareW > 0 ? roundMetric(spareW / projectionRateWph, 1) : 0)
      : null;
  const eta5 = window5.rateWeightPerHour > 0 ? roundMetric(window5.remainingWeight / window5.rateWeightPerHour, 1) : null;
  const eta7 = window7.rateWeightPerHour > 0 ? roundMetric(window7.remainingWeight / window7.rateWeightPerHour, 1) : null;
  const firstConstraint =
    eta5 !== null && (eta7 === null || eta5 <= eta7) ? "5h" : eta7 !== null ? "7d" : null;
  const firstConstraintLabel = firstConstraint === "5h" ? window5.floorLabel : firstConstraint === "7d" ? window7.floorLabel : null;

  return {
    pool_now: {
      ready_accounts: readyAccounts,
      total_accounts: totalAccounts,
      active_agents: activeAgents,
      total_agents: totalAgents,
      assigned_load_w: assignedLoadW,
      usable_capacity_w: usableCapacityW,
      pool_load_pct: poolLoadPct,
      spare_w: spareW,
      spare_heavy: Math.max(0, Math.floor(spareW / bucketWeights.heavyWeight)),
      spare_medium: Math.max(0, Math.floor(spareW / bucketWeights.mediumWeight)),
      spare_light: Math.max(0, Math.floor(spareW / bucketWeights.lightWeight)),
    },
    windows: {
      pool_5h_used_pct: window5.usedPct,
      pool_5h_remaining_w: window5.remainingWeight,
      pool_7d_used_pct: window7.usedPct,
      pool_7d_remaining_w: window7.remainingWeight,
      floor_5h_pct: window5.floorPct,
      floor_5h_label: window5.floorLabel,
      floor_7d_pct: window7.floorPct,
      floor_7d_label: window7.floorLabel,
    },
    pressure: {
      recent_overflows_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.demandOverflowReceipts, 0))),
      rebalances_blocked_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.blockedNoEligible, 0))),
      rebalances_warn_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.warningReceipts, 0))),
      cold_start_agents: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.coldStartAgentCount, 0))),
      over_target_accounts: overTargetAccounts,
    },
    projection: {
      load_pct_6h: projectLoadPct(6),
      load_pct_24h: projectLoadPct(24),
      load_pct_72h: projectLoadPct(72),
      load_pct_7d: projectLoadPct(24 * 7),
      overflow_eta_h: overflowEtaH,
      first_constraint: firstConstraint,
      first_constraint_label: firstConstraintLabel,
    },
  };
}
