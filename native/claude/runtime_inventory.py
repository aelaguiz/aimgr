#!/usr/bin/env python3
"""Read kernel executable identities, never vendor argv/environment or --version.

Status is observational. A racing exit is harmless; an unreadable live native
owner makes inventory incomplete, never a claim that no owners are running.
This helper does not signal processes or authorize any build (T02/T23).
"""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def claude_candidate(image):
    return Path(image).name.startswith('claude') or '/claude/versions/' in image


def inventory():
    rows = []
    unknown = 0
    if sys.platform not in ('darwin', 'linux'):
        raise RuntimeError('unsupported process inventory')
    output = subprocess.run(['/bin/ps', '-axo', 'pid=,uid=,comm='], check=True,
                            capture_output=True, text=True).stdout
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True) if sys.platform == 'darwin' else None
    for line in output.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3 or int(fields[1]) != os.getuid():
            continue
        pid, name = int(fields[0]), fields[2]
        try:
            if libproc:
                buf = ctypes.create_string_buffer(4096)
                length = libproc.proc_pidpath(pid, buf, len(buf))
                if length <= 0:
                    if claude_candidate(name): unknown += 1
                    continue
                image = os.fsdecode(buf.value)
            else:
                image = os.readlink('/proc/' + str(pid) + '/exe')
        except FileNotFoundError:
            continue
        except PermissionError:
            if claude_candidate(name): unknown += 1
            continue
        match = re.fullmatch(r'/opt/aimgr-claude-runtime/artifacts/([a-f0-9]{64})/claude', image)
        if match:
            rows.append({'pid': pid, 'artifactSet': match.group(1)})
        elif claude_candidate(name) or claude_candidate(image):
            # Do not expose personal installation paths in text/JSON status.
            rows.append({'pid': pid, 'artifactSet': None})
    return {'complete': unknown == 0, 'unreadableOwners': unknown, 'processes': rows}


if __name__ == '__main__':
    try:
        print(json.dumps(inventory()))
    except Exception:
        print(json.dumps({'complete': False, 'reason': 'process inventory unavailable', 'processes': []}))
        sys.exit(1)
