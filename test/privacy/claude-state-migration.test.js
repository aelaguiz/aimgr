import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireClaudeStateGuard, migrateClaudePrivateState } from "../../src/privacy/claude-state-migration.js";
import { retainClaudeLaunchFiles } from "../../src/privacy/claude-launch-retention.js";
import { acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
function credential(id = A, suffix = "old", expiresAt = Date.now() + 3600000) {
  return { nativeClaudeBundle: {
    oauthAccount: { accountUuid: id, organizationUuid: "00000000-0000-4000-8000-000000000003",
      organizationName: "Synthetic Pro", emailAddress: "synthetic@example.invalid" },
    claudeAiOauth: { accessToken: "synthetic-" + suffix, refreshToken: "synthetic-refresh-" + suffix,
      expiresAt, subscriptionType: "pro", rateLimitTier: "default_claude_max_5x", scopes: ["user:profile", "user:inference"] },
  } };
}
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
async function fixture(t) {
  const userHomeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-identity-migration-")));
  t.after(() => fs.rmSync(userHomeDir, { recursive: true, force: true }));
  const labelHome = path.join(userHomeDir, ".aimgr/claude-homes/a");
  const configDir = path.join(labelHome, ".claude"), migrationDir = path.join(labelHome, ".privacy-migration");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(migrationDir, { mode: 0o700 });
  const guard = await acquireClaudeAssignmentLock(userHomeDir, "a", { exclusive: true });
  t.after(() => guard.release());
  let ownerChecks = 0;
  return { userHomeDir, configDir, migrationDir, guard, command: fs.realpathSync(process.execPath), accountUuid: A,
    credential: credential(), assertStopped: async () => { ownerChecks++; }, checks: () => ownerChecks };
}

test("fresh private identity is stable and shared state survives the stopped transition", async t => {
  const f = await fixture(t);
  write(path.join(f.configDir, ".claude.json"), { theme: "dark", projects: { kept: true } });
  write(path.join(f.configDir, ".credentials.json"), { mcpOAuth: { required: { token: "synthetic-mcp" } } });
  assert.equal((await migrateClaudePrivateState(f)).action, "committed");
  const state = read(path.join(f.configDir, ".claude.json"));
  assert.match(state.userID, /^[0-9a-f]{64}$/); assert.match(state.machineID, /^[0-9a-f]{64}$/);
  assert.equal(state.theme, "dark"); assert.deepEqual(state.projects, { kept: true });
  assert.equal(read(path.join(f.configDir, ".credentials.json")).mcpOAuth.required.token, "synthetic-mcp");
  assert.equal((await migrateClaudePrivateState(f)).action, "unchanged");
  assert.deepEqual(read(path.join(f.configDir, ".claude.json")), state);
  assert.equal(f.checks(), 2);
});

test("legacy state wins, copied identifiers change, and newer native OAuth remains authoritative", async t => {
  const f = await fixture(t), current = credential(A, "newer", Date.now() + 7200000).nativeClaudeBundle;
  write(path.join(f.userHomeDir, ".claude.json"), { userID: "a".repeat(64) });
  write(path.join(f.configDir, ".claude.json"), { staleCanonical: true });
  write(path.join(f.configDir, ".config.json"), { userID: "a".repeat(64), machineID: "b".repeat(64),
    oauthAccount: current.oauthAccount, mcpServers: { keep: true } });
  write(path.join(f.configDir, ".credentials.json"), { claudeAiOauth: current.claudeAiOauth, mcpOAuth: { keep: true } });
  fs.chmodSync(path.join(f.configDir, ".config.json"), 0o644);
  await migrateClaudePrivateState(f);
  const state = read(path.join(f.configDir, ".claude.json"));
  assert.notEqual(state.userID, "a".repeat(64)); assert.equal(state.machineID, "b".repeat(64));
  assert.deepEqual(state.mcpServers, { keep: true }); assert.equal(state.staleCanonical, undefined);
  assert.equal(fs.existsSync(path.join(f.configDir, ".config.json")), false);
  assert.equal(read(path.join(f.configDir, ".credentials.json")).claudeAiOauth.accessToken, "synthetic-newer");
  const journal = read(path.join(f.migrationDir, "transaction.json"));
  assert.ok(journal.before.legacyAppState.text.includes('"mcpServers"'));
  assert.equal(journal.phase, "complete");
});

test("label rebinding replaces only provider identity and preserves MCP authentication", async t => {
  const f = await fixture(t); await migrateClaudePrivateState(f);
  const old = read(path.join(f.configDir, ".claude.json"));
  const authPath = path.join(f.configDir, ".credentials.json");
  write(authPath, { ...read(authPath), trustedDeviceToken: "old-device", mcpOAuth: { keep: true } });
  await migrateClaudePrivateState({ ...f, accountUuid: B, credential: credential(B, "other") });
  const state = read(path.join(f.configDir, ".claude.json"));
  assert.equal(state.oauthAccount.accountUuid, B); assert.notEqual(state.userID, old.userID);
  assert.deepEqual(read(authPath).mcpOAuth, { keep: true }); assert.equal(read(authPath).trustedDeviceToken, undefined);
});

test("unknown ownership, active owners and a shared guard cannot change account state", async t => {
  const f = await fixture(t), statePath = path.join(f.configDir, ".claude.json");
  write(statePath, { userID: "c".repeat(64) });
  const before = fs.readFileSync(statePath, "utf8");
  await assert.rejects(migrateClaudePrivateState(f), /no verified account owner/);
  await assert.rejects(migrateClaudePrivateState({ ...f, assertStopped: async () => { throw new Error("active-owner"); } }), /active-owner/);
  await assert.rejects(migrateClaudePrivateState({ ...f, guard: { ...f.guard, exclusive: false } }), /exclusive/);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(f.migrationDir, "transaction.json")), false);
});

