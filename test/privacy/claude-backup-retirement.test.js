import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeBackupRetirementComplete, retireClaudeLegacyBackups } from "../../src/privacy/claude-backup-retirement.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-retire-backups-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, ".claude"), migrationDir = path.join(root, ".privacy-migration");
  fs.mkdirSync(configDir, { mode: 0o700 }); fs.mkdirSync(migrationDir, { mode: 0o700 });
  fs.mkdirSync(path.join(configDir, "backups"), { mode: 0o700 });
  const identityRecord = { accountUuid: "synthetic-account-a", fields: { userID: "a".repeat(64), machineID: "b".repeat(64) } };
  return { configDir, migrationDir, identityRecord, guard: { exclusive: true, assertOwned() {} } };
}
function preserved(f) {
  return fs.readdirSync(f.migrationDir).filter(name => name.startsWith("native-app-state-backups-")).flatMap(name => {
    const root = path.join(f.migrationDir, name);
    return fs.readdirSync(root).filter(file => !["inventory.json", "complete.json"].includes(file)).map(file => fs.readFileSync(path.join(root, file), "utf8"));
  });
}

test("old app-state backups move intact while task history and subsequent private backups stay usable", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.configDir, ".claude.json.backup"), "old global identifier", { mode: 0o644 });
  fs.writeFileSync(path.join(f.configDir, "backups/.claude.json.backup.123"), "former account identifier", { mode: 0o600 });
  fs.writeFileSync(path.join(f.configDir, "backups/history.json"), "task history");
  assert.equal(claudeBackupRetirementComplete(f), false);
  retireClaudeLegacyBackups(f);
  assert.equal(claudeBackupRetirementComplete(f), true);
  assert.deepEqual(preserved(f).sort(), ["former account identifier", "old global identifier"]);
  assert.equal(fs.readFileSync(path.join(f.configDir, "backups/history.json"), "utf8"), "task history");
  assert.equal(fs.existsSync(path.join(f.configDir, ".claude.json.backup")), false);
  const fresh = path.join(f.configDir, "backups/.claude.json.backup.456");
  fs.writeFileSync(fresh, "new private identifier"); retireClaudeLegacyBackups(f);
  assert.equal(fs.readFileSync(fresh, "utf8"), "new private identifier");
  const rebound = { ...f, identityRecord: { ...f.identityRecord, accountUuid: "synthetic-account-b" } };
  assert.equal(claudeBackupRetirementComplete(rebound), false);
  retireClaudeLegacyBackups(rebound);
  assert.equal(fs.existsSync(fresh), false); assert.ok(preserved(f).includes("new private identifier"));
});

test("an interrupted move retains every byte and resumes without overwriting recovery data", t => {
  const f = fixture(t);
  for (const name of ["1", "2", "3"]) fs.writeFileSync(path.join(f.configDir, ".claude.json.backup." + name), name);
  let moved = 0;
  assert.throws(() => retireClaudeLegacyBackups({ ...f, fsImpl: { ...fs,
    renameSync(from, to) {
      if (from.startsWith(f.configDir + "/") && ++moved === 2) throw new Error("synthetic interruption");
      return fs.renameSync(from, to);
    },
  } }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
  assert.equal(claudeBackupRetirementComplete(f), false);
  assert.equal(preserved(f).length, 1);
  retireClaudeLegacyBackups(f);
  assert.equal(claudeBackupRetirementComplete(f), true);
  assert.deepEqual(preserved(f).sort(), ["1", "2", "3"]);
});

test("unsafe backups and missing exclusive ownership refuse without moving the source", t => {
  const f = fixture(t), file = path.join(f.configDir, ".claude.json.backup");
  const target = path.join(f.configDir, "task.txt"); fs.writeFileSync(target, "keep"); fs.symlinkSync(target, file);
  assert.throws(() => retireClaudeLegacyBackups(f)); assert.equal(fs.readFileSync(target, "utf8"), "keep");
  fs.unlinkSync(file); fs.linkSync(target, file); assert.throws(() => retireClaudeLegacyBackups(f));
  fs.unlinkSync(file); fs.writeFileSync(file, "keep");
  assert.throws(() => retireClaudeLegacyBackups({ ...f, guard: { ...f.guard, exclusive: false } }));
  assert.equal(fs.readFileSync(file, "utf8"), "keep"); assert.equal(claudeBackupRetirementComplete(f), false);
});


test("legacy and corrupted native copies retire with the current backup family", t => {
  const f = fixture(t), names = [".config.json.backup", ".config.json.backup.12", ".claude.json.corrupted.34", ".config.json.corrupted.56"];
  for (const prefix of ["", "backups/"]) for (const name of names) fs.writeFileSync(path.join(f.configDir, prefix + name), prefix + name);
  retireClaudeLegacyBackups(f);
  assert.equal(claudeBackupRetirementComplete(f), true);
  assert.deepEqual(preserved(f).sort(), names.flatMap(name => [name, "backups/" + name]).sort());
});

test("retry resyncs the original destination after rename succeeds and its directory fsync fails", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.configDir, ".claude.json.backup.1"), "unchanged old ID");
  let movedBucket, failed = false;
  const fds = new Map(), syncedOnRetry = new Set();
  const io = { ...fs,
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); fds.set(fd, file); return fd; },
    closeSync(fd) { fds.delete(fd); return fs.closeSync(fd); },
    renameSync(from, to) {
      const result = fs.renameSync(from, to);
      if (from.startsWith(f.configDir + "/")) movedBucket = path.dirname(to);
      return result;
    },
    fsyncSync(fd) {
      if (movedBucket && fds.get(fd) === movedBucket && !failed) { failed = true; throw new Error("synthetic directory fsync failure"); }
      return fs.fsyncSync(fd);
    },
  };
  assert.throws(() => retireClaudeLegacyBackups({ ...f, fsImpl: io }));
  assert.equal(claudeBackupRetirementComplete(f), false);
  retireClaudeLegacyBackups({ ...f, fsImpl: { ...io, fsyncSync(fd) { syncedOnRetry.add(fds.get(fd)); return fs.fsyncSync(fd); } } });
  assert.ok(syncedOnRetry.has(movedBucket));
  assert.ok(syncedOnRetry.has(path.join(movedBucket, "root-.claude.json.backup.1")));
  assert.equal(claudeBackupRetirementComplete(f), true);
  assert.deepEqual(preserved(f), ["unchanged old ID"]);
});


test("a previous identity's marker cannot bypass an interrupted rebind inventory", t => {
  const f = fixture(t); retireClaudeLegacyBackups(f);
  for (const name of ["1", "2"]) fs.writeFileSync(path.join(f.configDir, ".claude.json.backup." + name), name);
  const rebound = { ...f, identityRecord: { ...f.identityRecord, accountUuid: "synthetic-account-b" } };
  let moved = 0;
  assert.throws(() => retireClaudeLegacyBackups({ ...rebound, fsImpl: { ...fs,
    renameSync(from, to) {
      if (from.startsWith(f.configDir + "/") && ++moved === 2) throw new Error("synthetic interruption");
      return fs.renameSync(from, to);
    },
  } }));
  assert.equal(claudeBackupRetirementComplete(f), false);
  retireClaudeLegacyBackups(f); // Return to A must first finish B's durable inventory.
  assert.equal(claudeBackupRetirementComplete(f), true);
  assert.deepEqual(preserved(f).sort(), ["1", "2"]);
  retireClaudeLegacyBackups(rebound);
  assert.equal(claudeBackupRetirementComplete(rebound), true);
});
