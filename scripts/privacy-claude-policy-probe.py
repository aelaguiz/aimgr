#!/usr/bin/env python3
"""Exercise scoped Claude settings before choosing a production launcher policy.

Only the two already identified official 2.1.317 artifacts are admitted. The
Linux caller must supply a loopback-only network namespace; the rented Mac must
have its independent cloud egress denial installed. All homes, credentials,
requests and tool results are synthetic. A settings refusal is not a full
remote-control lifecycle pass: eligibility and active-owner tests remain separate.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import signal
import socket
import subprocess
import threading
import tempfile

EXPECTED = {
    "Linux": "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0",
    "Darwin": "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9",
}
p = argparse.ArgumentParser()
p.add_argument("--root", type=Path, required=True)
p.add_argument("--claude", type=Path, required=True)
p.add_argument("--case", action="append", help="Run only these named comparisons")
p.add_argument("--sandbox-profile", type=Path, help="Rented-Mac pre-exec Seatbelt fixture")
p.add_argument("--approved-mac-launcher", type=Path, help="Installed candidate native entry on the rented Mac")
p.add_argument("--approved-linux-launcher", type=Path, help="Installed candidate native entry on the offsite Linux VM")
p.add_argument("--privacy-mode", choices=["ordinary", "protected"], default="protected")
p.add_argument("--read-root", type=Path, action="append", default=[], help="Synthetic additional native read grant for installed Mac candidate")
p.add_argument("--mac-reentry-role", choices=["a", "b"], help="Fixed hardened offsite native reentry decision fixture")
p.add_argument("--native-launcher", type=Path, help="Root-started Linux metadata decision fixture")
p.add_argument("--apparmor-profile", help="Offsite Linux per-executable file decision fixture")
p.add_argument("--file-canary", type=Path, help="Synthetic file: native Read denied, intentional Bash allowed")
p.add_argument("--host-id-read", action="store_true", help="Offsite Linux only: compare native Read of the fixed machine-ID file")
p.add_argument("--tool-check", type=Path, help="Offsite synthetic check run by the intentional Bash tool")
p.add_argument("--composed-settings", type=Path, help="Synthetic output from the AIM settings component")
a = p.parse_args()
base = Path("/opt/aimgr-state-audit")
root = a.root.resolve()
if not (base / "OFFSITE_AUDIT_HOST").is_file() or root.parent not in (base, base / "claude-implementation"):
    raise SystemExit("Marked offsite host and dedicated fixture directory required")
if root.exists():
    raise SystemExit("Refusing reused fixture")
host_id = None
if a.host_id_read:
    if platform.system() != "Linux":
        raise SystemExit("The fixed machine-ID comparison requires the offsite Linux host")
    host_id = Path('/etc/machine-id').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{32}', host_id):
        raise SystemExit("Expected a normal disposable-host machine ID")
if platform.system() == "Linux" and sorted(n for _, n in socket.if_nameindex()) != ["lo"]:
    raise SystemExit("Loopback-only network namespace required")
if a.approved_mac_launcher and (platform.system() != "Darwin" or not str(a.approved_mac_launcher.resolve()).startswith("/opt/aimgr-claude-runtime/artifacts/")):
    raise SystemExit("Installed offsite Mac candidate required")
if a.approved_linux_launcher and (platform.system() != "Linux" or not str(a.approved_linux_launcher.resolve()).startswith("/opt/aimgr-claude-runtime/artifacts/")):
    raise SystemExit("Installed offsite Linux candidate required")
approved_launcher = a.approved_mac_launcher or a.approved_linux_launcher
if a.mac_reentry_role and platform.system() != "Darwin":
    raise SystemExit("Rented Mac required for native reentry fixture")
if a.native_launcher and (platform.system() != "Linux" or os.geteuid() != 0):
    raise SystemExit("The Linux decision fixture must start as root and drop both native processes")
if a.apparmor_profile and (platform.system() != "Linux" or a.apparmor_profile != "aim-claude-decision"):
    raise SystemExit("Only the fixed Linux AppArmor decision profile is supported")
if a.file_canary and (base / "claude-implementation" not in a.file_canary.resolve().parents
                      or a.file_canary.name not in ("hidden-canary", "hidden-canary-a", "hidden-canary-b")
                      or a.file_canary.read_text() != "SYNTHETIC_FILE_CANARY"):
    raise SystemExit("Only the fixed synthetic file canary is supported")
for grant in a.read_root:
    if not approved_launcher or base / "claude-implementation" not in grant.resolve().parents:
        raise SystemExit("Only dedicated offsite candidate grants are supported")
if a.tool_check and a.tool_check.resolve().parent != base / "claude-implementation":
    raise SystemExit("Only a check in the dedicated offsite fixture directory is supported")
if a.composed_settings and (a.composed_settings.resolve().parent != base / "claude-implementation"
                           or a.composed_settings.with_suffix(".hooks.jsonl").exists()):
    raise SystemExit("Dedicated composed-settings source and fresh lifecycle log required")
if os.geteuid() == 0 and not a.native_launcher:
    raise SystemExit("Run the admitted vendor as the disposable unprivileged user")
digest = hashlib.sha256()
with a.claude.open("rb") as binary:
    for block in iter(lambda: binary.read(1024 * 1024), b""):
        digest.update(block)
if digest.hexdigest() != EXPECTED.get(platform.system()):
    raise SystemExit("Unapproved research artifact")
os.umask(0o077)
root.mkdir()
if a.native_launcher:
    user = pwd.getpwnam("aimprivacy")
    os.chown(root, user.pw_uid, user.pw_gid)
requests = []
active = None
command = ""
reload_command = None


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        requests.append({"case": active, "path": self.path, "headers": dict(self.headers), "body": body})
        with (root / "requests.private.jsonl").open("a") as f:
            f.write(json.dumps(requests[-1]) + "\n")
        if active.endswith("-model-error") and "messages" in self.path:
            raw = json.dumps({"type": "error", "error": {"type": "invalid_request_error",
                             "message": "AIM_SYNTHETIC_MODEL_FAILURE"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if "count_tokens" in self.path:
            result = {"input_tokens": 10}
        elif "messages" in self.path:
            completed = any(
                c.get("type") == "tool_result" and "POLICY_ENV" in str(c.get("content"))
                for m in body.get("messages", [])
                for c in (m.get("content") if isinstance(m.get("content"), list) else [])
            )
            reloaded = any(
                c.get("type") == "tool_result" and "POLICY_RELOAD" in str(c.get("content"))
                for m in body.get("messages", [])
                for c in (m.get("content") if isinstance(m.get("content"), list) else [])
            )
            read_attempted = any(
                c.get("type") == "tool_result" and c.get("tool_use_id") == "file_read_probe"
                for m in body.get("messages", [])
                for c in (m.get("content") if isinstance(m.get("content"), list) else [])
            )
            tool_failed = any(
                c.get("type") == "tool_result" and c.get("is_error")
                and str(c.get("tool_use_id", "")).startswith("policy_tool_")
                for m in body.get("messages", [])
                for c in (m.get("content") if isinstance(m.get("content"), list) else [])
            ) or sum(r["case"] == active and "messages" in r["path"] for r in requests) > 20
            # A broken test tool must produce a failed observation, not an
            # unbounded loop replaying the same stateful command and history.
            finished = completed or tool_failed
            terminal_text = "POLICY_TOOL_FAILED" if tool_failed else "POLICY_DONE"
            content = ({"type": "text", "text": terminal_text} if finished else {
                "type": "tool_use", "id": "policy_tool_" + str(len(requests)), "name": "Bash",
                # A nested native-client check can outlive a normal short tool
                # call. Do not accidentally background it and ask the mock
                # model to repeat a still-running stateful fixture.
                "input": {"command": reload_command if reload_command and not reloaded else command,
                          "timeout": 90000 if a.tool_check else 10000},
            })
            if a.file_canary and not read_attempted:
                content = {"type": "tool_use", "id": "file_read_probe", "name": "Read", "input": {"file_path": str(a.file_canary)}}
            elif host_id and not any(
                c.get("type") == "tool_result" and c.get("tool_use_id") == "host_id_probe"
                for m in body.get("messages", [])
                for c in (m.get("content") if isinstance(m.get("content"), list) else [])
            ):
                content = {"type": "tool_use", "id": "host_id_probe", "name": "Read", "input": {"file_path": "/etc/machine-id"}}
            result = {"id": "msg_policy", "type": "message", "role": "assistant",
                      "model": body.get("model"), "content": [content],
                      "stop_reason": "end_turn" if finished else "tool_use", "stop_sequence": None,
                      "usage": {"input_tokens": 10, "output_tokens": 5}}
            if body.get("stream"):
                events = [
                    {"type": "message_start", "message": dict(result, content=[], stop_reason=None)},
                    {"type": "content_block_start", "index": 0, "content_block":
                        {"type": "text", "text": ""} if finished else dict(content, input={})},
                    {"type": "content_block_delta", "index": 0, "delta":
                        {"type": "text_delta", "text": terminal_text} if finished else
                        {"type": "input_json_delta", "partial_json": json.dumps(content["input"])}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": result["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 5}},
                    {"type": "message_stop"},
                ]
                raw = "".join("event: " + x["type"] + "\ndata: " + json.dumps(x) + "\n\n" for x in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
        else:
            result = {}
        raw = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
endpoint = "http://127.0.0.1:" + str(server.server_port)


def run_case(name, user_settings, project_settings, overlays, remote=False, managed=None, reload=False, parent_policy=None, extra_args=None):
    global active, command, reload_command
    if a.case and name not in a.case:
        return None
    active = name
    home = root / name
    app = home / ".claude"
    project = home / "project"
    for d in [app, project / ".claude", home / "tmp"]:
        d.mkdir(parents=True)
    (app / "settings.json").write_text(json.dumps(user_settings))
    (project / ".claude/settings.json").write_text(json.dumps(project_settings))
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
           "CLAUDE_CONFIG_DIR": str(app), "CLAUDE_CODE_TMPDIR": str(home / "tmp"),
           "TMPDIR": str(home / "tmp"), "TERM": "xterm-256color", "SHELL": "/bin/bash",
           "ANTHROPIC_API_KEY": "sk-ant-synthetic-policy-fixture",
           "DISABLE_AUTOUPDATER": "1", "DISABLE_UPDATES": "1",
           "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1"}
    argv = [str(a.claude)]
    argv += extra_args or []
    if parent_policy is not None:
        argv += ["--managed-settings", json.dumps(parent_policy)]
    if managed is not None:
        managed_file = home / "managed" / "managed-settings.json"
        managed_file.parent.mkdir()
        managed_file.write_text(json.dumps(managed))
        # This variable names the policy DIRECTORY, not managed-settings.json.
        env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = str(managed_file.parent)
    for i, overlay in enumerate(overlays):
        f = home / ("overlay-" + str(i) + ".json")
        f.write_text(json.dumps(overlay))
        argv += ["--settings", str(f)]
    output_file = project / "environment.json"
    code = "import json,os,pathlib;v={k:os.environ.get(k) for k in ['DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING','DISABLE_UPDATES','REQUIRED_TOOL_CANARY','PROJECT_LIVE_CANARY']};v['toolUnameMatchesHost']=os.uname().release==" + repr(os.uname().release) + ";v['toolUid']=os.getuid();pathlib.Path(" + repr(str(output_file)) + ").write_text(json.dumps(v));print('POLICY_ENV '+json.dumps(v))"
    if a.file_canary:
        code = code.replace(";pathlib.Path(", ";v['intentionalToolRead']=pathlib.Path(" + repr(str(a.file_canary)) + ").read_text()=='SYNTHETIC_FILE_CANARY';v['toolNoNewPrivs']=[s for s in pathlib.Path('/proc/self/status').read_text().splitlines() if s.startswith('NoNewPrivs:')] if pathlib.Path('/proc/self/status').exists() else None;pathlib.Path(", 1)
    if a.tool_check:
        code = code.replace(";pathlib.Path(", ";import runpy;v['nativeToolCheck']=runpy.run_path(" + repr(str(a.tool_check)) + ").get('_aim_probe_result');pathlib.Path(", 1)
    command = "/usr/bin/python3 -c " + shlex.quote(code)
    reload_command = None
    if reload:
        next_settings = {"env": {"DISABLE_TELEMETRY": "", "DISABLE_ERROR_REPORTING": "", "DISABLE_UPDATES": "", "REQUIRED_TOOL_CANARY": "live-edit-preserved", "PROJECT_LIVE_CANARY": "project-live-edit-preserved"}, "disableRemoteControl": False}
        reload_target = home / ("overlay-" + str(len(overlays) - 1) + ".json") if reload == "overlay" else project / ".claude/settings.json"
        change = "import pathlib,time;pathlib.Path(" + repr(str(reload_target)) + ").write_text(" + repr(json.dumps(next_settings)) + ");time.sleep(3);print('POLICY_RELOAD')"
        reload_command = "/usr/bin/python3 -c " + shlex.quote(change)
    if remote:
        argv += ["remote-control"]
    else:
        env["ANTHROPIC_BASE_URL"] = endpoint
        argv += ["-p", "Run the synthetic policy tool, then finish.", "--dangerously-skip-permissions", "--model", "sonnet"]
    environment_transfer = None
    if approved_launcher:
        if not overlays: raise SystemExit("Candidate fixture requires an explicit privacy snapshot")
        settings = home / ("overlay-" + str(len(overlays)-1) + ".json")
        environment_transfer = tempfile.TemporaryFile(dir=home)
        environment_transfer.write(b"".join((k+"="+v).encode()+b"\0" for k,v in env.items()))
        environment_transfer.flush(); environment_transfer.seek(0)
        update = home / "unapproved-update"; update.mkdir()
        grants = [str(project), *[str(grant.resolve()) for grant in a.read_root]]
        argv = [str(approved_launcher), "v1", a.privacy_mode, str(app), str(settings),
                str(home / "tmp"), str(environment_transfer.fileno()), str(len(grants)), *grants, "1", str(update), "--", *argv[1:]]
    if a.mac_reentry_role:
        argv = [str(base / "claude-implementation/reentry-native"), a.mac_reentry_role, *argv[1:]]
    if a.sandbox_profile:
        if platform.system() != "Darwin":
            raise SystemExit("Seatbelt fixture is Mac-only")
        argv = ["/usr/bin/sandbox-exec", "-f", str(a.sandbox_profile), *argv]
    if a.apparmor_profile and not a.native_launcher:
        argv = ["/usr/bin/aa-exec", "-p", a.apparmor_profile, "--", *argv]
    if a.native_launcher:
        if a.apparmor_profile:
            env["AIM_METADATA_FIXTURE_APPARMOR"] = "1"
        for item in [home, *home.rglob("*")]:
            os.chown(item, user.pw_uid, user.pw_gid)
        argv = [str(a.native_launcher), *argv]
    child = subprocess.Popen(argv, env=env, cwd=project, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                             pass_fds=(environment_transfer.fileno(),) if environment_transfer else ())
    if environment_transfer: environment_transfer.close()
    try:
        out, err = child.communicate(timeout=100 if a.tool_check else 35)
        code = child.returncode
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        out, err = child.communicate()
        code = "timeout"
    (home / "output.private.txt").write_text(out + err)
    observations = {"case": name, "exit": code,
                    "toolFailureObserved": "POLICY_TOOL_FAILED" in out,
                    "policyRefusal": "disableRemoteControl" in out + err and "disabled" in (out + err).lower(),
                    "syntheticModelFailureObserved": "AIM_SYNTHETIC_MODEL_FAILURE" in out + err,
                    "modelRequests": sum(r["case"] == name and "messages" in r["path"] for r in requests),
                    "toolEnvironment": json.loads(output_file.read_text()) if output_file.exists() else None}
    model_requests = [r for r in requests if r["case"] == name and "messages" in r["path"]]
    if model_requests:
        first = model_requests[0]
        observations["automaticHeaders"] = {k: v for k, v in first["headers"].items()
                                            if k.lower() in ("x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version", "user-agent")}
        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)
        observations["automaticEnvironmentLines"] = sorted(set(
            line.strip() for value in strings(first["body"])
            for line in re.findall(r"^\s*- (?:Platform|OS Version|Shell):[^\n]*", value, re.M)))
        if a.file_canary:
            reads = [c for r in model_requests for m in r["body"].get("messages", [])
                     for c in (m.get("content") if isinstance(m.get("content"), list) else [])
                     if c.get("type") == "tool_result" and c.get("tool_use_id") == "file_read_probe"]
            observations["nativeReadAttempted"] = bool(reads)
            observations["nativeReadReturnedCanary"] = any("SYNTHETIC_FILE_CANARY" in str(c) for c in reads)
            observations["nativeReadError"] = any(c.get("is_error") for c in reads)
        if host_id:
            reads = [c for r in model_requests for m in r["body"].get("messages", [])
                     for c in (m.get("content") if isinstance(m.get("content"), list) else [])
                     if c.get("type") == "tool_result" and c.get("tool_use_id") == "host_id_probe"]
            observations["hostIdReadAttempted"] = bool(reads)
            observations["hostIdReturned"] = any(host_id in str(c) for c in reads)
            observations["hostIdReadError"] = any(c.get("is_error") for c in reads)
    return observations


privacy = {"disableRemoteControl": True, "env": {"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_UPDATES": "1"}}
conflict = {"disableRemoteControl": False, "env": {"DISABLE_TELEMETRY": "", "DISABLE_ERROR_REPORTING": "", "DISABLE_UPDATES": "", "REQUIRED_TOOL_CANARY": "preserve-me"}}
results = []
try:
    if a.composed_settings:
        composed = json.loads(a.composed_settings.read_text())
        hook_log = a.composed_settings.with_suffix(".hooks.jsonl")
        for name in ["aim-composed-settings", "aim-composed-settings-model-error"]:
            previous = len(hook_log.read_text().splitlines()) if hook_log.exists() else 0
            row = run_case(name, {}, {**conflict, "disableAllHooks": True}, [composed],
                           reload=not name.endswith("-model-error"))
            if row is not None:
                row["lifecycleEvents"] = hook_log.read_text().splitlines()[previous:] if hook_log.exists() else []
                row["requiredHooksConfigured"] = sorted(composed.get("hooks", {}))
                results.append(row)
    results.append(run_case("shell-only", {}, conflict, []))
    results.append(run_case("privacy-overlay", {}, conflict, [privacy]))
    results.append(run_case("privacy-last", {}, conflict, [conflict, privacy]))
    results.append(run_case("conflict-last", {}, {}, [privacy, conflict]))
    # An extra --settings must not silently discard existing AIM hooks/settings.
    # Keep this canary exclusively in the earlier flag, absent from project and
    # user settings, so ordinary project merging cannot create a false pass.
    results.append(run_case("multiple-overlay-preservation", {}, {}, [
        {"env": {"REQUIRED_TOOL_CANARY": "earlier-overlay-preserved"}}, privacy]))
    results.append(run_case("parent-policy", conflict, conflict, [conflict], parent_policy=privacy))
    results.append(run_case("parent-policy-live-edit", {}, {}, [
        {"env": {"REQUIRED_TOOL_CANARY": "existing-overlay-preserved"}}],
        parent_policy=privacy, reload=True))
    results.append(run_case("explicit-settings-file-live-edit", {}, {}, [
        {"env": {"REQUIRED_TOOL_CANARY": "initial-explicit-setting"}}], reload="overlay"))
    results.append(run_case("schema-invalid-model", {}, conflict, [{**privacy, "model": {}}]))
    results.append(run_case("schema-invalid-env", {}, conflict, [{**privacy,
        "env": {**privacy["env"], "REQUIRED_TOOL_CANARY": []}}]))
    results.append(run_case("safe-mode-settings", {}, conflict, [privacy], extra_args=["--safe-mode"]))
    results.append(run_case("remote-user-setting", {"disableRemoteControl": True}, {}, [], remote=True))
    results.append(run_case("remote-overlay", {}, {"disableRemoteControl": False}, [privacy], remote=True))
    results.append(run_case("remote-later-conflict", {}, {}, [privacy, conflict], remote=True))
    results.append(run_case("remote-private-managed", {}, conflict, [], remote=True, managed=privacy))
    results.append(run_case("private-managed-conflicting-overlay", {}, conflict, [conflict], managed=privacy))
    results.append(run_case("privacy-overlay-live-edit", {}, {}, [privacy], reload=True))
    results.append(run_case("private-managed-live-edit", {}, {}, [], managed=privacy, reload=True))
finally:
    server.shutdown()
    server.server_close()
report = {"platform": platform.system(), "artifactSha256": EXPECTED[platform.system()],
          "meaning": "Scoped settings observations, not complete telemetry or relay lifecycle acceptance", "results": [r for r in results if r is not None]}
(root / "policy-observations.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
