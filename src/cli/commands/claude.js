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
import { readRedisClaudeRotationFence } from "../../coordination/redis-claude-rotation-fence.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
  refreshRedisRuntimeState,
  writeRedisLocalStateFromView,
} from "../../coordination/runtime.js";
import { REDIS_CONNECTION_POLICY_LEASED } from "../../coordination/redis-store.js";
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
  buildClaudeNativeStorageDescriptor,
  buildManagedClaudeNativeStorageDescriptor,
  captureClaudeNativeBundleFromKeychain,
  ensureSafeManagedClaudeStorage,
  readManagedClaudeNativeBundleFromFiles,
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
import { loadLocalState } from "../../state/local-state.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { hasCompleteClaudeNativeBundle, readClaudeAppStateFile } from "../../credentials/claude-bundle.js";
import {
  activateClaudeLabelSelection,
  activateClaudePoolSelection,
  assertRedisClaudeFenceSuccessor,
  buildClaudeTokenLineageFingerprint,
  clearClaudeRotationFenceOrThrow,
  createClaudeRotationFenceForCurrentCredential,
  currentRedisClaudeRecord,
  projectClaudeNativeBundleToManagedConfig,
  publishClaudeRotationIfNeeded,
  readClaudeProjectionReceipt,
  recordCommittedClaudeProjection,
} from "../../targets/claude-cli.js";
import { runSharedClaudePreRunPreflight } from "../../targets/claude-preflight.js";
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
const CLAUDE_LEASE_RENEWED = "renewed";
const CLAUDE_LEASE_CONTENDED = "contended";
const CLAUDE_LEASE_UNREACHABLE = "unreachable";
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
}) {
  let stopped = false;
  let timer = null;
  let inFlight = null;
  let lost = false;

  const loseOwnership = () => {
    lost = true;
    abortController.abort();
  };
  const applyRenewalResult = async (result) => {
    if (stopped) return result;
    if (result === CLAUDE_LEASE_CONTENDED) {
      loseOwnership();
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

async function acquireClaudeCredentialLeaseGuard(runtime, label) {
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
    fresh: false,
    nowMs,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
  });
  return selectLeastUsedUnlockedClaudeAccount({
    ...usageStatus,
    accounts: usageStatus.accounts.filter(
      (account) => !excluded.has(account.label) && account.rotationPending !== true,
    ),
  }, { preset });
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

function startClaudeActiveRotationPublisher({
  runtime,
  homeDir,
  label,
  descriptor,
  fence,
  guard,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  let stopped = false;
  let failed = false;
  let degraded = false;
  let timer = null;
  let inFlight = null;

  const schedule = () => {
    if (stopped || failed) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      inFlight = (async () => {
        try {
          if (!await assertClaudeCredentialLeaseOwned({
            ...guard,
            phase: "before active-run rotation reconciliation",
            tolerateUnreachable: true,
          })) return;
          const nowMs = Date.now();
          const result = await syncLiveClaudeRotationBackToLabelFromStorage({
            state: runtime.state,
            label,
            descriptor,
            nowMs,
          });
          if (result.status !== "candidate") return;
          if (result.label !== label) {
            throw new Error("Claude managed-storage rotation resolved to an unexpected account label.");
          }
          const currentFingerprint = buildClaudeTokenLineageFingerprint(
            currentRedisClaudeRecord(runtime, label)?.credential,
          );
          const candidateFingerprint = buildClaudeTokenLineageFingerprint(
            result.candidateCredential,
          );
          if (candidateFingerprint && candidateFingerprint === currentFingerprint) return;
          if (!await assertClaudeCredentialLeaseOwned({
            ...guard,
            phase: "before active-run rotation publication",
            tolerateUnreachable: true,
          })) return;
          const record = await publishClaudeRotationIfNeeded({
            runtime,
            reconciliation: result,
            label,
            observedAt: new Date(nowMs).toISOString(),
            fence,
            descriptor,
            homeDir,
          });
          assertRedisClaudeFenceSuccessor({ record, fence });
        } catch {
          if (guard.heartbeat.lost) {
            failed = true;
            guard.abortController.abort();
          } else {
            degraded = true;
          }
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
    get degraded() {
      return degraded;
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
    await clearClaudeRotationFenceOrThrow({
      runtime,
      label,
      fence: existingFence,
      lease: guard.lease,
    });
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
    await clearClaudeRotationFenceOrThrow({
      runtime,
      label,
      fence: existingFence,
      lease: guard.lease,
    });
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

function readCleanOfflineClaudeCache({ homeDir, label, nowMs }) {
  const localState = loadLocalState({ homeDir });
  const receipt = readClaudeProjectionReceipt(localState.targets?.claudeCli, label);
  if (!receipt) {
    throw new Error(`Claude label=${label} has no valid local projection receipt.`);
  }
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  const configDir = resolveManagedClaudeDir({ homeDir: claudeHome });
  const credentialsPath = path.join(configDir, ".credentials.json");
  if (receipt.credentialsPath !== credentialsPath) {
    throw new Error(`Claude label=${label} local projection receipt points outside its managed account home.`);
  }
  const appState = readClaudeAppStateFile({ homeDir: configDir });
  const expectedEmail = typeof appState?.emailAddress === "string" ? appState.emailAddress.trim().toLowerCase() : "";
  if (!expectedEmail) {
    throw new Error(`Claude label=${label} local cache has no complete native identity.`);
  }
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
    expectedEmail,
    managedRootDir: resolveAimgrStateDir({ homeDir }),
  });
  ensureSafeManagedClaudeStorage({ descriptor });
  const cached = readManagedClaudeNativeBundleFromFiles({ descriptor });
  const localFingerprint = cached.ok === true
    ? buildClaudeTokenLineageFingerprint({ nativeClaudeBundle: cached.nativeClaudeBundle })
    : null;
  if (!localFingerprint || localFingerprint !== receipt.committedLineageFingerprint) {
    throw new Error(`Claude label=${label} local cache is unpublished, unreadable, or identity-ambiguous.`);
  }
  const receiptAgeMs = Math.max(0, Number(nowMs) - Date.parse(receipt.reconciledAt));
  return { localState, receipt, receiptAgeMs, claudeHome, configDir, descriptor };
}

async function runClaudeFromCleanOfflineCache(context, {
  label,
  launchCwd,
  sessionFork,
}) {
  const {
    homeDir,
    stdout,
    env,
    opts,
    setExitCode,
    runClaudeCliImpl = runClaudeCli,
    resolveExecutableOnPathImpl,
    nowMs,
  } = context;
  const cache = readCleanOfflineClaudeCache({ homeDir, label, nowMs });
  const discoveredCommand = resolveExecutableOnPathImpl?.("claude");
  if (!discoveredCommand || !path.isAbsolute(discoveredCommand)) {
    throw new Error("Could not resolve the installed Claude executable for offline managed launch.");
  }
  const prepareLaunchImpl = typeof resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl === "function"
    ? resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl
    : prepareClaudeCliLaunch;
  const preparedLaunch = await prepareLaunchImpl({
    command: discoveredCommand,
    userHomeDir: homeDir,
    homeDir: cache.claudeHome,
    configDir: cache.configDir,
  });
  let stagedSessionFork = null;
  try {
    if (sessionFork) {
      stagedSessionFork = stageManagedClaudeSessionFork({
        session: sessionFork,
        targetConfigDir: cache.configDir,
      });
    }
    stdout?.write?.(
      `AIM coordination=offline label=${label} receipt_age_seconds=${Math.floor(cache.receiptAgeMs / 1000)} cache=clean\n`,
    );
    const result = await runClaudeCliImpl({
      command: preparedLaunch.command,
      userHomeDir: homeDir,
      homeDir: cache.claudeHome,
      configDir: cache.configDir,
      cwd: launchCwd,
      args: opts.afterDoubleDash,
      env,
      preparedLaunch,
    });
    if (result?.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    if (result?.status !== 0) {
      setExitCode(Number.isInteger(result?.status) ? result.status : 1);
    }
  } finally {
    stagedSessionFork?.cleanup();
  }
}

async function handleRedisClaudeRun(context, {
  launchCwd = process.cwd(),
  sessionFork = null,
  allowOffline = true,
} = {}) {
  const {
    opts,
    positional,
    homeDir,
    env,
    stdout,
    setExitCode,
    connectRedisStoreImpl,
    runClaudeCliImpl = runClaudeCli,
    resolveExecutableOnPathImpl,
    nowMs,
  } = context;
  const setRotationTimer = context.setTimeoutImpl ?? setTimeout;
  const clearRotationTimer = context.clearTimeoutImpl ?? clearTimeout;
  const label = normalizeLabel(positional[2]);
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  const configDir = resolveManagedClaudeDir({ homeDir: claudeHome });
  let runtime;
  try {
    runtime = await loadRedisRuntime({
      homeDir,
      connectRedisStoreImpl,
      provider: ANTHROPIC_PROVIDER,
      connectionPolicy: REDIS_CONNECTION_POLICY_LEASED,
    });
  } catch (redisError) {
    if (allowOffline) {
      try {
        await runClaudeFromCleanOfflineCache(context, {
          label,
          launchCwd,
          sessionFork,
        });
        return;
      } catch (cacheError) {
        throw new Error(
          `Claude coordination is offline and label=${label} has no safe clean-cache launch: ${cacheError.message}`,
          { cause: redisError },
        );
      }
    }
    throw redisError;
  }
  let guard = null;
  let operationError = null;
  let cleanupError = null;
  let processResult = null;
  let activeRotationPublisher = null;
  let activeRotationPublicationFailed = false;
  let stagedSessionFork = null;
  try {
    guard = await acquireClaudeCredentialLeaseGuard(runtime, label);
    // A prior lease owner may have rotated this label between our initial read
    // and lease acquisition. Reload under the lease before inspecting local
    // projections or choosing the authoritative bundle.
    await refreshRedisRuntimeState(runtime);
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before managed Claude preflight" });
    const expectedEmail = requireExpectedClaudeEmail(runtime.state, label);
    const preflight = await runSharedClaudePreRunPreflight({
      runtime,
      label,
      homeDir,
      configDir,
      expectedEmail,
      nowMs,
      resolveCommandImpl: resolveExecutableOnPathImpl,
      lease: guard.lease,
      assertLeaseOwned: (phase) => assertClaudeCredentialLeaseOwned({ ...guard, phase }),
    });
    if (preflight.deferred) {
      // An explicit run of a young foreign-fenced label remains unsafe: name
      // the fence age and the recent rotation elsewhere instead of launching.
      const fenceAgeHours = (Math.max(0, preflight.fenceRecovery?.fenceAgeMs ?? 0) / 3_600_000).toFixed(1);
      throw new Error(
        `Claude label=${label} was recently rotated on another machine (fence age ${fenceAgeHours}h); `
          + "its shared rotation fence is still inside the recovery window. "
          + "Run it on that machine or retry after the fence expires.",
      );
    }
    const {
      descriptor,
      command: discoveredCommand,
      recoveryStorageId,
      observedAt,
    } = preflight;
    let retainedRunFence = preflight.retainedFence;
    const prepareLaunchImpl = typeof resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl === "function"
      ? resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl
      : prepareClaudeCliLaunch;
    const preparedLaunch = await prepareLaunchImpl({
      command: discoveredCommand,
      userHomeDir: homeDir,
      homeDir: claudeHome,
      configDir,
    });

    const target = runtime.state.targets.claudeCli;
    if (sessionFork) {
      stagedSessionFork = stageManagedClaudeSessionFork({
        session: sessionFork,
        targetConfigDir: configDir,
      });
    }

    const credential = requireRedisClaudeCredential(runtime.state, label);
    await projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential,
      nowMs,
    });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before native Claude launch" });
    target.lastRunLabel = label;
    delete target.claudeDir;
    delete target.credentialsPath;
    delete target.appStatePath;
    target.lastAppliedAt = observedAt;
    recordCommittedClaudeProjection({
      runtime,
      label,
      record: currentRedisClaudeRecord(runtime, label),
      descriptor,
      homeDir,
      reconciledAt: observedAt,
    });
    const runFence = retainedRunFence ?? await createClaudeRotationFenceForCurrentCredential({
      runtime,
      label,
      recoveryStorageId,
      observedAt,
    });
    await assertClaudeCredentialLeaseOwned({ ...guard, phase: "after creating the shared rotation fence" });

    activeRotationPublisher = startClaudeActiveRotationPublisher({
      runtime,
      homeDir,
      label,
      descriptor,
      fence: runFence,
      guard,
      setTimeoutImpl: setRotationTimer,
      clearTimeoutImpl: clearRotationTimer,
    });
    let launched = null;
    let launchError = null;
    try {
      launched = await runClaudeCliImpl({
        command: preparedLaunch.command,
        userHomeDir: homeDir,
        homeDir: claudeHome,
        configDir,
        cwd: launchCwd,
        args: opts.afterDoubleDash,
        env,
        signal: guard.abortController.signal,
        preparedLaunch,
      });
    } catch (error) {
      launchError = error;
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
      label,
      descriptor,
      nowMs: Date.now(),
    });
    let postRunRecord = null;
    let continuityFailed = guard.heartbeat.lost || activeRotationPublicationFailed;
    if (!continuityFailed) {
      try {
        await assertClaudeCredentialLeaseOwned({ ...guard, phase: "before post-run rotation publication" });
        postRunRecord = await publishClaudeRotationIfNeeded({
          runtime,
          reconciliation: postRunSync,
          label,
          observedAt: new Date().toISOString(),
          fence: runFence,
          descriptor,
          homeDir,
        });
        if (postRunRecord) assertRedisClaudeFenceSuccessor({ record: postRunRecord, fence: runFence });
      } catch {
        continuityFailed = true;
      }
    }
    continuityFailed = continuityFailed
      || guard.heartbeat.lost
      || (
        postRunSync.status !== "candidate"
        && (postRunSync.reason !== "tokens_unchanged" || !launchCompletedCleanly)
      );
    if (continuityFailed) {
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      if (!guard.heartbeat.lost) {
        stdout?.write?.(
          postRunSync.status === "candidate"
            ? `AIM coordination=degraded label=${label} publication=retryable local_candidate=retained\n`
            : `AIM coordination=degraded label=${label} fence=retained retry=next_run\n`,
        );
      }
      if (launchError) throw launchError;
      processResult = safeLaunch;
    } else {
      let fenceCleared = false;
      try {
        const owned = await assertClaudeCredentialLeaseOwned({
          ...guard,
          phase: "before clearing the post-run rotation fence",
          tolerateUnreachable: true,
        });
        if (owned) {
          await clearClaudeRotationFenceOrThrow({
            runtime,
            label,
            fence: runFence,
            lease: guard.lease,
          });
          fenceCleared = true;
        }
      } catch {
        fenceCleared = false;
      }
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      if (!fenceCleared && !guard.heartbeat.lost) {
        stdout?.write?.(
          `AIM coordination=degraded label=${label} fence=retained retry=next_run\n`,
        );
      }
      if (launchError) throw launchError;
      processResult = safeLaunch;
    }
  } catch (error) {
    operationError = error;
  } finally {
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
  if (processResult?.signal) {
    process.kill(process.pid, processResult.signal);
    return;
  }
  if (processResult?.status !== 0) {
    setExitCode(Number.isInteger(processResult?.status) ? processResult.status : 1);
  }
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
      "Missing claude subcommand. Usage: aim claude list [count] [--json] | aim claude resume <row-or-thread-id-or-name> [--account <label>] [--switch-account fable|opus] | aim claude inventory [--json] | aim claude status [account...] [--fresh] [--verbose] [--json] | aim claude run <label> [-- <claude args...>] | aim claude capture-native <label> | aim claude export-live --out <file> | aim claude import-native <label> --in <file>",
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
        "Usage: aim claude resume <row-or-thread-id-or-name> [--account <label>] [--switch-account fable|opus]",
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
    const requestedAccountLabel = opts.claudeResumeAccountLabel
      ? normalizeLabel(opts.claudeResumeAccountLabel)
      : null;
    if (requestedAccountLabel === session.account) {
      throw new Error(
        `Claude session already belongs to label=${session.account}; omit --account to resume it directly.`,
      );
    }
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
    if (!requestedSwitchPreset && !requestedAccountLabel) {
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
    const selected = requestedAccountLabel
      ? { label: requestedAccountLabel }
      : await selectAutomaticClaudeAccount(context, {
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
    const forkReason = requestedAccountLabel
      ? `Switching session from ${session.account} to ${selected.label}`
        + (requestedSwitchPreset ? ` using ${forkPreset}` : "")
      : requestedSwitchPreset
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
      allowOffline: Boolean(requestedAccountLabel),
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
      }, { allowOffline: false });
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
    stdout.write(
      opts.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderClaudeRedisAccountUsageStatus(result, { verbose: opts.verbose === true }),
    );
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
