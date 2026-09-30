#!/usr/bin/env python3
"""AIM Codex account selections that involve a label on this host.

Reads ~/.aimgr/local-state.json and its backups. Incomplete: switches made by
`aim codex run` and by routines are often missing. Usage:
  ssh <host> 'python3 - lessons 2026-09-25' < selections.py
"""
import glob, json, os, socket, sys

label = sys.argv[1]
since = sys.argv[2] if len(sys.argv) > 2 else "2026-01-01"
paths = [os.path.expanduser("~/.aimgr/local-state.json")] + sorted(glob.glob(os.path.expanduser("~/.aimgr/local-state.json.bak*")))[-60:]
seen, events = set(), []
for path in paths:
    try:
        state = json.load(open(path))
    except Exception:
        continue
    for event in state.get("pool", {}).get("openaiCodex", {}).get("history", []):
        key = (event.get("observedAt"), event.get("label"), event.get("kind"))
        if key not in seen:
            seen.add(key)
            events.append(event)
    receipt = state.get("targets", {}).get("codexCli", {}).get("lastSelectionReceipt") or {}
    key = (receipt.get("observedAt"), receipt.get("label"), "receipt")
    if receipt and key not in seen:
        seen.add(key)
        events.append({"observedAt": receipt.get("observedAt"), "label": receipt.get("label"), "kind": "receipt",
                       "status": receipt.get("status"), "previous": receipt.get("previousLabel")})
events = sorted((e for e in events if (e.get("observedAt") or "") >= since), key=lambda e: e["observedAt"])
hits = [e for e in events if label in (e.get("label"), e.get("previous"))]
print(f"{socket.gethostname()}: {len(events)} events since {since}; {len(hits)} involve {label}")
for event in hits:
    print(f"  {event['observedAt']} {event.get('label')} {event.get('kind')} {event.get('status') or ''} "
          f"{event.get('reason') or ''} {'previous=' + event['previous'] if event.get('previous') else ''}")
