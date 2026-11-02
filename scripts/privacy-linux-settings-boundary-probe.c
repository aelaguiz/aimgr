/* Synthetic payload run THROUGH the real Linux validator helper. No Claude
 * code or provider credentials are involved. The unsandboxed comparison must
 * demonstrate each access before its denial can count as evidence. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static bool reads(const char *file, const char *expected) {
  char data[128] = {0}; int fd = open(file, O_RDONLY);
  if (fd < 0) return false;
  ssize_t n = read(fd, data, sizeof(data)-1); close(fd);
  return n >= 0 && !strcmp(data, expected);
}
static bool writes(const char *file) {
  int fd = open(file, O_WRONLY|O_CREAT|O_TRUNC, 0600);
  if (fd < 0) return false;
  bool ok = write(fd, "SYNTHETIC_ALLOWED", 17) == 17; close(fd); return ok;
}
static const char *yes(bool b) { return b ? "true" : "false"; }
int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "--settings") || strcmp(argv[3], "doctor")) return 2;
  /* Inspect the inherited descriptor before opening anything that could reuse
   * its number. The harness reserves descriptor 9 for a synthetic private file. */
  bool descriptor = fcntl(9, F_GETFD) >= 0;
  char hidden[4096];
  if (snprintf(hidden, sizeof(hidden), "%s", argv[2]) >= (int)sizeof(hidden)) return 3;
  char *slash = strrchr(hidden, '/'); if (!slash) return 4;
  if (snprintf(slash + 1, sizeof(hidden) - (size_t)(slash + 1 - hidden), "hidden-canary")
      >= (int)(sizeof(hidden) - (size_t)(slash + 1 - hidden))) return 4;
  bool input_read = reads(argv[2], "SYNTHETIC_SETTINGS");
  bool input_write = writes(argv[2]);
  writes("replacement.json");
  bool input_replace = rename("replacement.json", argv[2]) == 0;
  bool input_rename = rename(argv[2], "renamed.json") == 0;
  if (input_rename) rename("renamed.json", argv[2]);
  bool input_unlink = unlink(argv[2]) == 0;
  bool private_read = reads(hidden, "SYNTHETIC_PRIVATE_CANARY");
  if (symlink(hidden, "escape-link")) return 5;
  bool link_read = reads("escape-link", "SYNTHETIC_PRIVATE_CANARY");
  bool private_write = writes(hidden);
  bool own = writes("allowed-file") && reads("allowed-file", "SYNTHETIC_ALLOWED");
  int fd = socket(AF_INET, SOCK_STREAM, 0); bool network = fd >= 0;
  if (fd >= 0) close(fd);
  bool shell = false; pid_t pid = fork();
  if (pid == 0) { execl("/bin/sh", "sh", "-c", "exit 0", NULL); _exit(77); }
  if (pid > 0) { int status; if (waitpid(pid, &status, 0) == pid) shell = WIFEXITED(status) && WEXITSTATUS(status) == 0; }
  /* ELF interpreter execution is necessarily admitted. It can also load a
   * readable ELF as data: never confuse direct exec denial with code isolation.
   * This child still inherits the same file, input and network restrictions. */
  bool loader_shell = false; pid = fork();
  if (pid == 0) {
#if defined(__x86_64__)
    execl("/lib64/ld-linux-x86-64.so.2", "ld-linux", "/bin/sh", "-c", "exit 0", NULL);
#elif defined(__aarch64__)
    execl("/lib/ld-linux-aarch64.so.1", "ld-linux", "/bin/sh", "-c", "exit 0", NULL);
#endif
    _exit(77);
  }
  if (pid > 0) { int status; if (waitpid(pid, &status, 0) == pid) loader_shell = WIFEXITED(status) && WEXITSTATUS(status) == 0; }
  printf("{\"privateRead\":%s,\"privateWrite\":%s,\"symlinkRead\":%s,\"allowedReadWrite\":%s,\"inputRead\":%s,\"inputWrite\":%s,\"inputReplace\":%s,\"inputRename\":%s,\"inputUnlink\":%s,\"networkSocket\":%s,\"shellExec\":%s,\"loaderShellExec\":%s,\"inheritedDescriptor\":%s,\"inheritedSecret\":%s}\n",
    yes(private_read), yes(private_write), yes(link_read), yes(own), yes(input_read), yes(input_write),
    yes(input_replace), yes(input_rename), yes(input_unlink), yes(network), yes(shell), yes(loader_shell), yes(descriptor), yes(getenv("SYNTHETIC_SECRET") != NULL));
  return 0;
}
