import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { durableCodexWrite, durableCodexMkdir } from "../io/codex-state-io.js";
import { readCodexInstallationId } from "../targets/codex-installation-id.js";
import { readCodexEnvironment } from "./codex-environment.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const SHARED = new Set(["AGENTS.md", "AGENTS.override.md", "instructions.md", "skills", "agents", "rules", "memories", "memory", "sessions", "archived_sessions", "history.jsonl", "session_index.jsonl", "plugins", "marketplaces", "prompts", "thread-writer-locks"]);

// Direct MCP keyring entries are OS-user scoped, independent of account or
// settings origin. Reuse native's ordinary default-home lock inodes so those
// sessions and every AIM home serialize the same rotating MCP credential.
export const codexMcpLockDirectory = homeDir => path.join(homeDir, ".codex", "mcp-oauth-locks");

function readOwner(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, ".aim-account.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function codexSharedHome({ homeDir, env = {}, environment }) {
  const selected = path.resolve(env.CODEX_HOME || path.join(homeDir, ".codex"));
  const owner = readOwner(selected);
  if (owner && owner.environmentId !== environment?.binding) throw new Error("The selected Codex home belongs to another environment. Sign in on this machine; do not import its credentials.");
  return owner?.schema === 1 && path.isAbsolute(owner.sharedHome) ? owner.sharedHome : selected;
}

export function codexAccountPaths({ homeDir, accountId, env = {}, environment = readCodexEnvironment() }) {
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("Codex private state requires the underlying account identity.");
  const base = path.join(homeDir, ".aimgr");
  const sharedHome = codexSharedHome({ homeDir, env, environment });
  if (!/^[a-f0-9]{64}$/.test(environment?.binding)) throw new Error("Codex account state requires a provisioned environment identity.");
  const accountRoot = path.join(base, "accounts", "openai-codex", hash(`${environment.binding}\0${accountId}`));
  // A custom settings origin gets its own native home, but the same account's
  // credentials/ID and native refresh lock remain at one canonical target.
  const codexHome = path.join(accountRoot, "homes", hash(sharedHome));
  return { base, accountRoot, codexHome, sharedHome, accountId, environmentId: environment.binding };
}

function createOnce(file, text) {
  const staged = `${file}.${randomUUID()}`;
  durableCodexWrite(staged, text, { exclusive: true });
  try { fs.linkSync(staged, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { fs.unlinkSync(staged); }
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function codexStateLink(file, target) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSymbolicLink() || path.resolve(path.dirname(file), fs.readlinkSync(file)) !== target) {
      throw new Error(`Codex state entry has a different owner: ${file}`);
    }
    return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { fs.symlinkSync(target, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; codexStateLink(file, target); }
}

export function prepareCodexAccountState({ homeDir, env = {}, accountId, label, environment }) {
  const prepared = codexAccountPaths({ homeDir, env, accountId, environment });
  for (const directory of [prepared.accountRoot, prepared.codexHome, prepared.sharedHome, codexMcpLockDirectory(homeDir)]) durableCodexMkdir(directory);
  const ownerFile = path.join(prepared.codexHome, ".aim-account.json");
  createOnce(ownerFile, JSON.stringify({ schema: 1, accountId, environmentId: prepared.environmentId, sharedHome: prepared.sharedHome, accountRoot: prepared.accountRoot }) + "\n");
  const owner = readOwner(prepared.codexHome);
  if (owner?.schema !== 1 || owner.accountId !== accountId || owner.environmentId !== prepared.environmentId || owner.sharedHome !== prepared.sharedHome || owner.accountRoot !== prepared.accountRoot) {
    throw new Error("Codex private home belongs to a different account, environment or settings origin.");
  }
  const accountOwnerFile = path.join(prepared.accountRoot, "owner.json");
  createOnce(accountOwnerFile, JSON.stringify({ schema: 1, accountId, environmentId: prepared.environmentId }) + "\n");
  const accountOwner = JSON.parse(fs.readFileSync(accountOwnerFile, "utf8"));
  if (accountOwner.schema !== 1 || accountOwner.accountId !== accountId || accountOwner.environmentId !== prepared.environmentId) throw new Error("Codex primary credentials belong to a different account or environment.");
  const idFile = path.join(prepared.accountRoot, "installation_id");
  if (!fs.existsSync(idFile)) {
    // Legacy label-derived IDs have no environment provenance. A destination
    // must not inherit one just because a copied auth file names this account.
    createOnce(idFile, randomUUID() + "\n");
  }
  const installationId = readCodexInstallationId({ codexHome: prepared.accountRoot });
  if (!installationId) throw new Error("Codex account installation identity is invalid.");
  for (const name of ["auth.json", "installation_id"]) codexStateLink(path.join(prepared.codexHome, name), path.join(prepared.accountRoot, name));
  codexStateLink(path.join(prepared.codexHome, "mcp-oauth-locks"), codexMcpLockDirectory(homeDir));
  // Native creates these lazily. Link their canonical destinations before the
  // first owner, including an initially empty history, so first use cannot
  // silently create a private parallel transcript tree.
  for (const name of ["thread-writer-locks", "sessions", "archived_sessions", "memories"]) fs.mkdirSync(path.join(prepared.sharedHome, name), { recursive: true, mode: 0o700 });
  for (const name of ["history.jsonl", "session_index.jsonl"]) {
    const fd = fs.openSync(path.join(prepared.sharedHome, name), "a", 0o600);
    fs.closeSync(fd);
  }
  for (const name of fs.readdirSync(prepared.sharedHome)) {
    if (SHARED.has(name)) codexStateLink(path.join(prepared.codexHome, name), path.join(prepared.sharedHome, name));
  }
  return Object.freeze({ ...prepared, label, installationId });
}
