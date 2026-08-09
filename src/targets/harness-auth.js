import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { ensureDirectoryMode, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveAimgrStateDir } from "../io/paths.js";

export const HARNESS_EXTERNAL_PROTOCOL = "aimgr-credential-v1";
export const HARNESS_MANAGED_PROVIDERS = Object.freeze([
  OPENAI_CODEX_PROVIDER,
  ANTHROPIC_PROVIDER,
]);

const IDENTITY_FINGERPRINT_PATTERN = /^aimgr-id-v1:[A-Za-z0-9_-]{43}$/;
const DEFAULT_AIM_EXECUTABLE = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
const LOCK_OPTIONS = Object.freeze({
  retries: Object.freeze({
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  }),
  stale: 30_000,
});

function assertProvider(provider) {
  if (!HARNESS_MANAGED_PROVIDERS.includes(provider)) {
    throw new Error("Harness target provider must be openai-codex or anthropic.");
  }
  return provider;
}

function assertTargetId(targetId) {
  if (targetId !== "pi" && targetId !== "prime") {
    throw new Error("Harness target must be pi or prime.");
  }
  return targetId;
}

function assertSafePathComponent(value) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error("Unsafe harness target backup path component.");
  }
}

export function resolveHarnessOwnedAuthPath({ targetState, resolvedAuthPath }) {
  const resolved = typeof resolvedAuthPath === "string" && path.isAbsolute(resolvedAuthPath)
    ? path.resolve(resolvedAuthPath)
    : null;
  if (!resolved) throw new Error("Resolved harness auth path must be absolute.");
  const persistedValue = typeof targetState?.authPath === "string" ? targetState.authPath.trim() : "";
  if (persistedValue && !path.isAbsolute(persistedValue)) {
    throw new Error("Persisted harness auth ownership path must be absolute.");
  }
  const persistedAuthPath = persistedValue ? path.resolve(persistedValue) : null;
  return Object.freeze({
    authPath: persistedAuthPath ?? resolved,
    resolvedAuthPath: resolved,
    persistedAuthPath,
    pathConflict: Boolean(persistedAuthPath && persistedAuthPath !== resolved),
  });
}

