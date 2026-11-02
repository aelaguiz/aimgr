#!/usr/bin/env python3
"""Exercise the candidate's actual executable-metadata admission with an ELF.
Does not launch Claude or alter any installed runtime file.
"""
import hashlib,json,os,shutil,struct,subprocess
from pathlib import Path
work=Path('/opt/aimgr-state-audit/claude-implementation')
assert os.geteuid()==0 and (work.parent/'OFFSITE_AUDIT_HOST').is_file()
root=work/'native-capability-check-v1';root.mkdir(mode=0o755)
source=work/'repo/native/claude/approved_launch_linux.c'
target=root/'synthetic-elf';shutil.copyfile('/usr/bin/true',target);target.chmod(0o755)
probe=root/'probe.c';probe.write_text('#define main original_entry_main\n#include '+json.dumps(str(source))+'\n#undef main\nint main(int argc,char **argv){if(argc!=2)return 3;immutable(argv[1],0);return 0;}\n')
subprocess.run(['/usr/bin/gcc','-O2','-Wall','-Wextra','-Werror',str(probe),'-o',str(root/'probe')],check=True)
command=['runuser','-u','aimdev','--',str(root/'probe'),str(target)]
def run():return subprocess.run(command,capture_output=True,text=True,timeout=10).returncode
before=hashlib.sha256(target.read_bytes()).hexdigest()
report={'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'plainExit':run()}
try:
 os.setxattr(target,'security.capability',struct.pack('<5I',0x02000001,1<<10,0,0,0))
 report['capabilityExit']=run()
 report['bytesUnchanged']=hashlib.sha256(target.read_bytes()).hexdigest()==before
 report['modeUnchanged']=target.stat().st_mode&0o7777==0o755
finally:
 os.removexattr(target,'security.capability')
report['restoredExit']=run()
report['passed']=report['plainExit']==0 and report['capabilityExit']==125 and report['restoredExit']==0 and report['bytesUnchanged'] and report['modeUnchanged']
(root/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)
