#!/usr/bin/env python3
"""Actual kernel stop/exit proof on isolated Linux and Mac, synthetic children."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

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
    target = subprocess.Popen(['/bin/sleep', '60'])
    children += [unrelated, target]
    refused = stop(target, '/synthetic/not-the-selected-image')
    assert refused.returncode == 125
    assert target.poll() is None and unrelated.poll() is None
    result = stop(target, Path('/bin/sleep').resolve())
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
