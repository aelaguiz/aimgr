#!/usr/bin/env python3
"""Real finite conversion with a disposable OS keyring and synthetic tokens.

Linux requires a loopback-only namespace and fresh dbus-run-session. macOS
uses only a temporary test keychain on the designated rented machine.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import socket
import signal
import subprocess
import tempfile
import time
import uuid

assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
assert os.getuid() != 0
parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True)
parser.add_argument('--process-control', required=True)
parser.add_argument('--debug-owner', action='store_true')
parser.add_argument('--custom-settings', action='store_true')
parser.add_argument('--standard-keychain', action='store_true')
parser.add_argument('--cuts', nargs='+', choices=['pending', 'backup', 'intents', 'import', 'native-read-before', 'native-read-after', 'publish', 'retire', 'committed'],
                    default=['pending', 'backup', 'intents', 'import', 'publish', 'retire', 'committed'])
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='aimgr-mcp-maintenance-'))
home = root / 'home'
source = home / ('custom-settings' if args.custom_settings else '.codex')
source.mkdir(parents=True, mode=0o700)
project = root / 'project'
project.mkdir()
base = Path(f'/opt/aimgr-codex-runtime/users/{os.getuid()}/maintenance')
assert base.is_dir() and not (base / 'pending.json').exists() and not (base / 'transaction.json').exists()
before = set(base.iterdir())
receipts_before = set((base / 'receipts').glob('*.json'))
keyring = repo / 'native/codex/mcp-keyring/target/release/aimgr-codex-mcp-keyring'
env = dict(os.environ, HOME=str(home), CODEX_HOME=str(source), XDG_DATA_HOME=str(home / '.local/share'))
if platform.system() == 'Darwin':
    env['HOME'] = str(Path.home())  # Security.framework's existing OS-user context.
request = dict(operation='start', home=str(home), cwd=str(project), source_home=str(source),
               artifact_set='a' * 64, managed={},
               config_state=str(repo / 'native/codex/config-state/target/debug/aimgr-codex-config-state'),
               state_io=str(repo / 'native/codex/state_io.py'), keyring=str(keyring),
               process_control=args.process_control, node=args.node,
               owner_script=str(repo / 'src/credentials/codex-mcp-maintenance-owner.js'))
if platform.system() == 'Darwin':
    admitted = json.loads(subprocess.check_output([args.node, '--input-type=module', '-e',
        "import {admitCodexArtifact} from './src/privacy/codex-artifacts.js'; console.log(JSON.stringify(admitCodexArtifact()))"], cwd=repo, text=True))
    request['artifact_set'] = admitted['artifactSet']
    request['native_access'] = dict(executable=admitted['command'], sha256=admitted['vendorSha256'])
daemon = None
default_keychain = None
assert not args.standard_keychain or platform.system() == 'Darwin'
keychain = (Path.home() / 'Library/Keychains' / (root.name + '.keychain-db')) if args.standard_keychain else root / 'fixture.keychain-db'
keychain_created = False

def security(*arguments, check=True):
    return subprocess.run(['/usr/bin/security', *map(str, arguments)], capture_output=True, text=True, check=check)

def credential(operation, name, url, value=None):
    payload = dict(operation=operation, server_name=name, url=url)
    if value is not None:
        payload['value'] = value
    result = subprocess.run([str(keyring)], input=json.dumps(payload), capture_output=True, text=True, env=env)
    assert result.stderr == ''
    return json.loads(result.stdout)

def maintain(operation='start', expected=True, cut=None):
    command = ['/usr/bin/python3', '-I', str(repo / 'native/codex/mcp_maintenance.py')]
    if cut:
        # Kill the actual finite owner at deterministic boundaries. Production
        # code has no fault switches; backend writes/receipts stay real.
        command = ['/usr/bin/python3', '-I', '-c', '''
import importlib.util,json,os,signal,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('fixture_owner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
request=json.load(sys.stdin);owner=m.Maintenance(request);point=sys.argv[2]
def die(): os.kill(os.getpid(),signal.SIGKILL)
durable=m.durable
def durable_cut(file,data,exclusive=False):
 if exclusive and point=='backup':
  # Interrupt after creating the staging inode but before writing any bytes.
  def stop(*args,**kwargs): die()
  m.os.fdopen=stop
 return durable(file,data,exclusive)
m.durable=durable_cut
save=owner.save
def save_cut():
 save()
 if point=='intents' and owner.journal.get('intents') is not None and not owner.journal.get('committed'): die()
owner.save=save_cut
keyring=owner.keyring
def keyring_cut(operation,item):
 result=keyring(operation,item)
 if point=='import' and operation=='insert-if-absent': die()
 return result
owner.keyring=keyring_cut
control=owner.owner
def control_cut(operation,**values):
 if point=='native-read-before' and operation=='native-read': die()
 result=control(operation,**values)
 if point=='native-read-after' and operation=='native-read': die()
 if point=='publish' and operation=='publish': die()
 return result
owner.owner=control_cut
flush=m.state_io.flush_parent
def flush_cut(file,*args,**kwargs):
 result=flush(file,*args,**kwargs)
 if point=='retire' and Path(file).resolve()==(Path(request['source_home'])/'.credentials.json').resolve(): die()
 return result
m.state_io.flush_parent=flush_cut
admission=owner.admission
def admission_cut(pending):
 result=admission(pending)
 if point=='pending' and pending: die()
 if point=='committed' and not pending: die()
 return result
owner.admission=admission_cut
try: owner.run()
finally: owner.close()
''', str(repo / 'native/codex/mcp_maintenance.py'), cut]
    elif args.debug_owner:
        # Synthetic remote fixture only: report exception type and source line,
        # never an exception message containing paths or token values.
        command = ['/usr/bin/python3', '-I', '-c', '''
import importlib.util,json,sys,traceback
s=importlib.util.spec_from_file_location('fixture_owner',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
owner=m.Maintenance(json.load(sys.stdin))
try:
 owner.run(); print(json.dumps({'ok':True}))
except m.MaintenanceError as error:
 print(json.dumps({'error':str(error)})); sys.exit(1)
except Exception as error:
 frames=[(f.name,f.lineno) for f in traceback.extract_tb(error.__traceback__)]
 print(json.dumps({'error':type(error).__name__,'frames':frames})); sys.exit(1)
finally: owner.close()
''', str(repo / 'native/codex/mcp_maintenance.py')]
    result = subprocess.run(command,
                            input=json.dumps(dict(request, operation=operation)), capture_output=True, text=True, env=env)
    assert result.stderr == '', result.stderr
    if cut:
        assert result.returncode == -signal.SIGKILL, (cut, result.returncode)
        return
    response = json.loads(result.stdout)
    assert (result.returncode == 0 and response.get('ok') is True) == expected, response
    return response

def seed(name, access):
    url = 'https://fixture.invalid/mcp'
    key = name + '|' + hashlib.sha256(json.dumps(dict(type='http', url=url, headers={}), separators=(',', ':')).encode()).hexdigest()[:16]
    config = ('mcp_oauth_credentials_store="file"\ncheck_for_update_on_startup=false\n'
              '[analytics]\nenabled=false\n[feedback]\nenabled=false\n'
              '[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n'
              f'[mcp_servers.{name}]\nurl="{url}"\n')
    (source / 'config.toml').write_text(config)
    (source / 'config.toml').chmod(0o600)
    entry = dict(server_name=name, server_url=url, client_id='synthetic-client', issuer='https://fixture.invalid',
                 access_token=access, refresh_token='SYNTHETIC_REFRESH', expires_at=4102444800000, scopes=['read', 'write'])
    original = json.dumps({key: entry}).encode()
    (source / '.credentials.json').write_bytes(original)
    (source / '.credentials.json').chmod(0o600)
    return url, original

def authorize_synthetic(name, url):
    key = name + '|' + hashlib.sha256(json.dumps(dict(type='http', url=url, headers={}), separators=(',', ':')).encode()).hexdigest()[:16]
    signature = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=4', str(keyring)], capture_output=True, text=True, check=True).stderr
    cdhash = re.search(r'^CDHash=([0-9a-f]+)$', signature, re.M).group(1)
    security('set-generic-password-partition-list', '-s', 'Codex MCP Credentials', '-a', key,
             '-S', 'cdhash:' + cdhash + ',teamid:2DC432GLL2', '-k', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)

try:
    if platform.system() == 'Linux':
        assert os.environ.get('AIMGR_SYNTHETIC_DBUS') == '1'
        assert {name for _, name in socket.if_nameindex()} == {'lo'}
        runtime = Path.home() / 'codex-m1-private/keyring-fixture/runtime'
        daemon_log = (root / 'keyring.log').open('wb')
        daemon = subprocess.Popen([str(runtime / 'usr/bin/gnome-keyring-daemon'), '--foreground',
                                   '--components=secrets', '--unlock', '--control-directory=' + str(root / 'control')],
                                  stdin=subprocess.PIPE, stdout=daemon_log, stderr=daemon_log,
                                  env=dict(env, LD_LIBRARY_PATH=str(runtime / 'usr/lib/x86_64-linux-gnu')))
        daemon.stdin.write(b'SYNTHETIC_FIXTURE_PASSWORD\n')
        daemon.stdin.close()
    else:
        default_keychain = security('default-keychain', '-d', 'user', check=False).stdout.strip().strip('"')
        security('create-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        keychain_created = True
        security('unlock-keychain', '-p', 'SYNTHETIC_FIXTURE_PASSWORD', keychain)
        security('default-keychain', '-d', 'user', '-s', keychain)
    name = 'synthetic_maintenance_' + uuid.uuid4().hex
    url, original = seed(name, 'SYNTHETIC_ACCESS')
    for _ in range(30):
        probe = credential('load', name, url)
        if probe.get('error') != 'keyring_unavailable':
            break
        time.sleep(0.1)
    assert probe == {'value': None}, probe
    # A real unchanged legacy-capable consumer must remain alive. Inventory
    # cannot prove whether its cached MCP connections use refresh coordination.
    live_log = (root / 'existing-native.log').open('wb')
    live = subprocess.Popen(['/opt/aimgr-state-audit/bin/codex', 'app-server', '--listen', 'stdio://'],
                            cwd=project, env=env, stdin=subprocess.PIPE, stdout=live_log, stderr=live_log)
    try:
        time.sleep(.2)
        assert live.poll() is None
        refusal = maintain(expected=False)
        assert 'finish or exit normally' in refusal['error']
        assert live.poll() is None and not (base / 'pending.json').exists()
        assert (source / '.credentials.json').read_bytes() == original
        assert credential('load', name, url) == {'value': None}
    finally:
        live.stdin.close()
        live.wait(timeout=15)
        live_log.close()
    print('PASS existing native consumer is refused before pending and exits normally without any credential mutation')
    if args.standard_keychain:
        config_before = (source / 'config.toml').read_bytes()
        refused = maintain(expected=False)
        assert 'Codex could not read every imported MCP credential' in refused['error'], refused
        assert (source / '.credentials.json').read_bytes() == original
        assert (source / 'config.toml').read_bytes() == config_before
        assert (base / 'pending.json').exists()
        # Test-only persistent authorization for this one synthetic item.
        # No product password handling and no claim of GUI-click coverage.
        authorize_synthetic(name, url)
        maintain('recover')
        print('PASS official-client denial preserves File/config/pending; synthetic authorization enables recovery')
    else:
        maintain()
    journal = json.loads((base / 'transaction.json').read_text())
    if args.custom_settings:
        plan = journal['plan']
        expected = {str(source.resolve() / 'mcp-oauth-locks'), str(home.resolve() / '.codex/mcp-oauth-locks')}
        assert set(plan['lock_directories']) == expected
        assert Path(plan['file_lock']).parent == source.resolve() / 'mcp-oauth-locks'
    assert journal['committed'] and journal['finished']
    assert not (base / 'pending.json').exists() and not (source / '.credentials.json').exists()
    assert Path(journal['backup']).read_bytes() == original
    stored = json.loads(credential('load', name, url)['value'])
    if platform.system() == 'Darwin':
        acl = security('dump-keychain', '-a', keychain, check=False)
        (root / 'keychain-acl.txt').write_text(acl.stdout + acl.stderr)
    assert stored['token_response']['access_token'] == 'SYNTHETIC_ACCESS'
    assert stored['token_response']['refresh_token'] == 'SYNTHETIC_REFRESH'
    assert stored['token_response']['scope'] == 'read write'
    assert stored['issuer'] == 'https://fixture.invalid' and stored['expires_at'] == 4102444800000
    print('PASS finite File-to-Direct conversion preserves complete credentials and retires only the original File store')
    # Real unchanged native reader/deleter, no account login or outbound route.
    result = subprocess.run(['/opt/aimgr-state-audit/bin/codex', 'mcp', 'logout', name],
                            cwd=project, env=env, capture_output=True, text=True, timeout=30)
    (root / 'native-logout.json').write_text(json.dumps(dict(code=result.returncode, stdout=result.stdout, stderr=result.stderr)))
    assert result.returncode == 0, 'native logout failed; private fixture retained'
    assert credential('load', name, url) == {'value': None}
    maintain('recover')
    assert credential('load', name, url) == {'value': None}
    print('PASS unchanged native logout reads the migrated entry and committed recovery does not resurrect it')
    # An expired optional login is still a readable native credential. It must
    # not leave every unrelated Codex workflow waiting for reauthentication.
    expired_name = name + '_expired'
    expired_url, _ = seed(expired_name, 'SYNTHETIC_EXPIRED')
    expired_file = source / '.credentials.json'
    expired = json.loads(expired_file.read_text())
    for entry in expired.values():
        entry['expires_at'] = 1
        entry.pop('refresh_token')
    expired_file.write_text(json.dumps(expired))
    with (source / 'config.toml').open('a') as config:
        config.write('enabled=false\n')
    if args.standard_keychain:
        refused = maintain(expected=False)
        assert 'Codex could not read every imported MCP credential' in refused['error'], refused
        authorize_synthetic(expired_name, expired_url)
        maintain('recover')
    else:
        maintain()
    assert not expired_file.exists() and not (base / 'pending.json').exists()
    assert json.loads(credential('load', expired_name, expired_url)['value'])['expires_at'] == 1
    print('PASS expired disabled MCP login imports without blocking unrelated sessions')
    for cut in ([] if args.standard_keychain else args.cuts):
        interrupted_name = name + '_' + cut
        interrupted_url, original_cut = seed(interrupted_name, 'SYNTHETIC_' + cut)
        maintain(cut=cut)
        journal = json.loads((base / 'transaction.json').read_text())
        assert not journal['finished']
        if cut == 'backup':
            assert not (base / ('file-before-' + journal['operation_id'] + '.json')).exists()
            assert (source / '.credentials.json').read_bytes() == original_cut
        if cut in ('retire', 'committed'):
            assert not (source / '.credentials.json').exists()
        if cut == 'committed':
            assert journal['committed'] and not (base / 'pending.json').exists()
            logout = subprocess.run(['/opt/aimgr-state-audit/bin/codex', 'mcp', 'logout', interrupted_name],
                                    cwd=project, env=env, capture_output=True, text=True, timeout=30)
            assert logout.returncode == 0
            assert credential('load', interrupted_name, interrupted_url) == {'value': None}
        else:
            assert not journal['committed'] and (base / 'pending.json').exists()
        if cut == 'pending':
            late_log = (root / 'late-native.log').open('wb')
            late = subprocess.Popen(['/opt/aimgr-state-audit/bin/codex', 'app-server', '--listen', 'stdio://'],
                                    cwd=project, env=env, stdin=subprocess.PIPE, stdout=late_log, stderr=late_log)
            try:
                time.sleep(.2)
                assert late.poll() is None
                refused = maintain('recover', expected=False)
                assert 'finish or exit normally' in refused['error']
                assert late.poll() is None and (base / 'pending.json').exists()
                assert (source / '.credentials.json').read_bytes() == original_cut
                assert credential('load', interrupted_name, interrupted_url) == {'value': None}
            finally:
                late.stdin.close()
                late.wait(timeout=15)
                late_log.close()
            lock_file = Path(journal['plan']['file_lock'])
            lock_file.parent.mkdir(parents=True, exist_ok=True)
            held = os.open(lock_file, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(held, fcntl.LOCK_EX)
                began = time.monotonic()
                refused = maintain('recover', expected=False)
                assert 'credential operation is still running' in refused['error']
                assert 55 <= time.monotonic() - began < 90
                assert (base / 'pending.json').exists()
                assert (source / '.credentials.json').read_bytes() == original_cut
                assert credential('load', interrupted_name, interrupted_url) == {'value': None}
            finally:
                os.close(held)
        maintain('recover')
        journal = json.loads((base / 'transaction.json').read_text())
        assert journal['committed'] and journal['finished']
        assert not (base / 'pending.json').exists() and not (source / '.credentials.json').exists()
        assert Path(journal['backup']).read_bytes() == original_cut
        assert Path(journal['backup']).stat().st_nlink == 1
        assert re.search(r'mcp_oauth_credentials_store\s*=\s*"keyring"', (source / 'config.toml').read_text())
        if cut == 'committed':
            assert credential('load', interrupted_name, interrupted_url) == {'value': None}
        else:
            recovered = json.loads(credential('load', interrupted_name, interrupted_url)['value'])
            assert recovered['token_response']['access_token'] == 'SYNTHETIC_' + cut
    if not args.standard_keychain:
        print('PASS SIGKILL recovery boundaries: ' + ', '.join(args.cuts))
    # A different keyring value is never overwritten, nor is File retired.
    name2 = name + '_conflict'
    url2, original2 = seed(name2, 'SYNTHETIC_FILE_OLDER')
    other = dict(stored, server_name=name2, url=url2,
                 token_response=dict(stored['token_response'], access_token='SYNTHETIC_KEYRING_DIFFERENT'))
    frozen = json.dumps(other, separators=(',', ':'))
    assert credential('insert-if-absent', name2, url2, frozen).get('inserted') is True
    maintain(expected=False)
    assert (base / 'pending.json').exists()
    assert (source / '.credentials.json').read_bytes() == original2
    assert credential('load', name2, url2)['value'] == frozen
    maintain('recover', expected=False)
    assert credential('load', name2, url2)['value'] == frozen
    print('PASS conflicting destination survives both initial conversion and explicit recovery with File preserved')
    print(json.dumps(dict(fixture=root.name, platform=platform.system())))
finally:
    if daemon is not None:
        daemon.terminate()
        daemon.wait(timeout=15)
    if default_keychain:
        security('default-keychain', '-d', 'user', '-s', default_keychain)
    if keychain_created:
        security('delete-keychain', keychain)
    # All owned children have exited. Remove only this synthetic transaction's
    # records; its credential store lived in the now-removed test keyring.
    for file in set((base / 'receipts').glob('*.json')) - receipts_before:
        file.unlink()
    for file in set(base.iterdir()) - before:
        if file.is_file():
            file.unlink()
