import { ANTHROPIC_PROVIDER, COLD_START_EQUAL_SHARE_DEMAND_SOURCE, HERMES_SESSION_DEMAND_SOURCE, KEEP_CURRENT_DEMAND_RATIO_THRESHOLD, KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR, MIN_AGENT_DEMAND_WEIGHT, OPENCLAW_SESSION_DEMAND_SOURCE } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeHermesHomeId, normalizeLabel } from "../core/normalize.js";
import { extractOpenclawConfigAgentModelPrimary } from "../openclaw/models.js";
import { parseProviderModelRef } from "../openclaw/sessions.js";
import { buildLabelCapacityInfo } from "./token-usage.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";

export function discoverConfiguredOpenclawCodexAgents({ agentsList, exclusions }) {
  const excluded = isObject(exclusions) ? exclusions : {};
  return (Array.isArray(agentsList) ? agentsList : [])
    .map((entry) => {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) return null;
      const normalizedId = normalizeAgentId(id);
      if (typeof excluded[normalizedId] === "string" && excluded[normalizedId].trim()) {
        return null;
      }
      const currentPrimary = extractOpenclawConfigAgentModelPrimary(entry?.model);
      if (!currentPrimary) return normalizedId;
      const parsed = parseProviderModelRef(currentPrimary);
      if (parsed?.provider === ANTHROPIC_PROVIDER) return null;
      return normalizedId;
    })
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
}

export function buildWeightedRebalanceSupply({ labels, usage }) {
  const normalizedLabels = [...new Set((Array.isArray(labels) ? labels : []).map((label) => normalizeLabel(label)))];
  const byLabel = {};

  // Weekly remaining headroom is the allocator SSOT.
  // Do not derive target capacity from current assignments or repeat rebalances will churn.
  for (const label of normalizedLabels) {
    const capacity = buildLabelCapacityInfo(usage?.[label] ?? null);
    byLabel[label] = {
      ...capacity,
      capacityBudgetWeight: null,
      targetUnits: Math.max(0, capacity.remainingPct),
    };
  }

  return {
    byLabel,
    budgetingEnabled: true,
  };
}

export function buildWeightedRebalanceCandidate({
  label,
  supply,
  assignedDemandByLabel,
  assignedCounts,
  agentWeight,
}) {
  const currentAssignedDemand = normalizeDemandWeight(assignedDemandByLabel[label], 0);
  const targetDemandWeight = normalizeDemandWeight(supply.targetDemandWeight, 0);
  const projectedDemandWeight = currentAssignedDemand + agentWeight;
  const overflowWeight = Math.max(0, projectedDemandWeight - targetDemandWeight);
  const projectedDemandRatio =
    targetDemandWeight > 0 ? projectedDemandWeight / targetDemandWeight : (projectedDemandWeight > 0 ? Number.POSITIVE_INFINITY : 0);
  const remainingBudgetWeight =
    supply.capacityBudgetWeight === null ? Number.POSITIVE_INFINITY : Math.max(0, supply.capacityBudgetWeight - currentAssignedDemand);

  return {
    label,
    assignedCount: Number.isFinite(Number(assignedCounts[label])) ? Number(assignedCounts[label]) : 0,
    currentAssignedDemandWeight: roundDemandWeight(currentAssignedDemand),
    targetDemandWeight: roundDemandWeight(targetDemandWeight),
    projectedDemandWeight: roundDemandWeight(projectedDemandWeight),
    overflowWeight: roundDemandWeight(overflowWeight),
    projectedDemandRatio,
    remainingBudgetWeight: Number.isFinite(remainingBudgetWeight) ? roundDemandWeight(remainingBudgetWeight) : null,
    capacityBudgetWeight: supply.capacityBudgetWeight,
    primaryRemainingPct: supply.primaryRemainingPct,
    secondaryRemainingPct: supply.secondaryRemainingPct,
    keptCurrent: false,
    reasons: [],
  };
}

export function shouldKeepCurrentWeightedAssignment({ currentCandidate, bestCandidate, agentWeight }) {
  if (!currentCandidate || !bestCandidate) return false;
  return (
    currentCandidate.overflowWeight <= bestCandidate.overflowWeight + agentWeight * KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR
    && currentCandidate.projectedDemandRatio <= bestCandidate.projectedDemandRatio + KEEP_CURRENT_DEMAND_RATIO_THRESHOLD
  );
}

