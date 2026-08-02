import path from "node:path";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { acquireRedisCredentialLease } from "../coordination/redis-credential-lease.js";
import { readRedisClaudeRotationFence } from "../coordination/redis-claude-rotation-fence.js";
import {
  publishRedisCredentialPolicyFromState,
  refreshRedisRuntimeState,
  writeRedisLocalStateFromView,
} from "../coordination/runtime.js";
import { getAnthropicCredentialView } from "./anthropic.js";
import { hasCompleteClaudeNativeBundle } from "./claude-bundle.js";
import { syncLiveClaudeRotationBackToLabelFromStorage } from "./claude-native.js";
import {
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
} from "./claude-native-storage.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveAimgrStateDir,
  resolveManagedClaudeDir,
} from "../io/paths.js";
import { ensureLocalInstallationId } from "../state/local-state.js";
import {
  assertRedisClaudeFenceSuccessor,
  assertUnfencedClaudeProjectionIsRecoverable,
  buildClaudeRecoveryStorageId,
  clearClaudeRotationFenceOrThrow,
  clearClaudeProjectionReceipt,
  createClaudeRotationFenceForCurrentCredential,
  currentRedisClaudeRecord,
  projectClaudeNativeBundleToManagedConfig,
  publishClaudeRotationIfNeeded,
  recordCommittedClaudeProjection,
  recoverSharedClaudeRotationFence,
} from "../targets/claude-cli.js";
import { runClaudeCliNoninteractive } from "../targets/claude-runner.js";

const MAINTENANCE_TIMEOUT_MS = 30_000;
const MAINTENANCE_LEASE_TTL_MS = 60_000;
const MAINTENANCE_DUE_WINDOW_MS = 5 * 60_000;
const MAINTENANCE_ARGS = Object.freeze([
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--print",
  "--output-format",
  "json",
  "/usage",
]);
const SAFE_PRE_RUN_REASONS = new Set([
  "authority_import_newer",
  "native_storage_empty",
  "tokens_unchanged",
  "stale_candidate",
]);
const RETRY_REASONS = new Set([
  "client_failed",
  "client_signaled",
  "client_timeout",
  "client_unavailable",
  "coordination_unavailable",
  "lease_lost",
  "lease_release_failed",
  "local_state_conflict",
  "local_state_unreadable",
  "maintenance_failed",
  "publication_failed",
]);

function maintenanceResult(outcome, reason) {
  return Object.freeze({ outcome, reason });
}

function maintenanceFailure(reason, cause) {
  const error = new Error("Claude credential maintenance could not complete safely.", { cause });
  error.code = "AIMGR_CLAUDE_MAINTENANCE_RETRY";
  error.maintenanceReason = RETRY_REASONS.has(reason) ? reason : "maintenance_failed";
  return error;
}

function classifyMaintenanceFailure(error) {
  return RETRY_REASONS.has(error?.maintenanceReason)
    ? error.maintenanceReason
    : "maintenance_failed";
}

function classifyRotationFailure(error, fallback) {
  if (RETRY_REASONS.has(error?.maintenanceReason)) return error.maintenanceReason;
  const message = `${String(error?.message ?? "")} ${String(error?.cause?.message ?? "")}`;
  if (/unreadable|no complete token lineage/i.test(message)) return "local_state_unreadable";
  if (/stale_version|publication failed|while publishing/i.test(message)) return "publication_failed";
  if (/Redis .* failed|Redis .* timed out/i.test(message)) return "coordination_unavailable";
  if (/could not be cleared safely/i.test(message)) return "lease_lost";
  return fallback;
}

async function assertLeaseOwned(lease) {
  let renewed;
  try {
    renewed = await lease.renew();
  } catch (error) {
    throw maintenanceFailure("coordination_unavailable", error);
  }
  if (renewed !== true) throw maintenanceFailure("lease_lost");
}

async function createMaintenanceFence(options) {
  try {
    return await createClaudeRotationFenceForCurrentCredential(options);
  } catch (error) {
    throw maintenanceFailure(classifyRotationFailure(error, "local_state_conflict"), error);
  }
}

