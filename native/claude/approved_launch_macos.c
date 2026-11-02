/* Final unprivileged macOS entry for the approved, unmodified Claude package.
 *
 * T02/T03/T08/T11: compile and hardened-runtime sign THIS helper during the
 * approved installation. No DYLD/library-validation exception is permitted.
 * Seatbelt's no-sandbox transition occurs before main; ordinary code clearing
 * DYLD_* inside main would already be too late. The only reentry exception is
 * this immutable image. It accepts data paths and fixed modes, never SBPL or a
 * replacement executable, and applies the new policy before any payload runs.
 *
 * The trusted AIM caller first validates the complete artifact manifest,
 * provider/admin settings and exact snapshot. This helper independently keeps
 * its own package immutable, fixes the vendor target relative to itself, adds
 * mandatory common restrictions, restores the private environment transfer
 * only after policy entry, closes inherited descriptors, then execs that image.
 * No request, callback, interpreter or vendor probe runs before policy entry.
 */
#include <sys/acl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <mach-o/dyld.h>
#include <libproc.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
extern int sandbox_init_with_parameters(const char *, uint64_t, const char *const *, char **);
extern char **environ;
#define RUNTIME_ROOT "/opt/aimgr-claude-runtime/artifacts/"
#define MAX_ROOTS 256
#define MAX_ENV (16 * 1024 * 1024)
static _Noreturn void fail(const char *reason) {
    dprintf(2,"Claude was not started: native privacy admission failed (%s). Repair the approved runtime before retrying.\n",reason);
    _exit(125);
}
// Required controls must survive allocation failures as a refusal, never
// as execution under the preceding configuration or opt-out values.
static void set_environment(const char *name,const char *value,int overwrite) {
    if (setenv(name,value,overwrite)) fail("required environment installation");
}
static int inside(const char *file,const char *directory) {
    if (!strcmp(directory,"/")) return file[0]=='/';
    size_t n=strlen(directory);
    return !strcmp(file,directory) || (!strncmp(file,directory,n) && file[n]=='/');
}
static void close_descriptors_except(int retained) {
    /* A descriptor opened before RLIMIT_NOFILE was lowered can remain above
     * the current hard limit. Inventory the kernel's actual handles; a bound
     * derived from that limit silently leaks such a handle to the vendor. */
    int bytes=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,NULL,0);
    if (bytes<=0 || bytes>64*1024*1024) fail("descriptor inventory");
    int capacity=bytes+(int)(32*sizeof(struct proc_fdinfo));
    struct proc_fdinfo *fds=malloc((size_t)capacity);
    if (!fds) fail("descriptor inventory allocation");
    int got=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,fds,capacity);
    if (got<=0 || got>=capacity || got%(int)sizeof(*fds)) fail("descriptor inventory changed");
    for (int i=0;i<got/(int)sizeof(*fds);i++) if (fds[i].proc_fd>=3 && fds[i].proc_fd!=retained) close(fds[i].proc_fd);
    free(fds);
}
static void close_inherited_descriptors(void) { close_descriptors_except(-1); }
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
    int fd=open(file,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);
    if (fd<0 || fstat(fd,&st) || st.st_uid!=0 || (st.st_mode&022) || (directory?!S_ISDIR(st.st_mode):!S_ISREG(st.st_mode))
        || (!directory && st.st_nlink!=1)) fail("mutable artifact");
    errno=0; acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED); int acl_error=errno;
    close(fd);
    // Darwin returns ENOENT for an absent ACL property even on a valid open
    // inode. Query the descriptor so this cannot mean a missing/replaced path.
    // All other inspection failures remain fatal.
    if (!acl && acl_error==ENOENT) return;
    if (!acl || acl_valid(acl)) fail("artifact ACL unreadable");
    acl_entry_t entry; int index=ACL_FIRST_ENTRY;
    while (acl_get_entry(acl,index,&entry)==0) {
        index=ACL_NEXT_ENTRY;
        acl_tag_t tag; acl_permset_mask_t permissions;
        if (acl_get_tag_type(entry,&tag) || acl_get_permset_mask_np(entry,&permissions)) fail("artifact ACL invalid");
        if (tag==ACL_EXTENDED_DENY) continue;
        if (tag!=ACL_EXTENDED_ALLOW) fail("artifact ACL unsupported");
        const acl_permset_mask_t read_only=ACL_READ_DATA|ACL_EXECUTE|ACL_READ_ATTRIBUTES|ACL_READ_EXTATTRIBUTES|ACL_READ_SECURITY|ACL_SYNCHRONIZE;
        if (permissions & ~read_only) fail("artifact ACL permits mutation");
    }
    acl_free(acl);
}
static void chain(const char *file) {
    char buffer[PATH_MAX]; strlcpy(buffer,file,sizeof(buffer));
    for (;;) {
        char *slash=strrchr(buffer,'/'); if (!slash) fail("invalid artifact ancestor");
        if (slash==buffer) buffer[1]=0; else *slash=0;
        immutable(buffer,1); if (!strcmp(buffer,"/")) break;
    }
}
static void quote(FILE *out,const char *s) {
    fputc('"',out);
    for (const unsigned char *p=(const unsigned char *)s;*p;p++) {
        if (*p<32 || *p==127) fail("invalid policy input");
        if (*p=='"' || *p=='\\') fputc('\\',out);
        fputc(*p,out);
    }
    fputc('"',out);
}
static void rule(FILE *out,const char *filter,const char *file) {
    fprintf(out,"(%s ",filter); quote(out,file); fputc(')',out);
}
static void ancestors(FILE *out,const char *file) {
    char buffer[PATH_MAX]; strlcpy(buffer,file,sizeof(buffer));
    for (;;) {
        char *slash=strrchr(buffer,'/'); if (!slash) fail("invalid policy ancestor");
        if (slash==buffer) buffer[1]=0; else *slash=0;
        rule(out,"literal",buffer); if (!strcmp(buffer,"/")) break;
    }
}
static int number(const char *value,int maximum) {
    if (!value || !*value) fail("invalid argument count");
    char *end; errno=0; long result=strtol(value,&end,10);
    if (errno || *end || result<0 || result>maximum) fail("invalid numeric input");
    return (int)result;
}
static void restore_environment(int fd) {
    struct stat st;
    if (fd<3 || fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=getuid() || st.st_nlink!=0
        || (st.st_mode&077) || st.st_size<1 || st.st_size>MAX_ENV) fail("private environment transfer");
    size_t size=(size_t)st.st_size, offset=0; char *buffer=calloc(size+1,1);
    if (!buffer || lseek(fd,0,SEEK_SET)<0) fail("environment allocation");
    while (offset<size) {
        ssize_t got=read(fd,buffer+offset,size-offset);
        if (got<0 && errno==EINTR) continue;
        if (got<=0) fail("environment read");
        offset+=(size_t)got;
    }
    if (buffer[size-1]) fail("environment format");
    size_t count=0;
    for (offset=0;offset<size;offset+=strlen(buffer+offset)+1) {
        const char *equals=strchr(buffer+offset,'=');
        if (!equals || equals==buffer+offset) fail("environment entry");
        count++;
    }
    char **values=calloc(count+1,sizeof(char *)); if (!values) fail("environment allocation");
    count=0;
    for (offset=0;offset<size;offset+=strlen(buffer+offset)+1) values[count++]=buffer+offset;
    environ=values; close(fd);
}
static _Noreturn void enter_route(int argc,char **argv,const char *self) {
    // A nested session inherits Seatbelt, which prevents even /bin/ps and our
    // setuid routing identity helper from executing. Reenter ONLY through
    // this hardened immutable image. This role never accepts a payload path,
    // script, policy or interpreter flag: its sole payload is this same image
    // in protected final-policy mode. The caller's private environment stays
    // unopened until that policy has been applied.
    if (argc<14 || strcmp(argv[4],"--") || strcmp(argv[5],"v1") || strcmp(argv[6],"protected")
        || number(argv[10],1024)!=3 || strlen(argv[3])>16384) fail("route invocation");
    canonical(argv[7]);
    const char *helper="/opt/aimgr-claude-proxy/darwin_proxy.py";
    const char *identity="/opt/aimgr-claude-proxy/darwin_identity";
    immutable(helper,0); chain(helper); immutable(identity,0); chain(identity);
    struct stat transfer;
    if (fstat(3,&transfer) || !S_ISREG(transfer.st_mode) || transfer.st_uid!=getuid()
        || transfer.st_nlink!=0 || (transfer.st_mode&077) || transfer.st_size<1 || transfer.st_size>MAX_ENV) fail("route private environment");
    close_descriptors_except(3);
    // Do not restore caller-controlled DYLD/Python/Node variables while this
    // route setup is outside Seatbelt. Identity restores only these fixed
    // values; the vendor's complete environment crosses separately as fd3.
    FILE *environment=tmpfile(); if (!environment) fail("route environment");
    const char *base[]={"PATH=/usr/bin:/bin:/usr/sbin:/sbin","LANG=C.UTF-8",NULL};
    for (int i=0;base[i];i++) if (fwrite(base[i],1,strlen(base[i])+1,environment)!=strlen(base[i])+1) fail("route environment write");
    if (fprintf(environment,"CLAUDE_CONFIG_DIR=%s",argv[7])<0 || fputc(0,environment)==EOF
        || fflush(environment) || fseek(environment,0,SEEK_SET)) fail("route environment write");
    int fd=fileno(environment);
    if (fd==3 || fcntl(fd,F_SETFD,0) || fcntl(3,F_SETFD,0)) fail("route descriptors");
    char descriptor[24]; snprintf(descriptor,sizeof(descriptor),"%d",fd);
    char **args=calloc((size_t)argc+6,sizeof(char *)); if (!args) fail("route allocation");
    args[0]="/usr/bin/python3"; args[1]="-I"; args[2]=(char *)helper; args[3]="launch-approved";
    args[4]=argv[2]; args[5]=argv[3]; args[6]=descriptor; args[7]="--"; args[8]=(char *)self;
    for (int i=5;i<argc;i++) args[i+4]=argv[i];
    char *clean[]={"PATH=/usr/bin:/bin:/usr/sbin:/sbin","LANG=C.UTF-8",NULL};
    execve(args[0],args,clean);
    fail("route entry exec");
}
int main(int argc,char **argv) {
    /* Protocol: v1 MODE CONFIG SETTINGS SCRATCH ENVFD READCOUNT READROOT...
     * UPDATECOUNT UPDATEROOT... -- VENDOR_ARGS...
     * Private settings/environment contents never appear in argv. */
    if (getuid()==0 || geteuid()!=getuid() || argc<10 || (strcmp(argv[1],"v1") && strcmp(argv[1],"route-v1"))) fail("invocation");
    int route=!strcmp(argv[1],"route-v1");
    int protected=!strcmp(argv[2],"protected"), managed_validator=!strcmp(argv[2],"validate-managed");
    int validator=managed_validator || !strcmp(argv[2],"validate");
    if (!route && !protected && !validator && strcmp(argv[2],"ordinary")) fail("mode");
    char image[PATH_MAX], self[PATH_MAX], vendor[PATH_MAX]; uint32_t size=sizeof(image);
    if (_NSGetExecutablePath(image,&size) || !realpath(image,self)) fail("launcher path");
    size_t prefix=strlen(RUNTIME_ROOT);
    if (strncmp(self,RUNTIME_ROOT,prefix) || strlen(self)!=prefix+64+strlen("/launcher")) fail("launcher installation");
    for (size_t i=prefix;i<prefix+64;i++) if (!((self[i]>='a' && self[i]<='f') || (self[i]>='0' && self[i]<='9'))) fail("artifact identity");
    if (strcmp(self+prefix+64,"/launcher")) fail("launcher entry");
    immutable(self,0); chain(self);
    strlcpy(vendor,self,sizeof(vendor)); strcpy(strrchr(vendor,'/'),"/claude");
    immutable(vendor,0); if (access(vendor,X_OK)) fail("vendor execution access");
    if (route) enter_route(argc,argv,self);
    const char *config=argv[3], *settings=argv[4], *scratch=argv[5];
    canonical(config); canonical(settings); canonical(scratch);
    // Native OAuth refresh takes both its current in-config lock and a
    // legacy sibling lock. Denying the latter silently drops coordination
    // with an older owner. Grant only this exact derived path (T04/T16/T23).
    char config_lock[PATH_MAX];
    if (snprintf(config_lock,sizeof(config_lock),"%s.lock",config)>=(int)sizeof(config_lock)) fail("account lock path");
    if (protected) canonical_future(config_lock);
    int environment_fd=number(argv[6],1024), readcount=number(argv[7],MAX_ROOTS);
    int update_index=8+readcount;
    if (update_index>=argc) fail("read roots");
    int updatecount=number(argv[update_index],MAX_ROOTS), separator=update_index+1+updatecount;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("update roots");
    const char **readroots=(const char **)(argv+8), **updateroots=(const char **)(argv+update_index+1);
    struct passwd *user=getpwuid(getuid()); if (!user || !user->pw_dir) fail("caller home");
    char home[PATH_MAX]; if (!realpath(user->pw_dir,home)) fail("caller home");
    const char *managed="/Library/Application Support/ClaudeCode";
    const char *system_preferences="/Library/Managed Preferences/com.anthropic.claudecode.plist";
    char user_preferences[PATH_MAX];
    if (!user->pw_name || strchr(user->pw_name,'/') || snprintf(user_preferences,sizeof(user_preferences),
        "/Library/Managed Preferences/%s/com.anthropic.claudecode.plist",user->pw_name)>=(int)sizeof(user_preferences)) fail("managed preference path");
    if (inside(home,config) || inside(home,scratch)) fail("overbroad private root");
    for (int i=0;i<readcount;i++) {
        canonical(readroots[i]);
        if (!strcmp(readroots[i],"/") || inside(home,readroots[i])
            || (inside(config,readroots[i]) && strcmp(config,readroots[i]))) fail("overbroad read root");
    }
    for (int i=0;i<updatecount;i++) {
        canonical_future(updateroots[i]);
        if (!strcmp(updateroots[i],"/") || inside(vendor,updateroots[i]) || inside(self,updateroots[i])) fail("invalid update root");
    }
    if (validator && (inside(vendor,scratch) || inside(settings,scratch))) fail("validator input overlap");
    char *policy=NULL; size_t length=0; FILE *out=open_memstream(&policy,&length);
    if (!out) fail("policy allocation");
    fputs("(version 1)(allow default)\n",out);
    if (validator) {
        // This role has no escape/reentry exception. Its only executable child
        // is the native Keychain diagnostic, whose Mach lookup is denied.
        fputs("(deny network*)(deny mach-lookup)(deny file-read* (require-not (require-any ",out);
        rule(out,"literal",vendor); rule(out,"literal",settings); rule(out,"subpath",scratch);
        ancestors(out,vendor); ancestors(out,settings); ancestors(out,scratch);
        if (managed_validator) {
            // The snapshot-only check must stay independent of these sources.
            // Their exact native schema is checked separately after immutable
            // source and executable-policy-helper admission by trusted AIM.
            rule(out,"subpath",managed); rule(out,"literal",system_preferences); rule(out,"literal",user_preferences);
            ancestors(out,managed); ancestors(out,system_preferences); ancestors(out,user_preferences);
            for (int i=0;i<readcount;i++) { rule(out,"subpath",readroots[i]); ancestors(out,readroots[i]); }
        }
        fputs("(literal \"/private\")(literal \"/var\")(literal \"/private/var\")"
          "(literal \"/Library\")(literal \"/Library/Developer\")"
          "(literal \"/dev/null\")(literal \"/dev/random\")(literal \"/dev/urandom\")"
          "(subpath \"/System\")(subpath \"/usr\")(subpath \"/Library/Apple\")"
          "(subpath \"/private/var/db/dyld\")(subpath \"/private/preboot/Cryptexes/OS\"))))",out);
        fputs("(deny file-write* (require-not (require-any (literal \"/dev/null\")",out);
        rule(out,"subpath",scratch); fputs(")))(deny process-exec (require-not (require-any ",out);
        rule(out,"literal",vendor); fputs("(literal \"/usr/bin/security\")",out);
        if (managed_validator) fputs("(literal \"/usr/bin/plutil\")",out);
        fputs(")))",out);
    } else {
        fputs("(allow process-exec ",out); rule(out,"literal",self); fputs(" (with no-sandbox))",out);
        // Seatbelt also prevents Apple's setuid ps from starting, even with
        // allow-default. The reviewed vendor uses it for zombie/process-tree
        // and daemon-owner checks. This fixed system utility cannot execute a
        // caller-selected payload; preserve those lifecycle operations.
        fputs("(allow process-exec (literal \"/bin/ps\") (with no-sandbox))",out);
        // Explicit privileged tool commands retain their normal host authority
        // under the user's accepted privileged-tampering scope. No automatic
        // sudo execution exists in the reviewed vendor. Include explicit MCP
        // server commands: those are spawned directly by the vendor too.
        // Never give shells, interpreters or generic route helpers an escape.
        // Ordinary unprivileged tools keep all common restrictions.
        fputs("(allow process-exec (literal \"/usr/bin/sudo\") (with no-sandbox))",out);
        // Every descendant, including ordinary tools, keeps these exact
        // snapshot and updater restrictions. Tool-specific file/metadata
        // exemptions below must never exempt vendor update code.
        fputs("(deny file-write* ",out); rule(out,"literal",settings); fputs(")",out);
        // T08: denying only the leaf permits moving its parent and writing the
        // same inode through the new path, and loses the replayed --settings
        // path in background children. Pin traversal directories against
        // removal/rename while allowing normal edits to their other children.
        fputs("(deny file-write-unlink ",out); ancestors(out,settings); fputs(")",out);
        // Do not make absent machine policy look unreadable: that can make
        // the native client eligible for remote organization policy. The AIM
        // caller admits these exact sources and their replacement permissions.
        // Descendants may inspect them, but cannot introduce a later override.
        fputs("(deny file-write* ",out); rule(out,"subpath",managed);
        rule(out,"literal",system_preferences); rule(out,"literal",user_preferences); fputs(")",out);
        for (int i=0;i<updatecount;i++) {
            fputs("(deny file-read* file-write* process-exec file-map-executable ",out);
            rule(out,"subpath",updateroots[i]); fputs(")",out);
        }
        if (protected) {
            fputs("(with-filter ",out); rule(out,"process-path",vendor); fputs("\n",out);
            fputs("(deny file-read* file-write* (require-not (require-any ",out);
            rule(out,"literal",vendor); rule(out,"literal",settings); rule(out,"subpath",config); rule(out,"subpath",scratch);
            rule(out,"subpath",config_lock);
            ancestors(out,vendor); ancestors(out,settings); ancestors(out,config); ancestors(out,scratch);
            rule(out,"subpath",managed); rule(out,"literal",system_preferences); rule(out,"literal",user_preferences);
            ancestors(out,managed); ancestors(out,system_preferences); ancestors(out,user_preferences);
            for (int i=0;i<readcount;i++) { rule(out,"subpath",readroots[i]); ancestors(out,readroots[i]); }
            // getaddrinfo/lstat inspect the /etc, /var and /tmp symlinks before
            // resolving their already allowed /private targets. Literal
            // traversal preserves DNS without opening the whole var tree.
            fputs("(literal \"/etc\")(literal \"/var\")(literal \"/tmp\")(literal \"/private\")(literal \"/private/var\")"
              "(subpath \"/System\")(subpath \"/usr\")(subpath \"/bin\")(subpath \"/sbin\")"
              "(subpath \"/dev\")(subpath \"/Library/Apple\")(subpath \"/Library/Developer\")"
              "(subpath \"/private/etc\")(subpath \"/private/var/db/dyld\")"
              "(subpath \"/private/preboot/Cryptexes/OS\")(literal \"/private/var/select/developer_dir\"))))",out);
            fputs("(deny iokit-get-properties (iokit-property \"IOPlatformUUID\")(iokit-property \"IOPlatformSerialNumber\"))"
              "(deny sysctl-read (sysctl-name \"kern.hostname\")(sysctl-name \"kern.osproductversion\")"
              "(sysctl-name \"kern.osrelease\")(sysctl-name \"kern.osversion\")(sysctl-name \"kern.version\")(sysctl-name \"hw.model\"))"
              "(deny file-read* (literal \"/System/Library/CoreServices/SystemVersion.plist\"))"
              "(deny syscall-unix (syscall-number SYS_gethostuuid))"
              "(deny syscall-mig (kernel-mig-routine host_kernel_version))"
              "(deny process-exec (literal \"/usr/bin/sw_vers\")))",out);
        }
    }
    if (fclose(out) || !policy || length>1024*1024) fail("policy generation");
    char *error=NULL;
    if (sandbox_init_with_parameters(policy,0,NULL,&error)) fail("policy application");
    free(policy);
    restore_environment(environment_fd);
    if (validator) {
        // Doctor must never receive provider or user credentials, even if a
        // later caller mistakenly reuses a normal launch environment.
        environ=calloc(1,sizeof(char *)); if (!environ) fail("validator environment");
        set_environment("PATH","/usr/bin:/bin:/usr/sbin:/sbin",1);
        set_environment("TERM","dumb",1); set_environment("LANG","C.UTF-8",1); set_environment("NO_COLOR","1",1);
        set_environment("HOME",scratch,1); set_environment("CLAUDE_CODE_TMPDIR",scratch,1); set_environment("TMPDIR",scratch,1);
    }
    set_environment("CLAUDE_CONFIG_DIR",validator?scratch:config,1);
    set_environment("CLAUDE_SECURESTORAGE_CONFIG_DIR",validator?scratch:config,1);
    set_environment("DISABLE_AUTOUPDATER","1",1); set_environment("DISABLE_UPDATES","1",1); set_environment("DISABLE_GROWTHBOOK","1",1);
    /* Detached supervisors can own later requests using their earlier image and
     * settings. Supply the narrow early default before vendor startup. Shared
     * argument admission and the settings snapshot keep supported AIM paths
     * disabled; this env pin alone does not override hostile disk settings. Ordinary background
     * Bash/subagents stay available; never use DISABLE_BACKGROUND_TASKS here. */
    set_environment("CLAUDE_CODE_DISABLE_AGENT_VIEW","1",1);
    if (protected || validator) { set_environment("DISABLE_TELEMETRY","1",1); set_environment("DISABLE_ERROR_REPORTING","1",1); }
    // Keep stdio; the trusted supervisor retains its IPC/assignment handles.
    close_inherited_descriptors();
    if (validator) {
        char *args[]={vendor,"--settings",(char *)settings,"doctor",NULL};
        execv(vendor,args);
    } else {
        argv[separator]=vendor;
        execv(vendor,argv+separator);
    }
    fail("approved vendor exec");
}
