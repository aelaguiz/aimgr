#!/usr/bin/env python3
"""Build/install a bounded offsite candidate; never grants normal-use approval.

Invoke only on the designated isolated test host. It has no download path and
never executes the vendor. Root-owned host authorization stays outside bundles.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import secrets
import shutil
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--user', required=True)
parser.add_argument('--node', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
base = Path('/opt/aimgr-state-audit')
runtime = Path('/opt/aimgr-codex-runtime')
system = platform.system()
assert os.geteuid() == 0 and (base / 'OFFSITE_AUDIT_HOST').is_file(), 'designated offsite host required'
user = pwd.getpwnam(args.user)
assert user.pw_uid != 0
assert system in ('Linux', 'Darwin')
vendor, helper = base / 'bin/codex', base / 'bin/codex-code-mode-host'
def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

# Record the complete actual source inputs in this checkout, rather than the
# checksum of whichever incremental transfer happened to arrive last.
source_files = [repo / 'package.json', repo / 'package-lock.json']
for folder in ('src', 'native', 'scripts'):
    source_files.extend(file for file in (repo / folder).rglob('*') if file.is_file()
        and not file.is_symlink() and not any(part in ('target', '__pycache__', 'node_modules') for part in file.relative_to(repo).parts))
source_inventory = [[str(file.relative_to(repo)), digest(file)] for file in sorted(set(source_files))]
source_sha256 = hashlib.sha256(json.dumps(source_inventory, separators=(',', ':')).encode()).hexdigest()

if system == 'Linux':
    assert digest(vendor) == '1f389f19de064430a227a50af2bfa627699be4c600f1a37c114039fdd027b75b'
    assert digest(helper) == 'd01f7a656bd2a54b26fd99131f252c7371e2e890f3713c5dd977676b54bfb3bf'
else:
    raise RuntimeError('Mac candidate hash inventory must be verified on the isolated Mac before enabling installation')

runtime.mkdir(mode=0o755, exist_ok=True)
assert runtime.lstat().st_uid == 0 and not runtime.is_symlink() and runtime.stat().st_mode & 0o022 == 0
(runtime / 'artifacts').mkdir(mode=0o755, exist_ok=True)
def atomic(file, value, mode=0o644):
    temporary = file.with_name(file.name + '.' + secrets.token_hex(12))
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    with os.fdopen(fd, 'w') as stream:
        stream.write(json.dumps(value, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

with tempfile.TemporaryDirectory(prefix='.candidate-', dir=runtime) as directory:
    stage = Path(directory)
    subprocess.run(['cc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
        str(repo / 'native/codex/approved_launch_linux.c'), '-o', str(stage / 'launcher')], check=True)
    atomic(stage / 'policy.json', {'schema': 1, 'platform': 'linux', 'arch': 'x64', 'version': '0.163.0-alpha.5',
        'sourceCommit': '54201ea65a3501d09a87c776376a0c16aa39db70', 'settingsManifest': 1,
        'candidateSourceSha256': source_sha256})
    entries = {'codex': (vendor, 'vendor', True), 'codex-code-mode-host': (helper, 'vendor', True),
        'launcher': (stage / 'launcher', 'launcher', True), 'state_io.py': (repo / 'native/codex/state_io.py', 'launcher', False),
        'mcp-keyring': (repo / 'native/codex/mcp-keyring/target/release/aimgr-codex-mcp-keyring', 'launcher', True),
        'policy.json': (stage / 'policy.json', 'policy', False)}
    files = {name: {'sha256': digest(file), 'size': file.stat().st_size, 'executable': executable, 'role': role}
        for name, (file, role, executable) in entries.items()}
    inventory = [[name, files[name]['sha256'], files[name]['size'], files[name]['executable'], files[name]['role']] for name in sorted(files)]
    artifact = hashlib.sha256(json.dumps(inventory, separators=(',', ':')).encode()).hexdigest()
    target = runtime / 'artifacts' / artifact
    assert not target.exists(), 'candidate is already installed; do not replace immutable bytes'
    target.mkdir(mode=0o755)
    for name, (file, _, executable) in entries.items():
        with file.open('rb') as inp, (target / name).open('xb') as out:
            shutil.copyfileobj(inp, out)
            out.flush()
            os.fsync(out.fileno())
        (target / name).chmod(0o4755 if name == 'launcher' else 0o755 if executable else 0o644)
    atomic(target / 'approval.json', {'schema': 1, 'platform': 'linux', 'arch': 'x64', 'version': '0.163.0-alpha.5',
        'privacyAbi': 'codex-privacy-v1', 'candidateSourceSha256': source_sha256,
        'entrypoint': 'codex', 'codeModeHost': 'codex-code-mode-host', 'launcher': 'launcher', 'stateIO': 'state_io.py',
        'mcpKeyring': 'mcp-keyring',
        'policy': 'policy.json', 'files': files, 'approval': {'kind': 'offsite-test', 'normalUseApproved': False,
        'reference': 'Amir authorized isolated Codex milestone 1 implementation and testing'}})
    host_file = base / 'CODEX_TEST_HOST.json'
    if not host_file.exists(): atomic(host_file, {'schema': 1, 'token': secrets.token_hex(32)})
    host = json.loads(host_file.read_text())
    now = datetime.datetime.now(datetime.timezone.utc)
    atomic(runtime / 'offsite-test.json', {'schema': 1, 'artifactSet': artifact, 'platform': 'linux', 'arch': 'x64',
        'normalUseApproved': False, 'hostTokenSha256': hashlib.sha256(host['token'].encode()).hexdigest(),
        'authorizedAt': now.isoformat(), 'expiresAt': (now + datetime.timedelta(days=2)).isoformat(),
        'reference': 'Designated isolated implementation VM; synthetic fixtures and assigned test accounts only'})
    if not (runtime / 'environment.json').exists(): atomic(runtime / 'environment.json', {'schema': 1, 'id': str(uuid.uuid4())})
    if not (runtime / 'policy.lock').exists(): atomic(runtime / 'policy.lock', {})
    atomic(runtime / 'active.json', {'schema': 1, 'artifactSet': artifact})
    module = (repo / 'src/privacy/codex-artifacts.js').as_uri()
    script = 'const {admitCodexArtifact}=await import(process.argv[1]);admitCodexArtifact();'
    result = subprocess.run(['/usr/bin/sudo', '-n', '-u', user.pw_name, args.node, '--input-type=module', '-e', script, module], capture_output=True, text=True)
    assert result.returncode == 0, 'candidate did not pass ordinary-user admission'
print(json.dumps({'artifactSet': artifact, 'testOnly': True, 'normalUseApproved': False}))
