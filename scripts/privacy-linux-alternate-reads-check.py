#!/usr/bin/env python3
"""Pair actual Claude Read calls against aliases and Linux identity sources.

Only disposable-host values reach the loopback model fixture. Reports contain
access results, not the identity values. Keep baseline failures explicit: an
unreadable DMI source is not evidence that AIM blocked a readable source.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

base = Path('/opt/aimgr-state-audit')
work = base / 'claude-implementation'
assert os.getuid() != 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
assert sorted(n for _, n in socket.if_nameindex()) == ['lo']
name = sys.argv[1]
assert name.isidentifier()
root = work / name
root.mkdir(mode=0o700)
installed = json.loads((work / 'linux-candidate-staging/installed.json').read_text())
package = Path(installed['root'])
source = Path(__file__).with_name('privacy-claude-policy-probe.py').read_text()
prepare = '''    reads=[];unavailable=[]
    canary=root/'ungranted-canary';canary.write_text('SYNTHETIC_ALTERNATE_READ_CANARY')
    alias=project/'canary-alias';alias.symlink_to(canary)
    reads += [{'id':'relative','path':os.path.relpath(canary,project),'needle':canary.read_text()},
              {'id':'symlink','path':str(alias),'needle':canary.read_text()}]
    for key,file in [('kernel-version','/proc/version'),('kernel-release','/proc/sys/kernel/osrelease'),
                     ('hostname','/proc/sys/kernel/hostname'),('dbus-machine-id','/var/lib/dbus/machine-id'),
                     ('dmi-product-uuid','/sys/class/dmi/id/product_uuid')]:
        try:value=Path(file).read_text().strip()
        except (PermissionError,FileNotFoundError) as error:
            unavailable.append({'id':key,'reason':type(error).__name__});continue
        assert value
        reads.append({'id':key,'path':file,'needle':value})
    global alternate_reads
    alternate_reads=reads
    (root/'read-expectations.private.json').write_text(json.dumps({'reads':reads,'unavailable':unavailable}))
'''
needle = '    child = subprocess.Popen(argv, env=env, cwd=project, stdin=subprocess.DEVNULL,'
assert source.count(needle) == 1
source = source.replace(needle, prepare + needle, 1)
needle = '            result = {"id": "msg_policy", "type": "message", "role": "assistant",'
assert source.count(needle) == 1
source = source.replace(needle, '''            completed_reads={c.get('tool_use_id') for m in body.get('messages',[]) for c in (m.get('content') if isinstance(m.get('content'),list) else []) if c.get('type')=='tool_result'}
            pending=next((item for item in alternate_reads if 'alternate_'+item['id'] not in completed_reads),None)
            if pending:
                finished=False
                content={'type':'tool_use','id':'alternate_'+pending['id'],'name':'Read','input':{'file_path':pending['path']}}
''' + needle, 1)
fixture = root / 'policy-reads.private.py'
fixture.write_text(source)
rows = []
for mode in ['ordinary', 'protected']:
    target = work / (name + '_' + mode)
    args = ['python3', str(fixture), '--root', str(target), '--claude', str(package / 'claude'),
            '--case', 'privacy-overlay', '--approved-linux-launcher', str(package / 'launcher'), '--privacy-mode', mode]
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    (root / (mode + '.stdout.private.txt')).write_text(result.stdout)
    (root / (mode + '.stderr.private.txt')).write_text(result.stderr)
    assert result.returncode == 0, 'Native fixture failed: ' + mode
    observations = json.loads(result.stdout)['results'][0]
    assert observations['exit'] == 0 and not observations['toolFailureObserved']
    expected = json.loads((target / 'read-expectations.private.json').read_text())
    requests = [json.loads(line) for line in (target / 'requests.private.jsonl').read_text().splitlines()]
    checks = []
    for item in expected['reads']:
        results = [c for r in requests for m in r['body'].get('messages', [])
                   for c in (m.get('content') if isinstance(m.get('content'), list) else [])
                   if c.get('type') == 'tool_result' and c.get('tool_use_id') == 'alternate_' + item['id']]
        assert results, 'No native Read result for ' + item['id']
        disclosed = any(item['needle'] in str(c.get('content')) for c in results)
        denied = any(c.get('is_error') for c in results)
        checks.append({'id': item['id'], 'valueReturned': disclosed, 'readError': denied,
                       'passed': disclosed if mode == 'ordinary' else denied and not disclosed})
    rows.append({'mode': mode, 'checks': checks, 'unavailableBeforeSandbox': expected['unavailable']})
report = {'artifactSet': installed['artifactSet'], 'results': rows,
          'passed': all(check['passed'] for row in rows for check in row['checks'])}
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
assert report['passed']
