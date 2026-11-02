#!/usr/bin/env python3
"""Selector publication contracts; no vendor, credentials, root or live runtime.

The full installer/admission suite separately verifies privileged staging. These
tests exercise the actual publication boundary with real files, a held account
lock and a surviving synthetic owner, including refusal before Linux unloading.
"""
import contextlib
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

repo = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', repo / 'scripts/install-claude-runtime.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aimgr-activation-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.user = SimpleNamespace(pw_uid=501)
        self.old = self.root / 'artifacts' / ('a' * 64)
        self.new = self.root / 'artifacts' / ('b' * 64)
        for target in (self.old, self.new):
            target.mkdir(parents=True)
            (target / 'claude').write_text('never-executed synthetic image: ' + target.name)
        self.selector = self.root / 'active.json'
        self.events = []

    def activate(self, target=None):
        installer.activate_installed_bundle(self.user, target or self.new, self.root,
                                            lambda: self.events.append('published'))

    def test_mac_live_owner_and_account_lock_survive_first_activation_and_replacement(self):
        # The child models an owner with an already-selected immutable path.
        # Holding the real lock would make the former all-account gate refuse.
        lock = self.root / 'account.lock'
        code = ('import fcntl, pathlib, sys\n'
                'f=open(sys.argv[1], "w"); fcntl.flock(f, fcntl.LOCK_SH)\n'
                'print("ready", flush=True)\n'
                'for _ in sys.stdin: print(pathlib.Path(sys.argv[2]).read_text(), flush=True)\n')
        child = subprocess.Popen([sys.executable, '-I', '-c', code, str(lock), str(self.old / 'claude')],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with lock.open('r') as held:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(installer.platform, 'system', return_value='Darwin'), \
                    patch.object(installer, 'stopped_accounts', side_effect=AssertionError('global stop forbidden')), \
                    patch.object(installer, 'reclaim_stopped_linux_profiles', side_effect=AssertionError('Linux cleanup forbidden')):
                for target in (self.old, self.new):
                    self.activate(target)
                    self.assertEqual(json.loads(self.selector.read_text()), {'schema': 1, 'artifactSet': target.name})
                    self.assertIsNone(child.poll())
                    child.stdin.write('read\n'); child.stdin.flush()
                    self.assertEqual(child.stdout.readline().strip(), (self.old / 'claude').read_text())
            self.assertEqual(self.events, ['published', 'published'])
            self.assertEqual(self.selector.stat().st_mode & 0o777, 0o644)
            self.assertEqual(list(self.root.glob('.active.json-*')), [])
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()

    def test_failed_atomic_replacement_preserves_previous_default(self):
        with patch.object(installer.platform, 'system', return_value='Darwin'):
            self.activate(self.old)
            before = self.selector.read_bytes()
            with patch.object(installer.os, 'replace', side_effect=OSError('synthetic rename failure')):
                with self.assertRaises(OSError): self.activate()
            self.assertEqual(self.selector.read_bytes(), before)
            self.assertEqual(self.events, ['published'])
            self.assertEqual(list(self.root.glob('.active.json-*')), [])

    def test_linux_live_owner_refuses_before_cleanup_or_publication(self):
        with patch.object(installer.platform, 'system', return_value='Linux'), \
                patch.object(installer, 'stopped_accounts', side_effect=RuntimeError('live owner')), \
                patch.object(installer, 'reclaim_stopped_linux_profiles') as reclaim:
            with self.assertRaisesRegex(RuntimeError, 'live owner'): self.activate()
            reclaim.assert_not_called()
        self.assertFalse(self.selector.exists())
        self.assertEqual(self.events, [])

    def linux_guard(self, user, vendor):
        self.assertIs(user, self.user)
        self.assertEqual(vendor, self.new / 'claude')
        @contextlib.contextmanager
        def guard():
            self.events.append('locked')
            try: yield
            finally: self.events.append('unlocked')
        return guard()

    def test_linux_holds_stopped_guard_through_cleanup_and_publication(self):
        def reclaim(uid, runtime):
            self.assertEqual((uid, runtime), (501, self.root))
            self.events.append('reclaimed')
        with patch.object(installer.platform, 'system', return_value='Linux'), \
                patch.object(installer, 'stopped_accounts', side_effect=self.linux_guard), \
                patch.object(installer, 'reclaim_stopped_linux_profiles', side_effect=reclaim):
            self.activate()
        self.assertEqual(self.events, ['locked', 'reclaimed', 'published', 'unlocked'])

    def test_linux_surviving_tools_prevent_publication(self):
        with patch.object(installer.platform, 'system', return_value='Linux'), \
                patch.object(installer, 'stopped_accounts', side_effect=self.linux_guard), \
                patch.object(installer, 'reclaim_stopped_linux_profiles', side_effect=RuntimeError('surviving tool')):
            with self.assertRaisesRegex(RuntimeError, 'surviving tool'): self.activate()
        self.assertEqual(self.events, ['locked', 'unlocked'])
        self.assertFalse(self.selector.exists())


if __name__ == '__main__':
    unittest.main()
