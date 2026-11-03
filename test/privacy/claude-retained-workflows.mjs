// Offsite decision fixture: reuse the existing actual-native feature harness
// while testing the common feature-flag pin. This is not full policy acceptance.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { verifyNativeClaudeFeatures } from "../network/native-features-fixture.js";
import { scheduledResponse } from "../network/native-scheduled-response.js";
import { prepareClaudeCliLaunch } from "../../src/targets/claude-runner.js";
import { verifyInteractiveRoutine } from "../network/native-pty-fixture.js";

const base = "/opt/aimgr-state-audit";
const root = path.resolve(process.argv[2] ?? "");
const pinned = process.argv[3] === "pinned";
const phase = process.argv[4] ?? "features";
assert.ok(["baseline", "pinned"].includes(process.argv[3]));
assert.ok(["features", "schedule"].includes(phase));
assert.ok(process.getuid() !== 0 && fs.existsSync(`${base}/OFFSITE_AUDIT_HOST`));
assert.equal(path.dirname(root), `${base}/claude-implementation`);
assert.equal(fs.existsSync(root), false);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const vendor = `${base}/bin/claude`;
const expected = { linux: "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0",
  darwin: "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9" };
const hash = crypto.createHash("sha256");
for await (const block of fs.createReadStream(vendor)) hash.update(block);
assert.equal(hash.digest("hex"), expected[process.platform]);
process.umask(0o077);
fs.mkdirSync(root, { mode: 0o700 });
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  TERM: "xterm-256color", SHELL: "/bin/bash", DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1",
  DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", AIMGR_TEST_CLAUDE_BIN: vendor,
  ...(pinned ? { DISABLE_GROWTHBOOK: "1" } : {}) });
const skill = path.join(root, ".claude/skills/privacy-proof/SKILL.md");
fs.mkdirSync(path.dirname(skill), { recursive: true });
fs.writeFileSync(skill, "---\nname: privacy-proof\ndescription: Run the synthetic retained-skill check.\n---\nUse NATIVE_SKILL_CONTENT_CANARY when completing this check.\n");
const modelRequests = [];
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/v1/messages")) {
    res.setHeader("content-type", "application/json"); res.end("{}"); return;
  }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); modelRequests.push(body);
  fs.appendFileSync(path.join(root, "requests.private.jsonl"), JSON.stringify(body) + "\n");
  const messages = JSON.stringify(body.messages);
  const routine = messages.includes("ROUTINE_SUCCESS_CANARY");
  const wantsMcp = messages.includes("MCP_STDIO_CANARY");
  const wantsSkill = messages.includes("NATIVE_SKILL_PARENT");
  const wantsSubagent = body.messages.some(message => message.role === "user" && (typeof message.content === "string"
    ? message.content.includes("NATIVE_SUBAGENT_PARENT") : message.content.some(block => block.type === "text" && block.text.includes("NATIVE_SUBAGENT_PARENT"))));
  const isChild = messages.includes("NATIVE_CHILD_TASK") && !wantsSubagent;
  const mcpTool = body.tools.find(tool => tool.name.includes("stdio") && tool.name.endsWith("echo"));
  const toolName = wantsSkill ? "Skill" : wantsSubagent ? "Agent" : wantsMcp ? mcpTool?.name ?? "ToolSearch" : "Bash";
  const alreadyRan = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_use"
    && (wantsSkill ? block.name === "Skill" : wantsSubagent ? block.name === "Agent" : wantsMcp ? block.name.includes("stdio") && block.name.endsWith("echo") : block.name === "Bash")));
  const input = wantsSkill ? { skill: "privacy-proof" }
    : wantsSubagent ? { description: "Synthetic child task", prompt: "Run the synthetic Bash task. NATIVE_CHILD_TASK.", subagent_type: "general-purpose" }
      : wantsMcp ? (mcpTool ? { text: "MCP_TOOL_RESULT_CANARY" } : { query: "+stdio echo", max_results: 5 })
        : { command: isChild ? "printf subagent-ok > child-proof.txt" : "printf native-tool-ok > tool-proof.txt", description: "Write synthetic proof" };
  const content = scheduledResponse(body, modelRequests.length) ?? (alreadyRan ? { type: "text", text: routine ? "NATIVE_MOCK_DONE\nAIM-JOB: done" : "NATIVE_MOCK_DONE" }
    : { type: "tool_use", id: `tool_fixture_${modelRequests.length}`, name: toolName, input });
  if (content.hold) return;
  const message = { id: `msg_native_${modelRequests.length}`, type: "message", role: "assistant", model: body.model,
    content: [content], stop_reason: content.type === "text" ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
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
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  if (phase === "schedule") {
    const result = await verifyInteractiveRoutine({ root, destination: `http://127.0.0.1:${server.address().port}`, claudeBin: vendor });
    const report = { platform: process.platform, commonFeatureFlagsDisabled: pinned,
      initialTurnCompleted: result.initialTurnCompleted, followupCompleted: result.followupCompleted,
      inSessionScheduledWakeupCompleted: result.inSessionScheduledWakeupCompleted,
      terminalRestored: result.terminalRestored, passed: true,
      meaning: "Actual AIM interactive routine and native timer; not OS calendar firing or final combined privacy policy" };
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } else {
  const features = await verifyNativeClaudeFeatures({ root, destination: `http://127.0.0.1:${server.address().port}`, modelRequests });
  // The existing feature helper uses the maintenance/noninteractive entry,
  // which intentionally does not project personal customizations. Run the
  // actual interactive preflight before testing the personal skills link.
  await prepareClaudeCliLaunch({ command: vendor, userHomeDir: root,
    homeDir: path.join(root, ".aimgr/claude-homes/a"),
    configDir: path.join(root, ".aimgr/claude-homes/a/.claude") });
  const result = await features.nativeTurn("Use privacy-proof. NATIVE_SKILL_PARENT.");
  assert.equal(result.status, 0);
  assert.ok(modelRequests.some(body => JSON.stringify(body.messages).includes("NATIVE_SKILL_CONTENT_CANARY")));
  const report = { platform: process.platform, commonFeatureFlagsDisabled: pinned,
    ...features.receipt, personalSkill: true, passed: true,
    meaning: "Actual native retained-feature comparison; not the final combined privacy policy" };
  fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