async function clearMaintenanceFence(options) {
  try {
    await clearClaudeRotationFenceOrThrow(options);
  } catch (error) {
    throw maintenanceFailure(classifyRotationFailure(error, "coordination_unavailable"), error);
  }
}

async function publishMaintenanceCandidate(options) {
  try {
    const record = await publishClaudeRotationIfNeeded(options);
    assertRedisClaudeFenceSuccessor({ record, fence: options.fence });
    return record;
  } catch (error) {
    throw maintenanceFailure(classifyRotationFailure(error, "publication_failed"), error);
  }
}

function requireCredential(runtime, label) {
  const credential = runtime.state?.credentials?.[ANTHROPIC_PROVIDER]?.[label];
  if (!isObject(credential)) throw maintenanceFailure("local_state_conflict");
  return credential;
}

function requireExpectedEmail(state, label) {
  const expectedEmail = typeof state?.accounts?.[label]?.expect?.email === "string"
    ? state.accounts[label].expect.email.trim().toLowerCase()
    : "";
  if (!expectedEmail) throw maintenanceFailure("local_state_conflict");
  return expectedEmail;
}

/**
 * Runs one due Claude OAuth refresh attempt inside an already-loaded, one-shot
 * Redis runtime. It does not resolve sessions, apply optional customization,
 * start the supervisor, or load another runtime.
 */
