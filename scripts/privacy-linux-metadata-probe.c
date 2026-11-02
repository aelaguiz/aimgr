/* Offsite decision fixture, NOT an installed production helper.
 *
 * The outer test owns an isolated loopback-only network namespace. This
 * root-started process installs a uname notification filter and drops both
 * sides to the disposable user before executing the already hash-checked
 * official binary. Unlike blanket seccomp/no_new_privs, native tool executables
 * retain their uname API and nested sudo is not disabled. A production design
 * still needs approved-artifact admission, all request-owner inventory,
 * bootstrap validation, lifetime integration and the complete test matrix.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void fatal(const char *what) { perror(what); exit(125); }
static void drop(const struct passwd *user) {
    if (setgroups(0, NULL) || setgid(user->pw_gid) || setuid(user->pw_uid)) fatal("drop privileges");
    if (geteuid() == 0 || getegid() == 0) { errno = EPERM; fatal("unprivileged payload required"); }
}
static int send_fd(int socket, int fd) {
    char byte = 'F', control[CMSG_SPACE(sizeof(int))] = {0};
    struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control)};
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    cmsg->cmsg_level = SOL_SOCKET; cmsg->cmsg_type = SCM_RIGHTS; cmsg->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cmsg), &fd, sizeof(fd));
    return sendmsg(socket, &msg, 0) == 1 ? 0 : -1;
}
static int receive_fd(int socket) {
    char byte, control[CMSG_SPACE(sizeof(int))] = {0};
    struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control)};
    if (recvmsg(socket, &msg, MSG_CMSG_CLOEXEC) != 1) return -1;
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    if (!cmsg || cmsg->cmsg_type != SCM_RIGHTS || cmsg->cmsg_len != CMSG_LEN(sizeof(int))) return -1;
    int fd; memcpy(&fd, CMSG_DATA(cmsg), sizeof(fd)); return fd;
}
int main(int argc, char **argv) {
    const char *vendor = "/opt/aimgr-state-audit/bin/claude";
    struct stat identity;
    if (getuid() != 0 || access("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST", F_OK)
        || argc < 2 || strcmp(argv[1], vendor) || stat(vendor, &identity)
        || identity.st_uid != 0 || (identity.st_mode & 022)) {
        fprintf(stderr, "Only the root-started marked offsite fixture and fixed vendor path are supported.\n");
        return 125;
    }
    struct passwd *user = getpwnam("aimprivacy");
    if (!user || user->pw_uid == 0 || user->pw_gid == 0) fatal("disposable user");
    int channel[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, channel)) fatal("socketpair");
    pid_t child = fork();
    if (child == -1) fatal("fork");
    if (!child) {
        close(channel[0]);
        struct sock_filter filter[] = {
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_uname, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        };
        struct sock_fprog program = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
        int listener = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
        if (listener < 0 || send_fd(channel[1], listener)) fatal("install/send filter");
        close(listener); close(channel[1]);
        drop(user);
        // UID changes clear PDEATHSIG: arm after drop, then check the parent.
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1) _exit(125);
        if (getenv("AIM_METADATA_FIXTURE_APPARMOR")) {
            char **wrapped = calloc((size_t)argc + 4, sizeof(char *));
            if (!wrapped) fatal("allocate fixture arguments");
            wrapped[0] = "/usr/bin/aa-exec";
            wrapped[1] = "-p"; wrapped[2] = "aim-claude-decision"; wrapped[3] = "--";
            for (int i = 1; i < argc; i++) wrapped[i + 3] = argv[i];
            execv(wrapped[0], wrapped); fatal("exec AppArmor fixture");
        }
        execv(vendor, &argv[1]); fatal("exec vendor");
    }
    close(channel[1]);
    int listener = receive_fd(channel[0]); close(channel[0]);
    if (listener < 0) { kill(child, SIGKILL); fatal("receive filter"); }
    drop(user);
    unsigned int denied = 0, allowed = 0;
    int status;
    for (;;) {
        pid_t finished = waitpid(child, &status, WNOHANG);
        if (finished == child) break;
        if (finished == -1) fatal("waitpid");
        struct pollfd ready = {.fd = listener, .events = POLLIN};
        if (poll(&ready, 1, 100) < 0) { if (errno == EINTR) continue; fatal("poll"); }
        if (!(ready.revents & POLLIN)) continue;
        struct seccomp_notif request = {0};
        struct seccomp_notif_resp response = {0};
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request)) {
            if (errno == EINTR || errno == ENOENT) continue;
            fatal("receive syscall");
        }
        char executable[80];
        snprintf(executable, sizeof(executable), "/proc/%u/exe", request.pid);
        struct stat current;
        int inspected = stat(executable, &current) == 0;
        int is_vendor = inspected && current.st_dev == identity.st_dev && current.st_ino == identity.st_ino;
        response.id = request.id;
        if (!inspected || is_vendor) { response.error = -EPERM; denied++; }
        else { response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE; allowed++; }
        // An exited/replaced task invalidates its notification. Never infer
        // identity from a recycled PID and act on another pending syscall.
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id)) continue;
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) && errno != ENOENT) fatal("answer syscall");
    }
    close(listener);
    fprintf(stderr, "AIM_METADATA_FIXTURE denied=%u toolAllowed=%u\n", denied, allowed);
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return 128 + WTERMSIG(status);
}
