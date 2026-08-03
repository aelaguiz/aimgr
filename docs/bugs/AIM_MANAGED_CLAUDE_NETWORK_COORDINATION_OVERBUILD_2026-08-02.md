# AIM Managed Claude Network-Coordination Overbuild — Cut Analysis

Date: 2026-08-02  
Status: discussion draft; urgent no-freeze hotfix is being implemented separately

## Requirements

1. A running Claude terminal must never freeze, stutter, or die merely because
   Redis, Tailscale, or the current Wi-Fi network is temporarily unavailable.
2. AIM should try to renew the account lease. If transport fails, it should
   leave Claude running and try again on a later heartbeat.
3. A successful Redis response proving that another owner has acquired the
   same account remains a real conflict and may stop the stale session.
4. Preserve Redis credential rotation publication without making Redis a
   synchronous dependency of Claude's interactive input/output loop.
5. No new daemon, offline queue, distributed protocol, UI state machine, or
   adjacent scope. Prefer deletion over replacement machinery.

## Bottom line

The managed-Claude wrapper is overbuilt because it treats a short Redis lease
as permission for the *entire Claude process to execute*, rather than as
coordination for account selection and credential publication.

Commit `ceb857d` attempted to repair sessions dying after sleep. It changed the
failure mode from **kill on one Redis failure** to **freeze on one Redis
failure** by adding pause/resume state, IPC controls, and literal
`SIGSTOP`/`SIGCONT` signals. That commit added 469 lines across seven files.

During the 2026-08-02 reproduction:

- Redis was configured on `amirs-mac-studio:6380` over Tailscale.
- Wi-Fi/Tailscale transition produced alternating Redis PONGs and timeouts and
  50% packet loss to the Redis host.
- Three freshly resumed AIM Claude children entered macOS process state `T+`
  while their AIM wrappers and supervisors remained runnable.
- One Claude child changed `T+ -> S+ -> T+` as its independently phased
  heartbeat first succeeded and then timed out again.

This exactly explains the rotating set of responsive and frozen sessions.

## Current execution path

```text
running Claude
  -> every 10 seconds: renew/reacquire 30-second Redis lease
  -> Redis does not answer within 5 seconds
  -> classify as "unreachable"
  -> heartbeat enters paused state
  -> AIM sends pause IPC to claude-supervisor
  -> supervisor sends SIGSTOP to Claude
  -> later heartbeat reaches Redis
  -> AIM sends resume IPC
  -> supervisor sends SIGCONT
```

Each session owns a different Redis connection and heartbeat phase. Network
flapping therefore stops and resumes different sessions at different times.

## Overbuild inventory

| Mechanism | Intended purpose | Actual cost | Recommendation |
|---|---|---|---|
| `paused` state inside the lease heartbeat | Represent uncertain Redis ownership | Turns transport instability into application lifecycle state | **Cut** |
| `pauseForUncertainOwnership` / `resumeAfterOwnershipRecovered` callbacks | Connect coordination state to the child process | Couples Redis directly to the TUI | **Cut** |
| Runner IPC `pause` / `resume` messages | Carry the pause decision across the supervisor boundary | Extra protocol and failure modes for behavior we do not want | **Cut** |
| Supervisor `SIGSTOP` / `SIGCONT` handling | Enforce the pause | Makes Claude unable to render or accept input; produces the reported lockup | **Cut** |
| Abort when pause IPC fails | Fail closed when AIM cannot freeze Claude | Converts an ordinary network transition into a dead session | **Cut** |
| `heartbeat.paused` branch in the active rotation publisher | Avoid publication while frozen | Dead complexity after freezing is removed | **Cut** |
| Test contract requiring pause, resume, and termination after temporary loss | Prove the 2026-07-28 design | Enshrines the user-visible defect | **Replace** with retry-without-pause proof |
| Five-second per-attempt deadline | Bound a hung Redis call | Reasonable if timeout only means “retry later” | **Keep** |
| Three outcomes: renewed, contended, unreachable | Distinguish a real competing owner from transport failure | This is the useful core decision | **Keep** |
| Atomic renew-or-reacquire Lua operation | Recover after sleep only if no replacement owner exists | Small, correct protection against overwriting another owner | **Keep** |
| Thirty-second lease and ten-second retry cadence | Exclude the same account from normal concurrent selection | Simple enough once it no longer controls process execution | **Keep for now** |
| Durable Redis rotation fence | Prevent a different recovery home from publishing an unrelated token successor | Protects refresh-token lineage across machine failure | **Keep** |
| Thirty-second active rotation publisher | Publish a refreshed file-backed Claude token while the session is still running | Reduces loss if the process later crashes | **Keep**, but skip a tick when Redis is unavailable |
| Local `rotationPublicationPendingByLabel` plus shared Redis fence | Remember continuity failure locally and globally | Duplicate state has already produced orphan-marker and hidden-fence failures | **Review next**, separately |

