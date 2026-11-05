#!/usr/bin/env python3
"""Actual AppArmor tool/reentry checks with synthetic native vendor images.

Run as root only on the isolated Linux host. The production launchers are
compiled unchanged; no real vendor, login, active selector or approval is used.
"""
import ctypes
import json
import os
from pathlib import Path
import pwd
import secrets
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
base = Path('/opt/aimgr-state-audit')
assert sys.platform == 'linux' and (base / 'OFFSITE_AUDIT_HOST').is_file()

def invoke(fixture, provider, arguments, scratch=None):
    case = Path(fixture['root']) / provider
    package = Path(fixture['packages'][provider])
    env = dict(os.environ, HOME=str(case / 'home'), SYNTHETIC_CANARY=str(Path(fixture['root']) / 'private-canary'),
               SYNTHETIC_OTHER_SCRATCH=fixture['otherScratch'],
               SYNTHETIC_ACCOUNT_PARENT=fixture['root'],
               SYNTHETIC_INPUT_PARENT=str(Path(fixture['root']) / 'inputs'),
               SYNTHETIC_DATABASE_PARENT=str(Path(fixture['root']) / 'databases'))
    with tempfile.TemporaryFile(dir=case) as transfer:
        os.fchmod(transfer.fileno(), 0o600)
        transfer.write(b''.join((k + '=' + v).encode() + b'\0' for k, v in env.items()))
        transfer.flush()
        if provider == 'codex':
            args = ['v1', str(case), str(case / 'home'), str(scratch or fixture['codexScratch']), str(transfer.fileno()),
                    '1', str(case / 'project'), '1', str(Path(fixture['root']) / 'inputs/selected'),
                    '1', str(Path(fixture['root']) / 'databases/selected'), '0', '--']
        else:
            args = ['v1', 'protected', str(case / 'home'), str(case / 'settings.json'),
                    str(case / 'scratch'), str(transfer.fileno()), '1', str(case / 'project'), '0', '--']
        child = subprocess.Popen([str(package / 'launcher'), *args, *arguments], pass_fds=(transfer.fileno(),),
                              cwd=case / 'project', env={'PATH': '/usr/bin:/bin'}, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            output, errors = child.communicate(timeout=40)
            return subprocess.CompletedProcess(child.args, child.returncode, output, errors)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)

def observation(result, tools=False):
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert len(lines) == 3, result.stdout
    ordinary = '//&' not in lines[0] and lines[0].endswith('-tools (enforce)')
    assert ordinary == tools and '(enforce)' in lines[0], lines[0]
    assert lines[1:] == (['read=1', 'uname=1'] if tools else ['read=0', 'uname=0']), lines
    return lines[0]

