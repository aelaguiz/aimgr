---
title: "aimgr MCP remote control — full plan"
date: 2026-08-25
status: proposed
owners: [aelaguiz]
doc_type: plan
related:
  - PRIME_AGENT_REMOTE_CONTROL_LANDSCAPE_2026-08-12.md
  - AIM_CLAUDE_STUCK_AIM_FIXING_ANALYSIS_2026-08-02.md
  - aelaguiz/AIM_SCHEDULED_ROUTINES_IMPLEMENTATION_PLAN_2026-08-15.md
  - scratch-aim-usage-mining.md
---

# TL;DR

Build one new command, `aim mcp serve`, that runs on each machine as a LaunchAgent and
exposes an **unauthenticated Streamable-HTTP MCP server on the tailnet** (default port
`7337`, bound to the Tailscale interface). Any MCP client (Claude app, phone, ChatGPT,
another agent) registers three servers — `aim-m5`, `aim-studio`, `aim-m3` — and gets
**eyes and hands** on aimgr on every machine:

- **Information**: raw structured facts — accounts, usage, resets, recent sessions,
  watcher/routine freshness, logs. No verdicts, no summaries — the consuming agent
  answers "how's everything going?" by composing a few info calls.
- **Action**: any non-interactive `aim` command — rotate accounts, run maintenance,
  run routines, repair — plus (Phase 2) completing OAuth re-logins remotely.

Everything is a thin wrapper over the `aim` CLI that already does the work. No new
daemon protocol, no gateway, no auth stack, no event bus, **no judgment in the tool
layer**. Redis is already the fleet SSOT and is itself wide open on the tailnet at
`:6380` — the MCP adds zero new exposure class.

**Effort: Phase 1 ≈ 1 day (usable from a phone that evening). Phase 2 ≈ 1 day, only
after Phase 1 has been used for real.** Roughly 600–800 new LOC plus one dependency
(`@modelcontextprotocol/sdk`).

# 1. Tool-design doctrine (from published MCP best practices)

Sources reviewed 2026-08-25: Anthropic, "Writing effective tools for agents" (2025-09);
modelcontextprotocol.io server-concepts and tools spec (2025-06-18); Anthropic,
"Code execution with MCP".

What they say, applied here:

1. **Tools are model-controlled information providers and action takers.** The MCP docs'
   canonical tools are "search flights", "send messages" — facts in, effects out. The
   agent decides when to call and what it means. **Rule: no tool returns a verdict,
   health grade, stuckness flag, or prose summary.** Facts carry timestamps and ages;
   interpretation belongs to the calling agent.
2. **Consolidation is for mechanical chains, not judgment.** Anthropic's
   `schedule_event` example merges availability-lookup + create into one call because
   agents always chain them — the merged tool is still deterministic data/action, not
   opinion. Here that means `aim_exec` exposes the whole tested CLI as one tool, while a
   composite "how_is_everything" summarizer is explicitly the wrong shape and is not
   built. Same logic cuts thin single-command wrappers around individual `aim`
   subcommands.
3. **Shape data for tokens, not for meaning.** Pagination, line limits, field filtering,
   and a `response_format: concise|detailed` enum are the server's job (Anthropic saw
   ~3× token savings from concise formats). Concise drops noisy fields; it never
   editorializes.
4. **High-signal structured responses.** Prefer semantic names/labels over cryptic IDs,
   consistent JSON, actionable error strings (say what argument was wrong and what
   valid looks like), sensible defaults, hard output caps.
5. **Namespace clearly.** All tools share the `aim_` prefix; boundaries stay obvious. Few,
   non-overlapping tools beat many thin ones.
6. **Iterate from transcripts, not upfront cleverness.** After a week of real use, the
   miner-style transcript review tells us which tools get called, chained, or fumbled;
   reshape then. No eval harness (pragmatism: Amir in the loop is the eval).

# 2. Startup-pragmatism decision record

