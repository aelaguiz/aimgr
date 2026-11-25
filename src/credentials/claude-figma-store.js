import fs from "node:fs";
import path from "node:path";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveAimgrStateDir } from "../io/paths.js";

export const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
export const FIGMA_MCP_NAME = "figma-work";

const GRANT_FILE = "grant.json";
const MAX_GRANT_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const oauthToken = value => typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
const grantError = () => new Error("The local Figma grant is unavailable or unsafe.");

export function figmaGrantRoot(homeDir) {
  if (!path.isAbsolute(homeDir ?? "")) throw grantError();
  return path.join(resolveAimgrStateDir({ homeDir }), "claude-integrations", "figma");
}

function inspectGrantRoot({ homeDir, fsImpl, create }) {
  const root = figmaGrantRoot(homeDir);
  const directories = [resolveAimgrStateDir({ homeDir }), path.dirname(root), root];
  for (const directory of directories) {
    if (create) {
      try { fsImpl.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid()
      || (stat.mode & (directory === root ? 0o077 : 0o022))) throw grantError();
  }
  return root;
}

export function ensureClaudeFigmaGrantRoot({ homeDir, fsImpl = fs } = {}) {
  try { return inspectGrantRoot({ homeDir, fsImpl, create: true }); }
  catch { throw grantError(); }
}

export function selectClaudeFigmaNativeGrant(native) {
  if (!object(native?.mcpOAuth)) return null;
  const entries = Object.entries(native.mcpOAuth).filter(([, entry]) => (
    entry?.serverName === "figma" && entry?.serverUrl === FIGMA_MCP_URL
  ));
  if (entries.length !== 1) return null;
  const [[key, entry]] = entries;
  const { expiresAt, accessToken, refreshToken } = entry;
  if (!oauthToken(accessToken) || !oauthToken(refreshToken) || !Number.isFinite(expiresAt)
    || expiresAt <= 0 || !Number.isFinite(new Date(expiresAt).getTime())) return null;
  const selected = { mcpOAuth: { [key]: structuredClone(entry) } };
  if (Object.hasOwn(native.mcpOAuthClientConfig ?? {}, key)) {
    const client = native.mcpOAuthClientConfig[key];
    if (!object(client)) return null;
    selected.mcpOAuthClientConfig = { [key]: structuredClone(client) };
  }
  return { key, native: selected, expiresAt, accessToken, refreshToken };
}

function privateGrantFile(stat) {
  return stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1
    && !(stat.mode & 0o077) && stat.size <= MAX_GRANT_BYTES;
}

function normalizedEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
}

export function readClaudeFigmaGrant({ homeDir, fsImpl = fs } = {}) {
  let fd;
  try {
    const root = inspectGrantRoot({ homeDir, fsImpl, create: false });
    fd = fsImpl.openSync(path.join(root, GRANT_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!privateGrantFile(fsImpl.fstatSync(fd))) throw grantError();
    const stored = JSON.parse(fsImpl.readFileSync(fd, "utf8"));
    const email = normalizedEmail(stored?.email);
    const grant = selectClaudeFigmaNativeGrant(stored?.native);
    if (stored?.schema !== 1 || !email || !grant) throw grantError();
    return { email, ...grant };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw grantError();
  } finally { if (fd !== undefined) fsImpl.closeSync(fd); }
}

export function writeClaudeFigmaGrant({ homeDir, email, native } = {}) {
  try {
    const normalized = normalizedEmail(email);
    const grant = selectClaudeFigmaNativeGrant(native);
    if (!normalized || !grant) throw grantError();
    const stored = { schema: 1, email: normalized, native: grant.native };
    if (Buffer.byteLength(`${JSON.stringify(stored, null, 2)}\n`) > MAX_GRANT_BYTES) throw grantError();
    const file = path.join(ensureClaudeFigmaGrantRoot({ homeDir }), GRANT_FILE);
    try { if (!privateGrantFile(fs.lstatSync(file))) throw grantError(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    writeJsonFileIfChanged(file, stored, { mode: 0o600 });
    return { email: normalized, ...grant };
  } catch { throw grantError(); }
}
