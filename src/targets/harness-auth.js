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

function providerState(targetState, provider, { create = false } = {}) {
  targetState.providers = isObject(targetState.providers) ? targetState.providers : {};
  if (!isObject(targetState.providers[provider]) && create) targetState.providers[provider] = {};
  return isObject(targetState.providers[provider]) ? targetState.providers[provider] : null;
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

function writeDisplacedEntryBackup({ backupPath, targetId, provider, entry, fsImpl = fs }) {
  if (fsImpl.existsSync(backupPath)) {
    const existing = readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl });
    if (!isDeepStrictEqual(existing, entry)) {
      throw new Error(`Refusing to overwrite an existing displaced auth backup: ${backupPath}`);
    }
    return false;
  }
  ensureDirectoryMode(path.dirname(backupPath), 0o700);
  writeJsonFileIfChanged(backupPath, {
    schemaVersion: 1,
    target: targetId,
    provider,
    entry,
  }, { mode: 0o600 });
  return true;
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

function readPendingTransition(providerStateValue) {
  const pending = providerStateValue?.pendingTransition;
  if (!isObject(pending) || pending.schemaVersion !== 1) return null;
  if (pending.operation !== "install" && pending.operation !== "uninstall") return null;
  return pending;
}

async function persistTargetTransition(persistTargetState) {
  await persistTargetState();
}

export async function installHarnessProvider({
  targetId,
  targetState,
  authPath,
  homeDir,
  provider,
  descriptor,
  replaceNativeAuth = false,
  recognizeLegacyEntry = () => false,
  persistTargetState = async () => {},
  fsImpl = fs,
  lockfileImpl = lockfile,
}) {
  assertTargetId(targetId);
  assertProvider(provider);
  if (!isAimHarnessExternalDescriptor(descriptor)) {
    throw new Error("Refusing to install an invalid AIM external descriptor.");
  }
  const currentProviderState = providerState(targetState, provider, { create: true });
  const lastInstalled = isObject(currentProviderState.lastInstalledDescriptor)
    ? currentProviderState.lastInstalledDescriptor
    : null;
  let pending = readPendingTransition(currentProviderState);
  if (pending?.operation === "uninstall") {
    throw new Error(`Finish the pending ${provider} uninstall before installing a binding.`);
  }
  if (pending && !isDeepStrictEqual(pending.descriptor, descriptor)) {
    throw new Error(`Finish recovery of the pending ${provider} descriptor before selecting another binding.`);
  }
  let backupPath = typeof pending?.backupPath === "string"
    ? pending.backupPath
    : typeof currentProviderState.backupPath === "string"
      ? currentProviderState.backupPath
      : null;
  let migratedLegacy = pending?.migratedLegacy === true;
  let displacedNative = pending?.displacedNative === true;
  let recoveredInstallReceipt = pending?.recoveredInstallReceipt === true;
  let preparedPersisted = Boolean(pending);
  let createdBackup = false;

  const result = await withHarnessAuthTransaction(authPath, async (auth) => {
    const currentPresent = Object.hasOwn(auth, provider);
    const current = isObject(auth[provider]) ? auth[provider] : null;
    if (currentPresent && !current) {
      throw new Error(`Refusing malformed native ${provider} auth.`);
    }

    if (!pending) {
      const ownedCurrent = current && lastInstalled && isDeepStrictEqual(current, lastInstalled);
      const recognizedLegacy = current && !ownedCurrent && recognizeLegacyEntry(current) === true;
      let source = null;
      if (ownedCurrent) {
        source = "owned_descriptor";
      } else if (isAimHarnessExternalDescriptor(current) && isDeepStrictEqual(current, descriptor)) {
        // The target switch can land before the final local receipt. Re-adopt
        // only the exact descriptor requested by this operation.
        source = "recovered_descriptor";
        recoveredInstallReceipt = true;
        const orphanBackupPath = backupPathFor({ homeDir, targetId, provider });
        if (fsImpl.existsSync(orphanBackupPath)) {
          readDisplacedEntryBackup({ backupPath: orphanBackupPath, targetId, provider, fsImpl });
          backupPath = orphanBackupPath;
          displacedNative = true;
        }
      } else if (recognizedLegacy) {
        source = "legacy_projection";
        migratedLegacy = true;
      } else if (!current && !lastInstalled) {
        source = "empty";
      } else {
        if (lastInstalled) {
          throw new Error(`Refusing to replace ${provider}: current auth conflicts with AIM's last installed descriptor.`);
        }
        if (isAimHarnessExternalDescriptor(current)) {
          throw new Error(`Refusing to replace an AIM descriptor without its local ownership receipt for ${provider}.`);
        }
        if (!replaceNativeAuth) {
          throw new Error(`Refusing to replace native ${provider} auth without --replace-native-auth.`);
        }
        source = "native";
        if (!backupPath) backupPath = backupPathFor({ homeDir, targetId, provider });
        createdBackup = writeDisplacedEntryBackup({
          backupPath,
          targetId,
          provider,
          entry: current,
          fsImpl,
        });
        displacedNative = true;
      }
      pending = {
        schemaVersion: 1,
        operation: "install",
        source,
        descriptor: structuredClone(descriptor),
        backupPath,
        migratedLegacy,
        displacedNative,
        recoveredInstallReceipt,
      };
      currentProviderState.pendingTransition = pending;
      targetState.authPath = authPath;
      try {
        await persistTargetTransition(persistTargetState);
        preparedPersisted = true;
      } catch (error) {
        delete currentProviderState.pendingTransition;
        if (createdBackup && backupPath) {
          try {
            fsImpl.unlinkSync(backupPath);
          } catch {
            // A surviving exact orphan backup is validated on the next retry.
          }
        }
        throw error;
      }
    }

    const alreadySwitched = isDeepStrictEqual(current, descriptor);
    if (!alreadySwitched) {
      if (pending.source === "native") {
        if (!backupPath) throw new Error(`Missing ${provider} displaced auth backup receipt.`);
        const displaced = readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl });
        if (!isDeepStrictEqual(current, displaced)) {
          throw new Error(`Refusing ${provider} install recovery after native auth changed.`);
        }
      } else if (pending.source === "legacy_projection") {
        if (!current || recognizeLegacyEntry(current) !== true) {
          throw new Error(`Refusing ${provider} install recovery after legacy auth changed.`);
        }
      } else if (pending.source === "owned_descriptor") {
        if (!current || !lastInstalled || !isDeepStrictEqual(current, lastInstalled)) {
          throw new Error(`Refusing ${provider} install recovery after AIM auth changed.`);
        }
      } else if (pending.source === "empty") {
        if (current) throw new Error(`Refusing ${provider} install recovery after native auth appeared.`);
      } else if (pending.source === "recovered_descriptor") {
        throw new Error(`Refusing ${provider} descriptor recovery after target auth changed.`);
      } else {
        throw new Error(`Invalid pending ${provider} install transition.`);
      }
    }
    const next = { ...auth, [provider]: descriptor };
    return {
      result: { wrote: !alreadySwitched },
      next: isDeepStrictEqual(auth, next) ? undefined : next,
    };
  }, { fsImpl, lockfileImpl });

  if (!preparedPersisted) {
    throw new Error(`Could not persist the prepared ${provider} install transition.`);
  }
  currentProviderState.binding = descriptor.binding;
  currentProviderState.lastInstalledDescriptor = structuredClone(descriptor);
  if (backupPath) currentProviderState.backupPath = backupPath;
  else delete currentProviderState.backupPath;
  currentProviderState.lastInstalledAt = new Date().toISOString();
  delete currentProviderState.pendingTransition;
  targetState.authPath = authPath;
  await persistTargetTransition(persistTargetState);
  return Object.freeze({
    provider,
    binding: descriptor.binding,
    authPath,
    wrote: Boolean(result?.wrote),
    migratedLegacy,
    displacedNative,
    recoveredInstallReceipt,
    backupPath,
  });
}

