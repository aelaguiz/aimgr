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
import pwd
import secrets
import shutil
import subprocess
import sys
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
#include <Security/Security.h>
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static void check(int ok, const char *name) {
    if (!ok) { perror(name); exit(1); }
}
int main(int argc, char **argv) {
    check(argc == 7 || argc == 8, "arguments");
    int tool = argc == 8 && !strcmp(argv[7], "tool");
    char actual[4096]; struct stat st;
    const char *parents = getenv("AIM_SYNTHETIC_PARENTS");
    if (parents) {
        char *copy = strdup(parents), *save = NULL;
        check(copy != NULL, "parent fixture allocation");
        for (char *parent = strtok_r(copy, ":", &save); parent; parent = strtok_r(NULL, ":", &save)) {
            check(!stat(parent, &st) && S_ISDIR(st.st_mode), "ancestor metadata");
            int allowed = tool || (getenv("AIM_SYNTHETIC_ALLOWED_PARENT")
                && !strcmp(parent, getenv("AIM_SYNTHETIC_ALLOWED_PARENT")));
            DIR *directory = opendir(parent);
            check(allowed ? directory != NULL : !directory && errno == EPERM, "ancestor listing boundary");
            if (directory) closedir(directory);
            errno = 0;
            ssize_t attr = getxattr(parent, "com.aimgr.synthetic-absent", NULL, 0, 0, 0);
            check(allowed ? attr < 0 && errno == ENOATTR : attr < 0 && errno == EPERM, "ancestor xattr boundary");
        }
        free(copy);
    }
    const char *selected = getenv("AIM_SYNTHETIC_READ");
    if (selected) { int fd = open(selected, O_RDONLY); check(fd >= 0, "selected read input"); close(fd); }
    const char *database = getenv("AIM_SYNTHETIC_DATABASE");
    if (database) { int fd = open(database, O_CREAT | O_RDWR, 0600); check(fd >= 0, "selected database write"); close(fd); }
    const char *keychain_path = getenv("AIM_SYNTHETIC_KEYCHAIN");
    if (keychain_path) {
        check(!stat(keychain_path, &st), "selected keychain metadata");
        int raw = open(keychain_path, O_RDONLY);
        check(raw >= 0, "approved selected keychain read"); close(raw);
        raw = open(keychain_path, O_WRONLY);
        check(raw >= 0, "approved selected keychain write"); close(raw);
        errno = 0;
        ssize_t attr = getxattr(keychain_path, "com.aimgr.synthetic-absent", NULL, 0, 0, 0);
        check(tool ? attr < 0 && errno == ENOATTR : attr < 0 && errno == EPERM, "keychain xattr boundary");
        const char *unrelated = getenv("AIM_SYNTHETIC_UNRELATED_KEYCHAIN");
        check(unrelated != NULL, "unrelated keychain fixture");
        raw = open(unrelated, O_RDONLY);
        check(tool ? raw >= 0 : raw < 0 && errno == EPERM, "unrelated keychain read boundary");
        if (raw >= 0) close(raw);
        raw = open(unrelated, O_WRONLY);
        check(tool ? raw >= 0 : raw < 0 && errno == EPERM, "unrelated keychain write boundary");
        if (raw >= 0) close(raw);
        check(strlen(keychain_path) < sizeof(actual), "keychain path size");
        strcpy(actual, keychain_path); *strrchr(actual, '/') = 0;
        DIR *directory = opendir(actual);
        check(tool ? directory != NULL : !directory && errno == EPERM, "keychain parent listing boundary");
        if (directory) closedir(directory);
        SecKeychainRef keychain = NULL;
        OSStatus status = SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &keychain);
        check(status == 0 && keychain != NULL, "native default keychain");
        UInt32 path_size = sizeof(actual);
        check(!SecKeychainGetPath(keychain, &path_size, actual) && !strcmp(actual, keychain_path), "custom default retained");
        UInt32 size = 0; void *data = NULL;
        const char *service = "AIM Synthetic Path Probe", *account = "synthetic";
        // This is a filesystem-policy probe. Seed through the same executable
        // identity as the readers; security(1) has a different native partition
        // in a standard Keychain. Cross-identity MCP import has its own fixture.
        if (getenv("AIM_SYNTHETIC_CREATE_KEYCHAIN_ITEM")) {
            check(!SecKeychainAddGenericPassword(keychain, (UInt32)strlen(service), service,
                                                 (UInt32)strlen(account), account, 6, "MARKER", NULL),
                  "seed native item");
        }
        status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
                                               (UInt32)strlen(account), account, &size, &data, NULL);
        if (status) fprintf(stderr, "native keychain lookup status: %d\n", (int)status);
        check(status == 0 && size == 6 && !memcmp(data, "MARKER", 6), "native item lookup");
        SecKeychainItemFreeContent(NULL, data); CFRelease(keychain);
    }
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
    read_root = root / 'inputs' / 'selected'
    read_root.mkdir(parents=True)
    read_file = read_root / 'visible'
    read_file.write_text('SYNTHETIC_SELECTED_READ')
    database_root = root / 'databases' / 'selected'
    database_root.mkdir(parents=True)
    boundary_env = dict(AIM_SYNTHETIC_PARENTS=':'.join(map(str, [root, shared, read_root.parent, database_root.parent])),
                        AIM_SYNTHETIC_READ=str(read_file), AIM_SYNTHETIC_DATABASE=str(database_root / 'test.sqlite'))
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
    standard = '--standard-keychain' in sys.argv
    keychain = ((Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Keychains' / ('aim.synthetic+[' + secrets.token_hex(6) + '].keychain-db'))
                if standard else root / 'keychain-only' / 'fixture+[literal].keychain-db')
    keychain.parent.mkdir(exist_ok=True)
    unrelated_keychain = keychain.with_name(keychain.name + '-unrelated')
    unrelated_keychain.write_text('SYNTHETIC_UNRELATED_KEYCHAIN')
    prior_keychain = None
    keychain_created = False
    def security(*args):
        result = subprocess.run(['/usr/bin/security', *map(str, args)], capture_output=True, text=True, check=True)
        return result.stdout.strip().strip('"')
    try:
        for source, name in [(repo / 'native/codex/approved_launch_macos.c', 'launcher'), (root / 'probe.c', 'codex')]:
            subprocess.run(['clang', '-O2', '-Wall', '-Wextra', '-Werror', str(source),
                            '-framework', 'Security', '-framework', 'CoreFoundation', '-o', str(root / name)], check=True)
        shutil.copy2(root / 'codex', root / 'tool')
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime', str(root / 'launcher')], check=True, capture_output=True)
        subprocess.run(['sudo', '-n', 'mkdir', '-m', '755', str(installed)], check=True)
        for name in ['launcher', 'codex', 'codex-code-mode-host']:
            subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'wheel', '-m', '755',
                            str(root / ('codex' if name == 'codex-code-mode-host' else name)), str(installed / name)], check=True)
        prior_keychain = security('default-keychain', '-d', 'user')
        security('create-keychain', '-p', 'SYNTHETIC_PATH_PASSWORD', keychain)
        keychain_created = True
        security('unlock-keychain', '-p', 'SYNTHETIC_PATH_PASSWORD', keychain)
        security('default-keychain', '-d', 'user', '-s', keychain)
        probe_args = [str(sibling), str(scratch / 'own-file'), str(installed / 'codex-code-mode-host'),
                      str(root / 'tool'), str(optional), str(optional / 'visible')]
        control = subprocess.run([str(installed / 'codex'), *probe_args, 'tool'],
                                 env=dict(os.environ, **boundary_env, HOME=pwd.getpwuid(os.getuid()).pw_dir, AIM_SYNTHETIC_KEYCHAIN=str(keychain),
                                          AIM_SYNTHETIC_CREATE_KEYCHAIN_ITEM='1',
                                          AIM_SYNTHETIC_UNRELATED_KEYCHAIN=str(unrelated_keychain)),
                                 capture_output=True, text=True, timeout=20)
        assert control.returncode == 0, ('unrestricted control', control.returncode, control.stderr)
        shutil.rmtree(optional)
        optional.symlink_to(root / 'not-installed')
        with tempfile.TemporaryFile() as environment:
            environment.write(b'PATH=/usr/bin:/bin\0HOME=' + pwd.getpwuid(os.getuid()).pw_dir.encode()
                              + b'\0AIM_SYNTHETIC_KEYCHAIN=' + str(keychain).encode()
                              + b'\0AIM_SYNTHETIC_UNRELATED_KEYCHAIN=' + str(unrelated_keychain).encode() + b'\0')
            for key, value in boundary_env.items():
                environment.write((key + '=' + value).encode() + b'\0')
            environment.flush()
            result = subprocess.run([str(installed / 'launcher'), 'v1', str(account), str(home), str(scratch),
                                     str(environment.fileno()), '1', str(optional), '1', str(read_root), '1', str(database_root), '0', '--', *probe_args],
                                    pass_fds=(environment.fileno(),), capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        print(result.stdout, end='')
        # No MCP use: an absent optional plist under a valid symlinked
        # Preferences parent must not refuse an otherwise healthy launch.
        boundary_env['AIM_SYNTHETIC_ALLOWED_PARENT'] = str(read_root.parent)
        fake_home = root / 'preference-home'
        (fake_home / 'Library').mkdir(parents=True)
        preference_parent = root / 'preferences-only'
        preference_parent.mkdir()
        (fake_home / 'Library/Preferences').symlink_to(preference_parent)
        shutil.rmtree(optional)
        optional.symlink_to(root / 'not-installed')
        with tempfile.TemporaryFile() as environment:
            environment.write(b'PATH=/usr/bin:/bin\0HOME=' + str(fake_home).encode() + b'\0')
            for key, value in boundary_env.items():
                environment.write((key + '=' + value).encode() + b'\0')
            environment.flush()
            no_mcp = subprocess.run([str(installed / 'launcher'), 'v1', str(account), str(home), str(scratch),
                                     str(environment.fileno()), '1', str(optional), '1', str(read_root.parent), '1', str(database_root), '0', '--', *probe_args],
                                    pass_fds=(environment.fileno(),), capture_output=True, text=True, timeout=20)
        assert no_mcp.returncode == 0, ('optional preference', no_mcp.returncode, no_mcp.stdout, no_mcp.stderr)
        print(json.dumps({'fixture': root.name, 'realVendorExecuted': False, 'activeSelectorChanged': False,
                          'keychainLocation': 'standard' if standard else 'custom', 'selectedDatabaseReadWrite': True,
                          'unrelatedDatabaseDenied': True, 'keychainXattrsDenied': True,
                          'ancestorMetadataOnly': True, 'selectedInputsAndDatabaseWritable': True,
                          'missingPreferenceWithSymlinkedParent': True}))
    finally:
        if prior_keychain:
            security('default-keychain', '-d', 'user', '-s', prior_keychain)
        if keychain_created:
            security('delete-keychain', keychain)
        unrelated_keychain.unlink()
        if installed.exists():
            for name in ['launcher', 'codex', 'codex-code-mode-host']:
                subprocess.run(['sudo', '-n', 'rm', '-f', str(installed / name)], check=True)
            subprocess.run(['sudo', '-n', 'rmdir', str(installed)], check=True)
        shutil.rmtree(scratch)
