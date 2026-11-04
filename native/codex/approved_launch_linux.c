/* Fixed, root-owned/setuid entry for one admitted official Codex bundle.
 * Ordinary tools have normal host access. Only the exact vendor images
 * retain file/device restrictions; nested AIM enters a fresh native policy.
 */
#define VENDOR_NAME "Codex"
#define NOTIFY_COMPAT_SYSCALLS 1
#define RUNTIME "/opt/aimgr-codex-runtime"
#include "../privacy/launch_linux.h"
#include "maintenance_gate.h"

static void deny_distribution_probe(FILE *out,char **environment) {
    /* Command::new("lsb_release") searches PATH. AppArmor checks a symlink's
     * target, so cover that exact command's resolved targets as well as its
     * ordinary filename. These denials never enter the tools profile. */
    fputs("deny /**/lsb_release x,\n",out);
    const char *search="/bin:/usr/bin";
    for (char **entry=environment;*entry;entry++) if (!strncmp(*entry,"PATH=",5)) { search=*entry+5;break; }
    char *copy=strdup(search),*remaining=copy,*directory;
    if (!copy) fail("distribution probe inventory");
    while ((directory=strsep(&remaining,":"))) {
        char candidate[PATH_MAX],resolved[PATH_MAX];
        if (snprintf(candidate,sizeof(candidate),"%s/lsb_release",*directory?directory:".")>=(int)sizeof(candidate)) fail("distribution probe path");
        if (realpath(candidate,resolved)) { fputs("deny ",out);literal(out,resolved);fputs(" x,\n",out); }
    }
    free(copy);
    const char *release_files[]={"/etc/os-release","/etc/mariner-release","/etc/centos-release",
        "/etc/fedora-release","/etc/alpine-release","/etc/redhat-release"};
    for (size_t i=0;i<sizeof(release_files)/sizeof(*release_files);i++) {
        char resolved[PATH_MAX];
        if (realpath(release_files[i],resolved)) { fputs("deny ",out);literal(out,resolved);fputs(" r,\n",out); }
    }
}

static void database_grants(FILE *out,const char *root) {
    // Native versioned database names are owned by Codex. Permit SQLite files
    // and their sidecars, without exposing the rest of a legacy shared home.
    char directory[PATH_MAX];if (snprintf(directory,sizeof(directory),"%s/",root)>=(int)sizeof(directory)) fail("database path length");
    literal(out,directory);fputs(" rw,\n",out);
    char *escaped=NULL;size_t length=0;FILE *buffer=open_memstream(&escaped,&length);
    if (!buffer) fail("database policy allocation");
    literal(buffer,root);fclose(buffer);escaped[length-1]=0;
    fprintf(out,"%s/*.sqlite{,-wal,-shm,-journal}\" rwmlk,\n",escaped);
    fprintf(out,"%s/.sqlite-maintenance.lock\" rwlk,\n",escaped);free(escaped);
    ancestors(out,root,"r","");
}

