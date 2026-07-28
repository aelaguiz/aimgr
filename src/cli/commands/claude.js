import { createHash } from "node:crypto";
import path from "node:path";
import {
  CLAUDE_FABLE_RUN_PRESET_ARGS,
  CLAUDE_OPUS_RUN_PRESET_ARGS,
} from "../args.js";
import { AIMGR_REDIS_PRIMARY_HOST, AIMGR_REDIS_PRIMARY_URL, ANTHROPIC_PROVIDER } from "../../core/constants.js";
import {
  DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS,
  acquireRedisCredentialLease,
  renewOrReacquireRedisCredentialLease,
} from "../../coordination/redis-credential-lease.js";
import {
  clearRedisClaudeRotationFence,
  createRedisClaudeRotationFence,
  isRedisClaudeRotationFenceSuccessor,
  readRedisClaudeRotationFence,
} from "../../coordination/redis-claude-rotation-fence.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
  publishRedisCredentialPolicyFromState,
  publishRedisStateCredential,
  refreshRedisRuntimeState,
  writeRedisLocalStateFromView,
} from "../../coordination/runtime.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
import { isObject, normalizeLabel } from "../../core/normalize.js";
import { recordAccountMaintenanceAttempt, recordAccountMaintenanceFailure, recordAccountMaintenanceSuccess } from "../../credentials/anthropic-maintenance.js";
import {
  assertNoAnthropicSnapshotIdentityConflict,
  captureAnthropicNativeBundleForLabel,
  exportLiveClaudeNativeBundle,
  importAnthropicNativeBundleForLabel,
  persistAnthropicNativeBundleForLabel,
  readClaudeNativeBundleExportFile,
  resolveAnthropicMaintenanceBlockedReason,
  syncLiveClaudeRotationBackToLabelFromStorage,
} from "../../credentials/claude-native.js";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  buildClaudeNativeStorageDescriptor,
  buildManagedClaudeNativeStorageDescriptor,
  captureClaudeNativeBundleFromKeychain,
  ensureSafeManagedClaudeStorage,
  retireManagedClaudeCredentialProjection,
} from "../../credentials/claude-native-storage.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveAimgrStateDir,
  resolveCliPath,
  resolveManagedClaudeDir,
  resolveOptionalSourceHome,
} from "../../io/paths.js";
import { markImportedAnthropicLabelDirtyState } from "../../state/authority-anthropic.js";
import { ensureLocalInstallationId } from "../../state/local-state.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { parseExpiresAtToMs } from "../../core/time.js";
import { hasCompleteClaudeNativeBundle } from "../../credentials/claude-bundle.js";
import {
  activateClaudeLabelSelection,
  activateClaudePoolSelection,
  projectClaudeNativeBundleToManagedConfig,
} from "../../targets/claude-cli.js";
import { prepareClaudeCliLaunch, runClaudeCli } from "../../targets/claude-runner.js";
import {
  buildManagedClaudeSessionForkName,
  listRecentManagedClaudeSessions,
  renderRecentManagedClaudeSessions,
  resolveManagedClaudeSession,
  stageManagedClaudeSessionFork,
} from "../../targets/claude-sessions.js";
import {
  collectClaudeRedisAccountInventory,
  collectClaudeRedisAccountUsageStatus,
  renderClaudeRedisAccountInventory,
  renderClaudeRedisAccountUsageStatus,
  selectLeastUsedUnlockedClaudeAccount,
} from "../../status/claude-redis-view.js";

const CLAUDE_LEASE_RENEW_INTERVAL_MS = Math.floor(DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS / 3);
const CLAUDE_LEASE_RENEW_DEADLINE_MS = 5_000;
const CLAUDE_ACTIVE_ROTATION_SYNC_INTERVAL_MS = 30_000;
const SAFE_PRE_RUN_STORAGE_REASONS = new Set(["native_storage_empty", "tokens_unchanged", "stale_candidate"]);
const CLAUDE_RECOVERY_STORAGE_CONTRACT = CLAUDE_MANAGED_FILE_STORAGE_MODE;
const CLAUDE_MAINTENANCE_TIMEOUT_MS = 30_000;
const CLAUDE_MAINTENANCE_DUE_WINDOW_MS = 5 * 60_000;
const CLAUDE_MAINTENANCE_SKIPPED = Symbol("claude-maintenance-skipped");
const CLAUDE_LEASE_RENEWED = "renewed";
const CLAUDE_LEASE_CONTENDED = "contended";
const CLAUDE_LEASE_UNREACHABLE = "unreachable";
const CLAUDE_MAINTENANCE_ARGS = Object.freeze([
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--print",
  "--output-format",
  "json",
  "/usage",
]);

