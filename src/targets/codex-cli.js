import path from "node:path";
import { getCodexCredential } from "../browser/seed.js";
import { CODEX_AUTH_STORE_MODE_FILE, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { clampPercent } from "../core/numbers.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { findCodexLabelByAccountId } from "../credentials/codex.js";
import { CODEX_LOCAL_AUTHORITY, readLocalCodexCredential } from "../credentials/codex-local.js";
import { prepareCodexAccountState } from "../privacy/codex-account-state.js";
import { readCodexEnvironment } from "../privacy/codex-environment.js";
import { appendOpenaiCodexHistory, collectCodexPoolStatusWithExhaustionHistory, recordOpenaiCodexBlockedSelectionHistory } from "../pool/history.js";
import { pickLeastUsedCodexPoolLabel, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { collectCodexUsageSnapshots, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverStatusConfiguredOpenclawCodexAgents, getCodexTargetState, getOpenclawAssignments, getOpenclawTargetState } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function applyCodexCliFromState({ label, homeDir, env = {} }, state) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!account) throw new Error(`Unknown Codex label: ${normalizedLabel}.`);
  if (normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) throw new Error(`Refusing to activate non-Codex label=${normalizedLabel}.`);
  const selected = getCodexCredential(state, normalizedLabel);
  if (selected?.authority !== CODEX_LOCAL_AUTHORITY) throw new Error(`Sign in on this machine with \`aim codex login ${normalizedLabel}\` before using this Codex account.`);
  const environment = state.codexEnvironment ?? readCodexEnvironment();
  const local = readLocalCodexCredential({ homeDir, env, environment, accountId: selected.accountId });
  if (local.status !== "ready") throw new Error(`Codex login is ${local.status} on this machine. Run \`aim codex login ${normalizedLabel}\`.`);
  const prepared = prepareCodexAccountState({ homeDir, env, environment, accountId: selected.accountId, label: normalizedLabel });
  const target = getCodexTargetState(state);
  target.homeDir = prepared.codexHome;
  target.activeLabel = normalizedLabel;
  target.expectedAccountId = prepared.accountId;
  target.environmentId = prepared.environmentId;
  target.lastAppliedAt = new Date().toISOString();
  // Selection does not project or replace auth. Native and AIM use the one
  // environment-local canonical target, guarded by the native sidecar lock.
  return { label: normalizedLabel, accountId: prepared.accountId, codexHome: prepared.codexHome,
    authPath: path.join(prepared.accountRoot, "auth.json"), storeMode: "file", wrote: false, prepared };
}

