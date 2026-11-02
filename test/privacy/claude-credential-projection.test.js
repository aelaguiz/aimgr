import assert from "node:assert/strict";
import test from "node:test";
import { planClaudeCredentialProjection } from "../../src/privacy/claude-credential-projection.js";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const oauth = { accessToken: "synthetic-new", refreshToken: "synthetic-refresh", scopes: ["user:inference"], subscriptionType: "pro" };
const thirdParty = { mcpOAuth: { server: { accessToken: "required-third-party" } }, mcpOAuthClientConfig: { server: { clientId: "required-registration" } },
  mcpXaaIdp: { identity: "required" }, mcpXaaIdpConfig: { issuer: "fixture" }, mcpDiscoveryCacheKey: "cache-key", pluginSecrets: { package: "required" } };
const provider = { claudeAiOauth: { accessToken: "synthetic-old" }, enterpriseGateway: { token: "gateway" },
  gatewayTrust: { gateway: true }, gatewayAllowlistEntries: ["gateway"], designOauth: { token: "design" },
  cloudSessionsOauth: { token: "cloud" }, organizationUuid: "synthetic-org", trustedDeviceToken: "device",
  trustedDeviceEnrolledAfterRefusalAtMs: 123, coworkRemoteDevice: { [A]: { privateKeyPkcs8B64: "A-key" }, [B]: { privateKeyPkcs8B64: "B-key" } } };

test("same-account OAuth projection preserves required secrets and only its signed-device entry", () => {
  const current = { ...thirdParty, ...provider }, saved = structuredClone(current);
  const result = planClaudeCredentialProjection({ current, currentAccountUuid: A, targetAccountUuid: A, projectedOauth: oauth });
  assert.deepEqual(result, { ...current, claudeAiOauth: oauth, coworkRemoteDevice: { [A]: provider.coworkRemoteDevice[A] } });
  assert.deepEqual(current, saved);
  result.mcpOAuth.server.accessToken = "changed-result";
  assert.equal(current.mcpOAuth.server.accessToken, "required-third-party");
});

test("label reuse keeps independent MCP/package auth and drops the former provider's credentials", () => {
  const result = planClaudeCredentialProjection({ current: { ...thirdParty, ...provider }, currentAccountUuid: A, targetAccountUuid: B, projectedOauth: oauth });
  assert.deepEqual(result, { ...thirdParty, claudeAiOauth: oauth });
});

test("unknown credential roots and unknown provider ownership refuse without revealing values", () => {
  for (const current of [{ PRIVATE_SECRET_FIELD: "private-value" }, provider]) {
    assert.throws(() => planClaudeCredentialProjection({ current, targetAccountUuid: A, projectedOauth: oauth }), error =>
      error.code === "AIMGR_CLAUDE_PRIVATE_IDENTITY" && !error.message.includes("PRIVATE_SECRET") && !error.message.includes("private-value"));
  }
  assert.deepEqual(planClaudeCredentialProjection({ current: thirdParty, targetAccountUuid: A, projectedOauth: oauth }), { ...thirdParty, claudeAiOauth: oauth });
});

test("invalid projection or signed-device shape never replaces the native document", () => {
  for (const projectedOauth of [null, [], {}, { accessToken: " " }]) assert.throws(() =>
    planClaudeCredentialProjection({ targetAccountUuid: A, projectedOauth }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
  assert.throws(() => planClaudeCredentialProjection({ current: { coworkRemoteDevice: [] }, currentAccountUuid: A,
    targetAccountUuid: A, projectedOauth: oauth }), /signed-device/);
});


test("legacy lossy projection retains metadata only for the same issued tokens", () => {
  const current = { claudeAiOauth: { ...oauth, clientId: "issued-client", refreshTokenExpiresAt: 12345 } };
  const apply = projectedOauth => planClaudeCredentialProjection({ current, currentAccountUuid: A, targetAccountUuid: A, projectedOauth }).claudeAiOauth;
  assert.deepEqual(apply(oauth), current.claudeAiOauth);
  assert.deepEqual(apply({ ...oauth, refreshToken: "rotated" }), { ...oauth, refreshToken: "rotated" });
  assert.deepEqual(apply({ ...oauth, clientId: null, refreshTokenExpiresAt: null }), { ...oauth, clientId: null, refreshTokenExpiresAt: null });
  assert.deepEqual(planClaudeCredentialProjection({ current, currentAccountUuid: A, targetAccountUuid: B, projectedOauth: oauth }).claudeAiOauth, oauth);
});
