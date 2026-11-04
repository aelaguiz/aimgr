#!/usr/bin/env python3
"""Actual kernel stop/exit proof on isolated Linux and Mac, synthetic children."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--helper', required=True)
parser.add_argument('--timeout-case', action='store_true')
args = parser.parse_args()
assert os.getuid() != 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()

def stop(child, image):
    return subprocess.run([args.helper, str(child.pid), str(image)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35, text=True)

children = []
try:
    unrelated = subprocess.Popen(['/bin/sleep', '60'])
    canary = uuid.uuid4().hex
    # Apple platform binaries hide their environment from KERN_PROCARGS2.
    # Use our unsigned fixture process, without changing SIP or signatures.
    target = subprocess.Popen([sys.executable, '-I', '-c',
        'import time; print("ready", flush=True); time.sleep(60)'], stdout=subprocess.PIPE,
        text=True, env=dict(os.environ, CODEX_HOME='/synthetic/codex-home', AIMGR_PRIVATE_CANARY=canary))
    assert target.stdout.readline().strip() == 'ready'
    children += [unrelated, target]
    refused = stop(target, '/synthetic/not-the-selected-image')
    assert refused.returncode == 125
    assert target.poll() is None and unrelated.poll() is None
    inventory = subprocess.run([args.helper, '--inventory'], capture_output=True, text=True, check=True)
    assert canary not in inventory.stdout and inventory.stderr == ''
    selected = next(item for item in json.loads(inventory.stdout) if item['pid'] == target.pid)
    assert 'environment' not in selected and '/synthetic/codex-home' not in inventory.stdout
    assert selected['environment_visible'] and not selected['native_installer']
    wrong_birth = subprocess.run([args.helper, str(target.pid), selected['image'], 'different-lifetime'], capture_output=True)
    assert wrong_birth.returncode == 125 and target.poll() is None
    print('PASS: private inventory omits other environment values and stale birth identity refuses signaling')
    result = stop(target, selected['image'])
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() in ('exited', 'gone')
    target.wait(timeout=2)
    assert unrelated.poll() is None, 'an unrelated same-user process must survive'
    print('PASS: wrong image refused, selected lifetime exited, unrelated child survived')
    if args.timeout_case:
        resistant = subprocess.Popen([sys.executable, '-I', '-c',
            'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(60)'],
            stdout=subprocess.PIPE, text=True)
        children.append(resistant)
        assert resistant.stdout.readline().strip() == 'ready'
        result = stop(resistant, Path(sys.executable).resolve())
        assert result.returncode == 125
        assert resistant.poll() is None
        print('PASS: a nonexiting owner refuses maintenance without PID-based escalation')
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
