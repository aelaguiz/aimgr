import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexDesktopIdentityFingerprint } from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome } from "../helpers/files.js";

const KEY_PREFIX = "aimgr:desktop-pin-test";

function codexRecord({ label, accountId, credential = null, policy = null, health = null }) {
  return {
    provider: "openai-codex",
    label,
    identity: { accountId },
    credential: credential ?? {
      access: `ACCESS_${label}`,
      refresh: `REFRESH_${label}`,
      accountId,
      expiresAt: "2026-08-08T00:00:00.000Z",
    },
    policy: policy ?? { pool: { enabled: true } },
    ...(health ? { health } : {}),
  };
}

function reservedPolicy(accountId, { ownerHost = "test-host" } = {}) {
  return {
    expect: {
      codexDesktop: {
        reserved: true,
        ownerHost,
        identityFingerprint: buildCodexDesktopIdentityFingerprint(accountId),
        reservedAt: "2026-08-07T00:00:00.000Z",
      },
    },
    pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
  };
}

async function seedFixture({ records, nativeAccountId = null }) {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(
    store,
    { credentials: records },
    { updatedBy: "test", observedAt: "2026-08-07T00:00:00.000Z" },
  );
  let nativeAuthPath = null;
  if (nativeAccountId) {
    const nativeHome = path.join(home, ".codex");
    fs.mkdirSync(nativeHome, { recursive: true });
    nativeAuthPath = path.join(nativeHome, "auth.json");
    // Desktop-owned bytes, including fields AIM does not model; pin must
    // leave every byte untouched.
    fs.writeFileSync(nativeAuthPath, JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { account_id: nativeAccountId, id_token: "NATIVE_ID_TOKEN", access_token: "NATIVE_ACCESS" },
      last_refresh: "2026-08-06T00:00:00.000Z",
    }, null, 2));
  }
  const deps = {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
    hostnameImpl: () => "test-host",
    refreshCodexWithoutBrowserImpl: async () => {
      throw new Error("refresh impl not stubbed for this case");
    },
  };
  return { home, client, store, deps, nativeAuthPath };
}

function redisDump(client) {
  return JSON.stringify([...client.values.entries()].sort());
}

test("happy pin reserves the identity, retires the credential, and never touches native auth", async () => {
  const { home, client, store, deps, nativeAuthPath } = await seedFixture({
    records: [
      codexRecord({ label: "boss", accountId: "acct_pin_1" }),
      codexRecord({ label: "pool_b", accountId: "acct_pin_other" }),
    ],
    nativeAccountId: "acct_pin_1",
  });
  const nativeBytesBefore = fs.readFileSync(nativeAuthPath);
  let refreshedCredentialInput = null;
  deps.refreshCodexWithoutBrowserImpl = async ({ credential }) => {
    refreshedCredentialInput = credential;
    return {
      accountId: "acct_pin_1",
      access: "REFRESHED_ACCESS_MATERIAL",
      refresh: "REFRESHED_REFRESH_MATERIAL",
      expires: Date.now() + 3600_000,
    };
  };

  const out = await runCli(["codex", "desktop", "pin", "boss", "--home", home], deps);
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.status, "reserved");
  assert.equal(result.label, "boss");
  assert.equal(result.ownerHost, "test-host");
  assert.equal(result.credentialRetired, true);
  // Operator output carries labels/booleans/reasons only, never raw identity.
  assert.doesNotMatch(out, /acct_pin_1/);
  assert.doesNotMatch(out, /identityFingerprint/);

  assert.equal(refreshedCredentialInput.refresh, "REFRESH_boss");
  const snapshot = await readSnapshot(store);
  const record = snapshot.credentials.find((entry) => entry.label === "boss");
  assert.deepEqual(record.credential, {});
  assert.deepEqual(record.identity, { accountId: "acct_pin_1" });
  const reservation = record.policy.expect.codexDesktop;
  assert.equal(reservation.reserved, true);
  assert.equal(reservation.ownerHost, "test-host");
  assert.equal(reservation.identityFingerprint, buildCodexDesktopIdentityFingerprint("acct_pin_1"));
  assert.match(reservation.reservedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(record.policy.pool, { enabled: false, disabledReason: "codex_desktop_reserved" });
  assert.deepEqual(record.health, { status: "native_owned", reason: "codex_desktop_reserved" });

  // The refreshed material was deliberately discarded, not published anywhere.
  assert.doesNotMatch(redisDump(client), /REFRESHED_ACCESS_MATERIAL|REFRESHED_REFRESH_MATERIAL/);
  // Native Desktop auth is byte-identical.
  assert.deepEqual(fs.readFileSync(nativeAuthPath), nativeBytesBefore);
  // Catalog and credential leases were released.
  assert.equal(await client.get(`${KEY_PREFIX}:lease:identity-catalog:openai-codex`), null);
});

test("a pre-pin alias of the same immutable account blocks pin with zero writes", async () => {
  const { home, client, deps } = await seedFixture({
    records: [
      codexRecord({ label: "boss", accountId: "acct_dup" }),
      codexRecord({ label: "shadow", accountId: "acct_dup" }),
    ],
    nativeAccountId: "acct_dup",
  });
  const before = redisDump(client);

  const { stdout, exitCode } = await runCliWithExitCode(["codex", "desktop", "pin", "boss", "--home", home], deps);
  const result = JSON.parse(stdout);
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [{ reason: "identity_alias_conflict", labels: ["shadow"] }]);
  assert.equal(redisDump(client), before);
});

