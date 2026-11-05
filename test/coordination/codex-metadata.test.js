import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { main } from "../../src/cli/main.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { readLocalCodexCredential } from "../../src/credentials/codex-local.js";
import { CODEX_TEST_ENVIRONMENT } from "../helpers/codex-local.js";
import { getRedisConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, closeRedisStore, readSnapshot } from "../../src/coordination/redis-store.js";
import { loadRedisRuntime, refreshRedisRuntimeSnapshot, refreshRedisRuntimeState } from "../../src/coordination/runtime.js";
import { ensureCodexAccountMetadata, readCodexAccountMetadata } from "../../src/coordination/codex-metadata.js";

test("Codex metadata crosses the Redis boundary without legacy grants or grant-local failures",{
  skip:process.env.AIMGR_TEST_CODEX_REDIS!=="1",
},async t=>{
  assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
  const {redis}=getRedisConfig({homeDir:os.homedir()});
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(new URL(redis.url).hostname),"use only the isolated VM's local test Redis");
  const store=await connectRedisStore({...redis,keyPrefix:`aimgr:codex-m1-test:${randomUUID()}:`});
  const provider="openai-codex",key=label=>store.keys.credential({provider,label});
  t.after(async()=>{
    try {await store.client.del([key("legacy"),key("new"),store.keys.credentials(),store.keys.credentialsByProvider(provider)]);}
    finally {await closeRedisStore(store);}
  });
  const existing=JSON.stringify({provider,label:"legacy",identity:{accountId:"fixture-account"},
    credential:{access:"SYNTHETIC_FOREIGN_ACCESS",refresh:"SYNTHETIC_FOREIGN_REFRESH"},
    policy:{pool:{enabled:true},reauth:{blockedReason:"oauth_reauth_required"},egress:{profileRef:"synthetic-route"}},version:9});
  await store.client.set(key("legacy"),existing);
  await store.client.sAdd(store.keys.credentials(),key("legacy"));
  await store.client.sAdd(store.keys.credentialsByProvider(provider),key("legacy"));
  const replies=[],originalEval=store.client.eval.bind(store.client);
  store.client.eval=async(...args)=>{const reply=await originalEval(...args);replies.push(reply);return reply;};
  const metadata=await readCodexAccountMetadata(store);
  assert.equal(metadata[0].accountId,"fixture-account");
  assert.equal(metadata[0].policy.reauth,undefined);
  assert.equal(metadata[0].credential,undefined);
  assert.equal(JSON.stringify(replies).includes("SYNTHETIC_FOREIGN"),false);
  assert.equal((await readSnapshot(store,{excludeCodexGrants:true})).credentials.length,0);
  assert.equal(JSON.stringify(replies).includes("SYNTHETIC_FOREIGN"),false);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-snapshot-scope-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  writeAimgrConfig({ homeDir, config: { redis: { ...redis, keyPrefix: store.keyPrefix } } });
  const originalGet = store.client.get.bind(store.client), originalMGet = store.client.mGet.bind(store.client);
  store.client.get = async keyName => {
    assert.notEqual(keyName, key("legacy"), "scoped readers cannot retrieve the legacy grant");
    return originalGet(keyName);
  };
  store.client.mGet = async keyNames => {
    assert.equal(keyNames.includes(key("legacy")), false, "scoped readers cannot retrieve the legacy grant");
    return originalMGet(keyNames);
  };
  try {
    for (const scope of [{ provider: "anthropic" }, { provider: "xai" }, { excludeCodexGrants: true }]) {
      const runtime = await loadRedisRuntime({ homeDir, ...scope, connectRedisStoreImpl: async () => store });
      assert.deepEqual(runtime.snapshot.credentials, []);
      assert.deepEqual((await refreshRedisRuntimeSnapshot(runtime)).credentials, []);
      await refreshRedisRuntimeState(runtime);
      assert.deepEqual(runtime.snapshot.credentials, []);
    }
    assert.equal(JSON.stringify(replies).includes("SYNTHETIC_FOREIGN"), false);
  } finally {
    store.client.get = originalGet; store.client.mGet = originalMGet;
  }
  // Separately scoped Prime/Pi owners retain their existing authority. This
  // test does not authorize native Codex or generic maintenance to use it.
  const legacyRuntime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl: async () => store });
  assert.equal(legacyRuntime.snapshot.credentials[0].credential.refresh, "SYNTHETIC_FOREIGN_REFRESH");
  assert.deepEqual(await ensureCodexAccountMetadata(store,{label:"legacy",accountId:"fixture-account"}),{outcome:"unchanged"});
  assert.equal(await store.client.get(key("legacy")),existing);
  await assert.rejects(ensureCodexAccountMetadata(store,{label:"legacy",accountId:"another-account"}),/different/);
  assert.equal(await store.client.get(key("legacy")),existing);
  assert.deepEqual(await ensureCodexAccountMetadata(store,{label:"new",accountId:"new-account"}),{outcome:"created"});
  const created=JSON.parse(await store.client.get(key("new")));
  assert.deepEqual(created.credential,{});
  assert.equal((await readCodexAccountMetadata(store)).length,2);
});

