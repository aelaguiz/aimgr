// Ordinary (not setuid) entrypoint. Preserve the caller's exact environment
// across Apple's protected Python interpreter and the identity helper. Both
// can strip DYLD_* on entry; normal tools must receive their original values.
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern char **environ;
int main(int argc, char **argv) {
    if (argc < 5 || strcmp(argv[3], "--")) return 125;
    // This unlinked descriptor crosses the protected interpreter without
    // altering unrelated variables or exposing them in argv/on-disk state.
    // The setuid helper restores it only after dropping privilege. Preserve
    // inherited descriptors too: Node IPC and user tools depend on them.
    // Regression: test/network/claude-native-macos.test.js (environment/FDs).
    FILE *environment = tmpfile();
    if (!environment) return 125;
    for (char **entry = environ; *entry; entry++) {
        size_t size = strlen(*entry) + 1;
        if (fwrite(*entry, 1, size, environment) != size) return 125;
    }
    if (fflush(environment) || fseek(environment, 0, SEEK_SET)) return 125;
    int fd = fileno(environment);
    if (fcntl(fd, F_SETFD, 0)) return 125;
    char descriptor[24];
    snprintf(descriptor, sizeof(descriptor), "%d", fd);
    char **args = calloc((size_t)argc + 6, sizeof(char *));
    if (!args) return 125;
    args[0] = "/usr/bin/python3";
    args[1] = "-I";
    args[2] = "/opt/aimgr-claude-proxy/darwin_proxy.py";
    args[3] = "run";
    args[4] = argv[1];
    args[5] = argv[2];
    args[6] = descriptor;
    for (int i = 3; i < argc; i++) args[i + 4] = argv[i];
    execv(args[0], args);
    return 125;
}
