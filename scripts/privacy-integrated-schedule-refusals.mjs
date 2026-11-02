/** Actual AIM occurrences and real disposable Redis. Only Herdr UI is mocked.
 * Root mutations touch this offsite candidate's policy and fixture route only,
 * are bounded by finally, and never run concurrently with another fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeRoutineFixture } from '../test/network/native-routine-fixture.js';

export async function verifyScheduledRefusals(input) {
  const root=path.join(input.userHomeDir,'scheduled-refusals');fs.mkdirSync(root);
  const fixture=await createNativeRoutineFixture({root,profile:input.egressProfile,claudeBin:input.command,
    defaultServices:{caFile:process.env.NODE_EXTRA_CA_CERTS,realRedisUrl:'redis://127.0.0.1:36379'}});
  const exec=promisify(execFile), mac=process.platform==='darwin';
  const models=()=>fs.existsSync(input.captureFile)?fs.readFileSync(input.captureFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.path.includes('/messages')):[];
  const stop=()=>exec('sudo',['-n',...(mac?['/bin/launchctl','bootout','system/com.aimgr.claude-proxy.impl_mock']:['systemctl','stop','aimgr-claude-proxy-impl_mock.service'])]);
  const repair=async()=>{
    if(mac)for(let n=0;n<150;n++){
      const exists=await exec('sudo',['-n','/bin/launchctl','print','system/com.aimgr.claude-proxy.impl_mock']).then(()=>true,()=>false);
      if(!exists)break;if(n===149)throw Error('old scheduled fixture route is still stopping');await delay(100);
    }
    await exec('sudo',['-n',...(mac?['/bin/launchctl','bootstrap','system','/Library/LaunchDaemons/com.aimgr.claude-proxy.impl_mock.plist']:['systemctl','start','aimgr-claude-proxy-impl_mock.service'])]);
    if(mac){const ready='/opt/aimgr-claude-proxy/impl_mock-state';for(let n=0;n<100;n++){
      if(fs.existsSync(path.join(ready,'ready.json'))&&!fs.existsSync(path.join(ready,'starting'))&&!fs.existsSync(path.join(ready,'failed')))return;await delay(100);
    }throw Error('fixture route repair timed out');}
  };
  const unknown=path.join(root,'unknown-claude');fs.writeFileSync(unknown,'#!/bin/sh\ntouch '+path.join(root,'unknown-executed')+'\n',{mode:0o700});
  const selector=JSON.parse(fs.readFileSync('/opt/aimgr-claude-runtime/active.json'));
  assert.match(selector.artifactSet,/^[a-f0-9]{64}$/);
  const policy=path.join('/opt/aimgr-claude-runtime/artifacts',selector.artifactSet,'policy.json');
  const hidden=policy+'.schedule-fixture-held';assert.ok(!fs.existsSync(hidden));
  const receipts=[];let minute=0;
  try {
    for(const kind of ['proxy-down','unknown-build','missing-policy','auth-refreshing']){
      let held,stopped=false,moved=false;
      const before=models().length;
      try{
        if(kind==='proxy-down'){await stop();stopped=true;}
        if(kind==='missing-policy'){await exec('sudo',['-n','/bin/mv',policy,hidden]);moved=true;}
        if(kind==='auth-refreshing'){held=await fixture.holdAuthRefreshLease();assert.ok(held);}
        const occurrence=await fixture.start(minute++,'Run the synthetic scheduled task. ROUTINE_SUCCESS_CANARY.',kind==='unknown-build'?{command:unknown}:{});
        await occurrence.finished.catch(()=>{});
        const receipt=JSON.parse(fs.readFileSync(occurrence.queued.receiptPath));
        assert.equal(receipt.outcome,'failed_before_prompt',kind);
        assert.equal(receipt.prompt.admittedAt,null);assert.equal(models().length,before);
        const patterns={'proxy-down':/proxy.*unavailable/i,'unknown-build':/not.*approved|not started/i,'missing-policy':/policy|artifact|ENOENT|not.*approved/i,'auth-refreshing':/busy|available|refresh/i};
        assert.match(receipt.error??'',patterns[kind]);
        const duplicate=await occurrence.duplicate();assert.notEqual(duplicate.outcome,'queued');
        receipts.push({kind,fireKey:receipt.fireKey,outcome:receipt.outcome,diagnostic:receipt.error,duplicateOutcome:duplicate.outcome,modelRequests:0});
      }finally{
        if(held)await held.release();
        if(moved)await exec('sudo',['-n','/bin/mv',hidden,policy]);
        if(stopped)await repair();
      }
      await delay(300);assert.equal(models().length,before,'repair must not replay an occurrence');
      const next=await fixture.start(minute++,'Run the synthetic scheduled task. ROUTINE_SUCCESS_CANARY.');
      const receipt=await next.finished;assert.equal(receipt.outcome,'completed');assert.equal(await fixture.lease(),null);
      assert.notEqual(receipt.fireKey,receipts.at(-1).fireKey);
      receipts.at(-1).nextOccurrenceCompleted=true;receipts.at(-1).nextFireKey=receipt.fireKey;
    }
    assert.ok(!fs.existsSync(path.join(root,'unknown-executed')));
    return {passed:true,realRedis:true,refusals:receipts,leaseReleased:true,noReplay:true};
  }finally{await fixture.close();}
}
