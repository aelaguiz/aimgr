#!/usr/bin/env python3
"""Read recent agent transcript metadata on this host and reachable pool hosts.

Only session metadata, tool names, edited paths, and rate-limit reset fingerprints
leave this script. Prompts, tool arguments, credentials, and message bodies do not.
"""

import argparse
import datetime as dt
import glob
import json
import os
import pathlib
import re
import socket
import sqlite3
import subprocess
import sys
import time

TAIL_BYTES = 2 * 1024 * 1024
MAX_SESSIONS_PER_RUNTIME = 300
REMOTE_HOSTS = ("home",)
PATCH_PATH = re.compile(r"^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$", re.M)
SESSION_ID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
RESUME_ID = re.compile(r"(?:\bresume|--resume)(?:=|\s+)(" + SESSION_ID + r")\b")


def utc(ms=None):
    when = dt.datetime.fromtimestamp((ms or time.time() * 1000) / 1000, dt.timezone.utc)
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    if isinstance(value, (int, float)):
        return int(value if value > 10**11 else value * 1000)
    if isinstance(value, str):
        try:
            return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def read_tail(path, limit=TAIL_BYTES):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > limit:
                handle.seek(size - limit)
            lines = handle.read().splitlines()
        if size > limit:
            lines = lines[1:]
        for line in lines:
            try:
                yield json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
    except (OSError, PermissionError):
        return


def first_record(path):
    try:
        with open(path, "rb") as handle:
            return json.loads(handle.readline())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def recent_files(patterns, since_ms):
    files = []
    for pattern in patterns:
        for filename in glob.iglob(pattern):
            try:
                modified_ms = int(os.stat(filename).st_mtime * 1000)
            except OSError:
                continue
            if modified_ms >= since_ms:
                files.append((modified_ms, filename))
    return sorted(files, reverse=True)[:MAX_SESSIONS_PER_RUNTIME]


def patch_paths(arguments):
    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError:
            decoded = arguments
    else:
        decoded = arguments
    if isinstance(decoded, dict):
        texts = [value for value in decoded.values() if isinstance(value, str)]
    elif isinstance(decoded, str):
        texts = [decoded]
    else:
        texts = []
    paths = set()
    for text in texts:
        for candidate in (text, text.replace("\\n", "\n")):
            paths.update(path.strip()[:500] for path in PATCH_PATH.findall(candidate))
    return paths


def codex_sessions(home, since_ms):
    database = home / ".codex" / "state_5.sqlite"
    if not database.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        columns = {row[1] for row in conn.execute("pragma table_info(threads)")}
        timestamp = "updated_at_ms" if "updated_at_ms" in columns else "updated_at * 1000"
        query = f"""select id, rollout_path, cwd, title, model, {timestamp} as updated_ms
                    from threads where {timestamp} >= ? order by updated_ms desc limit ?"""
        records = [dict(row) for row in conn.execute(query, (since_ms, MAX_SESSIONS_PER_RUNTIME))]
        conn.close()
    except (sqlite3.Error, OSError):
        return []
    sessions = []
    for record in records:
        tools = {}
        edits = set()
        last_event = 0
        weekly_reset_ms = None
        token_events = 0
        for event in read_tail(record.get("rollout_path") or ""):
            event_ms = parse_time(event.get("timestamp")) or 0
            if event_ms < since_ms:
                continue
            last_event = max(last_event, event_ms)
            payload = event.get("payload") or {}
            if event.get("type") == "event_msg" and payload.get("type") == "token_count":
                token_events += 1
                limits = payload.get("rate_limits") or {}
                for window in (limits.get("primary"), limits.get("secondary")):
                    if not isinstance(window, dict):
                        continue
                    if int(window.get("window_minutes") or 0) >= 7 * 24 * 60:
                        weekly_reset_ms = parse_time(window.get("resets_at"))
            if event.get("type") == "response_item" and payload.get("type") == "function_call":
                name = str(payload.get("name") or "unknown")[:100]
                tools[name] = tools.get(name, 0) + 1
                if "patch" in name or name == "functions.exec":
                    edits.update(patch_paths(payload.get("arguments")))
        sessions.append({
            "runtime": "codex",
            "provider": "openai-codex",
            "sessionId": record["id"],
            "project": record.get("cwd"),
            "title": (record.get("title") or "")[:160],
            "model": record.get("model"),
            "lastActivityAt": utc(last_event or record["updated_ms"]),
            "weeklyResetAt": utc(weekly_reset_ms) if weekly_reset_ms else None,
            "tokenEventsInTail": token_events,
            "toolCountsInTail": tools,
            "editedPathsInTail": sorted(edits)[:30],
            "evidence": "sqlite_recent_and_transcript_tail",
        })
    return sessions


