/* FD4 is the empty per-account/environment coordination inode, never a data
 * grant. Keep it through vendor exec and its native code-mode helper. Ordinary
 * tools may close it; their existing cgroup/GID route is independent of it. */
static int codex_assignment_lock(const char *account) {
    const char *key=strrchr(account,'/');
    const char *suffix="/accounts/openai-codex";
    size_t prefix=key?(size_t)(key-account):0,length=strlen(suffix);
    if (!key || strlen(key+1)!=64 || prefix<length
        || strncmp(account+prefix-length,suffix,length)) fail("assignment account path");
    for (const char *p=key+1;*p;p++) if (!((*p>='a' && *p<='f') || (*p>='0' && *p<='9'))) fail("assignment account identity");
    char expected[PATH_MAX];
    if (snprintf(expected,sizeof(expected),"%.*s/codex-egress/%s.json.lock",(int)(prefix-length),account,key+1)>=(int)sizeof(expected)) fail("assignment lock path");
    struct stat open,named;
    if (fstat(4,&open) || lstat(expected,&named) || !S_ISREG(open.st_mode)
        || !S_ISREG(named.st_mode) || open.st_uid!=getuid() || open.st_nlink!=1
        || (open.st_mode&077) || open.st_size || open.st_dev!=named.st_dev || open.st_ino!=named.st_ino
        || flock(4,LOCK_SH|LOCK_NB) || fcntl(4,F_SETFD,0)) fail("assignment lock ownership");
    codex_private_acl(4);
    return 4;
}
