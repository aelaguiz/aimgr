import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, runCliWithExitCode } from '../helpers/cli-runner.js';
import { mkTempHome } from '../helpers/files.js';

for (const args of [['login','synthetic'],['login','synthetic','--provider','anthropic'],['login','synthetic','--provider','codex'],['synthetic'],['browser','set','synthetic','--mode','aim-profile'],['browser','show','synthetic']]) {
 test(`retired ${args.join(' ')} never reads credentials or launches a browser`,async t=>{
  const home=mkTempHome();t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const untouched=path.join(home,'untouched');fs.writeFileSync(untouched,'synthetic existing state');
  const deps={connectRedisStoreImpl:async()=>assert.fail('must not connect'),runClaudeCliImpl:async()=>assert.fail('must not launch'),openUrlImpl:()=>assert.fail('must not open browser'),promptLineImpl:()=>assert.fail('must not prompt')};
  await assert.rejects(runCli([...args,'--home',home],deps),/aim claude login.*aim codex login/);
  assert.equal(fs.readFileSync(untouched,'utf8'),'synthetic existing state');
 });
}
for(const provider of ['anthropic','codex']) test(`retired ${provider} automation returns a single JSONL error without side effects`,async()=>{
 const result=await runCliWithExitCode(['login','synthetic','--provider',provider,'--manual-callback-stdio'],{connectRedisStoreImpl:async()=>assert.fail('must not connect')});
 assert.equal(result.exitCode,1);const message=JSON.parse(result.stdout);assert.equal(message.type,'error');assert.match(message.error,/manual callbacks/);
});
