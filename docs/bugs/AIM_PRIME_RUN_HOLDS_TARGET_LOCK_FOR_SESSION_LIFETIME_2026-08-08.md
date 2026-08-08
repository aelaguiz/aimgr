---
title: "AIM Prime run holds the target lock for the entire interactive session"
date: 2026-08-08
status: fixed
owners: ["Amir Elaguiz"]
reviewers: []
related:
  - "local PID 82797"
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** A second `aim prime run claude` fails with `Lock file is already being held` while another AIM-launched Prime TUI is open.
- **Impact:** One active Prime session prevents launching every other Prime account locally.
- **Cause:** `handleHarnessTarget()` wraps `prime run` in the outer target mutation mutex, while `handleRun()` waits for the interactive Prime child to exit. The mutex therefore lasts for the full TUI lifetime rather than only startup.
- **Status:** Fixed locally; the pre-fix session and its lock remain untouched.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

An active AIM-launched Prime TUI must not block launching another Prime session. Long-lived interactive child lifetime is not a target-mutation critical section.

## Evidence

- Local target lock directory was created at `2026-08-08 09:50:22`, exactly when PID `82797` started as `aimgr.js prime run claude`.
- Its mtime continues to advance through `proper-lockfile` heartbeats while child Prime PID `82886` remains active.
- Repeated `aim prime run claude` attempts fail on that same target lock.
- Source control flow: `handleHarnessTarget()` acquires the outer mutex around `dispatch()`, `dispatch()` enters `handleRun()`, and `handleRun()` awaits the interactive child close.

## Scope and Simplicity Contract

- **Human-authorized behavior:** Multiple local `aim prime run` sessions can coexist without killing or altering active sessions.
- **Smallest sufficient fix:** Do not route the long-lived human `prime run` command through the outer target mutex. Keep the existing atomic auth-file update inside target selection, and retain the outer mutex for bounded operations such as structured create, use, rotating resume, identity install, and uninstall.
- **Initial minimal convergence closure:** Router change plus a regression that holds the outer target lock and proves `prime run` still launches.
- **Scope freeze:** Frozen before implementation on 2026-08-08.
- **Enough proof:** The regression, Prime target tests, lint, full suite, local wrapper install, and a no-provider-call launch-admission smoke that does not stop existing sessions.
- **Do not build:** No new lock type, daemon protocol, startup heuristic, session termination, or manual deletion of the live lock.
- **Accepted residual risk:** Two human runs started at the same instant retain the pre-existing narrow selection/startup race. Prime session bindings fail closed and pin identity once the new root starts; structured `prime create` remains the exact machine-safe admission lane.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Exempt `prime run` from the outer target mutation mutex, like plain resume.
2. Replace the lifetime-heartbeat regression with a held-lock regression proving another run can launch.
3. Update the mutation-routing test so bounded mutations still require the outer mutex while run and plain resume do not.
4. Run focused and full verification, reinstall local AIM, and prove the live lock no longer blocks a safe isolated Prime run.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

Implemented the smallest router change in `src/cli/commands/harness-target.js`: `prime run` and plain `prime resume` dispatch without the outer target mutex. Bounded target mutations still route through the mutex, and `prime run` retains the existing auth projection transaction inside `handleUse()`.

Regression coverage:

- `Prime run does not wait on a target lock held by another interactive session` acquires the real outer target mutex first and proves an isolated run still reaches its launcher.
- `bounded AIM harness target mutations route through the outer target mutex` keeps use, rotating resume, create, identity install, and uninstall serialized.

Proof completed on 2026-08-08:

- Focused Prime target suite: 35/35 passed.
- `npm run lint`: passed.
- Full `npm test`: 380/380 passed.
- `npm run install:local`: installed the workspace wrapper at `/Users/aelaguiz/.local/bin/aim`.
- Pre-fix PID `82797`, its child Prime session, and its live lock were not stopped or removed.

The bug is closed locally. The existing lock may keep heartbeating until the old AIM parent naturally exits, but new `prime run` invocations no longer consult that long-lived lock.
<!-- /bugs:block:implementation -->
