#!/usr/bin/env node
// Finite native-client comparisons for remote build/database recovery (2) and
// SSH/device-file recovery mechanics (3). These finite fixtures do not establish
// physical-phone acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { prepareCodexAccountState } from '../src/privacy/codex-account-state.js';
import { prepareCodexNativeInvocation } from '../src/privacy/codex-native-invocation.js';
import { readCodexEnvironment } from '../src/privacy/codex-environment.js';

assert(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST') && process.getuid() !== 0);
if (process.platform === 'linux') assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
const which = Number(process.argv.find(x => x.startsWith('--case='))?.split('=')[1]);
assert([2, 3].includes(which), 'select --case=2 or --case=3');
const machines = process.argv.includes('--machines');
if (machines) assert(process.platform === 'darwin' && which === 2 && process.env.AIM_WORKLOAD_MACHINES_ROOT, 'original machines wrapper runs from isolated Mac');
// machines' unchanged SSH ControlPath includes HOME plus a 40-byte host hash;
// Darwin allows at most 103 bytes, so keep these disposable homes short.
const root = fs.mkdtempSync(machines ? '/Users/aelaguiz-t/' : `/opt/aimgr-state-audit/codex-m1-fixtures/remote-device-${which}-`);
const q = x => "'" + String(x).replaceAll("'", "'\\''") + "'";
const put = (file, bytes, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, mode ? { mode } : undefined); };
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options });
const rows = [];
console.log(JSON.stringify({ fixture: root, case: which }));
put(path.join(root, 'inputs.json'), JSON.stringify({ candidateCommit: process.env.AIM_WORKLOAD_CANDIDATE_COMMIT || null,
  fixtureScriptSha256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
  nativeSha256: createHash('sha256').update(fs.readFileSync('/opt/aimgr-state-audit/bin/codex')).digest('hex'),
  host: { platform: process.platform, architecture: process.arch, release: os.release() },
  model: 'synthetic loopback endpoint; gpt-5.4 tool schema', permissionMode: 'danger-full-access',
  substitutes: which === 2 ? { compiler: 'C fixture, cc; no Rust acceptance claimed' } : { phone: 'disposable directory and writer only' } }, null, 2));

// The unprivileged test sshd and test keys exist inside the disposable host and
// loopback namespace. No normal authorization or host SSH configuration is used.
const sshDir = path.join(root, 'ssh'); fs.mkdirSync(sshDir);
let sshd, sshLog, sshPort = 22222;
if (!machines) {
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sshDir, 'client')]);
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sshDir, 'host')]);
put(path.join(sshDir, 'authorized_keys'), fs.readFileSync(path.join(sshDir, 'client.pub')), 0o600);
const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
sshPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
put(path.join(sshDir, 'sshd_config'), `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${sshDir}/host\nPidFile ${sshDir}/sshd.pid\nAuthorizedKeysFile ${sshDir}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nUseDNS no\nAllowUsers ${os.userInfo().username}\nSubsystem sftp internal-sftp\n`);
sshLog = fs.openSync(path.join(root, 'sshd.log'), 'a');
sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(sshDir, 'sshd_config')], { stdio: ['ignore', sshLog, sshLog] });
await new Promise(resolve => setTimeout(resolve, 200));
assert(sshd.exitCode === null, `test sshd failed; see ${root}/sshd.log`);
}

