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
r=base/'mac-mach-denial';r.mkdir(mode=0o700)
probe=base/'mac-sandbox-candidate/shared/attributes'
basepolicy=(base/'mac-sandbox-verified/attributes-only.sb').read_text()+'\n(deny syscall-unix (syscall-number SYS_gethostuuid))\n'
policies={'host-info':basepolicy+'(deny syscall-mig (kernel-mig-routine host_info host_kernel_version))\n',
'no-inference':basepolicy+'(disable-syscall-inference)\n(deny syscall-mig (kernel-mig-routine host_info host_kernel_version))\n'}
report={}
for label,text in policies.items():
 profile=r/(label+'.sb');profile.write_text(text);row={}
 for name,cmd in [('load',['/usr/bin/true']),('attributes',[str(probe)]),('python',['/usr/bin/python3','-c','import os;print("OK")'])]:
  p=subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),*cmd],capture_output=True,text=True,timeout=20)
  (r/(label+'-'+name+'.private.json')).write_text(json.dumps({'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}))
  row[name]={'exit':p.returncode,'error':p.stderr[:1600]}
  if name=='attributes' and p.returncode==0:
   value=json.loads(p.stdout);value.pop('privateHostUuidDigest',None);row[name]['values']=value
 report[label]=row
(r/'public-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
