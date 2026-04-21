import { isObject } from "../core/normalize.js";
import { tryBuildAnthropicCredentialFingerprint } from "../credentials/anthropic.js";
import { buildClaudeCredentialSummaryFromBundle, getClaudeNativeBundle } from "../credentials/claude-bundle.js";
import {
  getAnthropicCredentialFromStateUnsafe,
  getCodexCredentialFromStateUnsafe,
  tryBuildCodexCredentialFingerprint,
} from "../credentials/codex.js";
import { collectNormalizedAuthorityImportEntries } from "./authority-metadata.js";

export function buildAnthropicAuthorityIdentityFromCredential(credential) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) return null;
  const bundle = getClaudeNativeBundle(cred);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  const oauthAccount = isObject(bundle?.oauthAccount) ? bundle.oauthAccount : null;
  const accountUuid =
    typeof oauthAccount?.accountUuid === "string" && oauthAccount.accountUuid.trim()
      ? oauthAccount.accountUuid.trim()
      : null;
  const emailAddress =
    typeof cred.emailAddress === "string" && cred.emailAddress.trim()
      ? cred.emailAddress.trim().toLowerCase()
      : summary?.emailAddress || null;
  const organizationUuid =
    typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()
      ? cred.organizationUuid.trim()
      : summary?.organizationUuid || null;
  if (!accountUuid && !(emailAddress && organizationUuid)) {
    return null;
  }
  return {
    ...(accountUuid ? { accountUuid } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  };
}

export function normalizeAnthropicAuthorityIdentityRecord(value) {
  if (!isObject(value)) return null;
  const accountUuid =
    typeof value.accountUuid === "string" && value.accountUuid.trim() ? value.accountUuid.trim() : null;
  const emailAddress =
    typeof value.emailAddress === "string" && value.emailAddress.trim()
      ? value.emailAddress.trim().toLowerCase()
      : null;
  const organizationUuid =
    typeof value.organizationUuid === "string" && value.organizationUuid.trim()
      ? value.organizationUuid.trim()
      : null;
  if (!accountUuid && !(emailAddress && organizationUuid)) {
    return null;
  }
  return {
    ...(accountUuid ? { accountUuid } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  };
}

export function doAnthropicAuthorityIdentitiesMatch(left, right) {
  const leftIdentity = normalizeAnthropicAuthorityIdentityRecord(left);
  const rightIdentity = normalizeAnthropicAuthorityIdentityRecord(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  if (leftIdentity.accountUuid && rightIdentity.accountUuid) {
    return leftIdentity.accountUuid === rightIdentity.accountUuid;
  }
  if (
    leftIdentity.emailAddress
    && rightIdentity.emailAddress
    && leftIdentity.organizationUuid
    && rightIdentity.organizationUuid
  ) {
    return (
      leftIdentity.emailAddress === rightIdentity.emailAddress
      && leftIdentity.organizationUuid === rightIdentity.organizationUuid
    );
  }
  return false;
}

export function normalizeAuthorityCodexImportMetadata(state) {
  const importMeta = isObject(state.imports?.authority?.codex) ? state.imports.authority.codex : {};
  const { labels: nextLabels, metaByLabel } = collectNormalizedAuthorityImportEntries(importMeta);
  const importedAtFallback =
    typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? importMeta.importedAt.trim() : null;
  const nextLabelsByName = {};

  for (const label of nextLabels) {
    const existing = metaByLabel.get(label) ?? {};
    const credential = getCodexCredentialFromStateUnsafe(state, label);
    const currentFingerprint = tryBuildCodexCredentialFingerprint(credential);
    const currentAccountId =
      typeof credential?.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
    const importedAt =
      typeof existing.importedAt === "string" && existing.importedAt.trim()
        ? existing.importedAt.trim()
        : importedAtFallback;
    const baseAccountId =
      typeof existing.baseAccountId === "string" && existing.baseAccountId.trim()
        ? existing.baseAccountId.trim()
        : currentAccountId;
    const baseCredentialFingerprint =
      typeof existing.baseCredentialFingerprint === "string" && existing.baseCredentialFingerprint.trim()
        ? existing.baseCredentialFingerprint.trim()
        : currentFingerprint;
    const dirtyObservedAt =
      typeof existing.dirtyObservedAt === "string" && existing.dirtyObservedAt.trim()
        ? existing.dirtyObservedAt.trim()
        : null;
    const lastPromotedAt =
      typeof existing.lastPromotedAt === "string" && existing.lastPromotedAt.trim()
        ? existing.lastPromotedAt.trim()
        : null;

    nextLabelsByName[label] = {
      ...(importedAt ? { importedAt } : {}),
      ...(baseAccountId ? { baseAccountId } : {}),
      ...(baseCredentialFingerprint ? { baseCredentialFingerprint } : {}),
      dirtyLocal: existing.dirtyLocal === true,
      ...(dirtyObservedAt ? { dirtyObservedAt } : {}),
      ...(lastPromotedAt ? { lastPromotedAt } : {}),
    };
  }

  importMeta.labels = nextLabels;
  importMeta.labelsByName = nextLabelsByName;
  state.imports.authority.codex = importMeta;
}

export function normalizeAuthorityAnthropicImportMetadata(state) {
  const importMeta = isObject(state.imports?.authority?.anthropic) ? state.imports.authority.anthropic : {};
  const { labels: nextLabels, metaByLabel } = collectNormalizedAuthorityImportEntries(importMeta);
  const importedAtFallback =
    typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? importMeta.importedAt.trim() : null;
  const nextLabelsByName = {};

  for (const label of nextLabels) {
    const hasExistingMeta = metaByLabel.has(label);
    const existing = metaByLabel.get(label) ?? {};
    const credential = getAnthropicCredentialFromStateUnsafe(state, label);
    const currentFingerprint = tryBuildAnthropicCredentialFingerprint(credential);
    const currentIdentity = buildAnthropicAuthorityIdentityFromCredential(credential);
    const importedAt =
      typeof existing.importedAt === "string" && existing.importedAt.trim()
        ? existing.importedAt.trim()
        : importedAtFallback;
    const baseCredentialFingerprint =
      typeof existing.baseCredentialFingerprint === "string" && existing.baseCredentialFingerprint.trim()
        ? existing.baseCredentialFingerprint.trim()
        : hasExistingMeta
          ? null
          : currentFingerprint;
    const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(existing.baseIdentity)
      ?? (hasExistingMeta ? null : currentIdentity);
    const dirtyObservedAt =
      typeof existing.dirtyObservedAt === "string" && existing.dirtyObservedAt.trim()
        ? existing.dirtyObservedAt.trim()
        : null;
    const lastPromotedAt =
      typeof existing.lastPromotedAt === "string" && existing.lastPromotedAt.trim()
        ? existing.lastPromotedAt.trim()
        : null;

    nextLabelsByName[label] = {
      ...(importedAt ? { importedAt } : {}),
      ...(baseCredentialFingerprint ? { baseCredentialFingerprint } : {}),
      ...(baseIdentity ? { baseIdentity } : {}),
      dirtyLocal: existing.dirtyLocal === true,
      ...(dirtyObservedAt ? { dirtyObservedAt } : {}),
      ...(lastPromotedAt ? { lastPromotedAt } : {}),
    };
  }

  importMeta.labels = nextLabels;
  importMeta.labelsByName = nextLabelsByName;
  state.imports.authority.anthropic = importMeta;
}
