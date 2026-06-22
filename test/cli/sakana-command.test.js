import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, readSnapshot } from "../../src/coordination/redis-store.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { resolveAimgrLocalStatePath } from "../../src/io/paths.js";
import { buildSakanaKeyFingerprint } from "../../src/providers/sakana.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome } from "../helpers/files.js";

const KEY_PREFIX = "aimgr:sakana-test";

function configureRedis(home) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
}

function connect(client) {
  return () => connectRedisStore({ client, keyPrefix: KEY_PREFIX });
}

test("aim sakana add stores account name + key in Redis and never echoes the raw key", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();
  const rawKey = "fish_supersecretkey_abcd";

  const stdout = await runCli(["sakana", "add", "pro1", "--key", rawKey, "--tier", "pro", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.action, "added");
  assert.equal(result.account.name, "pro1");
  assert.equal(result.account.tier, "pro");
  assert.equal(result.account.keyId, buildSakanaKeyFingerprint(rawKey));
  // The raw secret must never appear in CLI output.
  assert.doesNotMatch(stdout, /supersecretkey/);

  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  const snapshot = await readSnapshot(store);
  const record = snapshot.credentials.find((c) => c.provider === "sakana" && c.label === "pro1");
  assert.ok(record, "expected sakana credential record");
  assert.equal(record.credential.apiKey, rawKey);
  assert.equal(record.identity.keyFingerprint, buildSakanaKeyFingerprint(rawKey));

  // Raw key must not leak into the local projection file.
  const localStatePath = resolveAimgrLocalStatePath({ homeDir: home });
  if (fs.existsSync(localStatePath)) {
    assert.doesNotMatch(fs.readFileSync(localStatePath, "utf8"), /supersecretkey/);
  }
});

test("aim sakana add accepts the key piped on stdin", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();
  const rawKey = "fish_pipedkey_0001";

  async function* pipe() {
    yield `${rawKey}\n`;
  }
  const stdin = pipe();
  stdin.isTTY = false;

  const stdout = await runCli(["sakana", "add", "std1", "--home", home], {
    connectRedisStoreImpl: connect(client),
    stdin,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.account.name, "std1");
  assert.equal(result.account.keyId, buildSakanaKeyFingerprint(rawKey));
});

test("aim sakana list and show redact the key; remove deletes it", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();

  await runCli(["sakana", "add", "pro1", "--key", "fish_key_one", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });
  await runCli(["sakana", "add", "max1", "--key", "fish_key_two", "--tier", "max", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });

  const listOut = await runCli(["sakana", "list", "--home", home], { connectRedisStoreImpl: connect(client) });
  const list = JSON.parse(listOut);
  assert.equal(list.count, 2);
  assert.deepEqual(
    list.accounts.map((a) => a.name),
    ["max1", "pro1"],
  );
  assert.doesNotMatch(listOut, /fish_key_one|fish_key_two/);

  const showOut = await runCli(["sakana", "show", "pro1", "--home", home], { connectRedisStoreImpl: connect(client) });
  assert.doesNotMatch(showOut, /fish_key_one/);
  assert.match(showOut, /\*\*\*_one/);

  const removeOut = await runCli(["sakana", "remove", "pro1", "--home", home], { connectRedisStoreImpl: connect(client) });
  assert.equal(JSON.parse(removeOut).action, "removed");

  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.filter((c) => c.provider === "sakana").length, 1);
});

test("aim sakana use projects the selected key to ~/.codex/.env and preserves unrelated lines", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();
  const codexHome = path.join(home, ".codex");
  const envPath = path.join(codexHome, ".env");
  const authPath = path.join(codexHome, "auth.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(envPath, "KEEP_ME=1\nSAKANA_API_KEY=old_key\nOTHER=two\nexport SAKANA_API_KEY=duplicate_old\n", {
    encoding: "utf8",
    mode: 0o644,
  });
  fs.writeFileSync(authPath, "{\"openai\":\"untouched\"}\n", "utf8");

  await runCli(["sakana", "add", "pro1", "--key", "fish_key_one", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });
  const stdout = await runCli(["sakana", "use", "pro1", "--home", home], { connectRedisStoreImpl: connect(client) });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.action, "used");
  assert.equal(result.target.activeName, "pro1");
  assert.equal(result.target.keyId, buildSakanaKeyFingerprint("fish_key_one"));
  assert.doesNotMatch(stdout, /fish_key_one/);

  assert.equal(
    fs.readFileSync(envPath, "utf8"),
    "KEEP_ME=1\nSAKANA_API_KEY=fish_key_one\nOTHER=two\n",
  );
  assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), "600");
  assert.equal(fs.readFileSync(authPath, "utf8"), "{\"openai\":\"untouched\"}\n");

  const localStateText = fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8");
  assert.match(localStateText, /sakanaCodex/);
  assert.match(localStateText, /pro1/);
  assert.doesNotMatch(localStateText, /fish_key_one/);
});

test("aim sakana use can create ~/.codex/.env when it does not exist", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();

  await runCli(["sakana", "add", "pro1", "--key", "fish_key_one", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });
  await runCli(["sakana", "use", "pro1", "--home", home], { connectRedisStoreImpl: connect(client) });

  assert.equal(fs.readFileSync(path.join(home, ".codex", ".env"), "utf8"), "SAKANA_API_KEY=fish_key_one\n");
});

test("aim sakana add refuses to change the key of an existing account name", async () => {
  const home = mkTempHome();
  configureRedis(home);
  const client = new FakeRedisClient();

  await runCli(["sakana", "add", "pro1", "--key", "fish_key_one", "--home", home], {
    connectRedisStoreImpl: connect(client),
  });
  await assert.rejects(
    runCli(["sakana", "add", "pro1", "--key", "fish_key_DIFFERENT", "--home", home], {
      connectRedisStoreImpl: connect(client),
    }),
    /Refusing to change the API key/,
  );
});
