#!/usr/bin/env node
// Native, synthetic saved-session projection. No auth, network or vendor run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {zstdCompressSync} from "node:zlib";

assert(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
assert.notEqual(process.getuid(),0);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const binary=path.join(repo,"native/codex/config-state/target/debug/aimgr-codex-config-state");
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"aimgr-saved-inputs-")));
const home=path.join(root,"home"),codexHome=path.join(home,".codex"),cwd=path.join(root,"current");
const saved=path.join(root,"saved"),extra=path.join(root,"extra"),foreign=path.join(root,"foreign"),named=path.join(root,"named");
for(const dir of [codexHome,cwd,saved,extra,foreign,named])fs.mkdirSync(dir,{recursive:true,mode:0o700});
const settings='check_for_update_on_startup=false\napproval_policy="on-request"\ndefault_permissions=":workspace"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n';
fs.writeFileSync(path.join(codexHome,"config.toml"),settings+`[permissions.saved]\nextends=":workspace"\n[permissions.saved.workspace_roots]\n${JSON.stringify(named)}=true\n`);
const env={HOME:home,PATH:"/usr/bin:/bin",LANG:"en_US.UTF-8",TMPDIR:root};
const execute=promisify(execFile);
const base={operation:"initialize",artifact_set:"d".repeat(64),codex_home:codexHome,cwd,config:[],forced_config:"",forced_requirements:""};
const selection={fork:false,selector:null,last:false,all:false,include_non_interactive:false,explicit_cwd:false};
async function call(select={},patch={}){
  const run=execute(binary,[],{cwd,env,encoding:"utf8",timeout:90_000,maxBuffer:1024*1024});
  run.child.stdin.on("error",()=>{});run.child.stdin.end(JSON.stringify({...base,saved:{...selection,...select},...patch}));
  const result=await run;assert.equal(result.stderr,"");return JSON.parse(result.stdout);
}
const id=n=>`22222222-3333-4444-8555-${String(n).padStart(12,"0")}`;
const stamp="2026-11-04T12:00:05.000Z";
function snapshot(owner, roots, patch={}){
  return {type:"event_msg",payload:{type:"thread_settings_applied",thread_id:owner,thread_settings:{
    model:"synthetic",model_provider_id:"openai",approval_policy:"on-request",approvals_reviewer:"user",
    permission_profile:{type:"disabled"},cwd:saved,runtime_workspace_roots:roots,
    collaboration_mode:{mode:"default",settings:{model:"synthetic",reasoning_effort:null,developer_instructions:null}},...patch}}};
}
const sessions=path.join(codexHome,"sessions/2026/11/04");fs.mkdirSync(sessions,{recursive:true});
function rollout(n,label,metadata={},items=[]){
  const file=path.join(sessions,`rollout-2026-11-04T12-00-05-${id(n)}.jsonl`);
  const lines=[{type:"session_meta",payload:{id:id(n),session_id:id(n),timestamp:stamp,cwd:saved,
    originator:"synthetic-offline-fixture",cli_version:"0.166.0",source:"cli",model_provider:"openai",...metadata}},
    {type:"event_msg",payload:{type:"user_message",message:label,kind:"plain"}},...items];
  fs.writeFileSync(file,lines.map(line=>JSON.stringify({timestamp:stamp,...line})).join("\n")+"\n",{mode:0o600});return file;
}
const file=rollout(1,"owned-roots",{runtime_workspace_roots:[saved,foreign]},[
  snapshot(id(1),[saved,extra]),snapshot(id(99),[foreign])]);
// Populate every rollout before native first-run backfill. Appending a raw
// file later is not equivalent to a running native writer updating metadata.
rollout(2,"absent-roots",{runtime_workspace_roots:[saved,foreign]},[snapshot(id(2),undefined)]);
rollout(3,"named-profile",{},[snapshot(id(3),[saved],{active_permission_profile:{id:"saved"}})]);
rollout(7,"native-metadata-cwd",{},[snapshot(id(7),[saved,extra]),snapshot(id(99),[foreign],{cwd:foreign})]);
const archivedCwd=path.join(root,"archived"),execCwd=path.join(root,"exec"),badCwd=path.join(root,"broken");
for(const dir of [archivedCwd,execCwd,badCwd])fs.mkdirSync(dir);
const archiveFile=rollout(4,"archived-choice",{cwd:archivedCwd});
rollout(5,"exec-choice",{cwd:execCwd,source:"exec"});
rollout(6,"broken-choice",{cwd:badCwd});
let result=await call({selector:id(1)});
assert(result.project_cwds.includes(saved));assert(result.project_cwds.includes(cwd));
assert(result.writes.includes(extra));assert(!result.writes.includes(foreign));
assert(!JSON.stringify(result).includes("owned-roots"),"no transcript content leaves helper");
assert(!result.writes.includes(home));
console.log("PASS native saved/current cwd branches and owned roots without foreign grants or transcript output");

