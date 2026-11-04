#!/usr/bin/env python3
"""Unprivileged file operations needing native flock/exchange semantics.

Invoked synchronously by AIM, never a service. Secrets enter only on stdin.
The installed copy belongs to the approved package; this helper never execs Codex.
"""
import ctypes
import ctypes.util
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid


def flush_parent(path, allow_unreadable=False):
    try:
        fd = os.open(str(Path(path).parent), os.O_RDONLY)
    except PermissionError:
        if allow_unreadable:
            return False
        raise
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return True


def exchange(left, right, allow_unreadable=False):
    libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
    if sys.platform == 'darwin':
        rename, cwd, flag = libc.renameatx_np, -2, 2
    elif sys.platform.startswith('linux'):
        rename, cwd, flag = libc.renameat2, -100, 2
    else:
        raise RuntimeError('Unsupported platform for atomic settings exchange')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(cwd, os.fsencode(left), cwd, os.fsencode(right), flag):
        raise OSError(ctypes.get_errno(), 'atomic exchange failed')
    synced = flush_parent(left, allow_unreadable)
    if Path(left).parent != Path(right).parent:
        synced = flush_parent(right, allow_unreadable) and synced
    return synced


def private_record(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise RuntimeError('Invalid private state file')
    return file.read_text()


def atomic_json(file, value):
    staged = str(file) + '.aim-' + str(uuid.uuid4())
    try:
        fd = os.open(staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staged, file)
        flush_parent(file)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def check_replaceable(target):
    # Match native primary-auth file storage: readonly mode, multiple links,
    # and a file ACL that denies writing all prohibit replacing existing auth.
    if not target.exists():
        return
    info = target.stat()
    if info.st_mode & 0o222 == 0 or info.st_nlink > 1:
        raise PermissionError('Primary auth is not replaceable')
    fd = os.open(target, os.O_WRONLY | os.O_NOFOLLOW)
    os.close(fd)


def settings_replaceable(file):
    """Permission check for native NamedTempFile + persist, not in-place write.

    Native may replace a mode-0400 file if the directory allows it. Directory
    ACLs, sticky ownership and immutable/append flags still govern replacement.
    No temporary write to the user's source is needed to answer this check.
    """
    target = Path(file)
    parent = target.parent
    if not os.access(parent, os.W_OK | os.X_OK):
        return False
    objects = [(parent, parent.stat())]
    try:
        objects.append((target, target.stat()))
    except FileNotFoundError:
        pass
    if sys.platform == 'darwin':
        # accessx_np uses Darwin's extended permission bits, including add_file
        # and delete/delete_child rather than POSIX's coarse W_OK.
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        class Descriptor(ctypes.Structure):
            _fields_ = [('name_offset', ctypes.c_uint32), ('flags', ctypes.c_int), ('pad', ctypes.c_int * 2)]
        libc.accessx_np.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_int), ctypes.c_uint]
        libc.accessx_np.restype = ctypes.c_int
        def accessx(p, flags):
            name = os.fsencode(p) + b'\0'
            data = ctypes.create_string_buffer(ctypes.sizeof(Descriptor) + len(name))
            descriptor = Descriptor.from_buffer(data)
            descriptor.name_offset, descriptor.flags = ctypes.sizeof(Descriptor), flags
            ctypes.memmove(ctypes.addressof(data) + descriptor.name_offset, name, len(name))
            result = ctypes.c_int(-1)
            return libc.accessx_np(data, ctypes.sizeof(data), ctypes.byref(result), os.getuid()) == 0 and result.value == 0
        if not accessx(parent, 1 << 10):
            return False
        if len(objects) == 2 and not (accessx(target, 1 << 12) or accessx(parent, 1 << 14)):
            return False
        return all(not (getattr(info, 'st_flags', 0) & (0x2 | 0x4 | 0x20000 | 0x40000)) for _, info in objects)
    if sys.platform.startswith('linux'):
        if len(objects) == 2 and objects[0][1].st_mode & stat.S_ISVTX and os.getuid() not in (0, objects[0][1].st_uid, objects[1][1].st_uid):
            return False
        # statx is path based: replacement needs write/search on the parent,
        # not permission to list it or open the old file for data access.
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        libc.statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
        libc.statx.restype = ctypes.c_int
        for p, _ in objects:
            data = ctypes.create_string_buffer(256)  # Linux's fixed statx ABI.
            if libc.statx(-100, os.fsencode(p), 0, 0x7ff, data):
                raise OSError(ctypes.get_errno(), 'settings permission inspection failed')
            attributes = int.from_bytes(data.raw[8:16], sys.byteorder)
            supported = int.from_bytes(data.raw[56:64], sys.byteorder)
            if attributes & supported & (0x10 | 0x20):  # STATX_ATTR_IMMUTABLE / APPEND
                return False
            if os.statvfs(p).f_flag & os.ST_RDONLY:
                return False
        return True
    raise RuntimeError('Unsupported settings permission platform')


