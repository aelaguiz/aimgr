import { createArtifactAdmission } from "./artifact-admission.js";

export const CLAUDE_RUNTIME_ROOT = "/opt/aimgr-claude-runtime";
export const CLAUDE_PRIVACY_ABI = "claude-privacy-v1";
const admission = createArtifactAdmission({
  provider: "Claude", runtimeRootDefault: CLAUDE_RUNTIME_ROOT, privacyAbi: CLAUDE_PRIVACY_ABI,
  offsiteHostFile: "/opt/aimgr-state-audit/CLAUDE_TEST_HOST.json",
  requiredEntries: platform => platform === "darwin" ? [{
    field: "securityAdapter", file: "security", role: "resource", executable: true,
    error: "the approved Mac runtime lacks its credential adapter",
  }] : [{
    file: "validate-settings", role: "launcher", executable: true,
    error: "the approved Linux runtime lacks its executable settings validator",
  }],
});
export const {
  AdmissionError: ClaudeAdmissionError,
  installedVersionHint: claudeInstalledVersionHint,
  inspectAdministratorPath: inspectClaudeAdministratorPath,
  artifactSetDigest: claudeArtifactSetDigest,
  admitArtifact: admitClaudeArtifact,
} = admission;
