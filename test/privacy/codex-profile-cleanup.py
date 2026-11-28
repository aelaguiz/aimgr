#!/usr/bin/env python3
"""Real AppArmor cleanup uncertainty controls on the disposable Linux VM.

The production cleanup code is compiled into a fixture driver for Codex or
Antigravity. Task changes and read failures are injected into its scan.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import secrets
import select
import signal
import subprocess
import sys
import tempfile

assert sys.platform == 'linux' and os.getuid() == 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
assert len(sys.argv) <= 2, 'usage: codex-profile-cleanup.py [codex|agy]'
provider = sys.argv[1] if len(sys.argv) == 2 else 'codex'
assert provider in ('codex', 'agy')
repo = Path(__file__).resolve().parents[2]
temporary = tempfile.TemporaryDirectory(prefix='profile-cleanup-', dir='/opt/aimgr-state-audit')
root = Path(temporary.name)
fixture_uid = (1 << 30) + os.getpid()
try:
    pwd.getpwuid(fixture_uid)
except KeyError:
    pass
else:
    raise RuntimeError('fixture UID is assigned to a local user')
namespace = Path('/proc/self/ns/pid').stat().st_ino
lock_path = root / 'policy.lock'
lock_path.touch(mode=0o600, exist_ok=False)
source = root / 'driver.c'
source.write_text(r'''
#define _GNU_SOURCE
#include <sys/types.h>
#include <unistd.h>
static ssize_t fixture_read(int,void *,size_t);
#define read fixture_read
#define main production_main
#include SOURCE
#undef main
#undef read
static int mode,triggered;
static pid_t owned_child;
static ssize_t fixture_read(int fd,void *buf,size_t size) {
 char name[80],file[4096];snprintf(name,sizeof(name),"/proc/self/fd/%d",fd);
 ssize_t n=readlink(name,file,sizeof(file)-1);if(n>0)file[n]=0;
 if(!triggered && n>0 && strstr(file,"/attr/current")) {
  triggered=1;
  if(mode==1){owned_child=fork();if(!owned_child)for(;;)pause();if(owned_child<0)_exit(3);}
  if(mode==2){kill(owned_child,SIGTERM);if(waitpid(owned_child,NULL,0)!=owned_child)_exit(4);owned_child=0;}
  if(mode==3){errno=EACCES;return -1;}
 }
 return read(fd,buf,size);
}
int main(int argc,char **argv) {
 if((argc!=4 && argc!=5) || getuid()!=0)return 2;
 caller=(uid_t)atoi(argv[1]);mode=atoi(argv[2]);
 if(argc==5){
  if(strlen(argv[4])>=sizeof(profile))return 2;
  strcpy(profile,argv[4]);enter_profile();
  owned_child=fork();if(owned_child<0)return 3;
  if(!owned_child){close(0);close(1);close(2);alarm(30);for(;;)pause();}
  printf("%ld\n",(long)owned_child);return 0;
 }
 if(mode==2){owned_child=fork();if(!owned_child)for(;;)pause();if(owned_child<0)return 3;}
 int lock=open(argv[3],O_RDONLY|O_CLOEXEC);if(lock<0)return 5;
 prune_profiles(lock,PROVIDER,profile_pid_namespace());close(lock);
 if(owned_child){kill(owned_child,SIGTERM);waitpid(owned_child,NULL,0);}
 printf("%d\n",triggered);return 0;
}
'''.replace('#include SOURCE', '#include ' + json.dumps(str(repo / f'native/{provider}/approved_launch_linux.c'))))
subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', f'-DPROVIDER="{provider}"', str(source), '-o', str(root / 'driver')], check=True)
created = []
possibly_live = set()

def install(tagged=True, kind=provider):
    namespace_tag = f'n{namespace}-' if tagged else ''
    name = f'aim-{kind}-p-{fixture_uid}-{namespace_tag}{secrets.token_hex(16)}'
    policy = ''.join(f'profile {n} flags=(enforce) {{ / rw, /** rwmlkix, signal, }}\n' for n in (name, name + '-tools'))
    subprocess.run(['/usr/sbin/apparmor_parser', '-a', '-T'], input=policy, text=True, check=True)
    created.extend([name, name + '-tools'])
    return name

def loaded(name):
    labels = {line.split(' ', 1)[0] for line in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()}
    return len({name, name + '-tools'} & labels)

def driver(mode=0):
    return [str(root / 'driver'), str(fixture_uid), str(mode), str(lock_path)]

def drive(mode=0, before=None):
    cmd = driver(mode)
    if before:
        cmd = ['unshare', '-m', 'python3', '-c', before, *cmd]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=10)
    return r.stdout.strip()

try:
    for mode, label in [(1, 'task birth'), (2, 'task exit'), (3, 'unreadable label')]:
        name = install()
        assert drive(mode) == '1', 'scan injection not reached'
        assert loaded(name) == 2, label + ' must retain the pair'
        print('PASS cleanup skipped on ' + label)
    for counter in ['stat', 'loadavg']:
        name = install()
        copy = root / ('masked-' + counter)
        copy.write_bytes((Path('/proc') / counter).read_bytes())
        script = 'import os,subprocess,sys; subprocess.run(["mount","--make-rprivate","/"],check=True); subprocess.run(["mount","--bind",' + repr(str(copy)) + ',' + repr('/proc/' + counter) + '],check=True); os.execv(sys.argv[1],sys.argv[1:])'
        assert drive(before=script) == '0'
        assert loaded(name) == 2
        print('PASS cleanup skipped on masked /proc/' + counter)
    name = install()
    subprocess.run(['unshare', '-mpf', '--mount-proc', *driver()], capture_output=True, text=True, check=True, timeout=10)
    assert loaded(name) == 2, 'nested namespace cannot prune ancestor pairs'
    print('PASS nested PID namespace retains ancestor pair')
    with lock_path.open('rb') as loading:
        fcntl.flock(loading, fcntl.LOCK_SH)
        assert drive() == '0', 'cleanup must not scan while another launcher holds the shared lock'
        assert loaded(name) == 2
    print('PASS in-flight launcher blocks cleanup')

    legacy = install(False)
    foreign = install(kind='codex' if provider == 'agy' else 'agy')
    live = install()
    tools = live + '-tools'
    possibly_live.update((live, tools))
    child = subprocess.run([*driver(), tools], capture_output=True, text=True, check=True, timeout=10)
    pid = int(child.stdout)
    pidfd = os.pidfd_open(pid)
    try:
        current = Path(f'/proc/{pid}/attr/current')
        assert current.read_text().strip() == f'{tools} (enforce)'
        for _ in range(8):
            drive()
            if loaded(name) == 0: break
        assert loaded(name) == 0, 'quiet scan must reclaim both inactive tagged profiles'
        assert loaded(live) == 2, 'the surviving tool must retain its pair'
        assert current.read_text().strip() == f'{tools} (enforce)'
    finally:
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            assert select.select([pidfd], [], [], 5)[0], 'fixture child did not exit'
            possibly_live.clear()
        finally:
            os.close(pidfd)
    for _ in range(8):
        drive()
        if loaded(live) == 0: break
    assert loaded(live) == 0, 'the surviving tool pair must be reclaimed after the tool exits'
    assert loaded(legacy) == 2, 'legacy untagged pair must remain untouched'
    assert loaded(foreign) == 2, 'another provider’s pair must remain untouched'
    print('PASS quiet scan retains a surviving tool and reclaims its pair after exit')
    print('PASS legacy untagged pairs and other providers are preserved')
    print(json.dumps(dict(fixture=root.name, provider=provider, realVendorExecuted=False)))
finally:
    # Only this fixture's inactive policies; no profile used by a running client.
    for name in created:
        if name in possibly_live:
            continue
        try:
            with open('/sys/kernel/security/apparmor/.remove', 'wb', buffering=0) as out:
                out.write(name.encode())
        except FileNotFoundError:
            pass
