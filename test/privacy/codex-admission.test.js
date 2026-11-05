import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { codexArtifactSetDigest, CODEX_PRIVACY_ABI } from "../../src/privacy/codex-artifacts.js";

const enabled=process.env.AIMGR_TEST_CODEX_ARTIFACT_FILESYSTEM==="1";
test("Codex complete-package admission uses protected files and includes every vendor helper",{skip:!enabled},async t=>{
  assert.equal(process.getuid(),0,"synthetic artifact fixture needs administrator setup");
  assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
  const parent=fs.mkdtempSync("/opt/aimgr-state-audit/codex-admission-");
  fs.chmodSync(parent,0o755);
  fs.writeFileSync(path.join(parent,"package.json"),'{"type":"module"}',{mode:0o644});
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  for(const name of ["artifact-admission.js","codex-artifacts.js"]) {
    fs.copyFileSync(new URL(`../../src/privacy/${name}`,import.meta.url),path.join(parent,name));
    fs.chmodSync(path.join(parent,name),0o644);
  }
  const user=process.platform==="darwin"?"ec2-user":"aimprivacy";
  const uid=Number(execFileSync("/usr/bin/id",["-u",user],{encoding:"utf8"}).trim());
  const gid=Number(execFileSync("/usr/bin/id",["-g",user],{encoding:"utf8"}).trim());
  const admit=(root,selectedCommand,maintenance=false,repeats=1)=>spawnSync(process.execPath,["--input-type=module","-e",`
    process.setgroups([]);process.setgid(${gid});process.setuid(${uid});
    const {admitCodexArtifact}=await import(${JSON.stringify(path.join(parent,"codex-artifacts.js"))});
    const fs=await import("node:fs"), checks={};
    const fsImpl={...fs,accessSync(file,mode){if(mode===fs.constants.W_OK)checks[file]=(checks[file]??0)+1;return fs.accessSync(file,mode);}};
    try {let result;for(let i=0;i<${repeats};i++)result=admitCodexArtifact({runtimeRoot:${JSON.stringify(root)},selectedCommand:${JSON.stringify(selectedCommand)},maintenance:${maintenance},fsImpl});console.log(JSON.stringify({...result,checks}));}
    catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=77;}
  `],{encoding:"utf8"});
  function fixture(name,change=()=>{}) {
    const root=path.join(parent,name);
    const files=Object.fromEntries([["codex","vendor",true],["codex-code-mode-host","vendor",true],["launcher","launcher",true],["state_io.py","launcher",false],["mcp-keyring","launcher",true],["mcp_maintenance.py","launcher",false],["config-state","launcher",true],["worktree-tool","launcher",true],["process-control","launcher",true],["policy.json","policy",false]].map(([name,role,executable])=>[name,{role,executable,size:10,sha256:crypto.createHash("sha256").update("SYNTHETIC\n").digest("hex")} ]));
    if(process.platform==="darwin") files["managed-preferences"]={...files["mcp-keyring"]};
    change(files);
    const artifactSet=codexArtifactSetDigest(files),bundle=path.join(root,"artifacts",artifactSet);
    fs.mkdirSync(bundle,{recursive:true,mode:0o755});
    for(const [name,file] of Object.entries(files)) {
      const target=path.join(bundle,name);
      fs.writeFileSync(target,"SYNTHETIC\n");
      fs.chmodSync(target,name==="launcher"&&process.platform==="linux"?0o4755:file.executable?0o755:0o644);
    }
    const manifest={schema:1,platform:process.platform,arch:process.arch,privacyAbi:CODEX_PRIVACY_ABI,version:"0.0.0-test",entrypoint:"codex",launcher:"launcher",policy:"policy.json",codeModeHost:"codex-code-mode-host",stateIO:"state_io.py",mcpKeyring:"mcp-keyring",mcpMaintenance:"mcp_maintenance.py",configState:"config-state",worktreeTool:"worktree-tool",processControl:"process-control",files,reviewedAimRevision:"a".repeat(40),approval:{kind:"normal-use",approver:"synthetic",reference:"non-executable test fixture only",reviewEvidence:"no real vendor artifact",approvedAt:"2026-11-01T00:00:00Z"}};
    if(process.platform==="darwin") manifest.managedPreferences="managed-preferences";
    fs.writeFileSync(path.join(bundle,"approval.json"),JSON.stringify(manifest),{mode:0o644});
    fs.writeFileSync(path.join(root,"active.json"),JSON.stringify({schema:1,artifactSet}),{mode:0o644});
    return {root,bundle};
  }
  await t.test("an ordinary UID admits the complete immutable fixture",()=>{
    const f=fixture("complete"),result=admit(f.root);
    assert.equal(result.status,0,result.stderr||result.stdout);
    const approved=JSON.parse(result.stdout);
    assert.equal(approved.codeModeHost,path.join(f.bundle,"codex-code-mode-host"));
    assert.ok(approved.readPaths.includes(approved.codeModeHost));
    assert.equal(approved.mcpKeyring,undefined);
    assert.equal(approved.mcpMaintenance,undefined);
    const conversion=JSON.parse(admit(f.root,undefined,true).stdout);
    assert.equal(conversion.mcpKeyring,path.join(f.bundle,"mcp-keyring"));
    assert.equal(conversion.mcpMaintenance,path.join(f.bundle,"mcp_maintenance.py"));
  });
  await t.test("explicit selection accepts the installed entry or matching copy and rejects different same-size bytes",()=>{
    const f=fixture("selected"),installed=path.join(f.bundle,"codex");
    const copy=path.join(parent,"selected-copy");
    fs.copyFileSync(installed,copy);fs.chmodSync(copy,0o755);
    for(const selected of [installed,copy]) {
      const result=admit(f.root,selected);
      assert.equal(result.status,0,result.stderr||result.stdout);
    }
    fs.writeFileSync(copy,"ALTERED!!!");
    assert.equal(fs.statSync(copy).size,fs.statSync(installed).size);
    const result=admit(f.root,copy);
    assert.equal(result.status,77,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout).code,"AIMGR_CODEX_BUILD_NOT_APPROVED");
  });
  for(const variant of ["missing","wrong-role","changed-size","writable-parent","missing-config-helper","mutable-config-helper","missing-worktree-helper"]) await t.test(`refuses ${variant} before execution`,()=>{
    const f=fixture(variant,files=>{
      if(variant==="missing") delete files["codex-code-mode-host"];
      if(variant==="missing-config-helper") delete files["config-state"];
      if(variant==="missing-worktree-helper") delete files["worktree-tool"];
      if(variant==="wrong-role") files["codex-code-mode-host"].role="resource";
    });
    if(variant==="changed-size") fs.truncateSync(path.join(f.bundle,"codex-code-mode-host"),1);
    if(variant==="writable-parent") fs.chmodSync(f.bundle,0o777);
    if(variant==="mutable-config-helper") fs.chmodSync(path.join(f.bundle,"config-state"),0o777);
    const result=admit(f.root);
    assert.equal(result.status,77,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout).code,"AIMGR_CODEX_BUILD_NOT_APPROVED");
  });
  for(const helper of ["mcp-keyring","mcp_maintenance.py","process-control"]) for(const defect of ["absent-manifest","absent-file","mutable","changed-size"]) {
    await t.test(`normal launch ignores unused ${helper} ${defect}; conversion refuses it`,()=>{
      const f=fixture(`${helper}-${defect}`,files=>{if(defect==="absent-manifest")delete files[helper];});
      if(defect==="absent-file") fs.unlinkSync(path.join(f.bundle,helper));
      if(defect==="mutable") fs.chmodSync(path.join(f.bundle,helper),0o777);
      if(defect==="changed-size") fs.truncateSync(path.join(f.bundle,helper),1);
      assert.equal(admit(f.root).status,0);
      assert.equal(admit(f.root,undefined,true).status,77);
    });
  }
  await t.test("a conversion filename cannot hide a selected runtime file",()=>{
    const f=fixture("conversion-selected",files=>{files["mcp-keyring"].role="vendor";});
    const record=path.join(f.bundle,"approval.json"), manifest=JSON.parse(fs.readFileSync(record));
    manifest.entrypoint="mcp-keyring";fs.writeFileSync(record,JSON.stringify(manifest));
    fs.chmodSync(path.join(f.bundle,"mcp-keyring"),0o777);
    assert.equal(admit(f.root).status,77);
  });
  await t.test("ancestor inspection is reused only within each admission",()=>{
    const f=fixture("ancestors"), result=admit(f.root,undefined,false,2);
    assert.equal(result.status,0,result.stdout);
    const {checks}=JSON.parse(result.stdout);
    for(const directory of ["/",parent,f.root]) assert.equal(checks[directory],2,directory);
  });
  await t.test("offsite approval honors its explicit expiry and host without a seven-day cap",()=>{
    const f=fixture("offsite"), file=path.join(f.bundle,"approval.json"), manifest=JSON.parse(fs.readFileSync(file));
    manifest.candidateSourceSha256="b".repeat(64);
    manifest.approval={kind:"offsite-test",normalUseApproved:false,reference:"synthetic fixture"};
    fs.writeFileSync(file,JSON.stringify(manifest));
    const host=JSON.parse(fs.readFileSync("/opt/aimgr-state-audit/CODEX_TEST_HOST.json"));
    const authorization={schema:1,artifactSet:path.basename(f.bundle),platform:process.platform,arch:process.arch,
      normalUseApproved:false,reference:"synthetic fixture",authorizedAt:new Date(Date.now()-1000).toISOString(),
      expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString(),
      hostTokenSha256:crypto.createHash("sha256").update(host.token).digest("hex")};
    const record=path.join(f.root,"offsite-test.json");
    fs.writeFileSync(record,JSON.stringify(authorization));
    assert.equal(admit(f.root).status,0);
    fs.writeFileSync(record,JSON.stringify({...authorization,expiresAt:new Date(Date.now()-500).toISOString()}));
    assert.equal(admit(f.root).status,77);
    fs.writeFileSync(record,JSON.stringify({...authorization,hostTokenSha256:"0".repeat(64)}));
    assert.equal(admit(f.root).status,77);
  });

});
