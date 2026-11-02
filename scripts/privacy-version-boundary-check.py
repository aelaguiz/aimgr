#!/usr/bin/env python3
"""Intentional native-tool checks for an OFFSITE version-policy decision.

Run through the real client's Bash tool, not as a substitute for that client.
The disposable scripts represent downloaded code; they never contact a service.
This proves only the named updater layouts. Admission, all actual updater
callers, dynamic path resolution and package lifetime need separate tests.
"""
import json
import os
from pathlib import Path
import platform
import subprocess

base = Path('/opt/aimgr-state-audit')
if not (base / 'OFFSITE_AUDIT_HOST').is_file() or os.geteuid() == 0:
    raise RuntimeError('Marked offsite host and unprivileged tool required')
import tempfile
root = Path(tempfile.mkdtemp(prefix='version-boundary-fixture-', dir=base / 'claude-implementation'))
records = []


def attempt(name, argv, marker, denied):
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=20)
        result = completed.returncode
    except PermissionError:
        result = 'permission-denied'
    ran = marker.exists()
    records.append({'name': name, 'exit': result, 'markerExecuted': ran,
                    'expectedDenied': denied,
                    'passed': (not ran and result != 0) if denied else (ran and result == 0)})
    if ran:
        marker.unlink()


layouts = [
    'home/.local/share/claude/versions/unknown',
    'home/.cache/claude/staging/unknown',
    'alternative-data/claude/versions/unknown',
    'alternative-cache/claude/staging/unknown',
    'npm/node_modules/@anthropic-ai/claude-code/unknown',
]
for index, layout in enumerate(layouts):
    path = root / layout
    path.mkdir(parents=True)
    marker = root / ('executed-' + str(index))
    script = path / 'claude'
    script.write_text('#!/bin/sh\n: > ' + str(marker) + '\n')
    script.chmod(0o700)
    python = path / 'cli.py'
    python.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
    attempt(layout + ':direct', [str(script)], marker, True)
    attempt(layout + ':shell', ['/bin/sh', str(script)], marker, True)
    attempt(layout + ':interpreter', ['/usr/bin/python3', str(python)], marker, True)
    alias = root / ('alias-' + str(index))
    alias.symlink_to(script)
    attempt(layout + ':symlink', [str(alias)], marker, True)

# A policy that blocks all native tools also blocks the bad markers, so prove
# that ordinary scripts and newly compiled project programs still execute.
marker = root / 'project-marker'
script = root / 'project-script'
script.write_text('#!/bin/sh\n: > ' + str(marker) + '\n')
script.chmod(0o700)
attempt('ordinary-project-script', [str(script)], marker, False)
source = root / 'project.c'
source.write_text('#include <stdio.h>\nint main(void){FILE *f=fopen(' + json.dumps(str(marker)) + ',"w");if(!f)return 1;return fclose(f);}\n')
compiler = '/usr/bin/cc'
binary = root / 'project-build'
build = subprocess.run([compiler, str(source), '-o', str(binary)], capture_output=True, text=True, timeout=30)
records.append({'name': 'native-project-build', 'exit': build.returncode, 'passed': build.returncode == 0})
if build.returncode == 0:
    attempt('native-project-run', [str(binary)], marker, False)
if platform.system() == 'Linux':
    privileged = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/id', '-u'], capture_output=True, text=True, timeout=10)
    records.append({'name': 'nested-fixed-privileged-helper', 'exit': privileged.returncode,
                    'passed': privileged.returncode == 0 and privileged.stdout.strip() == '0'})
_aim_probe_result = {'platform': platform.system(),
                     'processPolicy': Path('/proc/self/attr/current').read_text().strip() if platform.system() == 'Linux' else None,
                     'checks': records,
                     'decisionFixturePassed': all(record['passed'] for record in records)}
(root / 'observations.json').write_text(json.dumps(_aim_probe_result, indent=2) + '\n')
