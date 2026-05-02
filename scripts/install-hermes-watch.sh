#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AIMGR_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
WORKSPACE_DIR_FROM_SCRIPT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd -P 2>/dev/null || true)"

WATCH_LABEL_MAC="com.funcountry.agents_host.aim_hermes_watch"
WATCH_SERVICE_LINUX="aim-hermes-watch.service"
WATCH_TIMER_LINUX="aim-hermes-watch.timer"
WATCH_COMMAND_TARGET="hermes"
WATCH_SCRIPT_NAME="install-hermes-watch.sh"
WATCH_NPM_SCRIPT_PREFIX="hermes-watch"
WATCH_THRESHOLD_HELP="Rebalance when 5h remaining drops below this percent"
WATCH_UNIT_DESCRIPTION="AIM Hermes watch one-shot"
WATCH_TIMER_DESCRIPTION_PREFIX="Run AIM Hermes watch"
WATCH_LOG_STEM="agents_host_aim_hermes_watch"

source "${SCRIPT_DIR}/lib/watch-install.sh"