def claude_sessions(home, since_ms):
    patterns = [str(home / ".claude" / "projects" / "*" / "*.jsonl")]
    patterns.append(str(home / ".aimgr" / "claude-homes" / "*" / ".claude" / "projects" / "*" / "*.jsonl"))
    patterns.append(str(home / ".claude" / "projects" / "*" / "*" / "subagents" / "*.jsonl"))
    patterns.append(str(home / ".aimgr" / "claude-homes" / "*" / ".claude" / "projects" / "*" / "*" / "subagents" / "*.jsonl"))
    sessions = []
    for modified_ms, filename in recent_files(patterns, since_ms):
        label_match = re.search(r"[\\/]claude-homes[\\/]([^\\/]+)[\\/]\.claude[\\/]", filename)
        account_label = label_match.group(1) if label_match else None
        project = None
        model = None
        tools = {}
        edits = set()
        last_model_event = 0
        model_responses = set()
        for event in read_tail(filename):
            event_ms = parse_time(event.get("timestamp")) or 0
            if event_ms < since_ms:
                continue
            project = event.get("cwd") or project
            message = event.get("message") or {}
            if event.get("type") != "assistant" or not isinstance(message, dict):
                continue
            event_model = message.get("model")
            if isinstance(event_model, str) and event_model and not event_model.startswith("<") and message.get("usage"):
                model = event_model
                last_model_event = max(last_model_event, event_ms)
                model_responses.add(message.get("id") or event.get("uuid") or event_ms)
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = str(block.get("name") or "unknown")[:100]
                tools[name] = tools.get(name, 0) + 1
                if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                    value = (block.get("input") or {}).get("file_path")
                    if isinstance(value, str) and value:
                        edits.add(value[:500])
        if not last_model_event:
            continue
        is_child = pathlib.Path(filename).parent.name == "subagents"
        sessions.append({
            "runtime": "claude",
            "provider": "anthropic",
            "sessionId": pathlib.Path(filename).stem,
            "sessionKind": "child" if is_child else "root",
            "parentSessionId": pathlib.Path(filename).parent.parent.name if is_child else None,
            "project": project,
            "model": model,
            "accountLabel": account_label,
            "accountEvidence": "managed_home" if account_label else "unknown",
            "lastActivityAt": utc(last_model_event),
            "modelResponsesInTail": len(model_responses),
            "toolCountsInTail": tools,
            "editedPathsInTail": sorted(edits)[:30],
            "evidence": "transcript_mtime_and_tail",
        })
    return sessions


