import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudePrivateIdentityError, isClaudeAccountId } from "./claude-identity.js";

const fail = () => { throw new ClaudePrivateIdentityError("old Claude app-state backups could not be preserved outside the account's readable state"); };
const identityDigest = identity => crypto.createHash("sha256").update(JSON.stringify(identity.fields)).digest("hex");
const markerName = "backups-retired.json";

function privateDirectory(directory, io) {
  const stat = io.lstatSync(directory);
  if (io.realpathSync(directory) !== directory || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail();
}
function sync(directory, io) {
  const fd = io.openSync(directory, fs.constants.O_RDONLY);
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function write(file, value, io) {
  const temp = file + "." + crypto.randomUUID();
  let fd, created = false;
  try {
    fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true; io.writeFileSync(fd, JSON.stringify(value) + "\n"); io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined; io.renameSync(temp, file); created = false; sync(path.dirname(file), io);
  } finally { if (fd !== undefined) io.closeSync(fd); if (created) io.unlinkSync(temp); }
}

export function claudeBackupRetirementComplete({ migrationDir, identityRecord, fsImpl: io = fs }) {
  if (!identityRecord || !isClaudeAccountId(identityRecord.accountUuid)) return false;
  let fd;
  try {
    privateDirectory(migrationDir, io);
    fd = io.openSync(path.join(migrationDir, markerName), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) fail();
    const marker = JSON.parse(io.readFileSync(fd, "utf8"));
    if (marker.schema !== 1 || !isClaudeAccountId(marker.accountUuid) || !/^[a-f0-9]{64}$/.test(marker.identityDigest ?? "")) fail();
    // A previous account's marker cannot hide an interrupted rebind. Native
    // backup pruning must not run while an inventory still needs source bytes.
    for (const name of io.readdirSync(migrationDir)) {
      if (!name.startsWith(bucketPrefix)) continue;
      const bucket = path.join(migrationDir, name); privateDirectory(bucket, io);
      try { readPrivateJson(path.join(bucket, "inventory.json"), io); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      let complete;
      try { complete = readPrivateJson(path.join(bucket, "complete.json"), io); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
      if (complete.schema !== 1 || complete.complete !== true) fail();
    }
    return marker.accountUuid === identityRecord.accountUuid && marker.identityDigest === identityDigest(identityRecord);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail();
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

// Native selects either current .claude.json or legacy .config.json. Both
// backup and corrupted copies contain the entire app state, including IDs.
const nativeCopy = /^\.(?:claude|config)\.json\.(?:backup|corrupted)(?:[.-][A-Za-z0-9_-]+)*$/;
const bucketPrefix = "native-app-state-backups-";
function readPrivateJson(file, io) {
  let fd;
  try {
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 32 * 1024 * 1024) fail();
    return JSON.parse(io.readFileSync(fd, "utf8"));
  } finally { if (fd !== undefined) io.closeSync(fd); }
}
function inspectCopy(file, io, { optional = false, durable = false } = {}) {
  let fd;
  try {
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) fail();
    io.fchmodSync(fd, 0o600);
    if (durable) io.fsyncSync(fd);
    return true;
  } catch (error) { if (optional && error.code === "ENOENT") return false; throw error; }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
function sourceDirectory(configDir, prefix, io) {
  const directory = path.join(configDir, prefix);
  const stat = io.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || io.realpathSync(directory) !== directory) fail();
  return directory;
}
function targetName(source) {
  const parts = source.split("/");
  if (parts.length === 1 && nativeCopy.test(parts[0])) return "root-" + parts[0];
  if (parts.length === 2 && parts[0] === "backups" && nativeCopy.test(parts[1])) return "backups-" + parts[1];
  fail();
}
function finishBucket({ bucket, configDir, guard, io }) {
  privateDirectory(bucket, io);
  try {
    const complete = readPrivateJson(path.join(bucket, "complete.json"), io);
    if (complete.schema !== 1 || complete.complete !== true) fail();
    // All copies and both rename directories were durable before this record.
    // A previous marker-directory fsync may have failed; finish that sync.
    sync(bucket, io); return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let inventory;
  try { inventory = readPrivateJson(path.join(bucket, "inventory.json"), io); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // No move starts before the inventory rename+sync. An interruption while
    // creating that inventory leaves only its private temporary file (or an
    // empty bucket). Preserve those bytes; no source has moved into this bucket.
    for (const name of io.readdirSync(bucket)) {
      if (!/^inventory\.json\.[a-f0-9-]{36}$/.test(name)) fail();
      inspectCopy(path.join(bucket, name), io);
    }
    return;
  }
  if (inventory.schema !== 1 || !Array.isArray(inventory.files)) fail();
  const sources = new Set(), targets = new Set();
  for (const row of inventory.files) {
    if (!row || typeof row.source !== "string" || row.target !== targetName(row.source)
      || sources.has(row.source) || targets.has(row.target)) fail();
    sources.add(row.source); targets.add(row.target);
  }
  for (const row of inventory.files) {
    guard.assertOwned();
    const parent = sourceDirectory(configDir, path.dirname(row.source) === "." ? "" : "backups", io);
    const source = path.join(configDir, row.source), target = path.join(bucket, row.target);
    const hasSource = inspectCopy(source, io, { optional: true });
    const hasTarget = inspectCopy(target, io, { optional: true });
    if (hasSource === hasTarget) fail(); // Neither exists, or ambiguous duplicates: preserve and refuse.
    if (hasSource) io.renameSync(source, target);
    // Reconcile the original bucket on retry, including a rename that completed
    // before fsync failed. Merely scanning remaining sources loses this proof.
    inspectCopy(target, io, { durable: true }); sync(parent, io); sync(bucket, io);
  }
  guard.assertOwned(); write(path.join(bucket, "complete.json"), { schema: 1, complete: true }, io);
}

/** T04/T05: native app-state copies can contain the former installation ID.
 * Preserve their exact bytes outside the recursive account grant. This is a
 * stopped-owner migration per private identity, not pruning on every launch.
 * New native backups remain usable during normal sessions.
 *
 * Persist each inventory before moving. Retry reconciles its original sources
 * and destinations, then syncs every moved file and directory before marking
 * completion. No history, active config, or unclassified filename is removed.
 */
export function retireClaudeLegacyBackups({ configDir, migrationDir, identityRecord, guard, fsImpl: io = fs }) {
  try {
    if (guard?.exclusive !== true || typeof guard.assertOwned !== "function" || !isClaudeAccountId(identityRecord?.accountUuid)) fail();
    guard.assertOwned(); privateDirectory(configDir, io); privateDirectory(migrationDir, io);
    if (migrationDir === configDir || migrationDir.startsWith(configDir + path.sep)) fail();
    if (claudeBackupRetirementComplete({ migrationDir, identityRecord, fsImpl: io })) return;
    for (const name of io.readdirSync(migrationDir)) {
      if (name.startsWith(bucketPrefix)) finishBucket({ bucket: path.join(migrationDir, name), configDir, guard, io });
    }
    const files = [];
    for (const prefix of ["", "backups"]) {
      let directory;
      try { directory = sourceDirectory(configDir, prefix, io); }
      catch (error) { if (prefix && error.code === "ENOENT") continue; throw error; }
      for (const name of io.readdirSync(directory)) {
        if (!nativeCopy.test(name)) continue;
        inspectCopy(path.join(directory, name), io);
        const source = path.join(prefix, name);
        files.push({ source, target: targetName(source) });
      }
    }
    if (files.length) {
      const bucket = io.mkdtempSync(path.join(migrationDir, bucketPrefix)); io.chmodSync(bucket, 0o700);
      write(path.join(bucket, "inventory.json"), { schema: 1, files }, io);
      sync(migrationDir, io);
      finishBucket({ bucket, configDir, guard, io });
    }
    guard.assertOwned();
    write(path.join(migrationDir, markerName), { schema: 1, accountUuid: identityRecord.accountUuid,
      identityDigest: identityDigest(identityRecord) }, io);
  } catch (error) { if (error instanceof ClaudePrivateIdentityError) throw error; fail(); }
}
