import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CODEX_SHARED_INSTRUCTION_NAMES, CODEX_SHARED_STATE_NAMES } from "./codex-account-state.js";
import { codexCanonicalPath, codexWorkingDirectories } from "./codex-working-directories.js";

export { codexCanonicalPath } from "./codex-working-directories.js";

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

// The macOS launcher writes every read root, and each of its ancestors, twice
// into a policy it refuses past 1 MiB. PATH grants get a share of that, so an
// unusual PATH can never make the launch fail.
const PATH_POLICY_BUDGET = 256 * 1024;
const policyBytes = file => {
  let bytes = 2 * (file.length + 12);
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    bytes += 2 * (parent.length + 12);
    if (parent === "/") return bytes;
  }
};

// Issue #30. libc's posix_spawnp tries each PATH folder in turn. When the
// first match is a file the sandboxed vendor process may not read, macOS
// starts that file and still reports failure, so the search starts the next
// match too: Codex ran ~/.local/bin/git and /usr/bin/git for one call and read
// both outputs as one. Codex may therefore read the folders on the PATH it
// runs with, and the file behind each executable link in them: a link whose
// target stayed unreadable starts twice the same way. Programs it starts run
// outside the sandbox already; only the lookup needs to succeed. A folder is
// granted whole or not at all, together with the links of any PATH folder
// inside it. One that would expose the home folder or AIM state, that links an
// executable into AIM state, or that does not fit the budget stays unreadable,
// which leaves its links failing cleanly as before.
function codexPathReads({ pathValue, homes, privateRoots }) {
  const contains = (root, target) => target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
  const folders = new Map();
  for (const entry of (pathValue ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    let folder, children;
    try {
      folder = fs.realpathSync(entry);
      children = fs.readdirSync(folder, { withFileTypes: true });
    } catch { continue; }
    if (folders.has(folder)) continue;
    const targets = new Set();
    for (const child of children) {
      if (!child.isSymbolicLink()) continue;
      try {
        const target = fs.realpathSync(path.join(folder, child.name)), stat = fs.statSync(target);
        if (stat.isFile() && stat.mode & 0o111) targets.add(target);
      } catch {}
    }
    folders.set(folder, targets);
  }
  const grants = new Set(), covered = file => [...grants].some(root => contains(root, file));
  let spent = 0;
  for (const folder of folders.keys()) {
    if (covered(folder) || homes.some(home => contains(folder, home))
      || privateRoots.some(root => contains(folder, root) || contains(root, folder))) continue;
    const targets = new Set();
    for (const [member, linked] of folders) if (contains(folder, member)) for (const target of linked) {
      if (!contains(folder, target) && !covered(target)) targets.add(target);
    }
    if ([...targets].some(target => privateRoots.some(root => contains(root, target)))) continue;
    const cost = [...targets].reduce((sum, target) => sum + policyBytes(target), policyBytes(folder));
    if (spent + cost > PATH_POLICY_BUDGET) continue;
    spent += cost;
    for (const file of [folder, ...targets]) grants.add(file);
  }
  return [...grants];
}

export function resolveCodexLaunchInputs({ prepared, parsedArgs, homeDir, env, managedFiles = [], spawnSyncImpl = spawnSync, platform = process.platform,
  effectiveInputs, workingDirectories = codexWorkingDirectories({ homeDir, env, platform, accountRoot: prepared.accountRoot ?? prepared.codexHome }) }) {
  if (!effectiveInputs) throw new Error("Codex requires an admitted native input inventory.");
  const cwd = codexCanonicalPath(effectiveInputs.cwd);
  const writes = new Set(), reads = new Set(), databases = new Set();
  const add = (set, file) => { if (typeof file === "string") set.add(codexCanonicalPath(file)); };
  const actualHome = codexCanonicalPath(homeDir);
  const userHome = env.HOME || homeDir;
  const skillRoots = new Set([path.join(userHome, ".agents/skills"), path.join(prepared.codexHome, "skills"),
    path.join(prepared.sharedHome, "skills")].map(file => path.resolve(file)));
  const protectedSkillParents = [homeDir, userHome, prepared.accountRoot ?? prepared.codexHome,
    prepared.sharedHome, path.join(userHome, ".agents")].map(file => {
    try { return codexCanonicalPath(file); } catch { return path.resolve(file); }
  });
  const addSkill = (set, file) => {
    // Optional discovery aliases must neither veto launch when dangling nor
    // expose home, account collections or the shared/private parent of skills.
    let root;
    try { root = codexCanonicalPath(file); } catch { return; }
    if (protectedSkillParents.some(target => target === root || target.startsWith(root === "/" ? "/" : `${root}/`))) return;
    set.add(root); return root;
  };
  for (const directory of workingDirectories) {
    const root = codexCanonicalPath(directory);
    const contains = target => target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
    if (contains(actualHome) || contains(codexCanonicalPath(prepared.accountRoot ?? prepared.codexHome))) {
      throw new Error("A Codex working directory would expose the whole home or account collection. Select a narrower directory.");
    }
    writes.add(root);
  }
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
    if (!fs.lstatSync(file).isSymbolicLink()) continue;
    if (fs.existsSync(file)) {
      if (name === "skills") addSkill(writes, file);
      else add(writes, file);
    }
    else if (platform === "darwin" && CODEX_SHARED_STATE_NAMES.includes(name)) {
      const shared = path.join(fs.realpathSync(prepared.sharedHome), name);
      // Seatbelt checks the shared link before native can observe an absent
      // optional destination. Retain that exact classified entry, not its
      // missing target or the shared home containing legacy credentials.
      if (path.resolve(path.dirname(file), fs.readlinkSync(file)) !== shared) continue;
      try {
        if (fs.lstatSync(shared).isSymbolicLink()) {
          try { fs.statSync(shared); }
          catch (error) { if (error.code !== "ENOENT") throw error; writes.add(shared); }
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
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
  // Installed skills are editable shared state. Native roots retain their
  // scope; directory aliases inherit it even before a SKILL.md is created.
  addSkill(writes, path.join(userHome, ".agents/skills"));
  const scannedSkillRoots = new Set();
  const addSkillLinks = (set, roots) => {
    for (const root of roots) {
      const canonical = addSkill(set, root);
      if (!canonical || scannedSkillRoots.has(canonical)) continue;
      scannedSkillRoots.add(canonical);
      // Pinned 0.166 discovery: ext/skills/src/loader/{mod,discovery}.rs
      // and exec-server/src/local_file_system.rs. Inventory only directory
      // links, with the same sorted breadth-first bounds; never parse SKILL.md.
      const queue = [[root, 0]], visited = new Set([canonical]);
      let entries = 0;
      scan: for (let cursor = 0; cursor < queue.length; cursor++) {
        const [directory, depth] = queue[cursor];
        let children;
        try { children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))); }
        catch { continue; }
        for (const child of children) {
          if (entries++ === 20_000) break scan;
          if (child.name.startsWith(".")) continue;
          // Root is depth zero: native reads skill files in directories at
          // depth six, but never follows another directory below that depth.
          if (depth >= 6) continue;
          const file = path.join(directory, child.name);
          let target;
          try {
            if (!fs.statSync(file).isDirectory()) continue;
            target = child.isSymbolicLink() ? addSkill(set, file) : codexCanonicalPath(file);
          } catch { continue; }
          if (!target || visited.has(target)) continue;
          visited.add(target);
          if (queue.length < 2_000) queue.push([file, depth + 1]);
        }
      }
    }
  };
  addSkillLinks(writes, [...skillRoots, ...(effectiveInputs.writable_skill_roots ?? [])]);
  // Project/admin discovery cannot turn a repository-authored link into
  // authority for a private target. Only installed User-scope roots above
  // extend access through links; other scopes retain their exact root grant.
  for (const file of effectiveInputs.skill_roots ?? []) addSkill(reads, file);
  // Native bundled-system discovery also ignores directory links.
  for (const file of effectiveInputs.system_skill_roots ?? []) addSkill(reads, file);
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
  for (const file of effectiveInputs.reads) {
    if (skillRoots.has(path.resolve(file))) addSkill(reads, file);
    else add(reads, file);
  }
  for (const file of managedFiles) add(reads, file);
  for (const file of effectiveInputs.writes) add(writes, file);
  for (const file of effectiveInputs.database_roots) add(databases, file);
  const selectedCA = env.CODEX_CA_CERTIFICATE || env.SSL_CERT_FILE;
  for (const file of [selectedCA, env.SSL_CERT_DIR, env.NODE_EXTRA_CA_CERTS]) if (file) add(reads, path.resolve(cwd, file));
  for (const socket of keyringSockets(env)) add(writes, socket);
  if (platform === "darwin") {
    const canonicalOr = file => { try { return codexCanonicalPath(file); } catch { return path.resolve(file); } };
    for (const file of codexPathReads({ pathValue: env.PATH, homes: [actualHome, canonicalOr(userHome)],
      privateRoots: [prepared.base, prepared.accountRoot, prepared.codexHome, prepared.sharedHome].filter(Boolean).map(canonicalOr) })) reads.add(file);
  }
  return { cwd, ...compactGrants(reads, writes), databases: [...databases], effectiveInputs };
}

export function codexPrivacyEnvironment({ env, prepared, artifact }) {
  const output = { ...env, CODEX_HOME: prepared.codexHome,
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
