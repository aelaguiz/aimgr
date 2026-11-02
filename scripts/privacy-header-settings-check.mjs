// Actual pinned native schema acceptance, entirely offsite and without auth or
// network. This checks the marker mechanism; it does not certify a live session.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { nativeClaudeHeaderSourceAccepted } from "../src/privacy/claude-session-headers.js";
const work = "/opt/aimgr-state-audit/claude-implementation";
assert.ok(fs.statSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST").isFile());
assert.notEqual(process.getuid(), 0);
const candidate = JSON.parse(fs.readFileSync(path.join(work,
  `${process.platform === "darwin" ? "mac" : "linux"}-candidate-staging/installed.json`)));
const root = fs.mkdtempSync(path.join(work, "header-schema-check-"));
fs.chmodSync(root, 0o700);
const helperMarker = path.join(root, "helper-ran");
const base = { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Synthetic: initial" } };
const cases = [
  ["valid", base, true],
  ["invalid-model", { ...base, model: {} }, false],
  ["remote-false-valid", { ...base, disableRemoteControl: false }, true],
  ["invalid-remote-object", { ...base, disableRemoteControl: {} }, false],
  ["stripped-managed-field", { ...base, forceLoginOrgUUID: "synthetic-org" }, true],
  ["unknown-field", { ...base, syntheticUnknown: { values: [1, 2] } }, true],
  ["helper-never-executed", { ...base, apiKeyHelper: "touch " + helperMarker }, true],
  ["invalid-helper-type", { ...base, apiKeyHelper: {} }, false],
  ["env-array-coercion", { env: { ANTHROPIC_CUSTOM_HEADERS: ["X-Synthetic: array"] } }, true],
  ["env-null-coercion", { env: { ANTHROPIC_CUSTOM_HEADERS: null } }, true],
  ["env-coercion-failure", { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Synthetic: initial", OTHER: { toString: null } } }, false],
  ["skipped-proto-key", JSON.parse('{"env":{"ANTHROPIC_CUSTOM_HEADERS":"X-Synthetic: initial","__proto__":{"toString":null}}}'), true],
];
const near = { env: { ANTHROPIC_CUSTOM_HEADERS: 0 }, syntheticPadding: "" };
near.syntheticPadding = "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(near)));
cases.push(["native-size-boundary", near, true]);
const results = [];
for (const [name, settings, expected] of cases) {
  let failure, accepted;
  try {
    accepted = await nativeClaudeHeaderSourceAccepted(settings, {
      expected: { version: "2.1.316", commit: "cd7ceb459c68", platform: process.platform,
        arch: process.arch, entrypoint: path.join(candidate.root, "claude") },
      nativeLauncher: path.join(candidate.root, "launcher"), scratchParent: root,
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options);
        const output = path.join(root, name + ".private.txt");
        fs.writeFileSync(output, "", { mode: 0o600 });
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => fs.appendFileSync(output, chunk));
        return child;
      },
    });
  } catch (error) { failure = error.code ?? "unexpected"; }
  results.push({ name, accepted, expected, ...(failure ? { failure } : {}), passed: !failure && accepted === expected });
}
const report = { platform: process.platform, nativeArtifactSet: candidate.artifactSet,
  helperExecuted: fs.existsSync(helperMarker), results,
  passed: results.every(result => result.passed) && !fs.existsSync(helperMarker) };
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...report, fixture: root }));
process.exitCode = report.passed ? 0 : 1;
