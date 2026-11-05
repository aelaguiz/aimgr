#!/usr/bin/env node
// Exact native utility commands with synthetic files on the isolated hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getStaticTOMLValue,parseTOML} from 'toml-eslint-parser';
import {prepareCodexAccountState} from '../src/privacy/codex-account-state.js';
import {prepareCodexNativeInvocation} from '../src/privacy/codex-native-invocation.js';
import {readCodexEnvironment} from '../src/privacy/codex-environment.js';
assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST') && process.getuid()!==0);
if(process.platform==='linux')assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
const root=fs.mkdtempSync('/opt/aimgr-state-audit/codex-m1-fixtures/passthrough-');
const before=process.argv.includes('--expect-failure'), rows=[];
const external=path.join(root,'external');fs.mkdirSync(external);
const selected=path.join(external,'selected.rules'),neighbor=path.join(external,'private.rules');
for(const file of [selected,neighbor])fs.writeFileSync(file,
 ['echo','--remote','-p','-rpolicy.rules'].map(command=>`prefix_rule(pattern = [${JSON.stringify(command)}], decision = "allow")`).join('\n')+'\n');
const cases=[
 ['sandbox',['-c','sandbox_mode="danger-full-access"','sandbox','/bin/sh','-c','printf SYNTHETIC_CHILD_SCRIPT']],
 ['mcp-add',['mcp','add','fixture','--env','LABEL=synthetic','node','server.js','--remote','-c','child-script','-C','child-dir','-i','child.png','-p','child-profile']],
 ['execpolicy',['execpolicy','check','--rules',selected,'echo','--remote','-c','child-script']],
 ...(!before?[
  ['execpolicy-leading-remote',['execpolicy','check','-r',selected,'--remote','endpoint','-c','child-data']],
  ['execpolicy-leading-profile',['execpolicy','check','-r',selected,'-p','child-profile']],
  ['execpolicy-attached-short',['execpolicy','check','-r',selected,'-rpolicy.rules','echo']],
  ['neighbor-denial',['execpolicy','check','--rules',selected,'echo']],
 ]:[]),
];
const run=(command,args,options)=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,options);let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
});
for(const [name,args] of cases){
 for(const protect of [false,true]){
  const homeDir=path.join(root,name+(protect?'-protected':'-stock')),shared=path.join(homeDir,'.codex'),cwd=path.join(homeDir,'project');
  fs.mkdirSync(shared,{recursive:true});fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(shared,'config.toml'),'mcp_oauth_credentials_store="keyring"\nsandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access=true\n');
  const env={HOME:process.platform==='darwin'?os.homedir():homeDir,CODEX_HOME:shared,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'};
  let invocation,result;
  try{
   if(protect){
    const environment=readCodexEnvironment();
    const prepared={...prepareCodexAccountState({homeDir,env,environment,accountId:'api-provider:deepseek',label:'synthetic'}),keyBacked:true};
    try{invocation=await prepareCodexNativeInvocation({prepared,homeDir,cwd,env,args});}
    catch(error){if(!before)throw error;rows.push({name,protected:true,failedDuringPreparation:true});continue;}
   }
   let argv=invocation?.args??args;
   if(name==='neighbor-denial'){
    const vendorStart=invocation?argv.indexOf('--')+1:0;
    argv=argv.map((arg,index)=>index>=vendorStart&&arg===selected?neighbor:arg);
   }
   const pending=run(invocation?.command??'/opt/aimgr-state-audit/bin/codex',argv,{cwd,env:invocation?.env??env,
    stdio:['ignore','pipe','pipe',...(invocation?[invocation.environmentFd, invocation.assignmentFd]:[])]});
   invocation?.closeEnvironment();result=await pending;await invocation?.flushSettings();
   if(before&&protect){assert.notEqual(result.code,0,'Expected before-fix failure');rows.push({name,protected:true,failedDuringExecution:true});continue;}
   if(name==='neighbor-denial'&&protect){assert.notEqual(result.code,0);assert.match(result.stderr,/policy|Permission denied/i);}
   else{
    assert.equal(result.code,0,JSON.stringify({name,protect,...result}));
    if(name==='sandbox')assert.equal(result.stdout,'SYNTHETIC_CHILD_SCRIPT');
    if(name.startsWith('execpolicy')||name==='neighbor-denial')assert.equal(JSON.parse(result.stdout).decision,'allow');
    if(name==='mcp-add'){
     const server=getStaticTOMLValue(parseTOML(fs.readFileSync(path.join(shared,'config.toml'),'utf8'))).mcp_servers.fixture;
     assert.equal(server.command,'node');assert.deepEqual(server.args,args.slice(args.indexOf('node')+1));assert.equal(server.env.LABEL,'synthetic');
    }
   }
   rows.push({name,protected:protect,passed:true,...(name==='neighbor-denial'&&protect?{neighborDenied:true}:{})});
  }finally{await invocation?.close();}
 }
}
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({before,rows},null,2)+'\n');
console.log(JSON.stringify({fixture:root,before,rows}));
