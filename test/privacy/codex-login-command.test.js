import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../../src/cli/main.js';
import { connectRedisStore } from '../../src/coordination/redis-store.js';
import { ensureCodexAccountMetadata } from '../../src/coordination/codex-metadata.js';
import { readLocalCodexCredential } from '../../src/credentials/codex-local.js';
import { writeAimgrConfig } from '../../src/config/aimgr-config.js';
import { FakeRedisClient } from '../helpers/fake-redis.js';

for(const jsonl of [false,true]) test(`Codex local login ${jsonl?'JSONL':'plain text'} ignores old browser policy and stores only locally`,async t=>{
 const homeDir=fs.mkdtempSync(path.join(os.tmpdir(),'aim-codex-manual-'));t.after(()=>fs.rmSync(homeDir,{recursive:true,force:true}));
 const environment={binding:'b'.repeat(64)}, accountId='synthetic-account';
 writeAimgrConfig({homeDir,config:{redis:{url:'redis://fake:6379',keyPrefix:'fixture:'}}});
 const client=new FakeRedisClient(),store=await connectRedisStore({client,keyPrefix:'fixture:'});
 await ensureCodexAccountMetadata(store,{label:'synthetic',accountId});
 const key=store.keys.credential({provider:'openai-codex',label:'synthetic'});
 const record=JSON.parse(await client.get(key));record.policy.browser={mode:'aim-profile'};record.policy.reauth={mode:'browser-managed'};
 await client.set(key,JSON.stringify(record));const before=await client.get(key);
 const stdin=new PassThrough();t.after(()=>stdin.destroy());let output='',sent=false,requests=0;
 const stdout={write(chunk){output+=chunk; if(!sent){const url=jsonl?JSON.parse(chunk).url:String(chunk).match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];if(url){sent=true;const state=new URL(url).searchParams.get('state');const callback='http://localhost:1455/auth/callback?code=synthetic-code&state='+state;stdin.write((jsonl?JSON.stringify({url:callback}):callback)+'\n');}}return true;}};
 const jwt='e30.'+Buffer.from(JSON.stringify({chatgpt_account_id:accountId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.synthetic';
 await main(['codex','login','synthetic','--home',homeDir,...(jsonl?['--manual-callback-stdio']:[])],{
  stdin,stdout,env:{},readCodexEnvironmentImpl:()=>environment,connectRedisStoreImpl:async()=>store,
  openUrlImpl:()=>assert.fail('must never open browser'),loginOpenAICodexImpl:()=>assert.fail('retired transport'),
  fetchJsonWithTimeoutImpl:async(url,options)=>{requests++;assert.equal(url,'https://auth.openai.com/oauth/token');assert.equal(options.body.get('code'),'synthetic-code');return {ok:true,json:async()=>({access_token:jwt,id_token:jwt,refresh_token:'synthetic-refresh',expires_in:3600})};},
  setExitCode:()=>assert.fail('login failed')});
 assert.equal(requests,1);assert.equal(await client.get(key),before);
 assert.equal(readLocalCodexCredential({homeDir,environment,accountId}).status,'ready');
 if(jsonl)assert.deepEqual(output.trim().split('\n').map(line=>JSON.parse(line).type),['auth_url','result']);
 else assert.match(output,/Codex synthetic is signed in on this machine/);
});
