import fs from "node:fs";
import path from "node:path";

// Early refusal protects pre-exec account selection/refresh during explicit
// maintenance. The native final-exec admission lock remains authoritative.
export function assertCodexMaintenanceClear({ root = `/opt/aimgr-codex-runtime/users/${process.getuid()}/maintenance` } = {}) {
  try { fs.lstatSync(path.join(root, "pending.json")); }
  catch (error) { if (error.code === "ENOENT") return; throw new Error("Codex maintenance status could not be checked."); }
  throw new Error("Codex credential maintenance is pending. Finish or recover it before starting another Codex session.");
}
