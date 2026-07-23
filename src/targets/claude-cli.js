import fs from "node:fs";
import path from "node:path";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { assertAnthropicCredentialShape } from "../credentials/anthropic.js";
import { cloneJsonObject, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, normalizeNonEmptyStringArray, readClaudeAppStateFile, readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { planClaudeNativeBundleReplacement, syncLiveClaudeRotationBackToLabel } from "../credentials/claude-native.js";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  ensureSafeManagedClaudeStorage,
  readManagedClaudeNativeBundleFromFiles,
} from "../credentials/claude-native-storage.js";
import { writeJsonFileIfChanged, writeTextFileIfChanged } from "../io/json-store.js";
import { resolveClaudeAppStatePath, resolveClaudeAuthFilePath, resolveManagedClaudeDir } from "../io/paths.js";
import { appendAnthropicHistory, buildAnthropicExhaustionHistoryEntries, recordAnthropicBlockedSelectionHistory } from "../pool/history.js";
import { collectAnthropicPoolStatus, getAnthropicPoolLabels, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { getClaudeTargetState } from "../state/accounts.js";
import { parseTimestampLikeToMs } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { buildWarningsFromClaudeTargetStatus, clearManagedClaudeCliActivation, getAnthropicCredentialMatchLabel, readClaudeCliTargetStatus } from "./claude-status.js";

const MANAGED_CLAUDE_JSON_MAX_BYTES = 256 * 1024;

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

export function writeClaudeNativeProjectionPair({
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
  const currentAppState = readClaudeAppStateFile({ homeDir });
  if (currentAppState.exists === true && currentAppState.ok !== true) {
    throw new Error("Refusing to mutate unreadable Claude app state file.");
  }
  const authPayload = buildClaudeAuthDotJson({ credential });
  const appStatePayload = buildClaudeAppStatePayload({ current: currentAppState, credential });
  const rollback = () => {
    restoreProjectionSnapshot(credentialsSnapshot, { fsImpl, writeTextFileIfChangedImpl });
    restoreProjectionSnapshot(appStateSnapshot, { fsImpl, writeTextFileIfChangedImpl });
  };

  let appStateWrite = { wrote: false, path: appStatePath };
  let credentialsWrite = { wrote: false, path: credentialsPath };
  try {
    // Identity is preflighted before either write. If the second atomic rename
    // fails, restore the first file before surfacing the failure.
    appStateWrite = writeJsonFileIfChangedImpl(appStatePath, appStatePayload, { mode: 0o600 });
    credentialsWrite = writeJsonFileIfChangedImpl(credentialsPath, authPayload, { mode: 0o600 });
    const verification = typeof verifyImpl === "function" ? verifyImpl() : null;
    return {
      credentialsPath,
      appStatePath,
      credentialsWrite,
      appStateWrite,
      verification,
      rollback,
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

export async function projectClaudeNativeBundleToManagedConfig({
  descriptor,
  credential,
  nowMs = Date.now(),
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

  const current = readManagedClaudeNativeBundleFromFiles({
    descriptor,
    fsImpl,
  });
  if (current.ok === true) {
    const replacement = planClaudeNativeBundleReplacement({
      currentBundle: current.nativeClaudeBundle,
      candidateBundle: credential,
      expectedEmail: descriptor.expectedEmail,
      nowMs,
      allowExpiredCandidate: true,
    });
    if (replacement.ok !== true) {
      throw new Error(`Managed Claude projection blocked: ${replacement.reason}.`);
    }
  } else if (current.errorKind !== "native_storage_empty") {
    throw new Error(`Managed Claude projection blocked: ${current.errorKind || "native_storage_unavailable"}.`);
  }

  const projection = writeClaudeNativeProjectionPair({
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
    action: current.ok === true ? "projected_existing" : "projected_new",
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
  const projection = writeClaudeNativeProjectionPair({
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
