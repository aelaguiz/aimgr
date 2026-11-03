import fs from "node:fs";
import path from "node:path";
import { claudeNativeProjectRoot, claudeLocalSettingsRoot } from "./claude-session-headers.js";

const object = value => value && typeof value === "object" && !Array.isArray(value);

function readOptional(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return object(value) ? value : null;
  } catch { return null; } // Native MCP owns errors in optional server definitions.
}

// Optional settings sources can be rejected as a whole by native schema
// validation. Retain each bounded source-inclusion combination, including a
// rejected middle tier followed by an accepted higher tier. At most the fixed
// user/project/local/app-state/CLI sources participate; never enumerate values
// or filesystem directories. The fully merged variant matters when command
// placeholders come from different active tiers.
// This is an input inventory, not a replacement settings parser or a launch
// environment override. Never execute a helper to compute a candidate path.
export function claudeMcpEnvironmentVariants({ env, appState, configDir, cwd,
  projectConfigRoot, userHomeDir, enabled, composition }) {
  const variants = [{ ...env }];
  const apply = source => {
    if (!object(source)) return;
    const update = {};
    try {
      for (const [key, value] of Object.entries(source)) {
        if (key === "__proto__" || value === undefined) continue;
        const text = String(value);
        if (!text.includes("\0")) update[key] = text;
      }
    } catch { return; }
    variants.push(...variants.map(previous => ({ ...previous, ...update })));
  };
  apply(Object.fromEntries(Object.entries(appState?.env ?? {}).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))));
  const files = [];
  if (enabled.has("user")) files.push(path.join(configDir, "settings.json"));
  if (enabled.has("project")) files.push(path.join(projectConfigRoot ?? cwd, ".claude/settings.json"));
  if (enabled.has("local")) {
    const local = projectConfigRoot ?? claudeLocalSettingsRoot(cwd, userHomeDir);
    if (local !== cwd && !projectConfigRoot) files.push(path.join(cwd, ".claude/settings.local.json"));
    files.push(path.join(local, ".claude/settings.local.json"));
  }
  for (const file of files) apply(readOptional(file)?.env);
  apply(composition.settings.env);
  return variants;
}

/** The protected vendor must read an executable to spawn a configured stdio
 * MCP server. Tool children retain the user's accepted host access, but that
 * does not grant the parent permission to open Homebrew/private-bin commands.
 * Admit only the exact configured executable, never its bin/package directory
 * or every PATH entry. Do not execute commands to discover their identity.
 *
 * This inventory supplements the existing native policy; it does not rewrite
 * MCP configuration, choose servers, read tokens, or validate their protocol.
 * Missing/invalid optional servers remain native MCP errors. Ordinary accounts
 * do not call this function. Keep discovery aligned with the reviewed vendor
 * when upgrading it, including environment substitution and project scope.
 */
