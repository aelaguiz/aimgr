#!/usr/bin/env python3
"""Exercise the offline helper boundary on isolated hosts, without credentials."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile

assert os.getuid() != 0 and Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
repo = Path(__file__).resolve().parents[2]
source = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/un.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/uio.h>
#endif
int aim_config_boundary(void);
int main(int argc, char **argv) {
    assert(argc == 4);
    int inet_fd = socket(AF_INET, SOCK_STREAM, 0), unix_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    assert(inet_fd >= 0 && unix_fd >= 0);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(atoi(argv[2]))};
    assert(inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1);
    struct sockaddr_un local_address = {.sun_family = AF_UNIX};
    assert(strlen(argv[3]) < sizeof(local_address.sun_path));
    strcpy(local_address.sun_path, argv[3]);
#ifdef __linux__
    int original = 42, copied = 0;
    struct iovec local = {&copied, sizeof(copied)}, remote = {&original, sizeof(original)};
    assert(process_vm_readv(getpid(), &local, 1, &remote, 1, 0) == sizeof(copied));
#endif
    assert(aim_config_boundary() == 0);
    assert(connect(inet_fd, (struct sockaddr *)&address, sizeof(address)) == -1 && (errno == EPERM || errno == EACCES));
    assert(connect(unix_fd, (struct sockaddr *)&local_address, sizeof(local_address)) == -1 && (errno == EPERM || errno == EACCES));
    close(inet_fd); close(unix_fd);
    int file = open(argv[1], O_CREAT | O_EXCL | O_WRONLY, 0600);
    assert(file >= 0 && write(file, "synthetic", 9) == 9); close(file);
#ifdef __linux__
    copied = 0;
    assert(process_vm_readv(getpid(), &local, 1, &remote, 1, 0) == sizeof(copied));
    assert(copied == original);
#endif
    pid_t child = fork(); assert(child >= 0);
    if (child == 0) {
        execl("/usr/bin/true", "true", (char *)0);
        _exit(errno == EPERM ? 0 : 1);
    }
    int status; assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='codex-helper-boundary-') as temporary:
    root = Path(temporary)
    (root / 'probe.c').write_text(source)
    subprocess.run(['cc', '-std=gnu11', '-Werror', '-Wno-deprecated-declarations',
                    str(root / 'probe.c'), str(repo / 'native/codex/config-state/boundary.c'),
                    '-o', str(root / 'probe')], check=True)
    with socket.socket() as inet, socket.socket(socket.AF_UNIX) as unix:
        inet.bind(('127.0.0.1', 0)); inet.listen()
        unix.bind(str(root / 'bus')); unix.listen()
        subprocess.run([str(root / 'probe'), str(root / 'written.txt'), str(inet.getsockname()[1]), str(root / 'bus')], check=True)
    assert (root / 'written.txt').read_text() == 'synthetic'
print('PASS helper permits ordinary file writes; network, Unix sockets and exec remain denied')