let fixtureFailure;
try {
  for (const protectedLaunch of [false, true]) {
    const name = protectedLaunch ? 'protected' : 'stock';
    const homeDir = path.join(root, machines ? (protectedLaunch ? 'p' : 's') : name), cwd = path.join(homeDir, 'workspace/current'), shared = path.join(homeDir, '.codex');
    const remote = machines ? cwd : path.join(root, `${name}-remote checkout`), returned = path.join(cwd, 'returned files');
    for (const dir of [cwd, shared, ...(machines ? [] : [remote]), returned]) fs.mkdirSync(dir, { recursive: true });
    const key = path.join(homeDir, '.ssh/workload-key'), config = path.join(homeDir, '.ssh/config');
    put(key, fs.readFileSync(machines ? '/Users/aelaguiz-workload-test/.ssh/build-key' : path.join(sshDir, 'client')), 0o600);
    put(config, `Host workload-target\n HostName 127.0.0.1\n Port ${sshPort}\n User ${machines ? 'aimdev' : os.userInfo().username}\n IdentityFile ${key}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile ${homeDir}/.ssh/known_hosts\n ControlMaster no\n`, 0o600);
    const container = `aim-workload-${name}-${path.basename(root).split('-').at(-1)}`.toLowerCase();
    const options = { case: which, remote, returned, config, container, dockerHost: process.env.DOCKER_HOST || '', ...(machines ? { machines: path.join(process.env.AIM_WORKLOAD_MACHINES_ROOT, 'scripts/machines') } : {}) };
    put(path.join(cwd, 'options.json'), JSON.stringify(options, null, 2));
    put(path.join(cwd, 'remote.py'), remoteProgram());
    put(path.join(cwd, 'driver.py'), driverProgram());
    if (machines) run('git', ['init', '-q', cwd]);
    const requests = [], outputs = new Map(), invocations = [];
    let stage = 'start', served = false, lastCallId, invocation, child, timer, serverError;
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let bytes = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
        if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
        const body = JSON.parse(bytes); requests.push(body);
        for (const item of body.input || []) if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) outputs.set(item.call_id, item.output);
        const running = lastCallId && /Process running with session ID (\d+)/.exec(String(outputs.get(lastCallId)));
        const item = !served ? { type: 'function_call', call_id: stage, name: 'exec_command', arguments: JSON.stringify({ cmd: `python3 ${q(path.join(cwd, 'driver.py'))} ${q(stage)}`, login: false, yield_time_ms: 10000, max_output_tokens: 2000 }) }
          : running ? { type: 'function_call', call_id: `${stage}-poll-${requests.length}`, name: 'write_stdin', arguments: JSON.stringify({ session_id: Number(running[1]), chars: '', yield_time_ms: 1000, max_output_tokens: 2000 }) }
          : { type: 'message', role: 'assistant', id: `done-${stage}`, content: [{ type: 'output_text', text: 'Finite remote sequence completed.' }] };
        if (item.type === 'function_call') lastCallId = item.call_id;
        served = true;
        const id = `remote-${name}-${requests.length}`;
        const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
      } catch (error) { serverError ??= error; res.writeHead(500); res.end(String(error)); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    put(path.join(shared, 'config.toml'), `model="gpt-5.4"\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${server.address().port}"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
    const env = { HOME: homeDir, CODEX_HOME: shared, PATH: '/opt/aimgr-state-audit/node/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
    const stdout = [], stderr = [];
    async function native(args) {
      invocation = undefined;
      if (protectedLaunch) {
        const prepared = { ...prepareCodexAccountState({ homeDir, cwd, env, environment: readCodexEnvironment(), accountId: 'api-provider:deepseek', label: 'fixture' }), keyBacked: true };
        invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, env, args });
      }
      invocations.push({ args, cwd, permissionMode: 'danger-full-access', protectedLaunch });
      child = spawn(invocation?.command ?? '/opt/aimgr-state-audit/bin/codex', invocation?.args ?? args, { cwd, env: invocation?.env ?? env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(invocation ? [invocation.environmentFd] : [])] });
      invocation?.closeEnvironment(); child.stdout.on('data', x => stdout.push(x)); child.stderr.on('data', x => stderr.push(x));
      timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 90_000);
      const [code, signal] = await once(child, 'close'); clearTimeout(timer);
      if (serverError) throw serverError;
      assert.equal(code, 0, `${name} native exit ${code}/${signal}; see ${root}`);
      await invocation?.close();
    }
    let primaryFailure;
    try {
      await native(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', 'Run the finite synthetic remote task.']);
      assert.match([...outputs].filter(([id]) => id.startsWith('start')).map(([, output]) => String(output)).join('\n'), /START_OK/, `first-stage remote tool failed: ${JSON.stringify([...outputs])}`);
      const thread = Buffer.concat(stdout).toString().split('\n').filter(Boolean).map(x => JSON.parse(x)).find(x => x.type === 'thread.started')?.thread_id;
      assert(thread, 'resume must use event-reported thread');
      stage = 'recover'; served = false; lastCallId = undefined;
      await native(['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', thread, 'Inspect remote state and recover the interrupted task.']);
      assert.match([...outputs].filter(([id]) => id.startsWith('recover')).map(([, output]) => String(output)).join('\n'), /RECOVERY_OK/, `recovery tool failed: ${JSON.stringify([...outputs])}`);
      const receipt = JSON.parse(fs.readFileSync(path.join(returned, 'receipt.json')));
      assert(receipt.sourceWithoutGit);
      if (which === 2) { assert(receipt.databaseDelaySeconds >= 1.5); assert(receipt.readinessInitialWaitExpired); assert(receipt.sameReadinessProcess); assert(receipt.missingBuildIdentityDetected); assert(receipt.connectionInterrupted); assert(receipt.generatedOutputHash); }
      else { assert.equal(receipt.restoredFiles, 3); assert(receipt.hashesMatch); assert(receipt.wrongProcessRefused); assert(receipt.parentHoldPreserved); assert(receipt.failedQuotingDetected); }
      rows.push({ case: which, launch: name, actualNativeTools: true, actualSshScp: true, sameAccountThreadResumed: true, ...(which === 3 ? { realDevice: 'not run; disposable transport fixture only' } : { machinesWrapper: machines ? 'original installed scripts, test-only host configuration' : 'not run on Linux; Mac comparison owns original wrapper' }), ...receipt });
      console.log(JSON.stringify(rows.at(-1)));
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      clearTimeout(timer);
      const cleanupErrors = [];
      try {
        put(path.join(root, `${name}-stdout.log`), Buffer.concat(stdout)); put(path.join(root, `${name}-stderr.log`), Buffer.concat(stderr));
        put(path.join(root, `${name}-requests.json`), JSON.stringify(requests, null, 2)); put(path.join(root, `${name}-tool-results.json`), JSON.stringify([...outputs], null, 2)); put(path.join(root, `${name}-invocations.json`), JSON.stringify(invocations, null, 2));
      } catch (error) { cleanupErrors.push(error); }
      if (child?.exitCode === null && child?.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      try { await invocation?.close(); } catch (error) { cleanupErrors.push(error); }
      try {
        const output = run('python3', [path.join(cwd, 'driver.py'), 'cleanup'], { cwd, env: { ...process.env, HOME: homeDir } });
        put(path.join(root, `${name}-cleanup.json`), JSON.stringify({ passed: true, output }, null, 2));
      } catch (error) {
        cleanupErrors.push(error);
        try { put(path.join(root, `${name}-cleanup.json`), JSON.stringify({ passed: false, error: String(error), stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }, null, 2)); }
        catch (writeError) { cleanupErrors.push(writeError); }
      }
      try { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) {
        if (primaryFailure) primaryFailure.cleanupErrors = cleanupErrors;
        else throw new AggregateError(cleanupErrors, 'Failed to clean up remote workload fixture');
      }
    }
  }
  put(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ fixture: root, finiteTransportComparisonPassed: true, results: rows }));
} catch (error) {
  fixtureFailure = error;
  throw error;
} finally {
  if (sshd) {
    try {
      if (sshd.exitCode === null && sshd.signalCode === null) { sshd.kill('SIGTERM'); await once(sshd, 'close'); }
      fs.closeSync(sshLog);
    } catch (error) {
      if (fixtureFailure) fixtureFailure.cleanupErrors = [...(fixtureFailure.cleanupErrors || []), error];
      else throw error;
    }
  }
}

// These short scripts run as the ordinary tool, then on the actual SSH target.
// Both native clients receive identical programs and independent seeded state.
function driverProgram() { return String.raw`import hashlib,json,os,pathlib,shlex,signal,subprocess,sys,time
here=pathlib.Path(__file__).parent
c=json.loads((here/'options.json').read_text())
ssh=['ssh','-F',c['config'],'workload-target']
scp=['scp','-q','-F',c['config']]
remote=c['remote']; returned=pathlib.Path(c['returned'])
def call(args,check=True,**kw):
 r=subprocess.run(args,capture_output=True,text=True,**kw)
 if check and r.returncode: raise AssertionError(str(args)+' failed '+str(r.returncode)+' '+r.stdout+' '+r.stderr)
 return r
def shell(text,check=True): return call(ssh+[text],check)
def operation(op,check=True):
 env=('DOCKER_HOST='+shlex.quote(c['dockerHost'])+' ') if c['dockerHost'] else ''
 return shell('cd '+shlex.quote(remote)+' && env '+env+'GIT_COMMIT=synthetic-workload-commit TEST_TOOLCHAIN=cc python3 remote.py '+op,check)
def wrapped(op,missing=False,background=False):
 env=('DOCKER_HOST='+shlex.quote(c['dockerHost'])+' ') if c['dockerHost'] else ''
 command='env '+('-u GIT_COMMIT ' if missing else env+'GIT_COMMIT=synthetic-workload-commit TEST_TOOLCHAIN=cc ')+'python3 remote.py '+op
 args=[c['machines'],'run','--host','fixture','--only',str(here),'--',command]
 if background:
  log=(here/'local-interruption.log').open('ab')
  return subprocess.Popen(args,stdout=log,stderr=log)
 return call(args,not missing,cwd=here)
if sys.argv[1]=='cleanup':
 result=operation('cleanup',False)
 print(result.stdout,end=''); print(result.stderr,end='',file=sys.stderr)
 sys.exit(result.returncode)
if sys.argv[1]=='start':
 if not c.get('machines'):
  shell('mkdir -p '+shlex.quote(remote))
  call(scp+[str(here/'remote.py'),'workload-target:'+remote+'/remote.py'])
  call(scp+[str(here/'options.json'),'workload-target:'+remote+'/options.json'])
 if c['case']==2:
  missing=wrapped('build',missing=True) if c.get('machines') else shell('cd '+shlex.quote(remote)+' && env -u GIT_COMMIT python3 remote.py build',False)
  assert missing.returncode==17 and 'MISSING_GIT_COMMIT' in missing.stdout,(missing.returncode,missing.stdout,missing.stderr)
  result=wrapped('build') if c.get('machines') else operation('build'); print(result.stdout,end='')
  # Losing this connection must leave a deliberately detached, progressing
  # run-owned process discoverable from the next real native invocation.
  p=wrapped('interrupted',background=True) if c.get('machines') else subprocess.Popen(ssh+['cd '+shlex.quote(remote)+' && nohup python3 remote.py survivor > survivor.log 2>&1 < /dev/null & wait'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  for _ in range(50):
   r=shell('test -f '+shlex.quote(remote+('/interrupted.pid' if c.get('machines') else '/survivor.pid')),False)
   if r.returncode==0: break
   time.sleep(.05)
  else: raise AssertionError('survivor did not start')
  p.terminate(); p.communicate(timeout=3); assert p.returncode!=0
  (here/'interrupted.json').write_text(json.dumps({'sshReturncode':p.returncode}))
 else:
  result=operation('device-start'); print(result.stdout,end='')
 print('START_OK',flush=True)
elif sys.argv[1]=='recover':
 result=operation('recover' if c['case']==2 else 'device-recover'); print(result.stdout,end='')
 if c.get('machines'):
  # The unchanged wrapper mirrors local source on retry. Preserve the actual
  # remote recovery records before that upload replaces remote-only files.
  for rel in ['interrupted.log','interrupted.pid','receipt.json']:
   call(scp+['workload-target:'+remote+'/'+rel,str(here/rel)])
  result=wrapped('recover'); print(result.stdout,end='')
 files=['receipt.json','generated/build-result.txt','generated/db-result.txt','generated/test-output.txt',('interrupted.log' if c.get('machines') else 'survivor.log')] if c['case']==2 else ['receipt.json','capture with spaces.txt','baseline-hashes.json','restored-hashes.json','parent.hold']
 for rel in files:
  dest=returned/pathlib.Path(rel).name
  call(scp+['workload-target:'+remote+'/'+rel,str(dest)])
 receipt=json.loads((returned/'receipt.json').read_text())
 if c['case']==2:
  assert (here/'interrupted.json').exists()
  receipt['connectionInterrupted']=True
  if c.get('machines'):
   assert 'INTERRUPTED_READY' in (returned/'interrupted.log').read_text()
   logs=[json.loads(x) for x in (pathlib.Path.home()/'.cache/machines/runs.log').read_text().splitlines()]
   assert any(x['back']>0 and x['exit']==0 for x in logs)
   receipt['wrapperReturnedFiles']=sum(x['back'] for x in logs)
   receipt['wrapperReceiptCount']=len(logs)
   (returned/'machines-runs.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in logs))
  else: assert 'SURVIVOR_DONE' in (returned/'survivor.log').read_text()
  receipt['generatedOutputHash']=hashlib.sha256((returned/'build-result.txt').read_bytes()).hexdigest()
  assert (returned/'build-result.txt').read_text()=='synthetic-workload-commit:6\n'
 else: assert (returned/'parent.hold').read_text()=='parent-owned-do-not-release\n'
 (returned/'receipt.json').write_text(json.dumps(receipt,indent=2))
 operation('cleanup')
 print('RECOVERY_OK',flush=True)
else: raise AssertionError('unknown phase')
`; }

function remoteProgram() { return String.raw`import hashlib,json,os,pathlib,shutil,signal,subprocess,sys,time
root=pathlib.Path(__file__).parent; os.chdir(root)
c=json.loads((root/'options.json').read_text()); container=c['container']
def call(args,check=True,**kw):
 r=subprocess.run(args,capture_output=True,text=True,**kw)
 if check and r.returncode: raise AssertionError(str(args)+' failed '+str(r.returncode)+' '+r.stdout+' '+r.stderr)
 return r
def docker(*args,check=True): return call(['docker',*args],check)
def sql(s,check=True): return docker('exec',container,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',s,check=check)
def hashes(folder): return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob('*')) if p.is_file()}
def owned_pid(file,needle):
 pid=int((root/file).read_text()); r=call(['ps','-p',str(pid),'-o','args='],False)
 return pid,needle in r.stdout
def stop_writer(file):
 pid,correct=owned_pid(file,str(root/'writer.py'))
 if not correct: raise PermissionError('refusing PID whose command is not this run-owned writer')
 os.kill(pid,signal.SIGTERM)
op=sys.argv[1]
if op=='build':
 if not os.environ.get('GIT_COMMIT'):
  print('MISSING_GIT_COMMIT'); sys.exit(17)
 assert not (root/'.git').exists(); assert os.environ['TEST_TOOLCHAIN']=='cc'
 generated=root/'generated'; generated.mkdir(exist_ok=True)
 (root/'fixture.c').write_text('#include <stdio.h>\n#ifndef BUILD_COMMIT\n#error missing build identity\n#endif\nint main(void){ printf("%s:%d\\n",BUILD_COMMIT,1+2+3);return 0;}\n')
 call(['cc','-std=c11','-O0','-DBUILD_COMMIT="'+os.environ['GIT_COMMIT']+'"','fixture.c','-o',str(generated/'fixture')])
 result=call([str(generated/'fixture')]).stdout; assert result=='synthetic-workload-commit:6\n'
 (generated/'build-result.txt').write_text(result)
 docker('run','-d','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine')
 for _ in range(120):
  if docker('exec',container,'pg_isready','-U','postgres',check=False).returncode==0: break
  time.sleep(.05)
 else: raise AssertionError('database not ready')
 identity=docker('inspect','--format={{.Id}}',container).stdout.strip()
 sql('CREATE TABLE fixture_values(v integer); INSERT INTO fixture_values VALUES (2),(5);')
 assert sql('SELECT sum(v) FROM fixture_values;').stdout.strip()=='7'
 (generated/'db-result.txt').write_text('sum=7\n'+sql('SHOW server_version;').stdout)
 # A readiness wait expires while the same worker makes real DB progress.
 readiness=subprocess.Popen(['python3','-c','import pathlib,subprocess,time;time.sleep(1);subprocess.run('+repr(['docker','exec',container,'psql','-U','postgres','-At','-c','SELECT 1'])+',check=True,stdout=subprocess.DEVNULL);pathlib.Path("readiness.done").write_text("ready")'])
 try: readiness.wait(timeout=.1); raise AssertionError('readiness unexpectedly immediate')
 except subprocess.TimeoutExpired: pass
 assert readiness.poll() is None; pid=readiness.pid
 readiness.wait(timeout=10); assert readiness.pid==pid and (root/'readiness.done').read_text()=='ready'
 # A real PostgreSQL lock outlasts a short timeout. An independent query
 # remains available, and retry succeeds after the original holder exits.
 began=time.monotonic()
 holder=subprocess.Popen(['docker','exec',container,'psql','-U','postgres','-At','-c','SELECT pg_advisory_lock(663322); SELECT pg_sleep(2);'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 for _ in range(50):
  if sql("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted;").stdout.strip()=='1': break
  time.sleep(.02)
 else: raise AssertionError('holder never acquired lock')
 blocked=sql("SET statement_timeout='100ms'; SELECT pg_advisory_lock(663322);",False)
 assert blocked.returncode!=0 and 'statement timeout' in blocked.stderr
 assert sql('SELECT sum(v) FROM fixture_values;').stdout.strip()=='7'
 holder.communicate(timeout=10); assert holder.returncode==0
 assert sql('SELECT pg_try_advisory_lock(663322);').stdout.strip()=='t'
 elapsed=time.monotonic()-began; assert elapsed>=1.5
 (generated/'test-output.txt').write_text('real-lock-timeout detected; independent query=7; retry succeeded\n')
 receipt={'sourceWithoutGit':True,'missingBuildIdentityDetected':True,'databaseDelaySeconds':elapsed,'readinessInitialWaitExpired':True,'sameReadinessProcess':True,'readinessPid':pid,'containerId':identity,'toolchain':call(['cc','--version']).stdout.splitlines()[0]}
 (root/'receipt.json').write_text(json.dumps(receipt,indent=2)); print('BUILD_DATABASE_OK',flush=True)
elif op=='survivor':
 (root/'survivor.pid').write_text(str(os.getpid())); print('SURVIVOR_READY',flush=True)
 for _ in range(8): print('progress',flush=True); time.sleep(.1)
 (root/'survivor.done').write_text('completed-once'); print('SURVIVOR_DONE',flush=True)
elif op=='interrupted':
 (root/'interrupted.pid').write_text(str(os.getpid()))
 (root/'interrupted.log').write_text('INTERRUPTED_READY\n'); print('INTERRUPTED_READY',flush=True)
 time.sleep(30)
 raise AssertionError('interruption was not performed')
elif op=='recover':
 receipt=json.loads((root/'receipt.json').read_text())
 assert docker('inspect','--format={{.Id}}',container).stdout.strip()==receipt['containerId']
 if c.get('machines'):
  pid=int((root/'interrupted.pid').read_text())
  for _ in range(120):
   state=call(['ps','-p',str(pid),'-o','stat='],False).stdout.strip()
   if not state or state.startswith('Z'): break
   time.sleep(.05)
  else: raise AssertionError('wrapper left interrupted command running')
  receipt['interruptedProcessStopped']=True
  receipt['remoteStateInspectedBeforeRetry']=True
  (root/'receipt.json').write_text(json.dumps(receipt,indent=2))
  (root/'generated/recovered.txt').write_text('remote state inspected; original container preserved\n')
 else:
  for _ in range(80):
   if (root/'survivor.done').exists(): break
   time.sleep(.05)
  else: raise AssertionError('detached process did not survive connection interruption')
  assert (root/'survivor.done').read_text()=='completed-once'
  assert (root/'survivor.log').read_text().count('SURVIVOR_READY')==1
 assert sql('SELECT count(*) FROM fixture_values;').stdout.strip()=='2'
 print('REMOTE_STATE_INSPECTED_NO_DUPLICATION',flush=True)
elif op=='device-start':
 data=root/'device/data'; backup=root/'backup'; data.mkdir(parents=True); backup.mkdir()
 for rel,text in [('app/a.txt','SYNTHETIC_ACCOUNT_STATE\n'),('app/nested/file with spaces.txt','SYNTHETIC_SAVED_DATA\n'),('settings.json','{"media":0,"brightness":96}\n')]:
  p=data/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)
 shutil.copytree(data,backup,dirs_exist_ok=True)
 (root/'baseline-hashes.json').write_text(json.dumps(hashes(data),sort_keys=True))
 (root/'parent.hold').write_text('parent-owned-do-not-release\n')
 (root/'writer.py').write_text('import os,pathlib,time\nr=pathlib.Path(__file__).parent\n(r/"writer.pid").write_text(str(os.getpid()))\np=(r/"capture with spaces.txt").open("a")\nwhile True:p.write("captured-frame\\n");p.flush();time.sleep(.05)\n')
 subprocess.Popen(['python3',str(root/'writer.py')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 (data/'app/a.txt').write_text('changed-by-interrupted-worker\n'); (data/'extra.tmp').write_text('extra')
 (data/'settings.json').write_text('{"media":7,"brightness":10}\n')
 for _ in range(50):
  if (root/'writer.pid').exists(): break
  time.sleep(.02)
 else: raise AssertionError('writer not ready')
 print('DEVICE_FIXTURE_INTERRUPTED',flush=True)
elif op=='device-recover':
 pid,correct=owned_pid('writer.pid','writer.py'); assert correct
 (root/'wrong.pid').write_text(str(os.getpid()))
 refused=False
 try: stop_writer('wrong.pid')
 except PermissionError: refused=True
 assert refused
 os.kill(os.getpid(),0)
 quote=call(['sh','-c',"cat 'unterminated"],False); assert quote.returncode!=0
 stop_writer('writer.pid')
 time.sleep(.1)
 before=hashes(root/'backup'); data=root/'device/data'; shutil.rmtree(data); shutil.copytree(root/'backup',data)
 after=hashes(data); assert before==after
 assert (root/'parent.hold').read_text()=='parent-owned-do-not-release\n'
 assert (root/'capture with spaces.txt').stat().st_size>0
 (root/'restored-hashes.json').write_text(json.dumps(after,sort_keys=True))
 receipt={'sourceWithoutGit':True,'restoredFiles':len(after),'hashesMatch':True,'wrongProcessRefused':True,'parentHoldPreserved':True,'failedQuotingDetected':True,'captureHash':hashlib.sha256((root/'capture with spaces.txt').read_bytes()).hexdigest()}
 (root/'receipt.json').write_text(json.dumps(receipt,indent=2)); print('EXACT_DEVICE_FIXTURE_RESTORE',flush=True)
elif op=='cleanup':
 if c['case']==2:
  docker('rm','-f',container,check=False)
  assert docker('inspect',container,check=False).returncode!=0
 else:
  if (root/'writer.pid').exists():
   pid,correct=owned_pid('writer.pid','writer.py')
   if correct:
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
 print('OWNED_RESOURCES_CLEANED',flush=True)
else: raise AssertionError('unknown remote operation')
`; }
