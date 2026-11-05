#!/usr/bin/env node
// Actual OS occurrences, production AIM selection/worker/receipts and official
// Codex. Only usage/model services and Herdr's window UI are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import https from "node:https";
import zlib from "node:zlib";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../src/coordination/redis-store.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { buildRoutineFireKey } from "../src/routines/schedule.js";

assert.ok(["linux", "darwin"].includes(process.platform));
assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST") && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.realpathSync(process.argv[2]);
assert.ok(root.startsWith("/opt/aimgr-state-audit/")); assert.equal(fs.readdirSync(root).length, 0);
const homeDir = path.join(root, "home"), cwd = path.join(root, "project"), bin = path.join(root, "bin");
for (const dir of [path.join(homeDir, ".codex"), cwd, bin]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const exec = promisify(execFile), q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const main = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const terminal = fileURLToPath(new URL("./privacy-test-pty.py", import.meta.url));
const accounts = ["a", "b"].map(letter => {
  const accountId = "synthetic-routine-account-" + letter, label = "synthetic-routine-" + letter;
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
  return { accountId, label, token: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` };
});
const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem"), ca = path.join(root, "ca.pem");
fs.writeFileSync(path.join(root, "ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic routine authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n");
fs.writeFileSync(path.join(root, "cert.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
for (const args of [
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", path.join(root, "ca.cnf"), "-keyout", path.join(root, "ca.key"), "-out", ca],
  ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", path.join(root, "cert.csr")],
  ["x509", "-req", "-in", path.join(root, "cert.csr"), "-CA", ca, "-CAkey", path.join(root, "ca.key"), "-set_serial", "1", "-days", "1", "-extfile", path.join(root, "cert.ext"), "-out", cert],
]) execFileSync("openssl", args, { stdio: "ignore" });
const requests = [], threadCounts = new Map(), drivers = [], units = [];
let serverError, firstRequest = false, releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
const frames = async (request, body) => {
  const response = { id: "synthetic-response-" + requests.length, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [{ type: "response.created", response }];
  if (body.generate !== false && body.text?.format?.name !== "codex_output_schema") {
    const selected = accounts.find(account => account.accountId === request.headers["chatgpt-account-id"]);
    assert.ok(selected, "request uses a locally provisioned account");
    assert.equal(request.headers.authorization, "Bearer " + selected.token);
    assert.equal(body.client_metadata["x-codex-installation-id"], selected.prepared.installationId);
    assert.equal(JSON.parse(body.client_metadata["x-codex-turn-metadata"]).installation_id, selected.prepared.installationId);
    const thread = body.client_metadata.session_id;
    assert.match(thread, /^[a-f0-9-]{36}$/);
    assert.equal(body.client_metadata.thread_id, thread);
    assert.equal(request.headers["session-id"], thread);
    assert.equal(request.headers["thread-id"], thread);
    const count = threadCounts.get(thread) ?? 0; threadCounts.set(thread, count + 1);
    requests.push({ url: request.url, headers: request.headers, body, thread, count });
    if (!firstRequest) { firstRequest = true; await firstGate; }
    assert.ok(count < 2, "each scheduled task has exactly one tool call and its result");
    const item = count === 0 ? { type: "function_call", name: "exec_command", call_id: "routine-tool",
      arguments: JSON.stringify({ cmd: "printf 'SYNTHETIC_ROUTINE_TOOL\\n' >> " + q(path.join(cwd, "proof.txt")), login: false, max_output_tokens: 100 }) }
      : { type: "message", role: "assistant", id: "routine-result", content: [{ type: "output_text", text: "Synthetic routine complete.\nAIM-JOB: done" }] };
    events.push({ type: "response.output_item.done", item });
  }
  events.push({ type: "response.completed", response }); return events;
};
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (req.method === "POST" && req.url === "/responses") {
      const events = await frames(req, body); res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/models") ? { models: [] }
      : req.url === "/api/codex/accounts/check" ? { accounts: accounts.map(account => ({ id: account.accountId, plan_type: "plus", structure: "personal",
        workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" })), account_ordering: accounts.map(account => account.accountId), default_account_id: accounts[0].accountId } : {}));
  } catch (error) { serverError ??= error; res.writeHead(500); res.end("synthetic fixture failure"); }
});
const ws = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head, client => {
  client.on("message", async bytes => {
    try { for (const event of await frames(req, JSON.parse(bytes.toString()))) client.send(JSON.stringify(event)); }
    catch (error) { serverError ??= error; client.close(); }
  });
}));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const endpoint = `https://127.0.0.1:${server.address().port}`;
const config = `model="gpt-6.1-sol"\nopenai_base_url=${JSON.stringify(endpoint)}\nchatgpt_base_url=${JSON.stringify(endpoint)}\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\napps=false\ncode_mode=false\nhooks=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n`;
for (const name of ["config.toml", "yolo.config.toml"]) fs.writeFileSync(path.join(homeDir, ".codex", name), config);
const env = { HOME: homeDir, PATH: `${bin}:/opt/aimgr-state-audit/bin:/usr/local/bin:/usr/bin:/bin`,
  LANG: "C.UTF-8", TERM: "xterm-256color", CODEX_CA_CERTIFICATE: ca };
const environment = readCodexEnvironment();
for (const account of accounts) {
  const { accountId, label, token } = account;
  saveLocalCodexLogin({ homeDir, env, environment, accountId, label }, { access: token, idToken: token, refresh: "SYNTHETIC_ROUTINE_REFRESH_" + label, accountId });
  account.prepared = prepareCodexAccountState({ homeDir, env, environment, accountId, label });
}
const redisLog = fs.openSync(path.join(root, "redis.private.log"), "w", 0o600);
const redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", "6381", "--save", "", "--appendonly", "no", "--dir", root],
  { cwd: root, env, stdio: ["ignore", redisLog, redisLog] }); fs.closeSync(redisLog);
const waitFor = async (test, reason, timeout = 90_000) => {
  const until = Date.now() + timeout;
  while (!await test()) {
    if (serverError) throw serverError;
    if (Date.now() > until) throw Error("Timed out: " + reason);
    await delay(50);
  }
};
await waitFor(() => fs.readFileSync(path.join(root, "redis.private.log"), "utf8").includes("Ready to accept connections"), "private Redis");
const redisUrl = "redis://127.0.0.1:6381", keyPrefix = "aimgr:routine-synthetic:";
const store = await connectRedisStore({ url: redisUrl, keyPrefix, connectionPolicy: "leased" });
await importCredentialsSnapshot(store, { credentials: accounts.map(({ accountId, label }) => ({ provider: "openai-codex", label, identity: { accountId },
  credential: { access: "SYNTHETIC_FOREIGN_ACCESS", refresh: "SYNTHETIC_FOREIGN_REFRESH", accountId },
  policy: { pool: { enabled: true } }, health: { status: "ready", reason: null } })) }, { updatedBy: "synthetic", observedAt: new Date().toISOString() });
const wrapper = path.join(root, "aim.mjs");
fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import fs from 'node:fs';import {main} from ${JSON.stringify(main)};
assert.equal(process.env.HOME,${JSON.stringify(homeDir)});
fs.appendFileSync(${JSON.stringify(path.join(root, "cli.private.jsonl"))},JSON.stringify({argv:process.argv.slice(2),time:Date.now()})+'\\n');
await main(process.argv.slice(2),{fetchJsonWithTimeoutImpl:async(url,request)=>{
assert.equal(url,'https://chatgpt.com/backend-api/wham/usage');
const tokens=${JSON.stringify(Object.fromEntries(accounts.map(account => [account.accountId, account.token])))};
assert.ok(tokens[request.headers['ChatGPT-Account-Id']]);assert.equal(request.headers.Authorization,'Bearer '+tokens[request.headers['ChatGPT-Account-Id']]);
return {ok:true,status:200,json:async()=>({plan_type:'plus',rate_limit:{allowed:true,primary_window:{used_percent:1,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+3600}}})};}});
`);
const aim = path.join(bin, "aim"); fs.writeFileSync(aim, `#!/bin/sh\nexec ${q(process.execPath)} ${q(wrapper)} "$@"\n`, { mode: 0o700 });
const socket = path.join(root, "ui.sock"), failure = path.join(root, "fail-ui");
const uiScript = path.join(root, "ui.mjs"), session = "synthetic-routine-session";
fs.writeFileSync(uiScript, `import fs from 'node:fs';import net from 'node:net';const a=process.argv.slice(2);let result;
if(a.includes('workspace')&&a.includes('list'))result={type:'workspace_list',workspaces:[{workspace_id:'prior',focused:true}]};
else if(a.includes('workspace')&&a.includes('create')){if(fs.existsSync(${JSON.stringify(failure)}))throw Error('Synthetic unavailable UI');result={type:'workspace_created',workspace:{workspace_id:'w',label:a[a.indexOf('--label')+1],focused:false},tab:{tab_id:'t',workspace_id:'w'},root_pane:{pane_id:'p',tab_id:'t',workspace_id:'w',cwd:${JSON.stringify(cwd)},focused:false}};}
else if(a[0]==='session'&&a[1]==='list'){console.log(JSON.stringify({sessions:[{name:${JSON.stringify(session)},running:true,socket_path:${JSON.stringify(socket)}}]}));process.exit(0);}
else if(a.includes('pane')&&a.includes('run')){await new Promise((resolve,reject)=>{const c=net.createConnection(${JSON.stringify(socket)});c.on('connect',()=>c.write(JSON.stringify({method:'test.pane.run',command:a.at(-1)})+'\\n'));c.on('error',reject);c.on('data',()=>{});c.on('end',resolve);});result={type:'ok'};}
else throw Error('Unexpected synthetic UI request: '+a.join(' '));console.log(JSON.stringify({result}));
`);
fs.writeFileSync(path.join(bin, "herdr"), `#!/bin/sh\nexec ${q(process.execPath)} ${q(uiScript)} "$@"\n`, { mode: 0o700 });
const ui = net.createServer(connection => {
  let text = ""; connection.on("data", bytes => {
    text += bytes; if (!text.includes("\n")) return;
    const request = JSON.parse(text.split("\n")[0]);
    if (request.method === "workspace.move") {
      connection.end(JSON.stringify({ id: request.id, result: { type: "workspace_list", workspaces: [{ workspace_id: "w" }] } }) + "\n"); return;
    }
    assert.equal(request.method, "test.pane.run"); assert.ok(request.command.includes("'routine' '__execute'"));
    const pane = path.join(root, "pane-" + drivers.length); fs.mkdirSync(pane);
    const info = path.join(pane, "terminal-info.json");
    fs.writeFileSync(info, JSON.stringify({ root: pane, cwd, argv: ["/bin/sh", "-c", request.command], env: { HERDR_SESSION: session, HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: "p" } }));
    const log = fs.openSync(path.join(pane, "driver.private.log"), "w", 0o600);
    const child = spawn("/usr/bin/python3", ["-I", terminal, info], { cwd, env, detached: true, stdio: ["ignore", log, log] });
    fs.closeSync(log); drivers.push({ child, pane }); connection.end('{"result":"started"}\n');
  });
});
ui.listen(socket); await once(ui, "listening");
const id = "synthetic-codex-" + process.pid;
const target = new Date(Math.ceil((Date.now() + 15_000) / 60_000) * 60_000);
const times = [0, 60_000, 120_000].map(offset => new Date(target.getTime() + offset));
const promptFile = path.join(cwd, "prompt.md"); fs.writeFileSync(promptFile, "Run the synthetic routine tool exactly once, then finish.\n");
const routine = { id, agent: "codex", provider: "openai-codex", model: "gpt-6.1-sol", thinking: "xhigh", profile: "yolo",
  calendar: times.map(date => ({ hour: date.getHours(), minute: date.getMinutes() })), cwd, promptFile, herdrSession: session, spaceTitleFormat: "Synthetic {scheduled_local}" };
writeAimgrConfig({ homeDir, config: { redis: { url: redisUrl, keyPrefix }, routines: { [id]: routine } } });
const receiptFile = date => path.join(homeDir, ".aimgr/routine-runs", buildRoutineFireKey(id, date) + ".json");
const receipt = date => fs.existsSync(receiptFile(date)) ? JSON.parse(fs.readFileSync(receiptFile(date))) : null;
const system = async (...args) => exec("sudo", ["-n", ...args], { maxBuffer: 1024 * 1024 });
const startTimer = async interval => {
  const unit = id + (interval ? "-interval" : "-calendar"); units.push(unit);
  if (process.platform === "darwin") {
    const plist = { Label: unit, ProgramArguments: [aim, "routine", "run", id, "--json"],
      UserName: os.userInfo().username, WorkingDirectory: cwd, EnvironmentVariables: env,
      StandardOutPath: path.join(root, "scheduler.private.out"), StandardErrorPath: path.join(root, "scheduler.private.err"),
      ThrottleInterval: 1, ...(interval ? { RunAtLoad: true, StartInterval: 3 }
        : { StartCalendarInterval: { Month: target.getMonth() + 1, Day: target.getDate(), Hour: target.getHours(), Minute: target.getMinutes() } }) };
    execFileSync("/usr/bin/python3", ["-I", "-c", "import json,plistlib,sys;from pathlib import Path;Path(sys.argv[1]).write_bytes(plistlib.dumps(json.load(sys.stdin)))", path.join(root, unit + ".plist")],
      { input: JSON.stringify(plist), stdio: ["pipe", "ignore", "pipe"] });
    await system("chown", "root:wheel", path.join(root, unit + ".plist"));
    await system("chmod", "644", path.join(root, unit + ".plist"));
    await system("launchctl", "bootstrap", "system", path.join(root, unit + ".plist"));
    return unit;
  }
  await system("systemd-run", "--unit=" + unit,
    ...(interval ? ["--on-active=1s", "--on-unit-inactive=3s"] : ["--on-calendar=" + target.toISOString().replace("T", " ").replace(".000Z", " UTC")]),
    "--timer-property=AccuracySec=100ms", "--timer-property=RandomizedDelaySec=0", "--uid=aimdev", "--gid=aimdev",
    "--property=NetworkNamespacePath=/proc/" + process.pid + "/ns/net", "--property=WorkingDirectory=" + cwd,
    "--property=StandardOutput=append:" + root + "/scheduler.private.out", "--property=StandardError=append:" + root + "/scheduler.private.err",
    ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`), aim, "routine", "run", id, "--json");
  return unit;
};
const stopTimer = unit => process.platform === "darwin"
  ? system("launchctl", "bootout", "system/" + unit)
  : system("systemctl", "stop", unit + ".timer", unit + ".service");
const restartTimer = async unit => {
  if (process.platform !== "darwin") return system("systemctl", "restart", unit + ".timer");
  await stopTimer(unit);
  await system("launchctl", "bootstrap", "system", path.join(root, unit + ".plist"));
};
const closePane = async index => {
  const { pane, child } = drivers[index];
  // Wait for the real TUI prompt, then send its ordinary exit command.
  await waitFor(() => {
    const log = path.join(pane, "terminal.private.log");
    if (!fs.existsSync(log)) return false;
    const text = fs.readFileSync(log, "utf8");
    return text.includes("state=idle:app=codex") && text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s/g, "").includes("AIM-JOB:done");
  }, "native handoff screen");
  fs.appendFileSync(path.join(pane, "terminal-input.jsonl"), JSON.stringify({ raw: "\u0003" }) + "\n");
  await waitFor(() => child.exitCode !== null, "native handoff exit");
  assert.equal(JSON.parse(fs.readFileSync(path.join(pane, "pty-exit.json"))).exit, 0);
};
try {
  await startTimer(false); await waitFor(() => firstRequest, "calendar-triggered model turn", target.getTime() - Date.now() + 60_000);
  const overlap = await exec(process.execPath, [wrapper, "routine", "run", id, "--manual", "--json"], { cwd, env });
  assert.equal(JSON.parse(overlap.stdout).outcome, "overlap"); releaseFirst();
  await waitFor(() => receipt(times[0])?.interactiveTui?.status === "live", "calendar completion and same-thread handoff");
  assert.equal(receipt(times[0]).manual, false); assert.ok(receipt(times[0]).prompt.admittedAt);
  assert.equal(receipt(times[0]).codex.sessionId, receipt(times[0]).interactiveTui.sessionId);
  assert.ok(accounts.some(account => account.accountId === receipt(times[0]).selectedAccount.accountId));
  await closePane(0);
  fs.writeFileSync(failure, "synthetic before-prompt failure\n");
  const interval = await startTimer(true);
  await waitFor(() => receipt(times[1])?.outcome === "failed_before_prompt", "failed interval occurrence", times[1].getTime() - Date.now() + 30_000);
  const failed = fs.readFileSync(receiptFile(times[1])); const requestCount = requests.length;
  const calls = () => fs.readFileSync(path.join(root, "cli.private.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    .filter(row => row.argv[0] === "routine" && row.argv[1] === "run" && !row.argv.includes("--manual")).length;
  const beforeRestart = calls(); await restartTimer(interval);
  await waitFor(() => calls() >= beforeRestart + 2, "actual interval firings after timer restart");
  assert.deepEqual(fs.readFileSync(receiptFile(times[1])), failed); assert.equal(requests.length, requestCount);
  fs.unlinkSync(failure);
  await waitFor(() => receipt(times[2])?.interactiveTui?.status === "live", "next distinct interval occurrence succeeds", times[2].getTime() - Date.now() + 60_000);
  await closePane(1);
  assert.equal(requests.length, 4); assert.deepEqual([...threadCounts.values()], [2, 2]);
  assert.equal(fs.readFileSync(path.join(cwd, "proof.txt"), "utf8"), "SYNTHETIC_ROUTINE_TOOL\n".repeat(2));
  for (const date of [times[0], times[2]]) {
    const row = receipt(date); assert.equal(row.outcome, "completed"); assert.equal(row.needsAttention, false);
    assert.equal(row.interactiveTui.status, "exited"); assert.equal(row.interactiveTui.exitCode, 0);
  }
  assert.notEqual(receipt(times[0]).selectedAccount.accountId, receipt(times[2]).selectedAccount.accountId);
  for (const { label, token } of accounts) {
    const shared = await store.client.get(store.keys.credential({ provider: "openai-codex", label }));
    assert.ok(!shared.includes(token));
  }
  const result = { passed: true, actualCalendar: true, actualInterval: true, actualRedis: true,
    ordinaryToolRuns: 2, sameThreadHandoff: true, overlapSuppressed: true, failedOccurrenceNotReplayedAfterRestart: true,
    localAuthOnly: true, subsequentDistinctOccurrenceSucceeded: true };
  fs.writeFileSync(path.join(root, "result.private.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ fixture: root, ...result }));
} finally {
  releaseFirst();
  const cleanupErrors = [];
  for (const unit of units) await stopTimer(unit).catch(error => cleanupErrors.push(error));
  for (const { child } of drivers) if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "close"); }
  if (store.client.isOpen) await store.client.quit();
  redis.kill("SIGTERM"); await once(redis, "close");
  for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => ui.close(resolve))]);
  fs.writeFileSync(path.join(root, "model.private.json"), JSON.stringify(requests, null, 2));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Failed to unload fixture schedules");
}
