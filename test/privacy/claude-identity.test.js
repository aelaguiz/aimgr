import assert from "node:assert/strict";
import test from "node:test";
import { planClaudePrivateIdentity } from "../../src/privacy/claude-identity.js";

const accountA = "00000000-0000-4000-8000-000000000001";
const accountB = "00000000-0000-4000-8000-000000000002";
const initial = { userID: "a".repeat(64), machineID: "b".repeat(64),
  summonSidKey: "c".repeat(64), remoteControlMachineId: "00000000-0000-4000-8000-000000000003",
  oauthAccount: { accountUuid: accountA }, projects: { "/synthetic/project": { hasTrustDialogAccepted: true } },
  mcpServers: { required: { command: "synthetic-mcp" } }, unknownTaskField: { history: "retain" } };
const base = { appState: initial, accountUuid: accountA, foreignIdentifiers: [], inventoryComplete: true };

test("verified opaque account IDs bind exactly and rotate on reuse", () => {
  const first = planClaudePrivateIdentity({ ...base, appState: {}, accountUuid: "opaque-account-A" });
  const state = { ...first.state, oauthAccount: { accountUuid: "opaque-account-A" } };
  const same = planClaudePrivateIdentity({ ...base, appState: state, identityRecord: first.record,
    accountUuid: "opaque-account-A" });
  assert.equal(same.recordChanged, false); assert.deepEqual(same.changedFields, []);
  const rebound = planClaudePrivateIdentity({ ...base, appState: state, identityRecord: first.record,
    accountUuid: "opaque-account-B" });
  assert.equal(rebound.rebound, true); assert.notEqual(rebound.state.userID, state.userID);
});

test("unique account state keeps every ID and unrelated mixed app-state field", () => {
  const result = planClaudePrivateIdentity(base);
  assert.deepEqual(result.state, initial);
  assert.deepEqual(result.changedFields, []);
  assert.equal(result.record.accountUuid, accountA);
  assert.equal(result.recordChanged, true);
  const repeat = planClaudePrivateIdentity({ ...base, identityRecord: result.record,
    randomHex: () => { throw new Error("must not rotate on launch"); } });
  assert.deepEqual(repeat.state, initial);
  assert.deepEqual(repeat.record, result.record);
  assert.equal(repeat.recordChanged, false);
});

test("identifiers copied from personal or other-account state are replaced without discarding history", () => {
  const before = structuredClone(initial);
  const result = planClaudePrivateIdentity({ ...base, foreignIdentifiers: [initial.userID, initial.summonSidKey] });
  assert.notEqual(result.state.userID, initial.userID);
  assert.notEqual(result.state.summonSidKey, initial.summonSidKey);
  assert.equal(result.state.machineID, initial.machineID);
  assert.deepEqual(result.changedFields, ["userID", "summonSidKey"]);
  for (const key of ["oauthAccount", "projects", "mcpServers", "unknownTaskField"]) assert.deepEqual(result.state[key], initial[key]);
  assert.deepEqual(initial, before);
  const repeat = planClaudePrivateIdentity({ ...base, appState: result.state, identityRecord: result.record,
    foreignIdentifiers: [initial.userID, initial.summonSidKey] });
  assert.deepEqual(repeat.changedFields, []);
});

test("reusing a label for another underlying account does not reuse private IDs", () => {
  const first = planClaudePrivateIdentity(base);
  const rebound = planClaudePrivateIdentity({ ...base, identityRecord: first.record, accountUuid: accountB });
  assert.equal(rebound.rebound, true);
  for (const key of Object.keys(first.record.fields)) assert.notEqual(rebound.record.fields[key], first.record.fields[key]);
  assert.equal(rebound.record.accountUuid, accountB);
  // Credential projection is a separate coordinated step; do not fabricate or
  // replace OAuth data in an identity-only planner.
  assert.deepEqual(rebound.state.oauthAccount, initial.oauthAccount);
});

test("first migration recognizes a reused label even before an AIM identity record exists", () => {
  const rebound = planClaudePrivateIdentity({ ...base, accountUuid: accountB });
  assert.equal(rebound.rebound, true);
  for (const key of Object.keys(rebound.record.fields)) assert.notEqual(rebound.record.fields[key], initial[key]);
  assert.throws(() => planClaudePrivateIdentity({ ...base, appState: { userID: initial.userID } }),
    { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
});

test("first start creates only required fields; newly created optional native fields are adopted", () => {
  const first = planClaudePrivateIdentity({ ...base, appState: { projects: initial.projects } });
  assert.match(first.state.userID, /^[0-9a-f]{64}$/);
  assert.match(first.state.machineID, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(first.state, "summonSidKey"), false);
  const next = planClaudePrivateIdentity({ ...base, identityRecord: first.record,
    appState: { ...first.state, summonSidKey: "d".repeat(64) } });
  assert.equal(next.record.fields.summonSidKey, "d".repeat(64));
  assert.deepEqual(next.changedFields, []);
});

test("incomplete comparisons and inconsistent commits refuse without printing private values", () => {
  const first = planClaudePrivateIdentity(base);
  for (const patch of [{ inventoryComplete: false }, { accountUuid: " invalid-account " },
    { identityRecord: { ...first.record, schema: 999 } },
    { identityRecord: first.record, appState: { ...initial, userID: "e".repeat(64) } }]) {
    assert.throws(() => planClaudePrivateIdentity({ ...base, ...patch }), error => {
      assert.equal(error.code, "AIMGR_CLAUDE_PRIVATE_IDENTITY");
      assert.equal(error.message.includes(initial.userID), false);
      return true;
    });
  }
});

test("cross-field collisions are removed and broken randomness cannot silently reuse an ID", () => {
  const duplicate = planClaudePrivateIdentity({ ...base, appState: { ...initial, machineID: initial.userID } });
  assert.notEqual(duplicate.state.userID, duplicate.state.machineID);
  assert.throws(() => planClaudePrivateIdentity({ ...base, foreignIdentifiers: [initial.userID],
    randomHex: () => initial.userID }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
});
