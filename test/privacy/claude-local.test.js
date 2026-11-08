import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeEnvironment, claudeOwnerBinding } from '../../src/privacy/claude-environment.js';
import { readLocalClaudeCredential, saveLocalClaudeLogin, logoutLocalClaudeCredential, assertClaudeCredentialExportable } from '../../src/credentials/claude-local.js';
import { validateClaudeManualCallback } from '../../src/cli/commands/claude-local-auth.js';
import { clonePortableAnthropicCredential } from '../../src/credentials/anthropic-portable.js';

const environment = {binding:'a'.repeat(64)};
const identity = {accountUuid:'synthetic-account',organizationUuid:'synthetic-org',emailAddress:'synthetic@example.invalid',organizationName:'Synthetic'};
const metadata = {provider:'anthropic',label:'synthetic',identity,policy:{expect:{email:identity.emailAddress}}};
const bundle = token => ({oauthAccount:identity,claudeAiOauth:{accessToken:`access-${token}`,refreshToken:`refresh-${token}`,expiresAt:Date.now()+3600000,scopes:['user:profile','user:inference'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x'}});
function fixture(t) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'aim-claude-local-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 return {homeDir:home,label:'synthetic',metadata,environment,command:process.execPath,assertStopped:async()=>{}};
}
test('environment digest is account and organization specific; no raw marker in owner',()=>{
 const anchor={schema:1,id:'12345678-1234-4123-8123-123456789abc'};
 const env=readClaudeEnvironment({uid:1234,inspect:()=>({kind:'file',bytes:Buffer.from(JSON.stringify(anchor))})});
 assert.equal(env.binding.length,64);assert.notEqual(claudeOwnerBinding(env,identity),claudeOwnerBinding(env,{...identity,organizationUuid:'other'}));
 assert.notEqual(claudeOwnerBinding(env,identity),claudeOwnerBinding(env,{...identity,accountUuid:'other'}));
 assert.throws(()=>readClaudeEnvironment({uid:1234,inspect:()=>({kind:'file',bytes:Buffer.from('{}')})}));
});
test('local native enrollment, concurrent same-owner relogin, mixed secrets preservation and logout',async t=>{
 const options=fixture(t);assert.equal(readLocalClaudeCredential(options).status,'login_required');
 let local=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('first')});
 assert.equal(local.status,'ready');const oldGrant=local.owner.grant.id;const fields=local.owner.fields;
 const file=local.descriptor.credentialsPath;
 fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),mcpOAuth:{third:{accessToken:'mcp-secret'}},pluginSecrets:{third:'plugin-secret'}}),{mode:0o600});
 // Same-owner replacement does not invoke stopped-owner inventory.
 local=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('second'),assertStopped:async()=>assert.fail('same owner must stay concurrent')});
 assert.notEqual(local.owner.grant.id,oldGrant);assert.deepEqual(local.owner.fields,fields);
 assert.equal(JSON.parse(fs.readFileSync(file)).mcpOAuth.third.accessToken,'mcp-secret');
 assert.equal(readLocalClaudeCredential({...options,environment:{binding:'b'.repeat(64)}}).status,'login_required');
 assert.throws(()=>assertClaudeCredentialExportable(local.credential));assert.throws(()=>clonePortableAnthropicCredential(local.credential));
 await logoutLocalClaudeCredential(options);
 assert.equal(readLocalClaudeCredential(options).status,'login_required');
 const auth=JSON.parse(fs.readFileSync(file));assert.equal(auth.claudeAiOauth,undefined);assert.equal(auth.mcpOAuth.third.accessToken,'mcp-secret');
 assert.equal(auth.pluginSecrets.third,'plugin-secret');
});
test('legacy token and forged metadata never establish local authorization',t=>{
 const options=fixture(t),config=path.join(options.homeDir,'.aimgr','claude-homes','synthetic','.claude');
 fs.mkdirSync(config,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(config,'.credentials.json'),JSON.stringify({claudeAiOauth:bundle('legacy').claudeAiOauth}),{mode:0o600});
 fs.writeFileSync(path.join(config,'.claude.json'),JSON.stringify({oauthAccount:identity}),{mode:0o600});
 assert.equal(readLocalClaudeCredential(options).status,'login_required');
});
test('manual callback is bound to the native state and exact redirect',()=>{
 const url='https://claude.ai/oauth/authorize?state=expected&redirect_uri='+encodeURIComponent('https://console.anthropic.com/oauth/code/callback');
 assert.equal(validateClaudeManualCallback({code:'one-time#expected'},url),'one-time#expected');
 assert.equal(validateClaudeManualCallback({url:'https://console.anthropic.com/oauth/code/callback?code=one-time&state=expected'},url),'one-time#expected');
 for(const input of [{code:'one-time#wrong'},{url:'https://evil.invalid/oauth/code/callback?code=x&state=expected'},{url:'https://console.anthropic.com/wrong?code=x&state=expected'},{code:'x#expected',url:'https://x.invalid'}]) assert.throws(()=>validateClaudeManualCallback(input,url));
});

