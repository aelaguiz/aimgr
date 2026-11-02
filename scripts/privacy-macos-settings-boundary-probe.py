#!/usr/bin/env python3
"""Paired, offsite-only negative controls for the Mac doctor sandbox.

No vendor executable or real credentials are used here. Apply the same policy
inside a preloaded child, then compare file, network, exec and service access
with an unsandboxed synthetic baseline. Native doctor tests remain separate.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import socket
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
p.add_argument('--policy', type=Path, required=True)
p.add_argument('--policy-module', type=Path, help='Generate the policy through the actual handoff component')
p.add_argument('--node', type=Path)
a = p.parse_args()
base = Path('/opt/aimgr-state-audit')
root = a.root.resolve()
if (platform.system() != 'Darwin' or os.geteuid() == 0
        or not (base / 'OFFSITE_AUDIT_HOST').is_file()
        or root.parent != base / 'claude-implementation' or root.exists()
        or a.policy.resolve().parent != root.parent):
    raise SystemExit('Fresh unprivileged rented-Mac fixture required')
os.umask(0o077)
root.mkdir()
allowed = root / 'allowed'
allowed.mkdir()
secret = root / 'hidden-canary'
secret.write_text('SYNTHETIC_PRIVATE_CANARY')
(allowed / 'escape-link').symlink_to(secret)
(root / 'input.json').write_text('SYNTHETIC_SETTINGS')
if a.policy_module:
    if (a.policy_module.resolve().parent != root.parent / 'repo/src/privacy'
            or not a.node or a.node.resolve().parent != root.parent / 'node-v22.16.0-darwin-arm64/bin'):
        raise SystemExit('Only this fixture checkout and Node runtime are supported')
    generate = '''import fs from "node:fs";
import {pathToFileURL} from "node:url";
const {claudeMacSettingsValidationPolicy} = await import(pathToFileURL(process.argv[1]));
fs.writeFileSync(process.argv[5],claudeMacSettingsValidationPolicy({vendor:process.argv[2],settingsFile:process.argv[3],scratch:process.argv[4]}));'''
    subprocess.run([str(a.node), '--input-type=module', '-e', generate, str(a.policy_module),
                    str(base / 'bin/claude'), str(root / 'input.json'), str(allowed), str(a.policy)], check=True)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(4)
# The first Python-in-fork attempt was killed by denied demand paging of the
# CLT interpreter outside the policy's allowed runtime paths. Use a small native
# probe stored in the allowed fixture root; do not widen the policy for Python.
probe = allowed / 'boundary-probe'
subprocess.run(['/usr/bin/cc', '-Wall', '-Wextra', '-Wno-deprecated-declarations',
                '-o', str(probe), str(Path(__file__).with_suffix('.c')), '-lsandbox'], check=True)
reports = {}
for label in ['baseline', 'restricted']:
    (root / 'input.json').write_text('SYNTHETIC_SETTINGS')
    child = subprocess.run([str(probe), str(allowed), str(root), str(a.policy),
                            str(listener.getsockname()[1]), label],
                           capture_output=True, text=True, timeout=10)
    if child.returncode != 0:
        raise SystemExit('Boundary probe child failed: ' + str(child.returncode))
    reports[label] = json.loads(child.stdout)
listener.close()
b, r = reports['baseline'], reports['restricted']
checks = ['privateRead', 'symlinkRead', 'privateWrite', 'networkConnect', 'shellExec',
          'inputWrite', 'inputReplace', 'inputRename', 'inputUnlink']
passed = (all(b[k] and not r[k] for k in checks) and b['allowedReadWrite'] and r['allowedReadWrite']
          and b['inputRead'] and r['inputRead']
          and (root / 'input.json').read_text() == 'SYNTHETIC_SETTINGS'
          and all(b['serviceLookup'].values()) and not any(r['serviceLookup'].values()))
report = {'platform': platform.system(), 'comparisons': reports, 'passed': passed,
          'meaning': 'Synthetic policy boundary controls; final launcher must also close inherited descriptors'}
(root / 'observations.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
raise SystemExit(0 if passed else 1)
