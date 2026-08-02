import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { isObject } from "../core/normalize.js";
import { parseTimestampLikeToMs } from "../state/demand.js";
import {
  buildClaudeNativeBundle,
  buildClaudeCredentialSummaryFromBundle,
  hasCompleteClaudeNativeBundle,
  normalizeNonEmptyStringArray,
} from "./claude-bundle.js";

const LOCAL_JSON_MAX_BYTES = 256 * 1024;
const DEFAULT_MIN_REMAINING_MS = 60_000;
const SECURITY_INTERACTIVE_MAX_LINE_BYTES = 4000;
const HEX_DIGITS = Buffer.from("0123456789abcdef", "ascii");

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_MANAGED_FILE_STORAGE_MODE = "contained_native_file_v1";

export function buildClaudeKeychainService({ configDir, defaultConfigDir } = {}) {
  const rawConfigDir = typeof configDir === "string" ? configDir.trim() : "";
  const rawDefaultConfigDir = typeof defaultConfigDir === "string" ? defaultConfigDir.trim() : "";
  if (!rawConfigDir || !rawDefaultConfigDir) {
    throw new Error("Claude Keychain service resolution requires configDir and defaultConfigDir.");
  }
  const resolvedConfigDir = path.resolve(rawConfigDir).normalize("NFC");
  const resolvedDefaultConfigDir = path.resolve(rawDefaultConfigDir).normalize("NFC");
  if (resolvedConfigDir === resolvedDefaultConfigDir) return CLAUDE_KEYCHAIN_SERVICE;
  const suffix = crypto.createHash("sha256").update(resolvedConfigDir).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

function wipeBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function quoteSecurityInteractiveArgument(value) {
  const normalized = normalizeRequiredString(value);
  if (!normalized || /[\0\r\n]/.test(normalized)) return null;
  return `"${normalized.replace(/[\\"]/g, "\\$&")}"`;
}

function hexEncodeBuffer(value) {
  const encoded = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    encoded[index * 2] = HEX_DIGITS[byte >>> 4];
    encoded[(index * 2) + 1] = HEX_DIGITS[byte & 0x0f];
  }
  return encoded;
}

function executeSecurityRead({ file, args, options, execFileImpl }) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        wipeBuffer(stdout);
        wipeBuffer(stderr);
        reject(error);
        return;
      }
      wipeBuffer(stderr);
      resolve(stdout);
    });
  });
}

function normalizeRequiredString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFullKeychainOauth(value) {
  const oauth = isObject(value?.claudeAiOauth) ? value.claudeAiOauth : null;
  if (!oauth) return { ok: false, errorKind: "oauth_missing" };

  const accessToken = normalizeRequiredString(oauth.accessToken);
  const refreshToken = normalizeRequiredString(oauth.refreshToken);
  const expiresAt = parseTimestampLikeToMs(oauth.expiresAt);
  const subscriptionType = normalizeRequiredString(oauth.subscriptionType);
  const rateLimitTier = normalizeRequiredString(oauth.rateLimitTier);
  const scopes = normalizeNonEmptyStringArray(oauth.scopes);
  if (
    !accessToken
    || !refreshToken
    || !expiresAt
    || !subscriptionType
    || !rateLimitTier
    || scopes.length === 0
  ) {
    return { ok: false, errorKind: "oauth_incomplete" };
  }

  return {
    ok: true,
    oauth: {
      accessToken,
      refreshToken,
      expiresAt,
      subscriptionType,
      rateLimitTier,
      scopes,
    },
  };
}

