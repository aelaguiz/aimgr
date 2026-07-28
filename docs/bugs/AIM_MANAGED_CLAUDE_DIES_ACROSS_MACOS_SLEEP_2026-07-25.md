---
title: "AIM managed Claude dies across ordinary macOS sleep"
date: 2026-07-25
status: fixed
owners:
  - aelaguiz
reviewers: []
related:
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
  - ../CLAUDE_CODE_OAUTH_LIFECYCLE_AND_KEEPALIVE_2026-07-24.md
---

# AIM managed Claude dies across ordinary macOS sleep

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** AIM-managed Claude sessions left open overnight are gone when
  Amir M5 wakes. The affected sessions were idle, not cleanly exited by the
  operator.
- **Confirmed root cause:** Every managed Claude run owns a Redis credential
  lease with a 30-second TTL, renewed every 10 seconds. macOS suspends the AIM
  process during system sleep while Redis time continues. Once the TTL expires,
  the first renewal after wake returns false; AIM immediately aborts and sends
  `SIGTERM` to Claude, escalating to `SIGKILL` after five seconds.
- **Decisive live evidence:** Amir M5 entered sleep at `06:44:38` on
  2026-07-25. Six independent managed Claude session files were touched during
  shutdown at `06:45:06` through `06:45:09`, exactly as the machine woke from a
  28-second sleep. The one pre-sleep managed run that survived was still locked
  in Redis, consistent with its heartbeat having a slightly later expiry.
- **Not a nightly job or reboot:** The machine had been up for 11 days. No
  local AIM auth-maintainer LaunchAgent was loaded. The event is tied to
  sleep/wake, not a morning schedule.
- **Codex boundary:** Standalone Codex was not killed by this event. Two direct
  Codex processes were still alive after wake—one for 15 hours and one for
  eight days—and no Codex session file was touched during the wake window.
  Codex workers launched inside the killed Claude sessions can die with their
  owner, but there is no evidence of a separate AIM Codex sleep bug.
- **2026-07-28 recurrence:** The original expired-and-unowned sleep case remains
  fixed, but AIM still converts one Redis renewal error or five-second timeout
  into permanent lease loss and immediately aborts Claude.
- **Fresh decisive reproduction:** With Amphetamine off, Amir M5 entered
  clamshell sleep at `09:26:26` on 2026-07-28. DarkWake began at `09:26:46`;
  the managed `boss` session closed at `09:26:51`, exactly AIM's five-second
  Redis renewal deadline. All four AIM Claude wrappers observed immediately
  before sleep were gone afterward and their local account leases were free.
- **Status:** Fixed on 2026-07-28. Temporary Redis unreachability pauses the
  managed Claude process; renewal/reacquisition resumes it, while confirmed
  contention still terminates it.

<!-- bugs:block:tldr:end -->

## Bug North Star

An AIM-managed Claude session must survive ordinary sleep/wake when its account
was not claimed by another process while the machine slept.

Distributed account exclusion remains mandatory: if another AIM process or
machine has legitimately acquired the same account during the sleep interval,
the waking session must not continue with that credential.

Direct Claude arguments, account selection, file-backed credential isolation,
Redis rotation publication, working directory, terminal behavior, and normal
Ctrl-C/parent-death cleanup must not change. No separate Codex lifecycle work
belongs in this bug without a standalone Codex reproduction.

## Reproduction

The real production incident on Amir M5 is the reproduction:

1. Leave multiple `aim claude run ...` sessions open.
2. Put the Mac into system sleep long enough for a 30-second Redis lease to
   expire.
3. Wake the Mac.
4. Observe that most managed Claude wrappers and their Claude children exit
   immediately, while a lease whose remaining TTL happened to span the sleep
   can survive.

No provider request, model turn, credential read, Keychain access, or synthetic
sleep experiment was needed for the analysis. The user's real wake event
produced the failure.

<!-- bugs:block:analysis:start -->

## Analysis

### Fresh Amphetamine-off reproduction confirms a DarkWake reconnect failure

The operator explicitly confirmed Amphetamine was off for this reproduction
and enabled it only after the failure. Historical power and session evidence
aligns with that report:

| Local time, 2026-07-28 | Evidence | Meaning |
|---|---|---|
| `09:20` | Four live AIM Claude wrappers | Pre-sleep baseline |
| `09:26:26` | `pmset`: clamshell sleep begins | Node timers and network are suspended |
| `09:26:46` | `pmset`: DarkWake begins | Timers can resume before full interactive wake/network readiness |
| `09:26:51` | Managed `boss` JSONL mtime | Exact five-second renewal-deadline signature |
| `09:27:31` onward | Repeated maintenance sleep/DarkWake cycles | The machine does not reach full wake until `09:33:35` |
| `09:35` | Zero AIM Claude wrappers; all affected local labels unlocked | Every pre-sleep managed run has exited |

