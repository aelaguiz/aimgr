export {
  ANTHROPIC_PROVIDER,
  DEFAULT_ANTHROPIC_OAUTH_SCOPES,
  OPENAI_CODEX_PROVIDER,
  SAKANA_PROVIDER,
  SUPPORTED_OAUTH_PROVIDERS,
} from "./constants.js";

export function normalizeProviderId(provider) {
  return String(provider ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}