async function readNativeKeychainSecret({
  service,
  account,
  execFileImpl,
  normalizeImpl,
}) {
  const normalizedService = normalizeRequiredString(service);
  const normalizedAccount = normalizeRequiredString(account);
  if (!normalizedService || !normalizedAccount) {
    return { ok: false, errorKind: "keychain_identity_missing" };
  }

  let raw;
  try {
    raw = await executeSecurityRead({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-a", normalizedAccount, "-s", normalizedService, "-w"],
      options: {
        encoding: null,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        maxBuffer: LOCAL_JSON_MAX_BYTES,
        windowsHide: true,
      },
      execFileImpl,
    });
  } catch (error) {
    const status = Number(error?.code ?? error?.status);
    wipeBuffer(error?.stdout);
    wipeBuffer(error?.stderr);
    return {
      ok: false,
      errorKind: status === 44 ? "keychain_item_missing" : "keychain_unavailable",
    };
  }

  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
    return normalizeImpl(JSON.parse(text));
  } catch {
    return { ok: false, errorKind: "oauth_malformed" };
  } finally {
    wipeBuffer(raw);
  }
}

// Callers of this complete reader are credential-boundary code and must not
// serialize its successful result into status, logs, receipts, or errors.
export async function readClaudeNativeKeychainOauth({
  service,
  account = os.userInfo().username,
  execFileImpl = execFile,
} = {}) {
  return readNativeKeychainSecret({
    service,
    account,
    execFileImpl,
    normalizeImpl: normalizeFullKeychainOauth,
  });
}

