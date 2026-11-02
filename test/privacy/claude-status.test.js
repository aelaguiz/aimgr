import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectClaudePrivacyStatus, formatClaudePrivacyStatus } from "../../src/privacy/claude-status.js";
import { ClaudeAdmissionError } from "../../src/privacy/claude-artifacts.js";
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
  assert.equal(status.approved.protectedOsCompatible, true); assert.equal(status.running.processes[0].pid, 123);
  assert.equal(fs.existsSync(path.join(f.home, "VENDOR_EXECUTED")), false);
  assert.match(formatClaudePrivacyStatus(status), /Claude synthetic: approved for normal-use/);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(f.home));
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
