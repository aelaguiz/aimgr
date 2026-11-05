#!/usr/bin/env python3
"""Real keyring child lifetime and actual reboot recovery, isolated hosts only.

Build the AIM helper with `cargo rustc --bin aimgr-codex-mcp-keyring -- --cfg test`,
then copy it to one persistent fixture path before prepare. That executable is
retained through verify, including its macOS creator ACL identity. No Codex
source/executable is changed. Linux needs a fresh loopback-only dbus-run-session
for each phase. Prepare intentionally leaves one pending synthetic transaction.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import subprocess
import time
import uuid

assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file() and os.getuid() != 0
parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['prepare', 'verify'])
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--helper', type=Path, required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--process-control', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
assert args.root.is_absolute() and args.helper.is_absolute()
root = args.root
assert root.parent == Path.home() / 'codex-m1-private'
base = Path(f'/opt/aimgr-codex-runtime/users/{os.getuid()}/maintenance')
if args.phase == 'prepare':
    assert not root.exists() and not (base / 'pending.json').exists() and not (base / 'transaction.json').exists()
    root.mkdir(mode=0o700)
root = root.resolve()
assert root.stat().st_mode & 0o077 == 0
source = root / 'home/.codex'
project = root / 'project'
source.mkdir(parents=True, exist_ok=True, mode=0o700)
project.mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(source.parent), CODEX_HOME=str(source), XDG_DATA_HOME=str(root / 'keyring-data'))
for key in ('AIMGR_MCP_TEST_BARRIER', 'AIMGR_MCP_TEST_DIRECTORY', 'AIMGR_MCP_TEST_SERVER'):
    env.pop(key, None)
mac = platform.system() == 'Darwin'
if mac:
    env['HOME'] = str(Path.home())
else:
    assert os.environ.get('AIMGR_SYNTHETIC_DBUS') == '1'
    assert {name for _, name in socket.if_nameindex()} == {'lo'}
request = dict(operation='start', home=str(source.parent), cwd=str(project), source_home=str(source),
               artifact_set='a' * 64, managed={},
               config_state=str(repo / 'native/codex/config-state/target/debug/aimgr-codex-config-state'),
               state_io=str(repo / 'native/codex/state_io.py'), keyring=str(args.helper),
               process_control=args.process_control, node=args.node,
               owner_script=str(repo / 'src/credentials/codex-mcp-maintenance-owner.js'))
if mac:
    request['native_access'] = dict(executable='/opt/aimgr-state-audit/bin/codex',
        sha256='39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1')

def security(*arguments, check=True):
    return subprocess.run(['/usr/bin/security', *map(str, arguments)], capture_output=True, text=True, check=check)

def boot():
    return (subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True)
            if mac else Path('/proc/sys/kernel/random/boot_id').read_text()).strip().lower()

def save_info(value):
    file = root / 'fixture.json'
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(root, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)

def journal():
    return json.loads((base / 'transaction.json').read_text())

def credential(name, value=None):
    payload = dict(operation='load' if value is None else 'insert-if-absent', server_name=name, url='https://fixture.invalid/mcp')
    if value is not None:
        payload['value'] = value
        if mac:
            payload['native_access'] = request['native_access']
    result = subprocess.run([str(args.helper)], input=json.dumps(payload), text=True, capture_output=True, env=env)
    assert result.stderr == ''
    return json.loads(result.stdout)

def write_fixture(file, data):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(file.parent, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)

def seed(name):
    url = 'https://fixture.invalid/mcp'
    key = name + '|' + hashlib.sha256(json.dumps(dict(type='http', url=url, headers={}), separators=(',', ':')).encode()).hexdigest()[:16]
    config = ('mcp_oauth_credentials_store="file"\ncheck_for_update_on_startup=false\n'
              '[analytics]\nenabled=false\n[feedback]\nenabled=false\n'
              '[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n'
              f'[mcp_servers.{name}]\nurl="{url}"\n')
    write_fixture(source / 'config.toml', config.encode())
    entry = dict(server_name=name, server_url=url, client_id='synthetic', access_token='SYNTHETIC_ACCESS',
                 refresh_token='SYNTHETIC_REFRESH', expires_at=4102444800000, scopes=['read'])
    write_fixture(source / '.credentials.json', json.dumps({key: entry}).encode())

def maintain(expected=True):
    result = subprocess.run(['/usr/bin/python3', '-I', str(repo / 'native/codex/mcp_maintenance.py')],
                            input=json.dumps(dict(request, operation='recover')), env=env, text=True, capture_output=True)
    assert result.stderr == ''
    output = json.loads(result.stdout)
    assert (result.returncode == 0 and output.get('ok') is True) == expected, 'unexpected recovery outcome; private evidence retained'
    return output

def wait_for(check):
    deadline = time.monotonic() + 30
    while not check():
        assert time.monotonic() < deadline, 'fixture barrier timed out; private evidence retained'
        time.sleep(.02)

children = []

def inventory():
    return json.loads(subprocess.check_output([args.process_control, '--inventory'], text=True))

def start(point):
    control = root / point
    control.mkdir(mode=0o700)
    log = (root / (point + '.log')).open('wb')
    child = subprocess.Popen(['/usr/bin/python3', '-I', str(repo / 'native/codex/mcp_maintenance.py')],
                             stdin=subprocess.PIPE, stdout=log, stderr=log,
                             env=dict(env, AIMGR_MCP_TEST_BARRIER=point, AIMGR_MCP_TEST_DIRECTORY=str(control)))
    owned = dict(parent=child, control=control, helper=None)
    children.append(owned)
    child.stdin.write(json.dumps(request).encode())
    child.stdin.close()
    try:
        wait_for(lambda: (control / 'reached').exists() or child.poll() is not None)
        assert child.poll() is None, 'owner exited before the barrier; private log retained'
        helper_pid = int((control / 'reached').read_text())
        owned['helper'] = next(item for item in inventory() if item['pid'] == helper_pid)
        current = journal()
        assert current['source_home'] == str(source)
        info['operations'].append(dict(operation_id=current['operation_id'],
            receipt_ids=[item['operation_id'] for item in current['intents']]))
        save_info(info)
        return child, helper_pid, control, log
    except BaseException:
        (control / 'release').touch()
        log.close()
        raise

def finish_children():
    # A failed assertion must not move a still-writing helper to the prior
    # default keychain or tear down its Secret Service. Never kill for cleanup.
    for child in children:
        (child['control'] / 'release').touch()
    deadline = time.monotonic() + 30
    while children:
        processes = inventory()
        remaining = []
        for child in children:
            helper = child['helper']
            # If start failed before binding the helper lifetime, do not infer
            # backend quiescence from the parent's exit alone.
            helper_alive = helper is None or any(p['pid'] == helper['pid'] and p['birth'] == helper['birth'] for p in processes)
            if child['parent'].poll() is None or helper_alive:
                remaining.append(child)
        if not remaining:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(.1)
    return True

def lock_paths():
    plan = journal()['plan']
    return [base / 'setup.lock', *map(Path, plan['refresh_locks']), Path(plan['file_lock'])]

def locks_held(expected):
    for file in lock_paths():
        fd = os.open(file, os.O_RDWR)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = False
            except BlockingIOError:
                held = True
            if held != expected:
                return False
        finally:
            os.close(fd)
    return True

def logout(name):
    # Native logout also deletes its File fallback, even when keyring is
    # explicitly selected. This fixture changes only the destination backend;
    # restore the original synthetic source before testing recovery.
    file = source / '.credentials.json'
    original = file.read_bytes() if file.exists() else None
    result = subprocess.run(['/opt/aimgr-state-audit/bin/codex', '-c', 'mcp_oauth_credentials_store="keyring"', 'mcp', 'logout', name],
                            cwd=project, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, 'fixture native logout failed'
    if original is not None:
        write_fixture(file, original)

info = json.loads((root / 'fixture.json').read_text()) if args.phase == 'verify' else dict(
    boot=boot(), helper_sha256=hashlib.sha256(args.helper.read_bytes()).hexdigest(),
    helper_path=str(args.helper.resolve()), operations=[])
assert hashlib.sha256(args.helper.read_bytes()).hexdigest() == info['helper_sha256']
assert str(args.helper.resolve()) == info['helper_path']
if args.phase == 'verify':
    expected_operation = info['operations'][-1]['operation_id']
    assert journal()['operation_id'] == expected_operation and journal()['source_home'] == str(source)
    assert json.loads((base / 'pending.json').read_text())['operation_id'] == expected_operation
daemon = None
keychain = root / 'fixture.keychain-db'
default_keychain = None
success = False
try:
    if mac:
        if args.phase == 'prepare':
            default_keychain = security('default-keychain', '-d', 'user').stdout.strip().strip('"')
            assert default_keychain and Path(default_keychain).is_file() and Path(default_keychain).resolve() != keychain.resolve()
            info['prior_default_keychain'] = default_keychain
            save_info(info)
            security('create-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        else:
            default_keychain = info['prior_default_keychain']
            assert Path(default_keychain).is_file() and Path(default_keychain).resolve() != keychain.resolve()
        security('unlock-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        security('default-keychain', '-d', 'user', '-s', keychain)
    else:
        runtime = Path.home() / 'codex-m1-private/keyring-fixture/runtime'
        daemon_log = (root / ('keyring-' + args.phase + '.log')).open('wb')
        daemon = subprocess.Popen([str(runtime / 'usr/bin/gnome-keyring-daemon'), '--foreground', '--components=secrets',
                                   '--unlock', '--control-directory=' + str(root / ('control-' + args.phase))],
                                  stdin=subprocess.PIPE, stdout=daemon_log, stderr=daemon_log,
                                  env=dict(env, LD_LIBRARY_PATH=str(runtime / 'usr/lib/x86_64-linux-gnu')))
        daemon.stdin.write(b'SYNTHETIC_FIXTURE_PASSWORD\n')
        daemon.stdin.close()
        def fixture_owns_service():
            result = subprocess.run(['/usr/bin/dbus-send', '--session', '--print-reply',
                '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus.GetConnectionUnixProcessID', 'string:org.freedesktop.secrets'],
                env=env, capture_output=True, text=True)
            match = re.search(r'uint32 ([0-9]+)', result.stdout)
            return result.returncode == 0 and match and int(match.group(1)) == daemon.pid
        wait_for(fixture_owns_service)
    for _ in range(30):
        if credential('synthetic_probe').get('error') != 'keyring_unavailable':
            break
        time.sleep(.1)
    assert credential('synthetic_probe') == {'value': None}
    if args.phase == 'prepare':
        seed('synthetic_parent_' + uuid.uuid4().hex)
        parent, helper_pid, control, log = start('dispatched')
        try:
            parent.kill()
            parent.wait(timeout=10)
            assert locks_held(True), 'actual keyring child must retain all inherited transaction locks'
            item = journal()['intents'][0]
            receipt = base / 'receipts' / (item['operation_id'] + '.json')
            assert json.loads(receipt.read_text())['phase'] == 'dispatched'
            assert credential(item['serverName']) == {'value': None}
            (control / 'release').touch()
            wait_for(lambda: json.loads(receipt.read_text())['phase'] == 'verified' and locks_held(False))
            assert credential(item['serverName'])['value'] == item['value']
            maintain()
        finally:
            (control / 'release').touch()
            log.close()
        print('PASS actual keyring child retains setup/refresh/File locks after parent death and writes a verified backend receipt before release', flush=True)
        name = 'synthetic_reboot_' + uuid.uuid4().hex
        seed(name)
        original_file = (source / '.credentials.json').read_bytes()
        original_config = (source / 'config.toml').read_bytes()
        parent, helper_pid, control, log = start('backend_returned')
        try:
            item = journal()['intents'][0]
            assert credential(name)['value'] == item['value']
            os.kill(helper_pid, signal.SIGKILL)
            parent.wait(timeout=10)
            receipt = base / 'receipts' / (item['operation_id'] + '.json')
            assert json.loads(receipt.read_text())['phase'] == 'dispatched'
            assert 'later machine boot' in maintain(False)['error']
            assert (base / 'pending.json').exists()
            assert (source / '.credentials.json').read_bytes() == original_file
            assert (source / 'config.toml').read_bytes() == original_config
            # A synthetic independent writer replaces the unacknowledged value.
            # This is not claimed as a backend completing after helper death.
            logout(name)
            different = json.loads(item['value'])
            different['token_response']['access_token'] = 'SYNTHETIC_DIFFERENT_DESTINATION'
            different = json.dumps(different, separators=(',', ':'))
            assert credential(name, different)['inserted']
            assert 'later machine boot' in maintain(False)['error']
            assert credential(name)['value'] == different
            assert (source / '.credentials.json').read_bytes() == original_file
            assert (source / 'config.toml').read_bytes() == original_config
            info.update(name=name, expected=item['value'], different=different,
                        source_sha256=hashlib.sha256(original_file).hexdigest(), config_sha256=hashlib.sha256(original_config).hexdigest())
            save_info(info)
        finally:
            (control / 'release').touch()
            log.close()
        print('PASS helper death after backend return leaves dispatched receipt; same-boot recovery refuses both matching and changed destinations', flush=True)
        print(json.dumps(dict(fixture=root.name, phase='awaiting_actual_reboot', platform=platform.system())), flush=True)
    else:
        assert boot() != info['boot'], 'this case requires an actual later boot'
        assert (base / 'pending.json').exists()
        refusal = maintain(False)
        assert 'different credential' in refusal['error']
        assert credential(info['name'])['value'] == info['different']
        assert hashlib.sha256((source / '.credentials.json').read_bytes()).hexdigest() == info['source_sha256']
        assert hashlib.sha256((source / 'config.toml').read_bytes()).hexdigest() == info['config_sha256']
        print('PASS actual later-boot recovery preserves a conflicting destination, original File and configuration', flush=True)
        # Restore the fixture's intended value explicitly, then test the real
        # recovery owner through retirement/commit/schedule cleanup.
        logout(info['name'])
        assert credential(info['name'], info['expected'])['inserted']
        maintain()
        assert credential(info['name'])['value'] == info['expected']
        assert journal()['committed'] and journal()['finished']
        assert not (base / 'pending.json').exists() and not (source / '.credentials.json').exists()
        success = True
        print('PASS real maintenance recovery accepts the matching destination after reboot and completes commit', flush=True)
        print(json.dumps(dict(fixture=root.name, phase='complete', platform=platform.system())), flush=True)
finally:
    try:
        children_finished = finish_children()
    except BaseException:
        children_finished = False
    if not children_finished:
        print('Fixture writer lifetime unresolved; fixture keyring context and private evidence retained. Do not restore or delete its backend until the writer exits.', flush=True)
    if children_finished and daemon:
        daemon.terminate()
        daemon.wait(timeout=15)
    if children_finished and default_keychain:
        security('default-keychain', '-d', 'user', '-s', default_keychain)
        selected = security('default-keychain', '-d', 'user').stdout.strip().strip('"')
        assert Path(selected).resolve() == Path(default_keychain).resolve(), 'default Keychain restoration failed'
        print('PASS fixture writers exited and original default Keychain restored', flush=True)
    if success and children_finished:
        if mac:
            selected = security('default-keychain', '-d', 'user').stdout.strip().strip('"')
            assert Path(selected).resolve() != keychain.resolve()
            security('delete-keychain', keychain)
        fd = os.open(base / 'setup.lock', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for operation in info['operations']:
                operation_id = operation['operation_id']
                for name in ('transaction.json', 'completed-' + operation_id + '.json'):
                    file = base / name
                    if file.exists():
                        value = json.loads(file.read_text())
                        if value.get('operation_id') == operation_id and value.get('source_home') == str(source):
                            assert value.get('finished')
                            file.unlink()
                (base / ('file-before-' + operation_id + '.json')).unlink(missing_ok=True)
                for receipt_id in operation['receipt_ids']:
                    (base / 'receipts' / (receipt_id + '.json')).unlink(missing_ok=True)
        finally:
            os.close(fd)
    assert children_finished, 'fixture cleanup incomplete: keyring writer still active'