test('relogin waits outside storage locks for a native refresh already in flight',async t=>{
 const {default:lockfile}=await import('proper-lockfile');
 const {setTimeout:delay}=await import('node:timers/promises');
 const {withClaudeNativeStateLocks}=await import('../../src/credentials/claude-native-state-lock.js');
 const options=fixture(t);
 const initial=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('before')});
 const config=initial.configDir;
 const releaseNew=await lockfile.lock(config,{realpath:false,lockfilePath:path.join(config,'.oauth_refresh.lock'),stale:60000,update:5000});
 const releaseLegacy=await lockfile.lock(fs.realpathSync(config)+".lock",{realpath:false,lockfilePath:fs.realpathSync(config)+'.lock',stale:60000,update:5000});
 let settled=false;
 const relogin=saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('relogin'),assertStopped:async()=>assert.fail('no stopped check')}).finally(()=>{settled=true;});
 await delay(150);assert.equal(settled,false);
 // Native can still finish its storage write while AIM waits on refresh.
 await withClaudeNativeStateLocks({configDir:config,appStatePath:initial.descriptor.appStatePath},()=>{
  const auth=JSON.parse(fs.readFileSync(initial.descriptor.credentialsPath));
  auth.claudeAiOauth=bundle('native-refresh').claudeAiOauth;auth.mcpOAuth={third:{accessToken:'latest-third-party'}};
  fs.writeFileSync(initial.descriptor.credentialsPath,JSON.stringify(auth),{mode:0o600});
 });
 await releaseLegacy();await releaseNew();
 const result=await relogin;
 assert.equal(result.nativeClaudeBundle.claudeAiOauth.accessToken,'access-relogin');
 assert.equal(JSON.parse(fs.readFileSync(initial.descriptor.credentialsPath)).mcpOAuth.third.accessToken,'latest-third-party');
});
test('rejected old generation cannot invalidate successful newer relogin',async t=>{
 const {markLocalClaudeGrantRejected}=await import('../../src/credentials/claude-local.js');
 const options=fixture(t);
 const old=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('old')});
 const newer=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('new')});
 assert.equal(await markLocalClaudeGrantRejected({...options,grantId:old.owner.grant.id,generation:old.generation}),false);
 assert.equal(readLocalClaudeCredential(options).owner.grant.id,newer.owner.grant.id);
 assert.equal(readLocalClaudeCredential(options).status,'ready');
 assert.equal(await markLocalClaudeGrantRejected({...options,grantId:newer.owner.grant.id,generation:newer.generation}),true);
 assert.equal(readLocalClaudeCredential(options).status,'reauth_required');
});

