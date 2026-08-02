import { isObject, normalizeLabel } from "../core/normalize.js";
import { assertAnthropicCredentialShape, tryBuildAnthropicCredentialFingerprint } from "./anthropic.js";
import { buildClaudeNativeBundle, deriveAnthropicCredentialFromClaudeBundle } from "./claude-bundle.js";
import { tryBuildCodexCredentialFingerprint } from "./codex.js";
import { getImportedCodexLabels } from "../state/accounts.js";
import { getAuthorityAnthropicImportLabelStatus, getImportedAnthropicLabels } from "../state/authority-anthropic.js";
import { getAuthorityCodexImportLabelStatus } from "../state/authority-codex.js";

export function clonePortableAnthropicCredential(credential) {
  const cred = isObject(credential) ? structuredClone(credential) : null;
  if (!cred) {
    return null;
  }
  const bundle = buildClaudeNativeBundle(cred.nativeClaudeBundle);
  return bundle
    ? deriveAnthropicCredentialFromClaudeBundle({ existingCredential: cred, nativeClaudeBundle: bundle })
    : null;
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
