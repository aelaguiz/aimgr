import { randomUUID } from "node:crypto";
import os from "node:os";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { guardedDeleteWithRedisCredentialLease } from "./redis-credential-lease.js";
import { normalizeKeyPrefix } from "./records.js";

export const AIMGR_CLAUDE_ROTATION_FENCE_KIND = "aimgr.claude-rotation-fence.v1";
// Bounds how long a rotation fence can quarantine an account before any
// machine may recover the label from the Redis bundle.
export const CLAUDE_ROTATION_FENCE_TTL_MS = 24 * 60 * 60 * 1000;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVENANCE_FENCE_ID = "claudeRotationFenceId";
const PROVENANCE_BASE_FINGERPRINT = "claudeRotationBaseTokenLineageFingerprint";
const PROVENANCE_BASE_VERSION = "claudeRotationBaseCredentialVersion";
const PROVEN_ROTATION_SOURCE_TYPES = new Set([
  "login-maintenance",
  "native-claude-rotation",
]);

function requireStore(store) {
  const rawPrefix = typeof store?.keyPrefix === "string" ? store.keyPrefix.trim() : "";
  if (
    !rawPrefix
    || typeof store?.client?.get !== "function"
    || typeof store?.client?.set !== "function"
    || typeof store?.client?.eval !== "function"
  ) {
    throw new Error("Invalid Redis store for Claude rotation fence.");
  }
  return normalizeKeyPrefix(rawPrefix);
}

function buildFenceKey(store, label) {
  return `${requireStore(store)}fence:claude-rotation:${normalizeLabel(label)}`;
}

function normalizeIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeFence(value, expectedLabel) {
  const label = normalizeLabel(value?.label);
  const createdAt = normalizeIsoTimestamp(value?.createdAt);
  if (
    value?.kind !== AIMGR_CLAUDE_ROTATION_FENCE_KIND
    || value?.version !== 1
    || label !== normalizeLabel(expectedLabel)
    || typeof value?.fenceId !== "string"
    || !UUID_PATTERN.test(value.fenceId)
    || !SHA256_PATTERN.test(String(value?.recoveryStorageId ?? ""))
    || !SHA256_PATTERN.test(String(value?.baseTokenLineageFingerprint ?? ""))
    || !Number.isInteger(value?.baseCredentialVersion)
    || value.baseCredentialVersion < 1
    || !createdAt
  ) {
    throw new Error("Redis Claude rotation fence is invalid.");
  }
  const createdByHost = typeof value?.createdByHost === "string" && value.createdByHost.trim()
    ? value.createdByHost.trim()
    : null;
  return Object.freeze({
    kind: AIMGR_CLAUDE_ROTATION_FENCE_KIND,
    version: 1,
    fenceId: value.fenceId,
    label,
    recoveryStorageId: value.recoveryStorageId,
    baseTokenLineageFingerprint: value.baseTokenLineageFingerprint,
    baseCredentialVersion: value.baseCredentialVersion,
    createdAt,
    ...(createdByHost ? { createdByHost } : {}),
  });
}

export async function readRedisClaudeRotationFence(store, { label } = {}) {
  const normalizedLabel = normalizeLabel(label);
  const key = buildFenceKey(store, normalizedLabel);
  let raw;
  try {
    raw = await store.client.get(key);
  } catch {
    throw new Error("Redis Claude rotation fence read failed.");
  }
  if (raw === null) return null;
  try {
    return normalizeFence(JSON.parse(raw), normalizedLabel);
  } catch {
    throw new Error("Redis Claude rotation fence is invalid.");
  }
}

export async function createRedisClaudeRotationFence(store, {
  label,
  recoveryStorageId,
  baseTokenLineageFingerprint,
  baseCredentialVersion,
  observedAt = new Date().toISOString(),
} = {}) {
  const normalizedLabel = normalizeLabel(label);
  const record = normalizeFence({
    kind: AIMGR_CLAUDE_ROTATION_FENCE_KIND,
    version: 1,
    fenceId: randomUUID(),
    label: normalizedLabel,
    recoveryStorageId,
    baseTokenLineageFingerprint,
    baseCredentialVersion,
    createdAt: observedAt,
    createdByHost: os.hostname(),
  }, normalizedLabel);
  const key = buildFenceKey(store, normalizedLabel);
  let written;
  try {
    written = await store.client.set(key, JSON.stringify(record), { condition: "NX" });
  } catch {
    throw new Error("Redis Claude rotation fence creation failed.");
  }
  if (written === null) return null;
  if (written !== "OK") throw new Error("Redis Claude rotation fence creation failed.");
  return record;
}

