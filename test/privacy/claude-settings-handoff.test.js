import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeClaudePrivacySettings } from "../../src/privacy/claude-settings.js";
import { stageClaudeSettingsSnapshot, claudeArgsWithSettingsSnapshot, claudeMacSettingsValidationPolicy } from "../../src/privacy/claude-settings-handoff.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-settings-transfer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "original.json");
  fs.writeFileSync(original, JSON.stringify({ env: { REQUIRED_MCP_TOKEN: "synthetic-private" },
    sandbox: { filesystem: { allowRead: ["relative/**/", "~/keep"] } } }));
  return { root, original, composition: composeClaudePrivacySettings({ cwd: root, protectedAccount: true, args: ["--settings", original] }) };
}

test("snapshot preserves source directory, original file, private bytes and argument delimiter", t => {
  const { root, original, composition } = fixture(t);
  const before = fs.readFileSync(original, "utf8");
  const snapshot = stageClaudeSettingsSnapshot(composition);
  assert.equal(path.dirname(snapshot.file), root);
  assert.notEqual(snapshot.file, original);
  assert.equal(fs.statSync(snapshot.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(snapshot.file, "utf8"), composition.serialized);
  assert.equal(fs.readFileSync(original, "utf8"), before);
  composition.serialized = null;
  composition.settings = null;
  snapshot.assertUnchanged();
  assert.deepEqual(claudeArgsWithSettingsSnapshot(["-p", "--", "literal prompt"], snapshot),
    ["--settings", snapshot.file, "-p", "--", "literal prompt"]);
  assert.deepEqual(claudeArgsWithSettingsSnapshot(["--append-system-prompt", "--", "-p", "work"], snapshot),
    ["--settings", snapshot.file, "--append-system-prompt", "--", "-p", "work"]);
  for (const args of [["--model"], ["--settings"]]) assert.throws(() => claudeArgsWithSettingsSnapshot(args, snapshot), /required argument/);
  snapshot.dispose();
  assert.equal(fs.existsSync(snapshot.file), false);
  assert.equal(fs.readFileSync(original, "utf8"), before);
});

test("handoff keeps short clusters, child literal values and both native settings readers safe", () => {
  const snapshot = { file: "/private/synthetic-snapshot.json" };
  for (const args of [["-pn", "--", "prompt"], ["-pn", "--rc"],
    ["--", "mcp", "list"], ["mcp", "add", "server", "https://example.invalid", "--client-id", "--settings"]]) {
    assert.deepEqual(claudeArgsWithSettingsSnapshot(args, snapshot), ["--settings", snapshot.file, ...args]);
  }
  assert.deepEqual(claudeArgsWithSettingsSnapshot(["-p-settings", '{"ignored":"native"}'], snapshot),
    ["--settings", snapshot.file, "-p-settings", snapshot.file]);
  assert.deepEqual(claudeArgsWithSettingsSnapshot(["-p-settings={}"], snapshot),
    ["--settings", snapshot.file, "-p-settings=" + snapshot.file]);
  assert.throws(() => claudeArgsWithSettingsSnapshot(["--settings", "shadowed", "agents", "--settings={}"], snapshot), /detached Claude sessions/);
});

test("a failed private write removes its partial snapshot without touching the source", t => {
  const { root, composition, original } = fixture(t);
  const before = fs.readFileSync(original, "utf8");
  for (const failedOperation of ["fsyncSync", "fstatSync"]) {
    const io = new Proxy(fs, { get(target, key) {
      return key === failedOperation ? () => { throw new Error("synthetic disk failure"); } : target[key];
    } });
    assert.throws(() => stageClaudeSettingsSnapshot(composition, { fsImpl: io }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
    assert.deepEqual(fs.readdirSync(root), ["original.json"]);
  }
  assert.equal(fs.readFileSync(original, "utf8"), before);
});

test("handoff refuses rewrites that reveal Remote Control or a hidden eager settings source", () => {
  const snapshot = { file: "/private/synthetic-snapshot.json" };
  for (const args of [
    ["-p-settings", "-p", "rc"],
    ["-p-settings", "--", "mcp", "add", "--client-id", "--settings", "server-name", "command"],
    ["-p-settings", "cc://synthetic", "agents"],
    ["--settings", "/tmp/original.json", "-p-settings", "--restricted"],
    ["remote-control"],
  ]) assert.throws(() => claudeArgsWithSettingsSnapshot(args, snapshot), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("changed contents, substituted inode, and public permissions refuse before launch", t => {
  const { composition } = fixture(t);
  for (const change of [file => fs.writeFileSync(file, "{}"), file => fs.chmodSync(file, 0o644),
    file => { const data = fs.readFileSync(file); fs.renameSync(file, file + ".old"); fs.writeFileSync(file, data, { mode: 0o600 }); }]) {
    const snapshot = stageClaudeSettingsSnapshot(composition);
    change(snapshot.file);
    assert.throws(() => snapshot.assertUnchanged(), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
    snapshot.dispose();
  }
});

test("inline snapshot stays directly in the native temp origin", t => {
  const { root } = fixture(t);
  const directory = path.join(root, "native-temp/claude-999");
  const composition = composeClaudePrivacySettings({ cwd: root, protectedAccount: false, nativeTempDirectory: directory,
    args: ["--settings", '{"permissions":{"allow":["Read(/relative/**)"]}}'] });
  const snapshot = stageClaudeSettingsSnapshot(composition);
  assert.equal(path.dirname(snapshot.file), directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot.file)).permissions.allow, ["Read(/relative/**)"]);
  snapshot.dispose();
  const alias = path.join(root, "temp-alias"); fs.symlinkSync(directory, alias);
  assert.throws(() => stageClaudeSettingsSnapshot({ ...composition, source: { ...composition.source, directory: alias } }),
    { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("nested snapshots reuse a pinned private origin but cannot accept insecure permissions", t => {
  const { root } = fixture(t);
  const directory = path.join(root, "native-temp");
  fs.mkdirSync(directory, { mode: 0o700 });
  const composition = composeClaudePrivacySettings({ cwd: root, protectedAccount: false,
    nativeTempDirectory: directory, args: ["--settings", "{}"] });
  const io = new Proxy(fs, { get(target, key) {
    return key === "fchmodSync" ? () => { throw Object.assign(new Error("pinned origin"), { code: "EACCES" }); } : target[key];
  } });
  const snapshot = stageClaudeSettingsSnapshot(composition, { fsImpl: io });
  snapshot.assertUnchanged(); snapshot.dispose();
  fs.chmodSync(directory, 0o755);
  assert.throws(() => stageClaudeSettingsSnapshot(composition, { fsImpl: io }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("Mac validation policy escapes exact paths and never grants input-parent writes", t => {
  const { root } = fixture(t);
  const inputDirectory = path.join(root, 'input with "quotes"');
  const values = { vendor: path.join(root, "claude"), settingsFile: path.join(inputDirectory, "settings.json"), scratch: path.join(root, "scratch") };
  fs.mkdirSync(inputDirectory); fs.mkdirSync(values.scratch);
  fs.writeFileSync(values.settingsFile, "{}"); fs.writeFileSync(values.vendor, "synthetic");
  const policy = claudeMacSettingsValidationPolicy(values);
  assert.ok(policy.includes('input with \\"quotes\\"'));
  assert.ok(policy.includes('(deny network*)'));
  assert.ok(policy.includes('(deny mach-lookup)'));
  assert.equal(policy.includes(`(subpath "${root}/input`), false);
  assert.throws(() => claudeMacSettingsValidationPolicy({ ...values, scratch: root }), /overlap/);
  assert.throws(() => claudeMacSettingsValidationPolicy({ ...values, scratch: values.scratch + "/" }), /canonical/);
  const alias = path.join(root, "scratch-alias"); fs.symlinkSync(values.scratch, alias);
  assert.throws(() => claudeMacSettingsValidationPolicy({ ...values, scratch: alias }), /canonical/);
  assert.throws(() => claudeMacSettingsValidationPolicy({ ...values, settingsFile: "/private/\ninvalid" }), /paths/);
});
