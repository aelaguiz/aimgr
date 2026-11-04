#!/usr/bin/env python3
"""Finite File-to-Direct transaction owner. Never runs during ordinary launch.

The command owner supplies inventory/configuration through private JSON pipes.
This process owns the actual setup, refresh and File locks, including when its
AIM parent dies. Mutating keyring children inherit those locks and are never
terminated for a slow response. The native child receipt fences unknown writes.
"""
import ctypes
import ctypes.util
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import uuid

_state_spec = importlib.util.spec_from_file_location('aimgr_state_io', Path(__file__).with_name('state_io.py'))
state_io = importlib.util.module_from_spec(_state_spec)
_state_spec.loader.exec_module(state_io)

MAX_PRIVATE_BYTES = 16 * 1024 * 1024

class MaintenanceError(Exception):
    pass


def private(fd, directory=False):
    info = os.fstat(fd)
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 \
            or (not directory and info.st_nlink != 1):
        raise MaintenanceError('Maintenance state is not private to this OS user.')
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        libc.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
        libc.acl_get_fd_np.restype = ctypes.c_void_p
        libc.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
        libc.acl_get_tag_type.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        libc.acl_valid.argtypes = [ctypes.c_void_p]
        libc.acl_free.argtypes = [ctypes.c_void_p]
        acl = libc.acl_get_fd_np(fd, 0x100)
        if not acl and ctypes.get_errno() == 2:
            return
        if not acl:
            raise MaintenanceError('Maintenance ACL is unreadable.')
        try:
            if libc.acl_valid(acl):
                raise MaintenanceError('Maintenance ACL is invalid.')
            entry, tag, index = ctypes.c_void_p(), ctypes.c_int(), 0
            while libc.acl_get_entry(acl, index, ctypes.byref(entry)) == 0:
                index = 1
                if libc.acl_get_tag_type(entry, ctypes.byref(tag)) or tag.value != 2:
                    raise MaintenanceError('Maintenance ACL grants access to another identity.')
        finally:
            libc.acl_free(acl)


