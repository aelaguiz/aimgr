import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCredentialRecord,
  normalizeKeyPrefix,
  normalizeMetaRecord,
} from "../../src/coordination/records.js";

test("Redis records normalize shared metadata", () => {
  const now = "2026-05-30T14:00:00.000Z";
  const meta = normalizeMetaRecord({ version: 3, updatedBy: "aimgr-cli" }, { now });

  assert.equal(normalizeKeyPrefix("aimgr:test"), "aimgr:test:");
  assert.equal(meta.kind, "aimgr.meta.v1");
  assert.equal(meta.schemaVersion, "aimgr.redis.v1");
  assert.equal(meta.version, 3);
  assert.equal(meta.createdAt, now);
  assert.equal(meta.updatedAt, now);
  assert.equal(meta.updatedBy, "aimgr-cli");
});

test("Redis credential records normalize provider label policy identity and credential material", () => {
  const credential = normalizeCredentialRecord(
    {
      provider: "OpenAI_CodeX",
      label: " Boss ",
      identity: { accountId: "acct-1" },
      credential: { access: "access", refresh: "refresh", expiresAt: "2026-05-30T20:00:00.000Z" },
      policy: {
        expect: { email: "boss@example.com" },
        reauth: { mode: "browser-managed" },
        browser: { mode: "aim-profile" },
        pool: { enabled: false },
      },
      provenance: { lastSourceType: "migration" },
    },
    { now: "2026-05-30T14:00:00.000Z" },
  );

  assert.equal(credential.kind, "aimgr.credential.v1");
  assert.equal(credential.provider, "openai-codex");
  assert.equal(credential.label, "boss");
  assert.deepEqual(credential.identity, { accountId: "acct-1" });
  assert.deepEqual(credential.policy.pool, { enabled: false });
  assert.deepEqual(credential.provenance, { lastSourceType: "migration" });
  assert.throws(() => normalizeCredentialRecord({ label: "boss" }), /missing provider/);
});
