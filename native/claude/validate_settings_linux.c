/* Isolated offline settings validation, not the interactive session sandbox.
 *
 * The trusted AIM caller first admits the immutable vendor and this helper,
 * creates an empty 0700 scratch directory and a separate immutable settings
 * file, and starts this program with a clean loader environment. No account
 * credential, proxy configuration, or inherited control descriptor belongs here.
 *
 * T08: native schema rejection discards the entire settings overlay. Doctor is
 * used only to validate the exact bytes, before a real session receives auth.
 * No-new-privileges is appropriate in this disposable child; applying it to the
 * real session would break the required nested AIM sudo route helpers (T17).
 *
 * Landlock grants selected vendor/system ELF loader execution, runtime/input reads and
 * scratch writes. Seccomp denies sockets and io_uring; network namespaces and a
 * privileged proxy installation are not required for ordinary-account checks.
 * There is no weaker fallback when the kernel cannot enforce these controls.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported settings-validator architecture
#endif
#define READS (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define MUTATIONS (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE)
#define HANDLED (READS | MUTATIONS | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK)

static void refuse(const char *stage) {
  /* Never print errno-derived paths, settings, environment or native output. */
  fprintf(stderr, "Claude settings validation refused: %s.\n", stage);
  exit(125);
}
static void allow_path(int ruleset, const char *path, uint64_t access, int optional) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (optional && errno == ENOENT) return;
    refuse("required runtime path unavailable");
  }
  struct stat info;
  if (fstat(fd, &info)) refuse("runtime path inspection failed");
  if (!S_ISDIR(info.st_mode)) access &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) refuse("filesystem rule installation failed");
  close(fd);
}
#define DENY_CALL(call) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##call, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void deny_network(void) {
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* x32 uses the same audit architecture with a different syscall namespace. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    DENY_CALL(socket), DENY_CALL(socketpair), DENY_CALL(connect),
    /* Node uses connected Unix socketpairs for private stdout/stderr. Bun
     * duplicates stdout and writes with sendto(..., NULL, 0), so an fd-number
     * allowance would still discard valid doctor output. All other inherited
     * fds are closed; sockets/connect/socketpair remain denied. Only a send on
     * an already-connected private output channel can therefore succeed.
     * Non-null destinations remain denied. T08 native Node-pipe regression. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendto, 0, 8),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[5])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    DENY_CALL(sendmsg), DENY_CALL(sendmmsg),
    /* io_uring can issue network I/O without another filtered socket syscall. */
    DENY_CALL(io_uring_setup), DENY_CALL(io_uring_enter), DENY_CALL(io_uring_register),
    DENY_CALL(ptrace), DENY_CALL(process_vm_readv), DENY_CALL(process_vm_writev),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = sizeof(code)/sizeof(code[0]), .filter = code};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) refuse("network restriction failed");
}
static void validate_output(int fd) {
  struct stat info;
  if (fstat(fd, &info)) refuse("output inspection failed");
  if (S_ISFIFO(info.st_mode) || S_ISREG(info.st_mode)) return;
  if (S_ISSOCK(info.st_mode)) {
    struct sockaddr_storage local, peer;
    socklen_t n = sizeof(local), m = sizeof(peer);
    if (!getsockname(fd, (struct sockaddr *)&local, &n) && local.ss_family == AF_UNIX
        && !getpeername(fd, (struct sockaddr *)&peer, &m) && peer.ss_family == AF_UNIX) return;
  }
  refuse("private output channels required");
}
static int within(const char *file, const char *directory) {
  size_t n = strlen(directory);
  return !strncmp(file, directory, n) && (file[n] == '/' || file[n] == '\0');
}
int main(int argc, char **argv) {
  int managed = argc >= 5 && !strcmp(argv[4],"managed");
  if ((!managed && argc != 4) || argc > 261 || getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) refuse("unprivileged invocation required");
  char *vendor = realpath(argv[1], NULL), *scratch = realpath(argv[2], NULL), *settings = realpath(argv[3], NULL);
  if (!vendor || !scratch || !settings || strcmp(vendor, argv[1]) || strcmp(scratch, argv[2]) || strcmp(settings, argv[3])) refuse("canonical input paths required");
  struct stat directory, input, binary;
  if (stat(scratch, &directory) || !S_ISDIR(directory.st_mode) || directory.st_uid != getuid() || (directory.st_mode & 0777) != 0700
      || stat(settings, &input) || !S_ISREG(input.st_mode) || input.st_nlink != 1 || input.st_size < 2 || input.st_size > 2097152
      || stat(vendor, &binary) || !S_ISREG(binary.st_mode) || (binary.st_mode & 06000) || access(vendor, X_OK)) refuse("invalid validation inputs");
  if (!strcmp(scratch, "/") || within(settings, scratch) || within(vendor, scratch)) refuse("immutable inputs overlap writable scratch");
  DIR *contents = opendir(scratch);
  if (!contents) refuse("scratch inspection failed");
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(contents))) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) refuse("empty scratch directory required");
  }
  if (errno) refuse("scratch inspection failed");
  closedir(contents);
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) refuse("Landlock ABI 3 or newer is required");
  struct landlock_ruleset_attr description = {.handled_access_fs = HANDLED};
  int ruleset = syscall(SYS_landlock_create_ruleset, &description, sizeof(description), 0);
  if (ruleset < 0) refuse("filesystem restriction unavailable");
  allow_path(ruleset, "/usr", READS, 0);
  allow_path(ruleset, "/lib", READS, 1);
  allow_path(ruleset, "/lib64", READS, 1);
  allow_path(ruleset, "/etc/ld.so.cache", READS, 1);
  allow_path(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
  allow_path(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0);
  allow_path(ruleset, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE, 0);
  allow_path(ruleset, vendor, LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 0);
  /* execve checks the ELF interpreter as well as the vendor inode. Grant only
   * the system loader for this admitted platform, not executable access to /usr.
   * File/network restrictions still apply if a process invokes it directly. */
#if defined(__x86_64__)
  allow_path(ruleset, "/lib64/ld-linux-x86-64.so.2", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 0);
#elif defined(__aarch64__)
  allow_path(ruleset, "/lib/ld-linux-aarch64.so.1", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 0);
#endif
  allow_path(ruleset, settings, LANDLOCK_ACCESS_FS_READ_FILE, 0);
  if (managed) {
    // The trusted caller has already admitted these immutable machine sources
    // and rejected executable policy helpers. This second pass must see native
    // policy, while the first snapshot-only pass excludes it (T08/T09).
    allow_path(ruleset, "/etc/claude-code", READS, 1);
    for (int i=5;i<argc;i++) allow_path(ruleset,argv[i],READS,0);
  }
  allow_path(ruleset, scratch, READS | MUTATIONS, 0);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(SYS_landlock_restrict_self, ruleset, 0)) refuse("filesystem restriction failed");
  close(ruleset);
  int null = open("/dev/null", O_RDONLY);
  if (null < 0 || dup2(null, STDIN_FILENO) < 0) refuse("stdin isolation failed");
  /* No inherited socket/file/IPC descriptor may bypass the path policy. The
   * trusted caller supplies only dedicated output pipes on stdout/stderr. */
  if (syscall(SYS_close_range, 3, ~0U, 0)) refuse("descriptor isolation failed");
  if (chdir(scratch) || clearenv()) refuse("environment isolation failed");
  const char *fixed[][2] = {{"PATH","/usr/bin:/bin"},{"TERM","dumb"},{"LANG","C.UTF-8"},{"NO_COLOR","1"},
    {"DISABLE_AUTOUPDATER","1"},{"DISABLE_UPDATES","1"},{"DISABLE_TELEMETRY","1"},{"DISABLE_ERROR_REPORTING","1"},{"DISABLE_GROWTHBOOK","1"}};
  for (size_t i = 0; i < sizeof(fixed)/sizeof(fixed[0]); ++i) if (setenv(fixed[i][0],fixed[i][1],1)) refuse("environment setup failed");
  const char *roots[] = {"HOME","CLAUDE_CONFIG_DIR","CLAUDE_SECURESTORAGE_CONFIG_DIR","TMPDIR","CLAUDE_CODE_TMPDIR"};
  for (size_t i = 0; i < sizeof(roots)/sizeof(roots[0]); ++i) if (setenv(roots[i],scratch,1)) refuse("private directory setup failed");
  /* Refuse inherited Internet sockets on stdout/stderr before permitting
   * Bun's connected-output sendto. The trusted caller creates these private
   * output channels; it must never pass an unrelated Unix service socket. */
  validate_output(STDOUT_FILENO);
  validate_output(STDERR_FILENO);
  deny_network();
  char *arguments[] = {vendor, "--settings", settings, "doctor", NULL};
  execve(vendor, arguments, environ);
  refuse("native validator could not start");
}
