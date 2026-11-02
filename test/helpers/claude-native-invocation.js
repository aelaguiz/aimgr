// Synthetic process/transport tests exercise runner lifecycle independently of
// offsite native admission. This adapter exists only under test/: it never
// executes Claude, grants normal-use approval or bypasses production admission.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stageClaudeLaunchEnvironment } from "../../src/privacy/claude-launch-inputs.js";

export const verifySyntheticExecutable = async ({ command }) => fs.realpathSync(command);
export function resolveSyntheticSecurityAdapter({ userHomeDir }) {
  const shimPath = fs.realpathSync(path.join(userHomeDir, ".aimgr/runtime/claude-file-store/security"));
  return { shimPath, adapterDir: path.dirname(shimPath) };
}
export async function prepareSyntheticNativeInvocation({ preparedLaunch, args, env }) {
  let fd = stageClaudeLaunchEnvironment(env, os.tmpdir());
  return { command: preparedLaunch.command, vendorCommand: preparedLaunch.command, args, environment: env,
    environmentFd: fd, markStarted() {}, disposeBeforeStart() {},
    closeEnvironment() { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } } };
}
export function spawnSyntheticSupervisor(command, args, options) {
  // The production supervisor accepts only immutable /opt native entries.
  // Strip its native-only marker for this ordinary synthetic Node child; its
  // normal IPC/lock lifetime remains real, and the vendor gets only fd0..2.
  if (args[1] !== "--privacy-entry-v1") throw new Error("synthetic test lost the native-entry handoff");
  return spawn(command, [args[0], ...args.slice(2)], options);
}
