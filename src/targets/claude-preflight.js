import path from "node:path";
import { readRedisClaudeRotationFence } from "../coordination/redis-claude-rotation-fence.js";
import { writeRedisLocalStateFromView } from "../coordination/runtime.js";
import { syncLiveClaudeRotationBackToLabelFromStorage } from "../credentials/claude-native.js";
import {
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
} from "../credentials/claude-native-storage.js";
import { resolveAimgrStateDir, resolveManagedClaudeDir } from "../io/paths.js";
import { ensureLocalInstallationId } from "../state/local-state.js";
import {
  assertRedisClaudeFenceSuccessor,
  assertUnfencedClaudeProjectionIsRecoverable,
  buildClaudeRecoveryStorageId,
  clearClaudeRotationFenceOrThrow,
  createClaudeRotationFenceForCurrentCredential,
  publishClaudeRotationIfNeeded,
  recoverSharedClaudeRotationFence,
} from "./claude-cli.js";

const SAFE_PRE_RUN_STORAGE_REASONS = new Set([
  "authority_import_newer",
  "native_storage_empty",
  "tokens_unchanged",
  "stale_candidate",
]);

// Maps a pre-run guard failure onto the maintainer's retry reason taxonomy.
// Errors already tagged by the maintainer's own helpers keep their reason.
export function classifyClaudePreRunFailure(error, fallback) {
  if (typeof error?.maintenanceReason === "string" && error.maintenanceReason) {
    return error.maintenanceReason;
  }
  const message = `${String(error?.message ?? "")} ${String(error?.cause?.message ?? "")}`;
  if (/unreadable|no complete token lineage/i.test(message)) return "local_state_unreadable";
  if (/stale_version|publication failed|while publishing/i.test(message)) return "publication_failed";
  if (/Redis .* failed|Redis .* timed out/i.test(message)) return "coordination_unavailable";
  if (/could not be cleared safely/i.test(message)) return "lease_lost";
  return fallback;
}

function tagClaudePreRunFailure(error, maintenanceReason) {
  if (
    error
    && typeof error === "object"
    && !(typeof error.maintenanceReason === "string" && error.maintenanceReason)
  ) {
    error.maintenanceReason = maintenanceReason;
  }
  return error;
}

function preRunPublicationFailure(label, error, maintenanceReason) {
  const wrapped = new Error(
    `Claude label=${label} local credential publication failed before launch; retry when Redis is reachable.`,
    { cause: error },
  );
  wrapped.maintenanceReason = maintenanceReason;
  return wrapped;
}

/**
 * Single owner of the pre-run guard pipeline shared by `aim claude run` and
 * the auth maintainer: managed-storage setup, installation/recovery identity,
 * fence read + bounded recovery, sync-back, unfenced-projection assert, and
 * pre-run candidate publication. Errors carry a `maintenanceReason` tag so the
 * maintainer can map them onto its retry taxonomy while the run lane surfaces
 * the operator-facing message.
 *
 * Returns `{ descriptor, command, recoveryStorageId, observedAt, fenceRecovery,
 * retainedFence, deferred, paused }`. `deferred` marks a young foreign fence
 * (each lane decides whether that is a skip or an operator error); `paused`
 * marks a caller-requested stop right after fence recovery (the maintainer's
 * not-due gate), before any storage mutation.
 */
