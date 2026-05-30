import { AIMGR_REDIS_DEFAULT_KEY_PREFIX } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";

function normalizeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function timestamp(value, fallback) {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

export function normalizeKeyPrefix(value = AIMGR_REDIS_DEFAULT_KEY_PREFIX) {
  const raw = String(value ?? "").trim() || AIMGR_REDIS_DEFAULT_KEY_PREFIX;
  return raw.endsWith(":") ? raw : `${raw}:`;
}

export function normalizeMetaRecord(record = {}, { now = new Date().toISOString() } = {}) {
  const source = isObject(record) ? record : {};
  return {
    kind: "aimgr.meta.v1",
    schemaVersion: "aimgr.redis.v1",
    cutover: isObject(source.cutover) ? source.cutover : {},
    migration: isObject(source.migration) ? source.migration : {},
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : null,
    version: normalizeVersion(source.version),
  };
}

export function normalizeMachineRecord(record = {}, { now = new Date().toISOString() } = {}) {
  const source = isObject(record) ? record : {};
  const machineId = String(source.machineId ?? "").trim();
  if (!machineId) throw new Error("Redis machine record is missing machineId.");
  return {
    kind: "aimgr.machine.v1",
    machineId,
    hostname: typeof source.hostname === "string" ? source.hostname : null,
    displayName: typeof source.displayName === "string" ? source.displayName : machineId,
    aimVersion: typeof source.aimVersion === "string" ? source.aimVersion : "0.0.0",
    platform: typeof source.platform === "string" ? source.platform : null,
    lastSeenAt: timestamp(source.lastSeenAt, now),
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : machineId,
    version: normalizeVersion(source.version),
  };
}

export function normalizeLabelRecord(record = {}, { now = new Date().toISOString() } = {}) {
  const source = isObject(record) ? record : {};
  const provider = normalizeProviderId(source.provider);
  if (!provider) throw new Error("Redis label record is missing provider.");
  const label = normalizeLabel(source.label);
  return {
    kind: "aimgr.label.v1",
    provider,
    label,
    stableIdentity: isObject(source.stableIdentity) ? source.stableIdentity : {},
    expect: isObject(source.expect) ? source.expect : {},
    reauth: isObject(source.reauth) ? source.reauth : {},
    browser: isObject(source.browser) ? source.browser : {},
    pool: isObject(source.pool) ? source.pool : { enabled: true },
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : null,
    version: normalizeVersion(source.version),
  };
}

export function normalizeSessionRecord(record = {}, { now = new Date().toISOString() } = {}) {
  const source = isObject(record) ? record : {};
  const provider = normalizeProviderId(source.provider);
  if (!provider) throw new Error("Redis session record is missing provider.");
  const label = normalizeLabel(source.label);
  const machineId = String(source.machineId ?? "").trim();
  if (!machineId) throw new Error("Redis session record is missing machineId.");
  return {
    kind: "aimgr.session.v1",
    provider,
    label,
    machineId,
    sessionId: typeof source.sessionId === "string" && source.sessionId.trim()
      ? source.sessionId.trim()
      : `${provider}:${label}:${machineId}`,
    credential: isObject(source.credential) ? source.credential : {},
    identity: isObject(source.identity) ? source.identity : {},
    lineage: isObject(source.lineage) ? source.lineage : { mode: "independent-login" },
    health: isObject(source.health) ? source.health : { status: "ready", reason: null },
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : machineId,
    version: normalizeVersion(source.version),
  };
}
