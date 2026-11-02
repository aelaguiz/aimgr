import { ClaudePrivacySettingsError } from "./claude-settings.js";

const RECEIPT = "Remote Control is disabled by your organization's policy (managed setting disableRemoteControl).";
const FOOTER = "For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.";
const NO_AUTH = "Managed settings (remote): not fetched — no usable credentials for the settings fetch";
const NO_POLICY_AUTH = "Organization policy: not fetched: no API key or claude.ai sign-in for the policy lookup (apiKeyHelper keys are not used for it)";
export const CLAUDE_SOURCE_MARKER = "0";
const fail = () => { throw new ClaudePrivacySettingsError("the isolated native settings check did not confirm the complete privacy settings"); };

export function assertClaudeSettingsDoctorIdentity(expected) {
  if (!expected || typeof expected.version !== "string" || !/^\d+\.\d+\.\d+$/.test(expected.version)
    || typeof expected.commit !== "string" || !/^[0-9a-f]{12}$/.test(expected.commit)
    || !["linux", "darwin"].includes(expected.platform) || !["x64", "arm64"].includes(expected.arch)
    || typeof expected.entrypoint !== "string" || !expected.entrypoint.startsWith("/")
    || /[\r\n\x00]/.test(expected.entrypoint)) fail();
}

/** Check the pinned native validator's positive receipt, never just exit zero.
 *
 * T08: both audited binaries continue after rejecting an entire --settings
 * object; that silently discards the critical overrides. Mac doctor can also
 * exit zero without printing ANY report when a diagnostic helper cannot start.
 * These are refusal cases, not successful validation.
 *
 * This checks a result, not its execution boundary. The caller must first admit
 * the exact immutable binary, run doctor without provider credentials in a
 * network/file/service-restricted child with the admitted machine sources,
 * close unintended descriptors, and pass the same immutable settings bytes
 * to the eventual launch. In this build flag-source diagnostics are reported
 * independently of machine-tier selection. Rejecting those diagnostics is
 * essential: a machine policy can itself supply the Remote Control receipt.
 * No result here authorizes skipping those requirements.
 *
 * Diagnostics may contain user paths or settings values. Never attach the raw
 * output to the error, logs, status, or returned value. Compare the full result
 * in memory, then discard it. Re-audit this contract for every approved build.
 */
export function assertClaudeSettingsDoctorResult(result, expected, { managedPolicy = false, sourceAcceptance = false } = {}) {
  assertClaudeSettingsDoctorIdentity(expected);
  if (!result || !expected || result.status !== 0 || result.signal != null || result.error != null
    || typeof result.stdout !== "string" || typeof result.stderr !== "string"
    || result.stderr.trim() !== "" || Buffer.byteLength(result.stdout) > 1024 * 1024) fail();
  const output = result.stdout;
  if (output.includes("\x1b") || /unknown option|error:/i.test(output)
    || (!sourceAcceptance && /Invalid settings/i.test(output))) fail();
  // In the pinned doctor's settings-diagnostic position, statusOnly notices
  // are plain '- message' paragraphs with NO 'Invalid settings' heading.
  // They include tolerant-schema substitution/ignored policy. Reject them in
  // the machine-source pass; ordinary diagnostics after Remote Control (such
  // as the intentionally denied Keychain probe) are a separate section.
  if (managedPolicy && output.split("\nRemote Control\n")[0].split(/\r?\n/)
    .some(line => /^\s*- /.test(line))) fail();
  const lines = output.trimEnd().split(/\r?\n/);
  const once = value => lines.filter(line => line.trimEnd() === value).length === 1;
  if (lines[0] !== "Claude Code doctor" || lines.at(-1) !== FOOTER
    || !once(`Running: native (${expected.version})`) || !once(`Commit: ${expected.commit}`)
    || !once(`Platform: ${expected.platform}-${expected.arch}`) || !once(`Path: ${expected.entrypoint}`)
    || !once(NO_AUTH) || !once(NO_POLICY_AUTH) || (!sourceAcceptance && !once(RECEIPT))) fail();
  if (sourceAcceptance) {
    // Native's "Invalid settings" heading mixes fatal schema rejection and
    // nonfatal stripped-field warnings. Only a source that actually loaded
    // can apply this deliberate nonsecret env marker. The source checker
    // strips its original env and runs as the only flag source in a disposable
    // no-auth/no-network doctor; never use this mode for privacy admission.
    const marker = `- BASH_MAX_OUTPUT_LENGTH: Invalid value "${CLAUDE_SOURCE_MARKER}" (using default: 30000)`;
    const occurrences = lines.filter(line => line.startsWith("- BASH_MAX_OUTPUT_LENGTH: Invalid value"));
    if (occurrences.length > 1 || (occurrences.length && occurrences[0] !== marker)) fail();
    if (!occurrences.length) return false;
    const section = lines.indexOf("Environment variables"), position = lines.indexOf(marker);
    if (section < 0 || lines.lastIndexOf("Environment variables") !== section || position <= section
      || lines.slice(section + 1, position).some(line => line && !line.startsWith("- "))) fail();
    return true;
  }
}
