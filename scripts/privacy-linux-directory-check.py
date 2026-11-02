#!/usr/bin/env python3
"""Offsite kernel regression for exact granted directory roots and update denies.

Compile the production rule emitter, load its rules in a disposable profile,
then perform real opens under that profile. Querying libapparmor permissions
alone falsely reported success for the original missing-directory rule.
"""
import ctypes
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile

assert os.geteuid() == 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
source = Path(__file__).resolve().parents[1] / 'native/claude/approved_launch_linux.c'
user = pwd.getpwnam('aimdev')
with tempfile.TemporaryDirectory(prefix='aimgr-directory-check-', dir='/opt/aimgr-state-audit') as temp:
    root = Path(temp)
    root.chmod(0o755)
    for name in ['skills', 'skills-private', 'updates']:
        (root / name).mkdir()
        (root / name / 'entry').write_text('synthetic')
    probe = root / 'emit.c'
    probe.write_text('#define main original_entry_main\n#include ' + json.dumps(str(source)) +
                     '\n#undef main\nint main(int argc,char **argv){if(argc!=2)return 3;subtree(stdout,argv[1],"r");return 0;}\n')
    subprocess.run(['/usr/bin/gcc', '-O2', '-Wall', '-Wextra', '-Werror', str(probe), '-o', str(root / 'emit')], check=True)
    emit = lambda p: subprocess.check_output([str(root / 'emit'), str(p)], text=True)
    name = 'aimgr-directory-check-' + str(os.getpid())
    # The update path is otherwise readable; its exact production deny rules
    # must still beat the broad allow, including the directory itself.
    policy = ('profile ' + name + ' flags=(enforce) {\n/** w,\n' + emit(root / 'skills') + emit(root / 'updates') +
              ''.join('deny ' + line + '\n' for line in emit(root / 'updates').splitlines()) + '}\n')
    subprocess.run(['/usr/sbin/apparmor_parser', '-a', '-T'], input=policy, text=True, check=True)
    try:
        child = os.fork()
        if child == 0:
            os.setgroups([]); os.setgid(user.pw_gid); os.setuid(user.pw_uid)
            lib = ctypes.CDLL('libapparmor.so.1')
            assert lib.aa_change_profile(name.encode()) == 0
            results = {'grantedDirectory': os.listdir(root / 'skills') == ['entry'],
                       'grantedFile': (root / 'skills/entry').read_text() == 'synthetic'}
            for label, target in [('siblingDirectory', root / 'skills-private'), ('parentDirectory', root),
                                  ('updateDirectory', root / 'updates'), ('updateFile', root / 'updates/entry')]:
                try:
                    os.listdir(target) if label.endswith('Directory') else target.read_text()
                    results[label + 'Denied'] = False
                except PermissionError:
                    results[label + 'Denied'] = True
            print(json.dumps({'passed': all(results.values()), **results}), flush=True)
            os._exit(0 if all(results.values()) else 1)
        _, status = os.waitpid(child, 0)
        assert os.waitstatus_to_exitcode(status) == 0
    finally:
        subprocess.run(['/usr/sbin/apparmor_parser', '-R'], input=policy, text=True, check=True)
