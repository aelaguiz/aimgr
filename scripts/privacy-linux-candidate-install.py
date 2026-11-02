#!/usr/bin/env python3
"""Install only the explicitly authorized offsite Linux decision candidate.

No active selector or normal-use approval is created. The installed setuid
helper has one fixed immutable vendor target; tests run in loopback namespaces.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

import sys
candidate_source = sys.argv[1] if len(sys.argv) == 2 else ''
assert len(candidate_source) == 64 and all(c in '0123456789abcdef' for c in candidate_source)
base = Path('/opt/aimgr-state-audit')
work = base / 'claude-implementation'
assert platform.system() == 'Linux' and os.getuid() == 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
source = work / 'repo/native/claude/approved_launch_linux.c'
vendor = base / 'bin/claude'
assert hashlib.sha256(vendor.read_bytes()).hexdigest() == 'fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824'
staging = work / 'linux-candidate-staging'
staging.mkdir(mode=0o755)
subprocess.run(['/usr/bin/gcc', '-O2', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(staging / 'launcher')], check=True)
subprocess.run(['/usr/bin/gcc', '-O2', '-Wall', '-Wextra', '-Werror', str(work / 'repo/native/claude/validate_settings_linux.c'), '-o', str(staging / 'validate-settings')], check=True)
policy = {'schema': 1, 'platform': 'linux', 'arch': 'x64', 'version': '2.1.316',
          'testedKernelRelease': os.uname().release, 'vendorCommit': 'cd7ceb459c68', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'scope': 'offsite native entry decision only; no normal-use approval'}
(staging / 'policy.json').write_text(json.dumps(policy, sort_keys=True) + '\n')
files = {}
for name, file, role in [('claude', vendor, 'vendor'), ('launcher', staging / 'launcher', 'launcher'), ('validate-settings', staging / 'validate-settings', 'launcher'), ('policy.json', staging / 'policy.json', 'policy')]:
    files[name] = {'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'size': file.stat().st_size,
                   'executable': name != 'policy.json', 'role': role}
inventory = [[name, files[name]['sha256'], files[name]['size'], files[name]['executable'], files[name]['role']] for name in sorted(files)]
artifact = hashlib.sha256(json.dumps(inventory, separators=(',', ':')).encode()).hexdigest()
manifest = {'schema': 1, 'platform': 'linux', 'arch': 'x64', 'version': '2.1.316', 'privacyAbi': 'claude-privacy-v1',
            'candidateSourceSha256': candidate_source, 'entrypoint': 'claude', 'launcher': 'launcher', 'policy': 'policy.json', 'files': files,
            'approval': {'kind': 'offsite-test', 'normalUseApproved': False,
                         'reference': 'User-authorized implementation testing on designated GCP VM only'}}
root = Path('/opt/aimgr-claude-runtime/artifacts') / artifact
root.mkdir(parents=True, mode=0o755)
for name, file in [('claude', vendor), ('launcher', staging / 'launcher'), ('validate-settings', staging / 'validate-settings'), ('policy.json', staging / 'policy.json')]:
    shutil.copyfile(file, root / name)
    os.chown(root / name, 0, 0)
    os.chmod(root / name, 0o4755 if name == 'launcher' else 0o755 if name in ['claude', 'validate-settings'] else 0o644)
(root / 'approval.json').write_text(json.dumps(manifest, indent=2) + '\n')
(root / 'approval.json').chmod(0o644)
lock = root.parent.parent / 'policy.lock'
if not lock.exists():
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    os.close(fd)
(staging / 'installed.json').write_text(json.dumps({'artifactSet': artifact, 'root': str(root), 'manifest': manifest}, indent=2) + '\n')
print(json.dumps({'artifactSet': artifact, 'root': str(root), 'testOnly': True}))
