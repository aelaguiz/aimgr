import fs from "node:fs";
import { isAbsoluteExistingDirectory, normalizeChromeProfileDirectory, readChromeDefaultProfileInfoFromLocalState, readChromeProfileInfoFromLocalState, resolveAimBrowserUserDataDir, resolveChromeLocalStatePath } from "./chrome.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { isObject, normalizeAbsolutePath, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { ensureAccountShape, normalizeBrowserBindingMode, normalizeInteractiveOAuthMode, resolveBrowserBinding } from "../state/account-shape.js";
import { getAccountRecord } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export { ensureAccountShape, normalizeBrowserBindingMode, normalizeInteractiveOAuthMode, resolveBrowserBinding, resolveBrowserBindingDisplay } from "../state/account-shape.js";

// Browser substrate is configurable per label, but the binding itself is explicit AIM state.
// Do not infer from agent workspaces, agent ids, or the implicit default agent-browser session.

export function setBrowserBinding({
  state,
  label,
  mode,
  userDataDir,
  profileDirectory,
  agentBrowserProfile,
  agentBrowserSession,
  seedFromOpenclaw,
}) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: account.provider });
  const provider = normalizeProviderId(account.provider);
  if (provider === ANTHROPIC_PROVIDER) {
    throw new Error(
      `Claude labels do not use browser bindings anymore. Use \`aim claude capture-native ${normalizedLabel}\`, ` +
        `\`aim claude import-native ${normalizedLabel} --in <file>\`, or \`aim ${normalizedLabel}\`.`,
    );
  }

  const normalizedMode = String(mode ?? "").trim() === REAUTH_MODE_MANUAL_CALLBACK
    ? REAUTH_MODE_MANUAL_CALLBACK
    : normalizeBrowserBindingMode(mode);
  if (!normalizedMode) {
    throw new Error(
      `Unsupported browser mode for label=${normalizedLabel}: ${String(mode ?? "").trim() || "(missing)"}.`,
    );
  }

  const previous = JSON.stringify({
    reauth: account.reauth,
    browser: account.browser,
  });

  if (normalizedMode === REAUTH_MODE_MANUAL_CALLBACK) {
    account.reauth.mode = REAUTH_MODE_MANUAL_CALLBACK;
    account.browser = null;
    return { label: normalizedLabel, mode: normalizedMode, changed: previous !== JSON.stringify({ reauth: account.reauth, browser: account.browser }), warnings: [] };
  }

  const nextBrowser = { mode: normalizedMode };
  if (normalizedMode === BROWSER_MODE_AIM_PROFILE) {
    if (seedFromOpenclaw) {
      nextBrowser.seededFromOpenclawProfileId = String(seedFromOpenclaw).trim();
    }
  } else if (normalizedMode === BROWSER_MODE_CHROME_PROFILE) {
    const resolvedUserDataDir = normalizeAbsolutePath(userDataDir);
    if (!resolvedUserDataDir || !isAbsoluteExistingDirectory(resolvedUserDataDir)) {
      throw new Error(
        `Mapped Chrome profile for label=${normalizedLabel} requires an existing absolute --user-data-dir (got ${String(userDataDir ?? "").trim() || "(missing)"}).`,
      );
    }
    nextBrowser.userDataDir = resolvedUserDataDir;
    if (normalizeChromeProfileDirectory(profileDirectory)) {
      nextBrowser.profileDirectory = normalizeChromeProfileDirectory(profileDirectory);
    }
  } else if (normalizedMode === BROWSER_MODE_AGENT_BROWSER) {
    const resolvedProfile = normalizeAbsolutePath(agentBrowserProfile);
    const resolvedSession = String(agentBrowserSession ?? "").trim();
    if (!resolvedProfile || !isAbsoluteExistingDirectory(resolvedProfile)) {
      throw new Error(
        `Mapped agent-browser profile for label=${normalizedLabel} requires an existing absolute --profile (got ${String(agentBrowserProfile ?? "").trim() || "(missing)"}).`,
      );
    }
    if (!resolvedSession) {
      throw new Error(`Mapped agent-browser profile for label=${normalizedLabel} requires --session.`);
    }
    nextBrowser.agentBrowserProfile = resolvedProfile;
    nextBrowser.agentBrowserSession = resolvedSession;
  }

  if (typeof account.browser?.verifiedAt === "string" && account.browser.verifiedAt.trim()) {
    nextBrowser.verifiedAt = account.browser.verifiedAt.trim();
  }
  if (typeof account.browser?.seededAt === "string" && account.browser.seededAt.trim()) {
    nextBrowser.seededAt = account.browser.seededAt.trim();
  }
  if (typeof account.browser?.conflictReason === "string" && account.browser.conflictReason.trim()) {
    nextBrowser.conflictReason = account.browser.conflictReason.trim();
  }
  if (
    normalizedMode === BROWSER_MODE_AIM_PROFILE
    && !nextBrowser.seededFromOpenclawProfileId
    && typeof account.browser?.seededFromOpenclawProfileId === "string"
    && account.browser.seededFromOpenclawProfileId.trim()
  ) {
    nextBrowser.seededFromOpenclawProfileId = account.browser.seededFromOpenclawProfileId.trim();
  }

  account.reauth.mode = REAUTH_MODE_BROWSER_MANAGED;
  account.browser = nextBrowser;
  ensureAccountShape(account, { providerHint: account.provider });
  return {
    label: normalizedLabel,
    mode: normalizedMode,
    changed: previous !== JSON.stringify({ reauth: account.reauth, browser: account.browser }),
    warnings: [],
  };
}

