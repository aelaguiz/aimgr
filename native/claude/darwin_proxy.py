#!/usr/bin/env python3
"""macOS native Claude routing. Existing Chrome/SSH owners are unchanged."""
import ctypes
import fcntl
import grp
import http.client
import json
import os
import pathlib
import pwd
import plistlib
import re
import select
import signal
import shutil
import subprocess
import sys
import time
import tempfile
import termios
import urllib.parse
from contextlib import contextmanager

ROOT = pathlib.Path('/opt/aimgr-claude-proxy')
IDENTITY = str(ROOT / 'darwin_identity')
LIBC = ctypes.CDLL(None, use_errno=True)


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def validate(name):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}', name) or name in ('direct', 'default', 'manifest', 'install') or name.endswith('-sing-box'):
        raise RuntimeError('invalid native proxy profile')
    return name


def state_dir(name):
    return ROOT / f'{validate(name)}-state'


def profile(name):
    return json.loads((ROOT / f'{validate(name)}.json').read_text())


@contextmanager
def lock(file, exclusive=False, nonblocking=False):
    with file.open('r') as descriptor:
        fcntl.flock(descriptor, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | (fcntl.LOCK_NB if nonblocking else 0))
        yield descriptor


def processes():
    # Compare owner creation times independently of the invoking shell's locale
    # and timezone. These overrides belong only to inventory, never the child.
    output = command(['/bin/ps', '-axo', 'pid=,uid=,gid=,stat=,lstart=,comm='],
                     env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'}, capture_output=True, text=True).stdout
    result = {}
    for line in output.splitlines():
        fields = line.split(None, 9)
        if len(fields) != 10:
            continue
        pid, uid, gid = map(int, fields[:3])
        if fields[3].startswith('Z'):
            continue
        result[pid] = {'uid': uid, 'gid': gid, 'state': fields[3], 'started': ' '.join(fields[4:9]), 'command': fields[9]}
    return result


def members(config):
    return [pid for pid, info in processes().items() if info['uid'] == config['uid'] and info['gid'] == config['gid']]


def require_stopped(name):
    if members(profile(name)):
        raise RuntimeError(f'Claude proxy {name} still has local native work. Stop it before changing the assignment')


def stop(name):
    config = profile(name)
    # An admission probe holds the shared lock. Stop current work immediately
    # when an owner exits, even while that probe is still pending; a restarted
    # SSH listener must never let interrupted sessions retry in that interval.
    mark_failed(name)
    for pid in members(config):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    with lock(ROOT / f'{name}.lock', exclusive=True):
        # Close admission before collecting descendants. Repeated scans include
        # ordinary fork races; no process-name or global-user kill is used.
        for _ in range(100):
            targets = members(config)
            if not targets:
                return
            for pid in targets:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(.025)
        raise RuntimeError('native profile did not stop completely')


def mark_failed(name):
    try:
        fd = os.open(state_dir(name) / 'failed', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except FileExistsError:
        pass


def publish_state(file, contents, mode):
    # The ordinary-user guardian must own this directory to mark failure.
    # Root must never truncate or chmod one of its replaceable pathnames:
    # write an exclusively created inode, set permissions through that FD,
    # then rename it over the destination without following a symlink.
    fd, staged = tempfile.mkstemp(prefix='.publish-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(contents)
            os.fchmod(stream.fileno(), mode)
        os.replace(staged, file)
    finally:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass


def listener_pid(port):
    output = command(['/usr/sbin/lsof', '-nP', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True).stdout
    pids = set(map(int, output.split()))
    if len(pids) != 1:
        raise RuntimeError('proxy listener is unavailable or ambiguous')
    return pids.pop()


def environment(pid):
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2.
    size = ctypes.c_size_t(1024 * 1024)
    buffer = ctypes.create_string_buffer(size.value)
    if LIBC.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        error = ctypes.get_errno()
        if error == 3:
            return None
        raise RuntimeError('cannot inspect an existing native Claude owner')
    raw = buffer.raw[:size.value]
    argc = int.from_bytes(raw[:4], sys.byteorder)
    offset = raw.find(b'\0', 4)
    if offset < 0:
        raise RuntimeError('invalid native owner arguments')
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    for _ in range(argc):
        offset = raw.find(b'\0', offset) + 1
        if offset == 0:
            raise RuntimeError('incomplete native owner arguments')
    return raw[offset:].split(b'\0')


# R3/R6: --bg can delegate to an existing daemon rather than inherit this new
# launcher's GID. Inspect live owners, including old binaries, aliased config
# directories and surviving workers; a roster alone is not authoritative.
# Regression: test/network/claude-native-background.test.js.
def require_existing_owners_routed(config, expected, env, *, require_stopped=False):
    config_dir = env.get('CLAUDE_CONFIG_DIR')
    if not config_dir:
        return
    command_path = expected.get('nativeCommand')
    target = str(pathlib.Path(command_path).resolve()) if command_path else None
    recorded = set()
    try:
        roster = json.loads((pathlib.Path(config_dir) / 'daemon/roster.json').read_text())
        recorded.add(roster.get('supervisorPid'))
        for worker in roster.get('workers', {}).values():
            recorded.update([worker.get('pid'), worker.get('replPid')])
    except (FileNotFoundError, ValueError, AttributeError):
        pass
    for pid, info in processes().items():
        if info['uid'] != config['uid']:
            continue
        native_owner = pathlib.Path(info['command']).name.startswith('claude') or info['command'] == target
        if not (native_owner or pid in recorded):
            continue
        try:
            values = environment(pid)
        except RuntimeError:
            if processes().get(pid, {}).get('started') != info['started']:
                continue  # The process exited or its PID was reused mid-scan.
            if native_owner:
                raise
            # A stale roster can refer to an unrelated recycled PID. It must
            # not make nondumpable ordinary processes a launch dependency.
            continue
        same_account = False
        for value in values or []:
            if value.startswith(b'CLAUDE_CONFIG_DIR='):
                candidate = os.fsdecode(value.split(b'=', 1)[1])
                try:
                    same_account = os.path.samefile(candidate, config_dir)
                except OSError:
                    same_account = os.path.realpath(candidate) == os.path.realpath(config_dir)
                break
        if same_account and require_stopped:
            raise RuntimeError('this account still has native Claude work; stop its sessions and background owners before identity migration')
        if same_account and info['gid'] != config['gid']:
            raise RuntimeError('this account still has native Claude work outside its assigned proxy; stop its existing sessions and background daemon before retrying')


# A PID alone is reusable. Require each recorded process lifetime and the
# failure marker; a replacement listener/service cannot revive this admission.
def current_ready(name, allow_starting=False):
    state = state_dir(name)
    if (state / 'failed').exists():
        raise RuntimeError('native proxy is stopped')
    if not allow_starting and (state / 'starting').exists():
        raise RuntimeError('native proxy has not completed its routing check')
    ready = json.loads((state / 'ready.json').read_text())
    live = processes()
    for owner in ready['owners']:
        if live.get(owner['pid'], {}).get('started') != owner['started']:
            raise RuntimeError('native proxy owner exited or was replaced')
    return ready


def run(name, expected, env_fd, argv):
    terminal = termios.tcgetattr(0) if os.isatty(0) else None
    try:
        return run_child(name, expected, env_fd, argv)
    finally:
        if terminal is not None:
            try:
                # A background shell job must not receive SIGTTOU here.
                if os.tcgetpgrp(0) == os.getpgrp():
                    termios.tcsetattr(0, termios.TCSANOW, terminal)
            except (OSError, termios.error):
                pass  # The controlling terminal may have disconnected.


def run_child(name, expected, env_fd, argv, *, replace_with_approved=False):
    config = profile(name)
    for key in ('socksHost', 'socksPort'):
        if config[key] != expected[key]:
            raise RuntimeError('native proxy binding changed before launch')
    if sorted(config['expectedExits']) != sorted(expected['expectedExits']):
        raise RuntimeError('native proxy binding changed before launch')
    os.lseek(env_fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(env_fd), 'rb') as source:
        env = dict(os.fsdecode(entry).split('=', 1) for entry in source.read().split(b'\0') if entry)
    inherited_fds = []
    for entry in os.listdir('/dev/fd'):
        if not entry.isdecimal() or int(entry) < 3:
            continue
        try:
            if not fcntl.fcntl(int(entry), fcntl.F_GETFD) & fcntl.FD_CLOEXEC:
                inherited_fds.append(int(entry))
        except OSError:
            pass  # /dev/fd's own enumeration descriptor has already closed.
    active_child = None
    pending_signal = None
    def forward(signum, _frame):
        nonlocal pending_signal
        if signum != signal.SIGWINCH:
            pending_signal = signum
        if active_child and active_child.poll() is None:
            try:
                active_child.send_signal(signum)
            except ProcessLookupError:
                pass
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGWINCH):
        signal.signal(signum, forward)
    def spawn_routed(command_args):
        nonlocal active_child
        if pending_signal:
            raise RuntimeError('native launch was cancelled before admission')
        read_fd, write_fd = os.pipe()
        try:
            inherited = [*inherited_fds, env_fd, write_fd]
            if env.get('NODE_CHANNEL_FD', '').isdecimal():
                inherited.append(int(env['NODE_CHANNEL_FD']))
            child = subprocess.Popen([IDENTITY, name, str(write_fd), str(env_fd), '--', *command_args], pass_fds=tuple(set(inherited)))
            active_child = child
            if pending_signal:
                child.kill()
                child.wait()
                raise RuntimeError('native launch was cancelled during admission')
            os.close(write_fd)
            write_fd = None
            if not select.select([read_fd], [], [], 8)[0] or os.read(read_fd, 1) != b'1':
                child.kill()
                child.wait()
                raise RuntimeError('native process could not enter its assigned route')
            return child
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
    probe_args = ['/usr/bin/python3', '-I', str(ROOT / 'darwin_proxy.py'), 'probe', name]
    # Hold shared admission through the actual routed probe and identity handshake.
    # The child must enter its routing GID before stop/reconfiguration can acquire
    # the exclusive lock; otherwise a late child could escape the stop inventory.
    with lock(ROOT / f'{name}.lock') as admission_lock:
        current_ready(name, allow_starting=argv == probe_args)
        require_existing_owners_routed(config, expected, env)
        # The service invokes this exact internal probe too. Avoid recursion;
        # every other command proves the native path before it can start.
        if argv != probe_args:
            checking = spawn_routed(probe_args)
            try:
                if checking.wait(timeout=8) != 0:
                    raise RuntimeError('native routing health check failed before launch')
            except subprocess.TimeoutExpired:
                checking.kill()
                checking.wait()
                raise RuntimeError('native routing health check timed out before launch')
        current_ready(name, allow_starting=argv == probe_args)
        if replace_with_approved:
            # The hardened launcher reaches this role with a minimal routing
            # environment and a separate unopened vendor-environment FD. Keep
            # the supervisor's child PID: a waiting Python wrapper would make
            # SIGSTOP pause that wrapper while Claude kept sending requests.
            # Preserve admission through identity's GID change; final policy
            # entry closes this lock and all other non-stdio descriptors.
            # After the bounded probe, this PID is the payload. Do not consume
            # a TERM in a Python handler between the pending check and exec:
            # that would start Claude after cancellation until KILL escalated.
            active_child = None
            for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(signum, signal.SIG_DFL)
            if pending_signal:
                raise RuntimeError('native launch was cancelled before admission')
            os.set_inheritable(admission_lock.fileno(), True)
            read_fd, write_fd = os.pipe()
            os.set_inheritable(read_fd, True)
            os.set_inheritable(write_fd, True)
            os.set_inheritable(env_fd, True)
            # The fixed identity helper writes its normal success handshake.
            # This exec chain does not need a second observer: its own exit
            # remains the supervisor's child exit. Retain the read end until
            # final entry so the write cannot fail with SIGPIPE.
            os.execv(IDENTITY, [IDENTITY, name, str(write_fd), str(env_fd), '--', *argv])
        child = spawn_routed(argv)
    code = child.wait()
    if (state_dir(name) / 'failed').exists():
        raise RuntimeError('tunnel or native proxy failed; affected work was stopped')
    return code if code >= 0 else 128 - code


# R6: this ordinary-user guardian survives the launcher's exit and root service
# death, and watches exact owner exits through kqueue. It stops detached native
# work even when the normal health loop can no longer run. It never reconnects.
# Regressions: claude-native-macos.test.js and claude-native-background.test.js.
def guardian(name, monitor, adapter, tunnel, ready_fd):
    config = profile(name)
    os.setsid()
    user = pwd.getpwuid(config['uid'])
    os.initgroups(user.pw_name, user.pw_gid)
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    queue = select.kqueue()
    queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                 fflags=select.KQ_NOTE_EXIT) for pid in (monitor, adapter, tunnel)], 0, 0)
    os.write(ready_fd, b'1')
    os.close(ready_fd)
    queue.control(None, 3, None)
    stop(name)


