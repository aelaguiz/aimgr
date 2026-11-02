import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectClaudePrivacyStatus, formatClaudePrivacyStatus } from "../../src/privacy/claude-status.js";
import { admitClaudeArtifact, ClaudeAdmissionError, claudeInstalledVersionHint } from "../../src/privacy/claude-artifacts.js";
import { writeClaudeOfflineBinding } from "../../src/network/claude-offline-binding.js";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-privacy-status-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const command = path.join(home, "claude"), policy = path.join(home, "policy.json");
  fs.writeFileSync(command, `#!/bin/sh\ntouch '${home}/VENDOR_EXECUTED'\n`, { mode: 0o755 });
  fs.writeFileSync(policy, JSON.stringify({ testedKernelRelease: os.release() }));
  const artifact = { artifactSet: "a".repeat(64), version: "synthetic", vendorSha256: "b".repeat(64),
    platform: process.platform, arch: process.arch, privacyAbi: "claude-privacy-v1", approvalKind: "normal-use", policy };
  return { home, command, artifact, options: { command, homeDir: home, runtimeRoot: path.join(home, "runtime"),
    admit: () => artifact, inventory: () => ({ complete: true, processes: [{ pid: 123, artifactSet: artifact.artifactSet }] }) } };
}

test("status hashes selected bytes and reports admitted/running identity without executing the vendor", t => {
  const f = fixture(t), status = inspectClaudePrivacyStatus(f.options);
  assert.equal(status.selected.sha256, crypto.createHash("sha256").update(fs.readFileSync(f.command)).digest("hex"));
  assert.equal(status.approved.testedKernelRelease, os.release()); assert.equal(status.running.processes[0].pid, 123);
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
  assert.match(formatClaudePrivacyStatus(status), /Claude synthetic: approved for normal-use/);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(f.home));
});

test("a different or absent tested OS release is informational and does not refuse approval", t => {
  const f = fixture(t);
  for (const testedKernelRelease of ["different-from-" + os.release(), undefined]) {
    fs.writeFileSync(f.artifact.policy, JSON.stringify({ testedKernelRelease }));
    const status = inspectClaudePrivacyStatus(f.options);
    assert.equal(status.refusal, null);
    assert.equal(status.approved.testedKernelRelease, testedKernelRelease ?? null);
    assert.equal(Object.hasOwn(status.approved, "protectedOsCompatible"), false);
    assert.match(formatClaudePrivacyStatus(status), /informational; OS versions are not gated/);
    assert.doesNotMatch(formatClaudePrivacyStatus(status), /not verified for this OS|incompatible/);
  }
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
});

test("status reports admission refusal and incomplete inventory without printing malformed pins or policy details", t => {
  const f = fixture(t), pin = "PRIVATE_PIN_SECRET";
  const status = inspectClaudePrivacyStatus({ ...f.options, pinnedArtifactSet: pin,
    admit: () => { throw new ClaudeAdmissionError("the inherited approved build selection is invalid"); },
    inventory: () => { throw new Error("PRIVATE_PROCESS_SECRET"); } });
  assert.equal(status.pinnedArtifactSet, null); assert.equal(status.invalidInheritedPin, true);
  assert.equal(status.running.complete, false); assert.match(status.refusal.message, /inherited approved build selection/);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_/);
  fs.writeFileSync(f.artifact.policy, "PRIVATE_POLICY_SECRET");
  const broken = inspectClaudePrivacyStatus(f.options);
  assert.match(broken.refusal.message, /policy could not be inspected safely/);
  assert.doesNotMatch(JSON.stringify(broken), /PRIVATE_/);
});

