import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { getRedisConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, closeRedisStore, readSnapshot } from "../../src/coordination/redis-store.js";
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
    policy:{pool:{enabled:true},reauth:{blockedReason:"oauth_reauth_required"},egress:{mode:"synthetic-route"}},version:9});
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
  assert.deepEqual(await ensureCodexAccountMetadata(store,{label:"legacy",accountId:"fixture-account"}),{outcome:"unchanged"});
  assert.equal(await store.client.get(key("legacy")),existing);
  await assert.rejects(ensureCodexAccountMetadata(store,{label:"legacy",accountId:"another-account"}),/different/);
  assert.equal(await store.client.get(key("legacy")),existing);
  assert.deepEqual(await ensureCodexAccountMetadata(store,{label:"new",accountId:"new-account"}),{outcome:"created"});
  const created=JSON.parse(await store.client.get(key("new")));
  assert.deepEqual(created.credential,{});
  assert.equal((await readCodexAccountMetadata(store)).length,2);
});