This falsifies the incident-specific claim that the lid event did not sleep the
machine. That claim described the earlier `07:47` cluster only; it does not
apply to this controlled reproduction.

The active code makes the failure deterministic:

1. A resumed heartbeat gets five seconds to complete
   `renewOrReacquireRedisCredentialLease`.
2. A Redis transport rejection and a deadline timeout are both collapsed to
   the same boolean `false` used for confirmed ownership loss.
3. The heartbeat immediately calls `abortController.abort()`.
4. The supervisor terminates Claude before networking finishes restoring
   during the longer DarkWake/maintenance-sleep sequence.

The atomic sleep recovery is therefore necessary but incomplete. It correctly
handles an expired Redis key once Redis is reachable. It does not handle the
period where ownership is unknown because Redis cannot yet be reached.

### Scope disposition for the recurrence

Handling temporary Redis unreachability was `new-scope-needs-human` relative
to the completed 2026-07-25 fix, whose frozen contract explicitly retained
fail-closed behavior for Redis failure. Amir authorized that expansion on
2026-07-28.

The follow-up scope is now frozen:

- distinguish `renewed`, `contended`, and `unreachable` lease outcomes;
- pause the managed Claude process while ownership is unreachable;
- retry ownership resolution without letting Claude run;
- resume only after renewal or safe absent-key reacquisition;
- retain immediate termination for confirmed replacement ownership.

No daemon, Redis schema change, lock removal, configurable retry framework,
unfenced grace period, or unrelated selection/credential behavior is in scope.

### Recurrence on 2026-07-28 is not the original sleep-expiry case

Fresh evidence from Amir M5:

- `pmset -g log` records no sleep or wake after `2026-07-27 14:55:57`.
  Amphetamine, BrowserOS, and repeated `caffeinate` assertions were active, so
  closing the lid did not produce the original suspended-process event.
- AIM-managed files under `boss` and `pro6` closed in one cluster at
  `07:47:22` through `07:47:27`. No kernel, jetsam, memorystatus, or
  RunningBoard kill matched that window.
- An AIM Claude wrapper started at `2026-07-27 21:13:06` remains alive after
  the incident. The machine did not reboot, and macOS did not kill every AIM
  process.
- The installed AIM checkout is `849f9c7` and contains the original
  `renewOrReacquireRedisCredentialLease` sleep recovery.
- `renewClaudeCredentialLeaseWithinDeadline` still maps every Redis rejection
  and every five-second timeout to `false`; the heartbeat treats that single
  result as permanent loss and calls `abortController.abort()` immediately.

The measured facts disprove a repeat of macOS suspending Node past the lease
TTL in this incident. The leading explanation is a transient loss of Redis
reachability or an ownership check racing network restoration while the
laptop moved between networks. Direct wrapper stderr was not persisted, so
the exact Redis error is unavailable after the foreground terminal closed.

The original recovery operation only helps after Redis is reachable: it can
renew the same owner or atomically reclaim an absent key. It cannot distinguish
a temporary transport failure from a real replacement owner while Redis is
unreachable. The current caller resolves that uncertainty by killing Claude
after the first failed heartbeat.

### Incident timeline on Amir M5

| Local time, 2026-07-25 | Evidence | Meaning |
|---|---|---|
| `06:44:38` | `pmset -g log`: `Entering Sleep state due to 'Clamshell Sleep'` | The machine and Node timers were suspended |
| `06:45:06` | `pmset`: DarkWake; managed `boss` and `pro11` session mtimes | AIM/Claude processes began running again and those sessions shut down |
| `06:45:07` | `pmset`: FullWake; managed `coder` session mtime | The shutdown cluster continued at wake |
| `06:45:08` | Managed `claudalyst` and `pro10` session mtimes | Independent account sessions failed together |
| `06:45:09` | Managed `pro4` session mtime | Final observed member of the same wake cluster |
| `06:47:02` onward | New AIM wrappers started; Redis showed `pro9` and `qa` locked | These are post-wake replacements, not survivors |

The affected Claude JSONL files contain normal completed turns followed by
Claude's untimestamped `last-prompt` bookkeeping. They do not contain a model
error or clean user-requested exit at `06:45`; their filesystem mtimes move
together only when the suspended processes wake and terminate.

Amir M5 did not reboot. At observation time it had been up since
`2026-07-14 06:17:49`.

### Exact AIM kill path

1. `src/coordination/redis-credential-lease.js:5` sets the credential lease TTL
   to `30_000` milliseconds.