export async function maintainRedisClaudeCredential(context, { runtime, label }) {
  if (!runtime?.store || !runtime?.state || !runtime?.localState) {
    throw new Error("Claude credential maintenance requires an already-loaded Redis runtime.");
  }

  const normalizedLabel = normalizeLabel(label);
  const homeDir = context.homeDir;
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label: normalizedLabel });
  const configDir = resolveManagedClaudeDir({ homeDir: claudeHome });
  const maintenanceEnv = { ...(context.env ?? {}) };
  delete maintenanceEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  const runNoninteractiveImpl = context.runClaudeCliNoninteractiveImpl
    ?? runClaudeCliNoninteractive;
  let lease = null;
  let result = null;

  try {
    try {
      lease = await acquireRedisCredentialLease(runtime.store, {
        provider: ANTHROPIC_PROVIDER,
        label: normalizedLabel,
        ttlMs: MAINTENANCE_LEASE_TTL_MS,
      });
    } catch (error) {
      throw maintenanceFailure("coordination_unavailable", error);
    }
    if (!lease) result = maintenanceResult("skipped", "lease_busy");

    if (!result) {
      try {
        await refreshRedisRuntimeState(runtime);
      } catch (error) {
        throw maintenanceFailure("coordination_unavailable", error);
      }
      await assertLeaseOwned(lease);
      const record = currentRedisClaudeRecord(runtime, normalizedLabel);
      const credentialLoaded = isObject(record?.credential)
        && Object.keys(record.credential).length > 0;
      if (!record) {
        result = maintenanceResult("skipped", "record_missing");
      } else if (record.policy?.reauth?.blockedReason === "oauth_reauth_required") {
        result = maintenanceResult("skipped", "reauth_already_required");
      } else if (!credentialLoaded) {
        result = maintenanceResult("skipped", "credential_missing");
      } else if (!hasCompleteClaudeNativeBundle(record.credential)) {
        const account = runtime.state.accounts?.[normalizedLabel];
        if (!isObject(account)) {
          result = maintenanceResult("skipped", "record_missing");
        } else {
          account.reauth = {
            ...(isObject(account.reauth) ? account.reauth : {}),
            blockedReason: "oauth_reauth_required",
          };
          await assertLeaseOwned(lease);
          try {
            await publishRedisCredentialPolicyFromState({
              runtime,
              state: runtime.state,
              label: normalizedLabel,
              observedAt: new Date(nowMs).toISOString(),
            });
          } catch (error) {
            throw maintenanceFailure("publication_failed", error);
          }
          writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
          result = maintenanceResult("reauth_required", "refresh_material_missing");
        }
      } else {
        const expiresAtMs = parseExpiresAtToMs(
          getAnthropicCredentialView(record.credential)?.expiresAt,
        );
        if (expiresAtMs !== null && expiresAtMs > nowMs + MAINTENANCE_DUE_WINDOW_MS) {
          result = maintenanceResult("skipped", "not_due");
        }
      }
    }

    if (!result) {
      let descriptor;
      try {
        descriptor = buildManagedClaudeNativeStorageDescriptor({
          configDir,
          defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
          expectedEmail: requireExpectedEmail(runtime.state, normalizedLabel),
          managedRootDir: resolveAimgrStateDir({ homeDir }),
        });
        ensureSafeManagedClaudeStorage({ descriptor });
      } catch (error) {
        if (error?.code === "AIMGR_CLAUDE_MAINTENANCE_RETRY") throw error;
        throw maintenanceFailure("local_state_unreadable", error);
      }

      const command = context.resolveExecutableOnPathImpl?.("claude");
      if (!command || !path.isAbsolute(command)) throw maintenanceFailure("client_unavailable");

      const installationId = ensureLocalInstallationId(runtime.localState);
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      const recoveryStorageId = buildClaudeRecoveryStorageId({ installationId, configDir });
      const observedAt = new Date(nowMs).toISOString();
      let existingFence;
      try {
        existingFence = await readRedisClaudeRotationFence(runtime.store, {
          label: normalizedLabel,
        });
      } catch (error) {
        throw maintenanceFailure("coordination_unavailable", error);
      }
      let fenceRecovery;
      try {
        fenceRecovery = await recoverSharedClaudeRotationFence({
          runtime,
          label: normalizedLabel,
          fence: existingFence,
          recoveryStorageId,
          descriptor,
          lease,
          assertLeaseOwned: () => assertLeaseOwned(lease),
          homeDir,
          nowMs,
        });
      } catch (error) {
        throw maintenanceFailure(classifyRotationFailure(error, "local_state_conflict"), error);
      }
      let retainedFence = fenceRecovery?.retainedFence ?? null;
      const preRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
        state: runtime.state,
        label: normalizedLabel,
        descriptor,
        nowMs,
      });
      if (!retainedFence) {
        try {
          assertUnfencedClaudeProjectionIsRecoverable({
            runtime,
            label: normalizedLabel,
            descriptor,
            reconciliation: preRunSync,
          });
        } catch (error) {
          throw maintenanceFailure(
            /unreadable|no complete token lineage/i.test(String(error?.message ?? ""))
              ? "local_state_unreadable"
              : "local_state_conflict",
            error,
          );
        }
      }
      if (preRunSync.status === "unreadable") throw maintenanceFailure("local_state_unreadable");
      if (preRunSync.status === "lineage_conflict") throw maintenanceFailure("local_state_conflict");

      await assertLeaseOwned(lease);
      if (preRunSync.status === "candidate") {
        const preRunFence = retainedFence ?? await createMaintenanceFence({
          runtime,
          label: normalizedLabel,
          recoveryStorageId,
          observedAt,
        });
        await publishMaintenanceCandidate({
          runtime,
          reconciliation: preRunSync,
          label: normalizedLabel,
          observedAt,
          fence: preRunFence,
          descriptor,
          homeDir,
        });
        await assertLeaseOwned(lease);
        await clearMaintenanceFence({
          runtime,
          label: normalizedLabel,
          fence: preRunFence,
          lease,
        });
        if (preRunFence === retainedFence) retainedFence = null;
      } else if (!SAFE_PRE_RUN_REASONS.has(preRunSync.reason)) {
        throw maintenanceFailure("local_state_conflict");
      }

      const credential = requireCredential(runtime, normalizedLabel);
      const preRunCredentialComplete = hasCompleteClaudeNativeBundle(credential);
      await projectClaudeNativeBundleToManagedConfig({ descriptor, credential, nowMs });
      const target = runtime.state.targets.claudeCli;
      target.lastRunLabel = normalizedLabel;
      delete target.claudeDir;
      delete target.credentialsPath;
      delete target.appStatePath;
      target.lastAppliedAt = observedAt;
      try {
        recordCommittedClaudeProjection({
          runtime,
          label: normalizedLabel,
          record: currentRedisClaudeRecord(runtime, normalizedLabel),
          descriptor,
          homeDir,
          reconciledAt: observedAt,
        });
      } catch (error) {
        throw maintenanceFailure("local_state_conflict", error);
      }
      const runFence = retainedFence ?? await createMaintenanceFence({
        runtime,
        label: normalizedLabel,
        recoveryStorageId,
        observedAt,
      });
      await assertLeaseOwned(lease);

      let launchResult = null;
      let launchError = null;
      try {
        launchResult = await runNoninteractiveImpl({
          command,
          userHomeDir: homeDir,
          homeDir: claudeHome,
          configDir,
          cwd: context.cwd ?? process.cwd(),
          args: MAINTENANCE_ARGS,
          env: maintenanceEnv,
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
        });
      } catch (error) {
        launchError = error;
      }

      const postRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
        state: runtime.state,
        label: normalizedLabel,
        descriptor,
        nowMs,
      });
      if (postRunSync.status === "candidate") {
        await assertLeaseOwned(lease);
        await publishMaintenanceCandidate({
          runtime,
          reconciliation: postRunSync,
          label: normalizedLabel,
          observedAt,
          fence: runFence,
          descriptor,
          homeDir,
        });
      }

      const launchRetryReason = launchError
        ? "client_failed"
        : launchResult?.timedOut === true
          ? "client_timeout"
          : typeof launchResult?.signal === "string"
            ? "client_signaled"
            : launchResult?.status !== 0
              ? "client_failed"
              : null;
      if (launchRetryReason) {
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        result = maintenanceResult("retryable", launchRetryReason);
      } else if (
        preRunCredentialComplete
        && postRunSync.status === "unchanged"
        && postRunSync.reason === "native_storage_empty"
      ) {
        await assertLeaseOwned(lease);
        await clearMaintenanceFence({
          runtime,
          label: normalizedLabel,
          fence: runFence,
          lease,
        });
        clearClaudeProjectionReceipt({ state: runtime.state, label: normalizedLabel });
        runtime.state.accounts[normalizedLabel].reauth = {
          ...(isObject(runtime.state.accounts[normalizedLabel].reauth)
            ? runtime.state.accounts[normalizedLabel].reauth
            : {}),
          blockedReason: "oauth_reauth_required",
        };
        try {
          await publishRedisCredentialPolicyFromState({
            runtime,
            state: runtime.state,
            label: normalizedLabel,
            observedAt,
          });
        } catch (error) {
          throw maintenanceFailure("publication_failed", error);
        }
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        result = maintenanceResult("reauth_required", "native_session_expired");
      } else if (
        postRunSync.status === "candidate"
        || (postRunSync.status === "unchanged" && postRunSync.reason === "tokens_unchanged")
      ) {
        await assertLeaseOwned(lease);
        await clearMaintenanceFence({
          runtime,
          label: normalizedLabel,
          fence: runFence,
          lease,
        });
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        result = maintenanceResult(
          postRunSync.status === "candidate" ? "refreshed" : "unchanged",
          postRunSync.status === "candidate" ? "credential_rotated" : "tokens_unchanged",
        );
      } else {
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        result = maintenanceResult(
          "retryable",
          postRunSync.status === "unreadable"
            ? "local_state_unreadable"
            : "local_state_conflict",
        );
      }
    }
  } catch (error) {
    try {
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    } catch {
      // The bounded result is the caller-facing diagnostic.
    }
    result = maintenanceResult("retryable", classifyMaintenanceFailure(error));
  } finally {
    if (lease) {
      const released = await lease.release().catch(() => false);
      if (released !== true) result = maintenanceResult("retryable", "lease_release_failed");
    }
  }

  return result ?? maintenanceResult("retryable", "maintenance_failed");
}
