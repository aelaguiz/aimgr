import { parseExpiresAtToMs } from "../core/time.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { isUsageSnapshotExhausted } from "./account-status.js";
import { buildLabelCapacityInfo } from "./token-usage.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";

export function projectPoolCapacity({
  history,
  liveUsage,
  agentDemand,
  lastApplyReceipt,
  horizonDays = 7,
  lookbackDays = 14,
  now,
}) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = snapshotNow - Number(lookbackDays) * 24 * 60 * 60 * 1000;
  const events = (Array.isArray(history) ? history : []).filter((entry) => {
    if (!isObject(entry)) return false;
    const observedAtMs = parseExpiresAtToMs(entry.observedAt);
    return observedAtMs !== null && observedAtMs >= cutoffMs;
  });

  const blockedNoEligible = events.filter((entry) => entry.status === "blocked" && entry.reason === "no_eligible_pool_account").length;
  const demandOverflowReceipts = events.filter((entry) => entry.reason === "projected_demand_exceeds_eligible_supply").length;
  const warningReceipts = events.filter((entry) => typeof entry.status === "string" && entry.status.endsWith("_with_warnings")).length;
  const spareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === true).length;
  const noSpareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === false).length;
  const currentHighUtilizationLabels = Object.entries(isObject(liveUsage) ? liveUsage : {})
    .filter(([, snapshot]) => isUsageSnapshotExhausted(snapshot))
    .map(([label]) => label)
    .toSorted((a, b) => a.localeCompare(b));
  const agentDemandEntries = Object.values(isObject(agentDemand) ? agentDemand : {});
  const knownAgentDemandCount = agentDemandEntries.filter((entry) => entry?.source === "openclaw-session-tokens").length;
  const coldStartAgentCount = agentDemandEntries.filter((entry) => entry?.source === "cold-start-equal-share").length;
  const perAccountLoad = Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : [];
  const byAccountPressure = perAccountLoad
    .map((entry) => {
      if (!isObject(entry) || typeof entry.label !== "string") return null;
      const label = normalizeLabel(entry.label);
      const carriedDemandWeight = roundDemandWeight(entry.carriedDemandWeight);
      const targetDemandWeight = roundDemandWeight(entry.targetDemandWeight);
      const pressureRatio =
        targetDemandWeight > 0 ? roundDemandWeight(carriedDemandWeight / targetDemandWeight) : null;
      const capacity = buildLabelCapacityInfo(liveUsage?.[label] ?? null);
      return {
        label,
        carriedAgentCount: Math.max(0, Math.round(normalizeDemandWeight(entry.carriedAgentCount, 0))),
        carriedDemandWeight,
        targetDemandWeight,
        ...(typeof entry.capacityBudgetWeight === "number"
          ? { capacityBudgetWeight: roundDemandWeight(entry.capacityBudgetWeight) }
          : {}),
        pressureRatio,
        overTargetDemandWeight: roundDemandWeight(Math.max(0, carriedDemandWeight - targetDemandWeight)),
        primaryRemainingPct: capacity.primaryRemainingPct,
        secondaryRemainingPct: capacity.secondaryRemainingPct,
      };
    })
    .filter(Boolean)
    .toSorted((a, b) => {
      const aRatio = Number.isFinite(a.pressureRatio) ? a.pressureRatio : -1;
      const bRatio = Number.isFinite(b.pressureRatio) ? b.pressureRatio : -1;
      if (aRatio !== bRatio) return bRatio - aRatio;
      return a.label.localeCompare(b.label);
    });

  const needMoreAccounts = blockedNoEligible >= 1 || noSpareExhaustions >= 2 || demandOverflowReceipts >= 1;
  let riskLevel = "low";
  if (needMoreAccounts) {
    riskLevel = "high";
  } else if (spareExhaustions >= 1 || warningReceipts >= 2) {
    riskLevel = "medium";
  }

  const reasons = [];
  if (blockedNoEligible > 0) reasons.push(`${blockedNoEligible} blocked receipt(s) reported no eligible pool account.`);
  if (demandOverflowReceipts > 0) reasons.push(`${demandOverflowReceipts} recent rebalance receipt(s) overflowed projected demand beyond eligible supply.`);
  if (noSpareExhaustions > 0) reasons.push(`${noSpareExhaustions} exhaustion event(s) occurred with no spare eligible capacity.`);
  if (spareExhaustions > 0) reasons.push(`${spareExhaustions} exhaustion event(s) occurred but spare eligible capacity existed.`);
  if (warningReceipts > 0) reasons.push(`${warningReceipts} recent receipt(s) completed with warnings.`);
  for (const pressure of byAccountPressure.filter((entry) => entry.overTargetDemandWeight > 0)) {
    reasons.push(
      `${pressure.label} is carrying ${pressure.carriedAgentCount} agent(s) at ${pressure.carriedDemandWeight} demand weight, above its ${pressure.targetDemandWeight} target.`,
    );
  }

  return {
    needMoreAccounts,
    riskLevel,
    reasons,
    basedOn: {
      horizonDays,
      lookbackDays,
      blockedNoEligible,
      demandOverflowReceipts,
      warningReceipts,
      spareExhaustions,
      noSpareExhaustions,
      currentHighUtilizationLabels,
      knownAgentDemandCount,
      coldStartAgentCount,
    },
    ...(byAccountPressure.length > 0 ? { byAccountPressure } : {}),
  };
}