export function resolveTrustedAimExecutable({ executable = DEFAULT_AIM_EXECUTABLE, fsImpl = fs } = {}) {
  const absolute = typeof executable === "string" && path.isAbsolute(executable)
    ? path.resolve(executable)
    : null;
  if (!absolute) throw new Error("AIM helper executable must be an absolute path.");
  let resolved;
  try {
    resolved = fsImpl.realpathSync(absolute);
    const stat = fsImpl.statSync(resolved);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new Error("untrusted executable");
    }
    fsImpl.accessSync(resolved, fs.constants.X_OK);
    let parent = path.dirname(resolved);
    while (true) {
      const parentStat = fsImpl.statSync(parent);
      if (!parentStat.isDirectory() || (parentStat.mode & 0o022) !== 0) {
        throw new Error("untrusted parent");
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  } catch {
    throw new Error("AIM helper executable is not owner-trusted.");
  }
  return resolved;
}

export function buildHarnessExternalDescriptor({
  executable,
  binding,
  expectedIdentityFingerprint,
}) {
  const rawBinding = typeof binding === "string" ? binding.trim() : "";
  let normalizedBinding = null;
  try {
    normalizedBinding = normalizeLabel(rawBinding);
  } catch {
    throw new Error("Harness external descriptor requires an exact binding and identity fingerprint.");
  }
  const fingerprint = typeof expectedIdentityFingerprint === "string"
    ? expectedIdentityFingerprint.trim()
    : "";
  if (normalizedBinding !== rawBinding || !IDENTITY_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error("Harness external descriptor requires an exact binding and identity fingerprint.");
  }
  return Object.freeze({
    type: "external",
    source: "aimgr",
    protocol: HARNESS_EXTERNAL_PROTOCOL,
    executable: resolveTrustedAimExecutable({ executable }),
    args: Object.freeze(["credential-helper"]),
    binding: normalizedBinding,
    expectedIdentityFingerprint: fingerprint,
  });
}

function isCanonicalBinding(value) {
  try {
    return typeof value === "string" && normalizeLabel(value) === value;
  } catch {
    return false;
  }
}

export function isAimHarnessExternalDescriptor(value) {
  return isObject(value)
    && value.type === "external"
    && value.source === "aimgr"
    && value.protocol === HARNESS_EXTERNAL_PROTOCOL
    && typeof value.executable === "string"
    && path.isAbsolute(value.executable)
    && Array.isArray(value.args)
    && value.args.length === 1
    && value.args[0] === "credential-helper"
    && isCanonicalBinding(value.binding)
    && typeof value.expectedIdentityFingerprint === "string"
    && IDENTITY_FINGERPRINT_PATTERN.test(value.expectedIdentityFingerprint);
}

function ensureAuthFile(authPath, { fsImpl = fs } = {}) {
  ensureDirectoryMode(path.dirname(authPath), 0o700);
  try {
    const stat = fsImpl.lstatSync(authPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Refusing unsafe harness auth file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      fsImpl.writeFileSync(authPath, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      const raced = fsImpl.lstatSync(authPath);
      if (!raced.isFile() || raced.isSymbolicLink()) {
        throw new Error("Refusing unsafe harness auth file.");
      }
    }
  }
  fsImpl.chmodSync(authPath, 0o600);
}

function parseAuthJson(raw, authPath) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to mutate unreadable harness auth file: ${authPath}`);
  }
  if (!isObject(value)) {
    throw new Error(`Refusing to mutate non-object harness auth file: ${authPath}`);
  }
  return value;
}

export async function withHarnessAuthTransaction(authPath, operation, {
  fsImpl = fs,
  lockfileImpl = lockfile,
} = {}) {
  ensureAuthFile(authPath, { fsImpl });
  let compromised = null;
  const release = await lockfileImpl.lock(authPath, {
    ...LOCK_OPTIONS,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    if (compromised) throw new Error("Harness auth lock was compromised.");
    const current = parseAuthJson(fsImpl.readFileSync(authPath, "utf8"), authPath);
    const result = await operation(current);
    if (compromised) throw new Error("Harness auth lock was compromised.");
    if (result?.next !== undefined) {
      writeJsonFileIfChanged(authPath, result.next, { mode: 0o600 });
    }
    if (compromised) throw new Error("Harness auth lock was compromised.");
    return result?.result;
  } finally {
    try {
      await release();
    } catch {
      if (!compromised) throw new Error("Harness auth lock release failed.");
    }
  }
}

function backupPathFor({ homeDir, targetId, provider }) {
  assertSafePathComponent(assertTargetId(targetId));
  assertSafePathComponent(assertProvider(provider));
  return path.join(
    resolveAimgrStateDir({ homeDir }),
    "backups",
    "harness-auth",
    `${targetId}-${provider}.json`,
  );
}

function writeDisplacedEntryBackup({ backupPath, targetId, provider, entry }) {
  ensureDirectoryMode(path.dirname(backupPath), 0o700);
  writeJsonFileIfChanged(backupPath, {
    schemaVersion: 1,
    target: targetId,
    provider,
    entry,
  }, { mode: 0o600 });
}

function readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl = fs }) {
  let value;
  try {
    value = JSON.parse(fsImpl.readFileSync(backupPath, "utf8"));
  } catch {
    throw new Error(`Could not read displaced auth backup: ${backupPath}`);
  }
  if (
    !isObject(value)
    || value.schemaVersion !== 1
    || value.target !== targetId
    || value.provider !== provider
    || !isObject(value.entry)
  ) {
    throw new Error(`Displaced auth backup is invalid: ${backupPath}`);
  }
  return value.entry;
}

function clearHarnessReceiptState(targetState) {
  delete targetState.providers;
  delete targetState.lastSelectionReceipt;
  delete targetState.lastUninstallReceipt;
}

export async function installHarnessProvider({
  targetId,
  targetState,
  authPath,
  homeDir,
  provider,
  descriptor,
  recognizeLegacyEntry = () => false,
  fsImpl = fs,
  lockfileImpl = lockfile,
}) {
  assertTargetId(targetId);
  assertProvider(provider);
  if (!isAimHarnessExternalDescriptor(descriptor)) {
    throw new Error("Refusing to install an invalid AIM external descriptor.");
  }

  const deterministicBackupPath = backupPathFor({ homeDir, targetId, provider });
  let migratedLegacy = false;
  let displacedNative = false;
  let backupPath = fsImpl.existsSync(deterministicBackupPath) ? deterministicBackupPath : null;

  const result = await withHarnessAuthTransaction(authPath, async (auth) => {
    const currentPresent = Object.hasOwn(auth, provider);
    const current = isObject(auth[provider]) ? auth[provider] : null;
    if (currentPresent && !current) {
      throw new Error(`Refusing malformed native ${provider} auth.`);
    }

    if (current && !isAimHarnessExternalDescriptor(current)) {
      if (recognizeLegacyEntry(current) === true) {
        migratedLegacy = true;
      } else {
        writeDisplacedEntryBackup({
          backupPath: deterministicBackupPath,
          targetId,
          provider,
          entry: current,
        });
        backupPath = deterministicBackupPath;
        displacedNative = true;
      }
    }

    if (isDeepStrictEqual(current, descriptor)) {
      return { result: { wrote: false } };
    }
    return {
      result: { wrote: true },
      next: { ...auth, [provider]: descriptor },
    };
  }, { fsImpl, lockfileImpl });

  clearHarnessReceiptState(targetState);
  targetState.authPath = authPath;
  return Object.freeze({
    provider,
    binding: descriptor.binding,
    authPath,
    wrote: Boolean(result?.wrote),
    migratedLegacy,
    displacedNative,
    backupPath,
  });
}

export async function uninstallHarnessProvider({
  targetId,
  targetState,
  authPath,
  homeDir,
  provider,
  fsImpl = fs,
  lockfileImpl = lockfile,
}) {
  assertTargetId(targetId);
  assertProvider(provider);
  const backupPath = backupPathFor({ homeDir, targetId, provider });
  const backupPresent = fsImpl.existsSync(backupPath);
  let restoredEntry = null;
  if (backupPresent) {
    try {
      restoredEntry = readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl });
    } catch {
      // A broken passive backup must not strand an explicit provider switch.
    }
  }

  const result = await withHarnessAuthTransaction(authPath, async (auth) => {
    const currentPresent = Object.hasOwn(auth, provider);
    const current = isObject(auth[provider]) ? auth[provider] : null;
    if (currentPresent && !current) {
      throw new Error(`Refusing malformed current ${provider} auth.`);
    }
    if (!isAimHarnessExternalDescriptor(current)) {
      return { result: { wrote: false, status: "already_unmanaged" } };
    }

    const next = { ...auth };
    if (restoredEntry) next[provider] = restoredEntry;
    else delete next[provider];
    return {
      result: {
        wrote: true,
        status: restoredEntry ? "restored_native" : "removed",
      },
      next,
    };
  }, { fsImpl, lockfileImpl });

  if (backupPresent) {
    try {
      fsImpl.unlinkSync(backupPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  clearHarnessReceiptState(targetState);
  targetState.authPath = authPath;
  return Object.freeze({
    provider,
    authPath,
    status: result?.status ?? "already_unmanaged",
    wrote: Boolean(result?.wrote),
    backupPath: backupPresent ? backupPath : null,
  });
}

export function readHarnessTargetStatus({
  targetId,
  targetState,
  authPath,
  homeDir,
  resolvedAuthPath = authPath,
  persistedAuthPath = null,
  pathConflict = false,
  records = [],
  coordination = "not_checked",
  recognizeLegacyEntry = () => false,
  fsImpl = fs,
}) {
  assertTargetId(targetId);
  let auth = null;
  let authError = null;
  try {
    if (fsImpl.existsSync(authPath)) auth = parseAuthJson(fsImpl.readFileSync(authPath, "utf8"), authPath);
  } catch {
    authError = "unreadable";
  }
  const providers = {};
  for (const provider of HARNESS_MANAGED_PROVIDERS) {
    const providerEntryMalformed = Boolean(auth) && Object.hasOwn(auth, provider) && !isObject(auth[provider]);
    const current = isObject(auth?.[provider]) ? auth[provider] : null;
    const installed = isAimHarnessExternalDescriptor(current);
    const binding = installed ? current.binding : null;
    const record = records.find((entry) => entry.provider === provider && entry.label === binding);
    const legacyAimProjection = Boolean(current) && recognizeLegacyEntry(provider, current) === true;
    const legacyProjectionUnverified = targetId === "pi"
      && provider === OPENAI_CODEX_PROVIDER
      && coordination !== "available"
      && typeof targetState.activeLabel === "string"
      && current?.type === "oauth";
    const deterministicBackupPath = typeof homeDir === "string"
      ? backupPathFor({ homeDir, targetId, provider })
      : null;
    providers[provider] = {
      installed,
      providerEntryMalformed,
      legacyAimProjection,
      legacyProjectionUnverified,
      managedEntryPresent: installed,
      binding,
      backupPresent: Boolean(deterministicBackupPath && fsImpl.existsSync(deterministicBackupPath)),
      backupPath: deterministicBackupPath && fsImpl.existsSync(deterministicBackupPath)
        ? deterministicBackupPath
        : null,
      recordReady: coordination === "available"
        ? Boolean(record && isObject(record.credential) && Object.keys(record.credential).length > 0)
        : null,
    };
  }
  return Object.freeze({
    target: targetId,
    authPath,
    resolvedAuthPath,
    persistedAuthPath,
    pathConflict: Boolean(pathConflict),
    authFilePresent: Boolean(auth),
    authError,
    coordination,
    providers,
    secretsCopiedToTarget: Object.values(providers).some((entry) => entry.legacyAimProjection)
      ? true
      : Object.values(providers).some((entry) => entry.legacyProjectionUnverified)
        ? null
        : false,
    effect: "new_root_sessions",
  });
}
