/* Match native macOS User-domain generic-password storage. Only new ordinary
 * MCP entries receive this explicit two-application ACL, atomically with data.
 * Existing entries and their access policy are never rewritten. */
#if defined(__APPLE__)
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdint.h>
#include <string.h>
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
int aim_mcp_create_native_access(const char *account,const unsigned char *value,size_t size,const char *vendor) {
    SecKeychainRef keychain=NULL;SecTrustedApplicationRef applications[2]={NULL,NULL};
    CFArrayRef trusted=NULL;SecAccessRef access=NULL;SecKeychainItemRef item=NULL;
    OSStatus status=errSecParam;
    if (size>UINT32_MAX || strlen(account)>UINT32_MAX) goto done;
    status=SecKeychainCopyDomainDefault(kSecPreferencesDomainUser,&keychain);if (status) goto done;
    status=SecTrustedApplicationCreateFromPath(NULL,&applications[0]);if (status) goto done;
    status=SecTrustedApplicationCreateFromPath(vendor,&applications[1]);if (status) goto done;
    trusted=CFArrayCreate(NULL,(const void **)applications,2,&kCFTypeArrayCallBacks);if (!trusted) { status=errSecAllocate;goto done; }
    status=SecAccessCreate(CFSTR("Codex MCP Credentials"),trusted,&access);if (status) goto done;
    const char *service="Codex MCP Credentials";
    SecKeychainAttribute attrs[]={{kSecServiceItemAttr,(UInt32)strlen(service),(void *)service},
        {kSecAccountItemAttr,(UInt32)strlen(account),(void *)account}};
    SecKeychainAttributeList attributes={2,attrs};
    status=SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass,&attributes,(UInt32)size,value,keychain,access,&item);
done:
    if (item) CFRelease(item);
    if (access) CFRelease(access);
    if (trusted) CFRelease(trusted);
    for (int i=0;i<2;i++) if (applications[i]) CFRelease(applications[i]);
    if (keychain) CFRelease(keychain);
    return status==errSecSuccess?0:status==errSecDuplicateItem?1:-1;
}
#pragma clang diagnostic pop
#endif
