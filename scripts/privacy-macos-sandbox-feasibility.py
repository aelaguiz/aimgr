#!/usr/bin/env python3
"""Research native Mac isolation without changing official vendor binaries.

Run only on the disposable offsite Mac with its independent outbound deny rule.
These profiles test read restrictions and selected system-information denials;
they are NOT production policies and do not close all IPC/host-service channels.
No personal homes, credentials or browser profiles are used. Native failures are
retained as compatibility findings, never retried outside the sandbox for work.
"""
import argparse
import json
from collections import Counter
import os
from pathlib import Path
import platform
import signal
import subprocess

BASE=Path('/opt/aimgr-state-audit')
parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=BASE/'mac-sandbox-feasibility');args=parser.parse_args()
ROOT=args.root.resolve()
if platform.system()!='Darwin' or not (BASE/'OFFSITE_AUDIT_HOST').is_file():
    raise SystemExit('Disposable offsite Mac required')
if ROOT.parent!=BASE or not ROOT.name.startswith('mac-sandbox-'):
    raise SystemExit('Dedicated sandbox fixture root required')
if ROOT.exists():raise SystemExit('Refusing reused research fixture')
ROOT.mkdir(mode=0o700)
private=ROOT/'private-host';private.mkdir()
secret=private/'identity.txt';secret.write_text('SYNTHETIC-HOST-IDENTITY\n')
shared=ROOT/'shared';shared.mkdir();(shared/'escape-link').symlink_to(secret)
safe_paths=['/System','/usr','/bin','/sbin','/dev','/private/etc','/etc',
            '/private/var/db/dyld','/Library/Apple',str(BASE/'bin'),str(BASE/'audit.py'),
            str(BASE/'OFFSITE_AUDIT_HOST'),str(ROOT/'models-files'),str(ROOT/'models-attributes'),
            str(shared)]
# The Apple Python/Git shims can select Command Line Tools outside /usr. Allow
# the installed toolchain, not all of /Library (which contains identity stores).
developer=subprocess.check_output(['/usr/bin/xcode-select','-p'],text=True).strip()
if developer and Path(developer).is_dir():safe_paths.append(developer)
safe_paths+=['/private/var/select/developer_dir','/var/select/developer_dir']
allowed='\n'.join('(subpath '+json.dumps(p)+')' for p in safe_paths)
# The loader also requires access to these exact traversal roots. Without them,
# even /usr/bin/true aborts before main on macOS 26.7. Add literal ancestors,
# never subpath / or subpath BASE, which would expose the hidden canary/home.
allowed+='\n'+'\n'.join('(literal '+json.dumps(p)+')' for p in [
    '/', '/opt','/private','/var','/private/var','/var/select','/private/var/select',
    '/Library','/Library/Developer',str(BASE),str(ROOT)])
file_policy='(version 1)\n(allow default)\n(deny file-read* (require-not (require-any\n'+allowed+'\n)))\n'
# Denial can remove a source or cause a failure; it does not synthesize a generic
# OS. Test the actual outputs and native requests instead of calling it spoofing.
attribute_denials='''(deny iokit-get-properties
  (iokit-property "IOPlatformUUID") (iokit-property "IOPlatformSerialNumber"))
(deny sysctl-read
  (sysctl-name "kern.hostname") (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion")
  (sysctl-name "kern.version") (sysctl-name "hw.model"))
(deny file-read* (literal "/System/Library/CoreServices/SystemVersion.plist"))
'''
profiles={}
for label,policy in [('files',file_policy),('attributes',file_policy+attribute_denials),
                     ('attributes-only','(version 1)\n(allow default)\n'+attribute_denials)]:
    path=ROOT/(label+'.sb');path.write_text(policy);profiles[label]=path

