/* Hardened-runtime signed immutable entry; official vendor bytes stay intact.
 * The policy applies before vendor startup and drops at ordinary tool exec. */
#define VENDOR_NAME "Codex"
#define RUNTIME_ROOT "/opt/aimgr-codex-runtime/artifacts/"
#include "../privacy/launch_macos.h"
#include "maintenance_gate.h"

static void vendor_filter(FILE *out,const char *vendor,const char *helper) {
    fputs("(require-any ",out);rule(out,"process-path",vendor);rule(out,"process-path",helper);fputs(")",out);
}
static void runtime_reads(FILE *out) {
    fputs("(literal \"/etc\")(literal \"/var\")(literal \"/tmp\")(literal \"/private\")(literal \"/private/var\")"
      "(subpath \"/System\")(subpath \"/usr\")(subpath \"/bin\")(subpath \"/sbin\")(subpath \"/dev\")"
      "(subpath \"/Library/Apple\")(subpath \"/Library/Developer\")(subpath \"/private/etc\")"
      "(subpath \"/private/var/db/dyld\")(subpath \"/private/preboot/Cryptexes/OS\")"
      "(literal \"/private/var/select/developer_dir\")",out);
}
static void database_grants(FILE *out,const char *root,int reading) {
    // Escape regex metacharacters in user paths; the suffix is fixed.
    char pattern[PATH_MAX*2+128];size_t n=0;pattern[n++]='^';
    for (const char *p=root;*p;p++) {
        if (strchr("\\.^$|()[]{}*+?",*p)) pattern[n++]='\\';
        pattern[n++]=*p;
    }
    snprintf(pattern+n,sizeof(pattern)-n,"/(?:[^/]+\\.sqlite(?:-wal|-shm|-journal)?|\\.sqlite-maintenance\\.lock)$");
    rule(out,"regex",pattern);
    rule(out,"literal",root);
    if (reading) ancestors(out,root);
}

