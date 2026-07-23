import fs from "node:fs";
import path from "node:path";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { ensureDirectoryMode, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";

export const AIMGR_REDIS_CACHE_KIND = "aimgr.redis-cache.v2";
export const AIMGR_REDIS_STATUS_CACHE_KIND = "aimgr.redis-status-fallback.v1";
export const AIMGR_REDIS_CACHE_VERSION = 2;
export const AIMGR_PROVIDER_USAGE_CACHE_VERSION = 1;
export const AIMGR_REDIS_CACHE_MAX_BYTES = 2 * 1024 * 1024;
export const AIMGR_REDIS_CACHE_LOCK_STALE_MS = 30_000;

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IDENTITY_BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const WINDOW_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,39}$/;
const MAX_PROVIDERS = 8;
const MAX_PROVIDER_ENTRIES = 256;
const MAX_USAGE_WINDOWS = 16;

function emptyProviderUsage() {
  return {
    version: AIMGR_PROVIDER_USAGE_CACHE_VERSION,
    providers: {},
  };
}

export function createEmptyRedisCacheEnvelope() {
  return {
    kind: AIMGR_REDIS_CACHE_KIND,
    version: AIMGR_REDIS_CACHE_VERSION,
    statusView: null,
    providerUsage: emptyProviderUsage(),
  };
}

function canonicalCacheLabel(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    return normalizeLabel(value) === value ? value : null;
  } catch {
    return null;
  }
}

function normalizeCacheTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeCacheToken(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAFE_TOKEN_PATTERN.test(token) ? token : null;
}

function normalizeCachedUsage(provider, value) {
  const windows = Array.isArray(value?.windows)
    ? value.windows.slice(0, MAX_USAGE_WINDOWS).map((window) => {
        if (!isObject(window)) return null;
        const label = typeof window.label === "string" ? window.label.trim() : "";
        const usedPercent = Number(window.usedPercent);
        if (!WINDOW_LABEL_PATTERN.test(label) || !Number.isFinite(usedPercent)) return null;
        const resetAt = normalizeCacheTimestamp(window.resetAt);
        const kind = normalizeCacheToken(window.kind);
        const severity = normalizeCacheToken(window.severity);
        return {
          label,
          usedPercent: Math.max(0, Math.min(100, usedPercent)),
          ...(resetAt !== null ? { resetAt } : {}),
          ...(kind ? { kind } : {}),
          ...(severity ? { severity } : {}),
          ...(typeof window.active === "boolean" ? { active: window.active } : {}),
        };
      }).filter(Boolean)
    : [];
  return { provider, ok: windows.length > 0, windows };
}

function normalizeProviderEntries(provider, value) {
  const entries = {};
  for (const [rawLabel, rawEntry] of Object.entries(isObject(value) ? value : {}).slice(0, MAX_PROVIDER_ENTRIES)) {
    const label = canonicalCacheLabel(rawLabel);
    if (!label || !isObject(rawEntry)) continue;
    const identityBinding = typeof rawEntry.identityBinding === "string"
      && IDENTITY_BINDING_PATTERN.test(rawEntry.identityBinding)
      ? rawEntry.identityBinding
      : null;
    const lastAttemptAtMs = normalizeCacheTimestamp(rawEntry.lastAttemptAtMs);
    if (!identityBinding || lastAttemptAtMs === null) continue;
    entries[label] = {
      identityBinding,
      subscriptionType: normalizeCacheToken(rawEntry.subscriptionType),
      rateLimitTier: normalizeCacheToken(rawEntry.rateLimitTier),
      authState: normalizeCacheToken(rawEntry.authState),
      errorKind: normalizeCacheToken(rawEntry.errorKind),
      usageObservedAtMs: normalizeCacheTimestamp(rawEntry.usageObservedAtMs),
      lastAttemptAtMs,
      usage: normalizeCachedUsage(provider, rawEntry.usage),
    };
  }
  return entries;
}

