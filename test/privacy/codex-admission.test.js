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
  const admit=root=>spawnSync(process.execPath,["--input-type=module","-e",`
    process.setgroups([]);process.setgid(${gid});process.setuid(${uid});
    const {admitCodexArtifact}=await import(${JSON.stringify(path.join(parent,"codex-artifacts.js"))});
    try {console.log(JSON.stringify(admitCodexArtifact({runtimeRoot:${JSON.stringify(root)}})));}
    catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=77;}
  `],{encoding:"utf8"});
  function fixture(name,change=()=>{}) {
    const root=path.join(parent,name);
    const files=Object.fromEntries([["codex","vendor",true],["codex-code-mode-host","vendor",true],["launcher","launcher",true],["state_io.py","launcher",false],["policy.json","policy",false]].map(([name,role,executable])=>[name,{role,executable,size:10,sha256:crypto.createHash("sha256").update("SYNTHETIC\n").digest("hex")} ]));
    change(files);
    const artifactSet=codexArtifactSetDigest(files),bundle=path.join(root,"artifacts",artifactSet);
    fs.mkdirSync(bundle,{recursive:true,mode:0o755});
    for(const [name,file] of Object.entries(files)) {
      const target=path.join(bundle,name);
      fs.writeFileSync(target,"SYNTHETIC\n");
      fs.chmodSync(target,name==="launcher"&&process.platform==="linux"?0o4755:file.executable?0o755:0o644);
    }
    const manifest={schema:1,platform:process.platform,arch:process.arch,privacyAbi:CODEX_PRIVACY_ABI,version:"0.0.0-test",entrypoint:"codex",launcher:"launcher",policy:"policy.json",codeModeHost:"codex-code-mode-host",stateIO:"state_io.py",files,reviewedAimRevision:"a".repeat(40),approval:{kind:"normal-use",approver:"synthetic",reference:"non-executable test fixture only",reviewEvidence:"no real vendor artifact",approvedAt:"2026-11-01T00:00:00Z"}};
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
  });
  for(const variant of ["missing","wrong-role","changed-bytes","writable-parent"]) await t.test(`refuses ${variant} before execution`,()=>{
    const f=fixture(variant,files=>{
      if(variant==="missing") delete files["codex-code-mode-host"];
      if(variant==="wrong-role") files["codex-code-mode-host"].role="resource";
    });
    if(variant==="changed-bytes") fs.writeFileSync(path.join(f.bundle,"codex-code-mode-host"),"ALTERED!!!");
    if(variant==="writable-parent") fs.chmodSync(f.bundle,0o777);
    const result=admit(f.root);
    assert.equal(result.status,77,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout).code,"AIMGR_CODEX_BUILD_NOT_APPROVED");
  });
});
