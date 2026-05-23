import { getCodexCredential } from "../browser/seed.js";
import { CODEX_AUTH_STORE_MODE_FILE, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { clampPercent } from "../core/numbers.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { toIsoFromExpiresMs } from "../core/time.js";
import { assertCodexCredentialShape, buildCodexCredentialFingerprint, findCodexLabelByAccountId } from "../credentials/codex.js";
import { decodeJwtPayload } from "../credentials/jwt.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveCodexAuthFilePath, resolveCodexConfigPath, resolveManagedCodexHomeDir } from "../io/paths.js";
import { appendOpenaiCodexHistory, collectCodexPoolStatusWithExhaustionHistory, recordOpenaiCodexBlockedSelectionHistory } from "../pool/history.js";
import { getCodexPoolLabels, pickNextBestLocalCliPoolLabel, pickNextCodexUseRoundRobinLabel, rankPoolCandidates } from "../pool/ranking.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverStatusConfiguredOpenclawCodexAgents, getCodexTargetState, getImportedCodexLabels, getOpenclawAssignments, getOpenclawTargetState, hasImportedCodexReplica } from "../state/accounts.js";
import { markImportedCodexLabelDirtyState } from "../state/authority-codex.js";
import { getAuthorityCodexImport } from "../state/authority-codex.js";
import { ensureStateShape } from "../state/schema.js";
import { buildCodexAuthDotJson, clearManagedCodexCliActivation, ensureFileBackedCodexHome, readCodexAuthFile, readCodexCliStoreMode } from "./codex-store.js";

export function applyCodexCliFromState({ label, homeDir, env = {} }, state) {
  ensureStateShape(state);
  if (!hasImportedCodexReplica(state) && getCodexPoolLabels(state).length === 0) {
    throw new Error(
      "No imported Codex replica is available on this machine yet. " +
        "Run `aim sync codex --from agents@amirs-mac-studio` first.",
    );
  }

  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown imported label: ${normalizedLabel}. Run \`aim status\` to inspect the imported pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"}.`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  const store = ensureFileBackedCodexHome({ codexHome });
  const appliedAt = new Date().toISOString();
  const authPayload = buildCodexAuthDotJson({ credential, lastRefreshAt: appliedAt });
  const writeResult = writeJsonFileIfChanged(resolveCodexAuthFilePath(codexHome), authPayload, { mode: 0o600 });
  const readback = readCodexAuthFile({ codexHome });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back managed Codex auth file: ${readback.error || "unknown error"}`);
  }
  if (readback.accountId !== credential.accountId) {
    throw new Error(
      `Codex readback mismatch after apply: expected accountId=${credential.accountId}, got ${readback.accountId || "none"}.`,
    );
  }

  const target = getCodexTargetState(state);
  target.homeDir = codexHome;
  target.activeLabel = normalizedLabel;
  target.expectedAccountId = credential.accountId;
  target.lastAppliedAt = appliedAt;

  return {
    label: normalizedLabel,
    accountId: credential.accountId,
    codexHome,
    authPath: readback.authPath,
    storeMode: store.storeMode,
    wrote: writeResult.wrote,
  };
}

export function readCodexCliTargetStatus({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const importMeta = getAuthorityCodexImport(state);
  const target = getCodexTargetState(state);
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  let store = null;
  let storeError = null;

  try {
    store = readCodexCliStoreMode({ codexHome });
  } catch (err) {
    storeError = String(err?.message ?? err);
  }

  const readback = readCodexAuthFile({ codexHome });
  const activeLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const expectedAccountId = typeof target.expectedAccountId === "string" ? target.expectedAccountId.trim() : "";
  const actualAccountId = readback.ok ? readback.accountId : null;
  const inferredLabel = actualAccountId ? findCodexLabelByAccountId(state, actualAccountId) : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedCodexLabels(state),
    homeDir: codexHome,
    authPath: resolveCodexAuthFilePath(codexHome),
    storeMode: store?.storeMode ?? null,
    storeSource: store?.source ?? null,
    storeConfigPath: store?.configPath ?? resolveCodexConfigPath(codexHome),
    storeError,
    activeLabel: activeLabel || null,
    activeAccountPresent: activeLabel ? isObject(state.accounts[activeLabel]) : false,
    activeCredentialPresent: activeLabel ? isObject(getCodexCredential(state, activeLabel)) : false,
    expectedAccountId: expectedAccountId || null,
    actualAccountId: actualAccountId || null,
    inferredLabel: inferredLabel || null,
    readback,
    lastSelectionReceipt: isObject(target.lastSelectionReceipt) ? target.lastSelectionReceipt : null,
    lastWatchReceipt: isObject(target.lastWatchReceipt) ? target.lastWatchReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
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

  if (!status.importedLabels?.length && status.activeLabel) {
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

export function getPrimaryRemainingPctFromUsageSnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true) return null;
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return null;
  return clampPercent(100 - Number(windows[0]?.usedPercent ?? 0));
}

function jwtExpiresAt(token) {
  const claims = decodeJwtPayload(token);
  const exp = Number(claims?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return toIsoFromExpiresMs(exp * 1000);
}

export function preserveLiveCodexAuthForActiveLabel({ state, homeDir, env = {}, observedAt = new Date().toISOString() }) {
  ensureStateShape(state);
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  const readback = readCodexAuthFile({ codexHome });
  if (readback.ok !== true) {
    return {
      status: "skipped",
      reason: readback.exists ? "auth_unreadable" : "auth_missing",
      authPath: readback.authPath,
    };
  }

  const tokens = isObject(readback.json?.tokens) ? readback.json.tokens : null;
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
  const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token.trim() : "";
  if (!accountId || !access || !refresh) {
    return {
      status: "skipped",
      reason: "auth_tokens_incomplete",
      authPath: readback.authPath,
      accountId: accountId || null,
    };
  }

  const target = getCodexTargetState(state);
  const targetLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const inferredLabel = findCodexLabelByAccountId(state, accountId);
  const label = targetLabel || inferredLabel;
  if (!label) {
    return {
      status: "skipped",
      reason: "label_not_found",
      authPath: readback.authPath,
      accountId,
    };
  }

  const existing = getCodexCredential(state, label);
  if (!isObject(existing)) {
    return {
      status: "skipped",
      reason: "stored_credential_missing",
      label,
      accountId,
    };
  }
  if (typeof existing.accountId === "string" && existing.accountId.trim() && existing.accountId.trim() !== accountId) {
    return {
      status: "skipped",
      reason: "account_mismatch",
      label,
      accountId,
      expectedAccountId: existing.accountId.trim(),
    };
  }

  const expiresAt = jwtExpiresAt(idToken) || jwtExpiresAt(access) || existing.expiresAt;
  const credential = {
    access,
    refresh,
    idToken: idToken || existing.idToken || access,
    expiresAt,
    accountId,
  };
  try {
    assertCodexCredentialShape({ label, credential, requireFresh: false });
  } catch (err) {
    return {
      status: "skipped",
      reason: "live_credential_invalid",
      label,
      accountId,
      detail: String(err?.message ?? err),
    };
  }

  const oldFingerprint = buildCodexCredentialFingerprint(existing);
  const newFingerprint = buildCodexCredentialFingerprint(credential);
  if (oldFingerprint === newFingerprint) {
    return {
      status: "unchanged",
      label,
      accountId,
    };
  }

  state.credentials[OPENAI_CODEX_PROVIDER][label] = credential;
  const authorityPromotion = markImportedCodexLabelDirtyState(state, label, { observedAt });
  return {
    status: "updated",
    label,
    accountId,
    authorityPromotion,
  };
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
  const currentLabel = currentTarget.activeLabel ?? currentTarget.inferredLabel ?? null;

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
    return { status, receipt, wrote: Boolean(activated.wrote) };
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
  selectionMode = "round_robin",
}) {
  ensureStateShape(state);
  // Structural target validation comes first: if this machine's Codex home is not
  // AIM-manageable, fail loud before doing pool selection or usage probing.
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir, env }) });
  const observedAt =
    typeof observedAtOverride === "string" && observedAtOverride.trim()
      ? observedAtOverride.trim()
      : new Date().toISOString();
  const usageByProvider = isObject(usageByProviderOverride)
    ? usageByProviderOverride
    : await probeUsageSnapshotsByProviderImpl(state, { env });
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const poolStatus = collectCodexPoolStatusWithExhaustionHistory({
    state,
    homeDir,
    usageByLabel,
    observedAt,
  });

  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Codex pool labels are available on this machine yet. " +
        "Run `aim sync codex --from agents@amirs-mac-studio` first.",
    );
  }

  const target = getCodexTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
    clearManagedCodexCliActivation({ state, homeDir, env });
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      warnings: [],
      blockers: [{ reason: "no_eligible_pool_account" }],
      reasons: [],
      wroteAuthJson: false,
    };
    target.lastSelectionReceipt = receipt;
    recordOpenaiCodexBlockedSelectionHistory(state, { observedAt });
    return { status: "blocked", receipt, wrote: false };
  }

  const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
  const currentLabel = currentTarget.activeLabel ?? currentTarget.inferredLabel ?? null;
  let selection;
  if (selectionMode === "round_robin") {
    selection = pickNextCodexUseRoundRobinLabel({
      poolLabels: poolStatus.labels,
      eligibleLabels: poolStatus.eligibleLabels,
      currentLabel,
    });
  } else if (selectionMode === "weighted_usage") {
    const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
    const currentAssignments = getOpenclawAssignments(state);
    const rankedCandidates = rankPoolCandidates({
      labels: poolStatus.eligibleLabels,
      usage: usageByLabel,
      currentLabel,
      currentAssignments,
      configuredAgents: configuredCodexAgents,
      agentDemand: state.pool.openaiCodex.agentDemand,
      lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
      now: Date.parse(observedAt),
    });
    selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  } else {
    throw new Error(`Unsupported Codex selection mode: ${selectionMode}`);
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

  return { status, receipt, wrote: Boolean(activated.wrote) };
}
