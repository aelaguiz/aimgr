#!/usr/bin/env python3
"""Which approved Claude runtime bundle install-release.sh should activate, if any.

Reads `aim claude privacy status --json` from the new release on stdin. Arguments: the folder
of approved bundles this machine holds (~/.local/share/aimgr/runtime-bundles) and the
administrator-owned runtime (/opt/aimgr-claude-runtime).

Prints nothing when the active runtime is usable by this release and no bundle here was approved
after it. Prints a bundle folder when one should be activated: the newest normal-use approval for
this platform. Exits 1, saying why, when this release has no usable runtime and none is here.
Approval comes from each bundle's own reviewed approval.json; the installer re-verifies it.
"""

import json
import platform
import sys
from pathlib import Path


def this_platform():
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system(), platform.system().lower())
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(machine, machine)
    return system, arch


def approval(folder):
    try:
        data = json.loads((folder / "approval.json").read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def approved_at(data):
    return str(((data or {}).get("approval") or {}).get("approvedAt") or "")


def main():
    store, runtime = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        status = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        status = {}
    usable = (status.get("selected") or {}).get("available") is True and not status.get("refusal")
    active = status.get("activeArtifactSet")
    active_at = approved_at(approval(runtime / "artifacts" / active)) if active else ""

    system, arch = this_platform()
    candidates = []
    for folder in sorted(store.iterdir()) if store.is_dir() else []:
        data = approval(folder) if folder.is_dir() else None
        if not data or data.get("platform") != system or data.get("arch") != arch:
            continue
        if (data.get("approval") or {}).get("kind") != "normal-use":
            continue
        candidates.append((approved_at(data), str(folder)))
    newest = max(candidates) if candidates else None

    if usable and (not newest or newest[0] <= active_at):
        return 0
    if newest and (not usable or newest[0] > active_at):
        print(newest[1])
        return 0
    reason = status.get("refusal") or "no reviewed Claude runtime is active"
    print(f"this release can't launch Claude here ({reason}), and {store} holds no approved "
          f"{system} {arch} runtime to activate", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
