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
r=base/'hostuuid-syscall';r.mkdir()
source=r/'probe.c';source.write_text('''#include <unistd.h>
#include <sys/syscall.h>
#include <uuid/uuid.h>
#include <stdio.h>
#include <errno.h>
#include <time.h>
int main(int argc,char**argv){uuid_t u={0};struct timespec t={1,0};int n=argc>1?syscall(SYS_gethostuuid,u,&t):gethostuuid(u,&t);if(n){printf("error:%d\\n",errno);return 1;}for(int i=0;i<16;i++)printf("%02x",u[i]);puts("");return 0;}
''')
subprocess.run(['/usr/bin/xcrun','clang',str(source),'-o',str(r/'probe')],check=True,capture_output=True)
policies={'symbol':'(version 1)\n(allow default)\n(deny syscall-unix (syscall-number SYS_gethostuuid))\n',
'numeric':'(version 1)\n(allow default)\n(deny syscall-unix (syscall-number 142))\n',
'no-inference':'(version 1)\n(disable-syscall-inference)\n(allow default)\n(deny syscall-unix (syscall-number 142))\n'}
rows=[];baseline={}
for label,policy in [('baseline',None),*policies.items()]:
 prefix=[]
 if policy:
  path=r/(label+'.sb');path.write_text(policy);prefix=['/usr/bin/sandbox-exec','-f',str(path)]
 row={'profile':label}
 for mode,args in [('policyLoad',['/usr/bin/true']),('libc',[str(r/'probe')]),('direct',[str(r/'probe'),'direct'])]:
  p=subprocess.run(prefix+args,capture_output=True,text=True,timeout=10)
  (r/(label+'-'+mode+'.private.json')).write_text(json.dumps({'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}))
  value=p.stdout.strip();valid=p.returncode==0 and len(value)==32 and all(x in '0123456789abcdef' for x in value) and value!='0'*32
  if label=='baseline':baseline[mode]=value
  row[mode]={'exit':p.returncode,'validUuid':valid,'sameAsBaseline':valid and value==baseline.get(mode),'error':p.stderr[:1000]}
  if value.startswith('error:'):row[mode]['errno']=value
 rows.append(row)
report={'results':rows};(r/'public-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
