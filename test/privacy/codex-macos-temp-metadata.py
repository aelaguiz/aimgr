#!/usr/bin/env python3
"""Native /tmp alias regression on the designated disposable Mac only.

The real-client settings fixture proves read-only shell execution. This probe
separately proves that permitting its metadata does not permit temp listings,
extended-attribute values or another invocation's files. No real vendor is executed.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import tempfile

assert platform.system() == 'Darwin' and os.getuid() != 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
repo = Path(__file__).resolve().parents[2]
probe = r'''
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>
static void check(int ok, const char *name) {
    if (!ok) { perror(name); exit(1); }
}
int main(int argc, char **argv) {
    check(argc == 7 || argc == 8, "arguments");
    int tool = argc == 8 && !strcmp(argv[7], "tool");
    char actual[4096]; struct stat st;
    check(realpath("/tmp", actual) && !strcmp(actual, "/private/tmp"), "physical temp alias");
    check(!stat(actual, &st) && S_ISDIR(st.st_mode), "temp metadata");
    const char *roots[] = {"/tmp", "/private/tmp"};
    for (int i = 0; i < 2; i++) {
        DIR *directory = opendir(roots[i]);
        check(tool ? directory != NULL : !directory && errno == EPERM, "temp listing boundary");
        if (directory) closedir(directory);
        // Listing an empty xattr namespace may return zero without checking
        // file-read-xattr. An actual value lookup must reach that check.
        errno = 0;
        ssize_t value = getxattr(roots[i], "com.aimgr.synthetic-absent", NULL, 0, 0, 0);
        check(tool ? value < 0 && errno == ENOATTR : value < 0 && errno == EPERM, "temp xattrs boundary");
    }
    int fd = open(argv[1], O_RDONLY);
    check(tool ? fd >= 0 : fd < 0 && errno == EPERM, "sibling read boundary");
    if (fd >= 0) close(fd);
    fd = open(argv[2], O_CREAT | O_WRONLY, 0600);
    check(fd >= 0, "own scratch writable"); close(fd);
    check(realpath(argv[2], actual) != NULL, "own scratch file");
    *strrchr(actual, '/') = 0;
    DIR *own = opendir(actual); check(own != NULL, "own scratch listing"); closedir(own);
    if (tool) {
        check(!unlink(argv[5]) && !mkdir(argv[5], 0700), "replace optional shared link");
        fd = open(argv[6], O_CREAT | O_WRONLY, 0600);
        check(fd >= 0 && write(fd, "SHARED", 6) == 6, "populate shared replacement"); close(fd);
        return 0;
    }
    if (argc == 8) return 0;
    check(stat(argv[5], &st) < 0 && errno == ENOENT, "optional link preserves NotFound");
    for (int helper = 0; helper < 3; helper++) {
        pid_t child = fork(); check(child >= 0, "fork");
        if (!child) {
            const char *image = helper == 0 ? argv[4] : helper == 1 ? argv[3] : argv[0];
            execl(image, image, argv[1], argv[2], argv[3], argv[4], argv[5], argv[6], helper == 0 ? "tool" : "child", NULL);
            _exit(127);
        }
        int status; check(waitpid(child, &status, 0) == child && WIFEXITED(status)
                         && WEXITSTATUS(status) == 0, "vendor child retains boundary");
    }
    fd = open(argv[6], O_RDONLY); char value[7] = {0};
    check(fd >= 0 && read(fd, value, 6) == 6 && !strcmp(value, "SHARED"), "shared replacement visible to existing vendor"); close(fd);
    puts("PASS temp metadata and exact optional shared link; replacement visible; sibling denied; ordinary tools retained");
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix='aim-temp-metadata-', dir='/private/tmp') as temporary:
    root = Path(temporary)
    account = root / 'account'
    home = account / 'home'
    home.mkdir(parents=True, mode=0o700)
    shared = root / 'shared'
    shared.mkdir()
    sibling = shared / 'private-sibling'
    sibling.write_text('SYNTHETIC_PRIVATE_SIBLING')
    optional = shared / 'agents'
    optional.symlink_to(root / 'not-installed')
    (home / 'agents').symlink_to(optional)
    scratch = Path('/private/tmp') / ('aim-codex-' + str(os.getuid()) + '-' + secrets.token_hex(3))
    scratch.mkdir(mode=0o700)
    (root / 'probe.c').write_text(probe)
    artifact = hashlib.sha256(str(root).encode()).hexdigest()
    installed = Path('/opt/aimgr-codex-runtime/artifacts') / artifact
    try:
        for source, name in [(repo / 'native/codex/approved_launch_macos.c', 'launcher'), (root / 'probe.c', 'codex')]:
            subprocess.run(['clang', '-O2', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(root / name)], check=True)
        shutil.copy2(root / 'codex', root / 'tool')
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime', str(root / 'launcher')], check=True, capture_output=True)
        subprocess.run(['sudo', '-n', 'mkdir', '-m', '755', str(installed)], check=True)
        for name in ['launcher', 'codex', 'codex-code-mode-host']:
            subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'wheel', '-m', '755',
                            str(root / ('codex' if name == 'codex-code-mode-host' else name)), str(installed / name)], check=True)
        with tempfile.TemporaryFile() as environment:
            environment.write(b'PATH=/usr/bin:/bin\0HOME=' + str(root).encode() + b'\0')
            environment.flush()
            result = subprocess.run([str(installed / 'launcher'), 'v1', str(account), str(home), str(scratch),
                                     str(environment.fileno()), '1', str(optional), '0', '0', '0', '--', str(sibling),
                                     str(scratch / 'own-file'), str(installed / 'codex-code-mode-host'), str(root / 'tool'),
                                     str(optional), str(optional / 'visible')],
                                    pass_fds=(environment.fileno(),), capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        print(result.stdout, end='')
        print(json.dumps({'fixture': root.name, 'realVendorExecuted': False, 'activeSelectorChanged': False}))
    finally:
        if installed.exists():
            for name in ['launcher', 'codex', 'codex-code-mode-host']:
                subprocess.run(['sudo', '-n', 'rm', '-f', str(installed / name)], check=True)
            subprocess.run(['sudo', '-n', 'rmdir', str(installed)], check=True)
        shutil.rmtree(scratch)
