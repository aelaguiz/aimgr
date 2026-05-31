---
title: "Codex Tend - Low-Latency Foreground Relay - Architecture Plan"
date: 2026-05-30
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [arch-step-auto-plan]
doc_type: phased_refactor
related:
  - docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md
  - docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30_PLAN_AUDIT.md
  - docs/codex-tend-instability-findings-2026-05-30.md
  - docs/codex-tend-multi-instance-plan-2026-05-30.md
  - docs/codex-tend-path-bug-analysis-2026-05-30.md
  - docs/codex-tend-redesign-2026-05-30.md
---

# TL;DR

## Outcome

`aim codex run --tend` keeps AIMGR's account-rotation and rollout ownership logic, but the attached
human terminal path moves off the current Node/Python JSON relay. Foreground typing and Codex screen
rendering must run through a low-latency raw PTY relay with input priority and a management side
channel, not through JSON/base64 frames in the Node event loop.

## Problem

The first PTY cutover removed tmux and the private Codex app-server, then fixed the controlling
terminal bug. That made input possible, but not usable under fast typing. The attached hot path still
serializes every keystroke and every TUI output chunk through Node, JSON, base64, Python, and back
again. Under output/render backlog, the same management bridge that should supervise Codex can delay
human input and visible echo for seconds.

## Approach

Separate the planes:

- Human plane: raw bytes between the user's terminal and Codex's PTY, with independent input/output
  pumps and no JSON/base64 on the foreground hot path.
- Manager plane: AIMGR Node continues owning preflight, rollout identity, per-thread locks, goal
  state, account rotation, resume orchestration, and returned status/events through a small control
  side channel.

Keep the current JSON PTY helper for `--no-attach` automation and focused tests unless the new relay
fully replaces it. The default attached human path must use the new foreground relay.

## Plan

Phase 1 builds and proves the raw foreground relay against a synthetic high-output typing-latency
gate before Tend uses it. Phase 2 adapts `runCodexTender` to choose the foreground relay for attached
sessions while preserving current rollout/rotation behavior. Phase 3 updates tests, help, docs, and
fleet-ready verification so the shipped path is honest and the old smokes are not mistaken for
latency proof.

## Non-negotiables

- No tmux runtime, tmux attach, tmux session nesting, or tmux fallback.
- No Codex app-server or `--remote` path.
- No JSON/base64 or Node `process.stdin`/`process.stdout` forwarding on the attached human hot path.
- No implementation may ship on "bytes can pass" smokes alone; it needs key-to-visible-echo latency
  evidence under output load.
- `aim codex run --tend` remains the user-facing command.
- Existing Tend thread binding, per-thread lock, owned-rollout rotation, and shared-auth posture stay
  intact unless this plan explicitly changes them.

## Durable smoke memory

The pre-fix and post-fix PTY smokes have already been run repeatedly on 2026-05-30. They proved PTY
reachability and controlling-terminal repair, not foreground latency. Do not rerun old smoke loops as
new evidence. New implementation proof must be the latency gate in this plan or a later stricter
replacement.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-05-30
external_research_grounding: not required; internal code, worklog receipts, and local latency RCA are sufficient for this planning pass
deep_dive_pass_2: done 2026-05-30
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

<!-- arch_skill:block:auto_plan_receipts:start -->
{
  "version": 1,
  "digest": "sha256:40fc0786c7c5c75ee4eed48b98cbbfef061f94a1ac026afe69f5925f3095d72d",
  "receipts": [
    {
      "stage": "research",
      "command": "research",
      "status": "complete",
      "started_at": "2026-05-30T23:20:10Z",
      "command_ref_hash": "sha256:5ad5dc9efcb3c7d0d42e1d9014e3ee66fd24b8d2f1c85eef2c5ee96543e05c96",
      "doc_hash_before": "sha256:c739c95c294751e84d502267bcb5f418bf21396f2c974d8d8086e4cb5a016862",
      "completed_at": "2026-05-30T23:20:34Z",
      "doc_hash_after": "sha256:8db8c04e8e6760001d2e4afa91ef2350b347e73abb524e6489f691ef4401382c"
    },
    {
      "stage": "deep-dive-pass-1",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T23:20:42Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:8db8c04e8e6760001d2e4afa91ef2350b347e73abb524e6489f691ef4401382c",
      "completed_at": "2026-05-30T23:21:44Z",
      "doc_hash_after": "sha256:026102c5ddf051d53be154d7e6511cf2c32312216f0dc2c4abe08d164e3f5f4f"
    },
    {
      "stage": "deep-dive-pass-2",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T23:21:59Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:026102c5ddf051d53be154d7e6511cf2c32312216f0dc2c4abe08d164e3f5f4f",
      "completed_at": "2026-05-30T23:22:17Z",
      "doc_hash_after": "sha256:649a3e01e67abc7ee15e17f54fac46dcc6ef4cde27af66de710c4d7c2c004058"
    },
    {
      "stage": "phase-plan",
      "command": "phase-plan",
      "status": "complete",
      "started_at": "2026-05-30T23:22:23Z",
      "command_ref_hash": "sha256:1ce4687beab44819933a8a404a02b8e1345823a7a996f7d651f3dd25a0c54aa3",
      "doc_hash_before": "sha256:649a3e01e67abc7ee15e17f54fac46dcc6ef4cde27af66de710c4d7c2c004058",
      "completed_at": "2026-05-30T23:22:52Z",
      "doc_hash_after": "sha256:480c0270d98e767907ac9584d763848a3f8eaedf87c7fc46ff143de295041f63"
    },
    {
      "stage": "consistency-pass",
      "command": "consistency-pass",
      "status": "complete",
      "started_at": "2026-05-30T23:23:06Z",
      "command_ref_hash": "sha256:439e1ccf2a90587bbec572e8bf46c4e08f16c9c81c75fcf835f736db479d3d74",
      "doc_hash_before": "sha256:480c0270d98e767907ac9584d763848a3f8eaedf87c7fc46ff143de295041f63",
      "completed_at": "2026-05-30T23:23:16Z",
      "doc_hash_after": "sha256:bf804fad43a49cb51274196a5f328a055b0d45490d99738de55e3f20f2df6eb2"
    }
  ]
}
<!-- arch_skill:block:auto_plan_receipts:end -->

<!-- arch_skill:block:implementation_worklog:start -->
# Implementation Worklog

Date: 2026-05-31
Status: implemented locally; required review gates complete; final commit/push pending.

## Implemented surfaces

