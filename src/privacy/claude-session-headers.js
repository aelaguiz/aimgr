import fs from "node:fs";
import path from "node:path";
import { ClaudePrivacySettingsError, inspectClaudeArguments } from "./claude-settings.js";
import { CLAUDE_SOURCE_MARKER } from "./claude-settings-validator.js";
import { stageClaudeSettingsSnapshot } from "./claude-settings-handoff.js";
import { validateClaudeSettingsSnapshot } from "./claude-settings-validation-runner.js";

const KEY = "ANTHROPIC_CUSTOM_HEADERS";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = reason => { throw new ClaudePrivacySettingsError(reason); };
const has = source => object(source?.env) && Object.hasOwn(source.env, KEY);
const enabledValue = value => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
function checked(value) {
  let headers;
  try { headers = String(value); } catch { fail("the initial custom headers cannot be read safely"); }
  if (headers.includes("\0")) fail("the initial custom headers contain an invalid environment value");
  if (headers.split("\n").some(line => /^(authorization|x-api-key)\s*:/i.test(line.trimStart()))) {
    fail("Claude settings select header-based authentication instead of the selected individual OAuth account");
  }
  return headers;
}

/** Source acceptance is native, not a copied settings schema. Only env-bearing
 * candidates need this extra isolated check. Normal JSON env values undergo
 * String coercion in the pinned native schema; an object with a non-callable
 * toString can reject the WHOLE document, so test every original value first.
 * Replace only schema-equivalent env with nonsecret controls. Keep all other
 * fields, including malformed ones, to preserve source rejection. A string
 * apiKeyHelper can be blanked without changing its schema validity; this check
 * must never execute a configured credential helper.
 *
 * The deliberate BASH_MAX_OUTPUT_LENGTH marker distinguishes a loaded source
 * from a discarded one. Native doctor prints the same "Invalid settings"
 * heading for nonfatal warnings, so that heading is not an acceptance oracle.
 */
export async function nativeClaudeHeaderSourceAccepted(settings, validation) {
  if (!object(settings.env)) return false;
  try { for (const [key, value] of Object.entries(settings.env)) if (key !== "__proto__") String(value); }
  catch { return false; }
  const sanitized = { ...settings,
    ...(typeof settings.apiKeyHelper === "string" ? { apiKeyHelper: "" } : {}),
    // Numeric zero is an invalid positive output limit. Its serialized map
    // is smaller than even {ANTHROPIC_CUSTOM_HEADERS:0}, so this check cannot
    // push a native-valid near-2-MiB lower source over the native file bound.
    // The isolated entry already supplies every opt-out in the launch env.
    env: { BASH_MAX_OUTPUT_LENGTH: Number(CLAUDE_SOURCE_MARKER) } };
  const snapshot = stageClaudeSettingsSnapshot({ settings: sanitized, serialized: JSON.stringify(sanitized),
    source: { kind: "default", directory: path.join(validation.scratchParent, "header-schema") } });
  try {
    // No managed source gets to provide/overwrite the marker. This is a
    // separate schema check, never a substitute for final managed validation.
    const result = await validateClaudeSettingsSnapshot({ ...validation, managedPolicy: undefined,
      snapshot, sourceAcceptance: true });
    return result.sourceAccepted;
  } finally { snapshot.dispose(); }
}

function optional(file, method = "statSync") {
  try { return fs[method](file); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}
const localPath = value => value && !value.includes("\0") && !value.startsWith("//") && !value.startsWith("\\\\");
function gitMarker(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() || stat.isDirectory()) return true;
    if (stat.isSymbolicLink()) {
      const bytes = fs.readlinkSync(file, { encoding: "buffer" });
      const target = bytes.toString("utf8");
      if (!localPath(target) || !Buffer.from(target, "utf8").equals(bytes)) return false;
      const resolved = fs.statSync(file);
      return resolved.isFile() || resolved.isDirectory();
    }
  } catch { /* Native failed filesystem probes are not Git boundaries. */ }
  return false;
}
function safeGitText(file) {
  const stat = fs.lstatSync(file);
  // Native reads only local regular administrative files at these steps.
  if (!stat.isFile()) throw new Error("not a local Git file");
  const text = fs.readFileSync(file, "utf8").trim();
  if (!localPath(text)) throw new Error("not a local Git path");
  return text;
}

// Reviewed native local-settings root: nearest filesystem .git, canonical main
// repository for a linked worktree, followed by ownership/home checks. Git env
// overrides and `git rev-parse` are not this client's selector. Failed linked
// worktree checks fall back to its own root, not to a different ancestor.
export function claudeNativeProjectRoot(cwd) {
  let root;
  for (let current = cwd; ; current = path.dirname(current)) {
    if (gitMarker(path.join(current, ".git"))) { root = current; break; }
    if (path.dirname(current) === current) break;
  }
  if (!root) return undefined;
  const dotgit = path.join(root, ".git");
  try {
    const raw = fs.readFileSync(dotgit, "utf8").trim();
    const suffix = raw.startsWith("gitdir:") ? raw.slice(7).trim() : "";
    if (localPath(suffix)) {
      const directory = path.resolve(root, suffix);
      const common = path.resolve(directory, safeGitText(path.join(directory, "commondir")));
      const pointer = path.resolve(directory, safeGitText(path.join(directory, "gitdir")));
      if (path.dirname(directory) === path.join(common, "worktrees")
        && fs.realpathSync(pointer) === path.join(fs.realpathSync(root), ".git")) {
        if (path.basename(common) === ".git") root = path.dirname(common);
        else if (!gitMarker(path.join(common, ".git"))) root = common;
      }
    }
  } catch { /* Native uses the original worktree root on any invalid link. */ }
  return root;
}