export async function runSharedClaudePreRunPreflight({
  runtime,
  label,
  homeDir,
  configDir,
  expectedEmail,
  nowMs,
  resolveCommandImpl,
  lease,
  assertLeaseOwned,
  stopAfterFenceRecovery = null,
}) {
  let descriptor;
  try {
    descriptor = buildManagedClaudeNativeStorageDescriptor({
      configDir,
      defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
      expectedEmail,
      managedRootDir: resolveAimgrStateDir({ homeDir }),
    });
    ensureSafeManagedClaudeStorage({ descriptor });
  } catch (error) {
    throw tagClaudePreRunFailure(error, "local_state_unreadable");
  }

  const installationId = ensureLocalInstallationId(runtime.localState);
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  const recoveryStorageId = buildClaudeRecoveryStorageId({ installationId, configDir });
  const observedAt = new Date(nowMs).toISOString();

  let existingFence;
  try {
    existingFence = await readRedisClaudeRotationFence(runtime.store, { label });
  } catch (error) {
    throw tagClaudePreRunFailure(error, "coordination_unavailable");
  }
  let fenceRecovery;
  try {
    fenceRecovery = await recoverSharedClaudeRotationFence({
      runtime,
      label,
      fence: existingFence,
      recoveryStorageId,
      descriptor,
      lease,
      assertLeaseOwned,
      homeDir,
      nowMs,
    });
  } catch (error) {
    throw tagClaudePreRunFailure(error, classifyClaudePreRunFailure(error, "local_state_conflict"));
  }
  const base = { descriptor, recoveryStorageId, observedAt, fenceRecovery };
  if (fenceRecovery?.status === "deferred") {
    return { ...base, command: null, retainedFence: null, deferred: true, paused: false };
  }
  if (typeof stopAfterFenceRecovery === "function" && await stopAfterFenceRecovery(base)) {
    return {
      ...base,
      command: null,
      retainedFence: fenceRecovery?.retainedFence ?? null,
      deferred: false,
      paused: true,
    };
  }

  const command = resolveCommandImpl?.("claude");
  if (!command || !path.isAbsolute(command)) {
    throw tagClaudePreRunFailure(
      new Error("Could not resolve the installed Claude executable for managed launch."),
      "client_unavailable",
    );
  }

  let retainedFence = fenceRecovery?.retainedFence ?? null;
  const preRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
    state: runtime.state,
    label,
    descriptor,
    nowMs,
  });
  if (!retainedFence) {
    try {
      assertUnfencedClaudeProjectionIsRecoverable({
        runtime,
        label,
        descriptor,
        reconciliation: preRunSync,
      });
    } catch (error) {
      throw tagClaudePreRunFailure(error, classifyClaudePreRunFailure(error, "local_state_conflict"));
    }
  }

  await assertLeaseOwned("before pre-run rotation reconciliation");
  if (preRunSync.status === "candidate") {
    let preRunFence = retainedFence;
    if (!preRunFence) {
      try {
        preRunFence = await createClaudeRotationFenceForCurrentCredential({
          runtime,
          label,
          recoveryStorageId,
          observedAt,
        });
      } catch (error) {
        throw preRunPublicationFailure(label, error, classifyClaudePreRunFailure(error, "local_state_conflict"));
      }
    }
    try {
      const record = await publishClaudeRotationIfNeeded({
        runtime,
        reconciliation: preRunSync,
        label,
        observedAt,
        fence: preRunFence,
        descriptor,
        homeDir,
      });
      assertRedisClaudeFenceSuccessor({ record, fence: preRunFence });
    } catch (error) {
      throw preRunPublicationFailure(label, error, classifyClaudePreRunFailure(error, "publication_failed"));
    }
    try {
      await assertLeaseOwned("before clearing the pre-run rotation fence");
      await clearClaudeRotationFenceOrThrow({ runtime, label, fence: preRunFence, lease });
    } catch (error) {
      throw preRunPublicationFailure(label, error, classifyClaudePreRunFailure(error, "coordination_unavailable"));
    }
    if (preRunFence === retainedFence) retainedFence = null;
  } else if (preRunSync.status !== "unchanged" || !SAFE_PRE_RUN_STORAGE_REASONS.has(preRunSync.reason)) {
    throw tagClaudePreRunFailure(
      new Error(`Claude managed storage reconciliation blocked: ${preRunSync.status}:${preRunSync.reason}.`),
      preRunSync.status === "unreadable" ? "local_state_unreadable" : "local_state_conflict",
    );
  }

  return { ...base, command, retainedFence, deferred: false, paused: false };
}
