#!/usr/bin/env python3
"""Install the enrolled user's periodic Figma OAuth maintenance job."""

import os
import platform
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path

INTERVAL = 15 * 60
MAC_LABEL = "com.funcountry.aimgr.claude-figma"
LINUX_UNIT = "aimgr-claude-figma"
BASE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def install_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and not path.is_symlink() and path.read_bytes() == data:
        return False
    fd, staging = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        os.replace(staging, path)
    finally:
        Path(staging).unlink(missing_ok=True)
    return True


def run(*args, check=True):
    return subprocess.run(args, capture_output=True, timeout=15, check=check).returncode == 0


def install_mac(home, aim, search_path):
    def launchctl(*args, check=True):
        return run("/bin/launchctl", *args, check=check)

    plist = home / "Library" / "LaunchAgents" / f"{MAC_LABEL}.plist"
    changed = install_file(plist, plistlib.dumps({
        "Label": MAC_LABEL,
        "ProgramArguments": [str(aim), "claude", "figma", "maintain"],
        "EnvironmentVariables": {"HOME": str(home), "PATH": search_path},
        "WorkingDirectory": str(home),
        "RunAtLoad": True,
        "StartInterval": INTERVAL,
    }))
    domains = [f"gui/{os.getuid()}", f"user/{os.getuid()}"]
    for domain in domains:
        job = f"{domain}/{MAC_LABEL}"
        if launchctl("print", job, check=False):
            if changed:
                launchctl("bootout", job)
                launchctl("bootstrap", domain, str(plist))
            return
    for domain in domains:
        if launchctl("print", domain, check=False) and launchctl("bootstrap", domain, str(plist), check=False):
            return
    raise RuntimeError("No launchd domain accepted the Figma job")


def systemd_quote(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def install_linux(home, aim, search_path):
    units = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "systemd" / "user"
    service = f"{LINUX_UNIT}.service"
    timer = f"{LINUX_UNIT}.timer"
    changed = install_file(units / service, f"""[Unit]
Description=Refresh the AI Manager Figma MCP grant

[Service]
Type=oneshot
Environment={systemd_quote(f"PATH={search_path}")}
ExecStart={systemd_quote(aim)} claude figma maintain
""".encode())
    timer_changed = install_file(units / timer, f"""[Unit]
Description=Schedule AI Manager Figma MCP renewal

[Timer]
OnStartupSec=1min
OnUnitInactiveSec={INTERVAL}s
Unit={service}

[Install]
WantedBy=timers.target
""".encode())
    if changed or timer_changed:
        run("systemctl", "--user", "daemon-reload")
    if timer_changed and run("systemctl", "--user", "is-active", "--quiet", timer, check=False):
        run("systemctl", "--user", "restart", timer)
    run("systemctl", "--user", "enable", "--now", timer)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("Expected the absolute path to the installed aim wrapper")
    aim = Path(sys.argv[1])
    if not aim.is_absolute() or not aim.is_file() or not os.access(aim, os.X_OK):
        raise RuntimeError("The installed aim wrapper is unavailable")
    home = Path.home()
    search_path = f"{aim.parent}:{BASE_PATH}"
    system = platform.system()
    if system == "Darwin":
        install_mac(home, aim, search_path)
    elif system == "Linux":
        install_linux(home, aim, search_path)
    else:
        raise RuntimeError("Figma renewal supports macOS and Linux")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        sys.exit("Could not install the Figma renewal job for the current user.")
