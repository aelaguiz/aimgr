/* Root-owned setuid entry for the approved Linux Antigravity artifact. */
#define VENDOR_NAME "Antigravity"
#define RUNTIME "/opt/aimgr-agy-runtime"
#define APPARMOR_SKIP_EXPR_NORMALIZE 1
static void install_uname(void) __attribute__((unused));
static void unset_environment(const char *) __attribute__((unused));
#include "../privacy/launch_linux.h"
#include "../privacy/profile_gc_linux.h"
#include "credential-boundary.h"
#include <sched.h>
#include <sys/mount.h>

static int alphanumeric(const char *value) {
    return value[strspn(value,"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")]==0;
}

static void owned_directory(const char *path,int private_mode) {
    struct stat st;
    canonical(path);
    if (lstat(path,&st) || !S_ISDIR(st.st_mode) || st.st_uid!=caller ||
        (private_mode ? (st.st_mode&07777)!=0700 : (st.st_mode&022)!=0))
        fail("private directory ownership or mode");
}

static void private_scratch(const char *scratch) {
    static const char prefix[]="/tmp/aim-agy-";
    struct stat parent;
    if (lstat("/tmp",&parent) || !S_ISDIR(parent.st_mode) || parent.st_uid!=0 || !(parent.st_mode&S_ISVTX))
        fail("system temporary directory");
    if (strncmp(scratch,prefix,sizeof(prefix)-1) || strlen(scratch)!=sizeof(prefix)-1+6 ||
        !alphanumeric(scratch+sizeof(prefix)-1)) fail("private temporary path");
    owned_directory(scratch,1);
}

static void account_directory(const char *account,const char *state,int login) {
    owned_directory(state,1);
    owned_directory(account,1);
    if (!inside(account,state) || !strcmp(account,state)) fail("account home location");
    const char *label=account+strlen(state)+1;
    const char *slash=strchr(label,'/');
    if (!slash || strcmp(slash,"/home") || slash==label || slash-label>64) fail("account home location");
    char leaf[65];
    memcpy(leaf,label,(size_t)(slash-label));
    leaf[slash-label]=0;
    if (login) {
        if (strncmp(leaf,".login-",7) || strlen(leaf)!=13 || !alphanumeric(leaf+7)) fail("login home location");
    } else if (!strchr("0123456789abcdefghijklmnopqrstuvwxyz",leaf[0]) ||
               leaf[strspn(leaf,"0123456789abcdefghijklmnopqrstuvwxyz_-")]) fail("account label");
    char connection[PATH_MAX];
    snprintf(connection,sizeof(connection),"%.*s",(int)(slash-account),account);
    owned_directory(connection,1);
}

static void work_path(const char *file,const char *home,const char *aimgr) {
    canonical_future(file);
    if (inside(home,file) || inside(aimgr,file) || inside(file,aimgr)) fail("overbroad working path");
    const char *system[]={"/etc","/run","/proc","/sys","/dev","/usr","/bin","/sbin","/lib","/lib64",
        "/root","/var/lib",RUNTIME};
    for (size_t i=0;i<sizeof(system)/sizeof(*system);i++)
        if (inside(file,system[i]) || inside(system[i],file)) fail("system working path");
}

static int admit_arguments(int fixed_operation,char **args,int *slash_disabled) {
    if (fixed_operation && *args) fail("unexpected operation arguments");
    int headless=0;
    const char *values[]={"--print=","--model=","--effort=","--mode=","--output-format=","--print-timeout="};
    for (;*args;args++) {
        if (!strcmp(*args,"--disable-slash-commands")) {
            *slash_disabled=1;
            continue;
        }
        int allowed=0;
        for (size_t i=0;i<sizeof(values)/sizeof(*values);i++) {
            size_t length=strlen(values[i]);
            if (!strncmp(*args,values[i],length) && (*args)[length]) allowed=1;
        }
        if (!allowed) fail("unsupported Antigravity argument");
        if (!strncmp(*args,"--print=",8)) headless=1;
    }
    return headless;
}

static const char *staged_value(char **input,const char *key) {
    size_t length=strlen(key);
    for (;*input;input++)
        if (!strncmp(*input,key,length) && (*input)[length]=='=') return *input+length+1;
    return NULL;
}

