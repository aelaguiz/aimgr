#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
node_bin="${AIMGR_NODE_BIN:-$(command -v node)}"
claude_adapter_root="$HOME/.aimgr/runtime/claude-file-store"

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

if [[ "$(uname -s)" == "Darwin" ]]; then
  mkdir -p "$claude_adapter_root"
  chmod 700 "$claude_adapter_root"
  adapter_build_path="$(mktemp "$claude_adapter_root/.security.XXXXXX")"
  if /usr/bin/clang \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Werror \
    "$repo_root/native/claude/security_shim.c" \
    -o "$adapter_build_path"; then
    chmod 500 "$adapter_build_path"
    mv -f "$adapter_build_path" "$claude_adapter_root/security"
  else
    rm -f "$adapter_build_path"
    exit 1
  fi
fi

printf 'Installed aim wrappers into %s\n' "$target_dir"
printf 'Repo checkout: %s\n' "$repo_root"
if [[ "$(uname -s)" == "Darwin" ]]; then
  printf 'Installed Claude security adapter: %s\n' "$claude_adapter_root/security"
fi
printf 'Verify with: %s\n' "command -v aim && aim --help"