export async function uninstallHarnessProvider({
  targetId,
  targetState,
  authPath,
  provider,
  persistTargetState = async () => {},
  fsImpl = fs,
  lockfileImpl = lockfile,
}) {
  assertTargetId(targetId);
  assertProvider(provider);
  let currentProviderState = providerState(targetState, provider);
  let pending = readPendingTransition(currentProviderState);
  if (pending?.operation === "install") {
    // An install whose target switch landed before its final receipt can be
    // finalized safely only when the exact pending descriptor is still live.
    await withHarnessAuthTransaction(authPath, async (auth) => {
      const current = isObject(auth[provider]) ? auth[provider] : null;
      if (!isDeepStrictEqual(current, pending.descriptor)) {
        throw new Error(`Finish the pending ${provider} install before uninstalling it.`);
      }
      currentProviderState.binding = pending.descriptor.binding;
      currentProviderState.lastInstalledDescriptor = structuredClone(pending.descriptor);
      if (typeof pending.backupPath === "string") currentProviderState.backupPath = pending.backupPath;
      delete currentProviderState.pendingTransition;
      targetState.authPath = authPath;
      await persistTargetTransition(persistTargetState);
      return { result: { wrote: false } };
    }, { fsImpl, lockfileImpl });
    pending = null;
  }

  const lastInstalled = isObject(currentProviderState?.lastInstalledDescriptor)
    ? currentProviderState.lastInstalledDescriptor
    : null;
  let backupPath = typeof currentProviderState?.backupPath === "string"
    ? currentProviderState.backupPath
    : null;
  pending = readPendingTransition(currentProviderState);
  if (!lastInstalled) {
    return Object.freeze({ provider, authPath, status: "not_installed", wrote: false, backupPath });
  }
  if (pending && pending.operation !== "uninstall") {
    throw new Error(`Invalid pending ${provider} target transition.`);
  }
  if (pending?.lastInstalledDescriptor && !isDeepStrictEqual(pending.lastInstalledDescriptor, lastInstalled)) {
    throw new Error(`Pending ${provider} uninstall does not match AIM's ownership receipt.`);
  }
  if (typeof pending?.backupPath === "string") backupPath = pending.backupPath;

  const result = await withHarnessAuthTransaction(authPath, async (auth) => {
    const currentPresent = Object.hasOwn(auth, provider);
    const current = isObject(auth[provider]) ? auth[provider] : null;
    if (currentPresent && !current) {
      throw new Error(`Refusing malformed current ${provider} auth.`);
    }
    if (!pending) {
      pending = {
        schemaVersion: 1,
        operation: "uninstall",
        phase: "prepared",
        lastInstalledDescriptor: structuredClone(lastInstalled),
        backupPath,
      };
      currentProviderState.pendingTransition = pending;
      targetState.authPath = authPath;
      await persistTargetTransition(persistTargetState);
    }

    if (pending.phase === "auth_restored") {
      if (backupPath && fsImpl.existsSync(backupPath)) {
        const restored = readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl });
        if (!isDeepStrictEqual(current, restored)) {
          throw new Error(`Refusing ${provider} uninstall cleanup after restored auth changed.`);
        }
      }
      return { result: { wrote: false, recoveredCleanup: true } };
    }

    const restoredEntry = backupPath
      ? readDisplacedEntryBackup({ backupPath, targetId, provider, fsImpl })
      : null;
    if (
      (restoredEntry && current && isDeepStrictEqual(current, restoredEntry))
      || (!restoredEntry && !current)
    ) {
      // The auth mutation landed before the post-mutation phase receipt.
      return { result: { wrote: false, recoveredCleanup: true } };
    }
    if (!current || !isDeepStrictEqual(current, lastInstalled)) {
      throw new Error(
        `Refusing to uninstall ${provider}: current auth does not equal AIM's last installed descriptor.`
          + (backupPath ? ` Backup retained at ${backupPath}.` : ""),
      );
    }
    const next = { ...auth };
    if (restoredEntry) next[provider] = restoredEntry;
    else delete next[provider];
    return { result: { wrote: true, recoveredCleanup: false }, next };
  }, { fsImpl, lockfileImpl });

  currentProviderState.pendingTransition = {
    ...pending,
    phase: "auth_restored",
  };
  targetState.authPath = authPath;
  await persistTargetTransition(persistTargetState);

  if (backupPath && fsImpl.existsSync(backupPath)) fsImpl.unlinkSync(backupPath);
  delete targetState.providers[provider];
  if (Object.keys(targetState.providers).length === 0) delete targetState.providers;
  targetState.authPath = authPath;
  await persistTargetTransition(persistTargetState);
  return Object.freeze({
    provider,
    authPath,
    status: result?.recoveredCleanup
      ? "restored_native_cleanup"
      : backupPath ? "restored_native" : "removed",
    wrote: Boolean(result?.wrote),
    backupPath: backupPath ?? null,
  });
}

