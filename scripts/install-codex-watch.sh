#!/usr/bin/env bash
set -euo pipefail

LABEL_MAC="com.funcountry.agents_host.aim_codex_watch"
PLIST_MAC="/Library/LaunchDaemons/${LABEL_MAC}.plist"
LEGACY_PLIST_MAC_SYSTEM_AGENT="/Library/LaunchAgents/${LABEL_MAC}.plist"
SERVICE_LINUX="aim-codex-watch.service"
TIMER_LINUX="aim-codex-watch.timer"
SERVICE_LINUX_PATH="/etc/systemd/system/${SERVICE_LINUX}"
TIMER_LINUX_PATH="/etc/systemd/system/${TIMER_LINUX}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AIMGR_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
WORKSPACE_DIR_FROM_SCRIPT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd -P 2>/dev/null || true)"

default_user() {
  if id -u agents >/dev/null 2>&1; then
    printf '%s\n' "agents"
    return
  fi
  if [[ -n "${SUDO_USER:-}" ]]; then
    printf '%s\n' "${SUDO_USER}"
    return
  fi
  printf '%s\n' "${USER:-agents}"
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-codex-watch.sh [options]

Options:
  --user <name>               Install for this user (default: agents if present, else current user)
  --home <path>               Override that user's home directory
  --workspace-dir <path>      Override shared agents workspace dir when using the optional env wrapper
  --node-bin <path>           Override Node binary path used by the scheduler
  --interval-seconds <n>      Wake interval in seconds (default: 300)
  --threshold-pct <n>         Rotate when 5h remaining drops below this percent (default: 20)
  --print-only                Print the rendered service definition and exit
  --status                    Print installed service status and exit
  --uninstall                 Remove the installed service/timer/plist
  -h, --help                  Show this help

Examples:
  bash scripts/install-codex-watch.sh
  sudo bash scripts/install-codex-watch.sh --user agents --interval-seconds 180
  npm run codex-watch:install -- --print-only
  bash scripts/install-codex-watch.sh --status
  sudo bash scripts/install-codex-watch.sh --uninstall
EOF
}

resolve_home_dir() {
  local target_user="$1"
  local os_name="$2"
  if [[ "${os_name}" == "Darwin" ]]; then
    dscl . -read "/Users/${target_user}" NFSHomeDirectory 2>/dev/null | awk '{print $2}'
    return
  fi
  getent passwd "${target_user}" | cut -d: -f6
}

