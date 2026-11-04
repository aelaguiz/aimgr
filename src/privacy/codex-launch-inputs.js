import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CODEX_SHARED_INSTRUCTION_NAMES } from "./codex-account-state.js";

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

// Remove only paths already covered by an admitted directory. Never invent a
// common parent: that would expose unrelated projects or private home files.
function compactGrants(reads, writes) {
  const directories = new Map();
  const directory = file => {
    if (!directories.has(file)) {
      try { directories.set(file, fs.statSync(file).isDirectory()); }
      catch { directories.set(file, false); }
    }
    return directories.get(file);
  };
  const ancestor = (file, roots) => {
    for (let parent = path.dirname(file); parent !== file; file = parent, parent = path.dirname(file)) {
      if (roots.has(parent) && directory(parent)) return true;
    }
    return false;
  };
  return {
    writes: [...writes].filter(file => !ancestor(file, writes)),
    reads: [...reads].filter(file => !writes.has(file) && !ancestor(file, writes) && !ancestor(file, reads)),
  };
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
  const projectCwds = new Set([cwd, ...(effectiveInputs.project_cwds ?? []).map(codexCanonicalPath)]);
  for (const project of projectCwds) if (project !== actualHome && project !== "/") add(writes, project);
  for (const file of parsedArgs.directories) add(writes, file);
  for (const file of parsedArgs.images) add(reads, file);
  for (const file of parsedArgs.files ?? []) add(reads, file);
  for (const file of parsedArgs.outputs ?? []) add(writes, file);
  for (const name of fs.readdirSync(prepared.codexHome)) {
    // Shared settings views receive their own permission-aware grants after
    // reconciliation, rather than the generic mutable-state grant.
    if (name === "config.toml" || name.endsWith(".config.toml")) continue;
    const file = path.join(prepared.codexHome, name);
    if (fs.lstatSync(file).isSymbolicLink() && fs.existsSync(file)) add(writes, file);
  }
  // Instructions can first appear after launch. Grant only these known targets,
  // without resolving their deliberately dangling private-home links or exposing
  // the shared home (which can still contain legacy primary credentials).
  for (const name of CODEX_SHARED_INSTRUCTION_NAMES) {
    const file = path.join(prepared.sharedHome, name);
    try { fs.statSync(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Native treats a dangling optional instruction as absent. Its newly
      // selected destination can receive a grant on the next session.
      try { if (fs.lstatSync(file).isSymbolicLink()) continue; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    add(writes, file);
  }
  // Git worktrees keep their common metadata outside the worktree. Asking Git
  // for these two local paths preserves worktree behavior without copying Git
  // config or reading/removing remotes and user credentials.
  for (const project of projectCwds) {
    const git = spawnSyncImpl("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: project, env, encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    if (git.status === 0) for (const file of git.stdout.trim().split("\n")) add(writes, path.resolve(project, file));
  }
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
  return { cwd, ...compactGrants(reads, writes), databases: [...databases], effectiveInputs };
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
