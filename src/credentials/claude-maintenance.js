import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { acquireRedisCredentialLease } from "../coordination/redis-credential-lease.js";
import {
  publishRedisCredentialPolicyFromState,
  refreshRedisRuntimeState,
  writeRedisLocalStateFromView,
} from "../coordination/runtime.js";
import { getAnthropicCredentialView } from "./anthropic.js";
import { hasCompleteClaudeNativeBundle } from "./claude-bundle.js";
import { syncLiveClaudeRotationBackToLabelFromStorage } from "./claude-native.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveManagedClaudeDir,
} from "../io/paths.js";
import {
  assertRedisClaudeFenceSuccessor,
  clearClaudeRotationFenceOrThrow,
  clearClaudeProjectionReceipt,
  createClaudeRotationFenceForCurrentCredential,
  currentRedisClaudeRecord,
  projectClaudeNativeBundleToManagedConfig,
  publishClaudeRotationIfNeeded,
  recordCommittedClaudeProjection,
} from "../targets/claude-cli.js";
import {
  classifyClaudePreRunFailure,
  runSharedClaudePreRunPreflight,
} from "../targets/claude-preflight.js";
import { runClaudeCliNoninteractive } from "../targets/claude-runner.js";

const MAINTENANCE_TIMEOUT_MS = 30_000;
const MAINTENANCE_LEASE_TTL_MS = 60_000;
const MAINTENANCE_DUE_WINDOW_MS = 5 * 60_000;
// Bounds how long an identical per-account failure may retry before the label
// escalates to reauth_required instead of being retried forever.
const MAINTENANCE_FAILURE_ESCALATE_AFTER_MS = 2 * 60 * 60 * 1000;
const MAINTENANCE_ARGS = Object.freeze([
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--print",
  "--output-format",
  "json",
  "/usage",
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
// Per-account failure classes that can escalate past the escalation window;
// infrastructure-class reasons never do.
const ESCALATABLE_RETRY_REASONS = new Set([
  "client_failed",
  "client_signaled",
  "local_state_conflict",
  "local_state_unreadable",
]);

function maintenanceResult(outcome, reason, detail = null) {
  return Object.freeze({
    outcome,
    reason,
    ...(typeof detail === "string" && detail ? { detail } : {}),
  });
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

// Single-line, bounded, secret-free rendering of the deepest cause message;
// the maintenance messages are state names and guard reasons, not tokens.
function maintenanceDetailFromError(error) {
  let message = "";
  let current = error;
  while (current && typeof current === "object") {
    const candidate = typeof current.message === "string" ? current.message.trim() : "";
    if (candidate && candidate !== "Claude credential maintenance could not complete safely.") {
      message = candidate;
    }
    current = current.cause;
  }
  const detail = message.replace(/["\s]+/g, " ").trim().slice(0, 160);
  return detail || null;
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
    throw maintenanceFailure(classifyClaudePreRunFailure(error, "local_state_conflict"), error);
  }
}

async function clearMaintenanceFence(options) {
  try {
    await clearClaudeRotationFenceOrThrow(options);
  } catch (error) {
    throw maintenanceFailure(classifyClaudePreRunFailure(error, "coordination_unavailable"), error);
  }
}

async function publishMaintenanceCandidate(options) {
  try {
    const record = await publishClaudeRotationIfNeeded(options);
    assertRedisClaudeFenceSuccessor({ record, fence: options.fence });
    return record;
  } catch (error) {
    throw maintenanceFailure(classifyClaudePreRunFailure(error, "publication_failed"), error);
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
 * Time-bounds an identical per-account failure. The streak record lives on the
 * account's reauth state and round-trips through the existing reauth policy
 * fact; past the escalation window the label is published as reauth_required
 * (the status renderer's existing NEEDS YOU fact) instead of retrying forever.
 * Infrastructure-class results and skips never touch the streak.
 */
async function applyMaintenanceEscalation({ runtime, label, homeDir, nowMs, lease, result }) {
  const account = runtime.state.accounts?.[label];
  if (!isObject(account)) return result;
  const reauth = isObject(account.reauth) ? account.reauth : {};
  account.reauth = reauth;
  const streak = isObject(reauth.maintenance) ? reauth.maintenance : null;
  const observedAt = new Date(nowMs).toISOString();

  if (result.outcome === "refreshed" || result.outcome === "unchanged") {
    if (!streak) return result;
    delete reauth.maintenance;
    try {
      await assertLeaseOwned(lease);
      await publishRedisCredentialPolicyFromState({
        runtime,
        state: runtime.state,
        label,
        observedAt,
      });
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    } catch {
      // The pass already succeeded; clearing the stale streak is retried later.
    }
    return result;
  }

  if (result.outcome !== "retryable" || !ESCALATABLE_RETRY_REASONS.has(result.reason)) {
    return result;
  }
  const sameReason = streak?.reason === result.reason
    && Number.isFinite(Date.parse(streak?.firstFailedAt));
  const firstFailedAt = sameReason ? streak.firstFailedAt : observedAt;
  reauth.maintenance = {
    firstFailedAt,
    reason: result.reason,
    count: sameReason && Number.isSafeInteger(streak.count) ? streak.count + 1 : 1,
  };
  const escalated = nowMs - Date.parse(firstFailedAt) >= MAINTENANCE_FAILURE_ESCALATE_AFTER_MS;
  if (escalated) {
    reauth.blockedReason = "oauth_reauth_required";
  }
  try {
    await assertLeaseOwned(lease);
    await publishRedisCredentialPolicyFromState({
      runtime,
      state: runtime.state,
      label,
      observedAt,
    });
  } catch {
    // Keep the original per-account result; the streak/escalation publish is
    // retried on the next pass.
    return result;
  }
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  if (!escalated) return result;
  return maintenanceResult(
    "reauth_required",
    "escalated_persistent_failure",
    `persistent ${result.reason} since ${firstFailedAt}`,
  );
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
      }
    }

    if (!result) {
      // Fence recovery is eligible on every pass; only the /usage probe stays
      // due-gated (the not-due check runs inside the shared preflight, after
      // fence read/recovery).
      let preflight;
      try {
        preflight = await runSharedClaudePreRunPreflight({
          runtime,
          label: normalizedLabel,
          homeDir,
          configDir,
          expectedEmail: requireExpectedEmail(runtime.state, normalizedLabel),
          nowMs,
          resolveCommandImpl: context.resolveExecutableOnPathImpl,
          lease,
          assertLeaseOwned: () => assertLeaseOwned(lease),
          stopAfterFenceRecovery: () => {
            const current = currentRedisClaudeRecord(runtime, normalizedLabel);
            const expiresAtMs = parseExpiresAtToMs(
              getAnthropicCredentialView(current?.credential)?.expiresAt,
            );
            return expiresAtMs !== null && expiresAtMs > nowMs + MAINTENANCE_DUE_WINDOW_MS;
          },
        });
      } catch (error) {
        if (error?.code === "AIMGR_CLAUDE_MAINTENANCE_RETRY") throw error;
        throw maintenanceFailure(classifyClaudePreRunFailure(error, "local_state_conflict"), error);
      }
      if (preflight.deferred) {
        // A young foreign fence is a bounded skip, not a failure; it is not
        // retryable and never counts toward escalation.
        result = maintenanceResult("skipped", "fence_owned_elsewhere");
      } else if (preflight.paused) {
        result = maintenanceResult("skipped", "not_due");
      } else {
        const { descriptor, command, recoveryStorageId, observedAt } = preflight;
        let retainedFence = preflight.retainedFence;

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
          result = maintenanceResult(
            "retryable",
            launchRetryReason,
            launchError
              ? maintenanceDetailFromError(launchError)
              : launchResult?.timedOut === true
                ? `claude /usage timed out after ${MAINTENANCE_TIMEOUT_MS}ms`
                : typeof launchResult?.signal === "string"
                  ? `claude /usage exited on signal ${launchResult.signal}`
                  : `claude /usage exited with status ${launchResult?.status}`,
          );
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
            `post-run storage sync reported ${postRunSync.status}:${postRunSync.reason}`,
          );
        }
      }
    }
  } catch (error) {
    try {
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    } catch {
      // The bounded result is the caller-facing diagnostic.
    }
    result = maintenanceResult(
      "retryable",
      classifyMaintenanceFailure(error),
      maintenanceDetailFromError(error),
    );
  }

  result ??= maintenanceResult("retryable", "maintenance_failed");
  try {
    if (lease) {
      result = await applyMaintenanceEscalation({
        runtime,
        label: normalizedLabel,
        homeDir,
        nowMs,
        lease,
        result,
      });
    }
  } finally {
    if (lease) {
      const released = await lease.release().catch(() => false);
      if (released !== true) result = maintenanceResult("retryable", "lease_release_failed");
    }
  }

  return result;
}
