/* Shared immutable entry, AppArmor, descriptor and vendor-only uname primitives. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
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
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>

#define ARTIFACTS RUNTIME "/artifacts/"
#define MAX_ROOTS 256
#define MAX_ENV (16 * 1024 * 1024)
extern char **environ;
static uid_t caller;
static gid_t caller_group;
static char profile[160], tools_profile[170];
static _Noreturn void fail(const char *reason) {
    dprintf(2,VENDOR_NAME " was not started: native privacy admission failed (%s). Repair the approved runtime before retrying.\n",reason);
    _exit(125);
}
static void set_environment(const char *name,const char *value,int overwrite) {
    if (setenv(name,value,overwrite)) fail("required environment installation");
}
static void unset_environment(const char *name) {
    if (unsetenv(name)) fail("unsafe environment removal");
}
static void require_enforcement(void) {
    // A successful profile load/transition does not imply enforcement when
    // the host's global AppArmor mode is complain. Fail before vendor code.
    char mode[64]={0};
    int fd=open("/sys/module/apparmor/parameters/mode",O_RDONLY|O_CLOEXEC);
    ssize_t size=fd<0?-1:read(fd,mode,sizeof(mode)-1);
    if (fd>=0) close(fd);
    if (size<=0 || (strcmp(mode,"enforce\n") && strcmp(mode,"enforce"))) fail("AppArmor is not enforcing");
}
static void drop(void) {
    /* Supplementary groups were inherited from the caller, never initgroups
     * from a caller-selected name. Preserve actual tool access, drop saved IDs. */
    if (setresgid(caller_group,caller_group,caller_group) || setresuid(caller,caller,caller)
        || getuid()!=caller || geteuid()!=caller || getgid()!=caller_group) fail("privilege drop");
}
static void close_handles(void) {
    if (syscall(SYS_close_range,3u,~0u,0)) fail("descriptor closure");
}
static int inside(const char *file,const char *directory) {
    size_t n=strlen(directory);
    return !strcmp(directory,"/") || !strcmp(file,directory) || (!strncmp(file,directory,n) && file[n]=='/');
}
static void canonical(const char *file) {
    char resolved[PATH_MAX];
    if (!file || file[0]!='/' || strlen(file)>=PATH_MAX || !realpath(file,resolved) || strcmp(file,resolved)) fail("noncanonical path");
    for (const unsigned char *p=(const unsigned char *)file;*p;p++) if (*p<32 || *p==127) fail("invalid path");
}
// Updater roots need enforcement even before the installer creates them.
// Require a canonical existing prefix and literal missing components; never
// create a user directory just to apply a deny rule or follow a dangling link.
static void canonical_future(const char *file) {
    if (!file || file[0]!='/' || strlen(file)>=PATH_MAX) fail("invalid future path");
    for (const unsigned char *p=(const unsigned char *)file;*p;p++) if (*p<32 || *p==127) fail("invalid future path");
    char copy[PATH_MAX]; snprintf(copy,sizeof(copy),"%s",file);
    const char *part=file+1;
    while (*part) {
        const char *end=strchr(part,'/'); size_t size=end?(size_t)(end-part):strlen(part);
        if (!size || (size==1 && part[0]=='.') || (size==2 && part[0]=='.' && part[1]=='.')) fail("noncanonical future path");
        if (!end) break;
        part=end+1; if (!*part) fail("noncanonical future path");
    }
    struct stat st;
    while (lstat(copy,&st)) {
        if (errno!=ENOENT) fail("future path inspection");
        char *slash=strrchr(copy,'/'); if (!slash) fail("future path ancestor");
        if (slash==copy) { copy[1]=0; break; }
        *slash=0;
    }
    canonical(copy);
}
static void immutable(const char *file,int directory) {
    struct stat st;
    if (lstat(file,&st) || st.st_uid!=0 || (st.st_mode&022)
        || (directory?!S_ISDIR(st.st_mode):!S_ISREG(st.st_mode)) || (!directory && st.st_nlink!=1)) fail("mutable artifact");
    if (!directory) {
        // File capabilities can grant privilege without changing bytes or
        // mode bits. Normal tools retain privilege support, so NNP cannot be
        // relied on here to neutralize unexpected vendor/validator metadata.
        int fd=open(file,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
        if (fd<0) fail("artifact capability inspection");
        errno=0; ssize_t size=fgetxattr(fd,"security.capability",NULL,0); int error=errno;
        close(fd);
        if (size>=0 || error!=ENODATA) fail("artifact has unsupported capabilities");
    }
    /* POSIX ACL write grants are bounded by the group mode mask. Mode 022
     * rejects those effective grants as well as ordinary group/other writes. */
}
static void chain(const char *file) {
    char copy[PATH_MAX]; snprintf(copy,sizeof(copy),"%s",file);
    for (;;) { char *slash=strrchr(copy,'/'); if (!slash) fail("artifact ancestor");
        if (slash==copy) copy[1]=0; else *slash=0;
        immutable(copy,1); if (!strcmp(copy,"/")) break; }
}
static int number(const char *s,int maximum) {
    char *end; errno=0; long n=strtol(s,&end,10);
    if (!*s || errno || *end || n<0 || n>maximum) fail("numeric argument");
    return (int)n;
}
static void literal(FILE *out,const char *s) {
    /* Escape both the string and AARE grammar. User paths never supply a
     * wildcard, variable expansion, additional rule or policy directive. */
    fputc('"',out);
    for (const char *p=s;*p;p++) { if (strchr("\\\"*?[]{}^",*p)) fputc('\\',out); fputc(*p,out); }
    fputc('"',out);
}
static void ordinary_access(FILE *out) {
    /* Tools keep normal host operations, including their own sandboxes. Do
     * not use default_allow/unconfined: those modes bypass the exact vendor
     * exec transitions below. Do not use `allow all`, which adds conflicting
     * ix permissions. Keep every non-exec class explicit. */
    fputs("network,\ncapability,\nsignal,\nptrace,\nunix,\ndbus,\n"
          "mount,\nremount,\numount,\npivot_root,\nuserns,\nmqueue,\nio_uring,\n/ rwmlk,\n/** rwmlk,\n",out);
}
static void resolver_read(FILE *out) {
    /* AppArmor mediates the canonical target, so the literal /etc/resolv.conf
     * rule alone breaks DNS on systemd-resolved hosts. Resolve this fixed OS
     * dependency, never a caller/env-selected path. Grant only that regular
     * file read access: granting /run or the resolver directory would expose
     * unrelated service state. Atomic replacement at the same canonical path
     * remains supported; changing the symlink target requires a new session.
     * Resolver data may legitimately belong to systemd-resolve, unlike the
     * immutable root-owned executable artifacts checked above. */
    char resolved[PATH_MAX]; struct stat st;
    if (!realpath("/etc/resolv.conf",resolved) || stat(resolved,&st) || !S_ISREG(st.st_mode))
        fail("system DNS configuration");
    canonical(resolved);
    literal(out,resolved);fputs(" r,\n",out);
}
static void subtree(FILE *out,const char *file,const char *rights) {
    literal(out,file); fprintf(out," %s,\n",rights);
    char pattern[PATH_MAX]; if (snprintf(pattern,sizeof(pattern),"%s/",file)>=(int)sizeof(pattern)) fail("path length");
    /* The path part is literal; only this fixed suffix is a wildcard. */
    char *text=NULL; size_t length=0; FILE *buffer=open_memstream(&text,&length);
    if (!buffer) fail("policy allocation");
    literal(buffer,pattern); fclose(buffer);
    /* Kernel directory opens use a trailing slash. The bare root rule above
     * matches a file; the recursive wildcard alone may omit the directory.
     * Include that exact directory so shared skills can be enumerated without
     * granting any parent or sibling. Apply the same spelling to update denies.
     * Regression: privacy-linux-directory-check.py uses actual kernel opens;
     * libapparmor's query interface alone reported a misleading allow here. */
    text[length-1]=0; fprintf(out,"%s{,**}\" %s,\n",text,rights); free(text);
}
static inline void ancestors(FILE *out,const char *file,const char *rights,const char *qualifier) {
    char copy[PATH_MAX]; snprintf(copy,sizeof(copy),"%s",file);
    for (;;) { char *slash=strrchr(copy,'/'); if (!slash) fail("path ancestor");
        if (slash==copy) copy[1]=0; else *slash=0;
        fputs(qualifier,out); literal(out,copy); fprintf(out," %s,\n",rights);
        if (strcmp(copy,"/")) { size_t n=strlen(copy); copy[n]='/'; copy[n+1]=0;
            fputs(qualifier,out); literal(out,copy); fprintf(out," %s,\n",rights); copy[n]=0; }
        if (!strcmp(copy,"/")) break;
    }
}
static const char *launcher_namespaces[]={
    "/opt/aimgr-claude-runtime/artifacts/", "/opt/aimgr-codex-runtime/artifacts/"
};
static void artifact_exec(FILE *,const char *,const char **,int,const char *);
static void other_exec(FILE *out,const char *prefix,const char **excluded,int count,const char *transition) {
    for (int i=0;i<2;i++) if (!strcmp(prefix,launcher_namespaces[i])) {
        artifact_exec(out,prefix,excluded,count,transition); return;
    }
    /* Overlapping ix/px/Ux rules conflict; they do not have a most-specific
     * winner. Emit the exact complement of the two fixed image paths. No
     * generic abstractions with hidden ix rules are included (native v4 test). */
    size_t n=strlen(prefix); int terminal=0; unsigned char children[128]={0};
    for (int i=0;i<count;i++) { unsigned char next=(unsigned char)excluded[i][n];
        if (!next) terminal=1; else { if (next>=128) fail("artifact path encoding"); children[next]=1; } }
    if (!terminal && n>1) { literal(out,prefix); fprintf(out," %s,\n",transition); }
    char *quoted=NULL; size_t length=0; FILE *buffer=open_memstream(&quoted,&length);
    if (!buffer) fail("policy allocation");
    literal(buffer,prefix); fclose(buffer); quoted[length-1]=0;
    int any=0; for (int i=1;i<128;i++) any|=children[i];
    fprintf(out,"%s",quoted); free(quoted);
    if (any) {
        fputs("[^",out); for (int i=1;i<128;i++) if (children[i]) { if (strchr("\\]-^",i)) fputc('\\',out); fputc(i,out); }
        fprintf(out,"]**\" %s,\n",transition);
    } else fprintf(out,"?**\" %s,\n",transition);
    for (int i=1;i<128;i++) if (children[i]) {
        const char *next_excluded[MAX_ROOTS]; int next_count=0;
        for (int j=0;j<count;j++) if (excluded[j][n]==i) next_excluded[next_count++]=excluded[j];
        char next[PATH_MAX]; if (snprintf(next,sizeof(next),"%s%c",prefix,i)>=(int)sizeof(next)) fail("artifact path length");
        other_exec(out,next,next_excluded,next_count,transition);
    }
}
static void nonlauncher_exec(FILE *out,const char *prefix,const char *transition) {
    /* prefix is a generated AARE for exactly one bundle directory, never a
     * user path. Partition its descendants around the one literal leaf. */
    const char *leaf="launcher";
    for (size_t i=0;i<strlen(leaf);i++) {
        if (i) fprintf(out,"\"%s%.*s\" %s,\n",prefix,(int)i,leaf,transition);
        fprintf(out,"\"%s%.*s[^%c]**\" %s,\n",prefix,(int)i,leaf,leaf[i],transition);
    }
    fprintf(out,"\"%slauncher?**\" %s,\n",prefix,transition);
}
static void artifact_exec(FILE *out,const char *prefix,const char **excluded,int count,const char *transition) {
    char bundle[65]={0},pattern[PATH_MAX];size_t n=strlen(prefix);
    const char *local[3];int locals=0;
    for (int i=0;i<count;i++) if (strlen(excluded[i])>n) {
        const char *slash=strchr(excluded[i]+n,'/');
        if (!slash || slash-excluded[i]!=(ptrdiff_t)(n+64) || locals==3) fail("artifact exec partition");
        if (!locals) memcpy(bundle,excluded[i]+n,64);
        if (strncmp(bundle,excluded[i]+n,64)) fail("artifact exec partition");
        local[locals++]=excluded[i];
    }
    fprintf(out,"\"%s*\" %s,\n",prefix,transition); // Immediate entries, not descendants.
    if (!locals) {
        snprintf(pattern,sizeof(pattern),"%s*/",prefix);nonlauncher_exec(out,pattern,transition);return;
    }
    // All other bundle names, partitioned without matching this exact bundle.
    // A single-component wildcard is sufficient: each immutable launcher
    // validates its 64-hex installation shape before executing a vendor.
    char *others=NULL;size_t size=0;FILE *group=open_memstream(&others,&size);
    if (!group) fail("artifact exec allocation");
    fprintf(group,"%s{",prefix);
    for (int i=0;i<64;i++) {
        if (i) fprintf(group,",%.*s,",i,bundle);
        fprintf(group,"%.*s[^%c/]*",i,bundle,bundle[i]);
    }
    fprintf(group,",%s?*}/",bundle);
    if (fclose(group)) fail("artifact exec allocation");
    nonlauncher_exec(out,others,transition);free(others);
    snprintf(pattern,sizeof(pattern),"%s%s/",prefix,bundle);other_exec(out,pattern,local,locals,transition);
}
static void launcher_exec(FILE *out) {
    for (int i=0;i<2;i++) fprintf(out,"\"%s*/launcher\" Ux,\n",launcher_namespaces[i]);
}
static void trusted_launcher_namespaces(void) {
    for (int i=0;i<2;i++) {
        char directory[PATH_MAX];snprintf(directory,sizeof(directory),"%s",launcher_namespaces[i]);
        directory[strlen(directory)-1]=0;
        struct stat st;
        if (lstat(directory,&st)) {
            if (errno!=ENOENT) fail("launcher namespace inspection");
            // A missing namespace can only be created beneath its first
            // existing immutable ancestor. No user-created future exception.
            while (lstat(directory,&st)) {
                if (errno!=ENOENT) fail("launcher namespace ancestor");
                char *slash=strrchr(directory,'/');if (!slash || slash==directory) fail("launcher namespace ancestor");*slash=0;
            }
            immutable(directory,1);chain(directory);continue;
        }
        immutable(directory,1);chain(directory);
        DIR *dir=opendir(directory);if (!dir) fail("launcher namespace inventory");
        struct dirent *entry;
        while ((entry=readdir(dir))) {
            if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
            char child[PATH_MAX],launcher[PATH_MAX];
            if (snprintf(child,sizeof(child),"%s/%s",directory,entry->d_name)>=(int)sizeof(child)) fail("launcher namespace path");
            if (lstat(child,&st)) fail("launcher namespace entry");
            if (S_ISREG(st.st_mode)) continue;
            immutable(child,1);
            if (snprintf(launcher,sizeof(launcher),"%s/launcher",child)>=(int)sizeof(launcher)) fail("launcher namespace path");
            if (lstat(launcher,&st)) { if (errno==ENOENT) continue;fail("launcher namespace image"); }
            immutable(launcher,0);
        }
        closedir(dir);
    }
}
static void parse_policy(const char *text,int remove) {
    int input[2]; if (pipe2(input,O_CLOEXEC)) fail("policy pipe");
    pid_t child=fork(); if (child<0) fail("policy compiler fork");
    if (!child) {
        // Only this fixed system parser runs elevated. Give it consistent
        // real/effective IDs instead of making it mistake our inherited IDs
        // for an accidentally setuid-installed parser binary.
        if (setgroups(0,NULL) || setresgid(0,0,0) || setresuid(0,0,0)) _exit(125);
        if (dup2(input[0],0)<0) _exit(125);
        close_handles();
        char *env[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin","LANG=C",NULL};
        char *args[]={"/usr/sbin/apparmor_parser",remove?"-R":"-a","-T",
#ifdef APPARMOR_SKIP_EXPR_NORMALIZE
            // Codex generates fresh policies per launch. Its literal-root
            // rules compile faster without this expression-reordering pass;
            // DFA minimization and permission enforcement remain enabled.
            "-O", "no-expr-normalize",
#endif
            NULL};
        execve(args[0],args,env); _exit(125);
    }
    close(input[0]); size_t size=strlen(text), offset=0;
    while (offset<size) { ssize_t got=write(input[1],text+offset,size-offset);
        if (got<0 && errno==EINTR) continue;
        if (got<=0) fail("policy compiler input");
        offset+=(size_t)got; }
    close(input[1]); int status;
    if (waitpid(child,&status,0)!=child || !WIFEXITED(status) || WEXITSTATUS(status)) fail("native policy load");
}
static void enter_profile(void) {
    int fd=open("/proc/self/attr/current",O_WRONLY|O_CLOEXEC); char value[200];
    int size=snprintf(value,sizeof(value),"changeprofile %s",profile);
    if (fd<0 || write(fd,value,(size_t)size)!=size) fail("native policy entry");
    close(fd);
    // Check the actual profile and its mode. A parser configuration or host
    // setting that puts this policy into complain mode cannot silently pass.
    char actual[256]={0},expected[256];
    snprintf(expected,sizeof(expected),"%s (enforce)\n",profile);
    fd=open("/proc/self/attr/current",O_RDONLY|O_CLOEXEC);
    ssize_t got=fd<0?-1:read(fd,actual,sizeof(actual)-1);
    if (fd>=0) close(fd);
    if (got<=0 || strcmp(actual,expected)) fail("native policy is not enforcing");
}
static char **read_environment(int fd) {
    struct stat st; if (fd<3 || fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=caller
        || st.st_nlink || (st.st_mode&077) || st.st_size<1 || st.st_size>MAX_ENV) fail("private environment transfer");
    size_t size=(size_t)st.st_size, offset=0; char *buffer=calloc(size+1,1);
    if (!buffer || lseek(fd,0,SEEK_SET)<0) fail("environment allocation");
    while (offset<size) { ssize_t got=read(fd,buffer+offset,size-offset);
        if (got<0 && errno==EINTR) continue;
        if (got<=0) fail("environment read");
        offset+=(size_t)got; }
    close(fd); if (buffer[size-1]) fail("environment termination");
    size_t count=0; for (offset=0;offset<size;offset+=strlen(buffer+offset)+1) {
        const char *equals=strchr(buffer+offset,'='); if (!equals || equals==buffer+offset) fail("environment entry"); count++; }
    char **values=calloc(count+1,sizeof(char *)); if (!values) fail("environment allocation");
    count=0; for (offset=0;offset<size;offset+=strlen(buffer+offset)+1) values[count++]=buffer+offset;
    return values;
}
static int transfer_fd(int socket,int fd) {
    char byte='F',control[CMSG_SPACE(sizeof(int))]={0}; struct iovec iov={&byte,1};
    struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};
    struct cmsghdr *cmsg=CMSG_FIRSTHDR(&msg); cmsg->cmsg_level=SOL_SOCKET;cmsg->cmsg_type=SCM_RIGHTS;cmsg->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cmsg),&fd,sizeof(fd)); return sendmsg(socket,&msg,0)==1?0:-1;
}
static int receive_fd(int socket) {
    char byte,control[CMSG_SPACE(sizeof(int))]={0}; struct iovec iov={&byte,1};
    struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};
    if (recvmsg(socket,&msg,MSG_CMSG_CLOEXEC)!=1) return -1;
    struct cmsghdr *cmsg=CMSG_FIRSTHDR(&msg);
    if (!cmsg || cmsg->cmsg_level!=SOL_SOCKET || cmsg->cmsg_type!=SCM_RIGHTS || cmsg->cmsg_len!=CMSG_LEN(sizeof(int))) return -1;
    int fd; memcpy(&fd,CMSG_DATA(cmsg),sizeof(fd)); return fd;
}
static int vendor_label(const char *label) {
    /* NNP-compatible self-reentry can retain the tools profile and add the
     * vendor profile. Every component then applies: a tools component must
     * never exempt a vendor component from the uname restriction. */
    const char *part=label;
    while (*part) {
        const char *next=strstr(part,"//&");
        size_t length=next?(size_t)(next-part):strcspn(part," \n");
        int managed=(length>=13 && !strncmp(part,"aim-claude-p-",13))
            || (length>=12 && !strncmp(part,"aim-codex-p-",12));
        if (managed && (length<6 || strncmp(part+length-6,"-tools",6))) return 1;
        if (!next) break;
        part=next+3;
    }
    return 0;
}
static void listen_uname(int channel) {
    drop(); if (setsid()<0) _exit(125);
    int listener=receive_fd(channel); close(channel); if (listener<0) _exit(125);
    /* The original foreground owner may exit before a legitimate background
     * worker. Poll HUP comes from seccomp's filter user count, including all
     * descendants; waitpid of that foreground is not a lifetime boundary. */
    for (;;) {
        struct pollfd ready={.fd=listener,.events=POLLIN};
        int result=poll(&ready,1,-1); if (result<0 && errno==EINTR) continue;
        if (result<0 || (ready.revents&(POLLHUP|POLLERR|POLLNVAL))) break;
        if (!(ready.revents&POLLIN)) continue;
        struct seccomp_notif request={0}; struct seccomp_notif_resp response={0};
        if (ioctl(listener,SECCOMP_IOCTL_NOTIF_RECV,&request)) { if (errno==EINTR || errno==ENOENT) continue; break; }
        char file[80],current[512]={0}; snprintf(file,sizeof(file),"/proc/%u/attr/current",request.pid);
        int fd=open(file,O_RDONLY|O_CLOEXEC); ssize_t size=fd<0?-1:read(fd,current,sizeof(current)-1); if (fd>=0) close(fd);
        // A failed inspection is a denial, never a guessed tool exemption.
        int vendor=size>0 && vendor_label(current);
        response.id=request.id; if (size<=0 || size==(ssize_t)sizeof(current)-1 || vendor) response.error=-EPERM;
        else response.flags=SECCOMP_USER_NOTIF_FLAG_CONTINUE;
        if (ioctl(listener,SECCOMP_IOCTL_NOTIF_ID_VALID,&request.id)) continue;
        if (ioctl(listener,SECCOMP_IOCTL_NOTIF_SEND,&response) && errno!=ENOENT) break;
    }
    close(listener); _exit(0);
}
static int inherited_filter(void) {
    if (prctl(PR_GET_SECCOMP)!=SECCOMP_MODE_FILTER) return 0;
    struct utsname value; if (uname(&value)) fail("inherited syscall policy blocks ordinary tools");
    pid_t probe=fork(); if (probe<0) fail("inherited policy probe");
    if (!probe) { enter_profile(); drop(); errno=0; int result=uname(&value); _exit(result<0 && errno==EPERM?0:1); }
    int status; if (waitpid(probe,&status,0)!=probe || !WIFEXITED(status)) fail("inherited policy probe");
    return WEXITSTATUS(status)==0;
}
static void install_uname(void) {
    if (inherited_filter()) return;
    int channel[2]; if (socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,channel)) fail("syscall listener channel");
    pid_t listener=fork(); if (listener<0) fail("syscall listener fork");
    if (!listener) {
        close(channel[0]);
        // Retain only the private channel, including above lowered rlimits.
        if (dup2(channel[1],3)<0 || syscall(SYS_close_range,4u,~0u,0)) _exit(125);
        close(0);close(1);close(2); listen_uname(3);
    }
    close(channel[1]);
#if defined(__x86_64__)
    const unsigned int arch=AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
    const unsigned int arch=AUDIT_ARCH_AARCH64;
#else
#error Unsupported syscall architecture
#endif
    struct sock_filter filter[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,arch,1,0),
#ifdef NOTIFY_COMPAT_SYSCALLS
        // The official vendor uses the admitted native ABI. Other ABIs belong
        // to ordinary tools: inspect their AppArmor profile before allowing
        // the syscall instead of killing those tools via an inherited filter.
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF),
#else
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(NOTIFY_COMPAT_SYSCALLS) && defined(__x86_64__)
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K,~0x40000000u),
#endif
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_uname,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program={.len=sizeof(filter)/sizeof(filter[0]),.filter=filter};
    int fd=syscall(SYS_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_NEW_LISTENER,&program);
    if (fd<0 || transfer_fd(channel[0],fd)) { kill(listener,SIGKILL); fail("syscall filter installation"); }
    close(fd);close(channel[0]);
}
