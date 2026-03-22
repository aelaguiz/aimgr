#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"

mkdir -p "$target_dir"

install_wrapper() {
  local name="$1"
  local target="$target_dir/$name"

  cat >"$target" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$repo_root/bin/aimgr.js" "\$@"
EOF

  chmod 755 "$target"
}

install_wrapper "aim"
install_wrapper "aimgr"

printf 'Installed aim wrappers into %s\n' "$target_dir"
printf 'Repo checkout: %s\n' "$repo_root"
printf 'Verify with: %s\n' "command -v aim && aim --help"
