#!/usr/bin/env python3
"""Paired OS API observations using the production native policy construction.

This is a policy-semantics test, not a replacement vendor or admitted bundle.
The generator copies the production policy-rendering block unchanged and binds
its process-path to the synthetic API probe image. A different image would
exercise the intentional tool exemption. Actual vendor captures are separate.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

work=Path('/opt/aimgr-state-audit/claude-implementation')
assert platform.system()=='Darwin' and os.getuid()!=0 and (work.parent/'OFFSITE_AUDIT_HOST').is_file()
name=sys.argv[1];assert name.isidentifier()
root=work/name;root.mkdir(mode=0o700)
repo=Path(__file__).resolve().parents[1]
source=repo/'native/claude/approved_launch_macos.c'
text=source.read_text()
start=text.index('    char *policy=NULL; size_t length=0; FILE *out=open_memstream(&policy,&length);')
end=text.index('    char *error=NULL;',start)
construction=text[start:end]
probe=root/'attributes';generator=root/'policy-generator'
subprocess.run(['/usr/bin/clang','-x','objective-c',str(repo/'scripts/privacy-macos-attributes.m'),'-framework','Foundation','-framework','IOKit','-o',str(probe)],check=True,capture_output=True)
for d in ['config','scratch']:(root/d).mkdir()
(root/'settings.json').write_text('{}')
installed=json.loads((work/'mac-candidate-staging/installed.json').read_text())
parameters={'vendor':str(probe),'self':str(Path(installed['root'])/'launcher'),'config':str(root/'config'),
            'settings':str(root/'settings.json'),'scratch':str(root/'scratch'),'config_lock':str(root/'config.lock'),
            'managed':'/Library/Application Support/ClaudeCode','system_preferences':'/Library/Managed Preferences/com.anthropic.claudecode.plist',
            'user_preferences':'/Library/Managed Preferences/ec2-user/com.anthropic.claudecode.plist'}
harness='#define main approved_entry_main\n#include '+json.dumps(str(source))+'\n#undef main\nint main(int argc,char **argv){\n'
harness+='if(argc!=2)return 2;int protected=!strcmp(argv[1],"protected"),validator=0,managed_validator=0,readcount=0,updatecount=0;\n'
harness+='const char *readroots[MAX_ROOTS]={0},*updateroots[MAX_ROOTS]={0},*executable_aliases[MAX_ROOTS]={0};\n'
for k,v in parameters.items():harness+='const char *'+k+'='+json.dumps(v)+';\n'
harness+=construction+'fwrite(policy,1,length,stdout);free(policy);return 0;}\n'
(root/'generator.c').write_text(harness)
subprocess.run(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror',str(root/'generator.c'),'-o',str(generator)],check=True)
rows={}
for mode in ['baseline','ordinary','protected']:
    cmd=[str(probe)]
    if mode!='baseline':
        policy=root/(mode+'.sb');policy.write_bytes(subprocess.check_output([str(generator),mode]))
        cmd=['/usr/bin/sandbox-exec','-f',str(policy),str(probe)]
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
    (root/(mode+'.stdout.private.json')).write_text(result.stdout)
    (root/(mode+'.stderr.private.txt')).write_text(result.stderr)
    assert result.returncode==0,mode
    rows[mode]=json.loads(result.stdout)
baseline,ordinary,protected=(rows[k] for k in ['baseline','ordinary','protected'])
checks={}
for key in ['kern.hostname','kern.osproductversion','kern.osrelease','kern.osversion','kern.version','hw.model','numericSysctlRelease','gethostuuid']:
    checks[key]=baseline[key]['readable'] and ordinary[key]['readable'] and not protected[key]['readable']
for key in ['machKernelVersionReadable','systemVersionPlistReadable','IOPlatformUUIDDirectReadable','IOPlatformUUIDBulkReadable']:
    checks[key]=baseline[key] and ordinary[key] and not protected[key]
for key in ['IOPlatformSerialNumberDirectReadable','IOPlatformSerialNumberBulkReadable']:
    # EC2 Mac images may omit serials independently of the sandbox.
    checks[key]=not protected[key] and (not baseline[key] or ordinary[key])
checks['unamePartialBuffers']=baseline['uname']['releaseReadable'] and baseline['uname']['hostnameReadable'] and not protected['uname']['releaseReadable'] and not protected['uname']['hostnameReadable']
checks['gethostname']=baseline['gethostname']['nonempty'] and not protected['gethostname']['nonempty']
# Foundation is a residual API, not a claimed denial. The reviewed vendor's
# automatic hostname path calls gethostname and returns "unknown" on failure;
# it does not call NSProcessInfo.hostName. Requiring this unrelated API to spell
# its fallback "localhost" would invent a requirement and hide the actual
# question: can a reviewed automatic collection path reach or transmit it?
# Retain the API observation separately; candidate inventory/capture review
# must establish that causal boundary. This receipt alone cannot establish it.
residuals={'foundationHostname': {
    'readable': protected['foundationHostnameReadable'],
    'equalsBaseline': baseline.get('privateFoundationHostnameDigest') == protected.get('privateFoundationHostnameDigest'),
    'isLiteralLocalhost': protected['foundationHostnameIsLocalhost'],
    'automaticCollectionReviewRequired': True}}
checks['foundationExactVersion']=baseline['foundationOSVersion']!=protected['foundationOSVersion']
report={'passed':all(checks.values()),'artifactSet':installed['artifactSet'],'productionSourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'policyConstructionSha256':hashlib.sha256(construction.encode()).hexdigest(),'processPathSubstitution':'synthetic API probe image','checks':checks,
        'scope':'Enforced API checks; residual APIs require separate vendor inventory and request review', 'residualAPIs':residuals,
        'observations':{k:{n:v for n,v in row.items() if not n.startswith('private')} for k,row in rows.items()}}
(root/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)
