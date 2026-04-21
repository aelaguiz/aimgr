import { getCodexCredential } from "../browser/seed.js";
import { isObject } from "../core/normalize.js";
import { isUsageSnapshotExhausted } from "./account-status.js";
import { collectCodexPoolStatus } from "./ranking.js";
import { pruneOpenaiCodexHistory } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";

export function appendOpenaiCodexHistory(state, entries) {
  ensureStateShape(state);
  const current = Array.isArray(state.pool.openaiCodex.history) ? state.pool.openaiCodex.history : [];
  const additions = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry));
  state.pool.openaiCodex.history = pruneOpenaiCodexHistory([...current, ...additions]);
}

export function appendAnthropicHistory(state, entries) {
  ensureStateShape(state);
  const current = Array.isArray(state.pool.anthropic.history) ? state.pool.anthropic.history : [];
  const additions = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry));
  state.pool.anthropic.history = pruneOpenaiCodexHistory([...current, ...additions]);
}

export function buildExhaustionHistoryEntries({ state, usage, eligibleLabels, observedAt }) {
  const eligible = new Set(Array.isArray(eligibleLabels) ? eligibleLabels : []);
  const entries = [];

  for (const [label, snapshot] of Object.entries(isObject(usage) ? usage : {})) {
    if (!isUsageSnapshotExhausted(snapshot)) continue;
    const cred = getCodexCredential(state, label);
    entries.push({
      observedAt,
      kind: "exhaustion",
      label,
      ...(typeof cred?.accountId === "string" && cred.accountId.trim() ? { accountId: cred.accountId.trim() } : {}),
      hadSpareEligibleCapacity: Array.from(eligible).some((candidate) => candidate !== label),
      reason: snapshot?.ok === true ? "usage_window_95" : `provider_status_${snapshot?.status ?? "error"}`,
    });
  }

  return entries;
}

export function recordOpenaiCodexExhaustionHistory({ state, usage, eligibleLabels, observedAt }) {
  appendOpenaiCodexHistory(
    state,
    buildExhaustionHistoryEntries({
      state,
      usage,
      eligibleLabels,
      observedAt,
    }),
  );
}

export function collectCodexPoolStatusWithExhaustionHistory({ state, homeDir, usageByLabel, observedAt }) {
  const poolStatus = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });
  recordOpenaiCodexExhaustionHistory({
    state,
    usage: usageByLabel,
    eligibleLabels: poolStatus.eligibleLabels,
    observedAt,
  });
  return poolStatus;
}

export function buildBlockedSelectionHistoryEntry({ observedAt, reason = "no_eligible_pool_account" }) {
  return {
    observedAt,
    kind: "selection",
    status: "blocked",
    reason,
    hadSpareEligibleCapacity: false,
  };
}

export function recordOpenaiCodexBlockedSelectionHistory(state, { observedAt, reason } = {}) {
  appendOpenaiCodexHistory(state, [
    buildBlockedSelectionHistoryEntry({
      observedAt,
      reason,
    }),
  ]);
}

export function recordAnthropicBlockedSelectionHistory(state, { observedAt, reason } = {}) {
  appendAnthropicHistory(state, [
    buildBlockedSelectionHistoryEntry({
      observedAt,
      reason,
    }),
  ]);
}

export function buildAnthropicExhaustionHistoryEntries({ usage, eligibleLabels, observedAt }) {
  const eligible = new Set(Array.isArray(eligibleLabels) ? eligibleLabels : []);
  const entries = [];

  for (const [label, snapshot] of Object.entries(isObject(usage) ? usage : {})) {
    if (!isUsageSnapshotExhausted(snapshot)) continue;
    entries.push({
      observedAt,
      kind: "exhaustion",
      label,
      hadSpareEligibleCapacity: Array.from(eligible).some((candidate) => candidate !== label),
      reason: snapshot?.ok === true ? "usage_window_95" : `provider_status_${snapshot?.status ?? "error"}`,
    });
  }

  return entries;
}
