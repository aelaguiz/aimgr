import { createArtifactAdmission } from "./artifact-admission.js";

export const CODEX_RUNTIME_ROOT = "/opt/aimgr-codex-runtime";
export const CODEX_PRIVACY_ABI = "codex-privacy-v1";
const admission = createArtifactAdmission({
  provider: "Codex", runtimeRootDefault: CODEX_RUNTIME_ROOT, privacyAbi: CODEX_PRIVACY_ABI,
  offsiteHostFile: "/opt/aimgr-state-audit/CODEX_TEST_HOST.json",
  requiredEntries: platform => [{
    field: "codeModeHost", file: "codex-code-mode-host", role: "vendor", executable: true,
    error: "the approved Codex runtime lacks its code-mode helper",
  }, {
    field: "stateIO", file: "state_io.py", role: "launcher", executable: false,
    error: "the approved Codex runtime lacks its state helper",
  }, {
    field: "configState", file: "config-state", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its native configuration and state helper",
  }, {
    field: "worktreeTool", file: "worktree-tool", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its native worktree helper",
  }, {
    field: "processControl", file: "process-control", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its maintenance process control helper",
  }, {
    field: "mcpKeyring", file: "mcp-keyring", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its MCP keyring helper",
  }, ...(platform === "darwin" ? [{ field: "managedPreferences", file: "managed-preferences", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its forced-policy reader" }] : [])],
});
export const {
  AdmissionError: CodexAdmissionError,
  inspectAdministratorPath: inspectCodexAdministratorPath,
  artifactSetDigest: codexArtifactSetDigest,
  admitArtifact: admitCodexArtifact,
} = admission;
