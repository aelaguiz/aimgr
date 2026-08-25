#!/usr/bin/env bash
set -euo pipefail

LABEL="com.funcountry.agents_host.aim_mcp_serve"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
ENTRYPOINT="${REPO_DIR}/bin/aimgr.js"
TARGET_HOME="${HOME:?HOME is required}"
TARGET_UID="$(id -u)"
DOMAIN="gui/${TARGET_UID}"
AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"
PLIST_PATH="${AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${TARGET_HOME}/.aimgr/logs"

usage() {
  printf 'Usage: bash scripts/install-mcp-server.sh [--status|--uninstall]\n' >&2
}

if [[ $# -gt 1 ]]; then
  usage
  exit 2
fi
if [[ $# -eq 1 && "$1" != "--status" && "$1" != "--uninstall" ]]; then
  usage
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'The AIM MCP server installer supports macOS only.\n' >&2
  exit 1
fi

if [[ "${1:-}" == "--status" ]]; then
  if [[ ! -f "${PLIST_PATH}" ]]; then
    printf 'Not installed: %s\n' "${PLIST_PATH}"
    exit 1
  fi
  printf 'Installed %s\n' "${PLIST_PATH}"
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | sed -n '1,12p' || printf 'Not loaded in %s\n' "${DOMAIN}"
  exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  if [[ -f "${PLIST_PATH}" ]]; then
    launchctl bootout "${DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
    rm -f "${PLIST_PATH}"
  fi
  printf 'Removed %s\n' "${PLIST_PATH}"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" || "${NODE_BIN}" != /* || ! -x "${NODE_BIN}" ]]; then
  printf 'A supported absolute Node executable is required.\n' >&2
  exit 1
fi
NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ || "${NODE_MAJOR}" -lt 20 ]]; then
  printf 'Node 20 or newer is required.\n' >&2
  exit 1
fi
if [[ ! -f "${ENTRYPOINT}" ]]; then
  printf 'Missing AIM entrypoint: %s\n' "${ENTRYPOINT}" >&2
  exit 1
fi

umask 077
mkdir -p "${AGENTS_DIR}" "${LOG_DIR}"
chmod 700 "${LOG_DIR}"

NODE_DIR="$(dirname "${NODE_BIN}")"
JOB_PATH="${TARGET_HOME}/.local/bin:${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TEMP_PLIST="$(mktemp "${PLIST_PATH}.tmp.XXXXXX")"
trap 'rm -f "${TEMP_PLIST}"' EXIT

# No --bind: the server resolves this machine's Tailscale IPv4 at startup, so the
# listener follows the tailnet address instead of a hardcoded one.
cat >"${TEMP_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${ENTRYPOINT}</string>
      <string>mcp</string>
      <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${TARGET_HOME}</string>
      <key>PATH</key>
      <string>${JOB_PATH}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/mcp-serve.out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/mcp-serve.err.log</string>
  </dict>
</plist>
EOF

plutil -lint "${TEMP_PLIST}" >/dev/null
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
if [[ -f "${PLIST_PATH}" ]]; then
  launchctl bootout "${DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
fi
install -m 600 "${TEMP_PLIST}" "${PLIST_PATH}"
launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"

printf 'Installed %s\n' "${PLIST_PATH}"
printf 'Endpoint: http://<this-machine-tailscale-ip>:7337/mcp (unauthenticated; tailnet-only by intent)\n'
printf 'Status: bash scripts/install-mcp-server.sh --status\n'
printf 'Uninstall: bash scripts/install-mcp-server.sh --uninstall\n'