export function showBrowserBinding({ state, label, homeDir }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel);
  if (!account) {
    throw new Error(`Unknown label: ${normalizedLabel}.`);
  }
  const reauthMode = normalizeInteractiveOAuthMode(account?.reauth?.mode);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const warnings = [];
  if (reauthMode === REAUTH_MODE_BROWSER_MANAGED && !binding) {
    warnings.push({ reason: "binding_missing_for_future_reauth" });
  }
  return {
    label: normalizedLabel,
    reauthMode: reauthMode ?? null,
    binding: binding
      ? (binding.mode === BROWSER_MODE_AGENT_BROWSER
        ? {
            mode: binding.mode,
            profile: binding.agentBrowserProfile,
            session: binding.agentBrowserSession,
          }
        : {
            mode: binding.mode,
            ...(binding.userDataDir ? { userDataDir: binding.userDataDir } : {}),
            ...(binding.profileDirectory ? { profileDirectory: binding.profileDirectory } : {}),
          })
      : null,
    resolvedPaths:
      binding?.mode === BROWSER_MODE_AGENT_BROWSER
        ? {
            agentBrowserProfile: binding.agentBrowserProfile,
          }
        : binding?.userDataDir
          ? { userDataDir: binding.userDataDir }
          : null,
    warnings,
  };
}

export function resolveBrowserFactsPath(binding) {
  if (!binding) return null;
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return String(binding.agentBrowserProfile ?? "").trim() || null;
  }
  if (binding.mode === BROWSER_MODE_AIM_PROFILE || binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    return String(binding.userDataDir ?? "").trim() || null;
  }
  return null;
}

export function readBrowserFacts({ account, homeDir, label }) {
  const normalizedLabel = normalizeLabel(label);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const browserPath = resolveBrowserFactsPath(binding);
  if (!binding || !browserPath) {
    return {
      label: normalizedLabel,
      bindingPresent: false,
      exists: false,
      mode: null,
      userDataDir: null,
      name: null,
      userName: null,
      gaiaName: null,
    };
  }

  if (!fs.existsSync(browserPath)) {
    return {
      label: normalizedLabel,
      bindingPresent: true,
      exists: false,
      mode: binding.mode,
      userDataDir: browserPath,
      ...(binding.mode === BROWSER_MODE_CHROME_PROFILE && binding.profileDirectory
        ? { profileDirectory: binding.profileDirectory }
        : {}),
      name: null,
      userName: null,
      gaiaName: null,
      ...(binding.mode === BROWSER_MODE_AGENT_BROWSER
        ? { agentBrowserSession: binding.agentBrowserSession || null }
        : {}),
    };
  }

  const info =
    binding.mode === BROWSER_MODE_CHROME_PROFILE
      ? readChromeProfileInfoFromLocalState(
          resolveChromeLocalStatePath(browserPath),
          normalizeChromeProfileDirectory(binding.profileDirectory) || "Default",
        )
      : readChromeDefaultProfileInfoFromLocalState(resolveChromeLocalStatePath(browserPath));
  const name = typeof info?.name === "string" ? String(info.name).trim() : "";
  const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
  const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";
  return {
    label: normalizedLabel,
    bindingPresent: true,
    exists: true,
    mode: binding.mode,
    userDataDir: browserPath,
    ...(binding.mode === BROWSER_MODE_CHROME_PROFILE && binding.profileDirectory
      ? { profileDirectory: binding.profileDirectory }
      : {}),
    name: name || null,
    userName: userName || null,
    gaiaName: gaiaName || null,
    ...(binding.mode === BROWSER_MODE_AGENT_BROWSER
      ? { agentBrowserSession: binding.agentBrowserSession || null }
      : {}),
  };
}
