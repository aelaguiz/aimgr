import test from "node:test";
import assert from "node:assert/strict";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome } from "../helpers/files.js";

const PREFIX = "aimgr:claude-command-test";
const NOW_MS = Date.parse("2026-07-22T18:00:00.000Z");

test("Claude inventory and status use Redis candidates without Keychain or provider work", async () => {
  const homeDir = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: "anthropic",
          label: "coder",
          credential: {},
          identity: {},
          policy: {
            expect: { email: "private-account@example.test" },
            pool: { enabled: true },
          },
          health: { status: "candidate", reason: "credential_missing" },
          provenance: {
            evidenceGrade: "provider-current",
            evidenceAsOf: "2026-07-22",
          },
        },
      ],
    },
    { updatedBy: "test", observedAt: new Date(NOW_MS).toISOString() },
  );

  const forbidden = () => {
    throw new Error("forbidden boundary was invoked");
  };
  const deps = {
    nowImpl: () => NOW_MS,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    readClaudeNativeKeychainOauthImpl: forbidden,
    fetchJsonWithTimeoutImpl: forbidden,
  };

  const inventory = JSON.parse(await runCli(
    ["claude", "inventory", "--json", "--home", homeDir],
    deps,
  ));
  assert.equal(inventory.requestCount, 0);
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.accounts.map((account) => account.label), ["coder"]);
  assert.equal(inventory.accounts[0].state, "credential_missing");

  const statusResult = await runCliWithExitCode(
    ["claude", "status", "coder", "--json", "--home", homeDir],
    deps,
  );
  const status = JSON.parse(statusResult.stdout);
  assert.equal(statusResult.exitCode, 1);
  assert.equal(status.requestCount, 0);
  assert.equal(status.accounts[0].authState, "credential_missing");

  const publicOutput = `${JSON.stringify(inventory)}\n${statusResult.stdout}`;
  assert.doesNotMatch(publicOutput, /private-account|example\.test|default|puzzledb/i);
});