test("unknown PATH selection still reports the valid approved build for comparison", t => {
  const f = fixture(t);
  const status = inspectClaudePrivacyStatus({ ...f.options, admit(inputs) {
    if (inputs.selectedCommand) throw new ClaudeAdmissionError("the selected Claude executable differs from the approved build");
    return f.artifact;
  } });
  assert.equal(status.approved.version, "synthetic"); assert.equal(status.approved.vendorSha256, f.artifact.vendorSha256);
  assert.match(status.refusal.message, /differs from the approved build/);
  assert.match(formatClaudePrivacyStatus(status), new RegExp("Approved executable: Claude synthetic, SHA-256 " + f.artifact.vendorSha256));
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
});

test("a missing runtime explains the installed version and installation repair without executing Claude", t => {
  const f = fixture(t), versioned = path.join(f.home, "2.1.999");
  fs.renameSync(f.command, versioned);
  fs.symlinkSync(versioned, f.command);
  const runtimeRoot = path.join(f.home, "missing-runtime");
  assert.throws(() => admitClaudeArtifact({ selectedCommand: f.command, runtimeRoot }), error => {
    assert.equal(error.code, "AIMGR_CLAUDE_BUILD_NOT_APPROVED");
    assert.match(error.message, /no approved runtime bundle is installed/);
    assert.match(error.message, /Selected Claude: 2\.1\.999 \(installation filename; not executed\)/);
    assert.match(error.message, /Approved Claude for this launch: none; runtime bundle missing/);
    assert.match(error.message, /Updating Claude alone will not fix this/);
    assert.equal(error.message.includes(f.home), false);
    return true;
  });
  const status = inspectClaudePrivacyStatus({ ...f.options, admit: () => {
    throw new ClaudeAdmissionError("no approved runtime bundle is installed on this machine");
  } });
  assert.equal(status.selected.versionHint, "2.1.999");
  assert.match(formatClaudePrivacyStatus(status), /Selected Claude version: 2\.1\.999 \(installation filename; not verified\)/);
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
});

test("version hints never echo arbitrary filenames or turn an installation label into approval", t => {
  const f = fixture(t);
  assert.equal(claudeInstalledVersionHint(f.command), null);
  const privateName = path.join(f.home, "2.1.999\nPRIVATE_FILENAME_SECRET");
  fs.renameSync(f.command, privateName); fs.symlinkSync(privateName, f.command);
  assert.equal(claudeInstalledVersionHint(f.command), null);
  assert.equal(claudeInstalledVersionHint("relative/2.1.999"), null);
  const status = inspectClaudePrivacyStatus(f.options);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_FILENAME_SECRET/);
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
});

test("account status uses only the current local protection binding; absent binding stays unknown", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, ".aimgr"));
  fs.writeFileSync(path.join(f.home, ".aimgr/secrets.json"), "PRIVATE_RETIRED_SECRET");
  const read = () => inspectClaudePrivacyStatus({ ...f.options, label: "account-a" });
  assert.equal(read().account.mode, "unknown");
  writeClaudeOfflineBinding(f.home, "account-a", { required: true, invalidated: true });
  assert.equal(read().account.mode, "protected");
  writeClaudeOfflineBinding(f.home, "account-a", { egress: { profileRef: "proxy5" } });
  assert.equal(read().account.mode, "protected");
  writeClaudeOfflineBinding(f.home, "account-a", {});
  assert.equal(read().account.mode, "unknown");
});

test("public status command works without Redis or credentials and never executes an unknown PATH binary", t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [new URL("../../bin/aimgr.js", import.meta.url).pathname,
    "claude", "privacy", "status", "--json"], {
    encoding: "utf8", timeout: 15000,
    env: { HOME: f.home, PATH: f.home + path.delimiter + "/usr/bin:/bin", AIMGR_HOME: f.home,
      REDIS_URL: "rediss://127.0.0.1:1", AIMGR_REDIS_URL: "rediss://127.0.0.1:1" },
  });
  assert.equal(result.status, 1, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.selected.available, true); assert.equal(status.refusal.code, "AIMGR_CLAUDE_BUILD_NOT_APPROVED");
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
  assert.doesNotMatch(result.stderr, /Redis|ECONNREFUSED|credential/i);
});