if len(sys.argv) > 1:
    phase, file, provider = sys.argv[1:]
    fixture = json.loads(Path(file).read_text())
    if phase == '--tool':
        assert os.getuid() != 0
        case = Path(fixture['root']) / provider
        assert Path(os.environ['SYNTHETIC_CANARY']).read_text() == 'SYNTHETIC_PRIVATE'
        assert '-tools (enforce)' in Path('/proc/self/attr/current').read_text()
        parent_label = Path('/proc/self/attr/current').read_text().strip()
        (case / 'parent-ready').touch()
        next_bundle = case / 'next-bundle.json'
        deadline = time.monotonic() + 20
        while not next_bundle.exists():
            assert time.monotonic() < deadline, 'late bundle installation timed out'
            time.sleep(.05)
        package = Path(fixture['packages'][provider])
        images = [package / provider]
        if provider == 'codex': images.append(package / 'codex-code-mode-host')
        for image in images:
            observation(subprocess.run([str(image), 'probe'], capture_output=True, text=True))
            observation(subprocess.run([str(image), 'self'], capture_output=True, text=True))
            if provider == 'codex':
                # An ordinary requested tool still sees the directory entries.
                for key in ['SYNTHETIC_ACCOUNT_PARENT', 'SYNTHETIC_INPUT_PARENT', 'SYNTHETIC_DATABASE_PARENT']:
                    assert list(Path(os.environ[key]).iterdir())
                denied = subprocess.run([str(image), 'private-parents'], capture_output=True, text=True)
                assert denied.returncode == 0, (denied.returncode, denied.stderr)
                def no_new_privs():
                    assert ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) == 0
                label = observation(subprocess.run([str(image), 'probe'], preexec_fn=no_new_privs,
                                                   capture_output=True, text=True))
                assert '//&' in label and '-tools' in label
                ordinary = subprocess.run([str(image), 'exec', '/usr/bin/python3', '-c',
                    'import os,pathlib; assert "//&" not in pathlib.Path("/proc/self/attr/current").read_text(); '
                    'assert pathlib.Path(os.environ["SYNTHETIC_CANARY"]).read_text()=="SYNTHETIC_PRIVATE"; '
                    'assert os.uname().sysname=="Linux"'], preexec_fn=no_new_privs, capture_output=True, text=True)
                assert ordinary.returncode == 0, ordinary.stderr
        for image in [package / 'launcher-extra', package / 'nested/launcher']:
            label = observation(subprocess.run([str(image), 'probe'], capture_output=True, text=True), tools=True)
            assert label == parent_label
        subprocess.run(['sudo', '-n', 'true'], check=True, capture_output=True)
        source = case / 'project/build.c'
        source.write_text('int main(void){return 0;}\n')
        subprocess.run(['cc', str(source), '-o', str(case / 'project/build')], check=True, capture_output=True)
        subprocess.run([str(case / 'project/build')], check=True)
        sandbox = subprocess.run(['bwrap', '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/',
                        '--proc', '/proc', '--dev', '/dev', '/bin/true'], capture_output=True, text=True)
        assert sandbox.returncode == 0, sandbox.stderr
        # Snapshot denials stay on Claude itself, not its ordinary tools.
        snapshot = case / 'settings.json'
        original = snapshot.read_bytes()
        snapshot.write_text('SYNTHETIC_TOOL_EDIT')
        snapshot.write_bytes(original)
        nested = {}
        for target in ['codex', 'claude']:
            result = invoke(fixture, target, ['probe'])
            label = observation(result)
            assert label.split(' (')[0] != parent_label.removesuffix('-tools (enforce)')
            nested[target] = True
        late = dict(fixture, packages=dict(fixture['packages'], **{provider: json.loads(next_bundle.read_text())}))
        observation(invoke(late, provider, ['probe']))
        print(json.dumps(dict(provider=provider, privateToolRead=True, nativeReentry=True,
                             noNewPrivilegesReentry=provider == 'codex',
                             sudo=True, build=True, bubblewrap=True, settingsToolWrite=True, nested=nested,
                             laterInstalledBundle=True, launcherLeafOnly=True)))
    elif phase == '--chrome':
        assert os.getuid() != 0
        chrome = next(p for p in ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'] if Path(p).is_file())
        profile = tempfile.mkdtemp(prefix='chrome-', dir=Path(fixture['root']) / provider / 'project')
        result = invoke(fixture, provider, ['exec', chrome, '--headless', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-crash-reporter',
            '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--user-data-dir=' + profile,
            '--dump-dom', 'data:text/html,<title>AIM_TOOL_ACCESS_OK</title>'])
        assert result.returncode == 0 and 'AIM_TOOL_ACCESS_OK' in result.stdout, result.stderr
        print('PASS ' + provider + ' launches Chrome with its native sandbox and a fresh synthetic profile')
    elif phase == '--refuse':
        result = invoke(fixture, provider, ['probe'])
        assert result.returncode == 125 and not result.stdout and 'mutable artifact' in result.stderr
        print('PASS caller-writable other-provider bundle refused before vendor execution')
    else:
        assert phase == '--launch' and os.getuid() != 0
        observation(invoke(fixture, provider, ['probe']))
        observation(invoke(fixture, provider, ['self']))
        if provider == 'codex':
            private_parents = invoke(fixture, provider, ['private-parents'])
            assert private_parents.returncode == 0, (private_parents.returncode, private_parents.stderr)
            print('PASS selected input/database access without account or input ancestor listings')
            scratch = Path(fixture['codexScratch'])
            private = invoke(fixture, provider, ['temp-scratch'])
            assert private.returncode == 0, private.stderr
            scratch.chmod(0o755)
            try:
                refused = invoke(fixture, provider, ['probe'])
                assert refused.returncode == 125 and not refused.stdout
            finally: scratch.chmod(0o700)
            alias = scratch.with_name(scratch.name[:-6] + 'alias1')
            alias.symlink_to(scratch)
            try:
                for invalid in [alias, Path(fixture['root']) / provider / 'scratch', Path(fixture['foreignScratch'])]:
                    refused = invoke(fixture, provider, ['probe'], scratch=invalid)
                    assert refused.returncode == 125 and not refused.stdout
            finally: alias.unlink()
            print('PASS private scratch access, sibling/root denial, and native path/owner/mode rejection')
            masks = invoke(fixture, provider, ['temp-masks'])
            assert masks.returncode == 0, masks.stderr
            assert Path('/tmp/.aws/synthetic-canary').read_text() == 'SYNTHETIC_TEMP_SECRET'
            print('PASS native temporary-mask directory cleanup without listing or content access')
        result = invoke(fixture, provider, ['exec', '/usr/bin/python3', str(Path(__file__).resolve()), '--tool', file, provider])
        assert result.returncode == 0, result.stderr
        print(result.stdout, end='')
    sys.exit(0)

assert os.getuid() == 0 and {name for _, name in socket.if_nameindex()} == {'lo'}
user = pwd.getpwnam('aimdev')
# The caller supplies a fresh private /tmp mount; never modify an existing one.
assert all(not Path('/tmp/' + name).exists() for name in ['.git', '.agents', '.codex', '.aws']), 'fresh private /tmp required'
Path('/tmp/.aws').mkdir(mode=0o700); os.chown('/tmp/.aws', user.pw_uid, user.pw_gid)
Path('/tmp/.aws/synthetic-canary').write_text('SYNTHETIC_TEMP_SECRET')
os.chown('/tmp/.aws/synthetic-canary', user.pw_uid, user.pw_gid)
Path('/tmp/.aws/synthetic-canary').chmod(0o600)
root = Path(tempfile.mkdtemp(prefix='tool-boundary-', dir=base))
root.chmod(0o755)
classifier = root / 'classifier.c'
classifier.write_text('#define main original_entry_main\n#include '
    + json.dumps(str(repo / 'native/codex/approved_launch_linux.c'))
    + '\n#undef main\nint main(int argc,char **argv){return argc==2?vendor_label(argv[1]):2;}\n')
subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(classifier), '-o', str(root / 'classifier')], check=True)
for label, denied in [
    ('aim-codex-p-1001-abc (enforce)\n', True),
    ('aim-codex-p-1001-abc-tools (enforce)\n', False),
    ('aim-codex-p-1001-abc-tools//&aim-codex-p-1001-abc (enforce)\n', True),
    ('aim-codex-p-1001-abc//&aim-codex-p-1001-abc-tools (enforce)\n', True),
    ('aim-codex-p-1001-abc-tools//&aim-claude-p-1001-def (enforce)\n', True),
    ('aim-claude-p-1001-def-tools//&aim-codex-p-1001-abc-tools (enforce)\n', False),
]:
    assert subprocess.run([str(root / 'classifier'), label]).returncode == int(denied)
