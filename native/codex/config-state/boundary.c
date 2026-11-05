/* Applied before any upstream code or async runtime. This executable is AIM's
 * bounded, offline library caller; it is never the interactive tool boundary. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported architecture
#endif
#define DENY(call) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_##call,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
#elif defined(__APPLE__)
#include <libproc.h>
#include <sandbox.h>
#include <stdlib.h>

static int close_private_descriptors(void) {
    int bytes=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,NULL,0);
    if (bytes<=0 || bytes>64*1024*1024) return -1;
    int capacity=bytes+(int)(32*sizeof(struct proc_fdinfo));
    struct proc_fdinfo *fds=malloc((size_t)capacity);
    if (!fds) return -1;
    int got=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,fds,capacity);
    if (got<=0 || got>=capacity || got%(int)sizeof(*fds)) { free(fds);return -1; }
    for (int i=0;i<got/(int)sizeof(*fds);i++) if (fds[i].proc_fd>=3) close(fds[i].proc_fd);
    free(fds);return 0;
}
#endif

static int private_channel(int fd) {
    struct stat st;
    if (fstat(fd,&st)) return 0;
    if (S_ISFIFO(st.st_mode)) return 1;
    /* Node implements child pipes as connected Unix socketpairs. The admitted
     * parent creates them specifically for this request, never reuses a bus. */
    if (S_ISSOCK(st.st_mode)) {
        struct sockaddr_storage address; socklen_t size=sizeof(address);
        if (getsockname(fd,(struct sockaddr *)&address,&size) || address.ss_family!=AF_UNIX) return 0;
        // Node closes its stdin endpoint after sending the request. On Mac,
        // getpeername then fails although this is still the same private Unix
        // stream; peer credentials remain available after that orderly EOF.
#if defined(__APPLE__)
        uid_t uid;gid_t gid;
        return !getpeereid(fd,&uid,&gid) && uid==getuid();
#elif defined(__linux__)
        struct ucred peer; socklen_t length=sizeof(peer);
        return !getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length) && length==sizeof(peer) && peer.uid==getuid();
#else
        return 0;
#endif
    }
    return 0;
}

int aim_config_channels(void) {
    if (getuid()==0 || getuid()!=geteuid() || getgid()!=getegid()) return -1;
    for (int fd=0;fd<3;fd++) if (!private_channel(fd)) return -1;
    umask(077);
#if defined(__linux__)
    return syscall(SYS_close_range,3,~0U,0);
#elif defined(__APPLE__)
    return close_private_descriptors();
#else
    return -1;
#endif
}

int aim_config_boundary(void) {
#if defined(__linux__)
    if (prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)) return -1;
    struct sock_filter code[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,NATIVE_ARCH,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(socket),DENY(socketpair),DENY(connect),DENY(sendto),DENY(sendmsg),DENY(sendmmsg),
        DENY(io_uring_setup),DENY(io_uring_enter),DENY(io_uring_register),
        DENY(execve),DENY(execveat),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program={.len=sizeof(code)/sizeof(code[0]),.filter=code};
    if (prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)) return -1;
    return 0;
#elif defined(__APPLE__)
    /* All broker lookups are denied, including both legacy and current DNS
     * brokers. Forced MDM values arrive from AIM's admitted policy reader. */
    char *error=NULL;
    // Seatbelt may only be initialized once. Request parsing precedes this
    // call; every upstream library call and worker starts after it.
    return sandbox_init("(version 1)(allow default)(deny network*)(deny mach-lookup)(deny process-exec)",0,&error);
#else
    return -1;
#endif
}
