/** Full public AIM CLI against a disposable real Redis, under the installed
 * native routes. The outer offsite TLS collector owns all synthetic endpoints.
 * No mocked launch/admission/account/lease function is used in this check. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeAimgrConfig } from '../src/config/aimgr-config.js';
import { connectRedisStore, closeRedisStore, importCredentialsSnapshot } from '../src/coordination/redis-store.js';
import { buildAnthropicClaudeCredential } from '../test/helpers/claude.js';

export async function verifyConcurrency(input) {
  const home = input.userHomeDir, cwd = input.cwd;
  assert.ok(home.startsWith('/opt/aimgr-state-audit/claude-implementation/'));
  const cli = fileURLToPath(new URL('../bin/aimgr.js', import.meta.url));
  const transport = new URL('../src/network/claude-transport.js', import.meta.url).href;
  const keyPrefix = `claude-acceptance-${process.platform}-${process.pid}:`;
  const url = 'redis://127.0.0.1:36379';
  const store = await connectRedisStore({ url, keyPrefix, connectionPolicy: "leased" });
  const profiles = input.profiles;
  const bindings = { a: 'impl_mock', b: 'impl_mock_b' };
  const env = { ...process.env, HOME: home, PATH: `${path.dirname(input.command)}:${process.env.PATH}` };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[key];
  const credentials = ['a', 'b'].map(label => {
    const credential = buildAnthropicClaudeCredential({ access: `sk-ant-oat01-synthetic-${label}`, refresh: `synthetic-refresh-${label}`,
      emailAddress: `synthetic-${label}@example.invalid`, organizationUuid: `00000000-0000-4000-8000-00000000000${label === 'a' ? 2 : 4}`,
      subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' });
    credential.nativeClaudeBundle.oauthAccount.accountUuid = `00000000-0000-4000-8000-00000000000${label === 'a' ? 1 : 3}`;
    credential.nativeClaudeBundle.claudeAiOauth.subscriptionTypeSource = 'sign_in';
    const { accountUuid, emailAddress, organizationUuid } = credential.nativeClaudeBundle.oauthAccount;
    return { provider: 'anthropic', label, credential, identity: { accountUuid, emailAddress, organizationUuid },
      policy: { expect: { email: `synthetic-${label}@example.invalid` }, egress: { profileRef: bindings[label] }, pool: { enabled: true } }, health: { status: 'ready' } };
  });
  writeAimgrConfig({ homeDir: home, config: { redis: { url, keyPrefix }, claudeProxyProfiles: profiles } });
  await importCredentialsSnapshot(store, { credentials }, { updatedBy: 'offsite-synthetic-acceptance' });
  if(input.background || input.continuity || input.savedJobs) for(const label of ['a','b']){
    // Native --bg requires actual USER-source consent. A CLI settings overlay
    // intentionally does not count as accepting its background disclaimer.
    const config=path.join(home,'.aimgr/claude-homes',label,'.claude');
    fs.mkdirSync(config,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(config,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),{mode:0o600});
    if(input.continuity){
      const credential=credentials.find(record=>record.label===label).credential.nativeClaudeBundle;
      fs.writeFileSync(path.join(config,'.claude.json'),JSON.stringify({userID:'a'.repeat(64),machineID:'b'.repeat(64),summonSidKey:'c'.repeat(64),remoteControlMachineId:'00000000-0000-4000-8000-000000000099',oauthAccount:credential.oauthAccount,unknownTaskState:'PRESERVED_TASK_STATE',hasCompletedOnboarding:true}),{mode:0o600});
      fs.writeFileSync(path.join(config,'.credentials.json'),JSON.stringify({claudeAiOauth:credential.claudeAiOauth,mcpOAuth:{'fixture-service':{accessToken:'INDEPENDENT_MCP_SECRET'}}}),{mode:0o600});
    }
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ userID: input.continuity?'a'.repeat(64):'FOREIGN_HOST_INSTALLATION_CANARY', machineID: input.continuity?'b'.repeat(64):'FOREIGN_HOST_MACHINE_CANARY', ...(input.continuity?{summonSidKey:'c'.repeat(64),remoteControlMachineId:'00000000-0000-4000-8000-000000000099'}:{}),
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
  // Each tool executes in the ordinary trusted-tools domain, where nested AIM
  // must independently select B rather than inheriting A's account transport.
  fs.writeFileSync(path.join(cwd, 'concurrent-tool.mjs'), `
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
import {createClaudeTransport} from ${JSON.stringify(transport)};
const role=process.argv[2],cwd=${JSON.stringify(cwd)},home=${JSON.stringify(home)};
const deadline=Date.now()+100000;
fs.writeFileSync(path.join(cwd,role+'.entered'),String(process.pid));
if(role==='a1'){
 for(const label of ['a','b']){
  const transport=createClaudeTransport(${JSON.stringify(profiles)}[${JSON.stringify(bindings)}[label]]);
  try{const response=await transport.fetch('https://api.anthropic.com/nested-http-'+label);if(!response.ok)throw Error('nested HTTP failed');}
  finally{await transport.close();}
  const env={...process.env,HOME:home};
  for(const key of ['CLAUDECODE','CLAUDE_CONFIG_DIR','CLAUDE_SECURESTORAGE_CONFIG_DIR'])delete env[key];
  const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'claude','run',label,'--','-p','CONCURRENT_ROLE_nested-'+label+'.','--output-format','json','--model','sonnet','--dangerously-skip-permissions'],{cwd,env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  fs.writeFileSync(path.join(cwd,'nested-'+label+'.private.txt'),output);
  if(status!==0)throw Error('nested '+label+' failed '+status);
 }
 fs.writeFileSync(path.join(cwd,'nested.done'),'ok');
}
if(['a1','a2','b1','outage-a1','outage-a2','outage-b1','bg-a1','bg-a2','bg-b1','parent-a','supervisor-a'].includes(role)){
 while(!fs.existsSync(path.join(cwd,role+'.release'))){if(Date.now()>deadline)throw Error('barrier timed out');await delay(100);}
}
console.log('CONCURRENT_TOOL_OK_'+role);
`);
  const children = [];
  const readCaptures = () => fs.existsSync(input.captureFile) ? fs.readFileSync(input.captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const waitFor = async (predicate, reason, timeout = 110000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
      for (const child of children) if (child.failed) throw child.failed;
      if (Date.now() > deadline) throw new Error(`Timed out: ${reason}`);
      await delay(100);
    }
  };
  const start = (label, role, { expectFailure = false, background = false, extraArgs = [] } = {}) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cli, 'claude', 'run', label, '--', ...(background ? ['--bg', '--name', role, `CONCURRENT_ROLE_${role}.`] : ['-p', `CONCURRENT_ROLE_${role}.`, '--output-format', 'json']), '--model', 'sonnet', '--dangerously-skip-permissions', '--debug-file', path.join(cwd, role + '.debug.private.txt'), ...extraArgs],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { stderr += value; });
    child.finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        fs.writeFileSync(path.join(cwd, role + '.private.txt'), output + stderr);
        if (expectFailure) { resolve({ role, code, signal, diagnostic: stderr + output, startedAt, finishedAt: Date.now() }); return; }
        if (code !== 0) { child.failed = new Error(`${role} exited ${code ?? signal}; inspect private fixture output`); reject(child.failed); return; }
        if (background) { resolve({ role, label, startedAt, finishedAt: Date.now(), dispatched: true }); return; }
        const result = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(v => v?.type === 'result');
        if (!result || result.is_error) { child.failed = new Error(`${role} lacked successful native result`); reject(child.failed); return; }
        resolve({ role, label, startedAt, finishedAt: Date.now(), sessionId: result.session_id });
      });
    });
    child.finished.catch(() => {}); children.push(child); return child;
  };
  const leaseKey = label => `${keyPrefix}lease:credential:anthropic:${label}`;
  const receipt = { realRedis: true, fullPublicCli: true, checks: {}, sessions: [] };
  try {
    if(input.workflowOverlap){
      const {verifyOverlap}=await import('./privacy-integrated-overlap-check.mjs');
      await verifyOverlap({input,home,cwd,env,keyPrefix,start,waitFor,readCaptures,receipt});return;
    }
    if(input.savedJobs){
      const execute=promisify(execFile), config=label=>path.join(home,'.aimgr/claude-homes',label,'.claude');
      const command=async(label,args)=>execute(process.execPath,[cli,'claude','run',label,'--',...args],{cwd,env,timeout:40000,maxBuffer:1024*1024});
      const models=()=>readCaptures().filter(r=>r.path.includes('/messages'));
      for(const [label,role] of [['a','wake-a1'],['a','wake-a2'],['b','wake-b1']]){
        await start(label,role,{background:true}).finished;
        await waitFor(()=>models().filter(r=>JSON.stringify(r.body.messages).includes(`CONCURRENT_ROLE_${role}.`)).length>=2,role+' first background turn');
      }
      const list=async label=>JSON.parse((await command(label,['agents','--json','--all'])).stdout).filter(row=>row.kind==='background');
      const a=await list('a'),b=await list('b');
      assert.ok(a.length>=2);assert.ok(b.length>=1);
      assert.ok(a.every(row=>!b.some(other=>other.id===row.id)));
      receipt.checks.nativeJobListingsStayWithinAccount=true;
      const id=a[0].id, saved=path.join(config('a'),'jobs',id,'state.json');
      const before=JSON.parse(fs.readFileSync(saved));
      const snapshots=before.respawnFlags.filter((value,index,all)=>index>0&&all[index-1]==='--settings');
      assert.ok(snapshots.length);assert.ok(snapshots.every(file=>fs.existsSync(file)));
      await command('a',['stop',id]);
      assert.equal((await list('a')).find(row=>row.id===id).state,'stopped');
      // A subsequent real AIM launch exercises conservative retirement while
      // a stopped native job still refers to its original immutable snapshot.
      await start('a','after-stop-cleanup').finished;
      assert.ok(snapshots.every(file=>fs.existsSync(file)));
      const restarted=await command('a',['respawn',id]);
      fs.writeFileSync(path.join(home,'saved-job-respawn.private.txt'),restarted.stdout+restarted.stderr);
      let state;
      await waitFor(()=>{state=JSON.parse(fs.readFileSync(saved));return state.state!=='stopped'&&state.daemonShort;},'saved job respawn');
      assert.deepEqual(state.respawnFlags,before.respawnFlags);
      const terminalRoot=path.join(cwd,'saved-job-terminal');fs.mkdirSync(terminalRoot);
      const info=path.join(terminalRoot,'info.json');
      fs.writeFileSync(info,JSON.stringify({root:terminalRoot,cwd,argv:[process.execPath,cli,'claude','run','a','--','attach',state.daemonShort]}));
      const attached=execute('/usr/bin/python3',['-I',fileURLToPath(new URL('./privacy-test-pty.py',import.meta.url)),info],{cwd,env,timeout:90000});attached.catch(()=>{});
      await waitFor(()=>{
        const log=path.join(terminalRoot,'terminal.private.log');
        return fs.existsSync(log)&&fs.readFileSync(log,'utf8').includes('bypass permissions on');
      },'native attached prompt ready',30000);
      await delay(500);
      const inputFile=path.join(terminalRoot,'terminal-input.jsonl');
      const unicode='Café 日本語 👋';
      fs.appendFileSync(inputFile,JSON.stringify({paste:'Continue this saved conversation. NATIVE_SAVED_JOB_WAKE_PROMPT. '+unicode})+'\n');
      await waitFor(()=>models().some(r=>JSON.stringify(r.body.messages).includes('NATIVE_SAVED_JOB_WAKE_PROMPT.')),'native saved-job model request',30000);
      await delay(2000);fs.appendFileSync(inputFile,JSON.stringify('/exit')+'\n');
      // /exit detaches and returns to native's agents picker. Close that
      // ordinary UI with Ctrl-C while leaving the background job intact.
      await delay(2000);fs.appendFileSync(inputFile,JSON.stringify({raw:'\u0003'})+'\n');
      await delay(500);fs.appendFileSync(inputFile,JSON.stringify({raw:'\u0003'})+'\n');await attached;
      const ended=JSON.parse(fs.readFileSync(path.join(terminalRoot,'pty-exit.json')));assert.equal(ended.challenge,false);assert.equal(ended.exit,0);
      const woke=models().filter(r=>JSON.stringify(r.body.messages).includes('NATIVE_SAVED_JOB_WAKE_PROMPT.'));
      assert.ok(woke.every(r=>r.source==='127.0.0.2'));
      assert.ok(woke.some(r=>JSON.stringify(r.body.messages).includes(unicode)));
      receipt.checks.unicodeTerminalPastePreserved=true;
      assert.ok(snapshots.every(file=>fs.existsSync(file)));
      receipt.checks.stoppedNativeJobRetainsOriginalSettings=true;
      receipt.checks.savedJobRespawnAttachAndNewPrompt=true;
      receipt.passed=true;return;
    }
    if(input.failureLifecycle){
      const execute=promisify(execFile);
      const processes=async()=> (await execute('/bin/ps',['-axo','pid=,ppid=,stat=,comm='])).stdout.trim().split('\n').map(line=>{
        const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);return m&&{pid:Number(m[1]),ppid:Number(m[2]),state:m[3],command:m[4]};
      }).filter(Boolean);
      const rows=role=>readCaptures().filter(r=>r.path.includes('/messages')&&JSON.stringify(r.body.messages).includes(`CONCURRENT_ROLE_${role}.`));
      const healthy=start('b','b1');
      await waitFor(()=>fs.existsSync(path.join(cwd,'b1.entered')),'healthy sibling tool');
      receipt.failures=[];
      for(const role of ['parent-a','supervisor-a']){
        const work=start('a',role,{expectFailure:true});
        await waitFor(()=>fs.existsSync(path.join(cwd,role+'.entered')),role+' native tool');
        const tree=await processes(), descendants=new Set([work.pid]);
        for(let n=0;n<10;n++)for(const p of tree)if(descendants.has(p.ppid))descendants.add(p.pid);
        const vendor=tree.find(p=>descendants.has(p.pid)&&path.basename(p.command)==='claude');
        // Linux's route owner is above Node; Mac execs the route below Node.
        // The actual vendor's direct parent identifies the same trusted
        // supervisor on both platforms without assuming identical ancestry.
        const supervisor=tree.find(p=>p.pid===vendor?.ppid&&descendants.has(p.pid));
        assert.ok(vendor);assert.ok(supervisor);
        const before=rows(role).length;
        process.kill(role==='parent-a'?work.pid:supervisor.pid,'SIGKILL');
        fs.writeFileSync(path.join(cwd,role+'.release'),'ok');
        await waitFor(async()=>!(await processes()).some(p=>p.pid===vendor.pid&&!p.state.startsWith('Z')),role+' native owner exit',15000);
        const completed=await work.finished;assert.notEqual(completed.code,0);
        assert.ok(rows(role).every(r=>r.source==='127.0.0.2'));
        receipt.failures.push({role,nativeExited:true,requestsAfterDeath:rows(role).length-before,allRequestsUsedAssignedRoute:true,exit:completed.code,signal:completed.signal});
      }
      assert.equal(healthy.exitCode,null);fs.writeFileSync(path.join(cwd,'b1.release'),'ok');await healthy.finished;
      assert.ok(rows('b1').every(r=>r.source==='127.0.0.3'));
      receipt.checks.ownerFailureDoesNotRemoveBoundary=true;
      receipt.checks.healthySiblingAfterOwnerFailure=true;
      // Use the native operator diagnostic for a failed configured dependency.
      // The server actually starts and exits; no fake MCP client is used.
      const failedServer=path.join(cwd,'failed-mcp.mjs');
      fs.writeFileSync(failedServer,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(cwd,'failed-mcp-started'))},'started');process.exit(23);`);
      fs.writeFileSync(path.join(cwd,'.mcp.json'),JSON.stringify({mcpServers:{'required-fixture':{command:process.execPath,args:[failedServer]}}}));
      // Approve this deliberately failing fixture server in native USER settings.
      // Otherwise mcp list correctly reports pending consent without spawning it.
      const settingsFile=path.join(home,'.aimgr/claude-homes/a/.claude/settings.json');
      const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
      fs.writeFileSync(settingsFile,JSON.stringify({...settings,enabledMcpjsonServers:['required-fixture']}));
      let output='';
      try{const r=await execute(process.execPath,[cli,'claude','run','a','--','mcp','list'],{cwd,env,timeout:30000});output=r.stdout+r.stderr;}
      catch(error){output=(error.stdout??'')+(error.stderr??'');}
      fs.writeFileSync(path.join(home,'required-mcp-failure.private.txt'),output);
      assert.ok(fs.existsSync(path.join(cwd,'failed-mcp-started')));
      assert.match(output,/required-fixture/);assert.match(output,/Failed to connect|connection failed|disconnected/i);
      receipt.checks.requiredMcpFailureVisible=true;
      receipt.passed=true;return;
    }
    if(input.continuity){
      const {verifyContinuity}=await import('./privacy-integrated-continuity-check.mjs');
      await verifyContinuity({input,home,cwd,env,store,start,readCaptures,receipt});return;
    }
    if (input.background) {
      const execute = promisify(execFile), mac = process.platform === 'darwin';
      const models = () => readCaptures().filter(r => r.path.includes('/messages'));
      const rows = role => models().filter(r => JSON.stringify(r.body.messages).includes(`CONCURRENT_ROLE_${role}.`));
      const config = label => path.join(home, '.aimgr/claude-homes', label, '.claude');
      const roster = label => JSON.parse(fs.readFileSync(path.join(config(label), 'daemon/roster.json')));
      const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const [label,role] of [['a','bg-a1'],['a','bg-a2'],['b','bg-b1']]) {
        receipt.sessions.push(await start(label, role, {background:true}).finished);
        await waitFor(() => fs.existsSync(path.join(cwd, role+'.entered')), role+' detached native tool', 30000);
      }
      const a = roster('a'), b = roster('b');
      assert.ok(running(a.supervisorPid));assert.ok(running(b.supervisorPid));assert.notEqual(a.supervisorPid,b.supervisorPid);
      receipt.checks.backgroundOwnersAfterDispatchExit = true;
      // Killing native's own daemon supervisor deliberately leaves its active
      // workers. Their next model request must keep the inherited boundary.
      process.kill(a.supervisorPid, 'SIGKILL');
      fs.writeFileSync(path.join(cwd, 'bg-a1.release'), 'ok');
      await waitFor(() => rows('bg-a1').length>=2, 'surviving native background worker');
      assert.ok(rows('bg-a1').every(r=>r.source==='127.0.0.2'));
      receipt.checks.nativeSupervisorDeathRetainsWorkerProtection = true;
      const stop = () => execute('sudo', ['-n', ...(mac
        ? ['/bin/launchctl','bootout','system/com.aimgr.claude-proxy.impl_mock']
        : ['systemctl','stop','aimgr-claude-proxy-impl_mock.service'])]);
      const repair = async () => {
        if (mac) await waitFor(async () => {
          try { await execute('sudo', ['-n','/bin/launchctl','print','system/com.aimgr.claude-proxy.impl_mock']); return false; }
          catch { return true; }
        }, 'old background route launchd job removed', 15000);
        await execute('sudo', ['-n', ...(mac
          ? ['/bin/launchctl','bootstrap','system','/Library/LaunchDaemons/com.aimgr.claude-proxy.impl_mock.plist']
          : ['systemctl','start','aimgr-claude-proxy-impl_mock.service'])]);
        if (mac) await waitFor(() => {
          const root='/opt/aimgr-claude-proxy/impl_mock-state';
          return fs.existsSync(path.join(root,'ready.json')) && !fs.existsSync(path.join(root,'failed')) && !fs.existsSync(path.join(root,'starting'));
        }, 'repaired background Mac route', 20000);
      };
      await stop();
      const stoppedCount=rows('bg-a2').length;
      fs.writeFileSync(path.join(cwd,'bg-a2.release'),'ok');
      fs.writeFileSync(path.join(cwd,'bg-b1.release'),'ok');
      await waitFor(()=>rows('bg-b1').length>=2,'independent background B after A failure');
      assert.ok(rows('bg-b1').every(r=>r.source==='127.0.0.3'));
      await repair();await delay(1500);
      assert.equal(rows('bg-a2').length,stoppedCount);
      receipt.checks.backgroundRouteFailureClosed = true;
      receipt.checks.healthyBackgroundSiblingCompletes = true;
      receipt.checks.backgroundRepairDoesNotReplay = true;
      // The retained immutable settings referenced by native daemon state
      // remain readable after dispatcher exit and subsequent launch cleanup.
      for(const label of ['a','b']) {
        const directory=path.join(path.dirname(config(label)),'.privacy-launches');
        const retained=fs.readdirSync(directory).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(directory,f))));
        assert.ok(retained.length);assert.ok(retained.every(r=>fs.existsSync(r.settings.path)&&fs.existsSync(r.scratch.path)));
      }
      receipt.checks.backgroundSettingsRetained = true;
      receipt.passed = true;
      return;
    }
    const a1 = start('a', 'a1'), a2 = start('a', 'a2'), b1 = start('b', 'b1');
    await waitFor(() => ['a1', 'a2', 'b1'].every(role => fs.existsSync(path.join(cwd, role + '.entered'))), 'three overlapping native tool turns');
    assert.equal(children.every(c => c.exitCode === null), true);
    const tokenA = await store.client.get(leaseKey('a')), tokenB = await store.client.get(leaseKey('b'));
    assert.ok(tokenA); assert.ok(tokenB); assert.notEqual(tokenA, tokenB);
    receipt.checks.overlappingA1A2B = true;
    await waitFor(() => fs.existsSync(path.join(cwd, 'nested.done')), 'nested same/cross-account native and HTTP work');
    receipt.checks.nestedNativeAndHttp = true;
    fs.writeFileSync(path.join(cwd, 'a2.release'), 'ok'); receipt.sessions.push(await a2.finished);
    assert.equal(await store.client.get(leaseKey('a')), tokenA, 'A2 exit must retain A1 shared lease');
    assert.equal(b1.exitCode, null); receipt.checks.sharedLeaseAndIndependentSibling = true;
    fs.writeFileSync(path.join(cwd, 'a1.release'), 'ok'); receipt.sessions.push(await a1.finished);
    await waitFor(async () => await store.client.get(leaseKey('a')) === null, 'last A owner releases real Redis lease', 10000);
    assert.equal(await store.client.get(leaseKey('b')), tokenB);
    fs.writeFileSync(path.join(cwd, 'b1.release'), 'ok'); receipt.sessions.push(await b1.finished);
    await waitFor(async () => await store.client.get(leaseKey('b')) === null, 'B owner releases real Redis lease', 10000);
    receipt.sessions.push(await start('a', 'restart-a').finished);
    const captures = readCaptures(), models = captures.filter(r => r.path.includes('/messages'));
    const identities = {};
    for (const role of ['a1', 'a2', 'b1', 'nested-a', 'nested-b', 'restart-a']) {
      const rows = models.filter(r => JSON.stringify(r.body.messages).includes(`CONCURRENT_ROLE_${role}.`));
      assert.ok(rows.length >= 2, `${role} must complete a tool roundtrip`);
      const account = role === 'b1' || role === 'nested-b' ? 'b' : 'a';
      assert.ok(rows.every(r => r.source === (account === 'a' ? '127.0.0.2' : '127.0.0.3')), `${role} selected route`);
      assert.ok(rows.every(r => Object.entries(r.headers).some(([k,v]) => k.toLowerCase() === 'authorization' && v === `Bearer sk-ant-oat01-synthetic-${account}`)), `${role} selected token`);
      const values = new Set(rows.map(r => {
        const value = r.body.metadata?.user_id;
        return typeof value === 'string' && value.startsWith('{') ? JSON.parse(value).device_id : value;
      }));
      assert.equal(values.size, 1, `${role} stable device identifier`); identities[role] = [...values][0]; assert.ok(identities[role]);
    }
    assert.equal(identities.a1, identities.a2); assert.equal(identities.a1, identities['nested-a']); assert.equal(identities.a1, identities['restart-a']);
    assert.equal(identities.b1, identities['nested-b']); assert.notEqual(identities.a1, identities.b1);
    for (const label of ['a', 'b']) assert.ok(captures.some(r => r.path === `/nested-http-${label}` && r.source === (label === 'a' ? '127.0.0.2' : '127.0.0.3')));
    assert.ok(!JSON.stringify(captures).includes('FOREIGN_HOST_'));
    receipt.checks.stableSameAccountDistinctOtherAccount = true;
    receipt.checks.restartPreservesAccountIdentity = true;
    receipt.checks.assignedRoutesAndCredentials = true;
    receipt.checks.lastOwnerReleasesRealRedisLease = true;
    receipt.checks.hostIdentifiersAbsent = true;
    // The same final native controls must fail closed after admission too.
    // B remains in a live native Bash barrier while A's installed adapter dies.
    // These are disposable host services owned by the outer fixture only.
    const execute = promisify(execFile), mac = process.platform === 'darwin';
    const stop = () => execute('sudo', ['-n', ...(mac
      ? ['/bin/launchctl', 'bootout', 'system/com.aimgr.claude-proxy.impl_mock']
      : ['systemctl', 'stop', 'aimgr-claude-proxy-impl_mock.service'])]);
    const repair = () => execute('sudo', ['-n', ...(mac
      ? ['/bin/launchctl', 'bootstrap', 'system', '/Library/LaunchDaemons/com.aimgr.claude-proxy.impl_mock.plist']
      : ['systemctl', 'start', 'aimgr-claude-proxy-impl_mock.service'])]);
    const lost1 = start('a', 'outage-a1', { expectFailure: true });
    const lost2 = start('a', 'outage-a2', { expectFailure: true });
    const healthy = start('b', 'outage-b1');
    await waitFor(() => ['outage-a1','outage-a2','outage-b1'].every(role => fs.existsSync(path.join(cwd, role + '.entered'))), 'native outage barriers');
    const lostAt = Date.now(); await stop();
    const stopped = await Promise.all([lost1.finished, lost2.finished]);
    assert.ok(stopped.every(r => r.code !== 0), 'both affected sessions report failure');
    assert.ok(stopped.every(r => /proxy.*unavailable|proxy.*lost|proxy.*failed|proxy.*exited/i.test(r.diagnostic)), 'visible assigned-proxy failure');
    assert.ok(Date.now() - lostAt < 15000, 'outage shutdown bounded to 15 seconds');
    assert.equal(healthy.exitCode, null, 'other account remains live');
    const beforeDown = readCaptures().filter(r => r.path.includes('/messages')).length;
    const refused = await start('a', 'down-a', { expectFailure: true }).finished;
    assert.notEqual(refused.code, 0); assert.match(refused.diagnostic, /proxy.*unavailable/i);
    assert.equal(readCaptures().filter(r => r.path.includes('/messages')).length, beforeDown);
    await repair();
    if (mac) await waitFor(() => {
      const root='/opt/aimgr-claude-proxy/impl_mock-state';
      return fs.existsSync(path.join(root,'ready.json')) && !fs.existsSync(path.join(root,'failed')) && !fs.existsSync(path.join(root,'starting'));
    }, 'repaired Mac native route', 20000);
    await delay(1000);
    assert.equal(readCaptures().filter(r => r.path.includes('/messages')).length, beforeDown, 'repair never replays stopped work');
    fs.writeFileSync(path.join(cwd, 'outage-b1.release'), 'ok'); receipt.sessions.push(await healthy.finished);
    receipt.sessions.push(await start('a', 'repaired-a').finished);
    receipt.checks.midToolAdapterFailureClosed = true;
    receipt.checks.startDownRefusesBeforeModel = true;
    receipt.checks.healthySiblingSurvivesOutage = true;
    receipt.checks.noReplayAfterRepair = true;
    receipt.checks.explicitFreshLaunchAfterRepair = true;
    receipt.outage = { stopMs: Math.max(...stopped.map(r=>r.finishedAt))-lostAt, affectedExits: stopped.map(r=>r.code), startupExit: refused.code };
    receipt.passed = true;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.allSettled(children.map(c => c.finished));
    fs.writeFileSync(path.join(home, 'concurrency.json'), JSON.stringify(receipt, null, 2));
    await closeRedisStore(store);
  }
}
