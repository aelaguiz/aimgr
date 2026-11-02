/** One actual AIM routine and required native skill/MCP turn while A1/A2/B
 * remain alive. Reuse their exact home, records and real Redis leases. Only
 * Herdr UI and print-mode terminal presentation are substituted here; the
 * separately recorded real-account calendar check exercises the public worker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAimgrConfig, writeAimgrConfig } from '../src/config/aimgr-config.js';
import { executeRoutineWorker } from '../src/routines/run.js';
import { runClaudeCli } from '../src/targets/claude-runner.js';
import { runCli } from '../test/helpers/cli-runner.js';
import { connectRedisStore } from '../src/coordination/redis-store.js';

export async function verifyOverlap({ input, home, cwd, env, keyPrefix, start, waitFor, readCaptures, receipt }) {
  const skill = path.join(cwd, '.claude/skills/overlap-proof'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: overlap-proof\ndescription: Required concurrency fixture skill\n---\nOVERLAP_REQUIRED_SKILL_CONTENT\n');
  const server = path.join(cwd, 'overlap-mcp.mjs'), mcpConfig = path.join(cwd, 'overlap-mcp.json');
  fs.writeFileSync(server, `import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const r=JSON.parse(line);if(r.id===undefined)continue;
 const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'overlap',version:'1'}}
 :r.method==='tools/list'?{tools:[{name:'echo',description:'Return required overlap result',inputSchema:{type:'object',properties:{}}}]}
 :r.method==='tools/call'?{content:[{type:'text',text:'OVERLAP_REQUIRED_MCP_RESULT'}]}:{};
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}`);
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { overlap: { command: process.execPath, args: [server] } } }));
  const held = ['a1', 'a2', 'b1'].map((role, index) => start(index === 2 ? 'b' : 'a', role));
  const { config } = readAimgrConfig({ homeDir: home });
  try {
    await waitFor(() => ['a1', 'a2', 'b1'].every(role => fs.existsSync(path.join(cwd, role + '.entered'))), 'held native siblings');
    await start('a', 'overlap-required', { extraArgs: ['--mcp-config', mcpConfig] }).finished;
    const models = () => readCaptures().filter(row => row.path.includes('/messages'));
    const required = models().filter(row => JSON.stringify(row.body.messages).includes('CONCURRENT_ROLE_overlap-required.'));
    assert.ok(required.some(row => JSON.stringify(row.body.messages).includes('OVERLAP_REQUIRED_SKILL_CONTENT')));
    assert.ok(required.some(row => JSON.stringify(row.body.messages).includes('OVERLAP_REQUIRED_MCP_RESULT')));
    assert.ok(required.every(row => row.source === '127.0.0.2'));
    assert.ok(held.every(child => child.exitCode === null));
    receipt.checks.requiredSkillAndMcpWhileA1A2BRemainLive = true;

    const now = new Date(), id = 'concurrent-native', prompt = path.join(cwd, 'routine-prompt.md');
    fs.writeFileSync(prompt, 'Run the synthetic scheduled turn. CONCURRENT_ROUTINE_CANARY.\n');
    writeAimgrConfig({ homeDir: home, config: { ...config, routines: { [id]: { agent: 'claude', provider: 'anthropic',
      model: 'claude-sonnet-4-6', thinking: 'high', calendar: [{ hour: now.getHours(), minute: now.getMinutes() }],
      cwd, promptFile: prompt, herdrSession: 'overlap', spaceTitleFormat: 'Overlap {scheduled_local}' } } } });
    const routineEnv = { ...env, HERDR_SESSION: 'overlap', HERDR_WORKSPACE_ID: 'w', HERDR_PANE_ID: 'p' };
    const spawnSyncImpl = (_command, args) => ({ status: 0, stderr: '', stdout: JSON.stringify({ result: args.includes('create')
      ? { type: 'workspace_created', workspace: { workspace_id: 'w', label: args[args.indexOf('--label') + 1], focused: false },
        tab: { tab_id: 't', workspace_id: 'w' }, root_pane: { pane_id: 'p', workspace_id: 'w', tab_id: 't', cwd, focused: false } }
      : { type: 'workspace_list', workspaces: [{ workspace_id: 'prior', focused: true }] } }) });
    const queued = JSON.parse(await runCli(['routine', 'run', id, '--home', home, '--json'], {
      env: routineEnv, spawnSyncImpl, routineWorkspaceMoveImpl: async () => ({ verified: true, position: 1 }) }));
    assert.equal(queued.outcome, 'queued');
    const owner = JSON.parse(fs.readFileSync(path.join(home, '.aimgr/routine-locks', id, 'owner.json')));
    let status = 0;
    await executeRoutineWorker({ homeDir: home, cwd, env: routineEnv, opts: {}, nowMs: Date.now(),
      positional: ['routine', '__execute', id, queued.fireKey, owner.token], stdout: { write() {} }, stderr: { write() {} },
      setExitCode: value => { status = value; }, resolveExecutableOnPathImpl: () => input.command,
      connectRedisStoreImpl: options => connectRedisStore({ ...options, url: 'redis://127.0.0.1:36379', keyPrefix }),
      routineTimeouts: { pollMs: 25, initialTurnMs: 30000 },
      runClaudeCliImpl: launch => runClaudeCli({ ...launch, args: ['-p', '--output-format', 'json', ...launch.args] }) });
    const result = JSON.parse(fs.readFileSync(queued.receiptPath));
    assert.equal(status, 0); assert.equal(result.outcome, 'completed'); assert.ok(result.prompt.admittedAt);
    assert.ok(['a', 'b'].includes(result.selectedAccount.binding));
    assert.equal(fs.readFileSync(path.join(cwd, 'overlap-routine-proof.txt'), 'utf8'), 'overlap-routine-ok');
    assert.ok(held.every(child => child.exitCode === null));
    const routed = models().filter(row => JSON.stringify(row.body.messages).includes('CONCURRENT_ROUTINE_CANARY.'));
    assert.ok(routed.length >= 2); assert.ok(routed.every(row => row.source === (result.selectedAccount.binding === 'a' ? '127.0.0.2' : '127.0.0.3')));
    receipt.checks.actualRoutineWhileA1A2BRemainLive = true;
    receipt.overlapRoutine = { selectedAccount: result.selectedAccount.binding, outcome: result.outcome, assignedRoute: true };
  } finally {
    for (const role of ['a1', 'a2', 'b1']) fs.writeFileSync(path.join(cwd, role + '.release'), 'ok');
    await Promise.all(held.map(child => child.finished));
    writeAimgrConfig({ homeDir: home, config });
  }
  receipt.passed = true;
}
