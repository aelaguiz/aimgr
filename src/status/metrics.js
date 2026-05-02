import { MIN_AGENT_DEMAND_WEIGHT } from "../core/constants.js";
import { clampPercent } from "../core/numbers.js";
import { isObject, normalizeAgentId, normalizeLabel } from "../core/normalize.js";
import { buildLabelCapacityInfo } from "../pool/token-usage.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";

export function inferWindowHours(windowLabel) {
  const raw = String(windowLabel ?? "").trim();
  if (!raw) return null;
  const hoursMatch = raw.match(/^(\d+(?:\.\d+)?)h$/i);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    return Number.isFinite(hours) && hours > 0 ? hours : null;
  }
  if (/^day$/i.test(raw)) return 24;
  if (/^week$/i.test(raw)) return 168;
  return null;
}

export function roundMetric(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

export function formatMetricValue(value, { decimals = 1, suffix = "", integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const rendered = integer
    ? String(Math.round(number))
    : number.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return `${rendered}${suffix}`;
}

export function formatStatusBlockRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => [
    String(row?.[0] ?? ""),
    String(row?.[1] ?? ""),
    String(row?.[2] ?? ""),
  ]);
  if (normalized.length === 0) return [];
  const keyWidth = normalized.reduce((max, row) => Math.max(max, row[0].length), 0);
  const valueWidth = normalized.reduce((max, row) => Math.max(max, row[1].length), 0);
  return normalized.map(([key, value, extra]) => {
    const base = `${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}`.trimEnd();
    return extra ? `${base}  ${extra}` : base;
  });
}

export function buildStatusDemandByAgent({ configuredAgents, agentDemand }) {
  const ids = Array.isArray(configuredAgents) ? configuredAgents : [];
  const ledger = isObject(agentDemand) ? agentDemand : {};
  const observed = ids
    .map((agentId) => normalizeDemandWeight(ledger[normalizeAgentId(agentId)]?.demandWeight, 0))
    .filter((weight) => weight > 0);
  const fallbackDemandWeight = Math.max(
    MIN_AGENT_DEMAND_WEIGHT,
    observed.length > 0 ? observed.reduce((sum, weight) => sum + weight, 0) / observed.length : MIN_AGENT_DEMAND_WEIGHT,
  );
  return Object.fromEntries(
    ids.map((agentIdRaw) => {
      const agentId = normalizeAgentId(agentIdRaw);
      const entry = isObject(ledger[agentId]) ? ledger[agentId] : {};
      return [
        agentId,
        {
          demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(entry.demandWeight, fallbackDemandWeight))),
          source:
            entry.source === "openclaw-session-tokens" || entry.source === "cold-start-equal-share"
              ? entry.source
              : "cold-start-equal-share",
        },
      ];
    }),
  );
}

export function deriveDemandBucketWeights(demandByAgent) {
  const weights = Object.values(isObject(demandByAgent) ? demandByAgent : {})
    .map((entry) => normalizeDemandWeight(entry?.demandWeight, 0))
    .filter((weight) => weight > 0)
    .sort((a, b) => a - b);
  if (weights.length === 0) {
    return { lightWeight: 1, mediumWeight: 2, heavyWeight: 4 };
  }
  const pick = (fraction) => {
    const index = Math.max(0, Math.min(weights.length - 1, Math.floor((weights.length - 1) * fraction)));
    return weights[index];
  };
  const lightWeight = roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, pick(0.25)));
  const mediumWeight = roundDemandWeight(Math.max(lightWeight, pick(0.5)));
  const heavyWeight = roundDemandWeight(Math.max(mediumWeight, pick(0.75)));
  return { lightWeight, mediumWeight, heavyWeight };
}