test("unreadable legacy version images make the process inventory incomplete", () => {
  const helper = new URL("../../native/claude/runtime_inventory.py", import.meta.url).pathname;
  const source = `import importlib.util,json,os,sys\nfrom unittest.mock import patch\nfrom types import SimpleNamespace\ns=importlib.util.spec_from_file_location('inventory',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nrows=f'123 {os.getuid()} /synthetic/claude/versions/2.1.316\\n124 {os.getuid()} /usr/bin/other\\n'\nwith patch.object(m.sys,'platform','linux'),patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=rows)),patch.object(m.os,'readlink',side_effect=PermissionError()):\n print(json.dumps(m.inventory()))\n`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", source, helper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { complete: false, unreadableOwners: 1, processes: [] });
});


test("public detached refusal precedes Redis and provider work", t => {
  const f = fixture(t);
  for (const args of [["--bg", "task"], ["daemon", "run"], ["agents"], ["attach", "synthetic"], ["-cn", "--bg"], ["mcp", "add", "--bg"]]) {
    const result = spawnSync(process.execPath, [new URL("../../bin/aimgr.js", import.meta.url).pathname,
      "claude", "run", "synthetic", "--", ...args], { encoding: "utf8", timeout: 10000,
      env: { HOME: f.home, PATH: f.home + path.delimiter + "/usr/bin:/bin", AIMGR_HOME: f.home,
        REDIS_URL: "rediss://127.0.0.1:1", AIMGR_REDIS_URL: "rediss://127.0.0.1:1" } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Claude was not started:.*(detached Claude sessions|daemon commands)/);
    assert.doesNotMatch(result.stderr, /Redis|ECONNREFUSED|credential/i);
    assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
  }
});

test("role display is conservative and never prints unknown role input", t => {
  const f = fixture(t), status = inspectClaudePrivacyStatus({ ...f.options, inventory: () => ({ complete: true,
    processes: ["detached-supervisor", "detached-worker", "session", "unknown", "PRIVATE_ARG"].map((role, i) => ({ pid: 200 + i, role, artifactSet: null })) }) });
  const display = formatClaudePrivacyStatus(status);
  assert.match(display, /PID 200: detached-session daemon/);
  assert.match(display, /PID 201: detached-session worker/);
  assert.match(display, /PID 202: session/);
  assert.match(display, /PID 204: role unknown/);
  assert.doesNotMatch(display, /PRIVATE_ARG/);
});

test("kernel argv role parser keeps values and environment out of role classification", () => {
  const helper = new URL("../../native/claude/runtime_inventory.py", import.meta.url).pathname;
  const code = String.raw`import importlib.util,struct,sys
s=importlib.util.spec_from_file_location('inventory',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for argv,role in [(['claude','daemon','run'],'detached-supervisor'), (['claude','--dangerously-skip-permissions','daemon','run'],'detached-supervisor'), (['claude','--bg-pty-host','private'],'detached-worker'), (['claude','-p','daemon','run'],'session'), (['claude','--name','--bg-spare'],'session'), (['claude','daemon'],'unknown'), (['claude','daemon','--origin','transient'],'unknown'), (['claude','--daemon-new-role'],'unknown'), ([], 'unknown')]:
 assert m.process_role(argv)==role
blob=struct.pack('i',3)+b'/private/claude\0\0claude\0-p\0private prompt\0PRIVATE_ENV=secret\0'
assert m.mac_argv(blob)==['claude','-p','private prompt']
try: m.mac_argv(struct.pack('i',8)+blob[4:])
except ValueError: pass
else: raise AssertionError('truncated argc accepted')
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", code, helper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Mac activation and Linux reclamation contract", () => {
  const result = spawnSync("/usr/bin/python3", ["-I", new URL("./claude-runtime-activation.py", import.meta.url).pathname], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});
