/** Paired offsite test of the actual request owner. The enabled baseline uses
 * the same reviewed official bytes at a separate pathname, outside AIM, with
 * synthetic credentials and independent outbound denial. Production admission
 * has no override. Admission, settings and the startup pin are a combined
 * protection; a fresh namespace separately proves AIM refuses new supervisors. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareClaudeCliLaunch, buildContainedLaunchEnvironment, runClaudeCli, runClaudeCliNoninteractive } from '../src/targets/claude-runner.js';

export async function verifyDetached(input) {
  assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST'));
  assert.notEqual(process.getuid(), 0);
  assert.equal(input.mode, 'ordinary'); // Protection/routing is exercised separately.
  const { check, captureFile, ...launch } = input;
  const root = launch.userHomeDir, observations = [];
  const capture = () => {
    const text = fs.readFileSync(captureFile, 'utf8');
    // The separate HTTP process may be halfway through a large JSONL append.
    // Parse only committed lines; do not swallow malformed complete records.
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
  };
  const models = () => capture().filter(r => r.path.includes('/messages'));
  const inventory = () => JSON.parse(execFileSync('/usr/bin/python3', ['-I', new URL('../native/claude/runtime_inventory.py', import.meta.url).pathname], { encoding: 'utf8' }));
  const owned = image => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-c', `
import ctypes,json,os,subprocess,sys
rows=[];lib=ctypes.CDLL('/usr/lib/libproc.dylib') if sys.platform=='darwin' else None
for line in subprocess.check_output(['/bin/ps','-axo','pid=,ppid='],text=True).splitlines():
 try:
  pid,parent=map(int,line.split())
  if lib:
   buf=ctypes.create_string_buffer(4096)
   if lib.proc_pidpath(pid,buf,len(buf))<=0: continue
   exe=os.fsdecode(buf.value)
  else: exe=os.readlink('/proc/'+str(pid)+'/exe')
  if exe==sys.argv[1]: rows.append({'pid':pid,'parent':parent})
 except (OSError,ValueError): pass
print(json.dumps(rows))
`, image], { encoding: 'utf8' }));

  const note = (name, details = {}) => { observations.push({ name, passed: true, ...details }); fs.writeFileSync(path.join(root, 'detached.json'), JSON.stringify({ observations }, null, 2)); };
  const until = async (condition, reason) => { const end = Date.now() + 20000; while (!condition()) { assert.ok(Date.now() < end, reason); await delay(100); } };
  const run = async (command, args, env, fd) => {
    const child = spawn(command, args, { cwd: launch.cwd, env, stdio: ['ignore', 'pipe', 'pipe', fd ?? 'ignore'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    const { code, signal } = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    clearTimeout(timer); fs.appendFileSync(path.join(root, 'detached-output.private.txt'), output);
    assert.equal(timedOut, false, 'native probe timed out'); assert.equal(signal, null, 'native probe died by signal');
    return { code, output, timedOut, signal };
  };
  const prepared = await prepareClaudeCliLaunch(launch);
  const baselineEnv = buildContainedLaunchEnvironment({ preparedLaunch: prepared, env: process.env });
  delete baselineEnv.CLAUDE_CODE_DISABLE_AGENT_VIEW;
  const currentEnv = { ...baselineEnv, CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' };
  const turn = await runClaudeCliNoninteractive({ ...launch, args: ['-p', 'Reply SYNTHETIC_OK.'], env: currentEnv, timeoutMs: 30000 });
  assert.equal(turn.status, 0);
  const settingsFile = path.join(launch.configDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ skipDangerousModePermissionPrompt: true, disableAgentView: false, env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' } }));
  const stateFile = path.join(launch.configDir, '.claude.json');
  const state = JSON.parse(fs.readFileSync(stateFile)); state.defaultToAgentsView = true; fs.writeFileSync(stateFile, JSON.stringify(state));
  const old = path.join(root, 'claude-baseline'); fs.copyFileSync(launch.command, old); fs.chmodSync(old, 0o700);
  const daemonLog = fs.openSync(path.join(root, 'daemon-output.private.txt'), 'w');
  const daemon = spawn(old, ['daemon', 'run'], { cwd: launch.cwd, env: baselineEnv, stdio: ['ignore', daemonLog, daemonLog] });
  fs.closeSync(daemonLog);
  let daemonExited = false; daemon.once('exit', () => { daemonExited = true; });
  try {
    await until(() => { assert.equal(daemonExited, false, 'baseline daemon exited; inspect daemon-output.private.txt');
      fs.writeFileSync(path.join(root, 'owner-inventory.private.json'), JSON.stringify(inventory()));
      return inventory().processes.some(p => p.pid === daemon.pid && p.role === 'detached-supervisor'); }, 'baseline daemon identity');
    await delay(500);
    const before = models().length;
    const baseline = await run(old, ['--bg', '--name', 'synthetic-baseline', 'Reply SYNTHETIC_OK. BASELINE_DETACHED.', '--dangerously-skip-permissions', '--model', 'sonnet'], baselineEnv);
    assert.equal(baseline.code, 0, 'enabled native baseline must dispatch');
    await until(() => models().length > before, 'baseline model request');
    await delay(2000);
    assert.equal(daemonExited, false);
    const dispatchAgain = await run(launch.command, ['--bg', '--name', 'synthetic-second-baseline', 'Reply SYNTHETIC_OK. BASELINE_SECOND.', '--dangerously-skip-permissions', '--model', 'sonnet'], baselineEnv);
    assert.equal(dispatchAgain.code, 0);
    await until(() => models().some(r => JSON.stringify(r.body).includes('BASELINE_SECOND')), 'second baseline model request');
    const workers = owned(old).filter(p => p.parent === daemon.pid);
    assert.ok(workers.length >= 2, 'both jobs must run under the old executable/daemon');
    const roles = inventory().processes;
    assert.ok(workers.every(p => roles.some(r => r.pid === p.pid && r.role === 'detached-worker')), 'kernel role agrees with observed daemon children');
    note('enabled-baseline-uses-existing-old-path-supervisor', { sameReviewedVendorBytes: true, daemonSurvivedDispatcher: true,
      secondDispatcherUsedCandidateVendorPath: true, workersUseBaselineExecutable: true, workersAreDaemonChildren: true, workerCount: workers.length });
    for (const args of [['--bg', 'DISALLOWED_NEW_JOB'], ['--background', 'DISALLOWED_NEW_JOB'], ['-cn', '--bg'], ['mcp', 'add', '--bg'], ['--name', '--', '--bg'], ['agents'], ['daemon', 'run'], ['daemon', 'status'], ['attach', 'synthetic-baseline'], ['logs'], ['stop', '1234abcd'], ['kill', '1234abcd'], ['respawn', '--all'], ['rm', '1234abcd'], ['--model', 'sonnet', 'attach', '1234abcd']]) {
      const beforeRequests = models().length;
      await assert.rejects(runClaudeCliNoninteractive({ ...launch, args, env: currentEnv }), /detached Claude sessions|daemon commands/);
      await assert.rejects(runClaudeCli({ ...launch, preparedLaunch: { ...prepared, userHooksPath: settingsFile }, args, env: currentEnv }), /detached Claude sessions|daemon commands/);
      assert.equal(models().length, beforeRequests);
      assert.equal(daemonExited, false);
    }
    note('aim-refuses-detached-and-management-intent-without-model-request');
    const followup = await runClaudeCliNoninteractive({ ...launch, args: ['-p', 'daemon'], env: currentEnv, timeoutMs: 30000 });
    assert.equal(followup.status, 0);
    assert.equal(daemonExited, false);
    note('literal-daemon-prompt-remains-a-normal-session');
    // Only this exact disposable child is signaled. Recheck kernel identity and
    // role first; PID alone is not an ownership proof for manual transitions.
    assert.ok(inventory().processes.some(p => p.pid === daemon.pid && p.role === 'detached-supervisor'));
    daemon.kill('SIGTERM'); await until(() => daemonExited, 'targeted baseline shutdown');
    note('targeted-disposable-supervisor-shutdown');

    // An existing daemon can make an unprotected bootstrap exit with "already
    // running". That is not evidence that the pin prevents a fresh supervisor.
    // Use a new account and temp namespace, prove it can host an enabled owner,
    // retire that exact control, then test actual AIM in the now-idle namespace.
    // Do not bypass shared admission: the native bootstrap can reload disk env
    // before consulting a startup pin, so that pin is not an independent gate.
    const freshHome = path.join(root, '.aimgr', 'claude-homes', 'fresh-daemon-account');
    const freshConfig = path.join(freshHome, '.claude');
    const freshTemp = path.join(root, 'fresh-daemon-tmp');
    fs.mkdirSync(freshConfig, { recursive: true }); fs.mkdirSync(freshTemp);
    for (const file of ['.claude.json', '.credentials.json', 'settings.json']) {
      fs.copyFileSync(path.join(launch.configDir, file), path.join(freshConfig, file));
    }
    const freshEnv = { ...baselineEnv, CLAUDE_CONFIG_DIR: freshConfig, CLAUDE_SECURESTORAGE_CONFIG_DIR: freshConfig,
      TMPDIR: freshTemp, CLAUDE_CODE_TMPDIR: freshTemp };
    const control = spawn(old, ['daemon', 'run'], { cwd: launch.cwd, env: freshEnv, stdio: 'ignore' });
    let controlExited = false; control.once('exit', () => { controlExited = true; });
    try {
      await until(() => { assert.equal(controlExited, false); return inventory().processes.some(p => p.pid === control.pid && p.role === 'detached-supervisor'); }, 'fresh enabled supervisor');
      control.kill('SIGTERM'); await until(() => controlExited, 'fresh control shutdown');
      assert.ok(!owned(old).some(p => p.pid === control.pid));
      const freshLaunch = { ...launch, homeDir: freshHome, configDir: freshConfig };
      const freshPrepared = await prepareClaudeCliLaunch(freshLaunch);
      const beforeRequests = models().length;
      const beforeOwners = new Set([...owned(old), ...owned(launch.command)].map(p => p.pid));
      const hostileEnv = { ...freshEnv, CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' };
      await assert.rejects(runClaudeCliNoninteractive({ ...freshLaunch, args: ['daemon', 'run'], env: hostileEnv }), /daemon commands/);
      await assert.rejects(runClaudeCli({ ...freshLaunch, preparedLaunch: { ...freshPrepared, userHooksPath: path.join(freshConfig, 'settings.json') },
        args: ['daemon', 'run'], env: hostileEnv }), /daemon commands/);
      await delay(500);
      assert.ok([...owned(old), ...owned(launch.command)].every(p => beforeOwners.has(p.pid)), 'fresh AIM launch creates no supervisor or worker');
      assert.equal(models().length, beforeRequests);
      note('aim-prevents-fresh-supervisor-after-enabled-control', { freshAccountAndTempNamespace: true,
        enabledControlCreatedSupervisor: true, controlStoppedBeforeNegative: true, candidateImageAlsoInspected: true,
        interactiveAndNoninteractive: true, conflictingUserEnvironment: true });
    } finally { if (!controlExited) { control.kill('SIGTERM'); await until(() => controlExited, 'fresh control cleanup'); } }
    return { observations };
  } finally {
    // All matches have this fresh fixture's exact copied kernel image; never
    // signal unrelated approved sessions or infer ownership from an argv word.
    for (const owner of owned(old)) { try { process.kill(owner.pid, 'SIGTERM'); } catch {} }
    await delay(500);
    for (const owner of owned(old)) { try { process.kill(owner.pid, 'SIGKILL'); } catch {} }
    await until(() => owned(old).length === 0, 'disposable owner cleanup');
    fs.rmSync(old, { force: true });
  }
}
