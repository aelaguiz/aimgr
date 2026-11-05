/* Hardened-runtime signed immutable entry; official vendor bytes stay intact.
 * The policy applies before vendor startup and drops at ordinary tool exec. */
#define VENDOR_NAME "Codex"
#define RUNTIME_ROOT "/opt/aimgr-codex-runtime/artifacts/"
#include "../privacy/launch_macos.h"
#include "maintenance_gate.h"
#include "private_scratch.h"
#include "keychain_paths_macos.h"

static void vendor_filter(FILE *out,const char *vendor,const char *helper) {
    fputs("(require-any ",out);rule(out,"process-path",vendor);rule(out,"process-path",helper);fputs(")",out);
}
static void runtime_reads(FILE *out) {
    // dyld bootstrap needs the filesystem root itself; this grants no children.
    fputs("(literal \"/\")(literal \"/etc\")(literal \"/var\")(literal \"/tmp\")(literal \"/private\")(literal \"/private/var\")(literal \"/private/tmp\")"
      "(subpath \"/System\")(subpath \"/usr\")(subpath \"/bin\")(subpath \"/sbin\")(subpath \"/dev\")"
      "(subpath \"/Library/Apple\")(subpath \"/Library/Developer\")(subpath \"/private/etc\")"
      "(subpath \"/private/var/db/dyld\")(subpath \"/private/preboot/Cryptexes/OS\")"
      "(literal \"/private/var/select/developer_dir\")",out);
}
static void database_grants(FILE *out,const char *root) {
    // Escape regex metacharacters in user paths; the suffix is fixed.
    char pattern[PATH_MAX*2+128];size_t n=0;pattern[n++]='^';
    for (const char *p=root;*p;p++) {
        if (strchr("\\.^$|()[]{}*+?",*p)) pattern[n++]='\\';
        pattern[n++]=*p;
    }
    // Seatbelt uses POSIX extended groups, not PCRE's (?:...) syntax.
    snprintf(pattern+n,sizeof(pattern)-n,"/([^/]+\\.sqlite(-wal|-shm|-journal)?|\\.sqlite-maintenance\\.lock)$");
    rule(out,"regex",pattern);
    rule(out,"literal",root);
}

// A classified shared entry may itself be an authored dangling link. Preserve
// its exact lexical grant so native sees NotFound and a later replacement stays
// shared. This exception applies only to writes backed by the account-home link;
// configured reads, deny paths and their canonicalization remain unchanged.
static int shared_dangling_write(const char *file,const char *home) {
    if (!file || file[0]!='/' || strlen(file)>=PATH_MAX) return 0;
    const char *name=strrchr(file,'/');
    if (!name || !name[1] || !strcmp(name+1,".") || !strcmp(name+1,"..")) return 0;
    struct stat st;
    if (lstat(file,&st) || !S_ISLNK(st.st_mode) || !stat(file,&st) || errno!=ENOENT) return 0;
    char parent[PATH_MAX],link[PATH_MAX],target[PATH_MAX];
    strlcpy(parent,file,sizeof(parent));parent[name-file]=0;
    canonical(parent);
    for (const unsigned char *p=(const unsigned char *)name;*p;p++) if (*p<32 || *p==127) fail("invalid shared path");
    if (snprintf(link,sizeof(link),"%s/%s",home,name+1)>=(int)sizeof(link)) return 0;
    ssize_t size=readlink(link,target,sizeof(target)-1);
    if (size<0) return 0;
    target[size]=0;
    return !strcmp(target,file);
}

