/** Required package/worktree/development behavior under the final launcher.
 * Runs only behind the outer offsite synthetic service and network boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { runClaudeCliNoninteractive } from '../src/targets/claude-runner.js';
import { resolveClaudeInstructionReads } from '../src/privacy/claude-instruction-inputs.js';

export async function verifyCompatibility(input) {
  const { check, captureFile, ...launch } = input;
  const home=launch.userHomeDir, main=launch.cwd;
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:main,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'});
  git('init','-q');fs.writeFileSync(path.join(main,'tracked.txt'),'before\n');git('add','tracked.txt');
  git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic fixture');
  const worktree=path.join(home,'linked-worktree');git('worktree','add','-q','-b','fixture-worktree',worktree);
  // Native excludes external instruction imports until the project has its
  // own consent. Model an already-trusted synthetic worktree, as this test's
  // contract requires; bypass-permissions alone does not grant that consent.
  const stateFile=path.join(launch.configDir,'.claude.json');
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  state.projects??={};
  // Native stores linked-worktree trust under the canonical main Git root.
  // Setting only the worktree entry does not grant native import consent.
  state.projects[fs.realpathSync(main).normalize('NFC')]={...state.projects[main],hasTrustDialogAccepted:true,
    hasCompletedProjectOnboarding:true,hasClaudeMdExternalIncludesApproved:true,
    hasClaudeMdExternalIncludesWarningShown:true};
  state.projects[worktree]={hasTrustDialogAccepted:true,
    hasCompletedProjectOnboarding:true,hasClaudeMdExternalIncludesApproved:true,
    hasClaudeMdExternalIncludesWarningShown:true};
  fs.writeFileSync(stateFile,JSON.stringify(state));
  const skill=path.join(main,'.claude/skills/main-proof/SKILL.md');fs.mkdirSync(path.dirname(skill),{recursive:true});
  fs.writeFileSync(skill,'---\nname: main-proof\ndescription: Read the synthetic main-worktree skill.\n---\nNATIVE_MAIN_WORKTREE_SKILL_CONTENT\n');
  const pack=path.join(home,'external-package');fs.mkdirSync(path.join(pack,'.claude-plugin'),{recursive:true});
  fs.writeFileSync(path.join(pack,'.claude-plugin/plugin.json'),JSON.stringify({name:'privacy-fixture',version:'1.0.0',description:'Required synthetic skill and MCP package'}));
  fs.mkdirSync(path.join(pack,'skills/pack-proof'),{recursive:true});fs.writeFileSync(path.join(pack,'skills/pack-proof/SKILL.md'),'---\nname: pack-proof\ndescription: Read the required package skill.\n---\nNATIVE_PACKAGE_SKILL_CONTENT\n');
  const mcp=path.join(pack,'server.mjs');fs.writeFileSync(mcp,`import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id===undefined)continue;
const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'pack',version:'1'}}:r.method==='tools/list'?{tools:[{name:'echo',description:'Return package proof',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:'NATIVE_PACKAGE_MCP_RESULT'}]}:{};
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));}`);
  fs.writeFileSync(path.join(pack,'.mcp.json'),JSON.stringify({mcpServers:{pack:process.platform==='darwin'
    ? {command:'/usr/bin/sudo',args:['-n','--',process.execPath,mcp]}
    : {command:process.execPath,args:[mcp]}}}));
  const external=path.join(home,'external-instructions');fs.mkdirSync(external);
  const accepted=['plain','list','setext','escaped space','html-tail','nested'];
  const rejected=['code','inline','comment','image','attribute','frontmatter'];
  for(const name of [...accepted,...rejected])fs.writeFileSync(path.join(external,name+'.md'),'IMPORTED_CONTENT_'+name.replaceAll(' ','_')+'\n');
  fs.appendFileSync(path.join(external,'plain.md'),'@nested.md\n');
  const f=name=>path.join(external,name+'.md').replaceAll(' ','\\ ');
  const instructions=`---\nignored: @${f('frontmatter')}\n---\n@${f('plain')}\n\n- @${f('list')}\n\n@${f('setext')}\n------\n\n@${f('escaped space')}\n\n<!-- ignored --> @${f('html-tail')}\n\n\`@${f('inline')}\`\n\n\`\`\`text\n@${f('code')}\n\`\`\`\n\n<!-- @${f('comment')} -->\n\n![@${f('image')}](placeholder)\n\n<div title="@${f('attribute')}">text</div>\n`;
  const instructionFile=path.join(worktree,'CLAUDE.md');fs.writeFileSync(instructionFile,instructions);
  const discovered=resolveClaudeInstructionReads({files:[instructionFile],userHomeDir:home});
  for(const name of accepted)assert.ok(discovered.includes(path.join(external,name+'.md')),name);
  for(const name of rejected)assert.ok(!discovered.includes(path.join(external,name+'.md')),name);
  const options=path.join(home,'options');fs.mkdirSync(options);
  const settings=path.join(options,'relative-settings.json');const original=JSON.stringify({env:{AIM_SETTING_ORIGIN_VALUE:'SOURCE_DIRECTORY_OK'}});fs.writeFileSync(settings,original);
  const tool=path.join(worktree,'compatibility-tool.mjs');fs.writeFileSync(tool,`
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const cwd=process.cwd(),checks={};
checks.cwd=cwd===${JSON.stringify(worktree)};checks.relativeSettings=process.env.AIM_SETTING_ORIGIN_VALUE==='SOURCE_DIRECTORY_OK';
checks.processInventory=execFileSync('/bin/ps',['-p',String(process.pid),'-o','pid='],{encoding:'utf8'}).trim()===String(process.pid);
if(process.platform==='darwin')checks.explicitPrivilegedTool=execFileSync('/usr/bin/sudo',['-n','/usr/bin/id','-u'],{encoding:'utf8'}).trim()==='0';
fs.writeFileSync('tracked.txt','after\\n');checks.worktreeGit=execFileSync('/usr/bin/git',['status','--porcelain'],{encoding:'utf8'}).includes('tracked.txt');
fs.writeFileSync('example.c','#include <stdio.h>\\nint main(void){puts("PROTECTED_C_BUILD_OK");return 0;}\\n');
execFileSync('/usr/bin/cc',['example.c','-o','example']);checks.nativeBuild=execFileSync('./example',{encoding:'utf8'}).trim()==='PROTECTED_C_BUILD_OK';
fs.mkdirSync('subdir');checks.shellCwd=execFileSync('/bin/bash',['-c','cd subdir && pwd'],{encoding:'utf8'}).trim()===path.join(cwd,'subdir');
fs.writeFileSync('atomic.tmp','atomic-write');fs.renameSync('atomic.tmp','atomic.json');checks.atomicWrite=fs.readFileSync('atomic.json','utf8')==='atomic-write';
fs.writeFileSync('development.json',JSON.stringify(checks));console.log(JSON.stringify(checks));
`);
  const models=()=>fs.readFileSync(captureFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.path.includes('/messages'));
  const turn=async(prompt,args=[])=>{
    const result=await runClaudeCliNoninteractive({...launch,cwd:worktree,
      args:['-p',prompt,'--model','sonnet','--dangerously-skip-permissions','--output-format','json','--plugin-dir',pack,'--settings','../options/relative-settings.json','--debug-file',path.join(worktree,'debug.private.txt'),...args],
      env:process.env,timeoutMs:45000,maxOutputBytes:1024*1024,spawnImpl(command,argv,options){
        const child=spawn(command,argv,options);let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.once('close',()=>fs.appendFileSync(path.join(home,'compatibility.private.txt'),out));return child;
      }});
    assert.equal(result.status,0,'required native development/package turn failed; inspect private fixture');
  };
  await turn('Perform the development proof. NATIVE_COMPATIBILITY_DEVELOPMENT.');
  const development=JSON.parse(fs.readFileSync(path.join(worktree,'development.json')));assert.ok(Object.values(development).every(Boolean));
  assert.equal(fs.readFileSync(settings,'utf8'),original,'original relative settings file remains unchanged');
  const sent=JSON.stringify(models().map(r=>r.body));
  for(const name of accepted)assert.ok(sent.includes('IMPORTED_CONTENT_'+name.replaceAll(' ','_')),name+' native import');
  for(const name of rejected)assert.ok(!sent.includes('IMPORTED_CONTENT_'+name.replaceAll(' ','_')),name+' native exclusion');
  await turn('Load main-proof. NATIVE_COMPATIBILITY_WORKTREE_SKILL.');
  assert.ok(JSON.stringify(models()).includes('NATIVE_MAIN_WORKTREE_SKILL_CONTENT'));
  await turn('Load privacy-fixture:pack-proof. NATIVE_COMPATIBILITY_PACKAGE_SKILL.');
  assert.ok(JSON.stringify(models()).includes('NATIVE_PACKAGE_SKILL_CONTENT'));
  await turn('Call the required package echo. NATIVE_COMPATIBILITY_PACKAGE_MCP.');
  assert.ok(JSON.stringify(models()).includes('NATIVE_PACKAGE_MCP_RESULT'));
  fs.writeFileSync(path.join(home,'compatibility.json'),JSON.stringify({passed:true,development,relativeSourcePreserved:true,
    nativeInstructionDifferential:{accepted:accepted.length,rejected:rejected.length},linkedWorktreeSkill:true,packageSkill:true,packageMcp:true,
    explicitPrivilegedMcp:process.platform==='darwin'}));
}