export function readCodexCliTargetStatus({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const target = getCodexTargetState(state);
  const environment = state.codexEnvironment ?? readCodexEnvironment();
  const accountId = target.expectedAccountId;
  let local = null;
  if (accountId) {
    try { local = readLocalCodexCredential({ homeDir, env, environment, accountId }); }
    catch { local = { status: "local_auth_unavailable", credential: null }; }
  }
  const codexHome = local?.paths?.codexHome ?? null;
  const activeLabel = target.activeLabel || null;
  const actualAccountId = local?.credential?.accountId ?? null;
  return {
    source: "environment-local", importedAt: null, importedLabels: Object.keys(state.accounts),
    homeDir: codexHome, authPath: local?.paths ? path.join(local.paths.accountRoot, "auth.json") : null,
    storeMode: "file", storeSource: "privacy policy", storeConfigPath: codexHome ? path.join(codexHome, "config.toml") : null,
    storeError: null, activeLabel, activeAccountPresent: Boolean(state.accounts[activeLabel]),
    activeCredentialPresent: Boolean(local?.credential), expectedAccountId: accountId ?? null, actualAccountId,
    inferredLabel: actualAccountId ? findCodexLabelByAccountId(state, actualAccountId) : null,
    readback: { exists: Boolean(local?.raw), ok: Boolean(local?.credential), accountId: actualAccountId,
      ...(local && !local.credential ? { error: local.status } : {}) },
    lastSelectionReceipt: target.lastSelectionReceipt ?? null, lastWatchReceipt: target.lastWatchReceipt ?? null,
    lastAppliedAt: target.lastAppliedAt ?? null,
  };
}

export function buildWarningsFromCodexTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (status.storeError) {
    warnings.push({
      kind: "codex_target_config_invalid",
      system: "codex-cli",
      status: status.storeError,
    });
  } else if (status.storeMode && status.storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    warnings.push({
      kind: "codex_target_store_mode_unsupported",
      system: "codex-cli",
      status: status.storeMode,
    });
  }

  if (
    !status.importedLabels?.length
    && status.activeLabel
    && (!status.activeAccountPresent || !status.activeCredentialPresent)
  ) {
    warnings.push({
      kind: "codex_import_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "codex_target_label_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "codex_target_credentials_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.readback.exists) {
    warnings.push({
      kind: "codex_target_missing_auth_file",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "codex_target_auth_unreadable",
      system: "codex-cli",
      status: status.readback.error,
    });
  }

  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    warnings.push({
      kind: "codex_target_account_mismatch",
      system: "codex-cli",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }

  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    warnings.push({
      kind: "codex_target_label_mismatch",
      system: "codex-cli",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return warnings;
}

export function getWeeklyRemainingPctFromUsageSnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true) return null;
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return null;
  return clampPercent(100 - Number(windows[0]?.usedPercent ?? 0));
}

export function buildCodexWatchNonfatalWarnings(status) {
  return buildWarningsFromCodexTargetStatus(status)
    .filter((warning) => warning?.kind === "codex_import_missing");
}

export function buildCodexWatchTargetBlockers(status) {
  const blockers = [];
  if (!status) return blockers;

  if (status.storeError) {
    blockers.push({ reason: "codex_target_config_invalid", status: status.storeError });
  } else if (status.storeMode && status.storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    blockers.push({ reason: "codex_target_store_mode_unsupported", status: status.storeMode });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    blockers.push({ reason: "codex_target_label_missing", label: status.activeLabel });
  }
  if (status.activeLabel && !status.activeCredentialPresent) {
    blockers.push({ reason: "codex_target_credentials_missing", label: status.activeLabel });
  }
  if (status.activeLabel && !status.readback.exists) {
    blockers.push({ reason: "codex_target_missing_auth_file", label: status.activeLabel });
  }
  if (status.readback.exists && status.readback.ok !== true) {
    blockers.push({ reason: "codex_target_auth_unreadable", status: status.readback.error || "unknown" });
  }
  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    blockers.push({
      reason: "codex_target_account_mismatch",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }
  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    blockers.push({
      reason: "codex_target_label_mismatch",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return blockers;
}

export function classifyCodexActivationError(err) {
  const message = String(err?.message ?? err);
  if (/Unknown imported label/i.test(message)) {
    return "unknown_label";
  }
  if (/Refusing to activate non-Codex label/i.test(message)) {
    return "wrong_provider";
  }
  if (/Refusing expired openai-codex credentials/i.test(message)) {
    return "expired_credentials";
  }
  if (/Missing openai-codex credentials|credentials\.openai-codex\.[^.]+\.(access|refresh|accountId) is missing/i.test(message)) {
    return "missing_credentials";
  }
  if (/cli_auth_credentials_store|Managed Codex activation requires file-backed auth storage/i.test(message)) {
    return "unmanaged_codex_home";
  }
  return "activation_failed";
}

export function activateCodexLabelSelection({ state, homeDir, env = {}, label }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();
  const target = getCodexTargetState(state);
  const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
  const currentLabel = currentTarget.inferredLabel ?? currentTarget.activeLabel ?? null;

  try {
    const activated = applyCodexCliFromState({ label: normalizedLabel, homeDir, env }, state);
    const postStatus = readCodexCliTargetStatus({ state, homeDir, env });
    const warnings = buildWarningsFromCodexTargetStatus(postStatus);
    const status =
      !activated.wrote && currentLabel === normalizedLabel && currentTarget.expectedAccountId === activated.accountId
        ? "noop"
        : warnings.length > 0
          ? "activated_with_warnings"
          : "activated";
    const receipt = {
      action: "codex_use",
      status,
      observedAt,
      previousLabel: currentLabel ?? undefined,
      label: normalizedLabel,
      accountId: activated.accountId,
      explicit: true,
      reasons: ["explicit_label"],
      authPath: activated.authPath,
      wroteAuthJson: Boolean(activated.wrote),
      warnings,
      blockers: [],
    };
    target.lastSelectionReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "selection",
        status,
        label: normalizedLabel,
        accountId: activated.accountId,
        hadSpareEligibleCapacity: false,
        reason: "explicit_label",
      },
    ]);
    return { status, receipt, wrote: Boolean(activated.wrote), prepared: activated.prepared };
  } catch (err) {
    const message = String(err?.message ?? err);
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      reasons: ["explicit_label"],
      warnings: [],
      blockers: [
        {
          label: normalizedLabel,
          reason: classifyCodexActivationError(err),
          detail: message,
        },
      ],
      wroteAuthJson: false,
    };
    target.lastSelectionReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "selection",
        status: "blocked",
        label: normalizedLabel,
        hadSpareEligibleCapacity: false,
        reason: classifyCodexActivationError(err),
      },
    ]);
    return { status: "blocked", receipt, wrote: false };
  }
}

