"""Verify terminal restoration before the synthetic outer AIM exits."""
import errno,json,os,pty,select,signal,sys,termios,time
from pathlib import Path
value=json.loads(sys.argv[3]);home=Path(value['userHomeDir'])
assert str(home).startswith('/opt/aimgr-state-audit/claude-implementation/')
read_fd,write_fd=os.pipe();pid,terminal=pty.fork()
if pid==0:
    os.close(write_fd);os.read(read_fd,1);os.close(read_fd)
    os.execv(sys.argv[1],sys.argv[1:])
os.close(read_fd);original=termios.tcgetattr(terminal)
os.write(write_fd,b'1');os.close(write_fd)
raw=bytearray();deadline=time.time()+120;status=None
try:
    while time.time()<deadline:
        if (home/'control-tty-ready').exists() and not (home/'control-tty-checked').exists():
            restored=termios.tcgetattr(terminal)
            # Darwin sets transient PENDIN when raw mode returns to ICANON.
            # Compare all actual terminal controls; retain raw state below.
            expected=list(original);actual=list(restored)
            expected[3]&=~termios.PENDIN;actual[3]&=~termios.PENDIN
            good=actual==expected
            (home/'controls-termios.private.json').write_text(json.dumps({'before':original,'after':restored},default=lambda b:list(b)))
            (home/'control-tty-checked').write_text('ok' if good else 'terminal mismatch')
        if select.select([terminal],[],[],.05)[0]:
            try:raw.extend(os.read(terminal,65536))
            except OSError as error:
                if error.errno!=errno.EIO:raise
        found,status=os.waitpid(pid,os.WNOHANG)
        if found:break
    else:
        os.kill(pid,signal.SIGKILL);_,status=os.waitpid(pid,0)
        raise RuntimeError('native control PTY timed out')
finally:
    os.close(terminal);(home/'controls-terminal.private.txt').write_bytes(raw)
assert os.waitstatus_to_exitcode(status)==0,'native controls failed; inspect private terminal record'
assert (home/'control-tty-checked').read_text()=='ok'
print('SYNTHETIC_OK')
