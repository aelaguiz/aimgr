import { extractOpenAICodexAccountIdFromToken } from "./jwt.js";

const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_TIMEOUT_MS = 8_000;

export class CodexRefreshInvalidGrantError extends Error {
  constructor() {
    super("Codex refresh token requires reauthentication.");
    this.name = "CodexRefreshInvalidGrantError";
  }
}

export async function refreshCodexWithoutBrowser({
  credential,
  fetchJsonWithTimeoutImpl,
  nowMs = Date.now(),
  signal = null,
  timeoutMs = CODEX_REFRESH_TIMEOUT_MS,
}) {
  const refresh = typeof credential?.refresh === "string" ? credential.refresh.trim() : "";
  const expectedAccountId = typeof credential?.accountId === "string" ? credential.accountId.trim() : "";
  if (!refresh || !expectedAccountId) {
    throw new Error("Codex refresh requires complete stored refresh material.");
  }
  if (typeof fetchJsonWithTimeoutImpl !== "function") {
    throw new Error("Codex refresh requires a bounded JSON fetch implementation.");
  }

  const response = await fetchJsonWithTimeoutImpl(
    OPENAI_CODEX_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      ...(signal ? { signal } : {}),
    },
    Math.min(CODEX_REFRESH_TIMEOUT_MS, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CODEX_REFRESH_TIMEOUT_MS),
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Codex refresh returned malformed JSON.");
  }
  if (body?.error === "invalid_grant") {
    throw new CodexRefreshInvalidGrantError();
  }
  if (response.ok !== true) {
    throw new Error(`Codex refresh failed with HTTP ${Number(response.status) || "unknown"}.`);
  }

  const access = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  const nextRefresh = typeof body?.refresh_token === "string" ? body.refresh_token.trim() : "";
  const expiresInSeconds = Number(body?.expires_in);
  if (!access || !nextRefresh || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Codex refresh response is incomplete.");
  }
  const accountId = extractOpenAICodexAccountIdFromToken(access);
  if (!accountId) {
    throw new Error("Codex refresh response has no account identity.");
  }
  if (accountId !== expectedAccountId) {
    throw new Error("Codex refresh response changed account identity.");
  }

  return {
    access,
    refresh: nextRefresh,
    expiresAt: new Date(nowMs + expiresInSeconds * 1_000).toISOString(),
    accountId,
    idToken: access,
  };
}
