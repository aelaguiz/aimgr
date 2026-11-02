#!/usr/bin/env python3
"""Observe the pinned client at its default service URLs, entirely offsite.

The loopback service terminates synthetic TLS requests; it never forwards them.
Its temporary CA is trusted only by this child, never installed on the host.
An independent network boundary remains mandatory. No real credentials, project
data, browser, or provider connection belongs in this fixture. In particular,
synthetic subscription metadata is a mechanism test, not real-account proof.
"""
import argparse
import atexit
import base64
import errno
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pwd
import pty
import re
import select
import shlex
import signal
import socket
import ssl
import subprocess
import struct
import termios
import threading
import time
import tempfile
from urllib.parse import urlsplit


EXPECTED = {
    "Linux": "fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824",
    "Darwin": "64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f",
}
p = argparse.ArgumentParser()
p.add_argument("--root", type=Path, required=True)
p.add_argument("--claude", type=Path, required=True)
p.add_argument("--case", action="append")
p.add_argument("--sandbox-profile", type=Path)
p.add_argument("--approved-mac-launcher", type=Path)
p.add_argument("--integrated-aim", action="store_true")
p.add_argument("--routed-aim", action="store_true", help="Actual installed account route; marked cloud host must independently deny external web")
p.add_argument("--node", type=Path)
p.add_argument("--privacy-mode", choices=["ordinary", "protected"], default="protected")
p.add_argument("--poll-settings", action="store_true", help="Diagnostic fixture only: use the unchanged client's polling file watcher")
p.add_argument("--rc-policy-only", action="store_true", help="Eligible unwrapped RC comparison with only disableRemoteControl added")
p.add_argument("--disable-agent-view", action="store_true", help="Research the narrow native daemon switch, retaining ordinary background tools")
p.add_argument("--background-review", action="store_true", help="Run the isolated daemon lifetime/reuse/disable experiment")
a = p.parse_args()
base = Path("/opt/aimgr-state-audit")
root = a.root.resolve()
if (not (base / "OFFSITE_AUDIT_HOST").is_file()
        or root.parent != base / "claude-implementation" or root.exists()
        or os.geteuid() == 0):
    raise SystemExit("Fresh marked offsite fixture and unprivileged user required")
if platform.system() == "Linux" and not a.routed_aim and sorted(n for _, n in socket.if_nameindex()) != ["lo"]:
    raise SystemExit("Independent loopback-only network namespace required")
if a.routed_aim and (not a.integrated_aim or a.privacy_mode != "protected" or not a.node):
    raise SystemExit("Routed fixture requires integrated protected launch and explicit Node")
if a.rc_policy_only and a.integrated_aim:
    raise SystemExit("Policy-only comparison is a separate unwrapped baseline")
if a.approved_mac_launcher and (platform.system() != "Darwin" or not str(a.approved_mac_launcher.resolve()).startswith("/opt/aimgr-claude-runtime/artifacts/")):
    raise SystemExit("Installed rented-Mac candidate required")
with a.claude.open("rb") as f:
    checked = hashlib.sha256()
    for block in iter(lambda: f.read(1024 * 1024), b""):
        checked.update(block)
    digest = checked.hexdigest()
if digest != EXPECTED.get(platform.system()):
    raise SystemExit("Unapproved research artifact")
os.umask(0o077)
root.mkdir()
san = "DNS:api.ipify.org,DNS:api.anthropic.com,DNS:*.anthropic.com,DNS:claude.ai,DNS:*.claude.ai,DNS:claude.com,DNS:*.claude.com,DNS:*.sentry.io,DNS:statsigapi.net,DNS:*.statsigapi.net,DNS:browser-intake-us5-datadoghq.com,DNS:http-intake.logs.us5.datadoghq.com"
(root / "tls.cnf").write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=AIM synthetic loopback fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=" + san + "\n")


def openssl(*args):
    subprocess.run(["/usr/bin/openssl", *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-config", str(root / "tls.cnf"), "-keyout", str(root / "ca-key.pem"),
        "-out", str(root / "ca.pem"))
openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=api.anthropic.com",
        "-keyout", str(root / "key.pem"), "-out", str(root / "leaf.csr"))
(root / "leaf.cnf").write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
openssl("x509", "-req", "-in", str(root / "leaf.csr"), "-CA", str(root / "ca.pem"),
        "-CAkey", str(root / "ca-key.pem"), "-CAcreateserial", "-days", "1",
        "-extfile", str(root / "leaf.cnf"), "-out", str(root / "cert.pem"))
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(str(root / "cert.pem"), str(root / "key.pem"))
requests = []
connections = []
active = None
active_plan = None


