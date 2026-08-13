import path from "node:path";
import { normalizeBrowserBindingMode } from "../browser/bindings.js";
import { promptLine } from "../io/prompts.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK, SUPPORTED_OAUTH_PROVIDERS, XAI_PROVIDER } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { ensureStateShape } from "../state/schema.js";

export function resolveOpenAICodexInteractiveLoginModeFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw === "1") return REAUTH_MODE_BROWSER_MANAGED;
  if (raw === "2") return REAUTH_MODE_MANUAL_CALLBACK;

  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (
    normalized === "browser" ||
    normalized === "browser-managed" ||
    normalized === "aim" ||
    normalized === "aim-browser" ||
    normalized === "aim-browser-profile" ||
    normalized === "openclaw" ||
    normalized === "openclaw-browser" ||
    normalized === "openclaw-browser-profile"
  ) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (
    normalized === "manual" ||
    normalized === "callback" ||
    normalized === "manual-callback" ||
    normalized === "external-browser"
  ) {
    return REAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
}

export function resolveBrowserModeSelectionFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw === "1") return BROWSER_MODE_AIM_PROFILE;
  if (raw === "2") return BROWSER_MODE_CHROME_PROFILE;
  if (raw === "3") return BROWSER_MODE_AGENT_BROWSER;
  return normalizeBrowserBindingMode(raw);
}

export function resolveSupportedProviderFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (raw === "1") return OPENAI_CODEX_PROVIDER;
  if (raw === "2") return ANTHROPIC_PROVIDER;
  if (raw === "3") return XAI_PROVIDER;

  const normalized = normalizeProviderId(raw);
  if (normalized === "codex") return OPENAI_CODEX_PROVIDER;
  if (normalized === "claude") return ANTHROPIC_PROVIDER;
  if (normalized === XAI_PROVIDER) return XAI_PROVIDER;

  return SUPPORTED_OAUTH_PROVIDERS.has(normalized) ? normalized : null;
}

export async function ensureProviderConfiguredForLabel({
  state,
  label,
  explicitProvider = null,
  promptLineImpl = promptLine,
  writeImpl = () => {},
}) {
  ensureStateShape(state);
  const existing = state.accounts[label];
  const requested = explicitProvider ? resolveSupportedProviderFromInput(explicitProvider) : null;
  if (explicitProvider && !requested) {
    throw new Error(`Unsupported provider selection: ${explicitProvider}`);
  }
  if (requested) {
    if (!isObject(existing) || !SUPPORTED_OAUTH_PROVIDERS.has(normalizeProviderId(existing.provider))) {
      state.accounts[label] = {
        ...(isObject(existing) ? existing : {}),
        provider: requested,
      };
    }
    return requested;
  }

  const raw = typeof existing?.provider === "string" ? existing.provider.trim() : "";
  const normalized = raw ? normalizeProviderId(raw) : "";
  if (normalized && SUPPORTED_OAUTH_PROVIDERS.has(normalized)) {
    return normalized;
  }

  writeImpl(`No provider configured for label "${label}" yet.\n`);
  writeImpl("Pick provider:\n");
  writeImpl(`  1) ${OPENAI_CODEX_PROVIDER} - ${SUPPORTED_OAUTH_PROVIDERS.get(OPENAI_CODEX_PROVIDER).name}\n`);
  writeImpl(`  2) ${ANTHROPIC_PROVIDER} - ${SUPPORTED_OAUTH_PROVIDERS.get(ANTHROPIC_PROVIDER).name}\n`);
  writeImpl(`  3) ${XAI_PROVIDER} - ${SUPPORTED_OAUTH_PROVIDERS.get(XAI_PROVIDER).name}\n`);
  writeImpl("\n");

  // Default to OpenAI Codex to preserve the common fast path: "aim boss" then Enter.
  // If you want Claude Max, type "2" or "anthropic". For SuperGrok, type "3" or "xai".
  const answer = await promptLineImpl(`Provider for "${label}" (1-3 or id) [1]:`, { defaultValue: "1" });
  const provider = resolveSupportedProviderFromInput(answer);
  if (!provider) {
    throw new Error(`Unsupported provider selection: ${answer}`);
  }

  state.accounts[label] = {
    ...(isObject(existing) ? existing : {}),
    provider,
  };

  return provider;
}

export function parseAnthropicAuthorizationPaste(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error("Missing Anthropic callback input.");
  }

  // Accept a full callback URL (preferred UX).
  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return `${code}#${state}`;
  } catch {
    // not a URL
  }

  // Accept the raw library format.
  if (raw.includes("#")) {
    const [code, state] = raw.split("#", 2);
    if (code && state) return `${code}#${state}`;
  }

  // Accept "code=...&state=..." (or "?code=...&state=...").
  if (raw.includes("code=") && raw.includes("state=")) {
    const query = raw.startsWith("?") ? raw.slice(1) : raw;
    const params = new URLSearchParams(query);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) return `${code}#${state}`;
  }

  throw new Error(
    "Invalid Anthropic callback input. Paste the full callback URL from your browser address bar " +
      '(looks like "https://console.anthropic.com/oauth/code/callback?code=...&state=..."), or paste "code#state".',
  );
}
