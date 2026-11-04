#!/usr/bin/env node
// Synthetic keyring interoperability only, on the designated isolated Linux
// host inside a loopback-only namespace and a fresh dbus-run-session.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { codexMcpKey, decodeCodexMcpFile, codexMcpKeyring, codexMcpTokensEqual } from "../src/credentials/codex-mcp-migration.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { admitCodexArtifact } from "../src/privacy/codex-artifacts.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
assert.equal(process.platform, "linux");
assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
assert.match(process.env.DBUS_SESSION_BUS_ADDRESS ?? "", /^unix:/);
assert.equal(process.env.AIMGR_SYNTHETIC_DBUS, "1");
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "mcp-"));
const homeDir = path.join(root, "home"), cwd = path.join(root, "project"), controlDir = path.join(root, "keyring-control");
for (const dir of [path.join(homeDir, ".codex"), cwd, controlDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const env = { HOME: homeDir, XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  RUST_LOG: "codex_keyring_store=trace,codex_rmcp_client=debug",
  PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" };
const packageRoot = "/home/aimdev/codex-m1-private/keyring-fixture/runtime";
const daemon = spawn(path.join(packageRoot, "usr/bin/gnome-keyring-daemon"),
  ["--foreground", "--components=secrets", "--control-directory=" + controlDir, "--unlock"], {
    env: { ...env, LD_LIBRARY_PATH: path.join(packageRoot, "usr/lib/x86_64-linux-gnu") },
    stdio: ["pipe", "pipe", "pipe"],
  });
const daemonLogs = [];
daemon.stdout.on("data", bytes => daemonLogs.push(bytes)); daemon.stderr.on("data", bytes => daemonLogs.push(bytes));
daemon.stdin.end("SYNTHETIC_KEYRING_PASSWORD\n");
const monitorLogs = [];
const monitor = spawn("/usr/bin/dbus-monitor", ["--session"], { env, stdio: ["ignore", "pipe", "pipe"] });
monitor.stdout.on("data", bytes => monitorLogs.push(bytes)); monitor.stderr.on("data", bytes => monitorLogs.push(bytes));
const keyring = request => codexMcpKeyring(request, {
  command: admitCodexArtifact().mcpKeyring, env,
});
let generation = 0, rejectCurrentAccess = false, serverError;
const requests = [];
const service = http.createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    requests.push({ method: req.method, url: req.url });
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource/mcp") {
      json(200, { resource: server.url, authorization_servers: [server.url], scopes_supported: ["read", "write"] }); return;
    }
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server/mcp") {
      json(200, { issuer: server.url, authorization_endpoint: address + "/authorize", token_endpoint: address + "/token" }); return;
    }
    if (req.method === "GET" && req.url.startsWith("/models")) { json(200, { models: [] }); return; }
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    const text = Buffer.concat(chunks).toString();
    if (req.method === "POST" && req.url === "/token") {
      const form = new URLSearchParams(text);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), generation ? `SYNTHETIC_MCP_REFRESH_${generation}` : "SYNTHETIC_MCP_REFRESH");
      generation++; rejectCurrentAccess = false;
      json(200, { access_token: `SYNTHETIC_MCP_ACCESS_${generation}`, refresh_token: `SYNTHETIC_MCP_REFRESH_${generation}`,
        token_type: "Bearer", expires_in: 3600, scope: "read write" }); return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      if (rejectCurrentAccess || req.headers.authorization !== `Bearer SYNTHETIC_MCP_ACCESS_${generation}`) {
        res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }); res.end(); return;
      }
      const body = JSON.parse(text);
      requests.at(-1).rpc = body.method;
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = body.method === "initialize" ? { protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "synthetic-authenticated-mcp", version: "1" } }
        : body.method === "tools/list" ? { tools: [] } : undefined;
      assert.ok(result, "unexpected synthetic MCP request");
      json(200, { jsonrpc: "2.0", id: body.id, result }); return;
    }
    if (req.method === "POST" && req.url === "/responses") {
      const response = { id: "synthetic-response", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [{ type: "response.created", response }, { type: "response.output_item.done",
        item: { type: "message", role: "assistant", id: "synthetic-message", content: [{ type: "output_text", text: "Synthetic MCP check complete." }] } },
      { type: "response.completed", response }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
    }
    if (["GET", "DELETE"].includes(req.method) && req.url === "/mcp") { res.writeHead(405); res.end(); return; }
    throw new Error("unexpected synthetic endpoint");
  } catch (error) {
    serverError = new Error(`Synthetic service failed at ${req.method} ${req.url}: ${error.message}`);
    json(500, { error: "synthetic fixture failure" });
  }
});
service.listen(0, "127.0.0.1"); await once(service, "listening");
const address = `http://127.0.0.1:${service.address().port}`;
const namePrefix = process.env.AIMGR_SYNTHETIC_MCP_PREFIX ?? "";
assert.ok(["", "local:local:", "executor:", "ema-idp:"].includes(namePrefix));
const server = { name: namePrefix + "fixture_" + path.basename(root).replaceAll("-", "_"), url: address + "/mcp" };
const fileEntry = { server_name: server.name, server_url: server.url, client_id: "SYNTHETIC_CLIENT",
  access_token: "SYNTHETIC_MCP_ACCESS", refresh_token: "SYNTHETIC_MCP_REFRESH", expires_at: Date.now() - 1_000, issuer: server.url,
  scopes: ["read", "write"] };
