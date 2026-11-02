/** Synthetic HTTP/OAuth MCP acceptance through the actual admitted AIM runner.
 * Runs only inside the default-services offsite fixture. OAuth discovery,
 * refresh, credential persistence and MCP transport are native Claude code;
 * the loopback service owns every token below and never opens a browser.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runClaudeCliNoninteractive } from "../src/targets/claude-runner.js";

export async function verifyHttpMcp({ launch, captureFile }) {
  assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
  const calls = [], failures = [], refreshes = [], initialExchanges = [];
  let origin, url, authorization, loginProcess;
  const server = http.createServer(async (request, response) => {
    const reply = (status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(data === undefined ? undefined : JSON.stringify(data)); };
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (request.url.startsWith("/.well-known/oauth-protected-resource")) return reply(200, { resource: url, authorization_servers: [origin] });
      if (request.url === "/.well-known/oauth-authorization-server") return reply(200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ["code"], grant_types_supported: ["refresh_token", "authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp:tools", "mcp:resources"],
      });
      if (request.url.startsWith('/authorize?')) {
        authorization = new URL(origin + request.url);
        assert.equal(authorization.searchParams.get('client_id'), 'fixture-client');
        assert.equal(authorization.searchParams.get('response_type'), 'code');
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(authorization.searchParams.get('state'));
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', 'fixture-initial-code');
        callback.searchParams.set('state', authorization.searchParams.get('state'));
        response.writeHead(302, { location: callback.href }); response.end(); return;
      }
      if (request.url === "/token") {
        const fields = Object.fromEntries(new URLSearchParams(raw));
        if (fields.grant_type === 'authorization_code') {
          assert.ok(authorization); assert.equal(fields.code, 'fixture-initial-code');
          assert.equal(fields.client_id, 'fixture-client'); assert.equal(fields.client_secret, 'fixture-secret');
          assert.equal(fields.redirect_uri, authorization.searchParams.get('redirect_uri'));
          assert.equal(crypto.createHash('sha256').update(fields.code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
          assert.equal(fields.resource, url); initialExchanges.push(true);
          return reply(200, { access_token: 'initial-access', token_type: 'Bearer', expires_in: 3600,
            refresh_token: 'fixture-refresh', scope: 'mcp:tools mcp:resources' });
        }
        assert.equal(fields.grant_type, "refresh_token"); assert.equal(fields.refresh_token, "fixture-refresh");
        assert.equal(fields.client_id, "fixture-client"); assert.equal(fields.client_secret, "fixture-secret");
        assert.equal(fields.resource, url); refreshes.push(true);
        return reply(200, { access_token: "fresh-access", token_type: "Bearer", expires_in: 3600,
          refresh_token: "rotated-refresh", scope: "mcp:tools mcp:resources" });
      }
      assert.equal(request.url, "/mcp", "unexpected OAuth/browser endpoint");
      if (request.method === "GET") return reply(405, {});
      if (request.method === "DELETE") return reply(200, {});
      if (!request.headers.authorization) {
        response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); response.end(); return;
      }
      assert.ok(["Bearer initial-access", "Bearer fresh-access"].includes(request.headers.authorization));
      const message = JSON.parse(raw); calls.push(message.method);
      if (message.id === undefined) return reply(202);
      let result;
      switch (message.method) {
        // Native probes this optional extension even when the ordinary MCP
        // capabilities omit it. A compliant unknown-method response keeps
        // the standard tools/resources fallback under test.
        case "server/discover": return reply(200, { jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Optional discovery extension is unavailable" } });
        case "initialize": result = { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {}, resources: {} }, serverInfo: { name: "synthetic-http", version: "1" } }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools: [{ name: "echo", description: "Return synthetic HTTP proof",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }; break;
        case "tools/call": result = { content: [{ type: "text", text: "HTTP_TOOL_RESULT_CANARY" }] }; break;
        case "resources/list": result = { resources: [{ uri: "fixture://privacy/document", name: "fixture-document", mimeType: "text/plain" }] }; break;
        case "resources/templates/list": result = { resourceTemplates: [] }; break;
        case "resources/read": result = { contents: [{ uri: "fixture://privacy/document", mimeType: "text/plain", text: "HTTP_RESOURCE_CONTENT_CANARY" }] }; break;
        default: throw new Error("unexpected MCP method " + message.method);
      }
      reply(200, { jsonrpc: "2.0", id: message.id, result });
    } catch (error) { failures.push(error.message); reply(500, { error: "synthetic assertion failed" }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`; url = `${origin}/mcp`;
  try {
    const config = { type: "http", url, oauth: { clientId: "fixture-client" } };
    const key = "http|" + crypto.createHash("sha256").update(JSON.stringify({ type: config.type, url, headers: {} })).digest("hex").slice(0, 16);
    const credentialsFile = path.join(launch.configDir, ".credentials.json");
    const credentials = JSON.parse(fs.readFileSync(credentialsFile));
    credentials.mcpOAuth = {};
    // The secret exists only in the separate record: refresh must consume it.
    credentials.mcpOAuthClientConfig = { [key]: { clientSecret: "fixture-secret" } };
    fs.writeFileSync(credentialsFile, JSON.stringify(credentials));
    const mcpConfig = path.join(launch.cwd, "http-mcp.json");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { http: config } }));
    // Initial native MCP OAuth is distinct from Claude account login. Register
    // the server through native's persisted USER source; --mcp-config is a
    // dynamic model-launch source and is not consumed by `mcp login`.
    let addOutput = '';
    const added = await runClaudeCliNoninteractive({ ...launch, env: process.env,
      args: ['mcp', 'add-json', '--scope', 'user', 'http', JSON.stringify(config)], timeoutMs: 30000,
      spawnImpl(command, argv, options) {
        const child = spawn(command, argv, options);
        child.stdout.on('data', value => { addOutput += value; }); child.stderr.on('data', value => { addOutput += value; }); return child;
      } });
    fs.writeFileSync(path.join(launch.userHomeDir, 'mcp-add.private.txt'), addOutput);
    assert.equal(added.status, 0);
    const terminalRoot = path.join(launch.cwd, 'mcp-login-terminal'); fs.mkdirSync(terminalRoot);
    const info = path.join(terminalRoot, 'info.json');
    fs.writeFileSync(info, JSON.stringify({ root: terminalRoot, cwd: launch.cwd,
      argv: [process.execPath, fileURLToPath(new URL('./privacy-integrated-launch-check.mjs', import.meta.url)),
        JSON.stringify({ ...launch, check: 'interactive', args: ['mcp', 'login', 'http', '--no-browser'] })] }));
    const login = promisify(execFile)('/usr/bin/python3', ['-I', fileURLToPath(new URL('./privacy-test-pty.py', import.meta.url)), info],
      { cwd: launch.cwd, env: process.env, timeout: 90000 }); login.catch(() => {});
    loginProcess = login;
    let authorizeUrl;
    const deadline = Date.now() + 35000;
    while (!authorizeUrl) {
      const log = path.join(terminalRoot, 'terminal.private.log');
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') : '';
      const match = text.match(/http:\/\/127\.0\.0\.1:[0-9]+\/authorize\?[^\s\x1b]+/);
      if (match) authorizeUrl = match[0];
      else { assert.ok(Date.now() < deadline, 'native initial MCP OAuth URL missing; inspect private terminal'); await delay(100); }
    }
    // Simulate only the independent service's browser approval. Native Claude
    // creates state/PKCE and validates the pasted callback and token response.
    const approved = await fetch(authorizeUrl, { redirect: 'manual' }); assert.equal(approved.status, 302);
    const callback = approved.headers.get('location'); assert.ok(callback);
    fs.appendFileSync(path.join(terminalRoot, 'terminal-input.jsonl'), JSON.stringify(callback) + '\n');
    await login;
    const ended = JSON.parse(fs.readFileSync(path.join(terminalRoot, 'pty-exit.json')));
    assert.equal(ended.exit, 0, 'native initial MCP OAuth failed; inspect private terminal'); assert.equal(ended.challenge, false);
    assert.equal(initialExchanges.length, 1);
    const initial = JSON.parse(fs.readFileSync(credentialsFile));
    assert.equal(initial.mcpOAuth[key].accessToken, 'initial-access');
    assert.equal(initial.mcpOAuth[key].refreshToken, 'fixture-refresh');
    assert.equal(initial.claudeAiOauth.accessToken, credentials.claudeAiOauth.accessToken);
    // Expire only the local hint in the real native-created record. The next
    // launch must refresh and preserve the independently stored client secret.
    initial.mcpOAuth[key].expiresAt = Date.now() - 60000;
    fs.writeFileSync(credentialsFile, JSON.stringify(initial));
    for (const prompt of ["Use http echo. MCP_HTTP_CANARY.", "List and read the http resource. MCP_HTTP_RESOURCE_CANARY."]) {
      let output = "";
      const result = await runClaudeCliNoninteractive({ ...launch, env: process.env,
        args: ["-p", prompt, "--mcp-config", mcpConfig, "--output-format", "json", "--dangerously-skip-permissions",
          "--model", "sonnet", "--max-turns", "6", "--debug-file", path.join(launch.cwd, "http-mcp-debug.private.txt")],
        timeoutMs: 60000, maxOutputBytes: 1024 * 1024,
        spawnImpl(command, argv, options) {
          const child = spawn(command, argv, options);
          child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
          return child;
        } });
      fs.appendFileSync(path.join(launch.userHomeDir, "http-mcp-output.private.txt"), output);
      assert.equal(result.status, 0, "native HTTP MCP turn failed; inspect private output");
    }
    assert.deepEqual(failures, []); assert.equal(refreshes.length, 1);
    for (const method of ["tools/list", "tools/call", "resources/list", "resources/read"]) assert.ok(calls.includes(method), method);
    const models = fs.readFileSync(captureFile, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.path.includes("/messages"));
    for (const marker of ["HTTP_TOOL_RESULT_CANARY", "HTTP_RESOURCE_CONTENT_CANARY"]) assert.ok(models.some(row => JSON.stringify(row.body.messages).includes(marker)), marker);
    const stored = JSON.parse(fs.readFileSync(credentialsFile));
    assert.equal(stored.mcpOAuth[key].refreshToken, "rotated-refresh");
    assert.ok(stored.mcpOAuth[key].expiresAt > Date.now());
    assert.equal(stored.mcpOAuthClientConfig[key].clientSecret, "fixture-secret");
    assert.equal(stored.claudeAiOauth.accessToken, credentials.claudeAiOauth.accessToken);
    return { initialOAuthCodePkceAndCallback: true, nativeInitialCredentialPersistence: true,
      oauthRefresh: true, separateClientSecret: true, persistedRotatedToken: true,
      httpTool: true, resourceListAndRead: true, noBrowserOrRegistration: true, calls };
  } finally {
    if (loginProcess?.child.exitCode === null) loginProcess.child.kill('SIGTERM');
    if (loginProcess) await loginProcess.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
