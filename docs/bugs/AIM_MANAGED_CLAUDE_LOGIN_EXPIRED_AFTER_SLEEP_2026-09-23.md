---
title: "Managed Claude login expires after a lost Redis lease"
date: 2026-09-23
status: fixed-in-working-tree
owners: [aelaguiz]
---

# Managed Claude login expires after a lost Redis lease

## Root cause

An AIM-managed Claude run starts with a 30-second Redis credential lease and
renews it every 10 seconds. Sleep or a network outage can interrupt renewal.
Commit `3ef2758` on 2026-08-02 removed the pause/resume process control added
by `ceb857d` on 2026-07-28. Since that regression, an unreachable renewal
leaves the native Claude process running while its lease expires. Another AIM
writer can then acquire the label, refresh its single-use OAuth lineage, and
publish a new credential. The uncoordinated, still-running Claude process
later attempts to use its superseded credential. Claude Code writes empty
access and refresh tokens with `expiresAt: 0` and displays `Login expired`.

This is **not an inactivity timeout**. Idle time only delays the first request
that exposes a credential rotation that already happened. The initial
`economy` diagnosis incorrectly inferred an offline-cache launch from its
missing socket. Its argv was `aimgr.js claude run opus`; the auto-selection
branch sets `allowOffline: false`, so it started through the online leased
path and lost coordination later.

## Local evidence

All times below are 2026-09-23 in America/Chicago.

| Time | Observation |
| --- | --- |
| 09:25–09:34 | `pmset -g log` records clamshell sleep, DarkWake, maintenance sleeps, then full wake. This is long enough to expire a 30-second lease. |
| 09:36:45 | Redis `pro13` credential version 118 was updated to a later OAuth expiry. |
| 09:38:11 | `pro13` local Claude file became an empty-token tombstone with `expiresAt: 0`. Its AIM/Claude processes were still alive at inspection, but the label had no Redis lease. |
| 13:39:18 | Last successful `economy` model response. |
| 13:47:32 | Redis `pro14` credential version 117 was updated to an OAuth expiry at 21:47:34; provenance said `native-claude-rotation`. |
| 13:48:38–39 | The `economy` local credential file was rewritten with empty tokens and `expiresAt: 0`; its transcript then recorded `Login expired · Please run /login` with `authentication_failed`. |
| 13:52 | A fresh `aim claude status pro14 --fresh --verbose --json` request authenticated successfully using the Redis credential. The live `economy` AIM parent had no Redis TCP socket, and Redis reported its account lease free. |

`pro1` had the same empty-token tombstone shortly after a Redis rotation.
At inspection, 10 of 13 labels with active managed Claude supervisors had no
Redis credential lease. This was a fleet pattern, not a defect confined to
`economy`. The postmortem cannot distinguish whether each individual socket
failed to reconnect after sleep or was closed for another transport reason;
the persisted process/lease state and the safety regression are conclusive.
The specific AIM writer that rotated `pro14` was not logged, so its identity
is not asserted here.

## Repair

- A managed Claude process now receives an acknowledged `SIGSTOP` when lease
  renewal is unreachable. If AIM cannot confirm the pause, it terminates the
  process rather than letting it use an unowned credential.
- AIM opens a fresh leased Redis connection after an unreachable renewal,
  then renews or reacquires the exact lease. A paused Claude process resumes
  with `SIGCONT` only after ownership is confirmed.
- Before resuming, AIM reloads the Redis credential and compares its token
  lineage with the pre-outage record. A changed lineage terminates the stale
  process with a resume instruction. Active rotation publication stays idle
  while Claude is paused.
- Regression tests cover transport failure, pause, fresh-connection recovery,
  resume, competing ownership, changed token lineage, and actual supervisor
  `SIGSTOP`/`SIGCONT` delivery over IPC.

## Verification and operating limit

`npm test` passed 531 tests, including the real-IPC supervisor test, and
`npm run lint` passed. Existing AIM processes
loaded the old JavaScript before this repair and must be relaunched to use it.
The explicit clean-cache launch path can still run without Redis when the
operator requests a specific label during an outage; that path cannot prove
cross-machine credential ownership while offline. It did not launch
`economy`.
