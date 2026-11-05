#!/usr/bin/env node
// Real native help/version with broken settings, on designated isolated hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prepareCodexAccountState} from '../src/privacy/codex-account-state.js';
import {prepareCodexNativeInvocation} from '../src/privacy/codex-native-invocation.js';
import {readCodexEnvironment} from '../src/privacy/codex-environment.js';
assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST') && process.getuid() !== 0);
if (process.platform === 'linux') assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
const root=fs.mkdtempSync('/opt/aimgr-state-audit/codex-m1-fixtures/inspection-');
const before=process.argv.includes('--expect-prepare-failure'), rows=[];
const run=(command,args,options)=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,options);let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
});
for (const scenario of ['malformed-settings','readonly-database']) {
 const homeDir=path.join(root,scenario), shared=path.join(homeDir,'.codex'), cwd=path.join(homeDir,'project'), db=path.join(homeDir,'database');
 for (const dir of [shared,cwd,db]) fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(shared,'config.toml'),scenario==='malformed-settings'?'model = [\n':`sqlite_home=${JSON.stringify(db)}\n`);
 if(scenario==='readonly-database')fs.chmodSync(db,0o500);
 const env={HOME:process.platform==='darwin'?os.homedir():homeDir,CODEX_HOME:shared,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'};
 const environment=readCodexEnvironment();
 const prepared={...prepareCodexAccountState({homeDir,env,environment,accountId:'api-provider:deepseek',label:'synthetic'}),keyBacked:true};
 try {
  for (const args of [['--version'],['--help'],['exec','--help']]) {
   const stock=await run('/opt/aimgr-state-audit/bin/codex',args,{cwd,env,stdio:['ignore','pipe','pipe']});
   assert.equal(stock.code,0,stock.stderr);assert.ok(stock.stdout.trim());
   let invocation;
   try {
    try {invocation=await prepareCodexNativeInvocation({prepared,homeDir,cwd,env,args});}
    catch(error){if(!before)throw error;rows.push({scenario,args,stockPassed:true,preparationRefused:true});continue;}
    assert.ok(!before,'Expected the before-fix preparation failure');
    const pending=run(invocation.command,invocation.args,{cwd,env:invocation.env,stdio:['ignore','pipe','pipe',invocation.environmentFd, invocation.assignmentFd]});
    invocation.closeEnvironment();const actual=await pending;
    assert.equal(actual.code,0,actual.stderr);assert.equal(actual.stdout,stock.stdout);
    assert.deepEqual(fs.readdirSync(db),[],'Help/version must not initialize databases');
    assert.deepEqual(invocation.inputs.databases,[]);assert.equal(invocation.entries.length,0);
    rows.push({scenario,args,stockPassed:true,protectedPassed:true,noDatabasesCreated:true});
   }finally{await invocation?.close();}
  }
 }finally{fs.chmodSync(db,0o700);}
}
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({before,rows},null,2)+'\n');
console.log(JSON.stringify({fixture:root,before,rows}));
