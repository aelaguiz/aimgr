import crypto from "node:crypto";

// Sakana is an API-key provider (no OAuth). A "Sakana account" is one
// subscription-backed API key. We identify it by a stable fingerprint of the
// key so we never have to print or log the secret itself.

export const SAKANA_TIERS = new Set(["standard", "pro", "max", "payg"]);

export function normalizeSakanaApiKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key) {
    throw new Error("Missing Sakana API key.");
  }
  if (/\s/.test(key)) {
    throw new Error("Sakana API key must not contain whitespace.");
  }
  return key;
}

export function buildSakanaKeyFingerprint(apiKey) {
  const key = normalizeSakanaApiKey(apiKey);
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

export function redactSakanaApiKey(apiKey) {
  const key = String(apiKey ?? "");
  if (!key) return "";
  const tail = key.slice(-4);
  return `***${tail}`;
}

export function normalizeSakanaTier(tier) {
  if (tier === undefined || tier === null || String(tier).trim() === "") {
    return null;
  }
  const normalized = String(tier).trim().toLowerCase();
  if (!SAKANA_TIERS.has(normalized)) {
    throw new Error(`Invalid Sakana tier: ${normalized}. Use one of: standard, pro, max, payg.`);
  }
  return normalized;
}

export function buildSakanaCredential({ apiKey, tier = null, subscription = null, notes = null, createdAt } = {}) {
  const key = normalizeSakanaApiKey(apiKey);
  const normalizedTier = normalizeSakanaTier(tier);
  const normalizedSubscription =
    subscription === undefined || subscription === null || String(subscription).trim() === ""
      ? null
      : String(subscription).trim();
  const normalizedNotes =
    notes === undefined || notes === null || String(notes).trim() === "" ? null : String(notes).trim();
  return {
    apiKey: key,
    ...(normalizedTier ? { tier: normalizedTier } : {}),
    ...(normalizedSubscription ? { subscription: normalizedSubscription } : {}),
    ...(normalizedNotes ? { notes: normalizedNotes } : {}),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

export function buildSakanaIdentity(apiKey, { subscription = null } = {}) {
  return {
    keyFingerprint: buildSakanaKeyFingerprint(apiKey),
    ...(subscription ? { subscription: String(subscription).trim() } : {}),
  };
}
