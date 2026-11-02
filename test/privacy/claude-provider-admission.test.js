import assert from "node:assert/strict";
import test from "node:test";
import { assertClaudeIndividualOAuth, cleanClaudeRootEnvironment, claudeManagedSources } from "../../src/privacy/claude-provider-admission.js";

function individual() {
  return { accountUuid: "account-a", organizationUuid: "personal-org-a",
    appState: { oauthAccount: { accountUuid: "account-a", organizationUuid: "personal-org-a" } },
    credentialDocument: { claudeAiOauth: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      expiresAt: 1, scopes: ["user:inference"], subscriptionType: "max", subscriptionTypeSource: "profile",
      subscriptionTypeVerifiedAt: 1, clientId: "synthetic-client", refreshTokenExpiresAt: 2 },
    mcpOAuth: { independent: { accessToken: "synthetic-mcp" } } } };
}
test("individual admission retains expired refreshable credentials and exact provenance without rewriting", () => {
  const input = individual(), before = structuredClone(input);
  assert.equal(assertClaudeIndividualOAuth(input).subscriptionType, "max");
  assert.deepEqual(input, before);
});
test("identity, provider and subscription ambiguity refuses without printing private values", () => {
  const cases = [
    value => { value.appState.oauthAccount.accountUuid = "wrong"; },
    value => { value.appState.oauthAccount.organizationUuid = "wrong"; },
    value => { delete value.credentialDocument.claudeAiOauth.subscriptionType; },
    value => { value.credentialDocument.claudeAiOauth.subscriptionType = "team"; },
    value => { value.credentialDocument.claudeAiOauth.scopes = ["user:profile"]; },
    value => { value.appState.primaryApiKey = "PRIVATE-CANARY"; },
    value => { value.credentialDocument.enterpriseGateway = { token: "PRIVATE-CANARY" }; },
    value => { value.appState.env = { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: safe\n Authorization : PRIVATE-CANARY" }; },
    value => { value.appState.env = { ANTHROPIC_CUSTOM_HEADERS: "x-api-key: PRIVATE-CANARY" }; },
  ];
  for (const change of cases) {
    const input = individual(); change(input);
    assert.throws(() => assertClaudeIndividualOAuth(input), error => error.code === "AIMGR_CLAUDE_PRIVACY_SETTINGS" && !error.message.includes("PRIVATE-CANARY"));
  }
});
test("legacy app-state harmless headers remain admitted and unchanged", () => {
  const input = individual(); input.appState.env = { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: alpha:beta" };
  const before = structuredClone(input);
  assert.equal(assertClaudeIndividualOAuth(input).subscriptionType, "max");
  assert.deepEqual(input, before);
});
test("root cleanup excludes competing credentials while retaining build and independent MCP environment", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "private", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
    CLAUDE_CODE_ORGANIZATION_UUID: "other-org", CLAUDE_CODE_ACCOUNT_UUID: "other-account", CLAUDE_CODE_USER_EMAIL: "other@example.invalid",
    CLAUDE_BG_AUTH_SNAPSHOT_PATH: "/private/snapshot", CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    CLAUDE_CODE_CUSTOM_OAUTH_URL: "", ANTHROPIC_PROFILE: "another", AWS_PROFILE: "build",
    GOOGLE_APPLICATION_CREDENTIALS: "/build/credentials", GITHUB_TOKEN: "required-mcp",
    TERM: "xterm-256color", DISABLE_TELEMETRY: "0" };
  const before = { ...env }, result = cleanClaudeRootEnvironment(env);
  assert.deepEqual(result, { AWS_PROFILE: "build", GOOGLE_APPLICATION_CREDENTIALS: "/build/credentials",
    GITHUB_TOKEN: "required-mcp", TERM: "xterm-256color", DISABLE_TELEMETRY: "0" });
  assert.deepEqual(env, before);
});
test("custom header cleanup preserves independent headers and removes both native auth names", () => {
  assert.equal(cleanClaudeRootEnvironment({ ANTHROPIC_CUSTOM_HEADERS: "X-Trace: alpha:beta\n aUtHoRiZaTiOn : secret\nx-api-key: other\nX-Feature: test" }).ANTHROPIC_CUSTOM_HEADERS,
    "X-Trace: alpha:beta\nX-Feature: test");
  assert.equal(Object.hasOwn(cleanClaudeRootEnvironment({ ANTHROPIC_CUSTOM_HEADERS: "Authorization: secret" }), "ANTHROPIC_CUSTOM_HEADERS"), false);
});
test("managed preference paths use actual OS username and reject traversal", () => {
  assert.deepEqual(claudeManagedSources({ platform: "darwin", username: "test-user" }).preferences,
    ["/Library/Managed Preferences/test-user/com.anthropic.claudecode.plist", "/Library/Managed Preferences/com.anthropic.claudecode.plist"]);
  assert.equal(claudeManagedSources({ platform: "linux" }).directory, "/etc/claude-code");
  assert.throws(() => claudeManagedSources({ platform: "darwin", username: "../test" }));
});
