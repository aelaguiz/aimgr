#!/usr/bin/env python3
"""Real native initializer locks/recovery; synthetic state on isolated hosts."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

assert os.getuid() != 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
repo = Path(__file__).resolve().parent.parent
binary = repo / 'native/codex/config-state/target/debug/aimgr-codex-config-state'
root = Path(tempfile.mkdtemp(prefix='aimgr-state-crash-'))
os.chmod(root, 0o700)
project = root / 'project'
project.mkdir()
task_home = root / 'home'
task_home.mkdir()
settings = 'check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n'
environment = dict(HOME=str(task_home), PATH='/usr/bin:/bin', TMPDIR=str(root))

def request(name, state, logs):
    home = task_home / name
    home.mkdir(mode=0o700)
    (home / 'config.toml').write_text(settings)
    return dict(operation='initialize', artifact_set='a'*64, codex_home=str(home),
                cwd=str(project), config=['sqlite_home='+json.dumps(str(state)),
                                         'log_dir='+json.dumps(str(logs))],
                forced_config='', forced_requirements='')

def start(value):
    child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=environment, cwd=project)
    child.stdin.write(json.dumps(value).encode())
    child.stdin.close()
    child.stdin = None
    return child

def success(child):
    out, err = child.communicate(timeout=80)
    assert child.returncode == 0, (child.returncode, err.decode())
    assert not err
    return json.loads(out)

state, logs = root/'a-state', root/'z-logs'
state.mkdir(); logs.mkdir()
alias = root/'state-alias'
alias.symlink_to(state, target_is_directory=True)
first, second = request('one', state, logs), request('two', alias, logs)
a, b = start(first), start(second)
one, two = success(a), success(b)
assert all(Path(p).exists() for p in one['database_files'])
assert len({Path(p).resolve() for p in one['database_files'] + two['database_files']}) == 7
assert len({Path(p).parent.resolve() for p in one['database_files']}) == 2
print('PASS separate homes and symlink aliases share physical state/log root locks', flush=True)

marker = state/'.aimgr-codex-db-initialized.json'
marker.rename(state/'retained-marker.json')
os.mkfifo(marker, 0o600)
success(start(first))
assert marker.is_file() and not marker.is_symlink()
print('PASS FIFO completion object neither hangs nor supplies false completion', flush=True)

# A helper that survives its AIM-like parent retains its own first physical
# root lock while waiting for the second. No test-only pause in product code.
parent_state, parent_logs = root/'b-parent-state', root/'y-parent-logs'
parent_state.mkdir(); parent_logs.mkdir()
parent_request = request('parent', parent_state, parent_logs)
log_lock = os.open(parent_logs/'.aimgr-codex-db-init.lock', os.O_CREAT|os.O_RDWR, 0o600)
fcntl.flock(log_lock, fcntl.LOCK_EX)
wrapper = '''import json,subprocess,sys,time
v=json.loads(sys.stdin.readline())
p=subprocess.Popen([v['binary']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=v['env'])
p.stdin.write(json.dumps(v['request']).encode());p.stdin.close()
print(p.pid,flush=True)
sys.stdin.read()
'''
parent = subprocess.Popen([sys.executable, '-c', wrapper], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
parent.stdin.write(json.dumps(dict(binary=str(binary), env=environment, request=parent_request))+'\n')
parent.stdin.flush()
helper_pid = int(parent.stdout.readline())
state_lock = os.open(parent_state/'.aimgr-codex-db-init.lock', os.O_CREAT|os.O_RDWR, 0o600)
deadline = time.monotonic()+20
while True:
    try:
        fcntl.flock(state_lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        fcntl.flock(state_lock, fcntl.LOCK_UN)
    except BlockingIOError:
        break
    assert time.monotonic() < deadline, 'helper did not acquire its first root lock'
    time.sleep(0.01)
parent.kill(); parent.wait(timeout=5)
os.kill(helper_pid, 0)
try:
    fcntl.flock(state_lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
    raise AssertionError('parent death released initializing helper lock')
except BlockingIOError:
    pass
fcntl.flock(log_lock, fcntl.LOCK_UN); os.close(log_lock)
completion = parent_state/'.aimgr-codex-db-initialized.json'
deadline = time.monotonic()+30
while not completion.exists():
    assert time.monotonic() < deadline, 'orphan initializer did not finish'
    time.sleep(0.01)
deadline = time.monotonic()+10
while True:
    try:
        fcntl.flock(state_lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        break
    except BlockingIOError:
        assert time.monotonic() < deadline, 'completed initializer retained a lock'
        time.sleep(0.01)
fcntl.flock(state_lock, fcntl.LOCK_UN); os.close(state_lock)
success(start(parent_request))
print('PASS parent death retains helper locks through initialization and allows later reuse', flush=True)

# Kill an actual initializer after its first SQLite file appears, before all
# seven databases exist. Retry must complete native migrations, not trust a
# partial or absent completion record.
killed = False
for attempt in range(3):
    crash_state, crash_logs = root/('crash-state-'+str(attempt)), root/('crash-logs-'+str(attempt))
    value = request('crash-'+str(attempt), crash_state, crash_logs)
    child = start(value)
    deadline = time.monotonic()+20
    while child.poll() is None:
        files = list(crash_state.glob('*.sqlite')) + list(crash_logs.glob('*.sqlite'))
        if files and len(files) < 7:
            child.kill(); child.communicate(timeout=5)
            assert not (crash_state/'.aimgr-codex-db-initialized.json').exists()
            result = success(start(value))
            assert len(result['database_files']) == 7
            killed = True
            break
        assert time.monotonic() < deadline
        time.sleep(0.001)
    if killed: break
    success(child)
assert killed, 'fixture could not observe partial native migration'
print('PASS killed partial native migration recovers without a false completion marker', flush=True)
print(json.dumps(dict(fixture=root.name, platform=sys.platform)))
