import path from "node:path";
import {
  BROWSER_MODE_AGENT_BROWSER,
  BROWSER_MODE_AIM_PROFILE,
  BROWSER_MODE_CHROME_PROFILE,
  LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE,
  LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE,
  OPENAI_CODEX_PROVIDER,
  REAUTH_MODE_BROWSER_MANAGED,
  REAUTH_MODE_MANUAL_CALLBACK,
  REAUTH_MODE_NATIVE_CLAUDE,
} from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { normalizeChromeProfileDirectory, resolveAimBrowserUserDataDir } from "../browser/chrome.js";

export function normalizeInteractiveOAuthMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === REAUTH_MODE_NATIVE_CLAUDE) {
    return REAUTH_MODE_NATIVE_CLAUDE;
  }
  if (raw === REAUTH_MODE_BROWSER_MANAGED) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === REAUTH_MODE_MANUAL_CALLBACK) {
    return REAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
}

export function normalizeBrowserBindingMode(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return null;
  if (raw === "1" || raw === BROWSER_MODE_AIM_PROFILE || raw === "aim" || raw === "aim-profile") {
    return BROWSER_MODE_AIM_PROFILE;
  }
  if (raw === "2" || raw === BROWSER_MODE_CHROME_PROFILE || raw === "chrome" || raw === "chrome-profile") {
    return BROWSER_MODE_CHROME_PROFILE;
  }
  if (
    raw === "3"
    || raw === BROWSER_MODE_AGENT_BROWSER
    || raw === "agent"
    || raw === "agent-browser"
    || raw === "agent-browser-profile"
  ) {
    return BROWSER_MODE_AGENT_BROWSER;
  }
  return null;
}

export function browserBindingNeedsMode(browser) {
  return (
    typeof browser?.seededFromOpenclawProfileId === "string"
    || typeof browser?.seededFrom === "string"
    || typeof browser?.seededAt === "string"
    || typeof browser?.verifiedAt === "string"
    || typeof browser?.conflictReason === "string"
  );
}

export function ensureAccountShape(account, { providerHint } = {}) {
  const nextProvider =
    normalizeProviderId(account?.provider ?? providerHint ?? OPENAI_CODEX_PROVIDER) || OPENAI_CODEX_PROVIDER;
  account.provider = nextProvider;
  account.expect = isObject(account.expect) ? account.expect : {};

  const rawBrowser = isObject(account.browser) ? account.browser : null;
  const normalizedMode = normalizeBrowserBindingMode(rawBrowser?.mode)
    || (rawBrowser && browserBindingNeedsMode(rawBrowser) ? BROWSER_MODE_AIM_PROFILE : null);
  const seededFromOpenclawProfileId =
    typeof rawBrowser?.seededFromOpenclawProfileId === "string" && rawBrowser.seededFromOpenclawProfileId.trim()
      ? rawBrowser.seededFromOpenclawProfileId.trim()
      : typeof rawBrowser?.seededFrom === "string" && rawBrowser.seededFrom.trim()
        ? rawBrowser.seededFrom.trim()
        : null;
  const seededAt = typeof rawBrowser?.seededAt === "string" && rawBrowser.seededAt.trim() ? rawBrowser.seededAt.trim() : null;
  const verifiedAt =
    typeof rawBrowser?.verifiedAt === "string" && rawBrowser.verifiedAt.trim() ? rawBrowser.verifiedAt.trim() : null;
  const conflictReason =
    typeof rawBrowser?.conflictReason === "string" && rawBrowser.conflictReason.trim()
      ? rawBrowser.conflictReason.trim()
      : null;
  const userDataDir =
    normalizedMode === BROWSER_MODE_CHROME_PROFILE && typeof rawBrowser?.userDataDir === "string" && rawBrowser.userDataDir.trim()
      ? path.resolve(rawBrowser.userDataDir.trim())
      : null;
  const chromeProfileDirectory =
    normalizedMode === BROWSER_MODE_CHROME_PROFILE
    && typeof rawBrowser?.profileDirectory === "string"
    && rawBrowser.profileDirectory.trim()
      ? rawBrowser.profileDirectory.trim()
      : null;
  const agentBrowserProfile =
    normalizedMode === BROWSER_MODE_AGENT_BROWSER
    && typeof rawBrowser?.agentBrowserProfile === "string"
    && rawBrowser.agentBrowserProfile.trim()
      ? path.resolve(rawBrowser.agentBrowserProfile.trim())
      : null;
  const agentBrowserSession =
    normalizedMode === BROWSER_MODE_AGENT_BROWSER
    && typeof rawBrowser?.agentBrowserSession === "string"
    && rawBrowser.agentBrowserSession.trim()
      ? rawBrowser.agentBrowserSession.trim()
      : null;
  const reauthMode = normalizeInteractiveOAuthMode(account?.reauth?.mode);
  account.browser =
    reauthMode === REAUTH_MODE_MANUAL_CALLBACK || reauthMode === REAUTH_MODE_NATIVE_CLAUDE
      ? null
      : normalizedMode || seededFromOpenclawProfileId || seededAt || verifiedAt || conflictReason
        ? {
            ...(normalizedMode ? { mode: normalizedMode } : {}),
            ...(userDataDir ? { userDataDir } : {}),
            ...(chromeProfileDirectory ? { profileDirectory: chromeProfileDirectory } : {}),
            ...(agentBrowserProfile ? { agentBrowserProfile } : {}),
            ...(agentBrowserSession ? { agentBrowserSession } : {}),
            ...(seededFromOpenclawProfileId ? { seededFromOpenclawProfileId } : {}),
            ...(seededAt ? { seededAt } : {}),
            ...(verifiedAt ? { verifiedAt } : {}),
            ...(conflictReason ? { conflictReason } : {}),
          }
        : null;

  const reauth = isObject(account.reauth) ? account.reauth : {};
  const normalizedReauthMode = normalizeInteractiveOAuthMode(reauth.mode);
  account.reauth = {
    ...(normalizedReauthMode ? { mode: normalizedReauthMode } : {}),
    ...(typeof reauth.lastAttemptAt === "string" && reauth.lastAttemptAt.trim()
      ? { lastAttemptAt: reauth.lastAttemptAt.trim() }
      : {}),
    ...(typeof reauth.lastVerifiedAt === "string" && reauth.lastVerifiedAt.trim()
      ? { lastVerifiedAt: reauth.lastVerifiedAt.trim() }
      : {}),
    ...(typeof reauth.blockedReason === "string" && reauth.blockedReason.trim()
      ? { blockedReason: reauth.blockedReason.trim() }
      : {}),
  };

  const pool = isObject(account.pool) ? account.pool : {};
  account.pool = {
    enabled: pool.enabled !== false,
    ...(typeof pool.disabledReason === "string" && pool.disabledReason.trim()
      ? { disabledReason: pool.disabledReason.trim() }
      : {}),
    ...(typeof pool.disabledAt === "string" && pool.disabledAt.trim() ? { disabledAt: pool.disabledAt.trim() } : {}),
  };
}