export function claudeLocalSettingsRoot(cwd, home) {
  const project = claudeNativeProjectRoot(cwd);
  if (!project) return cwd;
  const root = fs.realpathSync(project).normalize("NFC");
  if (root === cwd) return root;
  if (root === fs.realpathSync(home).normalize("NFC")) return cwd;
  try {
    for (const [file, method] of [[root, "statSync"], [path.join(root, ".git"), "lstatSync"], [path.join(root, ".claude"), "lstatSync"]]) {
      const item = optional(file, method);
      if ((!item && file !== path.join(root, ".claude")) || (item && item.uid !== process.geteuid())) return cwd;
    }
  } catch { return cwd; }
  return root;
}

/** Reuse the pinned disk-tier selector for headers and explicit file grants.
 * This returns native source files; it does not rewrite settings or decide
 * their schema validity, permission mode or project trust. */
export function claudeNativeSettingsFiles({ parsed, cwd, configDir, userHomeDir, env = {},
  stdoutIsTTY = Boolean(process.stdout.isTTY) }) {
  const values = parsed.optionValues;
  const directory = fs.realpathSync(path.resolve(cwd, values["--cwd"]?.at(-1) ?? "."));
  const projectOption = values["--project-config-root"]?.at(-1);
  const project = projectOption === undefined ? directory : path.resolve(directory, projectOption);
  // Native restricted mode removes the three disk settings tiers, even when
  // --setting-sources names them. Its eager flag reader does not expand short
  // clusters and ignores a flag consumed as another option's value.
  const restricted = parsed.eagerRestricted || enabledValue(env.CLAUDE_CODE_RESTRICTED);
  const enabled = new Set(restricted ? [] : (values["--setting-sources"]?.at(-1) ?? "user,project,local")
    .split(",").map(value => value.trim()));
  const sources = [];
  if (enabled.has("user")) sources.push(path.join(configDir,
    enabledValue(env.CLAUDE_CODE_USE_COWORK_PLUGINS) ? "cowork_settings.json" : "settings.json"));
  const noninteractive = parsed.eagerPrint || parsed.options.includes("--init-only")
    || parsed.options.includes("--sdk-url") || !stdoutIsTTY;
  const served = parsed.options.includes("--attach-serve") || (!parsed.eagerPrint && noninteractive
    && parsed.options.some(flag => ["--cloud", "--remote"].includes(flag)));
  const ignoreRepo = served || (noninteractive && enabledValue(env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST));
  if (!ignoreRepo && enabled.has("project")) sources.push(path.join(project, ".claude/settings.json"));
  if (!ignoreRepo && enabled.has("local")) {
    const local = projectOption === undefined ? claudeLocalSettingsRoot(directory, userHomeDir ?? env.HOME) : project;
    if (projectOption === undefined && local !== directory) sources.push(path.join(directory, ".claude/settings.local.json"));
    sources.push(path.join(local, ".claude/settings.local.json"));
  }
  return sources;
}

/** Pin the initially effective complete string below immutable machine policy.
 * Later tiers replace, never concatenate, header strings. Empty wins. Only the
 * exact uppercase key matters in ordinary POSIX settings. App-state env uses
 * a primitive-only filter; ordinary settings instead use String coercion.
 *
 * User accepted new-session changes for this key only. Normal settings remain
 * in their original live files. The pin also travels in native child settings
 * snapshots, preserving the account selected by the admitted root launch.
 */
export async function resolveClaudeSessionHeaders({ args, cwd, configDir, userHomeDir,
  composition, env, appState, sourceAccepted, stdoutIsTTY = Boolean(process.stdout.isTTY) }) {
  if (has(composition.settings) && !String(composition.settings.env[KEY]).includes("\0")) {
    return checked(composition.settings.env[KEY]);
  }
  const sources = claudeNativeSettingsFiles({ parsed: inspectClaudeArguments(args), cwd, configDir,
    userHomeDir, env, stdoutIsTTY });
  for (const file of sources.reverse()) {
    const stat = optional(file);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
    let source;
    try { source = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (has(source) && await sourceAccepted(source)) {
      const value = String(source.env[KEY]);
      // Native applies a per-key NUL filter after schema coercion. Promoting
      // a dropped NUL value would make the immutable pin ineffective too.
      if (!value.includes("\0")) return checked(value);
    }
  }
  const legacy = appState?.env?.[KEY];
  if (["string", "number", "boolean"].includes(typeof legacy) && !String(legacy).includes("\0")) return checked(legacy);
  return checked(env[KEY] ?? "");
}

export function pinClaudeSessionHeaders(composition, headers) {
  composition.settings.env[KEY] = checked(headers);
  composition.serialized = JSON.stringify(composition.settings);
  if (Buffer.byteLength(composition.serialized) > 2 * 1024 * 1024) {
    fail("the settings plus required privacy controls exceed Claude's 2 MiB settings-file limit");
  }
}
