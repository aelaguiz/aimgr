import path from "node:path";
import { AIMGR_REDIS_PRIMARY_HOST, AIMGR_REDIS_PRIMARY_URL, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { resolveManagedPiAgentDir, resolvePiAuthFilePath } from "../io/paths.js";
import { resolveHarnessOwnedAuthPath } from "./harness-auth.js";
import {
  buildRecentSelectionCycleAvoidLabels,
  collectCodexPoolStatusWithExhaustionHistory,
  recordOpenaiCodexBlockedSelectionHistory,
} from "../pool/history.js";
import { pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import {
  discoverStatusConfiguredOpenclawCodexAgents,
  getOpenclawAssignments,
  getOpenclawTargetState,
  getPiTargetState,
} from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function createPiTargetAdapter({ state, homeDir, env = {} }) {
  state.targets = isObject(state.targets) ? state.targets : {};
  state.targets.piCli = isObject(state.targets.piCli) ? state.targets.piCli : {};
  const resolvedAgentDir = resolveManagedPiAgentDir({ homeDir, env });
  const ownership = resolveHarnessOwnedAuthPath({
    targetState: state.targets.piCli,
    resolvedAuthPath: resolvePiAuthFilePath(resolvedAgentDir),
  });
  return Object.freeze({
    targetId: "pi",
    targetState: state.targets.piCli,
    agentDir: path.dirname(ownership.authPath),
    resolvedAgentDir,
    ...ownership,
  });
}

/** Recognizes only the exact secret projection written by AIM before external cutover. */
export function isRecognizedAimLegacyPiProjection({ entry, targetState, record }) {
  if (
    !isObject(entry)
    || entry.type !== "oauth"
    || record?.provider !== OPENAI_CODEX_PROVIDER
    || targetState?.activeLabel !== record.label
    || targetState?.expectedAccountId !== record.credential?.accountId
  ) {
    return false;
  }
  const expires = parseExpiresAtToMs(record.credential?.expiresAt);
  return Boolean(
    typeof entry.access === "string"
    && entry.access === record.credential?.access
    && typeof entry.refresh === "string"
    && entry.refresh === record.credential?.refresh
    && typeof entry.accountId === "string"
    && entry.accountId === record.credential?.accountId
    && Number.isFinite(entry.expires)
    && entry.expires === expires
  );
}

export function clearLegacyPiProjectionReceipt(targetState) {
  delete targetState.activeLabel;
  delete targetState.expectedAccountId;
  delete targetState.lastAppliedAt;
  delete targetState.lastSelectionReceipt;
}

export async function selectNextBestPiCodexLabel({
  state,
  homeDir,
  usageByProvider,
  currentLabel: currentLabelOverride,
  avoidCurrentLabel = false,
  recentRotationLabels = [],
  observedAt = new Date().toISOString(),
}) {
  ensureStateShape(state);
  const usageByLabel = usageByProvider?.[OPENAI_CODEX_PROVIDER] ?? {};
  const poolStatus = collectCodexPoolStatusWithExhaustionHistory({
    state,
    homeDir,
    usageByLabel,
    observedAt,
  });
  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Redis-backed Codex pool labels are available on this machine yet. "
        + `Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`, then enroll a Codex label.`,
    );
  }
  if (poolStatus.eligibleLabels.length === 0) {
    recordOpenaiCodexBlockedSelectionHistory(state, { observedAt });
    return Object.freeze({ status: "blocked", selection: null, poolStatus });
  }

  const target = getPiTargetState(state);
  const currentLabel = currentLabelOverride !== undefined
    ? currentLabelOverride
    : (typeof target?.providers?.[OPENAI_CODEX_PROVIDER]?.binding === "string"
      ? target.providers[OPENAI_CODEX_PROVIDER].binding
      : null);
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel,
    currentAssignments: getOpenclawAssignments(state),
    configuredAgents: discoverStatusConfiguredOpenclawCodexAgents(state),
    agentDemand: state.pool.openaiCodex.agentDemand,
    lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
    now: Date.parse(observedAt),
  });
  const sourceLabel = avoidCurrentLabel ? currentLabel : null;
  const selectableLabels = rankedCandidates
    .filter((candidate) => pickNextBestLocalCliPoolLabel({ rankedCandidates: [candidate] }))
    .map((candidate) => candidate.label);
  const cycleAvoid = buildRecentSelectionCycleAvoidLabels({
    selectableLabels,
    sourceLabel,
    recentLabels: recentRotationLabels,
  });
  const withoutSource = rankedCandidates.filter((candidate) => candidate.label !== sourceLabel);
  const preferred = withoutSource.filter((candidate) => !cycleAvoid.has(candidate.label));
  const selection = pickNextBestLocalCliPoolLabel({ rankedCandidates: preferred })
    ?? pickNextBestLocalCliPoolLabel({ rankedCandidates: withoutSource })
    ?? pickNextBestLocalCliPoolLabel({ rankedCandidates });
  if (!selection) throw new Error("Failed to select a next-best Pi pool label.");
  return Object.freeze({ status: "selected", selection, poolStatus });
}

export function resolvePiAuthPath({ homeDir, env = {} }) {
  return path.join(resolveManagedPiAgentDir({ homeDir, env }), "auth.json");
}
