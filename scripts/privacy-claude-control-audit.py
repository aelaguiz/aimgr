#!/usr/bin/env python3
"""Probe Claude's supported relay policy on a disposable, outbound-denied host.

This deliberately uses no personal credentials. A policy-specific refusal is
required: a missing subscription, denied network request or default-off relay
does not demonstrate that the setting works. Normal model continuity is tested
separately by privacy-state-audit.py under the same managed policy.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess

p=argparse.ArgumentParser()
p.add_argument('--root',required=True)
p.add_argument('--claude',required=True)
a=p.parse_args()
root=Path(a.root).resolve()
if not Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file() or not str(root).startswith('/opt/aimgr-state-audit/'):
    raise SystemExit('Disposable-host marker and isolated root required')
if root.exists() and any(root.iterdir()):
    raise SystemExit('Refusing reused fixture root')
root.mkdir(parents=True,exist_ok=True)
os.umask(0o077)
managed=Path('/Library/Application Support/ClaudeCode/managed-settings.json' if platform.system()=='Darwin' else '/etc/claude-code/managed-settings.json')
if json.loads(managed.read_text()).get('disableRemoteControl') is not True:
    raise SystemExit('Managed disableRemoteControl policy is not installed')
home=root/'home';home.mkdir()
app=home/'.claude';app.mkdir()
# A lower-priority attempt to re-enable the feature must not beat managed policy.
(app/'settings.json').write_text('{"disableRemoteControl":false}\n')
env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'CLAUDE_CONFIG_DIR':str(app),
     'TERM':'dumb','DISABLE_AUTOUPDATER':'1','ANTHROPIC_API_KEY':'sk-ant-synthetic-not-real'}
cases=[('standalone',['remote-control']),('flag',['--remote-control','-p','Reply AUDIT_OK.'])]
results=[]
for name,argv in cases:
    try:
        run=subprocess.run([a.claude,*argv],env=env,cwd=root,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=20)
        output=run.stdout+run.stderr
        result={'case':name,'exitCode':run.returncode,'output':output,
                'passed':run.returncode!=0 and 'disabled' in output.lower() and 'disableRemoteControl' in output}
    except subprocess.TimeoutExpired:
        result={'case':name,'passed':False,'error':'timed out; no policy proof'}
    results.append(result)
report={'allPassed':all(x['passed'] for x in results),'results':results}
(root/'claude-control-policy.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
raise SystemExit(0 if report['allPassed'] else 1)
