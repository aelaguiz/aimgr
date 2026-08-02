import test from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_PROVIDER } from "../../src/core/constants.js";
import {
  buildStableIdentityForCredential,
  publishMaintainedCredential,
} from "../../src/coordination/login-publish.js";
import {
  connectRedisStore,
  publishCredential,
  readSnapshot,
} from "../../src/coordination/redis-store.js";
import {
  publishRedisCredentialPolicyFromState,
  publishRedisStateCredential,
} from "../../src/coordination/runtime.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import { getAnthropicCredentialView } from "../../src/credentials/anthropic.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

const INITIAL_EXPIRY = Date.parse("2026-07-22T18:00:00.000Z");

function anthropicCredential({
  access,
  refresh,
  expiresAtMs,
}) {
  return buildAnthropicClaudeCredential({
    access,
    refresh,
    expiresAtMs,
    emailAddress: "writer@example.com",
    organizationName: "Writer Org",
    organizationUuid: "org_writer",
  });
}

function anthropicRefresh(record) {
  return getAnthropicCredentialView(record?.credential)?.refresh;
}

async function createRuntimeWithRecord(credentialRecord) {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:runtime-test" });
  const seeded = await publishCredential(store, {
    expectedVersion: null,
    updatedBy: "test-seed",
    observedAt: "2026-07-22T14:00:00.000Z",
    credentialRecord,
  });
  assert.equal(seeded.ok, true);
  const snapshot = await readSnapshot(store);
  const state = buildCoordinationView(snapshot);
  return {
    client,
    store,
    runtime: {
      store,
      snapshot,
      state,
      updatedBy: "test-runtime",
    },
    state,
  };
}

test("policy publication preserves candidate health and provenance", async () => {
  const provenance = {
    candidateSource: "manual-inventory",
    discoveredAt: "2026-07-22T13:00:00.000Z",
  };
  const { runtime, state, store } = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential: {},
    identity: {},
    policy: {
      expect: { email: "writer@example.com" },
      pool: { enabled: true },
    },
    health: { status: "candidate", reason: "credential_missing" },
    provenance,
  });
  state.accounts.writer.reauth = { mode: "native-claude" };

  const published = await publishRedisCredentialPolicyFromState({
    runtime,
    state,
    label: "writer",
    observedAt: "2026-07-22T14:05:00.000Z",
  });

  assert.equal(published.version, 2);
  assert.deepEqual(published.credential, {});
  assert.deepEqual(published.health, { status: "candidate", reason: "credential_missing" });
  assert.deepEqual(published.provenance, provenance);
  assert.deepEqual(runtime.snapshot.credentials[0].health, published.health);

  const snapshot = await readSnapshot(store);
  assert.deepEqual(snapshot.credentials[0].provenance, provenance);
});

test("two Anthropic rotations publish through one runtime and stale lineages are rejected", async () => {
  const initial = anthropicCredential({
    access: "ACCESS_1",
    refresh: "REFRESH_1",
    expiresAtMs: INITIAL_EXPIRY,
  });
  const { runtime, state, store } = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential: initial,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, initial),
    policy: { pool: { enabled: true } },
    health: { status: "ready", reason: null },
  });

  state.credentials.anthropic.writer = anthropicCredential({
    access: "ACCESS_2",
    refresh: "REFRESH_2",
    expiresAtMs: INITIAL_EXPIRY + 60 * 60_000,
  });
  const first = await publishRedisStateCredential({
    runtime,
    state,
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    observedAt: "2026-07-22T14:10:00.000Z",
  });
  assert.equal(first.version, 2);
  assert.equal(runtime.snapshot.credentials[0].version, 2);

  Object.assign(state.credentials.anthropic.writer, anthropicCredential({
    access: "ACCESS_3",
    refresh: "REFRESH_3",
    expiresAtMs: INITIAL_EXPIRY + 2 * 60 * 60_000,
  }));
  assert.equal(anthropicRefresh(runtime.snapshot.credentials[0]), "REFRESH_2");
  const second = await publishRedisStateCredential({
    runtime,
    state,
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    observedAt: "2026-07-22T14:20:00.000Z",
  });
  assert.equal(second.version, 3);
  assert.equal(runtime.snapshot.credentials[0].version, 3);
  assert.equal(anthropicRefresh(runtime.snapshot.credentials[0]), "REFRESH_3");

  Object.assign(state.credentials.anthropic.writer, anthropicCredential({
    access: "ACCESS_OLDER",
    refresh: "REFRESH_OLDER",
    expiresAtMs: INITIAL_EXPIRY + 90 * 60_000,
  }));
  assert.equal(anthropicRefresh(runtime.snapshot.credentials[0]), "REFRESH_3");
  await assert.rejects(
    () => publishRedisStateCredential({
      runtime,
      state,
      provider: ANTHROPIC_PROVIDER,
      label: "writer",
      observedAt: "2026-07-22T14:30:00.000Z",
    }),
    /older Anthropic credentials/,
  );

  Object.assign(state.credentials.anthropic.writer, anthropicCredential({
    access: "ACCESS_AMBIGUOUS",
    refresh: "REFRESH_AMBIGUOUS",
    expiresAtMs: INITIAL_EXPIRY + 2 * 60 * 60_000,
  }));
  await assert.rejects(
    () => publishRedisStateCredential({
      runtime,
      state,
      provider: ANTHROPIC_PROVIDER,
      label: "writer",
      observedAt: "2026-07-22T14:40:00.000Z",
    }),
    /ambiguous Anthropic credential replacement.*same expiry/,
  );

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 3);
  assert.equal(anthropicRefresh(snapshot.credentials[0]), "REFRESH_3");
});