# PF applies only to the assigned routing GID; sing-box stays outside it to
# avoid forwarding loops. Keep these rules on failure so traffic cannot become
# direct while processes are stopping. Do not change host default routes/DNS.
def rules(config):
    gid, tun = config['gid'], config['interface']
    index = config['subnetIndex']
    # Trusted AIM launched by a tool can explicitly select another account.
    # Its account-bound HTTP transport needs that account's loopback SOCKS.
    # Deliberate local-relay misuse by hostile tools is outside this boundary.
    # Local OAuth/MCP listeners also send SYN+ACK, not just outbound SYN. PF's
    # default S/SA mask drops those replies when an ordinary browser initiated
    # the connection. Permit every TCP flag only within the existing loopback
    # exception; external connections still require the assigned TUN below.
    lines = [f'pass out quick inet proto tcp from any to 127.0.0.0/8 group {gid} flags any keep state',
              f'pass out quick inet6 proto tcp from any to ::1 group {gid} flags any keep state',
              f'pass out quick route-to ({tun} 198.19.{index}.2) inet proto tcp from any to any group {gid} flags S/SA keep state',
              f'pass out quick route-to ({tun} fd19:{index}::2) inet6 proto tcp from any to any group {gid} flags S/SA keep state',
              f'block drop out quick proto tcp from any to any group {gid}']
    return '\n'.join(lines) + '\n'


