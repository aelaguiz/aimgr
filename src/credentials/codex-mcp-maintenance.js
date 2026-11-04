import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { admitCodexArtifact } from "../privacy/codex-artifacts.js";
import { inspectCodexManagedPolicy } from "../privacy/codex-managed-policy.js";
import { readCodexEnvironment } from "../privacy/codex-environment.js";
import { codexSharedHome } from "../privacy/codex-account-state.js";

/** Explicit maintenance only. No ordinary launch calls this operation. Primary
 * auth and Redis are not inputs. A surviving native child owns its write locks. */
export async function maintainCodexMcp({ operation, homeDir, env = process.env, cwd = process.cwd() }) {
  const artifact = admitCodexArtifact();
  const managed = inspectCodexManagedPolicy({ artifact });
  const environment = readCodexEnvironment();
  const sourceHome = codexSharedHome({ homeDir, env, environment });
  const request = { operation, home: homeDir, cwd: path.resolve(cwd), source_home: sourceHome,
    artifact_set: artifact.artifactSet, managed, config_state: artifact.configState,
    state_io: artifact.stateIO, keyring: artifact.mcpKeyring, process_control: artifact.processControl,
    node: process.execPath, owner_script: fileURLToPath(new URL("./codex-mcp-maintenance-owner.js", import.meta.url)) };
  if (process.platform === "darwin") request.native_access = { executable: artifact.command, sha256: artifact.vendorSha256 };
  const safeEnv = Object.fromEntries(Object.entries({ ...env, HOME: homeDir }).filter(([key]) =>
    !key.startsWith("LD_") && !key.startsWith("DYLD_") && key !== "GLIBC_TUNABLES"));
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", artifact.mcpMaintenance], { env: safeEnv, cwd,
      stdio: ["pipe", "pipe", "ignore"] });
    const output = []; let size = 0;
    child.on("error", () => reject(new Error("Could not start the installed MCP maintenance owner.")));
    child.stdin.on("error", () => {});
    child.stdout.on("data", bytes => { size += bytes.length; if (size <= 1024 * 1024) output.push(bytes); });
    child.on("close", code => {
      let result;
      try { if (size <= 1024 * 1024) result = JSON.parse(Buffer.concat(output).toString("utf8")); } catch {}
      if (code !== 0 || result?.ok !== true) reject(new Error(result?.error ?? "MCP maintenance ended before completion. Run aim codex mcp-recover to recover its private transaction."));
      else resolve();
    });
    child.stdin.end(JSON.stringify(request));
  });
}
