import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runClaudeCli, runClaudeCliNoninteractive } from "../../src/targets/claude-runner.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { listen } from "./socks-fixture.js";
import { prepareClaudeNativeRoute, assertLocalClaudeProfileStopped } from "../../src/network/claude-native-route.js";
import { createNativeRoutineFixture } from "./native-routine-fixture.js";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("../../native/claude/linux_proxy.py", import.meta.url));

test("native A1/A2/B route without proxy variables and stop when the tunnel process exits", { skip: process.env.AIMGR_TEST_NATIVE_PROXY !== "1", timeout: 180000 }, async (t) => {
  assert.equal(process.platform, "linux");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-native-runner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const children = [];
  const services = ["aimgr-claude-proxy-test_a.service", "aimgr-claude-proxy-test_b.service"];
  const received = [];
  const modelRequests = [];
  const modelRoutes = [];
  let nativeTurn, savedNativeSessionId;
  let exitCheckDelayMs = 0;
  const origin = http.createServer(async (req, res) => {
    received.push({ route: req.socket.remoteAddress, path: req.url, issuedAt: Number(req.headers["x-issued-at"]) });
    if (req.url.startsWith("/v1/messages")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      modelRequests.push(body);
      modelRoutes.push(req.socket.remoteAddress);
      if (JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")) return;
      const routine = JSON.stringify(body.messages).includes("ROUTINE_SUCCESS_CANARY");
      const wantsMcp = JSON.stringify(body.messages).includes("MCP_STDIO_CANARY");
      const wantsSubagent = body.messages.some(message => message.role === "user" && (typeof message.content === "string"
        ? message.content.includes("NATIVE_SUBAGENT_PARENT")
        : message.content.some(block => block.type === "text" && block.text.includes("NATIVE_SUBAGENT_PARENT"))));
      const isChild = JSON.stringify(body.messages).includes("NATIVE_CHILD_TASK") && !wantsSubagent;
      const mcpTool = body.tools.find(tool => tool.name.includes("stdio") && tool.name.endsWith("echo"));
      const toolName = wantsSubagent ? "Agent" : wantsMcp ? mcpTool?.name ?? "ToolSearch" : "Bash";
      const alreadyRan = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_use" && (wantsSubagent ? block.name === "Agent" : wantsMcp ? block.name.includes("stdio") && block.name.endsWith("echo") : block.name === "Bash")));
      // Current Claude defers MCP tool definitions until ToolSearch discovers
      // them. Exercise that normal discovery before asking for the real tool.
      const input = wantsSubagent ? { description: "Synthetic child task", prompt: "Run the synthetic Bash task. NATIVE_CHILD_TASK.", subagent_type: "general-purpose" }
        : wantsMcp ? (mcpTool ? { text: "MCP_TOOL_RESULT_CANARY" } : { query: "+stdio echo", max_results: 5 })
          : { command: isChild ? "printf subagent-ok > child-proof.txt" : "printf native-tool-ok > tool-proof.txt", description: "Write synthetic test proof" };
      // The CLI deduplicates tool calls by id. Discovery and invocation must
      // have separate ids, just as separate real model responses do.
      const content = alreadyRan ? { type: "text", text: routine ? "NATIVE_MOCK_DONE\nAIM-JOB: done" : "NATIVE_MOCK_DONE" } : { type: "tool_use", id: `tool_fixture_${modelRequests.length}`, name: toolName, input };
      const message = { id: `msg_native_${modelRequests.length}`, type: "message", role: "assistant", model: body.model, content: [content], stop_reason: alreadyRan ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: content.type === "text" ? { type: "text", text: "" } : { ...content, input: {} } },
          { type: "content_block_delta", index: 0, delta: content.type === "text" ? { type: "text_delta", text: content.text } : { type: "input_json_delta", partial_json: JSON.stringify(content.input) } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ];
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); }
      return;
    }
    if (req.url === "/exit") { await delay(exitCheckDelayMs); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: req.socket.remoteAddress })); }
    else res.end(req.socket.remoteAddress);
  });
  const originPort = await listen(origin, "0.0.0.0");
  const fixture = new URL("./socks-fixture.js", import.meta.url).href;
  await exec("sudo", ["ip", "address", "add", "198.18.0.10/32", "dev", "lo"]);
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await closed;
        clearTimeout(timer);
      }
    }
    await exec("sudo", ["systemctl", "stop", ...services]);
    await exec("sudo", ["ip", "address", "del", "198.18.0.10/32", "dev", "lo"]);
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
  });
  const startProxy = async (sourceAddress, port = 0) => {
    const script = `import { startSocks } from ${JSON.stringify(fixture)}; const s = await startSocks({ sourceAddress: ${JSON.stringify(sourceAddress)}, port: ${port}, destinations: { "198.18.0.10": ${originPort} } }); console.log(s.port);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    const boundPort = Number((await once(child.stdout, "data"))[0].toString().trim());
    assert.ok(boundPort > 0);
    return { child, port: boundPort };
  };
  const [a, b] = await Promise.all([startProxy("127.0.0.2"), startProxy("127.0.0.3")]);
  const manifest = { user: process.env.USER, profiles: { test_a: { socksPort: a.port, redirectPort: 15085, expectedExits: ["127.0.0.2"], exitCheckUrl: `http://198.18.0.10:${originPort}/exit` }, test_b: { socksPort: b.port, redirectPort: 15086, expectedExits: ["127.0.0.3"], exitCheckUrl: `http://198.18.0.10:${originPort}/exit` } } };
  const binding = name => JSON.stringify({ socksHost: "127.0.0.1", ...manifest.profiles[name] });
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const installScript = fileURLToPath(new URL("../../scripts/install-claude-proxy-linux.sh", import.meta.url));
  // Exercise activation from a cold routing service, as on first install.
  // In particular, systemd's restore process must not deadlock on the
  // installer lock held by its caller.
  await exec("sudo", ["systemctl", "stop", "aimgr-claude-routing.service"]);
  const installer = spawn("sudo", ["bash", installScript, manifestPath], { stdio: ["ignore", "pipe", "pipe"] });
  let installError = "";
  installer.stderr.on("data", (chunk) => { installError += chunk; });
  const installed = once(installer, "exit");
  assert.equal((await installed)[0], 0, installError);
  await exec("sudo", ["systemctl", "restart", "aimgr-claude-routing.service"]);
  const destination = `http://198.18.0.10:${originPort}`;
  const direct = await (await fetch(`${destination}/control`)).text();
  assert.ok(!["127.0.0.2", "127.0.0.3"].includes(direct), "direct control differs from both proxy routes");
  // Exercise the actual runner, Python wrapper, IPC supervisor and child together.
  const receipt = path.join(root, "receipt.json");
  const ticks = path.join(root, "ticks");
  const fixtureCommand = path.join(root, "claude-fixture.mjs");
  await fs.writeFile(fixtureCommand, `#!${process.execPath}\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME, token: process.env.ORDINARY_TOOL_TOKEN, telemetry: process.env.DISABLE_TELEMETRY, errors: process.env.DISABLE_ERROR_REPORTING, config: process.env.CLAUDE_CONFIG_DIR })); setInterval(() => fs.appendFileSync(${JSON.stringify(ticks)}, "x"), 50);`, { mode: 0o700 });
  const configDir = path.join(root, ".aimgr", "claude-homes", "a", ".claude");
  const profile = { profileRef: "test_a", label: "a", socksHost: "127.0.0.1", socksPort: a.port, expectedExits: ["127.0.0.2"], exitCheckUrl: `${destination}/exit` };
  const admitted = await prepareClaudeNativeRoute({ profile, command: process.execPath, args: ["-e", "process.exit(0)"] });
  const changedManifest = structuredClone(manifest);
  changedManifest.profiles.test_a.expectedExits.push("127.0.0.3");
  await fs.writeFile(manifestPath, JSON.stringify(changedManifest));
  await exec("sudo", ["bash", installScript, manifestPath]);
  await assert.rejects(exec(admitted.command, admitted.args), error => error.code === 125,
    "an install between JS preflight and native admission invalidates the old binding");
  const freshAdmission = await prepareClaudeNativeRoute({ profile: { ...profile, expectedExits: changedManifest.profiles.test_a.expectedExits }, command: process.execPath, args: ["-e", "process.exit(0)"] });
  await exec(freshAdmission.command, freshAdmission.args);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await exec("sudo", ["bash", installScript, manifestPath]);
  // Rehearse the scheduled transition with a pre-change writer and saved
  // state. Failed installation/verification must leave stopped work stopped.
  const savedHistory = path.join(root, "pre-change-history.jsonl");
  const historyText = '{"type":"user","message":"PRE_CHANGE_HISTORY_CANARY"}\n';
  await fs.writeFile(savedHistory, historyText);
  const oldWrites = path.join(root, "old-writer-count");
  const oldWriter = spawn(process.execPath, ["-e", `const fs=require("fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(oldWrites)},"x"),30)`]);
  children.push(oldWriter);
  for (let n = 0; n < 40; n++) { try { await fs.stat(oldWrites); break; } catch { await delay(25); } }
  const oldExit = once(oldWriter, "exit"); oldWriter.kill("SIGTERM"); await oldExit;
  const writesAtStop = await fs.readFile(oldWrites, "utf8");
  await exec("sudo", ["systemctl", "stop", ...services]);
  const invalidManifest = structuredClone(manifest);
  invalidManifest.profiles.test_b.redirectPort = invalidManifest.profiles.test_a.redirectPort;
  await fs.writeFile(manifestPath, JSON.stringify(invalidManifest));
  await assert.rejects(exec("sudo", ["bash", installScript, manifestPath]), error => error.code === 125);
  await assert.rejects(exec("python3", [helper, "run", "test_a", binding("test_a"), "--", process.execPath, "-e", "process.exit(9)"]), error => error.code === 125);
  assert.equal(await fs.readFile(savedHistory, "utf8"), historyText);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await exec("sudo", ["bash", installScript, manifestPath]);
  // A deliberately wrong post-activation verification refuses admission;
  // the operator's failure procedure stops the affected adapter before repair.
  await assert.rejects(prepareClaudeNativeRoute({ profile: { ...profile, expectedExits: ["127.0.0.9"] }, command: process.execPath, args: [] }), { code: "native_proxy_mismatch" });
  await exec("sudo", ["systemctl", "stop", services[0]]);
  await assert.rejects(exec("python3", [helper, "run", "test_a", binding("test_a"), "--", process.execPath, "-e", "process.exit(9)"]), error => error.code === 125);
  assert.equal(await fs.readFile(savedHistory, "utf8"), historyText);
  assert.equal(await fs.readFile(oldWrites, "utf8"), writesAtStop, "old scheduled writer stays stopped throughout failure and repair");
  await exec("sudo", ["systemctl", "start", services[0]]);
  console.log(JSON.stringify({ transition: { oldWriterStopped: true, failedInstallClosed: true, failedVerificationClosed: true, historyPreserved: true } }));
  const controller = new AbortController();
  let control;
  const running = runClaudeCli({ command: fixtureCommand, userHomeDir: root, homeDir: path.dirname(configDir), configDir, cwd: root, env: { ...process.env, ORDINARY_TOOL_TOKEN: "synthetic-tool-value" }, egressProfile: profile, signal: controller.signal, registerProcessControl: (value) => { control = value; } });
  t.after(() => controller.abort());
  let observed;
  for (let i = 0; i < 60; i++) {
    try { observed = JSON.parse(await fs.readFile(receipt, "utf8")); break; } catch { await delay(50); }
  }
  assert.ok(observed, "the actual runner launched its child");
  assert.equal(observed.cwd, root);
  assert.equal(observed.home, root);
  assert.equal(observed.token, "synthetic-tool-value");
  assert.equal(observed.telemetry, "1");
  assert.equal(observed.errors, "1");
  assert.equal(observed.config, configDir);
  await delay(100);
  assert.equal(await control.pause(), true, "IPC pause survives the routing wrapper");
  const paused = await fs.readFile(ticks, "utf8");
  await delay(150);
  assert.equal(await fs.readFile(ticks, "utf8"), paused);
  assert.equal(await control.resume(), true);
  await delay(100);
  assert.ok((await fs.readFile(ticks, "utf8")).length > paused.length);
  controller.abort();
  const stopped = await running;
  assert.ok(stopped.status !== 0 || stopped.signal);
  assert.throws(() => process.kill(observed.pid, 0), { code: "ESRCH" });
  if (process.env.AIMGR_TEST_CLAUDE_BIN) {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Preserve NATIVE_INSTRUCTION_CANARY and this directory.\n");
    const mockSettings = path.join(root, "mock-settings.json");
    await fs.writeFile(mockSettings, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: "synthetic-native-key" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "printf start >> hook-proof.txt" }] }],
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "printf tool >> hook-proof.txt" }] }],
      },
    }), { mode: 0o600 });
    nativeTurn = async (prompt, extraArgs = []) => {
      let stdout = "";
      const result = await runClaudeCliNoninteractive({ command: process.env.AIMGR_TEST_CLAUDE_BIN, userHomeDir: root, homeDir: path.dirname(configDir), configDir, cwd: root,
      args: ["-p", prompt, "--settings", mockSettings, "--output-format", "json", "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6", "--max-turns", "3", ...extraArgs],
      env: { ...process.env, ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: "synthetic-native-key", API_TIMEOUT_MS: "3000" }, egressProfile: profile, timeoutMs: 45000,
      spawnImpl: (...args) => {
        const child = spawn(...args);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        return child;
      } });
      return { ...result, stdout };
    };
    const result = await nativeTurn("Perform the synthetic Bash test. NATIVE_HISTORY_CANARY.");
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(root, "tool-proof.txt"), "utf8"), "native-tool-ok");
    assert.ok(modelRequests.some(body => JSON.stringify(body).includes("NATIVE_INSTRUCTION_CANARY")));
    assert.ok(modelRequests.some(body => JSON.stringify(body.messages).includes("tool_result")));
    assert.match(await fs.readFile(path.join(root, "hook-proof.txt"), "utf8"), /start.*tool/);
    const sessionId = JSON.parse(result.stdout).session_id;
    savedNativeSessionId = sessionId;
    assert.ok(sessionId);
    const resumed = await nativeTurn("Continue from the previous saved conversation.", ["--resume", sessionId]);
    assert.equal(resumed.status, 0, JSON.stringify(resumed));
    assert.equal(JSON.parse(resumed.stdout).session_id, sessionId);
    assert.ok(JSON.stringify(modelRequests.at(-1).messages).includes("NATIVE_HISTORY_CANARY"));
    const forked = await nativeTurn("Fork this saved conversation.", ["--resume", sessionId, "--fork-session"]);
    assert.equal(forked.status, 0, JSON.stringify(forked));
    assert.notEqual(JSON.parse(forked.stdout).session_id, sessionId);
    assert.ok(JSON.stringify(modelRequests.at(-1).messages).includes("NATIVE_HISTORY_CANARY"));

    // A small protocol fixture exercises the real Claude MCP subprocess and
    // tool-result path. It has no external network or account credentials.
    const mcp = path.join(root, "mcp.mjs");
    await fs.writeFile(mcp, `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (request.id === undefined) continue;
  const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
    : request.method === "tools/list" ? { tools: [{ name: "echo", description: "Return synthetic test input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
    : request.method === "tools/call" ? { content: [{ type: "text", text: request.params.arguments.text }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`);
    const mcpConfig = path.join(root, "mcp.json");
    await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { stdio: { command: process.execPath, args: [mcp] } } }));
    const mcpResult = await nativeTurn("Use the stdio echo tool. MCP_STDIO_CANARY.", ["--mcp-config", mcpConfig]);
    assert.equal(mcpResult.status, 0, JSON.stringify(mcpResult));
    assert.ok(modelRequests.some(body => body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result" && JSON.stringify(block).includes("MCP_TOOL_RESULT_CANARY")))));
  }
  exitCheckDelayMs = 3000;
  await exec("python3", [helper, "probe", "test_a"]);
  exitCheckDelayMs = 0;
  const launch = async (profile, label) => {
    const script = `process.on("SIGTERM", () => {}); setInterval(async () => { try { console.log(await (await fetch(${JSON.stringify(destination + "/" + label)}, { headers: { "x-issued-at": String(Date.now()) } })).text()); } catch {} }, 100);`;
    const child = spawn("python3", [helper, "run", profile, binding(profile), "--", process.execPath, "-e", script], {
      env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "*" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = [];
    let stderr = "";
    child.stdout.on("data", (data) => lines.push(...data.toString().trim().split("\n")));
    child.stderr.on("data", (data) => { stderr += data; });
    for (let i = 0; i < 60 && !lines.length && child.exitCode === null; i++) await delay(100);
    assert.ok(lines.length, `native ${label} did not make a routed request: ${stderr}`);
    return { child, lines, error: () => stderr };
  };
  const [a1, a2, b1] = await Promise.all([launch("test_a", "a1"), launch("test_a", "a2"), launch("test_b", "b1")]);
  assert.equal(a1.lines[0], "127.0.0.2");
  assert.equal(a2.lines[0], "127.0.0.2");
  assert.equal(b1.lines[0], "127.0.0.3");
  let routines, failedOccurrence;
  if (process.env.AIMGR_TEST_CLAUDE_BIN) {
    routines = await createNativeRoutineFixture({ root, profile, destination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN });
    const first = await routines.start(0, "Run the synthetic scheduled Bash task. ROUTINE_SUCCESS_CANARY.");
    const completed = await first.finished;
    assert.equal(completed.needsAttention, false, JSON.stringify(completed));
    assert.equal(completed.selectedAccount.binding, "a");
    assert.equal(await fs.readFile(path.join(routines.cwd, "tool-proof.txt"), "utf8"), "native-tool-ok");
    const subagent = await nativeTurn("Delegate the synthetic child task. NATIVE_SUBAGENT_PARENT.");
    assert.equal(subagent.status, 0, JSON.stringify(subagent));
    assert.equal(JSON.parse(subagent.stdout).subagent_stats.spawned, 1);
    assert.equal(await fs.readFile(path.join(root, "child-proof.txt"), "utf8"), "subagent-ok");
    assert.ok(modelRequests.some((body, i) => JSON.stringify(body.messages).includes("NATIVE_CHILD_TASK") && modelRoutes[i] === "127.0.0.2"));
    failedOccurrence = await routines.start(1, "Run the synthetic interruption task. ROUTINE_FAIL_CANARY.");
    for (let n = 0; n < 300 && !modelRequests.some(body => JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")); n++) await delay(50);
    assert.ok(modelRequests.some(body => JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")));
  }
  // A partial installation must not remove the omitted active A route.
  const partial = spawn("sudo", ["python3", helper, "install"], { stdio: ["pipe", "ignore", "pipe"] });
  const partialExit = once(partial, "exit");
  partial.stdin.end(JSON.stringify({ ...manifest, profiles: { test_b: manifest.profiles.test_b } }));
  assert.equal((await partialExit)[0], 125);
  const wrongRoute = `import { SocksClient } from "socks"; try { await SocksClient.createConnection({ proxy: { host: "127.0.0.1", port: ${b.port}, type: 5 }, command: "connect", destination: { host: "198.18.0.10", port: ${originPort} }, timeout: 500 }); process.exit(9); } catch { process.exit(0); }`;
  await exec("python3", [helper, "run", "test_a", binding("test_a"), "--", process.execPath, "--input-type=module", "-e", wrongRoute]);
  const a1Exit = once(a1.child, "exit"), a2Exit = once(a2.child, "exit");
  const tunnelExit = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await tunnelExit;
  const repaired = await startProxy("127.0.0.2", a.port);
  assert.equal((await a1Exit)[0], 125);
  assert.equal((await a2Exit)[0], 125);
  if (failedOccurrence) {
    const failed = await failedOccurrence.finished;
    assert.equal(failed.needsAttention, true);
    assert.equal(failed.selectedAccount.binding, "a");
    assert.equal((await failedOccurrence.duplicate()).outcome, "duplicate");
  }
  assert.match(a1.error(), /tunnel or proxy exited/);
  const oldCount = received.filter(r => r.path === "/a1" || r.path === "/a2").length;
  await delay(250);
  assert.equal(received.filter(r => r.path === "/a1" || r.path === "/a2").length, oldCount, "tunnel repair does not revive killed sessions");
  // The health monitor may observe the same tunnel outage and stop the
  // adapter. Explicit recovery repairs both components before a new launch.
  await exec("sudo", ["systemctl", "restart", services[0]]);
  if (routines) {
    const recovered = await nativeTurn("Continue the saved conversation after explicit proxy repair.", ["--resume", savedNativeSessionId]);
    assert.equal(recovered.status, 0, JSON.stringify(recovered));
    assert.equal(JSON.parse(recovered.stdout).session_id, savedNativeSessionId);
    assert.ok(JSON.stringify(modelRequests.at(-1).messages).includes("NATIVE_HISTORY_CANARY"));
    const later = await routines.start(2, "Run the later independent scheduled Bash task. ROUTINE_SUCCESS_CANARY.");
    assert.equal((await later.finished).needsAttention, false);
    assert.equal(new Set(routines.receipts.map(receipt => receipt.fireKey)).size, 3);
    console.log(JSON.stringify({ nativeRoutineReceipts: routines.receipts }));
  }
  const explicit = await launch("test_a", "explicit-new-a");
  assert.equal(explicit.lines[0], "127.0.0.2");
  const explicitExit = once(explicit.child, "exit");
  await exec("sudo", ["systemctl", "stop", services[0]]);
  assert.equal((await explicitExit)[0], 125, "adapter loss also stops the account");
  await assert.rejects(exec("python3", [helper, "run", "test_a", binding("test_a"), "--", process.execPath, "-e", "process.exit(9)"]), error => error.code === 125);
  await exec("sudo", ["systemctl", "start", services[0]]);
  const orphanScript = `setInterval(async () => { try { await fetch(${JSON.stringify(destination + "/orphan-a")}, { headers: { "x-issued-at": String(Date.now()) } }); } catch {} }, 100);`;
  const parentScript = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(orphanScript)}], { detached: true, stdio: "ignore" }); console.log(child.pid); child.unref();`;
  const orphan = await exec("python3", [helper, "run", "test_a", binding("test_a"), "--", process.execPath, "-e", parentScript]);
  const orphanPid = Number(orphan.stdout.trim());
  t.after(() => { try { process.kill(orphanPid, "SIGKILL"); } catch {} });
  for (let n = 0; n < 60 && !received.some(r => r.path === "/orphan-a"); n++) await delay(50);
  assert.ok(received.some(r => r.path === "/orphan-a"), "background work remains supported after its launcher exits");
  await assert.rejects(assertLocalClaudeProfileStopped("test_a"), /still has local native work/);
  const hungA1 = await launch("test_a", "hung-a1");
  const hungA2 = await launch("test_a", "hung-a2");
  const hungExits = Promise.all([once(hungA1.child, "exit"), once(hungA2.child, "exit")]);
  repaired.child.kill("SIGSTOP");
  t.after(() => { try { repaired.child.kill("SIGCONT"); } catch {} });
  const hangStarted = Date.now();
  assert.deepEqual((await hungExits).map(result => result[0]), [125, 125]);
  assert.ok(Date.now() - hangStarted < 20000, "hung route has a bounded shutdown deadline");
  for (let n = 0; n < 60; n++) {
    if ((await fs.readFile("/sys/fs/cgroup/aimgr-claude/test_a/cgroup.events", "utf8")).includes("populated 0")) break;
    await delay(50);
  }
  assert.match(await fs.readFile("/sys/fs/cgroup/aimgr-claude/test_a/cgroup.events", "utf8"), /populated 0/, "including the orphaned background child");
  await assertLocalClaudeProfileStopped("test_a");
  const stoppedAt = Date.now();
  repaired.child.kill("SIGCONT");
  // Bytes already handed to the paused proxy can arrive later. They must be
  // pre-shutdown requests, never retries or new requests from surviving work.
  await delay(300);
  const oldRequests = () => received.filter(r => ["/hung-a1", "/hung-a2", "/orphan-a"].includes(r.path));
  assert.ok(oldRequests().every(r => r.issuedAt <= stoppedAt));
  const afterHang = oldRequests().length;
  await delay(300);
  assert.equal(oldRequests().length, afterHang);
  await exec("sudo", ["systemctl", "start", services[0]]);
  const adapterHang = await launch("test_a", "hung-adapter");
  const adapterExit = once(adapterHang.child, "exit");
  const { stdout: adapterPid } = await exec("lsof", ["-nP", "-t", "-iTCP:15085", "-sTCP:LISTEN"]);
  const adapterHangStart = Date.now();
  process.kill(Number(adapterPid.trim()), "SIGSTOP");
  assert.equal((await adapterExit)[0], 125, "a live but unresponsive adapter stops native work");
  assert.ok(Date.now() - adapterHangStart < 20000);
  assert.equal(b1.child.exitCode, null, "healthy B continues while A's adapter hangs");
  await exec("sudo", ["systemctl", "start", services[0]]);
  const afterAdapterHang = received.filter(r => r.path === "/hung-adapter").length;
  await delay(300);
  assert.equal(received.filter(r => r.path === "/hung-adapter").length, afterAdapterHang);
  const afterRepair = await launch("test_a", "after-hang-repair");
  const monitorExit = once(afterRepair.child, "exit");
  const { stdout: monitorPid } = await exec("systemctl", ["show", "--property=MainPID", "--value", services[0]]);
  await exec("sudo", ["kill", "-KILL", monitorPid.trim()]);
  assert.equal((await monitorExit)[0], 125, "monitor loss stops the adapter and all affected native work");
  const healthyCount = b1.lines.length;
  await delay(250);
  assert.ok(b1.lines.length > healthyCount);
  assert.equal(received.filter((r) => r.path !== "/control").every((r) => ["127.0.0.2", "127.0.0.3"].includes(r.route)), true);
});