- Added `src/targets/codex-foreground-relay.py` as the attached foreground relay helper. It owns
  terminal raw mode, PTY child launch with `fork` / `setsid` / `TIOCSCTTY` / fd dup / `execvpe`,
  process-group cleanup, independent input/output pumps, bounded snapshots, goal-intent detection,
  and side-channel command/event handling.
- Added `src/targets/codex-foreground-relay.js` as the Node session adapter. It spawns the helper
  with terminal stdio inherited by default and uses fd 3/4 pipes only for management messages.
- Updated `src/targets/codex-tender.js` so `attach === true` selects
  `createCodexForegroundRelaySession`; `attach === false` keeps `createCodexPtySession`.
- Added `scripts/smoke-codex-foreground-relay-latency.mjs` as the checked-in synthetic
  high-output key-to-visible-echo latency gate.
- Updated focused Tend tests for foreground adapter protocol, real helper protocol, attached vs.
  `--no-attach` runtime selection, and legacy JSON PTY helper scope.
- Updated `src/cli/help.js`, `src/cli/commands/codex.js`, and `README.md` wording so attached Tend
  is described as the foreground relay and `--no-attach` is described as the automation PTY helper.

## Verification receipts

- `node --test test/codex/use-watch.test.js`: PASS, 64 tests.
- `npm run lint`: PASS.
- `npm test`: PASS, 241 tests.
- `node scripts/smoke-codex-foreground-relay-latency.mjs`: PASS with 48 chars at
  130-WPM-equivalent, output frames `240` bytes every `3ms`, visible output bytes `300892`,
  p95 `0.26ms`, max `1.19ms`.
- Real Codex foreground pseudo-terminal smoke: PASS. Helper emitted `ready`; marker
  `aimgr-relay-smoke` appeared in the visible Codex composer stream; relay `send_exit` closed Codex
  with exit code `0`; helper exited `0`.
- Tend resume-prompt side-channel smoke: PASS. `runCodexTender()` attached mode used the real
  foreground relay adapter/helper against a synthetic Codex child, confirmed the resume prompt via
  snapshot plus side-channel Enter, and returned `poll_limit_reached` with `attached: true`.
- Runtime search: PASS. Live Tend routing contains no tmux/app-server launch path; `--remote` and
  `--remote-auth-token-env` remain rejected; `src/targets/codex-tender.js` selects
  foreground relay for attached mode and JSON PTY only for `--no-attach`.
- `npm run install:local`: PASS. `/Users/aelaguiz/.local/bin/aim` points at this checkout and
  `aim --help` now shows foreground-relay wording.

## Review gates before commit

- `$fresh-consult composer-2.5-fast`: PASS with notes, no blockers. Run directory:
  `/tmp/fresh-consult/codex-foreground-relay-final-20260531TvNWGF9`.
- `$thermo-nuclear-code-quality-review`: PASS with notes, no blockers. The review did catch one
  maintainability issue before finalization: relay-specific adapter/helper tests had been added to the
  already-large Tend orchestration case file. That was repaired by moving them to
  `test/codex/foreground-relay.cases.js` and importing them from `test/codex/use-watch.test.js`.
- `$plan-audit` implementation check: PASS, `approve-with-notes`; see
  `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30_PLAN_AUDIT.md`.
<!-- arch_skill:block:implementation_worklog:end -->

<!-- arch_skill:block:implementation_audit:start -->
# Implementation Audit

Date: 2026-05-31
Mode: implementation-audit
Scope: full low-latency foreground relay implementation worktree
Verdict: `approve-with-notes`
Audit log: `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30_PLAN_AUDIT.md`

## Code-Review Result

No blocking implementation findings remain. The code matches the plan's intended split:
attached Tend uses the new foreground relay, `--no-attach` keeps the JSON PTY helper, tmux/app-server
paths are not reintroduced, and the helper/adapter keep foreground terminal bytes off the management
side channel.

## Non-Blocking Notes

- Real Codex foreground smoke is recorded in this worklog rather than checked in as a repeatable
  automation fixture.
- Terminal restore is implemented in helper cleanup paths and covered indirectly; there is no
  dedicated automated failure-path test for every early helper exit shape.
- Bounded snapshot truncation has direct implementation but no dedicated truncation test.
- Foreground helper runtime diagnostic events still use the legacy `pty_helper_error` event name.
<!-- arch_skill:block:implementation_audit:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this implementation, a real attached `aim codex run --tend` session can be typed into at
130-WPM-equivalent bursts while Codex is producing screen updates, without multi-second stalls or
buffered text bursts, and without reintroducing tmux, a Codex app-server, or a Node-mediated terminal
byte stream.

## 0.2 In scope

- Preserve the `aim codex run --tend` CLI contract, including attached default mode, `--no-attach`,
  `--resume <session-id>`, profile selection, pass-through Codex args, preflight watch, restart
  limits, polling, prompt timeout, bind timeout, and workdir handling.
- Add a low-latency foreground relay for attached sessions.
- Preserve the current POSIX controlling-terminal fix: fork, `setsid`, `TIOCSCTTY`, fd 0/1/2 dup,
  and process-group cleanup.
- Give the relay a management side channel for ready, exit, error, resize, goal-intent, snapshot, and
  control-input events.
- Keep raw terminal bytes out of Node for attached sessions.
- Keep `runCodexTender` as the orchestration owner for account preflight, rollout binding,
  per-thread locks, `usageLimited` recovery, resume confirmation, and returned status/events.
- Keep current rollout ownership rules: new sessions bind by
  `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`, `source == "cli"`,
  `thread_source == "user"`, and goal-bearing rollout records; explicit resume owns the supplied
  UUID.
- Keep shared `~/.codex` auth and current Redis/local state posture.
- Add a latency smoke or test harness that measures key-to-visible-echo under synthetic output load.
- Update help, README, and live docs so the current Tend runtime is described as a foreground relay,
  not generic "PTY supervisor" when that phrase hides the old JSON bridge.

## 0.3 Out of scope

- Modifying Codex itself.
- Returning to tmux, even as a fallback.
- Returning to Codex app-server, `--remote`, or a daemon-backed TUI.
- Solving per-tender auth isolation or machine-global credential coordination in this plan.
- Changing the user-facing Tend command shape.
- Supporting Windows terminals in this implementation pass.
- Replacing the whole Tend orchestration loop if the session adapter boundary is sufficient.
- Treating stale old smokes as proof that the new path is usable.