const [converted] = decodeCodexMcpFile(JSON.stringify({ [codexMcpKey(server.name, server.url)]: fileEntry }), [server]);
const source = path.join(homeDir, ".codex", "config.toml");
fs.writeFileSync(source, `model="gpt-5.4"\nmodel_provider="fixture"\nmcp_oauth_credentials_store="keyring"\n[features]\napps=false\ncode_mode=false\nsecret_auth_storage=false\n[mcp_servers.${JSON.stringify(server.name)}]\nurl=${JSON.stringify(server.url)}\nrequired=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(address)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`, { mode: 0o600 });
const environment = readCodexEnvironment();
const outputs = [];
async function native(accountId, protectedLaunch, args = ["mcp", "list", "--json"]) {
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": {
    chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user",
  } };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const options = { homeDir, env, environment, accountId, label: accountId };
  saveLocalCodexLogin(options, { access: token, idToken: token, refresh: "SYNTHETIC_PRIMARY_REFRESH", accountId });
  const prepared = prepareCodexAccountState(options);
  const invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin/codex"), homeDir, cwd, env, args });
  let child, timer;
  try {
    child = spawn(protectedLaunch ? invocation.command : path.join(base, "bin/codex"), protectedLaunch ? invocation.args : args, {
      cwd, env: protectedLaunch ? invocation.env : invocation.environment, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...(protectedLaunch ? [invocation.environmentFd] : [])],
    });
    invocation.closeEnvironment();
    const stdout = [], stderr = [];
    child.stdout.on("data", bytes => stdout.push(bytes)); child.stderr.on("data", bytes => stderr.push(bytes));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 25_000);
    const [code, signal] = await once(child, "close");
    outputs.push({ accountId, protectedLaunch, args, code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    assert.equal(code, 0, `Native MCP command failed; private evidence ${root}`);
    return Buffer.concat(stdout).toString();
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await invocation.close();
  }
}

try {
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await keyring({ operation: "load", server_name: server.name, url: server.url })).value, null); break; }
    catch (error) { if (attempt === 9 || daemon.exitCode !== null) throw error; await delay(100); }
  }
  const inserted = await keyring({ operation: "insert-if-absent", server_name: server.name, url: server.url, value: JSON.stringify(converted.token) });
  assert.equal(inserted.inserted, true);
  assert.equal(codexMcpTokensEqual(JSON.parse(inserted.value), converted.token), true);
  for (const [account, protectedLaunch] of [["synthetic-A", false], ["synthetic-A", true], ["synthetic-B", true]]) {
    const entries = JSON.parse(await native(account, protectedLaunch));
    assert.ok(["o_auth", "oauth"].includes(entries.find(entry => entry.name === server.name)?.auth_status), "native recognizes converted OAuth tokens");
  }
  const execArgs = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Complete the synthetic MCP check."];
  for (const [index, account] of ["synthetic-A", "synthetic-B"].entries()) {
    const before = requests.length;
    rejectCurrentAccess = index === 1;
    await native(account, true, execArgs);
    if (serverError) throw serverError;
    assert.equal(generation, index + 1, "native rotates from the current refresh-token lineage exactly once");
    const stored = JSON.parse((await keyring({ operation: "load", server_name: server.name, url: server.url })).value);
    assert.equal(stored.token_response.refresh_token, `SYNTHETIC_MCP_REFRESH_${generation}`);
    assert.equal(stored.token_response.access_token, `SYNTHETIC_MCP_ACCESS_${generation}`);
    assert.ok(requests.slice(before).some(request => request.rpc === "tools/list"), "native starts the authenticated MCP integration");
  }
  // Native removal is the interoperability/revocation oracle, not the helper.
  await native("synthetic-B", true, ["mcp", "logout", server.name]);
  assert.equal((await keyring({ operation: "load", server_name: server.name, url: server.url })).value, null);
  for (const account of ["synthetic-A", "synthetic-B"]) {
    const entries = JSON.parse(await native(account, true));
    assert.ok(!["o_auth", "oauth"].includes(entries.find(entry => entry.name === server.name)?.auth_status), "native restart cannot resurrect removed tokens");
  }
  process.stdout.write(JSON.stringify({ fixture: root, configuredNamePrefix: namePrefix, convertedNativeReads: 3, protectedAccountHomes: 2,
    nativeRotatingRefreshes: generation, nativeLogoutRemovedKey: true, restartsWithoutResurrection: 2 }) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}; private evidence ${root}\n`); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, "native.json"), JSON.stringify(outputs, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "keyring.log"), Buffer.concat(daemonLogs), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "dbus.log"), Buffer.concat(monitorLogs), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
  service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
  if (monitor.exitCode === null) { monitor.kill("SIGTERM"); await once(monitor, "close"); }
  if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await once(daemon, "close"); }
}
