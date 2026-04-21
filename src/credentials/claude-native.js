import fs from "node:fs";
import path from "node:path";
import { ensureAccountShape } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { toIsoFromExpiresMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER, CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { buildClaudeCredentialSummaryFromBundle, buildClaudeNativeBundle, deriveAnthropicCredentialFromClaudeBundle, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, readClaudeNativeBundle, updateClaudeBundleTokenFields } from "./claude-bundle.js";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveHomeDir } from "../io/paths.js";
import { getAccountRecord } from "../state/accounts.js";
import { getAuthorityAnthropicImportLabelMeta } from "../state/authority-anthropic.js";
import { ensureStateShape } from "../state/schema.js";

export function captureClaudeNativeBundleFromHome({
  homeDir,
  label,
  expectedAccessToken = null,
  expectedRefreshToken = null,
}) {
  const readback = readClaudeNativeBundle({ homeDir });
  const normalizedLabel = normalizeLabel(label);
  if (readback.credentials.exists !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.credentialsPath} is missing. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (readback.credentials.ok !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: could not read ${readback.credentialsPath} ` +
        `(${readback.credentials.error || "unknown error"}).`,
    );
  }
  if (readback.credentials.claudeAiOauthPresent !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.credentialsPath} is missing claudeAiOauth.`,
    );
  }
  if (readback.appState.exists !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.appStatePath} is missing. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (readback.appState.ok !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: could not read ${readback.appStatePath} ` +
        `(${readback.appState.error || "unknown error"}).`,
    );
  }
  if (readback.appState.oauthAccountPresent !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.appStatePath} is missing oauthAccount. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: the local Claude auth files are incomplete for native switching.`,
    );
  }
  const expectedAccess = typeof expectedAccessToken === "string" ? expectedAccessToken.trim() : "";
  const expectedRefresh = typeof expectedRefreshToken === "string" ? expectedRefreshToken.trim() : "";
  if (
    (expectedAccess && readback.summary.access !== expectedAccess)
    || (expectedRefresh && readback.summary.refresh !== expectedRefresh)
  ) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: the current Claude auth files do not match the freshly authed AIM tokens. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  return {
    nativeClaudeBundle: readback.nativeClaudeBundle,
    summary: readback.summary,
    readback,
  };
}

export function getClaudeNativeBundleIdentity(source) {
  const bundle = getClaudeNativeBundle(source);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  const oauthAccount = isObject(bundle?.oauthAccount) ? bundle.oauthAccount : null;
  const accountUuid =
    typeof oauthAccount?.accountUuid === "string" && oauthAccount.accountUuid.trim()
      ? oauthAccount.accountUuid.trim()
      : null;
  return {
    accountUuid,
    emailAddress: summary?.emailAddress || null,
    organizationUuid: summary?.organizationUuid || null,
    refreshToken: summary?.refresh || null,
  };
}

export function doClaudeNativeBundleIdentitiesMatch(left, right) {
  const leftIdentity = getClaudeNativeBundleIdentity(left);
  const rightIdentity = getClaudeNativeBundleIdentity(right);
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
  if (leftIdentity.refreshToken && rightIdentity.refreshToken) {
    return leftIdentity.refreshToken === rightIdentity.refreshToken;
  }
  return false;
}

export function findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle, excludeLabel } = {}) {
  ensureStateShape(state);
  const excluded = excludeLabel ? normalizeLabel(excludeLabel) : null;
  for (const [label, credential] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (excluded && normalizeLabel(label) === excluded) continue;
    if (!hasCompleteClaudeNativeBundle(credential)) continue;
    if (doClaudeNativeBundleIdentitiesMatch(credential, nativeClaudeBundle)) {
      return normalizeLabel(label);
    }
  }
  return null;
}

