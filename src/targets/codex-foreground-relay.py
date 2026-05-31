#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import threading
import time
import tty


CONTROL_IN_FD = 3
CONTROL_OUT_FD = 4
SNAPSHOT_LIMIT_BYTES = 256 * 1024
PTY_READ_BYTES = 4096


def close_fd(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        if written == 0:
            raise BrokenPipeError("short write")
        view = view[written:]


def set_winsize(fd, cols, rows):
    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def terminal_size():
    try:
        size = os.get_terminal_size(0)
        return size.columns, size.lines
    except OSError:
        return 120, 40


def decode_wait_status(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        signum = os.WTERMSIG(status)
        try:
            return None, signal.Signals(signum).name
        except ValueError:
            return None, f"SIG{signum}"
    return None, None


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
            close_fd(CONTROL_IN_FD)
            close_fd(CONTROL_OUT_FD)
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
                write_all(error_write_fd, payload + b"\n")
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
        message = json.loads(error_data.decode("utf-8", "replace").strip())
        raise RuntimeError(message.get("message") or "child spawn failed")
    return pid, master_fd


class GoalIntentDetector:
    def __init__(self, on_goal_intent):
        self.buffer = ""
        self.observed = False
        self.on_goal_intent = on_goal_intent

    def push(self, data):
        for byte in data:
            if byte in (0x0D, 0x0A):
                self.submit()
                self.buffer = ""
                continue
            if byte in (0x08, 0x7F):
                self.buffer = self.buffer[:-1]
                continue
            if byte == 0x1B or byte < 0x20:
                continue
            self.buffer += bytes([byte]).decode("utf-8", "ignore")
            if len(self.buffer) > 4096:
                self.buffer = self.buffer[-4096:]

    def submit(self):
        if self.observed:
            return
        candidate = self.buffer.strip()
        if candidate == "/goal" or candidate.startswith("/goal "):
            self.observed = True
            self.on_goal_intent(self.buffer)


class ForegroundRelay:
    def __init__(self):
        self.child_pid = None
        self.master_fd = None
        self.started = False
        self.stop_event = threading.Event()
        self.event_lock = threading.Lock()
        self.ring_lock = threading.Lock()
        self.master_write_lock = threading.Lock()
        self.control_buffer = b""
        self.snapshot_ring = bytearray()
        self.input_thread = None
        self.output_thread = None
        self.terminal_attrs = None
        self.exit_sent = False
        self.goal_detector = GoalIntentDetector(self.emit_goal_intent)

    def emit(self, message):
        payload = json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"
        with self.event_lock:
            try:
                write_all(CONTROL_OUT_FD, payload)
            except OSError:
                self.stop_event.set()

    def emit_goal_intent(self, line):
        self.emit({"type": "goal_intent", "line": line})

    def enter_raw_mode(self, require_tty):
        if require_tty and (not os.isatty(0) or not os.isatty(1)):
            raise RuntimeError("foreground relay requires TTY stdin/stdout")
        if not os.isatty(0):
            return
        self.terminal_attrs = termios.tcgetattr(0)
        tty.setraw(0, termios.TCSANOW)

    def restore_terminal(self):
        if self.terminal_attrs is None:
            return
        try:
            termios.tcsetattr(0, termios.TCSADRAIN, self.terminal_attrs)
        except termios.error:
            pass
        self.terminal_attrs = None

    def install_signal_handlers(self):
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, self.handle_shutdown_signal)
        if hasattr(signal, "SIGWINCH"):
            signal.signal(signal.SIGWINCH, self.handle_winch)

    def handle_shutdown_signal(self, _signum, _frame):
        self.stop_event.set()
        self.terminate_child(signal.SIGTERM)

    def handle_winch(self, _signum, _frame):
        if self.master_fd is None:
            return
        cols, rows = terminal_size()
        try:
            set_winsize(self.master_fd, cols, rows)
        except OSError:
            pass

    def append_snapshot(self, data):
        with self.ring_lock:
            self.snapshot_ring.extend(data)
            if len(self.snapshot_ring) > SNAPSHOT_LIMIT_BYTES:
                del self.snapshot_ring[: len(self.snapshot_ring) - SNAPSHOT_LIMIT_BYTES]

    def snapshot_text(self):
        with self.ring_lock:
            data = bytes(self.snapshot_ring)
        return data.decode("utf-8", "replace")

    def write_master(self, data):
        if self.master_fd is None or not data:
            return
        with self.master_write_lock:
            try:
                write_all(self.master_fd, data)
            except OSError as exc:
                self.emit({"type": "error", "reason": "pty_write_failed", "message": str(exc)})

    def input_pump(self):
        while not self.stop_event.is_set() and self.master_fd is not None:
            try:
                data = os.read(0, 65536)
            except InterruptedError:
                continue
            except OSError as exc:
                self.emit({"type": "error", "reason": "terminal_read_failed", "message": str(exc)})
                break
            if not data:
                break
            self.write_master(data)
            self.goal_detector.push(data)
        self.stop_event.set()
        self.terminate_child(signal.SIGTERM)

    def output_pump(self):
        while not self.stop_event.is_set() and self.master_fd is not None:
            try:
                data = os.read(self.master_fd, PTY_READ_BYTES)
            except InterruptedError:
                continue
            except OSError:
                break
            if not data:
                break
            try:
                write_all(1, data)
            except OSError as exc:
                self.emit({"type": "error", "reason": "terminal_write_failed", "message": str(exc)})
                self.stop_event.set()
                self.terminate_child(signal.SIGTERM)
                break
            self.append_snapshot(data)

    def start_child(self, message):
        if self.started:
            self.emit({"type": "error", "reason": "already_started", "message": "foreground relay already started"})
            return False
        argv = message.get("argv") or []
        if not argv:
            self.emit({"type": "error", "reason": "missing_argv", "message": "start.argv is required"})
            return False
        cwd = message.get("cwd") or os.getcwd()
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in (message.get("env") or {}).items()})
        cols = int(message.get("cols") or terminal_size()[0])
        rows = int(message.get("rows") or terminal_size()[1])
        require_tty = bool(message.get("requireTty", False))
        try:
            self.enter_raw_mode(require_tty)
        except Exception as exc:
            self.emit({"type": "error", "reason": "not_tty", "message": str(exc)})
            return False
        try:
            self.child_pid, self.master_fd = spawn_pty_child(argv, cwd, env, cols, rows)
        except Exception as exc:
            self.restore_terminal()
            self.emit({"type": "error", "reason": "child_spawn_failed", "message": str(exc)})
            return False

        self.started = True
        self.input_thread = threading.Thread(target=self.input_pump, name="foreground-relay-input", daemon=True)
        self.output_thread = threading.Thread(target=self.output_pump, name="foreground-relay-output", daemon=True)
        self.input_thread.start()
        self.output_thread.start()
        self.emit({"type": "ready", "pid": self.child_pid})
        return True

    def send_exit_sequence(self):
        for delay, data in ((0.0, b"\x1b"), (0.25, b"\x15"), (0.50, b"\x04"), (0.85, b"\x04")):
            if self.stop_event.is_set():
                return
            if delay:
                time.sleep(delay)
            self.write_master(data)

    def handle_command(self, message):
        msg_type = message.get("type")
        if msg_type == "start":
            self.start_child(message)
            return
        if msg_type == "send_input":
            self.write_master(base64.b64decode(message.get("data") or ""))
            return
        if msg_type == "send_enter":
            self.write_master(b"\r")
            return
        if msg_type == "send_exit":
            threading.Thread(target=self.send_exit_sequence, name="foreground-relay-exit", daemon=True).start()
            return
        if msg_type == "resize":
            if self.master_fd is not None:
                set_winsize(self.master_fd, int(message.get("cols") or 120), int(message.get("rows") or 40))
            return
        if msg_type == "snapshot":
            text = self.snapshot_text()
            self.emit({
                "type": "snapshot",
                "requestId": message.get("requestId"),
                "text": text,
                "bytes": len(text.encode("utf-8", "replace")),
            })
            return
        if msg_type == "terminate":
            self.terminate_child(signal.SIGTERM)
            return
        self.emit({"type": "error", "reason": "unknown_command", "message": str(msg_type)})

    def read_control(self):
        try:
            chunk = os.read(CONTROL_IN_FD, 65536)
        except InterruptedError:
            return True
        if not chunk:
            return False
        self.control_buffer += chunk
        while b"\n" in self.control_buffer:
            line, self.control_buffer = self.control_buffer.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except Exception as exc:
                self.emit({"type": "error", "reason": "protocol_parse_failed", "message": str(exc)})
                continue
            self.handle_command(message)
        return True

    def reap_child(self, wait=False):
        if not self.child_pid:
            return None
        flags = 0 if wait else os.WNOHANG
        try:
            pid, status = os.waitpid(self.child_pid, flags)
        except ChildProcessError:
            self.child_pid = None
            return None
        if pid == 0:
            return None
        self.child_pid = None
        return decode_wait_status(status)

    def emit_exit(self, exit_code, sig):
        if self.exit_sent:
            return
        self.exit_sent = True
        self.emit({"type": "exit", "exitCode": exit_code, "signal": sig})

    def terminate_child(self, sig):
        if not self.child_pid:
            return
        try:
            os.killpg(self.child_pid, sig)
        except ProcessLookupError:
            pass

    def cleanup_child(self):
        if not self.child_pid:
            return
        self.terminate_child(signal.SIGTERM)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            result = self.reap_child()
            if result is not None:
                self.emit_exit(*result)
                return
            time.sleep(0.05)
        self.terminate_child(signal.SIGKILL)
        result = self.reap_child(wait=True)
        if result is not None:
            self.emit_exit(*result)

    def close_master(self):
        if self.master_fd is None:
            return
        close_fd(self.master_fd)
        self.master_fd = None

    def run(self):
        self.install_signal_handlers()
        try:
            while not self.stop_event.is_set():
                ready, _, _ = select.select([CONTROL_IN_FD], [], [], 0.05)
                if CONTROL_IN_FD in ready:
                    if not self.read_control():
                        self.stop_event.set()
                        break
                result = self.reap_child()
                if result is not None:
                    self.stop_event.set()
                    self.emit_exit(*result)
                    break
        finally:
            self.stop_event.set()
            self.cleanup_child()
            self.close_master()
            self.restore_terminal()
            for thread in (self.input_thread, self.output_thread):
                if thread is not None:
                    thread.join(timeout=0.2)
        return 0


def main():
    relay = ForegroundRelay()
    return relay.run()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        try:
            payload = json.dumps({"type": "error", "reason": "helper_failed", "message": str(exc)}).encode("utf-8")
            write_all(CONTROL_OUT_FD, payload + b"\n")
        except Exception:
            pass
        raise
