// Installed setuid-root only by the macOS installer. Change the routing GID,
// retain the caller's UID and group access, then exec as that same caller.
// No command, interpreter, or caller-controlled code runs with elevated UID.
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>
#include <membership.h>
#include <uuid/uuid.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Apple's default header alias selects the directory-membership view. The
// limited POSIX variant captures the actual inherited kernel credentials.
extern int raw_getgroups(int, gid_t *) __asm("_getgroups");
// Darwin private SPI: retain memberd lookup using the caller's original UID.
extern int __initgroups(int, const gid_t *, uid_t);
extern char **environ;

static _Noreturn void fail(const char *reason) {
    dprintf(2, "Claude native proxy identity unavailable: %s. Stop affected work and repair before retrying.\n", reason);
    _exit(125);
}

static int member(uid_t uid, gid_t gid) {
    uuid_t user, group;
    int yes = 0;
    return mbr_uid_to_uuid(uid, user) == 0 && mbr_gid_to_uuid(gid, group) == 0
        && mbr_check_membership(user, group, &yes) == 0 && yes == 1;
}

static void add(gid_t *groups, int *count, gid_t gid) {
    for (int i = 0; i < *count; i++) if (groups[i] == gid) return;
    groups[(*count)++] = gid;
}

int main(int argc, char **argv) {
    if (argc < 6 || strcmp(argv[4], "--") || geteuid() != 0) fail("invalid installed helper invocation");
    for (const unsigned char *p = (const unsigned char *)argv[1]; *p; p++) {
        if (!(islower(*p) || isdigit(*p) || *p == '_' || *p == '-')) fail("invalid profile");
    }
    if (!*argv[1] || strlen(argv[1]) > 128) fail("invalid profile");
    char identity[256], lockpath[256], ready[256], failed[256];
    snprintf(identity, sizeof(identity), "/opt/aimgr-claude-proxy/%s.identity", argv[1]);
    snprintf(lockpath, sizeof(lockpath), "/opt/aimgr-claude-proxy/%s.lock", argv[1]);
    snprintf(ready, sizeof(ready), "/opt/aimgr-claude-proxy/%s-state/ready.json", argv[1]);
    snprintf(failed, sizeof(failed), "/opt/aimgr-claude-proxy/%s-state/failed", argv[1]);
    int lock = open(lockpath, O_RDONLY | O_NOFOLLOW);
    if (lock < 0 || flock(lock, LOCK_SH) != 0) fail("profile admission lock");
    if (access(ready, F_OK) != 0 || access(failed, F_OK) == 0) fail("proxy is stopped");
    int fd = open(identity, O_RDONLY | O_NOFOLLOW);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) || st.st_uid != 0 || (st.st_mode & 022) || !S_ISREG(st.st_mode)) fail("profile identity permissions");
    FILE *file = fdopen(fd, "r");
    unsigned int allowed_uid, profile_gid;
    if (!file || fscanf(file, "%u %u", &allowed_uid, &profile_gid) != 2) fail("profile identity format");
    fclose(file);
    uid_t uid = getuid();
    if (uid == 0 || uid != allowed_uid) fail("profile belongs to another user");
    gid_t inherited[16], groups[20];
    int inherited_count = raw_getgroups(16, inherited), count = 0;
    if (inherited_count < 0) fail("cannot read inherited groups");
    add(groups, &count, profile_gid);
    add(groups, &count, getgid());
    add(groups, &count, getegid());
    for (int i = 0; i < inherited_count; i++) add(groups, &count, inherited[i]);
    // Preserve every explicit group unless the 16-entry kernel limit requires
    // removing a positively verified memberd duplicate. Prefer everyone.
    while (count > 16) {
        int omit = -1;
        for (int i = 1; i < count; i++) {
            if (member(uid, groups[i])) {
                omit = i;
                if (groups[i] == 12) break;
            }
        }
        if (omit < 0) fail("inherited groups cannot be preserved within Darwin's credential limit");
        memmove(groups + omit, groups + omit + 1, (size_t)(count - omit - 1) * sizeof(gid_t));
        count--;
    }
    // R1/R5: real/effective/saved routing GIDs must agree; shells otherwise can
    // reset an effective-only GID and escape PF. Keep the original UID/memberd
    // access. Replacing __initgroups with setgroups loses directory membership.
    // Regressions: test/network/native-macos-groups-fixture.c and Mac matrix.
    if (__initgroups(count, groups, uid) || setgid(profile_gid) || setuid(uid)) fail("cannot preserve caller credentials");
    if (getuid() != uid || geteuid() != uid || getgid() != profile_gid || getegid() != profile_gid) fail("caller credential verification");
    // Restore caller-controlled environment only AFTER dropping all elevated
    // UID privileges. Inherited FDs/environment are normal workflow, not a way
    // to execute arbitrary code as root. See native-features/control fixtures.
    char *end;
    long environment_fd = strtol(argv[3], &end, 10);
    struct stat environment_stat;
    if (*end || environment_fd < 3 || environment_fd > 1024 || fstat((int)environment_fd, &environment_stat)
        || !S_ISREG(environment_stat.st_mode) || environment_stat.st_size < 0 || environment_stat.st_size > 16 * 1024 * 1024) fail("caller environment descriptor");
    size_t size = (size_t)environment_stat.st_size;
    char *buffer = calloc(size + 1, 1);
    char **restored = calloc(size + 1, sizeof(char *));
    if (!buffer || !restored || lseek((int)environment_fd, 0, SEEK_SET) < 0) fail("caller environment allocation");
    size_t offset = 0;
    while (offset < size) {
        ssize_t got = read((int)environment_fd, buffer + offset, size - offset);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) fail("caller environment read");
        offset += (size_t)got;
    }
    if (size && buffer[size - 1] != '\0') fail("caller environment format");
    int entries = 0;
    for (offset = 0; offset < size; offset += strlen(buffer + offset) + 1) restored[entries++] = buffer + offset;
    close((int)environment_fd);
    environ = restored;
    long notify = strtol(argv[2], &end, 10);
    if (*end || notify < 3 || notify > 1024 || write((int)notify, "1", 1) != 1) fail("launch admission handshake");
    close((int)notify);
    close(lock);
    execvp(argv[5], argv + 5);
    fail("cannot execute native command");
}
