import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { assertAnthropicCredentialShape } from "../credentials/anthropic.js";
import { cloneJsonObject, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, normalizeNonEmptyStringArray, readClaudeAppStateFile, readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { syncLiveClaudeRotationBackToLabel } from "../credentials/claude-native.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveClaudeAppStatePath, resolveClaudeAuthFilePath, resolveManagedClaudeDir } from "../io/paths.js";
import { appendAnthropicHistory, buildAnthropicExhaustionHistoryEntries, recordAnthropicBlockedSelectionHistory } from "../pool/history.js";
import { collectAnthropicPoolStatus, getAnthropicPoolLabels, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { getClaudeTargetState } from "../state/accounts.js";
import { parseTimestampLikeToMs } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { buildWarningsFromClaudeTargetStatus, clearManagedClaudeCliActivation, getAnthropicCredentialMatchLabel, readClaudeCliTargetStatus } from "./claude-status.js";

export function buildClaudeAuthDotJson({ credential }) {
  const bundle = getClaudeNativeBundle(credential);
  const oauth = cloneJsonObject(bundle?.claudeAiOauth);
  if (!oauth) {
    throw new Error("Refusing to build Claude .credentials.json without a native Claude bundle.");
  }
  const expiresAt = parseTimestampLikeToMs(oauth.expiresAt);
  if (!expiresAt) {
    throw new Error("Refusing to build Claude .credentials.json without a valid expiresAt timestamp.");
  }
  oauth.expiresAt = expiresAt;
  oauth.scopes = normalizeNonEmptyStringArray(oauth.scopes);
  return {
    claudeAiOauth: oauth,
  };
}

// `.claude.json` is a mixed Claude app-state file. AIM owns only the
// `oauthAccount` key there and must preserve unrelated settings exactly.

export function writeClaudeAppStateOauthAccount({ homeDir, credential }) {
  const bundle = getClaudeNativeBundle(credential);
  const oauthAccount = cloneJsonObject(bundle?.oauthAccount);
  if (!oauthAccount) {
    throw new Error("Refusing to write Claude app state without a native Claude oauthAccount bundle.");
  }
  const current = readClaudeAppStateFile({ homeDir });
  if (current.exists === true && current.ok !== true) {
    throw new Error(`Refusing to mutate unreadable Claude app state file: ${current.error || current.appStatePath}`);
  }
  const next = {
    ...(current.ok === true && isObject(current.json) ? current.json : {}),
    oauthAccount,
    hasCompletedOnboarding: true,
    hasAvailableSubscription: true,
  };
  return writeJsonFileIfChanged(resolveClaudeAppStatePath({ homeDir }), next, { mode: 0o600 });
}

export function applyClaudeCliFromState({ label, homeDir }, state) {
  ensureStateShape(state);
  if (getAnthropicPoolLabels(state).length === 0) {
    throw new Error(
      "No Claude pool labels are available on this machine yet. " +
        "Reauth a Claude label first with `aim <label>`.",
    );
  }

  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown Claude label: ${normalizedLabel}. Run \`aim status\` to inspect the local pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== ANTHROPIC_PROVIDER) {
    throw new Error(`Refusing to activate non-Claude label=${normalizedLabel} provider=${provider || "unknown"}.`);
  }

  const preSwitchSync = syncLiveClaudeRotationBackToLabel({ state, homeDir });

  const credential = assertAnthropicCredentialShape({
    label: normalizedLabel,
    credential: getAnthropicCredential(state, normalizedLabel),
    requireFresh: true,
    requireClaudeNativeBundle: true,
  });

  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const authPayload = buildClaudeAuthDotJson({ credential });
  const credentialsWrite = writeJsonFileIfChanged(resolveClaudeAuthFilePath(claudeDir), authPayload, { mode: 0o600 });
  const appStateWrite = writeClaudeAppStateOauthAccount({ homeDir, credential });
  const readback = readClaudeNativeBundle({ homeDir });
  if (readback.ok !== true) {
    throw new Error("Failed to read back managed Claude auth bundle after apply.");
  }
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error("Claude readback is missing native auth bundle fields after apply.");
  }
  const inferredLabel = getAnthropicCredentialMatchLabel(state, {
    accessToken: readback.summary.access,
    refreshToken: readback.summary.refresh,
  });
  if (inferredLabel && inferredLabel !== normalizedLabel) {
    throw new Error(`Claude readback mismatch after apply: expected label=${normalizedLabel}, got ${inferredLabel}.`);
  }

  const target = getClaudeTargetState(state);
  target.claudeDir = claudeDir;
  delete target.authPath;
  delete target.expectedSubscriptionType;
  target.credentialsPath = readback.credentialsPath;
  target.appStatePath = readback.appStatePath;
  target.activeLabel = normalizedLabel;
  target.lastAppliedAt = new Date().toISOString();

  return {
    label: normalizedLabel,
    subscriptionType: credential.subscriptionType,
    claudeDir,
    credentialsPath: readback.credentialsPath,
    appStatePath: readback.appStatePath,
    wrote: {
      credentials: credentialsWrite.wrote,
      appState: appStateWrite.wrote,
    },
    preSwitchSync,
  };
}

export async function activateClaudePoolSelection({
  state,
  homeDir,
  env = {},
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
}) {
  ensureStateShape(state);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env });
  const usageByLabel = usageByProvider[ANTHROPIC_PROVIDER];
  const poolStatus = collectAnthropicPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });

  appendAnthropicHistory(
    state,
    buildAnthropicExhaustionHistoryEntries({
      usage: usageByLabel,
      eligibleLabels: poolStatus.eligibleLabels,
      observedAt,
    }),
  );

  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Claude pool labels are available on this machine yet. " +
        "Reauth a Claude label first with `aim <label>`.",
    );
  }

  const target = getClaudeTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readClaudeCliTargetStatus({ state, homeDir, env });
    clearManagedClaudeCliActivation({ state, homeDir });
    const blockerDetails = poolStatus.labels
      .map((label) => {
        const entry = poolStatus.byLabel[label];
        if (!entry || entry.eligible === true) return null;
        return {
          label,
          reason: entry.usageReason || entry.detailReason || entry.reason || "not_eligible",
        };
      })
      .filter(Boolean);
    const receipt = {
      action: "claude_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      warnings: [],
      blockers: blockerDetails.length > 0 ? blockerDetails : [{ reason: "no_eligible_pool_account" }],
      reasons: [],
      wroteCredentialsJson: false,
      wroteAppStateJson: false,
    };
    target.lastSelectionReceipt = receipt;
    recordAnthropicBlockedSelectionHistory(state, { observedAt });
    return { status: "blocked", receipt, wrote: false };
  }

  const currentTarget = readClaudeCliTargetStatus({ state, homeDir, env });
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel: currentTarget.activeLabel,
    currentAssignments: {},
    configuredAgents: [],
    agentDemand: {},
    lastApplyReceipt: null,
    now: Date.parse(observedAt),
  });
  const selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  if (!selection) {
    throw new Error("Failed to select a next-best Claude pool label.");
  }

  const activated = applyClaudeCliFromState({
    label: selection.label,
    homeDir,
  }, state);
  const postStatus = readClaudeCliTargetStatus({ state, homeDir, env });
  const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
  const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
  const status =
    !wroteAny
    && currentTarget.activeLabel === selection.label
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "claude_use",
    status,
    observedAt,
    previousLabel: currentTarget.activeLabel ?? undefined,
    label: selection.label,
    subscriptionType: activated.subscriptionType,
    keptCurrent: Boolean(selection.keptCurrent),
    reasons: Array.isArray(selection.reasons) ? selection.reasons : [],
    credentialsPath: activated.credentialsPath,
    appStatePath: activated.appStatePath,
    wroteCredentialsJson: Boolean(activated.wrote?.credentials),
    wroteAppStateJson: Boolean(activated.wrote?.appState),
    warnings,
    blockers: [],
  };
  target.lastSelectionReceipt = receipt;
  appendAnthropicHistory(state, [
    {
      observedAt,
      kind: "selection",
      status,
      label: selection.label,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason: selection.keptCurrent ? "kept_current" : "next_best",
    },
  ]);

  return { status, receipt, wrote: wroteAny };
}

export function classifyClaudeActivationError(err) {
  const message = String(err?.message ?? err);
  if (/nativeclaudebundle.*missing|missing or incomplete native Claude bundle|missing_native_claude_bundle/i.test(message)) {
    return "missing_native_claude_bundle";
  }
  if (/expired anthropic credentials|credentials are expired/i.test(message)) {
    return "expired_credentials";
  }
  if (/Missing anthropic credentials/i.test(message)) {
    return "missing_credentials";
  }
  return "activation_failed";
}

export function activateClaudeLabelSelection({ state, homeDir, env = {}, label }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();
  const target = getClaudeTargetState(state);
  const currentTarget = readClaudeCliTargetStatus({ state, homeDir, env });

  try {
    const activated = applyClaudeCliFromState({
      label: normalizedLabel,
      homeDir,
    }, state);
    const postStatus = readClaudeCliTargetStatus({ state, homeDir, env });
    const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
    const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
    const status =
      !wroteAny && currentTarget.activeLabel === normalizedLabel
        ? "noop"
        : warnings.length > 0
          ? "activated_with_warnings"
          : "activated";
    const receipt = {
      action: "claude_use",
      status,
      observedAt,
      previousLabel: currentTarget.activeLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      subscriptionType: activated.subscriptionType,
      reasons: ["explicit_label"],
      credentialsPath: activated.credentialsPath,
      appStatePath: activated.appStatePath,
      wroteCredentialsJson: Boolean(activated.wrote?.credentials),
      wroteAppStateJson: Boolean(activated.wrote?.appState),
      warnings,
      blockers: [],
      preSwitchSync: activated.preSwitchSync,
    };
    target.lastSelectionReceipt = receipt;
    appendAnthropicHistory(state, [
      {
        observedAt,
        kind: "selection",
        status,
        label: normalizedLabel,
        hadSpareEligibleCapacity: false,
        reason: "explicit_label",
      },
    ]);
    return { status, receipt, wrote: wroteAny };
  } catch (err) {
    const message = String(err?.message ?? err);
    const receipt = {
      action: "claude_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      reasons: ["explicit_label"],
      warnings: [],
      blockers: [
        {
          label: normalizedLabel,
          reason: classifyClaudeActivationError(err),
          detail: message,
        },
      ],
      wroteCredentialsJson: false,
      wroteAppStateJson: false,
    };
    target.lastSelectionReceipt = receipt;
    appendAnthropicHistory(state, [
      {
        observedAt,
        kind: "selection",
        status: "blocked",
        label: normalizedLabel,
        hadSpareEligibleCapacity: false,
        reason: classifyClaudeActivationError(err),
      },
    ]);
    return { status: "blocked", receipt, wrote: false };
  }
}
