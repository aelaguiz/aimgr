#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
node_bin="${AIMGR_NODE_BIN:-$(command -v node)}"
claude_runtime_bundle=""
if [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || $1 != --claude-runtime-bundle ]]; then
    echo 'Usage: scripts/install-local-bin.sh [--claude-runtime-bundle APPROVED_BUNDLE_DIRECTORY]' >&2
    exit 2
  fi
  claude_runtime_bundle=$2
fi

# The common artifact runtime is independent of optional proxy enrollment.
# Approval comes from the supplied reviewed manifest, never this installer.
# Activate it before replacing wrappers so a failed transition leaves the
# existing command installation intact. No vendor code is run here.
if [[ -n $claude_runtime_bundle ]]; then
  sudo /usr/bin/python3 -I "$repo_root/scripts/install-claude-runtime.py" \
    "$claude_runtime_bundle" --node "$node_bin" --user "$(id -un)" --activate
fi

mkdir -p "$target_dir"

install_wrapper() {
  local name="$1"
  local target="$target_dir/$name"
  local staged
  staged="$(mktemp "$target_dir/.${name}.XXXXXX")"

  cat >"$staged" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$node_bin" "$repo_root/bin/aimgr.js" "\$@"
EOF

  chmod 755 "$staged"
  mv -f "$staged" "$target"
}

install_wrapper "aim"
install_wrapper "aimgr"

AIMGR_NODE_BIN="$node_bin" bash "$repo_root/scripts/install-codex-shortcuts.sh"

printf 'Installed aim wrappers into %s\n' "$target_dir"
printf 'Repo checkout: %s\n' "$repo_root"
printf 'Claude runtime status: %s\n' 'aim claude privacy status'
printf 'Verify with: %s\n' "command -v aim && aim --help"
