import { toIsoFromExpiresMs } from "../core/time.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { assertAnthropicCredentialShape, tryBuildAnthropicCredentialFingerprint } from "./anthropic.js";
import { buildClaudeNativeBundle, normalizeNonEmptyStringArray } from "./claude-bundle.js";
import { tryBuildCodexCredentialFingerprint } from "./codex.js";
import { getImportedCodexLabels } from "../state/accounts.js";
import { getAuthorityAnthropicImportLabelStatus, getImportedAnthropicLabels } from "../state/authority-anthropic.js";
import { getAuthorityCodexImportLabelStatus } from "../state/authority-codex.js";
import { parseTimestampLikeToMs } from "../state/demand.js";

export function clonePortableAnthropicCredential(credential) {
  const cred = isObject(credential) ? structuredClone(credential) : null;
  if (!cred) {
    return null;
  }
  const bundle = buildClaudeNativeBundle(cred.nativeClaudeBundle);
  if (bundle) {
    cred.nativeClaudeBundle = bundle;
  }
  const expiresAt = toIsoFromExpiresMs(parseTimestampLikeToMs(cred.expiresAt));
  if (expiresAt) {
    cred.expiresAt = expiresAt;
  }
  if (Array.isArray(cred.scopes)) {
    cred.scopes = normalizeNonEmptyStringArray(cred.scopes);
  }
  if (typeof cred.emailAddress === "string" && cred.emailAddress.trim()) {
    cred.emailAddress = cred.emailAddress.trim().toLowerCase();
  }
  if (typeof cred.organizationName === "string" && cred.organizationName.trim()) {
    cred.organizationName = cred.organizationName.trim();
  }
  if (typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()) {
    cred.organizationUuid = cred.organizationUuid.trim();
  }
  if (typeof cred.subscriptionType === "string" && cred.subscriptionType.trim()) {
    cred.subscriptionType = cred.subscriptionType.trim();
  }
  if (typeof cred.rateLimitTier === "string" && cred.rateLimitTier.trim()) {
    cred.rateLimitTier = cred.rateLimitTier.trim();
  }
  return cred;
}

export function buildPortableAnthropicCredential({ label, credential }) {
  const cred = assertAnthropicCredentialShape({
    label,
    credential,
    requireFresh: false,
    requireClaudeNativeBundle: true,
  });
  return clonePortableAnthropicCredential(cred);
}

export function normalizeRequestedAnthropicLabels(labels, { context }) {
  const normalized = [];
  const seen = new Set();
  for (const labelRaw of Array.isArray(labels) ? labels : []) {
    const label = normalizeLabel(labelRaw);
    if (seen.has(label)) continue;
    seen.add(label);
    normalized.push(label);
  }
  if (normalized.length === 0) {
    throw new Error(`Missing label list for ${context}.`);
  }
  return normalized;
}

export function buildDirtyImportedCodexSyncConflicts({ state, incomingByLabel }) {
  const conflicts = [];
  for (const label of getImportedCodexLabels(state)) {
    const status = getAuthorityCodexImportLabelStatus(state, label);
    if (!status.dirty) continue;
    const incoming = incomingByLabel.get(label);
    if (!incoming) {
      conflicts.push({ label, reason: "removed_from_authority" });
      continue;
    }
    const incomingFingerprint = tryBuildCodexCredentialFingerprint(incoming.credential);
    if (status.currentFingerprint && incomingFingerprint && status.currentFingerprint === incomingFingerprint) {
      continue;
    }
    conflicts.push({ label, reason: "authority_would_overwrite_local_update" });
  }
  return conflicts;
}

export function buildDirtyImportedAnthropicSyncConflicts({ state, incomingByLabel }) {
  const conflicts = [];
  for (const label of getImportedAnthropicLabels(state)) {
    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    if (!status.dirty) continue;
    const incoming = incomingByLabel.get(label);
    if (!incoming) {
      conflicts.push({ label, reason: "removed_from_authority" });
      continue;
    }
    const incomingFingerprint = tryBuildAnthropicCredentialFingerprint(incoming.credential);
    if (status.currentFingerprint === incomingFingerprint) {
      continue;
    }
    conflicts.push({ label, reason: "authority_would_overwrite_local_update" });
  }
  return conflicts;
}