test("login-maintenance publication uses the same Anthropic rollback guard", async () => {
  const current = anthropicCredential({
    access: "ACCESS_CURRENT",
    refresh: "REFRESH_CURRENT",
    expiresAtMs: INITIAL_EXPIRY + 2 * 60 * 60_000,
  });
  const { runtime, state, store } = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential: current,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, current),
    policy: { pool: { enabled: true } },
  });
  state.credentials.anthropic.writer = anthropicCredential({
    access: "ACCESS_STALE",
    refresh: "REFRESH_STALE",
    expiresAtMs: INITIAL_EXPIRY,
  });

  await assert.rejects(
    () => publishMaintainedCredential({
      store,
      snapshot: runtime.snapshot,
      state,
      label: "writer",
      provider: ANTHROPIC_PROVIDER,
      observedAt: "2026-07-22T14:10:00.000Z",
    }),
    /older Anthropic credentials/,
  );

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials[0].version, 1);
  assert.equal(anthropicRefresh(snapshot.credentials[0]), "REFRESH_CURRENT");
});

test("successful credential publication clears only oauth_reauth_required and only after CAS", async () => {
  const credential = anthropicCredential({
    access: "ACCESS_CURRENT",
    refresh: "REFRESH_CURRENT",
    expiresAtMs: INITIAL_EXPIRY + 2 * 60 * 60_000,
  });
  const exact = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, credential),
    policy: {
      reauth: {
        mode: "native-claude",
        blockedReason: "oauth_reauth_required",
      },
      pool: { enabled: true },
    },
  });
  const exactResult = await publishMaintainedCredential({
    store: exact.store,
    snapshot: exact.runtime.snapshot,
    state: exact.state,
    label: "writer",
    provider: ANTHROPIC_PROVIDER,
  });
  assert.equal(exactResult.ok, true);
  assert.deepEqual(exact.state.accounts.writer.reauth, { mode: "native-claude" });
  assert.deepEqual(
    (await readSnapshot(exact.store)).credentials[0].policy.reauth,
    { mode: "native-claude" },
  );

  const unrelated = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, credential),
    policy: {
      reauth: {
        mode: "native-claude",
        blockedReason: "operator_policy_block",
      },
      pool: { enabled: true },
    },
  });
  const unrelatedResult = await publishMaintainedCredential({
    store: unrelated.store,
    snapshot: unrelated.runtime.snapshot,
    state: unrelated.state,
    label: "writer",
    provider: ANTHROPIC_PROVIDER,
  });
  assert.equal(unrelatedResult.ok, true);
  assert.equal(
    (await readSnapshot(unrelated.store)).credentials[0].policy.reauth.blockedReason,
    "operator_policy_block",
  );

  const stale = await createRuntimeWithRecord({
    provider: ANTHROPIC_PROVIDER,
    label: "writer",
    credential,
    identity: buildStableIdentityForCredential(ANTHROPIC_PROVIDER, credential),
    policy: {
      reauth: {
        mode: "native-claude",
        blockedReason: "oauth_reauth_required",
      },
      pool: { enabled: true },
    },
  });
  const concurrent = await publishCredential(stale.store, {
    expectedVersion: 1,
    updatedBy: "concurrent-test",
    credentialRecord: stale.runtime.snapshot.credentials[0],
  });
  assert.equal(concurrent.ok, true);
  const staleResult = await publishMaintainedCredential({
    store: stale.store,
    snapshot: stale.runtime.snapshot,
    state: stale.state,
    label: "writer",
    provider: ANTHROPIC_PROVIDER,
  });
  assert.equal(staleResult.ok, false);
  assert.equal(
    stale.state.accounts.writer.reauth.blockedReason,
    "oauth_reauth_required",
  );
});
