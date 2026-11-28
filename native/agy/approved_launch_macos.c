/* Immutable, hardened-runtime entry for the approved macOS Antigravity CLI. */
#define VENDOR_NAME "Antigravity"
#define RUNTIME "/opt/aimgr-agy-runtime"
#define ARTIFACTS RUNTIME "/artifacts/"
#include "../privacy/launch_macos.h"
#include "credential-boundary.h"

static int random_suffix(const char *suffix) {
    return strlen(suffix)==6 && strspn(suffix,"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")==6;
}

static void owned_directory(const char *path,int private_mode) {
    canonical(path);
    int fd=open(path,O_RDONLY|O_NOFOLLOW|O_DIRECTORY|O_CLOEXEC);
    struct stat st;
    if (fd<0 || fstat(fd,&st) || st.st_uid!=getuid() ||
        (private_mode ? (st.st_mode&07777)!=0700 : (st.st_mode&022)!=0)) fail("private directory ownership or mode");
    if (private_mode) {
        errno=0;
        acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
        if (acl ? acl_valid(acl)!=0 : errno!=ENOENT) fail("private directory ACL unreadable");
        if (acl) {
            acl_entry_t entry;
            int index=ACL_FIRST_ENTRY;
            while (acl_get_entry(acl,index,&entry)==0) {
                acl_tag_t tag;
                if (acl_get_tag_type(entry,&tag) || tag!=ACL_EXTENDED_DENY) fail("private directory ACL");
                index=ACL_NEXT_ENTRY;
            }
            acl_free(acl);
        }
    }
    close(fd);
}

static void account_directory(const char *account,const char *state,int login) {
    owned_directory(state,1);
    owned_directory(account,1);
    if (!inside(account,state) || !strcmp(account,state)) fail("account home location");
    const char *label=account+strlen(state)+1;
    const char *slash=strchr(label,'/');
    if (!slash || strcmp(slash,"/home") || slash==label || slash-label>64) fail("account home location");
    char leaf[65];
    strlcpy(leaf,label,(size_t)(slash-label)+1);
    if (login) {
        if (strncmp(leaf,".login-",7) || !random_suffix(leaf+7)) fail("login home location");
    } else if (!strchr("0123456789abcdefghijklmnopqrstuvwxyz",leaf[0]) ||
               leaf[strspn(leaf,"0123456789abcdefghijklmnopqrstuvwxyz_-")]) fail("account label");
    char connection[PATH_MAX];
    strlcpy(connection,account,(size_t)(slash-account)+1);
    owned_directory(connection,1);
}

static void private_scratch(const char *scratch) {
    static const char prefix[]="/private/tmp/aim-agy-";
    struct stat parent;
    if (lstat("/private/tmp",&parent) || !S_ISDIR(parent.st_mode) || parent.st_uid!=0 || !(parent.st_mode&S_ISVTX))
        fail("system temporary directory");
    if (strncmp(scratch,prefix,sizeof(prefix)-1) || !random_suffix(scratch+sizeof(prefix)-1)) fail("private temporary path");
    owned_directory(scratch,1);
}

static void work_path(const char *path,const char *home,const char *aimgr) {
    canonical_future(path);
    if (inside(home,path) || inside(aimgr,path) || inside(path,aimgr)) fail("overbroad working path");
    const char *system[]={"/System","/Library","/usr","/bin","/sbin","/dev","/private/etc",
        "/private/var/root","/private/var/db","/private/var/run","/private/preboot",RUNTIME,NULL};
    for (int i=0;system[i];i++) if (inside(path,system[i]) || inside(system[i],path)) fail("system working path");
}

static int admit_arguments(int fixed_operation,char **args) {
    if (fixed_operation && *args) fail("unexpected operation arguments");
    int print=0,slash_disabled=0;
    const char *values[]={"--print=","--model=","--effort=","--mode=","--output-format=","--print-timeout=",NULL};
    for (;*args;args++) {
        if (!strcmp(*args,"--disable-slash-commands")) {
            slash_disabled=1;
            continue;
        }
        int allowed=0;
        for (int i=0;values[i];i++) {
            size_t length=strlen(values[i]);
            if (!strncmp(*args,values[i],length) && (*args)[length]) allowed=1;
        }
        if (!allowed) fail("unsupported Antigravity argument");
        if (!strncmp(*args,"--print=",8)) print=1;
    }
    if (!fixed_operation && !print) fail("run requires print mode");
    return slash_disabled;
}