static const char *proxy_endpoint(char **input) {
    const char *proxy=staged_value(input,"HTTPS_PROXY"),*http=staged_value(input,"HTTP_PROXY"),
        *all=staged_value(input,"ALL_PROXY"),*port;
    if (!proxy && !http && !all) return NULL;
    if (!proxy || !http || !all || strcmp(proxy,http) || strcmp(proxy,all)) fail("assigned proxy environment");
    if (!strncmp(proxy,"socks5h://127.0.0.1:",20)) port=proxy+20;
    else if (!strncmp(proxy,"socks5h://[::1]:",16)) port=proxy+16;
    else fail("assigned proxy endpoint");
    if (!*port || port[strspn(port,"0123456789")] || !number(port,65535)) fail("assigned proxy port");
    return proxy;
}

static void install_environment(char **input,const char *account,const char *proxy) {
    if (clearenv()) fail("environment reset");
    const char *terminal[]={"TERM","COLORTERM","LANG","LC_ALL","LC_CTYPE","NO_COLOR"};
    for (size_t i=0;i<sizeof(terminal)/sizeof(*terminal);i++) {
        const char *value=staged_value(input,terminal[i]);
        if (value) set_environment(terminal[i],value,1);
    }
    set_environment("PATH","/usr/bin:/bin",1);
    set_environment("HOME",account,1);
    set_environment("BROWSER","/usr/bin/true",1);
    set_environment("SSH_CONNECTION","127.0.0.1 49152 127.0.0.1 22",1);
    set_environment("AGY_CLI_DISABLE_AUTO_UPDATE","true",1);
    // An explicit unavailable transport keeps libdbus from autolaunching or
    // discovering the host session. The vendor also has no D-Bus policy grant.
    set_environment("DBUS_SESSION_BUS_ADDRESS","unix:path=/dev/null",1);
    set_environment("DBUS_SYSTEM_BUS_ADDRESS","unix:path=/dev/null",1);
    set_environment("NO_PROXY","",1);
    if (proxy) {
        set_environment("HTTPS_PROXY",proxy,1);
        set_environment("HTTP_PROXY",proxy,1);
        set_environment("ALL_PROXY",proxy,1);
    }
}

static void deny_subtree(FILE *out,const char *path,const char *rights) {
    char *rules=NULL;
    size_t size=0;
    FILE *buffer=open_memstream(&rules,&size);
    if (!buffer) fail("denial policy allocation");
    subtree(buffer,path,rights);
    if (fclose(buffer)) fail("denial policy allocation");
    char *save=NULL;
    for (char *rule=strtok_r(rules,"\n",&save);rule;rule=strtok_r(NULL,"\n",&save)) fprintf(out,"deny %s\n",rule);
    free(rules);
}

static void deny_other_artifacts(FILE *out,const char *bundle) {
    fputs("deny \"" ARTIFACTS "{",out);
    for (size_t i=0;bundle[i];i++) {
        if (i) fprintf(out,",%.*s,",(int)i,bundle);
        fprintf(out,"%.*s[^/%c]*",(int)i,bundle,bundle[i]);
    }
    fprintf(out,",%s?*}{,/**}\" x,\n",bundle);
}

static void deny_directory_writes(FILE *out,const char *directory) {
    fputs("deny ",out);
    literal(out,directory);
    fputs(" w,\n",out);
    char path[PATH_MAX];
    if (snprintf(path,sizeof(path),"%s/",directory)>=(int)sizeof(path)) fail("protected directory path");
    fputs("deny ",out);
    literal(out,path);
    fputs(" w,\n",out);
}

