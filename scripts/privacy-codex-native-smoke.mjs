#!/usr/bin/env node
// Synthetic offsite fixture. Linux refuses execution outside loopback-only netns.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { superviseCodexAppServerStdio } from "../src/io/codex-app-server-stdio.js";
import { parseCodexSettings } from "../src/io/codex-settings-toml.js";

const base = "/opt/aimgr-state-audit";
if (!fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) || process.getuid() === 0) throw new Error("Ordinary user on designated offsite host required.");
if (process.platform === "linux" && Object.keys(os.networkInterfaces()).join() !== "lo") throw new Error("A fresh loopback-only network namespace is required.");
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "native-"));
const homeDir = path.join(root, "home"), cwd = path.join(root, "project");
fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true, mode: 0o700 });
fs.mkdirSync(cwd);
fs.mkdirSync(path.join(homeDir, ".codex", "skills", "review"), { recursive: true });
fs.mkdirSync(path.join(homeDir, ".codex", "skills", "second"), { recursive: true });
fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), 'model="synthetic-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\n[skills]\nconfig=[{path="./skills/review",enabled=false}]\n');
const manyRoots = process.argv.includes("--many-roots");
if (manyRoots) {
  const config = path.join(homeDir, ".codex", "config.toml");
  const roots = Array.from({length:300}, (_,i) => path.join(root,"inputs",String(i)));
  for (const folder of roots) fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(config, 'default_permissions="capacity"\n' + fs.readFileSync(config,"utf8")
    + '\n[permissions.capacity]\nextends=":workspace"\n[permissions.capacity.workspace_roots]\n'
    + roots.map(folder => `${JSON.stringify(folder)}=true\n`).join(""));
}
const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" };
const environment = readCodexEnvironment();
const options = { homeDir, env, environment, accountId: "synthetic-account-A", label: "synthetic-A" };
const token = payload => `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const claims = { "https://api.openai.com/auth": { chatgpt_account_id: options.accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user" } };
const credential = { access: token({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }),
  idToken: token(claims), refresh: "SYNTHETIC_REFRESH_ONLY", accountId: options.accountId };
const metadataRequests = [];
const service = http.createServer((req, res) => {
  metadataRequests.push({ method: req.method, url: req.url });
  const value = req.url.startsWith("/models") ? { models: [] }
    : req.url === "/api/codex/accounts/check" ? { accounts: [{ id: options.accountId, plan_type: "plus", structure: "personal",
      workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }],
      account_ordering: [options.accountId], default_account_id: options.accountId }
    : req.url === "/api/codex/settings/user" ? {} : null;
  res.writeHead(value ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(value ?? { error: "not_found" }));
});
service.listen(0, "127.0.0.1"); await once(service, "listening");
const source = path.join(homeDir, ".codex", "config.toml");
fs.writeFileSync(source, `chatgpt_base_url="http://127.0.0.1:${service.address().port}"\n` + fs.readFileSync(source, "utf8"));
saveLocalCodexLogin(options, credential);
const prepared = prepareCodexAccountState(options);
let invocation, child, transport;
const output = [], errors = [];
let launchStarted, initializedAfterMs;
try {
  invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin", "codex"), homeDir, cwd, env,
    args: ["app-server", "--listen", "stdio://"], ownedAppServer: true });
  if (manyRoots && Number(invocation.args[5]) <= 256) throw new Error("Fixture must exercise more than 256 exact native write grants.");
  launchStarted = Date.now();
  child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env,
    stdio: ["pipe", "pipe", "pipe", invocation.environmentFd], detached: true });
  invocation.closeEnvironment();
  const clientInput = new PassThrough(), clientOutput = new PassThrough();
  transport = superviseCodexAppServerStdio({ input: clientInput, output: clientOutput, child, entry: invocation.entries.at(-1),
    flush: invocation.flushSettings, onError: error => errors.push(`AIM adapter: ${error.message}\n`) });
  const lines = createInterface({ input: clientOutput });
  child.stderr.on("data", value => errors.push(value.toString()));
  let configSeen = false;
  const handleLine = async line => {
    const value = JSON.parse(line); output.push(value);
    if (value.id === 1) {
      initializedAfterMs = Date.now() - launchStarted;
      clientInput.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      clientInput.write(JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: true, cwd } }) + "\n");
    }
    if (value.id === 2) {
      configSeen = !value.error;
      // An ordinary external edit must retain its relative path and become
      // visible in the same native owner, including the enable/disable switch.
      const source = path.join(homeDir, ".codex", "config.toml");
      fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("enabled=false", "enabled=true"));
      await invocation.flushSettings();
      clientInput.write(JSON.stringify({ id: 3, method: "config/read", params: { includeLayers: true, cwd } }) + "\n");
    }
    if (value.id === 3) {
      clientInput.write(JSON.stringify({ id: 4, method: "config/batchWrite", params: { reloadUserConfig: true, edits: [
        { keyPath: "skills.config", mergeStrategy: "replace", value: [{ path: "./skills/second", enabled: false }] },
        { keyPath: "model", mergeStrategy: "replace", value: "synthetic-second-model" },
      ] } }) + "\n");
    }
    if (value.id === 4) clientInput.write(JSON.stringify({ id: 5, method: "config/read", params: { includeLayers: true, cwd } }) + "\n");
    if (value.id === 5) clientInput.write(JSON.stringify({ id: 6, method: "config/value/write", params: {
      keyPath: "model_instructions_file", mergeStrategy: "replace", value: "./must-not-persist.md", expectedVersion: "synthetic-stale-version",
    } }) + "\n");
    if (value.id === 6) clientInput.write(JSON.stringify({ id: 7, method: "config/value/write", params: {
      keyPath: "tui.screen_reader_detection_done", mergeStrategy: "replace", value: true,
    } }) + "\n");
    if (value.id === 7) clientInput.write(JSON.stringify({ id: 8, method: "config/value/write", params: {
      keyPath: 'tui.model_availability_nux."gpt-6.1-sol"', mergeStrategy: "replace", value: 1,
    } }) + "\n");
    if (value.id === 8) clientInput.write(JSON.stringify({ id: 9, method: "config/value/write", params: {
      keyPath: 'tui.model_availability_nux."gpt-6.1-sol"', mergeStrategy: "replace", value: 2,
    } }) + "\n");
    if (value.id === 9) clientInput.write(JSON.stringify({ id: 10, method: "config/read", params: { includeLayers: true, cwd } }) + "\n");
    if (value.id === 10) clientInput.end();
  };
  lines.on("line", line => { handleLine(line).catch(error => { errors.push(`Fixture: ${error.message}\n`); clientInput.end(); }); });
  clientInput.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "aim_privacy_fixture", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
  const timeout = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, manyRoots ? 120_000 : 25_000);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  clearTimeout(timeout); await transport.finished; await transport.close(); lines.close();
  fs.writeFileSync(path.join(root, "stderr.log"), errors.join(""), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "protocol.json"), JSON.stringify(output, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(metadataRequests, null, 2), { mode: 0o600 });
  const config = output.find(value => value.id === 2)?.result?.config;
  const expectedSkill = path.join(homeDir, ".codex", "skills", "review");
  const skillPath = config?.skills?.config?.[0]?.path;
  const live = output.find(value => value.id === 3)?.result?.config;
  const updated = output.find(value => value.id === 5)?.result?.config;
  const authored = parseCodexSettings(fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8")).value;
  const summary = { fixture: root, exit, configSeen, initializedAfterMs, nativeWriteRoots: Number(invocation.args[5]), skillPathMatchesOrigin: skillPath === expectedSkill,
    mcpSessionDefault: config?.mcp_oauth_credentials_store === "keyring"
      && output.find(value => value.id === 2)?.result?.origins?.mcp_oauth_credentials_store?.name?.type === "sessionFlags",
    mcpDefaultSurvivesReload: updated?.mcp_oauth_credentials_store === "keyring",
    mcpDefaultNotPublished: authored.mcp_oauth_credentials_store === undefined,
    liveExternalTogglePreserved: live?.skills?.config?.[0]?.path === expectedSkill && live.skills.config[0].enabled === true,
    batchAccepted: ["ok", "okOverridden"].includes(output.find(value => value.id === 4)?.result?.status),
    batchPathMatchesOrigin: updated?.skills?.config?.[0]?.path === path.join(homeDir, ".codex", "skills", "second"),
    authoredRelativePathPreserved: authored.skills?.config?.[0]?.path === "./skills/second",
    authoredModelUpdated: authored.model === "synthetic-second-model",
    rejectedWritePreserved: !authored.model_instructions_file && output.find(value => value.id === 6)?.error?.data?.config_write_error_code === "configVersionConflict",
    nativeRepeatedTableEdits: [7, 8, 9].every(id => ["ok", "okOverridden"].includes(output.find(value => value.id === id)?.result?.status))
      && output.find(value => value.id === 10)?.result?.config?.tui?.model_availability_nux?.["gpt-6.1-sol"] === 2
      && authored.tui?.model_availability_nux?.["gpt-6.1-sol"] === 2,
    initialized: output.some(value => value.id === 1 && value.result), errorCount: output.filter(value => value.error).length };
  process.stdout.write(JSON.stringify(summary) + "\n");
  if (exit.code !== 0 || !configSeen || !summary.skillPathMatchesOrigin || !summary.liveExternalTogglePreserved || !summary.batchAccepted || !summary.batchPathMatchesOrigin
    || !summary.authoredRelativePathPreserved || !summary.authoredModelUpdated || !summary.rejectedWritePreserved || summary.errorCount !== 1
    || !summary.mcpSessionDefault || !summary.mcpDefaultSurvivesReload || !summary.mcpDefaultNotPublished || !summary.nativeRepeatedTableEdits) {
    process.stderr.write(errors.join("").slice(-6000)); process.exitCode = 1;
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await transport?.close();
  await invocation?.close();
  service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
