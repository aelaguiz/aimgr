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
    for directory, folders, names in os.walk(repo / folder):
        folders[:] = [name for name in folders if name not in ('target', '__pycache__', 'node_modules', 'vendor', '.git')]
        source_files.extend(Path(directory) / name for name in names if (Path(directory) / name).is_file() and not (Path(directory) / name).is_symlink())
source_inventory = [[str(file.relative_to(repo)), digest(file)] for file in sorted(set(source_files))]
source_sha256 = hashlib.sha256(json.dumps(source_inventory, separators=(',', ':')).encode()).hexdigest()

if system == 'Linux':
    assert digest(vendor) == 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8'
    assert digest(helper) == '657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630'
else:
    assert digest(vendor) == '39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1'
    assert digest(helper) == 'fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a'
    for image in (vendor, helper):
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(image)], check=True, capture_output=True)

platform_name = 'linux' if system == 'Linux' else 'darwin'
architecture = 'x64' if system == 'Linux' else 'arm64'

runtime.mkdir(mode=0o755, exist_ok=True)
assert runtime.lstat().st_uid == 0 and not runtime.is_symlink() and runtime.stat().st_mode & 0o022 == 0
(runtime / 'artifacts').mkdir(mode=0o755, exist_ok=True)
(runtime / 'users').mkdir(mode=0o755, exist_ok=True)
user_runtime = runtime / 'users' / str(user.pw_uid)
user_runtime.mkdir(mode=0o755, exist_ok=True)
maintenance = user_runtime / 'maintenance'
if not maintenance.exists():
    maintenance.mkdir(mode=0o700)
    os.chown(maintenance, user.pw_uid, user.pw_gid)
assert not maintenance.is_symlink() and maintenance.stat().st_uid == user.pw_uid and maintenance.stat().st_mode & 0o077 == 0
admission = user_runtime / 'admission.lock'
try:
    fd = os.open(admission, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
except FileExistsError:
    pass
else:
    os.fchown(fd, user.pw_uid, user.pw_gid)
    os.fsync(fd)
    os.close(fd)
assert not admission.is_symlink() and admission.stat().st_uid == user.pw_uid and admission.stat().st_nlink == 1 and admission.stat().st_mode & 0o077 == 0
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
        str(repo / ('native/codex/approved_launch_linux.c' if system == 'Linux' else 'native/codex/approved_launch_macos.c')), '-o', str(stage / 'launcher')], check=True)
    subprocess.run(['cc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
        str(repo / 'native/codex/process_control.c'), '-o', str(stage / 'process-control')], check=True)
    if system == 'Darwin':
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', str(stage / 'launcher')], check=True, capture_output=True)
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(repo / 'native/codex/managed_preferences.m'), '-framework', 'Foundation', '-o', str(stage / 'managed-preferences')], check=True)
    atomic(stage / 'policy.json', {'schema': 1, 'platform': platform_name, 'arch': architecture, 'version': '0.166.0',
        'sourceCommit': '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856', 'settingsManifest': 1,
        'candidateSourceSha256': source_sha256})
    entries = {'codex': (vendor, 'vendor', True), 'codex-code-mode-host': (helper, 'vendor', True),
        'launcher': (stage / 'launcher', 'launcher', True), 'state_io.py': (repo / 'native/codex/state_io.py', 'launcher', False),
        'process-control': (stage / 'process-control', 'launcher', True),
        'mcp_maintenance.py': (repo / 'native/codex/mcp_maintenance.py', 'launcher', False),
        'mcp-keyring': (repo / 'native/codex/mcp-keyring/target/release/aimgr-codex-mcp-keyring', 'launcher', True),
        'config-state': (repo / 'native/codex/config-state/target/debug/aimgr-codex-config-state', 'launcher', True),
        'worktree-tool': (repo / 'native/codex/config-state/target/debug/aimgr-codex-worktree', 'launcher', True),
        'policy.json': (stage / 'policy.json', 'policy', False)}
    if system == 'Darwin': entries['managed-preferences'] = (stage / 'managed-preferences', 'launcher', True)
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
        (target / name).chmod(0o4755 if name == 'launcher' and system == 'Linux' else 0o755 if executable else 0o644)
    atomic(target / 'approval.json', {'schema': 1, 'platform': platform_name, 'arch': architecture, 'version': '0.166.0',
        'privacyAbi': 'codex-privacy-v1', 'candidateSourceSha256': source_sha256,
        'entrypoint': 'codex', 'codeModeHost': 'codex-code-mode-host', 'launcher': 'launcher', 'stateIO': 'state_io.py',
        'mcpKeyring': 'mcp-keyring', 'mcpMaintenance': 'mcp_maintenance.py', 'configState': 'config-state', 'processControl': 'process-control',
        'worktreeTool': 'worktree-tool',
        **({'managedPreferences': 'managed-preferences'} if system == 'Darwin' else {}),
        'policy': 'policy.json', 'files': files, 'approval': {'kind': 'offsite-test', 'normalUseApproved': False,
        'reference': 'Amir authorized isolated Codex milestone 1 implementation and testing'}})
    host_file = base / 'CODEX_TEST_HOST.json'
    if not host_file.exists(): atomic(host_file, {'schema': 1, 'token': secrets.token_hex(32)})
    host = json.loads(host_file.read_text())
    now = datetime.datetime.now(datetime.timezone.utc)
    atomic(runtime / 'offsite-test.json', {'schema': 1, 'artifactSet': artifact, 'platform': platform_name, 'arch': architecture,
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
