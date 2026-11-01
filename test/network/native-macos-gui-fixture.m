// A synthetic window and clipboard only; never loads a user's application data.
#import <Cocoa/Cocoa.h>
int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(20, 20, 320, 180)
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"AIM synthetic proxy verification";
    [window orderFrontRegardless];
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
    if (!window.visible || window.windowNumber <= 0) return 1;
    NSPasteboard *board = [NSPasteboard generalPasteboard];
    [board clearContents];
    if (![board setString:@"AIM_CLIPBOARD_SYNTHETIC" forType:NSPasteboardTypeString]) return 2;
    if (![[board stringForType:NSPasteboardTypeString] isEqualToString:@"AIM_CLIPBOARD_SYNTHETIC"]) return 3;
    puts("{\"windowVisible\":true,\"clipboardRoundTrip\":true}");
    [window orderOut:nil];
    return 0;
  }
}