## 0.4 Definition of done (acceptance evidence)

- `npm run lint` passes.
- `npm test` passes.
- Focused tests prove the attached default Tend path uses the foreground relay adapter and does not
  route user stdin/stdout through `CodexPtySession`'s JSON/base64 helper.
- Focused tests prove `--no-attach` keeps a working noninteractive PTY/session path.
- Focused tests prove foreground relay side-channel ready, exit, error, resize, goal-intent,
  snapshot, send-enter, send-exit, terminate, and dispose behavior.
- Existing tests still prove rollout binding, explicit resume, duplicate lock blocking, owned
  `usageLimited` rotation, resume prompt confirmation, and Redis Tend preservation boundaries.
- A local latency gate runs a synthetic high-output child through the new attached relay and proves
  p95 key-to-visible-echo latency is below `50ms` and max latency is below `150ms` for a
  130-WPM-equivalent burst on this machine.
- A real Codex attached smoke proves typed characters render in the composer and `sendExit` can close
  the session through the new relay.
- A real Tend smoke proves rotation close/resume still works without tmux and without app-server.
- Runtime search confirms no attached Tend code path launches tmux, Codex app-server, `--remote`, or
  the JSON PTY helper as the foreground human terminal relay.

## 0.5 Key invariants (fix immediately if violated)

- The attached human hot path is raw terminal bytes, not management frames.
- Management events are side-channel data, not the terminal stream.
- Human input cannot queue behind output serialization in Node.
- Output recording is bounded and diagnostic; it cannot require preserving every intermediate TUI
  byte before the user sees the current screen.
- `runCodexTender` remains the Tend state-machine owner.
- Owned rollout JSONL remains the source of truth for goal state.
- One live Tend owner per thread id.
- No silent runtime fallback to tmux, app-server, or the old JSON relay for attached mode.
- Fail loud if the relay cannot provide its latency or controlling-terminal contract.
- Terminal raw mode and foreground process state must be restored on success, child exit, signal,
  helper error, and forced termination.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Restore human typing/rendering usability for fast attached sessions.
2. Keep AIMGR's current correct ownership model: rollout identity, owned goal status, and per-thread
   locks.
3. Avoid the old failure families: tmux nesting/corruption and app-server/process side paths.
4. Prove latency with measurement, not just a reachability smoke.
5. Keep the implementation small enough to audit: a session adapter and relay helper, not a second
   Tend runtime.
6. Preserve `--no-attach` and unit-test ergonomics.

## 1.2 Constraints

- The repo is a Node ESM CLI targeting Node `>=20`.
- Current dependencies are intentionally small; no native npm PTY dependency is available.
- `node-pty@1.1.0` was previously rejected by local smoke on this machine.
- The current working PTY launch knowledge lives in `src/targets/codex-pty-helper.py`.
- Codex is external; AIMGR can spawn it, set env, read rollout files, and send terminal/control
  input, but cannot change Codex internals.
- The user is sensitive to remote-like latency; 130 WPM typing must feel local.
- The user explicitly rejected app-server and experienced tmux corruption.
- Rollout files can appear only after a goal starts, so binding remains tolerant of first-turn
  latency.
- Shared auth remains machine-global.

## 1.3 Architectural principles (rules we will enforce)

- Split human-plane terminal bytes from manager-plane state/events.
- Keep the attached hot path outside Node's event loop.
- Use independent input and output pumps inside the relay.
- Put goal-intent detection close to the raw input pump and emit only a small side-channel event.
- Keep output snapshots bounded and diagnostic.
- Preserve the existing `runCodexTender` state machine by adapting the session interface, not by
  cloning the orchestration.
- Prove behavior with fakes where possible and with one realistic local latency harness where unit
  fakes cannot prove usability.
- Delete or update stale live truth surfaces in the same implementation pass.

## 1.4 Known tradeoffs (explicit)

- The target relay is intentionally not tmux. It will not preserve detached sessions if AIMGR dies.
  Recovery remains `codex resume <thread-id>`.
- A raw relay is still a supervisor wrapper. It must prove latency before it is accepted as the
  default attached path.
- Keeping the JSON helper for `--no-attach` avoids mixing automation needs with human-latency needs,
  but attached mode must fail if it falls back to that helper.
- The relay may duplicate a small amount of POSIX PTY setup from the existing helper instead of
  creating a Python package abstraction; correctness and auditability matter more than clever reuse.
- The latency gate is local-machine evidence. It should be stable enough to catch regressions, but it
  is not a universal terminal benchmark.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

The current post-cutover Tend path launches Codex through `CodexPtySession` and
`src/targets/codex-pty-helper.py`. The helper creates a child PTY and speaks JSON lines with base64
payloads to Node over stdio. In attached mode, `src/targets/codex-pty.js` puts `process.stdin` in raw
mode, reads user keystrokes in Node, frames them as JSON/base64 input messages, receives JSON/base64
output messages from Python, decodes them, writes them to `process.stdout`, and keeps output
snapshots for orchestration.

## 2.2 What's broken / missing (concrete)

- The controlling-terminal fix made input possible, but the attached path is still too laggy for
  fast human use.
- User-observed symptom: a few words appear, the UI locks for roughly 10 seconds, then buffered text
  bursts onto the screen.
- Local RCA reproduced the same shape with synthetic output load: simulated `75ms` stdout/render
  drain produced about `7930.9ms` total key-to-echo delay.
- The current architecture treats a full-screen TUI byte stream like reliable log data. That makes
  visible input echo depend on output backlog and management serialization.
- The old smoke only proved byte reachability. It did not prove a low-latency foreground contract.

## 2.3 Constraints implied by the problem

- The fix must remove Node JSON/base64 forwarding from the attached human hot path.
- The fix must preserve AIMGR's management duties out of band.
- The fix must be measured under output load.
- The fix must not make tmux or app-server the escape hatch.
- The fix must avoid widening scope into auth isolation, Redis redesign, or Codex changes.

# 3) Research Grounding (external + internal "ground truth")

<!-- arch_skill:block:research_grounding:start -->

## 3.1 External anchors (papers, systems, prior art)

No new web or package research is required for this plan. The failure is already reproduced locally,
the current code path is in this repository, and the selected implementation style stays inside
standard POSIX terminal/PTY behavior already proven by the existing helper.

Relevant prior-art principles carried into the design:

- Terminal UI latency depends on keeping the interactive byte path short. Keystrokes should not
  wait behind management serialization, logging, or lossless replay of stale screen frames.
