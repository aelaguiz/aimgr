# Codex invalid credentials process investigation - 2026-05-31

## Context

- User reported sudden mid-session `invalid credentials` behavior after manually logging in 24 OpenAI Codex accounts about five minutes earlier.
- Hypothesis to test: something on this machine, or on `agents@amirs-mac-studio`, is automatically touching AIMGR/Codex auth via a Tend process, launchd job, cron job, or similar scheduler.
- Local repo: `/Users/aelaguiz/workspace/aimgr`.
- Start time: 2026-05-31 13:15:10 CDT.

## Running Notes

- Read repo instructions from `/Users/aelaguiz/.codex/RTK.md`; shell commands should be prefixed with `rtk`.
- Used `repo-search` skill because the investigation needs exact repo files and scheduler surfaces.
- Current repo status before this work: unrelated untracked `.antigravitycli/` and `docs/codex-osx-app-storage-investigation-2026-05-31.md`.
- Repo exposes watch installers and package scripts:
  - `npm run codex-watch:install/status/uninstall`
  - `npm run hermes-watch:install/status/uninstall`
  - Launchd label for Codex watch in source: `com.funcountry.agents_host.aim_codex_watch`
  - Launchd label for Hermes watch in source: `com.funcountry.agents_host.aim_hermes_watch`

## Local Machine: `Amir-M5`

- User/OS: `aelaguiz`, Darwin `Amir-M5`.
- Codex watcher is installed and enabled:
  - Launchd service: `system/com.funcountry.agents_host.aim_codex_watch`
  - Plist: `/Library/LaunchDaemons/com.funcountry.agents_host.aim_codex_watch.plist`
  - Program: `/bin/bash /Users/aelaguiz/workspace/agents/deploy/mac/host_runner/with_host_env.sh -- /opt/homebrew/bin/node /Users/aelaguiz/workspace/aimgr/bin/aimgr.js codex watch --once --rotate-below-5h-remaining-pct 20 --home /Users/aelaguiz`
  - Interval: 300 seconds
  - Runs observed by launchd: `10264`
  - Latest local stdout log mtime: `2026-05-31 13:14:00 CDT`
- Latest local watcher log:
  - `observedAt`: `2026-05-31T18:14:00.206Z`
  - `preserved.status`: `unchanged`
  - `preserved.label`: `amir_personal`
  - `currentLabelBefore`: `amir_personal`
  - `currentLabelAfter`: `amir_personal`
  - `primaryRemainingPctBefore`: `100`
  - `triggeredSelection`: `false`
- Local `~/.aimgr/local-state.json` mtime was `2026-05-31 13:14:00 CDT`; backups are being created about every five minutes by the watcher.
- Local `~/.codex/auth.json` mtime was `2026-05-31 13:13:17 CDT`.
- No current-user crontab was installed for `aelaguiz`.
- No Hermes watcher LaunchDaemon was found locally.
- Local launchd also has Codex Dock/app-server processes, and several live Codex/app-server processes are present. Separate live `aimgr.js login ... --manual-callback-stdio` processes were also present; those look like interactive login flows, not a scheduler.

## Remote Machine: `agents@amirs-mac-studio`

- SSH resolved and connected as `agents`; remote hostname reported `agents`.
- Codex watcher is installed and enabled:
  - Launchd service: `system/com.funcountry.agents_host.aim_codex_watch`
  - Plist: `/Library/LaunchDaemons/com.funcountry.agents_host.aim_codex_watch.plist`
  - Program: `/bin/bash /Users/agents/workspace/agents/deploy/mac/host_runner/with_host_env.sh -- /Users/agents/.nvm/versions/node/v22.22.0/bin/node /Users/agents/workspace/agents/work/aimgr/repo/aimgr/bin/aimgr.js codex watch --once --rotate-below-5h-remaining-pct 20 --home /Users/agents`
  - Interval: 300 seconds
  - Runs observed by launchd: `18817`
  - Latest stdout log mtime: `2026-05-31 13:15:21 CDT`
  - Stderr log mtime: `2026-05-31 00:02:39 CDT`, size `0`
- Latest watcher log:
  - `observedAt`: `2026-05-31T18:15:21.167Z`
  - `preserved.status`: `unchanged`
  - `preserved.label`: `pro3`
  - `currentLabelBefore`: `pro3`
  - `currentLabelAfter`: `pro3`
  - `primaryRemainingPctBefore`: `100`
  - `triggeredSelection`: `false`
