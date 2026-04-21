import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "0.2";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export const ANTHROPIC_PROVIDER = "anthropic";

export const OPENCLAW_ENFORCED_CODEX_MODEL = "openai-codex/gpt-5.4";

export const OPENCLAW_ENFORCED_ANTHROPIC_MODEL = "anthropic/claude-opus-4-6";

export const DEFAULT_ANTHROPIC_OAUTH_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

export const INFERRED_ANTHROPIC_SUBSCRIPTION_MAX = "claude_max";

export const INFERRED_ANTHROPIC_SUBSCRIPTION_PRO = "claude_pro";

export const INFERRED_ANTHROPIC_RATE_LIMIT_TIER_MAX = "oauth_claude_max_inferred";

export const INFERRED_ANTHROPIC_RATE_LIMIT_TIER_PRO = "oauth_claude_pro_inferred";

export const CODEX_AUTH_STORE_MODE_FILE = "file";

export const CODEX_AUTH_STORE_MODE_KEYRING = "keyring";

export const CODEX_AUTH_STORE_MODE_AUTO = "auto";

export const DEFAULT_AUTHORITY_STATE_REMOTE_PATH = "$HOME/.aimgr/secrets.json";

export const REAUTH_MODE_BROWSER_MANAGED = "browser-managed";

export const REAUTH_MODE_MANUAL_CALLBACK = "manual-callback";

export const REAUTH_MODE_NATIVE_CLAUDE = "native-claude";

export const LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE = "aim-browser-profile";

export const LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE = "openclaw-browser-profile";

export const BROWSER_MODE_AIM_PROFILE = "aim-profile";

export const BROWSER_MODE_CHROME_PROFILE = "chrome-profile";

export const BROWSER_MODE_AGENT_BROWSER = "agent-browser";

export const CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION = 1;

const AIMGR_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_AGENTS_REPO_ROOT = path.resolve(AIMGR_SRC_ROOT, "..", "..", "..", "..", "..");

export const HERMES_AUTH_STORE_VERSION = 1;

export const HERMES_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const STATUS_RESET_TIMEZONE = "America/Chicago";

export const DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS = 7;

export const MIN_AGENT_DEMAND_WEIGHT = 1;

export const KEEP_CURRENT_DEMAND_RATIO_THRESHOLD = 0.15;

export const KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR = 0.25;

export const LOCAL_CLI_MIN_PRIMARY_REMAINING_PCT = 80;

export const DEFAULT_CODEX_WATCH_INTERVAL_SECONDS = 300;

export const DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT = 20;

export const HERMES_SESSION_DEMAND_SOURCE = "hermes-session-tokens";

export const OPENCLAW_SESSION_DEMAND_SOURCE = "openclaw-session-tokens";

export const COLD_START_EQUAL_SHARE_DEMAND_SOURCE = "cold-start-equal-share";

export const STATUS_RESET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: STATUS_RESET_TIMEZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

export const SUPPORTED_OAUTH_PROVIDERS = new Map([
  [
    OPENAI_CODEX_PROVIDER,
    {
      id: OPENAI_CODEX_PROVIDER,
      name: "OpenAI Codex (ChatGPT Plus/Pro subscription)",
    },
  ],
  [
    ANTHROPIC_PROVIDER,
    {
      id: ANTHROPIC_PROVIDER,
      name: "Anthropic (Claude Pro/Max subscription)",
    },
  ],
]);
