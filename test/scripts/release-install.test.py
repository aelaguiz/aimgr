#!/usr/bin/env python3
"""Release orchestration in temporary homes; sudo, runtimes and services are fakes.

Environment tests exercise the real provisioning code with filesystem ownership
reported as root. No system runtime, provider credential or service is touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
CHOOSER = REPO / 'scripts/choose-runtime.py'
spec = importlib.util.spec_from_file_location('installer', REPO / 'scripts/install-claude-runtime.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
SYSTEM = {'Darwin': 'darwin', 'Linux': 'linux'}[platform.system()]
ARCH = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64'}[platform.machine()]


def manifest(provider, date='2026-11-09T00:00:00Z', kind='normal-use'):
    return dict(entrypoint=provider, platform=SYSTEM, arch=ARCH,
                approval=dict(kind=kind, approvedAt=date))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runtime'
        lstat, fstat = Path.lstat, os.fstat
        def root_stat(value):
            fields = list(value)
            fields[4] = 0
            return os.stat_result(fields)
        self.patches = [patch.object(Path, 'lstat', lambda p: root_stat(lstat(p))),
                        patch.object(os, 'fstat', lambda fd: root_stat(fstat(fd))),
                        patch.object(os, 'geteuid', lambda: 0)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_missing_anchor_is_created_and_repeat_preserves_bytes_and_inode(self):
        installer.ensure_claude_environment(self.root)
        anchor = self.root / 'environment.json'
        before, inode = anchor.read_bytes(), anchor.stat().st_ino
        self.assertEqual(json.loads(before)['schema'], 1)
        self.assertEqual(stat.S_IMODE(anchor.stat().st_mode), 0o644)
        installer.ensure_claude_environment(self.root)
        self.assertEqual(anchor.read_bytes(), before)
        self.assertEqual(anchor.stat().st_ino, inode)
        self.assertFalse((self.root / 'active.json').exists())

    def test_existing_invalid_anchor_is_refused_and_preserved(self):
        installer.ensure_claude_environment(self.root)
        anchor = self.root / 'environment.json'
        anchor.write_text('{"schema":1,"id":"broken"}')
        before = anchor.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'invalid machine-local'):
            installer.ensure_claude_environment(self.root)
        self.assertEqual(anchor.read_bytes(), before)

    def test_symlink_anchor_is_refused_without_touching_target(self):
        installer.ensure_claude_environment(self.root)
        anchor = self.root / 'environment.json'
        target = self.root / 'saved.json'
        anchor.rename(target)
        before = target.read_bytes()
        anchor.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'unsafe machine-local'):
            installer.ensure_claude_environment(self.root)
        self.assertEqual(target.read_bytes(), before)

    def test_provisioning_respects_install_lock(self):
        installer.ensure_claude_environment(self.root)
        with (self.root / 'install.lock').open() as lock:
            installer.fcntl.flock(lock, installer.fcntl.LOCK_EX)
            with self.assertRaises(BlockingIOError):
                installer.ensure_claude_environment(self.root)


class ChooserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store, self.runtime = self.root / 'bundles', self.root / 'runtime'
        for provider in ['claude', 'codex']:
            write_json(self.store / provider / 'approval.json', manifest(provider))

    def choose(self, provider, status):
        return subprocess.run([sys.executable, '-I', str(CHOOSER), provider,
                               str(self.store), str(self.runtime)], input=json.dumps(status),
                              capture_output=True, text=True)

    def test_mixed_bundle_directory_selects_only_requested_provider(self):
        for provider in ['claude', 'codex']:
            result = self.choose(provider, {})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(self.store / provider))

    def test_usable_active_bundles_are_not_reactivated(self):
        for provider in ['claude', 'codex']:
            write_json(self.runtime / 'artifacts' / 'active' / 'approval.json', manifest(provider))
            status = dict(selected=dict(available=True), activeArtifactSet='active') if provider == 'claude' else dict(
                runtime=dict(artifactSet='active'), environmentProvisioned=True, policyReady=True)
            result = self.choose(provider, status)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')

    def test_missing_codex_policy_requires_installing_approved_bundle(self):
        result = self.choose('codex', dict(runtime=dict(artifactSet='active'),
                                         environmentProvisioned=True, policyReady=False))
        self.assertEqual(result.stdout.strip(), str(self.store / 'codex'))

    def test_test_only_approval_and_other_provider_cannot_supply_codex(self):
        write_json(self.store / 'codex' / 'approval.json', manifest('codex', kind='offsite-test'))
        result = self.choose('codex', {})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no approved codex', result.stderr)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.checkout = self.home / 'checkout'
        (self.checkout / 'scripts').mkdir(parents=True)
        shutil.copy(REPO / 'scripts/install-release.sh', self.checkout / 'scripts/install-release.sh')
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        self.data = self.home / 'data'
        self.release = self.data / 'releases' / ('a' * 40)
        scripts = self.release / 'scripts'
        scripts.mkdir(parents=True)
        (self.release / '.aimgr-release').touch()
        (self.release / 'skills/aimgr').mkdir(parents=True)
        (self.release / 'skills/aimgr/SKILL.md').write_text('fixture skill')
        self.env = dict(os.environ, HOME=str(self.home), AIMGR_DATA_HOME=str(self.data),
                        XDG_BIN_HOME=str(self.home / 'wrappers'), AIMGR_NODE_BIN=str(self.bin / 'node'),
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'])
        executable(self.bin / 'git', '#!/bin/sh\nprintf "%s\\n" ' + 'a' * 40 + '\n')
        executable(self.bin / 'sudo', '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n')
        executable(self.bin / 'node', '#!' + sys.executable + '''
import json, os, pathlib, sys
status = pathlib.Path(os.environ['HOME']) / ('status-' + sys.argv[2] + '.json')
print(status.read_text() if status.exists() else '{}')
''')
        # Map only the fixed system paths into this fixture. Selection is the real code.
        shutil.copy(CHOOSER, scripts / 'choose-runtime-implementation.py')
        (scripts / 'choose-runtime.py').write_text('''import os, pathlib, runpy, sys
sys.argv[3] = str(pathlib.Path(os.environ['HOME']) / 'runtime' / sys.argv[1])
runpy.run_path(str(pathlib.Path(__file__).with_name('choose-runtime-implementation.py')), run_name='__main__')
''')
        stub = '''import json, os, pathlib, shutil, sys
home = pathlib.Path(os.environ['HOME'])
provider = pathlib.Path(__file__).stem.split('-')[1]
with (home / 'events').open('a') as log:
    log.write(provider + (' ensure' if '--ensure-environment' in sys.argv else ' activate') + '\\n')
if os.environ.get('FAIL_PROVIDER') == provider:
    sys.exit(1)
if '--ensure-environment' in sys.argv:
    anchor = home / 'environment.json'
    if not anchor.exists(): anchor.write_text('stable-local-identity')
else:
    bundle = pathlib.Path(sys.argv[1])
    root = home / 'runtime' / provider / 'artifacts' / provider
    root.mkdir(parents=True, exist_ok=True)
    shutil.copy(bundle / 'approval.json', root / 'approval.json')
    status = dict(selected=dict(available=True), activeArtifactSet=provider) if provider == 'claude' else dict(runtime=dict(artifactSet=provider), environmentProvisioned=True, policyReady=True)
    (home / ('status-' + provider + '.json')).write_text(json.dumps(status))
'''
        for provider in ['claude', 'codex']:
            (scripts / ('install-' + provider + '-runtime.py')).write_text(stub)
            write_json(self.data / 'runtime-bundles' / provider / 'approval.json', manifest(provider))
        (scripts / 'install-local-bin.sh').write_text('printf "wrappers\\n" >> "$HOME/events"\n')
        (scripts / 'follow-release.py').write_text("import os, pathlib\nwith (pathlib.Path(os.environ['HOME'])/'events').open('a') as f: f.write('services\\n')\n")

    def run_install(self):
        return subprocess.run(['bash', str(self.checkout / 'scripts/install-release.sh')],
                              env=self.env, capture_output=True, text=True)

    def test_fresh_install_activates_both_before_wrappers_and_repeat_keeps_identity(self):
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stderr)
        events = (self.home / 'events').read_text().splitlines()
        self.assertEqual(events, ['claude activate', 'codex activate', 'claude ensure', 'wrappers', 'services'])
        anchor = self.home / 'environment.json'
        before = anchor.read_bytes()
        # A second release uses the same runtime and must retain existing grants.
        shutil.copytree(self.release, self.data / 'releases' / ('b' * 40))
        executable(self.bin / 'git', '#!/bin/sh\nprintf "%s\\n" ' + 'b' * 40 + '\n')
        (self.home / 'events').write_text('')
        again = self.run_install()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual((self.home / 'events').read_text().splitlines(), ['claude ensure', 'wrappers', 'services'])
        self.assertEqual(anchor.read_bytes(), before)
        # Older active bundles may have no anchor; neither provider needs reactivation.
        anchor.unlink()
        (self.home / 'events').write_text('')
        repaired = self.run_install()
        self.assertEqual(repaired.returncode, 0, repaired.stderr)
        self.assertEqual(anchor.read_bytes(), before)
        self.assertEqual((self.home / 'events').read_text().splitlines(), ['claude ensure', 'wrappers', 'services'])

    def test_codex_install_failure_never_replaces_wrappers(self):
        self.env['FAIL_PROVIDER'] = 'codex'
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.home / 'events').read_text().splitlines(), ['claude activate', 'codex activate'])


if __name__ == '__main__':
    unittest.main()
