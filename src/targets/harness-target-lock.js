import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { ensureDirectoryMode } from "../io/json-store.js";
import { resolveAimgrStateDir } from "../io/paths.js";

const TARGET_LOCK_OPTIONS = Object.freeze({
  realpath: false,
  retries: Object.freeze({
    retries: 20,
    factor: 1.5,
    minTimeout: 50,
    maxTimeout: 1_000,
    randomize: true,
  }),
  stale: 60_000,
});

export function resolveHarnessTargetMutationLockPath({ homeDir, targetPath }) {
  const normalized = typeof targetPath === "string" && path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : null;
  if (!normalized) throw new Error("Harness target mutation lock requires an absolute target path.");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return path.join(resolveAimgrStateDir({ homeDir }), "locks", "harness-targets", `${digest}.lock`);
}

function ensureLockFile(lockPath, { fsImpl = fs } = {}) {
  ensureDirectoryMode(path.dirname(lockPath), 0o700);
  try {
    const stat = fsImpl.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Refusing unsafe harness target mutation lock file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      fsImpl.writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
    }
  }
  fsImpl.chmodSync(lockPath, 0o600);
}

export async function withHarnessTargetMutationLock({
  homeDir,
  targetPath,
  fsImpl = fs,
  lockfileImpl = lockfile,
  lockOptions,
}, operation) {
  const lockPath = resolveHarnessTargetMutationLockPath({ homeDir, targetPath });
  ensureLockFile(lockPath, { fsImpl });
  let compromised = null;
  const resolvedLockOptions = lockOptions && typeof lockOptions === "object"
    ? {
        ...TARGET_LOCK_OPTIONS,
        ...lockOptions,
        retries: lockOptions.retries && typeof lockOptions.retries === "object"
          ? { ...TARGET_LOCK_OPTIONS.retries, ...lockOptions.retries }
          : lockOptions.retries ?? TARGET_LOCK_OPTIONS.retries,
      }
    : TARGET_LOCK_OPTIONS;
  const release = await lockfileImpl.lock(lockPath, {
    ...resolvedLockOptions,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    if (compromised) throw new Error("Harness target mutation lock was compromised.");
    const result = await operation();
    if (compromised) throw new Error("Harness target mutation lock was compromised.");
    return result;
  } finally {
    try {
      await release();
    } catch {
      if (!compromised) throw new Error("Harness target mutation lock release failed.");
    }
  }
}
