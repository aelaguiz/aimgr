/** Offsite integration of the real JS snapshot -> native isolated doctor.
 * No auth, provider route or normal-use approval is supplied by this fixture.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { composeClaudePrivacySettings } from "../src/privacy/claude-settings.js";
import { stageClaudeSettingsSnapshot } from "../src/privacy/claude-settings-handoff.js";
import { validateClaudeSettingsSnapshot } from "../src/privacy/claude-settings-validation-runner.js";

const base = "/opt/aimgr-state-audit", work = path.join(base, "claude-implementation");
assert.ok(fs.statSync(path.join(base, "OFFSITE_AUDIT_HOST")).isFile());
assert.notEqual(process.getuid(), 0);
const platform = process.platform;
assert.ok(["linux", "darwin"].includes(platform));
const candidate = JSON.parse(fs.readFileSync(path.join(work, `${platform === "darwin" ? "mac" : "linux"}-candidate-staging/installed.json`), "utf8"));
const vendor = path.join(candidate.root, "claude"), launcher = path.join(candidate.root, "launcher");
const expectedHash = platform === "darwin" ? "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9" : "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0";
const digest = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(vendor)) digest.update(chunk);
assert.equal(digest.digest("hex"), expectedHash);
const root = fs.mkdtempSync(path.join(work, "candidate-js-validator-"));
const composed = composeClaudePrivacySettings({ cwd: root, protectedAccount: true, nativeTempDirectory: root });
const snapshot = stageClaudeSettingsSnapshot(composed);
try {
  const result = await validateClaudeSettingsSnapshot({ snapshot,
    expected: { version: "2.1.317", commit: "3d3e7cb16b55", platform, arch: process.arch, entrypoint: vendor },
    nativeLauncher: launcher, scratchParent: root });
  const report = { platform, artifactSet: candidate.artifactSet, ...result, scope: "Actual JS/native validator integration only" };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, fixture: root }));
} finally { snapshot.dispose(); }
