/** Offsite-only check of actual immutable machine sources and native doctor.
 * The outer root fixture owns/restores machine files; this child never edits
 * them. All settings/auth are synthetic, and native validation has no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { composeClaudePrivacySettings } from "../src/privacy/claude-settings.js";
import { stageClaudeSettingsSnapshot } from "../src/privacy/claude-settings-handoff.js";
import { inspectClaudeManagedPolicy } from "../src/privacy/claude-managed-policy.js";
import { validateClaudeSettingsSnapshot } from "../src/privacy/claude-settings-validation-runner.js";
const work = "/opt/aimgr-state-audit/claude-implementation";
assert.ok(fs.statSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST").isFile());
assert.notEqual(process.getuid(), 0);
const candidate = JSON.parse(fs.readFileSync(path.join(work, `${process.platform === "darwin" ? "mac" : "linux"}-candidate-staging/installed.json`)));
const root = fs.mkdtempSync(path.join(work, "managed-native-check-"));
let snapshot = stageClaudeSettingsSnapshot(composeClaudePrivacySettings({ cwd: root, protectedAccount: true, nativeTempDirectory: root, defaultFlagSettings: process.argv.includes("--invalid-flag") ? { model: {} } : {} }));
// Deliberate native-parser negatives: bypass only the fixture's serializer,
// while preserving exact-byte assertion. Real preparation never emits these.
const invalidKind = process.argv.find(arg => arg.startsWith("--invalid-kind="))?.split("=")[1];
if (invalidKind) {
  const current = JSON.parse(fs.readFileSync(snapshot.file, "utf8"));
  if (invalidKind === "remote") current.disableRemoteControl = {};
  else if (invalidKind === "env") current.env.DISABLE_GROWTHBOOK = {};
  else assert.equal(invalidKind, "malformed");
  const raw = invalidKind === "malformed" ? '{"synthetic":' : JSON.stringify(current);
  fs.writeFileSync(snapshot.file, raw);
  const original = snapshot;
  snapshot = { file: original.file, digest: crypto.createHash("sha256").update(raw).digest("hex"),
    assertUnchanged() { assert.equal(fs.readFileSync(original.file, "utf8"), raw); }, dispose: original.dispose };
}
let phase = "source-admission";
const report = { platform: process.platform, artifactSet: candidate.artifactSet, fixture: root };
try {
  const managedPolicy = inspectClaudeManagedPolicy({ protectedAccount: true });
  const inputs = { snapshot, expected: { version: "2.1.317", commit: "3d3e7cb16b55", platform: process.platform,
    arch: process.arch, entrypoint: path.join(candidate.root, "claude") }, nativeLauncher: path.join(candidate.root, "launcher"), scratchParent: root,
    spawnImpl(command, args, options) {
      const child = spawn(command, args, options);
      const file = path.join(root, phase + ".private.txt");
      fs.writeFileSync(file, "spawn attempted\n", { mode: 0o600 });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => fs.appendFileSync(file, chunk, { mode: 0o600 }));
      child.on("error", error => fs.appendFileSync(file, `spawn error ${error.code}\n`));
      child.on("close", (code, signal) => fs.appendFileSync(file, `close ${code} ${signal}\n`));
      return child;
    } };
  phase = "snapshot-validation";
  if (!process.argv.includes("--machine-only")) await validateClaudeSettingsSnapshot(inputs);
  phase = "machine-policy-validation";
  await validateClaudeSettingsSnapshot({ ...inputs, managedPolicy });
  Object.assign(report, { accepted: true, sourceCount: managedPolicy.sourceCount });
} catch (error) {
  assert.equal(error.code, "AIMGR_CLAUDE_PRIVACY_SETTINGS");
  Object.assign(report, { accepted: false, refusedAt: phase, diagnostic: error.message });
} finally { snapshot.dispose(); }
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