- A foreground terminal relay should separate raw byte pumps from management/control messages.
- If a wrapper owns a PTY, it must provide a controlling terminal for the child process. The previous
  repair proved `setsid` plus `TIOCSCTTY` is required for real Codex TUI input.
- A terminal stream is not an append-only business log. A bounded screen/output snapshot is useful
  for prompts and diagnostics, but preserving every intermediate TUI byte before rendering is the
  wrong contract for human usability.

## 3.2 Internal ground truth (code as spec)

- [src/targets/codex-pty.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-pty.js) currently owns
  `CodexPtySession`. In attached mode, `attachTerminal()` sets raw mode on `process.stdin`, listens
  for Node `data` events, pushes chunks through `createGoalIntentDetector`, and calls `write(chunk)`.
  `write()` sends JSON with base64 payloads to the Python helper. `handleMessage()` receives
  base64 output frames, appends them to an in-memory output ring, writes them to `process.stdout`,
  and emits output events. This file is the current latency hot path.
- [src/targets/codex-pty-helper.py](/Users/aelaguiz/workspace/aimgr/src/targets/codex-pty-helper.py)
  currently owns POSIX PTY launch. `spawn_pty_child()` uses `pty.openpty()`, `os.fork()`, `os.setsid()`,
  `TIOCSCTTY`, `dup2()`, and `os.execvpe()`. The main loop multiplexes Node stdin and PTY output with
  `select`, parses JSON input frames, writes decoded input to the PTY master, base64-encodes PTY
  output, and synchronously emits JSON output frames to Node stdout.
- [src/targets/codex-tender.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-tender.js) is the
  canonical Tend state-machine owner. `runCodexTender()` normalizes Codex args, preflights account
  selection, mints `originator = aimgr-tend-<runid>`, starts a PTY session, binds the owned rollout,
  acquires the per-thread lock, tails owned goal status, rotates on `usageLimited`, sends the close
  sequence, resumes the same thread, confirms the resume prompt, and returns JSON-shaped status and
  events.
- [src/targets/codex-rollout.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-rollout.js) is the
  source of truth for Tend thread identity and goal state. This plan does not replace it.
- [src/targets/codex-tend-lock.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-tend-lock.js) is
  the source of truth for one live Tend owner per thread id. This plan does not replace it.
- [src/cli/commands/codex.js](/Users/aelaguiz/workspace/aimgr/src/cli/commands/codex.js) passes
  `attach: !opts.noAttach` into `runCodexTenderImpl` and rejects obsolete `--tmux-session`.
- [test/codex/codex-10.cases.js](/Users/aelaguiz/workspace/aimgr/test/codex/codex-10.cases.js) holds
  the focused Codex Tend tests. It already covers CLI wiring, old tmux rejection, rollout binding,
  explicit resume, duplicate locks, usage-limited rotate/resume, helper spawn errors, goal bind
  timeout, generic rate-limit non-rotation, PTY protocol framing, attached stdin relay, resize, raw
  mode restoration, and Redis preservation behavior.
- [package.json](/Users/aelaguiz/workspace/aimgr/package.json) shows the repo is an ESM Node CLI with
  Node `>=20`, lint via `node --check`, tests via `node --test`, and no current native PTY dependency.

Canonical owner path:

- `runCodexTender()` remains the orchestration owner.
- A new attached-session adapter should satisfy the same small session shape that `runCodexTender`
  already consumes: `start`, `waitForReady`, `snapshotOutput`, `sendEnter`, `sendExit`,
  `waitForExit`, `terminate`, `dispose`, and event subscription.
- The existing JSON helper may remain a non-attached adapter. It must not be the default attached
  foreground human relay after this implementation.

Existing evidence to preserve:

- The 2026-05-30 controlling-terminal repair proved that PTY fds alone were insufficient; the child
  must own a controlling terminal.
- The 2026-05-30 real Codex smoke proved typed input can reach Codex after the repair.
- The 2026-05-30 latency RCA proved the current attached path can create multi-second key-to-echo
  delay under output/render drain, matching the user's report.

## 3.3 Decision gaps that must be resolved before implementation

None. The plan chooses a raw foreground relay for attached sessions, preserves the existing JSON PTY
helper only for non-attached automation/tests, keeps `runCodexTender()` as the orchestration owner,
forbids tmux/app-server fallbacks, and makes latency proof a hard acceptance gate.

<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->

## 4.1 On-disk structure

- [src/targets/codex-tender.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-tender.js) is the
  Tend orchestration module. It imports `createCodexPtySession`, rollout helpers, and the
  per-thread lock helper.
- [src/targets/codex-pty.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-pty.js) is both the
  attached terminal relay wrapper and the non-attached PTY automation wrapper. That dual role is the
  architectural pressure point.
- [src/targets/codex-pty-helper.py](/Users/aelaguiz/workspace/aimgr/src/targets/codex-pty-helper.py)
  is the Python POSIX PTY child launcher and JSON/base64 frame bridge.
- [src/targets/codex-rollout.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-rollout.js) owns
  rollout JSONL scanning and goal-state tailing.
- [src/targets/codex-tend-lock.js](/Users/aelaguiz/workspace/aimgr/src/targets/codex-tend-lock.js)
  owns per-thread Tend locks under AIMGR state.
- [src/cli/commands/codex.js](/Users/aelaguiz/workspace/aimgr/src/cli/commands/codex.js) owns CLI
  dispatch for `aim codex run --tend`.
- [src/cli/help.js](/Users/aelaguiz/workspace/aimgr/src/cli/help.js) and
  [README.md](/Users/aelaguiz/workspace/aimgr/README.md) describe the public command.
- [test/codex/codex-10.cases.js](/Users/aelaguiz/workspace/aimgr/test/codex/codex-10.cases.js) is
  the existing test home for this target family.

## 4.2 Control paths (runtime)

Current attached runtime:

```text
terminal keyboard
  -> Node process.stdin data event
  -> CodexPtySession.goalDetector
  -> JSON line input message
  -> base64 payload
  -> Python helper stdin pipe
  -> helper select loop
  -> os.write(PTY master)
  -> Codex TUI
  -> PTY output bytes
  -> helper select loop
  -> base64 payload
  -> JSON line output message
  -> Node helper stdout parser
  -> JSON.parse
  -> base64 decode
  -> output snapshot ring
  -> EventEmitter output event
  -> process.stdout.write
  -> terminal render
```

Current non-attached runtime:

