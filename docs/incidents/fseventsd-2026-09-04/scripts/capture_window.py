#!/usr/bin/env python3
"""Read-only interval capture. Stores CPU deltas, VM counters, and bounded FSEvents logs."""
import collections
import datetime
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
LABEL = sys.argv[1]
SECONDS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
OUT = ROOT / 'evidence' / LABEL
OUT.mkdir(exist_ok=False)
PIDS = {'fseventsd': 337, 'ghostty': 678, 'perfpower': 14417, 'vm': 28817, 'windowserver': 406, 'prime': 99550}

def run(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=30)
    return {'command': args, 'exitCode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}

def cpu_seconds(value):
    parts = value.split(':')
    return sum(float(part) * (60 ** i) for i, part in enumerate(reversed(parts)))

def snapshot():
    result = run(['ps', '-p', ','.join(map(str, PIDS.values())), '-o', 'pid=,time=,rss=,pcpu='])
    rows = {}
    for line in result['stdout'].splitlines():
        pid, cpu, rss, pcpu = line.split()
        rows[int(pid)] = {'cpuSeconds': cpu_seconds(cpu), 'rssKiB': int(rss), 'psCpuPercent': float(pcpu)}
    return {'monotonic': time.monotonic(), 'timestamp': datetime.datetime.now().astimezone().isoformat(), 'processes': rows}

def container_state():
    result = run(['docker', 'ps', '-q'])
    ids = result['stdout'].split()
    if result['exitCode'] or not ids:
        return result
    fmt = '{{json .Id}} {{json .Name}} {{json .State.Status}} {{json .State.StartedAt}} {{json .RestartCount}}'
    return run(['docker', 'inspect', '--format', fmt, *ids])

(OUT/'containers-before.json').write_text(json.dumps(container_state(),indent=2)+'\n')
vm_before=run(['vm_stat'])
start=datetime.datetime.now().astimezone()
samples=[snapshot()]
print(f'{LABEL}: measuring {SECONDS} seconds',flush=True)
for target in range(5,SECONDS+1,5):
    time.sleep(max(0,samples[0]['monotonic']+target-time.monotonic()))
    samples.append(snapshot())
end=datetime.datetime.now().astimezone()
vm_after=run(['vm_stat'])
elapsed=samples[-1]['monotonic']-samples[0]['monotonic']
metrics={}
for name,pid in PIDS.items():
    first=samples[0]['processes'].get(pid);last=samples[-1]['processes'].get(pid)
    if not first or not last: continue
    metrics[name]={'pid':pid,'intervalCpuPercent':round(100*(last['cpuSeconds']-first['cpuSeconds'])/elapsed,2),'rssStartMiB':round(first['rssKiB']/1024,2),'rssEndMiB':round(last['rssKiB']/1024,2),'intervalsCpuPercent':[round(100*(b['processes'][pid]['cpuSeconds']-a['processes'][pid]['cpuSeconds'])/(b['monotonic']-a['monotonic']),2) for a,b in zip(samples,samples[1:]) if pid in a['processes'] and pid in b['processes']]}
summary={'label':LABEL,'start':start.isoformat(),'end':end.isoformat(),'elapsedSeconds':elapsed,'metrics':metrics}
(OUT/'samples.json').write_text(json.dumps(samples,indent=2)+'\n')
(OUT/'vm-before.json').write_text(json.dumps(vm_before,indent=2)+'\n')
(OUT/'vm-after.json').write_text(json.dumps(vm_after,indent=2)+'\n')
(OUT/'containers-after.json').write_text(json.dumps(container_state(),indent=2)+'\n')
args=['/usr/bin/log','show','--start',start.strftime('%Y-%m-%d %H:%M:%S'),'--end',end.strftime('%Y-%m-%d %H:%M:%S'),'--style','compact','--predicate','process == "fseventsd"','--info']
logs=run(args)
(OUT/'fseventsd.log').write_text(logs.pop('stdout'))
(OUT/'log-capture.json').write_text(json.dumps(logs,indent=2)+'\n')
counts=collections.Counter(); clients=collections.Counter();other=[]
for line in (OUT/'fseventsd.log').read_text().splitlines():
    if 'Resolve user group list' in line: counts['groupResolutionActivities']+=1
    elif 'USER DROPPED' in line: counts['userDropped']+=1;other.append(line)
    elif 'KERNEL DROPPED' in line: counts['kernelDropped']+=1;other.append(line)
    elif 'fsevent_add_client' in line: counts['clientRegistrations']+=1;other.append(line)
    elif 'fseventsd[' in line: counts['other']+=1;other.append(line)
    m=re.search(r'pid (\d+)',line)
    if m: clients[m.group(1)]+=1
summary['logCounts']=dict(counts);summary['mentionedClientPids']=dict(clients)
summary['groupResolutionActivitiesPerSecond']=round(counts['groupResolutionActivities']/elapsed,2)
(OUT/'log-exceptions.txt').write_text('\n'.join(other)+'\n')
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2),flush=True)
