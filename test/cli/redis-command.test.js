import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexDesktopIdentityFingerprint } from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

test("redis configure writes shared Redis config without creating machine identity", async () => {
  const home = mkTempHome();
  const stdout = await runCli([
    "redis",
    "configure",
    "--home",
    home,
    "--url",
    "redis://amirs-mac-studio:6380",
    "--key-prefix",
    "aimgr:test",
    "--primary-host",
    "agents@amirs-mac-studio",
    "--transport",
    "tailscale",
  ]);

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.redis.url, "redis://amirs-mac-studio:6380");
  assert.equal(result.redis.keyPrefix, "aimgr:test:");
  assert.equal(result.redis.primaryHost, "agents@amirs-mac-studio");
  assert.equal(result.redis.transport, "tailscale");
  assert.equal(Object.hasOwn(result, "machineId"), false);
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "machine-id")), false);

  const configStdout = await runCli(["redis", "config", "--home", home]);
  const config = JSON.parse(configStdout);
  assert.equal(config.exists, true);
  assert.equal(Object.hasOwn(config, "machineId"), false);
  assert.equal(Object.hasOwn(config, "machineIdPath"), false);
});

test("redis configure requires a url", async () => {
  await assert.rejects(
    () => runCli(["redis", "configure", "--home", mkTempHome(), "--primary-host", "agents@amirs-mac-studio"]),
    /Missing --url/,
  );
});

test("redis import rejects every credential- or identity-bearing Anthropic alias before opening Redis", async () => {
  const home = mkTempHome();
  const snapshotPath = path.join(home, "snapshot.json");
  const blockedRecords = [
    {
      provider: " Anthropic ",
      label: "duplicate_credential_alias",
      credential: {
        access: "FAKE_ACCESS",
        refresh: "FAKE_REFRESH",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    },
    {
      provider: "ANTHROPIC",
      label: "duplicate_identity_alias",
      identity: {
        email: "same-account@example.test",
        organizationUuid: "org_same_account",
      },
    },
    {
      provider: "Anthropic",
      label: "duplicate_stable_identity_alias",
      stableIdentity: {
        emailAddress: "same-account@example.test",
        organizationUuid: "org_same_account",
      },
    },
  ];

  for (const record of blockedRecords) {
    writeJson(snapshotPath, { credentials: [record] });
    await assert.rejects(
      () => runCli(["redis", "import", "--home", home, "--in", snapshotPath]),
      (err) => {
        assert.match(err.message, /Generic Redis import cannot write Claude credential or identity material/);
        assert.doesNotMatch(err.message, /AIM Redis is not configured/);
        return true;
      },
    );
  }
});

test("redis import leaves policy-only Anthropic candidates outside the credential-material block", async () => {
  const home = mkTempHome();
  const snapshotPath = path.join(home, "policy-only-snapshot.json");
  writeJson(snapshotPath, {
    credentials: [
      {
        provider: "anthropic",
        label: "pro7",
        policy: {
          expect: { email: "pro7@example.test" },
          pool: { enabled: true },
        },
      },
    ],
  });

  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", snapshotPath]),
    (err) => {
      // Reaching the missing-config boundary proves the policy-only record passed
      // the generic import's Anthropic credential/identity-material guard.
      assert.match(err.message, /AIM Redis is not configured/);
      assert.doesNotMatch(err.message, /Generic Redis import cannot write Claude/);
      return true;
    },
  );
});

function buildReservedCodexRecord({ label = "desktop", accountId = "acct_reserved" } = {}) {
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
          identityFingerprint: buildCodexDesktopIdentityFingerprint(accountId),
          reservedAt: "2026-08-07T00:00:00.000Z",
        },
      },
      pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
    },
    health: { status: "native_owned", reason: "codex_desktop_reserved" },
  };
}

async function seedImportFixture() {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const keyPrefix = "aimgr:import-gate-test";
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix } },
  });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(
    store,
    { credentials: [buildReservedCodexRecord()] },
    { updatedBy: "test", observedAt: "2026-08-07T00:00:00.000Z" },
  );
  const deps = { connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }) };
  return { home, client, store, deps };
}

function redisDump(client) {
  return JSON.stringify([...client.values.entries()].sort());
}

test("redis import rejects a codex record aliasing a Desktop-reserved identity under any label", async () => {
  const { home, client, deps } = await seedImportFixture();
  const snapshotPath = path.join(home, "alias.json");
  writeJson(snapshotPath, {
    credentials: [{
      provider: "openai-codex",
      label: "brand_new_alias",
      identity: { accountId: "acct_reserved" },
      credential: {
        access: "SNEAKY_ACCESS",
        refresh: "SNEAKY_REFRESH",
        accountId: "acct_reserved",
        expiresAt: "2026-08-08T00:00:00.000Z",
      },
      policy: { pool: { enabled: true } },
    }],
  });
  const before = redisDump(client);
  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", snapshotPath], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);
});

test("redis import rejects re-adding credential material or dropping the reservation on a reserved record", async () => {
  const { home, client, deps } = await seedImportFixture();
  const before = redisDump(client);

  // Re-adding credential material to the reserved record.
  const credentialPath = path.join(home, "readd-credential.json");
  const withCredential = buildReservedCodexRecord();
  withCredential.credential = {
    access: "RETIRED_ACCESS",
    refresh: "RETIRED_REFRESH",
    accountId: "acct_reserved",
    expiresAt: "2026-08-08T00:00:00.000Z",
  };
  writeJson(credentialPath, { credentials: [withCredential] });
  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", credentialPath], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);

  // Dropping/overwriting policy.expect.codexDesktop.
  const dropPath = path.join(home, "drop-reservation.json");
  const dropped = buildReservedCodexRecord();
  dropped.policy = { expect: {}, pool: { enabled: true } };
  writeJson(dropPath, { credentials: [dropped] });
  await assert.rejects(
    () => runCli(["redis", "import", "--home", home, "--in", dropPath], deps),
    /codex_desktop_reserved/,
  );
  assert.equal(redisDump(client), before);
});

test("redis import allows an exact reserved round-trip and unrelated codex records", async () => {
  const { home, client, store, deps } = await seedImportFixture();

  // An exact reservation round-trip is not an identity change; the generic
  // import still refuses to blindly overwrite the existing record version.
  const roundTripPath = path.join(home, "round-trip.json");
  writeJson(roundTripPath, { credentials: [buildReservedCodexRecord()] });
  const before = redisDump(client);
  const roundTrip = JSON.parse(await runCli(["redis", "import", "--home", home, "--in", roundTripPath], deps));
  assert.equal(roundTrip.ok, false);
  assert.equal(redisDump(client), before);

  // A brand-new unrelated codex identity imports cleanly.
  const freshPath = path.join(home, "fresh.json");
  writeJson(freshPath, {
    credentials: [{
      provider: "openai-codex",
      label: "pool_new",
      identity: { accountId: "acct_unrelated" },
      credential: {
        access: "ACCESS_pool_new",
        refresh: "REFRESH_pool_new",
        accountId: "acct_unrelated",
        expiresAt: "2026-08-08T00:00:00.000Z",
      },
      policy: { pool: { enabled: true } },
    }],
  });
  const fresh = JSON.parse(await runCli(["redis", "import", "--home", home, "--in", freshPath], deps));
  assert.equal(fresh.ok, true);
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.some((record) => record.label === "pool_new"), true);
  const reserved = snapshot.credentials.find((record) => record.label === "desktop");
  assert.deepEqual(reserved.credential, {});
  assert.equal(reserved.policy.expect.codexDesktop.reserved, true);
});