static void common_rules(FILE *out,const char *home,const char *account,const char *scratch,const char *bundle) {
    deny_other_artifacts(out,bundle);
    // The ordinary /tmp work grant must never expose desktop state or socket
    // fallbacks. Writable Antigravity state cannot become a vendor executable.
    fputs("deny /**/.gemini/antigravity-ide{,/**} rwmlkx,\n"
          "deny /**/.config/{Antigravity,antigravity,antigravity-ide}{,/**} rwmlkx,\n"
          "deny /**/.local/share/keyrings{,/**} rwmlkx,\n"
          "deny /{run,var/run}/user/*/keyring{,/**} rwmlkx,\n"
          "deny /{tmp,var/tmp}/{,**/}{dbus-*,keyring,antigravity-*.sock}{,/**} rwmlkx,\n"
          "deny /**/antigravity x,\n"
          "deny /{tmp,var/tmp,home,usr}/{,**/}agy x,\n"
          "deny /{run,var/run}/{systemd/resolve/io.systemd.Resolve*,nscd/socket} rwmlkx,\n"
          "deny " ARTIFACTS "*/launcher x,\n",out);
    if (!inside(account,"/tmp") && !inside(account,"/var/tmp"))
        fputs("deny /{tmp,var/tmp}/{,**/}.gemini/antigravity-cli{,/**} rwmlkx,\n",out);
    char path[PATH_MAX];
    for (size_t i=0;i<sizeof(host_credential_paths)/sizeof(*host_credential_paths);i++) {
        if (snprintf(path,sizeof(path),"%s/%s",home,host_credential_paths[i])>=(int)sizeof(path)) fail("host state path");
        deny_subtree(out,path,"rwmlkx");
    }
    // Pin the host directories themselves without denying ordinary files in them.
    deny_directory_writes(out,home);
    if (snprintf(path,sizeof(path),"%s/.config",home)>=(int)sizeof(path)) fail("host state path");
    deny_directory_writes(out,path);
    deny_subtree(out,account,"x");
    deny_subtree(out,scratch,"x");
}

static void routed_rules(FILE *out) {
    // Preserve the inherited socket route for ordinary unprivileged children.
    fputs("deny capability net_raw,\ndeny capability net_admin,\ndeny userns,\n",out);
}

static void isolate_hostname(void) {
    if (unshare(CLONE_NEWUTS|CLONE_NEWNS) || sethostname("aim-agy",strlen("aim-agy")) ||
        setdomainname("local",strlen("local")) || mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL))
        fail("private hostname namespace");
    // Native name resolution reads /etc/hosts. Use a private loopback table
    // so this read cannot disclose hostnames stored in the host's real file.
    static const char hosts[]="127.0.0.1 localhost aim-agy\n::1 localhost ip6-localhost\n";
    struct stat target;
    if (lstat("/etc/hosts",&target) || !S_ISREG(target.st_mode) || target.st_uid!=0 || (target.st_mode&022))
        fail("system hosts path");
    char source[]=RUNTIME "/.hosts-XXXXXX";
    int fd=mkostemp(source,O_CLOEXEC);
    if (fd<0) fail("private hosts table");
    int ready=write(fd,hosts,sizeof(hosts)-1)==(ssize_t)sizeof(hosts)-1 && !fchmod(fd,0444);
    if (close(fd)) ready=0;
    int mounted=ready && !mount(source,"/etc/hosts",NULL,MS_BIND,NULL);
    if (unlink(source) || !mounted) fail("private hosts table mount");
}

static void close_run_input(void) {
    int input=open("/dev/null",O_RDONLY);
    if (input<0 || (input!=STDIN_FILENO && dup2(input,STDIN_FILENO)<0)) fail("headless input closure");
    if (input!=STDIN_FILENO) close(input);
}

static void write_only_terminal_outputs(void) {
    // A PTY inherited on stdout or stderr can itself be readable. Reopen the
    // same terminal for output so non-login entry points cannot read it.
    for (int fd=STDOUT_FILENO;fd<=STDERR_FILENO;fd++) {
        int flags=fcntl(fd,F_GETFL);
        if (flags<0 || (flags&O_ACCMODE)!=O_RDWR || !isatty(fd)) continue;
        char path[32];
        snprintf(path,sizeof(path),"/proc/self/fd/%d",fd);
        int output=open(path,O_WRONLY|O_NOCTTY|O_CLOEXEC|(flags&O_NONBLOCK));
        if (output<0 || dup2(output,fd)<0) fail("terminal output access");
        close(output);
    }
}

