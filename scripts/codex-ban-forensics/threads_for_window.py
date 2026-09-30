#!/usr/bin/env python3
"""Which Codex threads on this host ran on given weekly window(s).

Pass the account's weekly reset times (epoch seconds, from cache_reads.py or
usage-samples.csv). Prints thread, cwd, response count, time range, used%.
  ssh <host> 'python3 - 1791184644 1790460020' < threads_for_window.py
"""
import glob, json, os, socket, sys

targets = [int(value) for value in sys.argv[1:]]
rows = []
for path in glob.glob(os.path.expanduser("~/.codex/sessions/2026/*/*/*.jsonl")):
    try:
        data = open(path, errors="replace").read()
    except Exception:
        continue
    if not any(str(t) in data or str(t - 1) in data or str(t + 1) in data for t in targets):
        continue
    count, first, last, cwd, used = 0, None, None, None, []
    for line in data.splitlines():
        try:
            event = json.loads(line)
        except Exception:
            continue
        payload = event.get("payload") or {}
        if event.get("type") == "session_meta":
            cwd = payload.get("cwd")
        limits = payload.get("rate_limits") or {}
        if payload.get("type") != "token_count" or limits.get("limit_id") not in (None, "codex"):
            continue
        for window in (limits.get("primary") or {}, limits.get("secondary") or {}):
            if window.get("window_minutes") == 10080 and any(abs(int(window.get("resets_at") or 0) - t) <= 10 for t in targets):
                count += 1
                first = first or event.get("timestamp")
                last = event.get("timestamp")
                used.append(window.get("used_percent"))
    if count:
        rows.append((first, last, count, used[0], used[-1], os.path.basename(path), cwd))
print(f"{socket.gethostname()}: {len(rows)} threads (forked copies repeat their source's events)")
for first, last, count, low, high, name, cwd in sorted(rows):
    print(f"  {first[:16]} -> {last[:16]} {count:5} responses used {low}->{high}%  {name[-47:-11]}  {cwd}")
