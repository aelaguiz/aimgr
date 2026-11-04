#!/usr/bin/env python3
"""Probe actual loaded-job disable semantics on the isolated Mac user domain."""
import os,plistlib,subprocess,tempfile,time,uuid
from pathlib import Path
assert os.getuid()!=0 and Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
root=Path(tempfile.mkdtemp(prefix='aimgr-launchd-maintenance-'))
label='test.aimgr.mcp-maintenance.'+uuid.uuid4().hex
domain=f'user/{os.getuid()}'; service=domain+'/'+label
plist=root/'job.plist'; tick=root/'tick'
plist.write_bytes(plistlib.dumps(dict(Label=label,ProgramArguments=['/usr/bin/touch',str(tick)],StartInterval=2,ThrottleInterval=1,
                                     LimitLoadToSessionType='Background')))
def ctl(*args,check=True): return subprocess.run(['/bin/launchctl',*args],capture_output=True,text=True,check=check)
loaded=False
try:
 ctl('bootstrap',domain,str(plist)); loaded=True
 end=time.monotonic()+8
 while not tick.exists() and time.monotonic()<end: time.sleep(.1)
 assert tick.exists(),'test job did not execute before disable'
 tick.unlink()
 end=time.monotonic()+8
 while not tick.exists() and time.monotonic()<end: time.sleep(.1)
 assert tick.exists(),'test job did not execute a second occurrence before disable'
 ctl('disable',service)
 listing=ctl('print-disabled',domain).stdout
 print('disabled_state='+next((l.split('=>',1)[1].strip() for l in listing.splitlines() if label in l),'absent'),flush=True)
 tick.unlink(); time.sleep(4)
 assert tick.exists(),'expected native loaded-job behavior changed; re-review schedule control'
 ctl('bootout',service); loaded=False
 tick.unlink(); time.sleep(4)
 assert not tick.exists(),'booted-out job still fired'
 ctl('enable',service)
 ctl('bootstrap',domain,str(plist)); loaded=True
 end=time.monotonic()+8
 while not tick.exists() and time.monotonic()<end: time.sleep(.1)
 assert tick.exists(),'enabled loaded job did not resume'
 print('PASS disable alone leaves loaded timer active; bootout pauses it and enable/bootstrap restores future starts',flush=True)
finally:
 if loaded: ctl('bootout',service,check=False)
 ctl('enable',service,check=False)
