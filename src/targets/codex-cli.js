import { getCodexCredential } from "../browser/seed.js";
import {
  AIMGR_REDIS_PRIMARY_HOST,
  AIMGR_REDIS_PRIMARY_URL,
  CODEX_AUTH_STORE_MODE_FILE,
  OPENAI_CODEX_PROVIDER,
} from "../core/constants.js";
import { clampPercent } from "../core/numbers.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs, toIsoFromExpiresMs } from "../core/time.js";
import { assertCodexCredentialShape, buildCodexCredentialFingerprint, findCodexLabelByAccountId } from "../credentials/codex.js";
import { decodeJwtPayload } from "../credentials/jwt.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveCodexAuthFilePath, resolveCodexConfigPath, resolveManagedCodexHomeDir, resolveNativeCodexHomeDir } from "../io/paths.js";
import { appendOpenaiCodexHistory, collectCodexPoolStatusWithExhaustionHistory, recordOpenaiCodexBlockedSelectionHistory } from "../pool/history.js";
import { getCodexPoolLabels, pickLeastUsedCodexPoolLabel, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { collectCodexUsageSnapshots, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverStatusConfiguredOpenclawCodexAgents, getCodexDesktopTargetState, getCodexTargetState, getImportedCodexLabels, getOpenclawAssignments, getOpenclawTargetState, hasImportedCodexReplica } from "../state/accounts.js";
import { markImportedCodexLabelDirtyState } from "../state/authority-codex.js";
import { getAuthorityCodexImport } from "../state/authority-codex.js";
import { ensureStateShape } from "../state/schema.js";
import { buildCodexDesktopIdentityFingerprint, getCodexDesktopReservation } from "../coordination/codex-identity.js";
import { buildCodexAuthDotJson, clearManagedCodexCliActivation, ensureFileBackedCodexHome, readCodexAuthFile, readCodexCliStoreMode } from "./codex-store.js";

export function applyCodexCliFromState({ label, homeDir, env = {} }, state) {
  ensureStateShape(state);
  if (!hasImportedCodexReplica(state) && getCodexPoolLabels(state).length === 0) {
    throw new Error(
      "No Redis-backed Codex pool is available on this machine yet. " +
        `Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`, then import a reviewed snapshot or enroll a Codex label.`,
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
  const existingReadback = readCodexAuthFile({ codexHome });
  const candidatePayload = buildCodexAuthDotJson({ credential, lastRefreshAt: appliedAt });
  const existingTokens = isObject(existingReadback.json?.tokens) ? existingReadback.json.tokens : null;
  const tokensUnchanged = existingReadback.ok === true
    && existingTokens?.id_token === candidatePayload.tokens.id_token
    && existingTokens?.access_token === candidatePayload.tokens.access_token
    && existingTokens?.refresh_token === candidatePayload.tokens.refresh_token
    && existingTokens?.account_id === candidatePayload.tokens.account_id;
  const authPayload = tokensUnchanged && typeof existingReadback.json?.last_refresh === "string"
    ? { ...candidatePayload, last_refresh: existingReadback.json.last_refresh }
    : candidatePayload;
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

  // Identity mismatch is reported as a boolean only: raw immutable account
  // IDs never enter operator-visible warning payloads.
  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    warnings.push({
      kind: "codex_target_account_mismatch",
      system: "codex-cli",
      label: status.activeLabel,
      accountMismatch: true,
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

/**
 * Safe status projection for the Desktop-owned native Codex home. The native
 * home is strictly read-only here, and the result carries only the expected
 * label, booleans, and fixed reason codes: raw account IDs, fingerprints,
 * tokens, and enrollment data never enter status output. AIM deliberately has
 * no enrollment-DB reader.
 *
 * `rawRecords` is the optional raw provider-wide Redis record list (including
 * credential-empty identity records). When it is unavailable — Redis down or
 * unconfigured — the reservation state is reported as unknown (null) rather
 * than guessed.
 */
export function readCodexDesktopStatus({ state, homeDir, rawRecords = null }) {
  ensureStateShape(state);
  const nativeHome = resolveNativeCodexHomeDir({ homeDir });
  const desktop = getCodexDesktopTargetState(state);
  const expectedLabel =
    typeof desktop.expectedLabel === "string" && desktop.expectedLabel.trim() ? desktop.expectedLabel.trim() : null;
  const storedFingerprint =
    typeof desktop.identityFingerprint === "string" && desktop.identityFingerprint.trim()
      ? desktop.identityFingerprint.trim()
      : null;
  const pinnedAt = typeof desktop.pinnedAt === "string" && desktop.pinnedAt.trim() ? desktop.pinnedAt.trim() : null;
  const pinned = Boolean(expectedLabel && storedFingerprint);

  const native = readCodexAuthFile({ codexHome: nativeHome });
  const readable = native.exists === true && native.ok === true && Boolean(native.accountId);

  // Identity comparison stays inside this function: the opaque fingerprint of
  // the native account is compared against the pinned fingerprint and only the
  // resulting boolean escapes.
  let match = null;
  if (pinned && readable) {
    match = buildCodexDesktopIdentityFingerprint(native.accountId) === storedFingerprint;
  }

  let reserved = null;
  if (Array.isArray(rawRecords)) {
    reserved = rawRecords.some((record) => {
      if (record?.provider !== OPENAI_CODEX_PROVIDER) return false;
      const reservation = getCodexDesktopReservation(record);
      if (!reservation) return false;
      if (expectedLabel && record.label === expectedLabel) return true;
      return Boolean(storedFingerprint && reservation.identityFingerprint === storedFingerprint);
    });
  }

  const reason = !pinned
    ? "not_pinned"
    : !readable
      ? "native_auth_unreadable"
      : match === false
        ? "native_identity_mismatch"
        : reserved === false
          ? "reservation_missing"
          : "ok";

  return { nativeHome, expectedLabel, pinned, pinnedAt, readable, match, reserved, reason };
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

function newestCodexTokenExpiry(...tokens) {
  const expiries = tokens
    .map((token) => jwtExpiresAt(token))
    .map((expiresAt) => parseExpiresAtToMs(expiresAt))
    .filter((expiresAtMs) => Number.isFinite(expiresAtMs));
  return expiries.length > 0 ? toIsoFromExpiresMs(Math.max(...expiries)) : null;
}

/**
 * Reconcile the one managed Codex auth file with the credential currently
 * loaded from Redis. Identity must agree before freshness is considered.
 * The fresher side wins; equal-expiry token conflicts are left untouched.
 * Reconciliation results are operator-visible receipts: they carry labels and
 * fixed reason codes only, never raw immutable account IDs.
 */
export function reconcileCodexCliAuth({ state, homeDir, env = {}, observedAt = new Date().toISOString() }) {
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
    };
  }

  const target = getCodexTargetState(state);
  const targetLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const inferredLabel = findCodexLabelByAccountId(state, accountId);
  if (targetLabel && inferredLabel && targetLabel !== inferredLabel) {
    return {
      status: "conflict",
      reason: "target_identity_mismatch",
      label: targetLabel,
      actualLabel: inferredLabel,
    };
  }
  const label = targetLabel || inferredLabel;
  if (!label) {
    return {
      status: "skipped",
      reason: "label_not_found",
      authPath: readback.authPath,
    };
  }

  const existing = getCodexCredential(state, label);
  if (!isObject(existing)) {
    return {
      status: "skipped",
      reason: "stored_credential_missing",
      label,
    };
  }
  if (typeof existing.accountId === "string" && existing.accountId.trim() && existing.accountId.trim() !== accountId) {
    return {
      status: "skipped",
      reason: "account_mismatch",
      label,
    };
  }

  const expiresAt = newestCodexTokenExpiry(idToken, access) || existing.expiresAt;
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
      detail: String(err?.message ?? err),
    };
  }

  const oldFingerprint = buildCodexCredentialFingerprint(existing);
  const newFingerprint = buildCodexCredentialFingerprint(credential);
  if (oldFingerprint === newFingerprint) {
    return {
      status: "identical",
      label,
    };
  }

  const storedExpiresAtMs = parseExpiresAtToMs(existing.expiresAt);
  const localExpiresAtMs = parseExpiresAtToMs(credential.expiresAt);
  if (!Number.isFinite(storedExpiresAtMs) || !Number.isFinite(localExpiresAtMs)) {
    return {
      status: "conflict",
      reason: "freshness_unavailable",
      label,
    };
  }
  if (localExpiresAtMs < storedExpiresAtMs) {
    const projected = applyCodexCliFromState({ label, homeDir, env }, state);
    return {
      status: "redis_newer",
      label,
      wroteAuthJson: Boolean(projected.wrote),
    };
  }
  if (localExpiresAtMs === storedExpiresAtMs) {
    return {
      status: "conflict",
      reason: "token_conflict_at_equal_expiry",
      label,
    };
  }

  state.credentials[OPENAI_CODEX_PROVIDER][label] = credential;
  const authorityPromotion = markImportedCodexLabelDirtyState(state, label, { observedAt });
  return {
    status: "local_newer",
    label,
    authorityPromotion,
  };
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
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      reasons: ["explicit_label"],
      warnings: [],
      // Blocked-selection receipts stay reason-code only: raw activation error
      // text can echo immutable account IDs and must not reach operator output.
      blockers: [
        {
          label: normalizedLabel,
          reason: classifyCodexActivationError(err),
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
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir, env }) });
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
      return { status: "noop", receipt, wrote: false };
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
    clearManagedCodexCliActivation({ state, homeDir, env });
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
    selection = pickLeastUsedCodexPoolLabel({
      labels: selectionEligibleLabels,
      usage: usageByLabel,
      avoidLabel: avoidCurrentLabel ? currentLabel : null,
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
