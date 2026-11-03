#!/usr/bin/env python3
"""Check the native entry's policy-error branch with a synthetic syscall fault.

The admitted helper and host enforcement remain unchanged. This component build
uses the production entry source with only sandbox_init_with_parameters replaced
by a deterministic failure. Its unregistered immutable test package contains a
marker script, never Claude. Successful real-kernel/vendor cases are separate.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

work = Path('/opt/aimgr-state-audit/claude-implementation')
assert platform.system() == 'Darwin' and os.getuid() != 0
assert (work.parent / 'OFFSITE_AUDIT_HOST').is_file()
name = sys.argv[1]
assert name.isidentifier()
root = work / name
root.mkdir(mode=0o700)
source = Path(__file__).resolve().parents[1] / 'native/claude/approved_launch_macos.c'
component = root / 'policy-failure.c'
component.write_text('#define sandbox_init_with_parameters synthetic_policy_failure\n'
    '#include ' + json.dumps(str(source)) + '\n'
    'int synthetic_policy_failure(const char *p,uint64_t f,const char *const *v,char **e){'
    '(void)p;(void)f;(void)v;(void)e;'
    'fputs("SYNTHETIC_POLICY_FAILURE_REACHED\\n",stderr);return -1;}\n')
subprocess.run(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror',
                str(component), '-o', str(root / 'launcher')], check=True)
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime',
                str(root / 'launcher')], check=True, capture_output=True)
marker = root / 'payload-executed'
payload = root / 'claude'
payload.write_text('#!/bin/sh\nprintf reached > ' + str(marker) + '\n')
payload.chmod(0o700)
subprocess.run([str(payload)], check=True)
assert marker.read_text() == 'reached'
marker.unlink()
identity = hashlib.sha256(component.read_bytes()).hexdigest()
package = Path('/opt/aimgr-claude-runtime/artifacts') / identity
assert not package.exists()
installer = '''import os,shutil,sys
from pathlib import Path
source,target=map(Path,sys.argv[1:]);assert os.geteuid()==0
assert target.parent==Path('/opt/aimgr-claude-runtime/artifacts')
target.mkdir(mode=0o755)
for name in ['launcher','claude']:
 p=target/name;shutil.copyfile(source/name,p);os.chown(p,0,0);p.chmod(0o755)
'''
subprocess.run(['sudo', '-n', '/usr/bin/python3', '-I', '-c', installer,
                str(root), str(package)], check=True)
for directory in ['config', 'scratch']:
    (root / directory).mkdir()
(root / 'settings.json').write_text('{}')
rows = []
try:
    for mode in ['ordinary', 'protected']:
        with tempfile.TemporaryFile(dir=root) as transfer:
            transfer.write(b'PATH=/usr/bin:/bin\0')
            transfer.flush()
            cmd = [str(package / 'launcher'), 'v1', mode, str(root / 'config'),
                   str(root / 'settings.json'), str(root / 'scratch'),
                   str(transfer.fileno()), '0', '0', '--']
            result = subprocess.run(cmd, pass_fds=(transfer.fileno(),),
                                    capture_output=True, text=True, timeout=10)
        (root / (mode + '.stderr.txt')).write_text(result.stderr)
        assert result.returncode == 125 and not marker.exists()
        assert 'SYNTHETIC_POLICY_FAILURE_REACHED' in result.stderr
        assert 'policy application' in result.stderr
        rows.append({'mode': mode, 'exit': result.returncode,
                     'policyApplicationFailureReached': True, 'payloadExecuted': False})
finally:
    # These two files were created above solely for the component experiment.
    # No active selector/approval or admitted package is altered.
    cleanup = 'from pathlib import Path;import sys;p=Path(sys.argv[1]);' \
              'assert sorted(x.name for x in p.iterdir())==["claude","launcher"];' \
              '(p/"claude").unlink();(p/"launcher").unlink();p.rmdir()'
    subprocess.run(['sudo', '-n', '/usr/bin/python3', '-I', '-c', cleanup,
                    str(package)], check=True)
report = {'passed': True, 'scope': 'Compiled production-source component with syscall fault injection',
          'productionSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'payloadPositiveControl': True, 'hostEnforcementChanged': False,
          'admittedHelperChanged': False, 'rows': rows}
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
