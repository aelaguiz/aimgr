#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def set_winsize(fd, cols, rows):
    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def read_line_buffer(buffer):
    if b"\n" not in buffer:
        return None, buffer
    line, rest = buffer.split(b"\n", 1)
    return line, rest


def decode_wait_status(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        return None, signal.Signals(os.WTERMSIG(status)).name
    return None


def reap_child(child_pid, wait=False):
    flags = 0 if wait else os.WNOHANG
    try:
        pid, status = os.waitpid(child_pid, flags)
    except ChildProcessError:
        return None
    if pid == 0:
        return None
    return decode_wait_status(status)


def wait_child(child_pid, timeout):
    deadline = time.monotonic() + timeout
    while True:
        result = reap_child(child_pid)
        if result is not None:
            return result
        if time.monotonic() >= deadline:
            raise TimeoutError("child did not exit before timeout")
        time.sleep(0.05)


def spawn_pty_child(argv, cwd, env, cols, rows):
    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, cols, rows)
    error_read_fd, error_write_fd = os.pipe()
    flags = fcntl.fcntl(error_write_fd, fcntl.F_GETFD)
    fcntl.fcntl(error_write_fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)
    pid = os.fork()

    if pid == 0:
        try:
            os.close(error_read_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            os.close(master_fd)
            os.chdir(cwd)
            os.execvpe(str(argv[0]), [str(part) for part in argv], env)
        except Exception as exc:
            try:
                payload = json.dumps({"reason": "child_spawn_failed", "message": str(exc)}).encode("utf-8")
                os.write(error_write_fd, payload + b"\n")
            except Exception:
                pass
            os._exit(127)

    os.close(slave_fd)
    os.close(error_write_fd)
    error_data = os.read(error_read_fd, 65536)
    os.close(error_read_fd)
    if error_data:
        os.close(master_fd)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        message = json.loads(error_data.decode("utf-8").strip())
        raise RuntimeError(message.get("message") or "child spawn failed")
    return pid, master_fd


def main():
    master_fd = None
    child_pid = None
    stdin_buffer = b""
    started = False

    while True:
        read_fds = [0]
        if master_fd is not None:
            read_fds.append(master_fd)
        ready, _, _ = select.select(read_fds, [], [], 0.1)

        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                if child_pid:
                    try:
                        os.killpg(child_pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                break
            stdin_buffer += chunk
            while True:
                line, stdin_buffer = read_line_buffer(stdin_buffer)
                if line is None:
                    break
                if not line.strip():
                    continue
                try:
                    message = json.loads(line.decode("utf-8"))
                except Exception as exc:
                    emit({"type": "error", "reason": "protocol_parse_failed", "message": str(exc)})
                    continue

                msg_type = message.get("type")
                if msg_type == "start":
                    if started:
                        emit({"type": "error", "reason": "already_started", "message": "PTY helper already started"})
                        continue
                    argv = message.get("argv") or []
                    if not argv:
                        emit({"type": "error", "reason": "missing_argv", "message": "start.argv is required"})
                        return 1
                    cwd = message.get("cwd") or os.getcwd()
                    env = os.environ.copy()
                    env.update({str(k): str(v) for k, v in (message.get("env") or {}).items()})
                    cols = int(message.get("cols") or 120)
                    rows = int(message.get("rows") or 40)
                    try:
                        child_pid, master_fd = spawn_pty_child(argv, cwd, env, cols, rows)
                    except Exception as exc:
                        master_fd = None
                        emit({"type": "error", "reason": "child_spawn_failed", "message": str(exc)})
                        return 1
                    started = True
                    emit({"type": "ready", "pid": child_pid})
                elif msg_type == "input":
                    if master_fd is not None:
                        data = base64.b64decode(message.get("data") or "")
                        if data:
                            os.write(master_fd, data)
                elif msg_type == "resize":
                    if master_fd is not None:
                        set_winsize(master_fd, int(message.get("cols") or 120), int(message.get("rows") or 40))
                elif msg_type == "terminate":
                    if child_pid:
                        try:
                            os.killpg(child_pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                else:
                    emit({"type": "error", "reason": "unknown_message", "message": str(msg_type)})

        if master_fd is not None and master_fd in ready:
            try:
                output = os.read(master_fd, 65536)
            except OSError:
                output = b""
            if output:
                emit({"type": "output", "data": base64.b64encode(output).decode("ascii")})

        if child_pid:
            result = reap_child(child_pid)
            if result is not None:
                exit_code, sig = result
                emit({"type": "exit", "exitCode": exit_code, "signal": sig})
                return 0

    if child_pid:
        try:
            exit_code, sig = wait_child(child_pid, 1)
        except TimeoutError:
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            exit_code, sig = wait_child(child_pid, 1)
        emit({"type": "exit", "exitCode": exit_code, "signal": sig})
        return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit({"type": "error", "reason": "helper_failed", "message": str(exc)})
        raise
