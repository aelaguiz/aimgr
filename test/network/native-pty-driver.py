"""Drive an actual AIM/Claude interactive routine in a task-owned PTY."""
import errno
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import subprocess
import struct
import sys
import termios
import time

node, entry, info_path, final_path = sys.argv[1:]
pid, descriptor = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execv(node, [node, entry])

initial = termios.tcgetattr(descriptor)
fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
output = bytearray()
phase = 'initial'
first_stop = None
finished = False
approved_fixture_key = False
terminal_checked_before_aim_exit = False
deadline = time.monotonic() + 150
def pump(timeout):
    global approved_fixture_key
    if not select.select([descriptor], [], [], timeout)[0]:
        return
    try:
        chunk = os.read(descriptor, 65536)
        if chunk:
            output.extend(chunk)
            pathlib.Path(entry).with_suffix('.terminal.log').write_bytes(output)
            plain = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]', b'', bytes(output))
            if not approved_fixture_key and b'DetectedacustomAPIkey' in re.sub(rb'\s+', b'', plain):
                # This test owns the synthetic API key and its new profile.
                os.write(descriptor, b'\x1b[A\r')
                approved_fixture_key = True
    except OSError as error:
        if error.errno != errno.EIO:
            raise

def drain_for(duration):
    until = time.monotonic() + duration
    while time.monotonic() < until:
        pump(min(.02, max(0, until - time.monotonic())))

def enter(text):
    # Keep the PTY full duplex. If rendering fills its output queue, the TUI
    # blocks and later reads queued keystrokes together as a pasted multiline
    # value, even when this driver originally wrote each byte separately.
    for character in text:
        os.write(descriptor, bytes([character]))
        drain_for(.03)
    drain_for(1)
    os.write(descriptor, b'\r')

try:
    while time.monotonic() < deadline:
        pump(.05)
        try:
            info = json.loads(pathlib.Path(info_path).read_text())
            assert info['stdinTTY'] and info['stdoutTTY']
            receipt = json.loads(pathlib.Path(info['receiptPath']).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        # The worker can publish initialTurn=idle before the Stop hook's
        # lastTurn receipt lands. Wait for both observations rather than
        # racing that legitimate intermediate state.
        if phase == 'initial' and (receipt.get('initialTurn') or {}).get('status') == 'idle' and (receipt.get('lastTurn') or {}).get('endedAt'):
            first_stop = receipt['lastTurn']['endedAt']
            fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
            enter(b'Continue this same scheduled conversation. NATIVE_FOLLOWUP_CANARY.')
            phase = 'followup'
        elif phase == 'followup' and receipt.get('personJoinedAt') and (receipt.get('lastTurn') or {}).get('endedAt') not in (None, first_stop):
            first_stop = receipt['lastTurn']['endedAt']
            suffix = (' NATIVE_SCHEDULE_INTERRUPT_' + info['failure'].upper()) if info.get('failure') else ''
            enter(('Schedule the synthetic wakeup using ScheduleWakeup. NATIVE_SCHEDULE_REQUEST.' + suffix).encode())
            phase = 'scheduled'
        elif phase == 'scheduled' and pathlib.Path(info['cwd'], 'wakeup-proof.txt').exists() and 'NATIVE_WAKE_COMPLETED' in output.decode(errors='replace'):
            enter(b'/exit')
            phase = 'exit'
        if pathlib.Path(final_path).exists():
            final = json.loads(pathlib.Path(final_path).read_text())
            restored = termios.tcgetattr(descriptor)
            expected=list(initial);actual=list(restored)
            # Darwin marks queued input pending when ICANON is restored; this
            # transient state is not a terminal control and must not be flushed.
            if sys.platform == 'darwin':
                expected[3]&=~termios.PENDIN;actual[3]&=~termios.PENDIN
            assert actual == expected, {"initialAttributes": initial, "restoredAttributes": restored}
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if not done_pid:
                terminal_checked_before_aim_exit = True
                continue
            finished = True
            assert terminal_checked_before_aim_exit
            assert os.waitstatus_to_exitcode(status) == 0
            assert phase == ('scheduled' if info.get('failure') else 'exit'), phase
            print(json.dumps({'initialTurnCompleted': True, 'followupCompleted': True,
                              'nativeExit': final['interactiveTui']['exitCode'], 'terminalRestored': True, 'terminalCheckedBeforeAimExit': terminal_checked_before_aim_exit,
                              'sessionId': final['claude']['sessionId'], 'personJoinedAt': final['personJoinedAt'],
                              'outcome': final['outcome'], 'resizeRequested': True, 'inSessionScheduledWakeupCompleted': not bool(info.get('failure'))}))
            break
    else:
        raise RuntimeError('interactive routine timed out during ' + phase)
finally:
    pathlib.Path(entry).with_suffix('.terminal.log').write_bytes(output)
    if not finished:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        # A setuid admission helper may share this task-owned group. Drain the
        # whole group; never let a failed assertion hang on an unreaped child.
        subprocess.run(['sudo', '/bin/kill', '-KILL', '--', '-' + str(pid)], check=False, capture_output=True, timeout=5)
        for unused in range(50):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            time.sleep(.02)
        sys.stderr.write(output[-16000:].decode(errors='replace'))
    os.close(descriptor)
