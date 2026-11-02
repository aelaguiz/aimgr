#!/usr/bin/env python3
"""Observe official CLI copies using fake credentials and loopback model responses.

Run only on the disposable offsite test hosts. Linux invocation must be inside a
fresh network namespace with only loopback; macOS requires the rental's outbound
deny boundary. Changing HOME here creates experimental fixtures, not a proposed
change to the user's daily shell. The mock receives synthetic content only.
File-open traces establish access, not transmission: request captures provide
the separate evidence that an identifier leaves the client.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import shlex
import signal
import socket
import struct
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--codex', required=True)
parser.add_argument('--claude', required=True)
parser.add_argument('--phase', default='all', choices=['all','codex','claude'])
parser.add_argument('--sandbox-profile', help='Mac research only: apply this external policy to the official client, not the capture harness.')
parser.add_argument('--exercise-tools', action='store_true', help='Have the synthetic model request a real shell tool, project edit, Git, PTY and tiny C build.')
parser.add_argument('--fresh-only', action='store_true', help='Run one fresh case per provider; do not claim repeat/clone identity coverage.')
parser.add_argument('--private-canary', help='Synthetic file outside the candidate read boundary; never use a personal file.')
parser.add_argument('--private-claude-temp', action='store_true', help='Test the documented CLAUDE_CODE_TMPDIR inside the synthetic home.')
args = parser.parse_args()
if args.sandbox_profile and (platform.system() != 'Darwin' or not Path(args.sandbox_profile).is_file()):
    raise SystemExit('A readable Mac sandbox profile is required.')
root = Path(args.root).resolve()
if not Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file() or not str(root).startswith('/opt/aimgr-state-audit/'):
    raise SystemExit('Refusing audit: explicit disposable-host marker and isolated fixture root required.')
if root.exists() and any(root.iterdir()):
    raise SystemExit('Refusing reused fixture root: use a new empty directory so fresh/clone labels remain true.')
root.mkdir(parents=True, exist_ok=True)
os.umask(0o077)
requests = []
active_case = None
active_command = None

def has_tool_output(body):
    # Check the native tool-result envelope, not a marker in the assistant's
    # command text: otherwise merely requesting the tool would look like proof.
    for item in body.get('input',[]):
        if isinstance(item,dict) and item.get('type')=='function_call_output' and 'WORKFLOW_RESULT' in str(item.get('output','')):
            return True
    for message in body.get('messages',[]):
        for item in message.get('content',[]) if isinstance(message.get('content'),list) else []:
            if isinstance(item,dict) and item.get('type')=='tool_result' and 'WORKFLOW_RESULT' in str(item.get('content','')):
                return True
    return False

def response_events(body):
    msg = {'id':'msg_audit','type':'message','role':'assistant','status':'completed',
           'content':[{'type':'output_text','text':'AUDIT_OK','annotations':[]}]}
    resp = {'id':'resp_audit','object':'response','status':'completed','output':[msg],
            'usage':{'input_tokens':10,'output_tokens':3,'total_tokens':13,
                     'input_tokens_details':{'cached_tokens':0},'output_tokens_details':{'reasoning_tokens':0}}}
    if args.exercise_tools and not has_tool_output(body):
        msg={'id':'fc_workflow','type':'function_call','call_id':'call_workflow','name':'exec_command',
             'arguments':json.dumps({'cmd':active_command,'login':False,'yield_time_ms':30000,'max_output_tokens':1500}),
             'status':'completed'}
        resp['output']=[msg]
    return [{'type':'response.created','response':dict(resp,status='in_progress',output=[])},
            {'type':'response.output_item.done','output_index':0,'item':msg},
            {'type':'response.completed','response':resp}]

class Mock(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *unused):
        pass
    def capture(self, body, transport='http'):
        entry={'case':active_case,'path':self.path,'transport':transport,
               'headers':dict(self.headers),'body':body}
        requests.append(entry)
        with (root/'requests.private.jsonl').open('a') as f:
            f.write(json.dumps(entry)+'\n')
    def reply(self, value, status=200, content_type='application/json'):
        data=value.encode() if isinstance(value,str) else json.dumps(value).encode()
        self.send_response(status);self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(data)));self.send_header('Connection','close')
        self.end_headers();self.wfile.write(data);self.close_connection=True
    def do_GET(self):
        if self.headers.get('Upgrade','').lower()=='websocket':
            self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade')
            key=self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
            self.send_header('Sec-WebSocket-Accept',base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
            self.end_headers();self.wfile.flush();self.connection.settimeout(10)
            try:
                head=self.rfile.read(2)
                if len(head)!=2:return
                length=head[1]&127
                if length==126:length=struct.unpack('!H',self.rfile.read(2))[0]
                elif length==127:length=struct.unpack('!Q',self.rfile.read(8))[0]
                mask=self.rfile.read(4) if head[1]&128 else None
                payload=self.rfile.read(length)
                if mask:payload=bytes(v^mask[i%4] for i,v in enumerate(payload))
                body=json.loads(payload)
                self.capture(body,'websocket')
                for event in response_events(body):
                    data=json.dumps(event).encode()
                    frame=b'\x81'+(bytes([len(data)]) if len(data)<126 else b'\x7e'+struct.pack('!H',len(data)))+data
                    self.wfile.write(frame);self.wfile.flush()
            except (OSError,ValueError):
                pass
            self.close_connection=True
            return
        self.capture(None)
        self.reply({'data':[],'models':[]})
    def do_POST(self):
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        try:body=json.loads(raw)
        except ValueError:body={'unparsed':raw.decode(errors='replace')}
        self.capture(body)
        if 'count_tokens' in self.path:
            self.reply({'input_tokens':10});return
        if 'messages' in self.path:
            msg={'id':'msg_audit','type':'message','role':'assistant','model':body.get('model'),
                 'content':[{'type':'text','text':'AUDIT_OK'}],'stop_reason':'end_turn','stop_sequence':None,
                 'usage':{'input_tokens':10,'output_tokens':3}}
            tool=args.exercise_tools and not has_tool_output(body)
            if tool:
                msg['content']=[{'type':'tool_use','id':'tool_workflow','name':'Bash','input':{'command':active_command,'timeout':30000}}]
                msg['stop_reason']='tool_use'
            if body.get('stream'):
                events=[{'type':'message_start','message':dict(msg,content=[],stop_reason=None)},
                        {'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},
                        {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'AUDIT_OK'}},
                        {'type':'content_block_stop','index':0},
                        {'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':3}},
                        {'type':'message_stop'}]
                if tool:
                    events=[{'type':'message_start','message':dict(msg,content=[],stop_reason=None)},
                            {'type':'content_block_start','index':0,'content_block':dict(msg['content'][0],input={})},
                            {'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(msg['content'][0]['input'])}},
                            {'type':'content_block_stop','index':0},
                            {'type':'message_delta','delta':{'stop_reason':'tool_use','stop_sequence':None},'usage':{'output_tokens':3}},
                            {'type':'message_stop'}]
                self.reply(''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events),content_type='text/event-stream')
            else:self.reply(msg)
        elif 'responses' in self.path:
            self.reply(''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in response_events(body)),content_type='text/event-stream')
        else:self.reply({})

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock)
threading.Thread(target=server.serve_forever,daemon=True).start()
endpoint='http://127.0.0.1:'+str(server.server_port)
workspace=root/'project';workspace.mkdir(exist_ok=True)
(workspace/'README.md').write_text('Synthetic privacy audit project. No personal content.\n')

def digest(data):
    return hashlib.sha256(data).hexdigest()[:16]

def inventory(home):
    result=[]
    for path in sorted(home.rglob('*')):
        if path.is_symlink():
            result.append({'path':str(path.relative_to(home)),'symlink':os.readlink(path)})
        elif path.is_file():
            data=path.read_bytes()
            row={'path':str(path.relative_to(home)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
            if path.suffix=='.json' and len(data)<1024*1024:
                try:
                    j=json.loads(data)
                    if isinstance(j,dict):row['keys']=sorted(j)
                except ValueError:pass
            result.append(row)
    return result

def run_case(provider,label,app_home,os_home,telemetry_off=True):
    global active_case,active_command
    active_case=provider+'-'+label
    workflow_file=workspace/(active_case+'-workflow.json')
    edit_file=workspace/(active_case+'-native-edit.txt')
    if args.exercise_tools:
        probe='''import json,os,pathlib,pty,subprocess
p=pathlib.Path.cwd();result={}
(p/'native-edit.txt').write_text('live shared project edit\\n')
result['edit']=True
g=subprocess.run(['git','init','-q',str(p)],capture_output=True,timeout=5)
result['git']=g.returncode==0
try:
 m,s=pty.openpty();result['pty']=os.isatty(s);os.close(m);os.close(s)
except OSError:result['pty']=False
(p/'probe.c').write_text('#include <stdio.h>\\nint main(void){puts("NATIVE_BUILD_OK");return 0;}\\n')
try:
 c=subprocess.run(['cc',str(p/'probe.c'),'-o',str(p/'probe')],capture_output=True,timeout=20)
 result['nativeBuild']=c.returncode==0 and subprocess.check_output([str(p/'probe')],text=True).strip()=='NATIVE_BUILD_OK'
except (OSError,subprocess.SubprocessError):result['nativeBuild']=False
'''
        probe=probe.replace("'native-edit.txt'",repr(edit_file.name))
        if args.private_canary:
            # Only accept the deliberately created test canary, never arbitrary
            # host files. The parent observer is outside the candidate policy.
            assert Path(args.private_canary).read_text().startswith('SYNTHETIC-HOST-IDENTITY')
            probe+='\ntry:\n pathlib.Path('+repr(args.private_canary)+').read_text();result["privateReadDenied"]=False\nexcept OSError:result["privateReadDenied"]=True\n'
        probe+='\npathlib.Path('+repr(str(workflow_file))+').write_text(json.dumps(result))\nprint("WORKFLOW_RESULT "+json.dumps(result))\n'
        active_command='/usr/bin/python3 -c '+shlex.quote(probe)
    for p in [app_home,os_home,os_home/'.config',os_home/'.cache',os_home/'.local/share',os_home/'tmp']:
        p.mkdir(parents=True,exist_ok=True)
    env={'PATH':'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(os_home),'USER':os.environ.get('USER','audit'),
         'SHELL':'/bin/bash','TMPDIR':str(os_home/'tmp'),'XDG_CONFIG_HOME':str(os_home/'.config'),
         'XDG_CACHE_HOME':str(os_home/'.cache'),'XDG_DATA_HOME':str(os_home/'.local/share'),
         'TERM':'xterm-256color','TERM_PROGRAM':'PrivacyAuditTerminal','TERM_PROGRAM_VERSION':'AUDIT_VERSION_123'}
    if provider=='codex':
        env.update(CODEX_HOME=str(app_home),OPENAI_API_KEY='sk-synthetic-privacy-audit-not-a-real-key')
        config='model = "gpt-5.4"\nopenai_base_url = "'+endpoint+'/v1"\ncli_auth_credentials_store = "file"\n'
        if telemetry_off:
            config+='[analytics]\nenabled = false\n[feedback]\nenabled = false\n[otel]\nexporter = "none"\ntrace_exporter = "none"\nmetrics_exporter = "none"\n'
        (app_home/'config.toml').write_text(config)
        command=[args.codex,'exec','--skip-git-repo-check','--json','Reply AUDIT_OK. Do not use tools.']
        if args.exercise_tools:
            command=[args.codex,'exec','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','--json','Use the shell tool to perform the synthetic native workflow test, then reply AUDIT_OK.']
    else:
        env.update(CLAUDE_CONFIG_DIR=str(app_home),ANTHROPIC_API_KEY='sk-ant-synthetic-privacy-audit-not-real',ANTHROPIC_BASE_URL=endpoint,
                   DISABLE_AUTOUPDATER='1')
        if args.private_claude_temp:env['CLAUDE_CODE_TMPDIR']=str(os_home/'tmp')
        if telemetry_off:
            env.update(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1')
        command=[args.claude,'-p','Reply AUDIT_OK. Do not use tools.','--model','claude-sonnet-4-6','--output-format','json']
        if args.exercise_tools:
            command=[args.claude,'-p','Use Bash to perform the synthetic native workflow test, then reply AUDIT_OK.','--model','claude-sonnet-4-6','--output-format','json','--dangerously-skip-permissions']
    before=inventory(os_home)+[dict(x,path='APP/'+x['path']) for x in inventory(app_home)]
    if args.sandbox_profile:
        command=['/usr/bin/sandbox-exec','-f',args.sandbox_profile]+command
    if platform.system()=='Linux':
        command=['/usr/bin/strace','-f','-tt','-yy','-s','256','-e','trace=%file,%network,%process','-o',str(root/(active_case+'.strace'))]+command
    start=len(requests)
    with (root/(active_case+'.stdout')).open('w') as out,(root/(active_case+'.stderr')).open('w') as err:
        process=subprocess.Popen(command,cwd=workspace,env=env,stdout=out,stderr=err,start_new_session=True)
        try:code=process.wait(timeout=40)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGTERM)
            try:code=process.wait(timeout=3)
            except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);code=process.wait()
    captures=requests[start:]
    ids=[];agents=[]
    for entry in captures:
        body=entry['body'] or {}
        meta=body.get('client_metadata',{})
        if 'x-codex-installation-id' in meta:ids.append(meta['x-codex-installation-id'])
        user=(body.get('metadata') or {}).get('user_id')
        if user:
            try:
                parsed=json.loads(user) if isinstance(user,str) else user
                if isinstance(parsed,dict):ids.append(parsed.get('device_id') or str(parsed))
            except ValueError:ids.append(user)
        agents.extend(v for k,v in entry['headers'].items() if k.lower()=='user-agent')
    identity=app_home/'installation_id'
    local_id=identity.read_text().strip() if identity.exists() else None
    if provider=='claude':
        for p in [app_home/'.claude.json',os_home/'.claude.json']:
            if p.exists():
                obj=json.loads(p.read_text());local_id=obj.get('userID') or local_id
    after=inventory(os_home)+[dict(x,path='APP/'+x['path']) for x in inventory(app_home)]
    result={'case':active_case,'exitCode':code,'requestCount':len(captures),'modelRequestCount':sum('messages' in x['path'] or 'responses' in x['path'] for x in captures),
            'identifierHashes':sorted(set(digest(str(x).encode()) for x in ids)),
            'diskIdentifierHash':digest(local_id.encode()) if local_id else None,
            'userAgents':sorted(set(agents)),'filesBefore':before,'filesAfter':after}
    if args.exercise_tools:
        result['workflow']=json.loads(workflow_file.read_text()) if workflow_file.exists() else None
        result['toolOutputReturned']=any(has_tool_output(x['body'] or {}) for x in captures)
        result['sharedEditObserved']=edit_file.is_file() and edit_file.read_text()=='live shared project edit\n'
    (root/(active_case+'.json')).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['filesBefore','filesAfter']}),flush=True)
    return result

results=[]
for provider in ['codex','claude']:
    if args.phase not in ['all',provider]:continue
    base=root/provider;base.mkdir(exist_ok=True)
    home=base/'os-home'
    a=base/'account-a';b=base/'account-b'
    first=run_case(provider,'fresh-a',a,home)
    results.append(first)
    if first['exitCode'] != 0 or first['modelRequestCount'] == 0:
        print(provider+': first fixture did not complete; skipping redundant cases until diagnosed.',flush=True)
        continue
    if args.fresh_only:continue
    results.append(run_case(provider,'repeat-a',a,home))
    results.append(run_case(provider,'fresh-b',b,home))
    clone=base/'account-cloned'
    if not clone.exists():shutil.copytree(a,clone)
    results.append(run_case(provider,'cloned-a',clone,home))
    results.append(run_case(provider,'separate-os-home',base/'account-c',base/'other-home'))
server.shutdown();server.server_close()
checks=[]
for provider in ['codex','claude']:
    if args.phase not in ['all',provider]:continue
    rows={r['case'].removeprefix(provider+'-'):r for r in results if r['case'].startswith(provider+'-')}
    complete=len(rows)==(1 if args.fresh_only else 5) and all(r['exitCode']==0 and r['modelRequestCount']>0 for r in rows.values())
    checks.append({'provider':provider,'check':('one' if args.fresh_only else 'five')+' successful model exchanges','passed':complete})
    matches=complete and all(len(r['identifierHashes'])==1 and r['identifierHashes']==[r['diskIdentifierHash']] for r in rows.values())
    checks.append({'provider':provider,'check':'each transmitted identifier matches its disk identifier','passed':matches})
    if args.exercise_tools:
        checks.append({'provider':provider,'check':'native tool result returned and project/Git/PTY/build worked',
                       'passed':complete and all(r.get('toolOutputReturned') and r.get('sharedEditObserved') and r.get('workflow') and all(r['workflow'].get(k) for k in ['edit','git','pty','nativeBuild']) for r in rows.values())})
    if matches and not args.fresh_only:
        ids={name:r['diskIdentifierHash'] for name,r in rows.items()}
        checks.append({'provider':provider,'check':'restart and copied home retain ID','passed':ids['fresh-a']==ids['repeat-a']==ids['cloned-a']})
        checks.append({'provider':provider,'check':'fresh app homes have distinct IDs','passed':len({ids['fresh-a'],ids['fresh-b'],ids['separate-os-home']})==3})
passed=all(c['passed'] for c in checks)
(root/'summary.json').write_text(json.dumps({'platform':platform.platform(),'allPassed':passed,'checks':checks,'results':results},indent=2)+'\n')
print(json.dumps({'allPassed':passed,'checks':checks}),flush=True)
raise SystemExit(0 if passed else 1)
