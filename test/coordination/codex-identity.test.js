import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireCodexIdentityCatalogLease,
  assertCodexIdentityWriteAllowed,
  buildCodexDesktopIdentityFingerprint,
  buildReservedCodexIdentityIndex,
  CodexDesktopReservedError,
  commitCodexIdentityRecordFenced,
  listRawCodexIdentityRecords,
  readReservedCodexIdentityIndex,
} from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

const KEY_PREFIX = "aimgr:codex-identity-test";
const CATALOG_LEASE_KEY = `${KEY_PREFIX}:lease:identity-catalog:openai-codex`;

function reservedRecord({ label = "desktop", accountId = "acct_reserved", fingerprint } = {}) {
  return {
    provider: "openai-codex",
    label,
    identity: { accountId },
    credential: {},
    policy: {
      expect: {
        codexDesktop: {
          reserved: true,
          ownerHost: "test-host",
          identityFingerprint: fingerprint ?? buildCodexDesktopIdentityFingerprint(accountId),
          reservedAt: "2026-08-07T00:00:00.000Z",
        },
      },
      pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
    },
    health: { status: "native_owned", reason: "codex_desktop_reserved" },
  };
}

function pooledRecord({ label, accountId }) {
  return {
    provider: "openai-codex",
    label,
    identity: { accountId },
    credential: {
      access: `ACCESS_${label}`,
      refresh: `REFRESH_${label}`,
      accountId,
      expiresAt: "2026-08-08T00:00:00.000Z",
    },
    policy: { pool: { enabled: true } },
  };
}

async function seededStore(records, { client = new FakeRedisClient() } = {}) {
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(
    store,
    { credentials: records },
    { updatedBy: "test", observedAt: "2026-08-07T00:00:00.000Z" },
  );
  return { store, client };
}

test("reserved index is built from raw records including credential-empty ones", async () => {
  const { store } = await seededStore([
    reservedRecord({ label: "desktop", accountId: "acct_reserved" }),
    pooledRecord({ label: "pool_a", accountId: "acct_pool" }),
  ]);

  const raw = await listRawCodexIdentityRecords(store);
  assert.equal(raw.length, 2);
  const reserved = raw.find((record) => record.label === "desktop");
  // The credential-empty reserved record must remain globally visible in the
  // raw scan even though the normalized coordination view would drop it.
  assert.deepEqual(reserved.credential, {});
  assert.equal(reserved.health.status, "native_owned");
  assert.equal(reserved.health.reason, "codex_desktop_reserved");

  const index = await readReservedCodexIdentityIndex(store);
  assert.equal(index.size, 1);
  assert.equal(index.get("acct_reserved").label, "desktop");
  assert.equal(index.has("acct_pool"), false);
});

test("a reservation whose fingerprint mismatches its identity fails closed", () => {
  const corrupted = reservedRecord({
    accountId: "acct_reserved",
    fingerprint: buildCodexDesktopIdentityFingerprint("acct_other"),
  });
  assert.throws(
    () => buildReservedCodexIdentityIndex([corrupted]),
    /reservation fingerprint mismatch/,
  );
});

test("write gate matrix: reserved label, reserved alias, and unrelated writes", () => {
  const index = buildReservedCodexIdentityIndex([
    reservedRecord({ label: "desktop", accountId: "acct_reserved" }),
  ]);

  // Same label as the reservation is refused, even with no account ID.
  assert.throws(
    () => assertCodexIdentityWriteAllowed({ index, label: "desktop", accountId: null, operation: "test write" }),
    CodexDesktopReservedError,
  );
  // Any other label aliasing the reserved immutable account is refused.
  assert.throws(
    () => assertCodexIdentityWriteAllowed({ index, label: "innocent", accountId: "acct_reserved", operation: "test write" }),
    CodexDesktopReservedError,
  );
  // An unrelated label and account passes.
  assertCodexIdentityWriteAllowed({ index, label: "pool_a", accountId: "acct_pool", operation: "test write" });
});

test("catalog lease acquisitions use unique opaque tokens and refuse double acquisition", async () => {
  const { store, client } = await seededStore([]);

  const first = await acquireCodexIdentityCatalogLease(store);
  assert.ok(first);
  const firstToken = await client.get(CATALOG_LEASE_KEY);
  assert.ok(firstToken);
  // The catalog is exclusive while held.
  assert.equal(await acquireCodexIdentityCatalogLease(store), null);
  assert.equal(await first.release(), true);
  assert.equal(await client.get(CATALOG_LEASE_KEY), null);

  const second = await acquireCodexIdentityCatalogLease(store);
  const secondToken = await client.get(CATALOG_LEASE_KEY);
  assert.ok(secondToken);
  assert.notEqual(secondToken, firstToken);
  assert.equal(await second.release(), true);
});

