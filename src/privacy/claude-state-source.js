import fs from "node:fs";
import path from "node:path";
import { ClaudePrivateIdentityError } from "./claude-identity.js";

const fail = reason => { throw new ClaudePrivateIdentityError(reason); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const LIMIT = 32 * 1024 * 1024;

/** Select the same app-state path as reviewed Claude 2.1.316.
 *
 * Native selection is based on stat, not valid JSON: a nonempty legacy file
 * wins even when its contents are whitespace/corrupt. An empty writable legacy
 * file wins only while the canonical name does not exist. Never silently read
 * canonical identity after failing to read the source Claude actually chooses.
 * The caller holds coordination; returned contents stay local and private.
 *
 * A managed explicit CLAUDE_CONFIG_DIR puts canonical state inside configDir.
 * Legacy callers without that variable supply HOME/.claude.json explicitly.
 */
export function selectClaudeAppStateFile({ configDir,
  canonicalFile = path.join(configDir ?? "", ".claude.json"), fsImpl: io = fs } = {}) {
  if (!path.isAbsolute(configDir ?? "") || !path.isAbsolute(canonicalFile)) fail("the native app-state paths are invalid");
  const legacyFile = path.join(configDir.normalize("NFC"), ".config.json");
  let legacyStat;
  try { legacyStat = io.statSync(legacyFile); }
  catch (error) {
    // Native falls back on any stat error. We must not assume an inaccessible
    // path stays inaccessible after launch, or mistake an I/O fault for absence.
    if (error.code !== "ENOENT") fail("the legacy app-state selector could not be inspected");
  }
  const legacy = Boolean(legacyStat?.isFile() && (legacyStat.size > 0
    || ((legacyStat.mode & 0o222) !== 0 && !io.existsSync(canonicalFile))));
  const file = legacy ? legacyFile : canonicalFile;
  return { file, legacy };
}

export function readClaudeActiveAppState({ configDir,
  canonicalFile = path.join(configDir ?? "", ".claude.json"), fsImpl: io = fs,
  allowMalformed = false } = {}) {
  const { file, legacy } = selectClaudeAppStateFile({ configDir, canonicalFile, fsImpl: io });
  let fd;
  try {
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > LIMIT) {
      fail("the selected native app state is not a bounded owned regular file");
    }
    const text = io.readFileSync(fd, "utf8");
    // Empty files are native first-start state; whitespace-only nonempty files
    // are not silently substituted with canonical state or a fresh identity.
    let state;
    try { state = text.length === 0 ? {} : JSON.parse(text); }
    catch {
      if (allowMalformed) return { file, legacy, exists: true, malformed: true, state: {} };
      fail("the selected native app state could not be read; preserve it for repair");
    }
    if (!object(state)) {
      if (allowMalformed) return { file, legacy, exists: true, malformed: true, state: {} };
      fail("the selected native app state is not a JSON object");
    }
    return { file, legacy, exists: true, state };
  } catch (error) {
    if (error.code === "ENOENT" && !legacy) return { file, legacy: false, exists: false, state: {} };
    if (error instanceof ClaudePrivateIdentityError) throw error;
    fail("the selected native app state could not be read; preserve it for repair");
  } finally { if (fd !== undefined) io.closeSync(fd); }
}
