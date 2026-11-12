#!/usr/bin/env node
// Case 6 mechanical coverage. Actual gpt-image CLI/OpenAI SDK and artifact
// libraries execute through native Codex; the Images endpoint is synthetic.
// This does not claim a real Images grant or Google upload/readback.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import zlib from 'node:zlib';
import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {prepareCodexAccountState} from '../src/privacy/codex-account-state.js';
import {prepareCodexNativeInvocation} from '../src/privacy/codex-native-invocation.js';
import {readCodexEnvironment} from '../src/privacy/codex-environment.js';
assert.ok(fs.existsSync('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST'));assert.notEqual(process.getuid(),0);assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
const base='/home/aimdev/codex-workload-browser-20261105', python=base+'/python-env/bin/python', imageCli=base+'/python-env/bin/gpt-image';
const root=fs.mkdtempSync('/opt/aimgr-state-audit/codex-m1-fixtures/workload-artifacts-');
const put=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s,{mode:0o600});};
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'", results=[];
console.log(JSON.stringify({fixture:root,case:6}));
for(const protectedLaunch of [false,true]){
 const mode=protectedLaunch?'protected':'stock',home=path.join(root,mode,'home'),cwd=path.join(home,'workspace/project'),artifacts=path.join(home,'exports/fictional-workload'),config=path.join(home,'.codex');
 for(const p of [cwd,artifacts,config])fs.mkdirSync(p,{recursive:true});
 const canary='SYNTHETIC_IMAGES_'+mode,wrong='SYNTHETIC_WRONG_HOME_KEY';put(path.join(artifacts,'.env'),'OPENAI_API_KEY='+canary+'\n');put(path.join(home,'.env'),'OPENAI_API_KEY='+wrong+'\n');
 const helper=path.join(home,'tools/artifacts.py');
 put(helper,`from PIL import Image,ImageDraw
from pathlib import Path
import sys,json,zipfile,hashlib,io
p=Path(sys.argv[2]);p.mkdir(parents=True,exist_ok=True)
if sys.argv[1]=='seed':
 im=Image.new('RGB',(1024,1024),'#174cbe');d=ImageDraw.Draw(im);d.rectangle((160,160,864,864),fill='#ffc447');d.text((290,480),'FICTIONAL WORKLOAD',fill='black');im.save(p/'mock-response.png')
 im.resize((256,256)).save(p/'reference.png')
 frames=[Image.new('RGB',(128,128),c) for c in ['#174cbe','#ffc447']];frames[0].save(p/'animation.gif',save_all=True,append_images=frames[1:],duration=300,loop=0)
 print('ARTIFACT_INPUTS_READY')
else:
 from pptx import Presentation
 from pptx.util import Inches,Pt
 from openpyxl import Workbook,load_workbook
 from openpyxl.styles import Font,PatternFill,Alignment,Border,Side
 from openpyxl.drawing.image import Image as SheetImage
 deck=Presentation();deck.slide_width=Inches(13.333);deck.slide_height=Inches(7.5)
 for title,file in [('Fictional team ships 12 lessons', 'edited.png'),('Fictional progress has two states','animation.gif')]:
  s=deck.slides.add_slide(deck.slide_layouts[6]);t=s.shapes.add_textbox(Inches(.6), Inches(.3),Inches(12),Inches(.6)).text_frame;t.text=title;t.paragraphs[0].font.size=Pt(28)
  s.shapes.add_picture(str(p/file),Inches(3.9),Inches(1.3),height=Inches(5.5));n=s.shapes.add_textbox(Inches(.6),Inches(6.9), Inches(12), Inches(.3)).text_frame;n.text='Synthetic fixture · fictional data · '+str(len(deck.slides))
 deck.save(p/'fictional-lessons.pptx')
 wb=Workbook();ws=wb.active;ws.title='Fictional lessons';ws.append(['Fictional team','Target lessons','Completed lessons','Remaining lessons']);ws.append(['North',20,12,'=B2-C2']);ws.append(['South',16,10,'=B3-C3']);ws.append(['Total','=SUM(B2:B3)','=SUM(C2:C3)','=B4-C4']);ws.freeze_panes='B2'
 for col,width in {'A':24,'B':20,'C':22,'D':22,'F':30}.items():ws.column_dimensions[col].width=width
 for c in ws[1]:c.font=Font(bold=True);c.border=Border(bottom=Side(style='thin',color='A8B5CC'));c.alignment=Alignment(horizontal='left' if c.column==1 else 'right')
 for r in [2,3]:
  ws.cell(r,2).font=Font(color='174CBE');ws.cell(r,2).fill=PatternFill('solid',fgColor='EDF2FF')
 for row in ws.iter_rows(min_row=2,max_row=4,min_col=2,max_col=4):
  for c in row:c.number_format='0';c.alignment=Alignment(horizontal='right')
 ws['F1']='Blue cells: target assumptions';ws['F2']='Fictional fixture; no real users';ws.add_image(SheetImage(str(p/'edited.png')),'F4');ws.add_image(SheetImage(str(p/'animation.gif')),'F60');wb.save(p/'fictional-lessons.xlsx')
 check=load_workbook(p/'fictional-lessons.xlsx');assert check.active['D2'].value=='=B2-C2';assert check.active.freeze_panes=='B2'
 receipt={}
 for file,prefix in [('fictional-lessons.pptx','ppt/media/'),('fictional-lessons.xlsx','xl/media/')]:
  with zipfile.ZipFile(p/file) as z:
   media=[(n,z.read(n)) for n in z.namelist() if n.startswith(prefix)];assert any(b== (p/'edited.png').read_bytes() for n,b in media)
   gifs=[(n,b) for n,b in media if b.startswith(b'GIF')];assert len(gifs)==1;im=Image.open(io.BytesIO(gifs[0][1]));assert im.n_frames==2
   receipt[file]={'bytes':(p/file).stat().st_size,'sha256':hashlib.sha256((p/file).read_bytes()).hexdigest(),'embeddedGifFrames':im.n_frames,'embeddedImageExact':True}
 (p/'artifact-receipt.json').write_text(json.dumps(receipt,indent=2));print('ARTIFACT_DECK_WORKBOOK_VERIFIED '+json.dumps(receipt))
`);
 let step=0,error,invocation,child,timer;const outputs=[],modelRequests=[],stdout=[],stderr=[],imageRequests=[];
 const service=http.createServer(async(req,res)=>{
  const json=(n,v)=>{res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  try{
   const chunks=[];for await(const c of req)chunks.push(c);let b=Buffer.concat(chunks);
   if(req.url==='/v1/images/edits'){
    assert.equal(req.headers.authorization,'Bearer '+canary,'cwd dotenv selected');assert.ok(b.includes(fs.readFileSync(path.join(artifacts,'reference.png'))),'actual reference attached');assert.ok(b.includes(Buffer.from('gpt-image-2.5-flare')),'actual model preserved');
    imageRequests.push({endpoint:req.url,cwdDotenvSelected:true,referenceAttached:true,defaultFlare:true});json(200,{created:1,data:[{b64_json:fs.readFileSync(path.join(artifacts,'mock-response.png')).toString('base64')}]});return;
   }
   if(req.method==='GET'){json(200,{models:[]});return;}
   if(req.headers['content-encoding']==='gzip')b=zlib.gunzipSync(b);if(req.headers['content-encoding']==='zstd')b=zlib.zstdDecompressSync(b);
   const body=JSON.parse(b);modelRequests.push(body);for(const v of body.input??[])if(v.type==='function_call_output')outputs.push(v.output);
   const commands=[`${q(python)} ${q(helper)} seed ${q(artifacts)}`,`cd ${q(artifacts)}\n${q(imageCli)} --version\n${q(imageCli)} -i reference.png -p 'Preserve the synthetic blue and yellow shapes from image 1.' -f edited.png`,`${q(python)} ${q(helper)} build ${q(artifacts)}`];
   const item=step<3?{type:'function_call',name:'exec_command',call_id:'artifacts-'+step,arguments:JSON.stringify({cmd:commands[step],login:false,max_output_tokens:1500,yield_time_ms:10000})}:step===3?{type:'function_call',name:'view_image',call_id:'artifact-image',arguments:JSON.stringify({path:path.join(artifacts,'edited.png')})}:{type:'message',role:'assistant',id:'done',content:[{type:'output_text',text:'Fictional deck and workbook created and verified.'}]};assert.ok(step<5);step++;
   const response={id:'artifact-'+step,usage:{input_tokens:1,output_tokens:1,total_tokens:2}};const events=[{type:'response.created',response},{type:'response.output_item.done',item},{type:'response.completed',response}];res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  }catch(e){error??=e;json(500,{error:'synthetic artifact failure'});}
 });service.listen(0,'127.0.0.1');await once(service,'listening');
 const env={HOME:home,CODEX_HOME:config,PATH:base+'/python-env/bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TERM:'xterm-256color',OPENAI_BASE_URL:'http://127.0.0.1:'+service.address().port+'/v1'};
 put(path.join(config,'config.toml'),`model="gpt-5.4"\nmodel_provider="fixture"\nmcp_oauth_credentials_store="file"\n[features]\napps=false\ncode_mode=false\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${service.address().port}"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
 try{
  const args=['exec','--json','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--add-dir',artifacts,'Create fictional deck and workbook outside the starting directory using the installed image CLI with a reference and cwd dotenv.'];
  if(protectedLaunch){const prepared={...prepareCodexAccountState({homeDir:home,env,environment:readCodexEnvironment(),accountId:'api-provider:deepseek',label:'fixture'}),keyBacked:true};invocation=await prepareCodexNativeInvocation({prepared,homeDir:home,cwd,env,args});}
  child=spawn(invocation?.command??'/opt/aimgr-state-audit/bin/codex',invocation?.args??args,{cwd,env:invocation?.env??env,stdio:['ignore','pipe','pipe',...(invocation?[invocation.environmentFd]:[])],detached:true});invocation?.closeEnvironment();child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},60000);
  const [code,signal]=await once(child,'close');clearTimeout(timer);if(error)throw error;assert.equal(code,0,mode+' native '+code+'/'+signal);
  assert.equal(imageRequests.length,1);assert.ok(JSON.stringify(outputs).includes('ARTIFACT_DECK_WORKBOOK_VERIFIED'));assert.ok(!JSON.stringify(modelRequests).includes(canary),'credential never returned to model');assert.ok(JSON.stringify(modelRequests).includes('input_image'),'actual output opened by native image tool');
  const receipt=JSON.parse(fs.readFileSync(path.join(artifacts,'artifact-receipt.json')));assert.ok(receipt['fictional-lessons.pptx'].embeddedImageExact&&receipt['fictional-lessons.xlsx'].embeddedImageExact);
  const row={launch:mode,outsideInitialCwd:true,actualImageCli:'0.3.0',cwdDotenv:true,referenceAttached:true,openaiSdk:true,deckAndWorkbook:true,embeddedAnimatedGifFrames:2,localImageOpened:true,imagesEndpoint:'synthetic',realImagesCredential:'missing',realGoogleUploadReadback:'missing independent test Google identity',artifacts:receipt};results.push(row);console.log(JSON.stringify(row));
 }finally{clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}await invocation?.close();service.closeAllConnections();await new Promise(r=>service.close(r));put(path.join(root,mode,'stdout.jsonl'),Buffer.concat(stdout));put(path.join(root,mode,'stderr.log'),Buffer.concat(stderr));put(path.join(root,mode,'model-requests.json'),JSON.stringify(modelRequests,null,2));put(path.join(root,mode,'image-receipt.json'),JSON.stringify(imageRequests,null,2));}
}
put(path.join(root,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({fixture:root,results}));