def run(command, profile=None, timeout=60):
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(shared),'TERM':'xterm-256color',
         'SYNTHETIC_AMBIENT_SECRET':'illustrates-sandbox-does-not-clean-environment'}
    argv=(['/usr/bin/sandbox-exec','-f',str(profile)] if profile else [])+command
    try:
        p=subprocess.Popen(argv,cwd=shared,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           text=True,start_new_session=True)
        out,err=p.communicate(timeout=timeout)
        return {'exitCode':p.returncode,'stdout':out,'stderr':err}
    except subprocess.TimeoutExpired:
        os.killpg(p.pid,signal.SIGTERM)
        try:out,err=p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()
        return {'exitCode':'timeout','stdout':out,'stderr':err}

probe=r'''
import json, os, pathlib, pty, subprocess
root=pathlib.Path(os.getcwd());hidden=root.parent/'private-host/identity.txt'
def readable(p):
    try:return pathlib.Path(p).read_text()
    except OSError:return None
child=subprocess.run(['/bin/cat',str(hidden)],capture_output=True,text=True)
(root/'edit.txt').write_text('shared worktree edit\n')
master,slave=pty.openpty();tty=os.isatty(slave);os.close(master);os.close(slave)
def cmd(argv):
    p=subprocess.run(argv,capture_output=True,text=True)
    return p.returncode,p.stdout
git=cmd(['/usr/bin/git','init','-q',str(root)])
uname=cmd(['/usr/bin/uname','-sr']);version=cmd(['/usr/bin/sw_vers','-productVersion'])
model=cmd(['/usr/sbin/sysctl','-n','hw.model'])
ioreg=cmd(['/usr/sbin/ioreg','-rd1','-c','IOPlatformExpertDevice'])
print(json.dumps({'privateFileHidden':readable(hidden) is None,
 'symlinkEscapeDenied':readable(root/'escape-link') is None,
 'childPrivateReadDenied':child.returncode!=0,'ptyWorks':tty,'gitInitWorks':git[0]==0,
 'ambientEnvironmentStillVisible':'SYNTHETIC_AMBIENT_SECRET' in os.environ,
 'uname':{'exitCode':uname[0],'value':uname[1].strip()},
 'osVersion':{'exitCode':version[0],'value':version[1].strip()},
 'hardwareModelReadable':model[0]==0 and bool(model[1].strip()),
 'platformUuidPropertyVisible':'"IOPlatformUUID"' in ioreg[1],
 'serialPropertyVisible':'"IOPlatformSerialNumber"' in ioreg[1]}))
'''
report={'platform':platform.platform(),'profiles':{},'meaning':'Bounded filesystem and selected attribute tests, not full workflow certification.'}
host_uuid_digests={}
# This tiny observer tests alternate API paths, not just command-line tools.
# Building it is also a native toolchain smoke test; vendor binaries stay intact.
compiled=run(['/usr/bin/xcrun','clang','-framework','Foundation','-framework','IOKit',
              str(BASE/'privacy-macos-attributes.m'),'-o',str(shared/'attributes')],timeout=90)