test('native manual URL waits for the complete output token across every stream split',async()=>{
 const {extractNativeClaudeManualUrl}=await import('../../src/cli/commands/claude-local-auth.js');
 const url='https://claude.ai/oauth/authorize?state=expected&redirect_uri='+encodeURIComponent('https://console.anthropic.com/oauth/code/callback')+'&client_id=native-client&code_challenge=native-pkce&code_challenge_method=S256';
 for(let split=1;split<url.length;split++) {
  assert.equal(extractNativeClaudeManualUrl('Native: '+url.slice(0,split)),null);
  assert.equal(extractNativeClaudeManualUrl('Native: '+url.slice(0,split)+url.slice(split)+'\n'),url);
 }
 assert.equal(extractNativeClaudeManualUrl(url),null);
 assert.equal(extractNativeClaudeManualUrl('\u001b]8;;'+url+'\u001b\\Sign in\u001b]8;;\u001b\\'),url);
 const currentNative=url.replace('https://claude.ai/oauth/authorize','https://claude.com/cai/oauth/authorize');
 assert.equal(extractNativeClaudeManualUrl(currentNative+'\n'),currentNative);
 assert.equal(extractNativeClaudeManualUrl(currentNative.replace('/cai/oauth/authorize','/unrelated')+'\n'),null);
});

test('direct interactive login keeps native browser behavior; routed and manual login use their bridge',async()=>{
 const {buildClaudeLoginEnvironment}=await import('../../src/cli/commands/claude-local-auth.js');
 const env={BROWSER:'/synthetic/user-browser',DISPLAY:':1',WAYLAND_DISPLAY:'wayland-1',AIMGR_CLAUDE_LOGIN_STDIO:'stale'};
 const direct=buildClaudeLoginEnvironment({env,profile:null,manual:false,tabs:'/synthetic/tabs'});
 assert.equal(direct.BROWSER,env.BROWSER);assert.equal(direct.DISPLAY,env.DISPLAY);assert.equal(direct.WAYLAND_DISPLAY,env.WAYLAND_DISPLAY);
 assert.equal(direct.AIMGR_CLAUDE_LOGIN_STDIO,undefined);
 const nativeDefault=buildClaudeLoginEnvironment({env:{},profile:null,manual:false,tabs:'/synthetic/tabs'});
 assert.equal(Object.hasOwn(nativeDefault,'BROWSER'),false);
 for(const [profile,manual] of [[{profileRef:'synthetic'},false],[null,true]]) {
  const bridge=buildClaudeLoginEnvironment({env,profile,manual,tabs:'/synthetic/tabs'});
  assert.match(bridge.BROWSER,/claude-login-browser\.mjs$/);assert.equal(bridge.DISPLAY,undefined);assert.equal(bridge.WAYLAND_DISPLAY,undefined);
  assert.equal(bridge.AIMGR_CLAUDE_LOGIN_PROFILE,JSON.stringify(profile));assert.equal(bridge.AIMGR_CLAUDE_LOGIN_STDIO,manual?'1':undefined);
 }
});

