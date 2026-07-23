import test from "node:test";
import assert from "node:assert/strict";
import {
  hasCredentialMaterial,
  normalizeCredentialRecord,
  normalizeKeyPrefix,
  normalizeMetaRecord,
} from "../../src/coordination/records.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";

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

test("policy-only Redis records are candidates and do not project empty credentials", () => {
  const candidate = normalizeCredentialRecord(
    {
      provider: "anthropic",
      label: "writer",
      credential: {},
      policy: {
        expect: { email: "writer@example.com" },
        pool: { enabled: true },
      },
      health: { status: "ready", reason: null },
    },
    { now: "2026-07-22T14:00:00.000Z" },
  );

  assert.equal(hasCredentialMaterial(candidate.credential), false);
  assert.deepEqual(candidate.health, { status: "candidate", reason: "credential_missing" });

  const state = buildCoordinationView({ credentials: [candidate] });
  assert.equal(state.accounts.writer.provider, "anthropic");
  assert.deepEqual(state.accounts.writer.expect, { email: "writer@example.com" });
  assert.equal(Object.hasOwn(state.credentials.anthropic, "writer"), false);
});

test("provider-scoped coordination views keep same-label Claude policy authoritative", () => {
  const state = buildCoordinationView({
    credentials: [
      normalizeCredentialRecord({
        provider: "anthropic",
        label: "shared",
        credential: {},
        policy: {
          expect: { email: "claude@example.com" },
          reauth: { mode: "native-claude" },
          pool: { enabled: true },
        },
      }),
      normalizeCredentialRecord({
        provider: "openai-codex",
        label: "shared",
        credential: { access: "codex-access" },
        policy: {
          expect: { email: "codex@example.com" },
          reauth: { mode: "manual-callback" },
          pool: { enabled: true },
        },
      }),
    ],
  }, { provider: "anthropic" });

  assert.equal(state.accounts.shared.provider, "anthropic");
  assert.deepEqual(state.accounts.shared.expect, { email: "claude@example.com" });
  assert.equal(Object.hasOwn(state.credentials.anthropic, "shared"), false);
  assert.equal(Object.hasOwn(state.credentials["openai-codex"], "shared"), false);
});