int main(int argc,char **argv) {
    // v1 OP ACCOUNT_HOME WORKSPACE SCRATCH ENVFD ROOT_COUNT ROOT... -- AGY_ARGS...
    caller=getuid();
    caller_group=getgid();
    if (!caller || !caller_group || geteuid()!=0 || argc<9 || strcmp(argv[1],"v1")) fail("invocation");
    int login=!strcmp(argv[2],"login");
    int acp=!strcmp(argv[2],"resume") || !strcmp(argv[2],"logout");
    int run=!strcmp(argv[2],"run"),credits=!strcmp(argv[2],"credits");
    int diagnostic=credits || !strcmp(argv[2],"usage");
    if (!login && !acp && !run && !diagnostic) fail("operation");
    int root_count=number(argv[7],MAX_ROOTS),separator=8+root_count;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("working roots");
    if (diagnostic && (root_count || strcmp(argv[4],argv[5]))) fail("quota command requires private scratch workspace");
    int slash_disabled=0;
    int headless=admit_arguments(!run,argv+separator+1,&slash_disabled);
    if (run && !headless) fail("run requires print mode");

    char self[PATH_MAX],vendor[PATH_MAX],bundle[65];
    ssize_t length=readlink("/proc/self/exe",self,sizeof(self)-1);
    if (length<0 || length>=(ssize_t)sizeof(self)-1) fail("launcher path");
    self[length]=0;
    size_t prefix=strlen(ARTIFACTS);
    if (strncmp(self,ARTIFACTS,prefix) || length!=(ssize_t)(prefix+64+strlen("/launcher")) ||
        strcmp(self+prefix+64,"/launcher") || strspn(self+prefix,"0123456789abcdef")!=64) fail("launcher installation");
    memcpy(bundle,self+prefix,64);
    bundle[64]=0;
    immutable(self,0);
    chain(self);
    snprintf(vendor,sizeof(vendor),"%.*s/agy",(int)(prefix+64),self);
    immutable(vendor,0);
    struct stat vendor_info;
    if (stat(vendor,&vendor_info) || (vendor_info.st_mode&(S_ISUID|S_ISGID))) fail("privileged vendor image");
    immutable("/usr/sbin/apparmor_parser",0);
    chain("/usr/sbin/apparmor_parser");

    struct passwd *user=getpwuid(caller);
    char home[PATH_MAX],state[PATH_MAX],aimgr[PATH_MAX];
    if (!user || !realpath(user->pw_dir,home) || !strcmp(home,"/") ||
        snprintf(state,sizeof(state),"%s/.aimgr/agy",home)>=(int)sizeof(state)) fail("caller home");
    snprintf(aimgr,sizeof(aimgr),"%.*s",(int)strlen(state)-4,state);
    owned_directory(home,0);
    owned_directory(aimgr,0);
    const char *account=argv[3],*workspace=argv[4],*scratch=argv[5];
    account_directory(account,state,login);
    private_scratch(scratch);
    canonical(workspace);
    work_path(workspace,home,aimgr);
    for (int i=8;i<separator;i++) work_path(argv[i],home,aimgr);
    char **environment=read_environment(number(argv[6],1024));
    const char *proxy=proxy_endpoint(environment);
    close_handles();
    if (!login) write_only_terminal_outputs();

    require_enforcement();
    trusted_launcher_namespaces();
    isolate_hostname();
    unsigned char nonce[16];
    char hex[33];
    if (getentropy(nonce,sizeof(nonce))) fail("policy identity");
    for (size_t i=0;i<sizeof(nonce);i++) snprintf(hex+2*i,3,"%02x",nonce[i]);
    unsigned long long pid_namespace=profile_pid_namespace();
    if (pid_namespace) snprintf(profile,sizeof(profile),"aim-agy-p-%u-n%llu-%s",caller,pid_namespace,hex);
    else snprintf(profile,sizeof(profile),"aim-agy-p-%u-%s",caller,hex);
    snprintf(tools_profile,sizeof(tools_profile),"%s-tools",profile);

    char *policy=NULL;
    size_t size=0;
    FILE *out=open_memstream(&policy,&size);
    if (!out) fail("policy allocation");
    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",profile);
    fputs("network inet,\nnetwork inet6,\nnetwork unix,\ncapability,\nsignal,\nunix,\n"
          "deny dbus,\ndeny unix (connect, send, receive) peer=(addr=\"@**\"),\n"
          "deny /**/{dbus-launch,dbus-run-session,lsb_release} x,\n"
          "deny /**/.config/gcloud{,/**} rwmlkx,\n",out);
    fprintf(out,"ptrace (read,trace,readby,tracedby) peer=%s,\n",profile);
    subtree(out,account,"rwmlk");
    subtree(out,scratch,"rwlk");
    subtree(out,workspace,"rwlk");
    for (int i=8;i<separator;i++) subtree(out,argv[i],"rwlk");
    literal(out,vendor);fputs(" rm,\n",out);
    resolver_read(out);
    fputs("/{usr,bin,sbin,lib,lib64}{,/**} rm,\n/dev/{null,zero,random,urandom} rw,\n"
          "/etc/{hosts,resolv.conf,nsswitch.conf,gai.conf,localtime,ld.so.cache,passwd,group} r,\n/etc/{ssl,ca-certificates}{,/**} r,\n"
          "/proc/{meminfo,stat,filesystems,loadavg,uptime} r,\n/proc/sys/{vm/overcommit_memory,kernel/ngroups_max} r,\n"
          "/proc/[0-9]*/{maps,auxv,status,stat,statm,attr/current} r,\n/proc/[0-9]*/task/[0-9]*/{stat,status} r,\n"
          "/sys/devices/system/cpu/{online,possible} r,\n/sys/kernel/mm/transparent_hugepage/hpage_pmd_size r,\n"
          "deny /{etc,usr/lib}/{machine-id,hostid,hostname,os-release,lsb-release} r,\n",out);
    fprintf(out,"/dev/{tty,ptmx} %s,\n/dev/pts/{,**} %s,\n",login?"rw":"w",login?"rw":"w");
    const char *excluded[]={vendor,self,launcher_namespaces[0],launcher_namespaces[1]};
    char transition[200];
    snprintf(transition,sizeof(transition),"px -> %s",tools_profile);
    other_exec(out,"/",excluded,4,transition);
    literal(out,vendor);fputs(" ix,\n",out);
    common_rules(out,home,account,scratch,bundle);
    if (proxy) routed_rules(out);
    fputs("}\n",out);

    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",tools_profile);
    ordinary_access(out);
    other_exec(out,"/",excluded,4,"ix");
    launcher_exec(out);
    // Tools have no need for the native OAuth store. Only the vendor profile
    // may re-execute the approved image, and that re-execution stays confined.
    deny_subtree(out,aimgr,"rwmlkx");
    fputs("deny /dev/{tty,ptmx} r,\ndeny /dev/pts/{,**} r,\n",out);
    common_rules(out,home,account,scratch,bundle);
    if (proxy) routed_rules(out);
    fputs("}\n",out);
    if (fclose(out) || size>2*1024*1024) fail("policy generation");

    immutable(RUNTIME "/policy.lock",0);
    int lock=open(RUNTIME "/policy.lock",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if (lock<0) fail("policy installation lock");
    prune_profiles(lock,"agy",pid_namespace);
    // A collector must not see a freshly loaded pair before profile entry.
    if (flock(lock,LOCK_SH)) fail("policy installation lock");
    parse_policy(policy,0);
    free(policy);
    enter_profile();
    close(lock);
    drop();
    if (chdir(workspace)) fail("workspace entry");
    if (headless || diagnostic) close_run_input();
    install_environment(environment,account,proxy);
    char *acp_args[]={vendor,"acp","--disable-telemetry",NULL};
    char *diagnostic_args[]={vendor,credits ? "--print=/credits" : "--print=/usage","--output-format=json",
        "--print-timeout=10s","--settings={\"disableSlashCommands\":false,\"useG1Credits\":false}",NULL};
    argv[separator]=vendor;
    char **native_args=acp ? acp_args : diagnostic ? diagnostic_args : argv+separator;
    if (headless && !slash_disabled) {
        size_t count=(size_t)(argc-separator);
        native_args=calloc(count+2,sizeof(*native_args));
        if (!native_args) fail("native arguments allocation");
        memcpy(native_args,argv+separator,count*sizeof(*native_args));
        native_args[count]="--disable-slash-commands";
    }
    execv(vendor,native_args);
    fail("approved vendor exec");
}
