import fs from "node:fs";
import { parseExpiresAtToMs, toIsoFromExpiresMs } from "../core/time.js";
import { isObject } from "../core/normalize.js";
import { resolveClaudeAppStatePath, resolveClaudeAuthFilePath, resolveManagedClaudeDir } from "../io/paths.js";
import { parseTimestampLikeToMs } from "../state/demand.js";

export function normalizeNonEmptyStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

export function cloneJsonObject(value) {
  return isObject(value) ? structuredClone(value) : null;
}

export function getClaudeNativeBundle(source) {
  if (isObject(source?.nativeClaudeBundle)) {
    return source.nativeClaudeBundle;
  }
  if (isObject(source?.claudeAiOauth) && isObject(source?.oauthAccount)) {
    return source;
  }
  return null;
}

export function buildClaudeNativeBundle(source) {
  const oauth = cloneJsonObject(source?.claudeAiOauth);
  const account = cloneJsonObject(source?.oauthAccount);
  if (!oauth || !account) return null;
  const expiresAt = parseTimestampLikeToMs(oauth.expiresAt);
  if (expiresAt) {
    oauth.expiresAt = expiresAt;
  }
  if (Array.isArray(oauth.scopes)) {
    oauth.scopes = normalizeNonEmptyStringArray(oauth.scopes);
  }
  return {
    claudeAiOauth: oauth,
    oauthAccount: account,
  };
}

export function buildClaudeCredentialSummaryFromBundle(source) {
  const bundle = getClaudeNativeBundle(source);
  if (!bundle) return null;
  const claudeAiOauth = isObject(bundle.claudeAiOauth) ? bundle.claudeAiOauth : null;
  const oauthAccount = isObject(bundle.oauthAccount) ? bundle.oauthAccount : null;
  if (!claudeAiOauth || !oauthAccount) return null;

  const access = typeof claudeAiOauth.accessToken === "string" ? claudeAiOauth.accessToken.trim() : "";
  const refresh = typeof claudeAiOauth.refreshToken === "string" ? claudeAiOauth.refreshToken.trim() : "";
  const expiresAt = toIsoFromExpiresMs(parseTimestampLikeToMs(claudeAiOauth.expiresAt));
  const subscriptionType =
    typeof claudeAiOauth.subscriptionType === "string" ? claudeAiOauth.subscriptionType.trim() : "";
  const rateLimitTier =
    typeof claudeAiOauth.rateLimitTier === "string" ? claudeAiOauth.rateLimitTier.trim() : "";
  const scopes = normalizeNonEmptyStringArray(claudeAiOauth.scopes);
  const emailAddress =
    typeof oauthAccount.emailAddress === "string" ? oauthAccount.emailAddress.trim().toLowerCase() : "";
  const organizationName =
    typeof oauthAccount.organizationName === "string" ? oauthAccount.organizationName.trim() : "";
  const organizationUuid =
    typeof oauthAccount.organizationUuid === "string" ? oauthAccount.organizationUuid.trim() : "";

  return {
    access,
    refresh,
    expiresAt: expiresAt || null,
    subscriptionType,
    rateLimitTier,
    scopes,
    emailAddress,
    organizationName,
    organizationUuid,
  };
}

export function hasCompleteClaudeNativeBundle(source) {
  const bundle = getClaudeNativeBundle(source);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  return Boolean(
    bundle
    && isObject(bundle.claudeAiOauth)
    && isObject(bundle.oauthAccount)
    && summary
    && summary.access
    && summary.refresh
    && summary.expiresAt
    && summary.subscriptionType
    && summary.rateLimitTier
    && summary.scopes.length > 0
    && summary.emailAddress
    && summary.organizationName
    && summary.organizationUuid
  );
}

