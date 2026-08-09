import { parseExpiresAtToMs } from "../core/time.js";
import { COLD_START_EQUAL_SHARE_DEMAND_SOURCE, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS, HERMES_SESSION_DEMAND_SOURCE, MIN_AGENT_DEMAND_WEIGHT } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeHermesHomeId } from "../core/normalize.js";

export function parseTimestampLikeToMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeDemandWeight(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

export function roundDemandWeight(value) {
  return Math.round(normalizeDemandWeight(value) * 100) / 100;
}

export function pruneOpenaiCodexHistory(history) {
  const list = Array.isArray(history) ? history.filter((entry) => isObject(entry)) : [];
  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const filtered = list.filter((entry) => {
    const observedAtMs = parseExpiresAtToMs(entry.observedAt);
    return observedAtMs !== null && observedAtMs >= cutoffMs;
  });
  const limited = filtered.slice(-200);
  return limited.map((entry) => {
    const next = {
      observedAt: String(entry.observedAt),
      kind: String(entry.kind),
    };
    if (typeof entry.status === "string" && entry.status.trim()) next.status = entry.status.trim();
    if (typeof entry.label === "string" && entry.label.trim()) next.label = entry.label.trim();
    if (typeof entry.previousLabel === "string" && entry.previousLabel.trim()) {
      next.previousLabel = entry.previousLabel.trim();
    }
    if (typeof entry.accountId === "string" && entry.accountId.trim()) next.accountId = entry.accountId.trim();
    if (typeof entry.reason === "string" && entry.reason.trim()) next.reason = entry.reason.trim();
    if (typeof entry.hadSpareEligibleCapacity === "boolean") {
      next.hadSpareEligibleCapacity = entry.hadSpareEligibleCapacity;
    }
    return next;
  });
}

export function pruneOpenaiCodexAgentDemand(agentDemand) {
  const entries = isObject(agentDemand) ? agentDemand : {};
  const next = {};
  for (const [agentIdRaw, entry] of Object.entries(entries)) {
    try {
      const agentId = normalizeAgentId(agentIdRaw);
      const current = isObject(entry) ? entry : {};
      const updatedAtMs = parseTimestampLikeToMs(current.updatedAt);
      const lookbackDays = Math.max(1, Math.round(normalizeDemandWeight(current.lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
      const source =
        current.source === "openclaw-session-tokens" || current.source === "cold-start-equal-share"
          ? current.source
          : "cold-start-equal-share";
      next[agentId] = {
        updatedAt: updatedAtMs !== null ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
        lookbackDays,
        source,
        inputTokens: roundDemandWeight(current.inputTokens),
        outputTokens: roundDemandWeight(current.outputTokens),
        totalTokens: roundDemandWeight(current.totalTokens),
        demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(current.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
      };
    } catch {
      // Ignore malformed demand-ledger entries; the next rebalance refresh will restore them if needed.
    }
  }
  return next;
}

export function pruneHermesFleetDemand(homeDemand) {
  const entries = isObject(homeDemand) ? homeDemand : {};
  const next = {};
  for (const [homeIdRaw, entry] of Object.entries(entries)) {
    try {
      const homeId = normalizeHermesHomeId(homeIdRaw);
      const current = isObject(entry) ? entry : {};
      const updatedAtMs = parseTimestampLikeToMs(current.updatedAt);
      const lookbackDays = Math.max(1, Math.round(normalizeDemandWeight(current.lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
      const source =
        current.source === HERMES_SESSION_DEMAND_SOURCE || current.source === COLD_START_EQUAL_SHARE_DEMAND_SOURCE
          ? current.source
          : COLD_START_EQUAL_SHARE_DEMAND_SOURCE;
      const inputTokens = roundDemandWeight(current.inputTokens);
      const outputTokens = roundDemandWeight(current.outputTokens);
      const cacheReadTokens = roundDemandWeight(current.cacheReadTokens);
      const cacheWriteTokens = roundDemandWeight(current.cacheWriteTokens);
      const reasoningTokens = roundDemandWeight(current.reasoningTokens);
      next[homeId] = {
        updatedAt: updatedAtMs !== null ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
        lookbackDays,
        source,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens: roundDemandWeight(
          Math.max(
            0,
            normalizeDemandWeight(
              current.totalTokens,
              inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
            ),
          ),
        ),
        demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(current.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
      };
    } catch {
      // Ignore malformed Hermes demand entries; the next refresh will repopulate them from live homes.
    }
  }
  return next;
}