export async function activateCodexPoolSelection({
  state,
  homeDir,
  env = {},
  observedAt: observedAtOverride,
  usageByProvider: usageByProviderOverride,
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
  avoidCurrentLabel = false,
  selectLeastUsed = false,
}) {
  ensureStateShape(state);
  // Structural target validation comes first: if this machine's Codex home is not
  // AIM-manageable, fail loud before doing pool selection or usage probing.
  const observedAt =
    typeof observedAtOverride === "string" && observedAtOverride.trim()
      ? observedAtOverride.trim()
      : new Date().toISOString();
  const usageByProvider = isObject(usageByProviderOverride)
    ? usageByProviderOverride
    : await collectCodexUsageSnapshots({
        state,
        homeDir,
        env,
        nowMs: Date.parse(observedAt),
        probeUsageSnapshotsByProviderImpl,
      });
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const poolStatus = collectCodexPoolStatusWithExhaustionHistory({
    state,
    homeDir,
    usageByLabel,
    observedAt,
  });
  const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
  const currentLabel = currentTarget.inferredLabel ?? currentTarget.activeLabel ?? null;
  const selectionEligibleLabels =
    avoidCurrentLabel && currentLabel
      ? poolStatus.eligibleLabels.filter((label) => label !== currentLabel)
      : poolStatus.eligibleLabels;

  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Redis-backed Codex pool labels are available on this machine yet. " +
        "Import a reviewed Redis snapshot or enroll a Codex label before using Codex targets.",
    );
  }

  const target = getCodexTargetState(state);
  if (avoidCurrentLabel && selectionEligibleLabels.length === 0) {
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentLabel ?? undefined,
      warnings: [],
      blockers: [{ reason: "no_alternate_pool_account" }],
      reasons: ["avoid_current_label"],
      wroteAuthJson: false,
    };
    target.lastSelectionReceipt = receipt;
    recordOpenaiCodexBlockedSelectionHistory(state, { observedAt, reason: "no_alternate_pool_account" });
    return { status: "blocked", receipt, wrote: false };
  }

  if (poolStatus.eligibleLabels.length === 0) {
    const currentAccount = currentLabel ? poolStatus.byLabel[currentLabel] : null;
    const currentCredential = currentLabel ? getCodexCredential(state, currentLabel) : null;
    const currentAuthMatches = Boolean(
      currentLabel
      && currentTarget.readback?.ok === true
      && currentTarget.actualAccountId
      && currentTarget.actualAccountId === currentCredential?.accountId
    );
    const keepCurrentForTelemetry = Boolean(
      currentLabel
      && poolStatus.credentialEligibleLabels.includes(currentLabel)
      && currentAccount?.usageReason === "usage_unavailable"
      && (
        currentAuthMatches
        || currentTarget.expectedAccountId === currentTarget.actualAccountId
        || currentTarget.inferredLabel === currentLabel
      )
    );
    if (keepCurrentForTelemetry) {
      const receipt = {
        action: "codex_use",
        status: "noop",
        observedAt,
        previousLabel: currentLabel,
        label: currentLabel,
        warnings: [{ reason: "usage_unavailable", source: "telemetry" }],
        blockers: [],
        reasons: ["kept_current_usage_unavailable"],
        wroteAuthJson: false,
      };
      target.lastSelectionReceipt = receipt;
      return { status: "noop", receipt, wrote: false, prepared: applyCodexCliFromState({ label: currentLabel, homeDir, env }, state).prepared };
    }
    const telemetryOnlyFailure = poolStatus.credentialEligibleLabels.some(
      (label) => poolStatus.byLabel[label]?.usageReason === "usage_unavailable",
    );
    if (telemetryOnlyFailure) {
      const receipt = {
        action: "codex_use",
        status: "blocked",
        observedAt,
        previousLabel: currentLabel ?? undefined,
        warnings: [],
        blockers: [{ reason: "usage_unavailable" }],
        reasons: [],
        wroteAuthJson: false,
      };
      target.lastSelectionReceipt = receipt;
      recordOpenaiCodexBlockedSelectionHistory(state, { observedAt, reason: "usage_unavailable" });
      return { status: "blocked", receipt, wrote: false };
    }
    // Pool exhaustion never deletes a healthy account-private grant.
    delete target.activeLabel;
    delete target.expectedAccountId;
    delete target.homeDir;
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentLabel ?? undefined,
      warnings: [],
      blockers: [{ reason: "no_eligible_pool_account" }],
      reasons: [],
      wroteAuthJson: false,
    };
    target.lastSelectionReceipt = receipt;
    recordOpenaiCodexBlockedSelectionHistory(state, { observedAt });
    return { status: "blocked", receipt, wrote: false };
  }

  let selection;
  if (selectLeastUsed) {
    const recentRotationLabels = (Array.isArray(state.pool?.openaiCodex?.history)
      ? state.pool.openaiCodex.history
      : [])
      .filter((entry) => entry?.kind === "selection" && (entry?.status === "activated" || entry?.status === "noop"))
      .map((entry) => entry.label)
      .filter((label) => typeof label === "string" && label.trim());
    selection = pickLeastUsedCodexPoolLabel({
      labels: selectionEligibleLabels,
      usage: usageByLabel,
      avoidLabel: avoidCurrentLabel ? currentLabel : null,
      recentLabels: recentRotationLabels,
    });
  } else {
    const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
    const currentAssignments = getOpenclawAssignments(state);
    const rankedCandidates = rankPoolCandidates({
      labels: selectionEligibleLabels,
      usage: usageByLabel,
      currentLabel,
      currentAssignments,
      configuredAgents: configuredCodexAgents,
      agentDemand: state.pool.openaiCodex.agentDemand,
      lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
      now: Date.parse(observedAt),
    });
    selection = pickNextBestLocalCliPoolLabel({
      rankedCandidates,
      avoidLabel: avoidCurrentLabel ? currentLabel : null,
    });
  }
  if (!selection) {
    throw new Error("Failed to select a Codex pool label.");
  }

  const activated = applyCodexCliFromState({ label: selection.label, homeDir, env }, state);
  const postStatus = readCodexCliTargetStatus({ state, homeDir, env });
  const warnings = buildWarningsFromCodexTargetStatus(postStatus);
  const status =
    !activated.wrote && currentLabel === selection.label && currentTarget.expectedAccountId === activated.accountId
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "codex_use",
    status,
    observedAt,
    previousLabel: currentLabel ?? undefined,
    label: selection.label,
    accountId: activated.accountId,
    keptCurrent: Boolean(selection.keptCurrent),
    reasons: Array.isArray(selection.reasons) ? selection.reasons : [],
    authPath: activated.authPath,
    wroteAuthJson: Boolean(activated.wrote),
    warnings,
    blockers: [],
  };
  target.lastSelectionReceipt = receipt;
  appendOpenaiCodexHistory(state, [
    {
      observedAt,
      kind: "selection",
      status,
      label: selection.label,
      accountId: activated.accountId,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason: selection.keptCurrent ? "kept_current" : "next_best",
    },
  ]);

  return { status, receipt, wrote: Boolean(activated.wrote), prepared: activated.prepared };
}