def probe(name):
    config = profile(name)
    url = urllib.parse.urlsplit(config.get('exitCheckUrl', 'https://api.ipify.org?format=json'))
    if url.scheme not in ('https', 'http') or not url.hostname or url.username:
        raise RuntimeError('invalid exit check URL')
    connection_type = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=6)
    try:
        connection.request('GET', urllib.parse.urlunsplit(('', '', url.path or '/', url.query, '')), headers={'Connection': 'close'})
        response = connection.getresponse()
        if response.status != 200 or json.loads(response.read(1024)).get('ip') not in config['expectedExits']:
            raise RuntimeError('native route exit mismatch')
    finally:
        connection.close()


# Running probe() as root would test the host's ordinary route. Enter through
# the same UID/GID helper as Claude so this proves PF -> TUN -> assigned SOCKS.
def check_native_path(name, config):
    user = pwd.getpwuid(config['uid'])
    binding = {key: config[key] for key in ('socksHost', 'socksPort', 'expectedExits')}
    def ordinary_user():
        os.initgroups(user.pw_name, user.pw_gid)
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    command([str(ROOT / 'darwin_launch'), name, json.dumps(binding), '--', '/usr/bin/python3', '-I', str(ROOT / 'darwin_proxy.py'), 'probe', name],
            preexec_fn=ordinary_user, timeout=8)


