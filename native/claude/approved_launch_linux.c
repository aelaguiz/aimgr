/* Fixed native Linux entry, installed root-owned/setuid only as part of an
 * explicitly approved artifact set. No caller code, profile text, shell,
 * executable selection or privileged environment is accepted.
 *
 * T03/T07/T11: AppArmor keeps the common snapshot/update restrictions on
 * tools, while exact vendor exec transitions restore its private file view.
 * Unlike blanket no_new_privs, this retains trusted nested AIM route setup.
 * The uname listener is unprivileged, has no socket/service API, and lives
 * until the kernel reports that every inheriting task has gone away.
 * Every changed artifact requires the offsite native acceptance matrix before
 * normal-use approval; compilation alone is not privacy evidence.
 */
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

#define RUNTIME "/opt/aimgr-claude-runtime"
#define ARTIFACTS RUNTIME "/artifacts/"
#define MAX_ROOTS 256
#define MAX_ENV (16 * 1024 * 1024)
extern char **environ;
static uid_t caller;
static gid_t caller_group;
static char profile[160], tools_profile[170];
static _Noreturn void fail(const char *reason) {
    dprintf(2,"Claude was not started: native privacy admission failed (%s). Repair the approved runtime before retrying.\n",reason);
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
static void ancestors(FILE *out,const char *file,const char *rights,const char *qualifier) {
    char copy[PATH_MAX]; snprintf(copy,sizeof(copy),"%s",file);
    for (;;) { char *slash=strrchr(copy,'/'); if (!slash) fail("path ancestor");
        if (slash==copy) copy[1]=0; else *slash=0;
        fputs(qualifier,out); literal(out,copy); fprintf(out," %s,\n",rights);
        if (strcmp(copy,"/")) { size_t n=strlen(copy); copy[n]='/'; copy[n+1]=0;
            fputs(qualifier,out); literal(out,copy); fprintf(out," %s,\n",rights); copy[n]=0; }
        if (!strcmp(copy,"/")) break;
    }
}
static void other_exec(FILE *out,const char *prefix,const char **excluded,int count,const char *transition) {
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
        const char *next_excluded[2]; int next_count=0;
        for (int j=0;j<count;j++) if (excluded[j][n]==i) next_excluded[next_count++]=excluded[j];
        char next[PATH_MAX]; if (snprintf(next,sizeof(next),"%s%c",prefix,i)>=(int)sizeof(next)) fail("artifact path length");
        other_exec(out,next,next_excluded,next_count,transition);
    }
}
static void common_rules(FILE *out,const char *settings,const char **updates,int count) {
    fputs("deny ",out); literal(out,settings); fputs(" wlk,\n",out);
    ancestors(out,settings,"w","deny ");
    fputs("deny /etc/claude-code{,/**} wlk,\n",out);
    for (int i=0;i<count;i++) {
        char *part=NULL; size_t size=0; FILE *tmp=open_memstream(&part,&size);
        if (!tmp) fail("policy allocation");
        subtree(tmp,updates[i],"rwmklx"); fclose(tmp);
        // subtree emits two rules: prefix EACH rule with deny, not just the first.
        char *save=NULL; for (char *line=strtok_r(part,"\n",&save);line;line=strtok_r(NULL,"\n",&save)) fprintf(out,"deny %s\n",line);
        free(part); }
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
        char *args[]={"/usr/sbin/apparmor_parser",remove?"-R":"-a","-T",NULL};
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
        int vendor=size>0 && !strncmp(current,"aim-claude-p-",13) && strstr(current,"-tools")==NULL;
        response.id=request.id; if (size<=0 || vendor) response.error=-EPERM;
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
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,arch,1,0), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_uname,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program={.len=sizeof(filter)/sizeof(filter[0]),.filter=filter};
    int fd=syscall(SYS_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_NEW_LISTENER,&program);
    if (fd<0 || transfer_fd(channel[0],fd)) { kill(listener,SIGKILL); fail("syscall filter installation"); }
    close(fd);close(channel[0]);
}
int main(int argc,char **argv) {
    /* v1 MODE CONFIG SETTINGS SCRATCH ENVFD READCOUNT READROOT...
     * UPDATECOUNT UPDATEROOT... -- VENDOR_ARGS... (same as Mac).
     * File and provider admission remain the trusted AIM caller's precondition. */
    caller=getuid();caller_group=getgid();
    if (!caller || !caller_group || geteuid()!=0 || argc<10 || strcmp(argv[1],"v1")) fail("invocation");
    int protected=!strcmp(argv[2],"protected"),managed_validator=!strcmp(argv[2],"validate-managed");
    int validator=managed_validator || !strcmp(argv[2],"validate");
    if (!protected && !validator && strcmp(argv[2],"ordinary")) fail("mode");
    char self[PATH_MAX],vendor[PATH_MAX]; ssize_t n=readlink("/proc/self/exe",self,sizeof(self)-1);
    if (n<0 || n>=(ssize_t)sizeof(self)-1) fail("launcher path");
    self[n]=0;
    size_t prefix=strlen(ARTIFACTS);
    if (strncmp(self,ARTIFACTS,prefix) || strlen(self)!=prefix+64+strlen("/launcher") || strcmp(self+prefix+64,"/launcher")) fail("launcher installation");
    for (size_t i=prefix;i<prefix+64;i++) if (!((self[i]>='a' && self[i]<='f') || (self[i]>='0' && self[i]<='9'))) fail("artifact identity");
    immutable(self,0);chain(self); snprintf(vendor,sizeof(vendor),"%s",self); strcpy(strrchr(vendor,'/'),"/claude"); immutable(vendor,0);
    immutable("/usr/sbin/apparmor_parser",0);chain("/usr/sbin/apparmor_parser");
    const char *config=argv[3],*settings=argv[4],*scratch=argv[5]; canonical(config);canonical(settings);canonical(scratch);
    // Retain native refresh coordination with the exact legacy sibling lock;
    // no parent-directory grant is needed (T04/T16/T23).
    char config_lock[PATH_MAX];
    if (snprintf(config_lock,sizeof(config_lock),"%s.lock",config)>=(int)sizeof(config_lock)) fail("account lock path");
    if (protected) canonical_future(config_lock);
    struct passwd *user=getpwuid(caller); char home[PATH_MAX]; if (!user || !realpath(user->pw_dir,home)) fail("caller home");
    if (inside(home,config) || inside(home,scratch)) fail("overbroad private root");
    int envfd=number(argv[6],1024),readcount=number(argv[7],MAX_ROOTS),updateindex=8+readcount;
    if (updateindex>=argc) fail("read roots");
    int updatecount=number(argv[updateindex],MAX_ROOTS),separator=updateindex+1+updatecount;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("update roots");
    const char **roots=(const char **)(argv+8),**updates=(const char **)(argv+updateindex+1);
    for (int i=0;i<readcount;i++) { canonical(roots[i]); if (inside(home,roots[i]) || (inside(config,roots[i]) && strcmp(config,roots[i]))) fail("overbroad read root"); }
    for (int i=0;i<updatecount;i++) { canonical_future(updates[i]); if (inside(self,updates[i]) || inside(vendor,updates[i])) fail("invalid update root"); }
    char **private_environment=read_environment(envfd);
    if (validator) {
        // A nested AIM launch inherits its parent's AppArmor profile. Enter
        // through this one fixed Ux image, then drop privilege and call only
        // the immutable sibling validator. Its Landlock/seccomp isolation is
        // applied before the fixed vendor doctor; no arbitrary command or
        // privileged validator execution is exposed by this role.
        char helper[PATH_MAX]; snprintf(helper,sizeof(helper),"%s",self);
        strcpy(strrchr(helper,'/'),"/validate-settings"); immutable(helper,0);
        drop(); close_handles();
        char *args[MAX_ROOTS+6]={helper,vendor,(char *)scratch,(char *)settings,NULL};
        if (managed_validator) {
            args[4]="managed";
            for (int i=0;i<readcount;i++) args[i+5]=(char *)roots[i];
        }
        char *env[]={"PATH=/usr/bin:/bin","LANG=C.UTF-8",NULL};
        execve(helper,args,env);fail("isolated validator exec");
    }
    require_enforcement();
    unsigned char nonce[16]; if (getentropy(nonce,sizeof(nonce))) fail("policy identity"); char hex[33];
    for (int i=0;i<16;i++) snprintf(hex+2*i,3,"%02x",nonce[i]);
    snprintf(profile,sizeof(profile),"aim-claude-%c-%u-%s",protected?'p':'o',caller,hex);
    snprintf(tools_profile,sizeof(tools_profile),"%s-tools",profile);
    char *policy=NULL;size_t size=0;FILE *out=open_memstream(&policy,&size); if (!out) fail("policy allocation");
    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",profile);
    if (!protected) {
        // `allow all` implicitly includes ix and conflicts with the broad
        // vendor-to-tool px transitions. Spell out non-exec access so ordinary
        // file/device access remains unrestricted without conflicting x modes.
        fputs("network,\ncapability,\nsignal,\nptrace,\nunix,\n/** rwmlk,\n",out);
    }
    else {
        fputs("network,\ncapability,\nsignal,\nptrace,\nunix,\n",out);
        subtree(out,config,"rwmlk");subtree(out,scratch,"rwmlk");
        subtree(out,config_lock,"rwmlk");
        literal(out,vendor);fputs(" rm,\n",out);literal(out,settings);fputs(" r,\n",out);
        resolver_read(out);
        ancestors(out,config,"r","");ancestors(out,scratch,"r","");ancestors(out,settings,"r","");ancestors(out,vendor,"r","");
        for (int i=0;i<readcount;i++) { subtree(out,roots[i],"rwmlk");ancestors(out,roots[i],"r",""); }
        fputs("/{usr,bin,sbin,lib,lib64}{,/**} rm,\n/dev/{null,zero,random,urandom,tty,ptmx} rw,\n/dev/pts/{,**} rw,\n"
            "/etc/{resolv.conf,hosts,nsswitch.conf,gai.conf,localtime,ld.so.cache,passwd,group} r,\n/etc/{ssl,ca-certificates,claude-code}{,/**} r,\n"
            "/proc/{meminfo,stat,filesystems,loadavg,uptime} r,\n/proc/sys/{vm/overcommit_memory,kernel/ngroups_max} r,\n"
            "/proc/[0-9]*/{maps,auxv,status,stat,statm,attr/current} r,\n/proc/[0-9]*/task/[0-9]*/{stat,status} r,\n"
            "/sys/devices/system/cpu/{online,possible} r,\n/sys/kernel/mm/transparent_hugepage/hpage_pmd_size r,\n",out);
    }
    const char *excluded[]={vendor,self};char transition[200];snprintf(transition,sizeof(transition),"px -> %s",tools_profile);
    other_exec(out,"/",excluded,2,transition);literal(out,vendor);fputs(" ix,\n",out);literal(out,self);fputs(" Ux,\n",out);
    common_rules(out,settings,updates,updatecount);fputs("}\n",out);
    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",tools_profile);
    // `allow all` did not grant AF_UNIX stream creation/inheritance on the
    // tested kernel/parser combination. Node's child-process pipes are Unix
    // socketpairs, so it broke nested AIM before exec with EACCES. State these
    // classes explicitly, just as for the ordinary vendor profile; the fixed
    // exec transitions and common snapshot/update denials still apply.
    fputs("network,\ncapability,\nsignal,\nptrace,\nunix,\n/** rwmlk,\n",out);
    other_exec(out,"/",excluded,2,"ix");literal(out,vendor);fprintf(out," px -> %s,\n",profile);literal(out,self);fputs(" Ux,\n",out);
    common_rules(out,settings,updates,updatecount);fputs("}\n",out);
    if (fclose(out) || size>2*1024*1024) fail("policy generation");
    // Root-only runtime file. The installer creates it; no caller-selected
    // lock path or symlink is allowed. Entry occurs before releasing the lock.
    immutable(RUNTIME "/policy.lock",0);int lock=open(RUNTIME "/policy.lock",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if (lock<0 || flock(lock,LOCK_EX)) fail("policy installation lock");
    parse_policy(policy,0);free(policy);
    if (protected) install_uname();
    enter_profile();close(lock);drop();
    environ=private_environment;
    unset_environment("LD_PRELOAD");unset_environment("LD_AUDIT");
    set_environment("CLAUDE_CONFIG_DIR",config,1);set_environment("CLAUDE_SECURESTORAGE_CONFIG_DIR",config,1);
    set_environment("DISABLE_AUTOUPDATER","1",1);set_environment("DISABLE_UPDATES","1",1);set_environment("DISABLE_GROWTHBOOK","1",1);
    /* Detached supervisors can own later requests using their earlier image and
     * settings. Supply the narrow early default before vendor startup. Shared
     * argument admission and the settings snapshot keep supported AIM paths
     * disabled; this env pin alone does not override hostile disk settings. Ordinary background
     * Bash/subagents stay available; never use DISABLE_BACKGROUND_TASKS here. */
    set_environment("CLAUDE_CODE_DISABLE_AGENT_VIEW","1",1);
    if (protected) { set_environment("DISABLE_TELEMETRY","1",1);set_environment("DISABLE_ERROR_REPORTING","1",1); }
    set_environment("AIMGR_CLAUDE_LINUX_POLICY",profile,1);
    close_handles();argv[separator]=vendor;execv(vendor,argv+separator);fail("approved vendor exec");
}
