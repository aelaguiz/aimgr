import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKeyPrefix,
  normalizeLabelRecord,
  normalizeMachineRecord,
  normalizeMetaRecord,
  normalizeSessionRecord,
} from "../../src/coordination/records.js";

test("Redis records normalize shared metadata", () => {
  const now = "2026-05-30T14:00:00.000Z";
  const meta = normalizeMetaRecord({ version: 3, updatedBy: "studio" }, { now });

  assert.equal(normalizeKeyPrefix("aimgr:test"), "aimgr:test:");
  assert.equal(meta.kind, "aimgr.meta.v1");
  assert.equal(meta.schemaVersion, "aimgr.redis.v1");
  assert.equal(meta.version, 3);
  assert.equal(meta.createdAt, now);
  assert.equal(meta.updatedAt, now);
  assert.equal(meta.updatedBy, "studio");
});

test("Redis machine records require machine id and preserve identity fields", () => {
  const now = "2026-05-30T14:00:00.000Z";
  const machine = normalizeMachineRecord(
    {
      machineId: "studio",
      hostname: "amirs-mac-studio",
      displayName: "Mac Studio",
      aimVersion: "1.2.3",
      platform: "darwin",
    },
    { now },
  );

  assert.equal(machine.kind, "aimgr.machine.v1");
  assert.equal(machine.machineId, "studio");
  assert.equal(machine.lastSeenAt, now);
  assert.throws(() => normalizeMachineRecord({}), /missing machineId/);
});

test("Redis label records normalize provider and label names", () => {
  const label = normalizeLabelRecord(
    {
      provider: "OpenAI_CodeX",
      label: " Boss ",
      stableIdentity: { subject: "acct-1" },
      pool: { enabled: false },
    },
    { now: "2026-05-30T14:00:00.000Z" },
  );

  assert.equal(label.kind, "aimgr.label.v1");
  assert.equal(label.provider, "openai-codex");
  assert.equal(label.label, "boss");
  assert.deepEqual(label.stableIdentity, { subject: "acct-1" });
  assert.deepEqual(label.pool, { enabled: false });
  assert.throws(() => normalizeLabelRecord({ label: "boss" }), /missing provider/);
});

test("Redis session records default to machine-local session ids", () => {
  const session = normalizeSessionRecord(
    {
      provider: "anthropic",
      label: "writer",
      machineId: "laptop",
      credential: { type: "portable" },
      identity: { email: "writer@example.com" },
    },
    { now: "2026-05-30T14:00:00.000Z" },
  );

  assert.equal(session.kind, "aimgr.session.v1");
  assert.equal(session.sessionId, "anthropic:writer:laptop");
  assert.deepEqual(session.health, { status: "ready", reason: null });
  assert.deepEqual(session.lineage, { mode: "independent-login" });
  assert.throws(() => normalizeSessionRecord({ provider: "anthropic", label: "writer" }), /missing machineId/);
});
