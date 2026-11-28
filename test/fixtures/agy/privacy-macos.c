/* Apply the production Seatbelt policy to a temporary synthetic home. */
#define main approved_launch
#include "../../../native/agy/approved_launch_macos.c"
#undef main
#include <sys/wait.h>

extern int sandbox_check(pid_t, const char *, int, ...);
enum { path_filter = 1 };

static void expect_access(const char *path, int allowed) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (allowed ? fd < 0 : fd >= 0 || (errno != EACCES && errno != EPERM)) {
        dprintf(2, "Unexpected fixture access for %s\n", path);
        exit(1);
    }
    if (fd >= 0) close(fd);
}

static void expect_directory_protected(const char *directory, int protected) {
    int denied = sandbox_check(getpid(), "file-write-unlink", path_filter, directory);
    if (denied != protected) {
        dprintf(2, "Unexpected fixture directory policy for %s: %d\n", directory, denied);
        exit(1);
    }
}

int main(int argc, char **argv) {
    if (argc != 8) return 2;
    const char *mode = argv[1], *home = argv[2], *aimgr = argv[3], *account = argv[4];
    const char *workspace = argv[5], *scratch = argv[6], *tool = argv[7];
    int vendor = !strcmp(mode, "vendor");
    int control = !strcmp(mode, "control");
    if (vendor) apply_policy(argv[0], argv[0], home, aimgr, account, workspace, scratch, NULL, 0, 9, 0);
    const char *protected_files[] = {
        ".aimgr/claude-integrations/figma/grant.json", ".aimgr/accounts/fixture-auth",
        ".gemini/antigravity-cli/installation_id", ".claude.json", ".codex/.env",
        ".pi/agent/auth.json", ".prime/agent/auth.json", ".openclaw/agents/fixture/agent/auth-profiles.json",
        ".hermes/profiles/fixture/auth.json"
    };
    char path[PATH_MAX];
    for (size_t i = 0; i < sizeof(protected_files) / sizeof(*protected_files); i++) {
        if (snprintf(path, sizeof(path), "%s/%s", home, protected_files[i]) >= (int)sizeof(path)) return 2;
        expect_access(path, control);
    }
    if (snprintf(path, sizeof(path), "%s/.gemini", home) >= (int)sizeof(path)) return 2;
    expect_directory_protected(path, !control);
    expect_directory_protected(aimgr, !control);
    expect_directory_protected(home, !control);
    if (snprintf(path, sizeof(path), "%s/.gemini/antigravity-cli/antigravity-oauth-token", account) >= (int)sizeof(path)) return 2;
    expect_access(path, vendor || control);
    if (snprintf(path, sizeof(path), "%s/fixture-input", workspace) >= (int)sizeof(path)) return 2;
    expect_access(path, 1);
    if (vendor) {
        pid_t child = fork();
        if (child < 0) return 1;
        if (!child) {
            execl(tool, tool, "tool", home, aimgr, account, workspace, scratch, tool, (char *)NULL);
            _exit(127);
        }
        int status;
        if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 1;
    }
    return 0;
}