export function buildStatusLabelWeights({ eligibleLabels, liveUsage, demandByAgent, lastApplyReceipt }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  if (labels.length === 0) return {};

  const receiptEntries = new Map();
  for (const entry of Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : []) {
    if (!isObject(entry) || typeof entry.label !== "string") continue;
    const label = normalizeLabel(entry.label);
    receiptEntries.set(
      label,
      roundDemandWeight(
        Math.max(
          0,
          normalizeDemandWeight(entry.capacityBudgetWeight, normalizeDemandWeight(entry.targetDemandWeight, normalizeDemandWeight(entry.carriedDemandWeight, 0))),
        ),
      ),
    );
  }

  const totalDemandWeight = Object.values(isObject(demandByAgent) ? demandByAgent : {}).reduce(
    (sum, entry) => sum + normalizeDemandWeight(entry?.demandWeight, 0),
    0,
  );
  const totalRemainingPct = labels.reduce(
    (sum, label) => sum + Math.max(0, buildLabelCapacityInfo(liveUsage?.[label] ?? null).planningRemainingPct),
    0,
  );

  return Object.fromEntries(
    labels.map((label) => {
      const fromReceipt = receiptEntries.get(label);
      const fallbackWeight =
        totalDemandWeight > 0 && totalRemainingPct > 0
          ? (Math.max(0, buildLabelCapacityInfo(liveUsage?.[label] ?? null).planningRemainingPct) / totalRemainingPct) * totalDemandWeight
          : 1;
      return [label, roundDemandWeight(fromReceipt > 0 ? fromReceipt : fallbackWeight)];
    }),
  );
}

export function buildAssignedDemandByLabel({ eligibleLabels, configuredAgents, currentAssignments, demandByAgent }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const labelSet = new Set(labels);
  const assignedDemandByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignedCountsByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignments = isObject(currentAssignments) ? currentAssignments : {};
  const configuredSet = new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)));
  const demand = isObject(demandByAgent) ? demandByAgent : {};

  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    if (!configuredSet.has(agentId)) continue;
    if (typeof labelRaw !== "string") continue;
    const label = normalizeLabel(labelRaw);
    if (!labelSet.has(label)) continue;
    assignedCountsByLabel[label] += 1;
    assignedDemandByLabel[label] = roundDemandWeight(
      normalizeDemandWeight(assignedDemandByLabel[label], 0) + normalizeDemandWeight(demand[agentId]?.demandWeight, MIN_AGENT_DEMAND_WEIGHT),
    );
  }

  return { assignedDemandByLabel, assignedCountsByLabel };
}

export function summarizePoolWindow({ eligibleLabels, liveUsage, labelWeights, index, now }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const weights = isObject(labelWeights) ? labelWeights : {};
  let totalWeight = 0;
  let usedWeighted = 0;
  let remainingWeight = 0;
  let rateWeightPerHour = 0;
  let floorPct = null;
  let floorLabel = null;

  for (const label of labels) {
    const snapshot = liveUsage?.[label];
    const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
    const window = windows[index] ?? windows[windows.length - 1] ?? null;
    if (!window) continue;
    const weight = normalizeDemandWeight(weights[label], 0);
    if (weight <= 0) continue;
    const usedPct = clampPercent(window.usedPercent ?? 0);
    const remainingPct = clampPercent(100 - usedPct);
    totalWeight += weight;
    usedWeighted += weight * usedPct;
    remainingWeight += weight * (remainingPct / 100);
    if (floorPct === null || remainingPct < floorPct) {
      floorPct = remainingPct;
      floorLabel = label;
    }

    const totalHours = inferWindowHours(window.label);
    const resetAtMs = typeof window.resetAt === "number" ? window.resetAt : Number(window.resetAt);
    if (!Number.isFinite(totalHours) || totalHours <= 0 || !Number.isFinite(resetAtMs)) continue;
    const hoursRemaining = Math.max(0, Math.min(totalHours, (resetAtMs - now) / 3600000));
    const hoursElapsed = Math.max(0, totalHours - hoursRemaining);
    if (hoursElapsed <= 0 || usedPct <= 0) continue;
    rateWeightPerHour += (weight * (usedPct / 100)) / hoursElapsed;
  }

  const usedPct = totalWeight > 0 ? usedWeighted / totalWeight : 0;
  return {
    usedPct: roundMetric(usedPct, 1) ?? 0,
    remainingWeight: roundDemandWeight(remainingWeight),
    floorPct: roundMetric(floorPct ?? 0, 1) ?? 0,
    floorLabel,
    rateWeightPerHour: roundDemandWeight(rateWeightPerHour),
  };
}