```text
Node runCodexTender / tests
  -> CodexPtySession.write/sendEnter/sendExit
  -> JSON/base64 helper protocol
  -> PTY child
  -> output frames back to Node snapshots
```

Current management runtime:

```text
runCodexTender
  -> optional account preflight
  -> start Codex session
  -> bind new thread from rollout originator or explicit resume id
  -> acquire per-thread lock
  -> tail owned rollout goal status
  -> on usageLimited: rotate shared account, request session exit, resume same thread
  -> confirm native resume prompt from output snapshot
  -> wait for goal active from rollout
```

## 4.3 Object model + key abstractions

- `CodexPtySession`: mixed attached/non-attached session adapter. It owns helper process lifecycle,
  raw-mode entry/restoration, stdin relay, resize relay, output snapshot, helper events, and close
  sequence.
- `codex-pty-helper.py`: process-level helper. It owns child PTY creation, child process group,
  controlling terminal setup, JSON input parsing, base64 output framing, resize, terminate, and exit
  reporting.
- `runCodexTender`: orchestration state machine. It expects a session-shaped object rather than a
  specific helper protocol.
- `createGoalIntentDetector`: JS input detector used only because Node currently sees attached
  human keystrokes.
- Rollout helpers: identity and goal-state source of truth.
- Thread lock helper: duplicate owner guard.

## 4.4 Observability + failure behavior today

- The helper can report `ready`, `output`, `exit`, and `error` frames.
- Node keeps only the last 200 output chunks, but every foreground output chunk must still pass
  through Node before the user sees it.
- If Node's event loop is busy parsing/writing output, user input forwarding waits.
- If Node does not read helper stdout fast enough, the Python helper can block emitting output and
  stop reading new input messages.
- The current tests cover protocol reachability and raw-mode cleanup, but they do not prove human
  key-to-visible-echo latency under output load.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No new visual UI is planned. The user-facing surface is the existing terminal session. Success means
Codex's own TUI feels like a local foreground app while AIMGR supervises quietly.

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->

## 5.1 On-disk structure (future)

Add:

- `src/targets/codex-foreground-relay.py`: raw foreground PTY relay helper for attached sessions.
- `src/targets/codex-foreground-relay.js`: Node adapter that spawns the helper, speaks the small
  management side-channel protocol, and presents the same session shape consumed by
  `runCodexTender`.
- `scripts/smoke-codex-foreground-relay-latency.mjs`: local latency harness for the acceptance gate,
  unless the implementation places the harness under `test/codex/` with equivalent usability.

Update:

- `src/targets/codex-tender.js`: choose the foreground relay session when `attach === true`; keep the
  JSON PTY session for `attach === false`.
- `src/targets/codex-pty.js`: narrow its documented role to non-attached automation and, if useful,
  shared helper functions. It must not be the attached default after the cutover.
- `src/targets/codex-pty-helper.py`: keep as non-attached helper unless fully retired by a proven
  replacement. Do not route attached human terminal bytes through it.
- `test/codex/codex-10.cases.js`: add foreground relay adapter tests and runtime-selection tests.
- `src/cli/help.js`, `README.md`, and live docs: describe the foreground relay and latency gate.

No change expected:

- `src/targets/codex-rollout.js`
- `src/targets/codex-tend-lock.js`
- `src/targets/codex-cli.js`
- Redis credential coordination modules

## 5.2 Control paths (future)

Attached foreground path:

```text
Node AIMGR manager
  -> spawn foreground relay helper with stdio inherited from the real terminal
  -> communicate only over side-channel pipes

foreground relay helper
  -> spawn Codex in a child PTY with controlling terminal
  -> input pump: terminal stdin raw bytes -> PTY master
  -> output pump: PTY master bytes -> terminal stdout
  -> bounded output snapshot ring
  -> side-channel events: ready, exit, error, goal_intent, snapshot response
  -> side-channel commands: send_input, send_enter, send_exit, resize, terminate, snapshot

Codex TUI
  -> reads/writes its PTY normally
```

Management path:

```text
runCodexTender
  -> create session adapter
  -> wait for ready event
  -> bind rollout thread
  -> acquire lock
  -> tail owned goal status
  -> on usageLimited: rotate account
  -> side-channel sendExit
  -> wait for exit
  -> start resume session through the same adapter
  -> side-channel sendEnter when resume prompt snapshot is present
  -> verify active goal through rollout
```

Non-attached path:

```text
runCodexTender --no-attach / tests
  -> current CodexPtySession JSON helper path
  -> no human terminal latency contract
```

The attached relay helper should set terminal raw mode itself, restore it itself, and handle
`SIGWINCH` directly. Node should not need to subscribe to `process.stdin` or `process.stdout` resize
events for attached foreground I/O.

## 5.3 Object model + abstractions (future)

- `CodexForegroundRelaySession`: Node-side adapter with the same public session shape as
  `CodexPtySession`.
- `ForegroundRelayProtocol`: small line-delimited side-channel messages for management only:
  - helper to Node: `ready`, `exit`, `error`, `goal_intent`, `snapshot`, optional diagnostic events.
  - Node to helper: `start` or start config, `send_input`, `send_enter`, `send_exit`, `resize`,
    `snapshot`, `terminate`.
- `ForegroundRelayHelper`: Python helper that owns:
  - PTY allocation and controlling-terminal setup,
  - terminal raw mode and restoration,
  - input pump,
  - output pump,
  - output ring snapshot,
  - side-channel command/event handling,
  - child process-group cleanup.
- `SessionFactory`: the existing `createPtySessionImpl` injection remains useful, but the default
  factory should choose by `attach`:
  - attached: `createCodexForegroundRelaySession`
  - non-attached: `createCodexPtySession`

## 5.4 Invariants and boundaries

- Attached terminal stdin/stdout must be inherited by the foreground relay helper, not piped through
  Node.
- The side channel is for management messages only. It must never carry the live TUI byte stream.
- Input and output pumps are independent. A blocked or slow output write cannot stop stdin reads from
  reaching the PTY master.
- Output snapshots are bounded. The helper can keep enough recent output to identify resume prompts,
  but it must not require lossless forwarding to Node.
- `sendExit()` remains the proven close sequence: `Esc`, `Ctrl+U`, `Ctrl+D`, `Ctrl+D`.
- The relay must fail loud if it cannot enter raw mode, spawn a controlling PTY child, or restore the
  terminal safely.
- Attached fallback to the old JSON helper is forbidden. If the raw relay is not usable, the command
  blocks/fails instead of silently taking the slow path.
