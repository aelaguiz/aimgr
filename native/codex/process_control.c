/* Finite, unprivileged identity-bound stop for explicit MCP maintenance.
 * Discovery belongs to setup. No process names, process groups or PID-file
 * timeouts authorize signaling; the caller supplies the verified exact image.
 * A timeout preserves pending maintenance and refuses conversion. */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <poll.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <sys/event.h>
#endif

static int error(void) {
    fputs("Codex maintenance could not verify and stop an identified owner. Conversion remains pending.\n",stderr);
    return 125;
}

int main(int argc,char **argv) {
    if (getuid()==0 || getuid()!=geteuid() || argc!=3 || argv[2][0]!='/') return error();
    char *end=NULL;errno=0;long number=strtol(argv[1],&end,10);
    if (errno || !end || *end || number<=1 || number>INT_MAX || number==getpid() || number==getppid()) return error();
    pid_t pid=(pid_t)number;
#if defined(__linux__)
    // Bind the process lifetime before inspecting /proc. Recycled PID entries
    // cannot redirect a signal sent through this handle.
    int handle=(int)syscall(SYS_pidfd_open,pid,0);
    if (handle<0) { if (errno==ESRCH) { puts("gone");return 0; } return error(); }
    struct pollfd exit_event={.fd=handle,.events=POLLIN};
    if (poll(&exit_event,1,0)>0) { close(handle);puts("gone");return 0; }
    char proc[64],image[PATH_MAX];struct stat info;
    snprintf(proc,sizeof(proc),"/proc/%d",pid);
    if (stat(proc,&info) || info.st_uid!=getuid()) { close(handle);return error(); }
    snprintf(proc,sizeof(proc),"/proc/%d/exe",pid);
    ssize_t size=readlink(proc,image,sizeof(image)-1);
    if (size<0 || size>=(ssize_t)sizeof(image)-1) { close(handle);return error(); }
    image[size]=0;
    if (strcmp(image,argv[2])) { close(handle);return error(); }
    if (syscall(SYS_pidfd_send_signal,handle,SIGTERM,NULL,0)) {
        int missing=errno==ESRCH;close(handle);
        if (missing) { puts("gone");return 0; } return error();
    }
    int ready;
    do { ready=poll(&exit_event,1,30000); } while (ready<0 && errno==EINTR);
    close(handle);
    if (ready<=0 || !(exit_event.revents&POLLIN)) return error();
#elif defined(__APPLE__)
    // A task-name port permits the audit-token query without task_for_pid or
    // a debugger entitlement. MAC policy may still refuse; do not downgrade
    // that refusal to PID-based kill().
    mach_port_t task=MACH_PORT_NULL;
    if (task_name_for_pid(mach_task_self(),pid,&task)!=KERN_SUCCESS) return error();
    audit_token_t token=INVALID_AUDIT_TOKEN_VALUE;mach_msg_type_number_t count=TASK_AUDIT_TOKEN_COUNT;
    kern_return_t result=task_info(task,TASK_AUDIT_TOKEN,(task_info_t)&token,&count);
    mach_port_deallocate(mach_task_self(),task);
    if (result!=KERN_SUCCESS || count!=TASK_AUDIT_TOKEN_COUNT || audit_token_to_pid(token)!=pid
        || audit_token_to_ruid(token)!=getuid() || audit_token_to_euid(token)!=geteuid()) return error();
    int queue=kqueue();if (queue<0) return error();
    struct kevent event;
    EV_SET(&event,(uintptr_t)pid,EVFILT_PROC,EV_ADD|EV_ENABLE|EV_ONESHOT,NOTE_EXIT,0,NULL);
    if (kevent(queue,&event,1,NULL,0,NULL)) { close(queue);return error(); }
    // Validate the token's image after installing the exit knote. If the PID
    // exited and was reused during registration, this old-token check fails.
    char image[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath_audittoken(&token,image,sizeof(image))<=0 || strcmp(image,argv[2])) { close(queue);return error(); }
    if (proc_signal_with_audittoken(&token,SIGTERM)) {
        // ESRCH also covers exec-version mismatch, not just process exit.
        // Keep the identity-bound knote and require actual NOTE_EXIT below;
        // a surviving replacement image leaves maintenance refused.
        if (errno!=ESRCH) { close(queue);return error(); }
    }
    struct timespec timeout={.tv_sec=30,.tv_nsec=0};
    int ready=kevent(queue,NULL,0,&event,1,&timeout);
    close(queue);
    if (ready!=1 || event.filter!=EVFILT_PROC || !(event.fflags&NOTE_EXIT)) return error();
#else
    return error();
#endif
    puts("exited");return 0;
}
