#!/usr/bin/env node
// Synthetic keyring interoperability only, on the designated isolated Linux
// host inside a loopback-only namespace and a fresh dbus-run-session.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { codexMcpKey, decodeCodexMcpFile, codexMcpKeyring, codexMcpTokensEqual } from "../src/credentials/codex-mcp-migration.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";

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
  command: path.resolve("native/codex/mcp-keyring/target/release/aimgr-codex-mcp-keyring"), env,
});
const server = { name: "fixture_" + path.basename(root).replaceAll("-", "_"), url: "http://127.0.0.1:1/mcp" };
const fileEntry = { server_name: server.name, server_url: server.url, client_id: "SYNTHETIC_CLIENT",
  access_token: "SYNTHETIC_MCP_ACCESS", refresh_token: "SYNTHETIC_MCP_REFRESH", expires_at: Date.now() + 3_600_000,
  scopes: ["read", "write"] };
const [converted] = decodeCodexMcpFile(JSON.stringify({ legacy: fileEntry }), [server]);
const source = path.join(homeDir, ".codex", "config.toml");
fs.writeFileSync(source, `mcp_oauth_credentials_store="keyring"\n[features]\napps=false\nsecret_auth_storage=false\n[mcp_servers.${server.name}]\nurl=${JSON.stringify(server.url)}\n`, { mode: 0o600 });
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
    try { assert.equal((await keyring({ operation: "load", account: converted.key })).value, null); break; }
    catch (error) { if (attempt === 9 || daemon.exitCode !== null) throw error; await delay(100); }
  }
  const inserted = await keyring({ operation: "insert-if-absent", account: converted.key, value: JSON.stringify(converted.token) });
  assert.equal(inserted.inserted, true);
  assert.equal(codexMcpTokensEqual(JSON.parse(inserted.value), converted.token), true);
  for (const [account, protectedLaunch] of [["synthetic-A", false], ["synthetic-A", true], ["synthetic-B", true]]) {
    const entries = JSON.parse(await native(account, protectedLaunch));
    assert.ok(["o_auth", "oauth"].includes(entries.find(entry => entry.name === server.name)?.auth_status), "native recognizes converted OAuth tokens");
  }
  // Native removal is the interoperability/revocation oracle, not the helper.
  await native("synthetic-B", true, ["mcp", "logout", server.name]);
  assert.equal((await keyring({ operation: "load", account: codexMcpKey(server.name, server.url) })).value, null);
  for (const account of ["synthetic-A", "synthetic-B"]) {
    const entries = JSON.parse(await native(account, true));
    assert.ok(!["o_auth", "oauth"].includes(entries.find(entry => entry.name === server.name)?.auth_status), "native restart cannot resurrect removed tokens");
  }
  process.stdout.write(JSON.stringify({ fixture: root, convertedNativeReads: 3, protectedAccountHomes: 2,
    nativeLogoutRemovedKey: true, restartsWithoutResurrection: 2 }) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}; private evidence ${root}\n`); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, "native.json"), JSON.stringify(outputs, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "keyring.log"), Buffer.concat(daemonLogs), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "dbus.log"), Buffer.concat(monitorLogs), { mode: 0o600 });
  if (monitor.exitCode === null) { monitor.kill("SIGTERM"); await once(monitor, "close"); }
  if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await once(daemon, "close"); }
}
