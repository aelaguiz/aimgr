#!/usr/bin/env python3
"""Install an explicitly approved Codex bundle without executing Codex.

Stage by default. --activate installs the local privacy policy and selects the
bundle for new invocations. Old immutable bundles and active sessions survive.
--provision-clone replaces the copied environment identity on a destination
machine; every Codex account must then sign in independently on that machine.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import uuid

REPO = Path(__file__).resolve().parent.parent
RUNTIME = Path('/opt/aimgr-codex-runtime')
spec = importlib.util.spec_from_file_location('aimgr_runtime_installer', REPO / 'scripts/install-claude-runtime.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def provision(user, runtime, new_environment=False):
    """Machine identity is not part of the transferable bundle or user home."""
    anchor = runtime / 'environment.json'
    if anchor.exists() or anchor.is_symlink():
        info = anchor.lstat()
        common.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                       and info.st_mode & 0o022 == 0, 'unsafe machine-local environment identity')
        value = json.loads(anchor.read_text())
        identity = uuid.UUID(value['id'])
        common.require(value.get('schema') == 1 and identity.version == 4 and str(identity) == value['id'],
                       'invalid machine-local environment identity')
    if new_environment or not anchor.exists():
        common.write_atomic(anchor, (json.dumps(dict(schema=1, id=str(uuid.uuid4()))) + '\n').encode())
    users = runtime / 'users'
    common.protected_directory(users)
    owner = users / str(user.pw_uid)
    common.protected_directory(owner)
    maintenance = owner / 'maintenance'
    if not maintenance.exists() and not maintenance.is_symlink():
        maintenance.mkdir(mode=0o700)
        os.chown(maintenance, user.pw_uid, user.pw_gid)
    info = maintenance.lstat()
    common.require(stat.S_ISDIR(info.st_mode) and info.st_uid == user.pw_uid and info.st_mode & 0o077 == 0,
                   'unsafe private MCP maintenance directory')
    admission = owner / 'admission.lock'
    try:
        fd = os.open(admission, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        try:
            os.fchown(fd, user.pw_uid, user.pw_gid)
            os.fsync(fd)
        finally:
            os.close(fd)
    info = admission.lstat()
    common.require(stat.S_ISREG(info.st_mode) and info.st_uid == user.pw_uid and info.st_nlink == 1
                   and info.st_mode & 0o077 == 0, 'unsafe private admission lock')
    common.sync_directory(owner)


def install(bundle, node, user, activate=False, runtime=RUNTIME, provision_clone=False):
    common.require(not provision_clone or activate, '--provision-clone requires --activate on the destination machine')
    def activate_codex(user, target, runtime, published):
        provision(user, runtime, provision_clone)
        # This changes only administrator-owned Codex policy. Unrelated policy
        # and independent telemetry exporters are preserved by that installer.
        policy = subprocess.run([node, str(REPO / 'scripts/install-codex-policy.mjs')], capture_output=True, text=True)
        common.require(policy.returncode == 0, 'Codex managed privacy policy installation failed')
        module = (REPO / 'src/privacy/codex-managed-policy.js').as_uri()
        check = 'const {inspectCodexManagedPolicy}=await import(process.argv[1]);const {readCodexEnvironment}=await import(new URL("codex-environment.js",process.argv[1]));const {inspectCodexAdministratorPath}=await import(new URL("codex-artifacts.js",process.argv[1]));readCodexEnvironment({inspect:()=>inspectCodexAdministratorPath(process.argv[3])});inspectCodexManagedPolicy({artifact:JSON.parse(process.argv[2])});'
        artifact = {'managedPreferences': str(target / 'managed-preferences')}
        checked = subprocess.run(['/usr/bin/sudo', '-n', '-u', user.pw_name, node, '--input-type=module', '-e',
                                  check, module, json.dumps(artifact), str(runtime / 'environment.json')], capture_output=True, text=True)
        common.require(checked.returncode == 0, 'Codex effective local privacy policy conflicts with required settings')
        # A new immutable selection cannot replace any running owner's bytes or
        # grants. No process stop or live AppArmor profile removal is required.
        common.write_atomic(runtime / 'active.json', (json.dumps(dict(schema=1, artifactSet=target.name)) + '\n').encode(), published)
    return common.install(bundle, node, user, activate, runtime, provider='codex', activate_bundle=activate_codex)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--node', required=True)
    parser.add_argument('--user', default=os.environ.get('SUDO_USER'))
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--provision-clone', action='store_true')
    args = parser.parse_args()
    try:
        common.require(args.user is not None and Path(args.node).is_absolute(), 'an ordinary runtime user and absolute Node executable are required')
        print(json.dumps(install(args.bundle, args.node, pwd.getpwnam(args.user), args.activate, provision_clone=args.provision_clone)))
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else 'bundle installation could not complete safely'
        prefix = 'Codex runtime activation needs inspection: ' if isinstance(error, common.SelectorPublishedError) else 'Codex runtime was not activated: '
        parser.exit(1, prefix + detail + '.\n')