int main(int argc,char **argv) {
    /* Same v1 data-only protocol as the Linux entry. */
    if (getuid()==0 || geteuid()!=getuid() || argc<10 || strcmp(argv[1],"v1")) fail("invocation");
    char image[PATH_MAX],self[PATH_MAX],vendor[PATH_MAX],helper[PATH_MAX];uint32_t size=sizeof(image);
    if (_NSGetExecutablePath(image,&size) || !realpath(image,self)) fail("launcher path");
    size_t prefix=strlen(RUNTIME_ROOT);
    if (strncmp(self,RUNTIME_ROOT,prefix) || strlen(self)!=prefix+64+strlen("/launcher") || strcmp(self+prefix+64,"/launcher")) fail("launcher installation");
    for (size_t i=prefix;i<prefix+64;i++) if (!((self[i]>='a' && self[i]<='f') || (self[i]>='0' && self[i]<='9'))) fail("artifact identity");
    immutable(self,0);chain(self);
    strlcpy(vendor,self,sizeof(vendor));strcpy(strrchr(vendor,'/'),"/codex");immutable(vendor,0);
    strlcpy(helper,self,sizeof(helper));strcpy(strrchr(helper,'/'),"/codex-code-mode-host");immutable(helper,0);
    if (access(vendor,X_OK) || access(helper,X_OK)) fail("vendor execution access");
    const char *account=argv[2],*home=argv[3],*scratch=argv[4];
    canonical(account);canonical(home);canonical(scratch);
    if (!inside(home,account) || !inside(scratch,account)) fail("account state ownership");
    struct passwd *user=getpwuid(getuid());char user_home[PATH_MAX];
    if (!user || !realpath(user->pw_dir,user_home) || inside(user_home,account)) fail("overbroad account root");
    int envfd=number(argv[5],1024),writes=number(argv[6],MAX_ROOTS),readindex=7+writes;
    if (readindex>=argc) fail("write roots");
    int reads=number(argv[readindex],MAX_ROOTS),dbindex=readindex+1+reads;
    if (dbindex>=argc) fail("read roots");
    int databases=number(argv[dbindex],MAX_ROOTS),denyindex=dbindex+1+databases;
    if (denyindex>=argc) fail("database roots");
    int denies=number(argv[denyindex],MAX_ROOTS),separator=denyindex+1+denies;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("denied paths");
    const char **write_roots=(const char **)(argv+7),**read_roots=(const char **)(argv+readindex+1),**database_roots=(const char **)(argv+dbindex+1),**denied=(const char **)(argv+denyindex+1);
    for (int i=0;i<writes+reads;i++) {
        const char *root=i<writes?write_roots[i]:read_roots[i-writes];canonical_future(root);
        if (inside(user_home,root) || (inside(account,root) && strcmp(root,account))) fail("overbroad input root");
    }
    for (int i=0;i<databases;i++) canonical_future(database_roots[i]);
    for (int i=0;i<denies;i++) canonical_future(denied[i]);
    restore_environment(envfd);close_inherited_descriptors();
    int admission=codex_maintenance_admission();
    char *policy=NULL;size_t length=0;FILE *out=open_memstream(&policy,&length);if (!out) fail("policy allocation");
    fputs("(version 1)(allow default)\n(allow process-exec (require-not (require-any ",out);
    rule(out,"literal",vendor);rule(out,"literal",helper);fputs(")) (with no-sandbox))\n(with-filter ",out);
    vendor_filter(out,vendor,helper);fputs("\n(deny file-read* (require-not (require-any ",out);
    rule(out,"literal",vendor);rule(out,"literal",helper);ancestors(out,vendor);
    rule(out,"subpath",account);ancestors(out,account);runtime_reads(out);
    for (int i=0;i<writes;i++) {rule(out,"subpath",write_roots[i]);ancestors(out,write_roots[i]);}
    for (int i=0;i<reads;i++) {rule(out,"subpath",read_roots[i]);ancestors(out,read_roots[i]);}
    for (int i=0;i<databases;i++) database_grants(out,database_roots[i],1);
    fputs(")))\n(deny file-write* (require-not (require-any (subpath \"/dev\")",out);
    rule(out,"subpath",account);
    for (int i=0;i<writes;i++) rule(out,"subpath",write_roots[i]);
    for (int i=0;i<databases;i++) database_grants(out,database_roots[i],0);
    fputs(")))",out);
    for (int i=0;i<denies;i++) {fputs("(deny file-read* file-write* ",out);rule(out,"literal",denied[i]);fputs(")",out);}
    fputs("(deny file-write* (subpath \"/private/etc/codex\"))"
      "(deny iokit-get-properties (iokit-property \"IOPlatformUUID\")(iokit-property \"IOPlatformSerialNumber\"))"
      "(deny sysctl-read (sysctl-name \"kern.hostname\")(sysctl-name \"kern.osproductversion\")(sysctl-name \"kern.osrelease\")"
      "(sysctl-name \"kern.osversion\")(sysctl-name \"kern.version\")(sysctl-name \"hw.model\"))"
      "(deny file-read* (literal \"/System/Library/CoreServices/SystemVersion.plist\"))"
      "(deny syscall-unix (syscall-number SYS_gethostuuid))"
      "(deny syscall-mig (kernel-mig-routine host_kernel_version))"
      "(deny process-exec (literal \"/usr/bin/sw_vers\")))",out);
    if (fclose(out) || !policy || length>1024*1024) fail("policy generation");
    char *error=NULL;if (sandbox_init_with_parameters(policy,0,NULL,&error)) fail("policy application");
    free(policy);
    set_environment("CODEX_HOME",home,1);set_environment("TMPDIR",scratch,1);
    codex_close_except_admission(admission);argv[separator]=vendor;execv(vendor,argv+separator);fail("approved vendor exec");
}
