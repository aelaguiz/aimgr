#!/usr/bin/env node
// Offsite-only native route acceptance. Every vendor credential is synthetic;
// only the numeric TLS exit check can leave the host through its existing route.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { startSocks, listen } from "../test/network/socks-fixture.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = fileURLToPath(import.meta.url);
const lane = process.argv[3];
if (process.argv[2] === "relay") {
  const certificateRoot = process.argv[4];
  const requests = [];
  let websocket = false, composition = false, refreshed = false, modelTurns = 0;
  const frames = () => [
    { type: "response.created", response: { id: "synthetic-response" } },
    { type: "response.output_item.done", item: composition && ++modelTurns === 1
      ? { type: "function_call", call_id: "routed-tool", name: "exec_command",
        arguments: JSON.stringify({ cmd: "/usr/bin/python3 " + JSON.stringify(path.join(certificateRoot, "tool-proof.py")), login: false, yield_time_ms: 10000, max_output_tokens: 500 }) }
      : { type: "message", role: "assistant", id: "synthetic-message",
        content: [{ type: "output_text", text: "Synthetic proxy task complete." }] } },
    { type: "response.completed", response: { id: "synthetic-response", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  const origin = https.createServer({ key: fs.readFileSync(path.join(certificateRoot, "key.pem")),
    cert: fs.readFileSync(path.join(certificateRoot, "cert.pem")) }, async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    requests.push({ method: req.method, url: req.url, transport: "http", source: req.socket.remoteAddress });
    if (req.url === "/api/codex/accounts/check") {
      const accountId = "synthetic-proxy-" + lane;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accounts: [{ id: accountId, plan_type: "plus", structure: "personal",
        workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }],
        account_ordering: [accountId], default_account_id: accountId })); return;
    }
    if (composition && req.url === "/oauth/token") {
      const body = JSON.parse(bytes.toString());
      assert.equal(body.refresh_token, "SYNTHETIC_ONLY"); assert.equal(refreshed, false); refreshed = true;
      const original = JSON.parse(fs.readFileSync(path.join(certificateRoot, "synthetic-token.json")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: original.rotated, id_token: original.rotated, refresh_token: "SYNTHETIC_ROTATED" })); return;
    }
    if (req.url === "/mcp") {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const body = JSON.parse(bytes.toString()); requests.at(-1).rpc = body.method;
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = body.method === "initialize" ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "routed-proof", version: "1" } } : { tools: [] };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); return;
    }
    if (req.method === "POST" && req.url === "/responses") {
      if (composition && !refreshed) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"synthetic expired access"}}'); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frames().map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.startsWith("/models") ? { models: [] } : {}));
    }
  });
  const ws = new WebSocketServer({ noServer: true });
  origin.on("upgrade", (req, socket, head) => {
    if (!websocket) { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    ws.handleUpgrade(req, socket, head, client => client.on("message", () => {
      requests.push({ url: req.url, transport: "websocket", source: req.socket.remoteAddress });
      for (const frame of frames()) client.send(JSON.stringify(frame));
    }));
  });
  const originPort = await listen(origin);
  origin.on("tlsClientError", error => requests.push({ transport: "tls-error", code: error.code, message: error.message }));
  const host = `model-${lane}.aimgr.invalid`;
  const proof = http.createServer((req, res) => { requests.push({ url: req.url, transport: "raw-tool", source: req.socket.remoteAddress }); res.end("ASSIGNED_ROUTE"); });
  const proofPort = await listen(proof);
  const socks = await startSocks({ port: lane === "a" ? 1186 : 1187,
    sourceAddress: lane === "a" ? "127.0.0.2" : "127.0.0.3", destinations: { [host]: originPort, "198.18.0.19": proofPort, ipv6: proofPort },
    forwardSocks: { host: "127.0.0.1", port: 1086 }, forwardHosts: ["1.1.1.1"] });
  process.on("message", message => {
    if (message.action === "pause") socks.pauseForward();
    if (message.action === "resume") socks.resumeForward();
    if (message.action === "websocket") websocket = true;
    if (message.action === "composition") composition = true;
    process.send({ id: message.id, receipts: socks.receipts, requests });
  });
  process.send({ ready: true, port: socks.port, host });
  process.on("disconnect", () => process.exit());
} else {
  const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "proxy-"));
  const openssl = args => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "authority-key.pem", "-out", "authority.pem", "-subj", "/CN=Synthetic AIM authority",
    "-addext", "basicConstraints=critical,CA:TRUE"]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "request.pem", "-subj", "/CN=model-a.aimgr.invalid"]);
  fs.writeFileSync(path.join(root, "extensions.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:model-a.aimgr.invalid,DNS:model-b.aimgr.invalid\n");
  openssl(["x509", "-req", "-in", "request.pem", "-CA", "authority.pem", "-CAkey", "authority-key.pem",
    "-set_serial", "1", "-days", "1", "-extfile", "extensions.cnf", "-out", "cert.pem"]);
  openssl(["verify", "-CAfile", "authority.pem", "-purpose", "sslserver", "cert.pem"]);
  const report = { root, platform: process.platform, checks: [] };
  const relays = [], vendors = [];
  let ipv6Control, ipv6Alias = false;
  const composition = process.argv.includes("--composition");
  const fault = process.argv.includes("--fault") ? process.argv[process.argv.indexOf("--fault") + 1] : null;
  if (fault) assert.ok(["owner", "exit"].includes(fault));
  const environment = readCodexEnvironment();
  const installedBase = JSON.parse(fs.readFileSync(`/opt/aimgr-claude-proxy/${process.platform === "linux" ? "proxy6" : "codex-p24"}.json`));
  const profiles = Object.fromEntries(["a", "b"].map((name, index) => [`codex_test_${name}`, {
    socksHost: "127.0.0.1", socksPort: 1186 + index, httpPort: 2186 + index,
    expectedExits: installedBase.expectedExits, exitCheckUrl: "https://1.1.1.1/cdn-cgi/trace", exitCheckFormat: "cloudflare-trace",
    ...(process.platform === "linux" ? { redirectPort: 16186 + index }
      : { gid: 64087 + index, interface: `utun${87 + index}`, subnetIndex: 87 + index }),
  }]));
  const helper = path.resolve(`native/claude/${process.platform === "linux" ? "linux" : "darwin"}_proxy.py`);
  const sudo = args => execFileSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 120_000 });
  const installedManifest = JSON.parse(fs.readFileSync("/opt/aimgr-claude-proxy/manifest.json"));
  // Previous interrupted acceptance may have left these exact fixture names.
  // They are ours; preserve every other installed profile and its running state.
  for (const name of Object.keys(profiles)) delete installedManifest.profiles[name];
  fs.writeFileSync(path.join(root, "original-manifest.json"), JSON.stringify(installedManifest));
  const previouslyActive = process.platform === "linux" ? Object.keys(installedManifest.profiles).filter(name => {
    try { return sudo(["systemctl", "is-active", `aimgr-claude-proxy-${name}.service`]).trim() === "active"; }
    catch { return false; }
  }) : [];
  let sequence = 0;
  const control = (child, action) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error("Relay control timeout")); }, 3000);
    const receive = value => { if (value.id === id) { clearTimeout(timer); child.off("message", receive); resolve(value); } };
    child.on("message", receive); child.send({ id, action });
  });
  const check = (name, detail = {}) => {
    report.checks.push({ name, ...detail });
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ name, ...detail }) + "\n");
  };
  async function startRelay(name) {
    const child = spawn(process.execPath, [script, "relay", name, root], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const [ready] = await once(child, "message"); assert.equal(ready.ready, true);
    return child;
  }
  function restartRoute(name) {
    if (process.platform === "linux") sudo(["systemctl", "restart", `aimgr-claude-proxy-${name}.service`]);
    else sudo(["/bin/launchctl", "kickstart", "-k", `system/com.aimgr.claude-proxy.${name}`]);
  }
  function replaceInstalledProfile(name, value) {
    sudo(["python3", "-I", "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
      `/opt/aimgr-claude-proxy/${name}.json`, JSON.stringify(value)]);
  }
  let restoreProfile;
  async function launch(name, mode = "hold") {
    const folder = fs.mkdtempSync(path.join(root, name + "-")), homeDir = path.join(folder, "home"), cwd = path.join(folder, "project");
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true }); fs.mkdirSync(cwd);
    const address = `https://model-${name}.aimgr.invalid`;
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"),
      `model="gpt-6.1-sol"\nopenai_base_url="${address}"\nchatgpt_base_url="${address}"\n`
      + (mode === "http" ? `model_provider="fixture"\n` : "")
      + `[features]\napps=false\ncode_mode=false\nunified_exec=true\n`
      + (mode === "composition" ? `[mcp_servers.routed]\nurl="${address}/mcp"\nrequired=true\n` : "")
      + (mode === "http" ? `[model_providers.fixture]\nname="Fixture"\nbase_url="${address}"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n` : ""));
    const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color",
      CODEX_CA_CERTIFICATE: path.join(root, "authority.pem") };
    if (mode === "composition") {
      env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = address + "/oauth/token";
      env.HTTPS_PROXY = "http://127.0.0.1:9"; env.NO_PROXY = "*"; env.CODEX_SANDBOX = "inherited-synthetic";
    }
    const accountId = `synthetic-proxy-${name}`, profileRef = `codex_test_${name}`;
    const options = { homeDir, env, environment, accountId, label: name };
    const token = `synthetic.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: "synthetic-user", chatgpt_plan_type: "plus" } })).toString("base64url")}.signature`;
    if (mode === "composition") {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const rotated = `synthetic.${Buffer.from(JSON.stringify({ ...claims, rotation: 1 })).toString("base64url")}.signature`;
      fs.writeFileSync(path.join(root, "synthetic-token.json"), JSON.stringify({ rotated }));
    }
    saveLocalCodexLogin(options, { access: token, idToken: token, refresh: "SYNTHETIC_ONLY", accountId });
    writeAimgrConfig({ homeDir, config: { codexProxyProfiles: profiles } });
    const prepared = { ...prepareCodexAccountState(options), routeRecord: { label: name, accountId, version: 1, policy: { egress: { profileRef } } } };
    const args = mode === "hold" ? ["app-server", "--listen", "stdio://"]
      : ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "Say the synthetic task is complete."];
    const invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, env, args, command: path.join(base, "bin", "codex"), ownedAppServer: mode === "hold" });
    const child = spawn(invocation.command, invocation.args, { cwd, env: invocation.env, detached: true,
      stdio: [mode === "hold" ? "pipe" : "ignore", "pipe", "pipe", invocation.environmentFd, invocation.assignmentFd] });
    invocation.closeEnvironment();
    const owner = { child, invocation, folder, output: "", error: "", exit: null };
    owner.done = new Promise(resolve => child.once("close", (code, signal) => { owner.exit = { code, signal }; resolve(owner.exit); }));
    child.stdout.on("data", data => { owner.output += data; }); child.stderr.on("data", data => { owner.error += data; });
    vendors.push(owner);
    if (mode === "hold") child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "synthetic_proxy_acceptance", version: "1" } } }) + "\n");
    return owner;
  }
  async function waitFor(predicate, deadline = 30_000) {
    const started = Date.now();
    while (!predicate()) { assert.ok(Date.now() - started < deadline, "Native acceptance deadline"); await delay(100); }
  }
  async function initialized(owner) {
    await waitFor(() => owner.exit || owner.output.includes('"id":1'), 80_000);
    assert.equal(owner.exit, null, owner.error); assert.ok(owner.output.includes('"result"'), owner.output);
  }
  try {
    for (const name of ["a", "b"]) {
      relays.push(await startRelay(name));
    }
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ user: os.userInfo().username, profiles }));
    execFileSync("sudo", ["-n", "python3", "-I", helper, "install"], { input: JSON.stringify({ user: os.userInfo().username, profiles }), timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
    if (process.platform === "linux") sudo(["systemctl", "start", "aimgr-claude-proxy-codex_test_a.service", "aimgr-claude-proxy-codex_test_b.service"]);
    if (composition) {
      // Establish reachability outside the routed process; a missing host route
      // must not pass as evidence that the routing policy denies IPv6.
      const ipv6 = "fd18::19";
      sudo(process.platform === "linux" ? ["ip", "-6", "address", "add", ipv6 + "/128", "dev", "lo"]
        : ["/sbin/ifconfig", "lo0", "inet6", ipv6, "alias"]); ipv6Alias = true;
      let directHits = 0;
      ipv6Control = http.createServer((req, res) => { directHits++; res.end("DIRECT_CONTROL"); });
      const ipv6Port = await listen(ipv6Control, "::");
      const ipv6Url = `http://[${ipv6}]:${ipv6Port}/raw-ipv6`;
      const positive = await new Promise((resolve, reject) => http.get(ipv6Url, res => {
        let value = ""; res.on("data", b => value += b); res.on("end", () => resolve(value));
      }).on("error", reject));
      assert.equal(positive, "DIRECT_CONTROL");
      const privateCanary = path.join(root, "ordinary-tool-private.txt");
      fs.writeFileSync(privateCanary, "ORDINARY_TOOL_ACCESS", { mode: 0o600 });
      fs.writeFileSync(path.join(root, "tool-proof.py"), `import json,pathlib,urllib.request,platform
proof={"private":pathlib.Path(${JSON.stringify(privateCanary)}).read_text(),"release":platform.release(),"requests":{}}
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for url in ("http://198.18.0.19/raw-ipv4",${JSON.stringify(ipv6Url)}):
 try:proof["requests"][url]=client.open(url,timeout=4).read().decode()
 except Exception as error:proof["requests"][url]=type(error).__name__
pathlib.Path("routed-tool.json").write_text(json.dumps(proof))
print("ROUTED_ORDINARY_TOOL_COMPLETE")
`);
      await control(relays[0], "composition");
      const owner = await launch("a", "composition");
      await waitFor(() => owner.exit, 60_000);
      assert.equal(owner.exit.code, 0, owner.error);
      assert.ok(owner.output.includes("Synthetic proxy task complete"));
      const evidence = await control(relays[0], "receipts");
      assert.equal(evidence.requests.filter(x => x.url === "/oauth/token").length, 1);
      assert.ok(evidence.requests.some(x => x.rpc === "initialize"));
      assert.ok(evidence.requests.some(x => x.rpc === "tools/list"));
      const tool = JSON.parse(fs.readFileSync(path.join(owner.folder, "project", "routed-tool.json")));
      assert.equal(tool.private, "ORDINARY_TOOL_ACCESS"); assert.equal(tool.release, os.release());
      assert.equal(tool.requests["http://198.18.0.19/raw-ipv4"], "ASSIGNED_ROUTE");
      assert.ok(evidence.requests.some(x => x.url === "/raw-ipv4" && x.transport === "raw-tool"));
      assert.ok(["ASSIGNED_ROUTE", "URLError"].includes(tool.requests[ipv6Url]));
      assert.equal(directHits, 1, "routed IPv6 never reaches the direct positive-control listener");
      if (tool.requests[ipv6Url] === "ASSIGNED_ROUTE") assert.ok(evidence.requests.some(x => x.url === "/raw-ipv6" && x.transport === "raw-tool"));
      assert.ok(evidence.receipts.some(x => x.host === "model-a.aimgr.invalid" && x.port === 443));
      fs.writeFileSync(path.join(root, "composition-receipts.json"), JSON.stringify({ ...evidence, tool }, null, 2));
      check("native-refresh-mcp-and-ordinary-tool-composition", { toolRequests: tool.requests, ipv6DirectControlReachable: true, directIpv6Bypass: false });
    } else if (process.argv.includes("--protocols")) {
      for (const mode of ["http", "websocket"]) {
        if (mode === "websocket") await control(relays[0], "websocket");
        const owner = await launch("a", mode);
        await waitFor(() => owner.exit, 45_000);
        assert.equal(owner.exit.code, 0, owner.error);
        assert.ok(owner.output.includes("Synthetic proxy task complete"), owner.output);
        const evidence = await control(relays[0], "receipts");
        assert.ok(evidence.receipts.some(x => x.host === "model-a.aimgr.invalid" && x.port === 443));
        assert.ok(evidence.requests.some(x => x.url === "/responses" && x.transport === mode));
        fs.writeFileSync(path.join(root, `${mode}-receipts.json`), JSON.stringify(evidence, null, 2));
        await owner.invocation.close();
        check("native-model-through-assigned-socks-hostname", { protocol: mode });
      }
    } else if (fault) {
      const a = await launch("a"), b = await launch("b"); await Promise.all([initialized(a), initialized(b)]);
      const started = Date.now();
      if (fault === "owner") {
        const dead = once(relays[0], "exit"); relays[0].kill("SIGKILL"); await dead;
      } else {
        // Inject the validator's unexpected-exit condition while keeping the
        // same real connection and owners. No alternate external exit is used.
        restoreProfile = JSON.parse(fs.readFileSync("/opt/aimgr-claude-proxy/codex_test_a.json"));
        replaceInstalledProfile("codex_test_a", { ...restoreProfile, expectedExits: ["192.0.2.254"] });
        // Keep authored and installed settings equal so the new launch reaches
        // native admission and fails its exit check, not the JS settings check.
        profiles.codex_test_a.expectedExits = ["192.0.2.254"];
        if (process.platform === "darwin") sudo(["/bin/launchctl", "kill", "SIGHUP", "system/com.aimgr.claude-proxy.codex_test_a"]);
      }
      await waitFor(() => a.exit, 10_000);
      assert.equal(b.exit, null);
      check("fatal-fault-terminates-only-assigned-work", { fault, elapsedMs: Date.now() - started, exit: a.exit });
      const denied = await launch("a");
      await waitFor(() => denied.exit, 10_000);
      assert.equal(denied.output.includes('"id":1'), false);
      assert.notEqual(denied.exit.code, 0);
      check("new-admission-refuses-fatal-route");
      if (restoreProfile) {
        profiles.codex_test_a.expectedExits = restoreProfile.expectedExits;
        replaceInstalledProfile("codex_test_a", restoreProfile); restoreProfile = null;
      }
      if (fault === "owner") relays[0] = await startRelay("a");
      restartRoute("codex_test_a");
      await delay(15_000);
      assert.equal(b.exit, null);
      assert.equal((await control(relays[0], "receipts")).requests.filter(x => x.url === "/responses").length, 0);
      const resumed = await launch("a"); await initialized(resumed);
      check("service-restart-does-not-replay-and-explicit-new-launch-succeeds");
    } else {
    // Admission owns startup readiness; no fixture sleeps masquerade as health.
    const a = await launch("a"), b = await launch("b"); await Promise.all([initialized(a), initialized(b)]);
    check("two-native-routes-admitted");
    for (const duration of [5000, 30_000]) {
      await control(relays[0], "pause");
      const next = await launch("a");
      await delay(duration);
      assert.equal(a.exit, null); assert.equal(b.exit, null); assert.equal(next.exit, null);
      assert.equal(next.output.includes('"id":1'), false, "New native admission waits for recovery");
      await control(relays[0], "resume"); await initialized(next);
      assert.equal(a.exit, null); assert.equal(b.exit, null);
      next.child.stdin.end(); await next.done; await next.invocation.close();
      check("transient-recovery", { outageMs: duration, unrelatedRouteSurvived: true });
    }
    const outage = Date.now(); await control(relays[0], "pause");
    await waitFor(() => a.exit, 80_000); assert.equal(b.exit, null);
    check("long-outage-terminates-only-assigned-route", { elapsedMs: Date.now() - outage, exit: a.exit });
    await control(relays[0], "resume");
    await delay(15_000); assert.equal(a.exit?.code === 0, false); assert.equal(b.exit, null);
    check("repair-does-not-replay-work");
    }
    report.complete = true;
  } finally {
    if (restoreProfile) replaceInstalledProfile("codex_test_a", restoreProfile);
    for (const owner of vendors) {
      if (!owner.exit) { owner.child.stdin?.end(); await Promise.race([owner.done, delay(3000)]); }
      if (!owner.exit) { try { process.kill(-owner.child.pid, "SIGTERM"); } catch {} }
      await owner.invocation.close();
      fs.writeFileSync(path.join(owner.folder, "stdout.log"), owner.output);
      fs.writeFileSync(path.join(owner.folder, "stderr.log"), owner.error);
    }
    for (const [index, child] of relays.entries()) {
      if (child.connected) {
        try { fs.writeFileSync(path.join(root, `relay-${index}.json`), JSON.stringify(await control(child, "receipts"), null, 2)); }
        catch (error) { report.cleanupError = String(error.message); }
      }
    }
    for (const name of Object.keys(profiles)) {
      try {
        if (process.platform === "linux") {
          sudo(["systemctl", "disable", "--now", `aimgr-claude-proxy-${name}.service`]);
        } else {
          sudo(["python3", "-I", helper, "stop", name]);
          sudo(["/bin/launchctl", "bootout", `system/com.aimgr.claude-proxy.${name}`]);
          sudo(["/sbin/pfctl", "-a", `com.apple/aimgr-claude_${name}`, "-F", "all"]);
        }
      } catch (error) { report.cleanupError = String(error.message); }
    }
    for (const child of relays) child.kill("SIGTERM");
    if (ipv6Control) { ipv6Control.closeAllConnections(); await new Promise(resolve => ipv6Control.close(resolve)); }
    if (ipv6Alias) sudo(process.platform === "linux" ? ["ip", "-6", "address", "del", "fd18::19/128", "dev", "lo"]
      : ["/sbin/ifconfig", "lo0", "inet6", "fd18::19", "-alias"]);
    sudo(["python3", "-I", "-c", `import pathlib,sys,json,shutil
root=pathlib.Path('/opt/aimgr-claude-proxy')
(root/'manifest.json').write_text(sys.argv[1])
for name in ('codex_test_a','codex_test_b'):
 for suffix in ('.json','-sing-box.json','.identity'):
  (root/(name+suffix)).unlink(missing_ok=True)
 unit=pathlib.Path('/etc/systemd/system/aimgr-claude-proxy-'+name+'.service') if sys.platform=='linux' else pathlib.Path('/Library/LaunchDaemons/com.aimgr.claude-proxy.'+name+'.plist')
 unit.unlink(missing_ok=True)
 if sys.platform=='darwin':
  shutil.rmtree(root/(name+'-state'),ignore_errors=True)
  (root/(name+'.lock')).unlink(missing_ok=True)
`, JSON.stringify(installedManifest)]);
    if (process.platform === "linux") {
      // Re-render the existing installation's rules and sudoers together.
      execFileSync("sudo", ["-n", "python3", "-I", helper, "install"], {
        input: JSON.stringify(installedManifest), timeout: 120_000, stdio: ["pipe", "pipe", "pipe"],
      });
      for (const name of Object.keys(profiles)) sudo(["rmdir", `/sys/fs/cgroup/aimgr-claude/${name}`]);
      for (const name of previouslyActive) sudo(["systemctl", "start", `aimgr-claude-proxy-${name}.service`]);
    }
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ root, complete: report.complete === true }) + "\n");
  }
}
