#!/usr/bin/env python3
"""Restore Prime sessions into Herdr panes, one at a time, with proof.

Plan file: one target per line, fields separated by whitespace:

    <herdr-session> pane  <pane-id>  <cwd> <session-uuid>
    <herdr-session> new   <label>    <cwd> <session-uuid>     # new workspace with that label (use _ for spaces)
    <herdr-session> split <pane-id>  <cwd> <session-uuid>     # split that pane to the right

Usage: python3 scripts/prime-restore-sessions.py <plan-file> [--stop-on-failure]

Why it looks the way it does (all learned on 2026-09-02):
- resumes by ABSOLUTE transcript path, which Prime routes through the 30 s `list` lane; a bare uuid
  goes through the client's 3 s `get_state` lane and dies under load with
  "Could not look up active agent ... Timed out after 3000ms";
- never uses `exec`: if the TUI exits, an exec'd pane closes and a single-pane workspace disappears;
- success is the worker descriptor reaching lifecycle=ready with a live pid, never screen text
  (old scrollback contains yesterday's errors); failure is the pane's foreground dropping back to zsh;
- sequential with a pause, because every resume restores a kernel snapshot.
"""
import glob
import json
import os
import subprocess
import sys
import time

AGENT_DIR = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR", os.path.expanduser("~/.prime/agent"))
SESSIONS = os.path.join(AGENT_DIR, "sessions")
DESCRIPTORS = os.path.join(AGENT_DIR, "daemon-workers")


def herdr(session, *args):
    proc = subprocess.run(["herdr", "--session", session, *args], capture_output=True, text=True, timeout=90)
    return proc.stdout or proc.stderr


def worker_state(session_id):
    for path in glob.glob(os.path.join(DESCRIPTORS, "*", "*.json")):
        try:
            desc = json.load(open(path))
        except Exception:
            continue
        if desc.get("rootSessionId") != session_id:
            continue
        try:
            os.kill(desc["pid"], 0)
            return f"{desc.get('lifecycle')}:alive"
        except Exception:
            return f"{desc.get('lifecycle')}:dead"
    return "none"


def foreground(session, pane):
    try:
        info = json.loads(herdr(session, "pane", "process-info", "--pane", pane))["result"]["process_info"]
        return [p.get("name") for p in info["foreground_processes"]]
    except Exception:
        return ["?"]


def resolve_pane(session, how, target, cwd):
    if how == "pane":
        return target
    if how == "new":
        out = herdr(session, "workspace", "create", "--cwd", cwd, "--label", target.replace("_", " "), "--no-focus")
        return json.loads(out)["result"]["root_pane"]["pane_id"]
    if how == "split":
        out = herdr(session, "pane", "split", target, "--direction", "right", "--cwd", cwd, "--no-focus")
        return json.loads(out)["result"]["pane"]["pane_id"]
    raise ValueError(how)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    stop_on_failure = "--stop-on-failure" in sys.argv
    plan = [line.split() for line in open(sys.argv[1]) if line.strip() and not line.startswith("#")]
    results = []
    for session, how, target, cwd, sid in plan:
        transcript = os.path.join(SESSIONS, f"{sid}.jsonl")
        if not os.path.isfile(transcript):
            print(f"SKIP   {session} {sid}: no transcript at {transcript}")
            results.append((session, sid, "NO-TRANSCRIPT"))
            continue
        if worker_state(sid) == "ready:alive":
            print(f"SKIP   {session} {sid}: already resident")
            results.append((session, sid, "ALREADY"))
            continue
        try:
            pane = resolve_pane(session, how, target, cwd)
        except Exception as error:
            print(f"FAILED {session} {sid}: could not get a pane ({error})")
            results.append((session, sid, "NO-PANE"))
            if stop_on_failure:
                break
            continue
        if how != "pane":
            time.sleep(1.5)
        if foreground(session, pane) != ["zsh"]:
            print(f"FAILED {session} {pane} {sid}: pane is not at a zsh prompt ({foreground(session, pane)})")
            results.append((session, sid, "PANE-BUSY"))
            if stop_on_failure:
                break
            continue
        outcome = None
        for attempt in (1, 2, 3):
            herdr(session, "pane", "run", pane, f"cd {cwd} && aim prime resume {transcript}")
            started = time.time()
            state, exited = "none", False
            while time.time() - started < 150:
                time.sleep(3)
                state = worker_state(sid)
                if state == "ready:alive":
                    break
                if time.time() - started > 6 and foreground(session, pane) == ["zsh"]:
                    exited = True
                    break
            elapsed = int(time.time() - started)
            if state == "ready:alive":
                outcome = f"READY {pane} {elapsed}s attempt {attempt}"
                break
            screen = herdr(session, "pane", "read", pane, "--source", "visible", "--lines", "30")
            errors = [l.strip() for l in screen.splitlines() if "Error" in l or "Could not" in l]
            last = errors[-1][:150] if errors else "(no error text on screen)"
            if exited and "Could not look up active agent" in last and attempt < 3:
                print(f"  retry {session} {pane} {sid} (attempt {attempt}): {last[:100]}")
                time.sleep(15)
                continue
            outcome = f"FAILED {pane} state={state} exited={exited} {last}"
            break
        print(f"{outcome}  {session} {sid}", flush=True)
        results.append((session, sid, outcome))
        if outcome.startswith("FAILED") and stop_on_failure:
            break
        time.sleep(8)
    print("=== summary ===")
    for row in results:
        print(*row)
    print(f"{sum(1 for r in results if r[2].startswith('READY'))} ready of {len(plan)} planned")


if __name__ == "__main__":
    main()