def serve(name):
    config = profile(name)
    state = state_dir(name)
    previous = state / 'ready.json'
    # An old guardian may still be stopping the old GID's processes. Drain it
    # before reuse, or it could kill newly admitted work after explicit repair.
    if previous.exists():
        old = json.loads(previous.read_text())
        live = processes()
        if any(live.get(owner['pid'], {}).get('started') == owner['started'] for owner in old['owners'] if owner.get('role') == 'guardian'):
            raise RuntimeError('the previous proxy guardian is still stopping work; retry explicit repair after it exits')
    require_stopped(name)
    mark_failed(name)
    adapter = None
    watcher = None
    try:
        tunnel = listener_pid(config['socksPort'])
        if config['interface'] in command(['/sbin/ifconfig', '-l'], capture_output=True, text=True).stdout.split():
            raise RuntimeError('the configured native interface already exists; repair its owner before retrying')
        adapter = subprocess.Popen(['/usr/local/bin/sing-box', 'run', '-c', str(ROOT / f'{name}-sing-box.json')])
        for _ in range(80):
            if adapter.poll() is not None:
                raise RuntimeError('native adapter exited during startup')
            if subprocess.run(['/sbin/ifconfig', config['interface']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('native adapter did not create its interface')
        command(['/sbin/pfctl', '-a', f'com.apple/aimgr-claude_{name}', '-f', '-'], input=rules(config), text=True)
        status = command(['/sbin/pfctl', '-s', 'info'], capture_output=True, text=True).stdout
        if 'Status: Enabled' not in status:
            command(['/sbin/pfctl', '-E'], stdout=subprocess.DEVNULL)
        read_fd, write_fd = os.pipe()
        watcher = os.fork()
        if watcher == 0:
            os.close(read_fd)
            try:
                guardian(name, os.getppid(), adapter.pid, tunnel, write_fd)
                os._exit(0)
            except Exception:
                os._exit(125)
        os.close(write_fd)
        try:
            if not select.select([read_fd], [], [], 8)[0] or os.read(read_fd, 1) != b'1':
                raise RuntimeError('native guardian did not become ready')
        finally:
            os.close(read_fd)
        live = processes()
        owners = [{'pid': pid, 'started': live[pid]['started'], 'role': role}
                  for role, pid in [('monitor', os.getpid()), ('adapter', adapter.pid), ('tunnel', tunnel), ('guardian', watcher)]]
        with lock(ROOT / f'{name}.lock', exclusive=True):
            publish_state(state / 'starting', '', 0o600)
            publish_state(previous, json.dumps({'owners': owners}), 0o644)
            (state / 'failed').unlink()
        # The starting marker denies ordinary admission until the complete
        # native path passes. A listening tunnel or created TUN is insufficient.
        check_native_path(name, config)
        (state / 'starting').unlink()
        next_check = time.monotonic() + 5
        def stopping(_signum, _frame):
            raise RuntimeError('native proxy was stopped')
        signal.signal(signal.SIGTERM, stopping)
        signal.signal(signal.SIGINT, stopping)
        while True:
            if adapter.poll() is not None or os.waitpid(watcher, os.WNOHANG)[0]:
                raise RuntimeError('native adapter or guardian exited')
            if time.monotonic() >= next_check:
                if members(config):
                    check_native_path(name, config)
                next_check = time.monotonic() + 5
            time.sleep(.2)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            stop(name)
        finally:
            if adapter and adapter.poll() is None:
                adapter.kill()
                adapter.wait()
            if watcher:
                try:
                    os.waitpid(watcher, 0)
                except ChildProcessError:
                    pass


def install():
    if os.geteuid() != 0 or sys.platform != 'darwin':
        raise RuntimeError('native Mac installation requires macOS root')
    manifest = json.load(sys.stdin)
    user = pwd.getpwnam(manifest['user'])
    if user.pw_uid == 0 or not manifest['profiles']:
        raise RuntimeError('an ordinary user and at least one profile are required')
    ROOT.mkdir(mode=0o755, exist_ok=True)
    os.chown(ROOT, 0, 0)
    os.chmod(ROOT, 0o755)
    install_lock = ROOT / 'install.lock'
    install_lock.touch(mode=0o644)
    os.chmod(install_lock, 0o644)
    with lock(install_lock, exclusive=True, nonblocking=True):
        previous = ROOT / 'manifest.json'
        old = json.loads(previous.read_text()) if previous.exists() else {'user': user.pw_name, 'profiles': {}}
        if old['user'] != user.pw_name:
            raise RuntimeError('installed profiles belong to another user')
        for name in old['profiles']:
            require_stopped(name)
        profiles = {**old['profiles'], **manifest['profiles']}
        gids, ports, interfaces, subnets = set(), set(), set(), set()
        for index, (name, value) in enumerate(profiles.items()):
            validate(name)
            value.setdefault('socksHost', '127.0.0.1')
            value.setdefault('gid', old['profiles'].get(name, {}).get('gid', 64000 + index))
            value.setdefault('interface', old['profiles'].get(name, {}).get('interface', f'utun{80 + index}'))
            value.setdefault('subnetIndex', old['profiles'].get(name, {}).get('subnetIndex', 80 + index))
            value['uid'] = user.pw_uid
            if value['socksHost'] not in ('127.0.0.1', '::1') or type(value['socksPort']) is not int or not 1 <= value['socksPort'] <= 65535 or value['socksPort'] in ports:
                raise RuntimeError('profiles require distinct valid loopback SOCKS ports')
            if type(value['gid']) is not int or not 500 <= value['gid'] < 2**31 or value['gid'] in gids:
                raise RuntimeError('profiles require distinct reserved routing groups')
            try:
                grp.getgrgid(value['gid'])
            except KeyError:
                pass
            else:
                raise RuntimeError('routing group already belongs to an existing OS group')
            if not re.fullmatch(r'utun[0-9]+', value['interface']) or value['interface'] in interfaces:
                raise RuntimeError('profiles require distinct native TUN names')
            if type(value['subnetIndex']) is not int or not 0 <= value['subnetIndex'] <= 255 or value['subnetIndex'] in subnets:
                raise RuntimeError('profiles require distinct valid private TUN subnet indices')
            if not value.get('expectedExits'):
                raise RuntimeError('approved exit addresses are required')
            gids.add(value['gid']); ports.add(value['socksPort']); interfaces.add(value['interface']); subnets.add(value['subnetIndex'])
        if any(info['gid'] in gids for info in processes().values()):
            raise RuntimeError('a routing group is already used by a live process')
        main_rules = command(['/sbin/pfctl', '-sr'], capture_output=True, text=True).stdout
        if 'anchor "com.apple/*"' not in main_rules:
            raise RuntimeError('the existing PF rules lack the standard com.apple/* anchor; preserve existing firewall rules and add that anchor before installation')
        source = pathlib.Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='aimgr-mac-build-') as build:
            for binary in ('darwin_launch', 'darwin_identity'):
                command(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror', str(source / f'{binary}.c'), '-o', str(pathlib.Path(build) / binary)])
            for name in old['profiles']:
                subprocess.run(['/bin/launchctl', 'bootout', f'system/com.aimgr.claude-proxy.{name}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for name in old['profiles']:
                state = state_dir(name) / 'ready.json'
                if state.exists():
                    owners = json.loads(state.read_text())['owners']
                    for _ in range(100):
                        live = processes()
                        owners_gone = not any(live.get(item['pid'], {}).get('started') == item['started'] for item in owners if item['role'] != 'tunnel')
                        job_removed = subprocess.run(['/bin/launchctl', 'print', f'system/com.aimgr.claude-proxy.{name}'],
                                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
                        if owners_gone and job_removed:
                            break
                        time.sleep(.05)
                    else:
                        raise RuntimeError('previous native service has not finished stopping')
            shutil.copyfile(source / 'darwin_proxy.py', ROOT / 'darwin_proxy.py')
            os.chmod(ROOT / 'darwin_proxy.py', 0o755)
            for binary in ('darwin_launch', 'darwin_identity'):
                destination = ROOT / binary
                shutil.copyfile(pathlib.Path(build) / binary, destination)
                os.chown(destination, 0, 0)
                os.chmod(destination, 0o4755 if binary == 'darwin_identity' else 0o755)
        manifest = {'user': user.pw_name, 'profiles': profiles}
        previous.write_text(json.dumps(manifest))
        os.chmod(previous, 0o644)
        for name, config in profiles.items():
            state = state_dir(name)
            state.mkdir(mode=0o700, exist_ok=True)
            os.chown(state, user.pw_uid, user.pw_gid)
            os.chmod(state, 0o700)
            mark_failed(name)
            (ROOT / f'{name}.lock').touch(mode=0o644)
            (ROOT / f'{name}.identity').write_text(f'{user.pw_uid} {config["gid"]}\n')
            (ROOT / f'{name}.json').write_text(json.dumps(config))
            for suffix in ('.lock', '.identity', '.json'):
                os.chmod(ROOT / f'{name}{suffix}', 0o644)
            index = config['subnetIndex']
            router = {'log': {'level': 'error'},
                      'inbounds': [{'type': 'tun', 'interface_name': config['interface'], 'address': [f'198.19.{index}.1/30', f'fd19:{index}::1/126'],
                                    'mtu': 1500, 'auto_route': False, 'auto_redirect': False, 'dns_mode': 'disabled', 'stack': 'gvisor'}],
                      'outbounds': [{'type': 'socks', 'tag': 'assigned', 'server': config['socksHost'], 'server_port': config['socksPort'], 'version': '5'}],
                      'route': {'final': 'assigned'}}
            router_file = ROOT / f'{name}-sing-box.json'
            router_file.write_text(json.dumps(router))
            command(['/usr/local/bin/sing-box', 'check', '-c', str(router_file)])
            label = f'com.aimgr.claude-proxy.{name}'
            log = pathlib.Path(f'/var/log/aimgr-claude-proxy-{name}.log')
            log.touch(mode=0o600)
            os.chmod(log, 0o600)
            plist = {'Label': label, 'ProgramArguments': ['/usr/bin/python3', '-I', str(ROOT / 'darwin_proxy.py'), 'serve', name],
                     'RunAtLoad': True, 'KeepAlive': False, 'Umask': 0o077, 'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
            destination = pathlib.Path(f'/Library/LaunchDaemons/{label}.plist')
            destination.write_bytes(plistlib.dumps(plist))
            os.chmod(destination, 0o644)
    # Activation runs after the exclusive installer lock is released.
    try:
        for name in profiles:
            command(['/bin/launchctl', 'bootstrap', 'system', f'/Library/LaunchDaemons/com.aimgr.claude-proxy.{name}.plist'])
            deadline = time.monotonic() + 12
            while True:
                try:
                    current_ready(name)
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f'native proxy {name} did not become ready; inspect its installation log')
                    time.sleep(.1)
    except Exception as failure:
        cleanup_errors = []
        for name in profiles:
            try:
                stop(name)
            except Exception as error:
                cleanup_errors.append(f'{name}: {type(error).__name__}')
            finally:
                subprocess.run(['/bin/launchctl', 'bootout', f'system/com.aimgr.claude-proxy.{name}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name in profiles:
            ready = state_dir(name) / 'ready.json'
            if not ready.exists():
                continue
            owners = json.loads(ready.read_text())['owners']
            for _ in range(100):
                live = processes()
                if not any(live.get(item['pid'], {}).get('started') == item['started'] for item in owners if item['role'] == 'guardian'):
                    break
                time.sleep(.05)
            else:
                cleanup_errors.append(f'{name}: guardian still running')
        if cleanup_errors:
            raise RuntimeError('installation failed; cleanup requires attention: ' + ', '.join(cleanup_errors)) from failure
        raise


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'unknown'
    name = sys.argv[2] if len(sys.argv) > 2 else 'unknown'
    try:
        if action == 'install':
            install()
            sys.exit(0)
        validate(name)
        if action in ('run', 'launch-approved') and sys.argv[5] == '--':
            with lock(ROOT / 'install.lock') as install_lock:
                if action == 'launch-approved':
                    # This is NOT a sandbox escape entry. Only the immutable,
                    # hardened C launcher has that exception; it supplies the
                    # fixed final launcher and native protocol below. Calls
                    # from ordinary sandboxed tools still inherit their policy.
                    argv = sys.argv[6:]
                    if (len(argv) < 11 or not re.fullmatch(r'/opt/aimgr-claude-runtime/artifacts/[a-f0-9]{64}/launcher', argv[0])
                            or argv[1:3] != ['v1', 'protected']):
                        raise RuntimeError('invalid approved privacy entry')
                    os.set_inheritable(install_lock.fileno(), True)
                    sys.exit(run_child(name, json.loads(sys.argv[3]), int(sys.argv[4]), argv, replace_with_approved=True))
                sys.exit(run(name, json.loads(sys.argv[3]), int(sys.argv[4]), sys.argv[6:]))
        elif action == 'serve':
            serve(name)
        elif action == 'probe':
            probe(name)
        elif action == 'verify':
            if os.geteuid() != 0:
                raise RuntimeError('native verification requires sudo to enter the installed ordinary-user route')
            check_native_path(name, profile(name))
        elif action == 'stop':
            stop(name)
        elif action == 'check-stopped':
            require_stopped(name)
        else:
            raise RuntimeError('invalid native proxy operation')
    except Exception as error:
        label = 'unknown'
        if len(sys.argv) > 3 and sys.argv[1] in ('run', 'launch-approved'):
            try:
                candidate = json.loads(sys.argv[3]).get('label', 'unknown')
                if isinstance(candidate, str) and re.fullmatch(r'[a-zA-Z0-9_.@+-]+', candidate):
                    label = candidate
            except (ValueError, AttributeError):
                pass
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f'Claude account {label}, proxy {name} unavailable during {action}: {detail}. Repair the proxy/tunnel, then explicitly retry or resume.', file=sys.stderr)
        sys.exit(125)
