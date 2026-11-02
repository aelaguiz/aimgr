#!/usr/bin/env python3
"""Actual native entry -> Bash -> fresh account entry and isolated validation.
Only synthetic accounts/loopback collectors on the marked offsite machines.
"""
import argparse,json,os,platform,re,socket,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--run-name',required=True);p.add_argument('--only-validator',action='store_true');a=p.parse_args()
assert re.fullmatch('[a-z0-9-]{1,48}',a.run_name)
work=Path('/opt/aimgr-state-audit/claude-implementation')
assert os.getuid()!=0 and (work.parent/'OFFSITE_AUDIT_HOST').is_file()
mac=platform.system()=='Darwin'
assert mac or sorted(name for _,name in socket.if_nameindex())==['lo']
installed=json.loads((work/('mac-candidate-staging/installed.json' if mac else 'linux-candidate-staging/installed.json')).read_text())
package=Path(installed['root']); mode='--approved-mac-launcher' if mac else '--approved-linux-launcher'
root=work/a.run_name;root.mkdir(mode=0o700)
node=str(work/'node-v22.16.0-darwin-arm64/bin/node') if mac else '/usr/local/bin/node'
check=work/(a.run_name+'-nested.py')
check.write_text('from pathlib import Path\nimport json,subprocess\nwork=Path('+repr(str(work))+')\n'+
 'node='+repr(node)+'\npackage=Path('+repr(str(package))+')\nmode='+repr(mode)+'\nname='+repr(a.run_name)+'\nonly_validator='+repr(a.only_validator)+'\n'+'''
validation=subprocess.run([node,str(work/'repo/scripts/privacy-managed-validator-check.mjs'),'--machine-only'],capture_output=True,text=True,timeout=35)
validation_result=json.loads(validation.stdout) if validation.returncode==0 else {'fixtureExit':validation.returncode}
rows=[]
for target in ([] if only_validator else ['a','b']):
 args=['/usr/bin/python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),'--root',str(work/(name+'-child-'+target)),'--claude',str(package/'claude'),mode,str(package/'launcher'),'--case','privacy-overlay','--file-canary',str(work/('hidden-canary-'+target)),'--read-root',str(work/'hidden-canary-b')]
 result=subprocess.run(args,capture_output=True,text=True,timeout=45)
 (work/(name+'-child-'+target+'.private.txt')).write_text(result.stdout+result.stderr)
 rows.append(json.loads(result.stdout)['results'][0] if result.returncode==0 else {'fixtureExit':result.returncode})
_aim_probe_result={'validation':validation_result,'nested':rows}
''')
args=['/usr/bin/python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),'--root',str(work/(a.run_name+'-parent')),'--claude',str(package/'claude'),mode,str(package/'launcher'),'--case','privacy-overlay','--file-canary',str(work/'hidden-canary-a'),'--tool-check',str(check)]
result=subprocess.run(args,capture_output=True,text=True,timeout=125)
(root/'output.private.txt').write_text(result.stdout+result.stderr)
parent=json.loads(result.stdout)['results'][0] if result.returncode==0 else {'fixtureExit':result.returncode}
inner=(parent.get('toolEnvironment') or {}).get('nativeToolCheck') or {}
children=inner.get('nested',[])
report={'platform':platform.system(),'artifactSet':installed['artifactSet'],'parent':parent,
 'scope':'Native entry plus nested native validation/account file grants; full AIM route/scheduler integration remains separate'}
report['passed']=(parent.get('exit')==0 and parent.get('nativeReadError') is True and parent.get('nativeReadReturnedCanary') is False
 and inner.get('validation',{}).get('accepted') is True and len(children)==(0 if a.only_validator else 2) and all(row.get('exit')==0 for row in children)
 and (a.only_validator or (children[0].get('nativeReadReturnedCanary') is False and children[1].get('nativeReadReturnedCanary') is True))
 and all((row.get('toolEnvironment') or {}).get('toolUnameMatchesHost') is True for row in [parent,*children]))
(root/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
raise SystemExit(0 if report['passed'] else 1)