- Non-attached behavior may use the old helper because there is no human foreground latency claim.

## 5.5 UI surfaces (ASCII mockups, if UI work)

No new UI. AIMGR should remain quiet while the Codex TUI is foregrounded. Any status output should
stay outside the active TUI path or happen only before launch/after exit.

## 5.6 Second-pass hardening decisions

Relay process ownership:

- The foreground relay helper is the terminal owner while attached Codex is running. Node is the
  manager, not the terminal byte forwarder.
- The helper must restore terminal settings it changes. Restoration belongs in `finally`/signal
  cleanup paths in the helper, not only in Node.
- If the management side channel closes unexpectedly, the helper should terminate the Codex process
  group, restore the terminal, and exit. This avoids the old orphaned-foreground-control class.

Hot-path blocking rules:

- The relay must not send every PTY output chunk to Node. Side-channel events are small and bounded.
- The output pump may maintain a ring buffer for snapshots, but snapshot bookkeeping must not block
  terminal rendering or input forwarding.
- The input pump must write keystrokes to the PTY master before doing optional goal-intent reporting.
  Goal-intent reporting is best-effort management metadata.
- The helper should use independent execution contexts for input and output pumps. A blocking stdout
  write cannot stop stdin reads from reaching Codex.
- Do not drop arbitrary terminal bytes in v1. Escape streams are not safely droppable without a real
  screen model. The v1 bet is to remove artificial Node/JSON backlog and prove it with the latency
  gate. If that gate fails, stop and repair this plan rather than shipping a corrupting coalescer.

Terminal-output hygiene:

- During an attached session, helper diagnostics should go over the side channel. They should not be
  printed into the user's TUI on stdout or stderr except during pre-start fatal failures where Codex
  has not taken the screen.
- Node status JSON belongs after session exit or in `--no-attach`, not interleaved with the TUI.

Side-channel protocol stance:

- The side channel can be JSON lines because it is low-volume management data. That does not violate
  the hot-path rule because terminal bytes do not travel there.
- Snapshot responses should carry bounded text only. They are for prompt confirmation and diagnostics,
  not for replaying the TUI.
- Timed sequences such as `sendExit()` may be implemented in the Node adapter or helper, but the
  bytes must be written by the helper to the child PTY, not by Node to terminal stdio.

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->

## 6.1 Change map (table)

| Surface | Current behavior | Required change | Verification |
| --- | --- | --- | --- |
| `src/targets/codex-tender.js` session creation | Always defaults to `createCodexPtySession` | Use foreground relay for `attach === true`; keep JSON PTY session for `attach === false` | Runtime-selection tests |
| `src/targets/codex-tender.js` orchestration | Consumes session shape already | Preserve state machine; adapt only where side-channel snapshots/ready events differ | Existing Tend flow tests stay green |
| `src/targets/codex-pty.js` | Attached and non-attached JSON/base64 adapter | Stop being attached default; document or structure as non-attached helper | Attached tests prove not selected |
| `src/targets/codex-pty-helper.py` | JSON/base64 PTY helper | Keep for non-attached path or retire only if replaced everywhere | Non-attached tests |
| new `src/targets/codex-foreground-relay.py` | Missing | Add raw relay helper with controlling PTY, raw mode restore, independent pumps, side channel | Helper protocol and latency tests |
| new `src/targets/codex-foreground-relay.js` | Missing | Add Node adapter implementing session shape | Unit tests with fake helper process |
| Goal intent detection | JS detector sees raw stdin in Node | Move attached goal-intent detection into helper or adapter side-channel; keep JS detector for non-attached/fake tests if useful | Goal-intent side-channel tests |
| Resume prompt confirmation | Node snapshots output from JSON frames | Node requests bounded snapshot from foreground relay side channel and sends enter over side channel | Resume-prompt tests |
| Close sequence | Node sends timed writes through JSON helper | Adapter sends same sequence to relay side channel; relay writes bytes to PTY | `sendExit` side-channel test plus real close smoke |
| Resize | Node forwards stdout resize to helper | Relay handles `SIGWINCH`/terminal size directly, with optional side-channel resize for tests | Resize test |
| Latency proof | Old smokes prove reachability only | Add key-to-visible-echo harness under output load | Local smoke output recorded in worklog or implementation notes |
| `src/cli/commands/codex.js` | Passes `attach: !opts.noAttach` | Likely unchanged; only wording if needed | CLI wiring tests |
| `src/cli/help.js` | Says AIMGR PTY supervisor | Update wording to foreground relay if needed | Help snapshot/CLI tests if present |
| `README.md` | Describes current PTY supervisor | Update to explain low-latency foreground relay and `--no-attach` distinction | Doc review |
| Existing old plan/docs | Some now describe JSON PTY supervisor as current | Mark superseded or update current-runtime language | Doc review |
| `package.json` | No native deps | Avoid adding native npm dependency unless the implementation proves it is required and plan is revised | Dependency diff |
| Fleet publish/install | Existing local install flow | After implementation only, run install/publish process separately; not part of planning | Not run in this plan |

## 6.2 Migration notes

- This is a clean attached-runtime cutover. There is no runtime compatibility bridge for attached
  mode.
- Non-attached automation can keep the current JSON helper because it does not expose the user's
  foreground terminal to latency.
- Existing fake session tests should continue to use the session interface rather than depending on
  helper internals.
- The new relay helper should be launched by explicit Python path, mirroring the current helper style,
  to avoid npm native build risk.
- If implementation discovers that Python threads cannot satisfy the latency gate, stop and repair
  the plan. Do not silently fall back to tmux, app-server, or Node JSON relay.

## 6.3 Adjacent-surface disposition

- Rollout identity: unchanged and in scope only for regression tests.
- Per-thread locks: unchanged and in scope only for regression tests.
- Shared auth/Redis credential coordination: unchanged.
- Old tmux/app-server docs: update only where they can mislead current implementation work.
- The prior PTY cutover plan remains historical. This file is the current plan for the latency fix.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

- Session adapter shape is the consolidation point. Do not create a second `runCodexTender` loop.
- PTY child launch knowledge may be copied into the new helper if direct sharing would create a
  fragile Python import story. If copied, tests must cover both helpers' controlling-terminal
  behavior or the old helper must stay scoped to non-attached use.
- Do not add a generic terminal multiplexer abstraction. The only product need here is Codex Tend's
  foreground relay.

## 6.4 Second-pass proof inventory

