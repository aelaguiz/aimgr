import { ClaudePrivateIdentityError, isClaudeAccountId as accountId } from "./claude-identity.js";

// The existing credential-bundle contract treats provider account IDs as
// opaque strings. Ownership comes from the caller's verified bundle/sidecar,
// never from a UUID-shaped string being presumed trustworthy. Keep exact
// equality here and in the local private-identity sidecar.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
// Reviewed 2.1.316 credential document roots. Third-party MCP/XAA auth and
// package secrets are deliberately distinct from Anthropic account credentials.
const THIRD_PARTY = new Set(["mcpOAuth", "mcpOAuthClientConfig", "mcpXaaIdp", "mcpXaaIdpConfig",
  "mcpDiscoveryCacheKey", "pluginSecrets"]);
const PROVIDER = new Set(["claudeAiOauth", "enterpriseGateway", "gatewayTrust", "gatewayAllowlistEntries",
  "designOauth", "cloudSessionsOauth", "organizationUuid", "trustedDeviceToken",
  "trustedDeviceEnrolledAfterRefusalAtMs", "coworkRemoteDevice"]);
const fail = reason => { throw new ClaudePrivateIdentityError(reason); };

/** Preserve classified native secrets while projecting the selected OAuth.
 *
 * T04/T14: buildClaudeAuthDotJson is a portable OAuth projection, NOT the full
 * native credential document. Replacing that document with the projection
 * erases MCP OAuth, OAuth client registration, XAA state and package secrets.
 * This planner is separate from verification/publication: callers verify the
 * bundle's account binding, recover interrupted state first, and journal the
 * result with app state/private identity under exclusive stopped-owner control.
 *
 * Same-account projection retains its classified provider state. Label reuse
 * retains independent third-party auth but cannot carry former Anthropic tokens
 * or signed-device keys. Unknown roots require classification, never silent
 * deletion or blind transfer to another underlying account. No result may be
 * placed in Redis, argv, status or logs; it contains native private secrets.
 */
export function planClaudeCredentialProjection({ current = {}, currentAccountUuid = null,
  targetAccountUuid, projectedOauth } = {}) {
  if (!object(current) || !accountId(targetAccountUuid) || !object(projectedOauth)
    || typeof projectedOauth.accessToken !== "string" || !projectedOauth.accessToken.trim()) {
    fail("the classified credential projection is incomplete");
  }
  if (Object.keys(current).some(key => !THIRD_PARTY.has(key) && !PROVIDER.has(key))) {
    fail("the native credential document contains an unclassified field; preserve it for review");
  }
  const hasProviderState = Object.keys(current).some(key => PROVIDER.has(key) && current[key] != null);
  if (hasProviderState && !accountId(currentAccountUuid)) {
    fail("existing provider credentials have no verified account owner");
  }
  const sameAccount = currentAccountUuid === targetAccountUuid;
  const result = {};
  for (const [key, value] of Object.entries(current)) {
    if (THIRD_PARTY.has(key) || sameAccount) result[key] = structuredClone(value);
  }
  if (sameAccount && result.coworkRemoteDevice != null) {
    if (!object(result.coworkRemoteDevice)) fail("the signed-device credential map is invalid");
    // A copied global map must not make another account's private key visible
    // just because this file otherwise belongs to the selected account.
    result.coworkRemoteDevice = Object.hasOwn(result.coworkRemoteDevice, targetAccountUuid)
      ? { [targetAccountUuid]: result.coworkRemoteDevice[targetAccountUuid] } : {};
  }
  result.claudeAiOauth = structuredClone(projectedOauth);
  const oldOauth = current.claudeAiOauth;
  // Earlier AIM Keychain reads omitted these two optional native fields. Only
  // repair that lossy projection when BOTH tokens identify the same issued
  // credential. A new token is authoritative: an old OAuth client's identity
  // or refresh expiry must not be attached merely because the account matches.
  if (sameAccount && object(oldOauth) && oldOauth.accessToken === projectedOauth.accessToken
    && typeof oldOauth.refreshToken === "string" && oldOauth.refreshToken
    && oldOauth.refreshToken === projectedOauth.refreshToken) {
    for (const key of ["clientId", "refreshTokenExpiresAt"]) {
      if (!Object.hasOwn(projectedOauth, key) && Object.hasOwn(oldOauth, key)) {
        result.claudeAiOauth[key] = structuredClone(oldOauth[key]);
      }
    }
  }
  return result;
}
