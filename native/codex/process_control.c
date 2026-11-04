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
#include <stdint.h>
#if defined(__linux__)
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <sys/event.h>
#include <sys/sysctl.h>
#endif

struct process { pid_t pid,parent; char image[PATH_MAX],birth[80]; };

static int inspect(pid_t pid,struct process *value) {
    memset(value,0,sizeof(*value));value->pid=pid;
#if defined(__linux__)
    char file[64],buffer[4096];struct stat info;
    snprintf(file,sizeof(file),"/proc/%d",pid);
    if (stat(file,&info) || info.st_uid!=getuid()) return 0;
    snprintf(file,sizeof(file),"/proc/%d/exe",pid);
    ssize_t size=readlink(file,value->image,sizeof(value->image)-1);
    if (size<=0 || size>=(ssize_t)sizeof(value->image)-1) return 0;
    value->image[size]=0;
    snprintf(file,sizeof(file),"/proc/%d/stat",pid);
    FILE *input=fopen(file,"r");if (!input) return 0;
    char *read=fgets(buffer,sizeof(buffer),input);fclose(input);if (!read) return 0;
    char *end=strrchr(buffer,')');if (!end || end[1]!=' ') return 0;
    char *state=NULL,*field=strtok_r(end+2," ",&state);
    for (int index=3;field;index++,field=strtok_r(NULL," ",&state)) {
        if (index==4) value->parent=(pid_t)strtol(field,NULL,10);
        if (index==22) { snprintf(value->birth,sizeof(value->birth),"%llu",strtoull(field,NULL,10));return 1; }
    }
    return 0;
#elif defined(__APPLE__)
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info)
        || info.pbi_uid!=getuid() || info.pbi_ruid!=getuid()
        || proc_pidpath(pid,value->image,sizeof(value->image))<=0) return 0;
    value->parent=(pid_t)info.pbi_ppid;
    snprintf(value->birth,sizeof(value->birth),"%llu:%llu",(unsigned long long)info.pbi_start_tvsec,(unsigned long long)info.pbi_start_tvusec);
    return 1;
#else
    return 0;
#endif
}

static void quoted(const char *value) {
    putchar('"');
    for (const unsigned char *p=(const unsigned char *)value;*p;p++) {
        if (*p=='"' || *p=='\\') { putchar('\\');putchar(*p); }
        else if (*p<32) printf("\\u%04x",*p);
        else putchar(*p);
    }
    putchar('"');
}

/* Private discovery pipe only. Never print argv to a terminal or diagnostics.
 * Birth identity accompanies discovery so a later stop cannot target a reused
 * PID that happens to have the same executable (notably a Node AIM owner). */
