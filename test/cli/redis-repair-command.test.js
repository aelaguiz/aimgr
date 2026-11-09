import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

async function seed(client) {
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:repair-test" });
  const token = makeFakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_new" },
  });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: "openai-codex",
          label: "boss",
          identity: { accountId: "acct_old" },
          credential: {
            access: token,
            refresh: "REFRESH_BOSS",
            idToken: token,
            accountId: "acct_new",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          policy: { pool: { enabled: true } },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

function configureRedis(home) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:repair-test" } },
  });
}

test("label rebind repairs identity on the single shared credential", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  configureRedis(home);
  const store = await seed(client);

  const rebindOut = await runCli(["label", "rebind", "boss", "--home", home, "--provider", "openai-codex", "--confirm"], {
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: "aimgr:repair-test" }),
  });
  const rebind = JSON.parse(rebindOut);
  assert.equal(rebind.ok, true);
  const snapshot = await readSnapshot(store);
  assert.deepEqual(snapshot.credentials[0].identity, { accountId: "acct_new" });
});

test("repair commands require confirmation and provider", async () => {
  await assert.rejects(
    () => runCli(["label", "rebind", "boss", "--home", mkTempHome(), "--provider", "openai-codex"]),
    /requires --confirm/,
  );
  await assert.rejects(
    () => runCli(["label", "rebind", "boss", "--home", mkTempHome(), "--confirm"]),
    /requires --provider/,
  );
});