// Anthropic rotates refresh tokens on every successful refresh. Claude CLI
// performs its own refreshes and writes the rotated tokens into the live
// files in place; if we overwrite those files before capturing the rotation,
// the stored bundle's refresh token becomes permanently invalid at Anthropic.
// Call this before overwriting live Claude auth so the previous label's
// stored bundle picks up any rotated tokens first.

export function syncLiveClaudeRotationBackToLabel({ state, homeDir }) {
  ensureStateShape(state);
  const live = readClaudeNativeBundle({ homeDir });
  if (!live.exists || live.ok !== true || !hasCompleteClaudeNativeBundle(live.nativeClaudeBundle) || !live.summary) {
    return { synced: false, reason: "no_live_bundle" };
  }
  const target = state.targets?.claudeCli;
  const activeLabel = isObject(target) && typeof target.activeLabel === "string" ? normalizeLabel(target.activeLabel) : null;
  let matchedLabel = null;
  if (activeLabel) {
    const activeCredential = getAnthropicCredential(state, activeLabel);
    if (
      activeCredential
      && hasCompleteClaudeNativeBundle(activeCredential)
      && doClaudeNativeBundleIdentitiesMatch(activeCredential, live.nativeClaudeBundle)
    ) {
      matchedLabel = activeLabel;
    }
  }
  if (!matchedLabel) {
    matchedLabel = findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle: live.nativeClaudeBundle });
  }
  if (!matchedLabel) {
    return { synced: false, reason: "no_label_for_identity" };
  }
  const stored = getAnthropicCredential(state, matchedLabel);
  const storedBundle = getClaudeNativeBundle(stored);
  const storedOauth = isObject(storedBundle?.claudeAiOauth) ? storedBundle.claudeAiOauth : {};
  const liveOauth = live.nativeClaudeBundle.claudeAiOauth;
  const rotatedFields = [];
  if (storedOauth.accessToken !== liveOauth.accessToken) rotatedFields.push("accessToken");
  if (storedOauth.refreshToken !== liveOauth.refreshToken) rotatedFields.push("refreshToken");
  if (storedOauth.expiresAt !== liveOauth.expiresAt) rotatedFields.push("expiresAt");
  if (rotatedFields.length === 0) {
    return { synced: false, reason: "tokens_unchanged", label: matchedLabel };
  }
  const importMeta = getAuthorityAnthropicImportLabelMeta(state, matchedLabel);
  if (importMeta && importMeta.dirtyLocal !== true && typeof importMeta.importedAt === "string") {
    const importedAtMs = Date.parse(importMeta.importedAt);
    let liveMtimeMs = null;
    if (live.credentialsPath) {
      try {
        liveMtimeMs = fs.statSync(live.credentialsPath).mtimeMs;
      } catch {
        liveMtimeMs = null;
      }
    }
    if (
      Number.isFinite(importedAtMs)
      && liveMtimeMs !== null
      && liveMtimeMs <= importedAtMs + 5_000
    ) {
      return { synced: false, reason: "authority_import_newer", label: matchedLabel };
    }
  }
  const refreshedBundle = updateClaudeBundleTokenFields({
    nativeClaudeBundle: storedBundle,
    access: liveOauth.accessToken,
    refresh: liveOauth.refreshToken,
    expiresAt: toIsoFromExpiresMs(liveOauth.expiresAt),
  });
  const nextCredential = deriveAnthropicCredentialFromClaudeBundle({
    existingCredential: stored,
    nativeClaudeBundle: refreshedBundle,
  });
  state.credentials[ANTHROPIC_PROVIDER][matchedLabel] = nextCredential;
  return { synced: true, label: matchedLabel, rotatedFields };
}

export function ensureAnthropicLabelConfigured(state, label) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  const provider = normalizeProviderId(account?.provider);
  if (provider && provider !== ANTHROPIC_PROVIDER) {
    throw new Error(
      `Refusing to store native Claude auth on non-Anthropic label=${normalizedLabel} provider=${provider}.`,
    );
  }
  account.provider = ANTHROPIC_PROVIDER;
  ensureAccountShape(account, { providerHint: ANTHROPIC_PROVIDER });
  account.reauth = {
    ...account.reauth,
    mode: REAUTH_MODE_NATIVE_CLAUDE,
  };
  account.browser = null;
  return account;
}

