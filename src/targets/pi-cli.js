import fs from "node:fs";
import { getCodexCredential } from "../browser/seed.js";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { assertCodexCredentialShape, findCodexLabelByAccountId } from "../credentials/codex.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveManagedPiAgentDir, resolvePiAuthFilePath } from "../io/paths.js";
import { appendOpenaiCodexHistory, collectCodexPoolStatusWithExhaustionHistory, recordOpenaiCodexBlockedSelectionHistory } from "../pool/history.js";
import { getCodexPoolLabels, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverStatusConfiguredOpenclawCodexAgents, getImportedCodexLabels, getOpenclawAssignments, getOpenclawTargetState, getPiTargetState, hasImportedCodexReplica } from "../state/accounts.js";
import { getAuthorityCodexImport } from "../state/authority-codex.js";
import { ensureStateShape } from "../state/schema.js";

export function readPiAuthFile({ agentDir }) {
  const authPath = resolvePiAuthFilePath(agentDir);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Pi auth.json is not a JSON object.");
    }
    const providerEntry = isObject(parsed?.[OPENAI_CODEX_PROVIDER]) ? parsed[OPENAI_CODEX_PROVIDER] : null;
    const accountId = typeof providerEntry?.accountId === "string" ? providerEntry.accountId.trim() : null;
    const providerEntryType = typeof providerEntry?.type === "string" ? providerEntry.type.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath,
      accountId: accountId || null,
      providerEntryPresent: Boolean(providerEntry),
      providerEntryType: providerEntryType || null,
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath,
      error: String(err?.message ?? err),
    };
  }
}