export function buildRedisClaudeRotationFenceProvenance(provenance, fence) {
  const next = provenance && typeof provenance === "object" && !Array.isArray(provenance)
    ? { ...provenance }
    : {};
  delete next[PROVENANCE_FENCE_ID];
  delete next[PROVENANCE_BASE_FINGERPRINT];
  delete next[PROVENANCE_BASE_VERSION];
  if (!fence) return next;
  const normalized = normalizeFence(fence, fence.label);
  return {
    ...next,
    [PROVENANCE_FENCE_ID]: normalized.fenceId,
    [PROVENANCE_BASE_FINGERPRINT]: normalized.baseTokenLineageFingerprint,
    [PROVENANCE_BASE_VERSION]: normalized.baseCredentialVersion,
  };
}

export function isRedisClaudeRotationFenceSuccessor(record, {
  fence,
  tokenLineageFingerprint,
} = {}) {
  if (!fence || !record) return false;
  const normalized = normalizeFence(fence, fence.label);
  const provenance = record.provenance && typeof record.provenance === "object" && !Array.isArray(record.provenance)
    ? record.provenance
    : {};
  return (
    normalizeLabel(record.label) === normalized.label
    && Number.isInteger(record.version)
    && record.version > normalized.baseCredentialVersion
    && SHA256_PATTERN.test(String(tokenLineageFingerprint ?? ""))
    && tokenLineageFingerprint !== normalized.baseTokenLineageFingerprint
    && provenance[PROVENANCE_FENCE_ID] === normalized.fenceId
    && provenance[PROVENANCE_BASE_FINGERPRINT] === normalized.baseTokenLineageFingerprint
    && provenance[PROVENANCE_BASE_VERSION] === normalized.baseCredentialVersion
  );
}

export function isRedisClaudeRotationSuccessorOfFingerprint(record, {
  label,
  baseTokenLineageFingerprint,
  tokenLineageFingerprint,
} = {}) {
  const provenance = record?.provenance && typeof record.provenance === "object" && !Array.isArray(record.provenance)
    ? record.provenance
    : {};
  const baseCredentialVersion = provenance[PROVENANCE_BASE_VERSION];
  return (
    normalizeProviderId(record?.provider) === ANTHROPIC_PROVIDER
    && normalizeLabel(record?.label) === normalizeLabel(label)
    && Number.isInteger(record?.version)
    && Number.isInteger(baseCredentialVersion)
    && baseCredentialVersion >= 1
    && record.version > baseCredentialVersion
    && UUID_PATTERN.test(String(provenance[PROVENANCE_FENCE_ID] ?? ""))
    && SHA256_PATTERN.test(String(baseTokenLineageFingerprint ?? ""))
    && provenance[PROVENANCE_BASE_FINGERPRINT] === baseTokenLineageFingerprint
    && PROVEN_ROTATION_SOURCE_TYPES.has(provenance.lastSourceType)
    && SHA256_PATTERN.test(String(tokenLineageFingerprint ?? ""))
    && tokenLineageFingerprint !== baseTokenLineageFingerprint
  );
}

export async function clearRedisClaudeRotationFence(store, { label, fenceId, lease } = {}) {
  const normalizedLabel = normalizeLabel(label);
  const key = buildFenceKey(store, normalizedLabel);
  const current = await readRedisClaudeRotationFence(store, { label: normalizedLabel });
  if (!current || current.fenceId !== fenceId) return false;
  const raw = JSON.stringify(current);
  try {
    return await guardedDeleteWithRedisCredentialLease(lease, {
      targetKey: key,
      expectedValue: raw,
    });
  } catch {
    throw new Error("Redis Claude rotation fence clear failed.");
  }
}
