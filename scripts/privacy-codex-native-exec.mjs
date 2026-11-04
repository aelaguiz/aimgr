#!/usr/bin/env node
// Exact official client, synthetic model server, and synthetic account only.
// This fixture cannot run outside the offsite host's loopback-only namespace.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
assert.equal(process.platform, "linux");
assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "exec-"));
const certificate = path.join(root, "loopback-cert.pem"), certificateKey = path.join(root, "loopback-key.pem");
const authority = path.join(root, "authority.pem"), authorityKey = path.join(root, "authority-key.pem");
const requestFile = path.join(root, "loopback.csr"), extensions = path.join(root, "loopback.ext");
const openssl = args => execFileSync("openssl", args, { stdio: "ignore" });
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Synthetic AIM test authority",
  "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", authorityKey, "-out", authority]);
openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
  "-keyout", certificateKey, "-out", requestFile]);
fs.writeFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
openssl(["x509", "-req", "-in", requestFile, "-CA", authority, "-CAkey", authorityKey, "-set_serial", "1",
  "-days", "1", "-extfile", extensions, "-out", certificate]);
openssl(["verify", "-CAfile", authority, "-purpose", "sslserver", "-verify_ip", "127.0.0.1", certificate]);
const privateFile = path.join(root, "ordinary-tool-input.txt");
const canary = "SYNTHETIC_ORDINARY_TOOL_ACCESS";
fs.writeFileSync(privateFile, canary, { mode: 0o600 });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const toolScript = `import json,os,pathlib,platform,subprocess; print(json.dumps({"canary":pathlib.Path(${JSON.stringify(privateFile)}).read_text(),"release":platform.release(),"lsb":subprocess.check_output(["lsb_release","-rs"],text=True).strip(),"sdk_key":os.environ["OPENAI_API_KEY"]})); pathlib.Path("tool-output.txt").write_text("tool write succeeded")`;
const command = "/usr/bin/python3 -c " + shellQuote(toolScript);
const created = id => ({ type: "response.created", response: { id } });
const completed = id => ({ type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const done = item => ({ type: "response.output_item.done", item });

async function run(protectedLaunch, alias = false, builtin = null) {
  const name = (protectedLaunch ? "protected" : "control") + (alias ? "-alias" : "") + (builtin ? "-builtin-" + builtin : "");
  const homeDir = path.join(root, name, "home"), cwd = path.join(root, name, "project");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true, mode: 0o700 }); fs.mkdirSync(cwd);
  const requests = [], errors = [], output = [], metadataRequests = [];
  let serverError, refreshes = 0, rejectedInitialAuth = false;
  const frames = (req, body, transport) => {
    if (body.generate === false) return [created("synthetic-prewarm"), completed("synthetic-prewarm")];
    requests.push({ headers: req.headers, url: req.url, body, transport });
    assert.equal(req.url, "/responses");
    const number = requests.length;
    assert.ok(number <= 2, "Unexpected model retry or extra turn");
    const items = number === 1 ? [done({ type: "function_call", call_id: "synthetic-call", name: "exec_command",
      arguments: JSON.stringify({ cmd: command, yield_time_ms: 1000, max_output_tokens: 500 }) })]
      : [done({ type: "message", role: "assistant", id: "synthetic-message", content: [{ type: "output_text", text: "Synthetic task complete." }] })];
    return [created(`synthetic-${number}`), ...items, completed(`synthetic-${number}`)];
  };
  const handler = async (req, res) => {
    try {
      if (req.method === "GET") metadataRequests.push({ url: req.url, headers: req.headers });
      if (req.method === "GET" && req.url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"models":[]}'); return;
      }
      if (req.method === "GET" && req.url === "/api/codex/settings/user") {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{}'); return;
      }
      if (req.method === "GET" && req.url === "/api/codex/accounts/check") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accounts: [{ id: accountId, plan_type: "plus", structure: "personal",
          workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }],
          account_ordering: [accountId], default_account_id: accountId })); return;
      }
      if (req.method === "GET" && /^\/ps\/plugins\/(installed|list)\?/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plugins: [], pagination: { next_page_token: null } })); return;
      }
      if (req.method === "GET") {
        // Optional services outside this model fixture have ordinary HTTP
        // absence semantics. Keep every request in the private evidence.
        metadataRequests.at(-1).notFound = true;
        res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      else if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes.toString());
      if (builtin === "refresh" && req.url === "/oauth/token") {
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, "SYNTHETIC_REFRESH");
        assert.equal(refreshes++, 0, "single-use primary refresh token is exchanged once");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: rotatedToken, id_token: rotatedToken,
          refresh_token: "SYNTHETIC_ROTATED_REFRESH" })); return;
      }
      if (builtin === "refresh" && req.url === "/responses" && !refreshes) {
        assert.equal(req.headers.authorization, "Bearer " + token);
        rejectedInitialAuth = true;
        res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"synthetic expired access"}}'); return;
      }
      const events = frames(req, body, "http");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(events
        .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      serverError = new Error(`Synthetic ${req.method} ${req.url}: ${error.message}`);
      res.writeHead(500); res.end("synthetic fixture error");
    }
  };
  const server = builtin ? https.createServer({ key: fs.readFileSync(certificateKey), cert: fs.readFileSync(certificate) }, handler)
    : http.createServer(handler);
  const websockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (builtin !== "websocket") {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    websockets.handleUpgrade(req, socket, head, ws => {
      ws.on("message", bytes => {
        try { for (const event of frames(req, JSON.parse(bytes.toString()), "websocket")) ws.send(JSON.stringify(event)); }
        catch (error) { serverError = error; ws.close(); }
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `${builtin ? "https" : "http"}://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), `model="gpt-5.4"\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\nunified_exec=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(address)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
  if (builtin) fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"),
    `model="gpt-6.1-sol"\nopenai_base_url=${JSON.stringify(address)}\nchatgpt_base_url=${JSON.stringify(address)}\n[features]\napps=false\ncode_mode=false\nunified_exec=true\n`);
  const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color",
    OPENAI_API_KEY: "SYNTHETIC_INDEPENDENT_SDK_KEY", CODEX_CA_CERTIFICATE: authority };
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
  const rotatedToken = `synthetic.${Buffer.from(JSON.stringify({ ...claims, synthetic_rotation: 1 })).toString("base64url")}.signature`;
  if (builtin === "refresh") env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = address + "/oauth/token";
  const foreignAuth = JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FOREIGN_DESKTOP_KEY" });
  fs.writeFileSync(path.join(homeDir, ".codex/auth.json"), foreignAuth, { mode: 0o600 });
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
    fs.writeFileSync(path.join(root, `${name}-metadata.json`), JSON.stringify(metadataRequests, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stdout.log`), Buffer.concat(output), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stderr.log`), Buffer.concat(errors), { mode: 0o600 });
    if (serverError) throw serverError;
    assert.equal(code, 0, `${name} exit=${code}, signal=${signal}; private evidence ${root}`);
    assert.equal(requests.length, 2);
    if (builtin) for (const request of requests) {
      assert.equal(request.transport, builtin === "websocket" ? "websocket" : "http");
      assert.equal(request.headers.authorization, "Bearer " + (builtin === "refresh" ? rotatedToken : token), "native file auth wins over the independent SDK key");
      assert.equal(request.headers["chatgpt-account-id"], accountId);
      assert.equal(request.body.client_metadata["x-codex-installation-id"], prepared.installationId);
      assert.equal(JSON.parse(request.body.client_metadata["x-codex-turn-metadata"]).installation_id, prepared.installationId);
    }
    const toolOutput = requests[1].body.input.filter(item => item.type === "function_call_output");
    assert.match(JSON.stringify(toolOutput), new RegExp(canary));
    assert.ok(JSON.stringify(toolOutput).includes(env.OPENAI_API_KEY), "ordinary SDK tools retain their key");
    assert.ok(JSON.stringify(toolOutput).includes(os.release()), "ordinary tool retains actual uname");
    assert.equal(fs.readFileSync(path.join(cwd, "tool-output.txt"), "utf8"), "tool write succeeded");
    assert.equal(fs.readFileSync(path.join(homeDir, ".codex/auth.json"), "utf8"), foreignAuth);
    if (builtin === "refresh") {
      assert.ok(rejectedInitialAuth); assert.equal(refreshes, 1);
      const auth = JSON.parse(fs.readFileSync(path.join(prepared.accountRoot, "auth.json"), "utf8"));
      assert.equal(auth.tokens.access_token, rotatedToken);
      assert.equal(auth.tokens.refresh_token, "SYNTHETIC_ROTATED_REFRESH");
    }
    return { name, modelRequests: requests.length, ordinaryFileAccess: true, ordinaryUname: true, ordinarySdkKey: true,
      installationId: prepared.installationId, primaryRefreshes: refreshes,
      optionalEndpointsNotProvided: metadataRequests.filter(r => r.notFound).map(r => r.url),
      userAgent: requests[0].headers["user-agent"] };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await invocation?.close?.();
    for (const socket of websockets.clients) socket.terminate();
    websockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

try {
  if (process.argv.includes("--builtin-only")) {
    const results = [];
    for (const transport of ["http", "websocket", "refresh"]) results.push(await run(true, false, transport));
    assert.equal(new Set(results.map(row => row.installationId)).size, results.length);
    for (const row of results) assert.doesNotMatch(row.userAgent?.match(/\(([^;]+);/)?.[1], /\d+\.\d+/);
    process.stdout.write(JSON.stringify({ fixture: root, results: results.map(row => ({ ...row, userAgent: undefined })) }) + "\n");
  } else {
  const control = await run(false), controlAlias = await run(false, true), protectedResult = await run(true), alias = await run(true, true);
  const builtinHttp = await run(true, false, "http"), builtinWebsocket = await run(true, false, "websocket");
  assert.notEqual(builtinHttp.installationId, builtinWebsocket.installationId);
  const osLabel = agent => agent?.match(/\(([^;]+);/)?.[1];
  assert.match(osLabel(control.userAgent), /\d+\.\d+/, "control observes the distribution version");
  assert.match(osLabel(controlAlias.userAgent), /\d+\.\d+/, "the unprotected alias remains a working version probe");
  assert.doesNotMatch(osLabel(protectedResult.userAgent), /\d+\.\d+/, "vendor header excludes the distribution version");
  assert.doesNotMatch(osLabel(alias.userAgent), /\d+\.\d+/, "a PATH alias cannot disclose the distribution version");
  for (const result of [builtinHttp, builtinWebsocket]) assert.doesNotMatch(osLabel(result.userAgent), /\d+\.\d+/);
  process.stdout.write(JSON.stringify({ fixture: root, control: { ...control, userAgent: undefined },
    controlAlias: { ...controlAlias, userAgent: undefined },
    protected: { ...protectedResult, userAgent: undefined }, alias: { ...alias, userAgent: undefined },
    builtinHttp: { ...builtinHttp, userAgent: undefined }, builtinWebsocket: { ...builtinWebsocket, userAgent: undefined },
    vendorReleaseRemoved: true }) + "\n");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
