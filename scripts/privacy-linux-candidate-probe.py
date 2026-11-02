#!/usr/bin/env python3
"""Native candidate integration on the marked loopback-only Linux fixture."""
import json
import os
from pathlib import Path
import platform
import socket
import subprocess

base = Path('/opt/aimgr-state-audit')
work = base / 'claude-implementation'
assert platform.system() == 'Linux' and os.getuid() != 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
assert sorted(n for _, n in socket.if_nameindex()) == ['lo']
installed = json.loads((work / 'linux-candidate-staging/installed.json').read_text())
package = Path(installed['root'])
probe = work / 'repo/scripts/privacy-claude-policy-probe.py'
root = work / 'linux-candidate-boundary-v2'
root.mkdir(mode=0o700)
for label in ['a', 'b']:
    canary = work / ('hidden-canary-' + label)
    if not canary.exists():
        canary.write_text('SYNTHETIC_FILE_CANARY')
        canary.chmod(0o600)
    assert canary.read_text() == 'SYNTHETIC_FILE_CANARY'

def model(label, mode, check=None):
    args = ['python3', str(probe), '--root', str(work / ('linux-candidate-' + label)), '--claude', str(package / 'claude'),
            '--approved-linux-launcher', str(package / 'launcher'), '--privacy-mode', mode,
            '--case', 'privacy-overlay', '--file-canary', str(work / 'hidden-canary-b')]
    if check:
        args += ['--tool-check', str(check)]
    run = subprocess.run(args, capture_output=True, text=True, timeout=125)
    (root / (label + '.private.txt')).write_text(run.stdout + run.stderr)
    return json.loads(run.stdout)['results'][0] if run.returncode == 0 else {'fixtureExit': run.returncode}

check = work / 'linux-candidate-nested-check-v2.py'
check.write_text('''import json,os,subprocess
from pathlib import Path
work=Path('/opt/aimgr-state-audit/claude-implementation')
package=Path(''' + repr(str(package)) + ''')
home=work/'linux-candidate-protected-boundary-v2/privacy-overlay'
snapshot=home/'overlay-0.json'
original=snapshot.read_bytes()
blocked={}
for name,action in [('overwrite',lambda:snapshot.write_text('changed')),('unlink',lambda:snapshot.unlink()),('rename',lambda:snapshot.rename(snapshot.with_suffix('.moved'))),('hardlink',lambda:os.link(snapshot,home/'snapshot-alias'))]:
 try:action();blocked[name]=False
 except PermissionError:blocked[name]=True
try:home.rename(home.with_name('moved-fixture'));blocked['parentRename']=False
except PermissionError:blocked['parentRename']=True
blocked['bytesPreserved']=snapshot.read_bytes()==original
try:(home/'unapproved-update'/'new-executable').write_text('unapproved');blocked['updateWrite']=False
except PermissionError:blocked['updateWrite']=True
sudo=subprocess.run(['sudo','-n','true'],capture_output=True,text=True,timeout=10)
rows=[]
for target in ['a','b']:
 args=['python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),'--root',str(work/('linux-candidate-nested-'+target+'-v2')),'--claude',str(package/'claude'),'--case','privacy-overlay','--approved-linux-launcher',str(package/'launcher'),'--file-canary',str(work/('hidden-canary-'+target)),'--read-root',str(work/'hidden-canary-b')]
 result=subprocess.run(args,capture_output=True,text=True,timeout=45)
 (work/('linux-candidate-nested-'+target+'-v2.private.txt')).write_text(result.stdout+result.stderr)
 rows.append(json.loads(result.stdout)['results'][0] if result.returncode==0 else {'fixtureExit':result.returncode})
result={'blocked':blocked,'nested':rows,'nestedSudoExit':sudo.returncode}
(work/'linux-candidate-boundary-v2/nested.json').write_text(json.dumps(result,indent=2)+'\\n')
print(json.dumps(result))
''')
report = {'artifactSet': installed['artifactSet'], 'scope': 'Native candidate only; not full AIM workflow acceptance'}
report['ordinary'] = model('ordinary-boundary-v2', 'ordinary')
report['protected'] = model('protected-boundary-v2', 'protected', check)
if (root / 'nested.json').exists():
    report['nested'] = json.loads((root / 'nested.json').read_text())
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