function normalizeProviderUsage(value) {
  if (!isObject(value) || value.version !== AIMGR_PROVIDER_USAGE_CACHE_VERSION || !isObject(value.providers)) {
    return emptyProviderUsage();
  }
  const providers = {};
  for (const [rawProvider, entries] of Object.entries(value.providers).slice(0, MAX_PROVIDERS)) {
    const provider = String(rawProvider ?? "").trim().toLowerCase();
    if (!PROVIDER_PATTERN.test(provider)) continue;
    providers[provider] = normalizeProviderEntries(provider, entries);
  }
  return {
    version: AIMGR_PROVIDER_USAGE_CACHE_VERSION,
    providers,
  };
}

function normalizeRedisCacheEnvelope(value) {
  if (isObject(value) && value.kind === AIMGR_REDIS_CACHE_KIND && value.version === AIMGR_REDIS_CACHE_VERSION) {
    return {
      kind: AIMGR_REDIS_CACHE_KIND,
      version: AIMGR_REDIS_CACHE_VERSION,
      statusView: isObject(value.statusView) ? structuredClone(value.statusView) : null,
      providerUsage: normalizeProviderUsage(value.providerUsage),
    };
  }

  // Version 1 of this file was the status view itself. Accept it only as a
  // diagnostic status fallback and migrate it into the envelope on the next
  // successful write. It never supplies provider-usage backoff entries.
  if (isObject(value) && (Array.isArray(value.accounts) || isObject(value.redis))) {
    return {
      ...createEmptyRedisCacheEnvelope(),
      statusView: structuredClone(value),
    };
  }
  return null;
}

function inspectCachePath(cachePath, { fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(cachePath);
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "missing" } : { state: "invalid" };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: "unsafe" };
  if (!Number.isFinite(stat.size) || stat.size > AIMGR_REDIS_CACHE_MAX_BYTES) return { state: "unsafe" };
  if (Number.isInteger(stat.mode) && (stat.mode & 0o077) !== 0) return { state: "unsafe" };
  if (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) {
    return { state: "unsafe" };
  }
  return { state: "ready" };
}

export function readRedisCacheEnvelope({ homeDir, cachePath = resolveAimgrRedisCachePath({ homeDir }), fsImpl = fs } = {}) {
  const inspection = inspectCachePath(cachePath, { fsImpl });
  if (inspection.state === "missing") {
    return { state: "missing", cachePath, envelope: createEmptyRedisCacheEnvelope() };
  }
  if (inspection.state !== "ready") {
    return { state: inspection.state, cachePath, envelope: createEmptyRedisCacheEnvelope() };
  }

  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(cachePath, "utf8"));
  } catch {
    return { state: "invalid", cachePath, envelope: createEmptyRedisCacheEnvelope() };
  }
  const envelope = normalizeRedisCacheEnvelope(parsed);
  if (!envelope) {
    return { state: "invalid", cachePath, envelope: createEmptyRedisCacheEnvelope() };
  }
  return { state: "ready", cachePath, envelope };
}

export function readCachedRedisStatusView(options = {}) {
  const read = readRedisCacheEnvelope(options);
  return {
    state: read.state,
    cachePath: read.cachePath,
    view: isObject(read.envelope.statusView) ? structuredClone(read.envelope.statusView) : null,
  };
}

export function readCachedProviderUsage({ provider, ...options } = {}) {
  const read = readRedisCacheEnvelope(options);
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const entries = isObject(read.envelope.providerUsage.providers[normalizedProvider])
    ? structuredClone(read.envelope.providerUsage.providers[normalizedProvider])
    : {};
  return {
    state: read.state,
    cachePath: read.cachePath,
    entries,
  };
}

function assertWritableCacheState(read) {
  if (read.state === "unsafe") {
    throw new Error("Refusing to update an unsafe AIM Redis cache file.");
  }
}

function writeEnvelope({ homeDir, cachePath, envelope }) {
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > AIMGR_REDIS_CACHE_MAX_BYTES) {
    throw new Error("Refusing to write an oversized AIM Redis cache file.");
  }
  ensureDirectoryMode(path.dirname(cachePath), 0o700);
  return writeJsonFileIfChanged(cachePath, envelope, { mode: 0o600 });
}

