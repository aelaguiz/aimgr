import fs from "node:fs";
import path from "node:path";
import { ensureAccountShape } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { buildClaudeCredentialSummaryFromBundle, buildClaudeNativeBundle, deriveAnthropicCredentialFromClaudeBundle, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, readClaudeNativeBundle } from "./claude-bundle.js";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveHomeDir } from "../io/paths.js";
import { getAccountRecord } from "../state/accounts.js";
import { getAuthorityAnthropicImportLabelMeta } from "../state/authority-anthropic.js";
import { ensureStateShape } from "../state/schema.js";
import { readClaudeNativeBundleFromStorage } from "./claude-native-storage.js";

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

export function getStrictClaudeNativeBundleIdentity(source) {
  const identity = getClaudeNativeBundleIdentity(source);
  return identity.accountUuid && identity.emailAddress && identity.organizationUuid
    ? {
        accountUuid: identity.accountUuid,
        emailAddress: identity.emailAddress,
        organizationUuid: identity.organizationUuid,
      }
    : null;
}

export function doClaudeNativeBundleIdentitiesMatch(left, right) {
  const leftIdentity = getStrictClaudeNativeBundleIdentity(left);
  const rightIdentity = getStrictClaudeNativeBundleIdentity(right);
  return Boolean(
    leftIdentity
    && rightIdentity
    && leftIdentity.accountUuid === rightIdentity.accountUuid
    && leftIdentity.emailAddress === rightIdentity.emailAddress
    && leftIdentity.organizationUuid === rightIdentity.organizationUuid
  );
}

function nativeTokenSet(source) {
  const bundle = getClaudeNativeBundle(source);
  const oauth = isObject(bundle?.claudeAiOauth) ? bundle.claudeAiOauth : null;
  return oauth
    ? {
        accessToken: typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "",
        refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken.trim() : "",
        expiresAtMs: Number(oauth.expiresAt),
      }
    : null;
}

function hasSameNativeTokenSet(left, right) {
  const a = nativeTokenSet(left);
  const b = nativeTokenSet(right);
  return Boolean(
    a
    && b
    && a.accessToken
    && a.refreshToken
    && a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken
    && a.expiresAtMs === b.expiresAtMs
  );
}

export function planClaudeNativeBundleReplacement({
  currentBundle,
  candidateBundle,
  expectedEmail = null,
  nowMs = Date.now(),
  minRemainingMs = 0,
  allowExpiredCandidate = false,
} = {}) {
  const candidate = buildClaudeNativeBundle(getClaudeNativeBundle(candidateBundle));
  const candidateIdentity = getStrictClaudeNativeBundleIdentity(candidate);
  const candidateOauth = nativeTokenSet(candidate);
  const normalizedExpectedEmail = typeof expectedEmail === "string" ? expectedEmail.trim().toLowerCase() : "";
  if (!candidate || !hasCompleteClaudeNativeBundle(candidate) || !candidateIdentity || !candidateOauth) {
    return { ok: false, action: "blocked", reason: "candidate_incomplete" };
  }
  if (normalizedExpectedEmail && candidateIdentity.emailAddress !== normalizedExpectedEmail) {
    return { ok: false, action: "blocked", reason: "identity_mismatch" };
  }
  const current = buildClaudeNativeBundle(getClaudeNativeBundle(currentBundle));
  if (!current && isObject(currentBundle) && Object.keys(currentBundle).length > 0) {
    return { ok: false, action: "blocked", reason: "current_incomplete" };
  }
  if (current) {
    if (!hasCompleteClaudeNativeBundle(current)) {
      return { ok: false, action: "blocked", reason: "current_incomplete" };
    }
    if (!doClaudeNativeBundleIdentitiesMatch(current, candidate)) {
      return { ok: false, action: "blocked", reason: "identity_conflict" };
    }
    if (hasSameNativeTokenSet(current, candidate)) {
      return { ok: true, action: "noop", reason: "tokens_unchanged" };
    }
  }

  const freshnessFloor = Number(nowMs) + Math.max(0, Number(minRemainingMs) || 0);
  if (
    !Number.isFinite(candidateOauth.expiresAtMs)
    || (!allowExpiredCandidate && candidateOauth.expiresAtMs <= freshnessFloor)
  ) {
    return { ok: false, action: "blocked", reason: "candidate_expired" };
  }
  if (!current) return { ok: true, action: "create", reason: "empty_current" };

  const currentOauth = nativeTokenSet(current);
  if (!currentOauth || !Number.isFinite(currentOauth.expiresAtMs)) {
    return { ok: false, action: "blocked", reason: "current_incomplete" };
  }
  if (candidateOauth.expiresAtMs < currentOauth.expiresAtMs) {
    return { ok: false, action: "blocked", reason: "stale_candidate" };
  }
  if (candidateOauth.expiresAtMs === currentOauth.expiresAtMs) {
    return { ok: false, action: "blocked", reason: "ambiguous_equal_expiry" };
  }
  return { ok: true, action: "update", reason: "candidate_newer" };
}

