/* OFFSITE DECISION FIXTURE ONLY. The installed launcher must use admitted
 * artifact-relative targets and complete policies; this fixed host fixture
 * establishes the native reentry primitive without granting arbitrary exec or
 * accepting caller-written SBPL. Never install this file as a production gate.
 * Hardened-runtime signing is REQUIRED: no-sandbox takes effect before main,
 * so clearing DYLD_* here would be too late to prevent a constructor load. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
extern int sandbox_init_with_parameters(const char *, uint64_t, const char *const *, char **);
#define ROOT "/opt/aimgr-state-audit/claude-implementation"
#define SELF ROOT "/reentry-native"
#define VENDOR "/opt/aimgr-state-audit/bin/claude"
static _Noreturn void fail(void) { fputs("AIM offsite reentry refused before vendor startup.\n",stderr); _exit(125); }
int main(int argc, char **argv) {
    if (getuid()==0 || geteuid()!=getuid() || argc<3 || access("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST",F_OK)) fail();
    struct stat st;
    if (lstat(SELF,&st) || !S_ISREG(st.st_mode) || st.st_uid!=0 || (st.st_mode&022)) fail();
    if (lstat(VENDOR,&st) || !S_ISREG(st.st_mode) || st.st_uid!=0 || (st.st_mode&022)) fail();
    const char *hidden;
    if (!strcmp(argv[1],"a")) hidden=ROOT "/hidden-canary-b";
    else if (!strcmp(argv[1],"b")) hidden=ROOT "/hidden-canary-a";
    else fail();
    const char *policy="(version 1)(allow default)"
      "(allow process-exec (literal \"" SELF "\") (with no-sandbox))"
      "(deny process-exec (subpath \"" ROOT "/unapproved-update\"))"
      "(deny file-read* (require-all (process-path \"" VENDOR "\") (literal (param \"HIDDEN\"))))"
      "(with-filter (process-path \"" VENDOR "\")"
      "(deny iokit-get-properties (iokit-property \"IOPlatformUUID\") (iokit-property \"IOPlatformSerialNumber\"))"
      "(deny sysctl-read (sysctl-name \"kern.hostname\") (sysctl-name \"kern.osproductversion\")"
      "(sysctl-name \"kern.osrelease\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.version\") (sysctl-name \"hw.model\"))"
      "(deny file-read* (literal \"/System/Library/CoreServices/SystemVersion.plist\"))"
      "(deny syscall-unix (syscall-number SYS_gethostuuid))"
      "(deny syscall-mig (kernel-mig-routine host_kernel_version))"
      "(deny process-exec (literal \"/usr/bin/sw_vers\")))";
    const char *parameters[]={"HIDDEN",hidden,NULL}; char *error=NULL;
    if (sandbox_init_with_parameters(policy,0,parameters,&error)) fail();
    // Never accept a replacement executable. The controller checks this exact
    // official vendor digest outside the boundary before every fixture run.
    argv[1]=(char *)VENDOR;
    // Close synthetic inherited descriptors; normal launch will explicitly
    // restore its protected environment transfer before this final close.
    for (int fd=3;fd<1024;fd++) close(fd);
    execv(VENDOR,argv+1); fail();
}
