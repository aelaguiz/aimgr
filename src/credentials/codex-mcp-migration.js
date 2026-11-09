import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// This is the ordinary MCP File -> Direct conversion for the admitted native
// release. Primary Codex, executor and enterprise identities are not inputs.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const named = name => typeof name === "string" && name.length > 0;
const invalid = () => new Error("Codex MCP migration requires a valid, classified ordinary credential store.");

const credentialName = name => /^(executor:|ema-idp:|local:)/.test(name) ? `local:${name}` : name;

export function codexMcpKey(name, url) {
  if (!named(name) || typeof url !== "string") throw invalid();
  // serde_json's preserve_order is enabled in the admitted official package.
  const digest = createHash("sha256").update(JSON.stringify({ type: "http", url, headers: {} })).digest("hex").slice(0, 16);
  // Input is the configured local server name. Native first escapes reserved
  // names, then removes exactly that escape when deriving the ordinary key.
  return `${name}|${digest}`;
}

function validateEntry(entry) {
  if (!object(entry) || !named(entry.server_name) || entry.executor_owned === true
    || ["server_url", "client_id", "access_token"].some(key => typeof entry[key] !== "string")
    || (entry.executor_owned !== undefined && typeof entry.executor_owned !== "boolean")
    || (entry.issuer != null && typeof entry.issuer !== "string")
    || (entry.refresh_token != null && typeof entry.refresh_token !== "string")
    || (entry.expires_at != null && (!Number.isSafeInteger(entry.expires_at) || entry.expires_at < 0))
    || (entry.scopes !== undefined && (!Array.isArray(entry.scopes) || entry.scopes.some(scope => typeof scope !== "string")))) throw invalid();
}

/** Preserve native BTreeMap lookup order and local: escaping. The caller
 * supplies actual local-environment configured server identities, not native
 * credential names or managed executor/EMA descriptors. */
export function decodeCodexMcpFile(text, servers) {
  let file;
  try { file = JSON.parse(text); } catch { throw invalid(); }
  if (!object(file) || !Array.isArray(servers)) throw invalid();
  const entries = Object.entries(file).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  // A mixed store cannot be removed or converted until its other owners have
  // a migration map. Leave the entire original store untouched on refusal.
  for (const [, entry] of entries) validateEntry(entry);
  const result = [], destinations = new Map(), used = new Set();
  for (const server of servers) {
    if (!named(server?.name) || typeof server.url !== "string"
      || (server.environment_id !== undefined && server.environment_id !== "local")) throw invalid();
    const key = codexMcpKey(server.name, server.url), nativeName = credentialName(server.name);
    const matched = entries.find(([storedKey, entry]) => entry.server_url === server.url
      && (nativeName === server.name || storedKey === key)
      && (entry.server_name === server.name || (storedKey === key && entry.server_name === nativeName)));
    if (!matched) continue;
    const [sourceKey, entry] = matched;
    const token = { server_name: entry.server_name, url: entry.server_url,
      ...(entry.issuer == null ? {} : { issuer: entry.issuer }), client_id: entry.client_id,
      token_response: { access_token: entry.access_token, token_type: "bearer",
        ...(entry.refresh_token == null ? {} : { refresh_token: entry.refresh_token }),
        ...(entry.scopes?.length ? { scope: entry.scopes.join(" ") } : {}) },
      expires_at: entry.expires_at ?? null };
    if (destinations.has(key) && !codexMcpTokensEqual(destinations.get(key), token)) throw invalid();
    used.add(sourceKey);
    if (!destinations.has(key)) { destinations.set(key, token); result.push({ key, serverName: server.name, url: server.url, sourceKey, token }); }
  }
  // Unused legacy entries stay preserved; silently dropping one could discard
  // a currently disabled integration's only working authorization.
  if (used.size !== entries.length) throw new Error("Codex MCP migration needs an owner for every existing credential before changing its store.");
  return result;
}

export function codexMcpTokensEqual(left, right) {
  const normalize = value => {
    if (!object(value) || !object(value.token_response)) return null;
    const { expires_in: ignored, ...token } = value.token_response;
    return { ...value, issuer: value.issuer ?? null, expires_at: value.expires_at ?? null, token_response: token };
  };
  const a = normalize(left), b = normalize(right);
  return a !== null && b !== null && isDeepStrictEqual(a, b);
}
