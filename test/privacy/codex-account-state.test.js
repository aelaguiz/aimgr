import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readCodexEnvironment } from "../../src/privacy/codex-environment.js";
import { prepareCodexAccountState, codexAccountPaths, linkCodexMcpCredentials } from "../../src/privacy/codex-account-state.js";

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
  const lock = path.join(first.accountRoot, "auth.lock");
  fs.writeFileSync(lock, "", { mode: 0o600 });
  for (const prepared of [first, second]) {
    assert.equal(fs.realpathSync(path.join(prepared.codexHome, "auth.lock")), fs.realpathSync(lock));
    assert.equal(fs.statSync(path.join(prepared.codexHome, "auth.lock")).ino, fs.statSync(lock).ino);
  }
  const nested=codexAccountPaths({...options,env:{CODEX_HOME:first.codexHome},accountId:"nested-other-account"});
  assert.equal(nested.sharedHome,first.sharedHome);
  assert.notEqual(nested.codexHome,first.codexHome);
});

test("explicit home aliases use native canonical origins without changing account ownership", t => {
  const options = fixture(t), shared = path.join(options.homeDir, ".codex");
  const canonical = prepareCodexAccountState({ ...options, env: { CODEX_HOME: shared } });
  for (const name of ["alias one", "alias 日本語"]) {
    const alias = path.join(options.homeDir, name); fs.symlinkSync(shared, alias);
    const prepared = prepareCodexAccountState({ ...options, env: { CODEX_HOME: alias } });
    assert.equal(prepared.sharedHome, fs.realpathSync(shared));
    assert.equal(prepared.codexHome, canonical.codexHome);
    assert.equal(prepared.accountRoot, canonical.accountRoot);
    const nested = codexAccountPaths({ ...options, env: { CODEX_HOME: prepared.codexHome }, accountId: "another-account" });
    assert.equal(nested.sharedHome, prepared.sharedHome);
    assert.notEqual(nested.accountRoot, canonical.accountRoot);
  }
});

test("new explicit homes beneath a directory alias keep the same origin on later launches", t => {
  const options = fixture(t), parent = path.join(options.homeDir, "actual parent"), alias = path.join(options.homeDir, "parent alias");
  fs.mkdirSync(parent); fs.symlinkSync(parent, alias);
  const env = { CODEX_HOME: path.join(alias, "new settings") };
  const first = prepareCodexAccountState({ ...options, env }), second = prepareCodexAccountState({ ...options, env });
  assert.equal(first.sharedHome, path.join(fs.realpathSync(parent), "new settings"));
  for (const key of ["sharedHome", "codexHome", "accountRoot"]) assert.equal(first[key], second[key]);
});

test("all accounts and settings origins share native default-home MCP lock inodes", t => {
  const options = fixture(t), locks = path.join(options.homeDir, ".codex", "mcp-oauth-locks");
  fs.mkdirSync(locks);
  const lock = path.join(locks, "synthetic-key.lock");
  fs.writeFileSync(lock, "existing native lock");
  const inode = fs.statSync(lock).ino;
  const cases = [options, { ...options, env: { CODEX_HOME: path.join(options.homeDir, "custom") } },
    { ...options, accountId: "another-account", env: { CODEX_HOME: path.join(options.homeDir, "third") } }];
  for (const input of cases) {
    const prepared = prepareCodexAccountState(input);
    assert.equal(fs.realpathSync(path.join(prepared.codexHome, "mcp-oauth-locks")), fs.realpathSync(locks));
    assert.equal(fs.statSync(path.join(prepared.codexHome, "mcp-oauth-locks", "synthetic-key.lock")).ino, inode);
  }
  assert.equal(fs.readFileSync(lock, "utf8"), "existing native lock");
});

test("first-use shared capabilities remain shared across accounts and later launches", t => {
  const options = fixture(t);
  const first = prepareCodexAccountState(options);
  const names = ["skills", "agents", "rules", "memory", "memories", "plugins", "marketplaces", "prompts"];
  // Native system-skill installation and ordinary installers create a directory
  // beneath CODEX_HOME. No shared source existed before this account launched.
  for (const name of names) {
    const installed = path.join(first.codexHome, name, "first-install");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "content"), name);
    const authored = path.join(first.sharedHome, name);
    fs.mkdirSync(authored, { recursive: true });
    fs.writeFileSync(path.join(authored, "later-shared-edit"), "shared");
  }
  const reopened = prepareCodexAccountState(options);
  const second = prepareCodexAccountState({ ...options, accountId: "second-account" });
  for (const prepared of [reopened, second]) for (const name of names) {
    assert.equal(fs.realpathSync(path.join(prepared.codexHome, name)), fs.realpathSync(path.join(first.sharedHome, name)));
    assert.equal(fs.readFileSync(path.join(prepared.codexHome, name, "first-install/content"), "utf8"), name);
    assert.equal(fs.readFileSync(path.join(prepared.codexHome, name, "later-shared-edit"), "utf8"), "shared");
  }
  assert.equal(fs.existsSync(path.join(first.sharedHome, "AGENTS.override.md")), false);
});

