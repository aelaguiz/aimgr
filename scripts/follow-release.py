#!/usr/bin/env python3
"""Keep AI Manager's services and the plain `claude` command on what install-release.sh installed.

Arguments: the folder holding the `aim` wrapper (~/.local/bin) and the administrator-owned
runtime (/opt/aimgr-claude-runtime).

A launchd service that runs AI Manager by a path of its own (a release folder, or the live
checkout) never moves to a new release, so on a Mac each user LaunchAgent that runs
`.../bin/aimgr.js` is rewritten to run the `aim` wrapper with the same arguments and reloaded.
A long-running one (KeepAlive) is restarted after every install so it runs the new release; a
scheduled one picks it up at its next start. The plain `claude` command is pointed at the active
reviewed Claude when it is a link or missing; a real file there is left alone.
"""

import json
import os
import platform
import plistlib
import subprocess
import sys
import time
from pathlib import Path


def launchctl(*args):
    return subprocess.run(["/bin/launchctl", *args], capture_output=True, text=True)


def domains():
    uid = os.getuid()
    return [f"gui/{uid}", f"user/{uid}"]


def loaded_in(label):
    for domain in domains():
        if launchctl("print", f"{domain}/{label}").returncode == 0:
            return domain
    return None


def follow_services(aim):
    agents = Path.home() / "Library" / "LaunchAgents"
    for plist in sorted(agents.glob("*.plist")) if agents.is_dir() else []:
        try:
            data = plistlib.loads(plist.read_bytes())
        except Exception:
            continue
        args = [str(a) for a in data.get("ProgramArguments") or []]
        label = data.get("Label")
        if not label or not args:
            continue
        if len(args) >= 2 and args[1].endswith("/bin/aimgr.js"):
            wanted = [str(aim), *args[2:]]
        elif args[0] == str(aim):
            wanted = args
        else:
            continue
        changed = wanted != args
        if changed:
            data["ProgramArguments"] = wanted
            folder = str(data.get("WorkingDirectory") or "")
            if "/aimgr/releases/" in folder or folder.endswith("/workspace/aimgr"):
                data["WorkingDirectory"] = str(Path.home())
            staged = plist.with_name(f".{plist.name}.aimgr")
            staged.write_bytes(plistlib.dumps(data))
            os.replace(staged, plist)
        domain = loaded_in(label)
        if changed:
            if domain:
                launchctl("bootout", f"{domain}/{label}")
                # bootout returns before the job is gone, and a bootstrap before then fails.
                for _ in range(50):
                    if launchctl("print", f"{domain}/{label}").returncode != 0:
                        break
                    time.sleep(0.2)
            target = domain or next((d for d in domains() if launchctl("print", d).returncode == 0), domains()[-1])
            for _ in range(10):
                started = launchctl("bootstrap", target, str(plist))
                if started.returncode == 0:
                    break
                time.sleep(1)
            print(f"{label}: now runs {aim}" + ("" if started.returncode == 0 else f" (reload failed: {started.stderr.strip()})"))
        elif domain and data.get("KeepAlive"):
            launchctl("kickstart", "-k", f"{domain}/{label}")
            print(f"{label}: restarted on the new release")


def follow_claude(bin_dir, runtime):
    try:
        active = json.loads((runtime / "active.json").read_text())["artifactSet"]
    except (OSError, ValueError, KeyError, TypeError):
        return
    target = runtime / "artifacts" / str(active) / "claude"
    if not (target.is_file() and os.access(target, os.X_OK)):
        return
    link = bin_dir / "claude"
    if link.exists() and not link.is_symlink():
        print(f"{link} is a file, not a link; left it alone")
        return
    if link.is_symlink() and os.readlink(link) == str(target):
        return
    staged = bin_dir / ".claude.aimgr"
    if staged.is_symlink() or staged.exists():
        staged.unlink()
    staged.symlink_to(target)
    os.replace(staged, link)
    print(f"{link} -> the reviewed Claude {str(active)[:12]}")


def main():
    bin_dir, runtime = Path(sys.argv[1]), Path(sys.argv[2])
    if platform.system() == "Darwin":
        follow_services(bin_dir / "aim")
    follow_claude(bin_dir, runtime)


if __name__ == "__main__":
    main()
