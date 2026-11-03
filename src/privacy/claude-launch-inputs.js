import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ClaudePrivacySettingsError, claudeCriticalSettings, inspectClaudeArguments } from "./claude-settings.js";
import { resolveClaudeInstructionReads } from "./claude-instruction-inputs.js";
import { resolveClaudeTlsReadPaths } from "./claude-tls-inputs.js";
import { resolveClaudeMcpExecutableReads, claudeMcpEnvironmentVariants } from "./claude-mcp-inputs.js";

const fail = reason => { throw new ClaudePrivacySettingsError(reason); };
const inside = (file, root) => file === root || file.startsWith(root + path.sep);

/** The pinned native build keeps background control/PTY sockets outside its
 * config directory. Its namespace is SHA256(resolve(NFC(config)))[0..8], not
 * an installation identifier. Precreate the exact owned 0700 child so native
 * mkdir/chmod needs no write grant to the shared cc-daemon-UID subtree.
 *
 * Do not broaden this to the parent: native's same-UID control protocol does
 * not authenticate every operation. Other account namespaces stay outside
 * this account's file grants. Never repair an unsafe pre-existing directory
 * silently; refuse before executing Claude instead. Keep this derivation in
 * the version-upgrade review (T05/T14/T18).
 */
export function prepareClaudeDaemonDirectory({ configDir, env,
  temporaryBase = env.TERMUX_VERSION && env.PREFIX ? path.join(env.PREFIX, "tmp") : "/tmp",
} = {}) {
  const uid = process.getuid();
  const digest = crypto.createHash("sha256").update(path.resolve(configDir.normalize("NFC"))).digest("hex").slice(0, 8);
  const parent = path.join(fs.realpathSync(temporaryBase), `cc-daemon-${uid}`);
  const child = path.join(parent, digest);
  for (const directory of [parent, child]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") fail("Claude's private background socket directory could not be created"); }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
      fail("Claude's background socket directory must be an owned, non-symlink directory with mode 0700");
    }
  }
  return fs.realpathSync(child);
}

/** Read private native state without following a substituted leaf or exposing
 * parse excerpts. Call only while the existing account-state guard is held.
 * Keep the full object local: MCP credentials share this native document and
 * must not be reduced to the Anthropic projection merely to inspect it.
 */
export function readClaudeLaunchState(file, { optional = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) fail("the native launch state is unsafe");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("the native launch state is malformed");
    return value;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    if (error instanceof ClaudePrivacySettingsError) throw error;
    fail("the native launch state could not be inspected");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Private transfer across route/SUID/no-sandbox boundaries. Neither values
 * nor a reusable named credential file appear in argv. The final native entry
 * requires this owned, unlinked regular file, restores it after policy entry,
 * and closes it before vendor execution. T07 covers the complete helper chain.
 */
export function stageClaudeLaunchEnvironment(env, directory) {
  let fd, name, created = false;
  try {
    if (!env || typeof env !== "object" || !path.isAbsolute(directory ?? "")) fail("the launch environment is invalid");
    const entries = [];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) fail("the launch environment is invalid");
      entries.push(`${key}=${value}\0`);
    }
    const bytes = Buffer.from(entries.join(""));
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail("the launch environment exceeds the native transfer bound");
    name = path.join(directory, `.environment-${process.pid}-${crypto.randomUUID()}`);
    fd = fs.openSync(name, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fs.unlinkSync(name); name = undefined;
    fs.writeFileSync(fd, bytes);
    const result = fd; fd = undefined; return result;
  } catch (error) {
    if (error instanceof ClaudePrivacySettingsError) throw error;
    fail("the private environment could not be transferred");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (name && created) { try { fs.unlinkSync(name); } catch {} }
  }
}

/** Common opt-outs are scoped separately from protected-account opt-outs.
 * Preserve tool/build/MCP variables and terminal capabilities. This is not a
 * blanket environment wipe, and never runs on native self-spawned children.
 * Root auth/provider selection is cleaned separately before this function.
 */