export function clearManagedPiCliActivation({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const agentDir = resolveManagedPiAgentDir({ homeDir, env });
  const authPath = resolvePiAuthFilePath(agentDir);
  if (fs.existsSync(authPath)) {
    const current = readPiAuthFile({ agentDir });
    if (current.ok !== true) {
      throw new Error(`Refusing to mutate unreadable Pi auth file: ${current.error || authPath}`);
    }
    if (isObject(current.json) && Object.hasOwn(current.json, OPENAI_CODEX_PROVIDER)) {
      const next = { ...current.json };
      delete next[OPENAI_CODEX_PROVIDER];
      writeJsonFileIfChanged(authPath, next, { mode: 0o600 });
    }
  }

  const target = getPiTargetState(state);
  delete target.agentDir;
  delete target.authPath;
  delete target.activeLabel;
  delete target.expectedAccountId;
  delete target.lastAppliedAt;
}

export function buildPiAuthEntry({ credential }) {
  const expiresMs = parseExpiresAtToMs(credential?.expiresAt);
  if (!expiresMs) {
    throw new Error("Refusing to build Pi auth.json without a valid expiresAt timestamp.");
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: expiresMs,
    accountId: credential.accountId,
  };
}

export function readPiCliTargetStatus({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const importMeta = getAuthorityCodexImport(state);
  const target = getPiTargetState(state);
  const agentDir = resolveManagedPiAgentDir({ homeDir, env });
  const readback = readPiAuthFile({ agentDir });
  const activeLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const expectedAccountId = typeof target.expectedAccountId === "string" ? target.expectedAccountId.trim() : "";
  const actualAccountId = readback.ok ? readback.accountId : null;
  const inferredLabel = actualAccountId ? findCodexLabelByAccountId(state, actualAccountId) : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedCodexLabels(state),
    agentDir,
    authPath: resolvePiAuthFilePath(agentDir),
    activeLabel: activeLabel || null,
    activeAccountPresent: activeLabel ? isObject(state.accounts[activeLabel]) : false,
    activeCredentialPresent: activeLabel ? isObject(getCodexCredential(state, activeLabel)) : false,
    expectedAccountId: expectedAccountId || null,
    actualAccountId: actualAccountId || null,
    inferredLabel: inferredLabel || null,
    readback,
    lastSelectionReceipt: isObject(target.lastSelectionReceipt) ? target.lastSelectionReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
  };
}

export function buildWarningsFromPiTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (!status.importedLabels?.length && status.activeLabel) {
    warnings.push({
      kind: "pi_import_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "pi_target_label_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "pi_target_credentials_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.readback.exists) {
    warnings.push({
      kind: "pi_target_missing_auth_file",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "pi_target_auth_unreadable",
      system: "pi-cli",
      status: status.readback.error,
    });
  }

  if (status.activeLabel && status.readback.ok === true && !status.readback.providerEntryPresent) {
    warnings.push({
      kind: "pi_target_missing_provider_entry",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (
    status.activeLabel
    && status.readback.ok === true
    && status.readback.providerEntryPresent
    && status.readback.providerEntryType
    && status.readback.providerEntryType !== "oauth"
  ) {
    warnings.push({
      kind: "pi_target_provider_entry_invalid",
      system: "pi-cli",
      label: status.activeLabel,
      status: status.readback.providerEntryType,
    });
  }

  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    warnings.push({
      kind: "pi_target_account_mismatch",
      system: "pi-cli",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }

  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    warnings.push({
      kind: "pi_target_label_mismatch",
      system: "pi-cli",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return warnings;
}

export function applyPiCliFromState({ label, homeDir, env = {} }, state) {
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
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"} for Pi.`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const agentDir = resolveManagedPiAgentDir({ homeDir, env });
  const existing = readPiAuthFile({ agentDir });
  if (existing.exists && existing.ok !== true) {
    throw new Error(`Failed to read current Pi auth file before apply: ${existing.error || "unknown error"}`);
  }
  const authPayload = {
    ...(existing.ok === true && isObject(existing.json) ? existing.json : {}),
    [OPENAI_CODEX_PROVIDER]: buildPiAuthEntry({ credential }),
  };
  const writeResult = writeJsonFileIfChanged(resolvePiAuthFilePath(agentDir), authPayload, { mode: 0o600 });
  const readback = readPiAuthFile({ agentDir });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back managed Pi auth file: ${readback.error || "unknown error"}`);
  }
  if (readback.accountId !== credential.accountId) {
    throw new Error(
      `Pi readback mismatch after apply: expected accountId=${credential.accountId}, got ${readback.accountId || "none"}.`,
    );
  }

  const target = getPiTargetState(state);
  target.agentDir = agentDir;
  target.authPath = readback.authPath;
  target.activeLabel = normalizedLabel;
  target.expectedAccountId = credential.accountId;
  target.lastAppliedAt = new Date().toISOString();

  return {
    label: normalizedLabel,
    accountId: credential.accountId,
    agentDir,
    authPath: readback.authPath,
    wrote: writeResult.wrote,
  };
}

export async function activatePiPoolSelection({
  state,
  homeDir,
  env = {},
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
}) {
  ensureStateShape(state);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env });
  const usageByLabel = usageByProvider[OPENAI_CODEX_PROVIDER];
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

  const target = getPiTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readPiCliTargetStatus({ state, homeDir, env });
    clearManagedPiCliActivation({ state, homeDir, env });
    const receipt = {
      action: "pi_use",
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

  const currentTarget = readPiCliTargetStatus({ state, homeDir, env });
  const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
  const currentAssignments = getOpenclawAssignments(state);
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel: currentTarget.activeLabel,
    currentAssignments,
    configuredAgents: configuredCodexAgents,
    agentDemand: state.pool.openaiCodex.agentDemand,
    lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
    now: Date.parse(observedAt),
  });
  const selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  if (!selection) {
    throw new Error("Failed to select a next-best Pi pool label.");
  }

  const activated = applyPiCliFromState({ label: selection.label, homeDir, env }, state);
  const postStatus = readPiCliTargetStatus({ state, homeDir, env });
  const warnings = buildWarningsFromPiTargetStatus(postStatus);
  const status =
    !activated.wrote && currentTarget.activeLabel === selection.label && currentTarget.expectedAccountId === activated.accountId
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "pi_use",
    status,
    observedAt,
    previousLabel: currentTarget.activeLabel ?? undefined,
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
