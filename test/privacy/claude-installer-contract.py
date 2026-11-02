#!/usr/bin/env python3
"""Offsite-only installation contracts using synthetic, never-executed images.

No real vendor bytes or real normal-use approval enter this fixture. The
production installer is exercised under an isolated runtime root; the active
Claude test runtime and user accounts are not changed.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

base = Path('/opt/aimgr-state-audit')
assert os.geteuid() == 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
node = sys.argv[1]
repo = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', repo / 'scripts/install-claude-runtime.py')
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
parent = Path(tempfile.mkdtemp(prefix='claude-install-contract-', dir=base)); parent.chmod(0o755)
os.umask(0o022)
runtime = parent / 'runtime'
owner = pwd.getpwnam('ec2-user' if platform.system() == 'Darwin' else 'aimprivacy')
home = parent / 'home'; home.mkdir(mode=0o755); os.chown(home, owner.pw_uid, owner.pw_gid)
user = SimpleNamespace(pw_dir=str(home), pw_uid=owner.pw_uid, pw_gid=owner.pw_gid, pw_name=owner.pw_name)
passed = []


def bundle(name, edit=None):
    directory = parent / name; directory.mkdir()
    bodies = {'claude': b'SYNTHETIC VENDOR: MUST NEVER EXECUTE\n' + name.encode(),
              'launcher': b'SYNTHETIC LAUNCHER: MUST NEVER EXECUTE\n',
              'policy.json': json.dumps({'schema': 1, 'version': '0.0.0',
                  'platform': 'darwin' if platform.system() == 'Darwin' else 'linux',
                  'arch': 'arm64' if platform.machine() == 'arm64' else 'x64',
                  'vendorCommit': 'a' * 12, 'testedKernelRelease': os.uname().release}).encode()}
    helper = 'security' if platform.system() == 'Darwin' else 'validate-settings'
    bodies[helper] = b'SYNTHETIC HELPER: MUST NEVER EXECUTE\n'
    if platform.system() == 'Darwin':
        # codesign must see an actual hardened Mach-O. This tiny fixture is
        # compiled once and is never executed by the installer or this test.
        bodies['launcher'] = (parent / 'signed-launcher').read_bytes()
    files = {}
    for filename, body in bodies.items():
        (directory / filename).write_bytes(body)
        files[filename] = {'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body),
                           'executable': filename != 'policy.json',
                           'role': 'vendor' if filename == 'claude' else 'policy' if filename == 'policy.json'
                           else 'resource' if filename == 'security' else 'launcher'}
    manifest = {'schema': 1, 'platform': 'darwin' if platform.system() == 'Darwin' else 'linux',
                'arch': 'arm64' if platform.machine() == 'arm64' else 'x64', 'version': '0.0.0',
                'privacyAbi': 'claude-privacy-v1', 'reviewedAimRevision': 'a' * 40,
                'entrypoint': 'claude', 'launcher': 'launcher', 'policy': 'policy.json', 'files': files,
                'approval': {'kind': 'normal-use', 'approver': 'SYNTHETIC TEST ONLY',
                             'reference': 'No real vendor artifact is approved',
                             'reviewEvidence': 'Never-executed synthetic fixture', 'approvedAt': '2026-11-01T00:00:00Z'}}
    if platform.system() == 'Darwin': manifest['securityAdapter'] = 'security'
    if edit: edit(manifest)
    (directory / 'approval.json').write_text(json.dumps(manifest))
    return directory


def install(directory, activate=False):
    return installer.install(directory, node, user, activate, runtime)


def refuses(name, action, reason):
    selector = runtime / 'active.json'
    before = selector.read_bytes() if selector.exists() else None
    try: action()
    except RuntimeError as error:
        assert reason in str(error), (name, str(error))
    else: raise AssertionError(name + ' did not refuse')
    after = selector.read_bytes() if selector.exists() else None
    assert after == before, name + ' changed the active selector'
    passed.append(name)


try:
    if platform.system() == 'Darwin':
        source = parent / 'launcher.c'; source.write_text('int main(void){return 77;}\n')
        subprocess.run(['/usr/bin/clang', str(source), '-o', str(parent / 'signed-launcher')], check=True, capture_output=True)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', str(parent / 'signed-launcher')], check=True, capture_output=True)
    first = bundle('first')
    staged = install(first)
    assert staged['activated'] is False and not (runtime / 'active.json').exists()
    passed.append('staging does not activate')
    active = install(first, True)
    assert json.loads((runtime / 'active.json').read_text())['artifactSet'] == active['artifactSet']
    assert install(first, True) == active
    passed.append('explicit activation and idempotence')
    next_bundle = bundle('next')
    next_result = install(next_bundle, True)
    assert next_result['artifactSet'] != active['artifactSet']
    assert (runtime / 'artifacts' / active['artifactSet'] / 'claude').is_file()
    passed.append('old immutable artifacts retained')
    invalid = bundle('nonexecutable-helper', lambda m: m['files']['security' if platform.system() == 'Darwin' else 'validate-settings'].update(executable=False))
    refuses('nonexecutable fixed helper', lambda: install(invalid, True), 'production artifact admission')
    invalid = bundle('bad-hash'); (invalid / 'claude').write_bytes(b'changed')
    refuses('changed approved bytes', lambda: install(invalid, True), 'approved bytes changed')
    invalid = bundle('extra-file'); (invalid / 'extra').write_text('unapproved')
    refuses('unapproved extra resource', lambda: install(invalid, True), 'missing or unapproved files')
    invalid = bundle('test-only', lambda m: m['approval'].update(kind='offsite-test', normalUseApproved=False))
    refuses('test authorization cannot activate for normal use', lambda: install(invalid, True), 'normal-use approval')
    invalid = bundle('no-approval', lambda m: m['approval'].pop('approver'))
    refuses('review without human approval', lambda: install(invalid, True), 'production artifact admission')
    first_target = runtime / 'artifacts' / active['artifactSet']
    for file, mode in [(first_target / 'approval.json', 0o600), (first_target, 0o700)]:
        previous = file.stat().st_mode & 0o7777
        file.chmod(mode)
        try:
            refuses('existing bundle denies ordinary-user access: ' + file.name,
                    lambda: install(first, True), 'unreadable by the runtime user')
        finally: file.chmod(previous)
    if platform.system() == 'Darwin':
        denied = first_target / 'approval.json'
        subprocess.run(['/bin/chmod', '+a', 'user:' + owner.pw_name + ' deny read', str(denied)], check=True)
        try:
            refuses('existing Mac read-denying ACL', lambda: install(first, True), 'unreadable by the runtime user')
        finally: subprocess.run(['/bin/chmod', '-N', str(denied)], check=True)
    prior_umask = os.umask(0o077)
    try: assert install(bundle('restrictive-umask'))['activated'] is False
    finally: os.umask(prior_umask)
    passed.append('new staged bundle readable with restrictive administrator umask')
    inaccessible = bundle('inaccessible-destination')
    (runtime / 'artifacts').chmod(0o700)
    try:
        refuses('new destination under unreadable artifacts parent', lambda: install(inaccessible, True), 'unreadable by the runtime user')
    finally: (runtime / 'artifacts').chmod(0o755)
    if platform.system() == 'Darwin':
        denied = first_target / 'launcher'
        subprocess.run(['/bin/chmod', '+a', 'user:' + owner.pw_name + ' deny execute', str(denied)], check=True)
        try:
            refuses('existing Mac execution-denying ACL', lambda: install(first, True), 'unreadable by the runtime user')
        finally: subprocess.run(['/bin/chmod', '-N', str(denied)], check=True)
    config = home / '.aimgr/claude-homes/account-a/.claude'
    config.mkdir(parents=True)
    locks = home / '.aimgr/claude-egress'; locks.mkdir()
    for directory in [home / '.aimgr', home / '.aimgr/claude-homes', config.parent, config, locks]:
        os.chown(directory, owner.pw_uid, owner.pw_gid)
    lock = locks / 'account-a.json.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600); os.fchown(fd, owner.pw_uid, owner.pw_gid)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        if platform.system() == 'Linux':
            refuses('active account shared lock prevents Linux transition', lambda: install(first, True), 'stop Claude sessions')
        else:
            assert install(first, True)['activated']
            passed.append('Mac activation preserves held account session lock')
    finally: os.close(fd)
    assert install(first, True)['activated']
    passed.append('stopped account transitions after lock release')
    # A synthetic native owner outside passwd HOME proves custom-home/legacy
    # owners are noticed without examining process arguments or credentials.
    custom = parent / 'custom-home'; custom.mkdir()
    sleeper = custom / 'claude'
    if platform.system() == 'Darwin':
        # A copied Apple platform binary retains SIP process restrictions and
        # is not representative of an ordinary third-party native owner.
        source = custom / 'sleep.c'; source.write_text('#include <unistd.h>\nint main(void){sleep(30);return 0;}\n')
        subprocess.run(['/usr/bin/clang', str(source), '-o', str(sleeper)], check=True, capture_output=True)
    else: shutil.copyfile('/bin/sleep', sleeper)
    sleeper.chmod(0o755)
    child = subprocess.Popen([str(sleeper), '30'], user=owner.pw_uid, group=owner.pw_gid, start_new_session=True)
    try:
        for attempt in range(50):
            probe = subprocess.run(['/usr/bin/sudo', '-n', '-u', owner.pw_name, '/usr/bin/python3', '-I',
                                    str(repo / 'native/claude/runtime_inventory.py')], capture_output=True, text=True, check=True)
            if json.loads(probe.stdout)['processes']: break
            time.sleep(0.02)
        else: raise AssertionError('synthetic custom-home owner did not start')
        if platform.system() == 'Linux':
            refuses('custom-home native owner prevents Linux transition', lambda: install(next_bundle, True), 'owners in every home')
        else:
            assert install(next_bundle, True)['activated']
            assert child.poll() is None
            passed.append('Mac activation preserves custom-home native owner')
    finally:
        os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=5)
    if platform.system() == 'Linux':
        original = Path.read_text
        def mode(file, *args, **kwargs):
            return 'complain\n' if file == Path('/sys/module/apparmor/parameters/mode') else original(file, *args, **kwargs)
        with patch.object(Path, 'read_text', mode):
            refuses('global complain mode cannot replace selector', lambda: install(next_bundle, True), 'enforcing AppArmor')
        original_check = installer.linux_immutable
        def parser(file):
            if file == Path('/usr/sbin/apparmor_parser'): raise RuntimeError('synthetic mutable parser')
            return original_check(file)
        with patch.object(installer, 'linux_immutable', parser):
            refuses('unsafe fixed parser cannot replace selector', lambda: install(next_bundle, True), 'synthetic mutable parser')
        (runtime / 'policy.lock').chmod(0o666)
        refuses('mutable policy lock cannot replace selector', lambda: install(next_bundle, True), 'mutable or unsafe')
        (runtime / 'policy.lock').chmod(0o644)
        with patch.object(installer, 'reclaim_stopped_linux_profiles', side_effect=RuntimeError('synthetic surviving tools')):
            refuses('policy reclamation refusal cannot replace selector', lambda: install(next_bundle, True), 'surviving tools')
    previous_sync = installer.sync_directory
    def fail_after_publication(directory):
        if directory == runtime:
            raise OSError('synthetic directory fsync failure after publication')
        return previous_sync(directory)
    with patch.object(installer, 'sync_directory', fail_after_publication):
        try: install(next_bundle, True)
        except installer.SelectorPublishedError as error:
            assert 'published' in str(error)
        else: raise AssertionError('post-publication failure was not reported')
    assert json.loads((runtime / 'active.json').read_text())['artifactSet'] == next_result['artifactSet']
    passed.append('post-publication durability failure reports changed selector')
    previous_cleanup = installer.shutil.rmtree
    def fail_cleanup(directory, *args, **kwargs):
        if directory.parent == runtime: raise OSError('synthetic cleanup failure')
        return previous_cleanup(directory, *args, **kwargs)
    with patch.object(installer.shutil, 'rmtree', fail_cleanup):
        try: install(first, True)
        except installer.SelectorPublishedError as error:
            assert 'published' in str(error)
        else: raise AssertionError('post-publication cleanup failure was not reported')
    assert json.loads((runtime / 'active.json').read_text())['artifactSet'] == active['artifactSet']
    passed.append('post-publication cleanup failure reports changed selector')
    print(json.dumps({'platform': platform.system(), 'passed': passed, 'realVendorExecuted': False,
                      'realRuntimeChanged': False, 'syntheticInstallerContracts': True}))
finally:
    shutil.rmtree(parent)
