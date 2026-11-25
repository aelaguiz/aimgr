import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../../src/cli/main.js";
import { maintainClaudeFigmaGrant } from "../../src/credentials/claude-figma.js";
import {
  FIGMA_MCP_URL, figmaGrantRoot, readClaudeFigmaGrant, writeClaudeFigmaGrant,
} from "../../src/credentials/claude-figma-store.js";

const email = "work@example.com";
const key = "figma|native-test-key";
const day = 86_400_000;
const grant = (id, expiresAt) => ({
  mcpOAuth: { [key]: { serverName: "figma", serverUrl: FIGMA_MCP_URL,
    accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt } },
  mcpOAuthClientConfig: { [key]: { clientId: "test-client" } },
});
const nativeFile = configDir => path.join(configDir, ".credentials.json");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-figma-lifecycle-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const resolveExecutableOnPathImpl = () => process.execPath;
  resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl = async launch => launch;
  return { homeDir, resolveExecutableOnPathImpl, env: { ANTHROPIC_API_KEY: "secret", ANTHROPIC_CUSTOM_HEADERS: "other-secret" } };
}

function identityClient(getEmail, calls) {
  return async (url, options) => {
    assert.equal(String(url), FIGMA_MCP_URL);
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer access-new");
    assert.ok(options.signal);
    const rpc = JSON.parse(options.body);
    calls.push(rpc.method);
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
      protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "figma-test", version: "1" },
    } });
    assert.equal(rpc.method, "tools/call");
    assert.deepEqual(rpc.params, { name: "whoami", arguments: {} });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
      structuredContent: { whoami: { email: getEmail() } },
    } });
  };
}

test("Figma login verifies identity before replacing the machine grant", async t => {
  const context = fixture(t);
  const { homeDir } = context;
  writeClaudeFigmaGrant({ homeDir, email, native: grant("old", Date.now() + 7 * day) });
  const calls = [];
  let returnedEmail = "personal@example.com";
  context.fetchImpl = identityClient(() => returnedEmail, calls);
  context.runClaudeCliImpl = async ({ configDir, homeDir: stagingHome, args, env, signal }) => {
    assert.deepEqual(args, ["mcp", "login", "figma", "--no-browser"]);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.ok(signal);
    assert.match(path.basename(stagingHome), /^\.login-staging-[0-9a-f-]{36}$/);
    assert.equal(path.dirname(stagingHome), figmaGrantRoot(homeDir));
    assert.equal(fs.existsSync(nativeFile(configDir)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8")), {
      mcpServers: { figma: { type: "http", url: FIGMA_MCP_URL, oauth: { callbackPort: 12345 } } },
    });
    fs.writeFileSync(nativeFile(configDir), JSON.stringify(grant("new", Date.now() + 7 * day)));
    return { status: 0 };
  };

  const output = [];
  context.stdout = { write: value => output.push(value) };
  context.setExitCode = code => assert.fail(`Unexpected exit code ${code}`);
  const cli = (...args) => main(["claude", "figma", ...args, "--home", homeDir], context);
  const login = () => cli("login", "--email", email, "--port", "12345");
  await assert.rejects(login(), /differs from the requested email/);
  assert.equal(readClaudeFigmaGrant({ homeDir }).accessToken, "access-old");
  assert.deepEqual(fs.readdirSync(figmaGrantRoot(homeDir)), ["grant.json"]);
  returnedEmail = email.toUpperCase();
  await login();
  assert.equal(readClaudeFigmaGrant({ homeDir }).accessToken, "access-new");
  assert.equal(calls.filter(method => method === "tools/call").length, 2);

  output.length = 0;
  await cli("status", "--json");
  assert.equal(calls.filter(method => method === "tools/call").length, 2);
  await cli("status", "--json", "--fresh");
  assert.equal(calls.filter(method => method === "tools/call").length, 3);
  const [local, live] = output.map(value => JSON.parse(value));
  assert.deepEqual(live, { ...local, verified: true });
  assert.deepEqual(Object.keys(live).sort(), ["email", "expiresAt", "status", "verified"]);
});

test("Figma maintenance refreshes only a staged near-expiry grant and locks publication", async t => {
  const context = fixture(t);
  const { homeDir } = context;
  assert.deepEqual(await maintainClaudeFigmaGrant(context), { outcome: "skipped", reason: "not_enrolled" });
  const expiresAt = Date.now() + day / 2;
  writeClaudeFigmaGrant({ homeDir, email, native: grant("old", expiresAt) });
  let shouldFail = true;
  let calls = 0;
  context.runClaudeCliNoninteractiveImpl = async ({ args, configDir }) => {
    calls++;
    assert.deepEqual(args, ["mcp", "get", "figma"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(nativeFile(configDir), "utf8")), grant("old", 1));
    assert.equal(readClaudeFigmaGrant({ homeDir }).expiresAt, expiresAt);
    await new Promise(resolve => setTimeout(resolve, 10));
    fs.writeFileSync(nativeFile(configDir), JSON.stringify(grant("new", Date.now() + 7 * day)));
    return { status: shouldFail ? 1 : 0 };
  };

  assert.equal((await maintainClaudeFigmaGrant(context)).outcome, "retryable");
  assert.equal(readClaudeFigmaGrant({ homeDir }).refreshToken, "refresh-old");
  shouldFail = false;
  const results = await Promise.all([maintainClaudeFigmaGrant(context), maintainClaudeFigmaGrant(context)]);
  assert.deepEqual(results.map(result => result.outcome).sort(), ["refreshed", "unchanged"]);
  assert.equal(calls, 2);
  assert.equal(readClaudeFigmaGrant({ homeDir }).refreshToken, "refresh-new");
  assert.deepEqual(fs.readdirSync(figmaGrantRoot(homeDir)), ["grant.json"]);
});
