#!/usr/bin/env node
// Case 7: actual on-demand native stdio MCP and ordinary PATH/config CLI calls.
// All credentials/services are synthetic and terminate on loopback. Native HTTP
// OAuth/keyring coverage lives in privacy-codex-native-mcp --workload-calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";

assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST") && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync("/opt/aimgr-state-audit/codex-m1-fixtures/workload-credentials-");
const put = (file, value, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); };
const q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const results = [];
console.log(JSON.stringify({ fixture: root, case: 7 }));
for (const protectedLaunch of [false, true]) {
  const name = protectedLaunch ? "protected" : "stock";
  const homeDir = path.join(root, name), cwd = path.join(homeDir, "workspace/project"), shared = path.join(homeDir, ".codex");
  for (const directory of [cwd, shared]) fs.mkdirSync(directory, { recursive: true });
  const canary = "SYNTHETIC_TOOL_AUTH_" + createHash("sha256").update(homeDir).digest("hex").slice(0, 20);
  const credentials = path.join(homeDir, ".config/workload-sdk/credentials.json"), started = path.join(homeDir, "tool-runtime/started.jsonl");
  const cli = path.join(homeDir, "bin/workload-cli"), stdio = path.join(homeDir, "tool-runtime/stdio.mjs");
  const requests = [], modelRequests = [], tools = [], outputs = [], stdout = [], stderr = [];
  let generation = 0, step = 0, refreshes = 0, error, child, invocation, timer;
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      if (req.url === "/whoami" || req.url === "/denied") {
        assert.equal(req.headers.authorization, "Bearer " + canary + "_" + generation);
        requests.push(req.url); json(req.url === "/denied" ? 403 : 200,
          req.url === "/denied" ? { error: "SYNTHETIC_SERVICE_DENIAL" } : { identity: "SYNTHETIC_CLI_IDENTITY" }); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      if (req.url === "/refresh") {
        const body = JSON.parse(bytes); requests.push("refresh");
        if (body.refresh !== canary + "_refresh_" + generation) { json(400, { error: "invalid_grant" }); return; }
        generation++; refreshes++; json(200, { access: canary + "_" + generation, refresh: canary + "_refresh_" + generation, expires: Date.now() + 3600000 }); return;
      }
      if (req.method === "GET") { json(200, { models: [] }); return; }
      const body = JSON.parse(bytes); modelRequests.push(body);
      for (const item of body.input ?? []) if (item.type === "function_call_output") outputs.push(item.output);
      let item;
      if ([0, 2].includes(step)) {
        const suffix = step === 0 ? "whoami" : "denied";
        const namespace = body.tools.find(tool => tool.type === "namespace" && tool.name?.startsWith("mcp__") && tool.tools?.some(tool => tool.name === suffix));
        const tool = namespace?.tools.find(tool => tool.name === suffix) ?? body.tools.find(tool => tool.name?.endsWith("__" + suffix));
        assert.ok(tool, "native discovers stdio MCP tool"); tools.push(tool.name);
        item = { type: "function_call", name: tool.name, ...(namespace ? { namespace: namespace.name } : {}), call_id: "stdio-" + suffix, arguments: "{}" };
      } else if ([1, 3, 5].includes(step)) {
        const commands = { 1: "workload-cli whoami", 3: "set -eu\nworkload-cli expire\nworkload-cli whoami\nset +e\nworkload-cli denied\nr=$?\n[ $r -eq 7 ] || exit 9\nprintf 'CLI_DENIAL_REPORTED\\n'",
          5: "set -eu\nworkload-cli whoami\nworkload-cli revoke\nset +e\nworkload-cli whoami\nr=$?\n[ $r -eq 2 ] || exit 9\nprintf 'EXPIRED_GRANT_REPORTED\\n'" };
        item = { type: "function_call", name: "exec_command", call_id: "ordinary-cli-" + step,
          arguments: JSON.stringify({ cmd: commands[step], login: false, max_output_tokens: 1000, yield_time_ms: 1000 }) };
      } else item = { type: "message", role: "assistant", id: "done-" + step, content: [{ type: "output_text", text: "Synthetic integration sequence complete." }] };
      assert.ok(step < 7); step++;
      const id = "integration-" + name + "-" + step;
      const events = [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (caught) { error ??= caught; json(500, { error: "synthetic integration failure" }); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  put(credentials, JSON.stringify({ access: canary + "_0", refresh: canary + "_refresh_0", expires: Date.now() + 3600000 }));
  put(cli, `#!${process.execPath}
const fs=require('fs'),path=require('path');
const f=path.join(process.env.HOME,'.config/workload-sdk/credentials.json');
(async()=>{let c=JSON.parse(fs.readFileSync(f));const command=process.argv[2];
if(command==='expire'||command==='revoke'){c.expires=0;if(command==='revoke')c.refresh='SYNTHETIC_EXPIRED_GRANT';fs.writeFileSync(f,JSON.stringify(c));return;}
if(c.expires<Date.now()){const r=await fetch(${JSON.stringify(endpoint + "/refresh")},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refresh:c.refresh})});if(!r.ok){console.log('SYNTHETIC_AUTH_DENIAL');process.exitCode=2;return;}c=await r.json();fs.writeFileSync(f,JSON.stringify(c));}
const r=await fetch(${JSON.stringify(endpoint)}+'/'+command,{headers:{Authorization:'Bearer '+c.access}});const body=await r.json();console.log(JSON.stringify(body));if(!r.ok)process.exitCode=7;
})().catch(()=>{console.log('SYNTHETIC_CLI_FAILURE');process.exitCode=8;});
`, 0o700);
  put(stdio, `import fs from 'node:fs';import readline from 'node:readline';
if(process.env.SYNTHETIC_STDIO_ENV!==${JSON.stringify(canary)})throw Error('missing canary');
fs.appendFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid,canaryAccepted:true})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result;
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-stdio',version:'1'}};
else if(m.method==='tools/list')result={tools:['whoami','denied'].map(name=>({name,description:'Synthetic '+name,inputSchema:{type:'object',properties:{}}}))};
else if(m.method==='tools/call')result={isError:m.params.name==='denied',content:[{type:'text',text:m.params.name==='whoami'?'SYNTHETIC_STDIO_IDENTITY':'SYNTHETIC_STDIO_DENIAL'}]};
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}
`);
  const config = `model="gpt-5.4"\nmodel_provider="fixture"\nmcp_oauth_credentials_store="keyring"\n[features]\napps=false\ncode_mode=false\n[mcp_servers.workload_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(stdio)}]\nenv_vars=["SYNTHETIC_STDIO_ENV"]\nrequired=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(endpoint)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`;
  put(path.join(shared, "config.toml"), config);
  const env = { HOME: homeDir, CODEX_HOME: shared, PATH: path.dirname(cli) + ":" + path.dirname(process.execPath) + ":/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color", SYNTHETIC_STDIO_ENV: canary };
  async function run(args) {
    if (protectedLaunch) {
      const prepared = { ...prepareCodexAccountState({ homeDir, env, environment: readCodexEnvironment(), accountId: "api-provider:deepseek", label: "fixture" }), keyBacked: true };
      invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, env, args });
    }
    child = spawn(invocation?.command ?? "/opt/aimgr-state-audit/bin/codex", invocation?.args ?? args,
      { cwd, env: invocation?.env ?? env, stdio: ["ignore", "pipe", "pipe", ...(invocation ? [invocation.environmentFd] : [])], detached: true });
    invocation?.closeEnvironment(); child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 45000);
    const [code, signal] = await once(child, "close"); clearTimeout(timer); if (error) throw error;
    assert.equal(code, 0, `${name} exit ${code}/${signal}; ${root}`); await invocation?.close(); invocation = undefined;
  }
  try {
    assert.ok(!fs.existsSync(started), "MCP server is started on demand by native client");
    await run(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Run synthetic integration checks."]);
    const thread = Buffer.concat(stdout).toString().split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.type === "thread.started")?.thread_id;
    assert.ok(thread); await run(["exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", thread, "Check native integration continuity and expired grant."]);
    const outputText = JSON.stringify(outputs); for (const marker of ["SYNTHETIC_STDIO_IDENTITY", "SYNTHETIC_STDIO_DENIAL", "SYNTHETIC_CLI_IDENTITY", "CLI_DENIAL_REPORTED", "EXPIRED_GRANT_REPORTED"]) assert.match(outputText, new RegExp(marker));
    assert.equal(refreshes, 1); assert.equal(requests.filter(x => x === "/whoami").length, 3);
    assert.ok(!JSON.stringify(modelRequests).includes(canary), "tool credential not returned to model");
    assert.ok(!fs.existsSync(path.join(shared, ".credentials.json")), "empty native MCP setup creates no File fallback");
    const launches = fs.readFileSync(started, "utf8").trim().split("\n").map(JSON.parse); assert.equal(launches.length, 2);
    for (const launch of launches) assert.throws(() => process.kill(launch.pid, 0), "owned stdio process exits with native client");
    const row = { launch: name, nativeStdioOnDemand: true, laterSameThreadInvocation: true, cliPathConfigCredential: true,
      cliRefreshPersisted: true, serviceDenialReported: true, expiredGrantReported: true, emptyNativeStoreWithoutFileFallback: true,
      ...(process.platform === "linux" ? { nativeToolEnvironmentWithoutDbusAddress: true } : {}),
      stdioProcessesCleaned: launches.length, model: "synthetic endpoint", actualServiceCredential: "not run" };
    results.push(row); console.log(JSON.stringify(row));
  } finally {
    clearTimeout(timer); if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await invocation?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    put(path.join(root, name + "-stdout.log"), Buffer.concat(stdout)); put(path.join(root, name + "-stderr.log"), Buffer.concat(stderr));
    put(path.join(root, name + "-requests.json"), JSON.stringify(modelRequests, null, 2)); put(path.join(root, name + "-tool-results.json"), JSON.stringify(outputs, null, 2));
    put(path.join(root, name + "-service-receipt.json"), JSON.stringify({ requests, refreshes, tools }, null, 2));
  }
}
put(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ fixture: root, results }));
