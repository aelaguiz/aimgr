#!/usr/bin/env python3
"""Pause between production admission and native exec; attempt replacements.

The caller may replace its own selected symlink. It must not be able to replace
the admitted immutable files, selector or their ancestors. The paused invocation
must still run the admitted build, and a fresh admission of the changed symlink
must refuse. The marker image is synthetic and must never execute.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

base = Path('/opt/aimgr-state-audit')
work = base / 'claude-implementation'
assert os.getuid() != 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
name = sys.argv[1]
assert name.isidentifier()
root = work / name
root.mkdir(mode=0o700)
prefix = 'mac' if platform.system() == 'Darwin' else 'linux'
installed = json.loads((work / (prefix + '-candidate-staging/installed.json')).read_text())
package = Path(installed['root'])
node = sys.argv[2]
assert Path(node).is_absolute()
source = Path(__file__).with_name('privacy-claude-policy-probe.py').read_text()
admission = "import {admitClaudeArtifact} from 'file:///opt/aimgr-state-audit/claude-implementation/repo/src/privacy/claude-artifacts.js';console.log(JSON.stringify(admitClaudeArtifact({selectedCommand:process.argv[1]})));"
instrument = '''
def paused_admission_replacement():
    selected=root/'selected-claude'
    marker=root/'unapproved-marker'
    proof=root/'unapproved-executed'
    marker.write_text('#!/bin/sh\\nprintf unapproved > '+str(proof)+'\\n')
    marker.chmod(0o700)
    selected.symlink_to(a.claude)
    first=subprocess.run([RACE_NODE,'--input-type=module','-e',RACE_ADMISSION,str(selected)],capture_output=True,text=True,check=True)
    admitted=json.loads(first.stdout)
    assert admitted['command']==str(a.claude) and admitted['launcher']==str(approved_launcher)
    # Execution is paused here, after the real admission API has returned.
    selected.unlink();selected.symlink_to(marker)
    denied={}
    targets={'vendor':a.claude,'launcher':approved_launcher,
             'policy':Path(admitted['policy']),
             'approval':a.claude.parent/'approval.json',
             'selector':Path('/opt/aimgr-claude-runtime/active.json')}
    for label,target in targets.items():
        try:
            fd=os.open(target,os.O_WRONLY);os.close(fd);denied[label+'Write']=False
        except PermissionError:denied[label+'Write']=True
        try:
            target.rename(target.with_name(target.name+'.race-moved'));denied[label+'Rename']=False
        except PermissionError:denied[label+'Rename']=True
    for label,target in [('bundle',a.claude.parent),('artifactParent',a.claude.parent.parent)]:
        try:
            target.rename(target.with_name(target.name+'.race-moved'));denied[label+'Rename']=False
        except PermissionError:denied[label+'Rename']=True
    assert all(denied.values()),'Admitted image or ancestor is mutable by the runtime user'
    fresh=subprocess.run([RACE_NODE,'--input-type=module','-e',RACE_ADMISSION,str(selected)],capture_output=True,text=True)
    assert fresh.returncode!=0 and 'differs from the approved build' in fresh.stderr
    assert not proof.exists()
    (root/'replacement.json').write_text(json.dumps({'pausedAfterProductionAdmission':True,'selectedSymlinkChanged':True,'denied':denied,'freshAdmissionRefused':True}))
'''
source = source.replace('class Mock(http.server.BaseHTTPRequestHandler):',
                        'RACE_NODE = ' + repr(node) + '\nRACE_ADMISSION = ' + repr(admission) +
                        '\n' + instrument + '\nclass Mock(http.server.BaseHTTPRequestHandler):', 1)
needle = '    child = subprocess.Popen(argv, env=env, cwd=project, stdin=subprocess.DEVNULL,'
assert source.count(needle) == 1
source = source.replace(needle, '    paused_admission_replacement()\n' + needle, 1)
fixture = root / 'policy-race.private.py'
fixture.write_text(source)
rows = []
for mode in ['ordinary', 'protected']:
    target = work / (name + '_' + mode)
    args = ['python3', str(fixture), '--root', str(target), '--claude', str(package / 'claude'),
            '--case', 'privacy-overlay', '--approved-' + prefix + '-launcher', str(package / 'launcher'),
            '--privacy-mode', mode]
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    (root / (mode + '.stdout.private.txt')).write_text(result.stdout)
    (root / (mode + '.stderr.private.txt')).write_text(result.stderr)
    assert result.returncode == 0, 'Native fixture failed: ' + mode
    observations = json.loads(result.stdout)['results'][0]
    assert observations['exit'] == 0 and observations['modelRequests'] > 0
    assert not (target / 'unapproved-executed').exists()
    rows.append({'mode': mode, 'passed': True, 'modelRequests': observations['modelRequests'],
                 'replacement': json.loads((target / 'replacement.json').read_text())})
report = {'artifactSet': installed['artifactSet'], 'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
          'passed': True, 'results': rows}
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