## Minimal target behavior

The entire interactive heartbeat can be expressed as:

```text
result = try renew_or_reacquire_with_5_second_deadline()

if result == renewed:
    continue

if result == unreachable:
    keep Claude running
    schedule the next ordinary retry
    skip Redis publication until a retry succeeds

if result == contended:
    terminate the stale owner
```

No pause state. No process-control callback. No pause/resume IPC. No
`SIGSTOP`. No `SIGCONT`. No new retry subsystem: the existing heartbeat timer
already performs the retry.

## Why the simpler behavior is sufficiently safe

The lease is not the only safety boundary:

1. Every managed run also creates a durable rotation fence tied to its token
   lineage and recovery storage identity.
2. A different machine or AIM home cannot pass that fence merely because the
   short lease expired.
3. The running session keeps its credential inside its existing contained
   home; Redis publication can wait until connectivity returns.
4. When Redis does return, a confirmed replacement owner still causes the
   stale process to stop before it publishes.

There remains a narrow theoretical window if Redis is unavailable long enough
for a second launcher using the *same recovery identity* to start. That risk
should not be “solved” by freezing every terminal on ordinary packet loss. If
it becomes a real reproduction, the narrow answer is a same-home process lock,
not another distributed pause protocol.

## Cut now

1. Treat `unreachable` as a skipped renewal and retry later.
2. Preserve immediate abort only for `contended`.
3. Replace the pause/resume regression assertion with an assertion that Claude
   remains running through one or repeated transport failures.
4. Remove the now-unused pause/resume callbacks and IPC/SIGSTOP machinery in a
   cleanup commit after the urgent behavior change is deployed.

## Keep out of this change

1. Do not redesign Redis, Tailscale, or fleet topology.
2. Do not add exponential backoff, jitter, reconnect queues, or a new daemon.
3. Do not change automatic account ranking, session discovery, MCP/plugin
   projection, or Claude authentication.
4. Do not redesign rotation fences or local pending markers in the urgent fix.
5. Do not make offline launch a requirement; this change concerns already
   running interactive sessions.

## Follow-up candidates for a separate discussion

### 1. Delete dead process-control code

Once the no-freeze behavior is deployed and verified, remove the pause/resume
message type, runner registration API, supervisor `childPaused` state, and
their tests. Keep the supervisor itself: its parent-liveness and ordinary
signal-forwarding behavior is separate and still useful.

### 2. Collapse duplicate pending state

`rotationPublicationPendingByLabel` is local, while the rotation fence is
shared in Redis. The two sources have already disagreed in both directions:
an orphan local marker blocked a safe launch, and a shared fence was invisible
to automatic selection. Analyze whether the local marker can be derived or
removed. Do not mix that work into the network hotfix.

### 3. Make shared fences visible to selection

Status and automatic account selection should read shared fences and
quarantine those labels. That prevents one crashed account from breaking blind
`aim claude run fable` or `opus`. This is the previously identified fence bug,
not part of the SIGSTOP removal.

## Decision to discuss

Recommended boundary:

- Redis decides whether a **new** session may claim an account and whether a
  credential update may be published.
- Redis transport failure does **not** decide whether an already-running local
  Claude process may render, accept input, or continue its work.
- Only a confirmed competing owner ends the existing session.

