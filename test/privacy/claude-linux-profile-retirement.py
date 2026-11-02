#!/usr/bin/env python3
"""Offsite kernel checks for stopped-transition profile reclamation.

Only task-owned synthetic policies and /bin/sleep execute here. A surviving
tool must keep both profiles even when no Claude executable is running.
"""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
from unittest.mock import patch

assert os.geteuid() == 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
repo = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', repo / 'scripts/install-claude-runtime.py')
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
runtime = Path(tempfile.mkdtemp(prefix='profile-retirement-', dir='/opt/aimgr-state-audit'))
runtime.chmod(0o755); (runtime / 'policy.lock').touch(mode=0o644)
# This UID is a name component only. No system account or vendor identity is
# created, and production/test-user profiles are outside the selected set.
uid = 31337
assert not re.search(r'aim-claude-[op]-' + str(uid) + r'-[a-f0-9]{32}',
                     Path('/sys/kernel/security/apparmor/profiles').read_text())
main = f'aim-claude-p-{uid}-{uuid.uuid4().hex}'
tools = main + '-tools'
unrelated = 'aim-retirement-unrelated-' + uuid.uuid4().hex
other_user = f'aim-claude-o-{uid + 1}-{uuid.uuid4().hex}'
names = [main, tools, unrelated, other_user]
parser = '/usr/sbin/apparmor_parser'
policy = ''.join('profile ' + name + ' { network, capability, signal, ptrace, unix, /** rwmlkix, }\n' for name in names)
subprocess.run([parser, '-a', '-T'], input=policy, text=True, check=True, capture_output=True)
owner = None
passed = []
def loaded():
    return Path('/sys/kernel/security/apparmor/profiles').read_text()
def refusal(call, reason):
    try: call()
    except RuntimeError as error: assert reason in str(error), str(error)
    else: raise AssertionError('reclamation did not refuse')
    assert all(name + ' (enforce)' in loaded() for name in names)
def enter(image, *args):
    # Exercise the kernel transition directly; aa-exec is an optional utility
    # and is not a prerequisite of the installed native launcher.
    code = 'import os,sys;f=os.open("/proc/self/attr/current",os.O_WRONLY);os.write(f,("changeprofile "+sys.argv[1]).encode());os.close(f);os.execv(sys.argv[2],sys.argv[2:])'
    return subprocess.Popen(['/usr/bin/python3', '-I', '-c', code, tools, str(image), *args])
try:
    owner = enter('/bin/sleep', '30')
    for unused in range(100):
        if tools in Path(f'/proc/{owner.pid}/attr/current').read_text() and Path(f'/proc/{owner.pid}/exe').resolve() == Path('/bin/sleep').resolve(): break
        time.sleep(.02)
    else: raise AssertionError('synthetic tool never entered policy')
    assert Path(f'/proc/{owner.pid}/exe').resolve() == Path('/bin/sleep').resolve()
    refusal(lambda: installer.reclaim_stopped_linux_profiles(uid, runtime), 'surviving tools')
    passed.append('tool-only survivor retains vendor and tool profiles')
    owner.terminate(); owner.wait(timeout=5); owner = None
    source = runtime / 'worker.c'; image = runtime / 'worker'
    source.write_text('#include <pthread.h>\n#include <unistd.h>\nstatic void *work(void *p){(void)p;sleep(30);return 0;}\nint main(void){pthread_t t;if(pthread_create(&t,0,work,0))return 1;pthread_exit(0);}\n')
    subprocess.run(['/usr/bin/gcc', '-Wall', '-Wextra', '-Werror', '-pthread', str(source), '-o', str(image)], check=True, capture_output=True)
    owner = enter(image)
    for unused in range(100):
        state = Path(f'/proc/{owner.pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
        if state == 'Z': break
        time.sleep(.02)
    else: raise AssertionError('synthetic thread leader did not exit')
    try: installer.reclaim_stopped_linux_profiles(uid, runtime)
    except RuntimeError as error:
        assert any(reason in str(error) for reason in ['surviving tools', 'task inventory is unavailable', 'label is unavailable', 'label is unreadable']), str(error)
    else: raise AssertionError('surviving thread lost its profiles')
    assert all(name + ' (enforce)' in loaded() for name in names)
    passed.append('exited leader with live worker retains both profiles')
    owner.terminate(); owner.wait(timeout=5); owner = None
    original = Path.read_text
    def unreadable(file, *args, **kwargs):
        if str(file) == f'/proc/{os.getpid()}/task/{os.getpid()}/attr/current':
            raise PermissionError(13, 'synthetic unreadable task')
        return original(file, *args, **kwargs)
    with patch.object(Path, 'read_text', unreadable):
        refusal(lambda: installer.reclaim_stopped_linux_profiles(uid, runtime), 'label is unreadable')
    passed.append('unknown live label retains policies')
    original_run = subprocess.run
    locked_during_removal = []
    def check_lock(args, *positional, **kwargs):
        if args[:2] == [parser, '-R']:
            probe = os.open(runtime / 'policy.lock', os.O_RDONLY)
            try:
                try: fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError: locked_during_removal.append(True)
                else: raise AssertionError('reclamation did not hold native policy lock')
            finally: os.close(probe)
        return original_run(args, *positional, **kwargs)
    with patch.object(subprocess, 'run', check_lock):
        result = installer.reclaim_stopped_linux_profiles(uid, runtime)
    assert result == {'removedProfiles': 2}
    assert locked_during_removal == [True]
    assert main + ' (enforce)' not in loaded() and tools + ' (enforce)' not in loaded()
    assert all(name + ' (enforce)' in loaded() for name in [unrelated, other_user])
    passed.append('stopped pair reclaimed under policy lock; unrelated and other-user policies retained')
    assert installer.reclaim_stopped_linux_profiles(uid, runtime) == {'removedProfiles': 0}
    passed.append('empty repeated reclamation is harmless')
    print(json.dumps({'passed': passed, 'count': len(passed), 'vendorExecuted': False}))
finally:
    if owner:
        owner.terminate(); owner.wait(timeout=5)
    remaining = [name for name in names if name + ' (enforce)' in loaded()]
    if remaining:
        subprocess.run([parser, '-R', '-T'], input=''.join('profile ' + name + ' {}\n' for name in remaining),
                       text=True, check=True, capture_output=True)
    for file in runtime.iterdir(): file.unlink()
    runtime.rmdir()
