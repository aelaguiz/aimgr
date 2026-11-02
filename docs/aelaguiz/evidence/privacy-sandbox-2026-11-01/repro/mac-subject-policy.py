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
b=Path('/opt/aimgr-state-audit');r=b/'mac-subject-policy';r.mkdir(mode=0o700)
attrs=(b/'mac-sandbox-verified/attributes-only.sb').read_text().split('(allow default)\n')[1]
policy='(version 1)\n(allow default)\n(with-filter (require-any (signing-identifier "codex") (signing-identifier "com.anthropic.claude-code"))\n'+attrs+'(deny syscall-unix (syscall-number SYS_gethostuuid))\n(deny syscall-mig (kernel-mig-routine host_kernel_version))\n(deny process-exec (literal "/usr/bin/sw_vers"))\n)\n'
p=r/'subject.sb';p.write_text(policy)
report={}
for name,cmd in [('load',['/usr/bin/true']),('python',['/usr/bin/python3','-c','import subprocess;print(subprocess.check_output(["/usr/bin/sw_vers","-productVersion"],text=True))']),('codexVersion',[str(b/'bin/codex'),'--version']),('claudeVersion',[str(b/'bin/claude'),'--version'])]:
 env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(r),'CODEX_HOME':str(r/'codex-version'),'CLAUDE_CONFIG_DIR':str(r/'claude-version'),'DISABLE_AUTOUPDATER':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'}
 x=subprocess.run(['/usr/bin/sandbox-exec','-f',str(p),*cmd],env=env,capture_output=True,text=True,timeout=20)
 report[name]={'exit':x.returncode,'stdout':x.stdout,'stderr':x.stderr[:1800]}
if all(v['exit']==0 for v in report.values()):
 x=subprocess.run(['/usr/bin/python3',str(b/'audit.py'),'--root',str(r/'models'),'--codex',str(b/'bin/codex'),'--claude',str(b/'bin/claude'),'--fresh-only','--exercise-tools','--private-claude-temp','--sandbox-profile',str(p)],capture_output=True,text=True,timeout=110)
 (r/'models.private.json').write_text(json.dumps({'exit':x.returncode,'stdout':x.stdout,'stderr':x.stderr}))
 s=json.loads((r/'models/summary.json').read_text());s['results']=[{k:v for k,v in x.items() if k not in ['filesBefore','filesAfter','identifierHashes','diskIdentifierHash']} for x in s['results']];report['workflow']={'harnessExit':x.returncode,'summary':s}
(r/'public-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
# Read only this installed tool's manpage; no broad filesystem search.
x=subprocess.run(['/usr/bin/man','xcrun'],env={'PATH':'/usr/bin:/bin','MANPAGER':'cat','PAGER':'cat','TERM':'dumb'},capture_output=True,text=True,timeout=10)
(r/'xcrun-man.private.txt').write_text(x.stdout)
print('\n'.join(line for line in x.stdout.splitlines() if 'cache' in line.lower() or 'XCRUN' in line))