test("unreadable or mismatched native auth blocks pin with zero writes", async () => {
  const cases = [
    { nativeAccountId: null, reason: "native_auth_unreadable" },
    { nativeAccountId: "acct_someone_else", reason: "native_identity_mismatch" },
  ];
  for (const { nativeAccountId, reason } of cases) {
    const { home, client, deps } = await seedFixture({
      records: [codexRecord({ label: "boss", accountId: "acct_native" })],
      nativeAccountId,
    });
    deps.refreshCodexWithoutBrowserImpl = async () => ({ accountId: "acct_native" });
    const before = redisDump(client);
    const { stdout, exitCode } = await runCliWithExitCode(["codex", "desktop", "pin", "boss", "--home", home], deps);
    const result = JSON.parse(stdout);
    assert.equal(exitCode, 1);
    assert.deepEqual(result.blockers, [{ reason }]);
    assert.equal(redisDump(client), before);
  }
});

test("an identity mismatch after refresh blocks pin with zero writes", async () => {
  const { home, client, deps } = await seedFixture({
    records: [codexRecord({ label: "boss", accountId: "acct_expected" })],
    nativeAccountId: "acct_expected",
  });
  deps.refreshCodexWithoutBrowserImpl = async () => ({ accountId: "acct_rotated_elsewhere" });
  const before = redisDump(client);

  const { stdout, exitCode } = await runCliWithExitCode(["codex", "desktop", "pin", "boss", "--home", home], deps);
  const result = JSON.parse(stdout);
  assert.equal(exitCode, 1);
  assert.deepEqual(result.blockers, [{ reason: "identity_mismatch_after_refresh" }]);
  assert.equal(redisDump(client), before);
});

test("pinning an already reserved label is a no-op", async () => {
  const { home, client, deps } = await seedFixture({
    records: [codexRecord({
      label: "boss",
      accountId: "acct_noop",
      credential: {},
      policy: reservedPolicy("acct_noop"),
    })],
    nativeAccountId: "acct_noop",
  });
  const before = redisDump(client);
  const out = await runCli(["codex", "desktop", "pin", "boss", "--home", home], deps);
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.status, "noop");
  assert.equal(result.reserved, true);
  assert.equal(redisDump(client), before);
});

test("unpin requires the owning host and matching fingerprint, and never restores the credential", async () => {
  const { home, client, store, deps } = await seedFixture({
    records: [codexRecord({
      label: "boss",
      accountId: "acct_unpin",
      credential: {},
      policy: reservedPolicy("acct_unpin"),
    })],
  });

  const wrongHost = await runCliWithExitCode(
    ["codex", "desktop", "unpin", "boss", "--home", home],
    { ...deps, hostnameImpl: () => "another-host" },
  );
  assert.equal(wrongHost.exitCode, 1);
  assert.deepEqual(JSON.parse(wrongHost.stdout).blockers, [{ reason: "owner_host_mismatch" }]);

  const out = await runCli(["codex", "desktop", "unpin", "boss", "--home", home], deps);
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.status, "released");
  assert.equal(result.credentialRestored, false);

  const snapshot = await readSnapshot(store);
  const record = snapshot.credentials.find((entry) => entry.label === "boss");
  assert.equal(record.policy.expect.codexDesktop, undefined);
  // Unpin releases the reservation but never resurrects retired material; a
  // fresh `aim login` is the only way back into the pool.
  assert.deepEqual(record.credential, {});
  assert.deepEqual(record.policy.pool, { enabled: false });
  assert.deepEqual(record.health, { status: "candidate", reason: "credential_missing" });
  assert.equal(await client.get(`${KEY_PREFIX}:lease:identity-catalog:openai-codex`), null);
});

test("post-pin rebind and generic import under other labels reject the reserved account while its credential is empty", async () => {
  const { home, client, store, deps, nativeAuthPath } = await seedFixture({
    records: [
      codexRecord({ label: "boss", accountId: "acct_locked" }),
      // A drifted record whose stored identity differs from its credential
      // identity: invisible to the pin alias check, caught at rebind time.
      codexRecord({
        label: "drifter",
        accountId: "acct_drift",
        credential: {
          access: "ACCESS_drifter",
          refresh: "REFRESH_drifter",
          idToken: "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9sb2NrZWQifX0.",
          accountId: "acct_locked",
          expiresAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    ],
    nativeAccountId: "acct_locked",
  });
  deps.refreshCodexWithoutBrowserImpl = async () => ({ accountId: "acct_locked" });
  const pin = JSON.parse(await runCli(["codex", "desktop", "pin", "boss", "--home", home], deps));
  assert.equal(pin.status, "reserved");
  const reservedSnapshot = await readSnapshot(store);
  assert.deepEqual(reservedSnapshot.credentials.find((entry) => entry.label === "boss").credential, {});
  const before = redisDump(client);

  // Rebind of another label onto the reserved immutable account fails closed.
  await assert.rejects(
    () => runCli(["label", "rebind", "drifter", "--home", home, "--provider", "openai-codex", "--confirm"], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);

  // Generic import cannot re-introduce the reserved account under a new label.
  const aliasSnapshotPath = path.join(home, "alias-import.json");
  fs.writeFileSync(aliasSnapshotPath, JSON.stringify({
    credentials: [codexRecord({ label: "fresh_alias", accountId: "acct_locked" })],
  }));
  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", aliasSnapshotPath], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);

  // Generic import cannot re-add credential material to the reserved record
  // or drop its reservation object.
  const overwriteSnapshotPath = path.join(home, "overwrite-import.json");
  fs.writeFileSync(overwriteSnapshotPath, JSON.stringify({
    credentials: [codexRecord({ label: "boss", accountId: "acct_locked" })],
  }));
  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", overwriteSnapshotPath], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);
  assert.equal(fs.existsSync(nativeAuthPath), true);
});
