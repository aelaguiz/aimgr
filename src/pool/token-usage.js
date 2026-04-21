import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCodexCredential } from "../browser/seed.js";
import { DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeHermesHomeId } from "../core/normalize.js";
import { findCodexLabelByAccountId, findCodexLabelByTokenPair } from "../credentials/codex.js";
import { readJsonFile } from "../io/json-store.js";
import { resolveHermesHomePath, resolveHermesProfilesRoot, resolveHermesStateDbPath } from "../io/paths.js";
import { resolveSqlite3Command } from "../io/process.js";
import { resolveOpenclawSessionsStorePath } from "../openclaw/stores.js";
import { clampPercent } from "../core/numbers.js";
import { getCodexUsagePercents } from "./usage.js";
import { getHermesFleetDemandState } from "../state/accounts.js";
import { normalizeDemandWeight, parseTimestampLikeToMs, roundDemandWeight } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { doesHermesPoolMatchCodexCredential, doesHermesReadbackMatchCodexCredential, readHermesAuthFile } from "../targets/hermes-auth.js";

export function buildLabelCapacityInfo(snapshot) {
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const secondaryRemainingPct = windows.length > 1 ? clampPercent(100 - secondaryUsedPct) : clampPercent(100 - primaryUsedPct);
  const primaryRemainingPct = clampPercent(100 - primaryUsedPct);
  const planningUsedPct = windows.length > 1 ? secondaryUsedPct : primaryUsedPct;
  const planningRemainingPct = windows.length > 1 ? secondaryRemainingPct : primaryRemainingPct;
  const bottleneckUsedPct = Math.max(primaryUsedPct, windows.length > 1 ? secondaryUsedPct : primaryUsedPct);
  return {
    primaryUsedPct,
    secondaryUsedPct,
    primaryRemainingPct,
    secondaryRemainingPct,
    planningUsedPct,
    planningRemainingPct,
    bottleneckUsedPct,
    remainingPct: planningRemainingPct,
  };
}