test('abandoned native staging is never adopted; retry closes and reconnects coordination',async t=>{
 const {handleLocalClaudeAuth}=await import('../../src/cli/commands/claude-local-auth.js');
 const {connectRedisStore}=await import('../../src/coordination/redis-store.js');
 const {ensureClaudeAccountMetadata}=await import('../../src/coordination/claude-metadata.js');
 const {writeAimgrConfig}=await import('../../src/config/aimgr-config.js');
 const {FakeRedisClient}=await import('../helpers/fake-redis.js');
 const {PassThrough}=await import('node:stream');
 const options=fixture(t);
 const {readClaudeOfflineBinding}=await import('../../src/network/claude-offline-binding.js');
 writeAimgrConfig({homeDir:options.homeDir,config:{redis:{url:'redis://localhost:6379',keyPrefix:'synthetic:'},claudeProxyProfiles:{synthetic_route:{socksHost:'127.0.0.1',socksPort:1080,expectedExits:['203.0.113.8']}}}});
 const client=new FakeRedisClient();
 const store=await connectRedisStore({client,keyPrefix:'synthetic:'});
 await ensureClaudeAccountMetadata(store,{label:'synthetic',identity,policy:{egress:{profileRef:'synthetic_route'}}});
 const paths=path.join(options.homeDir,'.aimgr','claude-homes','synthetic');
 const abandoned=path.join(paths,'.login-staging-12345678-1234-4123-8123-123456789abc','.claude');
 fs.mkdirSync(abandoned,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(abandoned,'.credentials.json'),JSON.stringify({claudeAiOauth:bundle('orphan').claudeAiOauth}),{mode:0o600});
 let connections=0,closes=0,launched=false;
 const connect=async()=>{connections++;return {...store,ownsClient:true,client:{...client,eval:client.eval.bind(client),isOpen:true,quit:async()=>{closes++;},destroy:()=>{closes++;}}};};
 const resolve=()=>process.execPath;
 resolve.prepareClaudeCliLaunchImpl=async input=>({...input});
 const output=new PassThrough();output.resume();
 await handleLocalClaudeAuth({homeDir:options.homeDir,opts:{},positional:['claude','login','synthetic'],stdout:output,stdin:new PassThrough(),env:{},
  connectRedisStoreImpl:connect,readClaudeEnvironmentImpl:()=>environment,resolveExecutableOnPathImpl:resolve,setExitCode:()=>assert.fail('login failed'),
  assertClaudeNativeOwnersStoppedImpl:async()=>{},validateClaudeChromeImpl:async()=>{},runClaudeCliImpl:async launch=>{
   launched=true;assert.equal(readClaudeOfflineBinding(options.homeDir,'synthetic').invalidated,true);assert.equal(connections,1);assert.equal(closes,1,'idle coordination closes before native starts');
   assert.notEqual(launch.configDir,abandoned);assert.match(path.basename(launch.homeDir),/^\.login-staging-/);
   fs.writeFileSync(path.join(launch.configDir,'.credentials.json'),JSON.stringify({claudeAiOauth:bundle('fresh').claudeAiOauth}),{mode:0o600});
   fs.writeFileSync(path.join(launch.configDir,'.claude.json'),JSON.stringify({oauthAccount:identity}),{mode:0o600});
   return {status:0};
  }});
 assert.equal(launched,true);assert.equal(connections,2);assert.equal(closes,2);
 assert.equal(readLocalClaudeCredential(options).nativeClaudeBundle.claudeAiOauth.accessToken,'access-fresh');
 assert.equal(JSON.parse(fs.readFileSync(path.join(abandoned,'.credentials.json'))).claudeAiOauth.accessToken,'access-orphan');
 assert.equal(JSON.parse(await client.get(store.keys.credential({provider:'anthropic',label:'synthetic'}))).credential.access,undefined);
 assert.equal(readClaudeOfflineBinding(options.homeDir,'synthetic').invalidated,undefined);
 assert.equal(readClaudeOfflineBinding(options.homeDir,'synthetic').egress.profileRef,'synthetic_route');
 assert.equal(readClaudeOfflineBinding(options.homeDir,'synthetic').identity.accountUuid,identity.accountUuid);
});

test('local maintenance observes rejection from the real bounded noninteractive runner',async t=>{
 const {maintainLocalClaudeCredential}=await import('../../src/credentials/claude-local-maintenance.js');
 const {prepareClaudeCliLaunch,runClaudeCliNoninteractive}=await import('../../src/targets/claude-runner.js');
 const {verifySyntheticExecutable,resolveSyntheticSecurityAdapter,prepareSyntheticNativeInvocation,spawnSyntheticSupervisor}=await import('../helpers/claude-native-invocation.js');
 const options=fixture(t);await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('rejected')});
 const command=path.join(options.homeDir,'synthetic-native-maintenance');
 fs.writeFileSync(command,'#!/bin/sh\nif test "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC+x}" = x; then exit 3; fi\nprintf invalid_grant >&2\nexit 1\n',{mode:0o700});
 const adapter=path.join(options.homeDir,'.aimgr/runtime/claude-file-store/security');fs.mkdirSync(path.dirname(adapter),{recursive:true});fs.writeFileSync(adapter,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const resolve=()=>command;
 resolve.prepareClaudeCliLaunchImpl=launch=>prepareClaudeCliLaunch({...launch,verifyInstalledClaudeExecutableImpl:verifySyntheticExecutable,resolveInstalledClaudeSecurityAdapterImpl:resolveSyntheticSecurityAdapter});
 const result=await maintainLocalClaudeCredential({homeDir:options.homeDir,env:{PATH:process.env.PATH,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},resolveExecutableOnPathImpl:resolve,
  runClaudeCliNoninteractiveImpl:launch=>runClaudeCliNoninteractive({...launch,verifyInstalledClaudeExecutableImpl:verifySyntheticExecutable,resolveInstalledClaudeSecurityAdapterImpl:resolveSyntheticSecurityAdapter,
   prepareClaudeNativeInvocationImpl:prepareSyntheticNativeInvocation,spawnImpl:spawnSyntheticSupervisor})},
  {metadata,environment,state:{accounts:{synthetic:{provider:'anthropic',expect:{email:identity.emailAddress}}}},force:true});
 assert.equal(result.outcome,'reauth_required');assert.equal(result.reason,'local_grant_rejected');
 assert.equal(readLocalClaudeCredential(options).status,'reauth_required');
 const current=await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('new-login')});
 assert.equal(current.status,'ready');
});

