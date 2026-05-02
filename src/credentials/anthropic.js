import { createHash } from "node:crypto";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { buildClaudeNativeBundle, cloneJsonObject, hasCompleteClaudeNativeBundle, normalizeNonEmptyStringArray } from "./claude-bundle.js";

export function buildAnthropicCredentialFingerprint(credential) {
  const cred = assertAnthropicCredentialShape({
    label: "<fingerprint>",
    credential,
    requireFresh: false,
    requireClaudeNativeBundle: false,
  });
  const normalized = {
    access: String(cred.access).trim(),
    refresh: String(cred.refresh).trim(),
    expiresAt: String(cred.expiresAt).trim(),
    ...(typeof cred.subscriptionType === "string" && cred.subscriptionType.trim()
      ? { subscriptionType: cred.subscriptionType.trim() }
      : {}),
    ...(typeof cred.rateLimitTier === "string" && cred.rateLimitTier.trim()
      ? { rateLimitTier: cred.rateLimitTier.trim() }
      : {}),
    ...(Array.isArray(cred.scopes) && normalizeNonEmptyStringArray(cred.scopes).length > 0
      ? { scopes: normalizeNonEmptyStringArray(cred.scopes) }
      : {}),
    ...(typeof cred.emailAddress === "string" && cred.emailAddress.trim()
      ? { emailAddress: cred.emailAddress.trim().toLowerCase() }
      : {}),
    ...(typeof cred.organizationName === "string" && cred.organizationName.trim()
      ? { organizationName: cred.organizationName.trim() }
      : {}),
    ...(typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()
      ? { organizationUuid: cred.organizationUuid.trim() }
      : {}),
    ...(isObject(cred.nativeClaudeBundle)
      ? {
          nativeClaudeBundle: buildClaudeNativeBundle(cred.nativeClaudeBundle) ?? cloneJsonObject(cred.nativeClaudeBundle),
        }
      : {}),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function tryBuildAnthropicCredentialFingerprint(credential) {
  try {
    return buildAnthropicCredentialFingerprint(credential);
  } catch {
    return null;
  }
}

export function assertAnthropicCredentialShape({ label, credential, requireFresh, requireClaudeNativeBundle = false }) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) {
    throw new Error(`Missing anthropic credentials for label=${label}.`);
  }
  if (typeof cred.access !== "string" || !cred.access.trim()) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.access is missing.`);
  }
  if (typeof cred.refresh !== "string" || !cred.refresh.trim()) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.refresh is missing.`);
  }
  const expiresMs = parseExpiresAtToMs(cred.expiresAt);
  if (!expiresMs) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.expiresAt is missing/invalid.`);
  }
  if (requireFresh && expiresMs <= Date.now()) {
    throw new Error(`Refusing expired anthropic credentials for label=${label}. Reauth that label with \`aim ${label}\` first.`);
  }
  if (requireClaudeNativeBundle && !hasCompleteClaudeNativeBundle(cred)) {
    throw new Error(
      `credentials.${ANTHROPIC_PROVIDER}.${label}.nativeClaudeBundle is missing or incomplete. ` +
        `Capture/import a native Claude login with \`aim claude capture-native ${label}\` or ` +
        `\`aim claude import-native ${label} --in <file>\`.`,
    );
  }
  return cred;
}
