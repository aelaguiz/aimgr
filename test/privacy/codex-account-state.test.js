import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readCodexEnvironment } from "../../src/privacy/codex-environment.js";
import { prepareCodexAccountState, codexAccountPaths } from "../../src/privacy/codex-account-state.js";

const environment = { binding: "a".repeat(64) };
function fixture(t) {
  const homeDir=fs.mkdtempSync(path.join(os.tmpdir(),"codex-accounts-"));
  t.after(()=>fs.rmSync(homeDir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(homeDir,".codex"));
  return {homeDir,environment,accountId:"fixture-account"};
}

test("account identity survives label changes, while label reuse cannot reuse private state", t=>{
  const options=fixture(t);
  const first=prepareCodexAccountState({...options,label:"old"});
  const renamed=prepareCodexAccountState({...options,label:"new"});
  const replacement=prepareCodexAccountState({...options,label:"old",accountId:"another-account"});
  assert.equal(renamed.accountRoot,first.accountRoot);
  assert.equal(renamed.installationId,first.installationId);
  assert.notEqual(replacement.accountRoot,first.accountRoot);
  assert.notEqual(replacement.installationId,first.installationId);
});

test("custom settings origins share one local account auth target and refresh lock", t=>{
  const options=fixture(t);
  const first=prepareCodexAccountState(options);
  const second=prepareCodexAccountState({...options,env:{CODEX_HOME:path.join(options.homeDir,"custom")}});
  assert.notEqual(second.codexHome,first.codexHome);
  assert.equal(second.accountRoot,first.accountRoot);
  assert.equal(fs.readlinkSync(path.join(first.codexHome,"auth.json")),fs.readlinkSync(path.join(second.codexHome,"auth.json")));
  const nested=codexAccountPaths({...options,env:{CODEX_HOME:first.codexHome},accountId:"nested-other-account"});
  assert.equal(nested.sharedHome,first.sharedHome);
  assert.notEqual(nested.codexHome,first.codexHome);
});

test("a destination anchor rejects copied private-home ownership and does not adopt copied auth or IDs", t=>{
  const options=fixture(t);
  const source=prepareCodexAccountState(options);
  fs.writeFileSync(path.join(source.accountRoot,"auth.json"),'{"tokens":{"account_id":"fixture-account","refresh_token":"SYNTHETIC_SOURCE_ONLY"}}');
  const destination={...fixture(t),environment:{binding:"b".repeat(64)}};
  fs.cpSync(options.homeDir,destination.homeDir,{recursive:true});
  const copiedPrivateHome=path.join(destination.homeDir,path.relative(options.homeDir,source.codexHome));
  assert.throws(()=>prepareCodexAccountState({...destination,env:{CODEX_HOME:copiedPrivateHome}}),/another environment/);
  const fresh=prepareCodexAccountState(destination);
  assert.notEqual(fresh.accountRoot,source.accountRoot);
  assert.notEqual(fresh.installationId,source.installationId);
  assert.equal(fs.existsSync(path.join(fresh.accountRoot,"auth.json")),false);
  assert.ok(fs.readFileSync(path.join(source.accountRoot,"auth.json"),"utf8").includes("SYNTHETIC_SOURCE_ONLY"));
  assert.equal(prepareCodexAccountState(options).installationId,source.installationId);
});

test("catch-all home sharing cannot import auth, IDs, sockets or unknown state",t=>{
  const options=fixture(t), shared=path.join(options.homeDir,".codex");
  for(const name of ["auth.json","installation_id","daemon.sock","unknown-private","AGENTS.md","history.jsonl"]) fs.writeFileSync(path.join(shared,name),"synthetic\n");
  const prepared=prepareCodexAccountState(options);
  assert.equal(fs.existsSync(path.join(prepared.codexHome,"unknown-private")),false);
  assert.equal(fs.existsSync(path.join(prepared.codexHome,"daemon.sock")),false);
  assert.equal(fs.readlinkSync(path.join(prepared.codexHome,"AGENTS.md")),path.join(shared,"AGENTS.md"));
  assert.equal(fs.readlinkSync(path.join(prepared.codexHome,"auth.json")),path.join(prepared.accountRoot,"auth.json"));
  assert.equal(fs.existsSync(path.join(prepared.codexHome,"auth.json")),false);
});

test("machine provisioning identity is opaque, user scoped and requires protected input",()=>{
  const inspect=()=>({kind:"file",bytes:Buffer.from(JSON.stringify({schema:1,id:"b752cd1c-f542-418b-a9c3-f0f9dc309c34"}))});
  assert.equal(readCodexEnvironment({inspect,uid:1001}).binding,readCodexEnvironment({inspect,uid:1001}).binding);
  assert.notEqual(readCodexEnvironment({inspect,uid:1001}).binding,readCodexEnvironment({inspect,uid:1002}).binding);
  assert.throws(()=>readCodexEnvironment({inspect:()=>null,uid:1001}),/provisioned/);
  assert.throws(()=>readCodexEnvironment({inspect:()=>{throw new Error("unsafe ACL");},uid:1001}),/provisioned/);
});
