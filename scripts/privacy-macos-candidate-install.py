#!/usr/bin/env python3
"""Install an exact test-authorized candidate into the offsite runtime tree.

No active selector and no normal-use approval is created. Production AIM's
normal-use admission must refuse this test-only manifest. This stages the
candidate to exercise its real native path/ownership checks without a bypass.
"""
import hashlib,json,os,platform,subprocess
from pathlib import Path
import sys
candidate_source = sys.argv[1] if len(sys.argv) == 2 else ''
assert len(candidate_source) == 64 and all(c in '0123456789abcdef' for c in candidate_source)
base=Path('/opt/aimgr-state-audit');work=base/'claude-implementation'
assert platform.system()=='Darwin' and os.getuid()!=0 and (base/'OFFSITE_AUDIT_HOST').is_file()
source=work/'repo/native/claude/approved_launch_macos.c';vendor=base/'bin/claude'
expected='64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f'
assert hashlib.sha256(vendor.read_bytes()).hexdigest()==expected
staging=work/'mac-candidate-staging';staging.mkdir(mode=0o700)
subprocess.run(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror',str(source),'-o',str(staging/'launcher')],check=True)
subprocess.run(['/usr/bin/codesign','--force','--sign','-','--options','runtime',str(staging/'launcher')],check=True,capture_output=True)
subprocess.run(['/usr/bin/clang','-std=c11','-O2','-Wall','-Wextra','-Werror',str(work/'repo/native/claude/security_shim.c'),'-o',str(staging/'security')],check=True)
policy={'schema':1,'platform':'darwin','arch':'arm64','testedKernelRelease':os.uname().release,'vendorCommit':'cd7ceb459c68','version':'2.1.316','mcpExecutableAliases':True,
        'scope':'offsite candidate tests only; no normal-use approval','sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest()}
(staging/'policy.json').write_text(json.dumps(policy,sort_keys=True)+'\n')
files={}
for name,file,role in [('claude',vendor,'vendor'),('launcher',staging/'launcher','launcher'),('policy.json',staging/'policy.json','policy'),('security',staging/'security','resource')]:
 files[name]={'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'size':file.stat().st_size,'executable':name!='policy.json','role':role}
inventory=[[name,files[name]['sha256'],files[name]['size'],files[name]['executable'],files[name]['role']] for name in sorted(files)]
artifact=hashlib.sha256(json.dumps(inventory,separators=(',',':')).encode()).hexdigest()
manifest={'schema':1,'platform':'darwin','arch':'arm64','version':'2.1.316','privacyAbi':'claude-privacy-v1',
 'candidateSourceSha256':candidate_source,'entrypoint':'claude','launcher':'launcher','policy':'policy.json','securityAdapter':'security','files':files,
 'approval':{'kind':'offsite-test','reference':'User-authorized implementation testing on designated rented Mac only; exact vendor digest in plan',
             'normalUseApproved':False}}
(staging/'approval.json').write_text(json.dumps(manifest,indent=2)+'\n')
root=Path('/opt/aimgr-claude-runtime/artifacts')/artifact
installer='''import os,shutil,sys
from pathlib import Path
staging,vendor,root=map(Path,sys.argv[1:])
assert os.geteuid()==0 and str(root).startswith('/opt/aimgr-claude-runtime/artifacts/')
root.mkdir(parents=True,mode=0o755)
for name,source in [('claude',vendor),('launcher',staging/'launcher'),('policy.json',staging/'policy.json'),('approval.json',staging/'approval.json'),('security',staging/'security')]:
 target=root/name;shutil.copyfile(source,target);os.chown(target,0,0);os.chmod(target,0o755 if name in ['claude','launcher','security'] else 0o644)
'''
subprocess.run(['sudo','-n','/usr/bin/python3','-I','-c',installer,str(staging),str(vendor),str(root)],check=True)
(staging/'installed.json').write_text(json.dumps({'artifactSet':artifact,'root':str(root),'manifest':manifest},indent=2)+'\n')
print(json.dumps({'artifactSet':artifact,'root':str(root),'testOnly':True}))