source = root / 'probe.c'
source.write_text(r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/utsname.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
int main(int argc,char **argv){
 if(argc>1&&!strcmp(argv[1],"exec")){execv(argv[2],argv+2);perror("exec");return 2;}
 if(argc>1&&!strcmp(argv[1],"self")){char *a[]={argv[0],"probe",NULL};execv(a[0],a);return 3;}
 if(argc>1&&!strcmp(argv[1],"private-parents")){
  const char *keys[]={"SYNTHETIC_ACCOUNT_PARENT","SYNTHETIC_INPUT_PARENT","SYNTHETIC_DATABASE_PARENT"};
  for(size_t i=0;i<3;i++){
   errno=0;DIR *d=opendir(getenv(keys[i]));
   if(d){closedir(d);fprintf(stderr,"unexpected ancestor listing: %s\n",keys[i]);return 17;}
   if(errno!=EACCES&&errno!=EPERM)return 18;
  }
  char path[4096];snprintf(path,sizeof(path),"%s/selected/visible",getenv("SYNTHETIC_INPUT_PARENT"));
  FILE *f=fopen(path,"r");if(!f)return 19;fclose(f);
  snprintf(path,sizeof(path),"%s/selected/check.sqlite",getenv("SYNTHETIC_DATABASE_PARENT"));
  f=fopen(path,"w");if(!f)return 20;fclose(f);return 0;
 }
 if(argc>1&&!strcmp(argv[1],"temp-scratch")){
  char path[4096];snprintf(path,sizeof(path),"%s/vendor-proof",getenv("TMPDIR"));
  FILE *f=fopen(path,"w");if(!f)return 14;fputs("private temporary state",f);fclose(f);
  f=fopen(path,"r");if(!f)return 15;fclose(f);
  snprintf(path,sizeof(path),"%s/sibling-canary",getenv("SYNTHETIC_OTHER_SCRATCH"));
  if(fopen(path,"r")||opendir("/tmp"))return 16;
  return 0;
 }
 if(argc>1&&!strcmp(argv[1],"temp-masks")){
  const char *dirs[]={"/tmp/.git","/tmp/.agents","/tmp/.codex"};
  for(size_t i=0;i<3;i++){if(mkdir(dirs[i],0700))return 10;if(opendir(dirs[i]))return 11;if(rmdir(dirs[i]))return 12;}
  if(opendir("/tmp/.aws")||fopen("/tmp/.aws/synthetic-canary","r")||fopen("/tmp/.aws/synthetic-canary","w"))return 13;
  return 0;
 }
 FILE *f=fopen("/proc/self/attr/current","r");char line[256];if(!f||!fgets(line,sizeof(line),f))return 4;
 fclose(f);printf("%s",line);f=fopen(getenv("SYNTHETIC_CANARY"),"r");printf("read=%d\n",f!=NULL);if(f)fclose(f);
 struct utsname value;printf("uname=%d\n",uname(&value)==0);return 0;
}
''')
subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(root / 'probe')], check=True)
(root / 'private-canary').write_text('SYNTHETIC_PRIVATE')
(root / 'private-canary').chmod(0o644)
fixture = dict(root=str(root), packages={})
for name in ['inputs', 'databases']:
    for directory in [root / name, root / name / 'selected']:
        directory.mkdir(mode=0o700)
        os.chown(directory, user.pw_uid, user.pw_gid)
(root / 'inputs/selected/visible').write_text('SYNTHETIC_SELECTED_INPUT')
(root / 'inputs/selected/visible').chmod(0o644)
for key in ['codexScratch', 'otherScratch', 'foreignScratch']:
    scratch = Path('/tmp') / ('aim-codex-' + str(user.pw_uid) + '-' + secrets.token_hex(3))
    scratch.mkdir(mode=0o700)
    if key != 'foreignScratch': os.chown(scratch, user.pw_uid, user.pw_gid)
    fixture[key] = str(scratch)
(Path(fixture['otherScratch']) / 'sibling-canary').write_text('SYNTHETIC_OTHER_SCRATCH')
os.chown(Path(fixture['otherScratch']) / 'sibling-canary', user.pw_uid, user.pw_gid)
for provider in ['codex', 'claude']:
    runtime = Path('/opt/aimgr-' + provider + '-runtime')
    package = runtime / 'artifacts' / secrets.token_hex(32)
    package.mkdir(mode=0o755, parents=True)
    subprocess.run(['cc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
                    str(repo / 'native' / provider / 'approved_launch_linux.c'), '-o', str(package / 'launcher')], check=True)
    (package / 'launcher').chmod(0o4755)
    shutil.copyfile(root / 'probe', package / provider)
    (package / provider).chmod(0o755)
    if provider == 'codex':
        shutil.copyfile(root / 'probe', package / 'codex-code-mode-host')
        (package / 'codex-code-mode-host').chmod(0o755)
    (package / 'nested').mkdir(mode=0o755)
    for other in [package / 'launcher-extra', package / 'nested/launcher']:
        shutil.copyfile(root / 'probe', other)
        other.chmod(0o755)
    if not (runtime / 'policy.lock').exists():
        (runtime / 'policy.lock').touch(mode=0o644)
    fixture['packages'][provider] = str(package)
    case = root / provider
    for directory in [case, case / 'home', case / 'scratch', case / 'project']:
        directory.mkdir(mode=0o700)
        os.chown(directory, user.pw_uid, user.pw_gid)
    (case / 'settings.json').write_text('{}')
    os.chown(case / 'settings.json', user.pw_uid, user.pw_gid)
file = root / 'fixture.json'
file.write_text(json.dumps(fixture))
for provider in ['codex', 'claude']:
    with (root / (provider + '.log')).open('w') as log:
        child = subprocess.Popen(['sudo', '-n', '-u', user.pw_name, '/usr/bin/python3', str(Path(__file__).resolve()),
                                 '--launch', str(file), provider], stdout=log, stderr=log, text=True)
        deadline = time.monotonic() + 50
        try:
            while not (root / provider / 'parent-ready').exists() and child.poll() is None:
                assert time.monotonic() < deadline, 'parent policy did not start'
                time.sleep(.05)
            assert child.poll() is None, 'Boundary failed before tools; private evidence in ' + root.name
            old = Path(fixture['packages'][provider])
            newer = old.parent / secrets.token_hex(32)
            shutil.copytree(old, newer)
            (root / provider / 'next-bundle.json').write_text(json.dumps(str(newer)))
            assert child.wait(timeout=90) == 0, 'Boundary failed for ' + provider + '; private evidence in ' + root.name
        finally:
            if child.poll() is None: child.terminate(); child.wait(timeout=10)
    print((root / (provider + '.log')).read_text(), end='', flush=True)
unsafe = Path(fixture['packages']['claude']).parent / secrets.token_hex(32)
unsafe.mkdir(mode=0o755)
shutil.copyfile(root / 'probe', unsafe / 'launcher')
(unsafe / 'launcher').chmod(0o755)
unsafe.chmod(0o777)
try:
    subprocess.run(['sudo', '-n', '-u', user.pw_name, '/usr/bin/python3', str(Path(__file__).resolve()),
                    '--refuse', str(file), 'codex'], check=True)
finally:
    (unsafe / 'launcher').unlink()
    unsafe.rmdir()
print(json.dumps(dict(fixture=root.name, realVendorExecuted=False)))
