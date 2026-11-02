#!/usr/bin/env python3
"""Offsite-only native AppArmor transition decision; no vendor or network use."""
import json
import os
from pathlib import Path
import subprocess

base = Path('/opt/aimgr-state-audit')
assert os.getuid() == 0 and (base / 'OFFSITE_AUDIT_HOST').is_file()
root = base / 'claude-implementation/linux-transition-v4'
root.mkdir(mode=0o755)
source = root / 'probe.c'
source.write_text(r'''#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc,char **argv){char b[4096]={0};FILE *f=fopen("/proc/self/attr/current","r");if(!f)return 2;fgets(b,sizeof(b),f);fclose(f);printf("%s",b);fflush(stdout);if(argc>2){int n=atoi(argv[1]);if(n>0){char next[20];snprintf(next,sizeof(next),"%d",n-1);execl(argv[2],argv[2],next,argv[0],NULL);return 3;}}return 0;}
''')
for name in ['vendor', 'tool']:
    subprocess.run(['gcc', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(root / name)], check=True)
vendor, tool = root / 'vendor', root / 'tool'
policy = root / 'policy'
def other_paths(excluded):
    # AppArmor has no priority override for overlapping ix/px rules. Describe
    # their disjoint languages explicitly; exclude only exact fixed images.
    rules = []
    def visit(prefix, suffixes):
        if '' not in suffixes and prefix != '/':
            rules.append('"' + prefix + '"')
        chars = sorted({s[0] for s in suffixes if s})
        if chars:
            rules.append('"' + prefix + '[^' + ''.join(chars).replace('-', '\\-') + ']**"')
            for char in chars:
                visit(prefix + char, [s[1:] for s in suffixes if s.startswith(char)])
        else:
            rules.append('"' + prefix + '?**"')
    visit('/', [str(p)[1:] for p in excluded])
    return rules
vendor_other = '\n'.join('  ' + p + ' px -> aim-claude-transition-tools,' for p in other_paths([vendor]))
tool_other = '\n'.join('  ' + p + ' ix,' for p in other_paths([vendor]))
policy.write_text(f'''#include <tunables/global>
profile aim-claude-transition-vendor flags=(attach_disconnected) {{
  /** rwmkl,
  {vendor} ix,
{vendor_other}
}}
profile aim-claude-transition-tools flags=(attach_disconnected) {{
  allow all,
{tool_other}
  {vendor} px -> aim-claude-transition-vendor,
}}
''')
loaded = False
try:
    subprocess.run(['apparmor_parser', '-r', '-T', str(policy)], check=True)
    loaded = True
    run = subprocess.run(['runuser', '-u', 'aimprivacy', '--', 'aa-exec', '-p', 'aim-claude-transition-vendor', '--', str(vendor), '2', str(tool)], capture_output=True, text=True, timeout=10)
    expected = ['aim-claude-transition-vendor (enforce)', 'aim-claude-transition-tools (enforce)', 'aim-claude-transition-vendor (enforce)']
    report = {'exit': run.returncode, 'profiles': run.stdout.splitlines(), 'stderr': run.stderr, 'passed': run.returncode == 0 and run.stdout.splitlines() == expected}
    (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    if loaded:
        subprocess.run(['apparmor_parser', '-R', str(policy)], check=True)
