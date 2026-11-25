import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureClaudeFigmaGrantRoot, figmaGrantRoot, FIGMA_MCP_NAME, FIGMA_MCP_URL,
  readClaudeFigmaGrant, selectClaudeFigmaNativeGrant, writeClaudeFigmaGrant,
} from "../../src/credentials/claude-figma-store.js";
import { inspectClaudeArguments } from "../../src/privacy/claude-settings.js";
import { prepareClaudeCliLaunch, runClaudeCli } from "../../src/targets/claude-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const email = "work@example.invalid";
const key = "figma|test";
const nativeGrant = (accessToken = "synthetic-access", expiresAt = Date.now() + 60_000) => ({
  mcpOAuth: { [key]: { serverName: "figma", serverUrl: FIGMA_MCP_URL, accessToken,
    expiresAt, refreshToken: "synthetic-refresh" } },
  mcpOAuthClientConfig: { [key]: { clientId: "synthetic-client" } },
});
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function fixture(t) {
  const root = mkTempHome();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "Home with a 'quote'");
  fs.mkdirSync(home, { mode: 0o700 });
  return home;
}

test("the Figma store keeps only the exact native grant and its client registration", t => {
  const homeDir = fixture(t);
  const expected = nativeGrant();
  const native = structuredClone(expected);
  native.claudeAiOauth = { refreshToken: "unrelated-claude-private-state" };
  native.mcpOAuth.other = { ...native.mcpOAuth[key], serverName: "other" };
  native.mcpOAuth.wrongUrl = { ...native.mcpOAuth[key], serverUrl: `${FIGMA_MCP_URL}/` };
  native.mcpOAuthClientConfig.other = { clientId: "unrelated-client" };
  assert.equal(readClaudeFigmaGrant({ homeDir }), null);
  writeClaudeFigmaGrant({ homeDir, email: email.toUpperCase(), native });
  const file = path.join(figmaGrantRoot(homeDir), "grant.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readJson(file), { schema: 1, email, native: expected });
  assert.deepEqual(readClaudeFigmaGrant({ homeDir }), { email, ...selectClaudeFigmaNativeGrant(expected) });

  native.mcpOAuth.duplicate = { ...native.mcpOAuth[key] };
  assert.throws(() => writeClaudeFigmaGrant({ homeDir, email, native }), /local Figma grant/);
  assert.equal(selectClaudeFigmaNativeGrant(nativeGrant("synthetic-access", Number.MAX_SAFE_INTEGER)), null);
  assert.deepEqual(readJson(file).native, expected);

  fs.chmodSync(file, 0o644);
  assert.throws(() => readClaudeFigmaGrant({ homeDir }), /local Figma grant/);
  fs.renameSync(file, `${file}.saved`);
  fs.symlinkSync(`${file}.saved`, file);
  assert.throws(() => readClaudeFigmaGrant({ homeDir }), /local Figma grant/);
  assert.throws(() => writeClaudeFigmaGrant({ homeDir, email, native: expected }), /local Figma grant/);
});

async function preflight(userHomeDir, homeDir = path.join(userHomeDir, ".aimgr", "claude-homes", "label")) {
  return prepareClaudeCliLaunch({ command: process.execPath, userHomeDir, homeDir,
    configDir: path.join(homeDir, ".claude"), platform: "linux", verifyInstalledClaudeExecutableImpl: ({ command }) => command });
}

async function configuredServers(preparedLaunch, cwd, args, egressProfile) {
  let nativeArgs;
  await runClaudeCli({ preparedLaunch, cwd, args, egressProfile, env: {},
    prepareClaudeNativeInvocationImpl: async ({ args }) => {
      nativeArgs = args;
      return { command: process.execPath, args, environment: {}, markStarted() {}, closeEnvironment() {} };
    },
    prepareClaudeNativeRouteImpl: async ({ command, args }) => ({ command, args }),
    spawnImpl: () => ({ status: 0 }),
  });
  return (inspectClaudeArguments(nativeArgs).optionValues["--mcp-config"] ?? []).map(value => (
    value.startsWith("{") ? JSON.parse(value).mcpServers : readJson(value).mcpServers
  ));
}

test("a normal launch supplies Figma alongside user and CLI servers and clears only its cache entry", async t => {
  const homeDir = fixture(t);
  writeClaudeFigmaGrant({ homeDir, email, native: nativeGrant() });
  const personal = { personal: { type: "http", url: "https://user.example.invalid" } };
  writeJson(path.join(homeDir, ".claude.json"), { mcpServers: personal });
  const prepared = await preflight(homeDir);
  const cache = path.join(prepared.configDir, "mcp-needs-auth-cache.json");
  writeJson(cache, { [FIGMA_MCP_NAME]: 123, figma: 456, other: 789 });
  const cli = { cli: { type: "http", url: "https://cli.example.invalid" } };
  const [userConfig, figmaConfig, cliConfig] = await configuredServers(prepared, homeDir,
    ["--mcp-config", JSON.stringify({ mcpServers: cli }), "--", "--strict-mcp-config"]);
  assert.deepEqual(userConfig, personal);
  assert.deepEqual(cliConfig, cli);
  assert.deepEqual(readJson(cache), { figma: 456, other: 789 });
  const { url, type, headersHelper } = figmaConfig[FIGMA_MCP_NAME];
  assert.equal(url, FIGMA_MCP_URL);
  assert.equal(type, "http");
  assert.equal(headersHelper.includes("synthetic-"), false);
  assert.equal(fs.existsSync(path.join(prepared.configDir, ".credentials.json")), false);

  const helper = (name = FIGMA_MCP_NAME, url = FIGMA_MCP_URL) => spawnSync("/bin/sh", ["-c", headersHelper], {
    encoding: "utf8", env: { CLAUDE_CODE_MCP_SERVER_NAME: name, CLAUDE_CODE_MCP_SERVER_URL: url },
  });
  assert.deepEqual(JSON.parse(helper().stdout), { Authorization: "Bearer synthetic-access" });
  writeClaudeFigmaGrant({ homeDir, email, native: nativeGrant("rotated-access") });
  assert.deepEqual(JSON.parse(helper().stdout), { Authorization: "Bearer rotated-access" });
  for (const result of [helper("figma"), helper(FIGMA_MCP_NAME, `${FIGMA_MCP_URL}/`)]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout + result.stderr, "");
  }
  writeClaudeFigmaGrant({ homeDir, email, native: nativeGrant("expired-access", Date.now() - 1) });
  assert.equal(helper().stdout, "");
});

