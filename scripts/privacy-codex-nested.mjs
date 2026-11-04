#!/usr/bin/env node
// Official clients, public AIM CLI, private Redis and synthetic loopback services.
// No browser, real credential or normal home belongs in this fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../src/coordination/redis-store.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { buildAnthropicClaudeCredential } from "../test/helpers/claude.js";
import { runClaudeCliNoninteractive, prepareClaudeCliLaunch } from "../src/targets/claude-runner.js";
import { buildManagedClaudeNativeStorageDescriptor } from "../src/credentials/claude-native-storage.js";
import { projectClaudeNativeBundleToManagedConfig } from "../src/targets/claude-cli.js";
import { admitClaudeArtifact } from "../src/privacy/claude-artifacts.js";

assert.equal(process.platform, "linux");
assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST") && process.getuid() !== 0);
assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync("/opt/aimgr-state-audit/codex-m1-fixtures/nested-");
const homeDir = path.join(root, "home"), cwd = path.join(root, "project"), bin = path.join(root, "bin");
for (const dir of [path.join(homeDir, ".codex"), path.join(homeDir, ".claude"), cwd, bin]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const cli = fileURLToPath(new URL("../bin/aimgr.js", import.meta.url));
const accounts = ["a", "b"].map((label, index) => {
  const accountId = "synthetic-nested-codex-" + label;
  const claims = { exp: Math.floor(Date.now() / 1000) + 7200,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
  const credential = buildAnthropicClaudeCredential({ access: "sk-ant-oat01-synthetic-" + label, refresh: "synthetic-refresh-" + label,
    emailAddress: "synthetic-" + label + "@example.invalid", organizationUuid: "00000000-0000-4000-8000-00000000000" + (2 + 2 * index),
    subscriptionType: "pro", rateLimitTier: "default_claude_pro" });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = "00000000-0000-4000-8000-00000000000" + (1 + 2 * index);
  credential.nativeClaudeBundle.claudeAiOauth.subscriptionTypeSource = "sign_in";
  return { accountId, label, token: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, credential };
});
const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem"), ca = path.join(root, "ca.pem");
fs.writeFileSync(path.join(root, "ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic routine authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n");
fs.writeFileSync(path.join(root, "cert.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:api.anthropic.com,DNS:claude.ai,DNS:console.anthropic.com,DNS:chatgpt.com,DNS:api.openai.com\n");
for (const args of [
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", path.join(root, "ca.cnf"), "-keyout", path.join(root, "ca.key"), "-out", ca],
  ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", path.join(root, "cert.csr")],
  ["x509", "-req", "-in", path.join(root, "cert.csr"), "-CA", ca, "-CAkey", path.join(root, "ca.key"), "-set_serial", "1", "-days", "1", "-extfile", path.join(root, "cert.ext"), "-out", cert],
]) execFileSync("openssl", args, { stdio: "ignore" });

const requests = [], models = [], children = [];
const threadRoles = new Map();
const reviewerOnly = process.argv.includes("--reviewer-only");
const protectedClaude = process.argv.includes("--protected-claude");
let protectedParentObserved = false;
let serverError;
const roles = {
  "codex-parent": ["codex", "a", true], "codex-peer": ["claude", "a"],
  "codex-same": ["codex", "a"], "codex-other": ["codex", "b"],
  "claude-parent": ["claude", "a", true], "claude-peer": ["codex", "a"],
  "claude-same": ["claude", "a"], "claude-other": ["claude", "b"],
};
const roleOf = body => JSON.stringify(body.messages ?? body.input).match(/NESTED_CASE:([a-z-]+)/)?.[1];
const commandFor = role => roles[role][2]
  ? q(process.execPath) + " " + q(path.join(cwd, "children.mjs")) + " " + q(role)
  : "cat " + q(path.join(cwd, "brief.txt")) + " " + q(path.join(cwd, "example.js"));
function record(req, body, provider) {
  const thread = req.headers["session-id"] ?? body.client_metadata?.session_id;
  const role = roleOf(body) ?? (thread && threadRoles.get(thread));
  if (!roles[role]) return null; // Native startup/title probes are separate requests.
  if (thread) threadRoles.set(thread, role);
  const [expectedProvider, label, parent] = roles[role], account = accounts.find(row => row.label === label);
  assert.equal(provider, expectedProvider);
  assert.equal(req.headers.authorization, "Bearer " + (provider === "codex" ? account.token : account.credential.nativeClaudeBundle.claudeAiOauth.accessToken));
  if (provider === "codex") {
    assert.equal(req.headers["chatgpt-account-id"], account.accountId);
    assert.equal(body.client_metadata["x-codex-installation-id"], account.prepared.installationId);
  }
  if (protectedClaude && role === "claude-parent") {
    // The privileged launcher makes vendor processes nondumpable. Inspect
    // only this fixture's owned descendants as root; never weaken that mode.
    protectedParentObserved ||= JSON.parse(execFileSync("sudo", ["-n", "/usr/bin/python3", "-I", "-c", `
import json,os,re,subprocess,sys
from pathlib import Path
parents={int(row[0]):int(row[1]) for line in subprocess.check_output(['ps','-eo','pid=,ppid='],text=True).splitlines() if (row:=line.split())}
owned={int(sys.argv[1])}
while True:
 next_owned=owned|{pid for pid,parent in parents.items() if parent in owned}
 if next_owned==owned: break
 owned=next_owned
found=False
for pid in owned:
 try:
  image=Path(os.readlink('/proc/'+str(pid)+'/exe'))
  profile=Path('/proc/'+str(pid)+'/attr/current').read_text().strip()
  found|=image.name=='claude' and bool(re.fullmatch(r'aim-claude-p-\\d+-[0-9a-f]+ \\(enforce\\)',profile))
 except (FileNotFoundError,ProcessLookupError): pass
print(json.dumps(found))
`, String(children[0].pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  }
  const row = { role, provider, label, parent: !!parent, headers: req.headers, body };
  models.push(row); return row;
}
function codexFrames(req, body) {
  const response = { id: "synthetic-" + requests.length, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  if (body.generate === false) return [{ type: "response.created", response }, { type: "response.completed", response }];
  const row = record(req, body, "codex"), input = body.input ?? [];
  const output = input.filter(item => item.type === "function_call_output").at(-1)?.output;
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const running = text.match(/Process running with session ID (\d+)/);
  const done = row && text.includes(row.parent ? "NESTED_PARENT_COMPLETE" : "SYNTHETIC_NESTED_FILE");
  if (row && output && !running && !done) serverError ??= Error("Native nested tool failed: " + text.slice(-1500));
  let item;
  if (done || !row || serverError) item = { type: "message", role: "assistant", id: response.id, content: [{ type: "output_text", text: serverError ? "SYNTHETIC_FAILED" : "SYNTHETIC_NESTED_DONE" }] };
  else {
    assert.ok(!output || running, "Native nested tool failed; inspect private evidence");
    item = { type: "function_call", call_id: "nested-" + models.length, name: running ? "write_stdin" : "exec_command",
      arguments: JSON.stringify(running ? { session_id: Number(running[1]), chars: "", yield_time_ms: 1000, max_output_tokens: 1000 }
        : { cmd: commandFor(row.role), login: false, yield_time_ms: 1000, max_output_tokens: 1500 }) };
  }
  return [{ type: "response.created", response }, { type: "response.output_item.done", item }, { type: "response.completed", response }];
}
function claudeFrames(req, body) {
  const row = record(req, body, "claude");
  const blocks = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []);
  const result = blocks.filter(block => block.type === "tool_result").at(-1);
  if (result?.is_error) serverError ??= Error("Native nested Claude tool failed");
  const done = !row || !!result;
  if (row && done && !JSON.stringify(result).includes(row.parent ? "NESTED_PARENT_COMPLETE" : "SYNTHETIC_NESTED_FILE")) serverError ??= Error("Native nested Claude result did not complete the fixture");
  const content = done ? { type: "text", text: serverError ? "SYNTHETIC_FAILED" : "SYNTHETIC_NESTED_DONE" }
    : { type: "tool_use", id: "nested-" + models.length, name: "Bash", input: { command: commandFor(row.role), timeout: 180000 } };
  const response = { id: "msg_synthetic", type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return [{ type: "message_start", message: response },
    { type: "content_block_start", index: 0, content_block: done ? { type: "text", text: "" } : { ...content, input: {} } },
    { type: "content_block_delta", index: 0, delta: done ? { type: "text_delta", text: content.text } : { type: "input_json_delta", partial_json: JSON.stringify(content.input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" }];
}
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    const pathname = new URL(req.url, "https://fixture.invalid").pathname;
    requests.push({ host: req.headers.host, path: pathname });
    const reply = value => { res.writeHead(200, { "content-type": "application/json", "request-id": "synthetic" }); res.end(JSON.stringify(value)); };
    if (pathname.endsWith("/responses") || pathname === "/v1/messages") {
      const frames = pathname === "/v1/messages" ? claudeFrames(req, body) : codexFrames(req, body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    if (pathname === "/backend-api/wham/usage") return reply({ plan_type: "plus", rate_limit: { allowed: true,
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 7200 } } });
    if (pathname === "/api/oauth/usage") return reply({ five_hour: { utilization: 1, resets_at: new Date(Date.now() + 7200000).toISOString() } });
    if (pathname === "/api/oauth/profile") {
      const account = accounts.find(row => req.headers.authorization === "Bearer " + row.credential.nativeClaudeBundle.claudeAiOauth.accessToken);
      assert.ok(account); const identity = account.credential.nativeClaudeBundle.oauthAccount;
      return reply({ account: { uuid: identity.accountUuid, email: identity.emailAddress },
        organization: { uuid: identity.organizationUuid, organization_type: "claude_pro", rate_limit_tier: "default_claude_pro" } });
    }
    if (pathname.endsWith("/accounts/check")) return reply({ accounts: accounts.map(row => ({ id: row.accountId, plan_type: "plus", structure: "personal",
      workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" })), account_ordering: accounts.map(row => row.accountId), default_account_id: accounts[0].accountId });
    if (pathname.endsWith("/count_tokens")) return reply({ input_tokens: 1 });
    return reply({ features: {}, data: [], models: [] });
  } catch (error) { serverError ??= error; res.writeHead(500); res.end("Synthetic fixture failure"); }
});
const ws = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head, client => {
  client.on("message", bytes => { try { for (const event of codexFrames(req, JSON.parse(bytes.toString()))) client.send(JSON.stringify(event)); }
    catch (error) { serverError ??= error; client.close(); } });
}));
server.listen(443, "0.0.0.0"); await once(server, "listening");
const env = { HOME: homeDir, PATH: `${bin}:/opt/aimgr-state-audit/bin:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "xterm-256color",
  CODEX_CA_CERTIFICATE: ca, NODE_EXTRA_CA_CERTS: ca };
const config = 'model="gpt-6.1-sol"\napproval_policy="never"\n[features]\napps=false\ncode_mode=false\nhooks=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n';
fs.writeFileSync(path.join(homeDir, ".codex/config.toml"), config);
fs.writeFileSync(path.join(homeDir, ".claude/settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
fs.writeFileSync(path.join(cwd, "brief.txt"), "Read the code and report its return value. SYNTHETIC_NESTED_FILE\n");
fs.writeFileSync(path.join(cwd, "example.js"), "export const value = () => 42;\n");
const environment = readCodexEnvironment();
for (const account of accounts) {
  saveLocalCodexLogin({ homeDir, env, environment, accountId: account.accountId, label: account.label },
    { access: account.token, idToken: account.token, refresh: "SYNTHETIC_REFRESH_" + account.label, accountId: account.accountId });
  account.prepared = prepareCodexAccountState({ homeDir, env, environment, accountId: account.accountId, label: account.label });
}
const aim = path.join(bin, "aim"); fs.writeFileSync(aim, `#!/bin/sh\nexec ${q(process.execPath)} ${q(cli)} "$@"\n`, { mode: 0o700 });
const argvFor = role => {
  const [provider, label, parent] = roles[role];
  return provider === "claude" ? ["claude", "run", label, "--", "-p", "NESTED_CASE:" + role, "--model", "sonnet", "--output-format", "json", "--dangerously-skip-permissions"]
    : ["codex", "run", label, "--", "exec", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', ...(parent
      ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", "read-only"]), "-C", cwd, "--skip-git-repo-check", "--json", "NESTED_CASE:" + role];
};
fs.writeFileSync(path.join(cwd, "children.mjs"), `import fs from 'node:fs';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const parent=process.argv[2], commands=${JSON.stringify(Object.fromEntries(Object.keys(roles).filter(role => !roles[role][2]).map(role => [role, argvFor(role)])))};
fs.writeFileSync(${JSON.stringify(root)}+'/'+parent+'.environment.private.json',JSON.stringify({HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,CLAUDECODE:process.env.CLAUDECODE}));
for(const kind of ${JSON.stringify(protectedClaude ? ["peer"] : ["peer", "same", "other"])}){const role=parent.replace('parent',kind);const r=spawnSync(${JSON.stringify(aim)},commands[role],{cwd:${JSON.stringify(cwd)},env:process.env,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
fs.writeFileSync(${JSON.stringify(root)}+'/'+role+'.private.log',(r.stdout??'')+(r.stderr??''));assert.equal(r.status,0,role+' failed');assert.match(r.stdout,/SYNTHETIC_NESTED_DONE/);}
console.log('NESTED_PARENT_COMPLETE');
`);
const redisLog = fs.openSync(path.join(root, "redis.private.log"), "w", 0o600);
const redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", "6382", "--save", "", "--appendonly", "no", "--dir", root], { cwd: root, env, stdio: ["ignore", redisLog, redisLog] }); fs.closeSync(redisLog);
let store;
try {
  for (let n = 0; !fs.readFileSync(path.join(root, "redis.private.log"), "utf8").includes("Ready to accept connections"); n++) { assert.ok(n < 100); await delay(50); }
  const url = "redis://127.0.0.1:6382", keyPrefix = "aimgr:nested-synthetic:";
  store = await connectRedisStore({ url, keyPrefix, connectionPolicy: "leased" });
  writeAimgrConfig({ homeDir, config: { redis: { url, keyPrefix } } });
  await importCredentialsSnapshot(store, { credentials: accounts.flatMap(account => [
    { provider: "openai-codex", label: account.label, identity: { accountId: account.accountId }, credential: { access: "SYNTHETIC_FOREIGN", refresh: "SYNTHETIC_FOREIGN", accountId: account.accountId }, policy: { pool: { enabled: true } }, health: { status: "ready" } },
    { provider: "anthropic", label: account.label, credential: account.credential, identity: account.credential.nativeClaudeBundle.oauthAccount,
      policy: { expect: { email: account.credential.nativeClaudeBundle.oauthAccount.emailAddress }, pool: { enabled: true } }, health: { status: "ready" } },
  ]) }, { updatedBy: "synthetic", observedAt: new Date().toISOString() });
  if (protectedClaude) {
    const account = accounts[0], managedHome = path.join(homeDir, ".aimgr/claude-homes/a"), configDir = path.join(managedHome, ".claude");
    const launch = { command: admitClaudeArtifact().command, userHomeDir: homeDir, homeDir: managedHome, configDir, cwd };
    await prepareClaudeCliLaunch(launch);
    const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, defaultConfigDir: path.join(homeDir, ".claude"),
      expectedEmail: account.credential.nativeClaudeBundle.oauthAccount.emailAddress, managedRootDir: path.join(homeDir, ".aimgr") });
    await projectClaudeNativeBundleToManagedConfig({ descriptor, credential: account.credential });
    let output = "";
    const result = await runClaudeCliNoninteractive({ ...launch, args: argvFor("claude-parent").slice(4), env, timeoutMs: 240000,
      expectedIdentity: account.credential.nativeClaudeBundle.oauthAccount, egressProfile: { profileRef: "synthetic-nesting" },
      // Only routing is replaced: the fixture has no external interface. The
      // production runner still chooses and enforces protected vendor mode.
      prepareClaudeNativeRouteImpl: async ({ command, args }) => ({ command, args }),
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options); children.push(child);
        child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
        return child;
      },
      maxOutputBytes: 1024 * 1024 });
    fs.writeFileSync(path.join(root, "claude-parent.private.log"), output);
    assert.equal(result.status, 0, "protected Claude parent failed; private evidence " + root);
    assert.ok(protectedParentObserved, "the real parent must be observed in enforcing vendor policy");
  }
  for (const role of protectedClaude ? [] : reviewerOnly ? ["codex-same"] : ["codex-parent", "claude-parent"]) {
    const log = fs.openSync(path.join(root, role + ".private.log"), "w", 0o600);
    const child = spawn(aim, argvFor(role), { cwd, env, detached: true, stdio: ["ignore", log, log] }); fs.closeSync(log); children.push(child);
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 240000);
    const [code, signal] = await once(child, "close"); clearTimeout(timer);
    if (serverError) throw serverError;
    assert.equal(code, 0, role + " failed (" + signal + "); private evidence " + root);
  }
  for (const [role, [provider, label, parent]] of Object.entries(roles)) {
    if (protectedClaude && !["claude-parent", "claude-peer"].includes(role)) continue;
    if (reviewerOnly && role !== "codex-same") continue;
    const rows = models.filter(row => row.role === role); assert.ok(rows.length >= 2, role + " native tool round trip");
    assert.ok(JSON.stringify(rows.at(-1).body).includes(parent ? "NESTED_PARENT_COMPLETE" : "SYNTHETIC_NESTED_FILE"));
    if (provider === "claude") {
      const ids = new Set(rows.map(row => JSON.parse(row.body.metadata.user_id).device_id)); assert.equal(ids.size, 1);
      const native = JSON.parse(fs.readFileSync(path.join(homeDir, ".aimgr/claude-homes", label, ".claude/.claude.json")));
      assert.ok(ids.has(native.userID));
    }
  }
  console.log(JSON.stringify({ fixture: root, ...(protectedClaude ? { protectedClaudeToNativeReadOnlyCodex: true,
    enforcingClaudeParentObserved: protectedParentObserved, unchangedToolEnvironment: true, routingNotTested: true } : reviewerOnly ? { nativeReadOnlyReviewer: true } : {
    officialParents: 2, codexPrivacyEnforced: true, claudeMode: "ordinary", nestedChildren: 6,
    nativeReadOnlyReviewers: 3, unchangedToolEnvironment: true, parentIdentityPreserved: true }) }));
} catch (error) { console.error(error.message + "; private evidence " + root); process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(root, "models.private.json"), JSON.stringify(models, null, 2));
  fs.writeFileSync(path.join(root, "requests.private.json"), JSON.stringify(requests, null, 2));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  if (store?.client?.isOpen) await store.client.quit();
  const ended = once(redis, "close"); redis.kill("SIGTERM"); await ended;
  for (const client of ws.clients) client.terminate(); ws.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
