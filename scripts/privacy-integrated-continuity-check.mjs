/** Native history and OAuth against offsite synthetic default services.
 * Browser UI alone is replaced by an inert opener: this never opens Chrome
 * or proves browser routing. Existing original-Chrome controls cover that. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readSnapshot, importCredentialsSnapshot } from '../src/coordination/redis-store.js';

export async function verifyContinuity({input,home,cwd,env,store,start,readCaptures,receipt}){
  const config=label=>path.join(home,'.aimgr/claude-homes',label,'.claude');
  const captures=role=>readCaptures().filter(r=>r.path.includes('/messages')&&JSON.stringify(r.body.messages).includes(`CONCURRENT_ROLE_${role}.`));
  const device=r=>{const v=r.body.metadata.user_id;return typeof v==='string'&&v.startsWith('{')?JSON.parse(v).device_id:v;};
  fs.writeFileSync(path.join(cwd,'CLAUDE.md'),'CONTINUITY_PROJECT_INSTRUCTION_CANARY\n');
  const memory=path.join(home,'.claude/projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),'memory');
  fs.mkdirSync(memory,{recursive:true});fs.writeFileSync(path.join(memory,'MEMORY.md'),'CONTINUITY_SHARED_MEMORY_CANARY\n');
  const firstA=await start('a','identity-a').finished,firstB=await start('b','identity-b').finished;
  const idA=device(captures('identity-a')[0]),idB=device(captures('identity-b')[0]);
  assert.ok(idA&&idB);assert.notEqual(idA,idB);assert.notEqual(idA,'a'.repeat(64));assert.notEqual(idB,'a'.repeat(64));
  assert.ok(!JSON.stringify(readCaptures()).includes('FOREIGN_HOST_'));
  for(const label of ['a','b']){
    const app=JSON.parse(fs.readFileSync(path.join(config(label),'.claude.json')));
    assert.equal(app.unknownTaskState,'PRESERVED_TASK_STATE');
    assert.equal(JSON.parse(fs.readFileSync(path.join(config(label),'.credentials.json'))).mcpOAuth['fixture-service'].accessToken,'INDEPENDENT_MCP_SECRET');
    const bodies=JSON.stringify(captures('identity-'+label));
    assert.ok(bodies.includes('CONTINUITY_PROJECT_INSTRUCTION_CANARY'));assert.ok(bodies.includes('CONTINUITY_SHARED_MEMORY_CANARY'));
  }
  receipt.checks.clonedPersonalIdsReplacedBeforeRequests=true;
  receipt.checks.sharedMemoryInstructionsAndIndependentMcpCredentialPreserved=true;
  const projects=path.join(config('a'),'projects');
  const relative=fs.readdirSync(projects,{recursive:true}).find(f=>f.endsWith('/'+firstA.sessionId+'.jsonl'));
  assert.ok(relative);const transcript=path.join(projects,relative);
  const resumed=await start('a','resume-a',{extraArgs:['--resume',transcript]}).finished;
  assert.equal(resumed.sessionId,firstA.sessionId);
  assert.ok(captures('resume-a').some(r=>JSON.stringify(r.body.messages).includes('CONCURRENT_ROLE_identity-a.')));
  receipt.checks.sameAccountHistoryKeepsSession=true;
  const original=fs.readFileSync(transcript),hash=b=>createHash('sha256').update(b).digest('hex');
  const handoff=await start('b','handoff-b',{extraArgs:['--resume',transcript]}).finished;
  assert.notEqual(handoff.sessionId,firstA.sessionId);assert.notEqual(handoff.sessionId,firstB.sessionId);
  const rows=captures('handoff-b');assert.ok(rows.length);
  assert.ok(rows.every(r=>r.source==='127.0.0.3'&&device(r)===idB));
  assert.ok(rows.some(r=>JSON.stringify(r.body.messages).includes('CONCURRENT_ROLE_identity-a.')));
  assert.equal(hash(fs.readFileSync(transcript)),hash(original));
  receipt.checks.crossAccountHistoryForkUsesSelectedIdentity=true;
  const driver=path.join(cwd,'native-login-driver.mjs');
  fs.writeFileSync(driver,`import {main} from ${JSON.stringify(new URL('../src/cli.js',import.meta.url).href)};
import {runClaudeCli} from ${JSON.stringify(new URL('../src/targets/claude-runner.js',import.meta.url).href)};
try{await main(['login',process.argv[2],'--provider','anthropic','--home',${JSON.stringify(home)}],{
 env:process.env,resolveExecutableOnPathImpl:()=>${JSON.stringify(input.command)},
 validateClaudeChromeImpl:async profile=>{if(profile.profileRef!=='impl_mock')throw Error('wrong fixture profile');},
 runClaudeCliImpl:options=>runClaudeCli({...options,env:{...options.env,BROWSER:'/usr/bin/true'}})
});}catch(error){process.stderr.write(String(error.message)+'\\n');process.exitCode=1;}`);
  const login=(code,label='a')=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[driver,label],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    let text='',sent=false,flow;
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},40000);
    child.stdout.on('data',chunk=>{
      text+=chunk;
      if(!sent)for(const match of text.matchAll(/https:\/\/[^\s\x1b]+/g)){
        let url;try{url=new URL(match[0]);}catch{continue;}
        const state=url.searchParams.get('state');if(!state)continue;
        flow={state,challenge:url.searchParams.get('code_challenge'),clientId:url.searchParams.get('client_id')};
        try{
        const stage=path.join(path.dirname(config(label)),'.login-staging/.claude/.claude.json');
        if(fs.existsSync(stage)){
          const staged=JSON.parse(fs.readFileSync(stage));
          assert.ok(!staged.oauthAccount);assert.notEqual(staged.userID,idA);assert.notEqual(staged.userID,'a'.repeat(64));
        }
        child.stdin.write(code+'#'+state+'\n');sent=true;break;
        }catch(error){try{process.kill(-child.pid,'SIGKILL');}catch{}reject(error);}
      }
    });
    child.stderr.on('data',chunk=>text+=chunk);child.once('error',reject);
    child.once('exit',(status,signal)=>{clearTimeout(timer);fs.writeFileSync(path.join(home,code+'.private.txt'),text);if(sent&&status===0){
        const exchange=readCaptures().find(r=>r.body?.code===code)?.body;
        try{assert.ok(exchange);assert.equal(exchange.client_id,flow.clientId);
          assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'),flow.challenge);
        }catch(error){reject(error);return;}
      }resolve({status,signal,sent});});
  });
  await importCredentialsSnapshot(store,{credentials:[{provider:'anthropic',label:'new-a',identity:{},credential:{},
    policy:{expect:{email:'synthetic-new-a@example.invalid'},egress:{profileRef:'impl_mock'},pool:{enabled:false}},
    health:{status:'candidate',reason:'credential_missing'}}]},{updatedBy:'synthetic-initial-login'});
  const initial=await login('login-new-a','new-a');assert.ok(initial.sent);assert.equal(initial.status,0);
  const newlyBound=(await readSnapshot(store)).credentials.find(r=>r.label==='new-a');
  assert.equal(newlyBound.identity.accountUuid,'00000000-0000-4000-8000-000000000005');
  assert.ok(!fs.existsSync(path.join(path.dirname(config('new-a')),'.login-staging')));
  receipt.checks.initialLoginBindsVerifiedProfile=true;
  for(const code of ['login-a-first','login-a-second']){
    const result=await login(code);assert.ok(result.sent,'actual native OAuth manual URL');assert.equal(result.status,0,'native login failed; inspect synthetic fixture log');
    const record=(await readSnapshot(store)).credentials.find(r=>r.label==='a');
    assert.equal(record.credential.nativeClaudeBundle.claudeAiOauth.accessToken,'sk-ant-oat01-synthetic-'+code);
    await start('a',code).finished;assert.ok(captures(code).every(r=>device(r)===idA&&r.source==='127.0.0.2'));
  }
  receipt.checks.nativeLoginAndReloginPreserveAccountIdentity=true;
  const before=await readSnapshot(store);
  const files=['a','b'].flatMap(label=>['.claude.json','.credentials.json','.aim-privacy-identity.json'].map(name=>path.join(config(label),name)));
  const bytes=files.map(file=>hash(fs.readFileSync(file)));
  const wrong=await login('login-wrong-id');assert.ok(wrong.sent);assert.notEqual(wrong.status,0);
  const after=await readSnapshot(store);
  // observedAt is generated by each read, not persisted credential state.
  assert.deepEqual(after.credentials,before.credentials,'wrong UUID with expected email must not publish');
  assert.deepEqual(after.meta,before.meta);
  assert.deepEqual(files.map(file=>hash(fs.readFileSync(file))),bytes,'wrong login must not alter active native state');
  assert.ok(!fs.existsSync(path.join(path.dirname(config('a')),'.login-staging')));
  receipt.checks.wrongUuidWithExpectedEmailRefusesWithoutMutation=true;
  const exchanges=readCaptures().filter(r=>r.body?.grant_type==='authorization_code');
  assert.equal(exchanges.length,4);assert.ok(exchanges.every(r=>r.source==='127.0.0.2'));
  receipt.checks.nativeOAuthTokenAndProfileUseAssignedRoute=true;
  receipt.loginSubstitutions=['Chrome validation and opener only; native manual URL/state, OAuth exchange, profile, staging and publication are real'];
  receipt.passed=true;
}
