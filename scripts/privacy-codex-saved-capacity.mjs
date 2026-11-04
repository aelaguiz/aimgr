#!/usr/bin/env node
// Synthetic many-thread and >256 exact-root inventory, on isolated hosts only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {prepareCodexNativeInputs} from "../src/privacy/codex-native-inputs.js";
import {codexArguments} from "../src/privacy/codex-arguments.js";
assert(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));assert.notEqual(process.getuid(),0);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const build=process.argv.includes("--release")?"release":"debug";
const distinct=process.argv.includes("--distinct-projects");
const binary=path.join(repo,`native/codex/config-state/target/${build}/aimgr-codex-config-state`);
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"aimgr-saved-capacity-")));
const home=path.join(root,"home"),codexHome=path.join(home,".codex"),cwd=path.join(root,"project");
const sessions=path.join(codexHome,"sessions/2026/11/04");
for(const dir of [sessions,cwd])fs.mkdirSync(dir,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(codexHome,"config.toml"),'check_for_update_on_startup=false\ndefault_permissions=":workspace"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n');
const roots=Array.from({length:300},(_,i)=>path.join(root,"inputs",String(i)));
for(const dir of roots)fs.mkdirSync(dir,{recursive:true});
const count=1000,stamp="2026-11-04T12:00:00.000Z";
for(let n=0;n<count;n++){
  const id=`44444444-5555-4666-8777-${String(n).padStart(12,"0")}`;
  const project=distinct?path.join(root,"projects",`${n}-synthetic workspace with a descriptive project name`):cwd;
  fs.mkdirSync(project,{recursive:true});
  const lines=[{type:"session_meta",payload:{id,session_id:id,timestamp:stamp,cwd:project,
    runtime_workspace_roots:n===0?[project,...roots]:[project],originator:"synthetic",cli_version:"0.163.0-alpha.5",source:"cli",model_provider:"openai"}},
    {type:"event_msg",payload:{type:"user_message",message:"synthetic-capacity",kind:"plain"}}];
  fs.writeFileSync(path.join(sessions,`rollout-2026-11-04T12-00-00-${id}.jsonl`),lines.map(v=>JSON.stringify({timestamp:stamp,...v})).join("\n")+"\n");
}
const execute=promisify(execFile),metrics=path.join(root,"metrics");
async function run(label){
  const started=performance.now();
  const command=process.platform==="linux"?"/usr/bin/time":binary;
  const args=process.platform==="linux"?["-f","%M %e","-o",metrics,binary]:[];
  // Exercise the production private-pipe reader and its actual response limit.
  const output=await prepareCodexNativeInputs({artifact:{configState:binary,artifactSet:"f".repeat(64)},
    prepared:{codexHome},parsedArgs:codexArguments(["resume"],{cwd}),managed:{},
    env:{HOME:home,PATH:"/usr/bin:/bin",LANG:"en_US.UTF-8",TMPDIR:root},
    executeImpl:(_command,_args,options)=>execute(command,args,options)});
  for(const dir of roots)assert(output.writes.includes(dir),"every selected saved root must survive");
  assert(!output.writes.includes(path.join(root,"inputs")),"no widened ancestor grant");
  assert(!output.writes.includes(root));assert(!output.writes.includes(home));
  const [max_rss_kib,elapsed_seconds]=process.platform==="linux"?fs.readFileSync(metrics,"utf8").trim().split(" ").map(Number):[null,(performance.now()-started)/1000];
  console.log(JSON.stringify({fixture:path.basename(root),platform:process.platform,build,label,threads:count,
    projects:distinct?count:1,independent_roots:roots.length,response_bytes:Buffer.byteLength(JSON.stringify(output)),max_rss_kib,elapsed_seconds}));
}
await run("cold");await run("warm");
console.log("PASS complete 1000-thread picker retains all 300 independent roots without widening grants");
