#!/usr/bin/env bash
# Install this checkout's commit as the machine's AI Manager.
#
# This is what a machine runs whenever its ~/workspace/aimgr checkout moves (devcluster runs it
# on Amir's machines). The live `aim` command never runs the checkout itself: it runs a fixed
# release built from the checkout's commit, so uncommitted edits never go live and pulling main
# changes nothing until the new release has installed. The steps:
#
#   1. Build ~/.local/share/aimgr/releases/<commit> from the commit, with its own `npm ci`.
#   2. Activate the newest approved Claude and Codex runtimes in ~/.local/share/aimgr/runtime-bundles when
#      the active one is older or this release can't use it. A Mac keeps its running sessions;
#      Linux refuses while any Claude session runs, and nothing here stops one.
#      Provision a missing Claude environment identity even when activation is unnecessary.
#   3. Point `aim` and `aimgr` at the release (scripts/install-local-bin.sh).
#   4. Install the release's skills into ~/.agents/skills, linked from ~/.claude/skills.
#   5. Run AI Manager's launchd services through `aim` and restart the long-running ones, and
#      point the plain `claude` command at the active reviewed Claude.
#
# scripts/check-install.sh checks the result. Old releases are kept: running sessions use them.
set -euo pipefail

repo="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="${AIMGR_DATA_HOME:-$HOME/.local/share/aimgr}"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
runtime_root=/opt/aimgr-claude-runtime
commit="$(git -C "$repo" rev-parse HEAD)"
release="$data/releases/$commit"

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

# The node this machine's `aim` already uses, so a machine keeps its own choice.
node_bin="${AIMGR_NODE_BIN:-}"
if [[ -z $node_bin && -f $bin_dir/aim ]]; then
  node_bin="$(sed -n 's/^exec "\([^"]*\)" .*/\1/p' "$bin_dir/aim" | head -1)"
fi
[[ -n $node_bin && -x $node_bin ]] || node_bin="$(command -v node || true)"
[[ -n $node_bin && -x $node_bin ]] || for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -x $candidate ]] && { node_bin=$candidate; break; }
done
[[ -n $node_bin && -x $node_bin ]] || fail "no node found for AI Manager; set AIMGR_NODE_BIN"
node_dir="$(dirname -- "$(readlink -f -- "$node_bin" 2>/dev/null || printf '%s' "$node_bin")")"
export PATH="$node_dir:$PATH"

# 1. The release.
if [[ ! -f $release/.aimgr-release ]]; then
  mkdir -p "$data/releases"
  building="$data/releases/.building-$commit-$$"
  rm -rf -- "$building"
  mkdir -p "$building"
  trap 'rm -rf -- "$building"' EXIT
  git -C "$repo" archive "$commit" | tar -x -C "$building"
  (cd "$building" && npm ci --no-audit --no-fund --loglevel=error >/dev/null) || fail "npm ci failed in the release for $commit"
  printf '%s\n' "$commit" >"$building/.aimgr-release"
  [[ -e $release ]] && mv -- "$release" "$data/releases/.incomplete-$commit-$$"
  mv -- "$building" "$release"
  trap - EXIT
  say "Built release ${commit:0:12}"
fi

# 2. Both reviewed runtimes. Complete their prerequisites before replacing aim.
for provider in claude codex; do
  status="$("$node_bin" "$release/bin/aimgr.js" "$provider" privacy status --json 2>/dev/null || true)"
  bundle="$(printf '%s' "$status" | /usr/bin/python3 -I "$release/scripts/choose-runtime.py" "$provider" "$data/runtime-bundles" "/opt/aimgr-$provider-runtime")"
  if [[ -n $bundle ]]; then
    sudo -n true 2>/dev/null || fail "activating the reviewed $provider in $bundle needs passwordless sudo on this machine"
    say "Activating the reviewed $provider runtime in $bundle"
    sudo -n /usr/bin/python3 -I "$release/scripts/install-$provider-runtime.py" \
      "$bundle" --node "$node_bin" --user "$(id -un)" --activate
  fi
done
# An older active Claude bundle may predate machine-local identities. Creating
# its missing anchor must not reactivate Linux policy or rotate an existing ID.
sudo -n /usr/bin/python3 -I "$release/scripts/install-claude-runtime.py" --ensure-environment

# 3. aim and aimgr, and the Codex shortcuts.
AIMGR_NODE_BIN="$node_bin" bash "$release/scripts/install-local-bin.sh" >/dev/null

# 4. The skills.
mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
for skill in "$release"/skills/*/; do
  name="$(basename -- "$skill")"
  dest="$HOME/.agents/skills/$name"
  staged="$(mktemp -d "$HOME/.agents/skills/.$name.XXXXXX")"
  cp -R "$skill." "$staged/"
  chmod 755 "$staged"
  if [[ -e $dest || -L $dest ]]; then
    old="$HOME/.agents/skills/.$name.old-$$"
    mv -- "$dest" "$old"
    mv -- "$staged" "$dest"
    rm -rf -- "$old"
  else
    mv -- "$staged" "$dest"
  fi
  link="$HOME/.claude/skills/$name"
  if [[ -L $link || ! -e $link ]]; then
    ln -sfn "../../.agents/skills/$name" "$link"
  fi
done

# 5. Services and the plain claude command.
/usr/bin/python3 -I "$release/scripts/follow-release.py" "$bin_dir" "$runtime_root"

say "AI Manager ${commit:0:12} installed from $repo"