def pi_prime_sessions(home, since_ms, runtime):
    root = home / (".prime" if runtime == "prime" else ".pi") / "agent" / "sessions"
    patterns = [str(root / "*.jsonl")] if runtime == "prime" else [str(root / "*" / "*.jsonl")]
    sessions = []
    for modified_ms, filename in recent_files(patterns, since_ms):
        header = first_record(filename)
        if header.get("type") != "session":
            continue
        project = header.get("cwd")
        model = None
        provider = None
        account_label = None
        title = None
        tools = {}
        last_event = 0
        for event in read_tail(filename):
            event_ms = parse_time(event.get("timestamp")) or 0
            if event_ms < since_ms:
                continue
            last_event = max(last_event, event_ms)
            if event.get("type") == "model_change":
                model = event.get("modelId") or model
            if event.get("type") == "session_info":
                title = event.get("name") or title
            if event.get("type") == "custom" and event.get("customType") == "aimgr_credential_binding_v1":
                data = event.get("data") or {}
                provider = data.get("provider") or provider
                account_label = data.get("label") or data.get("accountLabel") or account_label
            message = event.get("message") or {}
            if event.get("type") == "message" and message.get("role") == "assistant":
                for block in message.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        name = str(block.get("name") or "unknown")[:100]
                        tools[name] = tools.get(name, 0) + 1
        sessions.append({
            "runtime": runtime,
            "provider": provider,
            "sessionId": header.get("id") or pathlib.Path(filename).stem,
            "project": project,
            "title": (title or "")[:160],
            "model": model,
            "accountLabel": account_label,
            "accountEvidence": "aimgr_binding" if account_label else "unknown",
            "lastActivityAt": utc(last_event or modified_ms),
            "toolCountsInTail": tools,
            "editedPathsInTail": [],
            "evidence": "transcript_mtime_and_tail",
        })
    return sessions


def process_summary():
    try:
        result = subprocess.run(["ps", "-eo", "pid=,ppid=,etime=,args="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    processes = []
    for line in result.stdout.splitlines():
        match = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)", line)
        if not match:
            continue
        pid, ppid, elapsed, args = match.groups()
        if "snapshot-agent-activity.py" in args or "python3 - --local-only" in args:
            continue
        if "/Applications/Claude.app/" in args or "codex-code-mode-host" in args:
            continue
        kind = None
        if re.search(r"(?:^|[ /])codex(?: |$)", args):
            kind = "codex"
        elif re.search(r"(?:^|[ /])claude(?: |$)", args) or "/claude-homes/" in args:
            kind = "claude"
        elif "prime-agent" in args:
            kind = "prime"
        elif re.search(r"(?:^|[ /])hermes(?: |$)", args):
            kind = "hermes"
        elif re.search(r"(?:^|[ /])pi(?: |$)", args):
            kind = "pi"
        if not kind:
            continue
        label_match = re.search(r"[\\/]claude-homes[\\/]([^\\/]+)[\\/]", args)
        processes.append({
            "pid": int(pid), "ppid": int(ppid), "elapsed": elapsed,
            "kind": kind, "accountLabel": label_match.group(1) if label_match else None,
            "sessionIds": RESUME_ID.findall(args)[:3],
        })
    return processes[:500]


def local_snapshot(since_minutes):
    home = pathlib.Path.home()
    since_ms = int((time.time() - since_minutes * 60) * 1000)
    return {
        "host": socket.gethostname(),
        "sampledAt": utc(),
        "sinceAt": utc(since_ms),
        "sessions": (
            codex_sessions(home, since_ms)
            + claude_sessions(home, since_ms)
            + pi_prime_sessions(home, since_ms, "prime")
            + pi_prime_sessions(home, since_ms, "pi")
        ),
        "processes": process_summary(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fleet", action="store_true")
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--since-minutes", type=int, default=70)
    args = parser.parse_args()
    hosts = [local_snapshot(args.since_minutes)]
    errors = []
    if args.fleet and not args.local_only:
        source = pathlib.Path(__file__).read_text()
        for target in REMOTE_HOSTS:
            try:
                result = subprocess.run(
                    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target,
                     "python3", "-", "--local-only", "--since-minutes", str(args.since_minutes)],
                    input=source, capture_output=True, text=True, timeout=25,
                )
                if result.returncode != 0:
                    raise RuntimeError(f"exit_{result.returncode}")
                hosts.append(json.loads(result.stdout)["hosts"][0])
            except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, RuntimeError) as error:
                errors.append({"host": target, "errorKind": type(error).__name__})
    print(json.dumps({"schemaVersion": 1, "hosts": hosts, "errors": errors}, separators=(",", ":")))


if __name__ == "__main__":
    main()
