/** Offsite acceptance of the public scheduled-job path with sacrificial accounts.
 * The OS calendar runs the public CLI. A small Herdr UI stand-in executes the
 * exact worker command AIM generates in a real PTY; account selection, leases,
 * native hooks, model calls and receipt handling are the production code.
 * Keep private account details and terminal output on the disposable test host.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readAimgrConfig, writeAimgrConfig } from '../src/config/aimgr-config.js';
import { loadRedisRuntime, closeRedisRuntime } from '../src/coordination/runtime.js';
import { renderRoutineLaunchAgent, routineLaunchAgentLabel } from '../src/routines/launchd.js';
import { buildRoutineFireKey } from '../src/routines/schedule.js';

assert.equal(process.env.AIMGR_TEST_REAL_ROUTINE, '1');
assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST'));
const mac = process.platform === 'darwin', home = os.homedir();
const globalChallenge = path.join(home, 'verification/HUMAN_VERIFICATION_CHALLENGE');
assert.ok(!fs.existsSync(globalChallenge), 'HUMAN_VERIFICATION_CHALLENGE: stop all provider work');
assert.equal(home, mac ? '/Users/ec2-user' : '/home/aimdev');
if (mac) {
  const file = '/etc/aimgr-macos-test-rental.json', stat = fs.statSync(file);
  assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
  const rental = JSON.parse(fs.readFileSync(file));
  assert.equal(rental.purpose, 'aimgr-macos-testing'); assert.equal(rental.provider, 'aws-ec2');
  assert.equal(rental.hostname, os.hostname());
} else assert.equal(os.hostname(), 'aimgr-privacy-dev');
const { config, path: configFile } = readAimgrConfig({ homeDir: home });
const redis = new URL(config.redis.url);
assert.equal(redis.hostname, '127.0.0.1'); assert.equal(redis.port, '6380');
assert.equal(config.redis.keyPrefix, 'aimgr-privacy-dev:');
const runtime = await loadRedisRuntime({ homeDir: home, provider: 'anthropic' });
assert.deepEqual(runtime.snapshot.credentials.map(row => row.label).sort(), ['proxy5', 'proxy6']);
await closeRedisRuntime(runtime);

const exec = promisify(execFile), quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const root = fs.mkdtempSync(path.join(home, 'verification/real-routine-'));
const cwd = path.join(root, 'project'), bin = path.join(root, 'bin');
for (const directory of [cwd, bin]) fs.mkdirSync(directory, { mode: 0o700 });
const cli = fileURLToPath(new URL('../bin/aimgr.js', import.meta.url));
const terminal = fileURLToPath(new URL('./privacy-test-pty.py', import.meta.url));
const id = `privacy-real-${process.pid}`, session = 'privacy-real-test';
const socketPath = path.join('/tmp', `aim-rt-${process.pid}.sock`);
const originalConfig = fs.readFileSync(configFile);
const promptFile = path.join(cwd, 'prompt.md'), proof = path.join(cwd, 'proof.json');
const marker = 'AIM_REAL_CALENDAR_TOOL_PROOF';
fs.writeFileSync(promptFile, `This is a synthetic scheduled test. Run exactly this Bash command once: printf '${marker} '; curl -fsS 'https://api.ipify.org?format=json' > '${proof}'; cat '${proof}'. Do not do any other work. Report its output and finish with the exact line AIM-JOB: done.\n`);
fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Synthetic scheduled-test workspace. Follow the supplied task.\n');
// Accept only the synthetic task's normal trust/permission prompts. Never copy
// or modify another account's app state or installation identifiers.
for (const label of ['proxy5', 'proxy6']) {
  const directory = path.join(home, '.aimgr/claude-homes', label, '.claude');
  assert.ok(fs.existsSync(directory), 'Run real account smoke before the routine test');
  const settings = path.join(directory, 'settings.json');
  const value = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings)) : {};
  fs.writeFileSync(settings, JSON.stringify({ ...value, skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
  const stateFile = path.join(directory, '.claude.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.projects = { ...state.projects, [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } };
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
}
const env = { ...process.env, HOME: home, PATH: `${bin}:${home}/.local/bin:${process.env.PATH}` };
const aim = path.join(bin, 'aim');
fs.writeFileSync(aim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
const herdrScript = path.join(bin, 'herdr.mjs');
fs.writeFileSync(herdrScript, `import fs from 'node:fs';import {spawn} from 'node:child_process';import net from 'node:net';
const args=process.argv.slice(2),root=${JSON.stringify(root)},cwd=${JSON.stringify(cwd)};
fs.appendFileSync(root+'/herdr.private.jsonl',JSON.stringify(args)+'\\n');
let result;
if(args.includes('workspace')&&args.includes('list')) result={type:'workspace_list',workspaces:[{workspace_id:'prior',focused:true}]};
else if(args.includes('workspace')&&args.includes('create')) result={type:'workspace_created',workspace:{workspace_id:'w',label:args[args.indexOf('--label')+1],focused:false},tab:{tab_id:'t',workspace_id:'w'},root_pane:{pane_id:'p',tab_id:'t',workspace_id:'w',cwd,focused:false}};
else if(args[0]==='session'&&args[1]==='list'){console.log(JSON.stringify({sessions:[{name:${JSON.stringify(session)},running:true,socket_path:${JSON.stringify(socketPath)}}]}));process.exit(0);}
else if(args.includes('pane')&&args.includes('run')){
 const command=args.at(-1);if(!command.includes("'routine' '__execute'"))throw Error('Unexpected worker command');
 if(process.platform==='linux'){
  // Real Herdr already runs outside the scheduler service's cgroup. Ask the
  // external UI stand-in to open the pane; a detached child of systemd-run
  // would be killed as soon as the short calendar command returns.
  await new Promise((resolve,reject)=>{const c=net.createConnection(${JSON.stringify(socketPath)});let text='';c.on('connect',()=>c.write(JSON.stringify({method:'test.pane.run',command})+'\\n'));c.on('error',reject);c.on('data',b=>text+=b);c.on('end',()=>{const r=JSON.parse(text);r.error?reject(Error(r.error)):resolve();});});
  console.log(JSON.stringify({result:{type:'ok'}}));process.exit(0);
 }
 fs.writeFileSync(root+'/worker-command.private.txt',command);
 const info=root+'/terminal-info.json';fs.writeFileSync(info,JSON.stringify({root,cwd,argv:['/bin/sh','-c',command],env:{HERDR_SESSION:${JSON.stringify(session)},HERDR_WORKSPACE_ID:'w',HERDR_PANE_ID:'p'}}));
 const log=fs.openSync(root+'/pty-driver.private.log','a',0o600);
 const child=spawn('/usr/bin/python3',['-I',${JSON.stringify(terminal)},info],{cwd,env:process.env,detached:true,stdio:['ignore',log,log]});
 fs.writeFileSync(root+'/pty-driver-pid',String(child.pid));child.unref();fs.closeSync(log);result={type:'ok'};
}else throw Error('Unexpected Herdr UI request');
console.log(JSON.stringify({result}));
`);
fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(herdrScript)} "$@"\n`, { mode: 0o700 });
const server = net.createServer(connection => {
  let text = ''; connection.on('data', chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    const request = JSON.parse(text.split('\n')[0]);
    if (!mac && request.method === 'test.pane.run') {
      assert.ok(request.command.includes("'routine' '__execute'"));
      fs.writeFileSync(path.join(root, 'worker-command.private.txt'), request.command);
      const info = path.join(root, 'terminal-info.json');
      fs.writeFileSync(info, JSON.stringify({ root, cwd, argv: ['/bin/sh', '-c', request.command],
        env: { HERDR_SESSION: session, HERDR_WORKSPACE_ID: 'w', HERDR_PANE_ID: 'p' } }));
      const log = fs.openSync(path.join(root, 'pty-driver.private.log'), 'a', 0o600);
      const child = spawn('/usr/bin/python3', ['-I', terminal, info], { cwd, env, detached: true, stdio: ['ignore', log, log] });
      fs.writeFileSync(path.join(root, 'pty-driver-pid'), String(child.pid)); child.unref(); fs.closeSync(log);
      connection.end(JSON.stringify({ result: 'started' }) + '\n'); return;
    }
    assert.equal(request.method, 'workspace.move');
    connection.end(JSON.stringify({ id: request.id, result: { type: 'workspace_list', workspaces: [{ workspace_id: 'w' }] } }) + '\n');
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
const target = new Date(Math.ceil((Date.now() + 35000) / 60000) * 60000);
const routine = { id, agent: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'high',
  calendar: [{ hour: target.getHours(), minute: target.getMinutes() }], cwd, promptFile,
  herdrSession: session, spaceTitleFormat: 'Privacy test {scheduled_local}' };
const fireKey = buildRoutineFireKey(id, target);
const receiptFile = path.join(home, '.aimgr/routine-runs', fireKey + '.json');
const unit = 'aimgr-' + id, label = routineLaunchAgentLabel(id), plist = path.join(root, 'calendar.plist');
const installedPlist = mac ? `/Library/LaunchDaemons/${label}.plist` : null;
let installed = false, receipt;
const challengeFile = path.join(root, 'HUMAN_VERIFICATION_CHALLENGE');
const waitFor = async (predicate, reason, timeout = 180000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (fs.existsSync(challengeFile)) fs.writeFileSync(globalChallenge, 'Stop all provider work.\n', { mode: 0o600 });
    if (fs.existsSync(globalChallenge)) throw Error('HUMAN_VERIFICATION_CHALLENGE: stop all provider work');
    if (Date.now() > end) throw Error('Timed out: ' + reason);
    await delay(150);
  }
};
try {
  writeAimgrConfig({ homeDir: home, config: { ...config, routines: { ...config.routines, [id]: routine } } });
  if (mac) {
    fs.mkdirSync(path.join(home, '.aimgr/logs'), { recursive: true });
    fs.writeFileSync(plist, renderRoutineLaunchAgent(routine, { homeDir: home, aimPath: aim }));
    // A rented headless Mac has no logged-in GUI domain. Use the same calendar
    // and ProgramArguments in a task-owned system job running as ec2-user.
    await exec('/usr/bin/python3', ['-I', '-c', `import plistlib,sys\np=sys.argv[1]\nv=plistlib.load(open(p,'rb'))\nv['UserName']='ec2-user'\nv['EnvironmentVariables'].update(${JSON.stringify({ PATH: env.PATH, NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS })})\nv['StandardOutPath']=sys.argv[2]+'/calendar.private.out'\nv['StandardErrorPath']=sys.argv[2]+'/calendar.private.err'\nplistlib.dump(v,open(p,'wb'))`, plist, root]);
    await exec('sudo', ['-n', 'install', '-o', 'root', '-g', 'wheel', '-m', '600', plist, installedPlist]);
    await exec('sudo', ['-n', '/bin/launchctl', 'bootstrap', 'system', installedPlist]); installed = true;
  } else {
    await exec('sudo', ['-n', 'systemd-run', '--unit=' + unit, '--on-calendar=' + target.toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
      '--timer-property=AccuracySec=1s', '--timer-property=RandomizedDelaySec=0', '--uid=aimdev', '--gid=aimdev',
      '--property=WorkingDirectory=' + cwd, '--property=BindReadOnlyPaths=/opt/aimgr-state-audit/claude-implementation/empty-managed-version:/etc/claude-code',
      '--property=StandardOutput=append:' + root + '/calendar.private.out', '--property=StandardError=append:' + root + '/calendar.private.err',
      '--setenv=HOME=' + home, '--setenv=PATH=' + env.PATH, '--setenv=NODE_EXTRA_CA_CERTS=' + env.NODE_EXTRA_CA_CERTS,
      aim, 'routine', 'run', id]); installed = true;
  }
  await waitFor(() => fs.existsSync(receiptFile), 'actual OS calendar occurrence', target.getTime() - Date.now() + 45000);
  await waitFor(() => {
    receipt = JSON.parse(fs.readFileSync(receiptFile));
    if (['failed_before_prompt', 'needs_attention'].includes(receipt.outcome)) throw Error('Scheduled run failed; inspect private receipt');
    return receipt.outcome === 'completed' && receipt.lastTurn?.jobStatus?.state === 'done';
  }, 'native routine completion');
  assert.equal(receipt.manual, false); assert.equal(receipt.fireKey, fireKey);
  assert.ok(receipt.prompt.admittedAt); assert.equal(receipt.herdr.workspaceOrder.verified, true);
  const selected = receipt.selectedAccount.binding; assert.ok(['proxy5', 'proxy6'].includes(selected));
  const ip = JSON.parse(fs.readFileSync(proof)).ip;
  assert.ok(config.claudeProxyProfiles[selected].expectedExits.includes(ip));
  assert.equal(receipt.interactiveTui.status, 'live');
  const duplicate = await exec(process.execPath, [cli, 'routine', 'run', id, '--json'], { cwd, env, timeout: 15000 });
  assert.equal(JSON.parse(duplicate.stdout).outcome, 'duplicate');
  fs.appendFileSync(path.join(root, 'terminal-input.jsonl'), JSON.stringify('/exit') + '\n');
  await waitFor(() => {
    receipt = JSON.parse(fs.readFileSync(receiptFile));
    return receipt.interactiveTui.status === 'exited' && fs.existsSync(path.join(root, 'pty-exit.json'));
  }, 'normal terminal exit and receipt');
  assert.equal(receipt.exitCode, 0);
  const ended = JSON.parse(fs.readFileSync(path.join(root, 'pty-exit.json'))); assert.equal(ended.exit, 0); assert.equal(ended.challenge, false);
  const after = await loadRedisRuntime({ homeDir: home, provider: 'anthropic' });
  try { assert.equal(await after.store.client.get(`${config.redis.keyPrefix}lease:credential:anthropic:${selected}`), null); }
  finally { await closeRedisRuntime(after); }
  const observations = { passed: true, platform: process.platform, checkedAt: new Date().toISOString(),
    actualOsCalendar: true, publicRoutineCli: true, exactGeneratedWorkerCommand: true, realSacrificialAccount: selected,
    syntheticToolCompleted: true, assignedExit: true, promptAdmitted: true, jobDone: true, terminalRemainedAvailable: true,
    duplicateSuppressed: true, normalExit: true, leaseReleased: true, humanChallenge: false };
  fs.writeFileSync(path.join(root, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log(JSON.stringify({ root, observations }));
} finally {
  if (installed) await exec('sudo', ['-n', ...(mac ? ['/bin/launchctl', 'bootout', 'system/' + label]
    : ['systemctl', 'stop', unit + '.timer', unit + '.service'])]).catch(() => {});
  if (installedPlist) await exec('sudo', ['-n', 'rm', '-f', '--', installedPlist]).catch(() => {});
  const driver = path.join(root, 'pty-driver-pid');
  if (fs.existsSync(driver) && !fs.existsSync(path.join(root, 'pty-exit.json'))) {
    try { process.kill(Number(fs.readFileSync(driver)), 'SIGTERM'); } catch {}
  }
  fs.writeFileSync(configFile, originalConfig, { mode: 0o600 });
  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(socketPath); } catch {}
}
