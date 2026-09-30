#!/usr/bin/env python3
"""Map rollout_counts.py output to account labels and print a load table.

Window-to-account mapping comes from AIM usage samples
(~/.aimgr/usage-snapshots/usage-samples.csv) and every host's
~/.aimgr/redis-cache.json. Windows that ended before the samples begin, or
were replaced by a reset credit, stay unattributed.
  python3 load_table.py --counts counts_*.json --caches cache_*.json [--threads-for <label>]
"""
import argparse, csv, datetime, json, os, collections

parser = argparse.ArgumentParser()
parser.add_argument("--counts", nargs="+", required=True)
parser.add_argument("--caches", nargs="*", default=[])
args = parser.parse_args()
windows = collections.defaultdict(set)
samples = os.path.expanduser("~/.aimgr/usage-snapshots/usage-samples.csv")
if os.path.exists(samples):
    for row in csv.DictReader(open(samples)):
        if row["provider"] == "openai-codex" and row["window"] == "Week" and row["reset_at"]:
            windows[int(datetime.datetime.fromisoformat(row["reset_at"].replace("Z", "+00:00")).timestamp())].add(row["label"])
def walk(node):
    if isinstance(node, dict):
        if node.get("provider") == "openai-codex" and node.get("label"):
            for window in ((node.get("usage") or {}).get("windows") or []):
                if window.get("resetAt"):
                    windows[int(window["resetAt"] / 1000)].add(node["label"])
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
for path in [os.path.expanduser("~/.aimgr/redis-cache.json")] + args.caches:
    try:
        walk(json.load(open(path)))
    except Exception:
        pass
def label_for(seconds):
    matches = {label for key, labels in windows.items() if abs(key - seconds) <= 10 and len(labels) == 1 for label in labels}
    return next(iter(matches)) if len(matches) == 1 else None
totals, unattributed, periods = collections.defaultdict(lambda: [0, 0]), [0, 0], None
for path in args.counts:
    data = json.load(open(path))
    periods = data["periods"]
    for seconds, (a, b) in data["counts"].items():
        label = label_for(int(seconds))
        target = totals[label] if label else unattributed
        target[0] += a
        target[1] += b
    unattributed[0] += data["unknown"][0]
    unattributed[1] += data["unknown"][1]
print(f"{'account':26} {periods[0]:>24} {periods[1]:>24}")
for label, (a, b) in sorted(totals.items(), key=lambda item: -item[1][0]):
    print(f"{label:26} {a:24} {b:24}")
print(f"{'(unattributed)':26} {unattributed[0]:24} {unattributed[1]:24}")