- Add a fake-helper test proving `CodexForegroundRelaySession` starts with inherited stdio plus
  side-channel pipes, not stdin/stdout pipes used for terminal bytes.
- Add a fake-helper test proving output events are not emitted per foreground output byte unless they
  are explicit side-channel diagnostics.
- Add a helper-level or harness-level test proving side-channel snapshot truncation is bounded.
- Add a local latency harness that drives an outer pseudo-terminal, types a deterministic burst, and
  records key-to-visible-echo timings from the visible output stream.
- Add a failure-path test or smoke proving terminal cleanup if the helper exits early.
- Keep old `CodexPtySession` protocol tests, but rename test descriptions or comments so they are
  clearly non-attached/automation proof, not foreground usability proof.

<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->

## Pre-implementation gates

- Do not implement from this plan unless `arch_stage_gate.py ready` returns `READY next=implement-loop`.
- Do not rerun old controlling-terminal or typed-input smoke loops as a substitute for the new
  latency proof.
- Confirm the worktree state before editing; ignore unrelated `.antigravitycli/` unless the user asks
  for it.
- Keep edits scoped to Tend foreground relay, tests, and truthful docs/help.

## Phase 1 - Build the foreground relay primitive and prove latency before Tend depends on it

Purpose:

Build the smallest raw attached relay that can spawn a PTY child, pass human terminal bytes outside
Node, expose management events through a side channel, and pass the synthetic latency gate.

Work:

Create the new helper and Node adapter first, with a synthetic child and harness. This phase proves
the risky human-plane behavior before modifying the Tend state machine.

Checklist (must all be done):

- Add `src/targets/codex-foreground-relay.py`.
- Add `src/targets/codex-foreground-relay.js`.
- Implement PTY child launch with `fork`, `setsid`, `TIOCSCTTY`, fd 0/1/2 dup, `execvpe`, and
  process-group cleanup.
- Implement helper-owned raw terminal entry and restoration.
- Implement independent input and output pumps.
- Implement bounded output snapshot storage.
- Implement side-channel events for `ready`, `exit`, `error`, `goal_intent`, and `snapshot`.
- Implement side-channel commands for `send_input`, `send_enter`, `send_exit`, `resize`, `snapshot`,
  and `terminate`.
- Ensure helper diagnostics do not print into the active TUI stream.
- Add unit tests for adapter start, ready, exit, error, snapshot, send-enter, send-exit, terminate,
  and dispose behavior using fake helper processes.
- Add helper-level or integration tests for controlling-terminal setup if practical.
- Add `scripts/smoke-codex-foreground-relay-latency.mjs` or an equivalent checked-in local harness.
- Run the latency harness against a synthetic high-output echo child.

Exit criteria (all required):

- The synthetic latency gate reports p95 key-to-visible-echo below `50ms` and max below `150ms` for a
  130-WPM-equivalent burst on this machine.
- The adapter exposes the same session shape that `runCodexTender` needs.
- No attached-terminal byte stream is carried over the side channel.
- If this phase fails the latency gate, stop and repair the plan. Do not wire Tend to an unproven
  relay.

## Phase 2 - Wire attached Tend to the foreground relay while preserving the Tend state machine

Purpose:

Make `aim codex run --tend` use the foreground relay by default for attached sessions while keeping
the existing rollout, lock, rotation, resume, and non-attached behavior intact.

Work:

Adapt the session factory boundary in `runCodexTender()` instead of rewriting the orchestration loop.
The old JSON PTY helper remains available for `--no-attach` and tests unless implementation cleanly
retires it everywhere.

Checklist (must all be done):

- Update `src/targets/codex-tender.js` so attached mode creates `CodexForegroundRelaySession`.
- Preserve `CodexPtySession` or equivalent for `attach === false`.
- Preserve all current `runCodexTender()` returned fields: `runid`, `originator`, `threadId`,
  `rolloutPath`, `attached`, `restarts`, `preflight`, `rotations`, `events`, and status/reason.
- Preserve `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>` for new starts only.
- Preserve explicit resume behavior for supplied session UUIDs.
- Preserve per-thread lock acquisition/release.
- Preserve owned-rollout `usageLimited` rotation only.
- Preserve resume prompt confirmation, now using foreground relay snapshots and side-channel input.
- Preserve the close sequence `Esc`, `Ctrl+U`, `Ctrl+D`, `Ctrl+D`.
- Ensure attached mode fails loud if the foreground relay cannot start; do not silently fall back to
  the JSON helper, tmux, app-server, or `--remote`.
- Keep `--tmux-session` rejection and `--remote` passthrough rejection.
- Add tests proving attached runtime selection uses foreground relay and `--no-attach` uses the
  non-attached path.
- Update existing Tend tests only where the session adapter boundary changed.

Exit criteria (all required):

- Existing rollout binding, resume, duplicate-lock, rotation, prompt, and Redis preservation tests
  still pass.
- New tests prove attached mode does not instantiate the JSON PTY helper by default.
- New tests prove `--no-attach` still works.
- No live Tend code path launches tmux or Codex app-server.

## Phase 3 - Prove real Codex behavior and clean up live truth surfaces

Purpose:

Turn the primitive and Tend wiring into a shippable local cutover with honest docs and realistic
runtime proof.

Work:

Run normal test suites, run the new latency harness, run one real Codex attached smoke, update help
and docs, then install locally. Fleet publish is a separate user-directed step after this plan is
implemented and verified.

Checklist (must all be done):

- Update `src/cli/help.js` wording if it still hides the foreground relay distinction.
- Update `README.md` so `aim codex run --tend` describes the foreground relay and `--no-attach`
  distinction.
- Update this plan/worklog during implementation with actual smoke receipts.
- Update or mark stale docs that still imply the JSON PTY supervisor is sufficient foreground proof.
- Run `npm run lint`.
- Run `npm test`.
- Run focused Codex tests if they are still separate from `npm test`.
- Run the new local latency harness and record p95/max.
- Run a real Codex attached smoke proving typed characters render in the composer through the new
  relay.
- Run a real close smoke proving `sendExit()` closes Codex through the new relay.
- Run a Tend resume/rotation-adjacent smoke sufficient to prove side-channel control still supports
  resume prompt confirmation without tmux/app-server.
- Run a runtime search for tmux/app-server/remote and old JSON-helper attached fallback.
- Run `npm run install:local` only after tests and smokes pass.

Exit criteria (all required):