**Door classification: two-way.** One new subcommand, one install script, one dep.
Reverting is `git revert` plus `--uninstall`. Decided now at current information.

**Cost of wrong vs slow.** Wrong = some tools are awkward and get reshaped (hours).
Slow = every stuck session, rate-limited account, and NEEDS-YOU login keeps requiring
ssh-to-the-right-machine by hand, which the usage mining shows happens near-daily.

**What gets cut (explicitly, forever until proven needed):**

- Auth, tokens, TLS, pairing, RBAC, audit logs, rate limiting. Tailnet membership IS
  the trust boundary, same as Redis today. Amir has explicitly accepted this.
- **Composite verdict/summary tools** (`how_is_everything`, health scores, stuck
  detectors). Server-side judgment is unevaluable, drifts, and duplicates the calling
  agent's actual job. Cut per the doctrine above.
- A central gateway / single aggregating server / cross-machine command bus. The MCP
  client fans out to three endpoints itself; Redis already centralizes pool state.
- Event streaming, subscriptions, push notifications, webhooks.
- MCP resources and prompts. **Tools only** — maximum client compatibility.
- A web/mobile UI. The MCP client is the UI.
- Stable DTO guarantees. Tool outputs are the `--json` output of today's CLI.
- Any change to aimgr internals, Redis schema, or credential flows in Phase 1.

**Where rigor is still owed:**

1. `aim_exec` refuses interactive commands. TUI lanes (`aim prime run`, `aim prime
   resume`, `aim claude run`, the guided label panel) fail fast with a clear error
   instead of hanging on a missing TTY. Remote terminal/session control is explicitly
   out of scope for this MCP (it belongs to the separate prime-agent MCP idea).
2. Every shell-out has a hard timeout (default 120s) and returns captured
   stdout+stderr+exit code. No hung tool calls.
3. The Phase-2 fleet heartbeat record contains no secrets (hostname, timestamps,
   counters only).

# 3. Grounding: what Amir actually does today

Evidence: `docs/scratch-aim-usage-mining.md` (zsh history, 728 Prime session logs,
Codex/Claude session logs, sampled 2026-08) plus the incident docs.

Ranked real usage:

| Real workflow (frequency) | Today | MCP coverage |
|---|---|---|
| "How's the pool / which account / when do resets land" (`aim status` 23, `aim claude status` 17, resets column ask 08-17) | terminal | agent composes `aim_exec` status/claude/grok `--json` calls |
| Rate-limit → rotate ("rotate accounts using aimgr", 08-20) | ssh + paste | `aim_exec ["codex","use"]` |
| Fleet maintenance over ssh (studio hermes rate-limited 08-19; m3 grok oauth 08-13; cron rate-limit fallback 08-23) | ssh to each box | per-machine endpoints + `aim_exec`, `aim_machine_info` |
| NEEDS-YOU re-logins via browser OAuth (08-15) | be at that machine | Phase 2 `aim_login_start`/`aim_login_submit` |
| Launch/lock/lease failures, credential-helper mismatch bulk repair (08-20) | ssh + debugging | `aim_exec`, `aim_log_tail` |
| `aim codex watch` / `aim hermes watch` health | log files on each box | `aim_machine_info` (freshness facts), `aim_log_tail` |
| `aim prime run/resume/--rotate` session starts and takeovers (178+/152/65) | terminal on the right machine | **Out of scope here** — interactive TUI lanes belong to the prime-agent MCP idea; this MCP covers the account/credential layer those sessions depend on |
| Stuck-session policing ("stuck for 3 hours" 08-16, "stuck compacting" 08-23) | eyeball at the desk | **Out of scope here** — same boundary; prime-agent MCP territory |

The defining incident is `AIM_CLAUDE_STUCK_AIM_FIXING_ANALYSIS_2026-08-02`: six wedged
accounts where **every fix was "run command X on machine Y"** (`aim claude run boss` on
M5, capture-native on the fence owner, maintainer log on M3). A per-machine MCP endpoint
is precisely the missing capability; nothing central would have helped. The
non-interactive share of those fixes (maintainer runs, capture-native, login relay,
log reading) is covered here; interactive recovery runs stay a desk/ssh task until the
prime-agent MCP exists.

