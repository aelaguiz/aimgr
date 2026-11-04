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
#define VENDOR_NAME "Claude"
#define RUNTIME "/opt/aimgr-claude-runtime"
#include "../privacy/launch_linux.h"
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
