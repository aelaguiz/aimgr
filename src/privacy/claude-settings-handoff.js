import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudePrivacySettingsError, inspectClaudeArguments, assertClaudeLocalInvocation } from "./claude-settings.js";

const fail = reason => { throw new ClaudePrivacySettingsError(reason); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

/** Stage the exact composed bytes beside their native source directory.
 *
 * T08/T15: moving the flag file to an arbitrary temp subdirectory changes
 * sandbox and Read/Edit permission anchors, and sometimes configured-hook
 * trust. Keep the original source unmodified and keep all its path strings.
 * The random snapshot contains private settings; never log its content or put
 * that content in argv. Normal project/user settings remain live in Claude.
 *
 * This is preparation, NOT an immutable launch boundary. Before vendor exec,
 * the caller must enforce read-only access to this exact path (including
 * rename/unlink), validate these bytes in the isolated doctor child, and
 * retain the snapshot for the complete lifetime of any consuming native owner.
 */
export function stageClaudeSettingsSnapshot(composition, { fsImpl: io = fs } = {}) {
  let file;
  let identity;
  let created = false;
  try {
    if (!composition || !["file", "inline", "default"].includes(composition.source?.kind)
      || !path.isAbsolute(composition.source?.directory ?? "")
      || typeof composition.serialized !== "string"
      || Buffer.byteLength(composition.serialized) > 2 * 1024 * 1024
      || JSON.stringify(composition.settings) !== composition.serialized) fail("the composed settings snapshot is inconsistent");
    const directory = composition.source.directory;
    if (composition.source.kind !== "file") {
      io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Native inline settings use a private, caller-owned claude-<uid>
      // directory and refuse a symlink at that final component. Preserve that
      // protection; never chmod an explicit settings file's project directory.
      const fd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const stat = io.fstatSync(fd);
        if (!stat.isDirectory() || stat.uid !== process.getuid()) fail("the native temporary settings directory is unsafe");
        // Parent sessions pin this origin against relocation. On Linux that
        // also denies redundant chmod; verified private mode needs no write.
        if ((stat.mode & 0o7777) !== 0o700) io.fchmodSync(fd, 0o700);
      } finally { io.closeSync(fd); }
    }
    const parent = io.statSync(directory);
    if (!parent.isDirectory()) fail("the native settings source directory is unavailable");
    file = path.join(directory, `.aim-claude-settings-${crypto.randomUUID()}.json`);
    const fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      identity = io.fstatSync(fd);
      io.writeFileSync(fd, composition.serialized, "utf8");
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
    const digest = hash(composition.serialized);
    const byteLength = Buffer.byteLength(composition.serialized);
    return Object.freeze({
      file,
      digest,
      // This check cannot replace the final native write/rename denial. It
      // detects accidental changes between trusted preparation operations.
      assertUnchanged() {
        let descriptor;
        try {
          descriptor = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const stat = io.fstatSync(descriptor);
          if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino
            || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)
            || stat.size !== byteLength
            || hash(io.readFileSync(descriptor)) !== digest) fail("the private settings snapshot changed before launch");
        } catch (error) {
          if (error instanceof ClaudePrivacySettingsError) throw error;
          fail("the private settings snapshot could not be verified");
        } finally { if (descriptor !== undefined) io.closeSync(descriptor); }
      },
      dispose() {
        // Never unlink a different inode substituted at the recorded name.
        try {
          const stat = io.lstatSync(file);
          if (stat.dev === identity.dev && stat.ino === identity.ino) io.unlinkSync(file);
        } catch (error) { if (error.code !== "ENOENT") fail("the private settings snapshot could not be cleaned up"); }
      },
    });
  } catch (error) {
    if (file && created) {
      try {
        const stat = io.lstatSync(file);
        // If the first fstat failed, no write was attempted. Clean only the
        // still-empty private regular file created with O_EXCL by this call.
        const ours = identity ? stat.dev === identity.dev && stat.ino === identity.ino
          : stat.isFile() && stat.size === 0 && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077);
        if (ours) io.unlinkSync(file);
      } catch {}
    }
    if (error instanceof ClaudePrivacySettingsError) throw error;
    fail("a private snapshot could not be created in the native settings source directory");
  }
}

