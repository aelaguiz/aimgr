#!/usr/bin/env python3
"""No-auth unchanged vendor inventory smoke on the isolated host only."""
import argparse,json,os,subprocess,tempfile,time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--helper',required=True); a=p.parse_args()
assert os.getuid()!=0 and Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
root=Path(tempfile.mkdtemp(prefix='aimgr-native-inventory-')); home=root/'home'; home.mkdir(mode=0o700)
(home/'config.toml').write_text('check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n')
env=dict(os.environ,CODEX_HOME=str(home),HOME=str(root))
with (root/'vendor.log').open('wb') as log:
 child=subprocess.Popen(['/opt/aimgr-state-audit/bin/codex','app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=log,stderr=log,env=env,cwd=root)
 try:
  for _ in range(30):
   assert child.poll() is None,'synthetic native owner exited; private log retained'
   inventory=json.loads(subprocess.check_output([a.helper,'--inventory']))
   entry=next((v for v in inventory if v['pid']==child.pid),None)
   if entry: break
   time.sleep(.1)
  assert entry and not any(key in entry for key in ('environment', 'environment_visible', 'native_installer')), 'process inventory needs no environment values or installer classification'
  result=subprocess.run([a.helper,str(child.pid),entry['image'],entry['birth']],capture_output=True,text=True)
  assert result.returncode==125 and child.poll() is None,'read-only inventory must not signal the native owner'
  print('PASS: unchanged native app-server is identified; inventory has no process-stop operation')
 finally:
  if child.poll() is None: child.terminate(); child.wait(timeout=10)