def auth_commit(request):
    # The admitted native release locks CODEX_HOME/auth.lock. Each private
    # home links that name to this stable account-wide inode.
    target = Path(request['path']).resolve(strict=False)
    owner_expected = request['owner']
    if target.name != 'auth.json' or target.parent != Path(request['accountRoot']).resolve():
        raise RuntimeError('Primary auth target is outside its account')
    lock = os.open(target.parent / 'auth.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('Invalid primary auth lock')
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Primary auth lock timed out')
                time.sleep(0.025)
        owner = json.loads(private_record(target.parent / 'owner.json'))
        if owner != owner_expected or owner.get('schema') != 1:
            raise RuntimeError('Primary auth environment ownership mismatch')
        current = private_record(target) if target.exists() else None
        grant_file = target.parent / 'grant.json'
        grant_raw = private_record(grant_file) if grant_file.exists() else None
        expected = request.get('expected')
        mode = request['mode']
        grant = json.loads(grant_raw) if grant_raw is not None else None
        expected_grant = json.loads(request['expectedGrant']) if request.get('expectedGrant') else None
        # A failed concurrent refresh must not discard the successful response
        # for that same original token generation. Login/logout still change
        # the grant identity and defeat this comparison.
        grant_matches = grant_raw == request.get('expectedGrant')
        if mode == 'refresh' and grant and expected_grant:
            grant_matches = ({k: v for k, v in grant.items() if k != 'failedGeneration'} ==
                             {k: v for k, v in expected_grant.items() if k != 'failedGeneration'})
        if current != expected or not grant_matches:
            # Reload the exact local generation; never publish it to Redis.
            # Network work happens before this short native-compatible lock.
            return {'committed': False, 'reason': 'changed'}
        if mode != 'login' and (not grant or grant.get('environmentId') != owner['environmentId'] or
                                grant.get('accountId') != owner['accountId'] or grant.get('source') != 'manual-oauth'):
            raise RuntimeError('No independently authorized local grant')
        if current is not None:
            parsed = json.loads(current)
            if parsed.get('tokens', {}).get('account_id') != owner['accountId']:
                raise RuntimeError('Refusing foreign primary auth replacement')
        if mode == 'invalidate':
            grant['failedGeneration'] = hashlib.sha256((current or '').encode()).hexdigest()
            atomic_json(grant_file, grant)
            return {'committed': True, 'changed': True}
        check_replaceable(target)
        if mode == 'logout':
            if current is not None:
                target.unlink()
                flush_parent(target)
            grant_file.unlink()
            flush_parent(grant_file)
            return {'committed': True, 'changed': current is not None}
        if mode not in ('login', 'refresh'):
            raise RuntimeError('Unknown primary auth mutation')
        payload = request['value']
        if payload.get('tokens', {}).get('account_id') != owner['accountId']:
            raise RuntimeError('Primary auth account mismatch')
        if mode == 'login':
            login_owner = str(uuid.uuid4())
            payload['tokens']['login_owner_id'] = login_owner
            # Remove stale provenance BEFORE replacing auth: interruption at
            # either boundary leaves an unproven grant, requiring a new login.
            if grant_file.exists():
                grant_file.unlink()
                flush_parent(grant_file)
            atomic_json(target, payload)
            atomic_json(grant_file, {**owner, 'source': 'manual-oauth', 'id': login_owner})
        else:
            # Native uses this identity to reject refreshes from an older
            # login, including another login to the same underlying account.
            payload = {**parsed, **payload, 'tokens': {**parsed['tokens'], **payload['tokens']}}
            # An issuer-specific proof about the previous refresh token is
            # not proof about this newly returned token.
            payload['tokens'].pop('oauth_provenance', None)
            atomic_json(target, payload)
            if 'failedGeneration' in grant:
                del grant['failedGeneration']
                atomic_json(grant_file, grant)
        return {'committed': True, 'changed': True}
    finally:
        os.close(lock)


def main():
    request = json.load(sys.stdin)
    operation = request['operation']
    if operation == 'exchange':
        synced = exchange(request['target'], request['staged'], request.get('allowUnreadableParent', False))
        return {'exchanged': True, 'directorySynced': synced}
    if operation == 'auth':
        return auth_commit(request)
    if operation == 'settings-replaceable':
        return {'writable': settings_replaceable(request['path'])}
    raise RuntimeError('Unknown state operation')


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        # Never echo settings, credentials or the stdin document in diagnostics.
        print(json.dumps({'error': type(error).__name__, 'errno': getattr(error, 'errno', None)}))
        sys.exit(1)
