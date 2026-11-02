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
import json,os,subprocess
from pathlib import Path
b=Path('/opt/aimgr-state-audit');assert (b/'OFFSITE_AUDIT_HOST').is_file();r=b/'mac-sandbox-candidate'
report={}
for label,profile in [('baseline',None),('combined',r/'combined.sb')]:
 fd=os.open(r/'private-host/identity.txt',os.O_RDONLY)
 try:
  code='import os,pathlib,json; p=pathlib.Path('+repr(str(r/'shared/escape-link'))+'); s={};\ntry:s["symlinkReadAllowed"]=p.read_text().startswith("SYNTHETIC")\nexcept OSError:s["symlinkReadAllowed"]=False\ntry:s["inheritedFdReadAllowed"]=os.read('+str(fd)+',100).startswith(b"SYNTHETIC")\nexcept OSError:s["inheritedFdReadAllowed"]=False\nprint(json.dumps(s))'
  command=['/usr/bin/python3','-c',code]
  if profile:command=['/usr/bin/sandbox-exec','-f',str(profile),*command]
  x=subprocess.run(command,pass_fds=[fd],cwd=r/'shared',env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(r/'shared'),'TMPDIR':str(r/'shared')},capture_output=True,text=True,timeout=20)
  report[label]={'exit':x.returncode,'values':json.loads(x.stdout) if x.returncode==0 else None,'error':x.stderr[-1200:]}
 finally:os.close(fd)
(r/'file-access-verified.json').write_text(json.dumps(report,indent=2))
subject=b/'mac-subject-policy';rows=[json.loads(x) for x in (subject/'models/requests.private.jsonl').read_text().splitlines()]
metadata={}
for provider in ['codex','claude']:
 captured=json.dumps([x for x in rows if x['case'].startswith(provider)])
 metadata[provider]={'macVersionPresent':'26.7' in captured,'kernelVersionPresent':os.uname().release in captured,'terminalVersionPresent':'AUDIT_VERSION_123' in captured,'macUnknownPresent':'Mac OS Unknown' in captured,'darwinUnknownPresent':'Darwin unknown' in captured}
(subject/'request-metadata-summary.json').write_text(json.dumps(metadata,indent=2))
print(json.dumps({'files':report,'subjectMetadata':metadata},indent=2))
