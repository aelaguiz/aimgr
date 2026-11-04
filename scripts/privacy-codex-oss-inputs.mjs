#!/usr/bin/env node
// Offline native OSS bootstrap/input parity; no service detection or auth.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
assert(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));assert.notEqual(process.getuid(),0);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const binary=path.join(repo,"native/codex/config-state/target/debug/aimgr-codex-config-state");
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"aimgr-oss-inputs-")));
const home=path.join(root,"home"),codexHome=path.join(home,".codex"),cwd=path.join(root,"project");
for(const dir of [codexHome,cwd])fs.mkdirSync(dir,{recursive:true,mode:0o700});
const config='check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n';
fs.writeFileSync(path.join(codexHome,"config.toml"),config);
const env={HOME:home,PATH:"/usr/bin:/bin",LANG:"en_US.UTF-8",TMPDIR:root},execute=promisify(execFile);
const base={operation:"inputs",artifact_set:"e".repeat(64),codex_home:codexHome,cwd,config:[],forced_config:"",forced_requirements:""};
async function call(patch={},failure=null){
  const run=execute(binary,[],{cwd,env,encoding:"utf8",timeout:90_000,maxBuffer:1024*1024});
  run.child.stdin.on("error",()=>{});run.child.stdin.end(JSON.stringify({...base,...patch}));
  if(failure){await assert.rejects(run,e=>e.code===125&&e.stderr.includes(failure));return;}
  const result=await run;assert.equal(result.stderr,"");return JSON.parse(result.stdout);
}
let result=await call({local_provider:"ollama"});
assert.equal(result.oss_choice,null);
result=await call({oss:true,local_provider:"ollama"});
assert.deepEqual(result.oss_choice,{provider:"ollama"});
result=await call({oss:true,config:['oss_provider="lmstudio"']});
assert.deepEqual(result.oss_choice,{provider:"lmstudio"});
result=await call({oss:true,local_provider:"ollama",config:['oss_provider="lmstudio"','model_provider="not-configured"']});
assert.deepEqual(result.oss_choice,{provider:"ollama"});
console.log("PASS native OSS explicit/configured precedence, ordinary-mode isolation and bootstrap before provider validation");
result=await call({oss:true});assert.equal(result.oss_choice,"picker");
result=await call({oss:true,headless:true});assert.equal(result.oss_choice,null);
console.log("PASS unresolved interactive OSS grants both native choices without probing; headless retains native missing-provider handling");
result=await call({oss:true,worktree:true,oss_choice:{provider:"lmstudio"},config:['oss_provider="ollama"']});
assert.deepEqual(result.oss_choice,{provider:"lmstudio"});
result=await call({oss:true,worktree:true,oss_choice:"picker",config:['oss_provider="ollama"']});
assert.equal(result.oss_choice,"picker");
await call({oss:true,oss_choice:"picker",config:['oss_provider="ollama"']},"OSS worktree provider");
result=await call({oss:true,oss_choice:"picker"});assert.equal(result.oss_choice,"picker");
console.log("PASS original TUI OSS choice survives source reload; a changed destination cannot silently replace the native picker");


const sessions=path.join(codexHome,"sessions/2026/11/04");fs.mkdirSync(sessions,{recursive:true});
const ids=["33333333-4444-4555-8666-000000000001","33333333-4444-4555-8666-000000000002"];
for(const [index,provider] of ["lmstudio","ollama"].entries()){
  const stamp="2026-11-04T12:00:00.000Z",id=ids[index];
  const lines=[{type:"session_meta",payload:{id,session_id:id,timestamp:stamp,cwd,originator:"synthetic",cli_version:"0.166.0",source:"cli",model_provider:provider}},
    {type:"event_msg",payload:{type:"user_message",message:"same-name",kind:"plain"}}];
  fs.writeFileSync(path.join(sessions,`rollout-2026-11-04T12-00-00-${id}.jsonl`),lines.map(v=>JSON.stringify({timestamp:stamp,...v})).join("\n")+"\n");
}
const fork={oss:true,operation:"fork_source",worktree:true,fork_source:{selector:"same-name",headless:false}};
await call(fork,"OSS worktree source");
result=await call({...fork,local_provider:"ollama"});assert.equal(result.fork_source.thread_id,ids[1]);
result=await call({...fork,fork_source:{selector:ids[0],headless:false}});assert.equal(result.fork_source.thread_id,ids[0]);
assert(!fs.existsSync(path.join(codexHome,"worktrees")),"source ambiguity must not allocate a checkout");
console.log("PASS provider-ambiguous named worktree fork refuses before allocation; explicit provider and agreed UUID work");
console.log(JSON.stringify({fixture:path.basename(root),platform:process.platform}));