export function isAnthropicDuplicateNativeBundleErrorMessage(message) {
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  return Boolean(
    normalizedMessage
    && /already stored on label=/i.test(normalizedMessage)
    && /duplicate Anthropic bundle capture\/import/i.test(normalizedMessage),
  );
}

export function resolveAnthropicMaintenanceBlockedReason(message) {
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  if (!normalizedMessage) return null;
  if (isAnthropicDuplicateNativeBundleErrorMessage(normalizedMessage)) {
    return null;
  }
  return /conflict|does not match|expects|unsupported|already stored/i.test(normalizedMessage)
    ? normalizedMessage
    : null;
}

export function resolveAnthropicBlockedReasonForStatus({
  blockedReason,
  hasFreshCredentials,
  hasCompleteClaudeBundle,
}) {
  const normalizedBlockedReason = typeof blockedReason === "string" ? blockedReason.trim() : "";
  if (!normalizedBlockedReason) return "";
  if (
    isAnthropicDuplicateNativeBundleErrorMessage(normalizedBlockedReason)
    && hasFreshCredentials
    && hasCompleteClaudeBundle
  ) {
    return "";
  }
  return normalizedBlockedReason;
}

export function validateAnthropicNativeBundleForLabel({ state, label, nativeClaudeBundle }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error(
      `Refusing to store an incomplete native Claude bundle for label=${normalizedLabel}.`,
    );
  }

  const account = ensureAnthropicLabelConfigured(state, normalizedLabel);
  const expectedEmail =
    typeof account.expect?.email === "string" ? account.expect.email.trim().toLowerCase() : "";
  if (expectedEmail && summary.emailAddress !== expectedEmail) {
    throw new Error(
      `Native Claude login for label=${normalizedLabel} is ${summary.emailAddress}, but AIM expects ${expectedEmail}.`,
    );
  }

  const duplicateLabel = findAnthropicLabelByNativeClaudeBundle(state, {
    nativeClaudeBundle: bundle,
    excludeLabel: normalizedLabel,
  });
  if (duplicateLabel) {
    throw new Error(
      `That native Claude login is already stored on label=${duplicateLabel}. Refusing duplicate Anthropic bundle capture/import.`,
    );
  }

  return {
    bundle,
    summary,
  };
}

export function persistAnthropicNativeBundleForLabel({ state, label, nativeClaudeBundle }) {
  const normalizedLabel = normalizeLabel(label);
  const { bundle, summary } = validateAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle,
  });
  const existingCredential = getAnthropicCredential(state, normalizedLabel);
  const credential = deriveAnthropicCredentialFromClaudeBundle({
    existingCredential,
    nativeClaudeBundle: bundle,
  });
  state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = credential;
  return {
    label: normalizedLabel,
    credential,
    summary,
  };
}

export function buildClaudeNativeBundleExportPayload({ nativeClaudeBundle, labelHint = null, sourceHome = null }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error("Refusing to export an incomplete native Claude bundle.");
  }
  return {
    version: CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION,
    provider: ANTHROPIC_PROVIDER,
    exportedAt: new Date().toISOString(),
    ...(sourceHome ? { sourceHome: path.resolve(sourceHome) } : {}),
    ...(labelHint ? { labelHint: normalizeLabel(labelHint) } : {}),
    nativeClaudeBundle: bundle,
  };
}