export function readOpenclawAgentTokenUsage({
  homeDir,
  agentId,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const storePath = resolveOpenclawSessionsStorePath(homeDir, normalizedAgentId);
  const wrapOpenclawDemandReadError = (error) => {
    const wrapped = new Error(
      `Failed to read OpenClaw session demand for ${normalizedAgentId}: ${String(error?.message ?? error ?? "unknown error")}`,
      { cause: error },
    );
    wrapped.code = "OPENCLAW_AGENT_DEMAND_UNREADABLE";
    wrapped.agentId = normalizedAgentId;
    wrapped.storePath = storePath;
    return wrapped;
  };
  let existing;
  try {
    existing = readJsonFile(storePath);
  } catch (error) {
    throw wrapOpenclawDemandReadError(error);
  }
  if (!existing) {
    return {
      agentId: normalizedAgentId,
      storePath,
      exists: false,
      sessionsTotal: 0,
      sessionsConsidered: 0,
      sessionsWithTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latestSessionAt: null,
    };
  }
  if (!isObject(existing)) {
    throw wrapOpenclawDemandReadError(new Error(`OpenClaw sessions store is not an object map: ${storePath}`));
  }

  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = snapshotNow - Math.max(1, Number(lookbackDays)) * 24 * 60 * 60 * 1000;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let sessionsConsidered = 0;
  let sessionsWithTokens = 0;
  let latestSessionAtMs = null;

  for (const entry of Object.values(existing)) {
    if (!isObject(entry)) continue;
    const updatedAtMs = parseTimestampLikeToMs(entry.updatedAt);
    if (updatedAtMs === null || updatedAtMs < cutoffMs) continue;
    sessionsConsidered += 1;

    const entryInputTokens = normalizeDemandWeight(entry.inputTokens, 0);
    const entryOutputTokens = normalizeDemandWeight(entry.outputTokens, 0);
    const rawTotalTokens = Number(entry.totalTokens);
    const entryTotalTokens =
      Number.isFinite(rawTotalTokens) && rawTotalTokens >= 0 ? rawTotalTokens : entryInputTokens + entryOutputTokens;
    if (entryInputTokens <= 0 && entryOutputTokens <= 0 && entryTotalTokens <= 0) {
      continue;
    }

    inputTokens += entryInputTokens;
    outputTokens += entryOutputTokens;
    totalTokens += entryTotalTokens;
    sessionsWithTokens += 1;
    if (latestSessionAtMs === null || updatedAtMs > latestSessionAtMs) {
      latestSessionAtMs = updatedAtMs;
    }
  }

  return {
    agentId: normalizedAgentId,
    storePath,
    exists: true,
    sessionsTotal: Object.keys(existing).length,
    sessionsConsidered,
    sessionsWithTokens,
    inputTokens: roundDemandWeight(inputTokens),
    outputTokens: roundDemandWeight(outputTokens),
    totalTokens: roundDemandWeight(totalTokens),
    latestSessionAt: latestSessionAtMs !== null ? new Date(latestSessionAtMs).toISOString() : null,
  };
}

export function buildOpenclawDemandUnreadableBlocker(error) {
  const blocker = {
    reason: "openclaw_agent_demand_unreadable",
  };
  if (typeof error?.agentId === "string" && error.agentId.trim()) {
    blocker.agentId = error.agentId.trim();
  }
  if (typeof error?.storePath === "string" && error.storePath.trim()) {
    blocker.storePath = error.storePath.trim();
  }
  const detail = String(error?.message ?? error ?? "").trim();
  if (detail) {
    blocker.detail = detail;
  }
  return blocker;
}

export function discoverHermesHomes({ homeDir }) {
  const profilesRoot = resolveHermesProfilesRoot(homeDir);
  if (!fs.existsSync(profilesRoot)) {
    return [];
  }
  const homes = [];
  for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const homeId = normalizeHermesHomeId(entry.name);
      const homePath = resolveHermesHomePath(homeDir, homeId);
      const markers = [
        path.join(homePath, "auth.json"),
        path.join(homePath, "config.yaml"),
        path.join(homePath, ".env"),
        path.join(homePath, "state.db"),
        path.join(homePath, "gateway_state.json"),
      ];
      if (!markers.some((markerPath) => fs.existsSync(markerPath))) {
        continue;
      }
      homes.push({
        homeId,
        homePath,
        authPath: path.join(homePath, "auth.json"),
        stateDbPath: path.join(homePath, "state.db"),
      });
    } catch {
      // Ignore malformed home ids; Hermes home dirs are authoritative and the next fix should happen there.
    }
  }
  return homes.toSorted((a, b) => a.homeId.localeCompare(b.homeId));
}

export function readHermesHomeStatus({ state, homeDir, homeId }) {
  ensureStateShape(state);
  const normalizedHomeId = normalizeHermesHomeId(homeId);
  const authPath = path.join(resolveHermesHomePath(homeDir, normalizedHomeId), "auth.json");
  const readback = readHermesAuthFile({ authPath });
  const tokenPairLabel =
    readback.ok === true
      ? findCodexLabelByTokenPair(state, {
          accessToken: readback.accessToken,
          refreshToken: readback.refreshToken,
        })
      : null;
  const accountIdLabel =
    readback.ok === true && !tokenPairLabel && readback.accountId
      ? findCodexLabelByAccountId(state, readback.accountId)
      : null;
  const currentLabel = tokenPairLabel || accountIdLabel || null;
  const activeCredential = currentLabel ? getCodexCredential(state, currentLabel) : null;
  const authDrifted =
    Boolean(currentLabel)
    && isObject(activeCredential)
    && !doesHermesReadbackMatchCodexCredential(readback, activeCredential);
  const needsSync =
    Boolean(currentLabel)
    && isObject(activeCredential)
    && (authDrifted || !doesHermesPoolMatchCodexCredential(readback, activeCredential));
  const demandEntry = isObject(getHermesFleetDemandState(state)[normalizedHomeId])
    ? getHermesFleetDemandState(state)[normalizedHomeId]
    : null;
  return {
    homeId: normalizedHomeId,
    homeDir: resolveHermesHomePath(homeDir, normalizedHomeId),
    authPath,
    stateDbPath: resolveHermesStateDbPath(homeDir, normalizedHomeId),
    currentLabel: currentLabel || null,
    matchMode: tokenPairLabel ? "token_pair" : accountIdLabel ? "account_id" : "none",
    authDrifted,
    needsSync,
    activeAccountPresent: currentLabel ? isObject(state.accounts[currentLabel]) : false,
    activeCredentialPresent: currentLabel ? isObject(getCodexCredential(state, currentLabel)) : false,
    demand: demandEntry,
    readback,
  };
}

export function buildWarningsFromHermesHomeStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (!status.readback.exists) {
    warnings.push({
      kind: "hermes_home_missing_auth_file",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "hermes_home_auth_unreadable",
      system: "hermes",
      homeId: status.homeId,
      status: status.readback.error,
    });
    return warnings;
  }

  if (status.readback.ok === true && status.readback.activeProvider && status.readback.activeProvider !== OPENAI_CODEX_PROVIDER) {
    warnings.push({
      kind: "hermes_home_active_provider_unsupported",
      system: "hermes",
      homeId: status.homeId,
      provider: status.readback.activeProvider,
    });
  }

  if (status.readback.ok === true && !status.readback.providerEntryPresent) {
    warnings.push({
      kind: "hermes_home_missing_provider_entry",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.readback.ok === true && status.readback.providerEntryPresent && !status.currentLabel) {
    warnings.push({
      kind: "hermes_home_label_unmapped",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.currentLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "hermes_home_label_missing",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
    });
  }

  if (status.currentLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "hermes_home_credentials_missing",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
    });
  }

  if (status.currentLabel && status.activeCredentialPresent && status.authDrifted) {
    warnings.push({
      kind: "hermes_home_auth_drifted",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
      matchMode: status.matchMode,
    });
  } else if (status.currentLabel && status.activeCredentialPresent && status.needsSync) {
    warnings.push({
      kind: "hermes_home_auth_needs_sync",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
      matchMode: status.matchMode,
    });
  }

  return warnings;
}

export function buildHermesHomeBlockers(status) {
  const hardBlockingWarningKinds = new Set([
    "hermes_home_missing_auth_file",
    "hermes_home_auth_unreadable",
    "hermes_home_active_provider_unsupported",
    "hermes_home_missing_provider_entry",
    "hermes_home_label_missing",
    "hermes_home_credentials_missing",
  ]);
  return buildWarningsFromHermesHomeStatus(status)
    .filter((warning) => hardBlockingWarningKinds.has(warning.kind))
    .map((warning) => {
    const blocker = {
      reason: warning.kind,
      homeId: warning.homeId,
    };
    if (typeof warning.label === "string" && warning.label.trim()) {
      blocker.label = warning.label.trim();
    }
    if (typeof warning.provider === "string" && warning.provider.trim()) {
      blocker.provider = warning.provider.trim();
    }
    if (typeof warning.status === "string" && warning.status.trim()) {
      blocker.status = warning.status.trim();
    }
    return blocker;
    });
}

export function buildHermesDemandUnreadableBlocker(error) {
  const blocker = {
    reason: "hermes_home_demand_unreadable",
  };
  if (typeof error?.homeId === "string" && error.homeId.trim()) {
    blocker.homeId = error.homeId.trim();
  }
  if (typeof error?.stateDbPath === "string" && error.stateDbPath.trim()) {
    blocker.stateDbPath = error.stateDbPath.trim();
  }
  const detail = String(error?.message ?? error ?? "").trim();
  if (detail) {
    blocker.detail = detail;
  }
  return blocker;
}