function strictClaudeIdentitiesFromRecord(record) {
  const identity = isObject(record?.identity) ? record.identity : {};
  const accountUuid = typeof identity.accountUuid === "string" ? identity.accountUuid.trim() : "";
  const emailAddress = typeof identity.emailAddress === "string" ? identity.emailAddress.trim().toLowerCase() : "";
  const organizationUuid = typeof identity.organizationUuid === "string" ? identity.organizationUuid.trim() : "";
  const stored = accountUuid && emailAddress && organizationUuid
    ? { accountUuid, emailAddress, organizationUuid }
    : null;
  const derived = getStrictClaudeNativeBundleIdentity(record?.credential);
  return [stored, derived].filter(Boolean);
}

export function findAnthropicSnapshotIdentityConflict(snapshot, {
  nativeClaudeBundle,
  excludeLabel,
} = {}) {
  const candidateIdentity = getStrictClaudeNativeBundleIdentity(nativeClaudeBundle);
  if (!candidateIdentity) return null;
  const excluded = excludeLabel ? normalizeLabel(excludeLabel) : null;
  for (const record of snapshot?.credentials ?? []) {
    if (normalizeProviderId(record?.provider) !== ANTHROPIC_PROVIDER) continue;
    const label = normalizeLabel(record.label);
    if (excluded && label === excluded) continue;
    const matches = strictClaudeIdentitiesFromRecord(record).some((recordIdentity) =>
      recordIdentity.accountUuid === candidateIdentity.accountUuid
      && recordIdentity.emailAddress === candidateIdentity.emailAddress
      && recordIdentity.organizationUuid === candidateIdentity.organizationUuid);
    if (matches) {
      return label;
    }
  }
  return null;
}

export function assertNoAnthropicSnapshotIdentityConflict(snapshot, options = {}) {
  const duplicateLabel = findAnthropicSnapshotIdentityConflict(snapshot, options);
  if (duplicateLabel) {
    throw new Error(
      `That native Claude login is already stored on label=${duplicateLabel}. Refusing duplicate Anthropic bundle capture/import.`,
    );
  }
}

