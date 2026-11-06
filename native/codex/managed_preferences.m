/* Read only the actual forced preferences consumed by the admitted Codex.
 * Output goes to AIM's private pipe, never diagnostics or the vendor argv. */
#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
int main(void) {
    @autoreleasepool {
        CFStringRef domain = CFSTR("com.openai.codex");
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        for (NSString *name in @[@"config_toml_base64", @"requirements_toml_base64"]) {
            CFStringRef key = (__bridge CFStringRef)name;
            if (!CFPreferencesAppValueIsForced(key, domain)) continue;
            CFPropertyListRef value = CFPreferencesCopyAppValue(key, domain);
            if (!value || CFGetTypeID(value) != CFStringGetTypeID() || !CFPreferencesAppValueIsForced(key, domain)) {
                if (value) CFRelease(value);
                return 125;
            }
            NSString *text = (__bridge NSString *)value;
            if ([text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 2 * 1024 * 1024) { CFRelease(value); return 125; }
            result[name] = text;
            CFRelease(value);
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        if (!data || fwrite(data.bytes, 1, data.length, stdout) != data.length) return 125;
        return 0;
    }
}