def read_private(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        private(fd)
        if os.fstat(fd).st_size > MAX_PRIVATE_BYTES:
            raise MaintenanceError('Maintenance input is too large.')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def durable(file, data, exclusive=False):
    # Recovery must be able to read every successfully persisted record. Check
    # before replacing the old journal or dispatching any native write.
    if len(data) > MAX_PRIVATE_BYTES:
        raise MaintenanceError('Maintenance state exceeds its supported size; no credential import was dispatched.')
    temporary = file.with_name('.' + file.name + '-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        private(fd)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    if exclusive:
        # Never expose a short backup under its final name. No-replace rename
        # also avoids a crash leaving two hard links to a private record.
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        rename, cwd, flag = (libc.renameatx_np, -2, 4) if sys.platform == 'darwin' else (libc.renameat2, -100, 1)
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(cwd, os.fsencode(temporary), cwd, os.fsencode(file), flag):
            raise OSError(ctypes.get_errno(), 'exclusive backup publication failed')
    else:
        os.replace(temporary, file)
    state_io.flush_parent(file)


def json_bytes(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def boot_id():
    if sys.platform.startswith('linux'):
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    else:
        value = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True).strip().lower()
    if str(uuid.UUID(value)) != value:
        raise MaintenanceError('Cannot establish the current maintenance boot.')
    return value


def intent_hash(name, url, token, access=None):
    fields = [value.encode() for value in (name, url, token)]
    if access is not None:
        fields.append((access['executable'] + '\0' + access['sha256']).encode())
    return hashlib.sha256(b''.join(len(field).to_bytes(8, 'big') + field for field in fields)).hexdigest()


class Maintenance:
    def __init__(self, request):
        if os.getuid() == 0 or os.getuid() != os.geteuid():
            raise MaintenanceError('Run MCP maintenance as the actual Codex OS user.')
        os.umask(0o077)
        self.request = request
        self.base = Path(f'/opt/aimgr-codex-runtime/users/{os.getuid()}/maintenance')
        fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            private(fd, directory=True)
        finally:
            os.close(fd)
        self.pending = self.base / 'pending.json'
        self.journal_file = self.base / 'transaction.json'
        self.locks = []
        self.setup_lock = None
        self.journal = None

    def lock(self, file, seconds=60):
        fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            # Native lock files may be 0644; they contain no credentials.
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022:
                raise MaintenanceError('A native credential lock is unsafe.')
            deadline = time.monotonic() + seconds
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.locks.append(fd)
                    return fd
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise MaintenanceError('An existing credential operation is still running. Maintenance remains pending.')
                    time.sleep(0.05)
        except BaseException:
            os.close(fd)
            raise

    def save(self):
        durable(self.journal_file, json_bytes(self.journal))

    def owner(self, operation, **values):
        # Fixed AIM code, no arbitrary command from the persisted journal.
        process = subprocess.run([self.request['node'], self.request['owner_script']],
                                 input=json_bytes(dict(operation=operation, lock_fds=self.locks, **values)),
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 pass_fds=tuple(self.locks), env=os.environ)
        try:
            result = json.loads(process.stdout)
        except (ValueError, UnicodeError):
            raise MaintenanceError('MCP maintenance could not complete its configuration/control operation.') from None
        if process.returncode or result.get('error'):
            raise MaintenanceError(result.get('error', 'MCP maintenance configuration/control operation failed.'))
        return result

    def keyring(self, operation, item):
        value = dict(operation=operation, server_name=item['serverName'], url=item['url'])
        if operation == 'insert-if-absent':
            access = self.journal['plan'].get('native_access')
            if access is not None:
                value['native_access'] = access
            value.update(value=item['value'], maintenance=dict(operation_id=item['operation_id'],
                         intent_sha256=intent_hash(item['serverName'], item['url'], item['value'], access),
                         boot_id=boot_id(), lock_fds=self.locks))
        # No timeout/kill: the child must retain locks through backend return
        # and durable acknowledgement even when AIM or this owner disappears.
        process = subprocess.run([self.request['keyring']], input=json_bytes(value),
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 pass_fds=tuple(self.locks), env=os.environ)
        try:
            result = json.loads(process.stdout)
        except (ValueError, UnicodeError):
            raise MaintenanceError('Keyring maintenance ended without a readable result. Recover the pending operation.') from None
        if process.returncode or result.get('error'):
            code = result.get('error')
            if code == 'maintenance_unknown_write':
                raise MaintenanceError('An interrupted keyring write has no completion acknowledgement. Recovery requires a later machine boot.')
            if code == 'maintenance_conflict':
                raise MaintenanceError('The keyring contains a different credential. It was preserved; maintenance remains pending.')
            raise MaintenanceError('The native keyring is unavailable or could not verify the credential. The File store remains preserved.')
        return result

    def admission(self, pending):
        fd = os.open(self.base.parent / 'admission.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            private(fd)
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise MaintenanceError('A Codex launch is still crossing admission. Retry maintenance after it finishes.')
                    time.sleep(0.05)
            if pending:
                if self.pending.exists() and json.loads(read_private(self.pending)).get('operation_id') != self.journal['operation_id']:
                    raise MaintenanceError('Pending maintenance belongs to another transaction.')
                durable(self.pending, json_bytes(dict(schema=1, operation_id=self.journal['operation_id'])))
            elif self.pending.exists():
                marker = json.loads(read_private(self.pending))
                if marker.get('operation_id') != self.journal['operation_id']:
                    raise MaintenanceError('Pending maintenance belongs to another transaction.')
                self.pending.unlink()
                state_io.flush_parent(self.pending)
        finally:
            os.close(fd)

    def finish(self):
        # Commit comes first. Once admissions reopen, token refresh/logout may
        # run; recovery from here must never inspect/replay the old tokens.
        # Keep only the setup lock through the final admission update.
        for fd in self.locks[:]:
            if fd != self.setup_lock:
                os.close(fd)
                self.locks.remove(fd)
        self.admission(False)
        self.journal['finished'] = True
        self.save()

    def run(self):
        self.setup_lock = self.lock(self.base / 'setup.lock')
        if self.journal_file.exists():
            self.journal = json.loads(read_private(self.journal_file))
            if self.journal.get('schema') != 1:
                raise MaintenanceError('Unsupported maintenance journal; no changes were made.')
            if self.journal.get('committed'):
                if not self.journal.get('finished'):
                    self.finish()
                    return
                if self.request['operation'] == 'recover':
                    return
                os.rename(self.journal_file, self.base / ('completed-' + self.journal['operation_id'] + '.json'))
                state_io.flush_parent(self.journal_file)
                self.journal = None
        if self.journal is None:
            if self.request['operation'] == 'recover':
                raise MaintenanceError('No MCP maintenance transaction needs recovery.')
            if self.pending.exists():
                raise MaintenanceError('Pending maintenance has no readable transaction journal.')
            plan = self.owner('plan', source_home=self.request['source_home'], config_state=self.request['config_state'],
                              artifact_set=self.request['artifact_set'], managed=self.request.get('managed', {}),
                              native_access=self.request.get('native_access'),
                              process_control=self.request['process_control'], state_io=self.request['state_io'],
                              cwd=self.request['cwd'], home=self.request['home'])
            # Check the real keyring before publishing pending maintenance.
            # A read of a fresh ordinary key changes nothing.
            self.keyring('load', dict(serverName='aimgr-maintenance-probe-' + uuid.uuid4().hex, url='https://invalid.invalid/'))
            self.journal = dict(schema=1, operation_id=uuid.uuid4().hex, source_home=plan['source_home'],
                                plan=plan, intents=None, committed=False, finished=False)
            self.save()
        self.admission(True)
        # A pre-maintenance admission may have crossed between the initial
        # inventory and publishing pending. Reinventory under pending, before
        # taking refresh locks, including on recovery.
        self.journal['plan'] = self.owner('recheck', plan=self.journal['plan'])
        self.save()
        plan = self.journal['plan']
        # No process or schedule is stopped. Supported AIM launches observe
        # pending before selection and at native exec; external raw launches
        # must remain stopped for this explicit one-time conversion.
        for directory in plan['lock_directories']:
            Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)
        for file in plan['refresh_locks']:
            self.lock(Path(file))
        self.lock(Path(plan['file_lock']))
        source = Path(plan['source_file'])
        backup = self.base / ('file-before-' + self.journal['operation_id'] + '.json')
        if self.journal['intents'] is None:
            original = read_private(source) if source.exists() else b'{}'
            prepared = self.owner('intent', plan=plan, file=original.decode())
            intents = []
            for item in prepared['items']:
                existing = self.keyring('load', item)['value']
                normalized = self.owner('destination', item=item, existing=existing)
                item.update(value=normalized['value'], operation_id=uuid.uuid4().hex)
                self.owner('validate', plan=plan, value=item['value'])
                intents.append(item)
            if backup.exists():
                if read_private(backup) != original:
                    raise MaintenanceError('Interrupted migration preserved a different original File store.')
            else:
                durable(backup, original, exclusive=True)
            self.journal.update(intents=intents, source_sha256=hashlib.sha256(original).hexdigest(), backup=str(backup))
            self.save()
        if source.exists() and hashlib.sha256(read_private(source)).hexdigest() != self.journal['source_sha256']:
            raise MaintenanceError('The original MCP File store changed. Both versions were preserved; maintenance remains pending.')
        for item in self.journal['intents']:
            result = self.keyring('insert-if-absent', item)
            if result.get('value') != item['value']:
                raise MaintenanceError('Native keyring readback differed from the immutable migration intent.')
        self.owner('publish', plan=plan, transaction=self.journal['operation_id'])
        if source.exists():
            if hashlib.sha256(read_private(source)).hexdigest() != self.journal['source_sha256']:
                raise MaintenanceError('The File store changed before retirement; maintenance remains pending.')
            source.unlink()
            state_io.flush_parent(source)
        self.owner('verify', plan=plan)
        self.journal['committed'] = True
        self.save()
        self.finish()

    def close(self):
        for fd in reversed(self.locks):
            os.close(fd)
        self.locks.clear()


def main():
    owner = None
    try:
        request = json.loads(sys.stdin.buffer.read(1024 * 1024 + 1))
        if request.get('operation') not in ('start', 'recover'):
            raise MaintenanceError('Choose MCP migration or recovery explicitly.')
        owner = Maintenance(request)
        owner.run()
        print(json.dumps(dict(ok=True)))
    except MaintenanceError as error:
        print(json.dumps(dict(error=str(error))))
        return 1
    except Exception:
        # Parsed files/OS exceptions can contain tokens or private paths.
        print(json.dumps(dict(error='MCP maintenance could not finish. Its private journal and original credentials were preserved.')))
        return 1
    finally:
        if owner:
            owner.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
