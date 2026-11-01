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

// Linux flock is already an installer prerequisite. Shared locks preserve
// simultaneous cached sessions; reassignment takes an exclusive, nonwaiting
// lock before examining the cgroup/cache. Closing stdin releases the lock,
// including when the owning AIM process exits unexpectedly.
export async function acquireClaudeAssignmentLock(homeDir, label, { exclusive = false } = {}) {
  const file = bindingPath(homeDir, label);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const child = spawn("flock", [exclusive ? "--exclusive" : "--shared", "--nonblock", `${file}.lock`,
    process.execPath, "-e", 'process.stdout.write("locked\\n"); process.stdin.resume();'],
  { stdio: ["pipe", "pipe", "pipe"] });
  const controller = new AbortController();
  const lost = new Error(`Claude ${label}: local assignment lock is unavailable; stop affected work before changing its proxy.`);
  const exited = new Promise(resolve => child.once("close", resolve));
  child.once("exit", () => controller.abort(lost));
  child.stdin.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(lost));
      child.stdout.once("data", () => resolve());
    });
  } catch (error) { child.stdin.end(); await exited; throw error; }
  return {
    signal: controller.signal,
    assertOwned: () => controller.signal.throwIfAborted(),
    async release() { child.stdin.end(); await exited; },
  };
}

// Remember opt-in before any credentials can enter the managed offline cache,
// even when this machine's proxy configuration has not been installed yet.
export function rememberClaudeProtection(homeDir, label, account) {
  let binding = readClaudeOfflineBinding(homeDir, label);
  if (!binding && claudeEgressPolicy(account) !== undefined) {
    invalidateClaudeOfflineBinding(homeDir, label);
    binding = readClaudeOfflineBinding(homeDir, label);
  }
  return binding;
}
