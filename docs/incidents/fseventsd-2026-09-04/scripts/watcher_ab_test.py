#!/usr/bin/env python3
"""One bounded Colima inotify-helper test; always attempts original helper restoration."""
import datetime
import json
import pathlib
import subprocess
import sys
import time

ROOT=pathlib.Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'evidence'
PROFILE='play-poker-codex'
ORIGINAL_PID=28737
START=['colima','daemon','start',PROFILE,'--inotify','--inotify-runtime','docker','--inotify-dir','/Users/aelaguiz/']
TIMELINE=EVIDENCE/'intervention-timeline.jsonl'

def record(event,**data):
    data={'at':datetime.datetime.now().astimezone().isoformat(),'event':event,**data}
    with TIMELINE.open('a') as f: f.write(json.dumps(data)+'\n')
    print(json.dumps(data),flush=True)

def command(args,timeout=70):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    record('command',args=args,returncode=p.returncode,stdout=p.stdout,stderr=p.stderr)
    return p

pidpath=pathlib.Path.home()/'.colima'/PROFILE/'daemon/daemon.pid'
assert int(pidpath.read_text().strip())==ORIGINAL_PID, 'Watcher PID changed; re-inventory first'
p=command(['ps','-p',str(ORIGINAL_PID),'-o','command='])
assert 'colima daemon start play-poker-codex --inotify --inotify-runtime docker --inotify-dir /Users/aelaguiz/' in p.stdout
assert '--vmnet' not in p.stdout, 'Helper includes networking; not safe for this test'
assert (EVIDENCE/'A1-watcher-running/summary.json').exists(), 'Baseline missing'
(EVIDENCE/'watcher-restore-command.json').write_text(json.dumps(START)+'\n')
record('test-begin',hypothesis='Colima file-notification helper contributes >=50% of fseventsd CPU')
stopped=False
try:
    p=command(['colima','daemon','stop',PROFILE])
    if p.returncode: raise RuntimeError('Helper stop failed; see receipt')
    stopped=True
    p=command(['ps','-p','28817','-o','pid=,comm='])
    assert p.returncode==0 and 'Virtualization' in p.stdout, 'VM not present'
    command(['docker','ps','--format','{{.ID}} {{.Names}} {{.Status}}'])
    p=subprocess.run([sys.executable,str(ROOT/'scripts/capture_window.py'),'B1-watcher-stopped','30'])
    assert p.returncode==0, 'Stopped-window capture failed'
finally:
    record('restore-begin',helperHadStopped=stopped)
    p=command(START)
    if p.returncode: raise RuntimeError('RESTORE FAILED: run saved restore command')
    time.sleep(12)
    p=command(['colima','daemon','status',PROFILE])
    assert p.returncode==0, 'Restored helper not running'
    command(['ps','-p','28817','-o','pid=,comm='])
    record('restore-complete',newHelperPid=pidpath.read_text().strip())
p=subprocess.run([sys.executable,str(ROOT/'scripts/capture_window.py'),'A2-watcher-restored','30'])
assert p.returncode==0, 'Restored-window capture failed'
record('test-complete')
