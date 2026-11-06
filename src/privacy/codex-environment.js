import { createHash } from "node:crypto";
import { inspectCodexAdministratorPath as inspectAdministratorPath } from "./codex-artifacts.js";

// Installed once per machine provisioning, outside transferable user state.
// Runtime upgrades preserve it. A managed clone must provision a new anchor.
export const CODEX_ENVIRONMENT_ANCHOR = "/opt/aimgr-codex-runtime/environment.json";

export function readCodexEnvironment({ inspect = inspectAdministratorPath, uid = process.getuid() } = {}) {
  let record;
  try {
    const input = inspect(CODEX_ENVIRONMENT_ANCHOR);
    if (input?.kind !== "file") throw new Error("missing");
    record = JSON.parse(input.bytes.toString("utf8"));
    if (record.schema !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.id) || !Number.isInteger(uid) || uid < 1) throw new Error("invalid");
  } catch {
    throw new Error("Codex needs its machine-local environment identity provisioned with the approved privacy runtime.");
  }
  return Object.freeze({ binding: createHash("sha256").update(`${record.id}\0${uid}`).digest("hex") });
}
