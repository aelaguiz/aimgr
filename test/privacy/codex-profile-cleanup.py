#!/usr/bin/env python3
"""Real AppArmor cleanup uncertainty controls on the disposable Linux VM.

The unchanged cleanup code is compiled into a fixture driver. Injected task
birth/death and a failed proc read occur during its actual task scan; no
production fault switches, client credentials or network requests are used.
"""
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import sys
import tempfile

assert sys.platform == 'linux' and os.getuid() == 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='profile-cleanup-', dir='/opt/aimgr-state-audit'))
user = pwd.getpwnam('aimdev')
namespace = Path('/proc/self/ns/pid').stat().st_ino
prefix = f'aim-codex-p-{user.pw_uid}-n{namespace}-'
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
 if(argc!=3 || getuid()!=0)return 2;
 caller=(uid_t)atoi(argv[1]);mode=atoi(argv[2]);
 if(mode==2){owned_child=fork();if(!owned_child)for(;;)pause();if(owned_child<0)return 3;}
 int lock=open(RUNTIME "/policy.lock",O_RDONLY|O_CLOEXEC);if(lock<0)return 5;
 codex_prune_profiles(lock,codex_pid_namespace());close(lock);
 if(owned_child){kill(owned_child,SIGTERM);waitpid(owned_child,NULL,0);}
 printf("%d\n",triggered);return 0;
}
'''.replace('#include SOURCE', '#include ' + json.dumps(str(repo / 'native/codex/approved_launch_linux.c'))))
subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(root / 'driver')], check=True)
created = []
def install(tagged=True):
    name = (prefix if tagged else f'aim-codex-p-{user.pw_uid}-') + secrets.token_hex(16)
    policy = ''.join(f'profile {n} flags=(enforce) {{ / rw, /** rwmlkix, }}\n' for n in (name, name + '-tools'))
    subprocess.run(['/usr/sbin/apparmor_parser', '-a', '-T'], input=policy, text=True, check=True)
    created.extend([name, name + '-tools'])
    return name

def installed(name):
    labels = {line.split(' ', 1)[0] for line in Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()}
    return name in labels and name + '-tools' in labels

def drive(mode=0, before=None):
    cmd = [str(root / 'driver'), str(user.pw_uid), str(mode)]
    if before:
        cmd = ['unshare', '-m', 'python3', '-c', before, *cmd]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return r.stdout.strip()

try:
    for mode, label in [(1, 'task birth'), (2, 'task exit'), (3, 'unreadable label')]:
        name = install()
        assert drive(mode) == '1', 'scan injection not reached'
        assert installed(name), label + ' must retain the pair'
        print('PASS cleanup skipped on ' + label)
    for counter in ['stat', 'loadavg']:
        name = install()
        copy = root / ('masked-' + counter)
        copy.write_bytes((Path('/proc') / counter).read_bytes())
        script = 'import os,subprocess,sys; subprocess.run(["mount","--make-rprivate","/"],check=True); subprocess.run(["mount","--bind",' + repr(str(copy)) + ',' + repr('/proc/' + counter) + '],check=True); os.execv(sys.argv[1],sys.argv[1:])'
        assert drive(before=script) == '0'
        assert installed(name)
        print('PASS cleanup skipped on masked /proc/' + counter)
    name = install()
    r = subprocess.run(['unshare', '-mpf', '--mount-proc', str(root / 'driver'), str(user.pw_uid), '0'], capture_output=True, text=True, check=True)
    assert installed(name), 'nested namespace cannot prune ancestor pairs'
    print('PASS nested PID namespace retains ancestor pair')
    legacy = install(False)
    for _ in range(8):
        drive()
        if not installed(name): break
    assert not installed(name), 'quiet scan must reclaim inactive tagged pair'
    assert installed(legacy), 'legacy untagged pair must remain untouched'
    print('PASS quiet scan prunes tagged inactive pairs and preserves untagged profiles')
    print(json.dumps(dict(fixture=root.name, realVendorExecuted=False)))
finally:
    # Only this fixture's inactive policies; no profile used by a running client.
    for name in created:
        try:
            with open('/sys/kernel/security/apparmor/.remove', 'wb', buffering=0) as out:
                out.write(name.encode())
        except FileNotFoundError:
            pass
