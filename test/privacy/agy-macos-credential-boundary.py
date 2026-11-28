#!/usr/bin/env python3
"""Check native Antigravity filesystem policy against temporary macOS fixtures."""

from pathlib import Path
import platform
import shutil
import subprocess
import tempfile


def main():
    if platform.system() != "Darwin":
        raise SystemExit("This fixture requires macOS Seatbelt.")
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="aim-agy-credential-boundary-") as directory:
        root = Path(directory).resolve()
        home, workspace, scratch = (root / leaf for leaf in ("home", "workspace", "scratch"))
        aimgr = home / ".aimgr"
        account = aimgr / "agy/fixture/home"
        fixture_paths = [
            aimgr / "claude-integrations/figma/grant.json", aimgr / "accounts/fixture-auth",
            home / ".gemini/antigravity-cli/installation_id", home / ".claude.json", home / ".codex/.env",
            home / ".pi/agent/auth.json", home / ".prime/agent/auth.json",
            home / ".openclaw/agents/fixture/agent/auth-profiles.json", home / ".hermes/profiles/fixture/auth.json",
            account / ".gemini/antigravity-cli/antigravity-oauth-token", workspace / "fixture-input",
        ]
        for path in fixture_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic\n")
        scratch.mkdir()
        vendor, tool = root / "vendor", root / "tool"
        subprocess.run([
            "/usr/bin/clang", "-O2", "-Wall", "-Wextra", "-Werror",
            repo / "test/fixtures/agy/privacy-macos.c", "-o", vendor,
        ], check=True, timeout=30)
        shutil.copy2(vendor, tool)
        for mode in ("control", "vendor"):
            subprocess.run([vendor, mode, home, aimgr, account, workspace, scratch, tool],
                           cwd=workspace, check=True, timeout=15)
    print("Antigravity Seatbelt protects host credentials and retains selected vendor and workspace access.")


if __name__ == "__main__":
    main()
