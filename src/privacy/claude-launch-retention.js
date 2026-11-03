import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudePrivacySettingsError } from "./claude-settings.js";

const fail = () => { throw new ClaudePrivacySettingsError("previous Claude launch files could not be retired safely"); };
const directoryFor = config => path.join(path.dirname(config), ".privacy-launches");
const uuid = "[a-f0-9-]{36}";
const receiptName = new RegExp(`^${uuid}\\.json$`);
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) || fs.realpathSync(directory) !== directory) fail();
}
function identity(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail();
  return { path: file, dev: stat.dev, ino: stat.ino };
}

/** Settings snapshots must outlive the foreground process: native background
 * children can read the original argv later. Record only AIM-created paths,
 * outside the vendor-readable config. A stopped-owner transition under the
 * existing exclusive account lock is the only reclamation point (T16/T18).
 * Saved job references are retained even after their processes stop. No timer,
 * foreground-exit callback or process-count guess deletes them.
 */
export function retainClaudeLaunchFiles({ configDir, settings, scratch }) {
  const directory = directoryFor(configDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); privateDirectory(directory);
  const value = { schema: 1, settings: identity(settings), scratch: identity(scratch, true) };
  const file = path.join(directory, crypto.randomUUID() + ".json");
  const temp = file + ".pending";
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parentFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  return { cancelBeforeStart() { fs.unlinkSync(file); } };
}

export function hasRetainedClaudeLaunchFiles(configDir) {
  const directory = directoryFor(configDir);
  try { privateDirectory(directory); return fs.readdirSync(directory).some(name => receiptName.test(name)); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** Stopped jobs can wake later using their saved --settings. The audited
 * legacy ledger lives under config/jobs/<id>/state.json. Retain references in
 * every state, including done/stopped/failed. A newer v5 reference or unknown
 * ledger cannot be interpreted as no references: retain all until its existing
 * native record is removed. This costs disk, never removes a saved workflow.
 */
function savedSettingsReferences(configDir) {
  const jobs = path.join(configDir, "jobs"), references = new Set();
  // A stopped native daemon may still have a saved roster or queued dispatch.
  // Their format is not yet part of this small GC reader: preserve all launch
  // files whenever any such record exists, including unreadable directories.
  try { if (fs.readdirSync(path.join(configDir, "daemon")).length) return null; }
  catch (error) { if (error.code !== "ENOENT") return null; }
  let entries;
  try {
    if (!fs.lstatSync(jobs).isDirectory() || fs.realpathSync(jobs) !== jobs) return null;
    entries = fs.readdirSync(jobs, { withFileTypes: true });
  } catch (error) { return error.code === "ENOENT" ? references : null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) return null;
    let state;
    try {
      const file = path.join(jobs, entry.name, "state.json"); identity(file);
      if (fs.statSync(file).size > 2 * 1024 * 1024) return null;
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { return null; }
    if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.respawnFlags) || state.respawnFlags.some(arg => typeof arg !== "string")) return null;
    const arrays = [state.respawnFlags, state.dispatch?.respawnFlags,
      state.dispatch?.launch?.args, state.dispatch?.launch?.flagArgs].filter(value => value !== undefined);
    for (const flags of arrays) {
      if (!Array.isArray(flags) || flags.some(arg => typeof arg !== "string")) return null;
      for (const arg of flags) {
        const value = arg.startsWith("--settings=") ? arg.slice(11) : arg;
        references.add(value);
        if (path.isAbsolute(value)) { try { references.add(fs.realpathSync(value)); } catch { /* Keep the lexical reference too. */ } }
      }
    }
  }
  return references;
}

/** Caller has already verified no live native owners, including background
 * descendants, while holding EX. Compare recorded inode identities before
 * deleting; preserve substituted files rather than deleting user data.
 * Device numbers can change after reboot. An identity mismatch preserves the
 * whole launch and its receipt; optional cleanup must not block a new session.
 * A crash after any deletion is retryable because absent owned paths are done.
 */
export function retireClaudeLaunchFiles({ configDir, guard }) {
  if (guard?.exclusive !== true) fail();
  guard.assertOwned();
  const directory = directoryFor(configDir); privateDirectory(directory);
  const references = savedSettingsReferences(configDir);
  if (references === null) return;
  launches: for (const name of fs.readdirSync(directory)) {
    if (!receiptName.test(name)) continue;
    const file = path.join(directory, name); identity(file);
    if (fs.statSync(file).size > 16384) fail();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.schema !== 1 || !value.settings || !value.scratch
      || !path.isAbsolute(value.settings.path ?? "")
      || !new RegExp(`^\\.aim-claude-settings-${uuid}\\.json$`).test(path.basename(value.settings.path))
      || path.dirname(value.scratch.path ?? "") !== configDir
      || !/^\.aim-private-runtime-[A-Za-z0-9]+$/.test(path.basename(value.scratch.path))) fail();
    let canonicalSettings;
    try { canonicalSettings = fs.realpathSync(value.settings.path); } catch { /* Prior interrupted deletion is handled below. */ }
    if (references.has(value.settings.path) || references.has(canonicalSettings)) continue;
    const owned = [];
    for (const [key, isDirectory] of [["settings", false], ["scratch", true]]) {
      guard.assertOwned(); const entry = value[key];
      if (!Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) fail();
      let actual;
      try { actual = identity(entry.path, isDirectory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (actual.dev !== entry.dev || actual.ino !== entry.ino) continue launches;
      owned.push({ path: entry.path, isDirectory });
    }
    // Verify both paths before deleting either half of the launch.
    for (const entry of owned) {
      guard.assertOwned();
      if (entry.isDirectory) fs.rmSync(entry.path, { recursive: true });
      else fs.unlinkSync(entry.path);
    }
    fs.unlinkSync(file);
  }
}