export function writeClaudeNativeKeychainOauth({
  service,
  oauth,
  account = os.userInfo().username,
  trustedApplicationPath,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedService = normalizeRequiredString(service);
  const normalizedAccount = normalizeRequiredString(account);
  const normalized = normalizeFullKeychainOauth({ claudeAiOauth: oauth });
  const rawTrustedApplicationPath = normalizeRequiredString(trustedApplicationPath);
  let resolvedTrustedApplicationPath = "";
  try {
    if (!path.isAbsolute(rawTrustedApplicationPath)) throw new Error("invalid path");
    resolvedTrustedApplicationPath = fsImpl.realpathSync(rawTrustedApplicationPath);
    const stat = fsImpl.statSync(resolvedTrustedApplicationPath);
    if (!stat.isFile()) throw new Error("not a file");
    fsImpl.accessSync(resolvedTrustedApplicationPath, fs.constants.X_OK);
  } catch {
    resolvedTrustedApplicationPath = "";
  }
  if (!normalizedService || !normalizedAccount || !resolvedTrustedApplicationPath || normalized.ok !== true) {
    return { ok: false, errorKind: "keychain_write_invalid" };
  }

  const secretInput = Buffer.from(JSON.stringify({ claudeAiOauth: normalized.oauth }), "utf8");
  const encodedSecret = hexEncodeBuffer(secretInput);
  const accountArgument = quoteSecurityInteractiveArgument(normalizedAccount);
  const serviceArgument = quoteSecurityInteractiveArgument(normalizedService);
  const trustedApplicationArgument = quoteSecurityInteractiveArgument(resolvedTrustedApplicationPath);
  const commandPrefix = accountArgument && serviceArgument && trustedApplicationArgument
    ? Buffer.from(
        `add-generic-password -U -a ${accountArgument} -s ${serviceArgument} -T "/usr/bin/security" -T ${trustedApplicationArgument} -X `,
        "utf8",
      )
    : null;
  const commandInput = commandPrefix
    ? Buffer.concat([commandPrefix, encodedSecret, Buffer.from("\n", "ascii")])
    : null;
  wipeBuffer(commandPrefix);
  if (!commandInput || commandInput.length > SECURITY_INTERACTIVE_MAX_LINE_BYTES) {
    wipeBuffer(secretInput);
    wipeBuffer(encodedSecret);
    wipeBuffer(commandInput);
    return { ok: false, errorKind: "keychain_write_invalid" };
  }
  let result;
  try {
    // Apple's `security ... -w` prompt uses getpass(3), which truncates input
    // at 128 characters. Interactive `-X` accepts the complete hex payload
    // through stdin while keeping it out of argv and the process listing.
    // AIM reads back rotations through the fixed system Keychain tool, so trust
    // only that management binary plus the exact Claude executable; never use -A.
    result = spawnSyncImpl(
      "/usr/bin/security",
      ["-i"],
      {
        input: commandInput,
        encoding: null,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 7000,
        windowsHide: true,
      },
    );
  } catch {
    return { ok: false, errorKind: "keychain_write_failed" };
  } finally {
    wipeBuffer(secretInput);
    wipeBuffer(encodedSecret);
    wipeBuffer(commandInput);
  }
  wipeBuffer(result?.stdout);
  wipeBuffer(result?.stderr);
  if (result?.error || Number(result?.status) !== 0) {
    return { ok: false, errorKind: "keychain_write_failed" };
  }
  return { ok: true };
}

export function deleteClaudeNativeKeychainOauth({
  service,
  account = os.userInfo().username,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedService = normalizeRequiredString(service);
  const normalizedAccount = normalizeRequiredString(account);
  if (!normalizedService || !normalizedAccount) {
    return { ok: false, errorKind: "keychain_identity_missing" };
  }
  let result;
  try {
    result = spawnSyncImpl(
      "/usr/bin/security",
      ["delete-generic-password", "-a", normalizedAccount, "-s", normalizedService],
      {
        encoding: null,
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
        windowsHide: true,
      },
    );
  } catch {
    return { ok: false, errorKind: "keychain_delete_failed" };
  }
  wipeBuffer(result?.stdout);
  wipeBuffer(result?.stderr);
  if (result?.error || ![0, 44].includes(Number(result?.status))) {
    return { ok: false, errorKind: "keychain_delete_failed" };
  }
  return { ok: true };
}

function normalizeOauthAccount(value) {
  if (!isObject(value)) return null;
  const accountUuid = normalizeRequiredString(value.accountUuid);
  const displayName = normalizeRequiredString(value.displayName);
  const emailAddress = normalizeRequiredString(value.emailAddress).toLowerCase();
  const organizationName = normalizeRequiredString(value.organizationName);
  const organizationUuid = normalizeRequiredString(value.organizationUuid);
  if (!accountUuid || !emailAddress || !organizationName || !organizationUuid) return null;
  return {
    accountUuid,
    ...(displayName ? { displayName } : {}),
    emailAddress,
    organizationName,
    organizationUuid,
  };
}

function readOwnedPrivateJsonObject(filePath, {
  fsImpl = fs,
  maxBytes = LOCAL_JSON_MAX_BYTES,
} = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    return {
      ok: false,
      errorKind: error?.code === "ENOENT" ? "missing" : "unavailable",
    };
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
    || !Number.isFinite(stat.size)
    || stat.size < 0
    || stat.size > maxBytes
    || (Number.isInteger(stat.mode) && (stat.mode & 0o077) !== 0)
  ) {
    return { ok: false, errorKind: "unsafe" };
  }

  let descriptor = null;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fsImpl.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fsImpl.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || (typeof process.getuid === "function" && Number.isInteger(opened.uid) && opened.uid !== process.getuid())
      || !Number.isFinite(opened.size)
      || opened.size < 0
      || opened.size > maxBytes
      || (Number.isInteger(opened.mode) && (opened.mode & 0o077) !== 0)
    ) {
      return { ok: false, errorKind: "unsafe" };
    }
    const parsed = JSON.parse(fsImpl.readFileSync(descriptor, "utf8"));
    return isObject(parsed)
      ? { ok: true, json: parsed }
      : { ok: false, errorKind: "malformed" };
  } catch {
    return { ok: false, errorKind: "malformed" };
  } finally {
    if (descriptor !== null) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // The read result remains value-free and closed on a descriptor error.
      }
    }
  }
}

