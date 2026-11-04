#!/usr/bin/env node
// Exact official client, synthetic model server, and synthetic account only.
// This fixture cannot run outside the offsite host's loopback-only namespace.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
assert.equal(process.platform, "linux");
assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "exec-"));
const privateFile = path.join(root, "ordinary-tool-input.txt");
const canary = "SYNTHETIC_ORDINARY_TOOL_ACCESS";
fs.writeFileSync(privateFile, canary, { mode: 0o600 });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const toolScript = `import json,os,pathlib,platform,subprocess; print(json.dumps({"canary":pathlib.Path(${JSON.stringify(privateFile)}).read_text(),"release":platform.release(),"lsb":subprocess.check_output(["lsb_release","-rs"],text=True).strip(),"sdk_key":os.environ["OPENAI_API_KEY"]})); pathlib.Path("tool-output.txt").write_text("tool write succeeded")`;
const command = "/usr/bin/python3 -c " + shellQuote(toolScript);
const created = id => ({ type: "response.created", response: { id } });
const completed = id => ({ type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const done = item => ({ type: "response.output_item.done", item });

async function run(protectedLaunch, alias = false) {
  const name = (protectedLaunch ? "protected" : "control") + (alias ? "-alias" : "");
  const homeDir = path.join(root, name, "home"), cwd = path.join(root, name, "project");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true, mode: 0o700 }); fs.mkdirSync(cwd);
  const requests = [], errors = [], output = [];
  let serverError;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"models":[]}'); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      else if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes.toString());
      requests.push({ headers: req.headers, url: req.url, body });
      assert.equal(req.url, "/responses");
      const number = requests.length;
      assert.ok(number <= 2, "Unexpected model retry or extra turn");
      const items = number === 1 ? [done({ type: "function_call", call_id: "synthetic-call", name: "exec_command",
        arguments: JSON.stringify({ cmd: command, yield_time_ms: 1000, max_output_tokens: 500 }) })]
        : [done({ type: "message", role: "assistant", id: "synthetic-message", content: [{ type: "output_text", text: "Synthetic task complete." }] })];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end([created(`synthetic-${number}`), ...items, completed(`synthetic-${number}`)]
        .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      serverError = new Error(`Synthetic ${req.method} ${req.url}: ${error.message}`);
      res.writeHead(500); res.end("synthetic fixture error");
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), `model="gpt-5.4"\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\nunified_exec=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(address)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color",
    OPENAI_API_KEY: "SYNTHETIC_INDEPENDENT_SDK_KEY" };
  if (alias) {
    const bin = path.join(homeDir, "bin"), libexec = path.join(homeDir, "libexec");
    fs.mkdirSync(bin); fs.mkdirSync(libexec);
    fs.copyFileSync("/usr/bin/lsb_release", path.join(libexec, "distribution-info"));
    fs.chmodSync(path.join(libexec, "distribution-info"), 0o700);
    fs.symlinkSync(path.join(libexec, "distribution-info"), path.join(bin, "lsb_release"));
    env.PATH = bin + ":" + env.PATH;
  }
  const environment = readCodexEnvironment(), accountId = `synthetic-${name}`;
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": {
    chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user",
  } };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const options = { homeDir, env, environment, accountId, label: name };
  saveLocalCodexLogin(options, { access: token, idToken: token, refresh: "SYNTHETIC_REFRESH", accountId });
  const prepared = prepareCodexAccountState(options);
  const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Perform the synthetic tool check."];
  let invocation, child, timer;
  try {
    invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin", "codex"), homeDir, cwd, env, args });
    child = spawn(protectedLaunch ? invocation.command : path.join(base, "bin", "codex"), protectedLaunch ? invocation.args : args, {
      cwd: invocation.cwd, env: protectedLaunch ? invocation.env : invocation.environment, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...(protectedLaunch ? [invocation.environmentFd] : [])] });
    invocation.closeEnvironment?.();
    child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 40_000);
    const [code, signal] = await once(child, "close");
    clearTimeout(timer);
    fs.writeFileSync(path.join(root, `${name}-requests.json`), JSON.stringify(requests, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stdout.log`), Buffer.concat(output), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stderr.log`), Buffer.concat(errors), { mode: 0o600 });
    if (serverError) throw serverError;
    assert.equal(code, 0, `${name} exit=${code}, signal=${signal}; private evidence ${root}`);
    assert.equal(requests.length, 2);
    const toolOutput = requests[1].body.input.filter(item => item.type === "function_call_output");
    assert.match(JSON.stringify(toolOutput), new RegExp(canary));
    assert.ok(JSON.stringify(toolOutput).includes(env.OPENAI_API_KEY), "ordinary SDK tools retain their key");
    assert.ok(JSON.stringify(toolOutput).includes(os.release()), "ordinary tool retains actual uname");
    assert.equal(fs.readFileSync(path.join(cwd, "tool-output.txt"), "utf8"), "tool write succeeded");
    return { name, modelRequests: requests.length, ordinaryFileAccess: true, ordinaryUname: true, ordinarySdkKey: true,
      userAgent: requests[0].headers["user-agent"] };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await invocation?.close?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

try {
  const control = await run(false), controlAlias = await run(false, true), protectedResult = await run(true), alias = await run(true, true);
  const osLabel = agent => agent?.match(/\(([^;]+);/)?.[1];
  assert.match(osLabel(control.userAgent), /\d+\.\d+/, "control observes the distribution version");
  assert.match(osLabel(controlAlias.userAgent), /\d+\.\d+/, "the unprotected alias remains a working version probe");
  assert.doesNotMatch(osLabel(protectedResult.userAgent), /\d+\.\d+/, "vendor header excludes the distribution version");
  assert.doesNotMatch(osLabel(alias.userAgent), /\d+\.\d+/, "a PATH alias cannot disclose the distribution version");
  process.stdout.write(JSON.stringify({ fixture: root, control: { ...control, userAgent: undefined },
    controlAlias: { ...controlAlias, userAgent: undefined },
    protected: { ...protectedResult, userAgent: undefined }, alias: { ...alias, userAgent: undefined }, vendorReleaseRemoved: true }) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
