/* Short, private temporary paths preserve ordinary tools' Unix sockets.
 * Only this invocation's directory is granted, never the shared temp root. */
static void codex_private_scratch(const char *scratch) {
    canonical(scratch);
    char temporary[PATH_MAX],prefix[PATH_MAX];struct stat parent;
    if (!realpath("/tmp",temporary) || stat(temporary,&parent) || !S_ISDIR(parent.st_mode)
        || parent.st_uid!=0 || !(parent.st_mode&S_ISVTX)) fail("temporary directory");
    int length=snprintf(prefix,sizeof(prefix),"%s/aim-codex-%u-",temporary,(unsigned)getuid());
    if (length<0 || length>=(int)sizeof(prefix) || strncmp(scratch,prefix,(size_t)length)
        || strlen(scratch)!=(size_t)length+6) fail("private temporary path");
    for (const char *p=scratch+length;*p;p++)
        if (!((*p>='a' && *p<='z') || (*p>='A' && *p<='Z') || (*p>='0' && *p<='9'))) fail("private temporary path");
    int fd=open(scratch,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    struct stat info;
    if (fd<0 || fstat(fd,&info) || !S_ISDIR(info.st_mode) || info.st_uid!=getuid()
        || (info.st_mode&0777)!=0700) fail("private temporary directory");
    codex_private_acl(fd);
    close(fd);
}
