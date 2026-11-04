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
  }, ...(platform === "darwin" ? [{ field: "managedPreferences", file: "managed-preferences", role: "launcher", executable: true,
    error: "the approved Codex runtime lacks its forced-policy reader" }] : [])],
});
export const {
  AdmissionError: CodexAdmissionError,
  inspectAdministratorPath: inspectCodexAdministratorPath,
  artifactSetDigest: codexArtifactSetDigest,
  admitArtifact: admitCodexArtifact,
} = admission;
