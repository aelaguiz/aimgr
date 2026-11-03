#!/usr/bin/env python3
"""Exercise the production Mac launcher with a synthetic vendor, without credentials.

Requires local administrator installation of a temporary, inactive fixture.
Chrome uses an empty profile and a dead loopback proxy; its own sandbox stays on.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile

if platform.system() != 'Darwin' or os.getuid() == 0:
    raise SystemExit('Run as the ordinary macOS user with sudo -n available')
repo = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else repo / 'native/claude/approved_launch_macos.c'

probe = r'''
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern int sandbox_check(pid_t, const char *, int, ...);
static void check(int ok, const char *what) { if (!ok) { perror(what); exit(1); } }
static void child(char **args) {
    pid_t p=fork(); check(p>=0,"fork");
    if (!p) { execv(args[0],args); _exit(127); }
    int s; check(waitpid(p,&s,0)==p && WIFEXITED(s) && WEXITSTATUS(s)==0,"child");
}
int main(int argc,char **argv) {
    check(argc>=5,"arguments");
    int tool=!strcmp(argv[1],"tool");
    check((sandbox_check(getpid(),NULL,0)>0)==!tool,"sandbox state");
    int f=open(argv[2],O_WRONLY); check((f>=0)==tool,"settings access"); if(f>=0)close(f);
    f=open(argv[3],O_RDONLY); check((f>=0)==tool,"updater access"); if(f>=0)close(f);
    if(!strcmp(argv[1],"self") || tool) return 0;
    char *again[]={argv[0],"self",argv[2],argv[3],argv[4],NULL}; child(again);
    char *other[]={argv[4],"tool",argv[2],argv[3],argv[4],NULL}; child(other);
    char *shell[]={"/bin/sh","-c","exec \"$@\"","sh",argv[4],"tool",argv[2],argv[3],argv[4],NULL}; child(shell);
    if(argc>5) child(argv+5);
    puts("vendor restricted; direct self-spawn restricted; ordinary tools unrestricted");
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix='aim-tool-access-') as temporary:
    root = Path(temporary).resolve()
    (root / 'probe.c').write_text(probe)
    for src, out in [(source, root / 'launcher'), (root / 'probe.c', root / 'claude')]:
        subprocess.run(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror', str(src), '-o', str(out)], check=True)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', str(root / 'launcher')], check=True, capture_output=True)
    shutil.copyfile(root / 'claude', root / 'tool')
    (root / 'tool').chmod(0o755)
    artifact = hashlib.sha256(str(root).encode()).hexdigest()
    installed = Path('/opt/aimgr-claude-runtime/artifacts') / artifact
    subprocess.run(['sudo', '-n', '/bin/mkdir', '-m', '755', str(installed)], check=True)
    try:
        for name in ['launcher', 'claude']:
            subprocess.run(['sudo', '-n', '/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '755', str(root / name), str(installed / name)], check=True)
        for name in ['config', 'scratch', 'updates']:
            (root / name).mkdir()
        settings = root / 'settings.json'
        settings.write_text('{}')
        update = root / 'updates/canary'
        update.write_text('synthetic updater content')
        chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        results = []
        for mode in ['ordinary', 'protected']:
            with tempfile.TemporaryFile() as environment:
                environment.write(b'PATH=/usr/bin:/bin\0HOME=' + str(root).encode() + b'\0')
                environment.flush()
                args = [str(installed / 'launcher'), 'v1', mode, str(root / 'config'), str(settings), str(root / 'scratch'), str(environment.fileno()), '1', str(root / 'tool'), '1', str(root / 'updates'), '--', 'parent', str(settings), str(update), str(root / 'tool')]
                if chrome.is_file():
                    args += [str(chrome), '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-crash-reporter', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--user-data-dir=' + str(root / ('chrome-' + mode)), '--dump-dom', 'data:text/html,<title>AIM_TOOL_ACCESS_OK</title>']
                process = subprocess.Popen(args, pass_fds=(environment.fileno(),), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                try:
                    out, err = process.communicate(timeout=30)
                finally:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.wait()
                assert process.returncode == 0, (mode, process.returncode, out, err[-4000:])
                assert 'ordinary tools unrestricted' in out
                assert not chrome.is_file() or 'AIM_TOOL_ACCESS_OK' in out
                assert 'Failed to initialize sandbox' not in err
                results.append({'mode': mode, 'vendorAndSelfSpawnRestricted': True, 'directAndShellToolsUnrestricted': True, 'chromeRenderedWithSandbox': chrome.is_file()})
        print(json.dumps(results, indent=2))
    finally:
        for name in ['launcher', 'claude']:
            subprocess.run(['sudo', '-n', '/bin/rm', '-f', str(installed / name)], check=True)
        subprocess.run(['sudo', '-n', '/bin/rmdir', str(installed)], check=True)
