// Run explicitly on the designated outbound-denied test host. This component
// fixture executes only the two authorized native artifacts with synthetic
// settings; it cannot select real credentials or a real provider endpoint.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { composeClaudePrivacySettings } from "../../src/privacy/claude-settings.js";
import { stageClaudeSettingsSnapshot } from "../../src/privacy/claude-settings-handoff.js";
import { validateClaudeSettingsSnapshot } from "../../src/privacy/claude-settings-validation-runner.js";

const base = "/opt/aimgr-state-audit";
const root = path.resolve(process.argv[2] ?? "");
assert.ok(process.getuid() > 0 && fs.existsSync(`${base}/OFFSITE_AUDIT_HOST`));
assert.equal(path.dirname(root), `${base}/claude-implementation`);
assert.equal(fs.existsSync(root), false);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const vendor = `${base}/bin/claude`;
const approved = { linux: "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0",
  darwin: "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9" };
const digest = crypto.createHash("sha256");
for await (const block of fs.createReadStream(vendor)) digest.update(block);
assert.equal(digest.digest("hex"), approved[process.platform]);
const expected = { version: "2.1.317", commit: "3d3e7cb16b55", platform: process.platform,
  arch: process.arch, entrypoint: vendor };
process.umask(0o077); fs.mkdirSync(root, { mode: 0o700 });
const conflictsOnly = process.argv[4] === "conflicts";
const results = [];
for (const name of (conflictsOnly ? ["provider-env", "config-env"] : ["valid", "invalid-model", "env-coercion", "unknown", "hook", "helper", "invalid-permissions", "large-input"])) {
  const directory = path.join(root, name + ' input "quoted"'); fs.mkdirSync(directory);
  const original = path.join(directory, "original.json");
  const marker = path.join(directory, "configured-code-ran");
  const values = { model: "sonnet" };
  if (name === "provider-env") values.env = { ANTHROPIC_API_KEY: "sk-ant-synthetic-invalid-validator" };
  if (name === "config-env") values.env = { CLAUDE_CONFIG_DIR: path.join(directory, "unrelated-config") };
  if (name === "invalid-model") values.model = {};
  if (name === "env-coercion") values.env = { SYNTHETIC: [] };
  if (name === "unknown") values.syntheticUnknown = { retained: true };
  if (name === "large-input") values.syntheticUnknown = "x".repeat(1500 * 1024);
  if (name === "invalid-permissions") values.permissions = { allow: 7 };
  // JSON.stringify supplies a valid shell double-quoted path for this fixed
  // synthetic fixture; no substitutions or user-controlled text enter it.
  const command = `printf called > ${JSON.stringify(marker)}`;
  if (name === "hook") values.hooks = { SessionStart: [{ hooks: [{ type: "command", command }] }] };
  if (name === "helper") values.apiKeyHelper = command;
  const originalText = JSON.stringify(values); fs.writeFileSync(original, originalText);
  const composition = composeClaudePrivacySettings({ cwd: root, args: ["--settings", original], protectedAccount: true });
  const snapshot = stageClaudeSettingsSnapshot(composition);
  let accepted = false;
  try {
    await validateClaudeSettingsSnapshot({ snapshot, expected, scratchParent: root, nativeLauncher: process.argv[3],
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options), output = [], errors = [];
        child.stdout.on("data", chunk => output.push(chunk));
        child.stderr.on("data", chunk => errors.push(chunk));
        child.once("close", (status, signal) => {
          fs.writeFileSync(path.join(directory, "result.private.json"), JSON.stringify({ status, signal,
            stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }));
        });
        return child;
      } });
    accepted = true;
  } catch (error) { assert.equal(error.code, "AIMGR_CLAUDE_PRIVACY_SETTINGS"); }
  snapshot.assertUnchanged();
  assert.equal(fs.readFileSync(original, "utf8"), originalText);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readdirSync(root).some(file => file.startsWith(".aim-settings-validation-")), false);
  const expectedAccepted = !name.startsWith("invalid-") && name !== "provider-env";
  results.push({ name, accepted, expectedAccepted, sourceUnchanged: true, snapshotUnchanged: true, configuredCodeRan: false, scratchRemoved: true });
  snapshot.dispose();
}
const report = { platform: process.platform, passed: results.every(row => row.accepted === row.expectedAccepted), results,
  meaning: "Actual composed-settings staging and isolated native validation; not full session admission" };
fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
assert.equal(report.passed, true);
