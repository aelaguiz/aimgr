/** Exercise the actual approved Mac route, supervisor and vendor in a PTY.
 * All credentials and requests belong to the outer offsite synthetic fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runClaudeCli } from '../src/targets/claude-runner.js';

export async function verifyControls(input) {
  assert.equal(process.platform, 'darwin');
  const home = input.userHomeDir, cwd = input.cwd;
  assert.ok(home.startsWith('/opt/aimgr-state-audit/claude-implementation/'));
  if (!input.controlPty) {
    const driver = fileURLToPath(new URL('./privacy-control-pty.py', import.meta.url));
    const entry = fileURLToPath(new URL('./privacy-integrated-launch-check.mjs', import.meta.url));
    const child = spawn('/usr/bin/python3', ['-I', driver, process.execPath, entry,
      JSON.stringify({ ...input, controlPty: true })], { stdio: 'inherit' });
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0);
    return;
  }
  const { check, captureFile, controlPty, ...launch } = input;
  const captures = () => fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const models = () => captures().filter(r => r.path.includes('/messages'));
  const wait = async (predicate, reason, timeout = 20000) => {
    const until = Date.now() + timeout;
    while (!predicate()) { if (Date.now() > until) throw new Error(reason); await delay(50); }
  };
  const tool = path.join(cwd, 'control-tool.py');
  fs.writeFileSync(tool, `import os,sys,time
from pathlib import Path
role=sys.argv[1];cwd=Path(${JSON.stringify(cwd)})
(cwd/(role+'.entered')).write_text(str(os.getpid()))
limit=time.time()+30
while not (cwd/(role+'.release')).exists() and time.time()<limit:time.sleep(.05)
print('NATIVE_CONTROL_TOOL_OK')
`);
  const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
    .trim().split('\n').map(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return match && { pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4] }; }).filter(Boolean);
  const start = role => {
    const abort = new AbortController(); let control, supervisor;
    const running = runClaudeCli({ ...launch, env: process.env,
      args: ['-p', `NATIVE_CONTROL_ROLE_${role}.`, '--model', 'sonnet', '--output-format', 'json', '--dangerously-skip-permissions'],
      signal: abort.signal, registerProcessControl: value => { control = value; },
      spawnImpl(command, args, options) { supervisor = spawn(command, args, options); return supervisor; } });
    running.catch(() => {});
    return { abort, running, control: () => control, supervisor: () => supervisor };
  };
  const result = {};
  for (const role of ['pause', 'hardkill']) {
    const before = execFileSync('/usr/bin/python3', ['-I', '-c', 'import json,termios,os;print(json.dumps({"termios":termios.tcgetattr(0),"foreground":os.tcgetpgrp(0),"pgrp":os.getpgrp()},default=lambda b:list(b)))'], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8' });
    fs.writeFileSync(path.join(home, role + '-termios-before.private.json'), before);
    const work = start(role);
    let toolPid;
    try {
      await wait(() => fs.existsSync(path.join(cwd, role + '.entered')), role + ' native tool');
      toolPid = Number(fs.readFileSync(path.join(cwd, role + '.entered')));
      const native = processes().find(p => p.ppid === work.supervisor().pid);
      assert.ok(native?.command.endsWith('/claude'), 'supervisor direct child must be the real vendor');
      result.directVendorPid = true;
      if (role === 'pause') {
        assert.equal(await work.control().pause(), true);
        assert.ok(processes().find(p => p.pid === native.pid)?.state.includes('T'));
        const before = models().length;
        fs.writeFileSync(path.join(cwd, role + '.release'), 'ok');
        await delay(500);
        assert.equal(models().length, before, 'paused vendor must not send the completed tool result');
        assert.equal(await work.control().resume(), true);
        assert.equal((await work.running).status, 0);
        assert.ok(models().length > before);
        result.pauseStopsVendorRequests = true; result.resumeCompletesTurn = true;
      } else {
        // Native Bash intentionally lacks a controlling terminal. Change the
        // same inherited PTY from the test controller after native startup,
        // then kill Claude; only the surviving supervisor may restore it.
        execFileSync('/usr/bin/python3', ['-I', '-c', 'import tty,termios;tty.setraw(0);a=termios.tcgetattr(0);assert not a[3] & (termios.ICANON|termios.ECHO|termios.ISIG)'], { stdio: [0, 'ignore', 'ignore'] });
        process.kill(native.pid, 'SIGKILL');
        const stopped = await work.running;
        assert.equal(stopped.signal, 'SIGKILL');
        assert.ok(!processes().some(p => p.pid === native.pid));
        result.forcedKillStopsVendor = true;
        // The independent PTY parent compares every saved termios field now,
        // while this outer AIM/controller process remains alive.
        fs.writeFileSync(path.join(home, 'control-tty-ready'), 'ok');
        await wait(() => fs.existsSync(path.join(home, 'control-tty-checked')), 'terminal restoration check');
        assert.equal(fs.readFileSync(path.join(home, 'control-tty-checked'), 'utf8'), 'ok');
        result.terminalRestoredWhileAimAlive = true;
      }
    } finally {
      work.abort.abort(); await work.running.catch(() => {});
      if (toolPid && processes().some(p => p.pid === toolPid && p.command.toLowerCase().includes('python'))) {
        try { process.kill(toolPid, 'SIGTERM'); } catch {}
      }
    }
  }
  const hold = path.join(home, 'hold-route-probe');
  fs.writeFileSync(hold, 'hold');
  const before = models().length, work = start('cancel');
  try {
    await wait(() => work.supervisor() && processes().some(p => p.ppid === work.supervisor().pid
      && p.command.toLowerCase().includes('python')), 'actual route preflight');
    work.abort.abort();
    const stopped = await work.running;
    assert.ok(stopped.status !== 0 || stopped.signal);
    fs.unlinkSync(hold); await delay(500);
    assert.equal(models().length, before);
    result.preflightCancellationStartsNoVendor = true;
  } finally {
    if (fs.existsSync(hold)) fs.unlinkSync(hold);
    work.abort.abort(); await work.running.catch(() => {});
  }
  fs.writeFileSync(path.join(home, 'controls.json'), JSON.stringify({ passed: true, ...result }));
}
