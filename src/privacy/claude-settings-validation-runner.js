import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ClaudePrivacySettingsError } from "./claude-settings.js";
import { assertClaudeSettingsDoctorIdentity, assertClaudeSettingsDoctorResult } from "./claude-settings-validator.js";

const fail = () => { throw new ClaudePrivacySettingsError("the isolated native settings check could not complete safely"); };

/** Run the already admitted build's doctor in a disposable restricted child.
 *
 * T08: never run this on an unknown executable to discover its version. The
 * caller must admit the vendor, Linux helper and policy implementation first.
 * Expected identity comes from that approved record, never doctor output.
 * No real account home, auth projection, inherited FD, proxy or launch env is
 * passed here. Private settings may contain required third-party values; the
 * filesystem/service/network boundary keeps them inside this disposable check.
 *
 * The real launch must still enforce the snapshot's immutable path and keep
 * all common/account controls in place. A successful receipt is no substitute
 * for account/provider admission, conflicting managed-source inspection, or
 * those native protections. This helper installs no global settings.
 */
export async function validateClaudeSettingsSnapshot({
  snapshot, expected, nativeLauncher, scratchParent, managedPolicy,
  spawnImpl = spawn, sourceAcceptance = false,
} = {}) {
  let scratch, environmentFd;
  try {
    assertClaudeSettingsDoctorIdentity(expected);
    if (!snapshot || typeof snapshot.assertUnchanged !== "function"
      || !expected || expected.platform !== process.platform || expected.arch !== process.arch
      || !["linux", "darwin"].includes(process.platform)
      || !path.isAbsolute(expected.entrypoint ?? "") || !path.isAbsolute(scratchParent ?? "")) fail();
    snapshot.assertUnchanged();
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchParent, ".aim-settings-validation-")));
    fs.chmodSync(scratch, 0o700);
    const settingsFile = fs.realpathSync(snapshot.file);
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb", LANG: "C.UTF-8", NO_COLOR: "1",
      HOME: scratch, CLAUDE_CONFIG_DIR: scratch, CLAUDE_SECURESTORAGE_CONFIG_DIR: scratch,
      TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch,
      DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", DISABLE_GROWTHBOOK: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0", ENABLE_BETA_TRACING_DETAILED: "0" };
    // Node copies NODE_V8_COVERAGE from its own environment unless this own
    // property is present. Undefined omits it from the actual child envPairs.
    env.NODE_V8_COVERAGE = undefined;
    {
      // A nested AIM invocation inherits its parent's Seatbelt/AppArmor.
      // Only the admitted fixed entry may replace that policy. Its validate
      // role applies isolated doctor restrictions before vendor execution;
      // no caller policy, privileged payload or substitute command is accepted.
      if (!path.isAbsolute(nativeLauncher ?? "") || path.dirname(nativeLauncher) !== path.dirname(expected.entrypoint)
        || path.basename(nativeLauncher) !== "launcher") fail();
      const transfer = path.join(scratch, ".environment-transfer");
      environmentFd = fs.openSync(transfer, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.unlinkSync(transfer);
      fs.writeFileSync(environmentFd, Object.entries(env).filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}\0`).join(""));
    }
    const command = nativeLauncher;
    const reads = managedPolicy?.resolvedReadPaths ?? [];
    if (!Array.isArray(reads) || reads.length > 256 || reads.some(file => !path.isAbsolute(file))) fail();
    const args = ["v1", managedPolicy ? "validate-managed" : "validate", scratch, settingsFile, scratch,
      "3", String(reads.length), ...reads, "0", "--"];
    const result = await new Promise(resolve => {
      let child, timeout, failure, status = null, signal = null;
      const chunks = { stdout: [], stderr: [] };
      const bytes = { stdout: 0, stderr: 0 };
      const stopGroup = () => {
        if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if (error.code !== "ESRCH") { failure = true; child.kill?.("SIGKILL"); }
        }
      };
      // T08: execFile silently ignores detached on supported Node versions.
      // spawn establishes the real dedicated process group. Killing it at the
      // parent's exit also closes output held open by diagnostic descendants.
      child = spawnImpl(command, args, { cwd: scratch, env, shell: false,
        detached: true, stdio: ["ignore", "pipe", "pipe", ...(environmentFd !== undefined ? [environmentFd] : [])] });
      if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; }
      timeout = setTimeout(() => { failure = true; stopGroup(); }, 12000);
      for (const name of ["stdout", "stderr"]) {
        child[name].on("data", chunk => {
          bytes[name] += chunk.length;
          if (bytes[name] > 1024 * 1024) { failure = true; stopGroup(); return; }
          chunks[name].push(chunk);
        });
        child[name].on("error", () => { failure = true; stopGroup(); });
      }
      child.once("error", () => { failure = true; stopGroup(); });
      child.once("exit", (code, exitSignal) => { status = code; signal = exitSignal; stopGroup(); });
      child.once("close", () => {
        clearTimeout(timeout);
        // Wait for stdio closure before deleting the disposable scratch. No
        // raw diagnostic output is returned to callers or attached to errors.
        resolve({ status, signal, error: failure ? true : null,
          stdout: Buffer.concat(chunks.stdout).toString("utf8"),
          stderr: Buffer.concat(chunks.stderr).toString("utf8") });
      });
    });
    const sourceAccepted = assertClaudeSettingsDoctorResult(result, expected, { managedPolicy: Boolean(managedPolicy), sourceAcceptance });
    snapshot.assertUnchanged();
    return Object.freeze(sourceAcceptance ? { sourceAccepted, settingsDigest: snapshot.digest }
      : { validated: true, settingsDigest: snapshot.digest });
  } catch (error) {
    if (error instanceof ClaudePrivacySettingsError) throw error;
    fail();
  } finally {
    if (environmentFd !== undefined) fs.closeSync(environmentFd);
    if (scratch) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { fail(); }
    }
  }
}
