import fs from "node:fs";
import path from "node:path";
import { createArtifactAdmission } from "./artifact-admission.js";

const runtimeRootDefault = "/opt/aimgr-agy-runtime";
const privacyAbi = "agy-privacy-v2";
const requiredEntries = [
  { field: "entrypoint", file: "agy", role: "vendor", executable: true, error: "the fixed Antigravity executable is missing" },
  { field: "launcher", file: "launcher", role: "launcher", executable: true, error: "the fixed Antigravity launcher is missing" },
  { field: "policy", file: "policy.json", role: "policy", executable: false, error: "the fixed Antigravity policy manifest is missing" },
];

const admission = createArtifactAdmission({
  provider: "Antigravity",
  runtimeRootDefault,
  privacyAbi,
  offsiteHostFile: "/opt/aimgr-state-audit/AGY_TEST_HOST.json",
  requiredEntries: () => requiredEntries,
});

export const {
  AdmissionError: AgyAdmissionError,
  inspectAdministratorPath: inspectAgyAdministratorPath,
} = admission;

export function supportsAgyPlatform(platform = process.platform, arch = process.arch) {
  return (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");
}

export function hasAgyRuntime({ runtimeRoot = runtimeRootDefault } = {}) {
  const active = path.join(runtimeRoot, "active.json");
  try {
    const stat = fs.lstatSync(active);
    if (!stat.isFile() || stat.size > 4096) return false;
    const selector = JSON.parse(fs.readFileSync(active, "utf8"));
    if (selector?.schema !== 1 || typeof selector.artifactSet !== "string" || !/^[a-f0-9]{64}$/.test(selector.artifactSet)) return false;
    const bundle = path.join(runtimeRoot, "artifacts", selector.artifactSet);
    const approval = path.join(bundle, "approval.json");
    const manifest = fs.lstatSync(approval);
    if (!manifest.isFile() || manifest.size > 1024 * 1024) return false;
    // Presence and compatibility are status hints. The launch path checks approval and hashes.
    return JSON.parse(fs.readFileSync(approval, "utf8"))?.privacyAbi === privacyAbi
      && requiredEntries.every(({ file }) => fs.lstatSync(path.join(bundle, file)).isFile());
  } catch {
    return false;
  }
}

export function admitAgyArtifact({ platform = process.platform, arch = process.arch, ...options } = {}) {
  if (!supportsAgyPlatform(platform, arch)) {
    throw new AgyAdmissionError("the native runtime requires Linux x64 or macOS arm64");
  }
  return admission.admitArtifact({ ...options, platform, arch });
}

export function inspectAgyRuntime() {
  if (!supportsAgyPlatform()) return { supported: false, runtime: null };
  try {
    const artifact = admitAgyArtifact();
    if (artifact.approvalKind !== "normal-use") {
      return { supported: true, runtime: null, refusal: "The selected Antigravity runtime is approved for offsite tests only." };
    }
    return { supported: true, runtime: { artifactSet: artifact.artifactSet, version: artifact.version } };
  } catch (error) {
    if (!(error instanceof AgyAdmissionError)) throw error;
    return { supported: true, runtime: null, refusal: error.message.split("\n", 1)[0] };
  }
}
