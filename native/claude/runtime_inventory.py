#!/usr/bin/env python3
"""Read kernel executable identities and classify roles without running Claude.

Status is observational. A racing exit is harmless; an unreadable live native
owner makes inventory incomplete, never a claim that no owners are running.
This helper does not signal processes or authorize any build (T02/T23).
"""
import ctypes
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys


def claude_candidate(image):
    return Path(image).name.startswith('claude') or '/claude/versions/' in image


# Read argv only to classify an executable already identified as Claude. Never
# emit arguments, personal paths or the environment. KERN_PROCARGS2 includes
# environment bytes after argc strings: stop at argc, not at the buffer end.
# Role is observational and never authority to signal/approve a process.
def mac_argv(blob):
    if len(blob) < 4: raise ValueError('missing argc')
    argc = struct.unpack_from('i', blob)[0]
    if not 1 <= argc <= 65536: raise ValueError('invalid argc')
    offset = blob.index(b'\0', 4) + 1  # executable path precedes argv
    while offset < len(blob) and blob[offset] == 0: offset += 1
    args = []
    for _ in range(argc):
        end = blob.index(b'\0', offset)
        args.append(os.fsdecode(blob[offset:end]))
        offset = end + 1
    return args


def process_argv(pid):
    if sys.platform == 'linux':
        with open('/proc/' + str(pid) + '/cmdline', 'rb') as source:
            blob = source.read(2 * 1024 * 1024 + 1)
        if not blob or len(blob) > 2 * 1024 * 1024 or not blob.endswith(b'\0'):
            raise ValueError('incomplete argv')
        return [os.fsdecode(part) for part in blob[:-1].split(b'\0')]
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
    # macOS rejects KERN_PROCARGS2 buffers larger than kern.argmax (EINVAL),
    # even when the actual command is tiny. Use the OS limit, bounded locally.
    maximum = os.sysconf('SC_ARG_MAX')
    if not 1 <= maximum <= 2 * 1024 * 1024:
        raise ValueError('unsupported argv bound')
    buffer = ctypes.create_string_buffer(maximum)
    size = ctypes.c_size_t(len(buffer))
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), 'argv unavailable')
    return mac_argv(buffer.raw[:size.value])


def process_role(argv):
    if not argv: return 'unknown'
    args = argv[1:]
    while args and args[0] in ('--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'):
        args = args[1:]
    if args[:2] == ['daemon', 'run']: return 'detached-supervisor'
    if args and args[0] in ('--bg-pty-host', '--bg-spare', '--daemon-worker', '--preload'):
        return 'detached-worker'
    # Bare daemon/default-origin forms can become supervisors depending on
    # stdin/state. Do not infer a foreground session or duplicate that parser.
    if args and (args[0] == 'daemon' or args[0].startswith(('--bg-', '--daemon-', '--preload'))):
        return 'unknown'
    return 'session'


def observed_role(pid):
    try: return process_role(process_argv(pid))
    except (OSError, ValueError): return 'unknown'


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
            rows.append({'pid': pid, 'artifactSet': match.group(1), 'role': observed_role(pid)})
        elif claude_candidate(name) or claude_candidate(image):
            # Do not expose personal installation paths in text/JSON status.
            rows.append({'pid': pid, 'artifactSet': None, 'role': observed_role(pid)})
    return {'complete': unknown == 0, 'unreadableOwners': unknown, 'processes': rows}


if __name__ == '__main__':
    try:
        print(json.dumps(inventory()))
    except Exception:
        print(json.dumps({'complete': False, 'reason': 'process inventory unavailable', 'processes': []}))
        sys.exit(1)
