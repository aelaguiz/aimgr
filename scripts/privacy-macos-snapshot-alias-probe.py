#!/usr/bin/env python3
"""Actual-vendor snapshot alias/ancestor check, on the marked rented Mac only."""
import argparse
import json
import os
import platform
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--label', required=True, choices=['before-fix', 'after-fix'])
a = p.parse_args()
work = Path('/opt/aimgr-state-audit/claude-implementation')
assert platform.system() == 'Darwin' and os.getuid() != 0 and (work.parent / 'OFFSITE_AUDIT_HOST').is_file()
package = Path(json.loads((work / 'mac-candidate-staging/installed.json').read_text())['root'])
root = work / ('mac-snapshot-alias-' + a.label)
home = root / 'privacy-overlay'
check = work / ('mac-snapshot-alias-' + a.label + '.py')
check.write_text('''import os
from pathlib import Path
home=Path(''' + repr(str(home)) + ''')
snapshot=home/'overlay-0.json'
original=snapshot.read_bytes()
alias=home/'alias.json'
result={'hardlinkCreated':False,'aliasWriteAllowed':False,'parentRenameAllowed':False,'snapshotWriteAfterMoveAllowed':False,'restored':True}
try:
 os.link(snapshot,alias);result['hardlinkCreated']=True
 try:alias.write_bytes(original);result['aliasWriteAllowed']=True
 except PermissionError:pass
finally:
 if alias.exists():alias.unlink()
moved=home.with_name('moved-home')
try:
 try:home.rename(moved);result['parentRenameAllowed']=True
 except PermissionError:pass
 if result['parentRenameAllowed']:
  try:(moved/'overlay-0.json').write_bytes(original);result['snapshotWriteAfterMoveAllowed']=True
  except PermissionError:pass
finally:
 if moved.exists():moved.rename(home)
 result['restored']=snapshot.read_bytes()==original
_aim_probe_result=result
''')
# Catch hardlink refusal outside the inner write attempt too.
source = check.read_text().replace("finally:\n if alias.exists()", "except PermissionError:pass\nfinally:\n if alias.exists()")
compile(source, str(check), 'exec')
check.write_text(source)
run = subprocess.run(['/usr/bin/python3', str(work / 'repo/scripts/privacy-claude-policy-probe.py'),
    '--root', str(root), '--claude', str(package / 'claude'), '--case', 'privacy-overlay',
    '--approved-mac-launcher', str(package / 'launcher'), '--tool-check', str(check)],
    capture_output=True, text=True, timeout=125)
(work / ('mac-snapshot-alias-' + a.label + '.private.txt')).write_text(run.stdout + run.stderr)
result = json.loads(run.stdout)['results'][0] if run.returncode == 0 else {'fixtureExit': run.returncode}
report = {'artifactSet': package.name, 'observation': result}
print(json.dumps(report, indent=2))
(work / ('mac-snapshot-alias-' + a.label + '.json')).write_text(json.dumps(report, indent=2) + '\n')