require_root_or_reexec() {
  if [[ "${PRINT_ONLY}" == "1" || "${STATUS_ONLY}" == "1" ]]; then
    return
  fi
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  if [[ $# -eq 0 ]]; then
    exec sudo bash "$0" --node-bin "${NODE_BIN}"
  fi
  exec sudo bash "$0" --node-bin "${NODE_BIN}" "$@"
}

resolve_node_bin() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    printf '%s\n' "${NODE_BIN}"
    return
  fi
  local candidates=()
  local candidate fallback=""
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    candidates+=("/opt/homebrew/bin/node")
  fi
  if [[ -x "/usr/local/bin/node" ]]; then
    candidates+=("/usr/local/bin/node")
  fi
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    candidates+=("${candidate}")
  done < <(find "${TARGET_HOME}/.nvm/versions/node" -type f -path '*/bin/node' 2>/dev/null | LC_ALL=C sort -r || true)
  for candidate in "${candidates[@]}"; do
    [[ -x "${candidate}" ]] || continue
    if node_bin_is_supported "${candidate}"; then
      printf '%s\n' "${candidate}"
      return
    fi
    if [[ -z "${fallback}" ]]; then
      fallback="${candidate}"
    fi
  done
  if [[ -n "${fallback}" ]]; then
    printf '%s\n' "${fallback}"
    return
  fi
  return 1
}

node_bin_major_version() {
  local candidate="$1"
  "${candidate}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

node_bin_is_supported() {
  local candidate="$1"
  local major
  major="$(node_bin_major_version "${candidate}")"
  [[ "${major}" =~ ^[0-9]+$ ]] || return 1
  [[ "${major}" -ge 20 ]]
}

render_mac_program_arguments() {
  if [[ -n "${HOST_ENV_WRAPPER}" ]]; then
    cat <<EOF
      <string>/bin/bash</string>
      <string>${HOST_ENV_WRAPPER}</string>
      <string>--</string>
      <string>${NODE_BIN}</string>
      <string>${AIMGR_ENTRYPOINT}</string>
      <string>codex</string>
      <string>watch</string>
      <string>--once</string>
      <string>--rotate-below-5h-remaining-pct</string>
      <string>${THRESHOLD_PCT}</string>
      <string>--home</string>
      <string>${TARGET_HOME}</string>
EOF
    return
  fi
  cat <<EOF
      <string>${NODE_BIN}</string>
      <string>${AIMGR_ENTRYPOINT}</string>
      <string>codex</string>
      <string>watch</string>
      <string>--once</string>
      <string>--rotate-below-5h-remaining-pct</string>
      <string>${THRESHOLD_PCT}</string>
      <string>--home</string>
      <string>${TARGET_HOME}</string>
EOF
}

render_linux_execstart() {
  if [[ -n "${HOST_ENV_WRAPPER}" ]]; then
    printf '%s\n' "/bin/bash ${HOST_ENV_WRAPPER} -- ${NODE_BIN} ${AIMGR_ENTRYPOINT} codex watch --once --rotate-below-5h-remaining-pct ${THRESHOLD_PCT} --home ${TARGET_HOME}"
    return
  fi
  printf '%s\n' "${NODE_BIN} ${AIMGR_ENTRYPOINT} codex watch --once --rotate-below-5h-remaining-pct ${THRESHOLD_PCT} --home ${TARGET_HOME}"
}

render_mac_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL_MAC}</string>

    <key>UserName</key>
    <string>${TARGET_USER}</string>

    <key>GroupName</key>
    <string>${TARGET_GROUP}</string>

    <key>WorkingDirectory</key>
    <string>${WORKSPACE_DIR}</string>

    <key>ProgramArguments</key>
    <array>
$(render_mac_program_arguments)
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${TARGET_HOME}</string>
      <key>USER</key>
      <string>${TARGET_USER}</string>
      <key>WORKSPACE_DIR</key>
      <string>${WORKSPACE_DIR}</string>
      <key>WORKSPACE_BASE</key>
      <string>${WORKSPACE_BASE}</string>
      <key>AIMGR_REPO_DIR</key>
      <string>${AIMGR_REPO_DIR}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${INTERVAL_SECONDS}</integer>

    <key>StandardOutPath</key>
    <string>/tmp/agents_host_aim_codex_watch.out.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/agents_host_aim_codex_watch.err.log</string>
  </dict>
</plist>
EOF
}

render_linux_service() {
  cat <<EOF
[Unit]
Description=AIM Codex watch one-shot
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=${WORKSPACE_DIR}
Environment=HOME=${TARGET_HOME}
Environment=USER=${TARGET_USER}
Environment=WORKSPACE_DIR=${WORKSPACE_DIR}
Environment=WORKSPACE_BASE=${WORKSPACE_BASE}
Environment=AIMGR_REPO_DIR=${AIMGR_REPO_DIR}
ExecStart=$(render_linux_execstart)
EOF
}

render_linux_timer() {
  cat <<EOF
[Unit]
Description=Run AIM Codex watch every ${INTERVAL_SECONDS} seconds

[Timer]
OnBootSec=1min
OnUnitActiveSec=${INTERVAL_SECONDS}s
Persistent=true
Unit=${SERVICE_LINUX}

[Install]
WantedBy=timers.target
EOF
}

print_rendered() {
  if [[ "${OS_NAME}" == "Darwin" ]]; then
    echo "# macOS launchd plist"
    render_mac_plist
    return
  fi
  echo "# Linux systemd service"
  render_linux_service
  echo
  echo "# Linux systemd timer"
  render_linux_timer
}

print_status() {
  if [[ "${OS_NAME}" == "Darwin" ]]; then
    if [[ ! -f "${PLIST_MAC}" ]]; then
      echo "Not installed: ${PLIST_MAC}" >&2
      return 1
    fi
    launchctl print "system/${LABEL_MAC}" | sed -n '1,120p'
    return
  fi
  if [[ ! -f "${SERVICE_LINUX_PATH}" || ! -f "${TIMER_LINUX_PATH}" ]]; then
    echo "Not installed: ${SERVICE_LINUX_PATH} ${TIMER_LINUX_PATH}" >&2
    return 1
  fi
  systemctl status "${TIMER_LINUX}" --no-pager
}

