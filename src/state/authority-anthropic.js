import { isObject, normalizeLabel } from "../core/normalize.js";
import { tryBuildAnthropicCredentialFingerprint } from "../credentials/anthropic.js";
import { getAnthropicCredentialFromStateUnsafe } from "../credentials/codex.js";
import {
  buildAnthropicAuthorityIdentityFromCredential,
  doAnthropicAuthorityIdentitiesMatch,
  normalizeAnthropicAuthorityIdentityRecord,
} from "./authority-normalize.js";
export {
  buildAnthropicAuthorityIdentityFromCredential,
  doAnthropicAuthorityIdentitiesMatch,
  normalizeAnthropicAuthorityIdentityRecord,
  normalizeAuthorityAnthropicImportMetadata,
} from "./authority-normalize.js";
import { ensureStateShape } from "./schema.js";

export function getAuthorityAnthropicImport(state) {
  ensureStateShape(state);
  return state.imports.authority.anthropic;
}

export function getAuthorityAnthropicImportLabelMeta(state, label) {
  const normalizedLabel = normalizeLabel(label);
  const labelsByName = getAuthorityAnthropicImport(state).labelsByName;
  return isObject(labelsByName?.[normalizedLabel]) ? labelsByName[normalizedLabel] : null;
}

export function getImportedAnthropicLabels(state) {
  const imported = getAuthorityAnthropicImport(state);
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

export function isImportedAnthropicLabel(state, label) {
  const normalizedLabel = normalizeLabel(label);
  return getImportedAnthropicLabels(state).includes(normalizedLabel);
}

export function getAuthorityAnthropicImportLabelStatus(state, label) {
  const normalizedLabel = normalizeLabel(label);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return {
      imported: false,
      dirty: false,
      meta: null,
      currentFingerprint: null,
      baseFingerprint: null,
      currentIdentity: null,
      baseIdentity: null,
    };
  }

  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
  const credential = getAnthropicCredentialFromStateUnsafe(state, normalizedLabel);
  const currentFingerprint = tryBuildAnthropicCredentialFingerprint(credential);
  const currentIdentity = buildAnthropicAuthorityIdentityFromCredential(credential);
  const baseFingerprint =
    typeof meta?.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
      ? meta.baseCredentialFingerprint.trim()
      : null;
  const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(meta?.baseIdentity);
  const dirty =
    meta?.dirtyLocal === true
    || currentFingerprint !== baseFingerprint
    || Boolean(currentIdentity && baseIdentity && !doAnthropicAuthorityIdentitiesMatch(currentIdentity, baseIdentity));

  return {
    imported: true,
    dirty,
    meta,
    currentFingerprint,
    baseFingerprint,
    currentIdentity,
    baseIdentity,
  };
}

export function markImportedAnthropicLabelDirtyState(state, label, { observedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return { imported: false, dirty: false };
  }

  const status = getAuthorityAnthropicImportLabelStatus(state, normalizedLabel);
  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
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

export function markImportedAnthropicLabelPromoted(state, label, { promotedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return { imported: false };
  }
  const credential = getAnthropicCredentialFromStateUnsafe(state, normalizedLabel);
  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
  if (!meta) {
    return { imported: true };
  }
  const fingerprint = tryBuildAnthropicCredentialFingerprint(credential);
  const identity = buildAnthropicAuthorityIdentityFromCredential(credential);
  if (fingerprint) {
    meta.baseCredentialFingerprint = fingerprint;
  } else if (Object.hasOwn(meta, "baseCredentialFingerprint")) {
    delete meta.baseCredentialFingerprint;
  }
  if (identity) {
    meta.baseIdentity = identity;
  } else if (Object.hasOwn(meta, "baseIdentity")) {
    delete meta.baseIdentity;
  }
  meta.dirtyLocal = false;
  if (Object.hasOwn(meta, "dirtyObservedAt")) {
    delete meta.dirtyObservedAt;
  }
  meta.lastPromotedAt = String(promotedAt ?? new Date().toISOString());
  return { imported: true };
}
