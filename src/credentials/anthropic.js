import { createHash } from "node:crypto";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { buildClaudeNativeBundle, deriveAnthropicCredentialView, getClaudeNativeBundle, hasCompleteClaudeNativeBundle } from "./claude-bundle.js";

export function buildAnthropicCredentialFingerprint(credential) {
  const cred = assertAnthropicCredentialShape({
    label: "<fingerprint>",
    credential,
    requireFresh: false,
    requireClaudeNativeBundle: false,
  });
  const normalized = { nativeClaudeBundle: buildClaudeNativeBundle(getClaudeNativeBundle(cred)) };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function getAnthropicCredentialView(credential) {
  return deriveAnthropicCredentialView(credential);
}

export function buildAnthropicTokenLineageFingerprint(credential) {
  const view = deriveAnthropicCredentialView(credential);
  const access = typeof view?.access === "string" ? view.access.trim() : "";
  const refresh = typeof view?.refresh === "string" ? view.refresh.trim() : "";
  if (!access || !refresh) return null;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ access, refresh }))
    .digest("hex")}`;
}

export function tryBuildAnthropicCredentialFingerprint(credential) {
  try {
    return buildAnthropicCredentialFingerprint(credential);
  } catch {
    return null;
  }
}

export function assertAnthropicCredentialShape({ label, credential, requireFresh, requireClaudeNativeBundle = false }) {
  const cred = deriveAnthropicCredentialView(credential);
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