- Lint and tests pass.
- Local latency gate passes.
- Real Codex attached input and close smokes pass on the new relay.
- Tend management behavior is unchanged except for the attached terminal transport.
- Docs/help no longer present the old JSON PTY bridge as adequate foreground latency proof.
- The installed local `aim` command points at the updated repo.

<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

## 8.1 Unit tests (contracts)

- `CodexForegroundRelaySession` adapter protocol tests with fake helper processes.
- Helper side-channel parsing/serialization tests where feasible.
- Runtime-selection tests in `runCodexTender()`: attached uses foreground relay; non-attached uses
  the automation PTY session.
- Regression tests for existing rollout, lock, resume prompt, rotation, bind timeout, and Redis
  preservation behavior.

## 8.2 Integration tests (flows)

- Synthetic child relay test: high-output stream plus echo of typed bytes.
- Snapshot/request test: helper returns bounded recent output without streaming TUI bytes to Node.
- Failure cleanup test: helper exits or side channel closes, terminal cleanup and child termination
  are attempted.

## 8.3 E2E / device tests (realistic)

- Local latency gate: 130-WPM-equivalent typed burst, p95 below `50ms`, max below `150ms`.
- Real Codex attached typing smoke through the foreground relay.
- Real Codex close smoke through `sendExit()`.
- Real Tend resume/rotation-adjacent smoke without tmux or app-server.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

This is a clean local cutover for attached Tend. Implementation must install locally before fleet
publish.

## 9.2 Telemetry changes

No external telemetry is required. Existing returned Tend status/events should stay useful for tests
and JSON CLI output.

## 9.3 Operational runbook

- If attached Tend shows bursty typing again, run the latency gate before changing orchestration.
- If the foreground relay fails to start, Tend should fail loud instead of silently using tmux,
  app-server, or the old JSON relay in attached mode.
- If rotation/resume breaks, inspect rollout binding and side-channel control events before touching
  terminal relay internals.

## Consistency Pass

<!-- arch_skill:block:consistency_pass:start -->

- Decision-complete: yes
- Unresolved decisions: none
- Decision: proceed to implement? yes
- Scope check: The plan addresses the user's actual failure report: attached Tend can accept input
  after the previous fix, but fast typing still stalls because the foreground terminal path is
  mediated by Node/Python JSON/base64 output and input queues.
- Architecture check: The target keeps AIMGR as manager while removing Node from the attached human
  terminal hot path. The selected owner path is a new foreground relay session adapter plus helper,
  not a second `runCodexTender` loop.
- Compatibility check: Public `aim codex run --tend` remains. `--no-attach` remains. Tmux,
  app-server, `--remote`, and attached fallback to the old JSON relay are forbidden.
- Evidence check: Current repo anchors were inspected for `codex-pty.js`, `codex-pty-helper.py`,
  `codex-tender.js`, CLI wiring, tests, README/help, and package constraints.
- Acceptance check: The plan requires normal lint/tests, existing Tend regression coverage, new
  foreground relay unit tests, a synthetic latency gate, real Codex attached typing/close smokes,
  and a Tend resume/rotation-adjacent smoke.
- Risk check: The plan explicitly handles controlling-terminal setup, terminal raw-mode restoration,
  side-channel closure, bounded snapshots, helper diagnostics, and no arbitrary terminal-byte
  dropping in v1.
- Implementation boundary: No code has been implemented by this auto-plan pass. The next command is
  `$arch-step implement-loop docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md`.

<!-- arch_skill:block:consistency_pass:end -->

# 10) Decision Log (append-only)

## 2026-05-30 - Intent-derived: original worklog request becomes a distinct plan

- Context: The user explicitly asked to turn
  the prior PTY cutover worklog into a full implementation plan using `$arch-step auto-plan` and not
  to implement code.
- Decision: The content was first auto-planned at the user-named worklog path, then renamed to the
  distinct canonical plan path `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md` to avoid
  confusing it with the completed PTY supervisor cutover plan.
- Consequence: This document, at its distinct low-latency foreground-relay path, is the
  implementation plan for the remaining attached-terminal latency fix until it is implemented or
  superseded.

## 2026-05-30 - Intent-derived: North Star is active

- Context: The user did not ask for a new draft; they asked for a full implementation plan after
  approving the high-level architecture direction in conversation.
- Decision: Mark the plan `status: active`.
- Consequence: Auto-plan may proceed through research, deep dive, phase planning, and consistency
  without stopping for another North Star confirmation.

## 2026-05-30 - Prior smoke receipts are historical, not latency proof

- Context: Previous smokes proved helper readiness, controlling terminal repair, real typed input,
  and close behavior. They were also rerun multiple times after compaction.
- Decision: Preserve those receipts as historical evidence but require a new latency gate for this
  implementation.
- Consequence: Do not rerun old smoke loops as evidence for this plan. New proof must measure
  key-to-visible-echo under output load.

# Appendix A) Imported Notes (source material preserved)

The original worklog recorded three source blocks now rehomed into this plan:

- `2026-05-30 - Implementation pass`: the prior cutover added `src/targets/codex-pty-helper.py`,
  `src/targets/codex-pty.js`, `src/targets/codex-rollout.js`,
  `src/targets/codex-tend-lock.js`, removed live tmux/app-server behavior, updated tests/docs, and
  passed lint, focused Codex tests, full `npm test`, PTY smoke, runtime search, and implementation
  review.
- `2026-05-30 - Attached input repair`: root cause was `pty.openpty()` plus
  `subprocess.Popen(..., start_new_session=True)` giving TTY-looking fds without a controlling
  terminal. The fix used `os.fork()`, `os.setsid()`, `TIOCSCTTY`, `dup2()`, `os.execvpe()`, process
  cleanup, and a non-slash `sendExit()` sequence of `Esc`, `Ctrl+U`, `Ctrl+D`, `Ctrl+D`. Real Codex
  attached typing and close smokes passed.
- `2026-05-30 - Attached latency RCA`: the current attached hot path routes keyboard and rendering
  through Node, JSON/base64, Python, PTY, and back. Synthetic output-load measurements reproduced
  multi-second key-to-echo delay, showing this is an architecture problem rather than a typing-speed
  problem. The recommended direction was a human-plane/manager-plane split with no tmux and no
  Codex app-server.

# Appendix B) Conversion Notes

- The old worklog was not deleted for meaning. Its evidence was promoted into the North Star,
  problem statement, acceptance criteria, decision log, and imported notes.
- The file name still ends in `_WORKLOG.md` because the user explicitly named this file as the plan
  artifact for this run.
