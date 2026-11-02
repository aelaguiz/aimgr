import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitClaudeIdentityMigration } from "../../src/privacy/claude-state-transaction.js";

const target = { appState: ".claude.json", auth: ".credentials.json", identity: ".aim-privacy-identity.json", legacyAppState: ".config.json" };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-identity-commit-")));
  const configDir = path.join(root, "config"), migrationDir = path.join(root, "private-backups");
  fs.mkdirSync(configDir, { mode: 0o700 }); fs.mkdirSync(migrationDir, { mode: 0o700 });
  const before = { appState: { userID: "old-private-id", projects: { kept: true } }, auth: { token: "old-private-token" } };
  for (const [key, value] of Object.entries(before)) fs.writeFileSync(path.join(configDir, target[key]), JSON.stringify(value) + "\n", { mode: 0o600 });
  const desired = { appState: { userID: "new-private-id", projects: { kept: true } }, auth: { token: "new-private-token" },
    legacyAppState: null, identity: { schema: 1, accountUuid: "synthetic-account", fields: { userID: "new-private-id" } } };
  const args = { configDir, migrationDir, desired, guard: { assertOwned() {} }, verifyStaged(value) {
    assert.equal(value.appState.userID, value.identity.fields.userID);
  } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const read = key => fs.existsSync(path.join(configDir, target[key])) ? JSON.parse(fs.readFileSync(path.join(configDir, target[key]), "utf8")) : null;
  return { ...args, args, before, read };
}
function failRename(matches) {
  return new Proxy(fs, { get(io, key) {
    if (key !== "renameSync") return io[key];
    return (from, to) => { if (matches(from, to)) throw new Error("synthetic write interruption"); return io.renameSync(from, to); };
  } });
}

test("publishes identity and credentials together with a private recoverable backup", t => {
  const f = fixture(t);
  assert.deepEqual(commitClaudeIdentityMigration(f.args), { action: "committed" });
  for (const key of Object.keys(target)) assert.deepEqual(f.read(key), f.desired[key]);
  const journal = JSON.parse(fs.readFileSync(path.join(f.migrationDir, "transaction.json"), "utf8"));
  assert.equal(journal.phase, "complete");
  assert.equal(JSON.parse(journal.before.auth.text).token, "old-private-token");
  for (const name of fs.readdirSync(f.configDir)) assert.equal(fs.statSync(path.join(f.configDir, name)).mode & 0o777, 0o600);
});

test("interruption before the commit marker leaves originals intact and reuses staged identity", t => {
  const f = fixture(t); let journalRenames = 0;
  const io = failRename((_from, to) => to.endsWith("transaction.json") && ++journalRenames === 2);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, fsImpl: io }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
  assert.deepEqual(f.read("appState"), f.before.appState); assert.deepEqual(f.read("auth"), f.before.auth);
  assert.equal(fs.existsSync(path.join(f.configDir, target.identity)), false);
  commitClaudeIdentityMigration({ ...f.args, desired: { ...f.desired, appState: { userID: "must-not-regenerate" } } });
  assert.deepEqual(f.read("appState"), f.desired.appState);
});

test("recovery finishes a committed partial publication without regenerating IDs", t => {
  const f = fixture(t);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args,
    fsImpl: failRename((_from, to) => to.endsWith(".credentials.json")) }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
  assert.deepEqual(f.read("appState"), f.desired.appState);
  assert.deepEqual(f.read("auth"), f.before.auth);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.migrationDir, "transaction.json"))).phase, "committed");
  commitClaudeIdentityMigration({ ...f.args, desired: undefined });
  for (const key of Object.keys(target)) assert.deepEqual(f.read(key), f.desired[key]);
});

test("unexpected concurrent state is never overwritten during recovery", t => {
  const f = fixture(t);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args,
    fsImpl: failRename((_from, to) => to.endsWith(".credentials.json")) }));
  fs.writeFileSync(path.join(f.configDir, target.auth), '{"token":"concurrent-update"}\n', { mode: 0o600 });
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, desired: undefined }), /changed outside/);
  assert.deepEqual(f.read("auth"), { token: "concurrent-update" });
});