export function resolveClaudeMcpExecutableReads({ cwd, projectConfigRoot, appState = {},
  cliConfigs = [], strict = false, environments = [], aliases = [] }) {
  const commandCwd = projectConfigRoot ?? cwd;
  const sources = [];
  const key = path.normalize((claudeNativeProjectRoot(cwd) ?? path.resolve(cwd)).normalize("NFC"));
  const local = appState.projects?.[key];
  if (!strict) {
    sources.push(appState);
    // Native local MCP state uses the nearest Git/common-worktree root. The
    // project-config override affects MCP spawn cwd, not this state key.
    const projectSources = [];
    for (let directory = commandCwd; path.dirname(directory) !== directory; directory = path.dirname(directory)) {
      projectSources.unshift(readOptional(path.join(directory, ".mcp.json")));
    }
    sources.push(...projectSources, local);
  }
  for (const value of cliConfigs) {
    if (value.trim().startsWith("{")) {
      try { sources.push(JSON.parse(value)); } catch { /* Native reports it. */ }
    } else sources.push(readOptional(path.resolve(cwd, value)));
  }
  const files = new Set();
  const disabled = new Set(Array.isArray(local?.disabledMcpServers) ? local.disabledMcpServers : []);
  for (const source of sources) {
    if (!object(source?.mcpServers)) continue;
    // Native validates entries before merging names. Keep an inventory of
    // candidates rather than letting an invalid later definition hide a valid
    // earlier command. Native still decides which optional server is active.
    for (const [name, server] of Object.entries(source.mcpServers)) {
      if (disabled.has(name)) continue;
      if (!object(server) || (server.type !== undefined && server.type !== "stdio")
          || typeof server.command !== "string" || !server.command || server.command.includes("\0")) continue;
      for (const environment of environments) {
        // Configuration placeholders use the launch environment, not a shell.
        // An unset placeholder cannot manufacture a different executable path.
        const expand = text => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
          (match, key, fallback) => environment[key] === undefined ? fallback ?? match : String(environment[key]));
        const command = expand(server.command);
        if (!command || command.includes("\0")) continue;
        const searchPath = typeof server.env?.PATH === "string" ? expand(server.env.PATH) : String(environment.PATH ?? "/usr/bin:/bin");
        const candidates = command.includes("/") ? [path.resolve(commandCwd, command)]
          : searchPath.split(path.delimiter).map(directory => path.resolve(commandCwd, directory, command));
        for (const candidate of candidates) {
          try {
            if (!fs.statSync(candidate).isFile()) continue;
            fs.accessSync(candidate, fs.constants.X_OK);
            const canonical = fs.realpathSync(candidate);
            files.add(canonical);
            if (candidate !== canonical) aliases.push(...claudeExecutableAliasSpellings(candidate));
            // External venv entrypoints can name a symlinked interpreter in
            // their shebang. Seatbelt checks that spelling during spawn too.
            // Inspect only the configured file's bounded first line; never
            // run it, scan its package, or resolve an /usr/bin/env argument.
            const interpreter = shebangInterpreter(canonical);
            if (interpreter) aliases.push(...claudeExecutableAliasSpellings(interpreter));
            break;
          } catch { /* Leave missing/unusable commands to native MCP. */ }
        }
      }
    }
  }
  return [...files];
}

function shebangInterpreter(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, size).toString("utf8").split("\n", 1)[0];
    const interpreter = /^#![ \t]*(\/[^\s\0]+)/.exec(line)?.[1];
    if (!interpreter || !fs.statSync(interpreter).isFile()) return null;
    fs.accessSync(interpreter, fs.constants.X_OK);
    return interpreter;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** macOS checks each symlink spelling while spawning a configured tool. The
 * canonical data grant alone is insufficient. Preserve each rewritten FULL
 * command path, including an intermediate physical prefix after a directory
 * symlink. Every returned spelling still resolves to the same regular file;
 * the native helper grants metadata to it and its traversal components only.
 * Never turn these into bin-directory data grants or rewrite the user's argv.
 */
export function claudeExecutableAliasSpellings(file) {
  let current = path.resolve(file);
  const target = fs.realpathSync(current), seen = new Set(), result = [];
  for (let links = 0; current !== target; links++) {
    if (links >= 40 || seen.has(current)) throw new Error("MCP executable symlink cycle");
    seen.add(current); result.push(current);
    const parts = current.split(path.sep).filter(Boolean);
    let prefix = path.parse(current).root, rewritten = false;
    for (let index = 0; index < parts.length; index++) {
      prefix = path.join(prefix, parts[index]);
      if (!fs.lstatSync(prefix).isSymbolicLink()) continue;
      current = path.resolve(path.dirname(prefix), fs.readlinkSync(prefix), ...parts.slice(index + 1));
      rewritten = true; break;
    }
    if (!rewritten || fs.realpathSync(current) !== target) throw new Error("MCP executable changed during inspection");
  }
  return result;
}
