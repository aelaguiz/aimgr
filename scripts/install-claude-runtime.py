#!/usr/bin/env python3
"""Install a previously reviewed, explicitly approved Claude bundle.

This command never downloads or executes Claude and cannot grant approval.
The input directory contains approval.json and exactly its approved files.
Stage by default; --activate performs the planned stopped-account transition.
Old bundles are retained for running/saved work. Proxy enrollment is separate.
"""
import argparse
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import tempfile

RUNTIME = Path('/opt/aimgr-claude-runtime')
REPO = Path(__file__).resolve().parent.parent


class SelectorPublishedError(RuntimeError):
    """The selector changed; callers must never report a failed activation."""


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def protected_directory(directory):
    if not directory.exists():
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)  # Known new directory, independent of root's umask.
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0,
            'runtime directory is not administrator-owned and immutable to users')


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def linux_immutable(file):
    """Mirror the native entry's fixed prerequisite checks before activation.

    An installer refusal keeps the previous selector usable. Native repeats
    these checks at execution; neither check substitutes for the other.
    """
    for item in [file, *file.parents]:
        info = item.lstat()
        require(info.st_uid == 0 and info.st_mode & 0o022 == 0
                and (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 if item == file
                     else stat.S_ISDIR(info.st_mode)), 'a fixed Linux runtime prerequisite is mutable or unsafe')
    require('security.capability' not in os.listxattr(file), 'a fixed Linux runtime prerequisite has file capabilities')


def linux_prerequisites():
    require(Path('/sys/module/apparmor/parameters/mode').read_text().strip() == 'enforce'
            and Path('/sys/kernel/security/apparmor/profiles').is_file(), 'enforcing AppArmor prerequisites are unavailable')
    parser = Path('/usr/sbin/apparmor_parser')
    linux_immutable(parser)
    require(parser.stat().st_mode & 0o111 == 0o111, 'the fixed AppArmor parser is not executable')