static int inventory(void) {
    if (isatty(STDOUT_FILENO)) return 125;
    pid_t *pids=NULL;int count=0;
#if defined(__linux__)
    DIR *directory=opendir("/proc");if (!directory) return 125;
    struct dirent *entry;
    while ((entry=readdir(directory))) {
        char *end=NULL;long pid=strtol(entry->d_name,&end,10);
        if (!end || *end || pid<=1 || pid>INT_MAX) continue;
        pid_t *next=realloc(pids,(size_t)(count+1)*sizeof(*pids));
        if (!next) { free(pids);closedir(directory);return 125; }
        pids=next;pids[count++]=(pid_t)pid;
    }
    closedir(directory);
#elif defined(__APPLE__)
    int capacity=proc_listallpids(NULL,0)+256;
    pids=calloc((size_t)capacity,sizeof(*pids));if (!pids) return 125;
    count=proc_listallpids(pids,capacity*(int)sizeof(*pids));
    if (count<0 || count>=capacity) { free(pids);return 125; }
#endif
    putchar('[');int first=1;
    for (int i=0;i<count;i++) {
        struct process value,after;
        if (!inspect(pids[i],&value)) continue;
        char *args=calloc(1024*1024+1,1);if (!args) { free(pids);return 125; }
        size_t size=0,offset=0;int argc=INT_MAX;
#if defined(__linux__)
        char file[64];snprintf(file,sizeof(file),"/proc/%d/cmdline",value.pid);
        int fd=open(file,O_RDONLY|O_CLOEXEC);
        if (fd>=0) { ssize_t n=read(fd,args,1024*1024);close(fd);if (n>0) size=(size_t)n; }
#elif defined(__APPLE__)
        int mib[]={CTL_KERN,KERN_PROCARGS2,value.pid};size=1024*1024;
        if (sysctl(mib,3,args,&size,NULL,0) || size<sizeof(argc)) size=0;
        else {
            memcpy(&argc,args,sizeof(argc));offset=sizeof(argc);
            while (offset<size && args[offset]) offset++;
            while (offset<size && !args[offset]) offset++;
        }
#endif
        if (!inspect(value.pid,&after) || strcmp(value.birth,after.birth) || strcmp(value.image,after.image)) { free(args);continue; }
        if (!first) putchar(',');
        first=0;
        printf("{\"pid\":%d,\"parent\":%d,\"birth\":",value.pid,value.parent);quoted(value.birth);
        fputs(",\"image\":",stdout);quoted(value.image);fputs(",\"args\":[",stdout);
        int index=0;
        while (offset<size && index<argc) {
            if (index++) putchar(',');
            quoted(args+offset);
            offset+=strnlen(args+offset,size-offset)+1;
        }
        // Only a native installer classification is exported. No environment
        // values, including credential-directory paths, leave this helper.
#if defined(__linux__)
        memset(args,0,1024*1024+1);size=0;offset=0;
        snprintf(file,sizeof(file),"/proc/%d/environ",value.pid);
        fd=open(file,O_RDONLY|O_CLOEXEC);
        if (fd>=0) { ssize_t n=read(fd,args,1024*1024);close(fd);if (n>0) size=(size_t)n; }
#endif
        int env_visible=0;unsigned installer=0,installer_mode=0;int previous_release=0;
        while (offset<size) {
            const char *entry=args+offset;size_t length=strnlen(entry,size-offset);
            if (memchr(entry,'=',length)) env_visible=1;
            // The pinned updater invokes /bin/sh -s, with its script on stdin.
            // Export only a classification, never these environment values.
            const char *flags[]={"CODEX_INSTALL_DEFER_SELECTION=","CODEX_INSTALL_DAEMON_ONLY=",
                "CODEX_INSTALL_IF_LATEST=","CODEX_INSTALL_IF_CURRENT="};
            for (unsigned flag=0;flag<4;flag++) {
                size_t n=strlen(flags[flag]);
                if (length==n+1 && !strncmp(entry,flags[flag],n) && (entry[n]=='0' || entry[n]=='1')) {
                    installer|=1u<<flag;
                    if (entry[n]=='1') installer_mode|=1u<<flag;
                }
            }
            if (!strcmp(entry,"CODEX_RELEASE=latest")) installer|=16;
            if (!strcmp(entry,"CODEX_NON_INTERACTIVE=1")) installer|=32;
            if (!strncmp(entry,"CODEX_UPDATE_FROM_RELEASE=",26)) { installer|=64;previous_release=length>26; }
            if (!strncmp(entry,"CODEX_HOME=/",12)) installer|=128;
            offset+=length+1;
        }
        installer_mode&=13; // Daemon-only selects package layout, not update mode.
        int native_installer=installer==255 && ((installer_mode==1 && !previous_release)
            || ((installer_mode==4 || installer_mode==8) && previous_release));
        printf("],\"environment_visible\":%s,\"native_installer\":%s}",env_visible?"true":"false",native_installer?"true":"false");free(args);
    }
    free(pids);puts("]");return 0;
}

static int error(void) {
    fputs("Codex maintenance could not verify and stop an identified owner. Conversion remains pending.\n",stderr);
    return 125;
}

int main(int argc,char **argv) {
    if (getuid()==0 || getuid()!=geteuid()) return error();
    if (argc==2 && !strcmp(argv[1],"--inventory")) return inventory();
    if ((argc!=3 && argc!=4) || argv[2][0]!='/') return error();
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
    struct process expected;
    if (argc==4 && (!inspect(pid,&expected) || strcmp(expected.birth,argv[3]))) { close(handle);return error(); }
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
    struct process expected;
    if (argc==4 && (!inspect(pid,&expected) || strcmp(expected.birth,argv[3]))) { close(queue);return error(); }
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