export function readClaudeNativeOauthAccountAtPath({
  appStatePath,
  expectedEmail,
  fsImpl = fs,
  maxBytes = LOCAL_JSON_MAX_BYTES,
} = {}) {
  const rawPath = normalizeRequiredString(appStatePath);
  const normalizedExpectedEmail = normalizeRequiredString(expectedEmail).toLowerCase();
  if (!rawPath || !path.isAbsolute(rawPath) || !normalizedExpectedEmail) {
    return { ok: false, errorKind: "app_state_descriptor_invalid" };
  }

  const read = readOwnedPrivateJsonObject(rawPath, { fsImpl, maxBytes });
  if (read.ok !== true) {
    const suffix = read.errorKind === "missing"
      ? "missing"
      : read.errorKind === "unsafe"
        ? "unsafe"
        : read.errorKind === "malformed"
          ? "malformed"
          : "unavailable";
    return { ok: false, errorKind: `app_state_${suffix}` };
  }
  const parsed = read.json;
  if (!isObject(parsed?.oauthAccount)) {
    return { ok: false, errorKind: "app_state_identity_missing" };
  }
  const oauthAccount = normalizeOauthAccount(parsed.oauthAccount);
  if (!oauthAccount) return { ok: false, errorKind: "app_state_identity_incomplete" };
  if (oauthAccount.emailAddress !== normalizedExpectedEmail) {
    return { ok: false, errorKind: "identity_mismatch" };
  }
  return { ok: true, oauthAccount };
}

export function buildClaudeNativeStorageDescriptor({
  configDir,
  defaultConfigDir,
  appStatePath,
  expectedEmail,
  requireIsolatedService = false,
  managedRootDir = null,
  storageMode = null,
} = {}) {
  const rawConfigDir = normalizeRequiredString(configDir);
  const rawDefaultConfigDir = normalizeRequiredString(defaultConfigDir);
  const rawAppStatePath = normalizeRequiredString(appStatePath);
  const rawManagedRootDir = normalizeRequiredString(managedRootDir);
  const normalizedExpectedEmail = normalizeRequiredString(expectedEmail).toLowerCase();
  if (
    !rawConfigDir
    || !rawDefaultConfigDir
    || !rawAppStatePath
    || !normalizedExpectedEmail
    || !path.isAbsolute(rawConfigDir)
    || !path.isAbsolute(rawDefaultConfigDir)
    || !path.isAbsolute(rawAppStatePath)
  ) {
    throw new Error("Claude native storage descriptor is incomplete.");
  }
  const resolvedConfigDir = path.resolve(rawConfigDir).normalize("NFC");
  const resolvedDefaultConfigDir = path.resolve(rawDefaultConfigDir).normalize("NFC");
  const resolvedAppStatePath = path.resolve(rawAppStatePath).normalize("NFC");
  const resolvedManagedRootDir = rawManagedRootDir
    ? path.resolve(rawManagedRootDir).normalize("NFC")
    : null;
  const fileOnly = storageMode === CLAUDE_MANAGED_FILE_STORAGE_MODE;
  const service = fileOnly
    ? null
    : buildClaudeKeychainService({
        configDir: resolvedConfigDir,
        defaultConfigDir: resolvedDefaultConfigDir,
      });
  if (requireIsolatedService && !fileOnly && service === CLAUDE_KEYCHAIN_SERVICE) {
    throw new Error("Managed Claude storage requires an isolated Keychain service.");
  }
  if ((requireIsolatedService || fileOnly) && !resolvedManagedRootDir) {
    throw new Error("Managed Claude storage requires an explicit managed root directory.");
  }
  if (resolvedManagedRootDir) {
    const relative = path.relative(resolvedManagedRootDir, resolvedConfigDir);
    const segments = relative.split(path.sep);
    const directLabelConfig = (
      segments.length === 3
      && segments[0] === "claude-homes"
      && /^[A-Za-z0-9_.-]+$/.test(segments[1])
      && segments[2] === ".claude"
    );
    const freshLoginConfig = (
      segments.length === 4
      && segments[0] === "claude-homes"
      && /^[A-Za-z0-9_.-]+$/.test(segments[1])
      && segments[2] === ".login-staging"
      && segments[3] === ".claude"
    );
    if (
      !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || (!directLabelConfig && !freshLoginConfig)
    ) {
      throw new Error("Managed Claude config directory is outside its exact AIM-owned root.");
    }
  }
  return Object.freeze({
    configDir: resolvedConfigDir,
    defaultConfigDir: resolvedDefaultConfigDir,
    appStatePath: resolvedAppStatePath,
    credentialsPath: path.join(resolvedConfigDir, ".credentials.json"),
    expectedEmail: normalizedExpectedEmail,
    ...(fileOnly
      ? { storageMode: CLAUDE_MANAGED_FILE_STORAGE_MODE }
      : { service }),
    ...(resolvedManagedRootDir ? { managedRootDir: resolvedManagedRootDir } : {}),
  });
}