result=await call({selector:id(1),explicit_cwd:true});
assert(!result.project_cwds.includes(saved));assert(!result.writes.includes(extra));
result=await call({selector:id(1)},{config:['tui.resume_cwd="session"']});
assert.deepEqual(result.project_cwds,[saved]);
result=await call({fork:true,selector:id(1)});
assert(result.project_cwds.includes(saved));assert(!result.writes.includes(extra));
console.log("PASS explicit cd/configured cwd and fork current-permission behavior");

result=await call({selector:id(2)});assert(!result.writes.includes(foreign));
result=await call({selector:id(3)});assert(result.writes.includes(named));
result=await call({selector:id(3)},{harness:{sandbox:"danger-full-access",approval:"never"}});
assert(!result.writes.includes(named));
console.log("PASS absent owned roots suppress old startup roots; named permissions resolve current config and explicit choices win");

// Native metadata extraction can retain a foreign snapshot's cwd even though
// raw workspace-root restoration is owner-aware. Match the actual TUI choice;
// do not misrepresent all stored cwd metadata as authenticated to this thread.
result=await call({selector:id(7)});assert(result.project_cwds.includes(foreign));
result=await call({selector:id(7),explicit_cwd:true});assert(!result.project_cwds.includes(foreign));assert(!result.writes.includes(foreign));
console.log("PASS native metadata cwd parity and explicit current-directory exclusion");

await call({selector:id(4)}); // native backfill, then mark the fixture archived
const database=result.database_files.find(f=>/^state_.*\.sqlite$/.test(path.basename(f)));
const continuedCwd=path.join(root,"continued");fs.mkdirSync(continuedCwd);
const move=spawnSync("python3",["-c","import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute('UPDATE threads SET cwd=? WHERE id=?',(sys.argv[2],sys.argv[3]));assert r.rowcount==1;c.commit();c.close()",database,continuedCwd,id(1)],{env,encoding:"utf8"});
assert.equal(move.status,0,move.stderr);
result=await call();assert(result.project_cwds.includes(continuedCwd));assert(result.project_cwds.includes(saved));
console.log("PASS picker retains both creation and current native metadata directories for the same thread");
const archived=path.join(codexHome,"archived_sessions",path.basename(archiveFile));fs.mkdirSync(path.dirname(archived),{recursive:true});fs.renameSync(archiveFile,archived);
const sql=spawnSync("python3",["-c","import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute('UPDATE threads SET archived=1,rollout_path=? WHERE id=?',(sys.argv[2],sys.argv[3]));assert r.rowcount==1;c.commit();c.close()",database,archived,id(4)],{env,encoding:"utf8"});
assert.equal(sql.status,0,sql.stderr);
fs.mkdirSync(path.join(badCwd,".codex"));fs.writeFileSync(path.join(badCwd,".codex/config.toml"),'invalid = [\n');
fs.appendFileSync(path.join(codexHome,"config.toml"),`[projects.${JSON.stringify(badCwd)}]\ntrust_level="trusted"\n`);
result=await call();assert(result.project_cwds.includes(archivedCwd));assert(!result.project_cwds.includes(execCwd));
assert(!result.project_cwds.includes(badCwd));assert(result.project_cwds.includes(saved));
result=await call({include_non_interactive:true});assert(result.project_cwds.includes(execCwd));
result=await call({fork:true});assert(!result.project_cwds.includes(archivedCwd));assert(!result.project_cwds.includes(execCwd));
console.log("PASS native picker archive/source reachability and healthy choices survive a broken historical project");

// Native persists a plain rollout identity even when only the compressed file
// remains. Its resolver, not Path.exists(), owns this representation.
fs.writeFileSync(file+".zst",zstdCompressSync(fs.readFileSync(file)));fs.unlinkSync(file);
result=await call({selector:id(1)});assert(result.writes.includes(extra));
result=await call();assert(result.writes.includes(extra));
const latest=spawnSync("python3",["-c","import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE threads SET updated_at=2000000000 WHERE id=?',(sys.argv[2],));c.commit();c.close()",database,id(1)],{env,encoding:"utf8"});
assert.equal(latest.status,0,latest.stderr);
result=await call({last:true,all:true});assert(result.writes.includes(extra));
console.log("PASS compressed native history stays selectable and retains saved root inventory");
console.log(JSON.stringify({fixture:path.basename(root),platform:process.platform}));
