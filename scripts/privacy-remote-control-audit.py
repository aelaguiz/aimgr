#!/usr/bin/env python3
"""Exercise enforced remote-control policy on an isolated official app-server.

The operator installs requirements.toml on the disposable test host first. This
script does not alter system policy, use a real account, or call provider URLs.
Run within the same outbound-denied boundary as privacy-state-audit.py.
"""
import argparse,json,os,queue,signal,subprocess,threading,time
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--codex',required=True);a=p.parse_args()
root=Path(a.root).resolve()
if not Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file() or not str(root).startswith('/opt/aimgr-state-audit/'):
    raise SystemExit('Disposable-host marker and isolated root required')
if root.exists() and any(root.iterdir()):
    raise SystemExit('Refusing reused fixture root: use a new empty directory.')
root.mkdir(parents=True,exist_ok=True)
home=root/'home';home.mkdir(exist_ok=True)
(home/'config.toml').write_text('cli_auth_credentials_store="file"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n')
env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'CODEX_HOME':str(home),'TERM':'dumb'}
results=[]
for attempt in ['cold','restart']:
    inbox=queue.Queue()
    with (root/(attempt+'.stderr')).open('w') as err:
        child=subprocess.Popen([a.codex,'app-server','--listen','stdio://'],env=env,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,start_new_session=True)
        def receive(stream, responses):
            for line in stream:
                try:responses.put(json.loads(line))
                except ValueError:pass
        threading.Thread(target=receive,args=(child.stdout,inbox),daemon=True).start()
        def call(i,method,params):
            child.stdin.write(json.dumps({'id':i,'method':method,'params':params})+'\n');child.stdin.flush()
            deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                item=inbox.get(timeout=max(.01,deadline-time.monotonic()))
                if item.get('id')==i:return item
            raise TimeoutError(method)
        try:
            init=call(1,'initialize',{'clientInfo':{'name':'privacy_audit','version':'1'},'capabilities':{'experimentalApi':True}})
            assert 'result' in init,init
            child.stdin.write('{"method":"initialized"}\n');child.stdin.flush()
            cases=[('remoteControl/enable',None),('remoteControl/disable',None),('remoteControl/status/read',None),
                   ('remoteControl/pairing/start',{'manualCode':False}),
                   ('remoteControl/pairing/status',{'pairingCode':'synthetic-code'}),
                   ('remoteControl/client/list',{'environmentId':'synthetic-environment'}),
                   ('remoteControl/client/revoke',{'environmentId':'synthetic-environment','clientId':'synthetic-client'})]
            for i,(method,params) in enumerate(cases,10):
                response=call(i,method,params)
                message=response.get('error',{}).get('message','')
                passed=response.get('error',{}).get('code')==-32600 and message=='remote control is disabled by managed requirements'
                results.append({'attempt':attempt,'method':method,'passed':passed,'response':response})
            local=call(99,'config/read',{'includeLayers':False})
            results.append({'attempt':attempt,'method':'config/read','passed':'result' in local})
            policy=call(100,'configRequirements/read',None)
            results.append({'attempt':attempt,'method':'configRequirements/read',
                            'passed':(policy.get('result',{}).get('requirements') or {}).get('allowRemoteControl') is False,
                            'response':policy})
        finally:
            child.stdin.close()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=5)
output={'allPassed':all(x['passed'] for x in results),'results':results}
(root/'remote-control-policy.json').write_text(json.dumps(output,indent=2)+'\n')
print(json.dumps(output),flush=True)
raise SystemExit(0 if output['allPassed'] else 1)