test("incomplete newer native lineage is preserved without creating a migration journal", async t => {
  const f = await fixture(t), current = credential(A, "newer").nativeClaudeBundle;
  delete current.claudeAiOauth.rateLimitTier;
  write(path.join(f.configDir, ".claude.json"), { oauthAccount: current.oauthAccount });
  write(path.join(f.configDir, ".credentials.json"), { claudeAiOauth: current.claudeAiOauth });
  await assert.rejects(migrateClaudePrivateState(f), /incomplete same-account token lineage/);
  assert.deepEqual(read(path.join(f.configDir, ".credentials.json")).claudeAiOauth, current.claudeAiOauth);
  assert.equal(fs.existsSync(path.join(f.migrationDir, "transaction.json")), false);
});

test("interrupted old-account commit recovers before a later label rebind", async t => {
  const f = await fixture(t); await migrateClaudePrivateState(f);
  const old = read(path.join(f.configDir, ".claude.json"));
  const journalPath = path.join(f.migrationDir, "transaction.json");
  const journal = read(journalPath); journal.phase = "committed";
  write(journalPath, journal);
  fs.rmSync(path.join(f.configDir, ".credentials.json"));
  fs.rmSync(path.join(f.configDir, ".aim-privacy-identity.json"));
  await migrateClaudePrivateState({ ...f, accountUuid: B, credential: credential(B, "other") });
  const state = read(path.join(f.configDir, ".claude.json"));
  assert.equal(state.oauthAccount.accountUuid, B); assert.notEqual(state.userID, old.userID);
  const oldJournal = fs.readdirSync(f.migrationDir).find(name => name.startsWith("completed-"));
  assert.equal(read(path.join(f.migrationDir, oldJournal)).phase, "complete");
  assert.equal(read(journalPath).phase, "complete");
});

test("coordinated launch migrates once and permits simultaneous same-account owners", async t => {
  const f = await fixture(t); await f.guard.release();
  const args = { homeDir: f.userHomeDir, label: "a", configDir: f.configDir, command: f.command,
    assertStopped: f.assertStopped,
    readBinding: async () => ({ protected: true, accountUuid: A, profileRef: "proxy-a",
      expectedEmail: "synthetic@example.invalid", credential: f.credential }) };
  const first = await acquireClaudeStateGuard(args); t.after(() => first.release());
  const second = await acquireClaudeStateGuard(args); t.after(() => second.release());
  assert.equal(first.exclusive, false); assert.equal(second.exclusive, false);
  assert.equal(f.checks(), 1, "normal concurrent launch must not require stopped owners");
  await assert.rejects(acquireClaudeAssignmentLock(f.userHomeDir, "a", { exclusive: true }), /lock is unavailable/);
  await first.release(); await second.release();
  const ex = await acquireClaudeAssignmentLock(f.userHomeDir, "a", { exclusive: true }); await ex.release();
});

test("binding change while changing lock modes refuses without projecting stale identity", async t => {
  const f = await fixture(t); await f.guard.release(); let reads = 0;
  await assert.rejects(acquireClaudeStateGuard({ homeDir: f.userHomeDir, label: "a", configDir: f.configDir,
    command: f.command, assertStopped: f.assertStopped,
    readBinding: async () => ({ protected: true, accountUuid: ++reads === 1 ? A : B,
      expectedEmail: "synthetic@example.invalid", credential: f.credential }) }), /assignment changed/);
  assert.equal(fs.existsSync(path.join(f.configDir, ".claude.json")), false);
  const ex = await acquireClaudeAssignmentLock(f.userHomeDir, "a", { exclusive: true }); await ex.release();
});

