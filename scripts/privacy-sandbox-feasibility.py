#!/usr/bin/env python3
"""Bounded whole-process isolation experiment, only on the offsite Linux VM.

This is a research fixture, NOT an AI Manager launcher or a production policy.
Run as root inside a fresh network namespace with loopback only. Bubblewrap sets
up a restricted filesystem/process view, then the payload drops to the synthetic
audit user. No real credentials, personal home or host service sockets are mounted.
The existing official-binary audit is run unchanged inside that view.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import socket
import subprocess
import sys

BASE = Path('/opt/aimgr-state-audit')
parser=argparse.ArgumentParser()
parser.add_argument('--exercise-tools',action='store_true',help='Use a fresh fixture for two actual model-selected native tool cases.')
args=parser.parse_args()
ROOT = BASE / ('linux-sandbox-workflow-verified' if args.exercise_tools else 'linux-sandbox-feasibility')
if platform.system() != 'Linux' or os.geteuid() != 0 or not (BASE / 'OFFSITE_AUDIT_HOST').is_file():
    raise SystemExit('Requires the marked offsite Linux audit VM, root in its isolated network namespace.')
# sysfs may still be the host mount after unshare; query the current network
# namespace through the socket API instead of mistaking that mount for routing.
if sorted(name for _, name in socket.if_nameindex()) != ['lo']:
    raise SystemExit('Refusing network namespace with interfaces other than loopback.')
if ROOT.exists():
    raise SystemExit('Refusing reused research fixture.')
user = pwd.getpwnam('aimprivacy')
ROOT.mkdir(mode=0o755)
for name in ['private-host', 'shared', 'etc', 'model-audit', 'home']:
    p = ROOT / name
    p.mkdir(mode=0o755)
    os.chown(p, user.pw_uid, user.pw_gid)
secret = ROOT / 'private-host' / 'personal-identity.txt'
secret.write_text('SYNTHETIC-HOST-IDENTITY-DO-NOT-EXPOSE\n')
os.chown(secret, user.pw_uid, user.pw_gid)
project = ROOT / 'shared'
(project / 'escape-link').symlink_to(secret)
(project / 'README.md').write_text('Synthetic shared project.\n')
os.chown(project / 'README.md', user.pw_uid, user.pw_gid)
for name, text in {
    'passwd': f'aimprivacy:x:{user.pw_uid}:{user.pw_gid}:Synthetic audit:/home/agent:/bin/bash\n',
    'group': f'aimprivacy:x:{user.pw_gid}:\n',
    'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
    'hosts': '127.0.0.1 localhost\n',
    'machine-id': '11111111111111111111111111111111\n',
}.items():
    (ROOT / 'etc' / name).write_text(text)
# /usr/bin/cc on this Ubuntu image resolves through this system toolchain link.
# Keep that exact link in the synthetic /etc; exposing the entire host /etc to
# repair a compiler dependency would reopen unrelated state and machine IDs.
alternatives=ROOT/'etc/alternatives';alternatives.mkdir()
compiler=Path('/etc/alternatives/cc')
if compiler.is_symlink():
    target=compiler.resolve()
    if not str(target).startswith('/usr/'):
        raise SystemExit('Unexpected compiler alternative outside the mounted toolchain')
    (alternatives/'cc').symlink_to(target)

# No bind of /, /home, /run, /sys, a host socket, or a personal application home.
# All descendants receive the same mount/PID/UTS/network view; no shell escape
# or host execution broker is introduced to make a denied operation succeed.
# Ubuntu's enabled AppArmor restriction denies the audit user's UID mapping.
# Do not disable that system policy. This research fixture uses root for mount
# setup, then setpriv drops all groups/capabilities and UID before any payload.
# A production installer/privilege design remains untested and unapproved.
base = ['/usr/bin/bwrap', '--unshare-pid', '--unshare-uts', '--unshare-ipc',
        '--hostname', 'agent-fixture', '--new-session', '--die-with-parent',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--remount-ro', '/proc',
        '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', str(ROOT / 'etc'), '/etc',
        # Explicit traversal permissions: root-created implicit bwrap parents
        # are mode 0700, which would make an otherwise writable bind unusable
        # after dropping UID. This changes only the private namespace tree.
        '--perms', '0755', '--dir', '/home',
        '--perms', '0755', '--dir', '/opt',
        '--perms', '0755', '--dir', str(BASE),
        '--perms', '0755', '--dir', str(ROOT),
        '--bind', str(ROOT / 'home'), '/home/agent',
        '--bind', str(project), str(project),
        '--bind', str(ROOT / 'model-audit'), str(ROOT / 'model-audit'),
        '--ro-bind', str(BASE / 'bin'), str(BASE / 'bin'),
        '--ro-bind', str(BASE / 'audit.py'), str(BASE / 'audit.py'),
        '--ro-bind', str(BASE / 'OFFSITE_AUDIT_HOST'), str(BASE / 'OFFSITE_AUDIT_HOST'),
        '--clearenv', '--setenv', 'HOME', '/home/agent', '--setenv', 'USER', 'aimprivacy',
        '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'TERM', 'xterm-256color',
        '--chdir', str(project)]

def run(command, extra=(), timeout=120):
    drop = ['/usr/bin/setpriv', '--reuid', str(user.pw_uid), '--regid', str(user.pw_gid),
            '--clear-groups', '--bounding-set=-all', '--inh-caps=-all',
            '--ambient-caps=-all', '--no-new-privs']
    return subprocess.run(base + list(extra) + ['--'] + drop + command, text=True,
                          capture_output=True, timeout=timeout, close_fds=True)

probe = r'''
import errno, json, os, pathlib, pty, socket, subprocess
root = pathlib.Path(os.getcwd())
hidden = pathlib.Path(root.parent / 'private-host/personal-identity.txt')
def readable(p):
    try: return pathlib.Path(p).read_text()
    except OSError: return None
child = subprocess.run(['/bin/cat', str(hidden)], capture_output=True, text=True)
(root/'edited-in-sandbox.txt').write_text('workspace edits remain visible\n')
subprocess.run(['git', 'init', '-q', str(root)], check=True)
git = subprocess.run(['git', 'status', '--porcelain'], cwd=root, capture_output=True, text=True)
master, slave = pty.openpty(); tty = os.isatty(slave); os.close(master); os.close(slave)
network = socket.socket(); network.settimeout(.3)
try:
    network.connect(('192.0.2.1',443)); denied = False
except OSError: denied = True
finally: network.close()
print(json.dumps({
 'privateFileHidden':readable(hidden) is None,
 'symlinkEscapeDenied':readable(root/'escape-link') is None,
 'childPrivateReadDenied':child.returncode != 0,
 'ambientSecretAbsent':'SYNTHETIC_AMBIENT_SECRET' not in os.environ,
 'hostHomeAbsent':not pathlib.Path('/home/aimdev').exists(),
 'hostSysfsAbsent':not pathlib.Path('/sys').exists(),
 'hostSocketsAbsent':not pathlib.Path('/run').exists(),
 'machineIdIsFixture':readable('/etc/machine-id').strip()=='1'*32,
 'hostnameIsFixture':socket.gethostname()=='agent-fixture',
 'kernelRelease':os.uname().release,
 'procPids':[p.name for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()],
 'gitWorks':git.returncode==0 and 'README.md' in git.stdout,
 'ptyWorks':tty, 'externalNetworkDenied':denied,
 'cpuInfoStillVisible':readable('/proc/cpuinfo') is not None,
 'memInfoStillVisible':readable('/proc/meminfo') is not None,
 'unprivilegedPayload':os.getuid()!=0 and 'CapEff:\t0000000000000000' in readable('/proc/self/status'),
}))
'''
os.environ['SYNTHETIC_AMBIENT_SECRET'] = 'must-not-inherit'
control = subprocess.run(['runuser','-u','aimprivacy','--','cat',str(secret)], capture_output=True, text=True)
r = run(['/usr/bin/python3', '-c', probe])
if r.returncode:
    (ROOT/'initial-failure.txt').write_text(r.stderr)
    raise SystemExit('Boundary fixture failed: ' + r.stderr)
result = json.loads(r.stdout)
result['sameUserUnsandboxedCanaryReadable'] = 'SYNTHETIC-HOST-IDENTITY' in control.stdout
result['workspaceEditVisibleOutside'] = (project/'edited-in-sandbox.txt').read_text().startswith('workspace edits')
result['sameKernelAsHost'] = result['kernelRelease'] == os.uname().release
result['bubblewrapVersion'] = subprocess.check_output(['bwrap','--version'],text=True).strip()
result['runtime'] = {'platform':platform.platform(), 'python':platform.python_version()}

# A tempting config/auth design is to bind individual shared files into each
# private home. Reproduce why it is not transparent: native atomic replacement
# cannot rename over a mount point, and an external replacement leaves the
# running mount on the old inode. Do not ship that design as a compatibility fix.
config = project/'shared-config.toml'
config.write_text('version = 1\n'); os.chown(config,user.pw_uid,user.pw_gid)
atomic = r'''
import json, os, pathlib
p=pathlib.Path('/home/agent/config.toml'); t=p.with_suffix('.new')
t.write_text('version = 2\n')
try: os.replace(t,p); result={'succeeded':True}
except OSError as e: result={'succeeded':False,'errno':e.errno,'error':e.strerror}
print(json.dumps(result))
'''
r = run(['/usr/bin/python3','-c',atomic], ['--bind',str(config),'/home/agent/config.toml'])
result['individualFileMountAtomicReplace'] = json.loads(r.stdout) if r.returncode==0 else {'fixtureFailure':r.stderr}

model_command=['/usr/bin/python3',str(BASE/'audit.py'),'--root',str(ROOT/'model-audit'),
               '--codex',str(BASE/'bin/codex'),'--claude',str(BASE/'bin/claude')]
if args.exercise_tools:model_command+=['--fresh-only','--exercise-tools']
models = run(model_command,timeout=400)
(ROOT/'model-output.txt').write_text(models.stdout)
(ROOT/'model-errors.txt').write_text(models.stderr)
result['modelHarnessExitCode'] = models.returncode
summary = ROOT/'model-audit/summary.json'
result['modelSummaryPresent'] = summary.exists()
model_summary = json.loads(summary.read_text()) if summary.exists() else {}
result['modelIdentityChecks'] = model_summary.get('checks', [])
result['modelIdentityAssertionsPassed'] = model_summary.get('allPassed') is True
# Store compact per-case facts, not raw prompts, tokens, or filesystem listings.
cases=[]
for p in sorted((ROOT/'model-audit').glob('*.json')):
    obj=json.loads(p.read_text())
    if isinstance(obj,dict) and 'case' in obj:
        cases.append({k:obj[k] for k in ['case','exitCode','modelRequestCount','identifierHashes','diskIdentifierHash','userAgents']})
        if args.exercise_tools:
            cases[-1].update(workflow=obj.get('workflow'),toolOutputReturned=obj.get('toolOutputReturned'))
result['modelCases']=cases
checks=['privateFileHidden','symlinkEscapeDenied','childPrivateReadDenied','ambientSecretAbsent',
        'hostHomeAbsent','hostSysfsAbsent','hostSocketsAbsent','machineIdIsFixture','hostnameIsFixture',
        'gitWorks','ptyWorks','externalNetworkDenied','sameUserUnsandboxedCanaryReadable','workspaceEditVisibleOutside',
        'unprivilegedPayload']
result['boundedChecksPassed']=all(result[k] for k in checks)
models_passed=(models.returncode==0 and result['modelIdentityAssertionsPassed']
              and len(cases)==(2 if args.exercise_tools else 10)
              and all(c['exitCode']==0 and c['modelRequestCount']>0 for c in cases))
result['allNativeWorkflowCasesPassed' if args.exercise_tools else 'allTenModelCasesPassed']=models_passed
(ROOT/'public-results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
sys.exit(0 if result['boundedChecksPassed'] and models_passed else 1)
