import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Non-time-stealable owner lock for the one AIM-managed rotating Codex home.
 *
 * The lock is an atomically created directory beside the managed home with
 * owner metadata `{ managerPid, childPid, nonce, createdAt, phase }`. It is
 * held from fresh Redis read/selection until the launched Codex child exits.
 *
 * Recovery removes an existing lock only when every recorded process is
 * proven dead via signal-0 liveness. Age, missed heartbeats, or macOS sleep
 * never authorize stealing, and ambiguous liveness (EPERM, unreadable
 * metadata, or a spawn that may have started an unrecorded child) fails
 * closed for operator cleanup.
 */

export const CODEX_RUN_LOCK_PHASE_SELECTING = "selecting";
export const CODEX_RUN_LOCK_PHASE_SPAWNING = "spawning";
export const CODEX_RUN_LOCK_PHASE_RUNNING = "running";

export class CodexRunLockHeldError extends Error {
  constructor({ lockDir, reason, owner = null }) {
    super(
      `Another \`aim codex run\` owns the managed Codex home (${reason}). `
        + `If you are certain no run is active, inspect and remove ${lockDir} manually.`,
    );
    this.name = "CodexRunLockHeldError";
    this.code = "codex_run_lock_held";
    this.reason = reason;
    this.lockDir = lockDir;
    this.owner = owner;
  }
}

export function resolveCodexRunLockDir(managedCodexHome) {
  const home = String(managedCodexHome ?? "").trim();
  if (!home) throw new Error("Missing managed Codex home for run lock.");
  // Sibling of the managed home so the Codex child never sees lock files
  // inside its own CODEX_HOME.
  return `${path.resolve(home)}.lock`;
}

function ownerFilePath(lockDir) {
  return path.join(lockDir, "owner.json");
}

/**
 * Signal-0 liveness. `null` means the process is provably dead; a pid value
 * that errors with EPERM (or anything other than ESRCH) counts as alive
 * because uncertainty must fail closed.
 */
export function processIsProvenDead(pid, { killImpl = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    killImpl(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

function readOwnerMetadata(lockDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFilePath(lockDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function classifyExistingLock(lockDir, { killImpl } = {}) {
  const owner = readOwnerMetadata(lockDir);
  if (!owner || !Number.isInteger(owner.managerPid) || typeof owner.nonce !== "string" || !owner.nonce) {
    // Unreadable or torn metadata: nothing is proven, so nothing may be stolen.
    return { removable: false, reason: "owner_metadata_unreadable", owner: null };
  }
  const managerDead = processIsProvenDead(owner.managerPid, { killImpl });
  if (!managerDead) {
    return { removable: false, reason: "manager_alive", owner };
  }
  if (owner.phase === CODEX_RUN_LOCK_PHASE_SPAWNING && !Number.isInteger(owner.childPid)) {
    // The dead manager may have started a child it never recorded. That is
    // ambiguous, and ambiguity fails closed.
    return { removable: false, reason: "spawn_outcome_unknown", owner };
  }
  if (Number.isInteger(owner.childPid) && !processIsProvenDead(owner.childPid, { killImpl })) {
    return { removable: false, reason: "child_alive", owner };
  }
  return { removable: true, reason: "owner_processes_proven_dead", owner };
}

function writeOwnerFile(lockDir, owner) {
  const tmpPath = path.join(lockDir, `.owner.${owner.nonce}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, ownerFilePath(lockDir));
}

export function acquireCodexRunLock({
  managedCodexHome,
  managerPid = process.pid,
  nowIso = new Date().toISOString(),
  killImpl = process.kill,
} = {}) {
  const lockDir = resolveCodexRunLockDir(managedCodexHome);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const existing = classifyExistingLock(lockDir, { killImpl });
      if (!existing.removable || attempt > 0) {
        throw new CodexRunLockHeldError({ lockDir, reason: existing.reason, owner: existing.owner });
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  const owner = {
    managerPid,
    childPid: null,
    nonce: randomUUID(),
    createdAt: nowIso,
    phase: CODEX_RUN_LOCK_PHASE_SELECTING,
  };
  writeOwnerFile(lockDir, owner);

  let released = false;

  function assertStillOwned() {
    const current = readOwnerMetadata(lockDir);
    if (!current || current.nonce !== owner.nonce) {
      throw new Error(`Managed Codex run lock at ${lockDir} is no longer owned by this process; aborting.`);
    }
  }

  return Object.freeze({
    lockDir,
    nonce: owner.nonce,

    /** Marks the window where a child may exist but is not yet recorded. */
    markSpawning() {
      assertStillOwned();
      owner.phase = CODEX_RUN_LOCK_PHASE_SPAWNING;
      writeOwnerFile(lockDir, owner);
    },

    recordChildPid(childPid) {
      if (!Number.isInteger(childPid) || childPid <= 0) {
        throw new Error("Cannot record an invalid Codex child pid on the run lock.");
      }
      assertStillOwned();
      owner.childPid = childPid;
      owner.phase = CODEX_RUN_LOCK_PHASE_RUNNING;
      writeOwnerFile(lockDir, owner);
    },

    /** Records that the spawn definitively failed before a child existed. */
    markSpawnFailed() {
      assertStillOwned();
      owner.phase = CODEX_RUN_LOCK_PHASE_SELECTING;
      owner.childPid = null;
      writeOwnerFile(lockDir, owner);
    },

    release() {
      if (released) return false;
      released = true;
      const current = readOwnerMetadata(lockDir);
      if (current && current.nonce !== owner.nonce) {
        // Someone recovered or replaced the lock; never delete their state.
        return false;
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    },

    readOwner() {
      return readOwnerMetadata(lockDir);
    },
  });
}

/** Read-only lock state for status projection: booleans and pids only. */
export function readCodexRunLockStatus({ managedCodexHome, killImpl = process.kill } = {}) {
  const lockDir = resolveCodexRunLockDir(managedCodexHome);
  if (!fs.existsSync(lockDir)) {
    return { locked: false, lockDir };
  }
  const owner = readOwnerMetadata(lockDir);
  const existing = classifyExistingLock(lockDir, { killImpl });
  return {
    locked: true,
    lockDir,
    ownerReadable: Boolean(owner),
    phase: typeof owner?.phase === "string" ? owner.phase : null,
    createdAt: typeof owner?.createdAt === "string" ? owner.createdAt : null,
    managerAlive: owner ? !processIsProvenDead(owner.managerPid, { killImpl }) : null,
    childRecorded: Boolean(owner && Number.isInteger(owner.childPid)),
    childAlive: owner && Number.isInteger(owner.childPid)
      ? !processIsProvenDead(owner.childPid, { killImpl })
      : null,
    recoverable: existing.removable,
    reason: existing.reason,
  };
}
