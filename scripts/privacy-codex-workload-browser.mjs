#!/usr/bin/env node
// Actual BrowserOS attachment, with an already-running disposable profile.
// The model endpoint is synthetic; browser tools and image transport are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {prepareCodexAccountState} from '../src/privacy/codex-account-state.js';
import {prepareCodexNativeInvocation} from '../src/privacy/codex-native-invocation.js';
import {readCodexEnvironment} from '../src/privacy/codex-environment.js';
assert.equal(process.platform,'linux'); assert.notEqual(process.getuid(),0);
assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST'));
assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
const base='/home/aimdev/codex-workload-browser-20261105';
const browserPath=base+'/browseros-051/usr/lib/browseros/browseros';
const root=fs.mkdtempSync('/opt/aimgr-state-audit/codex-m1-fixtures/workload-browser-');
const put=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s,{mode:0o600});};
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const results=[];
console.log(JSON.stringify({fixture:root,case:4}));
for(const protectedLaunch of [false,true]) {
 const mode=protectedLaunch?'protected':'stock', dir=path.join(root,mode), home=path.join(dir,'home'), cwd=path.join(home,'workspace/project'), toolHome=path.join(dir,'browser-home'), profile=path.join(dir,'profile');
 for(const d of [cwd,path.join(home,'.codex'),toolHome])fs.mkdirSync(d,{recursive:true});
 const log=fs.openSync(path.join(dir,'browser.log'),'w');
 const children=[], requests=[], modelRequests=[], outputs=[], stdout=[], stderr=[];
 let error, turn=0, invocation, child, timer, session, mcpUrl, rpcId=0, ownedId, heldId, windowId, screenshot, spill;
 const pages=http.createServer((req,res)=>{
  const authenticated=(req.headers.cookie??'').split(';').some(s=>s.trim()==='workload_session=SYNTHETIC_BROWSER_COOKIE');
  requests.push({url:req.url,authenticated});
  res.writeHead(200,{'content-type':'text/html'});
  res.end('<!doctype html><title>'+ (req.url==='/held'?'Preserved tab':'Synthetic account')+'</title><style>body{background:#edf2ff;color:#153782;font:28px sans-serif;padding:50px}h1{font-size:22px}</style><h1>'+ (req.url==='/held'?'Preserved tab':authenticated?'SYNTHETIC_BROWSER_IDENTITY':'UNAUTHENTICATED_BROWSER')+'</h1><input id="focus" value="Focus test"><p>Disposable browser workload</p>');
 });
 pages.listen(0,'127.0.0.1');await once(pages,'listening');const origin='http://127.0.0.1:'+pages.address().port;
 async function rpc(method,params={}) {
  const r=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
  assert.equal(r.status,200,'BrowserOS HTTP status');const text=await r.text();
  const value=text.startsWith('event:')||text.startsWith('data:')?JSON.parse(text.split('\n').find(s=>s.startsWith('data:')).slice(5)):JSON.parse(text);
  assert.ok(!value.error,JSON.stringify(value.error));return value.result;
 }
 async function call(name,args={}) {const value=await rpc('tools/call',{name,arguments:{...args,...(session?{session}:{})}});put(path.join(dir,'setup-'+rpcId+'.json'),JSON.stringify(value,null,2));session=value._meta?.['com.browseros/session']??session;assert.ok(!value.isError,JSON.stringify(value));return value;}
 const textOf=v=>(v.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 const unwrap=v=>{if(typeof v==='string'){const m=v.match(/^\[UNTRUSTED_PAGE_CONTENT[^\n]*\n([\s\S]*)\n\[END_UNTRUSTED_PAGE_CONTENT[^\n]*\]$/);if(m)return JSON.parse(m[1]);}return v;};
 const structured=v=>{const s=v.structuredContent??JSON.parse(textOf(v));return s.ok===true?unwrap(s.value):s;};
 const model=http.createServer(async(req,res)=>{
  const json=(n,v)=>{res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  try {
   if(req.method==='GET'){json(200,{models:[]});return;}
   const chunks=[];for await(const b of req)chunks.push(b);let bytes=Buffer.concat(chunks);
   if(req.headers['content-encoding']==='gzip')bytes=zlib.gunzipSync(bytes);
   if(req.headers['content-encoding']==='zstd')bytes=zlib.zstdDecompressSync(bytes);
   const body=JSON.parse(bytes);modelRequests.push(body);
   for(const v of body.input??[])if(v.type==='function_call_output')outputs.push(v.output);
   const visit=v=>{if(typeof v==='string'&&v.startsWith('data:image/')){const b=Buffer.from(v.split(',')[1],'base64');if(!screenshot){screenshot=path.join(dir,'mcp-inline.png');put(screenshot,b);}}else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(body.input);
   let name,args,namespace;
   if(turn===0){name='run';args={code:`const before=await browser.pages.list(); const page=await browser.pages.newPage(${JSON.stringify(origin+'/identity')},{background:true,windowId:${windowId}}); return {before,created:page};`,session};}
   else if(turn===1){
    const inventory=structured(await call('run',{code:'return await browser.pages.list();'}));put(path.join(dir,'after-create.json'),JSON.stringify(inventory,null,2));
    const candidates=inventory.value??inventory.pages??inventory;
    ownedId=candidates.find(p=>p.url===origin+'/identity')?.pageId;assert.ok(Number.isInteger(ownedId),'native created target tab');
    assert.equal(candidates.find(p=>p.pageId===ownedId).windowId,windowId,'new tab is in existing window');
    assert.equal(candidates.find(p=>p.pageId===ownedId).isActive,false,'new tab stays in background');
    name='run';args={code:`await browser.cdpJsonForPage(${ownedId},'Emulation.setFocusEmulationEnabled',JSON.stringify({enabled:true})); const state=await browser.cdpJsonForPage(${ownedId},'Runtime.evaluate',JSON.stringify({expression:"document.getElementById('focus').focus(); JSON.stringify({identity:document.querySelector('h1').textContent,focused:document.hasFocus(),active:document.activeElement.id})",returnByValue:true})); return state;`,session};
   }else if(turn===2){name='screenshot';args={page:ownedId,format:'png',session};}
   else if(turn===3){assert.ok(screenshot,'native model receives MCP inline image');name='evaluate';args={page:ownedId,code:"return 'BROWSER_SPILL_START'+ 'x'.repeat(60000)+'BROWSER_SPILL_END';",maxChars:1000,session};}
   else if(turn===4){
    const outputDir=path.join(toolHome,'.browseros/tool-output');const files=fs.existsSync(outputDir)?fs.readdirSync(outputDir,{recursive:true}).map(f=>path.join(outputDir,f)).filter(f=>fs.statSync(f).isFile()):[];
    spill=files.find(f=>fs.readFileSync(f,'utf8').includes('BROWSER_SPILL_END'));assert.ok(spill,'BrowserOS spills oversized result');
    name='exec_command';args={cmd:`/usr/local/bin/node -e ${quote("const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');if(s.length<60000||!s.includes('BROWSER_SPILL_END'))process.exit(1);console.log('BROWSER_SHELL_SPILL_READ '+s.length)")} ${quote(spill)}`,login:false,max_output_tokens:300};
   }else if(turn===5){name='run';args={code:`await browser.pages.close(${ownedId}); return await browser.pages.list();`,session};}
   let item;
   if(name){
    if(!['exec_command','view_image'].includes(name)){
     const ns=body.tools.find(t=>t.type==='namespace'&&t.name?.startsWith('mcp__browseros')&&t.tools?.some(t=>t.name===name));
     const tool=ns?.tools.find(t=>t.name===name)??body.tools.find(t=>t.name?.endsWith('__'+name));assert.ok(tool,'BrowserOS tool advertised '+name);namespace=ns?.name;name=tool.name;
    }
    item={type:'function_call',name,...(namespace?{namespace}:{}),call_id:'browser-'+turn,arguments:JSON.stringify(args)};
   }else item={type:'message',role:'assistant',id:'done',content:[{type:'output_text',text:'Disposable BrowserOS attachment completed.'}]};
   assert.ok(turn<8);turn++;
   const response={id:'browser-response-'+turn,usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
   const events=[{type:'response.created',response},{type:'response.output_item.done',item},{type:'response.completed',response}];
   res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  }catch(e){error??=e;json(500,{error:'synthetic browser workload failure'});}
 });
 model.listen(0,'127.0.0.1');await once(model,'listening');
 try {
  children.push(spawn('Xvfb',[':93','-screen','0','1280x900x24','-nolisten','tcp','-ac'],{stdio:['ignore',log,log],detached:true}));await delay(400);
  const browserEnv={...process.env,HOME:toolHome,DISPLAY:':93',CHROME_DEVEL_SANDBOX:path.join(path.dirname(browserPath),'chrome_sandbox')};
  children.push(spawn(browserPath,['--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',origin+'/held'],{env:browserEnv,stdio:['ignore',log,log],detached:true}));
  for(let i=0;i<120;i++){
   if(children.at(-1).exitCode!==null)throw Error('BrowserOS exited');
   const config=path.join(profile,'.browseros/config.json');
   if(fs.existsSync(config)){const ports=JSON.parse(fs.readFileSync(config)).ports;mcpUrl='http://127.0.0.1:'+ports.proxy+'/mcp';try{await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'disposable-setup',version:'1'}});break;}catch{}}
   await delay(250);
  }
  assert.ok(mcpUrl);const setup=structured(await call('run',{code:'return {pages:await browser.pages.list()};'}));put(path.join(dir,'before-native.json'),JSON.stringify(setup,null,2));
  const value=setup.value??setup;heldId=value.pages.find(p=>p.url===origin+'/held').pageId;windowId=value.pages.find(p=>p.pageId===heldId).windowId;
  assert.ok(Number.isInteger(windowId),'held tab window identified');
  const negative=await call('evaluate',{page:heldId,code:'return await (await fetch("/identity")).text();'});assert.ok(textOf(negative).includes('UNAUTHENTICATED_BROWSER'));put(path.join(dir,'unauthenticated-negative.json'),JSON.stringify(negative,null,2));
  await call('evaluate',{page:heldId,code:"document.cookie='workload_session=SYNTHETIC_BROWSER_COOKIE; Path=/; SameSite=Lax'; return 'DISPOSABLE_COOKIE_SEEDED';"});
  const env={HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TERM:'xterm-256color'};
  put(path.join(home,'.codex/config.toml'),`model="gpt-5.4"\nmodel_provider="fixture"\nmcp_oauth_credentials_store="file"\n[features]\napps=false\ncode_mode=false\n[mcp_servers.browseros]\nurl=${JSON.stringify(mcpUrl)}\nrequired=true\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${model.address().port}"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const args=['exec','--json','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','Use attached disposable BrowserOS session to execute the bounded browser workload.'];
  if(protectedLaunch){const prepared={...prepareCodexAccountState({homeDir:home,env,environment:readCodexEnvironment(),accountId:'api-provider:deepseek',label:'fixture'}),keyBacked:true};invocation=await prepareCodexNativeInvocation({prepared,homeDir:home,cwd,env,args});}
  child=spawn(invocation?.command??'/opt/aimgr-state-audit/bin/codex',invocation?.args??args,{cwd,env:invocation?.env??env,stdio:['ignore','pipe','pipe',...(invocation?[invocation.environmentFd]:[])],detached:true});invocation?.closeEnvironment();
  child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},90000);
  const [code,signal]=await once(child,'close');clearTimeout(timer);if(error)throw error;assert.equal(code,0,mode+' native '+code+'/'+signal);
  const resultText=JSON.stringify(outputs);for(const marker of ['SYNTHETIC_BROWSER_IDENTITY','BROWSER_SHELL_SPILL_READ'])assert.ok(resultText.includes(marker),'native result includes '+marker);
  const parsed=[];const inspect=v=>{if(typeof v==='string'){try{const clean=v.replace(/^Wall time:[^\n]*\nOutput:\n/,'');const u=unwrap(clean);inspect(u===clean?JSON.parse(clean):u);}catch{}}else if(Array.isArray(v))v.forEach(inspect);else if(v&&typeof v==='object'){parsed.push(v);Object.values(v).forEach(inspect);}};outputs.forEach(inspect);
  assert.ok(parsed.some(v=>v.identity==='SYNTHETIC_BROWSER_IDENTITY'&&v.focused===true&&v.active==='focus'),'exact native focus and identity result');
  assert.ok(fs.statSync(screenshot).size>1000);
  const after=structured(await call('run',{code:'return await browser.pages.list();'}));put(path.join(dir,'after-native.json'),JSON.stringify(after,null,2));
  assert.ok(JSON.stringify(after).includes(origin+'/held'));assert.ok(!JSON.stringify(after).includes(origin+'/identity'),'owned tab cleaned');
  assert.ok(requests.some(r=>r.url==='/identity'&&r.authenticated));
  const row={launch:mode,browser:'BrowserOS 0.51.0 / Chromium 155.0.8309.26',existingBrowserAttached:true,heldTabPreserved:true,syntheticCookieIdentity:true,unauthenticatedSetupNegative:true,backgroundTabInExistingWindow:true,focusEmulation:true,mcpInlineImage:true,shellSpillRead:true,ownedTabClosed:true,screenshotSha256:createHash('sha256').update(fs.readFileSync(screenshot)).digest('hex')};results.push(row);console.log(JSON.stringify(row));
 }finally{
  clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}
  await invocation?.close();
  for(const p of children.reverse()){try{process.kill(-p.pid,'SIGTERM');}catch{}await Promise.race([once(p,'close').catch(()=>{}),delay(2000)]);if(p.exitCode===null){try{process.kill(-p.pid,'SIGKILL');}catch{}}}
  fs.closeSync(log);for(const s of [pages,model]){s.closeAllConnections();await new Promise(r=>s.close(r));}
  put(path.join(dir,'stdout.jsonl'),Buffer.concat(stdout));put(path.join(dir,'stderr.log'),Buffer.concat(stderr));put(path.join(dir,'model-requests.json'),JSON.stringify(modelRequests,null,2));put(path.join(dir,'tool-results.json'),JSON.stringify(outputs,null,2));put(path.join(dir,'http-receipt.json'),JSON.stringify(requests,null,2));
 }
}
put(path.join(root,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({fixture:root,results}));