export function claudeArgsWithSettingsSnapshot(args, snapshot) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || !path.isAbsolute(snapshot?.file ?? "")) {
    fail("the settings launch arguments are invalid");
  }
  const parsed = inspectClaudeArguments(args), forwarded = [...args];
  assertClaudeLocalInvocation(args);
  for (const span of parsed.settings) {
    if (span.offset !== undefined) forwarded[span.index] = args[span.index].slice(0, span.offset) + snapshot.file;
    else forwarded[span.valueIndex] = snapshot.file;
  }
  // Prefix a literal option visible to BOTH native parsers. In '-pn -- work',
  // Commander consumes '--' as a name while the eager loader stops there.
  // Inserting just before that token would make -n consume '--settings'.
  // Keep raw clusters unchanged: expanding one can change subcommand routing.
  // Replaced later sources point at the SAME snapshot and cannot override it.
  const result = ["--settings", snapshot.file, ...forwarded];
  const final = inspectClaudeArguments(result);
  // Raw eager scans and Commander can disagree about short clusters. For
  // example '-p-settings -p rc' consumes the standalone -p as a settings
  // value in Commander, but uses it to suppress RC registration in the eager
  // scanner. Replacing that value changes dispatch. Another consumed '--'
  // can expose a later child literal as an eager settings option. Never return
  // rewritten argv without verifying BOTH effective settings and routing.
  // Keep this refusal explicit until a native-equivalent transfer is proved;
  // quietly changing the command or using the wrong settings is unsafe.
  if (final.selectedSettings !== snapshot.file
    || final.eagerPrint !== parsed.eagerPrint || final.eagerUri !== parsed.eagerUri
    || final.eagerRestricted !== parsed.eagerRestricted
    || final.selectedCommand !== parsed.selectedCommand
    || final.commandAfterDelimiter !== parsed.commandAfterDelimiter) {
    fail("the settings handoff would change native argument meanings; use unambiguous full options");
  }
  assertClaudeLocalInvocation(result);
  return result;
}

function quoted(value) {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail("the validation policy paths are invalid");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

/** Same restricted Mac validator policy as the offsite decision fixture, with
 * exact admitted/input paths and literal traversal ancestors. Never use a
 * writable input-parent subpath grant: it permits replacing validated bytes.
 */
export function claudeMacSettingsValidationPolicy({ vendor, settingsFile, scratch }) {
  for (const value of [vendor, settingsFile, scratch]) {
    quoted(value);
    // Seatbelt evaluates the resolved filesystem location. Lexical comparison
    // alone misses /tmp aliases and trailing-slash overlaps with writable
    // scratch, permitting replacement of the supposedly read-only input.
    try {
      if (path.resolve(value) !== value || fs.realpathSync(value) !== value) fail("canonical validation paths are required");
    } catch { fail("canonical validation paths are required"); }
  }
  if (scratch === "/" || [vendor, settingsFile].some(file => file === scratch || file.startsWith(scratch + "/"))) {
    fail("validation inputs overlap writable scratch");
  }
  const ancestors = new Set(["/", "/private", "/var", "/private/var", "/Library", "/Library/Developer"]);
  for (const file of [vendor, settingsFile, scratch]) {
    for (let dir = path.dirname(file); !ancestors.has(dir); dir = path.dirname(dir)) ancestors.add(dir);
  }
  const literals = [...ancestors, vendor, settingsFile, "/dev/null", "/dev/random", "/dev/urandom"];
  return `(version 1)
(allow default)
(deny network*)
(deny mach-lookup)
(deny file-read* (require-not (require-any
${literals.map(file => `  (literal ${quoted(file)})`).join("\n")}
  (subpath "/System") (subpath "/usr") (subpath "/Library/Apple")
  (subpath "/private/var/db/dyld") (subpath "/private/preboot/Cryptexes/OS")
  (subpath ${quoted(scratch)}))))
(deny file-write* (require-not (require-any (literal "/dev/null") (subpath ${quoted(scratch)}))))
(deny process-exec (require-not (require-any (literal ${quoted(vendor)}) (literal "/usr/bin/security"))))
`;
}
