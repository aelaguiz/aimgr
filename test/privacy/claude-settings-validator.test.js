import assert from "node:assert/strict";
import test from "node:test";
import { assertClaudeSettingsDoctorResult } from "../../src/privacy/claude-settings-validator.js";

const expected = { version: "2.1.316", commit: "cd7ceb459c68", platform: "darwin", arch: "arm64", entrypoint: "/opt/synthetic/claude" };
// Structure and receipt wording taken from both actual no-auth doctor captures.
// The real offsite outputs remain private; paths and warnings below are fake.
const stdout = `Claude Code doctor

Running: native (2.1.316)
Commit: cd7ceb459c68
Platform: darwin-arm64
Path: /opt/synthetic/claude
Managed settings (remote): not fetched — no usable credentials for the settings fetch
Organization policy: not fetched: no API key or claude.ai sign-in for the policy lookup (apiKeyHelper keys are not used for it)

Remote Control
Remote Control is disabled by your organization's policy (managed setting disableRemoteControl).

1 warnings found
- macOS Keychain is not writable (synthetic denied service)

For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.
`;
const good = { status: 0, signal: null, stdout, stderr: "" };
const refused = value => assert.throws(() => assertClaudeSettingsDoctorResult(value, expected), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });

test("accepts the complete pinned receipt despite expected isolated-environment warnings", () => {
  assert.doesNotThrow(() => assertClaudeSettingsDoctorResult(good, expected));
  assert.doesNotThrow(() => assertClaudeSettingsDoctorResult({ ...good, stdout: stdout.replace("darwin-arm64", "linux-x64") },
    { ...expected, platform: "linux", arch: "x64" }));
});

test("empty exit-zero, incomplete output, timeout and process failure never validate", () => {
  for (const change of [{ stdout: "" }, { stdout: stdout.slice(0, -100) }, { status: null }, { status: 1 },
    { signal: "SIGKILL" }, { error: new Error("buffer limit") }, { stderr: "native failure" }, { stdout: stdout + "a".repeat(1024 * 1024) }]) refused({ ...good, ...change });
});

test("invalid settings refuse even if another source supplies a safe policy receipt", () => {
  for (const error of ["Invalid settings\n- input.json › model: Expected string, but received object", "error: settings could not be loaded", "unknown option --settings"]) {
    refused({ ...good, stdout: stdout.replace("Remote Control\n", error + "\nRemote Control\n") });
  }
  refused({ ...good, stdout: stdout.replace("Remote Control is disabled", "Remote Control might be disabled") });
});

test("managed-policy validation rejects native unheaded substitution notices", () => {
  assert.doesNotThrow(() => assertClaudeSettingsDoctorResult(good, expected, { managedPolicy: true }));
  const result = { ...good, stdout: stdout.replace("\nRemote Control\n", "\n- A managed value could not be applied as written.\n\nRemote Control\n") };
  assert.throws(() => assertClaudeSettingsDoctorResult(result, expected, { managedPolicy: true }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("wrong binary receipt or credentials in the validator refuse", () => {
  for (const [from, to] of [["2.1.316", "2.1.999"], ["cd7ceb459c68", "000000000000"], ["darwin-arm64", "darwin-x64"],
    ["/opt/synthetic/claude", "/mutable/claude"], ["no usable credentials for the settings fetch", "loaded"],
    ["no API key or claude.ai sign-in for the policy lookup", "account is eligible"]]) {
    refused({ ...good, stdout: stdout.replace(from, to) });
  }
  refused({ ...good, stdout: stdout.replace("Commit: cd7ceb459c68", "Commit: cd7ceb459c68\nCommit: cd7ceb459c68") });
});

test("refusal never exposes diagnostics containing a private value", () => {
  assert.throws(() => assertClaudeSettingsDoctorResult({ ...good, stderr: "PRIVATE_SETTING_VALUE" }, expected), error => {
    assert.equal(error.message.includes("PRIVATE_SETTING_VALUE"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("source acceptance uses the native env marker, including nonfatal settings warnings", () => {
  const marker = '- BASH_MAX_OUTPUT_LENGTH: Invalid value "0" (using default: 30000)';
  const loaded = { ...good, stdout: stdout.replace("\nRemote Control\n", `\nInvalid settings\n- a managed-only field was ignored\n\nRemote Control\n`)
    .replace("\n1 warnings found\n", `\nEnvironment variables\n${marker}\n\n1 warnings found\n`) };
  const options = { sourceAcceptance: true };
  assert.equal(assertClaudeSettingsDoctorResult(loaded, expected, options), true);
  assert.equal(assertClaudeSettingsDoctorResult({ ...loaded, stdout: loaded.stdout.replace(marker, "") }, expected, options), false);
  for (const broken of [loaded.stdout.replace(marker, marker + "\n" + marker), loaded.stdout.replace("Environment variables", "wrong section"),
    loaded.stdout.replace("default: 30000", "default: 9999"), loaded.stdout.replace("Commit: cd7ceb459c68", "Commit: unknown")]) {
    assert.throws(() => assertClaudeSettingsDoctorResult({ ...loaded, stdout: broken }, expected, options));
  }
});
