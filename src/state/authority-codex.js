import { isObject, normalizeLabel } from "../core/normalize.js";
import { getCodexCredentialFromStateUnsafe, tryBuildCodexCredentialFingerprint } from "../credentials/codex.js";
export { normalizeAuthorityCodexImportMetadata } from "./authority-normalize.js";
import { ensureStateShape } from "./schema.js";

export function getAuthorityCodexImport(state) {
  ensureStateShape(state);
  return state.imports.authority.codex;
}

export function getAuthorityCodexImportLabelMeta(state, label) {
  const normalizedLabel = normalizeLabel(label);
  const labelsByName = getAuthorityCodexImport(state).labelsByName;
  return isObject(labelsByName?.[normalizedLabel]) ? labelsByName[normalizedLabel] : null;
}

export function getImportedCodexLabels(state) {
  const imported = getAuthorityCodexImport(state);
  const labels = Array.isArray(imported.labels) ? imported.labels : [];
  const normalized = [];
  for (const label of labels) {
    try {
      normalized.push(normalizeLabel(label));
    } catch {
      // Ignore malformed imported labels in status surfaces; import paths validate strictly.
    }
  }
  return [...new Set(normalized)].toSorted((a, b) => a.localeCompare(b));
}

export function isImportedCodexLabel(state, label) {
  const normalizedLabel = normalizeLabel(label);
  return getImportedCodexLabels(state).includes(normalizedLabel);
}

export function getAuthorityCodexImportLabelStatus(state, label) {
  const normalizedLabel = normalizeLabel(label);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return {
      imported: false,
      dirty: false,
      meta: null,
      currentFingerprint: null,
      baseFingerprint: null,
      currentAccountId: null,
      baseAccountId: null,
    };
  }

  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  const credential = getCodexCredentialFromStateUnsafe(state, normalizedLabel);
  const currentFingerprint = tryBuildCodexCredentialFingerprint(credential);
  const currentAccountId =
    typeof credential?.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
  const baseFingerprint =
    typeof meta?.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
      ? meta.baseCredentialFingerprint.trim()
      : null;
  const baseAccountId =
    typeof meta?.baseAccountId === "string" && meta.baseAccountId.trim() ? meta.baseAccountId.trim() : null;
  const dirty =
    meta?.dirtyLocal === true
    || Boolean(currentFingerprint && baseFingerprint && currentFingerprint !== baseFingerprint)
    || Boolean(currentAccountId && baseAccountId && currentAccountId !== baseAccountId);

  return {
    imported: true,
    dirty,
    meta,
    currentFingerprint,
    baseFingerprint,
    currentAccountId,
    baseAccountId,
  };
}

export function markImportedCodexLabelDirtyState(state, label, { observedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return { imported: false, dirty: false };
  }

  const status = getAuthorityCodexImportLabelStatus(state, normalizedLabel);
  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  if (!meta) {
    return { imported: true, dirty: status.dirty };
  }
  if (status.dirty) {
    meta.dirtyLocal = true;
    if (!(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim())) {
      meta.dirtyObservedAt = String(observedAt ?? new Date().toISOString());
    }
  } else {
    meta.dirtyLocal = false;
    if (Object.hasOwn(meta, "dirtyObservedAt")) {
      delete meta.dirtyObservedAt;
    }
  }
  return { imported: true, dirty: meta.dirtyLocal === true };
}

export function markImportedCodexLabelPromoted(state, label, { promotedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return { imported: false };
  }
  const credential = getCodexCredentialFromStateUnsafe(state, normalizedLabel);
  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  if (!meta || !credential) {
    return { imported: true };
  }
  const fingerprint = tryBuildCodexCredentialFingerprint(credential);
  const accountId = typeof credential.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
  if (fingerprint) {
    meta.baseCredentialFingerprint = fingerprint;
  }
  if (accountId) {
    meta.baseAccountId = accountId;
  }
  meta.dirtyLocal = false;
  if (Object.hasOwn(meta, "dirtyObservedAt")) {
    delete meta.dirtyObservedAt;
  }
  meta.lastPromotedAt = String(promotedAt ?? new Date().toISOString());
  return { imported: true };
}
