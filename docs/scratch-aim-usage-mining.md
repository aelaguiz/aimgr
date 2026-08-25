# aim / aimgr real-usage mining (agent session history)

Date: 2026-08-25. Sources: `~/.prime/agent/sessions/*.jsonl` (728 files, 4.8G), `~/.codex/sessions/2026/08` (6.4G), `~/.claude/projects` (1.3G), `~/.zsh_history`. Method: bounded `rg` sampling, not exhaustive parsing. Counts are string-occurrence counts (include agent output/docs echoing commands), so treat as relative frequency, not exact invocation counts.

## 1. Frequency-ranked command surface

### Amir's own hands (zsh history, normalized)

| rank | command | count |
|---|---|---|
| 1 | `aim prime resume <sid>` | 178 (+28 with full .jsonl path) |
| 2 | `aim prime run codex` | 152 |
| 3 | `aim prime run claude` | 68 |
| 4 | `aim prime resume <sid> --rotate` | 65 |
| 5 | `aim status` | 23 |
| 6 | `aim claude status` | 17 |
| 7 | `aim prime run grok` | 4 |
| 8 | `aim codex use [label]` | 5 |
| 9 | `aim prime resume <sid> --fork` | 1 |

Interactive human usage is ~95% session lifecycle: run, resume, resume --rotate, plus status checks. Frequent typos (`runc laude`, `run codexc`) suggest he wants fewer keystrokes.

### Inside agent sessions (Prime Agent logs, top normalized fragments)

| command family | prime-session hits | codex-session hits (Aug) | notes |
|---|---|---|---|
| `aim prime run <codex\|claude\|grok>` | ~1,880 | ~1,770 | core launch verb |
| `aim prime resume <sid> [--rotate]` | ~1,350 | ~3,340 | rate-limit recovery loop |
| `aim prime use <codex\|claude\|grok>` | ~1,510 | ~700 | credential bind w/o launch |
| `aim login <label>` | ~1,320 | ~2,220 | re-auth a specific account |
| `aim claude run/resume/list/status/usage/inventory` | ~2,300 | ~13,000 | Claude-harness lifecycle |
| `aim claude capture-native / import-native / export-live` | ~1,260 | ~2,500 | native-session capture into pool |
| `aim codex use / run / watch / desktop / label` | ~1,300 | ~5,400 | codex account switch + watcher |
| `aim status [--accounts\|--json\|--compact]` | ~740 | ~1,060 | pool health dashboard |
| `aim auth maintain / auth write hermes` | ~770 | ~1,160 | credential repair/refresh |
| `aim redis configure/import/export/config/ping/migrate` | ~1,200 | ~1,300 | shared cred store ops |
| `aim hermes watch [--once] [--rotate-below-5h-remaining-pct N]` | ~390 | ~300 | fleet auto-rotation daemon |
| `aim prime status / uninstall / create / identity` | ~800 | ~600 | binding + scheduled-routine surface |
| `aim grok status / inventory` | ~275 | — | Grok pool checks |
| `aim repair` | 1 | — | effectively unused |

Related non-`aim` tooling in the same loops: `codex-watch.sh --status/--install/--uninstall` (~400 hits), `hermes fallback add/list`, LaunchDaemon `com.funcountry.aimgr.routine.gp-monday-reset`.

## 2. Machines involved

- **Amir-M5** — current local Mac (this machine).
- **agents@amirs-mac-studio** — the "agents" Mac Studio; runs hermes agents in `~/workspace/agents`, cron jobs (`Daily Poker News Radar`), needs remote rotation via ssh.
- **amirs-m3-max-new** (~1,300 mentions) — hermes agents for 2 agents; grok 4.6 oauth work done here via ssh.
- **"home server"** — repeated resume/rotate failures diagnosed there; also amirs-m3-36gb, amirs-old-m1 appear.
- VMs — "uh on the vm? Just rotate using aimgr so it gets a new codex rate limit" (2026-08-20).

## 3. Recurring workflows (what happens before/after aim commands)

**W1. Rate-limit → rotate → resume (THE dominant loop).** Session hits usage limit (429, "resets at <ts>"). Amir runs `aim prime resume <sid> --rotate` (or rotates then tells the agent "i rotated pick it back up", "continue had to rotate accounts", "just rotated rate limits again see if they work"). Agents are also told to self-serve: "If it hits rate limits rotate accounts using aimgr" (2026-08-20, conductor goal loop); "use aimgr to rotate if you're getting rate limits" (2026-08-20).

**W2. Stuck-session policing.** Constant human pings: "whats going on you seem stuck" (08-06), "been stuck for 15 minutes" (08-07), "You've been stuck for 12 minutes... Don't just naively rerun it" (08-14), "you've been stuck for 3 hours" (08-16), "you were stuck for 5 hours on the last command" (08-19), "on the home server is prime agent 01a02686... stuck? I feel like its just stuck compacting can you see whats going on I can't even stop it" (08-23). He manually detects stuckness by watching; no tool tells him.