export function findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle, excludeLabel } = {}) {
  const excluded = excludeLabel ? normalizeLabel(excludeLabel) : null;
  const credentials = isObject(state?.credentials?.[ANTHROPIC_PROVIDER])
    ? state.credentials[ANTHROPIC_PROVIDER]
    : {};
  for (const [label, credential] of Object.entries(credentials)) {
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

export function syncClaudeNativeBundleBackToLabel({
  state,
  nativeClaudeBundle,
  source = "file",
  credentialsPath = null,
  nowMs = Date.now(),
}) {
  ensureStateShape(state);
  const liveBundle = buildClaudeNativeBundle(nativeClaudeBundle);
  if (!hasCompleteClaudeNativeBundle(liveBundle) || !getStrictClaudeNativeBundleIdentity(liveBundle)) {
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
      && doClaudeNativeBundleIdentitiesMatch(activeCredential, liveBundle)
    ) {
      matchedLabel = activeLabel;
    }
  }
  if (!matchedLabel) {
    matchedLabel = findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle: liveBundle });
  }
  if (!matchedLabel) {
    return { synced: false, reason: "no_label_for_identity" };
  }
  const stored = getAnthropicCredential(state, matchedLabel);
  const storedBundle = getClaudeNativeBundle(stored);
  const storedOauth = isObject(storedBundle?.claudeAiOauth) ? storedBundle.claudeAiOauth : {};
  const liveOauth = liveBundle.claudeAiOauth;
  const rotatedFields = [];
  if (storedOauth.accessToken !== liveOauth.accessToken) rotatedFields.push("accessToken");
  if (storedOauth.refreshToken !== liveOauth.refreshToken) rotatedFields.push("refreshToken");
  if (storedOauth.expiresAt !== liveOauth.expiresAt) rotatedFields.push("expiresAt");
  if (rotatedFields.length === 0) {
    return { synced: false, reason: "tokens_unchanged", label: matchedLabel };
  }
  const importMeta = getAuthorityAnthropicImportLabelMeta(state, matchedLabel);
  if (
    source === "file"
    && importMeta
    && importMeta.dirtyLocal !== true
    && typeof importMeta.importedAt === "string"
  ) {
    const importedAtMs = Date.parse(importMeta.importedAt);
    let liveMtimeMs = null;
    if (credentialsPath) {
      try {
        liveMtimeMs = fs.statSync(credentialsPath).mtimeMs;
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
  const replacement = planClaudeNativeBundleReplacement({
    currentBundle: storedBundle,
    candidateBundle: liveBundle,
    nowMs,
    // An expired access token can still carry the only valid rotating refresh
    // lineage. Preserve a strictly newer same-identity bundle so the official
    // Claude client can refresh it on the next managed launch.
    allowExpiredCandidate: true,
  });
  if (replacement.ok !== true) {
    return { synced: false, reason: replacement.reason, label: matchedLabel };
  }
  if (replacement.action === "noop") {
    return { synced: false, reason: "tokens_unchanged", label: matchedLabel };
  }
  const nextCredential = deriveAnthropicCredentialFromClaudeBundle({
    existingCredential: stored,
    nativeClaudeBundle: liveBundle,
  });
  state.credentials[ANTHROPIC_PROVIDER][matchedLabel] = nextCredential;
  return { synced: true, label: matchedLabel, rotatedFields, source };
}

export function syncLiveClaudeRotationBackToLabel({ state, homeDir }) {
  const live = readClaudeNativeBundle({ homeDir });
  if (!live.exists || live.ok !== true || !hasCompleteClaudeNativeBundle(live.nativeClaudeBundle) || !live.summary) {
    return { synced: false, reason: "no_live_bundle" };
  }
  return syncClaudeNativeBundleBackToLabel({
    state,
    nativeClaudeBundle: live.nativeClaudeBundle,
    source: "file",
    credentialsPath: live.credentialsPath,
    nowMs: Date.now(),
  });
}

export async function syncLiveClaudeRotationBackToLabelFromStorage({
  state,
  descriptor,
  nowMs = Date.now(),
  readClaudeNativeKeychainOauthImpl,
}) {
  const live = await readClaudeNativeBundleFromStorage({
    descriptor,
    nowMs,
    readClaudeNativeKeychainOauthImpl,
  });
  if (live.ok !== true) {
    return { synced: false, reason: live.errorKind || "no_live_bundle" };
  }
  return syncClaudeNativeBundleBackToLabel({
    state,
    nativeClaudeBundle: live.nativeClaudeBundle,
    source: live.source,
    credentialsPath: live.source === "file" ? path.join(descriptor.configDir, ".credentials.json") : null,
    nowMs,
  });
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

export function validateAnthropicNativeBundleForLabel({
  state,
  label,
  nativeClaudeBundle,
  allowExpiredAccess = false,
}) {
  if (!isObject(state)) {
    throw new Error("Refusing native Claude bundle without AIM state.");
  }
  const normalizedLabel = normalizeLabel(label);
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error(
      `Refusing to store an incomplete native Claude bundle for label=${normalizedLabel}.`,
    );
  }

  const strictIdentity = getStrictClaudeNativeBundleIdentity(bundle);
  if (!strictIdentity) {
    throw new Error(
      `Refusing native Claude bundle for label=${normalizedLabel} without complete stable identity.`,
    );
  }
  const account = isObject(state.accounts[normalizedLabel]) ? state.accounts[normalizedLabel] : null;
  const configuredProvider = normalizeProviderId(account?.provider);
  if (configuredProvider && configuredProvider !== ANTHROPIC_PROVIDER) {
    throw new Error(
      `Refusing to store native Claude auth on non-Anthropic label=${normalizedLabel} provider=${configuredProvider}.`,
    );
  }
  const expectedEmail =
    typeof account?.expect?.email === "string" ? account.expect.email.trim().toLowerCase() : "";
  if (expectedEmail && summary.emailAddress !== expectedEmail) {
    throw new Error(
      `Native Claude login for label=${normalizedLabel} failed identity_mismatch validation.`,
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

  const replacement = planClaudeNativeBundleReplacement({
    currentBundle: isObject(state?.credentials?.[ANTHROPIC_PROVIDER]?.[normalizedLabel])
      ? state.credentials[ANTHROPIC_PROVIDER][normalizedLabel]
      : null,
    candidateBundle: bundle,
    expectedEmail,
    allowExpiredCandidate: allowExpiredAccess,
  });
  if (replacement.ok !== true) {
    throw new Error(
      `Refusing native Claude bundle for label=${normalizedLabel}: ${replacement.reason}.`,
    );
  }

  return {
    bundle,
    summary,
    action: replacement.action,
  };
}

export function persistAnthropicNativeBundleForLabel({
  state,
  label,
  nativeClaudeBundle,
  allowExpiredAccess = false,
}) {
  const normalizedLabel = normalizeLabel(label);
  const { bundle, summary, action } = validateAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle,
    allowExpiredAccess,
  });
  ensureAnthropicLabelConfigured(state, normalizedLabel);
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
    action,
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

export function importAnthropicNativeBundleForLabel({
  state,
  label,
  filePath,
  allowExpiredAccess = false,
}) {
  const normalizedLabel = normalizeLabel(label);
  const imported = readClaudeNativeBundleExportFile({ filePath });
  const persisted = persistAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle: imported.payload.nativeClaudeBundle,
    allowExpiredAccess,
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
