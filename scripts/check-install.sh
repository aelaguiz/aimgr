#!/usr/bin/env bash
# Check that this machine runs the AI Manager install-release.sh installed from this checkout.
# It reads files and runs `aim`, and never launches Claude, signs in or uses the network.
set -euo pipefail

repo="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="${AIMGR_DATA_HOME:-$HOME/.local/share/aimgr}"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
commit="$(git -C "$repo" rev-parse HEAD)"
release="$data/releases/$commit"

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ -f $release/.aimgr-release ]] || fail "the release for ${commit:0:12} isn't built"
for name in aim aimgr; do
  grep -qF "\"$release/bin/aimgr.js\"" "$bin_dir/$name" 2>/dev/null \
    || fail "$bin_dir/$name doesn't run the release for ${commit:0:12}"
done
"$bin_dir/aim" --help >/dev/null 2>&1 || fail "aim --help fails"

"$bin_dir/aim" claude privacy status --json 2>/dev/null | /usr/bin/python3 -I -c '
import json, sys
try:
    status = json.load(sys.stdin)
except ValueError:
    sys.exit("aim claude privacy status gave no report")
if (status.get("selected") or {}).get("available") is not True or status.get("refusal"):
    sys.exit("the reviewed Claude runtime is not available: %s" % (status.get("refusal") or "not selected"))
' || exit 1

for skill in "$release"/skills/*/; do
  name="$(basename -- "$skill")"
  diff -rq "$skill" "$HOME/.agents/skills/$name" >/dev/null 2>&1 || fail "$HOME/.agents/skills/$name differs from the release"
  [[ -e $HOME/.claude/skills/$name ]] || fail "$HOME/.claude/skills/$name is missing"
done

# Every long-running AI Manager service runs through aim and is up.
if [[ $(uname) == Darwin ]]; then
  /usr/bin/python3 -I - "$bin_dir/aim" <<'PY'
import os, plistlib, subprocess, sys, time
from pathlib import Path
aim = sys.argv[1]
uid = os.getuid()
for plist in sorted((Path.home() / "Library" / "LaunchAgents").glob("*.plist")):
    try:
        data = plistlib.loads(plist.read_bytes())
    except Exception:
        continue
    args = [str(a) for a in data.get("ProgramArguments") or []]
    if len(args) >= 2 and args[1].endswith("/bin/aimgr.js"):
        sys.exit(f"{plist.name} still runs {args[1]} instead of {aim}")
    if not args or args[0] != aim or not data.get("KeepAlive"):
        continue
    for _ in range(20):
        shown = [subprocess.run(["/bin/launchctl", "print", f"{d}/{data['Label']}"], capture_output=True, text=True).stdout
                 for d in (f"gui/{uid}", f"user/{uid}")]
        if any("state = running" in s for s in shown):
            break
        time.sleep(1)
    else:
        sys.exit(f"{data['Label']} isn't running")
PY
fi
