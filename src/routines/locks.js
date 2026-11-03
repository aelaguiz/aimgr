import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { writeJsonFileIfChanged } from "../io/json-store.js";

function readInterruptedRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    // Power loss may interrupt the initial write. A partial record does not
    // make a worker from the previous boot alive again.
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

// A routine may legitimately run for days. Age alone cannot distinguish it
// from a crash, but no local worker can survive a machine restart. Leave a
// margin for os.uptime()'s rounding when comparing filesystem timestamps.
function predatesBoot(lockPath) {
  try {
    return fs.statSync(lockPath).mtimeMs < Date.now() - os.uptime() * 1_000 - 5_000;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function recoverRoutineLockAfterRestart(lockPath) {
  if (!predatesBoot(lockPath)) return false;

  // Serialize only recovery, then check again: simultaneous launches must not
  // remove a replacement lock another launch just acquired. This short lease
  // covers synchronous filesystem work only, never an agent or account bind.
  const recoveryPath = `${lockPath}.recovery`;
  const release = await lockfile.lock(recoveryPath, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  try {
    if (!predatesBoot(lockPath)) return false;
    const ownerPath = path.join(lockPath, "owner.json");
    // The receipt already preserves the occurrence and native session IDs.
    // Make its interrupted state visible before discarding its obsolete lock.
    const owner = readInterruptedRecord(ownerPath);
    if (owner?.receiptPath) {
      const receipt = readInterruptedRecord(owner.receiptPath);
      if (receipt?.fireKey === owner.fireKey && !receipt.completedAt) {
        writeJsonFileIfChanged(owner.receiptPath, {
          ...receipt,
          outcome: "interrupted",
          completedAt: new Date().toISOString(),
          error: "Machine restarted before this routine finished.",
          needsAttention: true,
        }, { mode: 0o600 });
      }
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    await release();
  }
}
