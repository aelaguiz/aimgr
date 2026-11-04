import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexSourcePath, parseCodexSettings, projectCodexSettings } from "../io/codex-settings-toml.js";

export function codexCanonicalPath(file) {
  let current = path.resolve(file), missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" || current === path.dirname(current)) throw error;
      // A dangling symlink is an authored target, not a literal missing name.
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("A required Codex path has a dangling symlink.");
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      missing.push(path.basename(current)); current = path.dirname(current);
    }
  }
}

function parsed(file, home) {
  try { return parseCodexSettings(projectCodexSettings(fs.readFileSync(file, "utf8"), { source: file, home })).value; }
  catch (error) {
    if (error.code && error.code !== "ENOENT") throw error;
    // Native remains the source of syntax/schema errors. This inspection only
    // derives file grants; it does not replace configuration precedence.
    return null;
  }
}

function keyringSockets(env) {
  if (process.platform !== "linux") return [];
  const addresses = env.DBUS_SESSION_BUS_ADDRESS;
  const candidates = addresses ? addresses.split(";").flatMap(address => {
    if (!address.startsWith("unix:")) return [];
    const encoded = address.slice(5).split(",").find(field => field.startsWith("path="))?.slice(5);
    if (!encoded) return [];
    try { return [decodeURIComponent(encoded)]; } catch { return []; }
  }) : [path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "bus")];
  return candidates.filter(file => {
    // A bus address is a socket grant, never authority for an arbitrary file
    // or directory named in environment configuration.
    if (!path.isAbsolute(file)) return false;
    try { return fs.statSync(file).isSocket(); } catch { return false; }
  });
}

export function resolveCodexLaunchInputs({ prepared, parsedArgs, homeDir, env, managedFiles = [], spawnSyncImpl = spawnSync,
  systemConfigFile = "/etc/codex/config.toml" }) {
  const cwd = codexCanonicalPath(parsedArgs.cwd);
  const writes = new Set(), reads = new Set(), databases = new Set();
  const add = (set, file) => { if (typeof file === "string") set.add(codexCanonicalPath(file)); };
  const actualHome = codexCanonicalPath(homeDir);
  // Starting in the user's home is valid, but it does not implicitly disclose
  // that whole directory to vendor code. Ordinary requested tools retain it.
  if (cwd !== actualHome && cwd !== "/") add(writes, cwd);
  for (const file of parsedArgs.directories) add(writes, file);
  for (const file of parsedArgs.images) add(reads, file);
  for (const name of fs.readdirSync(prepared.codexHome)) {
    // Shared settings views receive their own permission-aware grants after
    // reconciliation, rather than the generic mutable-state grant.
    if (name === "config.toml" || name.endsWith(".config.toml")) continue;
    const file = path.join(prepared.codexHome, name);
    if (fs.lstatSync(file).isSymbolicLink() && fs.existsSync(file)) add(writes, file);
  }
  // Git worktrees keep their common metadata outside the worktree. Asking Git
  // for these two local paths preserves worktree behavior without copying Git
  // config or reading/removing remotes and user credentials.
  const git = spawnSyncImpl("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
    cwd, env, encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  if (git.status === 0) for (const file of git.stdout.trim().split("\n")) add(writes, path.resolve(cwd, file));
  const configFiles = [path.join(prepared.sharedHome, "config.toml"),
    ...(parsedArgs.profile ? [path.join(prepared.sharedHome, `${parsedArgs.profile}.config.toml`)] : []), systemConfigFile, ...managedFiles];
  for (let current = cwd; ; current = path.dirname(current)) {
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) if (fs.existsSync(path.join(current, name))) add(reads, path.join(current, name));
    for (const name of [".codex", ".agents/skills"]) {
      const file = path.join(current, name);
      if (name === ".codex") configFiles.push(path.join(file, "config.toml"));
      else if (fs.existsSync(file)) add(reads, file);
    }
    if (current === path.dirname(current)) break;
  }
  const globalSkills = path.join(homeDir, ".agents", "skills");
  if (fs.existsSync(globalSkills)) add(reads, globalSkills);
  const visited = new Set(), configurations = [];
  function inspect(value, keys = []) {
    if (typeof value === "string" && codexSourcePath(keys)) {
      if (keys.length === 1 && keys[0] === "sqlite_home") add(databases, value);
      else if (keys.length === 1 && keys[0] === "log_dir") add(writes, value);
      else if (keys[0] === "sandbox_workspace_write" && keys[1] === "writable_roots") add(writes, value);
      else add(reads, value);
      if (keys[0] === "agents" && keys.at(-1) === "config_file") configFiles.push(value);
    } else if (Array.isArray(value)) value.forEach((item, index) => inspect(item, [...keys, index]));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) inspect(item, [...keys, key]);
  }
  for (let i = 0; i < configFiles.length; i++) {
    if (i > 256) throw new Error("Codex configured input inventory exceeds native capacity.");
    const file = configFiles[i];
    if (visited.has(file)) continue;
    visited.add(file);
    if (!fs.existsSync(file)) continue;
    // Grant the file, never its whole parent merely because it holds config.
    add(reads, file);
    const value = parsed(file, homeDir);
    if (value) { configurations.push({ file, value }); inspect(value); }
  }
  for (const override of parsedArgs.config) {
    try {
      const value = parseCodexSettings(projectCodexSettings(override, { source: path.join(cwd, "config.toml"), home: homeDir })).value;
      configurations.push({ source: "CLI override", value }); inspect(value);
    }
    catch { /* native validates CLI overrides */ }
  }
  add(databases, path.resolve(cwd, env.CODEX_SQLITE_HOME || prepared.sharedHome));
  for (const name of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) if (env[name]) add(reads, path.resolve(cwd, env[name]));
  for (const socket of keyringSockets(env)) add(writes, socket);
  return { cwd, writes: [...writes], reads: [...reads], databases: [...databases], configurations };
}

export function codexPrivacyEnvironment({ env, prepared, artifact, scratch }) {
  const output = { ...env, CODEX_HOME: prepared.codexHome, TMPDIR: scratch,
    CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME || prepared.sharedHome,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    AIMGR_CODEX_ARTIFACT_SET: artifact.artifactSet,
  };
  // The native primary-auth overrides are CODEX_*; the default OpenAI provider
  // has no env_key. Preserve OPENAI_API_KEY for independent SDK/tool commands.
  for (const name of ["TERM_PROGRAM_VERSION", "WEZTERM_VERSION", "KONSOLE_VERSION", "VTE_VERSION", "ZELLIJ_VERSION",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_THREAD_ID", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete output[name];
  output.PATH = path.dirname(artifact.command) + (env.PATH ? path.delimiter + env.PATH : "");
  return output;
}
