import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extractOpenAICodexAccountIdFromToken, isLikelyJwt } from "./jwt.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE = "https://auth.openai.com/oauth/authorize";
const TOKEN = "https://auth.openai.com/oauth/token";
export const CODEX_MANUAL_REDIRECT = "http://localhost:1455/auth/callback";

function callbackCode(input, expectedState) {
  let callback;
  try { callback = new URL(String(input).trim()); }
  catch { throw new Error("Codex login needs the complete callback URL."); }
  const redirect = new URL(CODEX_MANUAL_REDIRECT);
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.username || callback.password || callback.hash) {
    throw new Error("Codex callback does not match the login redirect.");
  }
  if (callback.searchParams.has("error")) throw new Error("Codex authorization was refused or cancelled.");
  const codes = callback.searchParams.getAll("code"), states = callback.searchParams.getAll("state");
  const actual = Buffer.from(states[0] ?? ""), expected = Buffer.from(expectedState);
  if (states.length !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Codex callback does not belong to this login.");
  if (codes.length !== 1 || !codes[0].trim()) throw new Error("Codex callback must contain one authorization code.");
  return codes[0];
}

/** Owns one manual handoff and one token exchange. No HTTP listener, browser
 * launch, native login or alternate login transport exists in this module.
 * The explicit bounded fetch is also the milestone 2 route composition point.
 */
export async function loginCodexManually({ emitAuthUrl, readCallbackUrl, fetchJsonWithTimeoutImpl,
  expectedAccountId, signal, timeoutMs = 10 * 60_000, now = Date.now } = {}) {
  if (typeof emitAuthUrl !== "function" || typeof readCallbackUrl !== "function" || typeof fetchJsonWithTimeoutImpl !== "function") throw new Error("Codex manual login needs its handoff and bounded transport.");
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex");
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID,
    redirect_uri: CODEX_MANUAL_REDIRECT, scope: "openid profile email offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "aimgr" }).toString();
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(), timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let abort;
  try {
    cancellation.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new Error("Codex manual login was cancelled or timed out."));
      cancellation.addEventListener("abort", abort, { once: true });
    });
    // Register stdin before emitting the URL so fast scripted replies cannot
    // arrive before the reader exists. This promise is consumed exactly once.
    const input = Promise.resolve(readCallbackUrl({ signal: cancellation }));
    const handoff = Promise.race([input, cancelled]);
    handoff.catch(() => {});
    await Promise.race([Promise.resolve(emitAuthUrl({ url: url.href })), cancelled]);
    const code = callbackCode(await handoff, state);
    cancellation.throwIfAborted();
    const response = await fetchJsonWithTimeoutImpl(TOKEN, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: cancellation,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID,
        code, code_verifier: verifier, redirect_uri: CODEX_MANUAL_REDIRECT }) }, 8_000);
    let body;
    try { body = await response.json(); } catch { throw new Error("Codex token exchange returned invalid JSON."); }
    if (!response.ok || body?.error) throw new Error(`Codex token exchange failed (HTTP ${Number(response.status) || "unknown"}).`);
    if (!body || typeof body.access_token !== "string" || !body.access_token || typeof body.refresh_token !== "string" || !body.refresh_token ||
        !isLikelyJwt(body.id_token) || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error("Codex token exchange returned incomplete credentials.");
    const accessAccount = extractOpenAICodexAccountIdFromToken(body.access_token);
    const idAccount = extractOpenAICodexAccountIdFromToken(body.id_token);
    const accountId = accessAccount ?? idAccount;
    if (!accountId || (accessAccount && idAccount && accessAccount !== idAccount) || (expectedAccountId && accountId !== expectedAccountId)) throw new Error("Codex login returned a different or missing account identity.");
    const expiry = new Date(now() + body.expires_in * 1000);
    if (!Number.isFinite(expiry.getTime())) throw new Error("Codex token exchange returned an invalid expiry.");
    cancellation.throwIfAborted();
    return { access: body.access_token, refresh: body.refresh_token, idToken: body.id_token, expiresAt: expiry.toISOString(), accountId };
  } finally {
    clearTimeout(deadline);
    cancellation.removeEventListener("abort", abort);
    timeout.abort(); // Close a pending handoff reader if emitting the URL failed.
  }
}
