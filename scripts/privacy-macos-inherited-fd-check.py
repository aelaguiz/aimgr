#!/usr/bin/env python3
"""Observe final vendor FDs through ordinary and routed AIM on the rented Mac.

A direct-vendor control deliberately inherits FD 200. AIM's actual supervisor,
route/identity helpers and admitted native entry must close it and the private
unlinked environment transfer before the vendor makes a request. The observer
uses proc_pidpath to identify the exact image and lsof to inspect kernel handles;
it never substitutes a child shell or injects code into the vendor.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

work = Path('/opt/aimgr-state-audit/claude-implementation')
assert platform.system() == 'Darwin' and os.getuid() != 0
assert (work.parent / 'OFFSITE_AUDIT_HOST').is_file()
name = sys.argv[1]
assert name.isidentifier()
root = work / name
root.mkdir(mode=0o700)
repo = Path(__file__).resolve().parents[1]
installed = json.loads((work / 'mac-candidate-staging/installed.json').read_text())
package = Path(installed['root'])
node = sys.argv[2]
observer = r'''import ctypes,json,subprocess,sys
from pathlib import Path
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
rows=[];inode_file=Path(sys.argv[3]);inodes=json.loads(inode_file.read_text()) if inode_file.exists() else []
for raw in subprocess.check_output(['/bin/ps','-axo','pid='],text=True).split():
 pid=int(raw);buf=ctypes.create_string_buffer(4096)
 if lib.proc_pidpath(pid,buf,len(buf))<=0 or buf.value.decode()!=sys.argv[1]:continue
 scan=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',str(pid),'-F','fni'],capture_output=True,text=True)
 assert scan.returncode==0
 entries=[];entry={}
 for line in scan.stdout.splitlines():
  if line.startswith('f'):
   if entry:entries.append(entry)
   entry={'fd':line[1:]}
  elif line.startswith('i'):entry['inode']=line[1:]
  elif line.startswith('n'):entry['name']=line[1:]
 if entry:entries.append(entry)
 rows.append({'pid':pid,'canaryOpen':any(e.get('name')==sys.argv[2] for e in entries),
   'canaryFd200':any(e.get('fd')=='200' and e.get('name')==sys.argv[2] for e in entries),
   'privateEnvironmentOpen':any(e.get('inode') in inodes for e in entries),'transfersObserved':len(inodes)})
assert len(rows)==1,'Expected exactly one actual vendor'
print(json.dumps(rows[0]))
'''
source = (repo / 'scripts/privacy-claude-default-services-probe.py').read_text()
needle = '        requests.append(entry)'
assert source.count(needle) == 1
source = source.replace(needle, '''        if '/messages' in self.path:
            observed=subprocess.run(['sudo','-n','/usr/bin/python3','-I','-c',FD_OBSERVER,str(a.claude.resolve()),str(root/'inherited-canary'),str(root/'transfer-inodes.json')],capture_output=True,text=True,check=True)
            with (root/'fd-observations.jsonl').open('a') as f:f.write(observed.stdout)
''' + needle)
source = source.replace('class Mock(http.server.BaseHTTPRequestHandler):', 'FD_OBSERVER = '+repr(observer)+'\nclass Mock(http.server.BaseHTTPRequestHandler):', 1)
needle = '            child = subprocess.Popen(arguments,'
assert source.count(needle) == 1
source = source.replace(needle, '''            canary=root/'inherited-canary';canary.write_text('SYNTHETIC_INHERITED_FD')
            original=os.open(canary,os.O_RDONLY);os.dup2(original,200,inheritable=True);os.close(original)
''' + needle)
needle = 'pass_fds=(environment_transfer.fileno(),) if environment_transfer else ())'
assert source.count(needle) == 1
source = source.replace(needle, 'pass_fds=((environment_transfer.fileno(),200) if environment_transfer else (200,)))\n            os.close(200)')
fixture = root / 'default-services-fd.private.py'
fixture.write_text(source)
driver = (repo / 'scripts/privacy-integrated-launch-check.mjs').read_text()
driver = driver.replace('"../src/', '"'+repo.as_uri()+'/src/').replace('import { spawn }', 'import { spawn, execFileSync }')
needle = '      const child = spawn(command, args, options);'
assert driver.count(needle) == 1
# Preserve the production stdio mapping, especially its private environment FD.
# The only added input is a deliberate inherited canary at descriptor 200.
driver = driver.replace(needle, '''      const stdio = [...options.stdio];
      const transfer = fs.fstatSync(stdio[5]);
      assert.ok(transfer.isFile() && transfer.nlink === 0);
      const inodeFile = path.join(input.userHomeDir, '..', 'transfer-inodes.json');
      const parentFds = execFileSync('sudo', ['-n', '/usr/sbin/lsof', '-nP', '-a', '-p', String(process.pid), '-F', 'fi'], {encoding:'utf8'});
      assert.ok(parentFds.split('\\n').includes('i'+String(transfer.ino)), 'lsof must expose the actual unlinked transfer inode in its positive control');
      fs.writeFileSync(inodeFile, JSON.stringify([String(transfer.ino)]));
      fs.writeFileSync(path.join(input.userHomeDir, '..', 'transfer-observer-positive.json'), JSON.stringify({passed:true}));
      while (stdio.length <= 200) stdio.push('ignore');
      stdio[200] = 200;
      const child = spawn(command, args, { ...options, stdio });''')
(root / 'privacy-integrated-launch-check.mjs').write_text(driver)
rows = []
for mode in ['baseline', 'ordinary', 'protected']:
    target = work / (name+'_'+mode)
    case = 'api-key-telemetry-off' if mode=='baseline' else 'ordinary-pro-refresh-upgrade-disabled' if mode=='ordinary' else 'protected-pro-refresh-upgrade-disabled'
    args = ['/usr/bin/python3', str(fixture), '--root', str(target), '--claude', str(package/'claude'), '--node', node,
            '--privacy-mode', 'protected' if mode=='protected' else 'ordinary', '--case', case]
    if mode != 'baseline': args += ['--integrated-aim']
    if mode == 'protected': args += ['--routed-aim']
    result = subprocess.run(args,capture_output=True,text=True,timeout=180)
    (root/(mode+'.stdout.private.txt')).write_text(result.stdout)
    (root/(mode+'.stderr.private.txt')).write_text(result.stderr)
    assert result.returncode == 0, 'Fixture failed: '+mode
    report = json.loads((target/'observations.json').read_text())
    assert len(report['results'])==1 and report['results'][0]['exit']==0
    observations = [json.loads(line) for line in (target/'fd-observations.jsonl').read_text().splitlines()]
    assert observations and all(x['canaryOpen']==(mode=='baseline') and not x['privateEnvironmentOpen'] for x in observations)
    if mode=='baseline':assert all(x['canaryFd200'] for x in observations)
    else:
        assert all(x['transfersObserved']==1 for x in observations)
        assert json.loads((target/'transfer-observer-positive.json').read_text())['passed'] is True
    rows.append({'mode':mode,'passed':True,'actualNativeRoute':mode=='protected','requestObservations':len(observations),
                 'canaryOpen':mode=='baseline','privateEnvironmentOpen':False})
report={'passed':True,'artifactSet':installed['artifactSet'],'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'rows':rows}
(root/'result.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
