#!/usr/bin/env node
// Synthetic, offline native-library fixture. Never use a normal account home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
assert.notEqual(process.getuid(), 0);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(repo, "native/codex/config-state/target/debug/aimgr-codex-config-state");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-inputs-"));
fs.chmodSync(root, 0o700);
const taskHome = path.join(root, "home"), cwd = path.join(root, "project");
const codexHome = path.join(taskHome, ".codex");
fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(cwd);
const settings = 'check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n';
fs.writeFileSync(path.join(codexHome, "config.toml"), settings, { mode: 0o600 });
const base = { operation: "inputs", artifact_set: "a".repeat(64), codex_home: codexHome,
  cwd, config: [], forced_config: "", forced_requirements: "" };
const environment = { HOME: taskHome, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: root };
function start(request) {
  const child = spawn(binary, [], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const output = [], errors = [];
  child.stdout.on("data", b => output.push(b)); child.stderr.on("data", b => errors.push(b));
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const done = once(child, "close").then(([code, signal]) => {
    clearTimeout(timer);
    return { code, signal, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() };
  });
  return { child, done };
}
async function call(request) {
  const result = await start(request).done;
  assert.equal(result.code, 0, `native helper exit ${result.code}/${result.signal}: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
const before = fs.readdirSync(codexHome);
const inventory = await call(base);
assert.equal(inventory.initialized, false);
assert.equal(inventory.database_files.length, 7);
assert.deepEqual(fs.readdirSync(codexHome), before, "read-only projection must not initialize state");
console.log("PASS read-only native projection without state creation");

const mcp = { ...base, operation: "mcp_inputs", config: ['mcp_oauth_credentials_store="keyring"',
  'mcp_servers.synthetic.url="https://fixture.invalid/mcp"'] };
const token = { server_name: "synthetic", url: "https://fixture.invalid/mcp", client_id: "fixture",
  token_response: { access_token: "SYNTHETIC_NATIVE_TOKEN", token_type: "bearer" }, expires_at: null };
const mcpResult = await call({ ...mcp, mcp_values: [JSON.stringify(token)] });
assert.equal(mcpResult.mcp_store, "keyring", "official input mode must not use the library's development-version File rewrite");
assert.equal(mcpResult.mcp_keyring_backend, "direct");
assert.ok(mcpResult.mcp_servers.some(s => s.name === "synthetic" && s.url === token.url && s.ordinary_oauth));
assert.equal(inventory.mcp_servers, undefined, "credential URLs belong only on the maintenance pipe");
const invalidToken = await start({ ...mcp, mcp_values: [JSON.stringify({ ...token, token_response: {} })] }).done;
assert.equal(invalidToken.code, 125);
assert.ok(!invalidToken.stderr.includes(token.token_response.access_token));
assert.deepEqual(fs.readdirSync(codexHome), before);
console.log("PASS maintenance-only HTTP identities and unchanged native token deserialization");

const initialize = { ...base, operation: "initialize" };
const cold = await Promise.all([call(initialize), call(initialize), call(initialize)]);
assert.ok(cold.every(result => result.initialized));
for (const filename of inventory.database_files) {
  assert.equal(fs.readFileSync(filename).subarray(0, 16).toString(), "SQLite format 3\0");
}
await call(initialize);
console.log("PASS concurrent cold initialization of seven native databases and native warm reopen");

const lazyHistory = inventory.database_files.find(file => /history/.test(path.basename(file)));
assert.ok(lazyHistory);
fs.renameSync(lazyHistory, lazyHistory + ".retained");
await call(initialize);
assert.equal(fs.readFileSync(lazyHistory).subarray(0, 16).toString(), "SQLite format 3\0");
console.log("PASS missing lazy-history database is restored by native initialization");

const failed = await start({ ...base, config: ['model_instructions_file="SYNTHETIC_SECRET_CANARY'] }).done;
assert.equal(failed.code, 125);
assert.equal(failed.stdout, "");
assert.ok(!failed.stderr.includes("SYNTHETIC_SECRET_CANARY"));
assert.match(failed.stderr, /no native configuration or credential details were logged/);
console.log("PASS invalid input reports no configuration contents");
console.log(JSON.stringify({ fixture: path.basename(root), platform: process.platform, databases: inventory.database_files.length }));