(ROOT/'attribute-build.private.json').write_text(json.dumps(compiled,indent=2)+'\n')
report['attributeProbeBuildExit']=compiled['exitCode']
for label,profile in [('baseline',None),*profiles.items()]:
    policy=run(['/usr/bin/true'],profile)
    p=run(['/usr/bin/python3','-c',probe],profile)
    (ROOT/(label+'-probe.private.json')).write_text(json.dumps(p,indent=2)+'\n')
    report['profiles'][label]={'policyLoadExit':policy['exitCode'],'probeExit':p['exitCode']}
    if policy['exitCode']!=0:report['profiles'][label]['policyError']=policy['stderr'][-1500:]
    if p['exitCode']==0:
        report['profiles'][label]['probe']=json.loads(p['stdout'])
    else:
        report['profiles'][label]['probeError']=p['stderr'][-1500:]
    if compiled['exitCode']==0:
        attributes=run([str(shared/'attributes')],profile)
        (ROOT/(label+'-attributes.private.json')).write_text(json.dumps(attributes,indent=2)+'\n')
        report['profiles'][label]['nativeAttributesExit']=attributes['exitCode']
        if attributes['exitCode']==0:
            value=json.loads(attributes['stdout'])
            host_uuid_digests[label]=value.pop('privateHostUuidDigest',None)
            # Newer probe revisions may add private comparison digests. Never
            # publish them just because the observer predates the new field.
            value={k:v for k,v in value.items() if not k.startswith('private')}
            value['sameHostUuidAsBaseline']=bool(host_uuid_digests[label] and host_uuid_digests[label]==host_uuid_digests.get('baseline'))
            report['profiles'][label]['nativeAttributes']=value
        else:report['profiles'][label]['nativeAttributesError']=attributes['stderr'][-1500:]
    # Keep the observer outside the tested boundary. A Python/toolchain probe
    # failure must not prevent testing the actual official binaries. Each child
    # enters the policy before exec; the mock and inventory remain independent.
    if policy['exitCode']==0:
        out=ROOT/('models-'+label)
        command=['/usr/bin/python3',str(BASE/'audit.py'),'--root',str(out),
                 '--codex',str(BASE/'bin/codex'),'--claude',str(BASE/'bin/claude'),'--private-claude-temp']
        if profile:command+=['--sandbox-profile',str(profile)]
        # The audit bounds each child's lifetime independently. Leave enough
        # time for all ten cases so the outer watchdog cannot strand children.
        p=run(command,timeout=500)
        (ROOT/(label+'-models.private.json')).write_text(json.dumps(p,indent=2)+'\n')
        cases=[]
        for path in sorted(out.glob('*.json')):
            obj=json.loads(path.read_text())
            if isinstance(obj,dict) and 'case' in obj:
                cases.append({k:obj[k] for k in ['case','exitCode','modelRequestCount','identifierHashes','diskIdentifierHash','userAgents']})
        summary_path=out/'summary.json'
        summary=json.loads(summary_path.read_text()) if summary_path.exists() else None
        report['profiles'][label].update(modelHarnessExit=p['exitCode'],modelCases=cases,
                                         identityChecks=summary.get('checks') if summary else None,
                                         allTenModelsPassed=p['exitCode']==0 and bool(summary and summary.get('allPassed'))
                                         and len(cases)==10 and all(c['exitCode']==0 and c['modelRequestCount']>0 for c in cases))
        if report['profiles'][label]['allTenModelsPassed']:
            workflow_root=out/'workflow'
            command=['/usr/bin/python3',str(BASE/'audit.py'),'--root',str(workflow_root),
                     '--codex',str(BASE/'bin/codex'),'--claude',str(BASE/'bin/claude'),
                     '--fresh-only','--exercise-tools','--private-canary',str(secret),'--private-claude-temp']
            if profile:command+=['--sandbox-profile',str(profile)]
            workflow=run(command,timeout=120)
            (ROOT/(label+'-workflow.private.json')).write_text(json.dumps(workflow,indent=2)+'\n')
            summary_path=workflow_root/'summary.json'
            w=json.loads(summary_path.read_text()) if summary_path.exists() else None
            report['profiles'][label]['workflow']={'harnessExit':workflow['exitCode'],
                'allPassed':workflow['exitCode']==0 and bool(w and w.get('allPassed')),'checks':w.get('checks') if w else None,
                'cases':[{k:r.get(k) for k in ['case','exitCode','modelRequestCount','workflow','toolOutputReturned','sharedEditObserved']} for r in w.get('results',[])] if w else []}
            expected_denial=label in ['files','attributes']
            rows=w.get('results',[]) if w else []
            report['profiles'][label]['workflow']['expectedPrivateReadBehaviorPassed']=(
                workflow['exitCode']==0 and len(rows)==2 and all(
                    (r.get('workflow') or {}).get('privateReadDenied') is expected_denial for r in rows))

