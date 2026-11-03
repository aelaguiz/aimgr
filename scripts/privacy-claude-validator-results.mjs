#!/usr/bin/env node
// Compare the production receipt checker against actual offsite native output.
// Raw diagnostics remain private; only case names and boolean results leave.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = "/opt/aimgr-state-audit/claude-implementation";
const root = path.resolve(process.argv[2] ?? "");
if (process.getuid() === 0 || path.dirname(root) !== base
  || !fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST")) {
  throw new Error("An unprivileged offsite fixture is required");
}
const { assertClaudeSettingsDoctorResult } = await import(pathToFileURL(path.join(base, "claude-settings-validator.js")));
const expected = { version: "2.1.317", commit: "3d3e7cb16b55", platform: process.platform,
  arch: process.arch, entrypoint: "/opt/aimgr-state-audit/bin/claude" };
const results = fs.readdirSync(root).filter(name => name.startsWith("doctor-before-")).sort().map(name => {
  const result = JSON.parse(fs.readFileSync(path.join(root, name, "result.private.json"), "utf8"));
  let accepted = true;
  try { assertClaudeSettingsDoctorResult(result, expected); } catch { accepted = false; }
  return { case: name, accepted, expectedAccepted: !name.endsWith("invalid"),
    configuredCodeRan: fs.existsSync(path.join(root, name, "configured-code-ran")), stderrEmpty: result.stderr === "" };
});
const passed = results.length === 7 && results.every(r => r.accepted === r.expectedAccepted && !r.configuredCodeRan && r.stderrEmpty);
const report = { platform: process.platform, passed, results };
fs.writeFileSync(path.join(root, "receipt-check.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = passed ? 0 : 1;
