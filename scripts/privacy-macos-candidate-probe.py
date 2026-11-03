#!/usr/bin/env python3
"""Exercise the real immutable Mac candidate without granting normal-use approval.

The cloud host has independent outbound denial; all model requests terminate in
the existing loopback fixture. This tests native entry, not complete AIM routing
or real-account workflows. Preserve failures rather than reusing result roots.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

base = Path('/opt/aimgr-state-audit')
work = base / 'claude-implementation'
assert platform.system() == 'Darwin' and os.getuid() != 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
installed = json.loads((work / 'mac-candidate-staging/installed.json').read_text())
package = Path(installed['root'])
launcher, vendor = package / 'launcher', package / 'claude'
assert hashlib.sha256(vendor.read_bytes()).hexdigest() == '09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9'
root = work / 'mac-candidate-boundary-v1'
root.mkdir(mode=0o700)
config, scratch = root / 'config', root / 'scratch'
config.mkdir(); scratch.mkdir()
settings = root / 'settings.json'
settings.write_text(json.dumps({'disableRemoteControl': True, 'env': {'DISABLE_GROWTHBOOK': '1', 'DISABLE_UPDATES': '1'}}))
report = {'artifactSet': installed['artifactSet'], 'scope': 'Native candidate tests only; full AIM integration is still required'}

def invoke(mode='validate', selected_config=config, selected_scratch=scratch):
    with tempfile.TemporaryFile(dir=root) as transfer:
        transfer.write(b'PATH=/usr/bin:/bin\0ANTHROPIC_API_KEY=synthetic-must-not-reach-doctor\0')
        transfer.flush()
        args = [str(launcher), 'v1', mode, str(selected_config), str(settings), str(selected_scratch), str(transfer.fileno()), '0', '0', '--']
        return subprocess.run(args, cwd=scratch, env={'PATH': '/usr/bin:/bin'}, pass_fds=(transfer.fileno(),), capture_output=True, text=True, timeout=15)

doctor = invoke()
(root / 'doctor.private.txt').write_text(doctor.stdout + doctor.stderr)
report['validator'] = {'exit': doctor.returncode, 'complete': doctor.stdout.startswith('Claude Code doctor\n') and 'Remote Control is disabled' in doctor.stdout and doctor.stdout.rstrip().endswith('For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.'), 'noAuth': 'Managed settings (remote): not fetched — no usable credentials' in doctor.stdout, 'stderrEmpty': doctor.stderr == ''}
report['rootGrantRefused'] = {mode: invoke(mode, selected_scratch=Path('/')).returncode == 125 for mode in ['validate', 'ordinary', 'protected']}
report['rootConfigRefused'] = invoke('protected', selected_config=Path('/')).returncode == 125

# Exercise the actual closure implementation, including a descriptor retained
# above a subsequently lowered hard limit. A limit-based loop fails this case.
source = work / 'repo/native/claude/approved_launch_macos.c'
fd_source = root / 'descriptor-test.c'
fd_source.write_text('#define main approved_entry_main\n#include ' + json.dumps(str(source)) + '\n#undef main\nint main(void){int fd=open("/dev/null",O_RDONLY);if(fd<0||dup2(fd,200)!=200)return 1;struct rlimit r={64,64};if(setrlimit(RLIMIT_NOFILE,&r))return 2;if(fcntl(200,F_GETFD)<0)return 3;close_inherited_descriptors();return fcntl(200,F_GETFD)==-1&&errno==EBADF?0:4;}\n')
fd_binary = root / 'descriptor-test'
subprocess.run(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror', str(fd_source), '-o', str(fd_binary)], check=True)
report['highDescriptorClosed'] = subprocess.run([str(fd_binary)]).returncode == 0

# The reentry privilege is applied by the kernel before main. The installed
# image's hardened signature must reject an injected pre-main constructor.
marker, library, library_source = root / 'constructor-marker', root / 'constructor.dylib', root / 'constructor.c'
library_source.write_text('#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void start(void){int fd=open(' + json.dumps(str(marker)) + ',O_WRONLY|O_CREAT,0600);if(fd>=0){write(fd,"injected",8);close(fd);}}\n')
subprocess.run(['/usr/bin/clang', '-dynamiclib', str(library_source), '-o', str(library)], check=True)
policy = '(version 1)(allow default)(deny file-write* (literal ' + json.dumps(str(marker)) + '))(allow process-exec (literal ' + json.dumps(str(launcher)) + ') (with no-sandbox))'
code = 'import os,subprocess;env=dict(os.environ);env["DYLD_INSERT_LIBRARIES"]=' + repr(str(library)) + ';p=subprocess.run(' + repr([str(launcher), 'bad-role']) + ',env=env,capture_output=True);print(p.returncode)'
injected = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/python3', '-c', code], capture_output=True, text=True, timeout=15)
report['constructorRejected'] = injected.returncode == 0 and injected.stdout.strip() == '125' and not marker.exists()

probe = work / 'repo/scripts/privacy-claude-policy-probe.py'
for label in ['a', 'b']:
    canary = work / ('hidden-canary-' + label)
    assert canary.read_text() == 'SYNTHETIC_FILE_CANARY'

def model_case(label, mode, check=None):
    command = ['/usr/bin/python3', str(probe), '--root', str(work / ('mac-candidate-' + label)), '--claude', str(vendor), '--case', 'privacy-overlay', '--approved-mac-launcher', str(launcher), '--privacy-mode', mode, '--file-canary', str(work / 'hidden-canary-b')]
    if check: command += ['--tool-check', str(check)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=130)
    (root / (label + '.private.txt')).write_text(result.stdout + result.stderr)
    return json.loads(result.stdout)['results'][0] if result.returncode == 0 else {'fixtureExit': result.returncode}

report['ordinary'] = model_case('ordinary-boundary-v1', 'ordinary')
check = work / 'mac-candidate-nested-check-v1.py'
check.write_text('''import json,os,subprocess
from pathlib import Path
work=Path('/opt/aimgr-state-audit/claude-implementation')
package=Path(''' + repr(str(package)) + ''')
home=work/'mac-candidate-protected-boundary-v1/privacy-overlay'
snapshot=home/'overlay-0.json'
original=snapshot.read_bytes()
blocked={}
for name,action in [('overwrite',lambda:snapshot.write_text('changed')),('unlink',lambda:snapshot.unlink()),('rename',lambda:snapshot.rename(snapshot.with_suffix('.moved')))]:
 try:action();blocked[name]=False
 except PermissionError:blocked[name]=True
blocked['bytesPreserved']=snapshot.read_bytes()==original
update=home/'unapproved-update'
try:(update/'new-executable').write_text('unapproved');blocked['updateWrite']=False
except PermissionError:blocked['updateWrite']=True
rows=[]
for target in ['a','b']:
 # B's config/scratch/settings do not exist when A enters its policy.
 args=['/usr/bin/python3',str(work/'repo/scripts/privacy-claude-policy-probe.py'),'--root',str(work/('mac-candidate-nested-'+target+'-v1')),'--claude',str(package/'claude'),'--case','privacy-overlay','--approved-mac-launcher',str(package/'launcher'),'--privacy-mode','protected','--file-canary',str(work/('hidden-canary-'+target)),'--read-root',str(work/'hidden-canary-b')]
 result=subprocess.run(args,capture_output=True,text=True,timeout=45)
 (work/('mac-candidate-nested-'+target+'-v1.private.txt')).write_text(result.stdout+result.stderr)
 row=json.loads(result.stdout)['results'][0] if result.returncode==0 else {'fixtureExit':result.returncode}
 rows.append(row)
_aim_probe_result={'snapshotAndUpdater':blocked,'nested':rows}
''')
report['protected'] = model_case('protected-boundary-v1', 'protected', check)
ordinary, protected = report['ordinary'], report['protected']
nested = (protected.get('toolEnvironment') or {}).get('nativeToolCheck') or {}
rows = nested.get('nested', [])
report['passed'] = (all(report['rootGrantRefused'].values()) and report['rootConfigRefused'] and report['highDescriptorClosed'] and report['constructorRejected']
    and report['validator'] == {'exit': 0, 'complete': True, 'noAuth': True, 'stderrEmpty': True}
    and ordinary.get('exit') == 0 and ordinary.get('nativeReadReturnedCanary') is True
    and protected.get('exit') == 0 and protected.get('nativeReadError') is True and protected.get('nativeReadReturnedCanary') is False
    and '- OS Version: Darwin unknown' in protected.get('automaticEnvironmentLines', [])
    and (protected.get('toolEnvironment') or {}).get('toolUnameMatchesHost') is True
    and len(rows) == 2 and all(r.get('exit') == 0 for r in rows)
    and rows[0].get('nativeReadError') is True and rows[0].get('nativeReadReturnedCanary') is False and rows[1].get('nativeReadReturnedCanary') is True
    and nested.get('snapshotAndUpdater') == {'overwrite': True, 'unlink': True, 'rename': True, 'bytesPreserved': True, 'updateWrite': True})
(root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['passed'] else 1)
