#!/usr/bin/env bash
# Deploy what's on main to the fleet. M5 is the dev box; run this FROM M5 after pushing.
# Per box: ff-only pull of ~/workspace/aimgr and ~/workspace/prime-agent, npm install,
# refresh aim/aimgr wrappers and the prime-agent wrapper. NEVER touches daemons,
# sessions, dist bundles, or snapshots. Diverged/dirty checkouts fail LOUD, no force.
set -uo pipefail

HOSTS=(${AIM_FLEET_HOSTS:-home amirs-mac-studio amirs-m3-max-new amir-m3-36gb})

REMOTE_SCRIPT='
set -u
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH

sync_repo() {
  repo="$1"; dir="$HOME/workspace/$repo"
  if [ ! -d "$dir/.git" ]; then echo "$repo: MISSING checkout"; return 1; fi
  cd "$dir" || return 1
  branch=$(git branch --show-current)
  if [ "$branch" != "main" ]; then echo "$repo: SKIP (on branch $branch, not main)"; return 1; fi
  dirty=$(git status --porcelain | grep -cv "^??" || true)
  git fetch -q origin || { echo "$repo: FETCH FAILED"; return 1; }
  if git pull --ff-only -q origin main 2>/dev/null; then
    note=""
  else
    echo "$repo: PULL FAILED (diverged from origin/main at $(git rev-parse --short HEAD); resolve by hand)"; return 1
  fi
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  [ "$ahead" -gt 0 ] && note=" (WARN: $ahead unpushed local commits ahead of main)"
  [ "$dirty" -gt 0 ] && note="$note (WARN: $dirty dirty tracked files)"
  npm install --no-audit --no-fund >/dev/null 2>&1 || note="$note (WARN: npm install failed)"
  echo "$repo: $(git rev-parse --short HEAD)$note"
}

sync_repo aimgr
aimgr_ok=$?
sync_repo prime-agent

if [ "$aimgr_ok" -eq 0 ]; then
  bash "$HOME/workspace/aimgr/scripts/install-local-bin.sh" >/dev/null 2>&1 && echo "wrappers: aim/aimgr refreshed" || echo "wrappers: aim install FAILED"
fi
launcher="$HOME/.local/bin/prime-agent"
printf "#!/bin/sh\nexec \"%s\" \"\$@\"\n" "$HOME/workspace/prime-agent/prime-agent.sh" > "$launcher.tmp" \
  && chmod +x "$launcher.tmp" && mv "$launcher.tmp" "$launcher" && echo "wrappers: prime-agent -> live checkout"
'

failures=0
for host in "${HOSTS[@]}"; do
  echo "===== $host ====="
  if ! printf '%s' "$REMOTE_SCRIPT" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" bash -s; then
    failures=$((failures + 1))
  fi
done
echo
if [ "$failures" -gt 0 ]; then
  echo "sync-fleet: $failures host(s) reported problems above."
  exit 1
fi
echo "sync-fleet: all hosts converged to main."
