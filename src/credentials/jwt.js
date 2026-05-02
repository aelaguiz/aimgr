import { isObject } from "../core/normalize.js";

export function isLikelyJwt(value) {
  const raw = String(value ?? "").trim();
  const parts = raw.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function decodeJwtPayload(token) {
  const raw = String(token ?? "").trim();
  if (!isLikelyJwt(raw)) return null;
  const [, payloadSegment] = raw.split(".");
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractOpenAICodexAccountIdFromClaims(claims) {
  if (!isObject(claims)) return null;
  const authClaims = isObject(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
  const candidates = [
    authClaims?.chatgpt_account_id,
    claims["https://api.openai.com/auth.chatgpt_account_id"],
    claims.chatgpt_account_id,
    claims.account_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function extractOpenAICodexAccountIdFromToken(token) {
  return extractOpenAICodexAccountIdFromClaims(decodeJwtPayload(token));
}

export function extractJwtIdentityLabel(token, fallback = "device_code") {
  const claims = decodeJwtPayload(token);
  if (isObject(claims)) {
    for (const key of ["email", "preferred_username", "upn"]) {
      const value = claims[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return fallback;
}