# Use the existing audited loopback-only TLS fixture for a positive control and
# a matched denial. Its two fake desktop IDs must be captured outside Seatbelt;
# inside Seatbelt they must not reach that server. Other doctor failures stay
# recorded: suppressing a request alone does not certify doctor functionality.
doctor_profile=ROOT/'doctor.sb'
doctor_profile.write_text('(version 1)\n(allow default)\n(deny file-read* (regex #".*/Library/Application Support/com[.]openai[.]codex/production-appcast-bootstrap[.]json$"))\n')
report['doctor']={}
for label,profile in [('baseline',None),('deny-desktop-file',doctor_profile)]:
    out=ROOT/('doctor-'+label)
    p=run(['/usr/bin/python3',str(BASE/'doctor.py'),'--root',str(out),'--codex',str(BASE/'bin/codex')],profile,120)
    result=out/'doctor-result.json'
    report['doctor'][label]={'harnessExit':p['exitCode'],'result':json.loads(result.read_text()) if result.exists() else None}
    (ROOT/(label+'-doctor.private.json')).write_text(json.dumps(p,indent=2)+'\n')
baseline=report['doctor']['baseline'];denied=report['doctor']['deny-desktop-file']
baseline_rows=(baseline['result'] or {}).get('results',[])
denied_rows=(denied['result'] or {}).get('results',[])
checks={
 'positiveBaseline':baseline['harnessExit']==0 and bool(baseline['result'] and baseline['result'].get('allPassed')) and len(baseline_rows)==2,
 'denialHarnessCompleted':denied['harnessExit']==1 and denied['result'] is not None,
 'matchedDoctorExit':len(denied_rows)==2 and all(isinstance(d['doctorExit'],int) and d['doctorExit']==b['doctorExit'] for b,d in zip(baseline_rows,denied_rows)),
 'captureStillWorking':len(denied_rows)==2 and all(r['requestsCaptured']>0 for r in denied_rows),
 'noAppcastRequest':len(denied_rows)==2 and all(not r['appcastRequests'] for r in denied_rows),
}
# Verify a denial was not just a sandbox launch failure or a broken mock: the
# native doctor emits JSON and its unrelated captured requests still match.
valid_json=True;diagnostic_checks=True;other=[];raw_denied=''
for label in ['baseline','deny-desktop-file']:
    out=ROOT/('doctor-'+label)
    for case in ['a','b']:
        try:
            value=json.loads((out/('doctor-'+case+'.stdout')).read_text())
            valid_json=valid_json and isinstance(value,(dict,list)) and bool(value)
            diagnostic_checks=diagnostic_checks and isinstance(value,dict) and all(
                key in value.get('checks',{}) for key in ['updates.status','network.provider_reachability'])
        except (OSError,ValueError):valid_json=False;diagnostic_checks=False
    try:
        raw=(out/'requests.private.json').read_text();captured=json.loads(raw)
        other.append(Counter(r['target'] for r in captured if '/wham/app/appcast?' not in r['target']))
        if label=='deny-desktop-file':raw_denied=raw
    except (OSError,ValueError):other.append(Counter())
checks['nativeDiagnosticJson']=valid_json
checks['expectedDiagnosticChecksPresent']=diagnostic_checks
checks['otherRequestsPreserved']=bool(other[0]) and all(other[1][target]>=count for target,count in other[0].items())
checks['fallbackCdnCaptured']=any('persistent.oaistatic.com' in target and 'appcast.xml' in target for target in other[1])
checks['noCanaryInAnyCapturedRequest']=bool(raw_denied) and 'SYNTHETIC-DESKTOP-INSTALLATION-' not in raw_denied
report['doctor']['denialChecks']=checks
report['doctor']['boundedDenialPassed']=all(checks.values())
report['workspaceEditVisibleOutside']=(shared/'edit.txt').read_text().startswith('shared worktree')
(ROOT/'public-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