test("completed recovery permits native updates; a later label migration applies its new plan", t => {
  const f = fixture(t); commitClaudeIdentityMigration(f.args);
  fs.writeFileSync(path.join(f.configDir, target.auth), '{"token":"native-refreshed"}\n', { mode: 0o600 });
  assert.deepEqual(commitClaudeIdentityMigration({ ...f.args, desired: undefined }), { action: "complete" });
  assert.equal(f.read("auth").token, "native-refreshed");
  const next = { ...f.desired, appState: { userID: "second-account-id" }, auth: { token: "second-account-token" },
    identity: { fields: { userID: "second-account-id" } } };
  commitClaudeIdentityMigration({ ...f.args, desired: next });
  assert.deepEqual(f.read("appState"), next.appState);
  assert.equal(fs.readdirSync(f.migrationDir).filter(name => name.startsWith("completed-")).length, 1);
});

test("lost coordination, invalid staged identity, unsafe files and visible backups refuse", t => {
  const f = fixture(t);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, guard: null }), /coordination/);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, migrationDir: f.configDir }), /overlap/);
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, verifyStaged() { throw new Error("PRIVATE_TOKEN"); } }), error => {
    assert.equal(error.message.includes("PRIVATE_TOKEN"), false); return true;
  });
  assert.deepEqual(f.read("appState"), f.before.appState);
  let calls = 0;
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, guard: { assertOwned() { if (++calls === 3) throw new Error("lost"); } } }));
  assert.deepEqual(f.read("appState"), f.before.appState);
  fs.rmSync(path.join(f.configDir, target.auth));
  fs.symlinkSync(path.join(f.configDir, target.appState), path.join(f.configDir, target.auth));
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, desired: undefined }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
});

test("async or false-returning checks cannot publish account state", async t => {
  for (const result of [false, "not an approval", Promise.resolve(true), Promise.reject(new Error("PRIVATE_ASYNC_FAILURE"))]) {
    // Drain the fixture promise even if an assertion fails before it is used.
    if (result instanceof Promise) result.catch(() => {});
    for (const check of ["guard", "verifier"]) {
      const f = fixture(t);
      const override = check === "guard" ? { guard: { assertOwned: () => result } } : { verifyStaged: () => result };
      assert.throws(() => commitClaudeIdentityMigration({ ...f.args, ...override }), error => {
        assert.equal(error.code, "AIMGR_CLAUDE_PRIVATE_IDENTITY");
        assert.equal(error.message.includes("PRIVATE_ASYNC_FAILURE"), false);
        return true;
      });
      assert.deepEqual(f.read("appState"), f.before.appState);
      assert.deepEqual(f.read("auth"), f.before.auth);
      assert.equal(fs.existsSync(path.join(f.configDir, target.identity)), false);
    }
  }
  await new Promise(resolve => setImmediate(resolve));
});


test("legacy config is journaled and retired last, including recovery after unlink", t => {
  const f = fixture(t);
  const legacy = path.join(f.configDir, target.legacyAppState);
  const original = '{"userID":"legacy-private-id","projects":{"legacy":true}}\n';
  fs.writeFileSync(legacy, original, { mode: 0o600 });
  let injected = false;
  const io = new Proxy(fs, { get(source, key) {
    if (key !== "rmSync") return source[key];
    return (file, options) => {
      if (file === legacy) {
        assert.deepEqual(f.read("appState"), f.desired.appState);
        assert.deepEqual(f.read("identity"), f.desired.identity);
        source.rmSync(file, options);
        if (!injected) { injected = true; throw new Error("interrupted after legacy retirement"); }
        return;
      }
      return source.rmSync(file, options);
    };
  } });
  assert.throws(() => commitClaudeIdentityMigration({ ...f.args, fsImpl: io }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
  commitClaudeIdentityMigration({ ...f.args, desired: undefined });
  assert.equal(fs.existsSync(legacy), false);
  const journal = JSON.parse(fs.readFileSync(path.join(f.migrationDir, "transaction.json")));
  assert.equal(journal.before.legacyAppState.text, original);
  assert.equal(journal.after.legacyAppState.text, null);
  assert.equal(journal.phase, "complete");
});