export function readHarnessTargetStatus({
  targetId,
  targetState,
  authPath,
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
    const state = providerState(targetState, provider);
    const providerEntryMalformed = Boolean(auth) && Object.hasOwn(auth, provider) && !isObject(auth[provider]);
    const current = isObject(auth?.[provider]) ? auth[provider] : null;
    const installed = Boolean(state?.lastInstalledDescriptor)
      && isDeepStrictEqual(current, state.lastInstalledDescriptor);
    const record = records.find((entry) => entry.provider === provider && entry.label === state?.binding);
    const legacyAimProjection = Boolean(current) && recognizeLegacyEntry(provider, current) === true;
    const legacyProjectionUnverified = targetId === "pi"
      && provider === OPENAI_CODEX_PROVIDER
      && coordination !== "available"
      && typeof targetState.activeLabel === "string"
      && current?.type === "oauth";
    providers[provider] = {
      installed,
      providerEntryMalformed,
      legacyAimProjection,
      legacyProjectionUnverified,
      managedEntryPresent: isAimHarnessExternalDescriptor(current),
      binding: typeof state?.binding === "string" ? state.binding : null,
      backupPresent: typeof state?.backupPath === "string" && fsImpl.existsSync(state.backupPath),
      backupPath: typeof state?.backupPath === "string" ? state.backupPath : null,
      pendingTransition: typeof state?.pendingTransition?.operation === "string"
        ? {
            operation: state.pendingTransition.operation,
            phase: state.pendingTransition.phase ?? "prepared",
          }
        : null,
      ownershipConflict: Boolean(state?.lastInstalledDescriptor) && !installed,
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
