#!/usr/bin/env bash
# Add ~/workspace and ~/.prime to Spotlight's privacy (exclusion) list on the
# data volume and restart mds so a running reindex skips them from now on.
# Needs root: sudo bash scripts/spotlight-exclude-workspace.sh [extra paths...]
#
# Why: a full disk makes fseventsd drop its journal and Spotlight rebuild its
# index of every worktree, node_modules, Rust target and DerivedData under
# ~/workspace; on 2026-09-02 that kept 33 mdworker processes and fseventsd at
# 100 % for hours and pushed load past 60 while the agents themselves used ~6 cores.
set -euo pipefail
PLIST=/System/Volumes/Data/.Spotlight-V100/VolumeConfiguration.plist
if [ "$(id -u)" != 0 ]; then echo "run with sudo"; exit 2; fi
owner=${SUDO_USER:-$(stat -f %Su /dev/console)}
home=$(dscl . -read "/Users/$owner" NFSHomeDirectory | awk '{print $2}')
paths=("$home/workspace" "$home/.prime" "$@")
cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
existing=$(/usr/libexec/PlistBuddy -c "Print :Exclusions" "$PLIST" 2>/dev/null || true)
if [ -z "$existing" ]; then /usr/libexec/PlistBuddy -c "Add :Exclusions array" "$PLIST"; fi
for p in "${paths[@]}"; do
  if printf '%s\n' "$existing" | grep -qxF "    $p"; then echo "already excluded: $p"; continue; fi
  /usr/libexec/PlistBuddy -c "Add :Exclusions: string $p" "$PLIST"
  echo "excluded: $p"
done
echo "--- exclusions now:"
/usr/libexec/PlistBuddy -c "Print :Exclusions" "$PLIST"
launchctl kickstart -k system/com.apple.metadata.mds
echo "mds restarted; mdworker count should fall within a minute"
