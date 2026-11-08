import { claudeEgressPolicy } from "./claude-egress-policy.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function bindingPath(homeDir, label) {
  return path.join(homeDir, ".aimgr", "claude-egress", `${encodeURIComponent(label)}.json`);
}

// Per-account files keep unrelated stale local-state writers from restoring
// a route invalidated by reassignment. These contain no credentials.
export function readClaudeOfflineBinding(homeDir, label) {
  try { return JSON.parse(fs.readFileSync(bindingPath(homeDir, label), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function writeClaudeOfflineBinding(homeDir, label, binding) {
  const file = bindingPath(homeDir, label);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(binding) + "\n", { mode: 0o600 });
  fs.renameSync(staged, file);
}

export function invalidateClaudeOfflineBinding(homeDir, label) {
  // Keep the opt-in even when the usable assignment is invalidated. Absence
  // means a legacy cache, so deleting this file would silently disable privacy.
  writeClaudeOfflineBinding(homeDir, label, { required: true, invalidated: true });
}

// T04/T16/T23: the lock belongs to AIM's open file description, not a live
// helper. An async "helper died" event cannot protect synchronous migration:
// the helper could release EX while JS is still writing and cannot handle the
// event. Pass our already-open FD to the short OS helper; flock on a dup/fork
// reference survives helper exit until the last reference closes. Never unlink
// this inode or explicitly LOCK_UN it: either would defeat another holder.
// SH permits concurrent sessions; EX is nonwaiting and only for transitions.
export async function acquireClaudeAssignmentLock(homeDir, label, {
  exclusive = false, platform = process.platform, spawnImpl = spawn, acquireTimeoutMs = 5_000,
  waitForTransition = false,
} = {}) {
  const file = bindingPath(homeDir, label);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const lost = new Error(`Claude ${label}: local assignment lock is unavailable; stop affected work before changing its proxy.`);
  const busy = Object.assign(new Error(lost.message), { code: "AIMGR_CLAUDE_ASSIGNMENT_BUSY" });
  const lockPath = `${file}.lock`;
  let fd, identity;
  const assertOwned = () => {
    try {
      controller.signal.throwIfAborted();
      const current = fs.fstatSync(fd), named = fs.lstatSync(lockPath);
      if (!current.isFile() || current.nlink !== 1 || current.uid !== process.getuid()
        || current.mode & 0o077 || named.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino
        || named.dev !== current.dev || named.ino !== current.ino) throw lost;
    } catch {
      controller.abort(lost);
      throw lost;
    }
  };
  try {
    if (!["darwin", "linux"].includes(platform) || !Number.isInteger(acquireTimeoutMs)
      || acquireTimeoutMs < 1 || acquireTimeoutMs > 30_000) throw lost;
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    identity = fs.fstatSync(fd);
    if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid()) throw lost;
    // Earlier helpers created this same empty coordination inode with umask
    // permissions (usually 0644). Tighten it in place: O_CREAT's mode does not
    // change an existing file, and replacing it would split live flock owners.
    fs.fchmodSync(fd, 0o600);
    assertOwned();
    const command = platform === "darwin" ? "/usr/bin/python3" : "/usr/bin/flock";
    // A launch may briefly wait for a stopped identity/retention transition.
    // Only SH can wait; EX must never queue behind a whole live session. The
    // helper deadline below bounds this wait and reaps it before releasing FD.
    const wait = !exclusive && waitForTransition === true;
    const args = platform === "darwin"
      ? ["-I", "-S", "-c", `import fcntl,sys,time
while True:
 try:
  fcntl.flock(3,(fcntl.LOCK_EX if sys.argv[1]=="exclusive" else fcntl.LOCK_SH)|fcntl.LOCK_NB)
  break
 except BlockingIOError:
  if sys.argv[2]!="wait": sys.exit(75)
  time.sleep(.025)`, exclusive ? "exclusive" : "shared", wait ? "wait" : "nowait"]
      : [exclusive ? "--exclusive" : "--shared", "--conflict-exit-code", "75", ...(wait ? [] : ["--nonblock"]), "3"];
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "ignore", "ignore", fd], shell: false,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    await new Promise((resolve, reject) => {
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, acquireTimeoutMs);
      // Reap even a failed/timed-out helper BEFORE closing the parent's FD.
      // Otherwise it could acquire a lock after we reported failure.
      child.once("error", () => { failed = true; });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (!failed && code === 0 && !signal) resolve();
        else reject(!failed && code === 75 && !signal ? busy : lost);
      });
    });
    assertOwned();
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    controller.abort(lost);
    throw error === busy ? busy : lost;
  }
  return {
    // The trusted launch supervisor may inherit this coordination descriptor
    // to cover parent death between fork and final admission. It contains no
    // credentials. Passing it is separate from granting any vendor file root.
    fd,
    exclusive,
    signal: controller.signal,
    assertOwned,
    async release() {
      if (fd === undefined) return;
      const closing = fd; fd = undefined;
      controller.abort(lost);
      fs.closeSync(closing);
    },
  };
}

// Remember opt-in before any credentials can enter the managed offline cache,
// even when this machine's proxy configuration has not been installed yet.
export function rememberClaudeProtection(homeDir, label, account) {
  let binding = readClaudeOfflineBinding(homeDir, label);
  // The local-authority runtime also caches direct account identity/version.
  // Only that known metadata shape is route-neutral; old required, invalidated
  // or malformed assignment markers must continue to refuse direct fallback.
  const directMetadata = binding && !Object.hasOwn(binding, "egress") && !Object.hasOwn(binding, "required")
    && !Object.hasOwn(binding, "invalidated") && binding.identity?.accountUuid && binding.identity?.organizationUuid
    && Number.isInteger(binding.version) && binding.version > 0;
  if ((!binding || directMetadata) && claudeEgressPolicy(account) !== undefined) {
    invalidateClaudeOfflineBinding(homeDir, label);
    binding = readClaudeOfflineBinding(homeDir, label);
  } else if (directMetadata) {
    return null;
  }
  return binding;
}
