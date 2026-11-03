#!/usr/bin/env python3
"""Offsite decision fixture for account-specific inherited Seatbelt policy.

No real credentials or networking. The inner policy harness verifies the exact
official research artifact. A second immutable path holds identical signed bytes:
we do not patch or re-sign Claude. This tests a candidate mechanism, not complete
AIM dispatch, version enforcement or production filesystem confinement.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess

base = Path("/opt/aimgr-state-audit")
work = base / "claude-implementation"
vendor = base / "bin/claude"
second = base / "bin/claude-nested-b"
p = argparse.ArgumentParser()
p.add_argument("--run-name", required=True)
p.add_argument("--common-policy", action="store_true", help="Apply both executable-specific account rules once")
a = p.parse_args()
if not re.fullmatch(r"[a-z0-9-]{1,40}", a.run_name):
    raise SystemExit("Invalid fixture name")
if platform.system() != "Darwin" or os.getuid() == 0 or not (base / "OFFSITE_AUDIT_HOST").is_file():
    raise SystemExit("Unprivileged rented-Mac fixture only")
if hashlib.sha256(vendor.read_bytes()).hexdigest() != "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9":
    raise SystemExit("Unapproved research artifact")
if (work / ("nested-a-" + a.run_name)).exists():
    raise SystemExit("Refusing reused fixture")
if not second.exists():
    subprocess.run(["sudo", "-n", "/bin/cp", "-p", str(vendor), str(second)], check=True)
assert hashlib.sha256(second.read_bytes()).hexdigest() == hashlib.sha256(vendor.read_bytes()).hexdigest()
assert second.stat().st_uid == 0 and second.stat().st_mode & 0o022 == 0
for name in ("hidden-canary-a", "hidden-canary-b"):
    (work / name).write_text("SYNTHETIC_FILE_CANARY")
rules = {}
for role, binary, other in [("a", vendor, "b"), ("b", second, "a")]:
    rules[role] = ('(deny file-read* (require-all (process-path "' + str(binary)
        + '") (literal "' + str(work / ("hidden-canary-" + other)) + '")))\n')
    (work / ("nested-" + role + "-" + a.run_name + ".sb")).write_text('(version 1)\n(allow default)\n' + rules[role])
if a.common_policy:
    (work / ("nested-a-" + a.run_name + ".sb")).write_text('(version 1)\n(allow default)\n' + rules["a"] + rules["b"])
check = work / ("nested-tool-check-" + a.run_name + ".py")
check.write_text('run_name=' + repr(a.run_name) + '\ncommon_policy=' + repr(a.common_policy) + '\n' + '''import json,subprocess
from pathlib import Path
work=Path('/opt/aimgr-state-audit/claude-implementation')
results=[]
for role in ('a','b'):
 argv=['/usr/bin/python3',str(work/'policy-probe.py'),'--root',str(work/('nested-b-read-'+role+'-'+run_name)),
       '--claude','/opt/aimgr-state-audit/bin/claude-nested-b','--case','privacy-overlay',
       '--file-canary',str(work/('hidden-canary-'+role))]
 if not common_policy: argv+=['--sandbox-profile',str(work/('nested-b-'+run_name+'.sb'))]
 p=subprocess.run(argv,capture_output=True,text=True,timeout=40)
 (work/('nested-b-read-'+role+'-'+run_name+'.private.txt')).write_text(p.stdout+p.stderr)
 record=json.loads(p.stdout)['results'][0] if p.returncode==0 else {}
 results.append({'readsAccount':role,'fixtureExit':p.returncode,'vendorExit':record.get('exit'),'nativeReadReturnedCanary':record.get('nativeReadReturnedCanary'),
                 'nativeReadError':record.get('nativeReadError'),'intentionalToolRead':(record.get('toolEnvironment') or {}).get('intentionalToolRead')})
_aim_probe_result=results
''')
argv = ["/usr/bin/python3", str(work / "policy-probe.py"), "--root", str(work / ("nested-a-" + a.run_name)),
        "--claude", str(vendor), "--case", "privacy-overlay", "--file-canary", str(work / "hidden-canary-b"),
        "--sandbox-profile", str(work / ("nested-a-" + a.run_name + ".sb")), "--tool-check", str(check)]
result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
(work / ("nested-a-" + a.run_name + ".private.txt")).write_text(result.stdout + result.stderr)
if result.returncode:
    raise SystemExit("Nested fixture failed; inspect the private synthetic record")
report = json.loads(result.stdout)
parent = report["results"][0]
children = (parent.get("toolEnvironment") or {}).get("nativeToolCheck") or []
report["commonInheritedPolicy"] = a.common_policy
report["decisionFixturePassed"] = (parent["exit"] == 0 and parent.get("nativeReadReturnedCanary") is False
    and parent.get("nativeReadError") is True and len(children) == 2
    and all(c["vendorExit"] == 0 and c["intentionalToolRead"] is True for c in children)
    and children[0]["nativeReadReturnedCanary"] is False and children[0]["nativeReadError"] is True
    and children[1]["nativeReadReturnedCanary"] is True and not children[1]["nativeReadError"])
(work / ("mac-nested-" + a.run_name + ".json")).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
raise SystemExit(0 if report["decisionFixturePassed"] else 1)
