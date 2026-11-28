#!/usr/bin/env python3
"""Install a previously reviewed Antigravity bundle on Linux x64 or macOS arm64.

The bundle must contain its existing normal-use approval and all approved
files. Stage by default. --activate selects the bundle for future launches.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import struct
import subprocess

REPO = Path(__file__).resolve().parent.parent
RUNTIME = Path('/opt/aimgr-agy-runtime')
spec = importlib.util.spec_from_file_location('aimgr_runtime_installer', REPO / 'scripts/install-claude-runtime.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
signature_spec = importlib.util.spec_from_file_location('aimgr_agy_signature', REPO / 'scripts/agy_macos_signature.py')
signature = importlib.util.module_from_spec(signature_spec)
signature_spec.loader.exec_module(signature)


def activate_agy(_user, target, runtime, published):
    # Each launch applies its own native policy. Publishing the selector leaves
    # other launches and their immutable artifact sets in place.
    selector = {'schema': 1, 'artifactSet': target.name}
    common.write_atomic(runtime / 'active.json', (json.dumps(selector) + '\n').encode(), published)


def validate_macos_bundle(bundle):
    for name in ('launcher', 'agy'):
        with (bundle / name).open('rb') as executable:
            header = executable.read(16)
        # Thin 64-bit Mach-O header with CPU_TYPE_ARM64 and MH_EXECUTE.
        common.require(len(header) == 16, f'the Mac {name} is not an arm64 Mach-O executable')
        magic, cpu_type, _, file_type = struct.unpack('<IIII', header)
        common.require((magic, cpu_type, file_type) == (0xfeedfacf, 0x0100000c, 2),
                       f'the Mac {name} is not an arm64 Mach-O executable')
    verified = subprocess.run(signature.verify_google_cli_command(bundle / 'agy'), capture_output=True)
    common.require(verified.returncode == 0, 'the Mac agy executable lacks the Google Developer ID signature')


def install(bundle, node, user, activate=False, runtime=RUNTIME):
    target = (platform.system(), platform.machine())
    common.require(target in (('Linux', 'x86_64'), ('Darwin', 'arm64')),
                   'Antigravity runtime installation requires Linux x64 or macOS arm64')
    return common.install(bundle, node, user, activate, runtime, provider='agy', activate_bundle=activate_agy,
                          validate_bundle=validate_macos_bundle if target[0] == 'Darwin' else None)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--node', required=True)
    parser.add_argument('--user', default=os.environ.get('SUDO_USER'))
    parser.add_argument('--activate', action='store_true', help='select the verified bundle for future launches')
    args = parser.parse_args()
    try:
        common.require(args.user is not None and Path(args.node).is_absolute(),
                       'an ordinary runtime user and absolute Node executable are required')
        print(json.dumps(install(args.bundle, args.node, pwd.getpwnam(args.user), args.activate)))
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else 'bundle installation could not complete safely'
        prefix = ('Antigravity runtime activation needs inspection: ' if isinstance(error, common.SelectorPublishedError)
                  else 'Antigravity runtime was not activated: ')
        parser.exit(1, prefix + detail + '.\n')