export function buildWeightedPerAccountLoad({ labels, assignments, assignedDemandByLabel, targetDemandByLabel, supplyByLabel }) {
  const agentsByLabel = Object.fromEntries((Array.isArray(labels) ? labels : []).map((label) => [label, []]));
  for (const [agentIdRaw, labelRaw] of Object.entries(isObject(assignments) ? assignments : {})) {
    const label = normalizeLabel(labelRaw);
    if (!Object.hasOwn(agentsByLabel, label)) continue;
    agentsByLabel[label].push(normalizeAgentId(agentIdRaw));
  }

  return Object.entries(agentsByLabel)
    .map(([label, agentIds]) => {
      const supply = supplyByLabel[label] ?? {};
      return {
        label,
        assignedAgents: agentIds.toSorted((a, b) => a.localeCompare(b)),
        carriedAgentCount: agentIds.length,
        carriedDemandWeight: roundDemandWeight(assignedDemandByLabel[label] ?? 0),
        targetDemandWeight: roundDemandWeight(targetDemandByLabel[label] ?? 0),
        ...(supply.capacityBudgetWeight !== null ? { capacityBudgetWeight: roundDemandWeight(supply.capacityBudgetWeight ?? 0) } : {}),
        primaryRemainingPct: supply.primaryRemainingPct ?? 0,
        secondaryRemainingPct: supply.secondaryRemainingPct ?? 0,
      };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function renameWeightedPlanEntries(entries, keyName) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const { subjectId, ...rest } = isObject(entry) ? entry : {};
    return {
      [keyName]: typeof subjectId === "string" ? subjectId : null,
      ...rest,
    };
  });
}

export function mapWeightedPlanSubjectKeys(plan, keyName) {
  return {
    ...plan,
    moved: renameWeightedPlanEntries(plan?.moved, keyName),
    unchanged: renameWeightedPlanEntries(plan?.unchanged, keyName),
    skipped: renameWeightedPlanEntries(plan?.skipped, keyName),
  };
}

