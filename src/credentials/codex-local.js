import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { codexAccountPaths, prepareCodexAccountState } from "../privacy/codex-account-state.js";
import { codexStateIO } from "../io/codex-state-io.js";
import { buildCodexAuthDotJson } from "../targets/codex-store.js";
import { decodeJwtPayload, extractOpenAICodexAccountIdFromToken, isLikelyJwt } from "./jwt.js";
import { fetchJsonWithTimeout } from "../io/fetch.js";

export const CODEX_LOCAL_AUTHORITY = "environment-local";
const generation = raw => createHash("sha256").update(raw ?? "").digest("hex");

export function assertCodexCredentialExportable(credential) {
  if (credential?.authority === CODEX_LOCAL_AUTHORITY || credential?.environmentId) {
    throw new Error("Environment-local Codex credentials cannot be published, exported or copied to another harness.");
  }
}

function privateText(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077)) throw new Error("Codex local auth requires private, singly owned files.");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function parse(raw) {
  try { return raw === null ? null : JSON.parse(raw); }
  catch { throw new Error("Codex local auth contains invalid state. Sign in again on this machine."); }
}

// Diagnostic caches keep an opaque local directory reference, not the
// provider account ID or a credential. Revalidate ownership on every use.
export function readReferencedLocalCodexCredential({ homeDir, env = {}, environment, accountKey }) {
  if (!/^[a-f0-9]{64}$/.test(accountKey ?? "")) return { status: "login_required", credential: null };
  const accountRoot = path.join(homeDir, ".aimgr", "accounts", "openai-codex", accountKey);
  const owner = parse(privateText(path.join(accountRoot, "owner.json")));
  if (owner?.schema !== 1 || owner.environmentId !== environment?.binding || typeof owner.accountId !== "string") {
    return { status: "login_required", credential: null };
  }
  const options = { homeDir, env, environment, accountId: owner.accountId };
  if (codexAccountPaths(options).accountRoot !== accountRoot) return { status: "login_required", credential: null };
  return readLocalCodexCredential(options);
}

export function readLocalCodexCredential(options) {
  const paths = codexAccountPaths(options);
  const expectedOwner = { schema: 1, accountId: paths.accountId, environmentId: paths.environmentId };
  const owner = parse(privateText(path.join(paths.accountRoot, "owner.json")));
  if (owner && Object.keys(expectedOwner).some(key => owner[key] !== expectedOwner[key])) throw new Error("Codex credentials belong to a different account or environment.");
  const grantFile = path.join(paths.accountRoot, "grant.json");
  for (let attempt = 0; attempt < 3; attempt++) {
    const grantRaw = privateText(grantFile);
    const raw = privateText(path.join(paths.accountRoot, "auth.json"));
    if (grantRaw !== privateText(grantFile)) continue;
    const result = { paths, raw, grantRaw, generation: generation(raw), credential: null };
    const grant = parse(grantRaw);
    if (!owner || !grant || !raw) return { ...result, status: "login_required" };
    if (grant.schema !== 1 || grant.accountId !== paths.accountId || grant.environmentId !== paths.environmentId || grant.source !== "manual-oauth" || typeof grant.id !== "string") {
      return { ...result, status: "login_required" };
    }
    if (grant.failedGeneration === result.generation) return { ...result, status: "reauth_required" };
    const document = parse(raw);
    // Native resolves explicit modes and non-OAuth authorities before tokens.
    // Cached same-account agent_identity metadata is legitimate native state;
    // the alternate primary modes and their grants are not this authorization.
    if ((document.auth_mode != null && document.auth_mode !== "chatgpt") ||
        ["personal_access_token", "bedrock_api_key", "bedrock_access_keys", "OPENAI_API_KEY"].some(key => document[key] != null)) {
      return { ...result, status: "login_required" };
    }
    const tokens = document.tokens;
    const expires = Number(decodeJwtPayload(tokens?.access_token)?.exp);
    const accessAccount = extractOpenAICodexAccountIdFromToken(tokens?.access_token);
    const idAccount = extractOpenAICodexAccountIdFromToken(tokens?.id_token);
    if (tokens?.account_id !== paths.accountId || accessAccount !== paths.accountId || (idAccount && idAccount !== paths.accountId) ||
        !isLikelyJwt(tokens?.id_token) || typeof tokens?.refresh_token !== "string" || !tokens.refresh_token || !Number.isFinite(expires) || expires <= 0) {
      return { ...result, status: "login_required" };
    }
    return { ...result, status: expires * 1000 > Date.now() ? "ready" : "expired", credential: {
      access: tokens.access_token, refresh: tokens.refresh_token, idToken: tokens.id_token,
      accountId: paths.accountId, expiresAt: new Date(expires * 1000).toISOString(),
      authority: CODEX_LOCAL_AUTHORITY, environmentId: paths.environmentId,
    } };
  }
  throw new Error("Codex login changed while reading it. Retry the command.");
}