export function buildClaudePrivacyEnvironment({ env, protectedAccount, artifactSet, emptyProfiles, scratch }) {
  if (!env || !path.isAbsolute(emptyProfiles ?? "") || !path.isAbsolute(scratch ?? "")
    || !/^[a-f0-9]{64}$/.test(artifactSet ?? "")) fail("the privacy environment inputs are invalid");
  const result = { ...env, ...claudeCriticalSettings({ protectedAccount }).env,
    ANTHROPIC_CONFIG_DIR: emptyProfiles, AIMGR_CLAUDE_ARTIFACT_SET: artifactSet,
    CLAUDE_CODE_TMPDIR: scratch };
  // These are loader code-injection controls, not ordinary build credentials.
  // Linux secure exec would scrub them; restoring them from the private FD
  // afterward must not reinstate caller-selected code in the vendor process.
  for (const key of Object.keys(result)) {
    if (key.startsWith("DYLD_") || ["LD_PRELOAD", "LD_AUDIT"].includes(key)) delete result[key];
  }
  return result;
}

/** Resolve only required task state, never a whole home ancestor. The native
 * policy grants traversal separately, so a symlinked skill can expose its
 * package directory without exposing every file beside it. Tool processes
 * retain their normal host view; these grants govern the vendor image.
 */