export function buildManagedClaudeNativeStorageDescriptor({
  configDir,
  defaultConfigDir,
  expectedEmail,
  managedRootDir,
} = {}) {
  const rawConfigDir = normalizeRequiredString(configDir);
  return buildClaudeNativeStorageDescriptor({
    configDir: rawConfigDir,
    defaultConfigDir,
    appStatePath: path.join(rawConfigDir, ".claude.json"),
    expectedEmail,
    storageMode: CLAUDE_MANAGED_FILE_STORAGE_MODE,
    managedRootDir,
  });
}

function assertOwnedDirectory(stat) {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && (typeof process.getuid !== "function" || !Number.isInteger(stat.uid) || stat.uid === process.getuid());
}

function assertOwnedRegularFile(stat) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1
    && (typeof process.getuid !== "function" || !Number.isInteger(stat.uid) || stat.uid === process.getuid());
}

export function ensureSafeManagedClaudeStorage({ descriptor, fsImpl = fs } = {}) {
  if (!descriptor?.managedRootDir || !isValidClaudeNativeStorageDescriptor(descriptor)) {
    throw new Error("Managed Claude storage descriptor is invalid.");
  }
  const relative = path.relative(descriptor.managedRootDir, descriptor.configDir);
  const segments = relative.split(path.sep);
  let current = descriptor.managedRootDir;
  for (const segment of [null, ...segments]) {
    if (segment !== null) current = path.join(current, segment);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Could not inspect a managed Claude directory.");
      }
      try {
        fsImpl.mkdirSync(current, { mode: 0o700 });
        stat = fsImpl.lstatSync(current);
      } catch {
        throw new Error("Could not create a managed Claude directory safely.");
      }
    }
    if (!assertOwnedDirectory(stat)) {
      throw new Error("Refusing an unsafe managed Claude directory.");
    }
    fsImpl.chmodSync(current, 0o700);
    const verified = fsImpl.lstatSync(current);
    if (!assertOwnedDirectory(verified) || (verified.mode & 0o077) !== 0) {
      throw new Error("Could not secure a managed Claude directory.");
    }
  }

  for (const filePath of [descriptor.credentialsPath, descriptor.appStatePath]) {
    let stat;
    try {
      stat = fsImpl.lstatSync(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("Could not inspect a managed Claude credential file.");
    }
    if (!assertOwnedRegularFile(stat) || !Number.isFinite(stat.size) || stat.size > LOCAL_JSON_MAX_BYTES) {
      throw new Error("Refusing an unsafe managed Claude credential file.");
    }
    fsImpl.chmodSync(filePath, 0o600);
    const verified = fsImpl.lstatSync(filePath);
    if (!assertOwnedRegularFile(verified) || (verified.mode & 0o077) !== 0) {
      throw new Error("Could not secure a managed Claude credential file.");
    }
  }
  return { ok: true };
}

