#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SYSTEM_SECURITY_PATH
#define SYSTEM_SECURITY_PATH "/usr/bin/security"
#endif

#define MAX_STDIN_BYTES (1024U * 1024U)
#define INPUT_IDLE_TIMEOUT_MS 2000

static int equal(const char *left, const char *right) {
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static int lowercase_hex(char value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

static int exact_or_config_scoped_service(const char *service, const char *base) {
    size_t base_length;
    size_t service_length;

    if (service == NULL || base == NULL) {
        return 0;
    }
    if (equal(service, base)) {
        return 1;
    }
    base_length = strlen(base);
    service_length = strlen(service);
    if (service_length != base_length + 9U || service[base_length] != '-') {
        return 0;
    }
    for (size_t index = base_length + 1U; index < service_length; index++) {
        if (!lowercase_hex(service[index])) {
            return 0;
        }
    }
    return 1;
}

static int claude_credential_service(const char *service) {
    return exact_or_config_scoped_service(service, "Claude Code-credentials") ||
        exact_or_config_scoped_service(service, "Claude Code");
}

static void wipe(volatile unsigned char *buffer, size_t length) {
    while (length > 0U) {
        buffer[--length] = 0;
    }
}

static int read_stdin(unsigned char **result, size_t *result_length) {
    unsigned char *buffer = malloc(MAX_STDIN_BYTES + 1U);
    size_t length = 0U;

    if (buffer == NULL) {
        return -1;
    }
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
            wipe(buffer, MAX_STDIN_BYTES + 1U);
            free(buffer);
            return -1;
        }

        ssize_t count = read(STDIN_FILENO, buffer + length, MAX_STDIN_BYTES + 1U - length);
        if (count > 0) {
            length += (size_t)count;
            if (length > MAX_STDIN_BYTES) {
                wipe(buffer, MAX_STDIN_BYTES + 1U);
                free(buffer);
                return -1;
            }
            continue;
        }
        if (count == 0) {
            buffer[length] = '\0';
            *result = buffer;
            *result_length = length;
            return 0;
        }
        if (errno != EINTR) {
            wipe(buffer, MAX_STDIN_BYTES + 1U);
            free(buffer);
            return -1;
        }
    }
}

static int starts_with_operation(const char *script, const char *operation) {
    size_t operation_length = strlen(operation);
    return strncmp(script, operation, operation_length) == 0 &&
        (script[operation_length] == ' ' || script[operation_length] == '\t');
}

static int script_claude_credential_status(const unsigned char *input, size_t length) {
    const char *script = (const char *)input;
    const char *service_flag;
    const char *service_start;
    const char *service_end;
    char service[64];
    size_t service_length;
    int status;

    if (memchr(input, '\0', length) != NULL) {
        return 0;
    }
    while (*script == ' ' || *script == '\t' || *script == '\r' || *script == '\n') {
        script++;
    }
    if (starts_with_operation(script, "add-generic-password")) {
        status = 1;
    } else if (starts_with_operation(script, "find-generic-password") ||
        starts_with_operation(script, "delete-generic-password")) {
        status = 44;
    } else {
        return 0;
    }

    service_flag = strstr(script, " -s ");
    if (service_flag == NULL) {
        return 0;
    }
    service_start = service_flag + 4;
    if (*service_start == '"') {
        service_start++;
        service_end = strchr(service_start, '"');
    } else {
        service_end = strpbrk(service_start, " \t\r\n");
    }
    if (service_end == NULL) {
        service_end = script + strlen(script);
    }
    service_length = (size_t)(service_end - service_start);
    if (service_length == 0U || service_length >= sizeof(service)) {
        return 0;
    }
    memcpy(service, service_start, service_length);
    service[service_length] = '\0';
    return claude_credential_service(service) ? status : 0;
}

static int replay_to_system_security(int argc, char **argv, unsigned char *input, size_t length) {
    int descriptors[2];
    pid_t child;
    pid_t waited;
    int status;

    (void)argc;
    if (pipe(descriptors) != 0) {
        return 71;
    }
    child = fork();
    if (child == 0) {
        close(descriptors[1]);
        if (dup2(descriptors[0], STDIN_FILENO) < 0) {
            _exit(71);
        }
        close(descriptors[0]);
        argv[0] = (char *)SYSTEM_SECURITY_PATH;
        execv(SYSTEM_SECURITY_PATH, argv);
        _exit(71);
    }
    close(descriptors[0]);
    if (child < 0) {
        close(descriptors[1]);
        return 71;
    }

    signal(SIGPIPE, SIG_IGN);
    size_t written = 0U;
    while (written < length) {
        ssize_t count = write(descriptors[1], input + written, length - written);
        if (count > 0) {
            written += (size_t)count;
        } else if (count < 0 && errno == EINTR) {
            continue;
        } else {
            break;
        }
    }
    close(descriptors[1]);
    do {
        waited = waitpid(child, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited != child) {
        return 71;
    }
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 71;
}

static const char *service_argument(int argc, char **argv) {
    for (int index = 2; index + 1 < argc; index++) {
        if (equal(argv[index], "-s")) {
            return argv[index + 1];
        }
    }
    return NULL;
}

int main(int argc, char **argv) {
    const char *operation = argc > 1 ? argv[1] : NULL;
    const char *service = service_argument(argc, argv);

    if (claude_credential_service(service)) {
        if (equal(operation, "find-generic-password")) {
            return 44;
        }
        if (equal(operation, "add-generic-password")) {
            return 1;
        }
        if (equal(operation, "delete-generic-password")) {
            return 44;
        }
    }

    if (argc == 2 && equal(operation, "-i") && !isatty(STDIN_FILENO)) {
        unsigned char *input = NULL;
        size_t input_length = 0U;
        int intercepted_status;
        int delegated_status;

        if (read_stdin(&input, &input_length) != 0) {
            return 74;
        }
        intercepted_status = script_claude_credential_status(input, input_length);
        if (intercepted_status != 0) {
            wipe(input, input_length);
            free(input);
            return intercepted_status;
        }
        delegated_status = replay_to_system_security(argc, argv, input, input_length);
        wipe(input, input_length);
        free(input);
        return delegated_status;
    }

    argv[0] = (char *)SYSTEM_SECURITY_PATH;
    execv(SYSTEM_SECURITY_PATH, argv);
    return 71;
}