- Live process scan showed one old `paperclip-codex` tmux resume and many Hermes gateway processes; no current `aimgr codex run --tend` process was found in the scan.

## Remote Machine: `amirs-m3-max-new`

- SSH resolved and connected as `aelaguiz`; remote hostname reported `Amirs-M3-Max-2`; OS Darwin.
- Codex watcher is installed and enabled:
  - Launchd service: `system/com.funcountry.agents_host.aim_codex_watch`
  - Plist: `/Library/LaunchDaemons/com.funcountry.agents_host.aim_codex_watch.plist`
  - Program: `/bin/bash /Users/aelaguiz/workspace/agents/deploy/mac/host_runner/with_host_env.sh -- /Users/aelaguiz/.nvm/versions/node/v22.19.0/bin/node /Users/aelaguiz/workspace/aimgr/bin/aimgr.js codex watch --once --rotate-below-5h-remaining-pct 20 --home /Users/aelaguiz`
  - Interval: 300 seconds
  - Runs observed by launchd: `19100`
  - Last exit code: `1`
  - Latest stdout log mtime: `2026-05-31 13:16:15 CDT`
  - Stderr log mtime: `2026-05-29 00:04:29 CDT`, size `0`
- Latest watcher log is directly relevant:
  - `observedAt`: `2026-05-31T18:16:14.904Z`
  - `preserved.status`: `unchanged`
  - `preserved.label`: `pro3`
  - `currentLabelBefore`: `pro3`
  - `currentLabelAfter`: `pro3`
  - `watched.status`: `blocked`
  - Blocker: `active_target_usage_unavailable`
  - HTTP status: `401`
  - Detail: `Encountered invalidated oauth token for user, failing request`
  - `tokenExpired`: `true`
- No current-user crontab output was present.
- Launchd grep found only `com.funcountry.agents_host.aim_codex_watch` among AIM/Codex watcher services, plus unrelated Redis/Hermes/db MCP entries.
- Live process scan did not show an active `aimgr codex run --tend` process.

## Remote Machine: `home`

- SSH resolved and connected as `aelaguiz`; remote hostname reported `amir-server`; OS Linux.
- Codex watcher is installed and enabled as systemd:
  - Timer: `aim-codex-watch.timer`
  - Service: `aim-codex-watch.service`
  - Unit files:
    - `/etc/systemd/system/aim-codex-watch.timer`
    - `/etc/systemd/system/aim-codex-watch.service`
  - Timer interval from unit description/status: every 300 seconds
  - Timer active since `2026-03-25 06:37:11 CDT`
  - Last completed service run: `2026-05-31 13:14:38 CDT`
  - Command: `/home/aelaguiz/.nvm/versions/node/v22.18.0/bin/node /home/aelaguiz/workspace/aimgr/bin/aimgr.js codex watch --once --rotate-below-5h-remaining-pct 20 --home /home/aelaguiz`
- Latest journal entries:
  - `observedAt`: `2026-05-31T18:14:37.499Z`
  - `preserved.status`: `unchanged`
  - `preserved.label`: `amir_cratejoy_personal`
  - `currentLabelBefore`: `amir_cratejoy_personal`
  - `currentLabelAfter`: `amir_cratejoy_personal`
  - `primaryRemainingPctBefore`: `87`
  - `triggeredSelection`: `false`
- No current-user crontab was installed for `aelaguiz`.
- Live process scan did find an old Tend-style tmux session:
  - `tmux new-session -d -s aimgr-codex-tend-1779878220547 -c /home/aelaguiz/workspace/rustai codex --no-alt-screen -p yolo`
  - Start time shown by `ps`: `2026-05-27 05:37:00 CDT`
  - The associated child `node` was shown as defunct.
- Home also has Codex app-server and Codex Dock relay processes.

## Code Behavior Relevant To The Finding

- `aim codex watch --once` on Redis-backed machines calls `preserveLiveCodexAuthForActiveLabel()` before it checks usage.
- `preserveLiveCodexAuthForActiveLabel()` reads the live `~/.codex/auth.json` for the active label, compares token fingerprints, and if the fingerprint changed it updates the in-memory credential record with status `updated`; Redis-backed watch then publishes that update to Redis via `publishCodexPreserveResult()`.
- If the fingerprint is identical, the log shows `preserved.status: "unchanged"` and Redis publish is skipped.
- The same command can also rotate/write `~/.codex/auth.json` if usage drops below the configured threshold; all observed latest runs had `triggeredSelection: false`.

## Interim Conclusion