2. `src/cli/commands/claude.js:78-79` renews that lease every 10 seconds and
   gives each renewal only five seconds.
3. `src/cli/commands/claude.js:115-139` treats one false or failed renewal as
   permanent loss and immediately calls `abortController.abort()`. There is no
   wake recovery, retry, or safe reacquisition path.
4. `src/cli/commands/claude.js:873-883` passes that abort signal into the real
   Claude launch.
5. `src/targets/claude-runner.js:1252-1266` responds by sending the supervisor
   `SIGTERM`, followed by `SIGKILL` after five seconds if needed.
6. `src/targets/claude-supervisor.js:23-29,79-97` deliberately propagates AIM
   termination or IPC loss to the real Claude child.

The safety behavior is internally consistent: a stale owner must not continue
after another owner acquires its credential. The defect is that normal host
sleep is classified as permanent ownership loss even when no replacement
owner exists.

### Why the 28-second sleep killed most sessions

Each heartbeat renews a 30-second TTL every 10 seconds. At the instant the Mac
sleeps, a session therefore has roughly 20 to 30 seconds left on its Redis
lease. Redis runs on another awake machine, so its expiry clock does not pause.

The observed sleep lasted 28 seconds before DarkWake. Most lease phases were
inside that expiry window and failed their first renewal at wake. One pre-sleep
local managed run remained alive and its account (`pro3`) was still locked;
that is consistent with a lease renewed close enough to sleep to survive the
28-second interval. The phase-dependent survivor is additional evidence for a
TTL cliff rather than a blanket OS process kill.

The same code can also kill sessions during a Redis/network interruption:
one renewal error or one five-second timeout follows the same abort path.

### Codex did not independently reproduce

At `06:53`, after the failing wake:

- direct Codex PID `49985` had been alive since July 16;
- direct Codex PID `80569` had been alive since July 24 at `15:48`;
- no `~/.codex/sessions/**/*.jsonl` file had an mtime between `06:44:20` and
  `06:45:40`;
- no recent Codex session metadata used an `aimgr-tend-*` originator.

This disproves the broad claim that macOS or AIM killed every standalone Codex
process at wake. Codex workers started as tools beneath an affected Claude
session may disappear when their owning Claude/shell tree is terminated. That
is a consequence of the confirmed Claude kill until a standalone Codex
reproduction says otherwise.

### Ranked hypotheses

1. **Confirmed — Redis credential lease expires while macOS suspends AIM.**
   The 30-second lease, 10-second heartbeat, immediate abort path, 28-second
   sleep, phase-dependent survivor, and six-file wake cluster align.
2. **Disproved — Amir M5 rebooted or macOS killed all agent processes.**
   Uptime spans 11 days, and long-running direct Claude/Codex processes survived.
3. **Disproved — the AIM auth maintainer evicted the sessions.**
   No AIM auth-maintainer LaunchAgent or local maintainer logs were present.
4. **Disproved — all standalone Codex instances share the Claude lease bug.**
   Direct Codex processes and their session files survived the exact window.
5. **Unproven — a second, independent Codex lifecycle bug exists.**
   No recent AIM Tend process or standalone Codex wake-time exit was available
   to reproduce. Keep this separate unless concrete evidence appears.

### Root cause

A short distributed lease was designed as a process-liveness signal, but
macOS sleep pauses the owner process without pausing the external Redis expiry
clock. AIM then interprets expected lease expiry after suspension as hostile
ownership loss and intentionally kills Claude. The design lacks a safe
post-suspension reacquisition state.

<!-- bugs:block:analysis:end -->

## Scope contract

### Correct behavior

- If the old lease still exists and renews, continue normally.
- If it expired and the label is currently unowned, atomically reacquire it and
  continue the same Claude session.
- If another process owns the label, terminate the waking session exactly as
  AIM does today.
- If Redis ownership is temporarily unknowable, do not let Claude run
  unfenced while deciding.

### Initial minimal convergence closure

- One specialized Redis lease operation that renews an owned lease or
  atomically reclaims the same label only when its key is absent.
- The Claude heartbeat call site that opts into that specialized operation.
- Focused deterministic tests for sleep-length timer suspension and
  reacquisition outcomes.

### Explicitly out of scope

- Changing account-selection policy, usage calculations, OAuth maintenance, or
  Redis credential schema.
- Making leases permanent or extending stale locks for hours.
- Adding a general process daemon, tmux, a VM, or a keep-awake service.
- Changing Claude credential projection, rotation fencing, Keychain policy,
  plugins, MCPs, skills, hooks, or session discovery.
- Modifying Codex Tend or direct Codex lifecycle without a separate
  reproduction.
- Live model requests as a substitute for deterministic lifecycle proof.

### Enough proof

