/* Offsite synthetic controls for the exact doctor policy. This probe is loaded
 * before applying the policy; its executable lives inside VALIDATION_ROOT so
 * later demand paging does not test an unrelated interpreter installation. */
#include <arpa/inet.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <sandbox.h>
#include <servers/bootstrap.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* Exported by the tested libsandbox; absent from the public SDK header. The
 * production runtime must admit its OS/policy ABI rather than assuming this
 * private interface exists on an untested macOS version. */
extern int sandbox_init_with_parameters(const char *, uint64_t, const char *const *, char **);

static bool reads(const char *file, const char *expected) {
  char data[128] = {0}; int fd = open(file, O_RDONLY);
  if (fd < 0) return false;
  ssize_t n = read(fd, data, sizeof(data)-1); close(fd);
  return n >= 0 && strcmp(data, expected) == 0;
}
static bool writes(const char *file) {
  int fd = open(file, O_WRONLY|O_CREAT|O_TRUNC, 0600);
  if (fd < 0) return false;
  bool ok = write(fd, "SYNTHETIC_ALLOWED", 17) == 17; close(fd); return ok;
}
static const char *yes(bool b) { return b ? "true" : "false"; }
int main(int argc, char **argv) {
  if (argc != 6) return 2;
  char *allowed = argv[1], *root = argv[2];
  char settings[4096], replacement[4096], renamed[4096];
  snprintf(settings, sizeof(settings), "%s/input.json", root);
  snprintf(replacement, sizeof(replacement), "%s/replacement.json", allowed);
  snprintf(renamed, sizeof(renamed), "%s/renamed.json", allowed);
  FILE *input = fopen(argv[3], "r");
  if (!input) return 3;
  char policy[16384] = {0}; size_t size = fread(policy, 1, sizeof(policy)-1, input);
  if (!feof(input) || !size) return 4;
  fclose(input);
  if (!strcmp(argv[5], "restricted")) {
    const char *parameters[] = {"VALIDATION_ROOT", allowed, "SETTINGS_FILE", settings,
      "INPUT_DIRECTORY", root, "VALIDATION_CONTAINER", root, NULL}; char *error = NULL;
    if (sandbox_init_with_parameters(policy, 0, parameters, &error)) return 5;
  }
  char hidden[4096], link[4096], outside[4096], own[4096];
  snprintf(hidden, sizeof(hidden), "%s/hidden-canary", root);
  snprintf(link, sizeof(link), "%s/escape-link", allowed);
  snprintf(outside, sizeof(outside), "%s/outside-write", root);
  snprintf(own, sizeof(own), "%s/allowed-file", allowed);
  bool private_read = reads(hidden, "SYNTHETIC_PRIVATE_CANARY");
  bool link_read = reads(link, "SYNTHETIC_PRIVATE_CANARY");
  bool private_write = writes(outside);
  bool own_access = writes(own) && reads(own, "SYNTHETIC_ALLOWED");
  bool input_read = reads(settings, "SYNTHETIC_SETTINGS");
  bool input_write = writes(settings);
  writes(replacement);
  bool input_replace = rename(replacement, settings) == 0;
  bool input_rename = rename(settings, renamed) == 0;
  /* Restore only in the unrestricted control so unlink tests the same inode. */
  if (input_rename) rename(renamed, settings);
  bool input_unlink = unlink(settings) == 0;
  int fd = socket(AF_INET, SOCK_STREAM, 0); bool network = false;
  if (fd >= 0) {
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(atoi(argv[4]))};
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    network = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0; close(fd);
  }
  pid_t pid = fork(); bool shell = false;
  if (pid == 0) { execl("/bin/sh", "sh", "-c", "exit 0", NULL); _exit(77); }
  if (pid > 0) { int status; if (waitpid(pid, &status, 0) == pid) shell = WIFEXITED(status) && WEXITSTATUS(status) == 0; }
  mach_port_t port = MACH_PORT_NULL;
  bool security = bootstrap_look_up(bootstrap_port, "com.apple.securityd.xpc", &port) == KERN_SUCCESS;
  if (security) mach_port_deallocate(mach_task_self(), port);
  bool preferences = bootstrap_look_up(bootstrap_port, "com.apple.cfprefsd.daemon", &port) == KERN_SUCCESS;
  if (preferences) mach_port_deallocate(mach_task_self(), port);
  printf("{\"privateRead\":%s,\"symlinkRead\":%s,\"privateWrite\":%s,\"allowedReadWrite\":%s,\"inputRead\":%s,\"inputWrite\":%s,\"inputReplace\":%s,\"inputRename\":%s,\"inputUnlink\":%s,\"networkConnect\":%s,\"shellExec\":%s,\"serviceLookup\":{\"com.apple.securityd.xpc\":%s,\"com.apple.cfprefsd.daemon\":%s}}\n",
         yes(private_read), yes(link_read), yes(private_write), yes(own_access), yes(input_read), yes(input_write), yes(input_replace), yes(input_rename), yes(input_unlink), yes(network), yes(shell), yes(security), yes(preferences));
  return 0;
}