**W3. Which-account / usage visibility.** "how can I tell which account it's using from inside Prime Agent?" (08-06); asked for a `/usage` slash command that prints account + usage inline; "does it ever pick the same account twice if I rotate?" (08-21); "can we just add a column in our aim status for number of resets per account" + "i just bought a reset, now see if it shows as unused in aim" (08-17); `aim claude status` averaging question (08-15).

**W4. Fleet/remote maintenance over ssh.** "ssh into our agents@amirs-mac-studio and figure out why my agents are rate limited they use aimgr (hermes agents in ~/workspace/agents) so prob need to be rotated" (08-19); "ssh into amirs-m3-max-new and update our hermes for both agents to latest, and switch max rivers to use grok 4.6 via oauth" (08-13); cron failure triage: "Cron 'Daily Poker News Radar' failed: provider rate limit. No fallback chain configured — add one with hermes fallback add" (08-23).

**W5. Login/re-auth of a flagged account.** `aim status` shows `NEEDS YOU ... aim login amir_cratejoy_max`; Amir has the account open in BrowserOS and tells the agent to drive the oauth (08-15). Token-expired codex accounts fixed via `aim codex use` + re-login (08-18).

**W6. Version/lock/daemon conflicts around launch.** Recurring failure modes he pastes at agents: `aim: Lock file is already being held`; `Error: Session tree must be completely idle for AIM credential handoff`; `A background service from a different Prime Agent version is running with N busy sessions. Stop it and continue?` (08-17/08-18); `Daemon worker runtime build does not match its supervisor`; `aim: Redis credential lease status read failed`; `Refusing to replace an AIM descriptor without its local ownership receipt`. Each triggers an agent-led diagnose/repair session.

**W7. Credential-protocol repair at scale.** "theres a bunch of sessions that have the aim credential helper protocol mismatch. Can you figure those out, get them fixed and up again?" (08-20) — bulk repair of live sessions, "i'm stuck unable to work until you get my session back up so get it done quickly".

**W8. Rotation quality complaints.** "--rotate ... all 3 landed on pro2 rather than different accounts... They shouldn't all go to the same one and just blow out its window. Fix it simply." (08-09); "I'll switch accounts with rotate and I'm immediately rate limited again" (08-21). Rotation policy itself is a live concern.

**W9. Scheduled routines through aimgr.** "figure out how to set the gp monday reset as an aimgr recurring job using opus 5 high... every monday morning 8am" (08-17) → LaunchDaemon `com.funcountry.aimgr.routine.gp-monday-reset`; scheduled probe messages ("AIM_SCHEDULE_SMOKE_OK", "AIM_ROUTINE_PIN_OK", rotate-probe messages) confirm bindings after rotation.

**W10. Watchers/daemons.** `aim hermes watch --once --rotate-below-5h-remaining-pct 20` as scheduler-safe one-shot; installed as LaunchDaemon every 300s on fleet machines; `codex-watch.sh --status/--install/--uninstall` maintenance sessions.

## 4. UX signals Amir stated directly

- Wants shortest possible verbs: "I want to type just 'aim prime use codex'... I don't want to have to remember all this shit" (08-06).
- Built `--rotate` on request: "make it so I can just do --rotate so... it picks the next best account... do not overbuild this" (08-06).
- Hates protective locks/refusals: "god damnit more locking f***ing bullshit... WHAT IS IT PROTECTING ME FROM?" (08-08); "the latest overbuild protecting me from nothing" (08-09).
- Orphaned/unfindable sessions frustrate him: "I like get these orphaned sessions I can't resume or find anywhere" (08-09); resume choosing wrong provider (08-09).
- Deploys aimgr to fleet: "get our AIM Manager pushed, and then deploy it to my fleet" (08-06).

## 5. Implications for an MCP remote-control surface

Grounded in the above, the highest-value remote operations are:
1. **Pool status** (`aim status --json` equivalent): accounts, usage %, resets-at, NEEDS-YOU flags, per-machine.
2. **Session inventory + stuckness**: list live prime/claude/codex sessions per machine with last-activity age (W2/W3 — today he detects stuck sessions by eyeball).
3. **Rotate + resume a session remotely** (`prime resume <sid> --rotate`) including "rotate whatever is rate limited on machine X" (W1/W4).
4. **Re-auth trigger** for a flagged account (`aim login <label>` initiation + status of pending oauth) (W5).
5. **Repair verbs**: kill stale daemon/lock, fix version-mismatch background service, bulk-fix credential-helper mismatches (W6/W7).
6. **Watcher/cron health**: hermes watch / codex-watch / routine LaunchDaemon status and last-run results (W9/W10).

`aim repair` is essentially unused today; repair happens as ad-hoc agent sessions. Grok is a minor but real third provider. Everything above already happens over ssh + copy-paste; the MCP surface mostly needs to formalize W1–W6.
