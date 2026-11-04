"""Synthetic proof that atomic exchange retains an intervening writer's inode.

This is not the production journal/recovery implementation. Uses only a temporary
directory; never reads user settings or invokes a vendor client.
"""
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import sys
import tempfile

libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
if sys.platform == 'darwin':
    rename = libc.renameatx_np
    at_fdcwd, exchange_flag = -2, 2  # AT_FDCWD, RENAME_SWAP
elif sys.platform.startswith('linux'):
    rename = libc.renameat2
    at_fdcwd, exchange_flag = -100, 2  # AT_FDCWD, RENAME_EXCHANGE
else:
    raise RuntimeError('Proof is scoped to macOS and Linux')
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                   ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int

def exchange(left, right):
    if rename(at_fdcwd, os.fsencode(left), at_fdcwd, os.fsencode(right), exchange_flag):
        raise OSError(ctypes.get_errno(), 'atomic exchange failed')

with tempfile.TemporaryDirectory(prefix='aimgr-settings-exchange-') as root:
    source, staged = Path(root) / 'source.toml', Path(root) / 'staged.toml'
    source.write_text('original')
    expected = source.read_bytes()
    staged.write_text('candidate')
    source.write_text('concurrent-edit')  # After the adapter's initial read.
    exchange(source, staged)
    assert source.read_text() == 'candidate'
    assert staged.read_text() == 'concurrent-edit'
    assert staged.read_bytes() != expected  # Detect the race; retain this version.

    fd = os.open(source, os.O_WRONLY)
    try:
        exchange(source, staged)
        os.ftruncate(fd, 0)
        os.write(fd, b'open-inode-edit')
    finally:
        os.close(fd)
    assert staged.read_text() == 'open-inode-edit'

print(json.dumps(dict(platform=sys.platform, atomic_exchange='pass',
    raced_version_retained='pass', open_displaced_inode_write_retained='pass',
    vendor_execution=False, real_settings_touched=False), indent=2))
