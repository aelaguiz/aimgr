"""Check the native launcher's terminal cleanup without a Node parent reset."""
import json
import errno
import os
import pty
import signal
import sys
import termios

mode = sys.argv[1]
assert mode in ('hard-exit', 'background')
read_fd, write_fd = os.pipe()
pid, terminal = pty.fork()
if pid == 0:
    os.close(write_fd)
    os.read(read_fd, 1)
    os.close(read_fd)
    if mode == 'background':
        worker = os.fork()
        if worker == 0:
            os.setpgid(0, 0)
        else:
            _, status = os.waitpid(worker, os.WUNTRACED)
            if os.WIFSTOPPED(status):
                os.write(1, ('background job stopped by signal ' + str(os.WSTOPSIG(status))).encode())
                os.killpg(worker, signal.SIGKILL)
                os.waitpid(worker, 0)
                os._exit(98)
            os._exit(os.waitstatus_to_exitcode(status))
    os.execv(sys.argv[2], sys.argv[2:])

os.close(read_fd)
original = termios.tcgetattr(terminal)
os.write(write_fd, b'1')
os.close(write_fd)
_, status = os.waitpid(pid, 0)
restored = termios.tcgetattr(terminal)
output = bytearray()
while True:
    try:
        chunk = os.read(terminal, 65536)
        if not chunk:
            break
        output.extend(chunk)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
os.close(terminal)
expected = 137 if mode == 'hard-exit' else 0
assert os.waitstatus_to_exitcode(status) == expected, {"status": status, "output": output.decode(errors="replace")}
assert restored == original, {"original": original, "restored": restored}
print(json.dumps({"case": mode, "nativeExit": expected, "fullTerminalRestored": True, "backgroundJobStopped": False}))
