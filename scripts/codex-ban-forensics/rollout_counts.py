#!/usr/bin/env python3
"""Codex responses per weekly rate-limit window, split into two periods.

Every Codex response records the account's weekly `resets_at`; that value is
unique per account and week, so it attributes usage to an account. Copied
history in forked rollouts is de-duplicated. Output is JSON for load_table.py.
  ssh <host> 'python3 - 2026-09-19 2026-09-24 2026-09-30' < rollout_counts.py > counts_<host>.json
Arguments: first day, last day of period A, last day of period B.
"""
import datetime, glob, json, os, sys, collections

start, split, end = sys.argv[1], sys.argv[2], sys.argv[3]
day = datetime.date.fromisoformat(start)
files = []
while day <= datetime.date.fromisoformat(end):
    files += glob.glob(os.path.expanduser(f"~/.codex/sessions/{day:%Y/%m/%d}/*.jsonl"))
    day += datetime.timedelta(days=1)
seen, counts, unknown = set(), collections.defaultdict(lambda: [0, 0]), [0, 0]
for path in files:
    with open(path, errors="replace") as handle:
        for line in handle:
            if '"token_count"' not in line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            payload = event.get("payload") or {}
            limits = payload.get("rate_limits") or {}
            if payload.get("type") != "token_count" or limits.get("limit_id") not in (None, "codex"):
                continue
            stamp = event.get("timestamp") or ""
            if not start <= stamp[:10] <= end:
                continue
            weekly = next((w.get("resets_at") for w in (limits.get("primary") or {}, limits.get("secondary") or {})
                           if w.get("window_minutes") == 10080), None)
            key = (stamp, weekly, json.dumps(payload.get("info") or {}, sort_keys=True)[:200])
            if key in seen:
                continue
            seen.add(key)
            period = 0 if stamp[:10] <= split else 1
            if weekly:
                counts[str(int(weekly))][period] += 1
            else:
                unknown[period] += 1
print(json.dumps({"periods": [f"{start}..{split}", f"after {split}..{end}"], "counts": counts, "unknown": unknown}))
