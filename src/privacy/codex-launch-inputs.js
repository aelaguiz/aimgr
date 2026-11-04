import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  effectiveInputs }) {
  if (!effectiveInputs) throw new Error("Codex requires an admitted native input inventory.");
  const cwd = codexCanonicalPath(effectiveInputs.cwd);
  const writes = new Set(), reads = new Set(), databases = new Set();
  const add = (set, file) => { if (typeof file === "string") set.add(codexCanonicalPath(file)); };
  const actualHome = codexCanonicalPath(homeDir);
  // Starting in the user's home is valid, but it does not implicitly disclose
  // that whole directory to vendor code. Ordinary requested tools retain it.
  if (cwd !== actualHome && cwd !== "/") add(writes, cwd);
  for (const file of parsedArgs.directories) add(writes, file);
  for (const file of parsedArgs.images) add(reads, file);
  for (const file of parsedArgs.files ?? []) add(reads, file);
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
  // Effective configuration decisions belong to the admitted native helper.
  // This module inventories only explicit startup inputs, shared state, Git
  // metadata and existing environment-selected local transport/trust files.
  for (const file of effectiveInputs.reads) add(reads, file);
  for (const file of managedFiles) add(reads, file);
  for (const file of effectiveInputs.writes) add(writes, file);
  for (const file of effectiveInputs.database_roots) add(databases, file);
  const selectedCA = env.CODEX_CA_CERTIFICATE || env.SSL_CERT_FILE;
  for (const file of [selectedCA, env.SSL_CERT_DIR, env.NODE_EXTRA_CA_CERTS]) if (file) add(reads, path.resolve(cwd, file));
  for (const socket of keyringSockets(env)) add(writes, socket);
  return { cwd, writes: [...writes], reads: [...reads], databases: [...databases], effectiveInputs };
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