class Mock(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_CONNECT(self):
        connections.append({"case": active, "authority": self.path})
        self.send_response(200)
        self.end_headers()
        self.wfile.flush()
        try:
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.connection.settimeout(10)
            self.rfile = self.connection.makefile("rb", self.rbufsize)
            self.wfile = self.connection.makefile("wb", 0)
            self.close_connection = False
            while not self.close_connection:
                self.handle_one_request()
        except (OSError, ssl.SSLError):
            pass
        finally:
            self.close_connection = True

    def reply(self, value, status=200, content_type="application/json", headers=None):
        raw = (value if isinstance(value, str) else json.dumps(value)).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)
        self.close_connection = True

    def capture(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 8 * 1024 * 1024:
            raise ValueError("Synthetic request too large")
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw) if raw else None
        except ValueError:
            body = {"unparsed": raw.decode(errors="replace")}
        entry = {"case": active, "method": self.command, "host": self.headers.get("Host"),
                 "path": self.path, "headers": dict(self.headers), "body": body, "source": self.client_address[0]}
        requests.append(entry)
        with (root / "requests.private.jsonl").open("a") as f:
            f.write(json.dumps(entry) + "\n")
        return body

    def do_GET(self):
        self.capture()
        route = urlsplit(self.path).path
        if route == "/exit" or self.headers.get("Host", "").split(":")[0] == "api.ipify.org":
            if route == "/exit" and "controls" in (active or ""):
                until = time.time() + 5
                if (home / "hold-route-probe").exists():
                    (home / "route-probe-held").write_text("held")
                while (home / "hold-route-probe").exists() and time.time() < until:
                    time.sleep(.05)
            self.reply({"ip": self.client_address[0]})
        elif route == "/api/claude_code/policy_limits":
            self.reply({"restrictions": {"allow_remote_control": {"allowed": True}, "allow_error_reporting": {"allowed": True}},
                        "compliance_taints": [], "defaults": {}})
        elif route.endswith("/work/poll"):
            # Registration + a real poll is the standalone positive control.
            # Hold empty polls so a synthetic server cannot cause a busy loop.
            time.sleep(2)
            self.reply("", status=204)
        elif route.endswith("/worker/events/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for _ in range(30):
                    self.wfile.write(b": keepalive\n\n"); self.wfile.flush(); time.sleep(1)
            except OSError:
                pass
            self.close_connection = True
        elif route.endswith("/worker"):
            self.reply({"worker": {}})
        elif route == "/api/oauth/usage":
            self.reply({"five_hour": {"utilization": 1, "resets_at": "2026-11-03T00:00:00Z"}})
        elif route == "/api/oauth/claude_cli/roles":
            self.reply({"organization_role":"admin","workspace_role":"admin","organization_name":"Synthetic Pro"})
        elif route == "/api/oauth/profile":
            if "schedules" in (active or ""):
                # Match createNativeRoutineFixture's credential identity on
                # every turn/restart; a server UUID change correctly refuses
                # the next native launch and is not a scheduling failure.
                self.reply({"account": {"uuid": "acct_boss", "email": "boss@example.com"},
                    "organization": {"uuid": "org_boss", "organization_type": "claude_pro",
                    "rate_limit_tier": "default_claude_pro"}}, headers={"request-id": "req_fixture"})
                return
            if "concurrency" in (active or ""):
                b = "synthetic-b" in self.headers.get("Authorization", "")
                wrong = "login-wrong-id" in self.headers.get("Authorization", "")
                fresh = "login-new-a" in self.headers.get("Authorization", "")
                self.reply({"account": {"uuid": "00000000-0000-4000-8000-00000000000" + ("5" if fresh else "3" if b or wrong else "1"),
                    "email": "synthetic-" + ("new-a" if fresh else "b" if b else "a") + "@example.invalid"},
                    "organization": {"uuid": "00000000-0000-4000-8000-00000000000" + ("6" if fresh else "4" if b else "2"),
                    "organization_type": "claude_pro", "rate_limit_tier": "default_claude_pro"}}, headers={"request-id":"req_fixture"})
                return
            self.reply({"account": {"uuid": "00000000-0000-4000-8000-000000000001",
                                   "email": "synthetic@example.invalid"},
                        "organization": {"uuid": "00000000-0000-4000-8000-000000000002",
                                         "organization_type": "claude_" + (active_plan or "pro"),
                                         "rate_limit_tier": "default_claude_max_5x"}},
                       headers={"request-id": "req_fixture"} if "upgrade" in active else None)
        elif route == "/api/claude_code/settings":
            # The deliberately empty response avoids changing what the fixture
            # is measuring. Observing an attempted fetch establishes eligibility.
            self.reply({})
        else:
            self.reply({"features": {}, "data": [], "models": []})

    def do_POST(self):
        body = self.capture()
        route = urlsplit(self.path).path
        if route.startswith("/api/eval/") and "errors" in active:
            # Native logs invalid remote feature shapes through the real error
            # sink. Its expected tool failures intentionally do not report.
            until = time.time() + 3
            while not any(r["case"] == active and r["path"].startswith("/api/claude_code/policy_limits") for r in requests) and time.time() < until:
                time.sleep(.05)
            time.sleep(.1)
            self.reply({"features": {"tengu_orford_ness": {"defaultValue": True}, "AIM_ERROR_PROBE": None}})
        elif route == "/v1/environments/bridge":
            self.reply({"environment_id": "env_rcfixture", "environment_secret": "fixture-secret",
                        "environment_secret_expires_in": 3600})
        elif route == "/v1/sessions":
            self.reply({"id": "session_rcfixture_" + str(len(requests)), "title": "Synthetic RC fixture"}, status=201)
        elif route == "/v1/code/sessions":
            self.reply({"session": {"id": "cse_rcfixture_" + str(len(requests))}}, status=201)
        elif route.startswith("/v1/code/sessions/") and route.endswith("/bridge"):
            self.reply({"worker_jwt": "fixture-worker", "expires_in": 3600,
                        "api_base_url": "https://api.anthropic.com", "worker_epoch": 1})
        elif isinstance(body, dict) and body.get("grant_type") == "authorization_code":
            code=body["code"]
            fresh=code=="login-new-a"
            wrong=code=="login-wrong-id"
            self.reply({"access_token":"sk-ant-oat01-synthetic-"+code,"refresh_token":"synthetic-refresh-"+code,
                "expires_in":86400,"token_type":"Bearer","scope":"user:inference user:profile user:sessions:claude_code",
                "account":{"uuid":"00000000-0000-4000-8000-00000000000"+("5" if fresh else "3" if wrong else "1"),"email_address":"synthetic-"+("new-a" if fresh else "a")+"@example.invalid"},
                "organization":{"uuid":"00000000-0000-4000-8000-00000000000"+("6" if fresh else "2"),"name":"Synthetic Pro"}})
        elif isinstance(body, dict) and body.get("grant_type") == "refresh_token":
            self.reply({"access_token": "sk-ant-oat01-synthetic-refreshed",
                        "refresh_token": "synthetic-refreshed-refresh", "expires_in": 86400,
                        "token_type": "Bearer", "scope": body.get("scope", "user:inference user:profile")})
        elif "count_tokens" in self.path:
            self.reply({"input_tokens": 10})
        elif "/messages" in self.path:
            content = {"type": "text", "text": "SYNTHETIC_OK"}
            if "errors" in active:
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                if not any(block.get("id") == "expected_error_tool" for block in blocks):
                    content = {"type": "tool_use", "id": "expected_error_tool", "name": "Bash", "input": {
                        "command": "printf SYNTHETIC_EXPECTED_TOOL_FAILURE >&2; exit 7", "description": "Exercise an expected synthetic tool failure"}}
            if "compatibility" in active:
                messages = json.dumps(body.get("messages", []))
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                calls = [block.get("name") for block in blocks if block.get("type") == "tool_use"]
                if "NATIVE_COMPATIBILITY_PACKAGE_MCP" in messages:
                    available = [tool["name"] for tool in body.get("tools", [])]
                    wanted = next((name for name in available if "pack" in name and name.endswith("echo")), None)
                    tool = wanted or "ToolSearch"
                    args = {} if wanted else {"query": "+pack echo", "max_results": 5}
                elif "NATIVE_COMPATIBILITY_WORKTREE_SKILL" in messages or "NATIVE_COMPATIBILITY_PACKAGE_SKILL" in messages:
                    tool = "Skill"
                    args = {"skill": "privacy-fixture:pack-proof" if "NATIVE_COMPATIBILITY_PACKAGE_SKILL" in messages else "main-proof"}
                else:
                    tool = "Bash"
                    args = {"command": shlex.quote(str(a.node)) + " compatibility-tool.mjs", "description": "Verify required native development"}
                if tool not in calls:
                    content = {"type": "tool_use", "id": "compatibility_" + str(len(requests)), "name": tool, "input": args}
            if "concurrency" in active:
                messages = json.dumps(body.get("messages", []))
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                match = re.search(r"CONCURRENT_ROLE_([a-z0-9-]+)\.", messages)
                role = match.group(1) if match else None
                if role and not any(block.get("id") == "concurrent_" + role for block in blocks):
                    content = {"type": "tool_use", "id": "concurrent_" + role, "name": "Bash", "input": {
                        "command": shlex.quote(str(a.node)) + " " + shlex.quote(str(home / "project/concurrent-tool.mjs")) + " " + role,
                        "description": "Verify concurrent tools and nested account launches"}}
                if role == "overlap-required":
                    calls = [block.get("name") for block in blocks if block.get("type") == "tool_use"]
                    if "Skill" not in calls:
                        content = {"type": "tool_use", "id": "overlap_skill", "name": "Skill", "input": {"skill": "overlap-proof"}}
                    elif not any("overlap" in call and call.endswith("echo") for call in calls):
                        tool = next((tool["name"] for tool in body.get("tools", []) if "overlap" in tool["name"] and tool["name"].endswith("echo")), None)
                        content = {"type": "tool_use", "id": "overlap_mcp_" + str(len(requests)), "name": tool or "ToolSearch", "input": {} if tool else {"query": "+overlap echo", "max_results": 3}}
                    else:
                        content = {"type": "text", "text": "SYNTHETIC_OK"}
                if "CONCURRENT_ROUTINE_CANARY." in messages:
                    content = {"type": "text", "text": "AIM-JOB: done"} if any(block.get("id") == "overlap_routine" for block in blocks) else {
                        "type": "tool_use", "id": "overlap_routine", "name": "Bash", "input": {"command": "printf overlap-routine-ok > overlap-routine-proof.txt", "description": "Verify scheduled work alongside live sessions"}}
            if "detached-terminal" in active and "DETACHED_LIVE_CHECK" in json.dumps(body.get("messages", [])):
                blocks = [b for m in body.get("messages", []) if isinstance(m.get("content"), list) for b in m["content"]]
                if not any(b.get("id") == "detached_live" for b in blocks):
                    content = {"type": "tool_use", "id": "detached_live", "name": "Bash", "input": {
                        "command": "printf 'DETACHED_LIVE_SETTING_%s' \"$AIM_DETACHED_LIVE_SETTING\"", "description": "Verify unrelated live settings still apply"}}
            if "controls" in active:
                messages = json.dumps(body.get("messages", []))
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                match = re.search(r"NATIVE_CONTROL_ROLE_([a-z]+)\.", messages)
                role = match.group(1) if match else None
                if role and not any(block.get("id") == "control_" + role for block in blocks):
                    content = {"type": "tool_use", "id": "control_" + role, "name": "Bash", "input": {
                        "command": "/usr/bin/python3 -I " + shlex.quote(str(home / "project/control-tool.py")) + " " + role,
                        "description": "Verify native process control and terminal restoration"}}
            if "update-boundary" in active:
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                if not any(block.get("id") == "ordinary_update_probe" for block in blocks):
                    content = {"type": "tool_use", "id": "ordinary_update_probe", "name": "Bash", "input": {
                        "command": "/usr/bin/python3 " + shlex.quote(str(home / "project/update-check.py")),
                        "description": "Check approved-build enforcement and ordinary native development"}}
            if "headers-reload" in active:
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                identifiers = {block.get("id") for block in blocks if block.get("type") == "tool_use"}
                if "header_initial_env_probe" not in identifiers:
                    content = {"type": "tool_use", "id": "header_initial_env_probe", "name": "Bash", "input": {
                        "command": "printf 'HEADER_FIRST_SETTING_%s' \"$AIM_HEADER_LIVE_PROBE\"", "description": "Read initial fixture setting"}}
                elif "NATIVE_SECOND_HEADER_TURN" in json.dumps(body.get("messages", [])) and "header_live_env_probe" not in identifiers:
                    content = {"type": "tool_use", "id": "header_live_env_probe", "name": "Bash", "input": {
                        "command": "printf 'HEADER_LIVE_SETTING_%s' \"$AIM_HEADER_LIVE_PROBE\"", "description": "Read unrelated live fixture setting"}}
            if ("dynamic-directory" in active or "startup-directory" in active) and "NATIVE_ADDED_DIRECTORY" in json.dumps(body.get("messages", [])):
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                if not any(block.get("type") == "tool_use" and block.get("name") == "Read" for block in blocks):
                    content = {"type": "tool_use", "id": "dynamic_directory_read", "name": "Read", "input": {"file_path": str(home / "added-dir/proof.txt")}}
            if "http-mcp" in active:
                messages = json.dumps(body.get("messages", []))
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                calls = [block.get("name") for block in blocks if block.get("type") == "tool_use"]
                available = [tool["name"] for tool in body.get("tools", [])]
                resource = "MCP_HTTP_RESOURCE_CANARY" in messages
                wanted = "ListMcpResourcesTool" if resource and "ListMcpResourcesTool" not in calls else "ReadMcpResourceTool" if resource else "mcp__http__echo"
                if wanted not in calls:
                    name = wanted if wanted in available else "ToolSearch"
                    args = {"query": "select:" + wanted, "max_results": 3} if name == "ToolSearch" else ({"server": "http", **({"uri": "fixture://privacy/document"} if wanted == "ReadMcpResourceTool" else {})} if resource else {"text": "HTTP_TOOL_INPUT_CANARY"})
                    content = {"type": "tool_use", "id": "http_mcp_" + str(len(requests)), "name": name, "input": args}
            if "workflows" in active or "schedules" in active:
                messages = json.dumps(body.get("messages", []))
                blocks = [block for message in body.get("messages", []) if isinstance(message.get("content"), list) for block in message["content"]]
                user_text = [message["content"] if isinstance(message.get("content"), str) else json.dumps([block for block in message.get("content", []) if block.get("type") == "text"]) for message in body.get("messages", []) if message.get("role") == "user"]
                skill = "NATIVE_SKILL_PARENT" in messages
                agent = any("NATIVE_SUBAGENT_PARENT" in text for text in user_text)
                mcp = "MCP_STDIO_CANARY" in messages
                child = "NATIVE_CHILD_TASK" in messages and not agent
                mcp_tool = next((tool["name"] for tool in body.get("tools", []) if "stdio" in tool["name"] and tool["name"].endswith("echo")), None)
                name = "Skill" if skill else "Agent" if agent else (mcp_tool or "ToolSearch") if mcp else "Bash"
                ran = any(block.get("type") == "tool_use" and (block.get("name") == "Skill" if skill else block.get("name") == "Agent" if agent else "stdio" in block.get("name", "") and block.get("name", "").endswith("echo") if mcp else block.get("name") == "Bash") for block in blocks)
                if not ran:
                    args = {"skill": "privacy-proof"} if skill else {"description": "Synthetic child task", "prompt": "Run the synthetic Bash task. NATIVE_CHILD_TASK.", "subagent_type": "general-purpose"} if agent else ({"text": "MCP_TOOL_RESULT_CANARY"} if mcp_tool else {"query": "+stdio echo", "max_results": 5}) if mcp else {"command": "printf subagent-ok > child-proof.txt" if child else "printf native-tool-ok > tool-proof.txt", "description": "Write synthetic proof"}
                    content = {"type": "tool_use", "id": "tool_fixture_" + str(len(requests)), "name": name, "input": args}
                elif "schedules" in active or "ROUTINE_SUCCESS_CANARY" in messages:
                    content = {"type": "text", "text": "NATIVE_MOCK_DONE\nAIM-JOB: done"}
                if "NATIVE_BACKGROUND_BASH" in messages and not ran:
                    content = {"type": "tool_use", "id": "background_bash", "name": "Bash", "input": {
                        "command": "sleep 1; printf background-ok > background-tool-proof.txt",
                        "description": "Verify ordinary background shell tools", "run_in_background": True}}
                overlap = re.search(r"NATIVE_OVERLAP_([ab])", messages)
                if overlap and not ran:
                    own = overlap.group(1); other = "b" if own == "a" else "a"
                    content = {"type": "tool_use", "id": "overlap_" + own, "name": "Bash", "input": {
                        "command": "touch overlap-" + own + "-ready; for i in $(seq 1 100); do if test -f overlap-" + other + "-ready; then printf overlap-ok > overlap-" + own + "-done; exit 0; fi; sleep .1; done; exit 1",
                        "description": "Verify concurrent ordinary sessions reach their tools"}}
                if "NATIVE_SCHEDULE_REQUEST" in "\n".join(user_text):
                    calls = [block for block in blocks if block.get("type") == "tool_use"]
                    name, args = None, None
                    if not any(call.get("name") == "ScheduleWakeup" for call in calls):
                        name, args = "ScheduleWakeup", {"delaySeconds": 60, "reason": "Verify assigned routing", "prompt": "NATIVE_WAKE_FIRED_CANARY", "noop": False}
                    elif not any("NATIVE_WAKE_FIRED_CANARY" in text for text in user_text):
                        content = {"type": "text", "text": "Waiting for the scheduled synthetic turn."}
                    elif not any(call.get("name") == "Bash" and "wakeup-proof" in call.get("input", {}).get("command", "") for call in calls):
                        name, args = "Bash", {"command": "printf native-wakeup-ok > wakeup-proof.txt", "description": "Write scheduled proof"}
                    elif not any(call.get("name") == "ScheduleWakeup" and call.get("input", {}).get("stop") for call in calls):
                        name, args = "ScheduleWakeup", {"stop": True}
                    else:
                        content = {"type": "text", "text": "NATIVE_WAKE_COMPLETED\nAIM-JOB: done"}
                    if name: content = {"type": "tool_use", "id": "scheduled_" + str(len(requests)), "name": name, "input": args}
            msg = {"id": "msg_synthetic", "type": "message", "role": "assistant",
                   "model": body.get("model"), "content": [content],
                   "stop_reason": "end_turn" if content["type"] == "text" else "tool_use", "stop_sequence": None,
                   "usage": {"input_tokens": 10, "output_tokens": 3}}
            if body.get("stream"):
                events = [
                    {"type": "message_start", "message": dict(msg, content=[], stop_reason=None)},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""} if content["type"] == "text" else dict(content, input={})},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": content["text"]} if content["type"] == "text" else {"type": "input_json_delta", "partial_json": json.dumps(content["input"])}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": msg["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 3}},
                    {"type": "message_stop"},
                ]
                self.reply("".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events), content_type="text/event-stream")
            else:
                self.reply(msg)
        else:
            self.reply({})

    def do_PUT(self):
        self.capture()
        self.reply({})

    def do_DELETE(self):
        self.capture()
        self.reply({})


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
proxy = "http://127.0.0.1:" + str(server.server_port)
tls_server = None
route_child = None
route_profile = None
route_profiles = {}
# The normal native route connects to default vendor hostnames. Synthetic
# /etc/hosts entries and a SOCKS server restricted to these two fixture IPs
# terminate those requests locally; no provider traffic is forwarded. The
# cloud firewall remains an independent external-egress denial.
route_addresses = ["198.18.0.24", "198.18.0.25"]
hosts_tag = "# aimgr-synthetic-default-services"
hosts_edit = """from pathlib import Path
import sys
p=Path('/etc/hosts');tag=sys.argv[1]
text=''.join(line for line in p.read_text().splitlines(keepends=True) if tag not in line)
if sys.argv[2]=='add':text+='\\n198.18.0.24 api.ipify.org api.anthropic.com platform.claude.com claude.ai claude.com browser-intake-us5-datadoghq.com http-intake.logs.us5.datadoghq.com '+tag+'\\n'
p.write_text(text)
"""
def cleanup_route():
    global route_child, tls_server
    if a.routed_aim:
        for ref in route_profiles or {"impl_mock": None}:
            command = ["/bin/launchctl", "bootout", "system/com.aimgr.claude-proxy." + ref] if platform.system() == "Darwin" else ["systemctl", "stop", "aimgr-claude-proxy-" + ref + ".service"]
            subprocess.run(["sudo", "-n", *command], capture_output=True)
        if route_child:
            route_child.terminate(); route_child.communicate(timeout=10); route_child = None
        subprocess.run(["sudo", "-n", "/usr/bin/python3", "-I", "-c", hosts_edit, hosts_tag, "remove"], check=True)
        for address in route_addresses:
            command = ["/sbin/ifconfig", "lo0", "-alias", address] if platform.system() == "Darwin" else ["ip", "address", "del", address + "/32", "dev", "lo"]
            subprocess.run(["sudo", "-n", *command], capture_output=True)
        if tls_server: tls_server.shutdown(); tls_server.server_close(); tls_server = None

