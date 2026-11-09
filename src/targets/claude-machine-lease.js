import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeLabel } from "../core/normalize.js";
import { resolveAimgrStateDir } from "../io/paths.js";
// Informational same-machine membership only. Native Claude owns local refresh
// serialization; primary grants are independent on different machines.
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
  if (token !== "environment-local") return null;
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
      throw new Error(`Timed out waiting for the local Claude session lock for label=${name}.`);
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
    if (!name.startsWith("local-") || !name.endsWith(".json")) continue;
    const holder = readHolder(path.join(dir, name));
    const live = holder ? holder.members.filter((pid) => isAliveImpl(pid)).length : 0;
    if (live > 0) {
      const label = name.slice("local-".length, -".json".length);
      counts.set(label,(counts.get(label) ?? 0)+live);
    }
  }
  return counts;
}

// Informational same-machine counts survive the end of copied-token leases.
// No session waits for an account held on a different machine.
export async function joinLocalClaudeSessions({homeDir,label,pid=process.pid,isAliveImpl=isProcessAlive}) {
  const name = normalizeLabel(label);
  return withHolderLock(homeDir, `local-${name}`, file => {
    const holder = readHolder(file);
    const members = (holder?.members ?? []).filter(member => member !== pid && isAliveImpl(member));
    writeHolder(file,{token:'environment-local',members:[...members,pid]});
    return async () => withHolderLock(homeDir,`local-${name}`, currentFile => {
      const current = readHolder(currentFile);
      const remaining = (current?.members ?? []).filter(member => member !== pid && isAliveImpl(member));
      if(remaining.length) writeHolder(currentFile,{token:'environment-local',members:remaining});
      else fs.rmSync(currentFile,{force:true});
    });
  });
}
