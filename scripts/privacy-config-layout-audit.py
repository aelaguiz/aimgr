#!/usr/bin/env python3
"""Test native shared-config semantics using synthetic homes on offsite hosts.

This makes no model or account request. The independent outbound deny boundary
is still required because app-server startup contains other network owners.
It tests a proposed layout; it never migrates the user's settings or credentials.
"""
import argparse,json,os,queue,signal,subprocess,threading,time
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--codex',required=True);a=p.parse_args()
root=Path(a.root).resolve()
if root.parent!=Path('/opt/aimgr-state-audit') or not (root.parent/'OFFSITE_AUDIT_HOST').is_file():
    raise SystemExit('Marked disposable host and dedicated fixture root required')
if root.exists() and any(root.iterdir()):raise SystemExit('Refusing reused fixture')
root.mkdir(parents=True,exist_ok=True)
canonical=root/'original/config home';sibling=canonical.parent/'account-a';deep=root/'accounts/account-b/home'
for path in [canonical,sibling,deep]:path.mkdir(parents=True)
(canonical.parent/'instructions.md').write_text('SYNTHETIC_SHARED_INSTRUCTIONS\n')
config=canonical/'config.toml'
config.write_text('model="gpt-5.4"\nmodel_instructions_file="../instructions.md"\nsqlite_home="."\nlog_dir="."\ncli_auth_credentials_store="file"\n[features]\nshell_snapshot=true\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n')
for path in [sibling,deep]:(path/'config.toml').symlink_to(config)
results=[]
for label,home in [('canonical',canonical),('sibling',sibling),('deep',deep)]:
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(root),'CODEX_HOME':str(home),'TERM':'dumb'}
    inbox=queue.Queue()
    with (root/(label+'.stderr')).open('w') as err:
        child=subprocess.Popen([a.codex,'app-server','--listen','stdio://'],env=env,cwd=root,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,start_new_session=True)
        def receive(stream):
            for line in stream:
                try:inbox.put(json.loads(line))
                except ValueError:pass
        threading.Thread(target=receive,args=(child.stdout,),daemon=True).start()
        def call(i,method,params):
            child.stdin.write(json.dumps({'id':i,'method':method,'params':params})+'\n');child.stdin.flush()
            end=time.monotonic()+15
            while time.monotonic()<end:
                item=inbox.get(timeout=max(.01,end-time.monotonic()))
                if item.get('id')==i:return item
            raise TimeoutError(method)
        try:
            init=call(1,'initialize',{'clientInfo':{'name':'layout_audit','version':'1'},'capabilities':{'experimentalApi':True}})
            child.stdin.write('{"method":"initialized"}\n');child.stdin.flush()
            before=call(2,'config/read',{'includeLayers':False})
            # Exercise the official writer through the symlink, then ask this
            # already-running owner to reread. Never emulate the writer in Python.
            write=None;after=None
            if label=='sibling':
                old_inode=config.stat().st_ino
                write=subprocess.run([a.codex,'features','disable','shell_snapshot'],cwd=root,env=env,capture_output=True,text=True,timeout=15)
                (root/'native-write.private.json').write_text(json.dumps({'exitCode':write.returncode,'stdout':write.stdout,'stderr':write.stderr},indent=2))
                after=call(3,'config/read',{'includeLayers':False})
                writer={'exitCode':write.returncode,'symlinkPreserved':(home/'config.toml').is_symlink(),
                        'canonicalInodeReplaced':config.stat().st_ino!=old_inode,
                        'canonicalChanged':'shell_snapshot = false' in config.read_text() or 'shell_snapshot=false' in config.read_text()}
            raw={'initialize':init,'before':before,'after':after}
            (root/(label+'.private.json')).write_text(json.dumps(raw,indent=2)+'\n')
            cfg=before.get('result',{}).get('config',{})
            row={'case':label,'initializeSucceeded':'result' in init,'configReadSucceeded':'result' in before,
                 'paths':{k:cfg.get(k) for k in ['model_instructions_file','sqlite_home','log_dir']},
                 'shellSnapshot':cfg.get('features',{}).get('shell_snapshot')}
            if 'error' in before:row['configReadError']=before['error']
            if write:
                row['writer']=writer
                row['runningOwnerSawEdit']=after.get('result',{}).get('config',{}).get('features',{}).get('shell_snapshot') is False
            results.append(row)
        finally:
            child.stdin.close()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
report={'results':results,'meaning':'Native config path resolution and symlink writer observations, not a compatible migration design.'}
(root/'public-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
