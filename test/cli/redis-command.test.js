import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
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
