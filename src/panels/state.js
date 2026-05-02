import { formatAgentBrowserTarget } from "../browser/agent-browser.js";
import { ensureAccountShape, normalizeInteractiveOAuthMode, readBrowserFacts, resolveBrowserBinding } from "../browser/bindings.js";
import { formatChromeBrowserTarget, normalizeChromeProfileDirectory } from "../browser/chrome.js";
import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { hasCompleteClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { derivePoolAccountStatus } from "../pool/account-status.js";
import { getAccountRecord } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function resolveProviderPanelLabel(provider) {
  if (provider === OPENAI_CODEX_PROVIDER) return "ChatGPT login";
  if (provider === ANTHROPIC_PROVIDER) return "Stored tokens";
  return "Login";
}

export function resolveProviderHomeUrl(provider) {
  if (provider === OPENAI_CODEX_PROVIDER) return "https://chatgpt.com";
  if (provider === ANTHROPIC_PROVIDER) return "https://claude.ai";
  return null;
}

export function resolveCredentialHealth(credential) {
  if (!isObject(credential)) return "unknown";
  const expiresAt = parseExpiresAtToMs(credential.expiresAt);
  if (!expiresAt) return "unknown";
  if (expiresAt <= Date.now()) return "expired";
  return "valid";
}

export function summarizeBrowserBindingForPanel({ binding, reauthMode }) {
  if (reauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return "manual callback";
  }
  if (!binding) {
    return "not configured";
  }
  if (binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return "AIM browser";
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    const profileDirectory = normalizeChromeProfileDirectory(binding.profileDirectory);
    return profileDirectory ? `Chrome profile / ${profileDirectory}` : "Chrome profile";
  }
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    const session = String(binding.agentBrowserSession ?? "").trim();
    return session ? `agent-browser / ${session}` : "agent-browser";
  }
  return binding.mode;
}

export function describeConcreteBrowserTarget(binding) {
  if (!binding) return "no configured browser binding";
  if (binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return binding.userDataDir
      ? `AIM browser path ${binding.userDataDir}`
      : "the AIM browser path for this label";
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    return formatChromeBrowserTarget({
      userDataDir: binding.userDataDir,
      profileDirectory: binding.profileDirectory,
      fallback: "the saved Chrome profile",
    });
  }
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return formatAgentBrowserTarget({
      session: binding.agentBrowserSession,
      profile: binding.agentBrowserProfile,
      fallback: "the saved agent-browser binding",
    });
  }
  return `browser mode ${binding.mode}`;
}

export function buildLabelControlPanelState({ state, label, homeDir }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: account.provider });

  const provider = normalizeProviderId(account.provider);
  const credential =
    provider === OPENAI_CODEX_PROVIDER
      ? getCodexCredential(state, normalizedLabel)
      : provider === ANTHROPIC_PROVIDER
        ? getAnthropicCredential(state, normalizedLabel)
        : null;
  const browserFacts = readBrowserFacts({ account, homeDir, label: normalizedLabel });
  const operator = derivePoolAccountStatus({
    account,
    label: normalizedLabel,
    credentials: credential,
    browserFacts,
    now: Date.now(),
  });
  const reauthMode =
    provider === ANTHROPIC_PROVIDER
      ? REAUTH_MODE_NATIVE_CLAUDE
      : normalizeInteractiveOAuthMode(account?.reauth?.mode);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const credentialHealth = resolveCredentialHealth(credential);
  const nativeBundleComplete = provider === ANTHROPIC_PROVIDER ? hasCompleteClaudeNativeBundle(credential) : null;
  const needsSetup =
    provider === ANTHROPIC_PROVIDER
      ? false
      : !reauthMode
        || (reauthMode === REAUTH_MODE_BROWSER_MANAGED && !binding && credentialHealth !== "valid");

  let panelKind = "ready";
  if (needsSetup) {
    panelKind = "setup";
  } else if (operator?.operatorStatus === "blocked") {
    panelKind = "blocked";
  } else if (operator?.operatorStatus === "reauth") {
    panelKind = "reauth";
  }

  let reason = null;
  if (provider === ANTHROPIC_PROVIDER) {
    reason =
      typeof operator?.reason === "string" && operator.reason.trim()
        ? operator.reason.trim()
        : nativeBundleComplete
          ? "Ready for native Claude switching."
          : "No complete native Claude bundle is stored for this label yet.";
  } else if (panelKind === "setup") {
    reason = !reauthMode
      ? "No login mode is configured yet."
      : operator?.reason ?? "Finish browser/login setup for this label.";
  } else if (typeof operator?.reason === "string" && operator.reason.trim()) {
    reason = operator.reason.trim();
  }

  return {
    label: normalizedLabel,
    provider,
    providerLabel: resolveProviderPanelLabel(provider),
    credentialHealth,
    reauthMode,
    binding,
    browserFacts,
    operator,
    panelKind,
    reason,
    nativeBundleComplete,
    browserSummary: summarizeBrowserBindingForPanel({ binding, reauthMode }),
  };
}
