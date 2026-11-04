#!/usr/bin/env python3
"""Real native keyring/receipt failures, only on the isolated audit hosts.

Linux: run in a loopback-only namespace under dbus-run-session. The fixture
owns a fresh Secret Service. macOS: own a temporary keychain, restore the
previous default before deleting only that fixture keychain.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import tempfile
import time
import uuid

assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
assert os.getuid() != 0
parser = argparse.ArgumentParser()
parser.add_argument('--helper', type=Path, required=True)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='aimgr-mcp-receipt-'))
base = Path(f'/opt/aimgr-codex-runtime/users/{os.getuid()}/maintenance')
assert base.is_dir() and not (base / 'pending.json').exists()
pending = base / 'pending.json'
pending.write_text('{"fixture":true}\n')
pending.chmod(0o600)
locks = []
daemon = None
default_keychain = None
keychain_created = False
keychain = root / 'fixture.keychain-db'
env = dict(os.environ, HOME=str(root))
if platform.system() == 'Darwin':
    # Security.framework and `security` must resolve the same user's keychain
    # preferences. This is the isolated rental user; only the fresh fixture
    # keychain is selected for the test.
    env['HOME'] = str(Path.home())
receipt_files = []

def security(*arguments, check=True):
    return subprocess.run(['/usr/bin/security', *map(str, arguments)], capture_output=True, text=True, check=check)

def boot_id():
    if platform.system() == 'Linux':
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True).strip().lower()

def request(name, value):
    url = 'https://fixture.invalid/mcp'
    token = json.dumps({'server_name': name, 'url': url, 'client_id': 'synthetic',
                        'token_response': {'access_token': value}}, separators=(',', ':'))
    fields = [name.encode(), url.encode(), token.encode()]
    digest = hashlib.sha256(b''.join(len(x).to_bytes(8, 'big') + x for x in fields)).hexdigest()
    operation_id = uuid.uuid4().hex
    receipt_files.append(base / 'receipts' / (operation_id + '.json'))
    return {'operation': 'insert-if-absent', 'server_name': name, 'url': url, 'value': token,
            'maintenance': {'operation_id': operation_id, 'intent_sha256': digest,
                            'boot_id': boot_id(), 'lock_fds': locks}}

def call(data):
    # No timeout can kill a credential writer. On failure, leave the pending
    # marker unless this fixture has observed the owned child exit.
    result = subprocess.run([str(args.helper)], input=json.dumps(data), text=True,
                            capture_output=True, env=env, pass_fds=tuple(locks))
    assert result.stderr == '', 'helper printed a diagnostic outside its safe protocol'
    return json.loads(result.stdout)

def receipt_path(data):
    return base / 'receipts' / (data['maintenance']['operation_id'] + '.json')

def seed_receipt(data, phase, boot):
    target = receipt_path(data)
    target.write_text(json.dumps({'schema': 1, 'operation_id': data['maintenance']['operation_id'],
                                 'intent_sha256': data['maintenance']['intent_sha256'], 'boot_id': boot, 'phase': phase}))
    target.chmod(0o600)

try:
    for name in ('setup.lock', 'file-store.lock'):
        fd = os.open(root / name, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        locks.append(fd)
    if platform.system() == 'Linux':
        assert os.environ.get('AIMGR_SYNTHETIC_DBUS') == '1'
        assert {name for _, name in socket.if_nameindex()} == {'lo'}
        runtime = Path.home() / 'codex-m1-private/keyring-fixture/runtime'
        daemon_env = dict(env, LD_LIBRARY_PATH=str(runtime / 'usr/lib/x86_64-linux-gnu'))
        daemon_log = (root / 'keyring.log').open('wb')
        daemon = subprocess.Popen([str(runtime / 'usr/bin/gnome-keyring-daemon'), '--foreground',
                                   '--components=secrets', '--unlock', '--control-directory=' + str(root / 'control')],
                                  stdin=subprocess.PIPE, stdout=daemon_log, stderr=daemon_log, env=daemon_env)
        daemon.stdin.write(b'SYNTHETIC_FIXTURE_PASSWORD\n')
        daemon.stdin.close()
    else:
        # A fresh EC2 Mac has no login/default keychain yet.
        default_keychain = security('default-keychain', '-d', 'user', check=False).stdout.strip().strip('"')
        security('create-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        keychain_created = True
        security('unlock-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        security('default-keychain', '-d', 'user', '-s', keychain)
    name = 'synthetic_receipt_' + uuid.uuid4().hex
    first = request(name, 'SYNTHETIC_ONE')
    for attempt in range(20):
        probe = call({'operation': 'load', 'server_name': name, 'url': first['url']})
        if probe.get('error') != 'keyring_unavailable':
            break
        time.sleep(0.1)
    assert probe == {'value': None}, probe
    result = call(first)
    assert result.get('inserted') is True, result.get('error')
    assert json.loads(receipt_path(first).read_text())['phase'] == 'verified'
    assert call(first).get('inserted') is False
    different = request(name, 'SYNTHETIC_TWO')
    assert call(different) == {'error': 'maintenance_conflict'}
    assert json.loads(receipt_path(different).read_text())['phase'] != 'verified'
    assert call({'operation': 'load', 'server_name': name, 'url': first['url']})['value'] == first['value']
    print('PASS native insert, exact readback, idempotence and conflicting token preservation')
    uncertain = request(name + '_uncertain', 'SYNTHETIC_PENDING')
    seed_receipt(uncertain, 'dispatched', boot_id())
    assert call(uncertain) == {'error': 'maintenance_unknown_write'}
    for malformed in ('', 'a' * 36, '00000000_0000-0000-0000-000000000000'):
        seed_receipt(uncertain, 'dispatched', malformed)
        assert call(uncertain) == {'error': 'maintenance_boot'}
    assert call({'operation': 'load', 'server_name': uncertain['server_name'], 'url': uncertain['url']}) == {'value': None}
    print('PASS same-boot unknown write and malformed boot provenance refuse without mutation')
    duplicate = request(name + '_duplicate', 'SYNTHETIC_DUPLICATE')
    duplicate['maintenance']['lock_fds'] = [locks[0], locks[0]]
    assert call(duplicate) == {'error': 'maintenance_lock'}
    duplicate['maintenance']['lock_fds'] = [locks[0], max(locks) + 100]
    assert call(duplicate) == {'error': 'maintenance_lock'}
    print('PASS duplicate and missing inherited lock descriptors refuse')
    if platform.system() == 'Darwin':
        for target in (base, base / 'receipts', receipt_path(first)):
            subprocess.run(['/bin/chmod', '+a', 'everyone allow read,write', str(target)], check=True)
            try:
                assert call(first) == {'error': 'maintenance_acl'}
            finally:
                subprocess.run(['/bin/chmod', '-N', str(target)], check=True)
        print('PASS macOS extended ALLOW ACLs refuse on directories and the actual receipt')
    print(json.dumps({'fixture': root.name, 'platform': platform.system()}))
finally:
    if daemon is not None:
        daemon.terminate()
        daemon.wait(timeout=15)
    if default_keychain:
        security('default-keychain', '-d', 'user', '-s', default_keychain)
    if keychain_created:
        security('delete-keychain', keychain)
    for fd in locks:
        os.close(fd)
    for target in receipt_files:
        target.unlink(missing_ok=True)
    pending.unlink()