export function planWeightedPoolAssignments({
  configuredSubjects,
  currentAssignments,
  eligibleLabels,
  usage,
  demandLedger,
  now,
  normalizeSubjectId,
  observedDemandSource,
}) {
  // This is intentionally not the same primitive as Codex "next best label".
  // Rebalance is many-to-one demand allocation across remaining account headroom, with low-churn hysteresis.
  const subjectIds = [...new Set((Array.isArray(configuredSubjects) ? configuredSubjects : []).map((subjectId) => normalizeSubjectId(subjectId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const existingAssignments = isObject(currentAssignments) ? currentAssignments : {};
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const nextAssignments = {};
  const moved = [];
  const unchanged = [];
  const skipped = [];
  const blockers = [];
  const assignedCounts = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignedDemandByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const ledger = isObject(demandLedger) ? demandLedger : {};
  const allocationMode = Object.values(ledger).some((entry) => entry?.source === observedDemandSource)
    ? "demand_weighted"
    : "cold_start_equal_share";

  if (labels.length === 0) {
    for (const subjectId of subjectIds) {
      skipped.push({ subjectId, reason: "no_eligible_pool_account" });
    }
    blockers.push({ reason: "no_eligible_pool_account" });
    return {
      assignments: nextAssignments,
      moved,
      unchanged,
      skipped,
      blockers,
      status: "blocked",
      allocationMode,
      perAccountLoad: [],
    };
  }

  const demandBySubject = Object.fromEntries(
    subjectIds.map((subjectId) => {
      const entry = isObject(ledger[subjectId]) ? ledger[subjectId] : {};
      return [
        subjectId,
        {
          source:
            entry.source === observedDemandSource || entry.source === COLD_START_EQUAL_SHARE_DEMAND_SOURCE
              ? entry.source
              : COLD_START_EQUAL_SHARE_DEMAND_SOURCE,
          demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(entry.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
        },
      ];
    }),
  );
  const totalDemandWeight = subjectIds.reduce((sum, subjectId) => sum + demandBySubject[subjectId].demandWeight, 0);
  const supply = buildWeightedRebalanceSupply({
    labels,
    usage,
  });
  const targetUnitsTotal = labels.reduce((sum, label) => sum + normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0), 0);
  if (targetUnitsTotal <= 0) {
    for (const subjectId of subjectIds) {
      const demand = demandBySubject[subjectId];
      skipped.push({
        subjectId,
        reason: "projected_demand_exceeds_eligible_supply",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
      });
    }
    blockers.push({ reason: "projected_demand_exceeds_eligible_supply" });
    return {
      assignments: nextAssignments,
      moved,
      unchanged,
      skipped,
      blockers,
      status: "blocked",
      allocationMode,
      perAccountLoad: [],
    };
  }

  const targetDemandByLabel = Object.fromEntries(
    labels.map((label) => [
      label,
      totalDemandWeight <= 0
        ? 0
        : (normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0) / targetUnitsTotal) * totalDemandWeight,
    ]),
  );
  for (const label of labels) {
    if (!isObject(supply.byLabel[label])) continue;
    supply.byLabel[label].capacityBudgetWeight = roundDemandWeight(targetDemandByLabel[label]);
  }
  const subjectIdsByDemand = [...subjectIds].sort((a, b) => {
    const aDemand = demandBySubject[a].demandWeight;
    const bDemand = demandBySubject[b].demandWeight;
    if (aDemand !== bDemand) return bDemand - aDemand;
    const aCurrent = typeof existingAssignments[a] === "string" && labels.includes(normalizeLabel(existingAssignments[a])) ? 1 : 0;
    const bCurrent = typeof existingAssignments[b] === "string" && labels.includes(normalizeLabel(existingAssignments[b])) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return a.localeCompare(b);
  });

  for (const subjectId of subjectIdsByDemand) {
    const currentLabelRaw = typeof existingAssignments[subjectId] === "string" ? existingAssignments[subjectId] : null;
    const normalizedCurrentLabel = currentLabelRaw ? normalizeLabel(currentLabelRaw) : null;
    const currentLabel = normalizedCurrentLabel && labels.includes(normalizedCurrentLabel) ? normalizedCurrentLabel : null;
    const demand = demandBySubject[subjectId];
    const candidates = labels
      .map((label) =>
        buildWeightedRebalanceCandidate({
          label,
          supply: {
            ...supply.byLabel[label],
            targetDemandWeight: targetDemandByLabel[label],
          },
          assignedDemandByLabel,
          assignedCounts,
          agentWeight: demand.demandWeight,
        }),
      )
      .toSorted((a, b) => {
        if (a.overflowWeight !== b.overflowWeight) return a.overflowWeight - b.overflowWeight;
        if (a.projectedDemandRatio !== b.projectedDemandRatio) return a.projectedDemandRatio - b.projectedDemandRatio;
        if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
        if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
        if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
        return a.label.localeCompare(b.label);
      });
    const bestCandidate = candidates[0] ?? null;
    const currentCandidate = candidates.find((candidate) => candidate.label === currentLabel) ?? null;
    let selection = bestCandidate;
    if (shouldKeepCurrentWeightedAssignment({ currentCandidate, bestCandidate, agentWeight: demand.demandWeight })) {
      currentCandidate.keptCurrent = true;
      currentCandidate.reasons.push("within_weighted_hysteresis");
      selection = currentCandidate;
    }

    if (!selection) {
      skipped.push({
        subjectId,
        reason: "projected_demand_exceeds_eligible_supply",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
      });
      continue;
    }

    nextAssignments[subjectId] = selection.label;
    assignedCounts[selection.label] = (assignedCounts[selection.label] ?? 0) + 1;
    assignedDemandByLabel[selection.label] = roundDemandWeight(
      normalizeDemandWeight(assignedDemandByLabel[selection.label], 0) + demand.demandWeight,
    );

    if (currentLabel === selection.label) {
      unchanged.push({
        subjectId,
        label: selection.label,
        reason: selection.keptCurrent ? "kept_current_hysteresis" : "weighted_best_fit",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
        targetDemandWeight: selection.targetDemandWeight,
        projectedDemandWeight: selection.projectedDemandWeight,
      });
    } else {
      moved.push({
        subjectId,
        from: normalizedCurrentLabel ?? null,
        to: selection.label,
        reason: selection.keptCurrent ? "kept_current_hysteresis" : "weighted_best_fit",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
        targetDemandWeight: selection.targetDemandWeight,
        projectedDemandWeight: selection.projectedDemandWeight,
      });
    }
  }

  let status = "applied";
  if (subjectIds.length === 0) {
    status = "noop";
  } else if (skipped.length > 0 && skipped.length === subjectIds.length) {
    const blockedReason = skipped.every((entry) => entry.reason === "projected_demand_exceeds_eligible_supply")
      ? "projected_demand_exceeds_eligible_supply"
      : "no_eligible_pool_account";
    blockers.push({ reason: blockedReason });
    status = "blocked";
  } else if (subjectIds.length > 0 && moved.length === 0 && skipped.length === 0) {
    status = "noop";
  } else if (skipped.length > 0) {
    status = "applied_with_warnings";
  }

  return {
    assignments: nextAssignments,
    moved,
    unchanged,
    skipped,
    blockers,
    status,
    allocationMode,
    perAccountLoad: buildWeightedPerAccountLoad({
      labels,
      assignments: nextAssignments,
      assignedDemandByLabel,
      targetDemandByLabel,
      supplyByLabel: supply.byLabel,
    }),
  };
}

export function planWeightedOpenclawRebalance({ configuredAgents, currentAssignments, eligibleLabels, usage, agentDemand, now }) {
  return mapWeightedPlanSubjectKeys(
    planWeightedPoolAssignments({
      configuredSubjects: configuredAgents,
      currentAssignments,
      eligibleLabels,
      usage,
      demandLedger: agentDemand,
      now,
      normalizeSubjectId: normalizeAgentId,
      observedDemandSource: OPENCLAW_SESSION_DEMAND_SOURCE,
    }),
    "agentId",
  );
}

export function planWeightedHermesRebalance({ configuredHomes, currentAssignments, eligibleLabels, usage, homeDemand, now }) {
  return mapWeightedPlanSubjectKeys(
    planWeightedPoolAssignments({
      configuredSubjects: configuredHomes,
      currentAssignments,
      eligibleLabels,
      usage,
      demandLedger: homeDemand,
      now,
      normalizeSubjectId: normalizeHermesHomeId,
      observedDemandSource: HERMES_SESSION_DEMAND_SOURCE,
    }),
    "homeId",
  );
}

export function planOpenclawRebalance(params) {
  return planWeightedOpenclawRebalance(params);
}