export function resolveBrowserBinding({ account, homeDir, label }) {
  const normalizedAccount = isObject(account) ? account : {};
  const reauthMode = normalizeInteractiveOAuthMode(normalizedAccount?.reauth?.mode);
  if (reauthMode !== REAUTH_MODE_BROWSER_MANAGED) {
    return null;
  }

  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : null;
  const mode = normalizeBrowserBindingMode(browser?.mode);
  if (!mode) {
    return null;
  }

  if (mode === BROWSER_MODE_AIM_PROFILE) {
    return {
      mode,
      ...(homeDir && label ? { userDataDir: resolveAimBrowserUserDataDir({ homeDir, label }) } : {}),
    };
  }

  if (mode === BROWSER_MODE_CHROME_PROFILE) {
    const userDataDir = String(browser?.userDataDir ?? "").trim();
    if (!userDataDir) {
      return null;
    }
    return {
      mode,
      userDataDir,
      ...(normalizeChromeProfileDirectory(browser?.profileDirectory)
        ? { profileDirectory: normalizeChromeProfileDirectory(browser?.profileDirectory) }
        : {}),
    };
  }

  if (mode === BROWSER_MODE_AGENT_BROWSER) {
    const agentBrowserProfile = String(browser?.agentBrowserProfile ?? "").trim();
    const agentBrowserSession = String(browser?.agentBrowserSession ?? "").trim();
    if (!agentBrowserProfile || !agentBrowserSession) {
      return null;
    }
    return {
      mode,
      agentBrowserProfile,
      agentBrowserSession,
    };
  }

  return null;
}

export function resolveBrowserBindingDisplay(binding) {
  if (!binding) return null;
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return {
      mode: binding.mode,
      agentBrowserProfile: binding.agentBrowserProfile,
      agentBrowserSession: binding.agentBrowserSession,
    };
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE || binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return {
      mode: binding.mode,
      ...(binding.userDataDir ? { userDataDir: binding.userDataDir } : {}),
      ...(binding.profileDirectory ? { profileDirectory: binding.profileDirectory } : {}),
    };
  }
  return { mode: binding.mode };
}
