import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readAimgrConfig } from "../config/aimgr-config.js";

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

function homePath(value, homeDir) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Codex working directories must be nonempty paths.");
  if (value === "~" || value === "$HOME") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  if (value.startsWith("$HOME/")) return path.join(homeDir, value.slice(6));
  return path.resolve(homeDir, value);
}

// Read XDG's two relevant path values as data; never source shell configuration.
function linuxFolders(homeDir, env) {
  const file = path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "user-dirs.dirs");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return {}; }
  const result = {};
  for (const name of ["DOWNLOAD", "PICTURES"]) {
    const match = text.match(new RegExp(`^XDG_${name}_DIR="((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m"));
    if (match) result[name] = homePath(match[1].replace(/\\([\\"$`])/g, "$1"), homeDir);
  }
  return result;
}

/** Broad user work areas, resolved once for the existing native launch policy. */
export function codexWorkingDirectories({ homeDir, env = {}, platform = process.platform,
  spawnSyncImpl = spawnSync, accountRoot, config = readAimgrConfig({ homeDir }).config } = {}) {
  const extra = config.codexWorkingDirectories ?? [];
  if (!Array.isArray(extra)) throw new Error("codexWorkingDirectories in AIM config must be a list of directories.");
  const roots = [path.join(homeDir, "workspace"), "/tmp"];
  if (platform === "darwin") {
    roots.push(path.join(homeDir, "Downloads"));
    const preferences = path.join(homeDir, "Library/Preferences/com.apple.screencapture.plist");
    let screenshot = path.join(homeDir, "Desktop");
    if (fs.existsSync(preferences)) {
      // Extract this one string: unrelated plist date/data values are not JSON.
      const read = spawnSyncImpl("/usr/bin/plutil", ["-extract", "location", "raw", "-o", "-", preferences],
        { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (read.status === 0 && read.stdout?.trim()) screenshot = homePath(read.stdout.trim(), homeDir);
    }
    // Screenshot thumbnails and most Mac tools use the OS user's temp folder.
    // TMPDIR already names our invocation scratch, so ask the OS directly.
    const temp = spawnSyncImpl("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"],
      { encoding: "utf8", timeout: 3000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
    if (temp.status === 0 && path.isAbsolute(temp.stdout?.trim() ?? "")) roots.push(temp.stdout.trim());
    roots.push(screenshot);
  } else {
    const folders = linuxFolders(homeDir, env);
    // XDG uses HOME itself to mean that a user directory is disabled.
    const downloads = folders.DOWNLOAD ?? path.join(homeDir, "Downloads");
    if (downloads !== homeDir) roots.push(downloads);
    const pictures = folders.PICTURES ?? path.join(homeDir, "Pictures");
    if (pictures !== homeDir) roots.push(path.join(pictures, "Screenshots"));
  }
  const protectedRoots = [homeDir, accountRoot].filter(Boolean).map(codexCanonicalPath);
  const defaults = roots.filter(directory => {
    try {
      const root = codexCanonicalPath(directory);
      return !protectedRoots.some(target => target === root || target.startsWith(root === "/" ? "/" : `${root}/`));
    } catch { return false; } // An unavailable optional folder never vetoes a launch.
  });
  // Explicit roots keep strict validation at the launch boundary.
  return [...defaults, ...extra.map(value => homePath(value, homeDir))];
}
