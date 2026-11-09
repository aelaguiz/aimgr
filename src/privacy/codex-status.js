import { admitCodexArtifact } from "./codex-artifacts.js";
import { readCodexEnvironment } from "./codex-environment.js";
import { inspectCodexManagedPolicy } from "./codex-managed-policy.js";
import { assertCodexMaintenanceClear } from "./codex-maintenance.js";

/** Local diagnostics: no credential read/refresh, Redis or vendor execution. */
export function inspectCodexPrivacyStatus({ pinnedArtifactSet, admit = admitCodexArtifact,
  environment = readCodexEnvironment, policy = inspectCodexManagedPolicy,
  maintenance = assertCodexMaintenanceClear } = {}) {
  const result = { schema: 1, runtime: null, environmentProvisioned: false, policyReady: false,
    maintenanceClear: false, ready: false, errors: [] };
  try {
    const artifact = admit({ pinnedArtifactSet });
    result.runtime = { version: artifact.version, artifactSet: artifact.artifactSet, approval: artifact.approvalKind };
    try { policy({ artifact }); result.policyReady = true; }
    catch (error) { result.errors.push(error.message); }
  } catch (error) { result.errors.push(error.message); }
  try { environment(); result.environmentProvisioned = true; }
  catch (error) { result.errors.push(error.message); }
  try { maintenance(); result.maintenanceClear = true; }
  catch (error) { result.errors.push(error.message); }
  result.ready = result.runtime !== null && result.environmentProvisioned && result.policyReady && result.maintenanceClear;
  return result;
}

export function formatCodexPrivacyStatus(status) {
  const lines = [status.ready ? "Codex privacy runtime checks passed." : "Codex privacy runtime needs attention."];
  if (status.runtime) lines.push(`Codex ${status.runtime.version}: ${status.runtime.approval === "normal-use" ? "approved runtime" : "isolated test runtime"}.`);
  lines.push(`Machine-local login identity: ${status.environmentProvisioned ? "provisioned" : "unavailable"}.`);
  lines.push(`Local privacy policy: ${status.policyReady ? "ready" : "unavailable or conflicting"}.`);
  lines.push(`Credential maintenance: ${status.maintenanceClear ? "clear" : "pending or unreadable"}.`);
  for (const error of status.errors) lines.push(error);
  return lines.join("\n") + "\n";
}
