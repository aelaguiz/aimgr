import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { resolveCodexLaunchInputs, codexPrivacyEnvironment } from "../../src/privacy/codex-launch-inputs.js";
import { validateCodexExporters } from "../../src/privacy/codex-managed-policy.js";

test("system and CLI exporter inputs are admitted without granting writable settings targets", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const systemConfigFile = path.join(root, "system.toml"), view = path.join(root, "view.toml");
  fs.writeFileSync(view, ""); fs.symlinkSync(view, path.join(codexHome, "config.toml"));
  fs.writeFileSync(systemConfigFile, '[otel]\ntrace_exporter={"otlp-http"={endpoint="https://ab.chatgpt.com/v1"}}\n');
  const options = { prepared: { sharedHome, codexHome }, homeDir: root, env: {}, systemConfigFile,
    parsedArgs: { cwd, images: [], directories: [], config: [] }, spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.equal(inputs.writes.includes(view), false);
  assert.ok(inputs.reads.includes(systemConfigFile));
  assert.throws(() => validateCodexExporters(inputs.configurations), /known provider/);
  fs.writeFileSync(systemConfigFile, "");
  options.parsedArgs.config = ['otel.exporter={"otlp-grpc"={endpoint="https://api.openai.com"}}'];
  assert.throws(() => validateCodexExporters(resolveCodexLaunchInputs(options).configurations), /known provider/);
});

test("selected account cannot be replaced by inherited vendor auth or originator variables", () => {
  const env = { PATH: "/tools", HOME: "/home/user", TERM: "xterm-256color", CODEX_ACCESS_TOKEN: "synthetic-token",
    CODEX_API_KEY: "synthetic-key", OPENAI_API_KEY: "synthetic-key", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "private-device",
    TERM_PROGRAM_VERSION: "private-version", VTE_VERSION: "private-version", TOOL_INPUT: "keep" };
  const result = codexPrivacyEnvironment({ env, prepared: { codexHome: "/private/codex", sharedHome: "/shared/codex" },
    artifact: { command: "/approved/codex", artifactSet: "fixture" }, scratch: "/scratch" });
  for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "TERM_PROGRAM_VERSION", "VTE_VERSION"]) assert.equal(result[key], undefined);
  assert.equal(result.OPENAI_API_KEY, env.OPENAI_API_KEY, "ordinary SDK tools retain their independent API credential");
  assert.equal(result.TOOL_INPUT, "keep"); assert.equal(result.TERM, env.TERM);
  assert.equal(result.HOME, env.HOME); assert.equal(result.CODEX_HOME, "/private/codex");
});

test("configured writable roots outside the project keep their native write permission", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-writable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  const extra = path.join(root, "outside-project");
  for (const dir of [sharedHome, codexHome, cwd, extra]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(sharedHome, "config.toml"), '[sandbox_workspace_write]\nwritable_roots=["../outside-project"]\n');
  const inputs = resolveCodexLaunchInputs({ prepared: { sharedHome, codexHome }, homeDir: root, env: {},
    parsedArgs: { cwd, images: [], directories: [], config: [] }, systemConfigFile: path.join(root, "absent"),
    spawnSyncImpl: () => ({ status: 1 }) });
  assert.ok(inputs.writes.includes(extra)); assert.equal(inputs.reads.includes(extra), false);
});

test("Linux native MCP gets only the selected existing D-Bus socket, not its directory", { skip: process.platform !== "linux" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const socket = path.join(root, "session-bus");
  const server = net.createServer(); server.listen(socket); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { prepared: { sharedHome, codexHome }, homeDir: root,
    env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${encodeURIComponent(socket)},guid=synthetic` },
    systemConfigFile: path.join(root, "absent"), parsedArgs: { cwd, images: [], directories: [], config: [] },
    spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.ok(inputs.writes.includes(fs.realpathSync(socket)));
  assert.equal(inputs.writes.includes(root), false);
  options.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}`;
  assert.equal(resolveCodexLaunchInputs(options).writes.includes(root), false);
});
