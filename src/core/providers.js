export {
  ANTHROPIC_PROVIDER,
  DEFAULT_ANTHROPIC_OAUTH_SCOPES,
  OPENAI_CODEX_PROVIDER,
  SAKANA_PROVIDER,
  SUPPORTED_OAUTH_PROVIDERS,
  XAI_PROVIDER,
} from "./constants.js";

export function normalizeProviderId(provider) {
  const normalized = String(provider ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (normalized === "grok" || normalized === "x-ai" || normalized === "grok-cli") {
    return "xai";
  }
  return normalized;
}
