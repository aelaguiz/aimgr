import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import {
  CLAUDE_ROTATION_FENCE_TTL_MS,
  clearRedisClaudeRotationFence,
  createRedisClaudeRotationFence,
  isRedisClaudeRotationFenceSuccessor,
} from "../coordination/redis-claude-rotation-fence.js";
import {
  publishRedisStateCredential,
  writeRedisLocalStateFromView,
} from "../coordination/runtime.js";
import {
  assertAnthropicCredentialShape,
  buildAnthropicTokenLineageFingerprint,
} from "../credentials/anthropic.js";
import { cloneJsonObject, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, normalizeNonEmptyStringArray, readClaudeAppStateFile, readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import {
  planClaudeNativeBundleReplacement,
  syncLiveClaudeRotationBackToLabel,
  syncLiveClaudeRotationBackToLabelFromStorage,
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
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { getClaudeTargetState } from "../state/accounts.js";
import { parseTimestampLikeToMs } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";
import { buildWarningsFromClaudeTargetStatus, clearManagedClaudeCliActivation, getAnthropicCredentialMatchLabel, readClaudeCliTargetStatus } from "./claude-status.js";

const MANAGED_CLAUDE_JSON_MAX_BYTES = 256 * 1024;
const CLAUDE_LINEAGE_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLAUDE_RECOVERY_STORAGE_CONTRACT = CLAUDE_MANAGED_FILE_STORAGE_MODE;

export function readClaudeProjectionReceipt(target, label) {
  const normalizedLabel = normalizeLabel(label);
  const value = target?.projectionReceiptsByLabel?.[normalizedLabel];
  const redisCredentialVersion = Number(value?.redisCredentialVersion);
  const credentialsPath = typeof value?.credentialsPath === "string" ? value.credentialsPath.trim() : "";
  const reconciledAtMs = Date.parse(String(value?.reconciledAt ?? ""));
  if (
    !isObject(value)
    || value.label !== normalizedLabel
    || !Number.isSafeInteger(redisCredentialVersion)
    || redisCredentialVersion < 1
    || !CLAUDE_LINEAGE_FINGERPRINT_PATTERN.test(String(value.committedLineageFingerprint ?? ""))
    || !path.isAbsolute(credentialsPath)
    || !Number.isFinite(reconciledAtMs)
  ) {
    return null;
  }
  return Object.freeze({
    label: normalizedLabel,
    redisCredentialVersion,
    committedLineageFingerprint: value.committedLineageFingerprint,
    credentialsPath: path.resolve(credentialsPath),
    reconciledAt: new Date(reconciledAtMs).toISOString(),
  });
}

export function recordClaudeProjectionReceipt({
  state,
  label,
  redisCredentialVersion,
  committedLineageFingerprint,
  credentialsPath,
  reconciledAt = new Date().toISOString(),
}) {
  const normalizedLabel = normalizeLabel(label);
  const target = getClaudeTargetState(state);
  const receipt = readClaudeProjectionReceipt({
    projectionReceiptsByLabel: {
      [normalizedLabel]: {
        label: normalizedLabel,
        redisCredentialVersion,
        committedLineageFingerprint,
        credentialsPath,
        reconciledAt,
      },
    },
  }, normalizedLabel);
  if (!receipt) throw new Error("Claude projection receipt is invalid.");
  target.projectionReceiptsByLabel = isObject(target.projectionReceiptsByLabel)
    ? target.projectionReceiptsByLabel
    : {};
  target.projectionReceiptsByLabel[normalizedLabel] = receipt;
  return receipt;
}

export function clearClaudeProjectionReceipt({ state, label }) {
  const target = getClaudeTargetState(state);
  if (!isObject(target.projectionReceiptsByLabel)) return;
  delete target.projectionReceiptsByLabel[normalizeLabel(label)];
  if (Object.keys(target.projectionReceiptsByLabel).length === 0) {
    delete target.projectionReceiptsByLabel;
  }
}

export function buildClaudeRecoveryStorageId({ installationId, configDir }) {
  return `sha256:${createHash("sha256")
    .update(
      `${CLAUDE_RECOVERY_STORAGE_CONTRACT}\0${installationId}\0${path.resolve(configDir).normalize("NFC")}`,
    )
    .digest("hex")}`;
}

export function currentRedisClaudeRecord(runtime, label) {
  return (runtime?.snapshot?.credentials ?? []).find(
    (record) => record.provider === ANTHROPIC_PROVIDER && record.label === label,
  ) ?? null;
}

export function buildClaudeTokenLineageFingerprint(credential) {
  return buildAnthropicTokenLineageFingerprint(credential);
}

function requireClaudeFenceBaseline(runtime, label) {
  const record = currentRedisClaudeRecord(runtime, label);
  const fingerprint = buildClaudeTokenLineageFingerprint(record?.credential);
  if (!record || !Number.isInteger(record.version) || !fingerprint) {
    throw new Error(`Claude label=${label} has no valid Redis credential lineage for rotation fencing.`);
  }
  return { record, fingerprint };
}

export function assertUnfencedClaudeProjectionIsRecoverable({
  runtime,
  label,
  descriptor,
  reconciliation,
}) {
  const local = readManagedClaudeNativeBundleFromFiles({ descriptor });
  if (local.errorKind === "native_storage_empty") return;
  if (local.ok !== true) {
    throw new Error(
      `Claude label=${label} local credential cache is unreadable; repair or remove that exact per-label cache before retrying.`,
    );
  }
  const baseline = requireClaudeFenceBaseline(runtime, label);
  const localFingerprint = buildClaudeTokenLineageFingerprint({
    nativeClaudeBundle: local.nativeClaudeBundle,
  });
  if (!localFingerprint) {
    throw new Error(`Claude label=${label} local credential cache has no complete token lineage.`);
  }
  if (localFingerprint === baseline.fingerprint) return;

  const receipt = readClaudeProjectionReceipt(runtime.state.targets?.claudeCli, label);
  const receiptPathMatches = receipt?.credentialsPath === descriptor.credentialsPath;
  const localMatchesReceipt = receiptPathMatches
    && localFingerprint === receipt.committedLineageFingerprint;
  const receiptMatchesRedis = receiptPathMatches
    && receipt.redisCredentialVersion === baseline.record.version
    && receipt.committedLineageFingerprint === baseline.fingerprint;
  if (localMatchesReceipt && receipt.redisCredentialVersion < baseline.record.version) return;
  if (receiptMatchesRedis && reconciliation?.status === "candidate") return;

  throw new Error(
    `Claude account "${label}" could not start. `
      + "This machine's saved login differs from AIM's shared copy, and AIM cannot safely tell which one is newer. "
      + "Your local login was left unchanged. "
      + `After confirming it belongs to "${label}", run \`aim claude capture-native ${label}\` `
      + `or \`aim claude import-native ${label} --in <file>\`.`,
  );
}

export async function createClaudeRotationFenceForCurrentCredential({
  runtime,
  label,
  recoveryStorageId,
  observedAt,
}) {
  const baseline = requireClaudeFenceBaseline(runtime, label);
  const fence = await createRedisClaudeRotationFence(runtime.store, {
    label,
    recoveryStorageId,
    baseTokenLineageFingerprint: baseline.fingerprint,
    baseCredentialVersion: baseline.record.version,
    observedAt,
  });
  if (!fence) {
    throw new Error(`Claude label=${label} has an unresolved shared rotation fence.`);
  }
  return fence;
}

export async function clearClaudeRotationFenceOrThrow({ runtime, label, fence, lease }) {
  if (!fence) return;
  if (await clearRedisClaudeRotationFence(runtime.store, {
    label,
    fenceId: fence.fenceId,
    lease,
  }) !== true) {
    throw new Error(`Claude label=${label} shared rotation fence could not be cleared safely.`);
  }
}

export function assertRedisClaudeFenceSuccessor({ record, fence }) {
  if (!fence) return;
  const fingerprint = buildClaudeTokenLineageFingerprint(record?.credential);
  if (!isRedisClaudeRotationFenceSuccessor(record, {
    fence,
    tokenLineageFingerprint: fingerprint,
  })) {
    throw new Error(`Claude label=${fence.label} rotation successor is not linked to its shared fence.`);
  }
}

export function recordCommittedClaudeProjection({
  runtime,
  label,
  record,
  descriptor,
  homeDir,
  reconciledAt,
}) {
  const committedLineageFingerprint = buildClaudeTokenLineageFingerprint(record?.credential);
  if (!Number.isSafeInteger(record?.version) || !committedLineageFingerprint) {
    throw new Error(`Claude label=${label} published credential cannot produce a projection receipt.`);
  }
  const receipt = recordClaudeProjectionReceipt({
    state: runtime.state,
    label,
    redisCredentialVersion: record.version,
    committedLineageFingerprint,
    credentialsPath: descriptor.credentialsPath,
    reconciledAt,
  });
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  return receipt;
}

export async function publishClaudeRotationIfNeeded({
  runtime,
  reconciliation,
  label,
  observedAt,
  fence,
  descriptor,
  homeDir,
}) {
  if (reconciliation?.status !== "candidate") return null;
  if (reconciliation.label !== label) {
    throw new Error("Claude managed-storage rotation resolved to an unexpected account label.");
  }
  if (!fence) {
    throw new Error(`Claude label=${label} rotation publication requires a shared fence.`);
  }
  const successorFingerprint = buildClaudeTokenLineageFingerprint(
    reconciliation.candidateCredential,
  );
  if (!successorFingerprint || successorFingerprint === fence.baseTokenLineageFingerprint) {
    throw new Error(`Claude label=${label} rotation did not produce a new access/refresh token pair.`);
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
    rotationFence: fence,
  });
  runtime.state.credentials[ANTHROPIC_PROVIDER][label] = reconciliation.candidateCredential;
  if (descriptor && homeDir) {
    recordCommittedClaudeProjection({
      runtime,
      label,
      record,
      descriptor,
      homeDir,
      reconciledAt: observedAt,
    });
  }
  return record;
}

export async function recoverSharedClaudeRotationFence({
  runtime,
  label,
  fence,
  recoveryStorageId,
  descriptor,
  lease,
  assertLeaseOwned,
  homeDir,
  nowMs,
}) {
  if (!fence) return null;
  if (typeof assertLeaseOwned !== "function") {
    throw new Error("Claude rotation fence recovery requires a lease ownership assertion.");
  }
  const baseline = requireClaudeFenceBaseline(runtime, label);
  if (baseline.fingerprint !== fence.baseTokenLineageFingerprint) {
    if (!isRedisClaudeRotationFenceSuccessor(baseline.record, {
      fence,
      tokenLineageFingerprint: baseline.fingerprint,
    })) {
      throw new Error(
        `Claude label=${label} has changed Redis credentials that are not a proven successor to its shared rotation fence.`,
      );
    }
    await assertLeaseOwned("before clearing a published rotation fence");
    await clearClaudeRotationFenceOrThrow({ runtime, label, fence, lease });
    return { status: "unchanged", reason: "already_published", record: baseline.record };
  }
  // The fence's machine binding is advisory: a young foreign fence defers to
  // its owner's recovery window, and any fence past the TTL is portable.
  const foreign = fence.recoveryStorageId !== recoveryStorageId;
  const fenceAgeMs = Math.max(0, nowMs - Date.parse(fence.createdAt));
  if (foreign && fenceAgeMs < CLAUDE_ROTATION_FENCE_TTL_MS) {
    return { status: "deferred", reason: "fence_owned_elsewhere", fenceAgeMs };
  }

  const recovered = await syncLiveClaudeRotationBackToLabelFromStorage({
    state: runtime.state,
    label,
    descriptor,
    nowMs,
  });
  await assertLeaseOwned("before publishing recovered Claude rotation");
  let record = null;
  if (recovered.status === "candidate") {
    record = await publishClaudeRotationIfNeeded({
      runtime,
      reconciliation: recovered,
      label,
      observedAt: new Date(nowMs).toISOString(),
      fence,
      descriptor,
      homeDir,
    });
    assertRedisClaudeFenceSuccessor({ record, fence });
  } else if (recovered.status === "unchanged" && recovered.reason === "tokens_unchanged" && !foreign) {
    return { ...recovered, retainedFence: fence };
  } else if (recovered.status === "unchanged") {
    // No reachable successor exists locally (files empty/older than Redis) or
    // the expired foreign fence owns this machine's unchanged tokens; either
    // way the fence protects nothing reachable, so clear it and proceed.
    await assertLeaseOwned("before clearing an expired rotation fence");
    await clearClaudeRotationFenceOrThrow({ runtime, label, fence, lease });
    return { status: "unchanged", reason: recovered.reason, clearedExpiredFence: true };
  } else {
    throw new Error(
      `Claude label=${label} shared rotation fence recovery blocked: ${recovered.status}:${recovered.reason}.`,
    );
  }
  await assertLeaseOwned("before clearing a recovered rotation fence");
  await clearClaudeRotationFenceOrThrow({ runtime, label, fence, lease });
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  return { ...recovered, record };
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

  const activated = applyClaudeCliFromState({
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
