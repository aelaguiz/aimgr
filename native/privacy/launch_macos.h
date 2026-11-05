/* Shared immutable entry, Seatbelt input and descriptor primitives. */
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
#define MAX_ROOTS 256
#define MAX_ENV (16 * 1024 * 1024)
static _Noreturn void fail(const char *reason) {
    dprintf(2,VENDOR_NAME " was not started: native privacy admission failed (%s). Repair the approved runtime before retrying.\n",reason);
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
static void close_descriptors_except_two(int retained,int second) {
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
    for (int i=0;i<got/(int)sizeof(*fds);i++) if (fds[i].proc_fd>=3 && fds[i].proc_fd!=retained && fds[i].proc_fd!=second) close(fds[i].proc_fd);
    free(fds);
}
static void close_descriptors_except(int retained) { close_descriptors_except_two(retained,-1); }
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
