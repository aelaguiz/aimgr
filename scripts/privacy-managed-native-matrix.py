#!/usr/bin/env python3
"""Root-owned synthetic managed-policy cases on the two designated test hosts.

Linux requires a disposable mount/network namespace. Mac requires absent fixed
machine sources and restores that absence in finally. No credentials/network.
"""
import argparse, json, os, platform, plistlib, re, shutil, socket, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--run-name',default='managed-native-matrix-v3');p.add_argument('--case',action='append');args=p.parse_args()
assert re.fullmatch('[a-z0-9-]{1,48}',args.run_name)
base=Path('/opt/aimgr-state-audit'); work=base/'claude-implementation'
assert os.geteuid()==0 and (base/'OFFSITE_AUDIT_HOST').is_file()
mac=platform.system()=='Darwin'; user='ec2-user' if mac else 'aimdev'
assert mac or sorted(name for _,name in socket.if_nameindex())==['lo']
root=work/args.run_name;root.mkdir(mode=0o755)
machine=Path('/Library/Application Support/ClaudeCode') if mac else Path('/etc/claude-code')
if mac:
 assert not machine.exists()
 assert not Path('/Library/Managed Preferences/com.anthropic.claudecode.plist').exists()
 assert not Path('/Library/Managed Preferences/ec2-user/com.anthropic.claudecode.plist').exists()
 machine.mkdir(mode=0o755)
else:
 mounted=root/'machine'; mounted.mkdir(mode=0o755)
 subprocess.run(['mount','--bind',str(mounted),str(machine)],check=True)
node=str(work/'node-v22.16.0-darwin-arm64/bin/node') if mac else '/usr/bin/node'
command=[node,str(work/'repo/scripts/privacy-managed-validator-check.mjs'),'--machine-only']
if mac: command=['sudo','-n','-u',user,*command]
else: command=['runuser','-u',user,'--',*command]
safe={'disableRemoteControl':True,'env':{'DISABLE_GROWTHBOOK':'1'}}
other='linux' if mac else 'macos'; current='macos' if mac else 'linux'
cases=[
 ('absent',None,True,None),
 ('safe',safe,True,None),
 ('native-env-coercion',{'env':{'DISABLE_GROWTHBOOK':1}},True,None),
 ('static-only',{'policyHelpers':{current:{'defaultSettings':safe}}},True,None),
 ('safe-invalid-flag',safe,False,'machine-policy-validation'),
 ('static-invalid-flag',{'policyHelpers':{current:{'defaultSettings':safe}}},False,'machine-policy-validation'),
 ('invalid-model',{'model':{}},False,'machine-policy-validation'),
 ('invalid-off-platform-static',{'policyHelpers':{current:{'defaultSettings':safe},other:{'defaultSettings':{'model':{}}}}},False,'machine-policy-validation'),
 ('org-pin-before-static',{'forceLoginOrgUUID':'fixture-org','policyHelpers':{'default':safe}},False,'source-admission'),
 ('literal-token-false',{'env':{'ANTHROPIC_AUTH_TOKEN':'false'}},False,'source-admission'),
 ('static-over-invalid-unrelated-base',{'model':{},'policyHelpers':{'default':safe}},True,None),
 ('ignored-dot-and-directory',safe,True,None),
 ('immutable-leaf-symlink',safe,True,None),
]
for kind in ['malformed','remote']:
 cases.extend([(f'safe-invalid-{kind}',safe,False,'machine-policy-validation'),
  (f'static-invalid-{kind}',{'policyHelpers':{current:{'defaultSettings':safe}}},False,'machine-policy-validation')])
# Native's env schema stringifies objects rather than rejecting them. This
# bypasses the composer deliberately; real preparation overwrites critical
# fields with exact strings. Acceptance is a parser control, not safe launch.
cases.extend([(name,document,True,None) for name,document in [
 ('safe-env-object-coercion',safe),
 ('static-env-object-coercion',{'policyHelpers':{current:{'defaultSettings':safe}}})]])
if mac:
 cases.extend([(name,None,True,None) for name in ['user-plist','device-plist','empty-user-plist','safe-user-plist','large-raw-plist']])
if args.case:cases=[case for case in cases if case[0] in args.case]
assert cases
created=[]
preferences=[]
def preference(file,value,large=False):
 parents=[];parent=file.parent
 while not parent.exists():parents.append(parent);parent=parent.parent
 for parent in reversed(parents):parent.mkdir(mode=0o755);created.append(parent)
 assert not file.exists()
 raw=plistlib.dumps(value)
 if large:raw=raw.replace(b'<plist ',b'<!--'+b'x'*(3*1024*1024)+b'-->\n<plist ',1)
 file.write_bytes(raw);file.chmod(0o644);preferences.append(file)
report={'platform':platform.system(),'scope':'Native managed-policy admission/validation only; no account or full launcher acceptance','cases':[]}
try:
 for name,document,accepted,phase in cases:
  for file in preferences:file.unlink()
  preferences.clear()
  for item in machine.iterdir():
   if item.is_dir() and not item.is_symlink(): shutil.rmtree(item)
   else:item.unlink()
  target=machine/'managed-settings.json'
  if document is not None:
   target.write_text(json.dumps(document)); target.chmod(0o644)
  if name=='ignored-dot-and-directory':
   drop=machine/'managed-settings.d';drop.mkdir(mode=0o755)
   (drop/'.ignored.json').write_text('malformed synthetic content');(drop/'ignored.json').mkdir()
  if name=='immutable-leaf-symlink':
   external=machine/'external-policy-source';external.write_text(json.dumps(safe));external.chmod(0o644)
   target.unlink();target.symlink_to(external)
  if name.endswith('plist'):
   u=Path('/Library/Managed Preferences/ec2-user/com.anthropic.claudecode.plist')
   d=Path('/Library/Managed Preferences/com.anthropic.claudecode.plist')
   if name=='device-plist':preference(d,safe)
   elif name in ['empty-user-plist','safe-user-plist']:
    preference(u,{} if name=='empty-user-plist' else safe);preference(d,{'env':{'DISABLE_GROWTHBOOK':'0'}})
   else:preference(u,safe,large=name=='large-raw-plist')
  extra=['--invalid-flag'] if name.endswith('invalid-flag') else []
  if name.endswith('env-object-coercion'):extra=['--invalid-kind=env']
  for kind in ['malformed','remote','env']:
   if name.endswith('invalid-'+kind):extra=['--invalid-kind='+kind]
  result=subprocess.run(command+extra,capture_output=True,text=True,timeout=40)
  (root/(name+'.private.txt')).write_text(result.stdout+result.stderr)
  row=json.loads(result.stdout) if result.returncode==0 else {'fixtureExit':result.returncode}
  row={'case':name,'expectedAccepted':accepted,**row}
  row['passed']=row.get('accepted')==accepted and (accepted or row.get('refusedAt')==phase)
  report['cases'].append(row)
  print(json.dumps(row),flush=True)
finally:
 for file in preferences:file.unlink()
 for parent in reversed(created):parent.rmdir()
 if mac:shutil.rmtree(machine)
 else:subprocess.run(['umount',str(machine)],check=True)
 report['passed']=len(report['cases'])==len(cases) and all(row['passed'] for row in report['cases'])
 (root/'result.json').write_text(json.dumps(report,indent=2)+'\n')
raise SystemExit(0 if report['passed'] else 1)