export function resolveClaudeTaskReadRoots({ cwd, userHomeDir, configDir, appState = {},
  additionalDirectories = [], userPluginDirs = [], taskFiles = [], sharedMemoryDirectory, projectConfigRoot } = {}) {
  const home = fs.realpathSync(userHomeDir), config = fs.realpathSync(configDir);
  const roots = new Set(), gitBoundaries = new Set(), packageDirectories = [];
  const add = (file, optional = false) => {
    if (!path.isAbsolute(file ?? "")) fail("a task read root is not absolute");
    let resolved;
    try { resolved = fs.realpathSync(file); }
    catch (error) { if (optional && error.code === "ENOENT") return; fail("a required task read root is unavailable"); }
    if (inside(home, resolved) || (inside(config, resolved) && resolved !== config)) fail("a task grant would expose an entire home or account collection");
    roots.add(resolved);
  };
  const addPackage = (directory, kind) => {
    try { if (!fs.statSync(directory).isDirectory()) return; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
    add(directory, true);
    packageDirectories.push({ directory, kind });
  };
  // Starting a shell in HOME does not mean granting all home data. Native
  // traversal/listing remains available through the private config ancestors.
  if (fs.realpathSync(cwd) !== home) add(cwd);
  for (const file of [...additionalDirectories, ...userPluginDirs, ...taskFiles]) add(path.resolve(cwd, file));
  for (const [file, state] of Object.entries(appState.projects ?? {})) {
    if (state?.hasTrustDialogAccepted === true && path.isAbsolute(file) && file !== home) add(file, true);
  }
  const managedRoot = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
  const instructions = [path.join(config, "CLAUDE.md"), path.join(managedRoot, "CLAUDE.md")];
  const rules = [path.join(config, "rules"), path.join(managedRoot, ".claude/rules")];
  for (const directory of additionalDirectories) {
    for (const file of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) instructions.push(path.resolve(cwd, directory, file));
    rules.push(path.resolve(cwd, directory, ".claude/rules"));
  }
  // Account personal sources live under CLAUDE_CONFIG_DIR. Original-home
  // skills are linked by AIM preflight; home instructions can still be normal
  // project ancestors, but are not an invented second personal settings tier.
  for (const name of ["skills", "commands", "agents"]) addPackage(path.join(config, name), name);
  for (const directory of [managedRoot, ...additionalDirectories.map(file => path.resolve(cwd, file))]) {
    for (const kind of ["skills", "commands", "agents"]) addPackage(path.join(directory, ".claude", kind), kind);
  }
  // Native walks instruction sources above cwd as well as within it. A
  // traversal-only ancestor grant cannot read these files. Admit these exact
  // task sources, including symlink targets, without granting the directory.
  for (let ancestor = fs.realpathSync(cwd); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    for (const relative of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules"]) {
      add(path.join(ancestor, relative), true);
    }
    instructions.push(...["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"].map(file => path.join(ancestor, file)));
    rules.push(path.join(ancestor, ".claude/rules"));
  }
  // MCP walks ancestors of the explicit project-config-root (or cwd). Native
  // package discovery has a DIFFERENT stop rule: before home, at the nearest
  // Git worktree. Keep these separate from instruction discovery (T14/T15).
  const packageCwd = projectConfigRoot ?? cwd;
  let packages = true;
  for (let ancestor = fs.realpathSync(packageCwd); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    add(path.join(ancestor, ".mcp.json"), true);
    if (ancestor === home) packages = false;
    if (packages) for (const kind of ["skills", "commands", "agents"]) addPackage(path.join(ancestor, ".claude", kind), kind);
    if (fs.existsSync(path.join(ancestor, ".git"))) {
      if (packages) gitBoundaries.add(ancestor);
      packages = false;
    }
  }
  if (sharedMemoryDirectory) {
    if (fs.realpathSync(sharedMemoryDirectory) === path.join(home, ".claude")) fail("the shared memory grant would expose the entire personal Claude home");
    add(sharedMemoryDirectory, true);
  }
  // Linked Git worktrees keep administrative state outside cwd. Read only
  // their exact git/common directories, never the containing workspace.
  for (const root of new Set([...roots, ...gitBoundaries])) {
    let stat; try { stat = fs.statSync(root); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const dotgit = path.join(root, ".git");
    let raw;
    try {
      const entry = fs.statSync(dotgit);
      if (!entry.isFile() || entry.size > 4096) continue;
      raw = fs.readFileSync(dotgit, "utf8");
    } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const match = /^gitdir: (.+)\r?\n?$/.exec(raw);
    if (!match) fail("a linked worktree has an invalid Git directory");
    const gitdir = fs.realpathSync(path.resolve(root, match[1])); add(gitdir);
    try {
      const common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
      if (!common || common.includes("\n")) fail("a linked worktree has an invalid common Git directory");
      const commonDirectory = path.resolve(gitdir, common);
      add(commonDirectory);
      // Standard linked worktrees inherit main-repository packages only when
      // the corresponding worktree package directory is absent. Instructions
      // do not have this fallback. Do not grant the main repository itself.
      let mainRepository;
      try {
        const backpointer = fs.readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
        if (path.dirname(gitdir) === path.join(commonDirectory, "worktrees")
          && fs.realpathSync(path.resolve(gitdir, backpointer)) === fs.realpathSync(dotgit)
          && path.basename(commonDirectory) === ".git") mainRepository = path.dirname(commonDirectory);
      } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
      if (!projectConfigRoot && mainRepository) {
        for (const kind of ["skills", "commands", "agents"]) {
          if (!fs.existsSync(path.join(root, ".claude", kind))) addPackage(path.join(mainRepository, ".claude", kind), kind);
        }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Native package roots may contain symlinked skills, commands or agents.
  // Follow only those package trees, never a recursive home/project search.
  // Skill dependencies execute as ordinary tools; vendor discovery needs the
  // package and SKILL.md target, not every symlink in node_modules (T14).
  const visitedPackages = new Set();
  const scanPackage = ({ directory, kind }) => {
    let resolved, entries;
    try {
      resolved = fs.realpathSync(directory);
      const key = (kind === "skills" ? "skills:" : "markdown:") + resolved;
      if (visitedPackages.has(key)) return;
      visitedPackages.add(key);
      if (visitedPackages.size > 4096) fail("the required package inventory exceeds native policy capacity");
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
    for (const entry of entries) {
      const file = path.join(resolved, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = fs.statSync(file).isDirectory(); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (isDirectory || (kind === "skills" ? entry.name === "SKILL.md" : entry.name.endsWith(".md"))) add(file);
      }
      if (kind === "skills") {
        if (isDirectory) add(path.join(file, "SKILL.md"), true);
      }
      else if (isDirectory) scanPackage({ directory: file, kind });
    }
  };
  for (const entry of packageDirectories) scanPackage(entry);
  for (const file of resolveClaudeInstructionReads({ files: instructions, ruleDirectories: rules, userHomeDir: home })) add(file);
  // A skill/rules/project subtree already covers its ordinary children. Count
  // actual policy grants, not files discovered while following instruction
  // imports. External canonical symlink/import targets remain independent.
  const minimal = [...roots].sort((left, right) => left.length - right.length)
    .filter((file, index, all) => !all.slice(0, index).some(parent => inside(file, parent)));
  if (minimal.length > 256) fail("the required task roots exceed the native policy capacity");
  return Object.freeze(minimal);
}

/** Resolve a not-yet-created native update location without creating it. The
 * final entry independently requires a canonical existing ancestor. Existing
 * symlinks are followed now; dangling links and unknown inspection failures
 * refuse, rather than treating an alternate executable root as absent.
 */
function futurePath(file) {
  let current = path.resolve(file); const missing = [];
  for (;;) {
    try { fs.lstatSync(current); return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") fail("a native update location could not be resolved");
      try { if (fs.lstatSync(current).isSymbolicLink()) fail("a native update location is a dangling link"); }
      catch (entryError) { if (entryError.code !== "ENOENT") throw entryError; }
      if (path.dirname(current) === current) fail("a native update location has no existing ancestor");
      missing.push(path.basename(current)); current = path.dirname(current);
    }
  }
}

/** Exact standalone 2.1.316 automatic updater/housekeeping/fallback roots.
 * Fixed immutable process.execPath self-spawns itself. It cannot dispatch npm
 * updater code in the retained session path; explicit install/update commands
 * are refused separately. Never deny all node_modules or package-manager bins:
 * MCP packages and independent build tooling must remain available (T03/T14).
 */
export function resolveClaudeUpdateRoots({ userHomeDir, env, cwd, vendorCommand }) {
  const home = fs.realpathSync(userHomeDir);
  const base = (key, fallback) => path.resolve(cwd, env[key] || path.join(home, fallback));
  const files = [path.join(base("XDG_DATA_HOME", ".local/share"), "claude/versions"),
    path.join(base("XDG_CACHE_HOME", ".cache"), "claude/staging"),
    path.join(base("XDG_STATE_HOME", ".local/state"), "claude/locks"),
    path.join(home, ".local/bin/claude")];
  return Object.freeze([...new Set(files.map(futurePath))].filter(file => file !== vendorCommand));
}


/** Extract file inputs from the same pinned argv grammar used by composition.
 * Do not grep argv for flags: a prompt value can literally be "--add-dir".
 * These are explicit task inputs, not automatic whole-home visibility.
 */
export function resolveClaudeConfiguredInputs({ args, cwd, configDir, userHomeDir, composition,
  env = {}, appState = {}, discoverReadRoots = true }) {
  const parsed = inspectClaudeArguments(args), values = parsed.optionValues;
  const taskCwd = path.resolve(cwd, values["--cwd"]?.at(-1) ?? ".");
  const expand = (value, origin = taskCwd) => value.startsWith("~/")
    ? path.join(userHomeDir, value.slice(2)) : path.resolve(origin, value);
  const additionalDirectories = (values["--add-dir"] ?? []).map(value => expand(value));
  const userPluginDirs = [...(values["--plugin-dir"] ?? []), ...(values["--plugin-dir-no-mcp"] ?? [])].map(value => expand(value));
  const taskFiles = [];
  for (const flag of ["--mcp-config", "--system-prompt-file", "--append-system-prompt-file",
    "--append-subagent-system-prompt-file", "--system-prompt-snapshot"]) {
    for (const value of values[flag] ?? []) {
      if (flag === "--mcp-config" && value.trim().startsWith("{")) continue;
      taskFiles.push(expand(value));
    }
  }
  for (const value of values["--resume"] ?? []) {
    const file = expand(value);
    if (fs.existsSync(file)) taskFiles.push(file);
  }
  const enabled = new Set((values["--setting-sources"]?.at(-1) ?? "user,project,local").split(","));
  const sources = [];
  if (enabled.has("user")) sources.push(path.join(configDir, "settings.json"));
  const projectRoot = values["--project-config-root"]?.at(-1);
  for (let directory = expand(projectRoot ?? "."); ; directory = path.dirname(directory)) {
    if (enabled.has("project")) sources.push(path.join(directory, ".claude/settings.json"));
    if (enabled.has("local")) sources.push(path.join(directory, ".claude/settings.local.json"));
    if (projectRoot || path.dirname(directory) === directory) break;
  }
  const settings = [];
  for (const file of sources) {
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(file, "utf8"); taskFiles.push(file);
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; fail("a configured task settings source could not be inspected"); }
    // Native reports/ignores malformed lower tiers. Do not turn extraction of
    // optional path fields into a stricter copy of its complete native schema.
    try { const value = JSON.parse(text.replace(/^\uFEFF/, "")); if (value && typeof value === "object" && !Array.isArray(value)) settings.push(value); }
    catch { continue; }
  }
  settings.push(composition.settings);
  for (const source of settings) {
    // Authentication belongs to the initial-header resolver, which follows
    // native source selection/schema acceptance. This read-grant inventory is
    // deliberately a superset; an unused ancestor must not refuse a launch.
    // Ordinary accounts need no private file grants (T01).
    if (!discoverReadRoots) continue;
    for (const value of (Array.isArray(source.permissions?.additionalDirectories) ? source.permissions.additionalDirectories : [])) {
      if (typeof value === "string") additionalDirectories.push(expand(value));
    }
    if (typeof source.autoMemoryDirectory === "string" && source.autoMemoryDirectory) {
      const memory = expand(source.autoMemoryDirectory);
      fs.mkdirSync(memory, { recursive: true, mode: 0o700 }); additionalDirectories.push(memory);
    }
  }
  if (!discoverReadRoots) return { cwd: taskCwd, additionalDirectories: [], userPluginDirs: [], taskFiles: [] };
  const executableAliases = [];
  taskFiles.push(...resolveClaudeMcpExecutableReads({ cwd: taskCwd, aliases: executableAliases,
    projectConfigRoot: projectRoot ? expand(projectRoot) : undefined, appState,
    cliConfigs: values["--mcp-config"] ?? [], strict: parsed.options.includes("--strict-mcp-config"),
    environments: claudeMcpEnvironmentVariants({ env, appState, configDir, cwd: taskCwd,
      projectConfigRoot: projectRoot ? expand(projectRoot) : undefined, userHomeDir, enabled, composition }) }));
  // Native TLS reads these explicit files itself, including during refresh.
  // Grant the selected files, never their home/credential-directory parents.
  // Lower settings may reload during a session: retain their initially known
  // paths as well as inherited/flag paths. Replacement at those paths works.
  taskFiles.push(...resolveClaudeTlsReadPaths({ environments: [env, ...settings.map(source => source.env ?? {})], cwd: taskCwd, userHomeDir }));
  return { cwd: taskCwd, additionalDirectories, userPluginDirs, taskFiles, executableAliases: [...new Set(executableAliases)],
    ...(projectRoot ? { projectConfigRoot: expand(projectRoot) } : {}) };
}