- A fake-clock test advances beyond the original lease TTL with no competitor;
  the same Claude child remains alive after atomic reacquisition.
- A competitor acquires the label during the simulated sleep; the original
  child is terminated and cannot publish rotation state.
- Redis is temporarily unavailable at wake; Claude pauses, rotation publishing
  stays idle, and Claude resumes only after ownership is recovered.
- Existing Ctrl-C, AIM parent-death, IPC-disconnect, lease-contention, and
  rotation-publication tests retain their current behavior.
- One local process-only smoke uses a stub child and a controlled Redis test
  namespace. No real Claude inference is required.

<!-- bugs:block:fix_plan:start -->

## Initial 2026-07-25 fix plan

1. Add a capability-guarded Redis Lua operation for the existing opaque lease:
   renew when the token still owns the key; atomically restore the same token
   only when the key is absent; return loss when another token owns it.
2. Use that operation only from the long-running Claude heartbeat. Ordinary
   short credential operations retain strict `renew()` semantics.
3. Prove expired-and-unowned recovery, competing-owner rejection, sanitized
   Redis failure, and unchanged release/guard behavior.
4. Run the focused Claude coordination/CLI tests and full suite; do not touch
   Codex, the supervisor, or unrelated auth maintenance.

That initial fix preserved five-second fail-closed behavior for Redis
unavailability. The 2026-07-28 recurrence proved that behavior was incomplete;
the authorized follow-up below supersedes it only for a running interactive
managed Claude process. Real contention remains fail-closed.

### Authorized recurrence follow-up

1. Preserve the lease operation's distinction between a Redis transport error
   and a successful Redis response reporting a different owner.
2. Expose pause/resume control for the already-owned managed Claude process
   group without changing its terminal relay or ordinary exit semantics.
3. On transport uncertainty, pause once and retry the existing atomic
   renew-or-reacquire operation on the existing heartbeat cadence.
4. Resume once ownership is renewed/reacquired; abort through the existing path
   if Redis confirms another owner.
5. Prove pause, retry, resume, contention termination, and unchanged normal
   renewal with focused deterministic tests.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation

- `src/coordination/redis-credential-lease.js` adds one capability-guarded Lua
  operation that renews the existing opaque owner token or restores it only
  when the Redis key is absent.
- `src/cli/commands/claude.js` uses that operation only for the long-running
  managed-Claude heartbeat. Ordinary lease users retain strict `renew()`.
- `test/helpers/fake-redis.js` models the atomic operation.
- Focused tests cover expired-and-unowned recovery, replacement-owner
  rejection, sanitized Redis failure, and a managed Claude child surviving a
  simulated timer suspension beyond the original TTL.
- The 2026-07-28 follow-up preserves three renewal outcomes: renewed,
  contended, and unreachable. Only unreachable pauses the running Claude
  process and schedules another atomic ownership check.
- `src/targets/claude-runner.js` sends bounded pause/resume IPC controls to the
  existing supervisor. `src/targets/claude-supervisor.js` maps them to
  `SIGSTOP`/`SIGCONT` for the exact Claude child and resumes a stopped child
  before ordinary termination.
- Active rotation publication stays idle while ownership is uncertain.
  Preflight, maintenance, confirmed contention, and failed process control
  remain fail-closed.

<!-- bugs:block:implementation:end -->

<!-- bugs:block:reviews:start -->

## Reviews

Not run. A reviewer cannot improve the evidence until a fix exists.

<!-- bugs:block:reviews:end -->

<!-- bugs:block:verification:start -->

## Verification

### Read-only commands used

- `uptime` and `sysctl -n kern.boottime`
- `pmset -g log`
- process listings filtered to AIM, Claude, and Codex executables
- managed Claude and Codex session mtimes
- metadata-only JSONL tail inspection; prompt and response bodies were not read
- cached `aim claude status --json`
- exact source reads and Git blame

### Current verdict

`PASS` for AIM-managed Claude sleep and temporary-network recovery.

- Focused Claude lifecycle, lease, runner, and supervisor suites: `70/70`.
- Full AIM suite: `372/372`.
- Lint and `git diff --check`: clean.
- The lifecycle test proves temporary Redis loss pauses Claude, prevents the
  rotation publisher from touching Redis, reacquires an expired unowned lease,
  resumes Claude, and later aborts when a replacement owner is confirmed.
- Runner and supervisor tests prove exact pause/resume IPC, `SIGSTOP`/
  `SIGCONT`, and safe `SIGCONT` before terminating a paused child.
- No provider request, model turn, live credential write, process kill, or
  synthetic machine sleep was used for verification.

Standalone Codex remains outside this bug because it survived the observed
wake and has no reproduction.

<!-- bugs:block:verification:end -->
