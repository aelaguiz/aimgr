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
  const admit=(root,selectedCommand)=>spawnSync(process.execPath,["--input-type=module","-e",`
    process.setgroups([]);process.setgid(${gid});process.setuid(${uid});
    const {admitCodexArtifact}=await import(${JSON.stringify(path.join(parent,"codex-artifacts.js"))});
    try {console.log(JSON.stringify(admitCodexArtifact({runtimeRoot:${JSON.stringify(root)},selectedCommand:${JSON.stringify(selectedCommand)}})));}
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
    assert.equal(approved.mcpKeyring,path.join(f.bundle,"mcp-keyring"));
    assert.equal(approved.mcpMaintenance,path.join(f.bundle,"mcp_maintenance.py"));
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
  for(const variant of ["missing","wrong-role","changed-size","writable-parent","missing-mcp-helper","mutable-mcp-helper","missing-maintenance-owner","mutable-maintenance-owner","missing-config-helper","mutable-config-helper","missing-process-helper","missing-worktree-helper"]) await t.test(`refuses ${variant} before execution`,()=>{
    const f=fixture(variant,files=>{
      if(variant==="missing") delete files["codex-code-mode-host"];
      if(variant==="missing-mcp-helper") delete files["mcp-keyring"];
      if(variant==="missing-maintenance-owner") delete files["mcp_maintenance.py"];
      if(variant==="missing-config-helper") delete files["config-state"];
      if(variant==="missing-process-helper") delete files["process-control"];
      if(variant==="missing-worktree-helper") delete files["worktree-tool"];
      if(variant==="wrong-role") files["codex-code-mode-host"].role="resource";
    });
    if(variant==="changed-size") fs.truncateSync(path.join(f.bundle,"codex-code-mode-host"),1);
    if(variant==="writable-parent") fs.chmodSync(f.bundle,0o777);
    if(variant==="mutable-mcp-helper") fs.chmodSync(path.join(f.bundle,"mcp-keyring"),0o777);
    if(variant==="mutable-maintenance-owner") fs.chmodSync(path.join(f.bundle,"mcp_maintenance.py"),0o777);
    if(variant==="mutable-config-helper") fs.chmodSync(path.join(f.bundle,"config-state"),0o777);
    const result=admit(f.root);
    assert.equal(result.status,77,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout).code,"AIMGR_CODEX_BUILD_NOT_APPROVED");
  });
});