uninstall_watch() {
  if [[ "${OS_NAME}" == "Darwin" ]]; then
    cleanup_mac_legacy_watch_instances
    launchctl bootout system "${PLIST_MAC}" >/dev/null 2>&1 || true
    launchctl bootout "system/${LABEL_MAC}" >/dev/null 2>&1 || true
    launchctl disable "system/${LABEL_MAC}" >/dev/null 2>&1 || true
    rm -f "${PLIST_MAC}"
    echo "Removed ${PLIST_MAC}"
    return
  fi
  systemctl disable --now "${TIMER_LINUX}" >/dev/null 2>&1 || true
  systemctl stop "${SERVICE_LINUX}" >/dev/null 2>&1 || true
  rm -f "${SERVICE_LINUX_PATH}" "${TIMER_LINUX_PATH}"
  systemctl daemon-reload
  echo "Removed ${SERVICE_LINUX_PATH} and ${TIMER_LINUX_PATH}"
}

cleanup_mac_legacy_watch_instances() {
  local target_uid legacy_user_agent_plist
  target_uid="$(id -u "${TARGET_USER}")"
  legacy_user_agent_plist="${TARGET_HOME}/Library/LaunchAgents/${LABEL_MAC}.plist"

  launchctl bootout "gui/${target_uid}/${LABEL_MAC}" >/dev/null 2>&1 || true
  launchctl disable "gui/${target_uid}/${LABEL_MAC}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${target_uid}" "${legacy_user_agent_plist}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${target_uid}" "${LEGACY_PLIST_MAC_SYSTEM_AGENT}" >/dev/null 2>&1 || true
  rm -f "${legacy_user_agent_plist}" "${LEGACY_PLIST_MAC_SYSTEM_AGENT}"
}

install_watch() {
  local tmp_a
  local tmp_b
  tmp_a="$(mktemp)"
  tmp_b="$(mktemp)"
  trap 'rm -f "${tmp_a:-}" "${tmp_b:-}"' EXIT

  if [[ "${OS_NAME}" == "Darwin" ]]; then
    render_mac_plist >"${tmp_a}"
    plutil -lint "${tmp_a}" >/dev/null
    cleanup_mac_legacy_watch_instances
    install -d -m 755 /Library/LaunchDaemons
    install -o root -g wheel -m 644 "${tmp_a}" "${PLIST_MAC}"
    launchctl bootout system "${PLIST_MAC}" >/dev/null 2>&1 || true
    launchctl bootout "system/${LABEL_MAC}" >/dev/null 2>&1 || true
    launchctl bootstrap system "${PLIST_MAC}"
    launchctl enable "system/${LABEL_MAC}" >/dev/null 2>&1 || true
    launchctl kickstart -k "system/${LABEL_MAC}"
    echo "Installed ${PLIST_MAC}"
    echo "Status: sudo launchctl print system/${LABEL_MAC} | sed -n '1,120p'"
    echo "Logs: /tmp/agents_host_aim_codex_watch.out.log /tmp/agents_host_aim_codex_watch.err.log"
    return
  fi

  render_linux_service >"${tmp_a}"
  render_linux_timer >"${tmp_b}"
  install -d -m 755 /etc/systemd/system
  install -m 644 "${tmp_a}" "${SERVICE_LINUX_PATH}"
  install -m 644 "${tmp_b}" "${TIMER_LINUX_PATH}"
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "${SERVICE_LINUX_PATH}" "${TIMER_LINUX_PATH}"
  fi
  systemctl daemon-reload
  systemctl enable --now "${TIMER_LINUX}"
  systemctl start "${SERVICE_LINUX}"
  echo "Installed ${SERVICE_LINUX_PATH} and ${TIMER_LINUX_PATH}"
  echo "Status: sudo systemctl status ${TIMER_LINUX} --no-pager"
  echo "Logs: sudo journalctl -u ${SERVICE_LINUX} -n 100 --no-pager"
}

TARGET_USER="$(default_user)"
TARGET_HOME=""
WORKSPACE_DIR=""
NODE_BIN=""
INTERVAL_SECONDS="300"
THRESHOLD_PCT="20"
PRINT_ONLY="0"
STATUS_ONLY="0"
UNINSTALL_ONLY="0"
ORIGINAL_ARGS=("$@")

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --user)
      TARGET_USER="$2"
      shift 2
      ;;
    --home)
      TARGET_HOME="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --node-bin)
      NODE_BIN="$2"
      shift 2
      ;;
    --interval-seconds)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --threshold-pct)
      THRESHOLD_PCT="$2"
      shift 2
      ;;
    --print-only)
      PRINT_ONLY="1"
      shift
      ;;
    --status)
      STATUS_ONLY="1"
      shift
      ;;
    --uninstall)
      UNINSTALL_ONLY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