# 4. Architecture

```
MCP client (Claude app / phone / any agent)  ← judgment lives here
   ├── http://amir-m5.tailnet:7337/mcp        aim mcp serve   (M5)
   ├── http://amirs-mac-studio:7337/mcp       aim mcp serve   (Studio "agents")
   └── http://amirs-m3-max-new:7337/mcp       aim mcp serve   (M3)
                    │ shells out to             ← facts and actions live here
                    ├── aim …  (status/rotate/maintain/routines/login: the tested CLI)
                    └── Redis :6380 (already the fleet SSOT; Phase-2 heartbeats)
```

Decisions, made now:

- **Per-machine server, no aggregator.** Each server answers pool-wide questions anyway
  (Redis), plus its own machine-local truth. MCP clients handle multiple servers natively.
- **Transport:** Streamable HTTP, stateless mode, official `@modelcontextprotocol/sdk`.
  This is the current-spec default with the broadest client support. `--stdio` flag comes
  free from the SDK for local/bridged clients (`mcp-remote` covers HTTP-less clients).
- **Bind** to the machine's Tailscale IP when resolvable, else `0.0.0.0`; `--bind`
  overrides. One line of code, keeps random LAN devices out, zero ceremony.
- **Execution model: shell out to the installed `aim` CLI.** No internal refactor.
  The CLI is the contract that is already tested, locked (proper-lockfile), and
  Redis-aware. `--json` flags already exist on every read surface that matters.
- **Interactive TUI lanes are out of scope.** `aim_exec` rejects them fast. This MCP
  supports aimgr — the account/credential/maintenance layer — not terminal or session
  multiplexing.
- **Deployment:** `scripts/install-mcp-server.sh` following the existing
  `install-auth-maintainer.sh` LaunchAgent pattern; `KeepAlive=true`; logs to
  `~/.aimgr/logs/mcp-serve.log`; `--uninstall` supported. Installed on all three machines.
- **Port 7337** everywhere.

# 5. Tool catalog

Phase 1 ships **3 tools**. The `aim` CLI is already an agent-legible surface (stable
help text, `--json` on every read command) — so one exec tool IS the information
provider and action taker for all of it. The other two exist only because no `aim`
command returns that data. Responses use a `{ok, exitCode, parsed|stdout, stderr}`
envelope, hard-capped ~20k tokens with explicit truncation notices.

| # | Tool | Args | What it does |
|---|---|---|---|
| 1 | `aim_exec` | `argv[]`, `timeoutSec?` | Any non-interactive `aim …` command. All reads (`status --json`, `claude status --json`, `grok status --json`, `claude list --json`, `grok inventory`, `redis config/ping`) and all actions (`codex use`, `auth maintain`, `routine run <id> --manual`, `rebalance hermes`, repair, redis admin, capture-native). Rejects interactive lanes (`prime run/resume`, `claude run`, bare `aim <label>`) with a clear error. Description lists common invocations; agents can run `["help"]`. |
| 2 | `aim_machine_info` | – | Facts no `aim` command returns: hostname, tailscale IP, aimgr git rev, disk free, redis ping ms, watcher log mtime+age (codex-watch, hermes-watch, auth-maintainer), per-routine last receipt (id, exit, age). No health verdict. |
| 3 | `aim_log_tail` | `name\|path`, `lines?` | Known aimgr logs by name (`auth-maintainer`, `codex-watch`, `hermes-watch`, `mcp-serve`) or explicit path. |

