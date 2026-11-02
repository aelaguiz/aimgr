#!/usr/bin/env python3
"""Bounded synthetic experiment; not a product sandbox or launch policy.

Requires the disposable rented Mac, independent outbound deny, and the preceding
fixtures documented in README.md. No real accounts, browsers or personal files.
Exact raw observations stay on the test host; only sanitized results are exported.
"""
import platform
from pathlib import Path
if platform.system() != "Darwin" or not Path("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST").is_file():
    raise SystemExit("Disposable offsite Mac required")
import json,os,signal,subprocess
from pathlib import Path
base=Path('/opt/aimgr-state-audit');assert (base/'OFFSITE_AUDIT_HOST').is_file()
r=base/'mac-sandbox-candidate';r.mkdir(mode=0o700)
secret=r/'private-host/identity.txt';secret.parent.mkdir();secret.write_text('SYNTHETIC-HOST-IDENTITY\n')
shared=r/'shared';shared.mkdir();(shared/'escape-link').symlink_to(secret)
safe=['/System','/usr','/bin','/sbin','/dev','/private/etc','/etc','/private/var/db/dyld','/Library/Apple','/Library/Developer/CommandLineTools',str(base/'bin'),str(shared),str(r/'models-files'),str(r/'models-combined'),'/private/var/select/developer_dir','/var/select/developer_dir']
parents=set(str(a) for p in safe for a in Path(p).parents)
allowed='\n'.join('(subpath '+json.dumps(p)+')' for p in safe)+'\n'+'\n'.join('(literal '+json.dumps(p)+')' for p in sorted(parents))
files='(version 1)\n(allow default)\n(deny file-read* (require-not (require-any\n'+allowed+'\n)))\n'
attrs=(base/'mac-sandbox-verified/attributes-only.sb').read_text().split('(allow default)\n',1)[1]
extra='(deny syscall-unix (syscall-number SYS_gethostuuid))\n(deny process-exec (literal "/usr/bin/sw_vers"))\n'
profiles={}
for label,text in [('files',files),('combined',files+attrs+extra)]:
 path=r/(label+'.sb');path.write_text(text);profiles[label]=path

def run(args,profile=None,timeout=40):
 cmd=(['/usr/bin/sandbox-exec','-f',str(profile)] if profile else [])+args
 env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(shared),'TMPDIR':str(shared)}
 p=subprocess.Popen(cmd,cwd=shared,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
 try:out,err=p.communicate(timeout=timeout)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:out,err=p.communicate(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()
 return {'exit':p.returncode,'stdout':out,'stderr':err}
report={};digests={}
build=run(['/usr/bin/xcrun','clang','-framework','Foundation','-framework','IOKit',str(base/'privacy-macos-attributes.m'),'-o',str(shared/'attributes')],timeout=60)
(r/'build.private.json').write_text(json.dumps(build));assert build['exit']==0,build['stderr']
for label,profile in [('baseline',None),*profiles.items()]:
 row={}
 for name,cmd in [('load',['/usr/bin/true']),('python',['/usr/bin/python3','-c','import pathlib,pty,subprocess,json;print("OK")']),('git',['/usr/bin/git','--version']),('swVers',['/usr/bin/sw_vers','-productVersion']),('attributes',[str(shared/'attributes')])]:
  v=run(cmd,profile);(r/(label+'-'+name+'.private.json')).write_text(json.dumps(v));row[name]=v
  if name=='attributes' and v['exit']==0:
   a=json.loads(v['stdout']);a.pop('privateFoundationHostnameDigest',None);digests[label]=a.pop('privateHostUuidDigest',None);a['sameHostUuidAsBaseline']=bool(digests[label] and digests[label]==digests.get('baseline'));row[name]={'exit':0,'values':a}
 if row['load']['exit']==0 and row['python']['exit']==0:
  out=r/('models-'+label)
  cmd=['/usr/bin/python3',str(base/'audit.py'),'--root',str(out),'--codex',str(base/'bin/codex'),'--claude',str(base/'bin/claude'),'--fresh-only','--exercise-tools','--private-canary',str(secret),'--private-claude-temp']
  if profile:cmd+=['--sandbox-profile',str(profile)]
  v=run(cmd,timeout=110);(r/(label+'-workflow.private.json')).write_text(json.dumps(v))
  row['workflow']={'harnessExit':v['exit']}
  summary=out/'summary.json'
  if summary.exists():
   s=json.loads(summary.read_text());s['results']=[{k:x.get(k) for k in ['case','exitCode','modelRequestCount','userAgents','workflow','toolOutputReturned','sharedEditObserved']} for x in s['results']];row['workflow']['summary']=s
 report[label]=row
 (r/'public-results.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({label:row},indent=2),flush=True)
