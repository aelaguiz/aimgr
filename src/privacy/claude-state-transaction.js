import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudePrivateIdentityError } from "./claude-identity.js";

// Fixed targets prevent a damaged journal from becoming an arbitrary-file
// writer. The journal is OUTSIDE the vendor-visible account config: its backup
// may contain a previous account's identifier or credential (T04/T05/T23).
const TARGETS = Object.freeze({ appState: ".claude.json", auth: ".credentials.json", identity: ".aim-privacy-identity.json", legacyAppState: ".config.json" });
const LIMIT = 32 * 1024 * 1024;
const fail = reason => { throw new ClaudePrivateIdentityError(reason); };
const digest = text => text === null ? null : crypto.createHash("sha256").update(text).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

// This transaction is deliberately synchronous. An accidentally async guard
// or verifier must not let publication outrun its eventual rejection. Drain a
// rejected promise without exposing its private error, then refuse immediately.
function requireSynchronousCheck(check, receiver, ...args) {
  const result = check.apply(receiver, args);
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    fail("migration verification must complete synchronously");
  }
  if (result !== undefined && result !== true) fail("migration verification did not confirm safe state");
}

function privateDirectory(directory, io) {
  if (!path.isAbsolute(directory) || io.realpathSync(directory) !== directory) fail("migration directories must be canonical");
  const stat = io.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail("migration directories must be private and owned by this user");
}

