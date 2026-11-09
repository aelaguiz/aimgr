import { createHash } from "node:crypto";
import { inspectClaudeAdministratorPath } from "./claude-artifacts.js";

export const CLAUDE_ENVIRONMENT_ANCHOR = "/opt/aimgr-claude-runtime/environment.json";

// Provisioned independently of portable user state; upgrades preserve it.
export function readClaudeEnvironment({ inspect = inspectClaudeAdministratorPath, uid = process.getuid() } = {}) {
  try {
    const input = inspect(CLAUDE_ENVIRONMENT_ANCHOR);
    if (input?.kind !== "file") throw new Error();
    const record = JSON.parse(input.bytes.toString("utf8"));
    if (record.schema !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.id)
      || !Number.isInteger(uid) || uid < 1) throw new Error();
    return Object.freeze({ binding: createHash("sha256").update(`${record.id}\0${uid}`).digest("hex") });
  } catch {
    throw new Error("Claude needs its machine-local environment identity provisioned with the approved runtime.");
  }
}

export function claudeOwnerBinding(environment, identity) {
  if (!/^[a-f0-9]{64}$/.test(environment?.binding ?? "") || !identity?.accountUuid || !identity?.organizationUuid) {
    throw new Error("Claude local ownership requires a verified account, organization and environment.");
  }
  return createHash("sha256").update(JSON.stringify([environment.binding, identity.accountUuid, identity.organizationUuid])).digest("hex");
}