atexit.register(cleanup_route)
if a.routed_aim:
    tls_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    tls_server.socket = context.wrap_socket(tls_server.socket, server_side=True)
    threading.Thread(target=tls_server.serve_forever, daemon=True).start()
    fixture = (base / "claude-implementation/repo/test/network/socks-fixture.js").as_uri()
    concurrent = any("concurrency" in case for case in (a.case or []))
    # Install merges existing owned profiles. Keep both disposable listeners
    # live even for one-account cases after a concurrency test installed B.
    sources = ["127.0.0.2", "127.0.0.3"]
    destinations = {route_addresses[0]: tls_server.server_port, route_addresses[1]: server.server_port,
                    "api.anthropic.com": tls_server.server_port, "api.ipify.org": tls_server.server_port}
    script = "import {startSocks} from " + json.dumps(fixture) + ";const servers=await Promise.all(" + json.dumps(sources) + ".map(sourceAddress=>startSocks({sourceAddress,destinations:" + json.dumps(destinations) + "})));console.log(JSON.stringify(servers.map(s=>s.port)));"
    if platform.system() == "Darwin":
        route_addresses.extend(sources)
    for address in route_addresses:
        command = ["/sbin/ifconfig", "lo0", "alias", address, "up"] if platform.system() == "Darwin" else ["ip", "address", "add", address + "/32", "dev", "lo"]
        subprocess.run(["sudo", "-n", *command], check=True, capture_output=True)
    subprocess.run(["sudo", "-n", "/usr/bin/python3", "-I", "-c", hosts_edit, hosts_tag, "add"], check=True)
    route_child = subprocess.Popen([str(a.node), "--input-type=module", "-e", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ports = json.loads(route_child.stdout.readline().strip())
    installed_profiles = {}
    for index, (port, source) in enumerate(zip(ports, sources)):
        ref = "impl_mock" if index == 0 else "impl_mock_b"
        profile = {"label": "synthetic", "profileRef": ref, "socksHost": "127.0.0.1", "socksPort": port,
            "expectedExits": [source], "exitCheckUrl": "http://198.18.0.25:" + str(server.server_port) + "/exit"}
        route_profiles[ref] = profile
        installed_profile = dict(profile)
        if platform.system() == "Linux": installed_profile["redirectPort"] = 15224 + index
        else: installed_profile.update(gid=64124 + index, interface="utun" + str(124 + index), subnetIndex=124 + index)
        installed_profiles[ref] = installed_profile
    route_profile = route_profiles["impl_mock"]
    manifest = root / "route-manifest.json"
    manifest.write_text(json.dumps({"user": pwd.getpwuid(os.getuid()).pw_name, "profiles": installed_profiles}))
    installer = base / ("claude-implementation/repo/scripts/install-claude-proxy-" + ("linux" if platform.system() == "Linux" else "macos") + ".sh")
    installed = subprocess.run(["sudo", "-n", "/bin/bash", str(installer), str(manifest)], capture_output=True, text=True)
    (root / "route-install.private.txt").write_text(installed.stdout + installed.stderr)
    if installed.returncode: raise RuntimeError("Synthetic route installation failed; inspect retained offsite log")
results = []
# Native DPs recognizes terminal families and maps unknown names to "other".
# Use its accepted iTerm2 shape so the telemetry-on control must expose the
# distinctive version, rather than passing an ineffective substring test.
TERMINAL_CANARY = "iTerm2 92471.63.17"


def captured_text(request):
    """Inspect the reviewed event envelope, including its base64 JSON fields.

    A raw substring scan misses terminal versions in additional_metadata. Keep
    original captures intact; decode only the two source-established JSON fields
    and refuse malformed envelopes instead of reporting an absent canary.
    """
    decoded = []
    body = request.get("body")
    if "/event_logging/" in request["path"] and isinstance(body, dict):
        for event in body.get("events", []):
            data = event.get("event_data", {})
            for key in ("additional_metadata", "process"):
                value = data.get(key)
                if isinstance(value, str):
                    decoded.append(json.loads(base64.b64decode(value, validate=True)))
    return json.dumps([request, decoded])


def interactive(arguments, home, env):
    """A fixture terminal, not a production relay or changed browser footprint."""
    request_start = len(requests)
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(home / "project")
        os.execve(arguments[0], arguments, env)
    fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 110, 0, 0))
    output = bytearray()
    counts = {"xtversionResponses": 0, "deviceAttributeResponses": 0}
    seen = {b"\x1b[>0q": 0, b"\x1b[c": 0, b"\x1b]11;?": 0}
    responses = {b"\x1b[>0q": b"\x1bP>|" + TERMINAL_CANARY.encode() + b"\x1b\\",
                 b"\x1b[c": b"\x1b[?1;2c", b"\x1b]11;?": b"\x1b]11;rgb:0000/0000/0000\x1b\\"}
    finished, exit_sent, model_at = False, False, None
    dynamic_phase, dynamic_at = "initial", None
    typing, next_key, submit_at = bytearray(), 0, None
    def enqueue(value):
        nonlocal typing, next_key, submit_at
        typing = bytearray(value.encode()); next_key = time.monotonic(); submit_at = None
    deadline = time.monotonic() + (90 if "detached-terminal" in active or "dynamic-directory" in active or "headers-reload" in active else 45)
    code = "timeout"
    opened_at = time.monotonic()
    inventory_at = 0
    if "detached-terminal" in active:
        inventory_script = Path(__file__).resolve().parent.parent / "native/claude/runtime_inventory.py"
        before_inventory = json.loads(subprocess.check_output(["/usr/bin/python3", "-I", str(inventory_script)], text=True))
        before_pids = {r["pid"] for r in before_inventory["processes"]}
        counts["processInventoryComplete"] = before_inventory["complete"]
        counts["newDetachedOwners"] = []
    remote_connected_at = None
    rc_debug_offset = (home / "project/debug.private.txt").stat().st_size if (home / "project/debug.private.txt").exists() else 0
    try:
        while time.monotonic() < deadline:
            if select.select([descriptor], [], [], .02)[0]:
                try:
                    chunk = os.read(descriptor, 65536)
                    if chunk:
                        output.extend(chunk)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                for query, response in responses.items():
                    total = output.count(query)
                    while seen[query] < total:
                        os.write(descriptor, response)
                        seen[query] += 1
                        if query == b"\x1b[>0q":
                            counts["xtversionResponses"] += 1
                        elif query == b"\x1b[c":
                            counts["deviceAttributeResponses"] += 1
            if model_at is None and any(r["case"] == active and "/messages" in r["path"] for r in requests[request_start:]):
                model_at = time.monotonic()
            if "detached-terminal" in active:
                if time.monotonic() - inventory_at > 1:
                    observed = json.loads(subprocess.check_output(["/usr/bin/python3", "-I", str(inventory_script)], text=True))
                    counts["processInventoryComplete"] &= observed["complete"]
                    counts["newDetachedOwners"] = sorted(set(counts["newDetachedOwners"]) | {r["pid"] for r in observed["processes"] if r["pid"] not in before_pids and r.get("role", "").startswith("detached-")})
                    inventory_at = time.monotonic()
                if typing and time.monotonic() >= next_key:
                    os.write(descriptor, bytes([typing.pop(0)])); next_key = time.monotonic() + .03
                    if not typing: submit_at = time.monotonic() + 1
                if submit_at is not None and time.monotonic() >= submit_at:
                    os.write(descriptor, b"\r"); submit_at = None; dynamic_at = time.monotonic()
                debug_file = home / "project/debug.private.txt"
                debug = debug_file.read_text(errors="replace") if debug_file.exists() else ""
                if dynamic_phase == "initial" and time.monotonic() - opened_at > 8:
                    enqueue("Reply SYNTHETIC_OK. DETACHED_FOREGROUND_CHECK.")
                    dynamic_phase = "first"
                elif dynamic_phase == "first" and model_at is not None and time.monotonic() - model_at > 8:
                    debug_offset = len(debug)
                    with (Path(env["CLAUDE_CONFIG_DIR"]) / "settings.json").open("r+") as stream:
                        stream.seek(0); json.dump({"skipDangerousModePermissionPrompt": True, "disableAgentView": False, "env": {
                            "CLAUDE_CODE_DISABLE_AGENT_VIEW": "0", "AIM_DETACHED_LIVE_SETTING": "after"}}, stream)
                        stream.truncate(); stream.flush(); os.fsync(stream.fileno())
                    dynamic_phase = "changed"
                elif dynamic_phase == "changed":
                    counts["settingsChangeObserved"] = "Detected change to" in debug[debug_offset:]
                    counts["appStateChangeObserved"] = "updating app state" in debug[debug_offset:]
                    if counts["settingsChangeObserved"] and counts["appStateChangeObserved"]:
                        enqueue("Check the live setting. DETACHED_LIVE_CHECK.")
                        dynamic_phase = "second"
                elif dynamic_phase == "second":
                    models = [r for r in requests[request_start:] if r["case"] == active and "/messages" in r["path"]]
                    if "DETACHED_LIVE_SETTING_after" in json.dumps([r["body"].get("messages") for r in models]):
                        counts["unrelatedLiveSettingApplied"] = True
                        enqueue("/background"); dynamic_phase = "background"
                elif dynamic_phase == "background" and not typing and submit_at is None:
                    plain = re.sub(rb'\s+', b'', re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', bytes(output)))
                    counts["backgroundCommandRefused"] = b"Unknowncommand:/background" in plain or b"Unknowncommand:background" in plain or b"disableAgentView" in plain or b"backgroundsessionsaredisabled" in plain.lower()
                    if counts["backgroundCommandRefused"]:
                        enqueue("/exit"); exit_sent = True; dynamic_phase = "exit"
            elif "-rc-" in active:
                # These are locally terminated synthetic RC sessions. Reach
                # native registration/transport once, then stop that owner;
                # never provide a remote instruction or forward provider data.
                captured = [r for r in requests[request_start:] if r["case"] == active]
                connected = any(urlsplit(r["path"]).path.endswith("/work/poll") or urlsplit(r["path"]).path.endswith("/worker/events/stream") for r in captured)
                if connected and remote_connected_at is None:
                    remote_connected_at = time.monotonic()
                if typing and time.monotonic() >= next_key:
                    os.write(descriptor, bytes([typing.pop(0)])); next_key = time.monotonic() + .03
                    if not typing: submit_at = time.monotonic() + 1
                if submit_at is not None and time.monotonic() >= submit_at:
                    os.write(descriptor, b"\r"); submit_at = None
                if active.endswith(("toggle", "saved")) and model_at is not None and dynamic_phase == "initial" and time.monotonic() - model_at > 3:
                    # A saved setting must start before this slash command.
                    # Native policy hides this command for Pro/Max accounts.
                    # The Enterprise upsell disabled stub is inapplicable.
                    if active.endswith("toggle") or a.integrated_aim or a.rc_policy_only:
                        enqueue("/remote-control")
                    dynamic_phase = "requested"
                text_output = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', bytes(output))
                debug_file = home / "project/debug.private.txt"
                native_policy_debug = debug_file.exists() and "disableRemoteControl" in debug_file.read_text(errors="replace")[rc_debug_offset:] and "--rc flag ignored." in debug_file.read_text(errors="replace")[rc_debug_offset:]
                policy_refusal = b"disableRemoteControl" in text_output or b"Remote Control is disabled for AI Manager" in text_output or native_policy_debug
                hidden_command = b"Unknown command: /remote-control" in text_output
                # Explicit AIM refusal exits naturally. Interrupting it at the
                # first output byte would replace exit 1 with a fixture SIGINT.
                interactive_refusal = not active.endswith(("standalone", "flag")) and (
                    policy_refusal or ((a.integrated_aim or a.rc_policy_only) and hidden_command))
                if not exit_sent and ((remote_connected_at is not None and time.monotonic() - remote_connected_at > 2)
                                      or interactive_refusal or (a.rc_policy_only and policy_refusal and not active.endswith("standalone"))):
                    os.write(descriptor, b"\x03")
                    time.sleep(.15)
                    os.write(descriptor, b"\x03")
                    exit_sent = True
            elif ("dynamic-directory" in active or "headers-reload" in active) and model_at is not None:
                if typing and time.monotonic() >= next_key:
                    os.write(descriptor, bytes([typing.pop(0)])); next_key = time.monotonic() + .03
                    if not typing: submit_at = time.monotonic() + 1
                if submit_at is not None and time.monotonic() >= submit_at:
                    os.write(descriptor, b"\r"); submit_at = None; dynamic_at = time.monotonic()
                if "headers-reload" in active:
                    models = [r for r in requests[request_start:] if r["case"] == active and "/messages" in r["path"]]
                    transcript = json.dumps([r.get("body") for r in models])
                    if dynamic_phase == "initial" and "HEADER_FIRST_SETTING_before" in transcript:
                        dynamic_phase, dynamic_at = "idle", time.monotonic()
                    elif dynamic_phase == "idle" and time.monotonic() - dynamic_at > 8:
                        debug = home / "project/debug.private.txt"
                        debug_offset = debug.stat().st_size if debug.exists() else 0
                        changed = {"env": {"ANTHROPIC_CUSTOM_HEADERS": "Authorization: Bearer SYNTHETIC_HEADER_OVERRIDE\nX-Aim-Initial: changed",
                                           "AIM_HEADER_LIVE_PROBE": "after"}}
                        # Edit externally after idle, preserving the inode.
                        # Native watcher initialization is asynchronous: an
                        # immediate first-turn Bash edit can precede readiness.
                        # Its startup settings writer also suppresses events
                        # for five seconds. Wait beyond that known native
                        # receipt, or the unwrapped Mac baseline drops our edit.
                        with (Path(env["CLAUDE_CONFIG_DIR"]) / "settings.json").open("r+") as stream:
                            stream.seek(0); json.dump(changed, stream); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
                        dynamic_phase, dynamic_at = "changed", time.monotonic()
                    elif dynamic_phase == "changed":
                        debug = (home / "project/debug.private.txt").read_text(errors="replace")[debug_offset:]
                        counts["settingsChangeObserved"] = "Detected change to" in debug
                        counts["appStateChangeObserved"] = "Settings changed from" in debug and "updating app state" in debug
                        if counts["settingsChangeObserved"] and counts["appStateChangeObserved"]:
                            enqueue("Check the unrelated live setting. NATIVE_SECOND_HEADER_TURN.")
                            dynamic_phase, dynamic_at = "second", time.monotonic()
                    elif dynamic_phase == "second" and "HEADER_LIVE_SETTING_" in transcript and not typing and submit_at is None:
                        dynamic_phase, dynamic_at = "completed", time.monotonic()
                    elif dynamic_phase == "completed" and time.monotonic() - dynamic_at > 2:
                        enqueue("/exit"); exit_sent = True; dynamic_phase = "exit"
                elif dynamic_phase == "initial" and time.monotonic() - model_at > 2:
                    enqueue("/add-dir " + str(home / "added-dir"))
                    dynamic_phase, dynamic_at = "directory", time.monotonic()
                elif dynamic_phase == "directory" and not typing and submit_at is None and b"Yes, for this session" in output:
                    # Native /add-dir asks for confirmation even in bypass
                    # mode. This fixture owns the synthetic directory; accept
                    # that exact dialog before entering another task prompt.
                    # Typing the prompt into the dialog silently consumes it.
                    os.write(descriptor, b"\r")
                    dynamic_phase, dynamic_at = "confirmed", time.monotonic()
                elif dynamic_phase == "directory" and not typing and submit_at is None and b"networkpath,whichcannotbeadded" in re.sub(rb'\s+', b'', re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', bytes(output))):
                    # The protected OS read denial is rendered by native's
                    # path validator as a network-path refusal. Still request
                    # the actual Read, so the paired test measures access as
                    # well as the slash-command result; do not time out here.
                    dynamic_phase, dynamic_at = "confirmed", time.monotonic()
                elif dynamic_phase == "confirmed" and time.monotonic() - dynamic_at > 3:
                    enqueue("Read the added directory proof. NATIVE_ADDED_DIRECTORY.")
                    dynamic_phase, dynamic_at = "read", time.monotonic()
                elif dynamic_phase == "read" and not typing and submit_at is None and time.monotonic() - dynamic_at > 8:
                    enqueue("/exit"); exit_sent = True; dynamic_phase = "exit"
            elif model_at is not None and time.monotonic() - model_at > (8 if "errors" in active else 2) and not exit_sent:
                os.write(descriptor, b"/exit\r")
                exit_sent = True
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = os.waitstatus_to_exitcode(status)
                finished = True
                break
    finally:
        if not finished:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(descriptor)
    return output.decode(errors="replace"), "", code, counts


cases = [
    ("api-key-telemetry-on", None, False, None),
    ("api-key-telemetry-off", None, True, None),
    ("pro-sign-in", "pro", True, "sign_in"),
    ("max-sign-in", "max", True, "sign_in"),
    ("team-positive-control", "team", True, "sign_in"),
    ("pro-stale-profile", "pro", True, "profile"),
    ("pro-stale-cached-policy", "pro", True, "profile"),
    ("pro-stale-cached-policy-disabled", "pro", True, "profile"),
    ("pro-expired-refresh", "pro", True, "sign_in"),
    ("ordinary-pro-stale-cached-policy-disabled", "pro", False, "profile"),
    ("ordinary-max-stale-cached-policy-disabled", "max", False, "profile"),
    ("ordinary-pro-refresh-upgrade-disabled", "pro", False, "sign_in"),
    ("protected-pro-refresh-upgrade-disabled", "pro", True, "sign_in"),
    ("protected-pro-workflows-disabled", "pro", True, "sign_in"),
    ("ordinary-pro-workflows-disabled", "pro", False, "sign_in"),
    ("ordinary-pro-detached-disabled", "pro", False, "sign_in"),
    ("ordinary-pro-detached-terminal-disabled", "pro", False, "sign_in"),
    ("protected-pro-detached-terminal-disabled", "pro", True, "sign_in"),
    ("pro-errors-on", "pro", False, "sign_in"),
    ("pro-errors-off", "pro", False, "sign_in"),
    ("protected-pro-errors-disabled", "pro", True, "sign_in"),
    ("protected-pro-schedules-disabled", "pro", True, "sign_in"),
    ("protected-pro-schedules-refusals-disabled", "pro", True, "sign_in"),
    ("ordinary-pro-schedules-disabled", "pro", False, "sign_in"),
    ("protected-pro-dynamic-directory-disabled", "pro", True, "sign_in"),
    ("protected-pro-startup-directory-disabled", "pro", True, "sign_in"),
    ("protected-pro-headers-reload-disabled", "pro", True, "sign_in"),
    ("pro-rc-standalone", "pro", True, "sign_in"),
    ("pro-rc-flag", "pro", True, "sign_in"),
    ("pro-rc-toggle", "pro", True, "sign_in"),
    ("pro-rc-saved", "pro", True, "sign_in"),
    ("protected-pro-compatibility-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-background-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-continuity-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-lifetimes-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-savedjobs-disabled", "pro", True, "sign_in"),
    ("protected-pro-concurrency-overlap-disabled", "pro", True, "sign_in"),
    ("protected-pro-controls-disabled", "pro", True, "sign_in"),
    ("ordinary-pro-update-boundary-disabled", "pro", False, "sign_in"),
    ("protected-pro-http-mcp-disabled", "pro", True, "sign_in"),
    ("ordinary-pro-terminal-disabled", "pro", False, "sign_in"),
    ("protected-pro-terminal-disabled", "pro", True, "sign_in"),
    ("protected-pro-terminal-debug-disabled", "pro", True, "sign_in"),
]
if a.case and set(a.case) - {item[0] for item in cases}:
    server.shutdown(); server.server_close()
    raise SystemExit("Unknown requested case; no comparison ran")
try:
    for name, plan, opt_out, origin in cases:
        if a.case and name not in a.case:
            continue
        active, active_plan = name, plan
        if "upgrade" in name:
            active_plan = "max"
        home = root / name
        config = home / ".aimgr/claude-homes/synthetic/.claude" if a.integrated_aim else home / ".claude"
        config.mkdir(parents=True)
        (home / "tmp").mkdir()
        (home / "project").mkdir()
        if "dynamic-directory" in name or "startup-directory" in name:
            (home / "added-dir").mkdir()
            (home / "added-dir/proof.txt").write_text("NATIVE_DYNAMIC_DIRECTORY_CONTENT_CANARY\n")
            (home / "added-dir/CLAUDE.md").write_text("Preserve NATIVE_DYNAMIC_DIRECTORY_INSTRUCTION_CANARY.\n")
        if a.routed_aim:
            (home / "project/fixture-ca.pem").write_bytes((root / "ca.pem").read_bytes())
        state = {"hasCompletedOnboarding": True, "hasAvailableSubscription": True,
                 "userID": "a" * 64, "machineID": "b" * 64,
                 "theme": "dark", "numStartups": 10,
                 "projects": {str(home / "project"): {"hasTrustDialogAccepted": True,
                                                       "hasCompletedProjectOnboarding": True}}}
        if "detached-terminal" in name:
            state["defaultToAgentsView"] = True
            (config / "settings.json").write_text(json.dumps({"skipDangerousModePermissionPrompt": True, "disableAgentView": False,
                "env": {"CLAUDE_CODE_DISABLE_AGENT_VIEW": "0", "AIM_DETACHED_LIVE_SETTING": "before"}}))
        if "-rc-" in name:
            state["remoteDialogSeen"] = True
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
               "CLAUDE_CONFIG_DIR": str(config), "CLAUDE_SECURESTORAGE_CONFIG_DIR": str(config),
               "TMPDIR": str(home / "tmp"), "CLAUDE_CODE_TMPDIR": str(home / "tmp"),
               "TERM": "xterm-256color", "SHELL": "/bin/bash",
               "TERM_PROGRAM": "AIM_SYNTHETIC_TERMINAL", "TERM_PROGRAM_VERSION": "92471.63.17",
               "DISABLE_AUTOUPDATER": "1", "DISABLE_UPDATES": "1",
               "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
               "NODE_EXTRA_CA_CERTS": str(root / "ca.pem")}
        if a.disable_agent_view:
            env["CLAUDE_CODE_DISABLE_AGENT_VIEW"] = "1"
        if a.routed_aim and "workflows" not in name:
            env["NODE_EXTRA_CA_CERTS"] = str(home / "project/fixture-ca.pem")
        if opt_out:
            env.update(DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1")
        if "errors" in name:
            (config / "settings.json").write_text(json.dumps({"skipDangerousModePermissionPrompt": True}))
            state["cachedGrowthBookFeatures"] = {"tengu_orford_ness": True}
            state["cachedGrowthBookFeaturesAt"] = int(time.time() * 1000)
            env["CLAUDE_CODE_DD_ERROR_TRACKING_FLUSH_INTERVAL_MS"] = "100"
            if name == "pro-errors-off": env["DISABLE_ERROR_REPORTING"] = "1"
            if a.integrated_aim:
                env.update(CLAUDE_CODE_ENABLE_TELEMETRY="1", OTEL_LOGS_EXPORTER="otlp", OTEL_METRICS_EXPORTER="otlp",
                    OTEL_TRACES_EXPORTER="none", OTEL_EXPORTER_OTLP_PROTOCOL="http/json",
                    OTEL_EXPORTER_OTLP_ENDPOINT=proxy, OTEL_LOGS_EXPORT_INTERVAL="100", OTEL_METRIC_EXPORT_INTERVAL="100")
        if a.poll_settings:
            # Isolate watcher transport from settings precedence. Some rental
            # Mac baseline runs report a working fs.watch probe but deliver no
            # settings event. This never changes the production launch env.
            env["CHOKIDAR_USEPOLLING"] = "1"
        if "cached-policy" in name:
            # The shipped override methods are compiled no-ops, but this opt-in
            # permits reading persisted flags while telemetry is disabled.
            env["CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF"] = "1"
            state["cachedGrowthBookFeatures"] = {"tengu_org_config_required": {
                "enabled": True, "plans": ["team", "enterprise"], "percent": 100,
                "graceTtlHours": 1, "budgetMs": 6000, "hostTokens": False,
                "exemptReasons": [], "refuseNotEntitled": False}}
            state["cachedGrowthBookFeaturesAt"] = int(time.time() * 1000)
        if name.endswith("disabled") or a.approved_mac_launcher:
            env["DISABLE_GROWTHBOOK"] = "1"
        if plan:
            state["oauthAccount"] = {"accountUuid": "00000000-0000-4000-8000-000000000001",
                                     "emailAddress": "synthetic@example.invalid",
                                     "organizationUuid": "00000000-0000-4000-8000-000000000002"}
            oauth = {"accessToken": "sk-ant-oat01-synthetic-not-a-real-token", "refreshToken": "synthetic-refresh",
                     "expiresAt": int((time.time() + 86400) * 1000),
                     "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
                     "subscriptionType": plan, "subscriptionTypeSource": origin,
                     "rateLimitTier": "default_claude_max_5x"}
            if origin == "profile":
                oauth["subscriptionTypeVerifiedAt"] = 1
            if "refresh" in name:
                oauth["expiresAt"] = int((time.time() - 3600) * 1000)
            (config / ".credentials.json").write_text(json.dumps({"claudeAiOauth": oauth}))
        else:
            env["ANTHROPIC_API_KEY"] = "sk-ant-synthetic-not-a-real-key"
        (config / ".claude.json").write_text(json.dumps(state))
        if "headers-reload" in name:
            (config / "settings.json").write_text(json.dumps({"env": {
                "ANTHROPIC_CUSTOM_HEADERS": "X-Aim-Initial: initial", "AIM_HEADER_LIVE_PROBE": "before"}}))
        if "update-boundary" in name:
            updater = home / "xdg-actual/claude/versions/unknown"
            updater.mkdir(parents=True)
            (home / "xdg-alias").symlink_to(home / "xdg-actual", target_is_directory=True)
            env["XDG_DATA_HOME"] = str(home / "xdg-alias")
            marker = home / "project/unapproved-executed"
            (updater / "claude").write_text("#!/bin/sh\n: > " + shlex.quote(str(marker)) + "\n")
            (updater / "claude").chmod(0o700)
            (updater / "unknown.py").write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").touch()\n")
            check = '''import json,subprocess
from pathlib import Path
updater=Path(UPDATER);marker=Path(MARKER);checks=[]
try:
 (updater/'replacement').write_text('must refuse')
 checks.append({'name':'updater-write','passed':False})
except PermissionError:checks.append({'name':'updater-write','passed':True})
for name,argv in [('direct',[str(updater/'claude')]),('interpreter',['/usr/bin/python3',str(updater/'unknown.py')])]:
 try: code=subprocess.run(argv,capture_output=True,timeout=15).returncode
 except PermissionError:code=126
 checks.append({'name':name,'exit':code,'passed':code!=0 and not marker.exists()})
project=marker.parent;proof=project/'project-script-proof';script=project/'ordinary.sh'
script.write_text('#!/bin/sh\\nprintf ordinary-ok > '+str(proof)+'\\n');script.chmod(0o700)
code=subprocess.run([str(script)],capture_output=True,timeout=15).returncode
checks.append({'name':'ordinary-project-script','exit':code,'passed':code==0 and proof.read_text()=='ordinary-ok'})
source=project/'ordinary.c';source.write_text('#include <stdio.h>\\nint main(void){puts("NATIVE_C_BUILD_OK");return 0;}\\n')
binary=project/'ordinary-build';built=subprocess.run(['/usr/bin/cc',str(source),'-o',str(binary)],capture_output=True,timeout=30)
ran=subprocess.run([str(binary)],capture_output=True,text=True,timeout=15) if built.returncode==0 else None
checks.append({'name':'native-c-build-and-run','passed':built.returncode==0 and ran.returncode==0 and ran.stdout.strip()=='NATIVE_C_BUILD_OK'})
result={'checks':checks,'passed':all(c['passed'] for c in checks)}
(project/'update-observations.json').write_text(json.dumps(result))
print(json.dumps(result))
'''.replace("UPDATER", repr(str(updater))).replace("MARKER", repr(str(marker)))
            (home / "project/update-check.py").write_text(check)
        if "-rc-" in name:
            (config / "settings.json").write_text(json.dumps({"remoteControlAtStartup": name.endswith("saved")}))
        start = len(requests)
        arguments = [str(a.claude), "-p", "Reply SYNTHETIC_OK.", "--model", "sonnet"]
        if "startup-directory" in name:
            arguments[2] = "Read the extra folder proof. NATIVE_ADDED_DIRECTORY."
            arguments += ["--add-dir", str(home / "added-dir")]
        if a.integrated_aim or "headers-reload" in name or "-rc-" in name or "errors" in name:
            arguments += ["--debug-file", str(home / "project/debug.private.txt")]
        if "terminal" in name or "dynamic-directory" in name or "headers-reload" in name or "-rc-" in name or "errors" in name:
            arguments.remove("-p")
        if "detached-terminal" in name:
            # No initial prompt: exercise persisted default-view startup itself.
            arguments.remove("Reply SYNTHETIC_OK.")
            arguments += ["--dangerously-skip-permissions"]
        if name == "pro-rc-standalone":
            arguments = [str(a.claude), "remote-control"]
        elif name == "pro-rc-flag":
            arguments += ["--rc"]
        if "dynamic-directory" in name or "startup-directory" in name or "headers-reload" in name or "update-boundary" in name or "errors" in name:
            arguments += ["--dangerously-skip-permissions"]
        if "terminal-debug" in name:
            arguments += ["--debug-file", str(home / "debug.private.txt")]
        if name.endswith("disabled") or a.rc_policy_only:
            # Match the common approved pin without disabling ordinary optional
            # analytics. Composition/override tests exercise the JS producer.
            settings = home / "launch-settings.json"
            settings.write_text(json.dumps({"disableRemoteControl": True,
                **({"skipDangerousModePermissionPrompt": True} if "dynamic-directory" in name or "headers-reload" in name else {}),
                "env": {} if a.rc_policy_only else {"DISABLE_GROWTHBOOK": "1"}}))
            if a.rc_policy_only and name == "pro-rc-standalone":
                # Standalone rejects root --settings before reaching its policy
                # gate. Use the native user source for this one control.
                (config / "settings.json").write_bytes(settings.read_bytes())
            else:
                arguments += ["--settings", str(settings)]
        environment_transfer = None
        if a.approved_mac_launcher:
            if "terminal" in name:
                raise SystemExit("Use the dedicated native terminal fixture for candidate PTY tests")
            environment_transfer = tempfile.TemporaryFile(dir=home)
            environment_transfer.write(b"".join((key+"="+value).encode()+b"\0" for key,value in env.items()))
            environment_transfer.flush()
            update = home / "unapproved-update"; update.mkdir()
            arguments = [str(a.approved_mac_launcher), "v1", a.privacy_mode, str(config), str(settings),
                str(home / "tmp"), str(environment_transfer.fileno()), "2", str(home / "project"), str(root / "ca.pem"),
                "1", str(update), "--", *arguments[1:]]
        if a.integrated_aim:
            if not a.node or not plan or a.approved_mac_launcher or (a.privacy_mode == "protected" and not a.routed_aim):
                raise SystemExit("Integrated stored OAuth requires Node and actual protected route when applicable")
            driver = Path(__file__).resolve().with_name("privacy-integrated-launch-check.mjs")
            invocation = {"mode": a.privacy_mode, "command": str(a.claude), "userHomeDir": str(home),
                "homeDir": str(config.parent), "configDir": str(config), "cwd": str(home / "project"), "args": arguments[1:]}
            if "detached" in name and "terminal" not in name:
                invocation.update(check="detached", captureFile=str(root / "requests.private.jsonl"))
            if "workflows" in name:
                invocation["check"] = "workflows"
                invocation["captureFile"] = str(root / "requests.private.jsonl")
            if "schedules" in name:
                invocation.update(check="schedule-refusals" if "refusals" in name else "schedules", captureFile=str(root / "requests.private.jsonl"))
            if "compatibility" in name:
                invocation.update(check="compatibility", captureFile=str(root / "requests.private.jsonl"))
            if "controls" in name:
                invocation.update(check="controls", captureFile=str(root / "requests.private.jsonl"))
            if "concurrency" in name:
                invocation.update(check="concurrency", captureFile=str(root / "requests.private.jsonl"), profiles=route_profiles, background="background" in name, continuity="continuity" in name, failureLifecycle="lifetimes" in name, savedJobs="savedjobs" in name, workflowOverlap="overlap" in name)
            if "terminal" in name or "dynamic-directory" in name or "headers-reload" in name or "-rc-" in name or "errors" in name:
                invocation["check"] = "interactive"
            if "http-mcp" in name:
                invocation["check"] = "http-mcp"
                invocation["captureFile"] = str(root / "requests.private.jsonl")
            if route_profile: invocation["egressProfile"] = route_profile
            if a.background_review:
                driver = Path(__file__).resolve().with_name("privacy-claude-background-review.mjs")
                invocation["captureFile"] = str(root / "requests.private.jsonl")
            arguments = [str(a.node), str(driver), json.dumps(invocation)]
        if a.sandbox_profile:
            if platform.system() != "Darwin" or a.sandbox_profile.resolve().parent != root.parent:
                raise SystemExit("Only a dedicated rented-Mac policy is supported")
            arguments = ["/usr/bin/sandbox-exec", "-f", str(a.sandbox_profile), *arguments]
        terminal = {}
        if "terminal" in name or "dynamic-directory" in name or "headers-reload" in name or "-rc-" in name or "errors" in name:
            out, err, code, terminal = interactive(arguments, home, env)
            if name == "pro-rc-saved" and code != "timeout":
                first_exit = code
                restart_at = len(requests)
                more_out, more_err, code, restarted = interactive(arguments, home, env)
                out += more_out; err += more_err
                terminal.update(firstExit=first_exit, restartExit=code,
                    restartedWithoutRcFlag=True,
                    restartRcCreations=sum(urlsplit(r["path"]).path == "/v1/code/sessions" for r in requests[restart_at:]))
        else:
            child = subprocess.Popen(arguments,
                                     cwd=home / "project", env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                                     pass_fds=(environment_transfer.fileno(),) if environment_transfer else ())
            if environment_transfer: environment_transfer.close()
            try:
                out, err = child.communicate(timeout=240 if "schedules" in name or "concurrency" in name else 180 if "detached" in name or "workflows" in name or "http-mcp" in name or "compatibility" in name or "controls" in name else 45)
                code = child.returncode
            except subprocess.TimeoutExpired:
                observed = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,uid=,gid=,stat=,command="], capture_output=True, text=True)
                (home / "processes.private.txt").write_text(observed.stdout)
                os.killpg(child.pid, signal.SIGKILL)
                out, err = child.communicate()
                code = "timeout"
        (home / "output.private.txt").write_text(out + err)
        captures = requests[start:]
        stored = json.loads((config / ".credentials.json").read_text()).get("claudeAiOauth", {}) if plan else {}
        results.append({"case": name, "exit": code, "syntheticModelCompleted": code == 0 and "SYNTHETIC_OK" in out,
                        "requestPaths": sorted(set(urlsplit(r["path"]).path for r in captures)),
                        "modelRequests": sum("/messages" in r["path"] for r in captures),
                        "modelSources": sorted(set(r["source"] for r in captures if "/messages" in r["path"])),
                        **({"errorLifecycle": {
                            "nativeErrorBatches": sum("browser-intake-us5-datadoghq.com" in r["host"] and r["path"].startswith("/api/v2/logs") for r in captures),
                            "nativeErrorCanaryUploaded": any("browser-intake-us5-datadoghq.com" in r["host"] and "AIM_ERROR_PROBE" in json.dumps(r["body"]) for r in captures),
                            "expectedToolFailureReachedModel": any("SYNTHETIC_EXPECTED_TOOL_FAILURE" in json.dumps(r["body"]) for r in captures if "/messages" in r["path"]),
                            "independentUserOtelLogs": any(r["path"] == "/v1/logs" and "claude_code" in json.dumps(r["body"]) for r in captures),
                            "independentUserOtelMetrics": any(r["path"] == "/v1/metrics" and "claude_code" in json.dumps(r["body"]) for r in captures),
                            "shutdownCompleted": code == 0,
                        }} if "errors" in name else {}),
                        "managedSettingsFetches": sum("/api/claude_code/settings" in r["path"] for r in captures),
                        "refreshRequests": sum(isinstance(r["body"], dict) and r["body"].get("grant_type") == "refresh_token" for r in captures),
                        "refreshedCredentialStored": stored.get("accessToken") == "sk-ant-oat01-synthetic-refreshed",
                        "storedSubscriptionType": stored.get("subscriptionType"),
                        "storedSubscriptionTypeSource": stored.get("subscriptionTypeSource"),
                        "storedSubscriptionFresh": isinstance(stored.get("subscriptionTypeVerifiedAt"), (int, float)) and stored["subscriptionTypeVerifiedAt"] > (time.time() - 60) * 1000,
                        "exactKernelInModel": any(platform.release() in json.dumps(r["body"]) for r in captures if "/messages" in r["path"]),
                        "hostnameInRequests": any(socket.gethostname() in json.dumps(r) for r in captures),
                        **({"directoryAccess": {
                            "requestedAtStartup": "startup-directory" in name,
                            "nativeAddDirectoryRefused": "networkpath,whichcannotbeadded" in re.sub(r'\s+', '', re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', out)),
                            "nativeReadSucceeded": any("NATIVE_DYNAMIC_DIRECTORY_CONTENT_CANARY" in json.dumps(r["body"]) for r in captures if "/messages" in r["path"]),
                            "newInstructionLoaded": any("NATIVE_DYNAMIC_DIRECTORY_INSTRUCTION_CANARY" in json.dumps(r["body"]) for r in captures if "/messages" in r["path"]),
                            "readAttempted": any("dynamic_directory_read" in json.dumps(r["body"]) for r in captures if "/messages" in r["path"])}} if "dynamic-directory" in name or "startup-directory" in name else {}),
                        "eventLoggingRequests": sum("/event_logging/" in r["path"] for r in captures),
                        **({"ordinaryUpdateBoundary": json.loads((home / "project/update-observations.json").read_text())}
                           if (home / "project/update-observations.json").exists() else {}),
                        **({"remoteControl": {
                            "environmentRegistrations": sum(urlsplit(r["path"]).path == "/v1/environments/bridge" for r in captures),
                            "standalonePolls": sum(urlsplit(r["path"]).path.endswith("/work/poll") for r in captures),
                            "sessionCreations": sum(urlsplit(r["path"]).path == "/v1/code/sessions" for r in captures),
                            "workerRegistrations": sum(r["method"] == "PUT" and r["path"].endswith("/worker") for r in captures),
                            "streams": sum(r["path"].endswith("/worker/events/stream") for r in captures),
                            "policyRefusal": "disableRemoteControl" in out or "Remote Control is disabled for AI Manager" in out + err,
                            "nativeFlagPolicyDiagnostic": (home / "project/debug.private.txt").exists() and "disableRemoteControl" in (home / "project/debug.private.txt").read_text(errors="replace") and "--rc flag ignored." in (home / "project/debug.private.txt").read_text(errors="replace"),
                            "commandHidden": "Unknown command: /remote-control" in re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', out),
                            "transportConnected": (home / "project/debug.private.txt").exists() and "SSETransport: Connected" in (home / "project/debug.private.txt").read_text(errors="replace"),
                        }} if "-rc-" in name else {}),
                        **({"headerReload": {
                            "initialValues": [next((value for key, value in r["headers"].items() if key.lower() == "x-aim-initial"), None) for r in captures if "/messages" in r["path"]],
                            "competingAuthSent": any(any(key.lower() == "authorization" and "SYNTHETIC_HEADER_OVERRIDE" in value for key, value in r["headers"].items()) for r in captures),
                            "unrelatedSettingReloaded": any("HEADER_LIVE_SETTING_after" in json.dumps(r["body"]) for r in captures if "/messages" in r["path"]),
                        }} if "headers-reload" in name else {}),
                        **terminal,
                        "terminalCanaryInModel": any(TERMINAL_CANARY in captured_text(r) for r in captures if "/messages" in r["path"]),
                        "terminalCanaryInEvents": any(TERMINAL_CANARY in captured_text(r) for r in captures if "/event_logging/" in r["path"]),
                        "terminalCanaryInOtherRequests": any(TERMINAL_CANARY in captured_text(r) for r in captures if "/event_logging/" not in r["path"] and "/messages" not in r["path"]),
                        "terminalCanaryInLocalDebug": (home / "debug.private.txt").exists() and TERMINAL_CANARY in (home / "debug.private.txt").read_text(),
                        **({"workflows": json.loads((home / "workflows.json").read_text())} if (home / "workflows.json").exists() else {}),
                        **({"detached": json.loads((home / "detached.json").read_text())} if (home / "detached.json").exists() else {}),
                        **({"backgroundReview": json.loads((home / "background-review.json").read_text())} if (home / "background-review.json").exists() else {}),
                        **({"compatibility": json.loads((home / "compatibility.json").read_text())} if (home / "compatibility.json").exists() else {}),
                        **({"controls": json.loads((home / "controls.json").read_text())} if (home / "controls.json").exists() else {}),
                        **({"concurrency": json.loads((home / "concurrency.json").read_text())} if (home / "concurrency.json").exists() else {}),
                        **({"schedules": json.loads((home / "schedules.json").read_text())} if (home / "schedules.json").exists() else {}),
                        **({"httpMcp": json.loads((home / "http-mcp.json").read_text())} if (home / "http-mcp.json").exists() else {}),
                        "connectAuthorities": sorted(set(r["authority"] for r in connections if r["case"] == name))})
finally:
    cleanup_route()
    atexit.unregister(cleanup_route)
    server.shutdown()
    server.server_close()
report = {"integratedAim": a.integrated_aim, "mode": a.privacy_mode, "actualNativeRoute": a.routed_aim, "platform": platform.system(), "artifactSha256": digest, "results": results,
          "disableAgentView": a.disable_agent_view, "backgroundReview": a.background_review,
          "settingsWatcherPollingDiagnostic": a.poll_settings,
          "remoteControlPolicyOnlyComparison": a.rc_policy_only,
          "captureAnalysis": "Decoded additional_metadata and process base64 JSON in native event envelopes",
          "meaning": "Default-host synthetic captures; no real-account eligibility or full lifecycle acceptance"}
(root / "observations.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