export function runSqlite3Query({ dbPath, sql, homeDir, spawnImpl = spawnSync }) {
  const sqlite3Command = resolveSqlite3Command({ homeDir, spawnImpl });
  const result = spawnImpl(sqlite3Command, ["-separator", "\t", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result?.error) {
    throw new Error(`Failed to run sqlite3 for ${dbPath}: ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? "").trim();
    throw new Error(`Failed to query sqlite3 for ${dbPath}: ${stderr || `exit ${result?.status ?? "unknown"}`}`);
  }
  return String(result?.stdout ?? "").trim();
}

export function readHermesHomeTokenUsage({
  homeDir,
  homeId,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
  spawnImpl = spawnSync,
}) {
  const normalizedHomeId = normalizeHermesHomeId(homeId);
  const stateDbPath = resolveHermesStateDbPath(homeDir, normalizedHomeId);
  if (!fs.existsSync(stateDbPath)) {
    return {
      homeId: normalizedHomeId,
      stateDbPath,
      exists: false,
      sessionsTotal: 0,
      sessionsConsidered: 0,
      sessionsWithTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      latestSessionAt: null,
    };
  }

  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const cutoffSeconds = snapshotNow / 1000 - normalizedLookbackDays * 24 * 60 * 60;
  const sql = `
SELECT
  COUNT(*) AS sessions_total,
  SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN 1 ELSE 0 END) AS sessions_considered,
  SUM(
    CASE
      WHEN started_at >= ${cutoffSeconds}
        AND (
          COALESCE(input_tokens, 0)
          + COALESCE(output_tokens, 0)
          + COALESCE(cache_read_tokens, 0)
          + COALESCE(cache_write_tokens, 0)
          + COALESCE(reasoning_tokens, 0)
        ) > 0
      THEN 1
      ELSE 0
    END
  ) AS sessions_with_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(input_tokens, 0) ELSE 0 END), 0) AS input_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(output_tokens, 0) ELSE 0 END), 0) AS output_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(cache_read_tokens, 0) ELSE 0 END), 0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(cache_write_tokens, 0) ELSE 0 END), 0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(reasoning_tokens, 0) ELSE 0 END), 0) AS reasoning_tokens,
  MAX(CASE WHEN started_at >= ${cutoffSeconds} THEN started_at ELSE NULL END) AS latest_session_at
FROM sessions;`;
  let stdout;
  try {
    stdout = runSqlite3Query({ dbPath: stateDbPath, sql, homeDir, spawnImpl });
  } catch (error) {
    const wrapped = new Error(
      `Failed to read Hermes session demand for ${normalizedHomeId}: ${String(error?.message ?? error ?? "unknown error")}`,
    );
    wrapped.code = "HERMES_HOME_DEMAND_UNREADABLE";
    wrapped.homeId = normalizedHomeId;
    wrapped.stateDbPath = stateDbPath;
    throw wrapped;
  }
  const fields = stdout.split("\t");
  const [
    sessionsTotalRaw = "0",
    sessionsConsideredRaw = "0",
    sessionsWithTokensRaw = "0",
    inputTokensRaw = "0",
    outputTokensRaw = "0",
    cacheReadTokensRaw = "0",
    cacheWriteTokensRaw = "0",
    reasoningTokensRaw = "0",
    latestSessionAtRaw = "",
  ] = fields;
  const inputTokens = roundDemandWeight(inputTokensRaw);
  const outputTokens = roundDemandWeight(outputTokensRaw);
  const cacheReadTokens = roundDemandWeight(cacheReadTokensRaw);
  const cacheWriteTokens = roundDemandWeight(cacheWriteTokensRaw);
  const reasoningTokens = roundDemandWeight(reasoningTokensRaw);
  const latestSessionAtSeconds = Number(latestSessionAtRaw);
  return {
    homeId: normalizedHomeId,
    stateDbPath,
    exists: true,
    sessionsTotal: Math.max(0, Math.round(normalizeDemandWeight(sessionsTotalRaw, 0))),
    sessionsConsidered: Math.max(0, Math.round(normalizeDemandWeight(sessionsConsideredRaw, 0))),
    sessionsWithTokens: Math.max(0, Math.round(normalizeDemandWeight(sessionsWithTokensRaw, 0))),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: roundDemandWeight(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens),
    latestSessionAt: Number.isFinite(latestSessionAtSeconds) && latestSessionAtSeconds > 0
      ? new Date(latestSessionAtSeconds * 1000).toISOString()
      : null,
  };
}
