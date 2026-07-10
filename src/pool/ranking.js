import { readBrowserFacts } from "../browser/bindings.js";
import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, LOCAL_CLI_MIN_PRIMARY_REMAINING_PCT, MIN_AGENT_DEMAND_WEIGHT, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { derivePoolAccountStatus, isUsageSnapshotExhausted } from "./account-status.js";
import { buildLabelCapacityInfo } from "./token-usage.js";
import { clampPercent } from "../core/numbers.js";
import { buildWeightedRebalanceCandidate, buildWeightedRebalanceSupply, shouldKeepCurrentWeightedAssignment } from "./weighted-planner.js";
import { getAccountPoolState } from "../state/accounts.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { buildAssignedDemandByLabel, buildStatusDemandByAgent, deriveDemandBucketWeights } from "../status/metrics.js";

export function getCodexPoolLabels(state) {
  ensureStateShape(state);
  return Object.entries(state.accounts)
    .filter(([, account]) => isObject(account))
    .filter(([, account]) => normalizeProviderId(account.provider) === OPENAI_CODEX_PROVIDER)
    .filter(([label]) => getAccountPoolState(state, label)?.enabled !== false)
    .map(([label]) => normalizeLabel(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function getAnthropicPoolLabels(state) {
  ensureStateShape(state);
  return Object.entries(state.accounts)
    .filter(([, account]) => isObject(account))
    .filter(([, account]) => normalizeProviderId(account.provider) === ANTHROPIC_PROVIDER)
    .filter(([label]) => getAccountPoolState(state, label)?.enabled !== false)
    .map(([label]) => normalizeLabel(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function collectCodexPoolStatus({ state, homeDir, usageByLabel, now }) {
  const labels = getCodexPoolLabels(state);
  const byLabel = {};
  const eligibleLabels = [];

  for (const label of labels) {
    const account = state.accounts[label];
    const browserFacts = readBrowserFacts({ account, homeDir, label });
    const status = derivePoolAccountStatus({
      account,
      label,
      credentials: getCodexCredential(state, label),
      browserFacts,
      now,
    });
    const usage = usageByLabel[label] ?? null;
    const usageOk = usage?.ok === true && Array.isArray(usage.windows) && usage.windows.length > 0;
    const usageExhausted = usageOk && isUsageSnapshotExhausted(usage);
    const eligible = status.eligible && usageOk && !usageExhausted;
    byLabel[label] = {
      ...status,
      label,
      browserFacts,
      usage,
      eligible,
      poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
      usageReason: !usageOk ? "usage_unavailable" : usageExhausted ? "usage_exhausted" : null,
    };
    if (eligible) {
      eligibleLabels.push(label);
    }
  }

  return { labels, byLabel, eligibleLabels };
}

export function collectAnthropicPoolStatus({ state, homeDir, usageByLabel, now }) {
  const labels = getAnthropicPoolLabels(state);
  const byLabel = {};
  const eligibleLabels = [];

  for (const label of labels) {
    const account = state.accounts[label];
    const browserFacts = readBrowserFacts({ account, homeDir, label });
    const status = derivePoolAccountStatus({
      account,
      label,
      credentials: getAnthropicCredential(state, label),
      browserFacts,
      now,
    });
    const usage = usageByLabel[label] ?? null;
    const usageOk = usage?.ok === true && Array.isArray(usage.windows) && usage.windows.length > 0;
    const usageExhausted = usageOk && isUsageSnapshotExhausted(usage);
    const eligible = status.eligible && usageOk && !usageExhausted;
    byLabel[label] = {
      ...status,
      label,
      browserFacts,
      usage,
      eligible,
      poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
      usageReason: !usageOk ? "usage_unavailable" : usageExhausted ? "usage_exhausted" : null,
    };
    if (eligible) {
      eligibleLabels.push(label);
    }
  }

  return { labels, byLabel, eligibleLabels };
}

export function rankPoolCandidates({
  labels,
  usage,
  currentLabel,
  assignedCounts,
  currentAssignments,
  configuredAgents,
  agentDemand,
  lastApplyReceipt,
  selectionDemandWeight,
  now,
}) {
  const normalizedLabels = [...new Set((Array.isArray(labels) ? labels : []).map((label) => normalizeLabel(label)))];
  const current = typeof currentLabel === "string" ? normalizeLabel(currentLabel) : null;
  const counts = isObject(assignedCounts) ? assignedCounts : {};
  const demandByAgent = buildStatusDemandByAgent({ configuredAgents, agentDemand });
  const { assignedDemandByLabel, assignedCountsByLabel } = buildAssignedDemandByLabel({
    eligibleLabels: normalizedLabels,
    configuredAgents,
    currentAssignments,
    demandByAgent,
  });
  const bucketWeights = deriveDemandBucketWeights(demandByAgent);
  const effectiveSelectionDemandWeight = roundDemandWeight(
    Math.max(
      MIN_AGENT_DEMAND_WEIGHT,
      normalizeDemandWeight(selectionDemandWeight, bucketWeights.mediumWeight),
    ),
  );
  const totalDemandWeight = Object.values(demandByAgent).reduce(
    (sum, entry) => sum + normalizeDemandWeight(entry?.demandWeight, 0),
    0,
  );
  const supply = buildWeightedRebalanceSupply({ labels: normalizedLabels, usage });
  const targetUnitsTotal = normalizedLabels.reduce(
    (sum, label) => sum + normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0),
    0,
  );
  const effectiveTotalDemandWeight = Math.max(effectiveSelectionDemandWeight, totalDemandWeight);
  const targetDemandByLabel = Object.fromEntries(
    normalizedLabels.map((label) => [
      label,
      targetUnitsTotal <= 0
        ? 0
        : (normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0) / targetUnitsTotal) * effectiveTotalDemandWeight,
    ]),
  );
  for (const label of normalizedLabels) {
    if (!isObject(supply.byLabel[label])) continue;
    supply.byLabel[label].capacityBudgetWeight = roundDemandWeight(targetDemandByLabel[label]);
  }
  const receiptTargets = new Map();
  for (const entry of Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : []) {
    if (!isObject(entry) || typeof entry.label !== "string") continue;
    receiptTargets.set(
      normalizeLabel(entry.label),
      roundDemandWeight(
        Math.max(
          0,
          normalizeDemandWeight(
            entry.capacityBudgetWeight,
            normalizeDemandWeight(entry.targetDemandWeight, normalizeDemandWeight(entry.carriedDemandWeight, 0)),
          ),
        ),
      ),
    );
  }
  const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const candidates = normalizedLabels.map((label) => {
    const snapshot = usage?.[label] ?? null;
    const capacity = buildLabelCapacityInfo(snapshot);
    const targetDemandWeight = receiptTargets.has(label)
      ? receiptTargets.get(label)
      : roundDemandWeight(targetDemandByLabel[label]);
    const candidate = buildWeightedRebalanceCandidate({
      label,
      supply: {
        ...supply.byLabel[label],
        targetDemandWeight,
        capacityBudgetWeight: targetDemandWeight,
      },
      assignedDemandByLabel,
      assignedCounts: {
        ...assignedCountsByLabel,
        [label]: Number.isFinite(Number(assignedCountsByLabel[label]))
          ? Number(assignedCountsByLabel[label])
          : (Number.isFinite(Number(counts[label])) ? Number(counts[label]) : 0),
      },
      agentWeight: effectiveSelectionDemandWeight,
    });
    return {
      ...candidate,
      accountId: null,
      primaryUsedPct: capacity.primaryUsedPct,
      secondaryUsedPct: capacity.secondaryUsedPct,
      observedAt,
    };
  });

  candidates.sort((a, b) => {
    if (a.overflowWeight !== b.overflowWeight) return a.overflowWeight - b.overflowWeight;
    if (a.projectedDemandRatio !== b.projectedDemandRatio) return a.projectedDemandRatio - b.projectedDemandRatio;
    if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
    if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
    if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
    return a.label.localeCompare(b.label);
  });

  if (current) {
    const best = candidates[0] ?? null;
    const currentCandidate = candidates.find((candidate) => candidate.label === current) ?? null;
    if (
      best
      && currentCandidate
      && shouldKeepCurrentWeightedAssignment({
        currentCandidate,
        bestCandidate: best,
        agentWeight: effectiveSelectionDemandWeight,
      })
    ) {
      currentCandidate.keptCurrent = true;
      currentCandidate.reasons.push("within_weighted_hysteresis");
      candidates.splice(candidates.indexOf(currentCandidate), 1);
      candidates.unshift(currentCandidate);
    }
  }

  return candidates;
}

export function pickNextBestPoolLabel({ rankedCandidates }) {
  const candidates = Array.isArray(rankedCandidates) ? rankedCandidates : [];
  return candidates[0] ?? null;
}

export function pickNextBestLocalCliPoolLabel({
  rankedCandidates,
  minPrimaryRemainingPct = LOCAL_CLI_MIN_PRIMARY_REMAINING_PCT,
  avoidLabel,
}) {
  const avoided = typeof avoidLabel === "string" && avoidLabel.trim() ? normalizeLabel(avoidLabel) : null;
  const candidates = (Array.isArray(rankedCandidates) ? rankedCandidates : [])
    .filter((candidate) => {
      if (!avoided || typeof candidate?.label !== "string") return true;
      return normalizeLabel(candidate.label) !== avoided;
    })
    .map((candidate) => ({
      ...candidate,
      keptCurrent: false,
      reasons: [],
    }));
  const selectableCandidates = candidates.filter((candidate) => {
    const primaryRemainingPct = Number(candidate.primaryRemainingPct);
    const secondaryRemainingPct = Number(candidate.secondaryRemainingPct);
    return (
      Number.isFinite(primaryRemainingPct)
      && Number.isFinite(secondaryRemainingPct)
      && primaryRemainingPct > 5
      && secondaryRemainingPct > 5
    );
  });
  if (selectableCandidates.length === 0) return null;
  const primaryRemainingFloor = clampPercent(minPrimaryRemainingPct);
  const gatedCandidates = selectableCandidates.filter((candidate) => candidate.primaryRemainingPct >= primaryRemainingFloor);
  const selectionPool = gatedCandidates.length > 0 ? gatedCandidates : selectableCandidates;

  selectionPool.sort((a, b) => {
    if (a.secondaryUsedPct !== b.secondaryUsedPct) return a.secondaryUsedPct - b.secondaryUsedPct;
    if (a.primaryUsedPct !== b.primaryUsedPct) return a.primaryUsedPct - b.primaryUsedPct;
    if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
    if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
    if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
    return a.label.localeCompare(b.label);
  });

  const best = selectionPool[0] ?? null;
  if (!best) return null;
  best.reasons.push(
    gatedCandidates.length > 0
      ? "lowest_weekly_used_over_5h_gate"
      : "lowest_weekly_used_after_5h_gate_relaxed",
  );
  return best;
}