int main(int argc,char **argv) {
    /* Same v1 data-only protocol as the Linux entry. */
    int verifying_mcp=argc>1 && !strcmp(argv[1],"mcp-verify-v1");
    if (getuid()==0 || geteuid()!=getuid() || argc<10 || (!verifying_mcp && strcmp(argv[1],"v1"))) fail("invocation");
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
    canonical(account);canonical(home);codex_private_scratch(scratch);
    if (!inside(home,account)) fail("account state ownership");
    struct passwd *user=getpwuid(getuid());char user_home[PATH_MAX];
    if (!user || !realpath(user->pw_dir,user_home) || inside(user_home,account)) fail("overbroad account root");
    int envfd=number(argv[5],1024),writes=number(argv[6],argc-7),readindex=7+writes;
    if (readindex>=argc) fail("write roots");
    int reads=number(argv[readindex],argc-readindex-1),dbindex=readindex+1+reads;
    if (dbindex>=argc) fail("read roots");
    int databases=number(argv[dbindex],argc-dbindex-1),denyindex=dbindex+1+databases;
    if (denyindex>=argc) fail("database roots");
    int denies=number(argv[denyindex],argc-denyindex-1),separator=denyindex+1+denies;
    if (separator>=argc || strcmp(argv[separator],"--")) fail("denied paths");
    // This maintenance-only operation cannot execute caller-selected commands
    // or grant other inputs. It reads credentials through unchanged Codex while
    // ordinary admissions remain closed and cannot contact any network service.
    if (verifying_mcp) {
        char expected[PATH_MAX];
        if (writes || reads || databases || denies || separator!=argc-1
            || snprintf(expected,sizeof(expected),CODEX_MAINTENANCE_ROOT "/%u/maintenance/read-",(unsigned)getuid())>=(int)sizeof(expected)
            || strncmp(account,expected,strlen(expected))
            || snprintf(expected,sizeof(expected),"%s/home",account)>=(int)sizeof(expected)
            || strcmp(home,expected) || chdir(home)) fail("maintenance read invocation");
    }
    const char **write_roots=(const char **)(argv+7),**read_roots=(const char **)(argv+readindex+1),**database_roots=(const char **)(argv+dbindex+1),**denied=(const char **)(argv+denyindex+1);
    for (int i=0;i<writes+reads;i++) {
        const char *root=i<writes?write_roots[i]:read_roots[i-writes];
        if (!(i<writes && shared_dangling_write(root,home))) canonical_future(root);
        if (inside(user_home,root) || (inside(account,root) && strcmp(root,account))) fail("overbroad input root");
    }
    for (int i=0;i<databases;i++) canonical_future(database_roots[i]);
    for (int i=0;i<denies;i++) canonical_future(denied[i]);
    restore_environment(envfd);close_inherited_descriptors();
    int admission=codex_maintenance_admission(verifying_mcp);
    struct codex_keychain_paths keychain=keychain_paths(user_home);
    char *policy=NULL;size_t length=0;FILE *out=open_memstream(&policy,&length);if (!out) fail("policy allocation");
    fputs("(version 1)(allow default)\n",out);
    if (verifying_mcp) {
        fputs("(deny network*)(deny process-exec (require-not (require-any ",out);
        rule(out,"literal",vendor);rule(out,"literal",helper);fputs(")))\n",out);
    } else {
        fputs("(allow process-exec (require-not (require-any ",out);
        rule(out,"literal",vendor);rule(out,"literal",helper);fputs(")) (with no-sandbox))\n",out);
    }
    fputs("(with-filter ",out);
    vendor_filter(out,vendor,helper);fputs("\n(deny file-read* (require-not (require-any ",out);
    rule(out,"literal",vendor);rule(out,"literal",helper);ancestors(out,vendor);
    rule(out,"subpath",account);ancestors(out,account);rule(out,"subpath",scratch);ancestors(out,scratch);runtime_reads(out);
    for (int i=0;i<writes;i++) {rule(out,"subpath",write_roots[i]);ancestors(out,write_roots[i]);}
    for (int i=0;i<reads;i++) {rule(out,"subpath",read_roots[i]);ancestors(out,read_roots[i]);}
    for (int i=0;i<databases;i++) {database_grants(out,database_roots[i]);ancestors(out,database_roots[i]);}
    if (*keychain.preferences) rule(out,"literal",keychain.preferences);
    keychain_database_grants(out,&keychain);
    fputs(")))\n",out);
    // Keep traversal metadata in the file-read* exception above, then remove
    // data/xattrs from ancestors unless another selected root grants that data.
    // An allow-metadata rule alone cannot override the broader explicit deny.
    fputs("(deny file-read-data file-read-xattr (require-all (require-any ",out);
    ancestors(out,vendor);ancestors(out,account);ancestors(out,scratch);
    for (int i=0;i<writes;i++) ancestors(out,write_roots[i]);
    for (int i=0;i<reads;i++) ancestors(out,read_roots[i]);
    for (int i=0;i<databases;i++) ancestors(out,database_roots[i]);
    fputs(") (require-not (require-any ",out);
    rule(out,"literal",vendor);rule(out,"literal",helper);
    rule(out,"subpath",account);rule(out,"subpath",scratch);runtime_reads(out);
    for (int i=0;i<writes;i++) rule(out,"subpath",write_roots[i]);
    for (int i=0;i<reads;i++) rule(out,"subpath",read_roots[i]);
    for (int i=0;i<databases;i++) database_grants(out,database_roots[i]);
    if (*keychain.preferences) rule(out,"literal",keychain.preferences);
    keychain_database_grants(out,&keychain);
    fputs("))))\n",out);
    if (*keychain.preferences || keychain.count) {
        fputs("(allow file-read-metadata ",out);keychain_metadata(out,&keychain);fputs(")",out);
    }
    // Security.framework checks this sentinel before opening any keychain.
    // Denying its stat sends native into a blocking system-keychain repair wait.
    fputs("(allow file-read-metadata ",out);
    rule(out,"literal","/private/var/run/systemkeychaincheck.done");
    rule(out,"literal","/var/run/systemkeychaincheck.done");
    ancestors(out,"/private/var/run/systemkeychaincheck.done");fputs(")",out);
    for (int i=0;i<keychain.count;i++) {
        fputs(i?"(deny file-read-data file-read-xattr ":"(deny file-read-xattr ",out);
        rule(out,"literal",keychain.files[i]);fputs(")",out);
    }
    fputs("\n(deny file-write* (require-not (require-any (subpath \"/dev\")",out);
    rule(out,"subpath",account);rule(out,"subpath",scratch);
    for (int i=0;i<writes;i++) rule(out,"subpath",write_roots[i]);
    for (int i=0;i<databases;i++) database_grants(out,database_roots[i]);
    keychain_database_grants(out,&keychain);
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
    codex_close_except_admission(admission);
    if (verifying_mcp) {
        char *read_args[]={vendor,"-c","mcp_oauth_credentials_store=\"keyring\"","-c","features.secret_auth_storage=false","mcp","list","--json",NULL};
        execv(vendor,read_args);
    } else { argv[separator]=vendor;execv(vendor,argv+separator); }
    fail("approved vendor exec");
}
