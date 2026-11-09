import crypto from "node:crypto";

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Provider account IDs are verified by the credential/lease caller, never by
// looking UUID-shaped. Preserve exact opaque identity; do not trim or coerce.
export const isClaudeAccountId = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const FIELDS = Object.freeze({
  userID: { format: HEX, required: true },
  machineID: { format: HEX, required: true },
  summonSidKey: { format: HEX, required: false },
  remoteControlMachineId: { format: UUID, required: false },
});

export class ClaudePrivateIdentityError extends Error {
  constructor(reason) {
    super(`Claude was not started: ${reason}.`);
    this.name = "ClaudePrivateIdentityError";
    this.code = "AIMGR_CLAUDE_PRIVATE_IDENTITY";
  }
}
const fail = reason => { throw new ClaudePrivateIdentityError(reason); };

/** Prepare only the audited private fields; never clone an OS home.
 *
 * T04/T05/T06: userID is sent as device_id even with telemetry disabled.
 * The pinned client also retains machineID, a summon session HMAC key, and a
 * remote-control machine UUID in this same mixed app-state file. Account OAuth,
 * project trust, MCP declarations and unknown task fields must survive intact.
 *
 * This pure function is NOT a migration transaction. The caller must first stop
 * affected owners and hold existing account coordination, collect the complete
 * local comparison inventory, then journal/commit state and sidecar together.
 * A journal must retain this plan's generated IDs across crash recovery. Calling
 * this again to regenerate a half-committed plan would rotate identity twice.
 * Never publish the returned state/record/IDs to Redis, argv, status or logs.
 */
export function planClaudePrivateIdentity({
  appState,
  identityRecord = null,
  accountUuid,
  organizationUuid = null,
  environmentBinding = null,
  foreignIdentifiers,
  inventoryComplete,
  now = new Date().toISOString(),
  randomHex = () => crypto.randomBytes(32).toString("hex"),
  randomUuid = () => crypto.randomUUID(),
} = {}) {
  if (!object(appState) || !isClaudeAccountId(accountUuid)) fail("the underlying Claude account identity is unknown");
  if (inventoryComplete !== true || !Array.isArray(foreignIdentifiers)
    || foreignIdentifiers.some(value => typeof value !== "string")) {
    fail("the local installation-identity comparison is incomplete");
  }
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) fail("the identity migration time is invalid");
  if (identityRecord !== null && (!object(identityRecord) || identityRecord.schema !== 1
    || !isClaudeAccountId(identityRecord.accountUuid) || !object(identityRecord.fields)
    || typeof identityRecord.createdAt !== "string" || !Number.isFinite(Date.parse(identityRecord.createdAt))
    || Object.keys(identityRecord.fields).some(key => !Object.hasOwn(FIELDS, key))
    || Object.entries(identityRecord.fields).some(([key, value]) => !FIELDS[key].format.test(value))
    || !FIELDS.userID.format.test(identityRecord.fields.userID ?? "")
    || !FIELDS.machineID.format.test(identityRecord.fields.machineID ?? ""))) {
    fail("the private installation-identity record is invalid");
  }
  if (environmentBinding !== null && !HEX.test(environmentBinding)) fail("the account environment binding is invalid");
  const sameAccount = identityRecord?.accountUuid === accountUuid
    && (environmentBinding === null || (identityRecord.environmentBinding === environmentBinding
      && identityRecord.organizationUuid === organizationUuid));
  const nativeAccount = appState.oauthAccount?.accountUuid;
  if (sameAccount && nativeAccount !== undefined && nativeAccount !== accountUuid) {
    fail("Claude account state differs from its committed identity record");
  }
  if (identityRecord === null && Object.keys(FIELDS).some(key => appState[key] !== undefined)
    && !isClaudeAccountId(nativeAccount)) {
    fail("existing Claude installation identifiers have no verified account owner");
  }
  // T04: first migration can reuse a label BEFORE a sidecar exists. The
  // native app state's known old account is still evidence of foreign IDs.
  // Credential projection remains the transaction caller's separate job.
  const rebound = (identityRecord !== null && !sameAccount)
    || (identityRecord === null && isClaudeAccountId(nativeAccount) && nativeAccount !== accountUuid);
  const foreign = new Set(foreignIdentifiers);
  const used = new Set(foreign);
  const reserved = new Set([...foreign, ...Object.keys(FIELDS).map(key => appState[key]),
    ...Object.values(identityRecord?.fields ?? {})]);
  const state = structuredClone(appState);
  const fields = {};
  const changedFields = [];
  for (const [key, spec] of Object.entries(FIELDS)) {
    const current = state[key];
    const valid = typeof current === "string" && spec.format.test(current);
    if (sameAccount && Object.hasOwn(identityRecord.fields, key)
      && identityRecord.fields[key] !== current) {
      // A completed record is evidence of an earlier atomic commit. Do not
      // paper over an interrupted write or imported foreign app state here.
      // The transaction recovery path must resolve that before a new plan.
      fail("Claude installation state differs from its committed identity record");
    }
    if (!spec.required && current === undefined) continue;
    let next = current;
    if (rebound || (environmentBinding && !sameAccount) || !valid || used.has(current)) {
      next = undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = key === "remoteControlMachineId" ? randomUuid() : randomHex();
        if (typeof candidate !== "string" || !spec.format.test(candidate)) fail("private identity generation failed");
        if (!used.has(candidate) && !reserved.has(candidate)) { next = candidate; break; }
      }
      if (next === undefined) fail("private identity generation did not produce a distinct value");
      state[key] = next;
      changedFields.push(key);
    }
    used.add(next);
    fields[key] = next;
  }
  const record = {
    schema: 1,
    accountUuid,
    createdAt: sameAccount ? identityRecord.createdAt : now,
    fields,
    ...(environmentBinding ? { environmentBinding, organizationUuid } : {}),
    ...(sameAccount && identityRecord?.grant ? { grant: structuredClone(identityRecord.grant) } : {}),
  };
  return {
    state,
    record,
    changedFields,
    recordChanged: JSON.stringify(identityRecord) !== JSON.stringify(record),
    // Labels locate directories; they are deliberately absent from this
    // identity binding so a display-label rename cannot rotate these IDs.
    rebound,
  };
}