function commit(snapshot, { mode, credential, stateIO = codexStateIO }) {
  return stateIO({ operation: "auth", path: path.join(snapshot.paths.accountRoot, "auth.json"),
    accountRoot: snapshot.paths.accountRoot,
    owner: { schema: 1, accountId: snapshot.paths.accountId, environmentId: snapshot.paths.environmentId },
    mode, expected: snapshot.raw, expectedGrant: snapshot.grantRaw,
    ...(credential ? { value: buildCodexAuthDotJson({ credential }) } : {}),
  });
}

// Call only with the result of a new manual OAuth authorization in this
// environment. No legacy/import path calls this function.
export function saveLocalCodexLogin(options, credential) {
  if (credential.accountId !== options.accountId) throw new Error("Codex login account identity changed.");
  prepareCodexAccountState(options);
  const snapshot = readLocalCodexCredential(options);
  if (!commit(snapshot, { mode: "login", credential }).committed) throw new Error("Codex login changed before it could be saved. Sign in again.");
  const saved = readLocalCodexCredential(options);
  if (!saved.credential || saved.credential.refresh !== credential.refresh) throw new Error("Codex login could not be verified after saving.");
  return saved;
}

export function logoutLocalCodexCredential(options) {
  const snapshot = readLocalCodexCredential(options);
  if (!snapshot.grantRaw) return { committed: true, changed: false };
  return commit(snapshot, { mode: "logout" });
}

export async function maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl = fetchJsonWithTimeout, signal, now = Date.now, refreshBeforeMs = 5 * 60_000 } = {}) {
  let current = readLocalCodexCredential(options);
  if (!current.credential || Date.parse(current.credential.expiresAt) > now() + refreshBeforeMs) return current;
  // No local/native lock is held across HTTP. If native Codex rotates while we
  // wait, its exact new generation wins and an old invalid_grant is ignored.
  const response = await fetchJsonWithTimeoutImpl("https://auth.openai.com/oauth/token", {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.credential.refresh, client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
  }, 8_000);
  let body;
  try { body = await response.json(); } catch { throw new Error("Codex refresh returned malformed JSON."); }
  if (body?.error === "invalid_grant") {
    commit(current, { mode: "invalidate" });
    return readLocalCodexCredential(options);
  }
  if (!response.ok || body?.error) throw new Error(`Codex refresh failed (HTTP ${Number(response.status) || "unknown"}).`);
  const credential = { ...current.credential, access: body?.access_token, refresh: body?.refresh_token,
    idToken: body?.id_token ?? current.credential.idToken };
  const idAccount = extractOpenAICodexAccountIdFromToken(credential.idToken);
  const expires = Number(decodeJwtPayload(credential.access)?.exp);
  if (typeof credential.refresh !== "string" || !credential.refresh || !isLikelyJwt(credential.idToken) ||
      extractOpenAICodexAccountIdFromToken(credential.access) !== options.accountId || (idAccount && idAccount !== options.accountId) || !Number.isFinite(expires) || expires * 1000 <= now()) {
    throw new Error("Codex refresh returned incomplete or foreign credentials.");
  }
  signal?.throwIfAborted();
  commit(current, { mode: "refresh", credential });
  return readLocalCodexCredential(options);
}