static const char *staged_value(const char *key) {
    size_t length=strlen(key);
    const char *value=NULL;
    for (char **entry=environ;*entry;entry++) {
        if (strncmp(*entry,key,length) || (*entry)[length]!='=') continue;
        if (value) fail("duplicate environment entry");
        value=*entry+length+1;
    }
    return value;
}

static int proxy_port(const char **endpoint) {
    const char *https=staged_value("HTTPS_PROXY"),*http=staged_value("HTTP_PROXY"),*all=staged_value("ALL_PROXY");
    if (!https && !http && !all) return 0;
    const char *no_proxy=staged_value("NO_PROXY");
    static const char prefix[]="socks5h://127.0.0.1:";
    if (!https || !http || !all || strcmp(https,http) || strcmp(https,all) ||
        (no_proxy && *no_proxy) || strncmp(https,prefix,sizeof(prefix)-1)) fail("assigned IPv4 SOCKS proxy");
    const char *port=https+sizeof(prefix)-1;
    if (!*port || port[strspn(port,"0123456789")]) fail("assigned proxy port");
    int value=number(port,65535);
    if (!value || value==53) fail("assigned proxy port");
    *endpoint=https;
    return value;
}

static void install_environment(const char *account,const char *scratch,const char *proxy) {
    const char *names[]={"TERM","COLORTERM","LANG","LC_ALL","LC_CTYPE","NO_COLOR",NULL};
    const char *values[sizeof(names)/sizeof(*names)]={0};
    for (int i=0;names[i];i++) values[i]=staged_value(names[i]);
    environ=calloc(1,sizeof(char *));
    if (!environ) fail("environment allocation");
    for (int i=0;names[i];i++) if (values[i]) set_environment(names[i],values[i],1);
    set_environment("PATH","/usr/bin:/bin",1);
    set_environment("HOME",account,1);
    set_environment("TMPDIR",scratch,1);
    set_environment("BROWSER","/usr/bin/true",1);
    set_environment("SSH_CONNECTION","127.0.0.1 49152 127.0.0.1 22",1);
    set_environment("AGY_CLI_DISABLE_AUTO_UPDATE","true",1);
    if (proxy) {
        set_environment("HTTPS_PROXY",proxy,1);
        set_environment("HTTP_PROXY",proxy,1);
        set_environment("ALL_PROXY",proxy,1);
        set_environment("NO_PROXY","",1);
    }
}

static void write_only_terminal_outputs(void) {
    // A readable TTY descriptor would let a headless provider collect input.
    for (int fd=STDOUT_FILENO;fd<=STDERR_FILENO;fd++) {
        int flags=fcntl(fd,F_GETFL);
        if (flags<0 || (flags&O_ACCMODE)!=O_RDWR || !isatty(fd)) continue;
        char path[PATH_MAX];
        if (ttyname_r(fd,path,sizeof(path))) fail("terminal output path");
        int output=open(path,O_WRONLY|O_NOCTTY|O_CLOEXEC|(flags&O_NONBLOCK));
        if (output<0 || dup2(output,fd)<0) fail("terminal output access");
        close(output);
    }
}