int main(int argc,char **argv) {
    /* v1 ACCOUNT HOME SCRATCH ENVFD WRITECOUNT ROOT... READCOUNT ROOT...
     * DBCOUNT ROOT... DENYCOUNT PATH... -- VENDOR_ARGS... */
    caller=getuid();caller_group=getgid();
    if (!caller || !caller_group || geteuid()!=0 || argc<10 || strcmp(argv[1],"v1")) fail("invocation");
    char self[PATH_MAX],vendor[PATH_MAX],helper[PATH_MAX];
    ssize_t n=readlink("/proc/self/exe",self,sizeof(self)-1);
    if (n<0 || n>=(ssize_t)sizeof(self)-1) fail("launcher path");
    self[n]=0;
    size_t prefix=strlen(ARTIFACTS);
    if (strncmp(self,ARTIFACTS,prefix) || strlen(self)!=prefix+64+strlen("/launcher") || strcmp(self+prefix+64,"/launcher")) fail("launcher installation");
    for (size_t i=prefix;i<prefix+64;i++) if (!((self[i]>='a' && self[i]<='f') || (self[i]>='0' && self[i]<='9'))) fail("artifact identity");
    immutable(self,0);chain(self);
    snprintf(vendor,sizeof(vendor),"%s",self);strcpy(strrchr(vendor,'/'),"/codex");immutable(vendor,0);
    snprintf(helper,sizeof(helper),"%s",self);strcpy(strrchr(helper,'/'),"/codex-code-mode-host");immutable(helper,0);
    immutable("/usr/sbin/apparmor_parser",0);chain("/usr/sbin/apparmor_parser");
    const char *account=argv[2],*home=argv[3],*scratch=argv[4];
    canonical(account);canonical(home);canonical(scratch);
    if (!inside(home,account) || !inside(scratch,account)) fail("account state ownership");
    struct passwd *user=getpwuid(caller);char user_home[PATH_MAX];
    if (!user || !realpath(user->pw_dir,user_home) || inside(user_home,account)) fail("overbroad account root");
    int envfd=number(argv[5],1024),writes=number(argv[6],argc-7),readindex=7+writes;
    if (readindex>=argc) fail("write roots");
    int reads=number(argv[readindex],argc-readindex-1),dbindex=readindex+1+reads;
    if (dbindex>=argc) fail("read roots");
    int databases=number(argv[dbindex],argc-dbindex-1),denyindex=dbindex+1+databases;
    if (denyindex>=argc) fail("database roots");
    int denies=number(argv[denyindex],argc-denyindex-1),separator=denyindex+1+denies;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("denied paths");
    const char **write_roots=(const char **)(argv+7),**read_roots=(const char **)(argv+readindex+1),**database_roots=(const char **)(argv+dbindex+1),**denied=(const char **)(argv+denyindex+1);
    for (int i=0;i<writes+reads;i++) {
        const char *root=i<writes?write_roots[i]:read_roots[i-writes];canonical_future(root);
        if (inside(user_home,root) || (inside(account,root) && strcmp(root,account))) fail("overbroad input root");
    }
    for (int i=0;i<databases;i++) canonical_future(database_roots[i]);
    for (int i=0;i<denies;i++) canonical_future(denied[i]);
    char **private_environment=read_environment(envfd);
    close_handles();
    int admission=codex_maintenance_admission();
    require_enforcement();
    trusted_launcher_namespaces();
    unsigned char nonce[16];char hex[33];if (getentropy(nonce,sizeof(nonce))) fail("policy identity");
    for (int i=0;i<16;i++) snprintf(hex+2*i,3,"%02x",nonce[i]);
    snprintf(profile,sizeof(profile),"aim-codex-p-%u-%s",caller,hex);
    snprintf(tools_profile,sizeof(tools_profile),"%s-tools",profile);
    char *policy=NULL;size_t size=0;FILE *out=open_memstream(&policy,&size);if (!out) fail("policy allocation");
    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",profile);
    fputs("network,\ncapability,\nsignal,\nptrace,\nunix,\n"
      "dbus (send, receive) bus=session peer=(name=org.freedesktop.DBus),\n"
      "dbus (send, receive) bus=session peer=(name=org.freedesktop.secrets),\n",out);
    subtree(out,account,"rwmlk");ancestors(out,account,"r","");
    for (int i=0;i<writes;i++) {subtree(out,write_roots[i],"rwmlk");ancestors(out,write_roots[i],"r","");}
    for (int i=0;i<reads;i++) {subtree(out,read_roots[i],"rm");ancestors(out,read_roots[i],"r","");}
    for (int i=0;i<databases;i++) database_grants(out,database_roots[i]);
    literal(out,vendor);fputs(" rm,\n",out);literal(out,helper);fputs(" rm,\n",out);
    ancestors(out,vendor,"r","");resolver_read(out);
    fputs("/{usr,bin,sbin,lib,lib64}{,/**} rm,\n/dev/{null,zero,random,urandom,tty,ptmx} rw,\n/dev/pts/{,**} rw,\n"
      "/etc/{resolv.conf,hosts,nsswitch.conf,gai.conf,localtime,ld.so.cache,passwd,group} r,\n/etc/{ssl,ca-certificates,codex}{,/**} r,\n"
      "/proc/{meminfo,stat,filesystems,loadavg,uptime} r,\n/proc/sys/{vm/overcommit_memory,kernel/ngroups_max} r,\n"
      "/proc/[0-9]*/{maps,auxv,status,stat,statm,attr/current} r,\n/proc/[0-9]*/task/[0-9]*/{stat,status} r,\n"
      "/sys/devices/system/cpu/{online,possible} r,\n/sys/kernel/mm/transparent_hugepage/hpage_pmd_size r,\n"
      "deny /{etc,usr/lib}/{os-release,lsb-release,machine-id,hostname} r,\n"
      "deny /etc/{mariner,centos,fedora,alpine,redhat}-release r,\n",out);
    /* Approved Linux metadata exception: native read-only sandbox setup
     * masks privileged socket aliases using the process mount table. This
     * permits same-user mount tables, not their mounted file contents. */
    fprintf(out,"/tmp/codex-daemon-%u/ rw,\n",caller);
    fputs("owner /proc/[0-9]*/mountinfo r,\n",out);
    /* Native workspace sandboxing creates empty masks for these names in
     * /tmp, then removes them after the tool exits. Permit same-user directory
     * entries only: no listings, descendant reads, or descendant writes. */
    fputs("owner /tmp/.{git,agents,codex,aws}/ w,\n",out);
    /* os_info 3.14 first execs lsb_release -a. Letting that helper enter the
     * ordinary-tool profile disclosed the distribution/version in HTTP.
     * This rule belongs only to vendor code; requested shell tools retain it. */
    deny_distribution_probe(out,private_environment);
    for (int i=0;i<denies;i++) {
        fputs("deny ",out);literal(out,denied[i]);fputs(" rwmlk,\n",out);
    }
    // Privacy policy is administrator-owned; native writes cannot enable an
    // alternative store, remote control or automatic vendor telemetry.
    fputs("deny /etc/codex{,/**} wlk,\n",out);
    const char *excluded[]={vendor,helper,self,launcher_namespaces[0],launcher_namespaces[1]};char transition[200];
    snprintf(transition,sizeof(transition),"px -> %s",tools_profile);
    other_exec(out,"/",excluded,5,transition);
    literal(out,vendor);fputs(" ix,\n",out);literal(out,helper);fputs(" ix,\n",out);launcher_exec(out);fputs("}\n",out);
    fprintf(out,"profile %s flags=(enforce,attach_disconnected) {\n",tools_profile);
    ordinary_access(out);
    other_exec(out,"/",excluded,5,"ix");
    /* Native bubblewrap sets no_new_privs before reentering this exact image.
     * Keep the existing tools confinement and add vendor restrictions, so
     * this is a subset transition under NNP. The next ordinary shell returns
     * to tools through the vendor component's normal px rule. */
    literal(out,vendor);fprintf(out," px -> \"%s//&%s\",\n",tools_profile,profile);
    literal(out,helper);fprintf(out," px -> \"%s//&%s\",\n",tools_profile,profile);
    launcher_exec(out);fputs("}\n",out); // No inherited vendor file denials on tools.
    if (fclose(out) || size>2*1024*1024) fail("policy generation");
    immutable(RUNTIME "/policy.lock",0);int lock=open(RUNTIME "/policy.lock",O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if (lock<0 || flock(lock,LOCK_EX)) fail("policy installation lock");
    parse_policy(policy,0);free(policy);install_uname();enter_profile();close(lock);drop();
    environ=private_environment;unset_environment("LD_PRELOAD");unset_environment("LD_AUDIT");
    set_environment("CODEX_HOME",home,1);set_environment("TMPDIR",scratch,1);
    codex_close_except_admission(admission);argv[separator]=vendor;execv(vendor,argv+separator);fail("approved vendor exec");
}