export function readClaudeNativeBundleExportFile({ filePath }) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Native Claude bundle file does not exist: ${resolvedPath}`);
  }
  const parsed = readJsonFile(resolvedPath);
  if (!isObject(parsed)) {
    throw new Error(`Native Claude bundle file is not a JSON object: ${resolvedPath}`);
  }
  if (parsed.version !== CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION) {
    throw new Error(
      `Unsupported native Claude bundle file version in ${resolvedPath}: ${String(parsed.version ?? "(missing)")}.`,
    );
  }
  if (normalizeProviderId(parsed.provider) !== ANTHROPIC_PROVIDER) {
    throw new Error(
      `Unsupported provider in native Claude bundle file ${resolvedPath}: ${String(parsed.provider ?? "(missing)")}.`,
    );
  }
  const nativeClaudeBundle = buildClaudeNativeBundle(parsed.nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(nativeClaudeBundle);
  if (!nativeClaudeBundle || !hasCompleteClaudeNativeBundle(nativeClaudeBundle) || !summary) {
    throw new Error(`Native Claude bundle file is incomplete: ${resolvedPath}`);
  }
  const payload = {
    version: CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION,
    provider: ANTHROPIC_PROVIDER,
    exportedAt:
      typeof parsed.exportedAt === "string" && parsed.exportedAt.trim() ? parsed.exportedAt.trim() : new Date().toISOString(),
    ...(typeof parsed.sourceHome === "string" && parsed.sourceHome.trim()
      ? { sourceHome: path.resolve(parsed.sourceHome.trim()) }
      : {}),
    ...(typeof parsed.labelHint === "string" && parsed.labelHint.trim()
      ? { labelHint: normalizeLabel(parsed.labelHint) }
      : {}),
    nativeClaudeBundle,
  };
  return {
    filePath: resolvedPath,
    payload,
    summary,
  };
}

export function writeClaudeNativeBundleExportFile({ filePath, nativeClaudeBundle, labelHint = null, sourceHome = null }) {
  const resolvedPath = path.resolve(filePath);
  const payload = buildClaudeNativeBundleExportPayload({
    nativeClaudeBundle,
    labelHint,
    sourceHome,
  });
  const writeResult = writeJsonFileIfChanged(resolvedPath, payload, { mode: 0o600 });
  return {
    filePath: resolvedPath,
    wrote: writeResult.wrote,
    payload,
    summary: buildClaudeCredentialSummaryFromBundle(payload.nativeClaudeBundle),
  };
}

export function captureAnthropicNativeBundleForLabel({ state, label, sourceHome }) {
  const normalizedLabel = normalizeLabel(label);
  const source = resolveHomeDir(sourceHome);
  const captured = captureClaudeNativeBundleFromHome({
    homeDir: source,
    label: normalizedLabel,
  });
  const persisted = persistAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle: captured.nativeClaudeBundle,
  });
  return {
    label: normalizedLabel,
    sourceHome: source,
    readback: captured.readback,
    summary: persisted.summary,
    credential: persisted.credential,
  };
}

export function importAnthropicNativeBundleForLabel({ state, label, filePath }) {
  const normalizedLabel = normalizeLabel(label);
  const imported = readClaudeNativeBundleExportFile({ filePath });
  const persisted = persistAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle: imported.payload.nativeClaudeBundle,
  });
  return {
    label: normalizedLabel,
    filePath: imported.filePath,
    summary: persisted.summary,
    credential: persisted.credential,
    exportedAt: imported.payload.exportedAt,
    labelHint: imported.payload.labelHint ?? null,
    sourceHome: imported.payload.sourceHome ?? null,
  };
}

export function exportLiveClaudeNativeBundle({ filePath, sourceHome, labelHint = null }) {
  const source = resolveHomeDir(sourceHome);
  const readback = readClaudeNativeBundle({ homeDir: source });
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error(
      `No complete native Claude login is available under ${source}. Run native Claude login there first.`,
    );
  }
  const exported = writeClaudeNativeBundleExportFile({
    filePath,
    nativeClaudeBundle: readback.nativeClaudeBundle,
    labelHint,
    sourceHome: source,
  });
  return {
    sourceHome: source,
    readback,
    ...exported,
  };
}