static int stock_hosts(void) {
    // The CLI resolves localhost at startup. Permit the standard table only,
    // including its stock comments, so a customized file cannot supply a name.
    static const char stock[]="##\n# Host Database\n#\n# localhost is used to configure the loopback interface\n"
        "# when the system is booting.  Do not change this entry.\n##\n"
        "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n";
    char found[sizeof(stock)];
    int fd=open("/private/etc/hosts",O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
    if (fd<0) return 0;
    ssize_t length=read(fd,found,sizeof(found));
    close(fd);
    if (length!=(ssize_t)(sizeof(stock)-1) || memcmp(found,stock,sizeof(stock)-1)) return 0;
    immutable("/private/etc/hosts",0);
    return 1;
}

static void related_home(FILE *out,const char *home,const char *suffix,const char *filter) {
    char path[PATH_MAX];
    if (snprintf(path,sizeof(path),"%s/%s",home,suffix)>=(int)sizeof(path)) fail("protected home path");
    rule(out,filter,path);
}

static void runtime_reads(FILE *out,const char *vendor,const char *account,const char *scratch,
                          const char *workspace,char **roots,int count,int hosts,int direct) {
    rule(out,"literal",vendor);
    rule(out,"subpath",account);
    rule(out,"subpath",scratch);
    rule(out,"subpath",workspace);
    for (int i=0;i<count;i++) rule(out,"subpath",roots[i]);
    fputs("(literal \"/\")(literal \"/dev/null\")(literal \"/dev/random\")(literal \"/dev/urandom\")"
          "(subpath \"/System/Library\")(subpath \"/usr/bin\")(subpath \"/usr/lib\")(subpath \"/usr/libexec\")"
          "(subpath \"/usr/share\")(subpath \"/bin\")(subpath \"/sbin\")(subpath \"/Library/Apple\")"
          "(subpath \"/private/var/db/dyld\")(subpath \"/private/preboot/Cryptexes/OS\")",out);
    if (hosts) fputs("(literal \"/private/etc/hosts\")(literal \"/etc/hosts\")",out);
    if (direct) fputs("(literal \"/etc/resolv.conf\")(literal \"/private/etc/resolv.conf\")"
        "(literal \"/private/var/run/resolv.conf\")",out);
}

static void apply_policy(const char *self,const char *vendor,const char *home,const char *aimgr,
                         const char *account,const char *workspace,const char *scratch,
                         char **roots,int count,int port,int login) {
    char *policy=NULL;
    size_t size=0;
    FILE *out=open_memstream(&policy,&size);
    if (!out) fail("policy allocation");
    fputs("(version 1)(allow default)\n(deny network*)\n"
          "(deny mach-lookup)(allow mach-lookup (global-name \"com.apple.trustd.agent\"))\n"
          "(deny job-creation)(deny appleevent-send)(deny mach-register)\n"
          "(deny system-socket (socket-domain AF_ROUTE)(socket-domain AF_SYSTEM))\n",out);
    if (port) {
        fprintf(out,"(allow network-outbound (remote tcp4 \"localhost:%d\"))\n",port);
    } else {
        // macOS libc resolves ordinary DNS through this Unix socket. Assigned
        // SOCKS routes resolve names at the proxy and never use the service.
        fputs("(allow network-outbound (remote tcp)(remote udp \"*:53\"))\n"
              "(deny network-outbound (remote ip \"localhost:*\"))\n"
              "(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n",out);
    }

    // Children retain their normal filesystem access outside AIM state and
    // credential/IDE paths. They inherit the assigned socket policy and cannot
    // start the protected vendor again to recover its account-home authority.
    fputs("(deny process-exec ",out);
    rule(out,"subpath",RUNTIME);
    rule(out,"subpath",account);
    rule(out,"subpath",scratch);
    fputs(")(with-filter (require-any ",out);
    rule(out,"process-path",self);
    rule(out,"process-path",vendor);
    fputs(") (allow process-exec ",out);
    rule(out,"literal",vendor);
    fputs("))\n(deny file-read* file-write* (require-all ",out);
    rule(out,"subpath",aimgr);
    fputs(" (require-not ",out);
    rule(out,"subpath",account);
    fputs(")))\n(with-filter (require-not ",out);
    rule(out,"process-path",vendor);
    fputs(") (deny file-read* file-write* ",out);
    rule(out,"subpath",account);
    fputs("))\n(deny file-read* file-write* ",out);
    for (size_t i=0;i<sizeof(host_credential_paths)/sizeof(*host_credential_paths);i++)
        related_home(out,home,host_credential_paths[i],"subpath");
    related_home(out,home,"Library/Keychains","subpath");
    related_home(out,home,"Library/Application Support/Antigravity","subpath");
    related_home(out,home,"Library/Application Support/Google/Antigravity","subpath");
    fputs("(subpath \"/Library/Keychains\")(subpath \"/private/var/Keychains\")"
          "(regex #\"/\\.gemini/antigravity-ide(/|$)\"))\n(deny file-write-unlink ",out);
    // Keep credential-bearing subtrees attached to their protected parents.
    rule(out,"literal",home);
    related_home(out,home,".config","literal");
    related_home(out,home,"Library","literal");
    related_home(out,home,"Library/Application Support","literal");
    related_home(out,home,"Library/Application Support/Google","literal");
    fputs(")\n"
          "(deny iokit-get-properties (iokit-property \"IOPlatformUUID\")(iokit-property \"IOPlatformSerialNumber\")"
          "(iokit-property \"serial-number\")(iokit-property \"mlb-serial-number\"))\n"
          "(deny sysctl-read (sysctl-name \"kern.hostname\")(sysctl-name \"kern.uuid\")(sysctl-name \"kern.bootsessionuuid\")"
          "(sysctl-name \"kern.osproductversion\")(sysctl-name \"kern.osrelease\")(sysctl-name \"kern.osversion\")"
          "(sysctl-name \"kern.version\")(sysctl-name \"hw.model\")(sysctl-name \"hw.targettype\")"
          "(sysctl-name-prefix \"net.route\"))\n"
          "(deny syscall-unix (syscall-number SYS_gethostuuid))\n"
          "(deny syscall-mig (kernel-mig-routine host_kernel_version))\n",out);
    if (!login) fputs("(deny file-read-data (literal \"/dev/tty\")(regex #\"^/dev/tty(s|p)\"))\n",out);

    fputs("(with-filter ",out);
    rule(out,"process-path",vendor);
    fputs("\n(allow network-bind network-inbound (local tcp \"localhost:*\"))\n"
          "(deny iokit-open)(deny ipc-posix*)\n(deny process-info* (require-not (target self)))\n"
          "(deny file-read* (require-not (require-any ",out);
    runtime_reads(out,vendor,account,scratch,workspace,roots,count,stock_hosts(),!port);
    if (login) fputs("(literal \"/dev/tty\")(regex #\"^/dev/ttys[0-9]+$\")",out);
    fputs(")))\n(allow file-read-metadata ",out);
    ancestors(out,vendor);
    ancestors(out,account);
    ancestors(out,scratch);
    ancestors(out,workspace);
    for (int i=0;i<count;i++) ancestors(out,roots[i]);
    fputs("(literal \"/etc\")(literal \"/private/etc\")(literal \"/private\")(literal \"/private/var\")"
          "(literal \"/private/var/run\")(literal \"/var\")(literal \"/tmp\")(literal \"/dev\")"
          "(literal \"/System\")(literal \"/usr\"))\n"
          "(deny file-write* (require-not (require-any (literal \"/dev/null\")",out);
    if (login) fputs("(literal \"/dev/tty\")(regex #\"^/dev/ttys[0-9]+$\")",out);
    rule(out,"subpath",account);
    rule(out,"subpath",scratch);
    rule(out,"subpath",workspace);
    for (int i=0;i<count;i++) rule(out,"subpath",roots[i]);
    fputs(")))\n(deny file-read* file-write* (literal \"/System/Library/CoreServices/SystemVersion.plist\")",out);
    const char *protected[]={"Library",".config",".claude",".codex",".google",".ssh",".gnupg",".aws",".azure",
        ".kube",".docker",".netrc",".git-credentials",".npmrc",NULL};
    for (int i=0;protected[i];i++) related_home(out,home,protected[i],"subpath");
    fputs("))\n",out);
    if (fclose(out) || !policy || size>1024*1024) fail("policy generation");
    char *error=NULL;
    if (sandbox_init_with_parameters(policy,0,NULL,&error)) fail("policy application");
    free(policy);
}

int main(int argc,char **argv) {
    // v1 OP ACCOUNT_HOME WORKSPACE SCRATCH ENVFD ROOT_COUNT ROOT... -- AGY_ARGS...
    if (!getuid() || getuid()!=geteuid() || argc<9 || strcmp(argv[1],"v1")) fail("invocation");
    int login=!strcmp(argv[2],"login");
    int acp=!strcmp(argv[2],"resume") || !strcmp(argv[2],"logout");
    int run=!strcmp(argv[2],"run"),credits=!strcmp(argv[2],"credits");
    int diagnostic=credits || !strcmp(argv[2],"usage");
    if (!login && !acp && !run && !diagnostic) fail("operation");
    int count=number(argv[7],MAX_ROOTS),separator=8+count;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("working roots");
    if (diagnostic && (count || strcmp(argv[4],argv[5]))) fail("quota command requires private scratch workspace");
    int slash_disabled=admit_arguments(!run,argv+separator+1);

    char image[PATH_MAX],self[PATH_MAX],vendor[PATH_MAX];
    uint32_t size=sizeof(image);
    if (_NSGetExecutablePath(image,&size) || !realpath(image,self)) fail("launcher path");
    size_t prefix=strlen(ARTIFACTS);
    if (strncmp(self,ARTIFACTS,prefix) || strlen(self)!=prefix+64+strlen("/launcher") ||
        strspn(self+prefix,"0123456789abcdef")!=64 || strcmp(self+prefix+64,"/launcher")) fail("launcher installation");
    immutable(self,0);
    chain(self);
    snprintf(vendor,sizeof(vendor),"%.*s/agy",(int)(prefix+64),self);
    immutable(vendor,0);
    struct stat vendor_info;
    if (stat(vendor,&vendor_info) || (vendor_info.st_mode&(S_ISUID|S_ISGID)) || access(vendor,X_OK)) fail("vendor execution access");

    struct passwd *user=getpwuid(getuid());
    char home[PATH_MAX],aimgr[PATH_MAX],state[PATH_MAX];
    if (!user || !realpath(user->pw_dir,home) || !strcmp(home,"/") ||
        snprintf(aimgr,sizeof(aimgr),"%s/.aimgr",home)>=(int)sizeof(aimgr) ||
        snprintf(state,sizeof(state),"%s/agy",aimgr)>=(int)sizeof(state)) fail("caller home");
    const char *account=argv[3],*workspace=argv[4],*scratch=argv[5];
    owned_directory(home,0);
    owned_directory(aimgr,0);
    account_directory(account,state,login);
    private_scratch(scratch);
    canonical(workspace);
    work_path(workspace,home,aimgr);
    for (int i=0;i<count;i++) work_path(argv[8+i],home,aimgr);

    restore_environment(number(argv[6],1024));
    const char *proxy=NULL;
    int port=proxy_port(&proxy);
    install_environment(account,scratch,proxy);
    close_inherited_descriptors();
    if (!login) write_only_terminal_outputs();
    if (run || diagnostic) {
        int input=open("/dev/null",O_RDONLY);
        if (input<0 || (input!=STDIN_FILENO && dup2(input,STDIN_FILENO)<0)) fail("headless input closure");
        if (input!=STDIN_FILENO) close(input);
    }
    if (chdir(workspace)) fail("workspace entry");
    apply_policy(self,vendor,home,aimgr,account,workspace,scratch,argv+8,count,port,login);

    char *acp_args[]={vendor,"acp","--disable-telemetry",NULL};
    char *login_args[]={vendor,"acp","--login","--disable-telemetry",NULL};
    char *diagnostic_args[]={vendor,credits ? "--print=/credits" : "--print=/usage","--output-format=json",
        "--print-timeout=10s","--settings={\"disableSlashCommands\":false,\"useG1Credits\":false}",NULL};
    argv[separator]=vendor;
    char **native_args=login ? login_args : acp ? acp_args : diagnostic ? diagnostic_args : argv+separator;
    if (run && !slash_disabled) {
        size_t native_count=(size_t)(argc-separator);
        native_args=calloc(native_count+2,sizeof(*native_args));
        if (!native_args) fail("native arguments allocation");
        memcpy(native_args,argv+separator,native_count*sizeof(*native_args));
        native_args[native_count]="--disable-slash-commands";
    }
    execv(vendor,native_args);
    fail("approved vendor exec");
}
