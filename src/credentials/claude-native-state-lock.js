import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

/** Join the reviewed client's existing file-store locks, not a new registry.
 *
 * Claude 2.1.316 secure storage mutate() takes .storage-write.lock before
 * invalidating its cache, rereading and writing MCP/OAuth/package secrets.
 * Its app-state writer takes <selected-config>.lock around its own RMW.
 * AIM's SH assignment guard deliberately allows those native writers, so
 * snapshot/merge/publication/rollback must also hold these native locks.
 * Lock both known config selectors because ordinary accounts retain legacy
 * selection. The stopped EX migration retires legacy separately.
 *
 * Async acquisition waits for a short native write without limiting sessions.
 * Critical callers perform only local synchronous reads/writes while held;
 * never hold these locks across HTTP, a model request or vendor startup.
 */
export async function withClaudeNativeStateLocks({ configDir, appStatePath, refresh = false, fsImpl = fs }, operation) {
  const releases = [];
  let compromised = false;
  try {
    if (![configDir, appStatePath].every(value => typeof value === "string" && path.isAbsolute(value))) {
      throw new Error("invalid paths");
    }
    fsImpl.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Pinned 2.1.317 f0i: the new refresh lock precedes the realpath
    // legacy sibling. Wait for network refresh BEFORE taking storage locks.
    if (refresh) for (const lockPath of [path.join(configDir, ".oauth_refresh.lock"), `${fsImpl.realpathSync(configDir)}.lock`]) {
      releases.push(await lockfile.lock(configDir, { fs: fsImpl, realpath: false,
        lockfilePath: lockPath, stale: 60_000, update: 5_000,
        retries: {retries: 35,minTimeout:100,maxTimeout:1000},
        onCompromised: () => { compromised = true; } }));
    }
    const files = [{ file: path.join(configDir.normalize("NFC"), ".storage-write"), stale: 15_000 },
      ...[...new Set([appStatePath, path.join(configDir.normalize("NFC"), ".config.json")])].sort()
        .map(file => ({ file, stale: 10_000 }))];
    for (const { file, stale } of files) {
      releases.push(await lockfile.lock(file, { fs: fsImpl, realpath: false,
        lockfilePath: `${file}.lock`, stale,
        retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
        onCompromised: () => { compromised = true; } }));
    }
    if (compromised) throw new Error("native state lock lost");
    const result = operation();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      throw new Error("native state mutation must be synchronous");
    }
    if (compromised) throw new Error("native state lock lost");
    return result;
  } catch (error) {
    if (!releases.length || compromised || ["ELOCKED", "ECOMPROMISED"].includes(error?.code)) {
      throw new Error("Claude native state is busy or its write lock was lost; retry after the current credential update finishes.");
    }
    throw error;
  } finally {
    let failed = false;
    for (const release of releases.reverse()) {
      try { await release(); } catch { failed = true; }
    }
    if (failed) throw new Error("Claude native state lock could not be released safely; inspect it before retrying.");
  }
}
