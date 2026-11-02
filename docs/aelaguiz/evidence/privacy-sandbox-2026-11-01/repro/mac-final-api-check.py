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
import json,subprocess
from pathlib import Path
base=Path('/opt/aimgr-state-audit');assert (base/'OFFSITE_AUDIT_HOST').is_file()
r=base/'mac-final-api';r.mkdir(mode=0o700)
subprocess.run(['/usr/bin/xcrun','clang','-framework','Foundation','-framework','IOKit',str(base/'privacy-macos-attributes.m'),'-o',str(base/'mac-sandbox-candidate/shared/attributes-v2')],check=True,capture_output=True)
probe=base/'mac-sandbox-candidate/shared/attributes-v2'
report={};baseline={}
policies={'baseline':None,'files':(base/'mac-sandbox-candidate/files.sb').read_text(),'combined':(base/'mac-sandbox-candidate/combined.sb').read_text(),
'kernel-version-only':'(version 1)\n(allow default)\n(deny syscall-mig (kernel-mig-routine host_kernel_version))\n',
'hardware-info-only':'(version 1)\n(allow default)\n(deny syscall-mig (kernel-mig-routine host_info))\n',
'memory-sysctl-only':'(version 1)\n(allow default)\n(deny sysctl-read (sysctl-name "hw.memsize"))\n'}
for label,text in policies.items():
 prefix=[]
 if text:
  path=r/(label+'.sb');path.write_text(text);prefix=['/usr/bin/sandbox-exec','-f',str(path)]
 row={}
 for name,cmd in [('load',['/usr/bin/true']),('attributes',[str(probe)])]:
  p=subprocess.run(prefix+cmd,capture_output=True,text=True,timeout=15)
  (r/(label+'-'+name+'.private.json')).write_text(json.dumps({'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}))
  row[name]={'exit':p.returncode,'error':p.stderr[:1000]}
  if name=='attributes' and p.returncode==0:
   values=json.loads(p.stdout)
   for key in list(values):
    if key.startswith('private'):
     value=values.pop(key)
     if label=='baseline':baseline[key]=value
     values['sameAsBaseline'+key.removeprefix('private')]=value==baseline.get(key)
   row[name]['values']=values
 report[label]=row
(r/'public-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
