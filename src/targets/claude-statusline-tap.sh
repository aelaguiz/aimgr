#!/bin/sh
# Managed Claude sessions run this as their status line. Claude Code pipes it
# the status-line JSON after each response; when that JSON carries the
# account's five-hour and weekly usage (read from the provider's own response
# headers), the tap saves it in the session's config directory so `aim status`
# can show it without asking the provider. The user's own status-line command,
# passed as the first argument, then renders from the same input as before.
input=$(cat)
dir=${CLAUDE_CONFIG_DIR:-}
case $input in
  *'"rate_limits"'*)
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      tmp="$dir/.aimgr-session-usage.json.$$"
      if (umask 077 && printf '%s' "$input" > "$tmp") 2>/dev/null; then
        mv -f "$tmp" "$dir/.aimgr-session-usage.json" 2>/dev/null || rm -f "$tmp"
      else
        rm -f "$tmp" 2>/dev/null
      fi
    fi
    ;;
esac
[ $# -gt 0 ] || exit 0
printf '%s' "$input" | /bin/sh -c "$1"
