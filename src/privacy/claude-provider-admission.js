import path from "node:path";
import { ClaudePrivacySettingsError } from "./claude-settings.js";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const fail = reason => { throw new ClaudePrivacySettingsError(reason); };

// T08/T09: reviewed 2.1.316 selectors, not a generic cloud-credential denylist.
// AWS/Google/GitHub/build/MCP credentials remain available to required tools.
// Any new provider/host bridge in a candidate release needs playbook review.
export const CLAUDE_PROVIDER_SWITCHES = Object.freeze([
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_GATEWAY",
]);
export const CLAUDE_ROOT_AUTH_SELECTORS = Object.freeze([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_GATEWAY_LINEAGE", "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN", "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE", "CLAUDE_CODE_RATE_LIMIT_TIER", "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_REMOTE_HERMETIC_MODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EVAL_CONFINED",
  "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SCOPE",
  "CLAUDE_CODE_FEDERATION_CACHE_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_UNIX_SOCKET",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL", "USE_LOCAL_OAUTH", "USE_STAGING_OAUTH",
  "CLAUDE_LOCAL_OAUTH_API_BASE", "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_CODE_PROCESS_WRAPPER", ...CLAUDE_PROVIDER_SWITCHES,
]);

function authHeader(line) {
  const colon = line.indexOf(":");
  return colon >= 0 && ["authorization", "x-api-key"].includes(line.slice(0, colon).trim().toLowerCase());
}

/** Clean ONLY a new AIM root launch, after selecting its stored OAuth account.
 *
 * Never call this on native-created children: background/agents legitimately
 * carry private token FDs or a snapshot created after the root was admitted.
 * The reviewed native settings filter excludes those selectors in every tier,
 * including live reload; putting empty FD/snapshot values in the common policy
 * is both ineffective and an invitation to break a future child handoff.
 * The admitted runtime later pins ordinary provider selectors in flag settings
 * too, because those (unlike FD/snapshot keys) can be restored by lower tiers.
 * In exact 2.1.316 empty CUSTOM_OAUTH_URL parses as absent and preserves ordinary
 * telemetry; this must be rechecked against a future approved release.
 */
export function cleanClaudeRootEnvironment(env) {
  if (!object(env)) fail("the root launch environment is invalid");
  const result = { ...env };
  for (const key of CLAUDE_ROOT_AUTH_SELECTORS) delete result[key];
  if (typeof result.ANTHROPIC_CUSTOM_HEADERS === "string") {
    // Native headers are newline-separated, splitting each at its first colon.
    // Preserve harmless exact header lines; never emit removed secret values.
    const headers = result.ANTHROPIC_CUSTOM_HEADERS.split("\n").filter(line => !authHeader(line)).join("\n");
    if (headers.trim()) result.ANTHROPIC_CUSTOM_HEADERS = headers;
    else delete result.ANTHROPIC_CUSTOM_HEADERS;
  }
  return result;
}

/** Native user/project settings can restore provider selectors after root
 * cleanup. The immutable flag snapshot and root environment share these exact
 * pins. Leave native child FDs, background snapshots and scopes untouched: they
 * carry legitimate per-child authentication. Empty profile name alone is not
 * enough; native falls back to active_config/default in its config directory.
 */
export function claudeStoredOAuthEnvironment({ emptyProfiles, subscriptionType } = {}) {
  if (!path.isAbsolute(emptyProfiles ?? "") || (subscriptionType !== undefined && !["pro", "max"].includes(subscriptionType))) {
    fail("the stored OAuth policy inputs are invalid");
  }
  return {
    ...Object.fromEntries(CLAUDE_PROVIDER_SWITCHES.map(key => [key, "0"])),
    ...Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_CUSTOM_OAUTH_URL",
      "CLAUDE_CODE_OAUTH_CLIENT_ID", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID"].map(key => [key, ""])),
    ANTHROPIC_CONFIG_DIR: emptyProfiles,
    ...(subscriptionType ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: subscriptionType } : {}),
  };
}

/** Verify the already selected credential; never infer eligibility from rate
 * limits, caller env, an empty cache or a failed remote-policy request. Expiry
 * alone is supported: native refresh retains its exact existing provenance.
 * This read-only check must run again after AIM refresh/reconciliation. It
 * cannot monitor a provider changing account type during a native request.
 */
export function assertClaudeIndividualOAuth({ credentialDocument, appState, accountUuid, organizationUuid } = {}) {
  const oauth = credentialDocument?.claudeAiOauth;
  const owner = appState?.oauthAccount;
  if (!object(credentialDocument) || !object(appState) || !object(oauth) || !object(owner)
    || !nonempty(accountUuid) || owner.accountUuid !== accountUuid
    || !nonempty(organizationUuid) || owner.organizationUuid !== organizationUuid) {
    fail("the selected stored Claude OAuth identity is not bound to this account");
  }
  if (!nonempty(oauth.accessToken) || !["pro", "max"].includes(oauth.subscriptionType)
    || !Array.isArray(oauth.scopes) || !oauth.scopes.includes("user:inference")) {
    fail("this privacy runtime requires a verified individual Claude Pro or Max OAuth account");
  }
  if (nonempty(appState.primaryApiKey) || credentialDocument.enterpriseGateway != null) {
    fail("the selected Claude state contains competing provider authentication");
  }
  // Native also applies the legacy app-state env map before user settings.
  // Checking settings.json alone misses this alternate root authentication
  // source. Do not print its value: it may contain an actual credential.
  if (typeof appState.env?.ANTHROPIC_CUSTOM_HEADERS === "string"
    && appState.env.ANTHROPIC_CUSTOM_HEADERS.split("\n").some(authHeader)) {
    fail("the selected Claude state contains header-based authentication instead of the selected individual OAuth account");
  }
  return Object.freeze({ accountUuid, organizationUuid, subscriptionType: oauth.subscriptionType });
}

/** Exact managed-source locations. Their apparent environment overrides are
 * compiled no-ops in the reviewed release. Use the actual OS username for Mac
 * preferences; changing HOME must not hide a higher-precedence policy source.
 * The caller inspects native-effective values and replacement permissions,
 * refuses dynamic policy helpers, and keeps admitted files immutable through
 * the complete native-owner lifetime. Listing paths alone is not admission.
 */
export function claudeManagedSources({ platform = process.platform, username } = {}) {
  if (platform === "linux") return Object.freeze({
    directory: "/etc/claude-code", preferences: Object.freeze([]),
  });
  if (platform !== "darwin" || !nonempty(username) || /[\/\\\x00-\x1f]/.test(username)
    || [".", ".."].includes(username)) fail("the native managed-policy source is unknown");
  return Object.freeze({ directory: "/Library/Application Support/ClaudeCode", preferences: Object.freeze([
    path.join("/Library/Managed Preferences", username, "com.anthropic.claudecode.plist"),
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  ]) });
}
