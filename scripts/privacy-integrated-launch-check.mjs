/** Offsite synthetic integration driver. The outer fixture owns the loopback
 * TLS service and independent network isolation; no real credentials belong
 * here. This uses the actual ordinary AIM runner, artifact admission, native
 * settings validation, supervisor and immutable native entry without mocks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { runClaudeCli, runClaudeCliNoninteractive, prepareClaudeCliLaunch } from "../src/targets/claude-runner.js";
import path from "node:path";
assert.ok(fs.statSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST").isFile());
assert.notEqual(process.getuid(), 0);
const input = JSON.parse(process.argv[2]);
assert.ok(input.userHomeDir.startsWith("/opt/aimgr-state-audit/claude-implementation/"));
assert.ok(["ordinary", "protected"].includes(input.mode));
assert.equal(Boolean(input.egressProfile), input.mode === "protected");
try {
  if (input.check === "controls") {
    const { verifyControls } = await import("./privacy-integrated-control-check.mjs");
    await verifyControls(input); console.log("SYNTHETIC_OK");
  } else if (input.check === "compatibility") {
    const { verifyCompatibility } = await import("./privacy-integrated-compatibility-check.mjs");
    await verifyCompatibility(input); console.log("SYNTHETIC_OK");
  } else if (input.check === "concurrency") {
    const { verifyConcurrency } = await import("./privacy-integrated-concurrency-check.mjs");
    await verifyConcurrency(input);
    console.log("SYNTHETIC_OK");
  } else if (input.check === "http-mcp") {
    const { verifyHttpMcp } = await import("./privacy-integrated-mcp-check.mjs");
    const { check, captureFile, ...launch } = input;
    const result = await verifyHttpMcp({ launch, captureFile });
    fs.writeFileSync(path.join(input.userHomeDir, "http-mcp.json"), JSON.stringify(result));
    console.log("SYNTHETIC_OK");
  } else if (input.check === "interactive") {
    const result = await runClaudeCli({ ...input, env: process.env });
    process.exitCode = result.status ?? 1;
  } else if (input.check === "schedule-refusals") {
    const { verifyScheduledRefusals } = await import("./privacy-integrated-schedule-refusals.mjs");
    const result = await verifyScheduledRefusals(input);
    fs.writeFileSync(path.join(input.userHomeDir, "schedules.json"), JSON.stringify(result));
    console.log("SYNTHETIC_OK");
  } else if (input.check === "schedules") {
    const { verifyOsScheduledRoutine } = await import("../test/network/native-scheduled-fixture.js");
    const { verifyInteractiveRoutine } = await import("../test/network/native-pty-fixture.js");
    const options = { root: input.userHomeDir, profile: input.egressProfile, claudeBin: input.command,
      defaultServices: { caFile: process.env.NODE_EXTRA_CA_CERTS, realRedisUrl: "redis://127.0.0.1:36379",
        ...(process.platform === "linux" ? { managedDirectory: "/opt/aimgr-state-audit/claude-implementation/empty-managed-version" } : {}) } };
    const calendar = await verifyOsScheduledRoutine(options);
    fs.writeFileSync(path.join(input.userHomeDir, "schedules.json"), JSON.stringify({ calendar, interactive: null }));
    const interactive = await verifyInteractiveRoutine(options);
    fs.writeFileSync(path.join(input.userHomeDir, "schedules.json"), JSON.stringify({ calendar, interactive }));
    console.log("SYNTHETIC_OK");
  } else if (input.check === "workflows") {
    const { check, captureFile, ...launch } = input;
    const cwd = launch.cwd;
    const models = () => fs.readFileSync(captureFile, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.path.includes("/messages")).map(row => row.body);
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "Preserve NATIVE_INSTRUCTION_CANARY.\n");
    const external = path.join(launch.userHomeDir, "instructions/external.md");
    fs.mkdirSync(path.dirname(external)); fs.writeFileSync(external, "NATIVE_EXTERNAL_INSTRUCTION_CANARY\n");
    fs.writeFileSync(path.join(launch.configDir, "CLAUDE.md"), "@" + external + "\n");
    const skill = path.join(launch.userHomeDir, ".claude/skills/privacy-proof/SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "---\nname: privacy-proof\ndescription: Run the synthetic retained-skill check.\n---\nUse NATIVE_SKILL_CONTENT_CANARY when completing this check.\n");
    await prepareClaudeCliLaunch(launch);
    const settings = path.join(cwd, "workflow-settings.json");
    fs.writeFileSync(settings, JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "printf start >> hook-proof.txt" }] }],
      PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "printf tool >> hook-proof.txt" }] }],
    } }));
    const turn = async (prompt, args = []) => {
      let stdout = "", stderr = "";
      const result = await runClaudeCliNoninteractive({ ...launch,
        args: ["-p", prompt, "--settings", settings, "--output-format", "json", "--dangerously-skip-permissions",
          "--model", "sonnet", "--max-turns", "4", "--debug-file", path.join(cwd, "workflow-debug.private.txt"), ...args],
        env: process.env, timeoutMs: 45000, maxOutputBytes: 1024 * 1024,
        spawnImpl(command, argv, options) {
          const child = spawn(command, argv, options);
          child.stdout.on("data", chunk => { stdout += chunk; });
          child.stderr.on("data", chunk => { stderr += chunk; }); return child;
        } });
      fs.appendFileSync(path.join(launch.userHomeDir, "workflow-output.private.txt"), stdout + stderr);
      assert.equal(result.status, 0, "actual native workflow failed; inspect private fixture output");
      return JSON.parse(stdout);
    };
    const first = await turn("Perform the synthetic Bash test. NATIVE_HISTORY_CANARY.");
    assert.equal(fs.readFileSync(path.join(cwd, "tool-proof.txt"), "utf8"), "native-tool-ok");
    assert.match(fs.readFileSync(path.join(cwd, "hook-proof.txt"), "utf8"), /start.*tool/);
    for (const marker of ["NATIVE_INSTRUCTION_CANARY", "NATIVE_EXTERNAL_INSTRUCTION_CANARY"]) assert.ok(models().some(body => JSON.stringify(body).includes(marker)), marker);
    const resumed = await turn("Continue the previous saved conversation.", ["--resume", first.session_id]);
    assert.equal(resumed.session_id, first.session_id); assert.ok(JSON.stringify(models().at(-1)).includes("NATIVE_HISTORY_CANARY"));
    const forked = await turn("Fork the saved conversation.", ["--resume", first.session_id, "--fork-session"]);
    assert.notEqual(forked.session_id, first.session_id); assert.ok(JSON.stringify(models().at(-1)).includes("NATIVE_HISTORY_CANARY"));
    const mcp = path.join(cwd, "mcp.mjs");
    fs.writeFileSync(mcp, `import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line);if(r.id===undefined)continue;
 const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}
 :r.method==='tools/list'?{tools:[{name:'echo',description:'Return synthetic input',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}
 :r.method==='tools/call'?{content:[{type:'text',text:r.params.arguments.text}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}`);
    const mcpConfig = path.join(cwd, "mcp.json");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { stdio: { command: process.execPath, args: [mcp] } } }));
    await turn("Use stdio echo. MCP_STDIO_CANARY.", ["--mcp-config", mcpConfig]);
    assert.ok(models().some(body => JSON.stringify(body.messages).includes("MCP_TOOL_RESULT_CANARY")));
    await turn("Use privacy-proof. NATIVE_SKILL_PARENT.");
    assert.ok(models().some(body => JSON.stringify(body.messages).includes("NATIVE_SKILL_CONTENT_CANARY")));
    const agent = await turn("Delegate the synthetic child task. NATIVE_SUBAGENT_PARENT.");
    assert.equal(agent.subagent_stats.spawned, 1);
    assert.equal(fs.readFileSync(path.join(cwd, "child-proof.txt"), "utf8"), "subagent-ok");
    fs.writeFileSync(path.join(launch.userHomeDir, "workflows.json"), JSON.stringify({ bash: true, hooks: true,
      instructions: true, externalInstructionImport: true, historyResumeFork: true, stdioMcp: true, personalSkill: true, subagent: true }));
    console.log("SYNTHETIC_OK");
  } else {
  const result = await runClaudeCliNoninteractive({ ...input, env: process.env, timeoutMs: 45000,
    maxOutputBytes: 1024 * 1024, spawnImpl(command, args, options) {
      const child = spawn(command, args, options);
      child.stdout.on("data", chunk => process.stdout.write(chunk));
      child.stderr.on("data", chunk => process.stderr.write(chunk));
      return child;
    } });
  process.exitCode = result.status ?? 1;
  }
} catch (error) {
  process.stderr.write(`${error.code ?? "fixture_error"}: ${error.message}\n`);
  process.exitCode = 1;
}
