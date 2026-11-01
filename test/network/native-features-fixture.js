import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { runClaudeCliNoninteractive } from "../../src/targets/claude-runner.js";
import { installFixtureSecurityAdapter } from "./native-routine-fixture.js";

// Actual pinned CLI with a recording model origin; no real credentials.
export async function verifyNativeClaudeFeatures({ root, profile, destination, modelRequests }) {
  installFixtureSecurityAdapter(root);
  const configDir = path.join(root, ".aimgr", "claude-homes", "a", ".claude");
  let nativeTurn, savedNativeSessionId;
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

  const subagent = await nativeTurn("Delegate the synthetic child task. NATIVE_SUBAGENT_PARENT.");
  assert.equal(subagent.status, 0, JSON.stringify(subagent));
  assert.equal(JSON.parse(subagent.stdout).subagent_stats.spawned, 1);
  assert.equal(await fs.readFile(path.join(root, "child-proof.txt"), "utf8"), "subagent-ok");
  const tools = [...new Set(modelRequests.flatMap(body => (body.tools ?? []).map(tool => tool.name)))].sort();
  const schedulingTools = modelRequests.flatMap(body => body.tools ?? []).filter(tool => /Schedule|Cron/.test(tool.name));
  console.log(JSON.stringify({ schedulingToolDefinitions: [...new Map(schedulingTools.map(tool => [tool.name, { name: tool.name, input_schema: tool.input_schema }])).values()] }));
  const receipt = { tools, bash: true, hooks: true, instructions: true, historyResumeFork: true, stdioMcp: true, subagent: true };
  console.log(JSON.stringify({ actualNativeFeatures: receipt }));
  return { nativeTurn, savedNativeSessionId, receipt };
}
