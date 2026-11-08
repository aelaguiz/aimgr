import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { admitClaudeArtifact, CLAUDE_RUNTIME_ROOT, inspectClaudeAdministratorPath, claudeInstalledVersionHint } from "./claude-artifacts.js";
import { readClaudeOfflineBinding } from "../network/claude-offline-binding.js";
import { readClaudeEnvironment } from "./claude-environment.js";
import { readCachedClaudeAccountMetadata } from "../coordination/claude-runtime.js";
import { readLocalClaudeCredential } from "../credentials/claude-local.js";

function inspectSelection(command) {
  if (!command || !path.isAbsolute(command)) return { available: false };
  let fd;
  try {
    const file = fs.realpathSync(command);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { available: false };
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return { available: true, versionHint: claudeInstalledVersionHint(command), sha256: hash.digest("hex") };
  } catch { return { available: false }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Local status never initializes Redis, runs Claude, or contacts a provider.
 * Managed privacy applies independently of routing. Local readiness uses the
 * same environment-bound metadata and native owner reader as managed launch.
 */
export function inspectClaudePrivacyStatus({ command, homeDir, label, pinnedArtifactSet, environment,
  admit = admitClaudeArtifact, runtimeRoot = CLAUDE_RUNTIME_ROOT,
  inventory = () => JSON.parse(execFileSync("/usr/bin/python3", ["-I",
    fileURLToPath(new URL("../../native/claude/runtime_inventory.py", import.meta.url))],
  { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 })),
} = {}) {
  const result = { schema: 1, selected: inspectSelection(command), activeArtifactSet: null,
    pinnedArtifactSet: /^[a-f0-9]{64}$/.test(pinnedArtifactSet ?? "") ? pinnedArtifactSet : null,
    invalidInheritedPin: pinnedArtifactSet !== undefined && !/^[a-f0-9]{64}$/.test(pinnedArtifactSet), approved: null, refusal: null,
    privacy: { mode: "protected", source: "all managed Claude accounts" },
    running: { complete: false, processes: [] }, account: label ? { label, mode: "protected", source: "managed privacy policy",
      localAuth: "unavailable", routing: "unknown" } : null };
  try {
    const source = inspectClaudeAdministratorPath(path.join(runtimeRoot, "active.json"));
    const selector = source ? JSON.parse(source.bytes.toString("utf8")) : null;
    if (selector?.schema === 1 && /^[a-f0-9]{64}$/.test(selector.artifactSet)) result.activeArtifactSet = selector.artifactSet;
  } catch { /* Admission below supplies the actionable refusal. */ }
  try {
    // Preserve the approved version/hash even when PATH selects a different
    // candidate. That comparison is the operator's reason for using status.
    const artifact = admit({ pinnedArtifactSet, runtimeRoot });
    const policy = JSON.parse(fs.readFileSync(artifact.policy, "utf8"));
    result.approved = { artifactSet: artifact.artifactSet, version: artifact.version,
      vendorSha256: artifact.vendorSha256, platform: artifact.platform, arch: artifact.arch,
      privacyAbi: artifact.privacyAbi, approvalKind: artifact.approvalKind,
      policySha256: crypto.createHash("sha256").update(fs.readFileSync(artifact.policy)).digest("hex"),
      // Test provenance is informational, never an OS-version admission gate.
      testedKernelRelease: policy.testedKernelRelease ?? null };
    if (!result.selected.available) throw new Error("Claude was not started: no readable Claude executable is selected on PATH.");
    admit({ selectedCommand: command, pinnedArtifactSet, runtimeRoot });
  } catch (error) { result.refusal = { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED",
    message: error.code === "AIMGR_CLAUDE_BUILD_NOT_APPROVED" ? error.message
      : result.selected.available ? "Claude was not started: the approved policy could not be inspected safely."
        : "Claude was not started: no readable Claude executable is selected on PATH." }; }
  try { result.running = inventory(); } catch { /* Explicit incomplete state. */ }
  if (label) {
    try {
      const binding = readClaudeOfflineBinding(homeDir, label);
      if (binding?.required === true || typeof binding?.egress?.profileRef === "string") result.account.routing = "assigned";
    } catch { /* Local readiness remains independent of old route caches. */ }
    try {
      environment ??= readClaudeEnvironment();
      const metadata = readCachedClaudeAccountMetadata({ homeDir, environment }).find(record => record.label === label);
      if (!metadata) result.account.localAuth = "metadata_unavailable";
      else {
        result.account.routing = metadata.policy?.egress?.profileRef ? "assigned" : "direct";
        result.account.localAuth = readLocalClaudeCredential({ homeDir, label, metadata, environment }).status;
      }
    } catch { /* Do not expose native credentials, cache contents or errors. */ }
  }
  return result;
}

export function formatClaudePrivacyStatus(status) {
  const lines = [status.refusal ? status.refusal.message : `Claude ${status.approved.version}: approved for ${status.approved.approvalKind}.`,
    "Managed Claude privacy: enabled for direct and assigned-route accounts.",
    `Selected Claude version: ${status.approved && status.selected.sha256 === status.approved.vendorSha256
      ? `${status.approved.version} (matches approved bytes)`
      : status.selected.versionHint ? `${status.selected.versionHint} (installation filename; not verified)` : "unknown without executing it"}.`,
    `Selected executable: ${status.selected.sha256 ?? "unavailable"}`,
    `Active artifact set: ${status.activeArtifactSet ?? "unavailable"}`];
  if (status.pinnedArtifactSet) lines.push(`Inherited artifact set: ${status.pinnedArtifactSet}`);
  if (status.approved) {
    lines.push(`Approved executable: Claude ${status.approved.version}, SHA-256 ${status.approved.vendorSha256}.`);
    lines.push(`OS release recorded during testing: ${status.approved.testedKernelRelease ?? "not recorded"} (informational; OS versions are not gated).`);
  }
  if (status.account) {
    const readiness = { ready: "ready", expired: "expired; native refresh required", login_required: "login required",
      reauth_required: "sign-in required", local_auth_unavailable: "unavailable", identity_mismatch: "account identity mismatch",
      metadata_unavailable: "local account metadata unavailable", unavailable: "unavailable" };
    lines.push(`Account ${status.account.label}: managed privacy enabled; local login ${readiness[status.account.localAuth] ?? "unavailable"}.`);
    lines.push(`Account routing: ${status.account.routing === "assigned" ? "assigned route" : status.account.routing === "direct" ? "direct" : "unknown from local state"}.`);
  }
  lines.push(`Running Claude processes: ${status.running.processes.length}${status.running.complete ? "" : " (inventory incomplete)"}.`);
  const roles = { "detached-supervisor": "detached-session daemon", "detached-worker": "detached-session worker", session: "session", unknown: "role unknown" };
  for (const row of status.running.processes) lines.push(`  PID ${row.pid}: ${roles[row.role] ?? roles.unknown}; ${row.artifactSet ?? "outside the approved runtime"}`);
  return lines.join("\n") + "\n";
}
