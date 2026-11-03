/** Real unprivileged stdio MCP through the full approved Mac launch path.
 * The outer default-services fixture supplies synthetic OAuth/model responses
 * and an independent offsite network boundary. Never use sudo as an MCP
 * command: it would skip the parent executable lookup this test must cover.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runClaudeCliNoninteractive } from "../src/targets/claude-runner.js";

export async function verifyMcpAliases(input) {
  assert.equal(process.platform, "darwin");
  const { check, captureFile, ...launch } = input;
  const profileName = launch.egressProfile?.profileRef;
  assert.match(profileName ?? "", /^[a-z0-9_-]+$/);
  const routingGid = JSON.parse(fs.readFileSync(`/opt/aimgr-claude-proxy/${profileName}.json`)).gid;
  const external = path.join(launch.userHomeDir, "private-mcp-bin");
  fs.mkdirSync(external, { mode: 0o700 });
  const sibling = path.join(external, "unrelated-private-file");
  fs.writeFileSync(sibling, "MCP_PRIVATE_SIBLING_CANARY");
  const alias = path.join(external, "node"); fs.symlinkSync(process.execPath, alias);
  const intermediate = path.join(external, "intermediate"); fs.symlinkSync(alias, intermediate);
  const directoryAlias = path.join(launch.userHomeDir, "mcp-bin-alias"); fs.symlinkSync(external, directoryAlias);
  const proof = path.join(launch.cwd, "mcp-proof.jsonl");
  const server = path.join(launch.cwd, "mcp-server.mjs");
  const body = `import readline from 'node:readline';import fs from 'node:fs';
for await(const line of readline.createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id===undefined)continue;
let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'alias',version:'1'}};
if(r.method==='tools/list')result={tools:[{name:'echo',description:'Return synthetic alias proof',inputSchema:{type:'object',properties:{}}}]};
if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(proof)},JSON.stringify({uid:process.getuid(),gid:process.getgid(),command:process.execPath})+'\\n');result={content:[{type:'text',text:'MCP_ALIAS_PROOF_OK'}]};}
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));}
`;
  fs.writeFileSync(server, body);
  const script = path.join(external, "venv-entry.mjs");
  fs.writeFileSync(script, `#!${alias}\n${body}`, { mode: 0o700 });
  const cases = [
    { name: "file-alias", command: alias, args: [server] },
    { name: "directory-and-file-alias", command: path.join(directoryAlias, "intermediate"), args: [server] },
    { name: "private-shebang-interpreter", command: script, args: [] },
  ];
  const receipts = [];
  const captures = () => fs.readFileSync(captureFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const proofRows = () => fs.existsSync(proof) ? fs.readFileSync(proof, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  for (const entry of cases) {
    const config = path.join(launch.cwd, entry.name + ".json");
    const configBytes = JSON.stringify({ mcpServers: { alias: { command: entry.command, args: entry.args } } });
    fs.writeFileSync(config, configBytes);
    let output = "";
    const before = captures().length;
    const previousProofCount = proofRows().length;
    const result = await runClaudeCliNoninteractive({ ...launch,
      args: ["-p", "Invoke the synthetic MCP echo. MCP_ALIAS_REQUEST.", "--model", "sonnet", "--max-turns", "6",
        "--dangerously-skip-permissions", "--output-format", "json", "--strict-mcp-config", "--mcp-config", config],
      env: process.env, timeoutMs: 45000, maxOutputBytes: 1024 * 1024,
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options);
        child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
        return child;
      } });
    fs.writeFileSync(path.join(launch.cwd, entry.name + ".private.txt"), output);
    assert.equal(result.status, 0, entry.name + " failed");
    const requests = captures().slice(before).filter(row => row.path.includes("/messages"));
    const blocks = requests.flatMap(row => row.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []));
    const ids = new Set(blocks.filter(block => block.type === "tool_use" && block.name.includes("alias") && block.name.endsWith("echo")).map(block => block.id));
    assert.ok(blocks.some(block => block.type === "tool_result" && ids.has(block.tool_use_id) && block.is_error !== true && JSON.stringify(block).includes("MCP_ALIAS_PROOF_OK")), entry.name + " did not return an actual MCP result");
    const calls = proofRows().slice(previousProofCount);
    assert.ok(calls.length > 0 && calls.every(row => row.uid === process.getuid() && row.gid === routingGid), "each MCP must execute as the ordinary user on its assigned route");
    assert.equal(fs.readFileSync(config, "utf8"), configBytes);
    receipts.push({ name: entry.name, passed: true, unprivileged: true, assignedRoutingGid: true, configUnchanged: true });
  }
  // First prove the real native Read can read this existing file when the
  // user intentionally grants its folder. Then remove that grant in a fresh
  // session while retaining the executable alias. Claude normalizes the
  // kernel denial into a link-resolution refusal, so compare behavior instead
  // of relying on an OS error string surviving the vendor's formatter.
  const readArgs = ["-p", "Read the sibling privacy canary. MCP_ALIAS_PRIVATE_READ.", "--model", "sonnet", "--max-turns", "3",
    "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", path.join(launch.cwd, "file-alias.json")];
  const controlStart = captures().length;
  const control = await runClaudeCliNoninteractive({ ...launch, args: [...readArgs, "--add-dir", external],
    env: process.env, timeoutMs: 45000 });
  assert.equal(control.status, 0);
  const controlBlocks = captures().slice(controlStart).filter(row => row.path.includes("/messages"))
    .flatMap(row => row.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []));
  assert.ok(controlBlocks.some(block => block.type === "tool_result" && block.tool_use_id === "mcp_alias_private_read"
    && block.is_error !== true && JSON.stringify(block).includes("MCP_PRIVATE_SIBLING_CANARY")));
  const before = captures().length;
  const result = await runClaudeCliNoninteractive({ ...launch,
    args: readArgs,
    env: process.env, timeoutMs: 45000 });
  assert.equal(result.status, 0);
  const blocks = captures().slice(before).filter(row => row.path.includes("/messages"))
    .flatMap(row => row.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []));
  assert.ok(blocks.some(block => block.type === "tool_use" && block.id === "mcp_alias_private_read" && block.input.file_path === sibling));
  assert.ok(blocks.some(block => block.type === "tool_result" && block.tool_use_id === "mcp_alias_private_read" && block.is_error));
  assert.equal(fs.readFileSync(sibling, "utf8"), "MCP_PRIVATE_SIBLING_CANARY");
  assert.ok(!JSON.stringify(blocks).includes("MCP_PRIVATE_SIBLING_CANARY"));
  fs.writeFileSync(path.join(launch.userHomeDir, "mcp-alias.json"), JSON.stringify({ passed: true, cases: receipts,
    intentionalSiblingReadPassed: true, siblingReadDeniedWithoutFolderGrant: true }));
}
