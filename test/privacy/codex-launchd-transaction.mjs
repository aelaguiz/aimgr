// Actual GUI-domain calendar, current AIM parent, and finite maintenance owner.
// Synthetic home and no vendor/auth calls. Run only on the rented test Mac.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { renderRoutineLaunchAgent, routineLaunchAgentLabel, routineLaunchAgentPath } from "../../src/routines/launchd.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { resolveAimgrRoutineLogsDir, resolveAimgrRoutineRunsDir } from "../../src/io/paths.js";
import { guardedRoutineLauncher, verifyLoadedRoutine, maintenanceOperation } from "../../src/credentials/codex-mcp-maintenance-owner.js";

assert.equal(process.platform, "darwin");
assert(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-calendar-maintenance-"));
const home = path.join(root,"home"), cwd = path.join(root,"project");
const bin = path.join(home,".local/bin"), pending = `/opt/aimgr-codex-runtime/users/${process.getuid()}/maintenance/pending.json`;
assert(!fs.existsSync(pending));
fs.mkdirSync(bin,{recursive:true}); fs.mkdirSync(cwd);
const wrapper = path.join(bin,"aim"), cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
fs.writeFileSync(wrapper,`#!/usr/bin/env bash\nset -euo pipefail\nexec "${process.execPath}" "${cli}" "$@"\n`,{mode:0o700});
// A restored occurrence must reach this local stub, never account bootstrap.
const called = path.join(root,"herdr-called");
fs.writeFileSync(path.join(bin,"herdr"),`#!/bin/sh\n/usr/bin/touch '${called}'\nprintf 'synthetic Herdr unavailable' >&2\nexit 1\n`,{mode:0o700});
const promptFile = path.join(root,"prompt.txt"); fs.writeFileSync(promptFile,"Synthetic scheduler boundary test.");
const minute = Math.floor((Date.now()+10_000)/60_000)*60_000;
const dates = [new Date(minute+60_000),new Date(minute+120_000),new Date(minute+180_000)];
const routine = {id:"maintenance-fixture",agent:"codex",calendar:dates.map(date=>({hour:date.getHours(),minute:date.getMinutes()})),
  cwd,promptFile,provider:"openai-codex",model:"synthetic",thinking:"high",profile:"yolo",herdrSession:"synthetic",
  spaceTitleFormat:"Synthetic {scheduled_local}"};
writeAimgrConfig({homeDir:home,config:{routines:{[routine.id]:routine}}});
const file = routineLaunchAgentPath({homeDir:home,routineId:routine.id});
fs.mkdirSync(path.dirname(file),{recursive:true}); fs.mkdirSync(resolveAimgrRoutineLogsDir({homeDir:home}),{recursive:true});
const bytes = renderRoutineLaunchAgent(routine,{homeDir:home,aimPath:wrapper}); fs.writeFileSync(file,bytes);
const ctl = (...args) => spawnSync("/bin/launchctl",args,{encoding:"utf8"});
const domain = `gui/${process.getuid()}`, service = `${domain}/${routineLaunchAgentLabel(routine.id)}`;
assert.equal(ctl("print",domain).status,0,"real GUI scheduler domain is required");
const definition = JSON.parse(spawnSync("/usr/bin/plutil",["-convert","json","-o","-",file],{encoding:"utf8"}).stdout);
const schedule = {file,service,enabled:true,loaded:true,disabled:false,definition,routine,
  launcher:guardedRoutineLauncher(wrapper,definition.EnvironmentVariables.PATH),sha256:createHash("sha256").update(bytes).digest("hex")};
const lock = fs.openSync(path.join(root,"owner.lock"),"wx",0o600);
const plan = {routine_ids:[routine.id],controllers:[],process_control:process.argv[2]};
assert(path.isAbsolute(plan.process_control??""));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate, timeout=90_000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(predicate())return; await sleep(100); }
  assert.fail("calendar condition timed out; synthetic evidence retained");
}
const receipts = () => {
  const dir=resolveAimgrRoutineRunsDir({homeDir:home});
  return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f)))):[];
};
let ownPending=false;
try {
  // A previously loaded service can retain a different HOME after its plist
  // was edited. Refuse it before disable/bootout, without relying on a mock.
  const stale=structuredClone(definition); stale.EnvironmentVariables.HOME=path.join(root,"other-home");
  assert.equal(spawnSync("/usr/bin/plutil",["-convert","xml1","-o",file,"-"],{input:JSON.stringify(stale)}).status,0);
  assert.equal(ctl("bootstrap",domain,file).status,0);
  fs.writeFileSync(file,bytes);
  await assert.rejects(maintenanceOperation({operation:"pause",schedule,plan,lock_fds:[lock]}),/differs/);
  assert.equal(ctl("print",service).status,0,"stale service was booted out before refusal");
  assert(!ctl("print-disabled",domain).stdout.split("\n").some(line=>line.includes(definition.Label)&&/=> (?:disabled|true)/.test(line)));
  assert.equal(ctl("bootout",service).status,0);
  assert.equal(ctl("bootstrap",domain,file).status,0);
  verifyLoadedRoutine(schedule,ctl("print",service).stdout);
  fs.writeFileSync(pending,"{}\n",{flag:"wx",mode:0o600}); ownPending=true;
  await until(()=>receipts().some(r=>r.outcome==="failed_before_prompt"));
  const first=receipts();
  assert.equal(first.length,1);
  assert.equal(first[0].scheduledAt,dates[0].toISOString());
  assert(JSON.stringify(first).includes("maintenance is pending"));
  assert(!fs.existsSync(called));
  // Wait for the guarded launcher to finish; maintenance must never signal it.
  await until(()=>/\tstate = not running\n/.test(ctl("print",service).stdout),10_000);
  await maintenanceOperation({operation:"pause",schedule,plan,lock_fds:[lock]});
  assert(Date.now()<dates[1].getTime(),"pause missed the occurrence it must exclude");
  assert.notEqual(ctl("print",service).status,0);
  console.log("PASS actual GUI calendar refuses pending before Herdr/account selection; reviewed service unloads");
  // A due calendar occurrence while unloaded is not replayed on restoration.
  await until(()=>Date.now()>dates[1].getTime()+2000,90_000);
  assert.equal(receipts().length,1);
  fs.unlinkSync(pending); ownPending=false;
  await maintenanceOperation({operation:"restore",schedule,plan,lock_fds:[lock]});
  assert(Date.now()<dates[2].getTime(),"restore missed the next legitimate occurrence");
  await sleep(1500);
  assert.equal(receipts().length,1,"restoration replayed a missed occurrence");
  await until(()=>receipts().length===2&&receipts().every(r=>r.outcome==="failed_before_prompt")&&fs.existsSync(called),90_000);
  const second=receipts().find(r=>r.scheduledAt!==first[0].scheduledAt);
  assert.equal(second.scheduledAt,dates[2].toISOString(),"restoration replayed the paused occurrence");
  assert(new Date(second.actualStart).getTime()>=dates[2].getTime());
  assert(fs.existsSync(called));
  assert.equal(receipts().filter(r=>JSON.stringify(r).includes("maintenance is pending")).length,1);
  console.log("PASS enable/bootstrap restores the next real calendar occurrence without replaying the missed one");
  console.log(JSON.stringify({fixture:path.basename(root)}));
} finally {
  ctl("bootout",service); ctl("enable",service);
  if(ownPending)fs.unlinkSync(pending);
  fs.closeSync(lock);
}