test("absent instructions preserve fallback and later shared edits in existing homes", t => {
  const options = fixture(t), first = prepareCodexAccountState(options);
  const second = prepareCodexAccountState({ ...options, accountId: "second-account" });
  for (const name of ["AGENTS.md", "AGENTS.override.md", "instructions.md"]) {
    for (const prepared of [first, second]) assert.throws(() => fs.statSync(path.join(prepared.codexHome, name)), { code: "ENOENT" });
    fs.writeFileSync(path.join(first.sharedHome, name), "later shared instruction");
    for (const prepared of [first, second]) assert.equal(fs.readFileSync(path.join(prepared.codexHome, name), "utf8"), "later shared instruction");
    fs.unlinkSync(path.join(first.sharedHome, name));
    for (const prepared of [first, second]) assert.equal(fs.existsSync(path.join(prepared.codexHome, name)), false);
  }
});

test("first-use preparation preserves authored optional directory links", t => {
  const options = fixture(t), shared = path.join(options.homeDir, ".codex");
  const missing = path.join(options.homeDir, "not-installed");
  fs.symlinkSync(missing, path.join(shared, "agents"));
  const prepared = prepareCodexAccountState(options);
  assert.equal(fs.readlinkSync(path.join(shared, "agents")), missing);
  assert.equal(fs.readlinkSync(path.join(prepared.codexHome, "agents")), path.join(shared, "agents"));
  assert.equal(fs.existsSync(missing), false);
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

// Codex rewrites $CODEX_HOME/.credentials.json in place (O_NOFOLLOW, truncate,
// write) when mcp_oauth_credentials_store="file". Simulate that write exactly.
function nativeMcpWrite(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

test("every account home shares one MCP File store without the OS keychain", t => {
  const options = fixture(t), shared = path.join(options.homeDir, ".codex", ".credentials.json");
  nativeMcpWrite(shared, '{"figma":1}');
  const first = prepareCodexAccountState(options);
  const second = prepareCodexAccountState({ ...options, accountId: "another-account" });
  const own = home => path.join(home.codexHome, ".credentials.json");
  for (const home of [first, second]) {
    assert.equal(fs.lstatSync(own(home)).isFile(), true, "a hard link, not a symlink native would refuse to write");
    assert.equal(fs.statSync(own(home)).ino, fs.statSync(shared).ino);
  }
  nativeMcpWrite(own(first), '{"figma":2}');
  assert.equal(fs.readFileSync(own(second), "utf8"), '{"figma":2}', "a refresh in one home reaches every account");
  assert.equal(fs.readFileSync(shared, "utf8"), '{"figma":2}');
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
});

test("a first MCP sign-in inside any account home reaches every account", t => {
  const options = fixture(t), shared = path.join(options.homeDir, ".codex", ".credentials.json");
  const first = prepareCodexAccountState(options);
  const second = prepareCodexAccountState({ ...options, accountId: "another-account" });
  assert.equal(fs.readFileSync(shared, "utf8"), "{}", "native's empty store is created before any sign-in");
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  nativeMcpWrite(path.join(first.codexHome, ".credentials.json"), '{"fly":1}');
  assert.equal(fs.readFileSync(path.join(second.codexHome, ".credentials.json"), "utf8"), '{"fly":1}');
  // Native deletes the file in one home when its last MCP login is removed;
  // that home's next launch publishes a sign-in made there in the meantime.
  fs.unlinkSync(shared);
  fs.unlinkSync(path.join(second.codexHome, ".credentials.json"));
  nativeMcpWrite(path.join(first.codexHome, ".credentials.json"), '{"fly":2}');
  prepareCodexAccountState(options);
  prepareCodexAccountState({ ...options, accountId: "another-account" });
  assert.equal(fs.readFileSync(path.join(second.codexHome, ".credentials.json"), "utf8"), '{"fly":2}');
});

test("MCP File store linking follows a linked shared file, replaces home symlinks and keeps diverged stores", t => {
  const options = fixture(t), real = path.join(options.homeDir, "real-credentials.json");
  nativeMcpWrite(real, '{"real":1}');
  const legacy = path.join(options.homeDir, "legacy-home");
  fs.mkdirSync(legacy);
  fs.symlinkSync(real, path.join(legacy, ".credentials.json"));
  const codexHome = path.join(options.homeDir, "private");
  fs.mkdirSync(codexHome);
  fs.symlinkSync(real, path.join(codexHome, ".credentials.json"));
  linkCodexMcpCredentials({ sharedHome: legacy, codexHome });
  assert.equal(fs.lstatSync(path.join(codexHome, ".credentials.json")).isFile(), true);
  assert.equal(fs.statSync(path.join(codexHome, ".credentials.json")).ino, fs.statSync(real).ino);
  const diverged = path.join(options.homeDir, "diverged");
  fs.mkdirSync(diverged);
  nativeMcpWrite(path.join(diverged, ".credentials.json"), '{"own":1}');
  linkCodexMcpCredentials({ sharedHome: legacy, codexHome: diverged });
  assert.equal(fs.readFileSync(path.join(diverged, ".credentials.json"), "utf8"), '{"own":1}');
  assert.equal(fs.readFileSync(real, "utf8"), '{"real":1}');
});