test("manual Codex login reconnects Redis after the browser handoff", {
  skip: process.env.AIMGR_TEST_CODEX_REDIS !== "1",
}, async t => {
  assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
  const { redis } = getRedisConfig({ homeDir: os.homedir() });
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(redis.url).hostname));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-login-redis-"));
  const keyPrefix = `aimgr:codex-login-test:${randomUUID()}:`;
  writeAimgrConfig({ homeDir, config: { redis: { ...redis, keyPrefix } } });
  const stores = [], events = [], input = new PassThrough();
  let callback, openAtHandoff;
  t.after(async () => {
    input.destroy();
    await callback;
    for (const store of stores) await closeRedisStore(store);
    const cleanup = await connectRedisStore({ ...redis, keyPrefix });
    try {
      await cleanup.client.del([cleanup.keys.credential({ provider: "openai-codex", label: "synthetic" }),
        cleanup.keys.credentials(), cleanup.keys.credentialsByProvider("openai-codex")]);
    } finally { await closeRedisStore(cleanup); }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp: 4102444800,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
  await main(["codex", "login", "synthetic", "--manual-callback-stdio", "--home", homeDir], {
    env: {}, stdin: input, setExitCode() {},
    readCodexEnvironmentImpl: () => CODEX_TEST_ENVIRONMENT,
    connectRedisStoreImpl: async options => {
      // Compress the real five-second idle deadline; no fake Redis client.
      const store = await connectRedisStore({ ...options, initialConnectTimeoutMs: 100 });
      stores.push(store); return store;
    },
    stdout: { write(line) {
      const event = JSON.parse(line); events.push(event);
      if (event.type === "auth_url") {
        openAtHandoff = stores[0].client.isOpen;
        callback = delay(350).then(() => {
          const url = new URL("http://localhost:1455/auth/callback");
          url.search = new URLSearchParams({ code: "SYNTHETIC_CODE", state: new URL(event.url).searchParams.get("state") });
          input.write(JSON.stringify({ callbackUrl: url.href }) + "\n");
        });
      }
      return true;
    } },
    fetchJsonWithTimeoutImpl: async () => ({ ok: true, status: 200, json: async () => ({
      access_token: token, id_token: token, refresh_token: "SYNTHETIC_LOCAL_REFRESH", expires_in: 3600,
    }) }),
  });
  assert.equal(events.at(-1).ok, true, events.at(-1).error);
  assert.equal(openAtHandoff, false, "no Redis socket waits on the human login");
  assert.equal(stores.length, 2, "metadata publication uses a fresh bounded connection");
  assert.equal(readLocalCodexCredential({ homeDir, environment: CODEX_TEST_ENVIRONMENT,
    accountId: "synthetic-account" }).credential.refresh, "SYNTHETIC_LOCAL_REFRESH");
});
