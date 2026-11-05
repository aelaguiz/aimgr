/* The existing AIM launcher owns this short admission barrier. The descriptor
 * closes atomically at vendor exec; no session owner or helper keeps it alive. */
#include <sys/file.h>
#include <time.h>

#define CODEX_MAINTENANCE_ROOT "/opt/aimgr-codex-runtime/users"

static void codex_private_acl(int fd) {
#if defined(__APPLE__)
    errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);int error=errno;
    if (!acl && error==ENOENT) return;
    if (!acl || acl_valid(acl)) fail("private state ACL unreadable");
    acl_entry_t entry;int index=ACL_FIRST_ENTRY;
    while (acl_get_entry(acl,index,&entry)==0) {
        index=ACL_NEXT_ENTRY;acl_tag_t tag;
        if (acl_get_tag_type(entry,&tag) || tag!=ACL_EXTENDED_DENY) fail("private state ACL grants access");
    }
    acl_free(acl);
#else
    (void)fd; // Linux POSIX ACL grants are bounded by the checked group mask.
#endif
}

static int codex_maintenance_admission(int verifying_mcp) {
    char directory[PATH_MAX];
    if (snprintf(directory,sizeof(directory),CODEX_MAINTENANCE_ROOT "/%u",(unsigned)getuid()) >= (int)sizeof(directory)) fail("maintenance path");
    immutable(CODEX_MAINTENANCE_ROOT,1);chain(CODEX_MAINTENANCE_ROOT);
    immutable(directory,1);
    int owner=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if (owner<0) fail("maintenance owner");
    // The parent is administrator-owned: the user can flock this inode but
    // cannot unlink it and split live owners onto different locks.
    int lock=openat(owner,"admission.lock",O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
    close(owner);
    struct stat info;
    if (lock<0 || fstat(lock,&info) || !S_ISREG(info.st_mode) || info.st_uid!=getuid() || info.st_nlink!=1 || (info.st_mode&077)) fail("maintenance admission lock");
    codex_private_acl(lock);
    size_t size=strlen(directory);
    if (size+sizeof("/maintenance")>sizeof(directory)) fail("maintenance path");
    memcpy(directory+size,"/maintenance",sizeof("/maintenance"));
    int root=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if (root<0 || fstat(root,&info) || !S_ISDIR(info.st_mode) || info.st_uid!=getuid() || (info.st_mode&077)) fail("maintenance directory");
    codex_private_acl(root);
    struct timespec start,now,pause={.tv_sec=0,.tv_nsec=25000000};
    if (clock_gettime(CLOCK_MONOTONIC,&start)) fail("maintenance clock");
    while (flock(lock,LOCK_SH|LOCK_NB)) {
        if (errno!=EWOULDBLOCK && errno!=EINTR) fail("maintenance admission lock");
        if (clock_gettime(CLOCK_MONOTONIC,&now) || now.tv_sec-start.tv_sec>=5) fail("credential maintenance is busy");
        nanosleep(&pause,NULL);
    }
    if (!fstatat(root,"pending.json",&info,AT_SYMLINK_NOFOLLOW)) {
        if (!verifying_mcp) {
            dprintf(2,"Codex was not started: MCP credential maintenance is pending. Finish or recover the maintenance operation before starting Codex.\n");
            _exit(125);
        }
        if (!S_ISREG(info.st_mode) || info.st_uid!=getuid() || (info.st_mode&077)) fail("maintenance verification owner");
    } else if (errno!=ENOENT || verifying_mcp) fail("maintenance status");
    close(root);
    if (lock<3) {
        int moved=fcntl(lock,F_DUPFD_CLOEXEC,3);
        if (moved<0) fail("maintenance descriptor");
        close(lock);lock=moved;
    }
    return lock;
}

static void codex_close_descriptors(int retained,int assignment) {
#if defined(__linux__)
    int first=retained,second=assignment;
    if (first>second) { int swap=first;first=second;second=swap; }
    unsigned start=3;
    int keep[]={first,second};
    for (int i=0;i<2;i++) if (keep[i]>=3) {
        if ((unsigned)keep[i]>start && syscall(SYS_close_range,start,(unsigned)keep[i]-1,0)) fail("descriptor closure");
        start=(unsigned)keep[i]+1;
    }
    if (syscall(SYS_close_range,start,~0u,0)) fail("descriptor closure");
#else
    if (retained<3 && assignment<3) close_inherited_descriptors();
    else close_descriptors_except_two(retained,assignment);
#endif
}
