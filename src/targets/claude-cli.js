import fs from "node:fs";
import path from "node:path";
import { planClaudeCredentialProjection } from "../privacy/claude-credential-projection.js";
import { readClaudeActiveAppState } from "../privacy/claude-state-source.js";
import { withClaudeNativeStateLocks } from "../credentials/claude-native-state-lock.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { publishRedisStateCredential } from "../coordination/runtime.js";
import {
  assertAnthropicCredentialShape,
  buildAnthropicTokenLineageFingerprint,
} from "../credentials/anthropic.js";
import { buildClaudeNativeBundle, cloneJsonObject, deriveAnthropicCredentialFromClaudeBundle, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, normalizeNonEmptyStringArray, readClaudeAppStateFile, readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import {
  planClaudeNativeBundleReplacement,
  syncClaudeNativeBundleBackToLabel,
} from "../credentials/claude-native.js";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  ensureSafeManagedClaudeStorage,
  readManagedClaudeNativeBundleFromFiles,
} from "../credentials/claude-native-storage.js";
import { writeJsonFileIfChanged, writeTextFileIfChanged } from "../io/json-store.js";
import { resolveClaudeAppStatePath, resolveClaudeAuthFilePath, resolveManagedClaudeDir } from "../io/paths.js";
import { appendAnthropicHistory, buildAnthropicExhaustionHistoryEntries, recordAnthropicBlockedSelectionHistory } from "../pool/history.js";
import { collectAnthropicPoolStatus, getAnthropicPoolLabels, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { assertNoClaudeRouteErrors, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { getClaudeTargetState } from "../state/accounts.js";
import { parseTimestampLikeToMs } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { buildWarningsFromClaudeTargetStatus, clearManagedClaudeCliActivation, getAnthropicCredentialMatchLabel, readClaudeCliTargetStatus } from "./claude-status.js";

const MANAGED_CLAUDE_JSON_MAX_BYTES = 256 * 1024;
export function currentRedisClaudeRecord(runtime, label) {
  return (runtime?.snapshot?.credentials ?? []).find(
    (record) => record.provider === ANTHROPIC_PROVIDER && record.label === label,
  ) ?? null;
}

export function buildClaudeTokenLineageFingerprint(credential) {
  return buildAnthropicTokenLineageFingerprint(credential);
}

export async function publishClaudeRotationIfNeeded({
  runtime,
  reconciliation,
  label,
  observedAt,
}) {
  if (reconciliation?.status !== "candidate") return null;
  if (reconciliation.label !== label) {
    throw new Error("Claude managed-storage rotation resolved to an unexpected account label.");
  }
  const candidateState = {
    ...runtime.state,
    credentials: {
      ...runtime.state.credentials,
      [ANTHROPIC_PROVIDER]: {
        ...runtime.state.credentials[ANTHROPIC_PROVIDER],
        [label]: reconciliation.candidateCredential,
      },
    },
  };
  const record = await publishRedisStateCredential({
    runtime,
    state: candidateState,
    provider: ANTHROPIC_PROVIDER,
    label,
    observedAt,
    lineageMode: "native-claude-rotation",
  });
  runtime.state.credentials[ANTHROPIC_PROVIDER][label] = reconciliation.candidateCredential;
  return record;
}

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

function buildClaudeAppStatePayload({ current, credential }) {
  const bundle = getClaudeNativeBundle(credential);
  const oauthAccount = cloneJsonObject(bundle?.oauthAccount);
  if (!oauthAccount) {
    throw new Error("Refusing to write Claude app state without a native Claude oauthAccount bundle.");
  }
  return {
    ...(current.ok === true && isObject(current.json) ? current.json : {}),
    oauthAccount,
    hasCompletedOnboarding: true,
    hasAvailableSubscription: true,
  };
}

function snapshotProjectionFile(filePath, { fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, filePath };
    throw new Error("Could not inspect Claude projection target.");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || !Number.isFinite(stat.size)
    || stat.size < 0
    || stat.size > MANAGED_CLAUDE_JSON_MAX_BYTES
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
  ) {
    throw new Error("Refusing to overwrite an unsafe Claude projection target.");
  }
  fsImpl.chmodSync(filePath, 0o600);
  return {
    exists: true,
    filePath,
    text: fsImpl.readFileSync(filePath, "utf8"),
    mode: 0o600,
  };
}

function restoreProjectionSnapshot(snapshot, {
  fsImpl = fs,
  writeTextFileIfChangedImpl = writeTextFileIfChanged,
} = {}) {
  if (!snapshot.exists) {
    fsImpl.rmSync(snapshot.filePath, { force: true });
    return;
  }
  writeTextFileIfChangedImpl(snapshot.filePath, snapshot.text, { mode: snapshot.mode || 0o600 });
}

export async function writeClaudeNativeProjectionPair(options = {}) {
  const configDir = options.claudeDir ?? resolveManagedClaudeDir({ homeDir: options.homeDir });
  const appStatePath = resolveClaudeAppStatePath({ homeDir: options.homeDir });
  return withClaudeNativeStateLocks({ configDir, appStatePath, fsImpl: options.fsImpl ?? fs },
    () => writeClaudeNativeProjectionPairLocked(options));
}

function writeClaudeNativeProjectionPairLocked({
  homeDir,
  claudeDir = resolveManagedClaudeDir({ homeDir }),
  credential,
  fsImpl = fs,
  writeJsonFileIfChangedImpl = writeJsonFileIfChanged,
  writeTextFileIfChangedImpl = writeTextFileIfChanged,
  verifyImpl = null,
} = {}) {
  const credentialsPath = resolveClaudeAuthFilePath(claudeDir);
  const appStatePath = resolveClaudeAppStatePath({ homeDir });
  const credentialsSnapshot = snapshotProjectionFile(credentialsPath, { fsImpl });
  const appStateSnapshot = snapshotProjectionFile(appStatePath, { fsImpl });
  const activeState = readClaudeActiveAppState({ configDir: claudeDir, canonicalFile: appStatePath,
    fsImpl, allowMalformed: true });
  const legacySnapshot = activeState.legacy ? snapshotProjectionFile(activeState.file, { fsImpl }) : null;
  const projectedOauth = buildClaudeAuthDotJson({ credential }).claudeAiOauth;
  let currentCredentials = {};
  try {
    if (credentialsSnapshot.exists) currentCredentials = JSON.parse(credentialsSnapshot.text);
  } catch {
    throw new Error("Claude credential projection refused unreadable native secrets; preserve the file for repair.");
  }
  if (activeState.malformed && currentCredentials?.claudeAiOauth?.accessToken === ""
    && currentCredentials?.claudeAiOauth?.refreshToken === "") {
    // Preserve the existing ordinary-account repair of a corrupt disposable
    // cache with native's exact empty-token tombstone. It carries no lineage
    // to attribute. Other provider secrets still require a verified owner;
    // MCP/package secrets retain their independent ownership. Protected entry
    // points perform strict stopped-owner identity admission before reaching
    // this projection, so corruption there never discards unknown task state.
    currentCredentials = { ...currentCredentials };
    delete currentCredentials.claudeAiOauth;
  }
  // T04/T14: the native document also holds required MCP/package secrets.
  // Replacing it with the portable OAuth bundle loses those workflows at each
  // refresh/reprojection. Classify before either write; the portable verified
  // OAuth remains authoritative, while independent native secrets stay local.
  const authPayload = planClaudeCredentialProjection({ current: currentCredentials,
    currentAccountUuid: activeState.state.oauthAccount?.accountUuid ?? null,
    targetAccountUuid: getClaudeNativeBundle(credential)?.oauthAccount?.accountUuid,
    projectedOauth });
  const appStatePayload = buildClaudeAppStatePayload({ current: { ok: activeState.exists, json: activeState.state }, credential });
  const rollback = () => {
    restoreProjectionSnapshot(credentialsSnapshot, { fsImpl, writeTextFileIfChangedImpl });
    restoreProjectionSnapshot(appStateSnapshot, { fsImpl, writeTextFileIfChangedImpl });
    if (legacySnapshot) restoreProjectionSnapshot(legacySnapshot, { fsImpl, writeTextFileIfChangedImpl });
  };

  let appStateWrite = { wrote: false, path: appStatePath };
  let credentialsWrite = { wrote: false, path: credentialsPath };
  try {
    // Identity is preflighted before either write. If the second atomic rename
    // fails, restore the first file before surfacing the failure.
    appStateWrite = writeJsonFileIfChangedImpl(appStatePath, appStatePayload, { mode: 0o600 });
    // Ordinary accounts keep their existing legacy selector. Publish the same
    // verified identity there too, preserving the actual native-active task
    // state. Protected identity migration retires this selector separately,
    // under stopped-owner EX coordination with a durable journal.
    if (legacySnapshot) writeJsonFileIfChangedImpl(activeState.file, appStatePayload, { mode: 0o600 });
    credentialsWrite = writeJsonFileIfChangedImpl(credentialsPath, authPayload, { mode: 0o600 });
    const verification = typeof verifyImpl === "function" ? verifyImpl() : null;
    return {
      credentialsPath,
      appStatePath,
      credentialsWrite,
      appStateWrite,
      verification,
    };
  } catch (error) {
    try {
      rollback();
    } catch {
      throw new Error("Claude native projection failed and could not be rolled back safely.");
    }
    throw error;
  }
}

export async function projectClaudeNativeBundleToManagedConfig(options = {}) {
  // Freshness is checked AFTER taking the same locks native refresh/MCP writes
  // use. Checking first would allow an older Redis token to win the wait.
  ensureSafeManagedClaudeStorage({ descriptor: options.descriptor, fsImpl: options.fsImpl ?? fs });
  return withClaudeNativeStateLocks({ configDir: options.descriptor.configDir,
    appStatePath: options.descriptor.appStatePath, fsImpl: options.fsImpl ?? fs },
  () => projectClaudeNativeBundleToManagedConfigLocked(options));
}

function projectClaudeNativeBundleToManagedConfigLocked({
  descriptor,
  credential,
  nowMs = Date.now(),
  preserveNewerLocal = false,
  fsImpl = fs,
  writeJsonFileIfChangedImpl = writeJsonFileIfChanged,
  writeTextFileIfChangedImpl = writeTextFileIfChanged,
} = {}) {
  if (
    !descriptor
    || !path.isAbsolute(String(descriptor.configDir ?? ""))
    || descriptor.appStatePath !== path.join(descriptor.configDir, ".claude.json")
    || descriptor.storageMode !== CLAUDE_MANAGED_FILE_STORAGE_MODE
  ) {
    throw new Error("Managed Claude projection requires an exact file-only config descriptor.");
  }
  ensureSafeManagedClaudeStorage({ descriptor, fsImpl });
  const candidatePlan = planClaudeNativeBundleReplacement({
    currentBundle: null,
    candidateBundle: credential,
    expectedEmail: descriptor.expectedEmail,
    nowMs,
    allowExpiredCandidate: true,
  });
  if (candidatePlan.ok !== true) {
    throw new Error(`Managed Claude projection blocked: ${candidatePlan.reason}.`);
  }
  if (preserveNewerLocal) {
    // Other sessions on this machine may be using the local login. Replace it
    // only when Redis is strictly newer: an equal or older write could put a
    // refresh token a sibling already spent back into the shared file.
    const local = readManagedClaudeNativeBundleFromFiles({ descriptor, fsImpl });
    if (local.ok === true) {
      const localPlan = planClaudeNativeBundleReplacement({
        currentBundle: local.nativeClaudeBundle,
        candidateBundle: credential,
        expectedEmail: descriptor.expectedEmail,
        nowMs,
        allowExpiredCandidate: true,
      });
      if (localPlan.action === "noop" || localPlan.reason === "stale_candidate") {
        return {
          ok: true,
          action: "kept_local",
          storageMode: CLAUDE_MANAGED_FILE_STORAGE_MODE,
          wrote: { credentials: false, appState: false },
        };
      }
      if (localPlan.ok !== true && localPlan.reason !== "identity_conflict") {
        throw new Error(`Managed Claude projection blocked: ${localPlan.reason}; preserve native credentials for repair.`);
      }
    } else {
      const active = readClaudeActiveAppState({ configDir: descriptor.configDir,
        canonicalFile: descriptor.appStatePath, fsImpl, allowMalformed: true });
      const snapshot = snapshotProjectionFile(descriptor.credentialsPath, { fsImpl });
      let current;
      try { current = snapshot.exists ? JSON.parse(snapshot.text) : {}; }
      catch { throw new Error("Managed Claude projection refused unreadable native secrets; preserve them for repair."); }
      const owner = active.state.oauthAccount?.accountUuid;
      const target = getClaudeNativeBundle(credential)?.oauthAccount?.accountUuid;
      if ((!owner || owner === target)
        && [current?.claudeAiOauth?.accessToken, current?.claudeAiOauth?.refreshToken]
          .some(value => typeof value === "string" && value.length > 0)) {
        throw new Error("Managed Claude projection refused an incomplete native token lineage; preserve it for repair.");
      }
    }
  }

  const projection = writeClaudeNativeProjectionPairLocked({
    homeDir: descriptor.configDir,
    claudeDir: descriptor.configDir,
    credential,
    fsImpl,
    writeJsonFileIfChangedImpl,
    writeTextFileIfChangedImpl,
    verifyImpl: () => {
      const verified = readManagedClaudeNativeBundleFromFiles({ descriptor, fsImpl });
      if (verified.ok !== true) {
        throw new Error("Managed Claude projection readback failed.");
      }
      const verificationPlan = planClaudeNativeBundleReplacement({
        currentBundle: credential,
        candidateBundle: verified.nativeClaudeBundle,
        expectedEmail: descriptor.expectedEmail,
        nowMs,
        allowExpiredCandidate: true,
      });
      if (verificationPlan.ok !== true || verificationPlan.action !== "noop") {
        throw new Error("Managed Claude projection readback mismatch.");
      }
      return {
        ok: true,
        source: "file",
      };
    },
  });
  return {
    ok: true,
    action: "projected",
    storageMode: CLAUDE_MANAGED_FILE_STORAGE_MODE,
    wrote: {
      credentials: projection.credentialsWrite.wrote,
      appState: projection.appStateWrite.wrote,
    },
  };
}

// `.claude.json` is a mixed Claude app-state file. AIM owns only the
// `oauthAccount` key there and must preserve unrelated settings exactly.

export function writeClaudeAppStateOauthAccount({ homeDir, credential }) {
  const current = readClaudeAppStateFile({ homeDir });
  if (current.exists === true && current.ok !== true) {
    throw new Error(`Refusing to mutate unreadable Claude app state file: ${current.error || current.appStatePath}`);
  }
  const next = buildClaudeAppStatePayload({ current, credential });
  return writeJsonFileIfChanged(resolveClaudeAppStatePath({ homeDir }), next, { mode: 0o600 });
}

export async function applyClaudeCliFromState({ label, homeDir }, state) {
  // Legacy local selection can wait behind native refresh just like managed
  // projection. Reconcile and choose its credential only after that writer
  // finishes; taking locks solely around the later write would restore an
  // already-spent refresh token selected before the wait.
  return withClaudeNativeStateLocks({ configDir: resolveManagedClaudeDir({ homeDir }),
    appStatePath: resolveClaudeAppStatePath({ homeDir }) },
  () => applyClaudeCliFromStateLocked({ label, homeDir }, state));
}

function applyClaudeCliFromStateLocked({ label, homeDir }, state) {
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

  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const active = readClaudeActiveAppState({ configDir: claudeDir,
    canonicalFile: resolveClaudeAppStatePath({ homeDir }), allowMalformed: true });
  const auth = snapshotProjectionFile(resolveClaudeAuthFilePath(claudeDir));
  let native;
  try { native = auth.exists ? JSON.parse(auth.text) : {}; }
  catch { throw new Error("Claude selection refused unreadable native credentials; preserve them for repair."); }
  const liveBundle = buildClaudeNativeBundle({ claudeAiOauth: native.claudeAiOauth,
    oauthAccount: active.state.oauthAccount });
  const preSwitchSync = syncClaudeNativeBundleBackToLabel({ state, nativeClaudeBundle: liveBundle,
    source: "file", credentialsPath: auth.filePath });
  let selected = getAnthropicCredential(state, normalizedLabel);
  const targetId = getClaudeNativeBundle(selected)?.oauthAccount?.accountUuid;
  const owner = active.state.oauthAccount?.accountUuid;
  if (!owner || owner === targetId) {
    if (hasCompleteClaudeNativeBundle(liveBundle)) {
      const replacement = planClaudeNativeBundleReplacement({ currentBundle: liveBundle,
        candidateBundle: selected, allowExpiredCandidate: true });
      if (replacement.action === "noop" || replacement.reason === "stale_candidate") {
        selected = deriveAnthropicCredentialFromClaudeBundle({ existingCredential: selected,
          nativeClaudeBundle: liveBundle });
      } else if (replacement.ok !== true) {
        throw new Error(`Claude selection refused ${replacement.reason}; preserve native credentials for repair.`);
      }
    } else if ([native?.claudeAiOauth?.accessToken, native?.claudeAiOauth?.refreshToken]
      .some(value => typeof value === "string" && value.length > 0)) {
      throw new Error("Claude selection refused an incomplete native token lineage; preserve it for repair.");
    }
  }
  // Reconciliation is a pure planner. Consume its result after successful
  // publication below; merely calling it does not preserve a rotated token.
  const credential = assertAnthropicCredentialShape({
    label: normalizedLabel,
    credential: selected,
    requireFresh: true,
    requireClaudeNativeBundle: true,
  });

  const projection = writeClaudeNativeProjectionPairLocked({
    homeDir,
    claudeDir,
    credential,
    verifyImpl: () => {
      const verified = readClaudeNativeBundle({ homeDir });
      if (verified.ok !== true) {
        throw new Error("Failed to read back managed Claude auth bundle after apply.");
      }
      if (!hasCompleteClaudeNativeBundle(verified.nativeClaudeBundle) || !verified.summary) {
        throw new Error("Claude readback is missing native auth bundle fields after apply.");
      }
      const replacement = planClaudeNativeBundleReplacement({
        currentBundle: credential,
        candidateBundle: verified.nativeClaudeBundle,
      });
      if (replacement.ok !== true || replacement.action !== "noop") {
        throw new Error("Claude readback identity or token mismatch after apply.");
      }
      return verified;
    },
  });
  const readback = projection.verification;
  const inferredLabel = getAnthropicCredentialMatchLabel(state, {
    accessToken: readback.summary.access,
    refreshToken: readback.summary.refresh,
  });
  if (inferredLabel && inferredLabel !== normalizedLabel) {
    throw new Error(`Claude readback mismatch after apply: expected label=${normalizedLabel}, got ${inferredLabel}.`);
  }

  if (preSwitchSync.status === "candidate") {
    state.credentials[ANTHROPIC_PROVIDER][preSwitchSync.label] = structuredClone(preSwitchSync.candidateCredential);
  }
  state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = structuredClone(credential);
  const target = getClaudeTargetState(state);
  delete target.claudeDir;
  delete target.authPath;
  delete target.expectedSubscriptionType;
  delete target.credentialsPath;
  delete target.appStatePath;
  target.lastRunLabel = normalizedLabel;
  target.lastAppliedAt = new Date().toISOString();

  return {
    label: normalizedLabel,
    subscriptionType: credential.subscriptionType,
    claudeDir,
    credentialsPath: readback.credentialsPath,
    appStatePath: readback.appStatePath,
    wrote: {
      credentials: projection.credentialsWrite.wrote,
      appState: projection.appStateWrite.wrote,
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
  assertNoClaudeRouteErrors(usageByLabel);
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
      previousLabel: currentTarget.lastRunLabel ?? currentTarget.inferredLabel ?? undefined,
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
    currentLabel: currentTarget.lastRunLabel,
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

  const activated = await applyClaudeCliFromState({
    label: selection.label,
    homeDir,
  }, state);
  const postStatus = readClaudeCliTargetStatus({ state, homeDir, env });
  const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
  const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
  const status =
    !wroteAny
    && currentTarget.lastRunLabel === selection.label
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "claude_use",
    status,
    observedAt,
    previousLabel: currentTarget.lastRunLabel ?? undefined,
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

export async function activateClaudeLabelSelection({ state, homeDir, env = {}, label }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();
  const target = getClaudeTargetState(state);
  const currentTarget = readClaudeCliTargetStatus({ state, homeDir, env });

  try {
    const activated = await applyClaudeCliFromState({
      label: normalizedLabel,
      homeDir,
    }, state);
    const postStatus = readClaudeCliTargetStatus({ state, homeDir, env });
    const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
    const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
    const status =
      !wroteAny && currentTarget.lastRunLabel === normalizedLabel
        ? "noop"
        : warnings.length > 0
          ? "activated_with_warnings"
          : "activated";
    const receipt = {
      action: "claude_use",
      status,
      observedAt,
      previousLabel: currentTarget.lastRunLabel ?? undefined,
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
      previousLabel: currentTarget.lastRunLabel ?? currentTarget.inferredLabel ?? undefined,
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
