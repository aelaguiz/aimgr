#!/usr/bin/env python3
"""Offsite native reentry decision; synthetic credentials, no public requests.

The fixed compiled fixture accepts only two predeclared policies and one exact
reviewed vendor. A hardened native entry must be tested because the kernel
removes the inherited Seatbelt policy before dynamic-library constructors run.
This is not full AIM launch/route integration or general sandbox acceptance.
"""
import hashlib,json,os,platform,subprocess
from pathlib import Path
base=Path('/opt/aimgr-state-audit'); work=base/'claude-implementation'
if platform.system()!='Darwin' or os.getuid()==0 or not (base/'OFFSITE_AUDIT_HOST').is_file():
 raise SystemExit('Unprivileged rented Mac required')
root=work/'reentry-native-decision';root.mkdir(mode=0o700)
vendor=base/'bin/claude'; expected='64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f'
assert hashlib.sha256(vendor.read_bytes()).hexdigest()==expected
src=work/'repo/scripts/privacy-macos-reentry-probe.c';helper=work/'reentry-native';control=root/'unhardened-entry'
for out in [control,root/'hardened-entry']:
 subprocess.run(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror',str(src),'-o',str(out)],check=True)
subprocess.run(['/usr/bin/codesign','--force','--sign','-','--options','runtime',str(root/'hardened-entry')],check=True,capture_output=True)
subprocess.run(['sudo','-n','/usr/bin/install','-o','root','-g','wheel','-m','755',str(root/'hardened-entry'),str(helper)],check=True)
marker=root/'constructor-marker';lib=root/'constructor.dylib';libsrc=root/'constructor.c'
libsrc.write_text('#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void start(void){int fd=open('+json.dumps(str(marker))+',O_WRONLY|O_CREAT,0600);if(fd>=0){write(fd,"injected",8);close(fd);}}\n')
subprocess.run(['/usr/bin/clang','-dynamiclib',str(libsrc),'-o',str(lib)],check=True)
report={'artifactSha256':expected,'constructor':{}}
for label,binary in [('unhardened-positive-control',control),('hardened-refusal',helper)]:
 policy='(version 1)(allow default)(deny file-write* (literal '+json.dumps(str(marker))+'))(allow process-exec (literal '+json.dumps(str(binary))+') (with no-sandbox))'
 code='import os,subprocess;env=dict(os.environ);env["DYLD_INSERT_LIBRARIES"]='+repr(str(lib))+';p=subprocess.run('+repr([str(binary),'bad-role','--version'])+',env=env,capture_output=True);print(p.returncode)'
 p=subprocess.run(['/usr/bin/sandbox-exec','-p',policy,'/usr/bin/python3','-c',code],capture_output=True,text=True,timeout=15)
 report['constructor'][label]={'outerExit':p.returncode,'vendorRefused':p.stdout.strip()=='125','preMainMarker':marker.exists()}
 if marker.exists():marker.unlink()
for role in ['a','b']:
 f=work/('hidden-canary-'+role)
 if f.exists():assert f.read_text()=='SYNTHETIC_FILE_CANARY'
 else:f.write_text('SYNTHETIC_FILE_CANARY')
check=work/'reentry-native-tool-check.py'
check.write_text('''import json,subprocess
from pathlib import Path
work=Path('/opt/aimgr-state-audit/claude-implementation')
rows=[]
# These B config roots do not exist when outer A enters its policy.
for target in ['a','b']:
 root=work/('reentry-native-b-read-'+target)
 p=subprocess.run(['/usr/bin/python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),
   '--root',str(root),'--claude','/opt/aimgr-state-audit/bin/claude','--case','privacy-overlay',
   '--mac-reentry-role','b','--file-canary',str(work/('hidden-canary-'+target))],capture_output=True,text=True,timeout=45)
 (work/('reentry-native-b-'+target+'.private.txt')).write_text(p.stdout+p.stderr)
 result=json.loads(p.stdout)['results'][0] if p.returncode==0 else {}
 rows.append({'readsAccount':target,'fixtureExit':p.returncode,'vendorExit':result.get('exit'),
  'nativeReadReturnedCanary':result.get('nativeReadReturnedCanary'),'nativeReadError':result.get('nativeReadError'),
  'intentionalToolRead':(result.get('toolEnvironment') or {}).get('intentionalToolRead'),
  'toolUnameMatchesHost':(result.get('toolEnvironment') or {}).get('toolUnameMatchesHost')})
_aim_probe_result=rows
''')
p=subprocess.run(['/usr/bin/python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),
 '--root',str(work/'reentry-native-a'),'--claude',str(vendor),'--case','privacy-overlay',
 '--mac-reentry-role','a','--file-canary',str(work/'hidden-canary-b'),'--tool-check',str(check)],capture_output=True,text=True,timeout=110)
(root/'native.private.txt').write_text(p.stdout+p.stderr)
report['nativeFixtureExit']=p.returncode
report['native']=json.loads(p.stdout) if p.returncode==0 else None
if report['native']:
 parent=report['native']['results'][0];children=(parent.get('toolEnvironment') or {}).get('nativeToolCheck') or []
 report['nativeReentryPassed']=parent['exit']==0 and (parent.get('toolEnvironment') or {}).get('intentionalToolRead') is True and (parent.get('toolEnvironment') or {}).get('toolUnameMatchesHost') is True and '- OS Version: Darwin unknown' in parent.get('automaticEnvironmentLines',[]) and parent.get('nativeReadReturnedCanary') is False and parent.get('nativeReadError') is True and len(children)==2 and all(c['vendorExit']==0 and c['intentionalToolRead'] is True and c['toolUnameMatchesHost'] is True for c in children) and children[0]['nativeReadReturnedCanary'] is False and children[0]['nativeReadError'] is True and children[1]['nativeReadReturnedCanary'] is True
report['constructorPassed']=report['constructor']['unhardened-positive-control']['preMainMarker'] is True and report['constructor']['hardened-refusal']['preMainMarker'] is False and all(c['vendorRefused'] and c['outerExit']==0 for c in report['constructor'].values())
report['passed']=report['constructorPassed'] and report.get('nativeReentryPassed') is True
(root/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
raise SystemExit(0 if report['passed'] else 1)
