import { AIMGR_REDIS_DEFAULT_KEY_PREFIX } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";

function normalizeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function timestamp(value, fallback) {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

export function hasCredentialMaterial(value) {
  return isObject(value) && Object.keys(value).length > 0;
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

function normalizeCredentialPolicy(source) {
  const policy = isObject(source.policy) ? source.policy : {};
  return {
    expect: isObject(policy.expect) ? policy.expect : isObject(source.expect) ? source.expect : {},
    reauth: isObject(policy.reauth) ? policy.reauth : isObject(source.reauth) ? source.reauth : {},
    browser: isObject(policy.browser) ? policy.browser : isObject(source.browser) ? source.browser : {},
    pool: isObject(policy.pool) ? policy.pool : isObject(source.pool) ? source.pool : { enabled: true },
  };
}

export function normalizeCredentialRecord(record = {}, { now = new Date().toISOString() } = {}) {
  const source = isObject(record) ? record : {};
  const provider = normalizeProviderId(source.provider);
  if (!provider) throw new Error("Redis credential record is missing provider.");
  const label = normalizeLabel(source.label);
  const credential = isObject(source.credential) ? source.credential : {};
  const policy = normalizeCredentialPolicy(source);
  return {
    kind: "aimgr.credential.v1",
    provider,
    label,
    credential,
    identity: isObject(source.identity) ? source.identity : isObject(source.stableIdentity) ? source.stableIdentity : {},
    policy,
    // A Desktop-reserved record is deliberately credential-empty but is not a
    // pool "candidate": its credential lineage is native-owned by the Codex
    // Desktop app, so normalization must round-trip that fixed health shape
    // instead of downgrading it to credential_missing.
    health: hasCredentialMaterial(credential)
      ? isObject(source.health)
        ? source.health
        : { status: "ready", reason: null }
      : policy.expect?.codexDesktop?.reserved === true
        ? { status: "native_owned", reason: "codex_desktop_reserved" }
        : { status: "candidate", reason: "credential_missing" },
    provenance: isObject(source.provenance) ? source.provenance : {},
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : null,
    version: normalizeVersion(source.version),
  };
}