function isValidClaudeNativeStorageDescriptor(descriptor) {
  if (
    !descriptor
    || !path.isAbsolute(String(descriptor.configDir ?? ""))
    || !path.isAbsolute(String(descriptor.defaultConfigDir ?? ""))
    || !path.isAbsolute(String(descriptor.appStatePath ?? ""))
    || descriptor.credentialsPath !== path.join(descriptor.configDir, ".credentials.json")
    || !normalizeRequiredString(descriptor.expectedEmail)
  ) {
    return false;
  }
  try {
    const fileOnly = descriptor.storageMode === CLAUDE_MANAGED_FILE_STORAGE_MODE;
    if (fileOnly) {
      if (
        descriptor.service !== undefined
        || !descriptor.managedRootDir
        || descriptor.appStatePath !== path.join(descriptor.configDir, ".claude.json")
      ) {
        return false;
      }
    } else {
      const serviceMatches = buildClaudeKeychainService({
        configDir: descriptor.configDir,
        defaultConfigDir: descriptor.defaultConfigDir,
      }) === descriptor.service;
      if (!serviceMatches) return false;
    }
    if (descriptor.managedRootDir) {
      const relative = path.relative(descriptor.managedRootDir, descriptor.configDir);
      const segments = relative.split(path.sep);
      const directLabelConfig = (
        segments.length === 3
        && segments[0] === "claude-homes"
        && /^[A-Za-z0-9_.-]+$/.test(segments[1])
        && segments[2] === ".claude"
      );
      const freshLoginConfig = (
        segments.length === 4
        && segments[0] === "claude-homes"
        && /^[A-Za-z0-9_.-]+$/.test(segments[1])
        && segments[2] === ".login-staging"
        && segments[3] === ".claude"
      );
      return Boolean(
        relative
        && !relative.startsWith("..")
        && !path.isAbsolute(relative)
        && (directLabelConfig || freshLoginConfig)
      );
    }
    return true;
  } catch {
    return false;
  }
}

export async function captureClaudeNativeBundleFromKeychain({
  descriptor,
  nowMs = Date.now(),
  minRemainingMs = DEFAULT_MIN_REMAINING_MS,
  allowExpired = false,
  fsImpl = fs,
  readClaudeNativeKeychainOauthImpl = readClaudeNativeKeychainOauth,
} = {}) {
  if (!isValidClaudeNativeStorageDescriptor(descriptor)) {
    return { ok: false, errorKind: "storage_descriptor_invalid" };
  }
  const identity = readClaudeNativeOauthAccountAtPath({
    appStatePath: descriptor.appStatePath,
    expectedEmail: descriptor.expectedEmail,
    fsImpl,
  });
  if (identity.ok !== true) return identity;

  let keychain;
  try {
    keychain = await readClaudeNativeKeychainOauthImpl({ service: descriptor.service });
  } catch {
    keychain = { ok: false, errorKind: "keychain_unavailable" };
  }
  if (keychain?.ok !== true) {
    return {
      ok: false,
      errorKind: normalizeRequiredString(keychain?.errorKind) || "keychain_unavailable",
    };
  }

  const nativeClaudeBundle = buildClaudeNativeBundle({
    claudeAiOauth: keychain.oauth,
    oauthAccount: identity.oauthAccount,
  });
  const summary = buildClaudeCredentialSummaryFromBundle(nativeClaudeBundle);
  const expiresAtMs = parseTimestampLikeToMs(nativeClaudeBundle?.claudeAiOauth?.expiresAt);
  if (!nativeClaudeBundle || !summary || !hasCompleteClaudeNativeBundle(nativeClaudeBundle)) {
    return { ok: false, errorKind: "native_bundle_incomplete" };
  }
  const remainingMs = expiresAtMs - Number(nowMs);
  if (
    !Number.isFinite(remainingMs)
    || (!allowExpired && remainingMs <= Math.max(0, Number(minRemainingMs) || 0))
  ) {
    return { ok: false, errorKind: "credential_expired" };
  }
  return {
    ok: true,
    nativeClaudeBundle,
    source: "keychain",
    expiresAtMs,
  };
}

