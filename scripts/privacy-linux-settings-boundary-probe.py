#!/usr/bin/env python3
"""Exercise the actual validator helper without proxy or namespace privileges."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
p.add_argument('--validator', type=Path, required=True)
a = p.parse_args()
base = Path('/opt/aimgr-state-audit')
root = a.root.resolve()
if (platform.system() != 'Linux' or os.geteuid() == 0
        or not (base / 'OFFSITE_AUDIT_HOST').is_file()
        or root.parent != base / 'claude-implementation' or root.exists()
        or a.validator.resolve().parent != root.parent):
    raise SystemExit('Fresh unprivileged offsite Linux fixture required')
os.umask(0o077)
root.mkdir()
probe = root / 'boundary-probe'
subprocess.run(['/usr/bin/cc', '-O2', '-Wall', '-Wextra', '-Werror', '-o', str(probe),
                str(Path(__file__).with_suffix('.c'))], check=True)
settings = root / 'input.json'
secret = root / 'hidden-canary'
reports = {}
for label in ['baseline', 'restricted']:
    scratch = root / label
    scratch.mkdir(mode=0o700)
    settings.write_text('SYNTHETIC_SETTINGS')
    secret.write_text('SYNTHETIC_PRIVATE_CANARY')
    with secret.open('rb') as inherited:
        os.dup2(inherited.fileno(), 9)
        try:
            argv = ([str(probe), '--settings', str(settings), 'doctor'] if label == 'baseline' else
                    [str(a.validator), str(probe), str(scratch), str(settings)])
            child = subprocess.run(argv, cwd=scratch, env={'PATH': '/usr/bin:/bin', 'SYNTHETIC_SECRET': 'fixture'},
                                   pass_fds=(9,), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        finally:
            os.close(9)
    if child.returncode != 0:
        raise SystemExit('Boundary probe failed: ' + str(child.returncode) + ' ' + child.stderr)
    reports[label] = json.loads(child.stdout)
b, r = reports['baseline'], reports['restricted']
denied = ['privateRead', 'privateWrite', 'symlinkRead', 'inputWrite', 'inputReplace', 'inputRename',
          'inputUnlink', 'networkSocket', 'shellExec', 'inheritedDescriptor', 'inheritedSecret']
passed = (all(b[k] and not r[k] for k in denied)
          and all(b[k] and r[k] for k in ['allowedReadWrite', 'inputRead'])
          and settings.read_text() == 'SYNTHETIC_SETTINGS'
          and secret.read_text() == 'SYNTHETIC_PRIVATE_CANARY')
report = {'platform': platform.system(), 'comparisons': reports, 'passed': passed,
          'meaning': 'File/input/network boundary, not arbitrary code-execution denial; no proxy setup or namespace privileges used'}
(root / 'observations.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
raise SystemExit(0 if passed else 1)