test('first conversion refuses live owners before browser auth; same-owner relogin stays concurrent',async t=>{
 const {assertLocalClaudeLoginTransitionAllowed}=await import('../../src/credentials/claude-local.js');
 const {acquireClaudeAssignmentLock}=await import('../../src/network/claude-offline-binding.js');
 const {handleLocalClaudeAuth}=await import('../../src/cli/commands/claude-local-auth.js');
 const {connectRedisStore}=await import('../../src/coordination/redis-store.js');
 const {ensureClaudeAccountMetadata}=await import('../../src/coordination/claude-metadata.js');
 const {writeAimgrConfig}=await import('../../src/config/aimgr-config.js');
 const {FakeRedisClient}=await import('../helpers/fake-redis.js');
 const {PassThrough}=await import('node:stream');
 const options=fixture(t),client=new FakeRedisClient();
 writeAimgrConfig({homeDir:options.homeDir,config:{redis:{url:'redis://localhost:6379',keyPrefix:'synthetic:'}}});
 const store=await connectRedisStore({client,keyPrefix:'synthetic:'});
 await ensureClaudeAccountMetadata(store,{label:'synthetic',identity});
 let guard=await acquireClaudeAssignmentLock(options.homeDir,'synthetic');
 let output='';const stdout=new PassThrough();stdout.on('data',chunk=>{output+=chunk;});
 try {
  let failed=false;
  await handleLocalClaudeAuth({homeDir:options.homeDir,opts:{manualCallbackStdio:true},positional:['claude','login','synthetic'],stdout,stdin:new PassThrough(),env:{},
   connectRedisStoreImpl:async()=>store,readClaudeEnvironmentImpl:()=>environment,resolveExecutableOnPathImpl:()=>process.execPath,setExitCode:code=>{assert.equal(code,1);failed=true;},
   assertClaudeNativeOwnersStoppedImpl:async()=>assert.fail('busy SH must refuse before owner inventory'),runClaudeCliImpl:async()=>assert.fail('native/browser auth must not start')});
  assert.equal(failed,true);
  const error=JSON.parse(output);assert.equal(error.code,'AIMGR_CLAUDE_LOCAL_LOGIN_REQUIRES_STOPPED_OWNER');assert.match(error.error,/Stop this account's Claude sessions/);
 } finally {await guard.release();}
 await saveLocalClaudeLogin({...options,nativeClaudeBundle:bundle('enrolled')});
 guard=await acquireClaudeAssignmentLock(options.homeDir,'synthetic');
 try {await assertLocalClaudeLoginTransitionAllowed({...options,assertStopped:async()=>assert.fail('same-owner relogin must remain concurrent')});}
 finally {await guard.release();}
 let stoppedChecks=0;
 await assertLocalClaudeLoginTransitionAllowed({...options,environment:{binding:'b'.repeat(64)},assertStopped:async()=>{stoppedChecks++;}});
 assert.equal(stoppedChecks,1,'a real environment rebind must preflight stopped native owners');
});
