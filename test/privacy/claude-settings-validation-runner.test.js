import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { composeClaudePrivacySettings } from "../../src/privacy/claude-settings.js";
import { stageClaudeSettingsSnapshot } from "../../src/privacy/claude-settings-handoff.js";
import { validateClaudeSettingsSnapshot } from "../../src/privacy/claude-settings-validation-runner.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-validator-runner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "synthetic-never-executed"); fs.writeFileSync(vendor, "not executable");
  const composition = composeClaudePrivacySettings({ cwd: root, protectedAccount: true, nativeTempDirectory: path.join(root, "claude-999") });
  const snapshot = stageClaudeSettingsSnapshot(composition);
  const expected = { version: "2.1.316", commit: "cd7ceb459c68", platform: process.platform, arch: process.arch, entrypoint: vendor };
  const output = `Claude Code doctor\nRunning: native (${expected.version})\nCommit: ${expected.commit}\nPlatform: ${expected.platform}-${expected.arch}\nPath: ${vendor}\nManaged settings (remote): not fetched — no usable credentials for the settings fetch\nOrganization policy: not fetched: no API key or claude.ai sign-in for the policy lookup (apiKeyHelper keys are not used for it)\nRemote Control is disabled by your organization's policy (managed setting disableRemoteControl).\nFor a full setup checkup that can also fix issues, run /doctor in a Claude Code session.\n`;
  return { root, snapshot, expected, output, args: { snapshot, expected, scratchParent: root,
    nativeLauncher: path.join(root, "launcher") } };
}

function fakeChild(output, error, action = () => {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  process.nextTick(() => {
    action();
    child.stdout.emit("data", Buffer.from(output));
    if (error) child.stderr.emit("data", Buffer.from("PRIVATE_DIAGNOSTICS"));
    child.emit("exit", error ? 1 : 0, null); child.emit("close", error ? 1 : 0, null);
  });
  return child;
}

test("validation uses private scratch and a clean environment, then removes only scratch", async t => {
  const f = fixture(t); let scratch;
  const result = await validateClaudeSettingsSnapshot({ ...f.args,
    spawnImpl(command, args, options) {
      scratch = options.cwd;
      assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
      assert.equal(options.env.HOME, scratch);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, scratch);
      assert.equal(options.env.DISABLE_GROWTHBOOK, "1");
      for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTP_PROXY", "SSH_AUTH_SOCK"]) assert.equal(Object.hasOwn(options.env, key), false);
      assert.equal(Object.hasOwn(options.env, "NODE_V8_COVERAGE"), true);
      assert.equal(options.env.NODE_V8_COVERAGE, undefined);
      assert.equal(options.detached, true);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio.slice(0, 3), ["ignore", "pipe", "pipe"]);
      {
        assert.equal(command, f.args.nativeLauncher);
        assert.equal(options.stdio.length, 4);
        const transfer = fs.fstatSync(options.stdio[3]);
        assert.equal(transfer.nlink, 0);
        assert.equal(transfer.mode & 0o777, 0o600);
        assert.deepEqual(args.slice(-4), ["3", "0", "0", "--"]);
      }
      assert.ok(args.includes(fs.realpathSync(f.snapshot.file)));
      return fakeChild(f.output, null);
    } });
  assert.deepEqual(result, { validated: true, settingsDigest: f.snapshot.digest });
  assert.equal(fs.existsSync(scratch), false);
  f.snapshot.assertUnchanged();
});

test("bad identity refuses before execution; empty or failed diagnostics never validate", async t => {
  const f = fixture(t); let invoked = false;
  await assert.rejects(validateClaudeSettingsSnapshot({ ...f.args, expected: { ...f.expected, commit: "unknown" },
    spawnImpl() { invoked = true; } }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.equal(invoked, false);
  for (const error of [null, new Error("PRIVATE_DIAGNOSTICS")]) {
    let scratch;
    await assert.rejects(validateClaudeSettingsSnapshot({ ...f.args,
      spawnImpl(command, args, options) { scratch = options.cwd; return fakeChild("", error); }
    }), value => value.code === "AIMGR_CLAUDE_PRIVACY_SETTINGS" && !value.message.includes("PRIVATE_DIAGNOSTICS"));
    assert.equal(fs.existsSync(scratch), false);
  }
});

test("a changed snapshot cannot borrow a valid receipt", async t => {
  const f = fixture(t);
  await assert.rejects(validateClaudeSettingsSnapshot({ ...f.args,
    spawnImpl() { return fakeChild(f.output, null, () => fs.writeFileSync(f.snapshot.file, "{}")); }
  }), /snapshot changed/);
});

test("real process group cleanup kills a diagnostic descendant retaining the output pipe", async t => {
  const f = fixture(t);
  const childProgram = `const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e", "setInterval(()=>{},1000)"],{stdio:"inherit"});
    child.unref();process.stdout.write(${JSON.stringify(f.output)});process.exit(0);`;
  let pid;
  const result = await validateClaudeSettingsSnapshot({ ...f.args,
    spawnImpl(command, args, options) {
      const child = spawn(process.execPath, ["-e", childProgram], options); pid = child.pid; return child;
    } });
  assert.equal(result.validated, true);
  // The descendant held stdout open; close/validation could not complete if
  // the dedicated group's cleanup had only killed the direct child.
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
});

test("native spawn failure and excessive output refuse and remove scratch", async t => {
  const f = fixture(t);
  for (const command of ["missing", "overflow"]) {
    let scratch;
    await assert.rejects(validateClaudeSettingsSnapshot({ ...f.args,
      spawnImpl(unused, args, options) {
        scratch = options.cwd;
        return command === "missing" ? spawn(path.join(f.root, "absent"), [], options)
          : spawn(process.execPath, ["-e", 'process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000)'], options);
      } }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
    assert.equal(fs.existsSync(scratch), false);
  }
});
