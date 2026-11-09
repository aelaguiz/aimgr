"""Task-owned offsite terminal for native job attach and real routine smoke.

Only the terminal UI is substituted. Execute the exact supplied AIM command,
retain private output, and stop on a human verification challenge. No browser
is opened and no provider response is rewritten.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

info = json.loads(Path(sys.argv[1]).read_text())
root = Path(info['root']).resolve()
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
assert os.getuid() != 0
assert str(root).startswith(('/opt/aimgr-state-audit/claude-implementation/', '/opt/aimgr-state-audit/rt166-', '/Users/ec2-user/verification/', '/home/aimdev/verification/'))
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(info['cwd'])
    os.environ.update(info.get('env', {}))
    os.environ['TERM'] = 'xterm-256color'
    os.execv(info['argv'][0], info['argv'])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
(root / 'pty-started.json').write_text(json.dumps({'pid': pid, 'startedAt': time.time()}))
deadline = time.monotonic() + 240
output = bytearray()
status = None
sent = 0
challenge = False

def pump(timeout):
    global challenge
    if not select.select([terminal], [], [], timeout)[0]:
        return
    try:
        data = os.read(terminal, 65536)
        if not data:
            return
        output.extend(data)
        with (root / 'terminal.private.log').open('ab') as log:
            log.write(data)
        del output[:-65536]
        text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', bytes(output)).lower()
        if any(word in text for word in [b'hcaptcha', b'recaptcha', b'verify you are human', b'human verification challenge']):
            challenge = True
            (root / 'HUMAN_VERIFICATION_CHALLENGE').write_text('Stop all provider work and discuss with user.\n')
        if b'\x1b[c' in data:
            os.write(terminal, b'\x1b[?1;2c')
        if b'\x1b]11;?' in data:
            os.write(terminal, b'\x1b]11;rgb:0000/0000/0000\x1b\\')
    except OSError as error:
        if error.errno != errno.EIO:
            raise

def interrupted(signum, frame):
    raise InterruptedError('Test terminal cancelled')

signal.signal(signal.SIGTERM, interrupted)

try:
    while time.monotonic() < deadline:
        pump(.05)
        if challenge:
            break
        file = root / 'terminal-input.jsonl'
        lines = file.read_text().splitlines() if file.exists() else []
        for line in lines[sent:]:
            value = json.loads(line)
            if isinstance(value, dict):
                if set(value) == {'paste'}:
                    assert isinstance(value['paste'], str)
                    os.write(terminal, b'\x1b[200~' + value['paste'].encode() + b'\x1b[201~')
                    until = time.monotonic() + .8
                    while time.monotonic() < until:
                        pump(.03)
                    os.write(terminal, b'\r')
                    sent += 1
                    continue
                # Native attach returns to its own agents picker on /exit.
                # A real Ctrl-C closes that picker; do not fake process exit.
                assert set(value) == {'raw'} and isinstance(value['raw'], str)
                os.write(terminal, value['raw'].encode())
                sent += 1
                continue
            for byte in value.encode():
                os.write(terminal, bytes([byte]))
                pump(.03)
            until = time.monotonic() + .8
            while time.monotonic() < until:
                pump(.03)
            os.write(terminal, b'\r')
            sent += 1
        found, result = os.waitpid(pid, os.WNOHANG)
        if found:
            status = os.waitstatus_to_exitcode(result)
            break
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGTERM)
            until = time.monotonic() + 5
            while time.monotonic() < until:
                pump(.05)
                found, result = os.waitpid(pid, os.WNOHANG)
                if found:
                    status = os.waitstatus_to_exitcode(result)
                    break
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                _, result = os.waitpid(pid, 0)
                status = os.waitstatus_to_exitcode(result)
        except ProcessLookupError:
            pass
    os.close(terminal)
    (root / 'pty-exit.json').write_text(json.dumps({'exit': status, 'challenge': challenge, 'commandsSent': sent}))
