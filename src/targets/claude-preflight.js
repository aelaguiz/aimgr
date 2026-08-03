import path from "node:path";
import { syncLiveClaudeRotationBackToLabelFromStorage } from "../credentials/claude-native.js";
import {
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
} from "../credentials/claude-native-storage.js";
import { resolveAimgrStateDir, resolveManagedClaudeDir } from "../io/paths.js";
import { publishClaudeRotationIfNeeded } from "./claude-cli.js";

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
 * Shared pre-run path for `aim claude run` and the auth maintainer. Redis is
 * canonical. A strictly newer same-account local credential is published
 * opportunistically under the caller's lease; every other local state is a
 * disposable cache that the caller will replace from Redis.
 *
 * Returns `{ descriptor, command, observedAt, reconciliation, paused }`.
 */
export async function runSharedClaudePreRunPreflight({
  runtime,
  label,
  homeDir,
  configDir,
  expectedEmail,
  nowMs,
  resolveCommandImpl,
  assertLeaseOwned,
  stopBeforeReconciliation = null,
}) {
  const observedAt = new Date(nowMs).toISOString();
  if (
    typeof stopBeforeReconciliation === "function"
    && await stopBeforeReconciliation()
  ) {
    return { descriptor: null, command: null, observedAt, reconciliation: null, paused: true };
  }

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

  const command = resolveCommandImpl?.("claude");
  if (!command || !path.isAbsolute(command)) {
    throw tagClaudePreRunFailure(
      new Error("Could not resolve the installed Claude executable for managed launch."),
      "client_unavailable",
    );
  }

  const preRunSync = await syncLiveClaudeRotationBackToLabelFromStorage({
    state: runtime.state,
    label,
    descriptor,
    nowMs,
  });
  if (preRunSync.status === "candidate") {
    try {
      await assertLeaseOwned("before pre-run rotation publication");
      await publishClaudeRotationIfNeeded({
        runtime,
        reconciliation: preRunSync,
        label,
        observedAt,
      });
    } catch (error) {
      throw preRunPublicationFailure(label, error, classifyClaudePreRunFailure(error, "publication_failed"));
    }
  }

  return { descriptor, command, observedAt, reconciliation: preRunSync, paused: false };
}