export function readClaudeAuthFile({ claudeDir }) {
  const authPath = resolveClaudeAuthFilePath(claudeDir);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Claude .credentials.json is not a JSON object.");
    }
    const claudeAiOauth = isObject(parsed?.claudeAiOauth) ? parsed.claudeAiOauth : null;
    const accessToken = typeof claudeAiOauth?.accessToken === "string" ? claudeAiOauth.accessToken.trim() : null;
    const refreshToken = typeof claudeAiOauth?.refreshToken === "string" ? claudeAiOauth.refreshToken.trim() : null;
    const expiresAtMs = parseTimestampLikeToMs(claudeAiOauth?.expiresAt);
    const subscriptionType =
      typeof claudeAiOauth?.subscriptionType === "string" ? claudeAiOauth.subscriptionType.trim() : "";
    const rateLimitTier =
      typeof claudeAiOauth?.rateLimitTier === "string" ? claudeAiOauth.rateLimitTier.trim() : "";
    const scopes = normalizeNonEmptyStringArray(claudeAiOauth?.scopes);
    return {
      exists: true,
      ok: true,
      authPath,
      claudeAiOauthPresent: Boolean(claudeAiOauth),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      expiresAt: expiresAtMs,
      subscriptionType: subscriptionType || null,
      rateLimitTier: rateLimitTier || null,
      scopes,
      claudeAiOauth: cloneJsonObject(claudeAiOauth),
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath,
      error: String(err?.message ?? err),
    };
  }
}

export function readClaudeAppStateFile({ homeDir }) {
  const appStatePath = resolveClaudeAppStatePath({ homeDir });
  if (!fs.existsSync(appStatePath)) {
    return { exists: false, appStatePath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Claude .claude.json is not a JSON object.");
    }
    const oauthAccount = isObject(parsed?.oauthAccount) ? parsed.oauthAccount : null;
    const emailAddress =
      typeof oauthAccount?.emailAddress === "string" ? oauthAccount.emailAddress.trim().toLowerCase() : null;
    const organizationName =
      typeof oauthAccount?.organizationName === "string" ? oauthAccount.organizationName.trim() : null;
    const organizationUuid =
      typeof oauthAccount?.organizationUuid === "string" ? oauthAccount.organizationUuid.trim() : null;
    return {
      exists: true,
      ok: true,
      appStatePath,
      oauthAccountPresent: Boolean(oauthAccount),
      emailAddress: emailAddress || null,
      organizationName: organizationName || null,
      organizationUuid: organizationUuid || null,
      oauthAccount: cloneJsonObject(oauthAccount),
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      appStatePath,
      error: String(err?.message ?? err),
    };
  }
}

export function readClaudeNativeBundle({ homeDir }) {
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const credentials = readClaudeAuthFile({ claudeDir });
  const appState = readClaudeAppStateFile({ homeDir });
  const nativeClaudeBundle =
    credentials.ok === true
    && credentials.claudeAiOauthPresent === true
    && appState.ok === true
    && appState.oauthAccountPresent === true
      ? buildClaudeNativeBundle({
          claudeAiOauth: credentials.claudeAiOauth,
          oauthAccount: appState.oauthAccount,
        })
      : null;
  const summary = buildClaudeCredentialSummaryFromBundle(nativeClaudeBundle);
  return {
    exists: credentials.exists || appState.exists,
    ok: (credentials.exists ? credentials.ok === true : true) && (appState.exists ? appState.ok === true : true),
    credentialsPath: credentials.authPath ?? resolveClaudeAuthFilePath(claudeDir),
    appStatePath: appState.appStatePath ?? resolveClaudeAppStatePath({ homeDir }),
    credentials,
    appState,
    nativeClaudeBundle,
    summary,
  };
}

export function deriveAnthropicCredentialFromClaudeBundle({ existingCredential, nativeClaudeBundle }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error("Refusing to store an incomplete native Claude bundle.");
  }
  const next = {
    ...(isObject(existingCredential) ? existingCredential : {}),
    nativeClaudeBundle: bundle,
    access: summary.access,
    refresh: summary.refresh,
    expiresAt: summary.expiresAt,
    subscriptionType: summary.subscriptionType,
    rateLimitTier: summary.rateLimitTier,
    scopes: summary.scopes,
    emailAddress: summary.emailAddress,
    organizationName: summary.organizationName,
    organizationUuid: summary.organizationUuid,
  };
  return next;
}

export function updateClaudeBundleTokenFields({ nativeClaudeBundle, access, refresh, expiresAt }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  if (!bundle) {
    throw new Error("Cannot refresh Claude bundle tokens without an existing native Claude bundle.");
  }
  const expiresAtMs = parseExpiresAtToMs(expiresAt);
  if (!expiresAtMs) {
    throw new Error("Cannot refresh Claude bundle tokens without a valid expiresAt.");
  }
  bundle.claudeAiOauth.accessToken = access;
  bundle.claudeAiOauth.refreshToken = refresh;
  bundle.claudeAiOauth.expiresAt = expiresAtMs;
  return bundle;
}
