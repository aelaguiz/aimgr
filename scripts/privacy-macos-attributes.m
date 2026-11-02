// Compile and run only on the disposable rented Mac. This probe asks ordinary
// OS APIs whether host information remains accessible inside the candidate
// policy. It prints no serial number, UUID, hostname, hardware model or memory
// size. The UUID digest is private fixture output: the observer removes it from
// public results and exports only equality with the matched baseline.
// Accessibility is separate from evidence that a vendor uploads a value.
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#include <CommonCrypto/CommonDigest.h>
#include <mach/mach.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <uuid/uuid.h>
#include <errno.h>

static NSDictionary *namedSysctl(const char *name) {
    char value[2048] = {0}; size_t length = sizeof(value); errno = 0;
    int result = sysctlbyname(name, value, &length, NULL, 0);
    return @{ @"readable": @(result == 0 && length > 0), @"errno": @(result ? errno : 0) };
}

static NSString *privateDigest(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *text = [NSMutableString string];
    for (unsigned int i = 0; i < sizeof(digest); ++i) [text appendFormat:@"%02x", digest[i]];
    return text;
}

int main(void) {
    @autoreleasepool {
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        for (NSString *name in @[@"kern.hostname", @"kern.osproductversion", @"kern.osrelease",
                                 @"kern.osversion", @"kern.version", @"hw.model", @"hw.memsize"])
            result[name] = namedSysctl(name.UTF8String);
        int mib[] = { CTL_KERN, KERN_OSRELEASE }; char release[2048] = {0}; size_t length = sizeof(release);
        errno = 0; int rc = sysctl(mib, 2, release, &length, NULL, 0);
        result[@"numericSysctlRelease"] = @{ @"readable": @(rc == 0 && length > 1), @"errno": @(rc ? errno : 0) };
        struct utsname uts = {0}; rc = uname(&uts);
        // uname can partially populate its output and still return -1. Test
        // each buffer independently; overall failure is not proof of removal.
        result[@"uname"] = @{ @"success": @(rc == 0), @"releaseReadable": @(uts.release[0] != 0),
                               @"hostnameReadable": @(uts.nodename[0] != 0), @"machineReadable": @(uts.machine[0] != 0) };
        char hostname[1024] = {0}; errno = 0; rc = gethostname(hostname, sizeof(hostname));
        result[@"gethostname"] = @{ @"success": @(rc == 0), @"nonempty": @(hostname[0] != 0), @"errno": @(rc ? errno : 0) };
        uuid_t hostId = {0}; struct timespec timeout = {1, 0}; errno = 0;
        rc = gethostuuid(hostId, &timeout);
        result[@"gethostuuid"] = @{ @"readable": @(rc == 0 && !uuid_is_null(hostId)), @"errno": @(rc ? errno : 0) };
        if (rc == 0 && !uuid_is_null(hostId)) {
            result[@"privateHostUuidDigest"] = privateDigest([NSData dataWithBytes:hostId length:sizeof(hostId)]);
        }
        kernel_version_t kernel = {0};
        result[@"machKernelVersionReadable"] = @(host_kernel_version(mach_host_self(), kernel) == KERN_SUCCESS && kernel[0]);
        host_basic_info_data_t basic = {0}; mach_msg_type_number_t count = HOST_BASIC_INFO_COUNT;
        result[@"machHardwareInfoReadable"] = @(host_info(mach_host_self(), HOST_BASIC_INFO, (host_info_t)&basic, &count) == KERN_SUCCESS && basic.max_mem > 0);
        NSProcessInfo *info = NSProcessInfo.processInfo;
        NSOperatingSystemVersion os = info.operatingSystemVersion;
        result[@"foundationOSVersion"] = [NSString stringWithFormat:@"%ld.%ld.%ld", (long)os.majorVersion, (long)os.minorVersion, (long)os.patchVersion];
        result[@"foundationVersionStringReadable"] = @(info.operatingSystemVersionString.length > 0);
        result[@"foundationHostnameReadable"] = @(info.hostName.length > 0);
        result[@"privateFoundationHostnameDigest"] = privateDigest([info.hostName dataUsingEncoding:NSUTF8StringEncoding]);
        result[@"foundationHostnameIsLocalhost"] = @([info.hostName isEqualToString:@"localhost"]);
        result[@"systemVersionPlistReadable"] = @([NSData dataWithContentsOfFile:@"/System/Library/CoreServices/SystemVersion.plist"] != nil);
        io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"));
        result[@"iokitServiceFound"] = @(service != 0);
        for (NSString *name in @[@"IOPlatformUUID", @"IOPlatformSerialNumber"]) {
            CFTypeRef value = service ? IORegistryEntryCreateCFProperty(service, (__bridge CFStringRef)name, kCFAllocatorDefault, 0) : NULL;
            result[[name stringByAppendingString:@"DirectReadable"]] = @(value != NULL);
            if ([name isEqualToString:@"IOPlatformUUID"] && value && CFGetTypeID(value) == CFStringGetTypeID()) {
                char text[128]; uuid_t platformId;
                BOOL parsed = CFStringGetCString(value, text, sizeof(text), kCFStringEncodingUTF8) && uuid_parse(text, platformId) == 0;
                result[@"hostUuidMatchesPlatformUuid"] = @(parsed && uuid_compare(platformId, hostId) == 0);
            }
            if (value) CFRelease(value);
        }
        CFMutableDictionaryRef properties = NULL;
        kern_return_t propertiesStatus = service ? IORegistryEntryCreateCFProperties(service, &properties, kCFAllocatorDefault, 0) : KERN_FAILURE;
        result[@"iokitBulkSuccess"] = @(propertiesStatus == KERN_SUCCESS);
        for (NSString *name in @[@"IOPlatformUUID", @"IOPlatformSerialNumber"])
            result[[name stringByAppendingString:@"BulkReadable"]] = @(properties && CFDictionaryContainsKey(properties, (__bridge CFStringRef)name));
        if (properties) CFRelease(properties);
        if (service) IOObjectRelease(service);
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
        fwrite(data.bytes, 1, data.length, stdout); puts("");
    }
    return 0;
}