- It is not just `Amir-M5`. All checked machines have an automatic Codex watcher installed:
  - `Amir-M5`: launchd, every 300 seconds
  - `agents@amirs-mac-studio`: launchd, every 300 seconds
  - `amirs-m3-max-new`: launchd, every 300 seconds
  - `home` / `amir-server`: systemd timer, every 300 seconds
- The strongest invalid-credential evidence is on `amirs-m3-max-new`, whose latest watcher run at `2026-05-31T18:16:14.904Z` blocked on a `401` invalidated OAuth token for `pro3`.
- Mac Studio and M3 Max New are both watching `pro3`, which means the same label is active on more than one machine.
- The watcher is automatic, frequent, and capable of preserving changed live Codex auth back into the shared Redis credential store when it sees token changes.

## Removal Verification: `Amir-M5`

- Checked after user removed the local watcher.
- Time checked: `2026-05-31 13:27:08 CDT`.
- `launchctl print system/com.funcountry.agents_host.aim_codex_watch` returned:
  - `Could not find service "com.funcountry.agents_host.aim_codex_watch" in domain for system`
- Plist file checks all returned `No such file or directory`:
  - `/Library/LaunchDaemons/com.funcountry.agents_host.aim_codex_watch.plist`
  - `/Library/LaunchAgents/com.funcountry.agents_host.aim_codex_watch.plist`
  - `/Users/aelaguiz/Library/LaunchAgents/com.funcountry.agents_host.aim_codex_watch.plist`
- `launchctl print system | rg ...` still showed a disabled override entry:
  - `"com.funcountry.agents_host.aim_codex_watch" => disabled`
  - This is not a loaded service and has no plist backing it.
- Process scan found no live `aimgr codex watch` / `agents_host_aim_codex_watch` process, only the verification command itself.

## Removal Verification: `amirs-m3-max-new`

- Checked after user removed the watcher.
- Time checked: `2026-05-31 13:27:41 CDT`.
- `launchctl print system/com.funcountry.agents_host.aim_codex_watch` returned:
  - `Could not find service "com.funcountry.agents_host.aim_codex_watch" in domain for system`
- Plist file checks all returned `No such file or directory`:
  - `/Library/LaunchDaemons/com.funcountry.agents_host.aim_codex_watch.plist`
  - `/Library/LaunchAgents/com.funcountry.agents_host.aim_codex_watch.plist`
  - `/Users/aelaguiz/Library/LaunchAgents/com.funcountry.agents_host.aim_codex_watch.plist`
- `launchctl print system | rg ...` still showed a disabled override entry:
  - `"com.funcountry.agents_host.aim_codex_watch" => disabled`
  - This is not a loaded service and has no plist backing it.
- Process scan found no live `aimgr codex watch` / `agents_host_aim_codex_watch` process, only the verification command itself.

## Removal Verification: `claw` / `bigboi`

- Checked `ssh claw`; remote host reported:
  - `HOST=bigboi`
  - `USER=claw`
  - `OS=Linux`
- Initial check found the Codex watcher still active:
  - `aim-codex-watch.timer` loaded, enabled, and active
  - `aim-codex-watch.service` loaded, inactive after last successful run
  - Unit files existed:
    - `/etc/systemd/system/aim-codex-watch.service`
    - `/etc/systemd/system/aim-codex-watch.timer`
  - Last shown service run: `2026-05-31 14:14:47 CDT`
- `sudo -n true` succeeded on `claw`, so the timer was removed with:
  - `sudo -n systemctl disable --now aim-codex-watch.timer`
  - `sudo -n systemctl stop aim-codex-watch.service`
  - `sudo -n rm -f /etc/systemd/system/aim-codex-watch.service /etc/systemd/system/aim-codex-watch.timer`
  - `sudo -n systemctl daemon-reload`
- Post-removal verification on `claw`:
  - `Unit aim-codex-watch.timer could not be found.`
  - `Unit aim-codex-watch.service could not be found.`
  - Both unit files returned `No such file or directory`.
  - Process scan found no live `aimgr codex watch` / `agents_host_aim_codex_watch` process.

## Final All-Host Verification

- Time checked: `2026-05-31 14:19 CDT`.
- `Amir-M5`: service `GONE`; plist files `GONE`.
- `amirs-m3-max-new`: service `GONE`; plist files `GONE`.
- `agents@amirs-mac-studio`: service `GONE`; plist files `GONE`.
- `home` / `amir-server`: systemd unit `GONE`; unit files `GONE`.
- `claw` / `bigboi`: systemd unit `GONE`; unit files `GONE`.
