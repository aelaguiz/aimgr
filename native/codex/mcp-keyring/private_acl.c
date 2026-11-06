#include <errno.h>
#if defined(__APPLE__)
#include <sys/acl.h>
#endif

/* Mode bits alone do not bound extended macOS ALLOW entries. Check the actual
 * open object, just as the native admission gate does. */
int aim_mcp_private_acl(int fd) {
#if defined(__APPLE__)
    errno=0; acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED); int error=errno;
    if (!acl && error==ENOENT) return 0;
    if (!acl) return -1;
    int result=acl_valid(acl); acl_entry_t entry; int index=ACL_FIRST_ENTRY;
    while (!result && acl_get_entry(acl,index,&entry)==0) {
        index=ACL_NEXT_ENTRY; acl_tag_t tag;
        if (acl_get_tag_type(entry,&tag) || tag!=ACL_EXTENDED_DENY) result=-1;
    }
    acl_free(acl); return result;
#else
    (void)fd; return 0;
#endif
}
