#!/usr/bin/env python3
"""Actual privileged Codex installer, synthetic never-executed vendor images.

The runtime destination is disposable. Existing local policy is already the
test host's required policy; activation must preserve its exact bytes. No
normal-use approval is granted to any real Codex executable.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

repo = Path(__file__).resolve().parents[2]
base = Path('/opt/aimgr-state-audit')
assert os.getuid() == 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
node = sys.argv[1]
user = pwd.getpwnam('ec2-user' if platform.system() == 'Darwin' else 'aimdev')
spec = importlib.util.spec_from_file_location('installer', repo / 'scripts/install-codex-runtime.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
parent = Path(tempfile.mkdtemp(prefix='codex-install-contract-', dir=base))
parent.chmod(0o755)
runtime = parent / 'runtime'
policy_files = [Path('/etc/codex') / name for name in ('managed_config.toml', 'requirements.toml')]
policy_before = [file.read_bytes() for file in policy_files]

def bundle(name):
    directory = parent / name
    directory.mkdir()
    roles = dict(codex=('vendor', True), launcher=('launcher', True))
    roles.update({'codex-code-mode-host': ('vendor', True), 'policy.json': ('policy', False),
        'state_io.py': ('launcher', False), 'mcp_maintenance.py': ('launcher', False),
        **{file: ('launcher', True) for file in ('config-state', 'worktree-tool', 'process-control', 'mcp-keyring')}})
    if platform.system() == 'Darwin': roles['managed-preferences'] = ('launcher', True)
    bodies = {file: b'SYNTHETIC NEVER EXECUTE ' + name.encode() for file in roles}
    bodies['policy.json'] = json.dumps(dict(schema=1, version='0.0.0-test', settingsManifest=1,
        platform='darwin' if platform.system() == 'Darwin' else 'linux',
        arch='arm64' if platform.system() == 'Darwin' else 'x64', sourceCommit='a' * 40)).encode()
    if platform.system() == 'Darwin':
        bodies['launcher'] = (parent / 'signed-launcher').read_bytes()
        bodies['managed-preferences'] = (parent / 'managed-preferences').read_bytes()
    files = {}
    for file, (role, executable) in roles.items():
        (directory / file).write_bytes(bodies[file])
        files[file] = dict(role=role, executable=executable, size=len(bodies[file]), sha256=hashlib.sha256(bodies[file]).hexdigest())
    manifest = dict(schema=1, platform='darwin' if platform.system() == 'Darwin' else 'linux',
        arch='arm64' if platform.system() == 'Darwin' else 'x64', version='0.0.0-test', privacyAbi='codex-privacy-v1',
        entrypoint='codex', launcher='launcher', policy='policy.json', codeModeHost='codex-code-mode-host',
        stateIO='state_io.py', mcpMaintenance='mcp_maintenance.py', mcpKeyring='mcp-keyring',
        configState='config-state', worktreeTool='worktree-tool', processControl='process-control',
        reviewedAimRevision='a' * 40, files=files,
        approval=dict(kind='normal-use', approver='SYNTHETIC FIXTURE ONLY', reference='Never-executed synthetic vendor',
                      reviewEvidence='No real vendor approved', approvedAt='2026-11-04T00:00:00Z'))
    if platform.system() == 'Darwin': manifest['managedPreferences'] = 'managed-preferences'
    (directory / 'approval.json').write_text(json.dumps(manifest))
    return directory

def install(directory, activate=True, destination=runtime, clone=False):
    return installer.install(directory, node, user, activate, destination, clone)

try:
    if platform.system() == 'Darwin':
        source = parent / 'launcher.c'
        source.write_text('int main(void){return 77;}\n')
        subprocess.run(['/usr/bin/clang', str(source), '-o', str(parent / 'signed-launcher')], check=True, capture_output=True)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', str(parent / 'signed-launcher')], check=True, capture_output=True)
        subprocess.run(['/usr/bin/clang', str(repo / 'native/codex/managed_preferences.m'), '-framework', 'Foundation',
                        '-o', str(parent / 'managed-preferences')], check=True, capture_output=True)
    first = bundle('first')
    install(first, False)
    assert not (runtime / 'active.json').exists() and not (runtime / 'environment.json').exists()
    with patch.object(installer.common, 'stopped_accounts', side_effect=AssertionError('global stop forbidden')), \
         patch.object(installer.common, 'reclaim_stopped_linux_profiles', side_effect=AssertionError('live unload forbidden')):
        old = install(first)
        anchor = (runtime / 'environment.json').read_bytes()
        assert install(first) == old and (runtime / 'environment.json').read_bytes() == anchor
        second = bundle('second')
        newer = install(second)
        assert newer['artifactSet'] != old['artifactSet'] and (runtime / 'environment.json').read_bytes() == anchor
        assert (runtime / 'artifacts' / old['artifactSet'] / 'codex').is_file()
    assert [file.read_bytes() for file in policy_files] == policy_before
    print('PASS staged/activated install, no proxy dependency, stable local identity and old runtime retention', flush=True)
    clone_root = parent / 'cloned-runtime'
    shutil.copytree(runtime, clone_root)
    for file in (clone_root / 'users' / str(user.pw_uid)).iterdir(): os.chown(file, user.pw_uid, user.pw_gid)
    install(second, destination=clone_root, clone=True)
    assert (clone_root / 'environment.json').read_bytes() != anchor
    assert (runtime / 'environment.json').read_bytes() == anchor
    print('PASS destination clone gets a fresh local identity while the source stays unchanged', flush=True)
    previous = (runtime / 'active.json').read_bytes()
    invalid = bundle('invalid')
    manifest = json.loads((invalid / 'approval.json').read_text())
    manifest['approval'].update(kind='offsite-test', normalUseApproved=False)
    (invalid / 'approval.json').write_text(json.dumps(manifest))
    try: install(invalid)
    except RuntimeError as error: assert 'normal-use' in str(error)
    else: raise AssertionError('test-only bundle accepted')
    assert (runtime / 'active.json').read_bytes() == previous
    invalid = bundle('changed')
    (invalid / 'codex-code-mode-host').write_text('CHANGED')
    try: install(invalid)
    except RuntimeError as error: assert 'approved bytes changed' in str(error)
    else: raise AssertionError('changed helper accepted')
    assert (runtime / 'active.json').read_bytes() == previous
    print('PASS test-only and changed helper bundles refuse without replacing the selected runtime', flush=True)
    print(json.dumps(dict(platform=platform.system(), realVendorExecuted=False, realRuntimeChanged=False)))
finally:
    shutil.rmtree(parent)
