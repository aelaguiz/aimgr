import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { codexAccountPaths, prepareCodexAccountState } from "../../src/privacy/codex-account-state.js";
import { readLocalCodexCredential, saveLocalCodexLogin, logoutLocalCodexCredential, maintainLocalCodexCredential } from "../../src/credentials/codex-local.js";
import { buildCodexAuthDotJson } from "../../src/targets/codex-store.js";
import { buildPortableCodexCredential } from "../../src/credentials/codex-portable.js";
import { publishCredential } from "../../src/coordination/redis-store.js";

function fixture(t, binding = "a") {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-auth-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, environment: { binding: binding.repeat(64) }, accountId: "synthetic-account", label: "fixture" };
}
function credential(refresh = "synthetic-local", accountId = "synthetic-account", exp = Date.now() + 3600_000) {
  const access = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), chatgpt_account_id: accountId })).toString("base64url")}.signature`;
  return { access, refresh, accountId, idToken: access, expiresAt: new Date(exp).toISOString() };
}
const reply = body => ({ ok: true, status: 200, json: async () => body });
function refreshed(cred) { return reply({ access_token: cred.access, refresh_token: cred.refresh, id_token: cred.idToken }); }
function nativeWrite(options, cred) {
  const target = path.join(codexAccountPaths(options).accountRoot, "auth.json");
  fs.writeFileSync(`${target}.native`, JSON.stringify(buildCodexAuthDotJson({ credential: cred })), { mode: 0o600 });
  fs.renameSync(`${target}.native`, target);
}

test("authorization stays in one environment across restart, label rename and custom settings homes", t => {
  const options = fixture(t), saved = saveLocalCodexLogin(options, credential());
  const resumed = readLocalCodexCredential({ ...options, label: "renamed", env: { CODEX_HOME: path.join(options.homeDir, "custom") } });
  assert.equal(resumed.credential.refresh, saved.credential.refresh);
  assert.equal(resumed.paths.accountRoot, saved.paths.accountRoot);
  assert.equal(resumed.status, "ready");
});

test("copying the entire user state and provenance cannot bootstrap a separately provisioned environment", t => {
  const a = fixture(t), b = fixture(t, "b");
  const saved = saveLocalCodexLogin(a, credential("source-only"));
  fs.cpSync(a.homeDir, b.homeDir, { recursive: true });
  assert.equal(readLocalCodexCredential(b).status, "login_required");
  const dest = prepareCodexAccountState(b);
  // Even moving copied files into the destination's correctly named directory
  // cannot turn the old provenance into a destination authorization.
  for (const name of ["auth.json", "grant.json"]) fs.copyFileSync(path.join(saved.paths.accountRoot, name), path.join(dest.accountRoot, name));
  assert.equal(readLocalCodexCredential(b).status, "login_required");
  const bSaved = saveLocalCodexLogin(b, credential("destination-only"));
  assert.equal(bSaved.credential.refresh, "destination-only");
  assert.equal(readLocalCodexCredential(a).credential.refresh, "source-only");
});

test("an unscoped auth file is never adopted or refreshed as independent authorization", async t => {
  const options = fixture(t);
  prepareCodexAccountState(options);
  nativeWrite(options, credential("legacy-global"));
  const result = await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl: () => assert.fail("must not refresh copied auth") });
  assert.equal(result.status, "login_required");
  assert.equal(result.credential, null);
});

test("local grants are rejected before Redis publication or portable field stripping", async t => {
  const local = saveLocalCodexLogin(fixture(t), credential()).credential;
  assert.throws(() => buildPortableCodexCredential({ label: "fixture", credential: local }), /cannot be published/);
  await assert.rejects(publishCredential({ client: new Proxy({}, { get() { assert.fail("Redis must not be contacted"); } }) }, {
    credentialRecord: { provider: "openai-codex", label: "fixture", credential: local },
  }), /cannot be published/);
  assert.equal(buildPortableCodexCredential({ label: "fixture", credential: credential("legacy-global") }).refresh, "legacy-global");
});

test("refresh and invalid_grant in A cannot replace or block B's independent grant", async t => {
  const a = fixture(t), b = fixture(t, "b");
  saveLocalCodexLogin(a, credential("old-a", a.accountId, Date.now() + 60_000));
  saveLocalCodexLogin(b, credential("healthy-b"));
  let calls = 0;
  let result = await maintainLocalCodexCredential(a, { fetchJsonWithTimeoutImpl: async (_url, init, timeout) => {
    calls++; assert.equal(init.body.get("refresh_token"), "old-a"); assert.equal(init.redirect, "error"); assert.equal(timeout, 8000);
    return refreshed(credential("fresh-a"));
  } });
  assert.equal(result.credential.refresh, "fresh-a");
  result = await maintainLocalCodexCredential(a, { refreshBeforeMs: 24 * 3600_000, fetchJsonWithTimeoutImpl: async () => reply({ error: "invalid_grant" }) });
  assert.equal(result.status, "reauth_required");
  assert.equal(calls, 1);
  assert.equal(readLocalCodexCredential(b).credential.refresh, "healthy-b");
  assert.equal(logoutLocalCodexCredential(a).committed, true);
  assert.equal(readLocalCodexCredential(a).status, "login_required");
  assert.equal(readLocalCodexCredential(b).credential.refresh, "healthy-b");
});

for (const outcome of ["success", "invalid_grant"]) test(`a native rotation while HTTP is pending wins over stale AIM ${outcome}`, async t => {
  const options = fixture(t);
  saveLocalCodexLogin(options, credential("old", options.accountId, Date.now() + 60_000));
  const result = await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl: async () => {
    nativeWrite(options, credential("native-winner"));
    return outcome === "success" ? refreshed(credential("stale-aim")) : reply({ error: "invalid_grant" });
  } });
  assert.equal(result.status, "ready");
  assert.equal(result.credential.refresh, "native-winner");
});

test("primary auth writes honor a native flock holder and keep the sidecar inode", async t => {
  const options = fixture(t), saved = saveLocalCodexLogin(options, credential());
  const lock = path.join(saved.paths.accountRoot, "auth.json.lock");
  const inode = fs.statSync(lock).ino;
  const holder = spawn("/usr/bin/python3", ["-I", "-c", "import fcntl,sys,time; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); time.sleep(.25)", lock], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await once(holder.stdout, "data");
  const start = Date.now();
  saveLocalCodexLogin(options, credential("next"));
  assert.ok(Date.now() - start >= 150);
  assert.equal(fs.statSync(lock).ino, inode);
});

test("a successful concurrent refresh supersedes an earlier invalid_grant for the same generation", async t => {
  const options = fixture(t);
  saveLocalCodexLogin(options, credential("old", options.accountId, Date.now() + 60_000));
  let complete;
  const pending = maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl: () => new Promise(resolve => { complete = resolve; }) });
  const failed = await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl: async () => reply({ error: "invalid_grant" }) });
  assert.equal(failed.status, "reauth_required");
  complete(refreshed(credential("successful-new-generation")));
  const winner = await pending;
  assert.equal(winner.status, "ready");
  assert.equal(winner.credential.refresh, "successful-new-generation");
});

test("foreign, readonly and hard-linked auth cannot be replaced, including logout", t => {
  const options = fixture(t), saved = saveLocalCodexLogin(options, credential());
  const file = path.join(saved.paths.accountRoot, "auth.json");
  fs.chmodSync(file, 0o400);
  assert.throws(() => saveLocalCodexLogin(options, credential("new")), /state auth failed/);
  assert.throws(() => logoutLocalCodexCredential(options), /state auth failed/);
  fs.chmodSync(file, 0o600);
  fs.linkSync(file, `${file}.hardlink`);
  assert.throws(() => logoutLocalCodexCredential(options), /singly owned/);
  fs.unlinkSync(`${file}.hardlink`);
  nativeWrite(options, credential("foreign", "different-account"));
  assert.throws(() => logoutLocalCodexCredential(options), /state auth failed/);
});

test("missing provenance after interrupted login requires authorization, never a refresh", async t => {
  const options = fixture(t), saved = saveLocalCodexLogin(options, credential());
  fs.unlinkSync(path.join(saved.paths.accountRoot, "grant.json"));
  nativeWrite(options, credential("uncommitted-new-grant"));
  assert.equal((await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl: () => assert.fail("no network") })).status, "login_required");
});

test("alternative native auth modes cannot override an admitted local ChatGPT grant", t => {
  const options = fixture(t), saved = saveLocalCodexLogin(options, credential());
  const file = path.join(saved.paths.accountRoot, "auth.json"), original = JSON.parse(fs.readFileSync(file));
  for (const alternative of [{ auth_mode: "api_key" }, { personal_access_token: "synthetic-pat" },
    { bedrock_api_key: "synthetic-bedrock" }, { bedrock_access_keys: { access_key_id: "synthetic" } }, { OPENAI_API_KEY: "synthetic-api-key" }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, ...alternative }));
    assert.equal(readLocalCodexCredential(options).status, "login_required");
  }
  fs.writeFileSync(file, JSON.stringify({ ...original, agent_identity: { synthetic: "legitimate native cached metadata" } }));
  assert.equal(readLocalCodexCredential(options).status, "ready");
});
