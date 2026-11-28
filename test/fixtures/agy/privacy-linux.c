/* A synthetic stand-in for agy. All paths and data belong to the offsite test. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int condition, const char *check) {
    if (condition) return;
    fprintf(stderr, "Antigravity fixture failed: %s\n", check);
    exit(1);
}

static void join(char *path, const char *parent, const char *child) {
    int length = snprintf(path, PATH_MAX, "%s/%s", parent, child);
    require(length > 0 && length < PATH_MAX, "fixture path length");
}

static void expect_file(const char *path, const char *expected) {
    char actual[128] = {0};
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, path);
    ssize_t length = read(fd, actual, sizeof(actual) - 1);
    require(close(fd) == 0 && length == (ssize_t)strlen(expected) && !strcmp(actual, expected), path);
}

static void reject_file(const char *path) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd < 0 && (errno == EACCES || errno == EPERM), path);
}

static void write_canary(const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(fd >= 0, path);
    require(write(fd, "fixture\n", 8) == 8 && close(fd) == 0, path);
}

static int session_protocol(const char *home, const char *cwd) {
    const char *id = "f77b6850-814d-429a-978e-3e73bc464c27";
    char grant[PATH_MAX], line[8192];
    size_t length = strlen(home);
    int first = length > 7 && !strcmp(home + length - 7, "/a/home");
    join(grant, home, ".gemini/antigravity-cli/antigravity-oauth-token");
    expect_file(grant, first ? "synthetic-grant-a\n" : "synthetic-grant-b\n");
    require(fgets(line, sizeof(line), stdin) && strstr(line, "\"method\":\"initialize\""), "ACP initialize");
    puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":"
         "{\"auth\":{\"logout\":{}},\"sessionCapabilities\":{\"resume\":{}}}}}");
    fflush(stdout);
    require(fgets(line, sizeof(line), stdin) != NULL, "ACP operation");
    if (strstr(line, "\"method\":\"logout\"")) {
        require(unlink(grant) == 0, "native logout removed the selected fixture grant");
        puts("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}");
        return 0;
    }
    require(strstr(line, "\"method\":\"session/list\"") && strstr(line, cwd), "ACP list scoped to cwd");
    printf("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessions\":[");
    if (first) printf("{\"sessionId\":\"%s\",\"cwd\":\"%s\"}", id, cwd);
    puts("]}}");
    fflush(stdout);
    if (!fgets(line, sizeof(line), stdin)) return 0;
    require(first && strstr(line, "\"method\":\"session/resume\"") && strstr(line, id), "ACP exact selected session");
    printf("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"sessionId\":\"%s\"}}\n", id);
    fflush(stdout);
    require(fgets(line, sizeof(line), stdin) && strstr(line, "\"method\":\"session/prompt\"") && strstr(line, id), "ACP prompt after exact resume");
    printf("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"%s\","
           "\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"RESUME_OK\"}}}}\n", id);
    puts("{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"stopReason\":\"end_turn\"}}");
    return 0;
}

int main(int argc, char **argv) {
    const int acp = argc == 3 && !strcmp(argv[1], "acp") && !strcmp(argv[2], "--disable-telemetry");
    if (acp) {
        char workspace[PATH_MAX];
        const char *home = getenv("HOME");
        require(home && getcwd(workspace, sizeof(workspace)) && getuid() != 0 && geteuid() == getuid(), "native ACP sandbox context");
        return session_protocol(home, workspace);
    }
    require(argc == 3 && !strncmp(argv[1], "--print=", 8) && !strcmp(argv[2], "--disable-slash-commands"),
            "managed native arguments and slash command protection");
    const char *probe = argv[1] + 8;
    int second = !strcmp(probe, "b");
    int direct = !strcmp(probe, "direct");
    require(second || direct || !strcmp(probe, "a"), "fixture selector");
    require(getuid() != 0 && geteuid() == getuid() && getegid() == getgid(), "privilege drop");
    for (int fd = 3; fd < 32; fd++) {
        require(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "inherited file descriptor");
    }
    const char *ambient[] = {"GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ADC_AUTH",
                            "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HTTPS_PROXY",
                            "AIMGR_AGY_FIXTURE_AMBIENT"};
    for (size_t i = 0; i < sizeof(ambient) / sizeof(*ambient); i++) {
        require(getenv(ambient[i]) == NULL, ambient[i]);
    }
    const char *session_bus = getenv("DBUS_SESSION_BUS_ADDRESS"), *system_bus = getenv("DBUS_SYSTEM_BUS_ADDRESS");
    require(session_bus && !strcmp(session_bus, "unix:path=/dev/null") &&
            system_bus && !strcmp(system_bus, "unix:path=/dev/null"), "host D-Bus addresses and autolaunch");
    require(getenv("TERM") && !strcmp(getenv("TERM"), "xterm"), "terminal environment");
    require(getenv("PATH") && !strcmp(getenv("PATH"), "/usr/bin:/bin") &&
            getenv("BROWSER") && !strcmp(getenv("BROWSER"), "/usr/bin/true") &&
            getenv("AGY_CLI_DISABLE_AUTO_UPDATE") && !strcmp(getenv("AGY_CLI_DISABLE_AUTO_UPDATE"), "true"),
            "fixed executable path, browser and update settings");
    struct utsname identity;
    require(uname(&identity) == 0 && !strcmp(identity.nodename, "aim-agy"), "isolated hostname");

    char cwd[PATH_MAX], home[PATH_MAX], file[PATH_MAX], other_grant[PATH_MAX], ide_id[PATH_MAX];
    char aim_config[PATH_MAX], codex_grant[PATH_MAX], figma_grant[PATH_MAX];
    char codex_env[PATH_MAX], claude_state[PATH_MAX], own_grant[PATH_MAX], host_grant[PATH_MAX];
    require(getcwd(cwd, sizeof(cwd)) != NULL, "working directory");
    char *leaf = strrchr(cwd, '/');
    require(leaf && !strcmp(leaf, "/project"), "working directory preserved");
    *leaf = 0;
    join(home, cwd, second ? "home/.aimgr/agy/b/home" : "home/.aimgr/agy/a/home");
    require(getenv("HOME") && !strcmp(getenv("HOME"), home), "account HOME");
    join(own_grant, home, ".gemini/antigravity-cli/antigravity-oauth-token");
    expect_file(own_grant, second ? "synthetic-grant-b\n" : "synthetic-grant-a\n");
    join(file, home, ".gemini/antigravity-cli/installation_id");
    expect_file(file, second ? "synthetic-id-b\n" : "synthetic-id-a\n");
    join(other_grant, cwd, second ? "home/.aimgr/agy/a/home/.gemini/antigravity-cli/antigravity-oauth-token"
                                 : "home/.aimgr/agy/b/home/.gemini/antigravity-cli/antigravity-oauth-token");
    reject_file(other_grant);
    join(ide_id, cwd, "home/.gemini/antigravity-ide/installation_id");
    reject_file(ide_id);
    join(aim_config, cwd, "home/.aimgr/config.yaml");
    reject_file(aim_config);
    join(codex_grant, cwd, "home/.aimgr/accounts/fixture-auth");
    reject_file(codex_grant);
    join(figma_grant, cwd, "home/.aimgr/claude-integrations/figma/grant.json");
    reject_file(figma_grant);
    join(codex_env, cwd, "home/.codex/.env");
    reject_file(codex_env);
    join(claude_state, cwd, "home/.claude.json");
    reject_file(claude_state);
    join(host_grant, cwd, "home/.gemini/antigravity-cli/installation_id");
    reject_file(host_grant);
    join(file, cwd, "home/.config/antigravity/desktop-canary");
    reject_file(file);
    join(file, cwd, "home/host-canary");
    reject_file(file);
    reject_file("hidden-link");
    reject_file("dbus-link");
    reject_file("/etc/machine-id");
    expect_file("/etc/hosts", "127.0.0.1 localhost aim-agy\n::1 localhost ip6-localhost\n");

    expect_file("workspace-input", "synthetic-workspace\n");
    join(file, cwd, "extra/fixture-input");
    expect_file(file, "synthetic-working-directory\n");
    join(file, cwd, direct ? "extra/fixture-input" : "home/Downloads/fixture-input");
    expect_file(file, "synthetic-working-directory\n");
    join(file, cwd, direct ? "extra/direct-output" : second ? "home/Downloads/b-output" : "home/Downloads/a-output");
    write_canary(file);
    int image = open(argv[0], O_RDONLY | O_CLOEXEC);
    require(image >= 0 && close(image) == 0, "approved vendor image readable");
    require(strlen(argv[0]) < sizeof(home) && strrchr(argv[0], '/'), "approved vendor image path");
    strcpy(home, argv[0]);
    *strrchr(home, '/') = 0;
    join(file, home, "policy.json");
    int package_write = open(file, O_WRONLY | O_CLOEXEC);
    require(package_write < 0 && (errno == EACCES || errno == EPERM), "package cannot be written");

    pid_t child = fork();
    require(child >= 0, "ordinary tool fork");
    if (!child) {
        execl("/bin/sh", "sh", "-ec",
              "test \"$(cat workspace-input)\" = synthetic-workspace; "
              "for path in \"$@\"; do if cat \"$path\" >/dev/null 2>&1; then exit 1; fi; done; "
              "git --version >/dev/null; printf 'fixture\\n' > tool-output",
              "fixture-tool", own_grant, other_grant, ide_id, aim_config, codex_grant,
              figma_grant, codex_env, claude_state, host_grant, "dbus-link", (char *)NULL);
        _exit(127);
    }
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "ordinary shell, Git and workspace writes");
    fprintf(stdout, "Antigravity fixture passed (%s)\n", probe);
    return 39;
}
