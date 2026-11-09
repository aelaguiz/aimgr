import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { handleLocalClaudeAuth } from '../../src/cli/commands/claude-local-auth.js';
import { connectRedisStore } from '../../src/coordination/redis-store.js';
import { ensureClaudeAccountMetadata } from '../../src/coordination/claude-metadata.js';
import { readLocalClaudeCredential } from '../../src/credentials/claude-local.js';
import { writeAimgrConfig } from '../../src/config/aimgr-config.js';
import { FakeRedisClient } from '../helpers/fake-redis.js';

const identity = {accountUuid:'synthetic-account',organizationUuid:'synthetic-org',emailAddress:'synthetic@example.invalid',organizationName:'Synthetic'};
const environment = {binding:'a'.repeat(64)};
const authorize = 'https://claude.com/cai/oauth/authorize?state=synthetic-state&client_id=fixture&code_challenge=fixture&code_challenge_method=S256&redirect_uri='+encodeURIComponent('https://platform.claude.com/oauth/code/callback');
const callback = 'https://platform.claude.com/oauth/code/callback?code=synthetic-code&state=synthetic-state';
const nativeScript = `
const fs=require('node:fs'), path=require('node:path');
const {spawnSync}=require('node:child_process');
const config=process.argv[1];
if(spawnSync(process.env.BROWSER,['https://localhost.invalid'],{env:process.env}).status!==0) process.exit(8);
const readline=require('node:readline').createInterface({input:process.stdin,terminal:false});
readline.on('line',line=>{
 if(line!=='synthetic-code#synthetic-state') process.exit(9);
 fs.writeFileSync(path.join(config,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,scopes:['user:profile','user:inference'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x'}}),{mode:0o600});
 fs.writeFileSync(path.join(config,'.claude.json'),JSON.stringify({oauthAccount:${JSON.stringify(identity)}}),{mode:0o600});
 process.stdout.write('NATIVE PRIVATE SUCCESS TEXT\\n');process.exit(0);
});
process.stderr.write('NATIVE PRIVATE DIAGNOSTIC\\n');
process.stdout.write(${JSON.stringify(authorize+'\n')});
`;

for (const mode of ['human-url','human-code','json-url','json-code','wrong-state','closed-input']) {
 test(`Claude manual login ${mode}: native stdin bridge, browser suppression, storage and cleanup`,{timeout:15000},async t=>{
  const homeDir=fs.mkdtempSync(path.join(os.tmpdir(),'aim-manual-'));t.after(()=>fs.rmSync(homeDir,{recursive:true,force:true}));
  writeAimgrConfig({homeDir,config:{redis:{url:'redis://fake:6379',keyPrefix:'fixture:'}}});
  const client=new FakeRedisClient(),store=await connectRedisStore({client,keyPrefix:'fixture:'});
  await ensureClaudeAccountMetadata(store,{label:'synthetic',identity});
  const metadata={provider:'anthropic',label:'synthetic',identity,policy:{expect:{email:identity.emailAddress}}};
  const stdin=new PassThrough(),stdout=new PassThrough();let output='',responded=false,exitCode=0,staging,child;
  t.after(()=>{child?.kill();stdin.destroy();stdout.destroy();});
  const jsonl=!mode.startsWith('human');
  stdout.on('data',bytes=>{
   output+=bytes.toString();
   if(responded || !output.includes(jsonl?'"type":"auth_url"':authorize)) return;
   responded=true;
   if(mode==='closed-input') {stdin.end();return;}
   const value=mode==='wrong-state'?{url:callback.replace('synthetic-state','wrong-state')}:mode.endsWith('code')?{code:'synthetic-code#synthetic-state'}:{url:callback};
   stdin.write((jsonl?JSON.stringify(value):Object.values(value)[0])+'\n');
  });
  const resolve=()=>process.execPath;resolve.prepareClaudeCliLaunchImpl=async options=>options;
  await handleLocalClaudeAuth({homeDir,opts:{manualCallbackStdio:jsonl},positional:['claude','login','synthetic'],stdin,stdout,
   env:{...process.env,BROWSER:'/does/not/exist',DISPLAY:':99',WAYLAND_DISPLAY:'bad'},
   connectRedisStoreImpl:async()=>store,readClaudeEnvironmentImpl:()=>environment,resolveExecutableOnPathImpl:resolve,
   assertClaudeNativeOwnersStoppedImpl:async()=>{},setExitCode:code=>{exitCode=code;},
   runClaudeCliImpl:async launch=>{
    staging=launch.homeDir;
    assert.match(launch.env.BROWSER,/claude-login-no-browser\.mjs$/);
    assert.equal(launch.env.DISPLAY,undefined);
    child=launch.spawnImpl(process.execPath,['-e',nativeScript,launch.configDir],{env:launch.env,signal:launch.signal,stdio:['inherit','inherit','inherit']});
    return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
   }});
  assert.equal(responded,true);assert.equal(fs.existsSync(staging),false);assert.doesNotMatch(output,/NATIVE PRIVATE|synthetic-access|synthetic-refresh/);
  const local=readLocalClaudeCredential({homeDir,label:'synthetic',metadata,environment,command:process.execPath});
  if(mode==='wrong-state'||mode==='closed-input') {
   assert.equal(exitCode,1);assert.equal(local.status,'login_required');assert.equal(JSON.parse(output.trim().split('\n').at(-1)).type,'error');
  } else {
   assert.equal(exitCode,0);assert.equal(local.status,'ready');
   if(jsonl) assert.deepEqual(output.trim().split('\n').map(line=>JSON.parse(line).type),['auth_url','result']);
   else assert.match(output,/Claude synthetic is signed in on this machine/);
   const record=JSON.parse(await client.get(store.keys.credential({provider:'anthropic',label:'synthetic'})));
   assert.equal(record.credential.access,undefined);
  }
 });
}
