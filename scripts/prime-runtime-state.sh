#!/usr/bin/env bash
# Read-only inventory of the Prime Agent control plane on this machine.
# Prints processes, sockets, leases, guards, registry owners, and worker
# descriptors, and says whether each recorded PID is alive. Never mutates.
#
# Usage: bash scripts/prime-runtime-state.sh [--json-descriptors]
set -u

RUNTIME_DIR="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo "${TMPDIR:-/tmp}/")prime-agent-$(id -u)"
RUNTIME_DIR="${RUNTIME_DIR//\/\//\/}"
AGENT_DIR="${PRIME_AGENT_DIR:-$HOME/.prime/agent}"
REGISTRY_DIR="$HOME/.prime/supervisor-owners"

alive() { kill -0 "$1" 2>/dev/null && echo "ALIVE" || echo "dead"; }
hdr() { printf '\n== %s ==\n' "$1"; }

hdr "prime-agent launcher"
printf 'PATH launcher : %s\n' "$(command -v prime-agent || echo 'NOT ON PATH')"
if command -v prime-agent >/dev/null; then
  printf 'resolves to   : %s\n' "$(readlink -f "$(command -v prime-agent)")"
fi
ls -d "$HOME"/.prime/installs/*/ 2>/dev/null | sed 's#^#install       : #'

hdr "processes (Prime retitles itself to 'prime-agent prime-agent-owner-token=<hex>'; role comes from registry/descriptors)"
python3 - "$AGENT_DIR" "$REGISTRY_DIR" <<'PY'
import glob,json,os,subprocess,sys
agent_dir,registry=sys.argv[1],sys.argv[2]
sup_pids={}
for d in glob.glob(os.path.join(registry,'*.owner')):
    try:
        j=json.load(open(os.path.join(d,'owner.json'))); sup_pids[j['pid']]=j.get('socketPath','')
    except Exception: pass
worker_pids={}
for f in glob.glob(os.path.join(agent_dir,'daemon-workers','*','*.json')):
    try:
        j=json.load(open(f)); worker_pids[j['pid']]=(j.get('workerId'),j.get('rootSessionId'),j.get('lifecycle'))
    except Exception: pass
ps=subprocess.run(['ps','-axo','pid=,ppid=,tty=,etime=,%cpu=,rss=,command='],capture_output=True,text=True).stdout
rows=[]
for line in ps.splitlines():
    parts=line.split(None,6)
    if len(parts)<7: continue
    pid,ppid,tty,et,cpu,rss,cmd=parts; pid=int(pid)
    if not any(k in cmd for k in ('prime-agent','rlm.repl','_bash_supervisor.py','prime-agent-owner-token','aimgr.js prime','aimgr.js mcp','daemon-catalog')): continue
    if 'grep' in cmd or 'prime-runtime-state' in cmd: continue
    if pid in sup_pids: role='SUPERVISOR'
    elif pid in worker_pids: w=worker_pids[pid]; role=f'WORKER {w[0]} root={w[1]} {w[2]}'
    elif 'daemon-catalog' in cmd: role='CATALOG'
    elif 'rlm.repl' in cmd: role='KERNEL'
    elif '_bash_supervisor' in cmd: role='BASH-SUPERVISOR'
    elif 'aimgr.js mcp' in cmd: role='AIM-MCP-7337'
    elif 'aimgr.js prime' in cmd: role='AIM-LAUNCHER'
    elif 'mcp-serve' in cmd: role='PRIME-FLEET-MCP'
    elif cmd.startswith('prime-agent prime-agent-owner-token='): role='PRIME-SPAWNED (not in registry/descriptors: starting, client-owned, or stale)'
    elif cmd.startswith('prime-agent') or '/prime-agent' in cmd or 'cli.js' in cmd: role='CLIENT/TUI' if tty!='??' else 'CLIENT (no tty)'
    else: role='?'
    rows.append((pid,int(ppid),tty,et,cpu,rss,role,cmd[:70]))
print(f"{'PID':>6} {'PPID':>6} {'TTY':6} {'ELAPSED':>11} {'%CPU':>5} {'RSS':>8}  ROLE  |  command")
for r in sorted(rows): print(f"{r[0]:>6} {r[1]:>6} {r[2]:6} {r[3]:>11} {r[4]:>5} {r[5]:>8}  {r[6]}  |  {r[7]}")
PY
SUP_PIDS=$(python3 - "$REGISTRY_DIR" <<'PY'
import glob,json,os,sys
out=[]
for d in glob.glob(os.path.join(sys.argv[1],'*.owner')):
    try:
        j=json.load(open(os.path.join(d,'owner.json')))
        os.kill(j['pid'],0); out.append(str(j['pid']))
    except Exception: pass
print(' '.join(out))
PY
)
printf 'live supervisor pids (registry owners that are alive): %s\n' "${SUP_PIDS:-none}"

hdr "runtime dir $RUNTIME_DIR"
if [ -d "$RUNTIME_DIR" ]; then
  ls -la "$RUNTIME_DIR" | grep -vE '^total' | cut -c1-140
  if [ -S "$RUNTIME_DIR/daemon.sock" ]; then
    if command -v nc >/dev/null; then
      if nc -z -U "$RUNTIME_DIR/daemon.sock" 2>/dev/null; then echo "daemon.sock   : CONNECTABLE"; else echo "daemon.sock   : present but NOT connectable (stale socket file)"; fi
    fi
  else
    echo "daemon.sock   : absent"
  fi
  if [ -f "$RUNTIME_DIR/daemon.sock.lock" ]; then
    p=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$RUNTIME_DIR/daemon.sock.lock" 2>/dev/null)
    printf 'daemon.sock.lock owner pid %s -> %s\n' "$p" "$( [ -n "$p" ] && alive "$p")"
  fi
  for d in "$RUNTIME_DIR"/.supervisor-launch-*.lock; do
    [ -e "$d" ] || continue
    p=$(cat "$d/pid" 2>/dev/null)
    printf 'launch lease %s owner pid %s -> %s\n' "$(basename "$d")" "${p:-?}" "$( [ -n "$p" ] && alive "$p")"
    [ -e "$d.guard" ] && printf '  guard file present: %s\n' "$d.guard"
  done
  for g in "$RUNTIME_DIR"/.guard* "$RUNTIME_DIR"/*.guard "$RUNTIME_DIR"/.*.guard; do
    [ -e "$g" ] && printf 'guard file    : %s\n' "$g"
  done
  n=$(ls "$RUNTIME_DIR"/worker-*.sock 2>/dev/null | wc -l | tr -d ' ')
  echo "worker socket files: $n"
fi

hdr "registry $REGISTRY_DIR (and mirror under runtime dir)"
for reg in "$REGISTRY_DIR" "$RUNTIME_DIR/supervisor-owners"; do
  [ -d "$reg" ] || continue
  echo "-- $reg"
  for f in "$reg"/.guard "$reg"/.guard.release-* "$reg"/.guard.publish-*; do
    [ -e "$f" ] || continue
    p=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$f" 2>/dev/null)
    printf '  %s pid=%s -> %s\n' "$(basename "$f")" "${p:-?}" "$( [ -n "$p" ] && alive "$p")"
  done
  for o in "$reg"/*.owner; do
    [ -d "$o" ] || continue
    python3 - "$o" <<'PY'
import json,os,sys
d=sys.argv[1]
try:
    j=json.load(open(os.path.join(d,'owner.json')))
except Exception as e:
    print(f"  {os.path.basename(d)}: unreadable owner.json ({e})"); sys.exit()
pid=j.get('pid')
try:
    os.kill(pid,0); st='ALIVE'
except Exception:
    st='dead'
print(f"  {os.path.basename(d)}: pid={pid} -> {st} phase={j.get('phase')} app={j.get('appVersion')} socket={j.get('socketPath')} updated={j.get('updatedAt')}")
PY
  done
  [ -d "$reg/offline-maintenance" ] && echo "  offline-maintenance/: $(ls "$reg/offline-maintenance" | wc -l | tr -d ' ') entries"
done

hdr "worker descriptors $AGENT_DIR/daemon-workers/<socket-id>/*.json"
for dir in "$AGENT_DIR"/daemon-workers/*/; do
  [ -d "$dir" ] || continue
  cnt=$(ls "$dir"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "$cnt" = "0" ] && continue
  echo "-- $(basename "$dir") ($cnt descriptors)"
  for j in "$dir"/*.json; do
    python3 - "$j" <<'PY'
import json,os,sys
p=sys.argv[1]
try:
    d=json.load(open(p))
except Exception as e:
    print(f"  {os.path.basename(p)}: unreadable ({e})"); sys.exit()
pid=d.get('pid')
try:
    os.kill(pid,0); st='ALIVE'
except Exception:
    st='dead'
print(f"  {d.get('workerId')}: pid={pid} -> {st} lifecycle={d.get('lifecycle')} root={d.get('rootSessionId')} err={str(d.get('lastError') or '')[:60]}")
PY
  done
done

hdr "launchd jobs that can start Prime or aim"
launchctl list 2>/dev/null | grep -iE 'funcountry|prime|aimgr' || echo "(none)"

hdr "latest daemon log lines"
ls -t "$AGENT_DIR"/logs/daemon*.log 2>/dev/null | head -1 | while read -r f; do echo "-- $f"; tail -5 "$f" | cut -c1-200; done
echo "-- client-errors.log"
tail -3 "$AGENT_DIR"/logs/client-errors.log 2>/dev/null | cut -c1-200
