#!/usr/bin/env node
// Focused native observation: a live exporter edit followed by real same-login
// refresh. Only synthetic state, loopback endpoints and the admitted official
// executable are used. Requires isolated DNS for api.openai.com -> loopback.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin, readLocalCodexCredential } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";

const base = "/opt/aimgr-state-audit";
const disableExporters = process.argv.includes("--requirements-none");
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
assert.equal((await dns.lookup("api.openai.com")).address, "127.0.0.1");
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "collector-reload-"));
const homeDir = path.join(root, "home"), cwd = path.join(root, "project");
fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true }); fs.mkdirSync(cwd);
const source = path.join(homeDir, ".codex/config.toml");
const authority = path.join(root, "authority.pem"), authorityKey = path.join(root, "authority.key");
const certificate = path.join(root, "loopback.pem"), certificateKey = path.join(root, "loopback.key");
const config = path.join(root, "authority.cnf"), request = path.join(root, "loopback.csr"), extensions = path.join(root, "loopback.ext");
fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic AIM fixture authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n");
fs.writeFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
for (const args of [
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", authorityKey, "-out", authority],
  ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", certificateKey, "-out", request],
  ["x509", "-req", "-in", request, "-CA", authority, "-CAkey", authorityKey, "-set_serial", "1", "-days", "1", "-extfile", extensions, "-out", certificate],
  ["verify", "-CAfile", authority, "-purpose", "sslserver", certificate],
]) execFileSync("openssl", args, { stdio: "ignore" });
const accountId = "synthetic-collector-reload", environment = readCodexEnvironment();
const claims = { exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
const token = rotation => `synthetic.${Buffer.from(JSON.stringify({ ...claims, rotation })).toString("base64url")}.signature`;
const receipts = [], modelCounts = new Map();
let refreshes = 0, serverError;
const handler = async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    receipts.push({ url: req.url, host: req.headers.host, headers: req.headers, body });
    const reply = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/oauth/token") {
      assert.equal(body.refresh_token, "SYNTHETIC_REFRESH"); refreshes++;
      return reply({ access_token: token(1), id_token: token(1), refresh_token: "SYNTHETIC_ROTATED_REFRESH" });
    }
    if (req.url === "/api/codex/accounts/check") return reply({ accounts: [{ id: accountId, plan_type: "plus", structure: "personal",
      workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }], account_ordering: [accountId], default_account_id: accountId });
    if (req.url.startsWith("/models")) return reply({ models: [] });
    if (req.url === "/responses" && req.method === "POST") {
      if (body.generate === false || body.text?.format?.name === "codex_output_schema") {
        const response = { id: "synthetic-auxiliary", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([{ type: "response.created", response }, { type: "response.completed", response }]
          .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
      }
      const thread = body.client_metadata?.thread_id;
      const count = modelCounts.get(thread) ?? 0; modelCounts.set(thread, count + 1);
      const item = count % 2 === 0 ? { type: "function_call", call_id: "proof-" + count, name: "exec_command",
        arguments: JSON.stringify({ cmd: "printf SYNTHETIC_COLLECTOR_TOOL_PROOF", login: false, max_output_tokens: 100 }) }
        : { type: "message", role: "assistant", id: "message-" + count, content: [{ type: "output_text", text: "Synthetic collector turn complete." }] };
      const response = { id: "response-" + count, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([{ type: "response.created", response }, { type: "response.output_item.done", item }, { type: "response.completed", response }]
        .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    return reply({});
  } catch (error) { serverError ??= error; res.writeHead(500); res.end("synthetic fixture error"); }
};
const api = https.createServer({ key: fs.readFileSync(certificateKey), cert: fs.readFileSync(certificate) }, handler);
const collector = http.createServer(handler);
api.listen(0, "127.0.0.1"); collector.listen(0, "127.0.0.1");
await Promise.all([once(api, "listening"), once(collector, "listening")]);
const endpoint = `https://127.0.0.1:${api.address().port}`;
const permitted = `http://127.0.0.1:${collector.address().port}/independent/logs`;
const prohibited = `http://api.openai.com:${collector.address().port}/provider/logs`;
fs.writeFileSync(source, `model="gpt-6.1-sol"\nopenai_base_url=${JSON.stringify(endpoint)}\nchatgpt_base_url=${JSON.stringify(endpoint)}\n` +
  `approval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\napps=false\ncode_mode=false\n` +
  `[otel]\nexporter={otlp-http={endpoint=${JSON.stringify(permitted)},protocol="json"}}\ntrace_exporter="none"\nmetrics_exporter="none"\n`);
const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8",
  RUST_LOG: "codex_app_server::otel_reloader=info",
  CODEX_CA_CERTIFICATE: authority, CODEX_REFRESH_TOKEN_URL_OVERRIDE: endpoint + "/oauth/token" };
const options = { homeDir, env, environment, accountId, label: "synthetic" };
saveLocalCodexLogin(options, { access: token(0), idToken: token(0), refresh: "SYNTHETIC_REFRESH", accountId });
const prepared = prepareCodexAccountState(options), messages = [], stderr = [];
let invocation, child, done, nextId = 1;
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (serverError) throw serverError;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("Native exited: " + description);
    if (Date.now() > deadline) throw new Error("Timed out: " + description);
    await delay(25);
  }
};
const call = async (method, params) => {
  const id = nextId++; child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  await waitFor(() => messages.some(message => message.id === id), method);
  const response = messages.find(message => message.id === id);
  assert.ok(!response.error, JSON.stringify(response)); return response.result;
};
try {
  invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin/codex"), homeDir, cwd, env,
    args: ["app-server", "--listen", "stdio://"], ownedAppServer: true });
  const artifactSet = invocation.artifact.artifactSet;
  child = spawn(invocation.command, invocation.args, { cwd, env: invocation.env, detached: true,
    stdio: ["pipe", "pipe", "pipe", invocation.environmentFd] });
  done = once(child, "close"); invocation.closeEnvironment();
  createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
  child.stderr.on("data", data => stderr.push(data.toString()));
  await call("initialize", { clientInfo: { name: "collector_audit", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const thread = await call("thread/start", { cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
  const turn = async text => {
    const result = await call("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text, text_elements: [] }] });
    await waitFor(() => messages.some(message => message.method === "turn/completed" && message.params.turn.id === result.turn.id), "native turn completion");
    const completed = messages.find(message => message.method === "turn/completed" && message.params.turn.id === result.turn.id);
    assert.equal(completed.params.turn.status, "completed");
    assert.ok(messages.some(message => message.method === "item/completed" && message.params.turnId === result.turn.id
      && message.params.item.type === "commandExecution" && message.params.item.exitCode === 0
      && message.params.item.aggregatedOutput.includes("SYNTHETIC_COLLECTOR_TOOL_PROOF")), "actual native shell succeeds");
  };
  await turn("Run the synthetic ordinary tool proof.");
  if (!disableExporters) await waitFor(() => receipts.some(row => row.url === "/independent/logs"), "independent native exporter positive");
  fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace(permitted, prohibited));
  await invocation.flushSettings();
  const read = await call("config/read", { includeLayers: false, cwd });
  if (disableExporters) {
    assert.equal(read.config.otel.exporter, "none");
    assert.equal(read.config.otel.trace_exporter, "none");
    assert.equal(read.config.otel.metrics_exporter, "none");
  } else assert.ok(JSON.stringify(read).includes(prohibited), "native observes the changed exporter");
  await call("account/read", { refreshToken: true });
  assert.equal(refreshes, 1);
  assert.equal(readLocalCodexCredential(options).credential.access, token(1));
  await waitFor(() => stderr.join("").includes("reloaded telemetry exporters after account change"), "actual native exporter reload");
  await turn("Run the synthetic ordinary tool proof after refresh.");
  // Shutdown flush is an actual observation trigger, not silence during an
  // arbitrarily short idle window. The same script keeps the positive receipt.
  child.stdin.end();
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native shutdown timed out")), 15_000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(child.exitCode, 0);
  await invocation.close(); invocation = null;
  const result = { fixture: path.basename(root), independentNativePositive: receipts.some(row => row.url === "/independent/logs"),
    actualNativeRefresh: refreshes === 1, modelRequests: receipts.filter(row => row.url === "/responses").length,
    providerCollectorRequestsAfterLiveEdit: receipts.filter(row => row.url === "/provider/logs").length,
    disableExporters, artifactSet,
    nativeExporterReloadObserved: stderr.join("").includes("reloaded telemetry exporters after account change"),
    completedOrdinaryTools: messages.filter(message => message.method === "item/completed" && message.params.item.type === "commandExecution"
      && message.params.item.exitCode === 0).length };
  fs.writeFileSync(path.join(root, "result.private.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.ok(result.nativeExporterReloadObserved, "native emitted an exporter reload event after the actual refresh");
  assert.equal(result.providerCollectorRequestsAfterLiveEdit, 0, "A live settings/auth reload must not enable provider collection");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await done;
  }
  if (invocation) await invocation.close();
  fs.writeFileSync(path.join(root, "requests.private.json"), JSON.stringify(receipts, null, 2));
  fs.writeFileSync(path.join(root, "rpc.private.json"), JSON.stringify(messages, null, 2));
  fs.writeFileSync(path.join(root, "stderr.private.txt"), stderr.join(""));
  api.closeAllConnections(); collector.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => collector.close(resolve))]);
}
