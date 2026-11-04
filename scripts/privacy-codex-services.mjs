#!/usr/bin/env node
// Native default service destinations are intercepted inside a loopback-only
// network namespace. Baseline children get empty policy in a private mount
// namespace; protected children use the installed/test-mounted AIM policy.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import https from "node:https";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";

const base = "/opt/aimgr-state-audit";
assert.ok(["linux", "darwin"].includes(process.platform));
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const names = ["api.openai.com", "chatgpt.com", "ab.chatgpt.com", "o33249.ingest.us.sentry.io"];
for (const name of names) assert.equal((await dns.lookup(name)).address, "127.0.0.1");
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "services-"));
const homeDir = path.join(root, "home"), cwd = path.join(root, "project");
fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true }); fs.mkdirSync(cwd);
const ca = path.join(root, "ca.pem"), cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
fs.writeFileSync(path.join(root, "ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic services authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n");
fs.writeFileSync(path.join(root, "cert.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1," + names.map(name => "DNS:" + name).join(",") + "\n");
for (const args of [
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", path.join(root, "ca.cnf"), "-keyout", path.join(root, "ca.key"), "-out", ca],
  ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Synthetic services", "-keyout", key, "-out", path.join(root, "cert.csr")],
  ["x509", "-req", "-in", path.join(root, "cert.csr"), "-CA", ca, "-CAkey", path.join(root, "ca.key"), "-set_serial", "1", "-days", "1", "-extfile", path.join(root, "cert.ext"), "-out", cert],
]) execFileSync("openssl", args, { stdio: "ignore" });
const accountId = "synthetic-services-account";
const claims = { exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
const token = rotation => `synthetic.${Buffer.from(JSON.stringify({ ...claims, rotation })).toString("base64url")}.signature`;
const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8",
  CODEX_CA_CERTIFICATE: ca, SSL_CERT_FILE: ca, CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://api.openai.com/oauth/token",
  RUST_LOG: "codex_app_server::otel_reloader=info" };
const environment = readCodexEnvironment();
saveLocalCodexLogin({ homeDir, env, environment, accountId }, { access: token(0), idToken: token(0), refresh: "SYNTHETIC_REFRESH_0", accountId });
const prepared = prepareCodexAccountState({ homeDir, env, environment, accountId });
const source = path.join(homeDir, ".codex/config.toml");
fs.writeFileSync(source, 'model="gpt-6.1-sol"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\napps=false\ncode_mode=false\n[analytics]\nenabled=true\n[feedback]\nenabled=true\n[otel]\nexporter={otlp-http={endpoint="https://api.openai.com/synthetic/otel/logs",protocol="json"}}\ntrace_exporter={otlp-http={endpoint="https://api.openai.com/synthetic/otel/traces",protocol="json"}}\n');
const view = path.join(prepared.codexHome, "config.toml"); fs.symlinkSync(source, view);
const empty = path.join(root, "empty-policy.toml"); fs.writeFileSync(empty, "");
const baselineLauncher = path.join(root, "baseline.py");
fs.writeFileSync(baselineLauncher, `import json,os,subprocess,sys\nfrom pathlib import Path\np=json.loads(Path(sys.argv[1]).read_text())\nassert os.getuid()==0\nassert os.readlink('/proc/self/ns/mnt')!=os.readlink('/proc/1/ns/mnt')\nfor target in ['/etc/codex/managed_config.toml','/etc/codex/requirements.toml']:\n subprocess.run(['mount','--bind',p['empty'],target],check=True)\nos.setgroups([]);os.setgid(p['gid']);os.setuid(p['uid']);os.chdir(p['cwd'])\nos.execve(p['command'],[p['command'],'app-server','--listen','stdio://'],p['env'])\n`);
// The rented Mac is dedicated to this sequential fixture. It has no mount
// namespace, so keep exact private backups while the baseline owns empty local
// policy. Restore before any protected launch and after failure. Never run
// another native fixture concurrently with the macOS baseline.
let macBaselinePolicy = false;
const setMacBaselinePolicy = enabled => {
  if (process.platform !== "darwin" || enabled === macBaselinePolicy) return;
  if (enabled) macBaselinePolicy = true; // A partial setup must still restore.
  execFileSync("sudo", ["-n", "/usr/bin/python3", "-I", "-c", `
import os,sys
from pathlib import Path
assert os.getuid()==0 and Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
root=Path(sys.argv[1]);enabled=sys.argv[2]=='1'
rows=[(Path('/private/etc/codex')/name,root/(name+'.original')) for name in ['managed_config.toml','requirements.toml']]
if enabled:
 for target,backup in rows:
  assert target.is_file() and not target.is_symlink() and target.stat().st_uid==0
  if backup.exists(): assert backup.read_bytes()==target.read_bytes()
  else:
   fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
   with os.fdopen(fd,'wb') as out: out.write(target.read_bytes());out.flush();os.fsync(out.fileno())
 for target,backup in rows: target.write_bytes(b'')
else:
 for target,backup in rows:
  if not backup.exists(): continue
  assert target.read_bytes() in (b'',backup.read_bytes())
  target.write_bytes(backup.read_bytes())
`, root, enabled ? "1" : "0"], { stdio: "ignore" });
  macBaselinePolicy = enabled;
};
const requests = [], remoteFrames = [], modelCounts = new Map(), runs = [];
let phase = "baseline", refreshes = 0, terminalError = false, serverError, current;
const eventsFor = body => {
  const response = { id: "synthetic-" + requests.length, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [{ type: "response.created", response }];
  if (body.generate === false) return [...events, { type: "response.completed", response }];
  if (terminalError) {
    terminalError = false;
    return [...events, { type: "response.failed", response: { ...response, error: { code: "invalid_prompt", message: "Synthetic terminal model failure" } } }];
  }
  let item;
  if (body.input?.some(item => item.type === "compaction_trigger")) item = { type: "compaction", encrypted_content: "SYNTHETIC_COMPACTED_CONTEXT" };
  else if (body.text?.format?.name === "codex_output_schema") item = { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"title":"Synthetic services"}' }] };
  else {
    const thread = body.client_metadata?.thread_id ?? body.client_metadata?.["x-codex-thread-id"] ?? "foreground";
    const count = modelCounts.get(thread) ?? 0; modelCounts.set(thread, count + 1);
    item = count % 2 === 0 ? { type: "function_call", call_id: "tool-" + count, name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf SYNTHETIC_SERVICE_TOOL", login: false, max_output_tokens: 100 }) }
      : { type: "message", role: "assistant", id: "message-" + count, content: [{ type: "output_text", text: "Synthetic services complete." }] };
  }
  return [...events, { type: "response.output_item.done", item }, { type: "response.completed", response }];
};
const enrollment = { server_id: "synthetic-server", environment_id: "synthetic-environment", remote_control_token: "synthetic-relay-token", expires_at: "2099-01-01T00:00:00Z" };
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    let body; try { body = bytes.length ? JSON.parse(bytes.toString()) : {}; } catch { body = { encoded: bytes.toString("base64") }; }
    const url = new URL(req.url, "https://" + req.headers.host);
    requests.push({ phase, method: req.method, host: req.headers.host, url: req.url, headers: req.headers, body });
    const reply = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/oauth/token") {
      assert.equal(body.refresh_token, "SYNTHETIC_REFRESH_" + refreshes); refreshes++;
      return reply({ access_token: token(refreshes), id_token: token(refreshes), refresh_token: "SYNTHETIC_REFRESH_" + refreshes });
    }
    if (url.pathname.endsWith("/accounts/check")) return reply({ accounts: [{ id: accountId, plan_type: "plus", structure: "personal",
      workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }], account_ordering: [accountId], default_account_id: accountId });
    if (url.pathname.endsWith("/server/enroll") || url.pathname.endsWith("/server/refresh")) return reply(enrollment);
    if (url.pathname.endsWith("/responses") && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(eventsFor(body).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    if (url.pathname.endsWith("/models")) return reply({ models: [] });
    if (url.pathname.includes("/analytics-events/") || url.pathname.includes("/otel/") || url.pathname === "/otlp/v1/metrics" || url.pathname.endsWith("/envelope/")) return reply({});
    return reply({});
  } catch (error) { serverError ??= error; res.writeHead(500); res.end("synthetic service failure"); }
});
const websockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => websockets.handleUpgrade(req, socket, head, client => {
  const clientPhase = phase;
  requests.push({ phase, method: "WS", host: req.headers.host, url: req.url, headers: req.headers });
  if (req.url.endsWith("/remote/control/server")) {
    assert.equal(req.headers["x-codex-protocol-version"], "3");
    client.on("message", bytes => remoteFrames.push({ phase: clientPhase, message: JSON.parse(bytes.toString()) }));
    client.send(JSON.stringify({ type: "ping", client_id: "synthetic-client" })); return;
  }
  assert.ok(req.url.endsWith("/responses"));
  client.on("message", bytes => {
    try {
      const body = JSON.parse(bytes.toString()); requests.push({ phase: clientPhase, method: "WS-frame", host: req.headers.host, url: req.url, headers: req.headers, body });
      for (const event of eventsFor(body)) client.send(JSON.stringify(event));
    } catch (error) { serverError ??= error; client.close(); }
  });
}));
server.listen(443, "127.0.0.1"); await once(server, "listening");
const waitFor = async (test, description, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (!test()) {
    if (serverError) throw serverError;
    if (current?.child.exitCode !== null) throw Error("Native exited: " + description);
    if (Date.now() > end) throw Error("Timed out: " + description);
    await delay(25);
  }
};
const start = async protectedLaunch => {
  let invocation, child;
  const args = ["app-server", "--listen", "stdio://"];
  if (protectedLaunch) {
    invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin/codex"), homeDir, cwd, env, args, ownedAppServer: true });
    child = spawn(invocation.command, invocation.args, { cwd, env: invocation.env, detached: true, stdio: ["pipe", "pipe", "pipe", invocation.environmentFd] });
    invocation.closeEnvironment();
  } else if (process.platform === "darwin") {
    setMacBaselinePolicy(true);
    child = spawn(path.join(base, "bin/codex"), args, { cwd, env: { ...env, CODEX_HOME: prepared.codexHome },
      detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    const launch = path.join(root, phase + "-launch.json");
    fs.writeFileSync(launch, JSON.stringify({ uid: process.getuid(), gid: process.getgid(), cwd, empty, command: path.join(base, "bin/codex"), env: { ...env, CODEX_HOME: prepared.codexHome } }));
    child = spawn("sudo", ["-n", "unshare", "--mount", "--propagation", "private", "/usr/bin/python3", "-I", baselineLauncher, launch], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  const run = { phase, child, invocation, done: once(child, "close"), messages: [], stderr: [], nextId: 1 };
  current = run; runs.push(run);
  createInterface({ input: child.stdout }).on("line", line => run.messages.push(JSON.parse(line)));
  child.stderr.on("data", bytes => run.stderr.push(bytes.toString()));
  await call("initialize", { clientInfo: { name: "synthetic_services", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n'); return run;
};
const call = async (method, params, allowError = false) => {
  const id = current.nextId++; current.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  await waitFor(() => current.messages.some(message => message.id === id), method);
  const result = current.messages.find(message => message.id === id);
  if (!allowError) assert.ok(!result.error, JSON.stringify(result));
  return allowError ? result : result.result;
};
const stop = async () => {
  current.child.stdin.end(); let timer;
  try { await Promise.race([current.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Native shutdown timeout")), 15_000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(current.child.exitCode, 0); await current.invocation?.close(); current = null;
  setMacBaselinePolicy(false);
};
const foreground = async () => {
  const { thread } = await call("thread/start", { cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
  const turn = async (text, failed = false) => {
    const result = await call("turn/start", { threadId: thread.id, input: [{ type: "text", text, text_elements: [] }] });
    await waitFor(() => current.messages.some(row => row.method === "turn/completed" && row.params.turn.id === result.turn.id), "native foreground turn");
    const done = current.messages.find(row => row.method === "turn/completed" && row.params.turn.id === result.turn.id);
    assert.equal(done.params.turn.status, failed ? "failed" : "completed");
    if (!failed) assert.ok(current.messages.some(row => row.method === "item/completed" && row.params.turnId === result.turn.id
      && row.params.item.type === "commandExecution" && row.params.item.exitCode === 0 && row.params.item.aggregatedOutput.includes("SYNTHETIC_SERVICE_TOOL")));
  };
  await turn("Run the synthetic service tool.");
  const before = current.messages.length; await call("thread/compact/start", { threadId: thread.id });
  await waitFor(() => current.messages.slice(before).some(row => row.method === "item/completed" && row.params.item.type === "contextCompaction"), "actual native compaction completion");
  const compacted = current.messages.slice(before).find(row => row.method === "item/completed" && row.params.item.type === "contextCompaction");
  await waitFor(() => current.messages.slice(before).some(row => row.method === "turn/completed" && row.params.turn.id === compacted.params.turnId), "compaction turn completion");
  const compactTurn = current.messages.slice(before).find(row => row.method === "turn/completed" && row.params.turn.id === compacted.params.turnId);
  assert.equal(compactTurn.params.turn.status, "completed"); assert.equal(compactTurn.params.turn.error, null);
  await turn("Run the synthetic service tool after compaction.");
  terminalError = true; await turn("Exercise the synthetic terminal model error.", true);
};
const has = (runPhase, kind) => requests.some(row => row.phase === runPhase && (
  kind === "analytics" ? row.url.includes("/analytics-events/") : kind === "statsig" ? row.host === "ab.chatgpt.com" && row.url === "/otlp/v1/metrics"
  : kind === "feedback" ? row.host === "o33249.ingest.us.sentry.io" && row.url.endsWith("/envelope/")
  : kind === "logs" ? row.url === "/synthetic/otel/logs" : row.url === "/synthetic/otel/traces"));
try {
  await start(false); await foreground();
  await call("feedback/upload", { classification: "bug", reason: "synthetic services audit", includeLogs: false });
  await call("account/read", { refreshToken: true });
  await waitFor(() => current.stderr.join("").includes("reloaded telemetry exporters after account change"), "baseline actual exporter reload");
  await call("remoteControl/enable", { ephemeral: false });
  await waitFor(() => remoteFrames.some(row => row.phase === phase && row.message.type === "pong"), "working native remote relay");
  for (const kind of ["analytics", "statsig", "feedback", "logs", "traces"]) await waitFor(() => has(phase, kind), "working native " + kind + " collector");
  await stop();
  phase = "baseline-restart"; await start(false);
  await waitFor(() => requests.some(row => row.phase === phase && row.url.endsWith("/server/refresh"))
    && remoteFrames.some(row => row.phase === phase && row.message.type === "pong"), "saved enabled row reload and relay");
  await stop();
  fs.unlinkSync(view); phase = "protected"; await start(true); await foreground();
  const feedback = await call("feedback/upload", { classification: "bug", reason: "synthetic services audit", includeLogs: false }, true);
  assert.ok(feedback.error?.message.includes("disabled by configuration"));
  for (const [method, params] of [["remoteControl/enable", { ephemeral: false }], ["remoteControl/enable", { ephemeral: true }],
    ["remoteControl/status/read", null], ["remoteControl/pairing/start", { manualCode: false }]]) {
    const result = await call(method, params, true); assert.equal(result.error?.message, "remote control is disabled by managed requirements");
  }
  await call("account/read", { refreshToken: true });
  await waitFor(() => current.stderr.join("").includes("reloaded telemetry exporters after account change"), "protected actual exporter reload");
  // Native config and reloader stay active across attempted local enablement.
  await call("config/value/write", { keyPath: "analytics.enabled", value: true, mergeStrategy: "replace" });
  await current.invocation.flushSettings();
  await stop();
  for (const kind of ["analytics", "statsig", "feedback", "logs", "traces"]) assert.equal(has("protected", kind), false, kind);
  assert.equal(requests.some(row => row.phase === "protected" && row.url.includes("/remote/control/")), false);
  const result = { passed: true, defaultHostnameInterception: true, baselineCollectors: ["analytics", "statsig", "feedback", "logs", "traces"],
    protectedCollectorRequests: 0, actualRefreshes: refreshes, ordinaryToolsAndCompaction: true, terminalModelError: true,
    workingRelay: true, savedEnabledRestart: true, protectedSavedEnabledSuppressed: true };
  fs.writeFileSync(path.join(root, "result.private.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ fixture: root, ...result }));
} finally {
  if (current) {
    if (current.child.exitCode === null) { try { process.kill(-current.child.pid, "SIGKILL"); } catch {} await current.done; }
    await current.invocation?.close();
  }
  setMacBaselinePolicy(false);
  for (const run of runs) {
    fs.writeFileSync(path.join(root, run.phase + ".rpc.private.json"), JSON.stringify(run.messages, null, 2));
    fs.writeFileSync(path.join(root, run.phase + ".stderr.private.txt"), run.stderr.join(""));
  }
  fs.writeFileSync(path.join(root, "requests.private.json"), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(root, "relay.private.json"), JSON.stringify(remoteFrames, null, 2));
  for (const client of websockets.clients) client.terminate(); websockets.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
