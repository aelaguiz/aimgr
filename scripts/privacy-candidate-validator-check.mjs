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
const expectedHash = platform === "darwin" ? "64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f" : "fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824";
const digest = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(vendor)) digest.update(chunk);
assert.equal(digest.digest("hex"), expectedHash);
const root = fs.mkdtempSync(path.join(work, "candidate-js-validator-"));
const composed = composeClaudePrivacySettings({ cwd: root, protectedAccount: true, nativeTempDirectory: root });
const snapshot = stageClaudeSettingsSnapshot(composed);
try {
  const result = await validateClaudeSettingsSnapshot({ snapshot,
    expected: { version: "2.1.316", commit: "cd7ceb459c68", platform, arch: process.arch, entrypoint: vendor },
    nativeLauncher: launcher, scratchParent: root });
  const report = { platform, artifactSet: candidate.artifactSet, ...result, scope: "Actual JS/native validator integration only" };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, fixture: root }));
} finally { snapshot.dispose(); }
