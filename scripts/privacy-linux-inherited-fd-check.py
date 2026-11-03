#!/usr/bin/env python3
"""Observe a deliberately inherited canary FD in the actual native vendor.

Run as the disposable user inside a loopback-only PID/network namespace. The
existing policy fixture supplies synthetic model traffic and checks exact vendor
bytes. A root observer reads only descriptor targets for that exact executable;
it does not inject code or replace the admitted helper. This distinguishes the
final vendor handoff from the separate settings-validator FD test.
"""
import hashlib
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
observer = '''import json,os,sys
from pathlib import Path
rows=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if os.readlink(p/'exe')!=sys.argv[1]:continue
  try:target=os.readlink(p/'fd/200')
  except FileNotFoundError:target=None
  rows.append({'pid':int(p.name),'canaryFdOpen':target==sys.argv[2]})
 except (FileNotFoundError,PermissionError):continue
print(json.dumps(rows))
'''
instrument = '''
def observe_inherited_fd():
    result=subprocess.run(['sudo','-n','/usr/bin/python3','-I','-c',FD_OBSERVER,
                           str(a.claude.resolve()),str(root/'inherited-canary')],
                          check=True,capture_output=True,text=True)
    rows=json.loads(result.stdout)
    assert len(rows)==1, 'Expected exactly one real vendor at request boundary'
    with (root/'fd-observations.jsonl').open('a') as f:
        f.write(json.dumps(rows[0])+'\\n')
'''
source = source.replace('class Mock(http.server.BaseHTTPRequestHandler):',
                        'FD_OBSERVER = ' + repr(observer) + '\n' + instrument +
                        '\nclass Mock(http.server.BaseHTTPRequestHandler):', 1)
needle = '        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))'
assert source.count(needle) == 1
source = source.replace(needle, needle + '\n        observe_inherited_fd()', 1)
needle = '    child = subprocess.Popen(argv, env=env, cwd=project, stdin=subprocess.DEVNULL,'
assert source.count(needle) == 1
source = source.replace(needle, '''    canary=root/'inherited-canary'
    canary.write_text('SYNTHETIC_INHERITED_DESCRIPTOR_CANARY')
    original=os.open(canary,os.O_RDONLY)
    os.dup2(original,200,inheritable=True);os.close(original)
''' + needle, 1)
source = source.replace('pass_fds=(environment_transfer.fileno(),) if environment_transfer else ())',
                        'pass_fds=((environment_transfer.fileno(),200) if environment_transfer else (200,)))\n    os.close(200)', 1)
fixture = root / 'policy-fd.private.py'
fixture.write_text(source)
rows = []
for mode in ['baseline', 'ordinary', 'protected']:
    target = work / (name + '_' + mode)
    args = ['python3', str(fixture), '--root', str(target), '--claude', str(package / 'claude'),
            '--case', 'privacy-overlay']
    if mode != 'baseline':
        args += ['--approved-linux-launcher', str(package / 'launcher'), '--privacy-mode', mode]
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    (root / (mode + '.stdout.private.txt')).write_text(result.stdout)
    (root / (mode + '.stderr.private.txt')).write_text(result.stderr)
    assert result.returncode == 0, 'Native fixture failed: ' + mode
    observations = json.loads(result.stdout)['results'][0]
    assert observations['exit'] == 0 and observations['modelRequests'] > 0
    fds = [json.loads(line) for line in (target / 'fd-observations.jsonl').read_text().splitlines()]
    assert fds and all(row['canaryFdOpen'] == (mode == 'baseline') for row in fds)
    rows.append({'mode': mode, 'modelRequests': observations['modelRequests'],
                 'inheritedCanaryOpenAtEveryRequest': all(row['canaryFdOpen'] for row in fds),
                 'passed': True})
report = {'artifactSet': installed['artifactSet'], 'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
          'passed': True, 'results': rows}
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
