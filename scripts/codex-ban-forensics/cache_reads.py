#!/usr/bin/env python3
"""Last good usage read for Codex label(s) in this host's AIM cache.

A failed usage read keeps the old timestamp, so `last_good_read` is the last
moment this host saw the account alive. Run locally, or remotely:
  ssh <host> 'python3 - pro11 lessons' < cache_reads.py
"""
import datetime, json, os, socket, sys

labels = set(sys.argv[1:])
def ts(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ms else "-"
try:
    cache = json.load(open(os.path.expanduser("~/.aimgr/redis-cache.json")))
except Exception as error:
    sys.exit(f"{socket.gethostname()}: no AIM cache ({error})")
seen = set()
def walk(node):
    if isinstance(node, dict):
        label = node.get("label")
        if node.get("provider") == "openai-codex" and label and (not labels or label in labels) and label not in seen:
            seen.add(label)
            usage = node.get("usage") or {}
            windows = usage.get("windows") or [{}]
            print(f"{socket.gethostname():16} {label:26} status={(node.get('operator') or {}).get('status')} "
                  f"last_good_read={ts(usage.get('observedAtMs'))} week_used={[w.get('usedPercent') for w in windows]} "
                  f"week_reset={[ts(w.get('resetAt')) for w in windows]}")
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
walk(cache)
