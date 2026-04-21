import { normalizeLabel } from "../core/normalize.js";
import { normalizeRequestedAnthropicLabels } from "./anthropic-portable.js";
import { assertCodexCredentialShape } from "./codex.js";
import { getImportedCodexLabels } from "../state/accounts.js";
import { getAuthorityAnthropicImport, getAuthorityAnthropicImportLabelStatus, getImportedAnthropicLabels, normalizeAnthropicAuthorityIdentityRecord } from "../state/authority-anthropic.js";
import { getAuthorityCodexImport, getAuthorityCodexImportLabelStatus } from "../state/authority-codex.js";

export function buildPortableCodexCredential({ label, credential }) {
  const cred = assertCodexCredentialShape({ label, credential, requireFresh: false });
  const next = {
    access: cred.access,
    refresh: cred.refresh,
    expiresAt: cred.expiresAt,
    accountId: cred.accountId,
  };
  if (typeof cred.idToken === "string" && cred.idToken.trim()) {
    next.idToken = cred.idToken.trim();
  }
  return next;
}

export function normalizeRequestedCodexLabels(labels, { context }) {
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

export function buildDirtyImportedCodexLabels(state) {
  return getImportedCodexLabels(state)
    .filter((label) => getAuthorityCodexImportLabelStatus(state, label).dirty)
    .toSorted((a, b) => a.localeCompare(b));
}

export function buildDirtyImportedAnthropicLabels(state) {
  return getImportedAnthropicLabels(state)
    .filter((label) => getAuthorityAnthropicImportLabelStatus(state, label).dirty)
    .toSorted((a, b) => a.localeCompare(b));
}

export function buildAuthorityCodexImportStatus(state) {
  const importMeta = getAuthorityCodexImport(state);
  const labels = getImportedCodexLabels(state);
  const labelsByName = {};
  const dirtyLabels = [];
  for (const label of labels) {
    const status = getAuthorityCodexImportLabelStatus(state, label);
    const meta = status.meta ?? {};
    labelsByName[label] = {
      ...(typeof meta.importedAt === "string" && meta.importedAt.trim() ? { importedAt: meta.importedAt.trim() } : {}),
      ...(typeof meta.baseAccountId === "string" && meta.baseAccountId.trim() ? { baseAccountId: meta.baseAccountId.trim() } : {}),
      dirtyLocal: status.dirty,
      ...(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim() ? { dirtyObservedAt: meta.dirtyObservedAt.trim() } : {}),
      ...(typeof meta.lastPromotedAt === "string" && meta.lastPromotedAt.trim() ? { lastPromotedAt: meta.lastPromotedAt.trim() } : {}),
    };
    if (status.dirty) {
      dirtyLabels.push(label);
    }
  }
  return {
    ...(typeof importMeta.source === "string" && importMeta.source.trim() ? { source: importMeta.source.trim() } : {}),
    ...(typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? { importedAt: importMeta.importedAt.trim() } : {}),
    labels,
    labelsByName,
    dirtyLabels,
  };
}

export function buildAuthorityAnthropicImportStatus(state) {
  const importMeta = getAuthorityAnthropicImport(state);
  const labels = getImportedAnthropicLabels(state);
  const labelsByName = {};
  const dirtyLabels = [];
  for (const label of labels) {
    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    const meta = status.meta ?? {};
    labelsByName[label] = {
      ...(typeof meta.importedAt === "string" && meta.importedAt.trim() ? { importedAt: meta.importedAt.trim() } : {}),
      ...(typeof meta.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
        ? { baseCredentialFingerprint: meta.baseCredentialFingerprint.trim() }
        : {}),
      ...(normalizeAnthropicAuthorityIdentityRecord(meta.baseIdentity)
        ? { baseIdentity: normalizeAnthropicAuthorityIdentityRecord(meta.baseIdentity) }
        : {}),
      dirtyLocal: status.dirty,
      ...(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim() ? { dirtyObservedAt: meta.dirtyObservedAt.trim() } : {}),
      ...(typeof meta.lastPromotedAt === "string" && meta.lastPromotedAt.trim() ? { lastPromotedAt: meta.lastPromotedAt.trim() } : {}),
    };
    if (status.dirty) {
      dirtyLabels.push(label);
    }
  }
  return {
    ...(typeof importMeta.source === "string" && importMeta.source.trim() ? { source: importMeta.source.trim() } : {}),
    ...(typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? { importedAt: importMeta.importedAt.trim() } : {}),
    labels,
    labelsByName,
    dirtyLabels,
  };
}

export function formatDirtyImportedCodexSyncError({ authoritySource, labels }) {
  const joined = normalizeRequestedCodexLabels(labels, { context: "dirty imported labels" }).join(", ");
  return [
    `Authority import would discard locally refreshed imported labels: ${joined}.`,
    `Publish them first with \`aim promote codex --to ${authoritySource || "<authority>"} ${joined}\`,`,
    "or rerun the import with `--discard-dirty` if you want to overwrite the local changes.",
  ].join(" ");
}

export function formatDirtyImportedAnthropicSyncError({ authoritySource, labels }) {
  const joined = normalizeRequestedAnthropicLabels(labels, { context: "dirty imported labels" }).join(", ");
  return [
    `Authority import would discard locally refreshed imported Claude labels: ${joined}.`,
    `Publish them first with \`aim promote claude --to ${authoritySource || "<authority>"} ${joined}\`,`,
    "or rerun the import with `--discard-dirty` if you want to overwrite the local changes.",
  ].join(" ");
}