export function writeCachedRedisStatusView({ homeDir, view, cachePath = resolveAimgrRedisCachePath({ homeDir }) } = {}) {
  if (!isObject(view) || view.kind !== AIMGR_REDIS_STATUS_CACHE_KIND) {
    throw new Error("Refusing to cache an unsupported Redis diagnostic status view.");
  }
  const read = readRedisCacheEnvelope({ homeDir, cachePath });
  assertWritableCacheState(read);
  return writeEnvelope({
    homeDir,
    cachePath,
    envelope: {
      ...read.envelope,
      statusView: structuredClone(view),
    },
  });
}

export function writeCachedProviderUsage({
  homeDir,
  provider,
  entries,
  cachePath = resolveAimgrRedisCachePath({ homeDir }),
} = {}) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalizedProvider)) {
    throw new Error("Missing or invalid provider for AIM Redis usage cache update.");
  }
  const read = readRedisCacheEnvelope({ homeDir, cachePath });
  assertWritableCacheState(read);
  return writeEnvelope({
    homeDir,
    cachePath,
    envelope: {
      ...read.envelope,
      statusView: isObject(read.envelope.statusView)
        && read.envelope.statusView.kind === AIMGR_REDIS_STATUS_CACHE_KIND
        ? read.envelope.statusView
        : null,
      providerUsage: {
        version: AIMGR_PROVIDER_USAGE_CACHE_VERSION,
        providers: {
          ...read.envelope.providerUsage.providers,
          [normalizedProvider]: normalizeProviderEntries(normalizedProvider, entries),
        },
      },
    },
  });
}

export function resolveRedisCacheLockPath(cachePath) {
  return `${cachePath}.lock`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

export function acquireRedisCacheLock({
  homeDir,
  cachePath = resolveAimgrRedisCachePath({ homeDir }),
  nowMs = Date.now(),
  fsImpl = fs,
} = {}) {
  const lockPath = resolveRedisCacheLockPath(cachePath);
  ensureDirectoryMode(path.dirname(lockPath), 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fsImpl.openSync(lockPath, "wx", 0o600);
      fsImpl.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAtMs: nowMs })}\n`, "utf8");
      return { fd, lockPath, identity: fsImpl.fstatSync(fd), fsImpl };
    } catch (error) {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch {
          // Best effort cleanup for a partially initialized lock.
        }
        try {
          fsImpl.unlinkSync(lockPath);
        } catch {
          // The partially initialized lock may already be absent.
        }
        return null;
      }
      if (error?.code !== "EEXIST") return null;
    }

    let firstStat;
    let ownerPid = null;
    try {
      firstStat = fsImpl.lstatSync(lockPath);
      if (Math.max(0, nowMs - firstStat.mtimeMs) <= AIMGR_REDIS_CACHE_LOCK_STALE_MS) return null;
      ownerPid = Number(JSON.parse(fsImpl.readFileSync(lockPath, "utf8"))?.pid);
    } catch {
      if (!firstStat || Math.max(0, nowMs - firstStat.mtimeMs) <= AIMGR_REDIS_CACHE_LOCK_STALE_MS) return null;
    }
    if (isProcessAlive(ownerPid)) return null;

    try {
      const secondStat = fsImpl.lstatSync(lockPath);
      if (!sameFileIdentity(firstStat, secondStat)) return null;
      fsImpl.unlinkSync(lockPath);
    } catch {
      return null;
    }
  }
  return null;
}

export function releaseRedisCacheLock(lock) {
  if (!lock) return;
  try {
    lock.fsImpl.closeSync(lock.fd);
  } catch {
    // Best effort; inode comparison below still protects a replacement lock.
  }
  try {
    const current = lock.fsImpl.lstatSync(lock.lockPath);
    if (sameFileIdentity(lock.identity, current)) lock.fsImpl.unlinkSync(lock.lockPath);
  } catch {
    // The lock may already have been reclaimed after interruption.
  }
}