test("strict and proxied launches, user collisions, expired grants, and Figma staging skip implicit Figma", async t => {
  const homeDir = fixture(t);
  writeClaudeFigmaGrant({ homeDir, email, native: nativeGrant() });
  const prepared = await preflight(homeDir);
  const cache = path.join(prepared.configDir, "mcp-needs-auth-cache.json");
  const cached = { [FIGMA_MCP_NAME]: true, other: true };
  writeJson(cache, cached);
  assert.deepEqual(await configuredServers(prepared, homeDir, ["--strict-mcp-config", "hello"]), []);
  assert.deepEqual(await configuredServers(prepared, homeDir, ["hello"], { label: "label", profileRef: "office" }), []);

  const ownServer = { [FIGMA_MCP_NAME]: { type: "http", url: "https://existing.example.invalid" } };
  assert.deepEqual(await configuredServers(prepared, homeDir, ["--mcp-config", JSON.stringify({ mcpServers: ownServer })]), [ownServer]);
  writeJson(path.join(homeDir, ".mcp.json"), { mcpServers: ownServer });
  assert.deepEqual(await configuredServers(prepared, homeDir, ["hello"]), []);
  fs.unlinkSync(path.join(homeDir, ".mcp.json"));

  const root = ensureClaudeFigmaGrantRoot({ homeDir });
  const stage = path.join(root, ".login-staging-12345678-1234-4123-8123-123456789abc");
  fs.mkdirSync(stage, { mode: 0o700 });
  const staged = await preflight(homeDir, stage);
  assert.equal(staged.loginStaging, true);
  assert.equal(staged.userHooksPath, null);
  assert.equal(staged.userMcpConfigPath, null);
  assert.deepEqual(await configuredServers(staged, homeDir, ["hello"]), []);
  await assert.rejects(preflight(homeDir, path.join(root, ".login-staging")), /exact label or login-staging home/);
  const symlink = path.join(root, ".login-staging-12345678-1234-4123-8123-123456789abd");
  fs.symlinkSync(prepared.homeDir, symlink);
  await assert.rejects(preflight(homeDir, symlink), /private Figma login-staging home/);

  writeClaudeFigmaGrant({ homeDir, email, native: nativeGrant("expired-access", Date.now() - 1) });
  assert.deepEqual(await configuredServers(prepared, homeDir, ["hello"]), []);
  assert.deepEqual(readJson(cache), cached);
});
