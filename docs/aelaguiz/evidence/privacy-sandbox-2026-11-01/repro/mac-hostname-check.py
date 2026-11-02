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
b=Path('/opt/aimgr-state-audit');r=b/'mac-hostname-routing';r.mkdir(mode=0o700)
p=(b/'mac-sandbox-candidate/combined.sb').read_text()
probes={'both-sysctl-syscalls':p+'\n(deny syscall-unix (syscall-number SYS_sysctl SYS_sysctlbyname))\n','configd':p+'\n(deny mach-lookup (global-name "com.apple.SystemConfiguration.configd"))\n'}
baseline=json.loads((b/'mac-final-api/baseline-attributes.private.json').read_text());baseline=json.loads(baseline['stdout'])['privateFoundationHostnameDigest'];report={}
for label,policy in probes.items():
 path=r/(label+'.sb');path.write_text(policy)
 row={}
 for name,cmd in [('load',['/usr/bin/true']),('attributes',[str(b/'mac-sandbox-candidate/shared/attributes-v2')])]:
  x=subprocess.run(['/usr/bin/sandbox-exec','-f',str(path),*cmd],capture_output=True,text=True,timeout=15)
  (r/(label+'-'+name+'.private.json')).write_text(json.dumps({'exit':x.returncode,'stdout':x.stdout,'stderr':x.stderr}))
  row[name]={'exit':x.returncode,'error':x.stderr[:700]}
  if name=='attributes' and x.returncode==0:
   values=json.loads(x.stdout);digest=values.pop('privateFoundationHostnameDigest',None);values.pop('privateHostUuidDigest',None);values['sameHostnameAsBaseline']=digest==baseline;row[name]['values']=values
 report[label]=row
(r/'public-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
