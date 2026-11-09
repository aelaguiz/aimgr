import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectRedisStore,closeRedisStore,readSnapshot } from '../../src/coordination/redis-store.js';
import { ensureClaudeAccountMetadata,readClaudeAccountMetadata } from '../../src/coordination/claude-metadata.js';
import { loadClaudeRuntime } from '../../src/coordination/claude-runtime.js';
import { loadRedisRuntime,refreshRedisRuntimeState } from '../../src/coordination/runtime.js';
import { writeAimgrConfig,getRedisConfig } from '../../src/config/aimgr-config.js';
import { FakeRedisClient } from '../helpers/fake-redis.js';

const identity={accountUuid:'synthetic-account',organizationUuid:'synthetic-org',emailAddress:'synthetic@example.invalid'};
async function checkBoundary(t,store) {
 const key=store.keys.credential({provider:'anthropic',label:'legacy'});
 const existing=JSON.stringify({provider:'anthropic',label:'legacy',identity,credential:{access:'SYNTHETIC_FOREIGN_ACCESS',refresh:'SYNTHETIC_FOREIGN_REFRESH'},policy:{expect:{email:identity.emailAddress},reauth:{blockedReason:'oauth_reauth_required'}},health:{status:'blocked'},version:9});
 await store.client.set(key,existing);await store.client.sAdd(store.keys.credentials(),key);await store.client.sAdd(store.keys.credentialsByProvider('anthropic'),key);
 const replies=[],original=store.client.eval.bind(store.client);
 store.client.eval=async(...args)=>{const reply=await original(...args);replies.push(reply);return reply;};
 const metadata=await readClaudeAccountMetadata(store);
 assert.equal(metadata[0].identity.organizationUuid,identity.organizationUuid);
 assert.deepEqual(metadata[0].credential,{});assert.equal(metadata[0].policy.reauth,undefined);assert.equal(metadata[0].health.status,'candidate');
 assert.equal(JSON.stringify(replies).includes('SYNTHETIC_FOREIGN'),false);
 const homeDir=fs.mkdtempSync(path.join(os.tmpdir(),'aim-claude-metadata-'));t.after(()=>fs.rmSync(homeDir,{recursive:true,force:true}));
 writeAimgrConfig({homeDir,config:{redis:{url:'redis://localhost:6379',keyPrefix:store.keyPrefix}}});
 const environment={binding:'a'.repeat(64)};
 const runtime=await loadClaudeRuntime({homeDir,environment,connectRedisStoreImpl:async()=>store});
 assert.deepEqual(runtime.state.credentials.anthropic ?? {},{});
 const offline=await loadClaudeRuntime({homeDir,environment,allowOffline:true,connectRedisStoreImpl:async()=>{throw new Error('offline');}});
 assert.equal(offline.offline,true);assert.equal(offline.snapshot.credentials[0].identity.accountUuid,identity.accountUuid);
 await assert.rejects(loadClaudeRuntime({homeDir,environment:{binding:'b'.repeat(64)},allowOffline:true,connectRedisStoreImpl:async()=>{throw new Error('offline');}}),/no verified local/);
 const scope=await loadRedisRuntime({homeDir,excludeCodexGrants:true,excludeClaudeGrants:true,connectRedisStoreImpl:async()=>store});
 assert.deepEqual(scope.snapshot.credentials,[]);await refreshRedisRuntimeState(scope);assert.deepEqual(scope.snapshot.credentials,[]);
 assert.equal(JSON.stringify(replies).includes('SYNTHETIC_FOREIGN'),false);
 assert.deepEqual(await ensureClaudeAccountMetadata(store,{label:'legacy',identity}),{outcome:'unchanged'});
 assert.equal(JSON.parse(await store.client.get(key)).credential.refresh,'SYNTHETIC_FOREIGN_REFRESH');
 await assert.rejects(ensureClaudeAccountMetadata(store,{label:'alias',identity}),/another label/);
 await assert.rejects(ensureClaudeAccountMetadata(store,{label:'legacy',identity:{...identity,organizationUuid:'different-org'}}),/another account or organization/);
 // Separate Prime/Pi authority remains explicitly available.
 assert.equal((await readSnapshot(store)).credentials[0].credential.refresh,'SYNTHETIC_FOREIGN_REFRESH');
}
test('safe Claude metadata, duplicate refusal, scoped reloads and offline cache',async t=>{
 const store=await connectRedisStore({client:new FakeRedisClient(),keyPrefix:`synthetic:${randomUUID()}:`});
 await checkBoundary(t,store);
});
test('real Redis never returns primary legacy grants to managed Claude readers',{skip:process.env.AIMGR_TEST_CLAUDE_REDIS!=='1'},async t=>{
 assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST'));
 const {redis}=getRedisConfig({homeDir:os.homedir()});
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(redis.url).hostname));
 const store=await connectRedisStore({...redis,keyPrefix:`aimgr:claude-local-test:${randomUUID()}:`});
 t.after(async()=>{try{const keys=await store.client.keys(`${store.keyPrefix}*`);if(keys.length)await store.client.del(keys);}finally{await closeRedisStore(store);}});
 await checkBoundary(t,store);
});
