import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeLabel } from "../core/normalize.js";
import { resolveAimgrStateDir } from "../io/paths.js";
import {
  acquireRedisCredentialLease,
  joinRedisCredentialLease,
  readRedisCredentialLeaseToken,
} from "../coordination/redis-credential-lease.js";

// Every AIM session for one Claude account on one machine runs in the same
// account folder and shares its login file, and Claude Code serializes their
// token refreshes with its own lock in that folder. Only another machine with
// a copy of the refresh token can collide. So the Redis lease belongs to the
// machine: the first session takes it, later sessions on the same machine
// join with the same token, and the last session to exit releases it.

// The locked section is one small file update and one Redis call.
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 30_000;

function resolveHolderDir(homeDir) {
  return path.join(resolveAimgrStateDir({ homeDir }), "runtime", "claude-leases");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readHolder(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const token = typeof parsed?.token === "string" && parsed.token ? parsed.token : null;
  if (!token) return null;
  const members = Array.isArray(parsed.members)
    ? parsed.members.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    : [];
  return { token, members };
}

function writeHolder(filePath, holder) {
  const staged = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(staged, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  fs.renameSync(staged, filePath);
}

async function withHolderLock(homeDir, label, operation) {
  const dir = resolveHolderDir(homeDir);
  const name = normalizeLabel(label);
  const lockPath = path.join(dir, `${name}.lock`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let lockAgeMs = 0;
    try {
      lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    // A crashed session can leave its lock behind.
    if (lockAgeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the local Claude lease lock for label=${name}.`);
    }
    await sleep(50 + Math.floor(Math.random() * 100));
  }
  try {
    return await operation(path.join(dir, `${name}.json`));
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Joins this machine's lease for a Claude account, or takes it when no session
 * on this machine holds it. Returns `{ lease, siblings }`, or null when another
 * machine or an exclusive AIM operation holds the account.
 */
export async function joinMachineClaudeLease({
  homeDir,
  store,
  provider,
  label,
  pid = process.pid,
  isAliveImpl = isProcessAlive,
}) {
  return withHolderLock(homeDir, label, async (filePath) => {
    const holder = readHolder(filePath);
    let lease = holder
      ? await joinRedisCredentialLease(store, { provider, label, token: holder.token })
      : null;
    lease ??= await acquireRedisCredentialLease(store, { provider, label });
    if (!lease) return null;
    const token = readRedisCredentialLeaseToken(lease);
    // A new token means any earlier local members no longer own the lease.
    const siblings = token === holder?.token
      ? holder.members.filter((member) => member !== pid && isAliveImpl(member))
      : [];
    writeHolder(filePath, { token, members: [...siblings, pid] });
    return { lease, siblings: siblings.length };
  });
}

/**
 * Leaves this machine's lease. The Redis lease is released only when no other
 * live session on this machine still shares it.
 */
export async function leaveMachineClaudeLease({
  homeDir,
  label,
  lease,
  pid = process.pid,
  isAliveImpl = isProcessAlive,
}) {
  return withHolderLock(homeDir, label, async (filePath) => {
    const holder = readHolder(filePath);
    const ownsHolder = holder !== null && holder.token === readRedisCredentialLeaseToken(lease);
    const remaining = ownsHolder
      ? holder.members.filter((member) => member !== pid && isAliveImpl(member))
      : [];
    if (remaining.length > 0) {
      writeHolder(filePath, { token: holder.token, members: remaining });
      return { released: false, remaining: remaining.length };
    }
    if (ownsHolder) fs.rmSync(filePath, { force: true });
    return { released: await lease.release(), remaining: 0 };
  });
}

/**
 * Counts live AIM Claude sessions per account on this machine.
 */
export function readMachineClaudeSessionCounts({ homeDir, isAliveImpl = isProcessAlive }) {
  const counts = new Map();
  const dir = resolveHolderDir(homeDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return counts;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const holder = readHolder(path.join(dir, name));
    const live = holder ? holder.members.filter((pid) => isAliveImpl(pid)).length : 0;
    if (live > 0) counts.set(name.slice(0, -".json".length), live);
  }
  return counts;
}