function readPrivate(file, io, limit = LIMIT) {
  let fd;
  try {
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) {
      fail("migration state is not a bounded private regular file");
    }
    return io.readFileSync(fd, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function syncDirectory(directory, io) {
  const fd = io.openSync(directory, fs.constants.O_RDONLY);
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}

function replacePrivate(file, text, io) {
  if (text === null) {
    io.rmSync(file, { force: true });
    syncDirectory(path.dirname(file), io);
    return;
  }
  const staged = `${file}.migration-${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    io.writeFileSync(fd, text, "utf8");
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(staged, file);
    syncDirectory(path.dirname(file), io);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    io.rmSync(staged, { force: true });
  }
}

function validateJournal(journal, configDir) {
  if (!object(journal) || journal.schema !== 2 || journal.configDir !== configDir
    || !["prepared", "committed", "complete"].includes(journal.phase)
    || !object(journal.before) || !object(journal.after)
    || Object.keys(journal.before).sort().join() !== Object.keys(TARGETS).sort().join()
    || Object.keys(journal.after).sort().join() !== Object.keys(TARGETS).sort().join()) {
    fail("the private migration journal is invalid");
  }
  for (const key of Object.keys(TARGETS)) {
    for (const row of [journal.before[key], journal.after[key]]) {
      if (!object(row) || (row.text !== null && typeof row.text !== "string")
        || (row.text !== null && Buffer.byteLength(row.text) > LIMIT) || row.digest !== digest(row.text)) {
        fail("the private migration journal has inconsistent contents");
      }
    }
    if ((key === "legacyAppState") !== (journal.after[key].text === null)) {
      fail("a migration must preserve required state and retire only the classified legacy config");
    }
  }
}

/** Commit the classified account files while existing exclusive coordination is
 * held and every affected native owner is stopped. No new lock/registry here.
 *
 * T04/T23: generated IDs and the credential projection are journaled together.
 * Before the durable commit marker, account files remain untouched. After it,
 * recovery finishes these exact bytes; it must never call the identity planner
 * again and generate another ID. A half-published commit never permits launch.
 *
 * The caller plans against the OLD app state before changing its account UUID,
 * verifies the proposed credential/account binding, and supplies only that
 * verified plan. The callback may inspect staged data but executes no vendor.
 * This transaction does not establish account ownership or stop live owners.
 * Coordination must remain held for this entire synchronous call; an event-
 * loop callback reporting helper exit cannot establish that invariant here.
 * Never expose journal contents through logs, Redis, argv or vendor file grants.
 */
export function commitClaudeIdentityMigration({ configDir, migrationDir, desired, guard, verifyStaged, fsImpl: io = fs } = {}) {
  try {
    if (typeof guard?.assertOwned !== "function" || typeof verifyStaged !== "function") fail("exclusive migration coordination and state verification are required");
    const assertOwned = () => requireSynchronousCheck(guard.assertOwned, guard);
    assertOwned();
    privateDirectory(configDir, io); privateDirectory(migrationDir, io);
    if (migrationDir === configDir || migrationDir.startsWith(configDir + path.sep)) fail("migration backups overlap vendor-visible state");
    const journalFile = path.join(migrationDir, "transaction.json");
    const persisted = readPrivate(journalFile, io, 8 * LIMIT);
    let journal = persisted === null ? null : JSON.parse(persisted);
    if (journal) validateJournal(journal, configDir);
    // A completed journal is a private backup, not a demand that native state
    // never changes. Auth refresh and native app-state writes remain legitimate.
    if (journal?.phase === "complete") {
      if (desired === undefined) return { action: "complete" };
      // A later label reuse or classified migration is a NEW transaction.
      // Keep the old private backup; never report success without applying the
      // new plan. A crash here precedes any new target writes and is retryable.
      assertOwned();
      io.renameSync(journalFile, path.join(migrationDir, `completed-${crypto.randomUUID()}.json`));
      syncDirectory(migrationDir, io);
      journal = null;
    }
    if (journal?.phase === "prepared") {
      // No target writes are legal before the commit marker. Refuse evidence
      // of an uncoordinated writer instead of overwriting it during recovery.
      for (const [key, name] of Object.entries(TARGETS)) {
        if (digest(readPrivate(path.join(configDir, name), io)) !== journal.before[key].digest) fail("account state changed before migration committed");
      }
    }
    if (!journal) {
      if (!object(desired) || Object.keys(desired).sort().join() !== Object.keys(TARGETS).sort().join()
        || Object.entries(desired).some(([key, value]) => key === "legacyAppState" ? value !== null : !object(value))) fail("the classified migration plan is invalid");
      journal = { schema: 2, configDir, phase: "prepared", before: {}, after: {} };
      for (const [key, name] of Object.entries(TARGETS)) {
        const before = readPrivate(path.join(configDir, name), io);
        const after = desired[key] === null ? null : JSON.stringify(desired[key]) + "\n";
        if (after !== null && Buffer.byteLength(after) > LIMIT) fail("the classified migration state is too large");
        journal.before[key] = { text: before, digest: digest(before) };
        journal.after[key] = { text: after, digest: digest(after) };
      }
      replacePrivate(journalFile, JSON.stringify(journal) + "\n", io);
    }
    const staged = Object.fromEntries(Object.keys(TARGETS).map(key => [key, journal.after[key].text === null ? null : JSON.parse(journal.after[key].text)]));
    requireSynchronousCheck(verifyStaged, undefined, staged);
    assertOwned();
    if (journal.phase === "prepared") {
      journal.phase = "committed";
      replacePrivate(journalFile, JSON.stringify(journal) + "\n", io);
    }
    // Check ALL targets before publishing any more of a recovered commit. Only
    // an original or proposed byte sequence is a valid interrupted state.
    for (const [key, name] of Object.entries(TARGETS)) {
      const current = digest(readPrivate(path.join(configDir, name), io));
      if (![journal.before[key].digest, journal.after[key].digest].includes(current)) fail("account state changed outside the interrupted migration");
    }
    // T04: native prefers a nonempty .config.json over .claude.json. Publish
    // the classified canonical state first, then retire that legacy selector
    // LAST. The exact old bytes remain in the private journal. Owners stay
    // stopped through recovery, so no half-published account may execute.
    for (const [key, name] of Object.entries(TARGETS)) {
      assertOwned();
      const file = path.join(configDir, name);
      if (digest(readPrivate(file, io)) !== journal.after[key].digest) replacePrivate(file, journal.after[key].text, io);
    }
    assertOwned();
    journal.phase = "complete";
    replacePrivate(journalFile, JSON.stringify(journal) + "\n", io);
    return { action: "committed" };
  } catch (error) {
    if (error instanceof ClaudePrivateIdentityError) throw error;
    throw new ClaudePrivateIdentityError("the private identity migration could not complete safely; repair it before starting Claude");
  }
}
