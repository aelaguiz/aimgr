#!/usr/bin/env python3
"""Private lock descriptors survive Python and Node maintenance-parent death."""
import argparse,fcntl,json,os,signal,subprocess,tempfile,time
from pathlib import Path
assert os.getuid()!=0 and Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
p=argparse.ArgumentParser(); p.add_argument('--node',required=True); a=p.parse_args()
repo=Path(__file__).resolve().parents[2]; root=Path(tempfile.mkdtemp(prefix='aimgr-mcp-lock-life-'))
ready=root/'ready'; release=root/'release'; lock=root/'lock'; child=None
node=root/'owner.mjs'
node.write_text('import fs from "node:fs"; import { maintenanceCommands } from '+json.dumps((repo/'src/credentials/codex-mcp-maintenance-owner.js').as_uri())+';\n'
  +'const r=JSON.parse(fs.readFileSync(0,"utf8")); fs.writeFileSync('+json.dumps(str(root/'node-pid'))+',String(process.pid));\n'
  +'maintenanceCommands(r.lock_fds)("/usr/bin/python3",["-I","-c",'+json.dumps(
    'import pathlib,time,os; r=pathlib.Path('+repr(str(root))+'); (r/"ready").write_text(str(os.getpid()))\nwhile not (r/"release").exists(): time.sleep(.05)')+']); process.stdout.write("{}\\n");\n')
code='''
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('maintenance',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
r=json.loads(sys.argv[2]); o=m.Maintenance(r)
try: o.lock(m.Path(r['lock'])); o.owner('fixture')
finally: o.close()
'''
request=dict(node=a.node,owner_script=str(node),lock=str(lock))
parent=subprocess.Popen(['/usr/bin/python3','-I','-c',code,str(repo/'native/codex/mcp_maintenance.py'),json.dumps(request)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def wait_for(check):
 end=time.monotonic()+10
 while not check():
  if time.monotonic()>end: raise AssertionError('fixture phase timed out')
  time.sleep(.05)
def held():
 fd=os.open(lock,os.O_RDWR)
 try:
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return False
  except BlockingIOError: return True
 finally: os.close(fd)
try:
 wait_for(ready.exists); child=int(ready.read_text()); node_pid=int((root/'node-pid').read_text())
 assert held()
 parent.kill(); parent.wait(timeout=5)
 assert held(),'Node and its child must retain the lock after Python dies'
 os.kill(node_pid,signal.SIGKILL)
 assert held(),'the mutating grandchild must retain the lock after both parents die'
 release.touch(); wait_for(lambda:not held())
 print('PASS native maintenance lock survives Python and Node parent death until the inherited child exits')
finally:
 release.touch()
 if parent.poll() is None: parent.kill(); parent.wait(timeout=5)