OS_NAME="$(uname -s)"
if [[ "${OS_NAME}" != "Darwin" && "${OS_NAME}" != "Linux" ]]; then
  echo "Unsupported OS: ${OS_NAME}" >&2
  exit 1
fi

if ! [[ "${INTERVAL_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${INTERVAL_SECONDS}" -le 0 ]]; then
  echo "Invalid --interval-seconds: ${INTERVAL_SECONDS}" >&2
  exit 2
fi
if ! [[ "${THRESHOLD_PCT}" =~ ^[0-9]+$ ]] || [[ "${THRESHOLD_PCT}" -lt 0 || "${THRESHOLD_PCT}" -gt 100 ]]; then
  echo "Invalid --threshold-pct: ${THRESHOLD_PCT}" >&2
  exit 2
fi

if [[ -z "${TARGET_HOME}" ]]; then
  TARGET_HOME="$(resolve_home_dir "${TARGET_USER}" "${OS_NAME}")"
fi
if [[ -z "${TARGET_HOME}" ]]; then
  echo "Could not resolve home directory for user ${TARGET_USER}" >&2
  exit 1
fi

TARGET_GROUP="$(id -gn "${TARGET_USER}")"
DEFAULT_WORKSPACE_DIR="${AIMGR_REPO_DIR}"
if [[ -n "${WORKSPACE_DIR_FROM_SCRIPT}" && -x "${WORKSPACE_DIR_FROM_SCRIPT}/deploy/mac/host_runner/with_host_env.sh" ]]; then
  DEFAULT_WORKSPACE_DIR="${WORKSPACE_DIR_FROM_SCRIPT}"
elif [[ -x "${TARGET_HOME}/workspace/agents/deploy/mac/host_runner/with_host_env.sh" ]]; then
  DEFAULT_WORKSPACE_DIR="${TARGET_HOME}/workspace/agents"
fi
WORKSPACE_DIR="${WORKSPACE_DIR:-${DEFAULT_WORKSPACE_DIR}}"
WORKSPACE_BASE="$(dirname "${WORKSPACE_DIR}")"
if [[ -d "${WORKSPACE_BASE}" ]]; then
  WORKSPACE_BASE="$(cd "${WORKSPACE_BASE}" && pwd -P)"
fi
if [[ -z "${WORKSPACE_BASE}" ]]; then
  WORKSPACE_BASE="${TARGET_HOME}/workspace"
fi
HOST_ENV_WRAPPER=""
if [[ -x "${WORKSPACE_DIR}/deploy/mac/host_runner/with_host_env.sh" ]]; then
  HOST_ENV_WRAPPER="${WORKSPACE_DIR}/deploy/mac/host_runner/with_host_env.sh"
fi
AIMGR_ENTRYPOINT="${AIMGR_REPO_DIR}/bin/aimgr.js"
NODE_BIN="$(resolve_node_bin)"

if [[ "${PRINT_ONLY}" == "1" || "${STATUS_ONLY}" == "0" && "${UNINSTALL_ONLY}" == "0" ]]; then
  if [[ ! -f "${AIMGR_ENTRYPOINT}" ]]; then
    echo "Missing aimgr entrypoint: ${AIMGR_ENTRYPOINT}" >&2
    exit 1
  fi
fi
if [[ ! -x "${NODE_BIN}" ]]; then
  echo "Missing Node binary: ${NODE_BIN}" >&2
  exit 1
fi
if ! node_bin_is_supported "${NODE_BIN}"; then
  echo "Unsupported Node binary: ${NODE_BIN} (AIM requires Node >=20; use --node-bin to override)." >&2
  exit 1
fi

if [[ ${#ORIGINAL_ARGS[@]} -eq 0 ]]; then
  require_root_or_reexec
else
  require_root_or_reexec "${ORIGINAL_ARGS[@]}"
fi

if [[ "${PRINT_ONLY}" == "1" ]]; then
  print_rendered
  exit 0
fi

if [[ "${STATUS_ONLY}" == "1" ]]; then
  print_status
  exit 0
fi

if [[ "${UNINSTALL_ONLY}" == "1" ]]; then
  uninstall_watch
  exit 0
fi

install_watch