test("race proof: an expired catalog scan cannot commit over a newer pin", async () => {
  const client = new FakeRedisClient({ nowMs: 0 });
  const { store } = await seededStore([
    pooledRecord({ label: "personal", accountId: "acct_reserved" }),
    pooledRecord({ label: "pool_a", accountId: "acct_pool" }),
  ], { client });

  // Publisher A acquires the catalog and scans the raw record set.
  const leaseA = await acquireCodexIdentityCatalogLease(store, { ttlMs: 1_000 });
  assert.ok(leaseA);
  const scanA = await listRawCodexIdentityRecords(store);
  const personalA = scanA.find((record) => record.label === "personal");
  assert.equal(buildReservedCodexIdentityIndex(scanA).size, 0);

  // A sleeps past its lease TTL; the catalog frees itself.
  client.advanceTime(1_500);

  // Pin B acquires the catalog, reserves the identity, and releases.
  const leaseB = await acquireCodexIdentityCatalogLease(store, { ttlMs: 1_000 });
  assert.ok(leaseB);
  const scanB = await listRawCodexIdentityRecords(store);
  const personalB = scanB.find((record) => record.label === "personal");
  const committedB = await commitCodexIdentityRecordFenced(leaseB, {
    expectedVersion: personalB.version,
    credentialRecord: reservedRecord({ label: "personal", accountId: "acct_reserved" }),
    updatedBy: "pin-b",
    observedAt: "2026-08-07T00:01:00.000Z",
  });
  assert.equal(committedB.ok, true);
  assert.equal(await leaseB.release(), true);

  // A's fenced commit from the stale scan must fail closed: its token is no
  // longer live, so the fence refuses the write regardless of record version.
  const committedA = await commitCodexIdentityRecordFenced(leaseA, {
    expectedVersion: personalA.version,
    credentialRecord: {
      ...personalA,
      label: "alias_label",
      credential: { ...personalA.credential },
    },
    updatedBy: "publisher-a",
    observedAt: "2026-08-07T00:02:00.000Z",
  });
  assert.equal(committedA.ok, false);
  assert.equal(committedA.code, "catalog_lease_lost");

  // The reservation actually stuck and no alias record was written.
  const after = await listRawCodexIdentityRecords(store);
  assert.equal(after.some((record) => record.label === "alias_label"), false);
  const reservedAfter = after.find((record) => record.label === "personal");
  assert.deepEqual(reservedAfter.credential, {});
  assert.equal(reservedAfter.policy.expect.codexDesktop.reserved, true);

  // A retried publisher gets a brand-new token and its fresh scan sees the
  // reservation, so the alias write is rejected before any commit.
  const retryLease = await acquireCodexIdentityCatalogLease(store, { ttlMs: 1_000 });
  assert.ok(retryLease);
  const retryScan = await listRawCodexIdentityRecords(store);
  const retryIndex = buildReservedCodexIdentityIndex(retryScan);
  assert.throws(
    () => assertCodexIdentityWriteAllowed({
      index: retryIndex,
      label: "alias_label",
      accountId: "acct_reserved",
      operation: "retried publication",
    }),
    CodexDesktopReservedError,
  );
  assert.equal(await retryLease.release(), true);
});

test("one failed fenced commit permanently invalidates the lease handle", async () => {
  const client = new FakeRedisClient({ nowMs: 0 });
  const { store } = await seededStore([
    pooledRecord({ label: "pool_a", accountId: "acct_pool" }),
  ], { client });

  const lease = await acquireCodexIdentityCatalogLease(store);
  const raw = await listRawCodexIdentityRecords(store);
  const record = raw.find((entry) => entry.label === "pool_a");

  const failed = await commitCodexIdentityRecordFenced(lease, {
    expectedVersion: record.version + 5,
    credentialRecord: record,
    updatedBy: "test",
    observedAt: "2026-08-07T00:03:00.000Z",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "stale_version");

  // The handle is dead: renew fails, and even a would-be-valid commit is
  // refused as catalog_lease_lost instead of transparently reacquiring.
  assert.equal(await lease.renew(), false);
  const retried = await commitCodexIdentityRecordFenced(lease, {
    expectedVersion: record.version,
    credentialRecord: record,
    updatedBy: "test",
    observedAt: "2026-08-07T00:04:00.000Z",
  });
  assert.equal(retried.ok, false);
  assert.equal(retried.code, "catalog_lease_lost");
  // The failed commit released the catalog for the next writer.
  assert.equal(await client.get(CATALOG_LEASE_KEY), null);
});