async function renewClaudeCredentialLeaseWithinDeadline(lease) {
  let deadlineTimer = null;
  try {
    const renewal = Promise.resolve()
      .then(() => renewOrReacquireRedisCredentialLease(lease))
      .then(
        (renewed) => renewed === true ? CLAUDE_LEASE_RENEWED : CLAUDE_LEASE_CONTENDED,
        () => CLAUDE_LEASE_UNREACHABLE,
      );
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve(CLAUDE_LEASE_UNREACHABLE),
        CLAUDE_LEASE_RENEW_DEADLINE_MS,
      );
      deadlineTimer.unref?.();
    });
    return await Promise.race([renewal, deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function startClaudeCredentialLeaseHeartbeat({
  lease,
  abortController,
  pauseForUncertainOwnership = null,
  resumeAfterOwnershipRecovered = null,
}) {
  let stopped = false;
  let timer = null;
  let inFlight = null;
  let lost = false;
  let paused = false;

  const loseOwnership = () => {
    lost = true;
    abortController.abort();
  };
  const applyRenewalResult = async (result) => {
    if (stopped) return result;
    if (result === CLAUDE_LEASE_CONTENDED) {
      loseOwnership();
      return result;
    }
    if (result === CLAUDE_LEASE_UNREACHABLE) {
      if (paused) return result;
      paused = true;
      try {
        if (await pauseForUncertainOwnership?.() === true) return result;
      } catch {
        // Failure to pause cannot preserve safe ownership uncertainty.
      }
      loseOwnership();
      return result;
    }
    if (paused) {
      try {
        if (await resumeAfterOwnershipRecovered?.() !== true) {
          loseOwnership();
          return CLAUDE_LEASE_UNREACHABLE;
        }
      } catch {
        loseOwnership();
        return CLAUDE_LEASE_UNREACHABLE;
      }
      paused = false;
    }
    return result;
  };
  const renewNow = () => {
    if (inFlight) return inFlight;
    inFlight = renewClaudeCredentialLeaseWithinDeadline(lease)
      .then(applyRenewalResult)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const schedule = () => {
    if (stopped || lost) return;
    timer = setTimeout(() => {
      timer = null;
      void renewNow().finally(schedule);
    }, CLAUDE_LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
  };
  schedule();
  return {
    get lost() {
      return lost;
    },
    get paused() {
      return paused;
    },
    renewNow,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

async function assertClaudeCredentialLeaseOwned({
  lease,
  heartbeat,
  abortController,
  phase,
  tolerateUnreachable = false,
}) {
  const renewal = heartbeat?.renewNow
    ? await heartbeat.renewNow()
    : await renewClaudeCredentialLeaseWithinDeadline(lease);
  if (
    tolerateUnreachable
    && renewal === CLAUDE_LEASE_UNREACHABLE
    && !heartbeat?.lost
  ) {
    return false;
  }
  if (heartbeat?.lost || renewal !== CLAUDE_LEASE_RENEWED) {
    abortController?.abort();
    throw new Error(`Claude credential lease was lost ${phase}.`);
  }
  return true;
}

function buildClaudeRecoveryStorageId({ installationId, configDir }) {
  return `sha256:${createHash("sha256")
    .update(
      `${CLAUDE_RECOVERY_STORAGE_CONTRACT}\0${installationId}\0${path.resolve(configDir).normalize("NFC")}`,
    )
    .digest("hex")}`;
}

function currentRedisClaudeRecord(runtime, label) {
  return (runtime?.snapshot?.credentials ?? []).find(
    (record) => record.provider === ANTHROPIC_PROVIDER && record.label === label,
  ) ?? null;
}

function buildClaudeTokenLineageFingerprint(credential) {
  const access = typeof credential?.access === "string" ? credential.access.trim() : "";
  const refresh = typeof credential?.refresh === "string" ? credential.refresh.trim() : "";
  if (!access || !refresh) return null;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ access, refresh }))
    .digest("hex")}`;
}

function requireClaudeFenceBaseline(runtime, label) {
  const record = currentRedisClaudeRecord(runtime, label);
  const fingerprint = buildClaudeTokenLineageFingerprint(record?.credential);
  if (!record || !Number.isInteger(record.version) || !fingerprint) {
    throw new Error(`Claude label=${label} has no valid Redis credential lineage for rotation fencing.`);
  }
  return { record, fingerprint };
}

async function createClaudeRotationFenceForCurrentCredential({ runtime, label, recoveryStorageId, observedAt }) {
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

async function clearClaudeRotationFenceOrThrow({ runtime, label, fence, guard }) {
  if (!fence) return;
  if (await clearRedisClaudeRotationFence(runtime.store, {
    label,
    fenceId: fence.fenceId,
    lease: guard?.lease,
  }) !== true) {
    throw new Error(`Claude label=${label} shared rotation fence could not be cleared safely.`);
  }
}

function assertRedisClaudeFenceSuccessor({ record, fence }) {
  if (!fence) return;
  const fingerprint = buildClaudeTokenLineageFingerprint(record?.credential);
  if (!isRedisClaudeRotationFenceSuccessor(record, {
    fence,
    tokenLineageFingerprint: fingerprint,
  })) {
    throw new Error(`Claude label=${fence.label} rotation successor is not linked to its shared fence.`);
  }
}

function assertExplicitClaudeFenceReplacement({ state, label, fence }) {
  if (!fence) return;
  const replacementFingerprint = buildClaudeTokenLineageFingerprint(
    state?.credentials?.[ANTHROPIC_PROVIDER]?.[label],
  );
  if (!replacementFingerprint || replacementFingerprint === fence.baseTokenLineageFingerprint) {
    throw new Error(
      `Claude label=${label} capture/import did not replace the unresolved rotating-token lineage; shared fence remains active.`,
    );
  }
}

async function acquireClaudeCredentialLeaseGuard(runtime, label, {
  pauseForUncertainOwnership = null,
  resumeAfterOwnershipRecovered = null,
} = {}) {
  const lease = await acquireRedisCredentialLease(runtime.store, {
    provider: ANTHROPIC_PROVIDER,
    label,
  });
  if (!lease) {
    const error = new Error(`Claude label=${label} is busy on another AIM process or machine; retry shortly.`);
    error.code = "AIMGR_CREDENTIAL_BUSY";
    throw error;
  }
  const abortController = new AbortController();
  const heartbeat = startClaudeCredentialLeaseHeartbeat({
    lease,
    abortController,
    pauseForUncertainOwnership,
    resumeAfterOwnershipRecovered,
  });
  try {
    await assertClaudeCredentialLeaseOwned({
      lease,
      heartbeat,
      abortController,
      phase: "immediately after acquisition",
    });
  } catch (error) {
    await heartbeat.stop();
    try {
      await lease.release();
    } catch {
      // The ownership assertion is the actionable failure.
    }
    throw error;
  }
  return { lease, heartbeat, abortController };
}

async function releaseClaudeCredentialLeaseGuard(guard) {
  if (!guard) return;
  await guard.heartbeat.stop();
  if (await guard.lease.release() !== true && !guard.heartbeat.lost) {
    throw new Error("Claude credential lease release failed.");
  }
}

async function selectAutomaticClaudeAccount(context, {
  preset,
  excludeLabels = [],
} = {}) {
  const {
    homeDir,
    nowMs,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
  } = context;
  const excluded = new Set(excludeLabels.map((label) => normalizeLabel(label)));
  const usageStatus = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    fresh: true,
    nowMs,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
  });
  return selectLeastUsedUnlockedClaudeAccount({
    ...usageStatus,
    accounts: usageStatus.accounts.filter((account) => !excluded.has(account.label)),
  }, { preset });
}

function pendingRotationMap(target) {
  if (!isObject(target.rotationPublicationPendingByLabel)) {
    target.rotationPublicationPendingByLabel = {};
  }
  return target.rotationPublicationPendingByLabel;
}

function markRotationPublicationPending(target, label) {
  pendingRotationMap(target)[label] = {
    pending: true,
    observedAt: new Date().toISOString(),
  };
}

function clearRotationPublicationPending(target, label) {
  const pending = pendingRotationMap(target);
  delete pending[label];
  if (Object.keys(pending).length === 0) {
    delete target.rotationPublicationPendingByLabel;
  }
}

function requireExpectedClaudeEmail(state, label) {
  const expectedEmail = typeof state?.accounts?.[label]?.expect?.email === "string"
    ? state.accounts[label].expect.email.trim().toLowerCase()
    : "";
  if (!expectedEmail) {
    throw new Error(`Claude label=${label} is missing its canonical expected-email policy in Redis.`);
  }
  return expectedEmail;
}

function requireRedisClaudeCredential(state, label) {
  const credential = state?.credentials?.[ANTHROPIC_PROVIDER]?.[label];
  if (!isObject(credential)) {
    throw new Error(`Claude label=${label} does not have a credential-ready Redis record.`);
  }
  return credential;
}

async function publishRotationIfNeeded({ runtime, result, label, observedAt, fence }) {
  if (result?.synced !== true) return null;
  if (result.label !== label) {
    throw new Error("Claude managed-storage rotation resolved to an unexpected account label.");
  }
  if (!fence) {
    throw new Error(`Claude label=${label} rotation publication requires a shared fence.`);
  }
  const successorFingerprint = buildClaudeTokenLineageFingerprint(
    runtime.state?.credentials?.[ANTHROPIC_PROVIDER]?.[label],
  );
  if (!successorFingerprint || successorFingerprint === fence.baseTokenLineageFingerprint) {
    throw new Error(`Claude label=${label} rotation did not produce a new access/refresh token pair.`);
  }
  return publishRedisStateCredential({
    runtime,
    state: runtime.state,
    provider: ANTHROPIC_PROVIDER,
    label,
    observedAt,
    lineageMode: "native-claude-rotation",
    rotationFence: fence,
  });
}

function startClaudeActiveRotationPublisher({
  runtime,
  label,
  descriptor,
  fence,
  guard,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  let stopped = false;
  let failed = false;
  let timer = null;
  let inFlight = null;

  const schedule = () => {
    if (stopped || failed) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      inFlight = (async () => {
        try {
          if (guard.heartbeat.paused) return;
          if (!await assertClaudeCredentialLeaseOwned({
            ...guard,
            phase: "before active-run rotation reconciliation",
            tolerateUnreachable: true,
          })) return;
          const nowMs = Date.now();
          const result = await syncLiveClaudeRotationBackToLabelFromStorage({
            state: runtime.state,
            descriptor,
            nowMs,
          });
          if (result.synced !== true) return;
          if (result.label !== label) {
            throw new Error("Claude managed-storage rotation resolved to an unexpected account label.");
          }
          const currentFingerprint = buildClaudeTokenLineageFingerprint(
            currentRedisClaudeRecord(runtime, label)?.credential,
          );
          const candidateFingerprint = buildClaudeTokenLineageFingerprint(
            runtime.state?.credentials?.[ANTHROPIC_PROVIDER]?.[label],
          );
          if (candidateFingerprint && candidateFingerprint === currentFingerprint) return;
          if (!await assertClaudeCredentialLeaseOwned({
            ...guard,
            phase: "before active-run rotation publication",
            tolerateUnreachable: true,
          })) return;
          const record = await publishRotationIfNeeded({
            runtime,
            result,
            label,
            observedAt: new Date(nowMs).toISOString(),
            fence,
          });
          assertRedisClaudeFenceSuccessor({ record, fence });
        } catch {
          failed = true;
          guard.abortController.abort();
        }
      })().finally(() => {
        inFlight = null;
        schedule();
      });
      return inFlight;
    }, CLAUDE_ACTIVE_ROTATION_SYNC_INTERVAL_MS);
    timer.unref?.();
  };

  schedule();
  return {
    get failed() {
      return failed;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
  };
}

async function recoverSharedClaudeRotationFence({
  runtime,
  label,
  fence,
  recoveryStorageId,
  descriptor,
  guard,
  homeDir,
  nowMs,
}) {
  if (!fence) return null;
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
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before clearing a published rotation fence" });
    await clearClaudeRotationFenceOrThrow({ runtime, label, fence, guard });
    return { synced: false, reason: "already_published", record: baseline.record };
  }
  if (fence.recoveryStorageId !== recoveryStorageId) {
    throw new Error(
      `Claude label=${label} has an unresolved rotation on another machine; recover there or replace it with ` +
        "`aim claude capture-native` / `aim claude import-native`.",
    );
  }

  const recovered = await syncLiveClaudeRotationBackToLabelFromStorage({
    state: runtime.state,
    descriptor,
    nowMs,
  });
  await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before publishing recovered Claude rotation" });
  let record = null;
  if (recovered.synced === true) {
    record = await publishRotationIfNeeded({
      runtime,
      result: recovered,
      label,
      observedAt: new Date(nowMs).toISOString(),
      fence,
    });
    assertRedisClaudeFenceSuccessor({ record, fence });
  } else if (recovered.reason === "tokens_unchanged") {
    return { ...recovered, retainedFence: fence };
  } else {
    markRotationPublicationPending(runtime.state.targets.claudeCli, label);
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    throw new Error(
      `Claude label=${label} shared rotation fence could not be recovered from this machine.`,
    );
  }
  await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before clearing a recovered rotation fence" });
  await clearClaudeRotationFenceOrThrow({ runtime, label, fence, guard });
  clearRotationPublicationPending(runtime.state.targets.claudeCli, label);
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  return { ...recovered, record };
}

async function handleRedisClaudeCaptureNative(context, { label, sourceHome, sourceConfigDir }) {
  const {
    homeDir,
    stdout,
    connectRedisStoreImpl,
    readClaudeNativeKeychainOauthImpl,
    nowMs,
  } = context;
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl,
    provider: ANTHROPIC_PROVIDER,
  });
  let guard = null;
  let attemptedAt = null;
  try {
    guard = await acquireClaudeCredentialLeaseGuard(runtime, label);
    await refreshRedisRuntimeState(runtime);
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native capture" });
    attemptedAt = recordAccountMaintenanceAttempt(runtime.state, label, { providerHint: ANTHROPIC_PROVIDER });
    const existingFence = await readRedisClaudeRotationFence(runtime.store, { label });
    const expectedEmail = requireExpectedClaudeEmail(runtime.state, label);
    const defaultConfigDir = resolveManagedClaudeDir({ homeDir: sourceHome });
    const configDir = sourceConfigDir ?? defaultConfigDir;
    const descriptor = buildClaudeNativeStorageDescriptor({
      configDir,
      defaultConfigDir,
      appStatePath: sourceConfigDir
        ? path.join(configDir, ".claude.json")
        : path.join(sourceHome, ".claude.json"),
      expectedEmail,
    });
    const captured = await captureClaudeNativeBundleFromKeychain({
      descriptor,
      nowMs,
      allowExpired: true,
      readClaudeNativeKeychainOauthImpl,
    });
    if (captured.ok !== true) {
      throw new Error(`Claude native capture blocked: ${captured.errorKind || "native_storage_unavailable"}.`);
    }
    assertNoAnthropicSnapshotIdentityConflict(runtime.snapshot, {
      nativeClaudeBundle: captured.nativeClaudeBundle,
      excludeLabel: label,
    });
    const persisted = persistAnthropicNativeBundleForLabel({
      state: runtime.state,
      label,
      nativeClaudeBundle: captured.nativeClaudeBundle,
      allowExpiredAccess: true,
    });
    assertExplicitClaudeFenceReplacement({ state: runtime.state, label, fence: existingFence });
    recordAccountMaintenanceSuccess(runtime.state, label, { homeDir, observedAt: attemptedAt });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native capture publication" });
    const published = await publishMaintainedCredential({
      store: runtime.store,
      snapshot: runtime.snapshot,
      state: runtime.state,
      label,
      provider: ANTHROPIC_PROVIDER,
      observedAt: attemptedAt,
      rotationFence: existingFence,
    });
    if (!published.ok) {
      throw new Error(`Redis stale_version while publishing Claude native bundle for label=${label}; reload and retry.`);
    }
    assertRedisClaudeFenceSuccessor({ record: published.credential?.record, fence: existingFence });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before resolving a shared rotation fence" });
    await clearClaudeRotationFenceOrThrow({ runtime, label, fence: existingFence, guard });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          captured: {
            label,
            source: "keychain",
            identityPolicyMatched: true,
            credentialReady: true,
            action: persisted.action,
            redisVersion: published.credential?.record?.version ?? null,
          },
        }),
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    if (attemptedAt) {
      recordAccountMaintenanceFailure(runtime.state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    throw err;
  } finally {
    try {
      await releaseClaudeCredentialLeaseGuard(guard);
    } finally {
      await closeRedisRuntime(runtime);
    }
  }
}

async function handleRedisClaudeImportNative(context, { label, inFile }) {
  const { homeDir, stdout, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl,
    provider: ANTHROPIC_PROVIDER,
  });
  let guard = null;
  let attemptedAt = null;
  try {
    guard = await acquireClaudeCredentialLeaseGuard(runtime, label);
    await refreshRedisRuntimeState(runtime);
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native import" });
    attemptedAt = recordAccountMaintenanceAttempt(runtime.state, label, { providerHint: ANTHROPIC_PROVIDER });
    const existingFence = await readRedisClaudeRotationFence(runtime.store, { label });
    requireExpectedClaudeEmail(runtime.state, label);
    const imported = readClaudeNativeBundleExportFile({ filePath: inFile });
    assertNoAnthropicSnapshotIdentityConflict(runtime.snapshot, {
      nativeClaudeBundle: imported.payload.nativeClaudeBundle,
      excludeLabel: label,
    });
    persistAnthropicNativeBundleForLabel({
      state: runtime.state,
      label,
      nativeClaudeBundle: imported.payload.nativeClaudeBundle,
      allowExpiredAccess: true,
    });
    assertExplicitClaudeFenceReplacement({ state: runtime.state, label, fence: existingFence });
    recordAccountMaintenanceSuccess(runtime.state, label, { homeDir, observedAt: attemptedAt });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native import publication" });
    const published = await publishMaintainedCredential({
      store: runtime.store,
      snapshot: runtime.snapshot,
      state: runtime.state,
      label,
      provider: ANTHROPIC_PROVIDER,
      observedAt: attemptedAt,
      rotationFence: existingFence,
    });
    if (!published.ok) {
      throw new Error(`Redis stale_version while publishing Claude native bundle for label=${label}; reload and retry.`);
    }
    assertRedisClaudeFenceSuccessor({ record: published.credential?.record, fence: existingFence });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before resolving a shared rotation fence" });
    await clearClaudeRotationFenceOrThrow({ runtime, label, fence: existingFence, guard });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          imported: {
            label,
            identityPolicyMatched: true,
            credentialReady: true,
            redisVersion: published.credential?.record?.version ?? null,
          },
        }),
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    if (attemptedAt) {
      recordAccountMaintenanceFailure(runtime.state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    throw err;
  } finally {
    try {
      await releaseClaudeCredentialLeaseGuard(guard);
    } finally {
      await closeRedisRuntime(runtime);
    }
  }
}

async function handleRedisClaudeRun(context, {
  maintenance = false,
  launchCwd = process.cwd(),
  sessionFork = null,
} = {}) {
  const {
    opts,
    positional,
    homeDir,
    env,
    setExitCode,
    connectRedisStoreImpl,
    runClaudeCliImpl = runClaudeCli,
    resolveExecutableOnPathImpl,
    nowMs,
  } = context;
  const setMaintenanceTimer = context.setTimeoutImpl ?? setTimeout;
  const clearMaintenanceTimer = context.clearTimeoutImpl ?? clearTimeout;
  const label = normalizeLabel(positional[2]);
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  const configDir = resolveManagedClaudeDir({ homeDir: claudeHome });
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl,
    provider: ANTHROPIC_PROVIDER,
  });
  let guard = null;
  let operationError = null;
  let cleanupError = null;
  let processResult = null;
  let managedDescriptor = null;
  let credentialProjected = false;
  let runFenceCreated = false;
  let maintenanceTimer = null;
  let maintenanceTimedOut = false;
  let activeRotationPublisher = null;
  let activeRotationPublicationFailed = false;
  let stagedSessionFork = null;
  let activeProcessControl = null;
  try {
    guard = await acquireClaudeCredentialLeaseGuard(runtime, label, maintenance
      ? {}
      : {
          pauseForUncertainOwnership: async () => (
            activeProcessControl?.pause ? activeProcessControl.pause() : false
          ),
          resumeAfterOwnershipRecovered: async () => (
            activeProcessControl?.resume ? activeProcessControl.resume() : false
          ),
        });
    // A prior lease owner may have rotated this label between our initial read
    // and lease acquisition. Reload under the lease before inspecting local
    // projections or choosing the authoritative bundle.
    await refreshRedisRuntimeState(runtime);
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before managed Claude preflight" });
    const refreshedRecord = currentRedisClaudeRecord(runtime, label);
    const refreshedExpiryMs = parseExpiresAtToMs(refreshedRecord?.credential?.expiresAt);
    if (
      maintenance
      && (
        refreshedRecord?.policy?.reauth?.blockedReason === "oauth_reauth_required"
        || (
          hasCompleteClaudeNativeBundle(refreshedRecord?.credential)
          && refreshedExpiryMs !== null
          && refreshedExpiryMs > nowMs + CLAUDE_MAINTENANCE_DUE_WINDOW_MS
        )
      )
    ) {
      throw CLAUDE_MAINTENANCE_SKIPPED;
    }
    const expectedEmail = requireExpectedClaudeEmail(runtime.state, label);
    const descriptor = buildManagedClaudeNativeStorageDescriptor({
      configDir,
      defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
      expectedEmail,
      managedRootDir: resolveAimgrStateDir({ homeDir }),
    });
    managedDescriptor = descriptor;
    ensureSafeManagedClaudeStorage({ descriptor });
    const discoveredCommand = resolveExecutableOnPathImpl?.("claude");
    if (!discoveredCommand || !path.isAbsolute(discoveredCommand)) {
      throw new Error("Could not resolve the installed Claude executable for managed launch.");
    }
    const prepareLaunchImpl = typeof resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl === "function"
      ? resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl
      : prepareClaudeCliLaunch;
    const preparedLaunch = await prepareLaunchImpl({
      command: discoveredCommand,
      userHomeDir: homeDir,
      homeDir: claudeHome,
      configDir,
    });
    const installationId = ensureLocalInstallationId(runtime.localState);
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    const recoveryStorageId = buildClaudeRecoveryStorageId({ installationId, configDir });

    const observedAt = new Date(nowMs).toISOString();
    const target = runtime.state.targets.claudeCli;
    const hadPendingRotation = pendingRotationMap(target)[label]?.pending === true;
    const existingFence = await readRedisClaudeRotationFence(runtime.store, { label });
    const fenceRecovery = await recoverSharedClaudeRotationFence({
      runtime,
      label,
      fence: existingFence,
      recoveryStorageId,
      descriptor,
      guard,
      homeDir,
      nowMs,
    });
    let retainedRunFence = fenceRecovery?.retainedFence ?? null;
    const preRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
      state: runtime.state,
      descriptor,
      nowMs,
    });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before pre-run rotation reconciliation" });
    let preRunRecord = null;
    let preRunFence = null;
    try {
      if (preRunSync.synced === true) {
        preRunFence = retainedRunFence ?? await createClaudeRotationFenceForCurrentCredential({
          runtime,
          label,
          recoveryStorageId,
          observedAt,
        });
      }
      preRunRecord = await publishRotationIfNeeded({
        runtime,
        result: preRunSync,
        label,
        observedAt,
        fence: preRunFence,
      });
      if (preRunFence) {
        assertRedisClaudeFenceSuccessor({ record: preRunRecord, fence: preRunFence });
        await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before clearing the pre-run rotation fence" });
        await clearClaudeRotationFenceOrThrow({ runtime, label, fence: preRunFence, guard });
        if (preRunFence === retainedRunFence) retainedRunFence = null;
      }
    } catch {
      markRotationPublicationPending(target, label);
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      throw new Error("Claude rotation publication is pending; rerun this label before launching Claude again.");
    }
    const preRunRecovered = preRunSync.synced === true
      || preRunSync.reason === "tokens_unchanged"
      || preRunSync.reason === "stale_candidate";
    if ((hadPendingRotation && !preRunRecovered) || (!hadPendingRotation && !preRunRecovered && !SAFE_PRE_RUN_STORAGE_REASONS.has(preRunSync.reason))) {
      throw new Error(
        hadPendingRotation
          ? "Claude rotation publication is pending and the managed projection could not be recovered."
          : "Claude managed storage could not be reconciled safely before projection.",
      );
    }
    clearRotationPublicationPending(target, label);

    if (sessionFork) {
      stagedSessionFork = stageManagedClaudeSessionFork({
        session: sessionFork,
        targetConfigDir: configDir,
      });
    }

    const credential = requireRedisClaudeCredential(runtime.state, label);
    const preRunCredentialComplete = hasCompleteClaudeNativeBundle(credential);
    await projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential,
      nowMs,
    });
    credentialProjected = true;
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native Claude launch" });
    target.activeLabel = label;
    target.claudeDir = configDir;
    target.credentialsPath = path.join(configDir, ".credentials.json");
    target.appStatePath = descriptor.appStatePath;
    target.lastAppliedAt = observedAt;
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    const runFence = retainedRunFence ?? await createClaudeRotationFenceForCurrentCredential({
      runtime,
      label,
      recoveryStorageId,
      observedAt,
    });
    runFenceCreated = true;
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "after creating the shared rotation fence" });

    if (!maintenance) {
      activeRotationPublisher = startClaudeActiveRotationPublisher({
        runtime,
        label,
        descriptor,
        fence: runFence,
        guard,
        setTimeoutImpl: setMaintenanceTimer,
        clearTimeoutImpl: clearMaintenanceTimer,
      });
    }
    let launched = null;
    let launchError = null;
    try {
      if (maintenance) {
        maintenanceTimer = setMaintenanceTimer(() => {
          maintenanceTimedOut = true;
          guard.abortController.abort();
        }, CLAUDE_MAINTENANCE_TIMEOUT_MS);
        maintenanceTimer.unref?.();
      }
      launched = await runClaudeCliImpl({
        command: preparedLaunch.command,
        userHomeDir: homeDir,
        homeDir: claudeHome,
        configDir,
        cwd: launchCwd,
        args: maintenance ? CLAUDE_MAINTENANCE_ARGS : opts.afterDoubleDash,
        env,
        signal: guard.abortController.signal,
        registerProcessControl: maintenance
          ? null
          : (processControl) => {
              activeProcessControl = processControl;
            },
        preparedLaunch,
      });
    } catch (error) {
      launchError = error;
    } finally {
      activeProcessControl = null;
      if (maintenanceTimer) {
        clearMaintenanceTimer(maintenanceTimer);
        maintenanceTimer = null;
      }
    }
    if (activeRotationPublisher) {
      await activeRotationPublisher.stop();
      activeRotationPublicationFailed = activeRotationPublisher.failed;
      activeRotationPublisher = null;
    }

    const safeLaunch = {
      status: Number.isInteger(launched?.status)
        ? launched.status
        : typeof launched?.signal === "string"
          ? null
          : 1,
      signal: typeof launched?.signal === "string" ? launched.signal : null,
    };
    const launchCompletedCleanly = !launchError && safeLaunch.status === 0 && safeLaunch.signal === null;

    const postRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
      state: runtime.state,
      descriptor,
      nowMs: Date.now(),
    });
    let postRunRecord = null;
    let continuityFailed = guard.heartbeat.lost || activeRotationPublicationFailed;
    if (!continuityFailed) {
      try {
        await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before post-run rotation publication" });
        postRunRecord = await publishRotationIfNeeded({
          runtime,
          result: postRunSync,
          label,
          observedAt: new Date().toISOString(),
          fence: runFence,
        });
        if (postRunRecord) assertRedisClaudeFenceSuccessor({ record: postRunRecord, fence: runFence });
      } catch {
        continuityFailed = true;
      }
    }
    const terminalMissingTokens = maintenance
      && preRunCredentialComplete
      && launchCompletedCleanly
      && postRunSync.reason === "native_storage_empty";
    let maintenanceOutcome = null;
    let terminalHandlingError = null;
    if (terminalMissingTokens && !continuityFailed) {
      try {
        await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before recording terminal Claude refresh failure" });
        await clearClaudeRotationFenceOrThrow({ runtime, label, fence: runFence, guard });
        runFenceCreated = false;
        clearRotationPublicationPending(target, label);
        retireManagedClaudeCredentialProjection({ descriptor });
        credentialProjected = false;
        runtime.state.accounts[label].reauth = {
          ...(isObject(runtime.state.accounts[label].reauth) ? runtime.state.accounts[label].reauth : {}),
          blockedReason: "oauth_reauth_required",
        };
        await publishRedisCredentialPolicyFromState({
          runtime,
          state: runtime.state,
          label,
          observedAt: new Date().toISOString(),
        });
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        maintenanceOutcome = "reauth_required";
      } catch {
        terminalHandlingError = new Error("Claude terminal refresh state could not be published safely.");
      }
    }
    if (terminalHandlingError) throw terminalHandlingError;
    continuityFailed = continuityFailed
      || guard.heartbeat.lost
      || (
        !maintenanceOutcome
        && postRunSync.synced !== true
        && (postRunSync.reason !== "tokens_unchanged" || !launchCompletedCleanly)
      );
    if (maintenanceOutcome) {
      processResult = { ...safeLaunch, maintenanceOutcome };
    } else if (continuityFailed) {
      markRotationPublicationPending(target, label);
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      if (launchError || launchCompletedCleanly) {
        throw new Error("Claude rotation publication is pending; rerun this label before launching Claude again.");
      }
      processResult = safeLaunch;
    } else {
      await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before clearing the post-run rotation fence" });
      await clearClaudeRotationFenceOrThrow({ runtime, label, fence: runFence, guard });
      runFenceCreated = false;
      clearRotationPublicationPending(target, label);
      retireManagedClaudeCredentialProjection({ descriptor });
      credentialProjected = false;
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      if (launchError) throw launchError;
      processResult = {
        ...safeLaunch,
        ...(maintenance
          ? { maintenanceOutcome: postRunSync.synced === true ? "refreshed" : "unchanged" }
          : {}),
      };
    }
  } catch (error) {
    if (
      error === CLAUDE_MAINTENANCE_SKIPPED
      || (maintenance && error?.code === "AIMGR_CREDENTIAL_BUSY")
    ) {
      processResult = {
        status: 0,
        signal: null,
        maintenanceOutcome: "skipped",
      };
    } else {
      operationError = error;
    }
    if (operationError && credentialProjected && !runFenceCreated && managedDescriptor) {
      try {
        retireManagedClaudeCredentialProjection({ descriptor: managedDescriptor });
        credentialProjected = false;
      } catch {
        operationError = new Error(
          "Managed Claude failed before launch fencing and its credential projection could not be retired safely.",
        );
      }
    }
  } finally {
    if (maintenanceTimer) clearMaintenanceTimer(maintenanceTimer);
    if (stagedSessionFork) {
      try {
        stagedSessionFork.cleanup();
      } catch {
        cleanupError = new Error("Could not clean the staged Claude session fork.");
      }
    }
    if (activeRotationPublisher) {
      try {
        await activeRotationPublisher.stop();
      } catch {
        cleanupError = new Error("Claude active-run rotation publisher shutdown failed.");
      }
    }
    try {
      await guard?.heartbeat.stop();
    } catch {
      cleanupError = new Error("Claude credential lease heartbeat shutdown failed.");
    }
    if (guard?.lease) {
      try {
        const released = await guard.lease.release();
        if (released !== true && !guard.heartbeat.lost) {
          cleanupError = new Error("Claude credential lease release failed.");
        }
      } catch {
        cleanupError = new Error("Claude credential lease release failed.");
      }
    }
    try {
      await closeRedisRuntime(runtime);
    } catch {
      cleanupError ??= new Error("Could not close the Redis runtime safely.");
    }
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (maintenance) {
    return {
      outcome: processResult?.maintenanceOutcome
        ?? (processResult?.status === 0 && !processResult?.signal ? "unchanged" : "failed"),
      timedOut: maintenanceTimedOut,
      status: processResult?.status ?? null,
      signal: processResult?.signal ?? null,
    };
  }
  if (processResult?.signal) {
    process.kill(process.pid, processResult.signal);
    return;
  }
  if (processResult?.status !== 0) {
    setExitCode(Number.isInteger(processResult?.status) ? processResult.status : 1);
  }
}

export async function maintainRedisClaudeCredential(context, { label }) {
  const maintenanceEnv = { ...context.env };
  delete maintenanceEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return handleRedisClaudeRun(
    {
      ...context,
      env: maintenanceEnv,
      positional: ["claude", "run", normalizeLabel(label)],
      opts: {
        ...context.opts,
        afterDoubleDash: CLAUDE_MAINTENANCE_ARGS,
      },
    },
    { maintenance: true },
  );
}

export async function handleClaude(context) {
  const {
    opts,
    positional,
    statePath,
    homeDir,
    env,
    stdout,
    setExitCode,
    probeUsageSnapshotsByProviderImpl,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
    nowMs,
  } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error(
      "Missing claude subcommand. Usage: aim claude list [count] [--json] | aim claude resume <row-or-thread-id> | aim claude inventory [--json] | aim claude status [account...] [--fresh] [--json] | aim claude run <label> [-- <claude args...>] | aim claude capture-native <label> | aim claude export-live --out <file> | aim claude import-native <label> --in <file>",
    );
  }
  if (subcmd === "list") {
    const requestedCount = positional[2];
    if (
      positional.length > 3
      || (
        requestedCount !== undefined
        && (
          !/^\d+$/.test(requestedCount)
          || !Number.isSafeInteger(Number(requestedCount))
          || Number(requestedCount) < 1
        )
      )
    ) {
      throw new Error("Usage: aim claude list [count] [--json]");
    }
    const sessions = listRecentManagedClaudeSessions({
      homeDir,
      ...(requestedCount === undefined ? {} : { limit: Number(requestedCount) }),
    });
    if (opts.json) {
      stdout.write(`${JSON.stringify({
        sessions: sessions.map((session) => ({
          rank: session.rank,
          lastUsedAt: session.lastUsedAt,
          account: session.account,
          threadName: session.threadName,
          threadId: session.threadId,
          cwd: session.cwd,
        })),
      }, null, 2)}\n`);
    } else {
      stdout.write(renderRecentManagedClaudeSessions(sessions, { homeDir, nowMs }));
    }
    return;
  }
  if (subcmd === "resume") {
    if (positional.length !== 3) {
      throw new Error(
        "Usage: aim claude resume <row-or-thread-id> [--switch-account fable|opus]",
      );
    }
    const session = resolveManagedClaudeSession({
      homeDir,
      selector: positional[2],
    });
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude resume\` requires Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const requestedSwitchPreset = opts.claudeResumeSwitchAccountPreset;
    const preservedResumeArgs = session.model && session.effort
      ? [
        "--dangerously-skip-permissions",
        "--model",
        session.model,
        "--effort",
        session.effort,
      ]
      : null;
    if (!requestedSwitchPreset && !preservedResumeArgs) {
      throw new Error(
        `Claude session ${session.threadId} does not record an exact model and effort; refusing to guess.`,
      );
    }
    if (!requestedSwitchPreset) {
      const directContext = {
        ...context,
        positional: ["claude", "run", session.account],
        opts: {
          ...opts,
          afterDoubleDash: [
            ...preservedResumeArgs,
            "--resume",
            session.threadId,
          ],
        },
      };
      try {
        await handleRedisClaudeRun(directContext, {
          launchCwd: session.cwd,
        });
        return;
      } catch (error) {
        if (error?.code !== "AIMGR_CREDENTIAL_BUSY") throw error;
      }
    }

    const forkPreset = requestedSwitchPreset
      ?? (session.model.toLowerCase().includes("fable") ? "fable" : "opus");
    const forkResumeArgs = requestedSwitchPreset
      ? (
        forkPreset === "fable"
          ? CLAUDE_FABLE_RUN_PRESET_ARGS
          : CLAUDE_OPUS_RUN_PRESET_ARGS
      )
      : preservedResumeArgs;
    const selected = await selectAutomaticClaudeAccount(context, {
      preset: forkPreset,
      excludeLabels: [session.account],
    });
    if (!selected) {
      if (requestedSwitchPreset) {
        const usage = forkPreset === "fable" ? "Fable" : "five-hour";
        throw new Error(
          `No other unlocked Claude account with readable ${usage} usage is available for --switch-account ${forkPreset}.`,
        );
      }
      throw new Error(
        `Claude label=${session.account} is busy and no other unlocked Claude account with readable five-hour usage is available.`,
      );
    }
    const forkName = buildManagedClaudeSessionForkName(session);
    const forkReason = requestedSwitchPreset
      ? `Switching session from ${session.account} to ${selected.label} using ${forkPreset}`
      : `${session.account} is busy; forking session onto ${selected.label}`;
    stdout.write(`${forkReason} as "${forkName}".\n`);
    await handleRedisClaudeRun({
      ...context,
      positional: ["claude", "run", selected.label],
      opts: {
        ...opts,
        afterDoubleDash: [
          ...forkResumeArgs,
          "--resume",
          session.threadId,
          "--fork-session",
          "--name",
          forkName,
        ],
      },
    }, {
      launchCwd: session.cwd,
      sessionFork: session,
    });
    return;
  }
  if (subcmd === "run") {
    if (positional.length > 3) {
      throw new Error(
        `Unknown Claude run preset: ${positional[3]}. Use opus, fable, or -- <claude args...>.`,
      );
    }
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude run\` requires Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    if (opts.claudeAutoSelect === true) {
      const selected = await selectAutomaticClaudeAccount(context, {
        preset: opts.claudeAutoSelectPreset,
      });
      if (!selected) {
        throw new Error(
          opts.claudeAutoSelectPreset === "fable"
            ? "No unlocked Claude account with readable Fable and five-hour usage is available."
            : "No unlocked Claude account with readable five-hour usage is available.",
        );
      }
      await handleRedisClaudeRun({
        ...context,
        positional: ["claude", "run", selected.label],
      });
      return;
    }
    await handleRedisClaudeRun(context);
    return;
  }
  if (subcmd === "status" || subcmd === "usage") {
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude ${subcmd}\` requires Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const selectedLabels = positional.slice(2);
    const result = await collectClaudeRedisAccountUsageStatus({
      homeDir,
      selectedLabels,
      fresh: opts.fresh === true,
      nowMs,
      fetchJsonWithTimeoutImpl,
      connectRedisStoreImpl,
    });
    stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderClaudeRedisAccountUsageStatus(result));
    if (result.ok !== true) {
      setExitCode(1);
    }
    return;
  }
  if (subcmd === "inventory") {
    if (positional.length > 2) {
      throw new Error("`aim claude inventory` does not accept positional arguments.");
    }
    if (opts.fresh === true) {
      throw new Error("`aim claude inventory` is always offline and does not accept --fresh.");
    }
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude inventory\` requires Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const result = await collectClaudeRedisAccountInventory({
      homeDir,
      nowMs,
      connectRedisStoreImpl,
    });
    stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderClaudeRedisAccountInventory(result));
    if (result.ok !== true) {
      setExitCode(1);
    }
    return;
  }
  if (subcmd === "capture-native") {
    const label = normalizeLabel(positional[2]);
    const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
    const sourceConfigDir = opts.sourceConfigDir === undefined
      ? null
      : resolveCliPath(opts.sourceConfigDir, {
          homeDir: sourceHome,
          optionName: "--source-config-dir",
        });
    if (isRedisConfigured({ homeDir })) {
      await handleRedisClaudeCaptureNative(context, { label, sourceHome, sourceConfigDir });
      return;
    }
    if (sourceConfigDir) {
      throw new Error("`--source-config-dir` requires Redis-backed Claude capture.");
    }
    const state = loadAimgrState(statePath);
    const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
    try {
      const captured = captureAnthropicNativeBundleForLabel({
        state,
        label,
        sourceHome,
      });
      recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
      markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
      writeJsonFileWithBackup(statePath, state);
      stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            captured: {
              label,
              sourceHome: captured.sourceHome,
              emailAddress: captured.summary.emailAddress,
              organizationName: captured.summary.organizationName,
              organizationUuid: captured.summary.organizationUuid,
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
  }
  if (subcmd === "export-live") {
    const outFile = resolveCliPath(opts.outFile, { homeDir, optionName: "--out" });
    const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
    const exported = exportLiveClaudeNativeBundle({
      filePath: outFile,
      sourceHome,
    });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          exported: {
            filePath: exported.filePath,
            sourceHome: exported.sourceHome,
            emailAddress: exported.summary.emailAddress,
            organizationName: exported.summary.organizationName,
            organizationUuid: exported.summary.organizationUuid,
            wrote: exported.wrote,
          },
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (subcmd === "import-native") {
    const label = normalizeLabel(positional[2]);
    const inFile = resolveCliPath(opts.inFile, { homeDir, optionName: "--in" });
    if (isRedisConfigured({ homeDir })) {
      await handleRedisClaudeImportNative(context, { label, inFile });
      return;
    }
    const state = loadAimgrState(statePath);
    const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
    try {
      const imported = importAnthropicNativeBundleForLabel({
        state,
        label,
        filePath: inFile,
      });
      recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
      markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
      writeJsonFileWithBackup(statePath, state);
      stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            imported: {
              label,
              filePath: imported.filePath,
              sourceHome: imported.sourceHome,
              emailAddress: imported.summary.emailAddress,
              organizationName: imported.summary.organizationName,
              organizationUuid: imported.summary.organizationUuid,
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported claude subcommand: ${subcmd} (supported: list, resume, inventory, status, usage, run, use, capture-native, export-live, import-native).`);
  }
  if (isRedisConfigured({ homeDir })) {
    throw new Error("`aim claude use` was retired for Redis installs. Use `aim claude run <label> [-- <claude args...>]`.");
  }
  const state = loadAimgrState(statePath);
  const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
  const activated = explicitLabel
    ? activateClaudeLabelSelection({ state, homeDir, env, label: explicitLabel })
    : await activateClaudePoolSelection({ state, homeDir, env, probeUsageSnapshotsByProviderImpl });
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
  if (activated.status === "blocked") {
    setExitCode(1);
  }
  return;
}
