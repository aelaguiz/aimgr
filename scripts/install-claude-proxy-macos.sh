#!/usr/bin/env bash
# Native setup and updates; existing Chrome and SSH tunnel owners stay in place.
# Protected accounts only; ordinary installations never require this helper.
# Same-assignment updates reload running monitors without draining sessions.
# Fresh installation leaves failed activation closed. launchd retries a failed
# service on the same assigned route; it never restarts an interrupted agent
# session or selects a different proxy.
# Regression: test/network/claude-native-macos.test.js (installation failures).
set -euo pipefail
if [[ $EUID -ne 0 || $(uname -s) != Darwin || $# -ne 1 ]]; then
  echo 'Usage on macOS: sudo scripts/install-claude-proxy-macos.sh MANIFEST.json' >&2
  exit 2
fi
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for dependency in /usr/bin/python3 /usr/bin/clang /sbin/pfctl /bin/launchctl /usr/sbin/lsof /usr/local/bin/sing-box; do
  [[ -x $dependency ]] || { echo "Install missing dependency: $dependency" >&2; exit 1; }
done
[[ $(/usr/local/bin/sing-box version | head -1) == 'sing-box version 1.14.4' ]] || {
  echo 'Install sing-box 1.14.4 before native Mac setup.' >&2
  exit 1
}
/usr/bin/python3 -I "$repo_dir/native/claude/darwin_proxy.py" install < "$1"