Cut from earlier drafts: composite `how_is_everything` (judgment in the tool layer);
seven single-command wrappers (duplicated `aim_exec`); all Herdr terminal/pane/session
tools (`aim_session_start`, `aim_pane_*`) — **this MCP supports aimgr, not herdr**.
Remote start/steer/kill of interactive sessions is the separate prime-agent MCP idea.
If transcript review later shows agents fumbling `aim_exec` arguments for a hot path,
promote exactly that path to a named tool — not before.

Notes:

- "How's everything going?" = the calling agent runs `aim_exec ["status","--json"]`
  once (any server) plus `aim_machine_info` per machine, and writes its own synthesis.
  Judgment stays in the agent.
- `aim_exec` can run anything including `aim redis export` (full credential dump). That
  is identical authority to the ssh access the tailnet already grants. Accepted.

## Phase 2 tools

| Tool | Args | Implementation |
|---|---|---|
| `aim_login_start` | `label` | Spawn `aim login <label> --manual-callback-stdio`, hold the child, return `login_id` + `auth_url`. Amir completes OAuth from any device. |
| `aim_login_submit` | `login_id`, `callback_url` | Write the callback URL to the held child's stdin; return the outcome. Kills the "NEEDS YOU on machine X" trip. |
| `aim_login_pending` | – | List held logins + ages; abandoned ones expire after 15 min. |
| `aim_fleet_peers` | – | Every `aim mcp serve` writes a secret-free heartbeat hash to Redis (TTL 5 min): hostname, endpoint URL, serve uptime, watcher/receipt ages, versions. Returns the raw records — peer discovery + liveness facts, no rollup verdict. ~50 LOC. |

# 6. Phases

## Phase 1 — serve + 3 tools (~0.5 day)

1. `src/cli/commands/mcp.js` + `src/mcp/server.js` + `src/mcp/tools.js`: SDK wiring,
   shell-out helper (timeout, capture, output cap, interactive-command rejection), the
   3 tools.
2. `scripts/install-mcp-server.sh` (LaunchAgent, `--status`, `--uninstall`), README
   section, port 7337.
3. Install on M5 + Studio + M3. Register the three servers in Amir's Claude client.
4. Smoke from the client (this is the proof; no harness): compose a fleet answer from
   `aim_exec ["status","--json"]` + per-machine `aim_machine_info`; rotate with
   `aim_exec ["codex","use"]` on Studio; `aim_log_tail auth-maintainer` on M3; confirm
   `aim_exec ["prime","run","codex"]` is rejected with a clear error.

## Phase 2 — fleet heartbeat + OAuth relay (~1 day, only after Phase 1 sees real use)

1. Heartbeat writer inside `aim mcp serve` + `aim_fleet_peers` reader.
2. `aim_login_start`/`aim_login_submit`/`aim_login_pending` around
   `--manual-callback-stdio`.
3. Transcript review of a week of real tool calls (per the doctrine): reshape awkward
   tools, right-size limits/formats, delete anything unused.

## Explicitly not now

Auth of any kind, TLS, public exposure, notifications/push, event subscriptions, web UI,
session transcript streaming, verdict/summary tools, automatic stuck remediation,
retry/queue machinery, cross-machine failover, Prime-daemon protocol integration (that
is the separate prime-agent MCP idea — this plan is aimgr's own surface), DTO versioning.

# 7. Risks (one line each)

- **Wide-open tailnet MCP = full account/credential authority for any tailnet device.**
  Accepted trust model; identical to today's open Redis + ssh.
- **Concurrent mutation** (MCP + local shell both rotating): existing aim locks already
  arbitrate; same as two terminals today.
- **Tool-shape misses**: expected; Phase-2 transcript review is the correction loop.

# 8. Definition of done (Phase 1)

From the Claude client on the phone, over the tailnet, with all three servers
registered: (1) the agent can answer "how's everything going?" fleet-wide from
`aim_exec` + `aim_machine_info` alone, with its own synthesis; (2) any non-interactive
`aim` command runs on any chosen machine with output back in the client; (3) watcher
and maintainer health is checkable per machine without ssh; (4) interactive lanes fail
fast with a clear pointer instead of hanging.
