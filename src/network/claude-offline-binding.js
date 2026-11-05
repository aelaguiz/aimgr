import { claudeEgressPolicy } from "./claude-egress-policy.js";
import fs from "node:fs";
import path from "node:path";
import { acquireAccountAssignmentLock } from "./assignment-lock.js";

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
export function acquireClaudeAssignmentLock(homeDir, label, options = {}) {
  return acquireAccountAssignmentLock(bindingPath(homeDir, label), { ...options, label });
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