export function readClaudeNativeBundleFromConfigFiles({ descriptor, fsImpl = fs }) {
  if (!isValidClaudeNativeStorageDescriptor(descriptor)) {
    return { ok: false, errorKind: "storage_descriptor_invalid" };
  }
  const credentials = readOwnedPrivateJsonObject(descriptor.credentialsPath, { fsImpl });
  const identity = readClaudeNativeOauthAccountAtPath({
    appStatePath: descriptor.appStatePath,
    expectedEmail: descriptor.expectedEmail,
    fsImpl,
  });
  if (
    credentials.ok !== true
    || !isObject(credentials.json?.claudeAiOauth)
    || identity.ok !== true
  ) {
    const credentialsMissing = credentials.errorKind === "missing";
    const identitySafelyEmpty = ["app_state_missing", "app_state_identity_missing"].includes(identity.errorKind);
    return {
      ok: false,
      errorKind: credentialsMissing && (identity.ok === true || identitySafelyEmpty)
        ? "file_bundle_missing"
        : "file_bundle_unavailable",
    };
  }
  const nativeClaudeBundle = buildClaudeNativeBundle({
    claudeAiOauth: credentials.json.claudeAiOauth,
    oauthAccount: identity.oauthAccount,
  });
  if (!hasCompleteClaudeNativeBundle(nativeClaudeBundle)) {
    const oauth = nativeClaudeBundle?.claudeAiOauth;
    const emptyTokenTombstone = (
      oauth?.accessToken === ""
      && oauth?.refreshToken === ""
      && hasCompleteClaudeNativeBundle({
        ...nativeClaudeBundle,
        claudeAiOauth: {
          ...oauth,
          accessToken: "empty-token-tombstone",
          refreshToken: "empty-token-tombstone",
        },
      })
    );
    if (emptyTokenTombstone) {
      return { ok: false, errorKind: "file_bundle_empty" };
    }
    return { ok: false, errorKind: "file_bundle_incomplete" };
  }
  return {
    ok: true,
    nativeClaudeBundle,
    source: "file",
    expiresAtMs: parseTimestampLikeToMs(nativeClaudeBundle.claudeAiOauth.expiresAt),
  };
}

export function readManagedClaudeNativeBundleFromFiles({
  descriptor,
  fsImpl = fs,
} = {}) {
  if (descriptor?.storageMode !== CLAUDE_MANAGED_FILE_STORAGE_MODE) {
    return { ok: false, errorKind: "storage_descriptor_invalid" };
  }
  try {
    ensureSafeManagedClaudeStorage({ descriptor, fsImpl });
  } catch {
    return { ok: false, errorKind: "managed_storage_unsafe" };
  }
  const result = readClaudeNativeBundleFromConfigFiles({ descriptor, fsImpl });
  if (
    result.ok !== true
    && ["file_bundle_missing", "file_bundle_empty"].includes(result.errorKind)
  ) {
    return { ok: false, errorKind: "native_storage_empty" };
  }
  return result;
}

function strictIdentity(bundle) {
  const account = bundle?.oauthAccount;
  const accountUuid = normalizeRequiredString(account?.accountUuid);
  const emailAddress = normalizeRequiredString(account?.emailAddress).toLowerCase();
  const organizationUuid = normalizeRequiredString(account?.organizationUuid);
  return accountUuid && emailAddress && organizationUuid
    ? { accountUuid, emailAddress, organizationUuid }
    : null;
}

function sameStrictIdentity(left, right) {
  const a = strictIdentity(left);
  const b = strictIdentity(right);
  return Boolean(
    a
    && b
    && a.accountUuid === b.accountUuid
    && a.emailAddress === b.emailAddress
    && a.organizationUuid === b.organizationUuid
  );
}

function sameTokenSet(left, right) {
  const a = left?.claudeAiOauth;
  const b = right?.claudeAiOauth;
  return Boolean(
    a
    && b
    && a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken
    && parseTimestampLikeToMs(a.expiresAt) === parseTimestampLikeToMs(b.expiresAt)
  );
}

