#!/usr/bin/env bash
# One-time native Linux setup. Chrome continues using its existing SOCKS setup.
set -euo pipefail
if [[ $EUID -ne 0 || $(uname -s) != Linux || $(uname -m) != x86_64 || $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage on Linux x86_64: sudo scripts/install-claude-proxy-linux.sh MANIFEST.json [SING_BOX_ARCHIVE]' >&2
  exit 2
fi
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
manifest=$1
for dependency in python3 nft lsof sudo visudo systemctl curl tar sha256sum flock; do
  command -v "$dependency" >/dev/null || { echo "Install missing dependency: $dependency" >&2; exit 1; }
done
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || { echo 'Native Claude requires cgroup v2.' >&2; exit 1; }
python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value["user"] and value["profiles"]' "$manifest"
mkdir -p /opt/aimgr-claude-proxy
exec 9>/opt/aimgr-claude-proxy/install.lock
chmod 0644 /opt/aimgr-claude-proxy/install.lock
flock --exclusive --nonblock 9
python3 "$repo_dir/native/claude/linux_proxy.py" check-stopped
version=1.14.4
checksum=699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968
if [[ ! -x /usr/local/bin/sing-box ]] || [[ $(/usr/local/bin/sing-box version | head -1) != "sing-box version ${version}" ]]; then
  staging=$(mktemp -d)
  trap 'rm -rf -- "$staging"' EXIT
  archive=${2:-$staging/sing-box.tar.gz}
  if [[ $# -eq 1 ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      "https://github.com/SagerNet/sing-box/releases/download/v${version}/sing-box-${version}-linux-amd64.tar.gz" --output "$archive"
  fi
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
  tar xzf "$archive" -C "$staging" "sing-box-${version}-linux-amd64/sing-box"
  install -m 0755 "$staging/sing-box-${version}-linux-amd64/sing-box" /usr/local/bin/sing-box
fi
python3 "$repo_dir/native/claude/linux_proxy.py" install < "$manifest"
flock --unlock 9
python3 "$repo_dir/native/claude/linux_proxy.py" activate
