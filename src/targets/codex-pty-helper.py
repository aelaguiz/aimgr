#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


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


def main():
    master_fd = None
    child = None
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
                if child and child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
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
                    master_fd, slave_fd = pty.openpty()
                    set_winsize(slave_fd, cols, rows)
                    try:
                        child = subprocess.Popen(
                            [str(part) for part in argv],
                            stdin=slave_fd,
                            stdout=slave_fd,
                            stderr=slave_fd,
                            cwd=cwd,
                            env=env,
                            close_fds=True,
                            start_new_session=True,
                        )
                    except Exception as exc:
                        os.close(slave_fd)
                        os.close(master_fd)
                        master_fd = None
                        emit({"type": "error", "reason": "child_spawn_failed", "message": str(exc)})
                        return 1
                    os.close(slave_fd)
                    started = True
                    emit({"type": "ready", "pid": child.pid})
                elif msg_type == "input":
                    if master_fd is not None:
                        data = base64.b64decode(message.get("data") or "")
                        if data:
                            os.write(master_fd, data)
                elif msg_type == "resize":
                    if master_fd is not None:
                        set_winsize(master_fd, int(message.get("cols") or 120), int(message.get("rows") or 40))
                elif msg_type == "terminate":
                    if child and child.poll() is None:
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
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

        if child and child.poll() is not None:
            code = child.returncode
            exit_code = code if code >= 0 else None
            sig = signal.Signals(-code).name if code < 0 else None
            emit({"type": "exit", "exitCode": exit_code, "signal": sig})
            return 0

    if child:
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=1)
        code = child.returncode
        exit_code = code if code >= 0 else None
        sig = signal.Signals(-code).name if code < 0 else None
        emit({"type": "exit", "exitCode": exit_code, "signal": sig})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit({"type": "error", "reason": "helper_failed", "message": str(exc)})
        raise
