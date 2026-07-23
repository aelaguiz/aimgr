#include <errno.h>
#include <poll.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

#define MAX_STDIN_BYTES (1024U * 1024U)
#define INPUT_IDLE_TIMEOUT_MS 2000

static int equal(const char *left, const char *right) {
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static int nonempty(const char *value) {
    return value != NULL && value[0] != '\0';
}

static void wipe(volatile unsigned char *buffer, size_t length) {
    while (length > 0) {
        buffer[--length] = 0;
    }
}

static int drain_stdin(void) {
    unsigned char buffer[4096];
    size_t total = 0;
    for (;;) {
        struct pollfd descriptor = {
            .fd = STDIN_FILENO,
            .events = POLLIN | POLLHUP,
            .revents = 0,
        };
        int ready;
        do {
            ready = poll(&descriptor, 1, INPUT_IDLE_TIMEOUT_MS);
        } while (ready < 0 && errno == EINTR);
        if (ready <= 0 || (descriptor.revents & (POLLERR | POLLNVAL)) != 0) {
            wipe(buffer, sizeof(buffer));
            return -1;
        }
        ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (count > 0) {
            total += (size_t)count;
            wipe(buffer, (size_t)count);
            if (total > MAX_STDIN_BYTES) {
                wipe(buffer, sizeof(buffer));
                return -1;
            }
            continue;
        }
        wipe(buffer, sizeof(buffer));
        if (count == 0) {
            return 0;
        }
        if (errno == EINTR) {
            continue;
        }
        return -1;
    }
}

int main(int argc, char **argv) {
    if (argc == 7 && equal(argv[1], "find-generic-password") &&
        equal(argv[2], "-a") && nonempty(argv[3]) &&
        equal(argv[4], "-w") && equal(argv[5], "-s") &&
        nonempty(argv[6])) {
        return 44;
    }

    if (argc == 2 && equal(argv[1], "show-keychain-info")) {
        return 36;
    }

    if (argc == 2 && equal(argv[1], "-i")) {
        return drain_stdin() == 0 ? 1 : 74;
    }

    if (argc == 9 && equal(argv[1], "add-generic-password") &&
        equal(argv[2], "-U") && equal(argv[3], "-a") &&
        nonempty(argv[4]) && equal(argv[5], "-s") &&
        nonempty(argv[6]) && equal(argv[7], "-X") &&
        nonempty(argv[8])) {
        return 1;
    }

    if (argc == 6 && equal(argv[1], "delete-generic-password") &&
        equal(argv[2], "-a") && nonempty(argv[3]) &&
        equal(argv[4], "-s") && nonempty(argv[5])) {
        return 44;
    }

    if (argc >= 2 && equal(argv[1], "verify-cert")) {
        return 65;
    }

    return 64;
}
