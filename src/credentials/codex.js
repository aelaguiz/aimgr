import { createHash } from "node:crypto";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject } from "../core/normalize.js";

export function getCodexCredentialFromStateUnsafe(state, label) {
  const byLabel = isObject(state?.credentials?.[OPENAI_CODEX_PROVIDER]) ? state.credentials[OPENAI_CODEX_PROVIDER] : {};
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function getAnthropicCredentialFromStateUnsafe(state, label) {
  const byLabel = isObject(state?.credentials?.[ANTHROPIC_PROVIDER]) ? state.credentials[ANTHROPIC_PROVIDER] : {};
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function buildCodexCredentialFingerprint(credential) {
  const cred = assertCodexCredentialShape({
    label: "<fingerprint>",
    credential,
    requireFresh: false,
  });
  const normalized = {
    access: String(cred.access).trim(),
    refresh: String(cred.refresh).trim(),
    expiresAt: String(cred.expiresAt).trim(),
    accountId: String(cred.accountId).trim(),
    ...(typeof cred.idToken === "string" && cred.idToken.trim() ? { idToken: cred.idToken.trim() } : {}),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function tryBuildCodexCredentialFingerprint(credential) {
  try {
    return buildCodexCredentialFingerprint(credential);
  } catch {
    return null;
  }
}

export function assertCodexCredentialShape({ label, credential, requireFresh }) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) {
    throw new Error(`Missing openai-codex credentials for label=${label}.`);
  }
  if (typeof cred.access !== "string" || !cred.access.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.access is missing.`);
  }
  if (typeof cred.refresh !== "string" || !cred.refresh.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.refresh is missing.`);
  }
  if (typeof cred.accountId !== "string" || !cred.accountId.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.accountId is missing.`);
  }
  const expiresMs = parseExpiresAtToMs(cred.expiresAt);
  if (!expiresMs) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.expiresAt is missing/invalid.`);
  }
  if (requireFresh && expiresMs <= Date.now()) {
    throw new Error(`Refusing expired openai-codex credentials for label=${label}. Refresh the label with \`aim login ${label}\` before projection.`);
  }
  return cred;
}

export function findCodexLabelByAccountId(state, accountId) {
  const targetAccountId = String(accountId ?? "").trim();
  if (!targetAccountId) return null;
  const byLabel = isObject(state?.credentials?.[OPENAI_CODEX_PROVIDER]) ? state.credentials[OPENAI_CODEX_PROVIDER] : {};
  for (const [label, cred] of Object.entries(byLabel)) {
    if (!isObject(cred)) continue;
    if (String(cred.accountId ?? "").trim() === targetAccountId) {
      return label;
    }
  }
  return null;
}

export function findCodexLabelByTokenPair(state, { accessToken, refreshToken }) {
  const targetAccess = typeof accessToken === "string" ? accessToken.trim() : "";
  const targetRefresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!targetAccess || !targetRefresh) return null;
  const byLabel = isObject(state?.credentials?.[OPENAI_CODEX_PROVIDER]) ? state.credentials[OPENAI_CODEX_PROVIDER] : {};
  for (const [label, cred] of Object.entries(byLabel)) {
    if (!isObject(cred)) continue;
    if (String(cred.access ?? "").trim() === targetAccess && String(cred.refresh ?? "").trim() === targetRefresh) {
      return label;
    }
  }
  return null;
}
