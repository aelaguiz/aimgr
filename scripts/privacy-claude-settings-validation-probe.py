#!/usr/bin/env python3
"""Find whether vanilla Claude exposes a usable offline settings validator.

This is an offsite decision fixture, not a launcher. All children use synthetic
homes under an independent network denial. Never use diagnostics exit zero as
validation proof: record positive and deliberately malformed comparisons.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument("--root", type=Path, required=True)
p.add_argument("--claude", type=Path, required=True)
p.add_argument("--no-auth", action="store_true")
p.add_argument("--case", action="append")
p.add_argument("--sandbox-profile", type=Path)
p.add_argument("--native-validator", type=Path)
a = p.parse_args()
base = Path("/opt/aimgr-state-audit")
root = a.root.resolve()
expected = {"Linux": "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0",
            "Darwin": "09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9"}
if (not (base / "OFFSITE_AUDIT_HOST").is_file() or root.parent != base / "claude-implementation"
        or root.exists() or os.geteuid() == 0):
    raise SystemExit("Fresh unprivileged offsite fixture required")
if platform.system() == "Linux" and sorted(n for _, n in socket.if_nameindex()) != ["lo"]:
    raise SystemExit("Loopback-only namespace required")
with a.claude.open("rb") as f:
    checked = hashlib.sha256()
    for block in iter(lambda: f.read(1024 * 1024), b""):
        checked.update(block)
    if checked.hexdigest() != expected.get(platform.system()):
        raise SystemExit("Unknown research artifact")
os.umask(0o077)
root.mkdir()
results = []
for case in ["doctor-before-valid", "doctor-before-invalid", "doctor-before-env-coercion",
             "doctor-before-unknown", "doctor-before-hook", "doctor-before-helper",
             "doctor-before-permissions-invalid", "doctor-after-valid", "doctor-after-invalid",
             "init-only-valid", "init-only-invalid"]:
    if a.case and case not in a.case:
        continue
    home = root / case
    config = home / ".claude"
    config.mkdir(parents=True)
    (home / "tmp").mkdir()
    settings = home / "input.json"
    values = {"model": {} if case == "doctor-before-invalid" else "sonnet",
              "disableRemoteControl": True, "env": {"DISABLE_TELEMETRY": "1"}}
    marker = home / "configured-code-ran"
    command = "printf called > " + str(marker)
    if case.endswith("env-coercion"):
        values["env"]["SYNTHETIC"] = []
    if case.endswith("unknown"):
        values["syntheticUnknownField"] = {"arbitrary": [1, 2, 3]}
    if case.endswith("hook"):
        values["hooks"] = {"SessionStart": [{"hooks": [{"type": "command", "command": command}]}]}
    if case.endswith("helper"):
        values["apiKeyHelper"] = command
    if case.endswith("permissions-invalid"):
        values["permissions"] = {"allow": 7}
    settings.write_text(json.dumps(values))
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "CLAUDE_CONFIG_DIR": str(config),
           "CLAUDE_SECURESTORAGE_CONFIG_DIR": str(config), "CLAUDE_CODE_TMPDIR": str(home / "tmp"),
           "TMPDIR": str(home / "tmp"), "TERM": "dumb", "DISABLE_AUTOUPDATER": "1", "DISABLE_UPDATES": "1",
           "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "ANTHROPIC_API_KEY": "sk-ant-synthetic-validator"}
    if a.no_auth:
        del env["ANTHROPIC_API_KEY"]
    args = (["doctor", "--settings", str(settings)] if "after" in case else
            ["--settings", str(settings), *( ["--init-only"] if case.startswith("init") else ["doctor"] )])
    argv = [str(a.claude), *args]
    if a.native_validator:
        if (platform.system() != "Linux" or not case.startswith("doctor-before-")
                or a.native_validator.resolve().parent != base / "claude-implementation"):
            raise SystemExit("Dedicated Linux doctor validator required")
        scratch = home / "validator-home"
        scratch.mkdir(mode=0o700)
        argv = [str(a.native_validator), str(a.claude), str(scratch), str(settings)]
    if a.sandbox_profile:
        if platform.system() != "Darwin" or a.sandbox_profile.resolve().parent != base / "claude-implementation":
            raise SystemExit("Only a dedicated rented-Mac policy is supported")
        scratch = home / "validator-home"
        scratch.mkdir(mode=0o700)
        for name in ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "TMPDIR"]:
            env[name] = str(scratch)
        env["DISABLE_GROWTHBOOK"] = "1"
        argv = ["/usr/bin/sandbox-exec", "-D", "VALIDATION_ROOT=" + str(scratch),
                "-D", "SETTINGS_FILE=" + str(settings), "-D", "INPUT_DIRECTORY=" + str(home),
                "-D", "VALIDATION_CONTAINER=" + str(root), "-f", str(a.sandbox_profile), *argv]
    began = time.monotonic()
    child = subprocess.Popen(argv, cwd=scratch if a.sandbox_profile else home, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = child.communicate(timeout=12)
        code = child.returncode
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        out, err = child.communicate()
        code = "timeout"
    (home / "output.private.txt").write_text(out + err)
    # Preserve streams separately for the actual production receipt parser.
    # This private artifact is never copied into public evidence.
    (home / "result.private.json").write_text(json.dumps({"status": code, "signal": None,
                                                        "stdout": out, "stderr": err}))
    results.append({"case": case, "exit": code, "durationMs": round((time.monotonic()-began)*1000),
                    "configuredCodeRan": marker.exists(), "output": out + err})
report = {"platform": platform.system(), "results": results}
(root / "observations.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