def reclaim_stopped_linux_profiles(uid, runtime=RUNTIME):
    """Reclaim this user's policies ONLY during the paused transition.

    New launches/schedules and their tools must already be stopped by the
    operator. The native policy lock prevents new profile installation during
    this check; it cannot freeze a tool that was left running. Inspect every
    task's actual label, across UIDs: a sudo tool can retain confinement and a
    plain Bash/MCP survivor can later execute Claude through its tools profile.
    Zero vendor executable owners alone is NOT a safe unload condition.

    No live garbage collector or privileged service is added. Ordinary exits
    retain policies; activation (or reboot) reclaims them. Keep old artifact
    files and saved-job settings: a future launch installs its policy afresh.
    """
    require(os.geteuid() == 0 and platform.system() == 'Linux' and uid > 0,
            'Linux policy reclamation requires an administrator and ordinary runtime user')
    linux_prerequisites()
    lock = runtime / 'policy.lock'; linux_immutable(lock)
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        directory = Path('/sys/kernel/security/apparmor/policy/profiles')
        pattern = re.compile(r'aim-claude-[op]-' + str(uid) + r'-[a-f0-9]{32}(?:-tools)?')
        # Read the kernel's name, not the escaped/mangled directory spelling.
        def selected():
            return {name for entry in directory.iterdir()
                    if pattern.fullmatch(name := (entry / 'name').read_text().strip())}
        names = selected()
        if not names: return {'removedProfiles': 0}
        for process in Path('/proc').iterdir():
            if not process.name.isdecimal(): continue
            try: tasks = list((process / 'task').iterdir())
            except FileNotFoundError:
                require(not (process / 'stat').exists(),
                        'a live process task inventory is unavailable; Linux policies were retained')
                continue
            # A leader can exit while its worker threads remain alive. An
            # absent/empty task directory is not proof the whole group exited.
            require(tasks or not (process / 'stat').exists(),
                    'a live process task inventory is unavailable; Linux policies were retained')
            for task in tasks:
                try: label = (task / 'attr/current').read_text()
                except FileNotFoundError:
                    require(not (task / 'stat').exists(),
                            'a live task label is unavailable; Linux policies were retained')
                    continue
                except OSError as error:
                    # Kernel threads can report EINVAL without an AppArmor
                    # label. Verify their lack of a userspace address space;
                    # other unreadable live tasks cannot authorize unloading.
                    try:
                        fields = (task / 'stat').read_text().rsplit(')', 1)[1].split()
                        kernel_thread = int(fields[6]) & 0x00200000  # PF_KTHREAD
                    except FileNotFoundError: continue
                    require(error.errno == errno.EINVAL and kernel_thread,
                            'a live task label is unreadable; Linux policies were retained')
                    continue
                # Stacked labels retain each component; do not check only
                # exact whole-string equality or only the process leader.
                labels = re.findall(r'aim-claude-[op]-[0-9]+-[a-f0-9]{32}(?:-tools)?', label)
                require(not names.intersection(labels),
                        'stop Claude and all surviving tools before reclaiming Linux policies')
        policy = ''.join('profile ' + name + ' {}\n' for name in sorted(names))
        removed = subprocess.run(['/usr/sbin/apparmor_parser', '-R', '-T'], input=policy,
                                 capture_output=True, text=True,
                                 env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
        require(removed.returncode == 0 and not names.intersection(selected()),
                'Linux policy reclamation did not complete; inspect the retained policies')
        return {'removedProfiles': len(names)}
    finally:
        os.close(descriptor)


def write_atomic(file, data, published=None):
    fd, name = tempfile.mkstemp(prefix='.' + file.name + '-', dir=file.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.replace(name, file)
        if published: published()
        sync_directory(file.parent)
    finally:
        if os.path.exists(name): os.unlink(name)


@contextlib.contextmanager
def stopped_accounts(user, vendor):
    """Reuse the existing account locks and owner proof, never kill sessions.

    Hold discovered default-home SH/EX coordination in EX until publication.
    Native owners predating those locks are checked by the existing helper.
    Kernel owner inventory also catches supported custom HOME/--home layouts.
    The operator pauses schedules/new launches for this scheduled transition;
    this is not a global process-registration service. A racing launch retains
    its immutable admitted set; activation never replaces its running bytes.
    This is the scheduled transition the user accepted, not a launch/session cap.
    """
    homes = Path(user.pw_dir) / '.aimgr/claude-homes'
    guards = []
    try:
        owners = subprocess.run(['/usr/bin/sudo', '-n', '-u', user.pw_name, '/usr/bin/python3', '-I',
                                 str(REPO / 'native/claude/runtime_inventory.py')], capture_output=True, text=True)
        inventory = json.loads(owners.stdout) if owners.returncode == 0 else {}
        require(inventory.get('complete') is True and inventory.get('processes') == [],
                'stop Claude owners in every home and pause schedules before activating the bundle')
        for home in sorted(homes.iterdir()) if homes.exists() else []:
            if not home.is_dir(): continue
            require(not home.is_symlink() and re.fullmatch(r'[A-Za-z0-9_.-]+', home.name), 'unsafe account directory')
            config = home / '.claude'
            if not config.exists(): continue
            require(config.is_dir() and not config.is_symlink(), 'unsafe account configuration')
            locks = Path(user.pw_dir) / '.aimgr/claude-egress'
            if not locks.exists():
                locks.mkdir(mode=0o700); os.chown(locks, user.pw_uid, user.pw_gid)
            file = locks / (home.name + '.json.lock')
            fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            guards.append(fd)
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe account lock')
            os.fchown(fd, user.pw_uid, user.pw_gid)
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('stop Claude sessions and pause schedules before activating the bundle')
            check = subprocess.run(['/usr/bin/sudo', '-n', '-u', user.pw_name, '/usr/bin/python3', '-I',
                                    str(REPO / 'native/claude/check_owners.py'), str(config.resolve()), str(vendor)],
                                   capture_output=True, text=True)
            require(check.returncode == 0, 'stop existing Claude background owners before activating the bundle')
        yield
    finally:
        for fd in guards: os.close(fd)


def install(bundle, node, user, activate=False, runtime=RUNTIME):
    require(os.geteuid() == 0, 'installation requires administrator privileges')
    require(user.pw_uid != 0, 'choose the ordinary AIM runtime user')
    require(platform.system() in ('Darwin', 'Linux'), 'unsupported native platform')
    bundle = bundle.resolve(strict=True)
    approval = bundle / 'approval.json'
    require(approval.is_file() and not approval.is_symlink() and approval.stat().st_size <= 1024 * 1024,
            'missing or invalid approved manifest')
    approved_bytes = approval.read_bytes()
    manifest = json.loads(approved_bytes)
    require(manifest.get('approval', {}).get('kind') == 'normal-use', 'only an explicit normal-use approval may be installed here')
    require(manifest.get('entrypoint') == 'claude' and manifest.get('launcher') == 'launcher'
            and manifest.get('policy') == 'policy.json', 'unsupported fixed native bundle layout')
    files = manifest.get('files', {})
    require(isinstance(files, dict) and 0 < len(files) <= 512, 'invalid approved inventory')
    for name in files:
        require(isinstance(name, str) and all(re.fullmatch(r'[A-Za-z0-9_.-]+', p) and p not in ('.', '..') for p in name.split('/')),
                'invalid approved path')
    actual = set()
    for directory, dirs, names in os.walk(bundle, followlinks=False):
        for name in dirs + names:
            file = Path(directory) / name
            require(not file.is_symlink(), 'bundle symlinks are not supported')
            if file.is_file(): actual.add(file.relative_to(bundle).as_posix())
            else: require(file.is_dir(), 'bundle contains a nonregular file')
    require(actual == set(files) | {'approval.json'}, 'bundle has missing or unapproved files')
    inventory = [[name, files[name]['sha256'], files[name]['size'], files[name]['executable'], files[name]['role']] for name in sorted(files)]
    artifact = hashlib.sha256(json.dumps(inventory, separators=(',', ':')).encode()).hexdigest()
    protected_directory(runtime.parent); protected_directory(runtime)
    protected_directory(runtime / 'artifacts')
    lockfd = os.open(runtime / 'install.lock', os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    stage = None
    selector_published = False
    def published():
        nonlocal selector_published
        selector_published = True
    def as_user(script, *args):
        return subprocess.run(['/usr/bin/sudo', '-n', '-u', user.pw_name, node,
                               '--input-type=module', '-e', script, *args], capture_output=True, text=True)
    try:
        info = os.fstat(lockfd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and info.st_mode & 0o022 == 0, 'unsafe installation lock')
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = Path(tempfile.mkdtemp(prefix='.install-', dir=runtime)); stage.chmod(0o755)
        staged = stage / 'artifacts' / artifact
        staged.mkdir(parents=True, mode=0o755)
        (stage / 'artifacts').chmod(0o755); staged.chmod(0o755)
        for name, expected in files.items():
            source = bundle / name
            require(source.is_file() and not source.is_symlink() and source.stat().st_nlink == 1, 'unsafe approved input')
            target = staged / name; target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            for parent in target.parents:
                if parent == staged: break
                parent.chmod(0o755)
            # Copy bytes only: source ACLs, capabilities and privilege bits must
            # never survive. The common gate validates every copied byte again.
            with source.open('rb') as inp, target.open('xb') as out:
                shutil.copyfileobj(inp, out); out.flush(); os.fsync(out.fileno())
            target.chmod(0o4755 if platform.system() == 'Linux' and name == 'launcher' else 0o755 if expected['executable'] else 0o644)
            require(target.stat().st_size == expected['size'] and digest(target) == expected['sha256'], 'approved bytes changed during copying')
        write_atomic(staged / 'approval.json', approved_bytes)
        write_atomic(stage / 'active.json', (json.dumps({'schema': 1, 'artifactSet': artifact}) + '\n').encode())
        module = (REPO / 'src/privacy/claude-artifacts.js').as_uri()
        # Reuse production schema, ownership/ACL, ABI, platform, hash and human
        # approval checks. This is file inspection; it never executes Claude.
        verify = 'const {admitClaudeArtifact}=await import(process.argv[1]);admitClaudeArtifact({runtimeRoot:process.argv[2]});'
        # Root can read 0600 files and bypass access-denying ACLs. Admission
        # must succeed for the actual runtime user before changing selection.
        checked = as_user(verify, module, str(stage))
        require(checked.returncode == 0, 'the complete bundle failed production artifact admission')
        policy = json.loads((staged / 'policy.json').read_bytes())
        require(policy.get('schema') == 1 and policy.get('version') == manifest['version']
                and policy.get('platform') == manifest['platform'] and policy.get('arch') == manifest['arch']
                and re.fullmatch(r'[a-f0-9]{12}', policy.get('vendorCommit', '')), 'invalid native policy identity')
        if platform.system() == 'Linux':
            linux_prerequisites()
        else:
            signature = subprocess.run(['/usr/bin/codesign', '-dv', '--verbose=4', str(staged / 'launcher')], capture_output=True, text=True)
            flags = re.search(r'flags=0x[0-9a-f]+\(([^)]*)\)', signature.stderr)
            verified = subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(staged / 'launcher')], capture_output=True, text=True)
            require(signature.returncode == 0 and verified.returncode == 0 and flags
                    and 'runtime' in flags.group(1).split(','), 'the Mac launcher lacks its approved hardened-runtime signature')
        target = runtime / 'artifacts' / artifact
        if target.exists():
            # Idempotence does not permit replacing immutable code. Verify all
            # existing entries before accepting/updating the approval record.
            existing = [target, *target.rglob('*')]
            require(all(not p.is_symlink() for p in existing), 'existing bundle contains a symlink')
            require({p.relative_to(target).as_posix() for p in existing if p.is_file()} == set(files) | {'approval.json'}, 'existing bundle inventory differs')
            for name, expected in files.items():
                file = target / name; info = file.lstat()
                mode = 0o4755 if platform.system() == 'Linux' and name == 'launcher' else 0o755 if expected['executable'] else 0o644
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == mode and info.st_size == expected['size']
                        and digest(file) == expected['sha256'], 'existing bundle bytes or execution mode differ')
                if platform.system() == 'Linux': require('security.capability' not in os.listxattr(file), 'existing bundle has file capabilities')
            require((target / 'approval.json').read_bytes() == approved_bytes,
                    'this artifact already has another approval record; retain it and use the reviewed transition procedure')
        else:
            os.rename(staged, target); sync_directory(target.parent)
        # Inspect the REAL destination as the ordinary user, including its
        # ancestors. A valid staging sibling says nothing about a preexisting
        # artifacts/0700 directory, or a destination ACL denying execution.
        metadata = 'const fs=await import("node:fs");const {inspectClaudeAdministratorPath}=await import(process.argv[1]);for(const [f,x] of JSON.parse(process.argv[2])){const r=inspectClaudeAdministratorPath(f,{readBytes:false});fs.accessSync(f,fs.constants.R_OK|(x||r.kind==="directory"?fs.constants.X_OK:0));}'
        entries = [[str(p), bool(files.get(p.relative_to(target).as_posix(), {}).get('executable'))]
                   for p in [target, *target.rglob('*')]]
        checked = as_user(metadata, module, json.dumps(entries))
        require(checked.returncode == 0, 'the installed bundle is unsafe or unreadable by the runtime user')
        lock = runtime / 'policy.lock'
        if not lock.exists() and not lock.is_symlink(): write_atomic(lock, b'')
        if platform.system() == 'Linux': linux_immutable(lock)
        if activate:
            with stopped_accounts(user, target / 'claude'):
                if platform.system() == 'Linux':
                    reclaim_stopped_linux_profiles(user.pw_uid, runtime)
                write_atomic(runtime / 'active.json', (json.dumps({'schema': 1, 'artifactSet': artifact}) + '\n').encode(), published)
        return {'artifactSet': artifact, 'activated': activate, 'oldBundlesRetained': True}
    except Exception as error:
        if selector_published:
            raise SelectorPublishedError('the new selector was published, but final durability or cleanup failed; inspect privacy status before continuing') from error
        raise
    finally:
        try:
            if stage: shutil.rmtree(stage)
        except Exception as error:
            if selector_published:
                raise SelectorPublishedError('the new selector was published, but temporary-file cleanup failed; inspect privacy status before continuing') from error
            raise
        finally: os.close(lockfd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--node', required=True)
    parser.add_argument('--user', default=os.environ.get('SUDO_USER'))
    parser.add_argument('--activate', action='store_true')
    args = parser.parse_args()
    try:
        require(args.user is not None and Path(args.node).is_absolute(), 'an ordinary runtime user and absolute Node executable are required')
        print(json.dumps(install(args.bundle, args.node, pwd.getpwnam(args.user), args.activate)))
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else 'bundle installation could not complete safely'
        prefix = 'Claude runtime activation needs inspection: ' if isinstance(error, SelectorPublishedError) else 'Claude runtime was not activated: '
        parser.exit(1, prefix + detail + '.\n')
