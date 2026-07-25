---
title: "AIM managed Claude dies across ordinary macOS sleep"
date: 2026-07-25
status: resolved
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
- **Status:** Resolved. The Claude heartbeat can atomically reclaim its same
  opaque lease after sleep only when the label is still unowned. A replacement
  owner, Redis failure, and ordinary short operations retain fail-closed
  behavior.

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
- Redis is temporarily unavailable at wake; the existing fail-closed
  termination behavior remains unchanged.
- Existing Ctrl-C, AIM parent-death, IPC-disconnect, lease-contention, and
  rotation-publication tests retain their current behavior.
- One local process-only smoke uses a stub child and a controlled Redis test
  namespace. No real Claude inference is required.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

1. Add a capability-guarded Redis Lua operation for the existing opaque lease:
   renew when the token still owns the key; atomically restore the same token
   only when the key is absent; return loss when another token owns it.
2. Use that operation only from the long-running Claude heartbeat. Ordinary
   short credential operations retain strict `renew()` semantics.
3. Prove expired-and-unowned recovery, competing-owner rejection, sanitized
   Redis failure, and unchanged release/guard behavior.
4. Run the focused Claude coordination/CLI tests and full suite; do not touch
   Codex, the supervisor, or unrelated auth maintenance.

This preserves the existing five-second fail-closed behavior for Redis
unavailability and real contention. Simply increasing the TTL is not
sufficient: it only changes which sleep durations fail and leaves crashed
processes locked longer.

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

`PASS` for AIM-managed Claude sleep recovery.

- Focused Claude lifecycle, lease, and macOS boundary suites: `62/62`.
- Full AIM suite: `365/365`.
- Lint and `git diff --check`: clean.
- The replacement-owner test proves the waking session cannot steal a label
  acquired while it slept.
- No provider request, model turn, live credential write, process kill, or
  synthetic machine sleep was used for verification.

Standalone Codex remains outside this bug because it survived the observed
wake and has no reproduction.

<!-- bugs:block:verification:end -->