// Reads the exact managed config-dir file projection and its isolated Keychain
// item, then fails closed on identity or equal-expiry ambiguity. This is for
// capture/projection and post-run rotation only; status must not import it.
export async function readClaudeNativeBundleFromStorage({
  descriptor,
  nowMs = Date.now(),
  fsImpl = fs,
  readClaudeNativeKeychainOauthImpl = readClaudeNativeKeychainOauth,
} = {}) {
  if (!isValidClaudeNativeStorageDescriptor(descriptor)) {
    return { ok: false, errorKind: "storage_descriptor_invalid" };
  }
  if (descriptor.managedRootDir) {
    try {
      ensureSafeManagedClaudeStorage({ descriptor, fsImpl });
    } catch {
      return { ok: false, errorKind: "managed_storage_unsafe" };
    }
  }
  const file = readClaudeNativeBundleFromConfigFiles({ descriptor });
  let keychainOauth;
  try {
    keychainOauth = await readClaudeNativeKeychainOauthImpl({ service: descriptor.service });
  } catch {
    keychainOauth = { ok: false, errorKind: "keychain_unavailable" };
  }
  let keychain;
  if (keychainOauth?.ok === true) {
    const identity = readClaudeNativeOauthAccountAtPath({
      appStatePath: descriptor.appStatePath,
      expectedEmail: descriptor.expectedEmail,
      fsImpl,
    });
    if (identity.ok !== true) {
      keychain = { ok: false, errorKind: "keychain_identity_unavailable" };
    } else {
      const nativeClaudeBundle = buildClaudeNativeBundle({
        claudeAiOauth: keychainOauth.oauth,
        oauthAccount: identity.oauthAccount,
      });
      const expiresAtMs = parseTimestampLikeToMs(nativeClaudeBundle?.claudeAiOauth?.expiresAt);
      keychain = !hasCompleteClaudeNativeBundle(nativeClaudeBundle)
        ? { ok: false, errorKind: "native_bundle_incomplete" }
        : {
            ok: true,
            nativeClaudeBundle,
            source: "keychain",
            expiresAtMs,
          };
    }
  } else {
    keychain = {
      ok: false,
      errorKind: normalizeRequiredString(keychainOauth?.errorKind) || "keychain_unavailable",
    };
  }
  if (file.ok !== true && keychain.ok !== true) {
    if (file.errorKind === "file_bundle_missing" && keychain.errorKind === "keychain_item_missing") {
      return {
        ok: false,
        errorKind: "native_storage_empty",
        keychainState: { present: false },
      };
    }
    return {
      ok: false,
      errorKind:
        file.errorKind !== "file_bundle_missing"
          ? file.errorKind
          : keychain.errorKind || "native_storage_unavailable",
    };
  }
  if (file.ok !== true) {
    if (file.errorKind !== "file_bundle_missing") {
      return { ok: false, errorKind: file.errorKind };
    }
    return {
      ...keychain,
      keychainState: { present: true, oauth: keychainOauth.oauth },
    };
  }
  if (keychain.ok !== true) {
    if (keychain.errorKind !== "keychain_item_missing") {
      return { ok: false, errorKind: keychain.errorKind };
    }
    return {
      ...file,
      keychainState: { present: false },
    };
  }
  if (!sameStrictIdentity(file.nativeClaudeBundle, keychain.nativeClaudeBundle)) {
    return { ok: false, errorKind: "native_storage_identity_conflict" };
  }
  if (sameTokenSet(file.nativeClaudeBundle, keychain.nativeClaudeBundle)) {
    return {
      ...keychain,
      keychainState: { present: true, oauth: keychainOauth.oauth },
    };
  }
  if (file.expiresAtMs === keychain.expiresAtMs) {
    return { ok: false, errorKind: "native_storage_freshness_ambiguous" };
  }
  return {
    ...(file.expiresAtMs > keychain.expiresAtMs ? file : keychain),
    keychainState: { present: true, oauth: keychainOauth.oauth },
  };
}
