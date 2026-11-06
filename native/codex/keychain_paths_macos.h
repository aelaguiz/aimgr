/* Security.framework locates the User-domain default keychain before using
 * securityd. Discover paths only; never read items, unlock a store or prompt.
 * Link the Mac launcher with Security and CoreFoundation. */
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CommonCrypto/CommonDigest.h>
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

struct codex_keychain_paths {
    char preferences[PATH_MAX];
    char files[3][PATH_MAX];
    int count;
};
static void keychain_path(struct codex_keychain_paths *paths,const char *file,int metadata_only) {
    char physical[PATH_MAX];
    // A metadata counterpart is a fixed sibling of the canonical selected
    // database. Keep its lexical name even when it is a dangling symlink.
    const char *selected=!metadata_only && realpath(file,physical)?physical:file;
    if (!metadata_only) canonical_future(selected);
    for (int i=0;i<paths->count;i++) if (!strcmp(paths->files[i],selected)) return;
    if (paths->count>=3) fail("keychain path inventory");
    strlcpy(paths->files[paths->count++],selected,PATH_MAX);
}
static struct codex_keychain_paths keychain_paths(const char *user_home) {
    struct codex_keychain_paths paths={0};
    char home[PATH_MAX],preferences[PATH_MAX],selected[PATH_MAX],parent[PATH_MAX];
    const char *configured=getenv("HOME");
    if (!configured || !*configured) configured=user_home;
    if (!realpath(configured,home)) return paths;
    if (snprintf(preferences,sizeof(preferences),"%s/Library/Preferences/com.apple.security.plist",home)>=(int)sizeof(preferences)) fail("keychain preference path");
    if (!realpath(preferences,paths.preferences)) {
        *strrchr(preferences,'/')=0;
        if (realpath(preferences,parent)) {
            if (snprintf(paths.preferences,sizeof(paths.preferences),"%s/com.apple.security.plist",parent)>=(int)sizeof(paths.preferences))
                paths.preferences[0]=0;
        } else paths.preferences[0]=0;
    }
    SecKeychainRef keychain=NULL;
    OSStatus status=SecKeychainCopyDomainDefault(kSecPreferencesDomainUser,&keychain);
    if (status || !keychain) return paths; // Native reports unavailable MCP; unrelated work can start.
    UInt32 length=sizeof(selected);
    status=SecKeychainGetPath(keychain,&length,selected);
    CFRelease(keychain);
    if (status || !length || length>=sizeof(selected) || selected[0]!='/') return paths;
    selected[length]=0;
    keychain_path(&paths,selected,0);
    strlcpy(selected,paths.files[0],sizeof(selected));
    char directory[PATH_MAX];
    if (snprintf(directory,sizeof(directory),"%s/Library/Keychains/",home)>=(int)sizeof(directory)) fail("keychain directory path");
    // Apple's native User Keychains location probes the legacy and -db names.
    // A custom default outside that location receives only its selected path.
    if (!strncmp(selected,directory,strlen(directory))) {
        size_t size=strlen(selected);
        if (size>=12 && !strcmp(selected+size-12,".keychain-db")) {
            selected[size-3]=0;keychain_path(&paths,selected,1);
        } else if (size>=9 && !strcmp(selected+size-9,".keychain") && size+3<sizeof(selected)) {
            strcat(selected,"-db");keychain_path(&paths,selected,1);
        }
    }
    return paths;
}
static void keychain_metadata(FILE *out,const struct codex_keychain_paths *paths) {
    if (*paths->preferences) ancestors(out,paths->preferences);
    for (int i=0;i<paths->count;i++) {
        rule(out,"literal",paths->files[i]);ancestors(out,paths->files[i]);
    }
}
// The first path is Security.framework's selected User-domain database. Its
// legacy filename counterpart above needs metadata only. Apple's AtomicFile
// uses .fl plus the first four SHA-1 bytes of the database basename for its
// lock and <database>.sb-<nonce> for atomic replacement. Never grant the parent.
static void keychain_database_grants(FILE *out,const struct codex_keychain_paths *paths) {
    if (!paths->count) return;
    const char *file=paths->files[0],*name=strrchr(file,'/');
    if (!name || !name[1]) fail("keychain database path");
    unsigned char digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(name+1,(CC_LONG)strlen(name+1),digest);
    char lock[PATH_MAX];
    int size=snprintf(lock,sizeof(lock),"%.*s/.fl%02X%02X%02X%02X",(int)(name-file),file,
                      digest[0],digest[1],digest[2],digest[3]);
    if (size<0 || size>=(int)sizeof(lock)) fail("keychain lock path");
    rule(out,"literal",file);rule(out,"literal",lock);
    char pattern[PATH_MAX*2+128];size_t n=0;pattern[n++]='^';
    for (const char *p=file;*p;p++) {
        if (strchr("\\.^$|()[]{}*+?",*p)) pattern[n++]='\\';
        pattern[n++]=*p;
    }
    snprintf(pattern+n,sizeof(pattern)-n,"\\.sb-[A-Za-z0-9-]+$");
    rule(out,"regex",pattern);
}
#pragma clang diagnostic pop