test("ready identities still remove foreign signed-device keys and compare explicit personal config", async t => {
  const f = await fixture(t); await migrateClaudePrivateState(f); await f.guard.release();
  const statePath = path.join(f.configDir, ".claude.json"), authPath = path.join(f.configDir, ".credentials.json");
  const old = read(statePath);
  write(authPath, { ...read(authPath), coworkRemoteDevice: { [A]: { own: true }, [B]: { foreign: true } },
    mcpOAuth: { retained: true } });
  fs.mkdirSync(path.join(f.userHomeDir, ".claude"), { mode: 0o700 });
  write(path.join(f.userHomeDir, ".claude/.claude.json"), { userID: old.userID });
  const guard = await acquireClaudeStateGuard({ homeDir: f.userHomeDir, label: "a", configDir: f.configDir,
    command: f.command, assertStopped: f.assertStopped,
    readBinding: async () => ({ protected: true, accountUuid: A, expectedEmail: "synthetic@example.invalid",
      credential: f.credential }) });
  t.after(() => guard.release());
  assert.notEqual(read(statePath).userID, old.userID);
  assert.equal(read(statePath).machineID, old.machineID);
  assert.deepEqual(read(authPath).coworkRemoteDevice, { [A]: { own: true } });
  assert.deepEqual(read(authPath).mcpOAuth, { retained: true });
});


test("simultaneous first launches join one completed identity transition", async t => {
  const f = await fixture(t); await f.guard.release();
  let preparing = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const args = { homeDir: f.userHomeDir, label: "a", configDir: f.configDir, command: f.command,
    beforeState: async () => { if (++preparing === 3) release(); await barrier; },
    assertStopped: async () => { await new Promise(resolve => setTimeout(resolve, 100)); await f.assertStopped(); },
    readBinding: async () => ({ protected: true, accountUuid: A, profileRef: "proxy-a",
      expectedEmail: "synthetic@example.invalid", credential: f.credential }) };
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => acquireClaudeStateGuard(args)));
  const guards = results.filter(r => r.status === "fulfilled").map(r => r.value);
  t.after(() => Promise.all(guards.map(g => g.release())));
  assert.equal(guards.length, 3, results.filter(r => r.status === "rejected").map(r => r.reason.message).join("; "));
  assert.ok(guards.every(g => !g.exclusive)); assert.equal(f.checks(), 1);
  assert.equal(read(path.join(f.configDir, ".claude.json")).oauthAccount.accountUuid, A);
  await assert.rejects(acquireClaudeAssignmentLock(f.userHomeDir, "a", { exclusive: true }), /lock is unavailable/);
});


test("a second launch joins while optional stopped cleanup briefly owns EX", async t => {
  const f = await fixture(t); await migrateClaudePrivateState(f); await f.guard.release();
  const settings = path.join(f.userHomeDir, ".aim-claude-settings-00000000-0000-4000-8000-000000000001.json");
  write(settings, {});
  const scratch = fs.mkdtempSync(path.join(f.configDir, ".aim-private-runtime-"));
  retainClaudeLaunchFiles({ configDir: f.configDir, settings, scratch });
  let entered, release;
  const scanning = new Promise(resolve => { entered = resolve; });
  const continueScan = new Promise(resolve => { release = resolve; });
  const args = { homeDir: f.userHomeDir, label: "a", configDir: f.configDir, command: f.command,
    assertStopped: async () => { entered(); await continueScan; },
    readBinding: async () => ({ protected: true, accountUuid: A, profileRef: "proxy-a",
      expectedEmail: "synthetic@example.invalid", credential: f.credential }) };
  const first = acquireClaudeStateGuard(args); await scanning;
  const second = acquireClaudeStateGuard(args); let joined = false;
  second.then(() => { joined = true; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(joined, false);
  release(); const guards = await Promise.all([first, second]);
  t.after(() => Promise.all(guards.map(g => g.release())));
  assert.ok(guards.every(g => !g.exclusive)); assert.equal(fs.existsSync(settings), false);
});

for (const protectedAccount of [false, true]) {
  test(`launch and resume admission survive pre-reboot launch records (protected=${protectedAccount})`, async t => {
    const f = await fixture(t); await migrateClaudePrivateState(f); await f.guard.release();
    const settings = path.join(f.userHomeDir, ".aim-claude-settings-00000000-0000-4000-8000-000000000001.json");
    write(settings, { keep: true });
    const scratch = fs.mkdtempSync(path.join(f.configDir, ".aim-private-runtime-"));
    retainClaudeLaunchFiles({ configDir: f.configDir, settings, scratch });
    const directory = path.join(path.dirname(f.configDir), ".privacy-launches");
    const receipt = path.join(directory, fs.readdirSync(directory)[0]);
    const recorded = read(receipt);
    recorded.settings.dev += 1; recorded.scratch.dev += 1; write(receipt, recorded);
    const checksBefore = f.checks();

    const guard = await acquireClaudeStateGuard({ homeDir: f.userHomeDir, label: "a", configDir: f.configDir,
      command: f.command, assertStopped: f.assertStopped,
      readBinding: async () => ({ protected: protectedAccount, accountUuid: A,
        expectedEmail: "synthetic@example.invalid", credential: f.credential }) });
    t.after(() => guard.release());

    assert.equal(guard.exclusive, false); guard.assertOwned();
    assert.equal(f.checks(), checksBefore + 1, "cleanup still requires stopped-owner proof");
    assert.deepEqual(read(settings), { keep: true }); assert.ok(fs.existsSync(scratch));
    assert.deepEqual(read(receipt), recorded);
  });
}
