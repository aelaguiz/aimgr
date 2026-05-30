---
title: "Codex Tend - PTY Supervisor Cutover - Architecture Plan"
date: 2026-05-30
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [composer-2.5-fast, plan-audit, thermonuclear-code-quality-review]
doc_type: phased_refactor
related:
  - docs/codex-tend-instability-findings-2026-05-30.md
  - docs/codex-tend-multi-instance-plan-2026-05-30.md
  - docs/codex-tend-path-bug-analysis-2026-05-30.md
  - docs/codex-tend-redesign-2026-05-30.md
---

# TL;DR

## Outcome

`aim codex run --tend` becomes an app-server-free, tmux-free foreground supervisor that runs Codex
inside an AIMGR-owned PTY, binds the owned Codex thread from rollout files, rotates accounts only
when that thread's goal reaches `usageLimited`, resumes the same thread id, and restores the user's
terminal cleanly.

## Problem

The current Tend path is unusable under real concurrent use because it stacks fragile layers:
private `codex app-server` processes, `--remote`, loaded-thread-count guessing, shared non-goal
rate-limit triggers, tmux attach lifecycle leaks, and direct `auth.json` overwrites.

## Approach

Delete Tend's private app-server and tmux runtime from the live path. Replace them with three
direct ownership primitives: a PTY child process runner for interactive Codex, a rollout-file
identity/tailer for thread and goal state, and atomic account rotation writes.

## Plan

Phase 1 proves the new PTY + rollout path with focused tests while leaving the CLI contract intact.
Phase 2 cuts the live Tend loop over to the new runtime, removes old app-server/tmux triggers, and
hardens auth writes. Phase 3 deletes stale docs/tests and verifies the installed global command.

## Non-negotiables

- No private Codex app-server or `--remote` in the Tend runtime.
- No tmux dependency, tmux attach, tmux pane driver, or tmux session naming in the Tend runtime.
- No loaded-thread-count discovery.
- No shared active-label or generic pane rate-limit trigger may rotate another healthy thread.
- Shared `~/.codex` auth remains the product posture, but writes must be atomic.
- The user-facing command stays `aim codex run --tend ...`; internal implementation may change.

## Smoke receipt - do not rerun before implementation

The PTY smoke has already been run multiple times on 2026-05-30. Treat Section 3.1 and the
2026-05-30 PTY backend decision log entry as the authoritative pre-implementation smoke receipt.
Do not rerun the smoke again during planning, Composer review, plan-audit, or compaction recovery.
Only rerun a smoke after implementation changes the actual PTY helper/supervisor code or after a
local runtime upgrade changes the PTY backend assumptions.

<!-- arch_skill:block:implementation_audit:start -->
# Implementation Audit (authoritative)
Date: 2026-05-30
Verdict (code): COMPLETE
Manual QA: complete (historical smoke receipts accepted; no PTY helper/supervisor code changed after those receipts in this pass)

## Code blockers (why code is not done)

- None.

## Reopened phases (false-complete fixes)

- None.

## Missing items (code gaps; evidence-anchored; no tables)

- None.

## Evidence checked in this pass

- Stage gate:
  - `arch_stage_gate.py ready --doc docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md` returned `READY next=implement-loop`.
- Code shape:
  - `src/targets/codex-app-server.js` is deleted.
  - `src/targets/codex-tender.js` is `610` lines, below the 1000-line plan threshold.
  - `src/targets/codex-pty.js`, `src/targets/codex-pty-helper.py`, `src/targets/codex-rollout.js`,
    `src/targets/codex-tend-lock.js`, and `src/io/json-store.js` implement the planned PTY,
    rollout, lock, and atomic-write boundaries.
  - `package.json` / `package-lock.json` do not include `node-pty`.
- Runtime side-door search:
  - Live `src/targets` and `src/cli` surfaces contain no tmux launcher, private Codex app-server
    launcher/import, loaded-thread-count discovery, or generic pane/global usage trigger.
  - `--remote` and `--remote-auth-token-env` are rejected for Tend pass-through args.
  - `--tmux-session` is rejected for `aim codex run --tend`.
- Tests and syntax:
  - `python3 -m py_compile src/targets/codex-pty-helper.py` passed.
  - `npm run lint` passed.
  - `node --test test/codex/use-watch.test.js` passed: `58` tests, `58` pass.
  - `npm test` passed: `235` tests, `235` pass.
- Install:
  - `npm run install:local` installed wrappers into `/Users/aelaguiz/.local/bin`.
  - `aim --help` runs from `/Users/aelaguiz/workspace/aimgr/bin/aimgr.js` and shows the current
    `aim codex run --tend` help, including PTY supervisor wording, obsolete `--tmux-session`,
    `--bind-timeout-seconds`, and Tend `--remote` rejection wording.
- Review:
  - Thermo-nuclear code quality review in the companion audit log found no blockers.
  - `$plan-audit` implementation check in the companion audit log returned `approve-with-notes` with
    no blocking plan-code-fit findings.

## Non-blocking follow-ups (manual QA / screenshots / human verification)

- The later attached-latency problem is outside this plan's tmux/app-server cutover scope and is now
  tracked separately in
  `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md`.
<!-- arch_skill:block:implementation_audit:end -->

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-05-30
external_research_grounding: not required; local smoke, package, repo, and Codex-source grounding are recorded in Section 3.1
deep_dive_pass_2: done 2026-05-30
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

<!-- arch_skill:block:auto_plan_receipts:start -->
{
  "version": 1,
  "digest": "sha256:664f46511fd8a9b4aa526be23ab2d0f47b3d5f49ebf01b252e4cd43eaa4807d0",
  "receipts": [
    {
      "stage": "research",
      "command": "research",
      "status": "complete",
      "started_at": "2026-05-30T20:24:12Z",
      "command_ref_hash": "sha256:5ad5dc9efcb3c7d0d42e1d9014e3ee66fd24b8d2f1c85eef2c5ee96543e05c96",
      "doc_hash_before": "sha256:57b00c5b781fa4807f25897ca1d95c12867827c575456140e1332ce6e91707e0",
      "completed_at": "2026-05-30T20:24:47Z",
      "doc_hash_after": "sha256:52c4176c95ee02eaa4d2f5515d9ef9f658a67b19abd8f642233355f59977e5ac"
    },
    {
      "stage": "deep-dive-pass-1",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T20:24:51Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:52c4176c95ee02eaa4d2f5515d9ef9f658a67b19abd8f642233355f59977e5ac",
      "completed_at": "2026-05-30T20:25:50Z",
      "doc_hash_after": "sha256:e5bb45fa7bae46087a1eefca26eebd32dc343171adaddd2dd9872662a214b74d"
    },
    {
      "stage": "deep-dive-pass-2",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T20:25:58Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:e5bb45fa7bae46087a1eefca26eebd32dc343171adaddd2dd9872662a214b74d",
      "completed_at": "2026-05-30T20:26:12Z",
      "doc_hash_after": "sha256:24f6a9f47e291091f7a33dce2c04c112ac7ea193695d23af44981267f4840735"
    },
    {
      "stage": "phase-plan",
      "command": "phase-plan",
      "status": "complete",
      "started_at": "2026-05-30T20:26:22Z",
      "command_ref_hash": "sha256:1ce4687beab44819933a8a404a02b8e1345823a7a996f7d651f3dd25a0c54aa3",
      "doc_hash_before": "sha256:24f6a9f47e291091f7a33dce2c04c112ac7ea193695d23af44981267f4840735",
      "completed_at": "2026-05-30T20:26:56Z",
      "doc_hash_after": "sha256:b245cfe1372c44a1fb1cd8a5535aef69a38b4356d062bd9c729d2b4096ade6f0"
    },
    {
      "stage": "consistency-pass",
      "command": "consistency-pass",
      "status": "complete",
      "started_at": "2026-05-30T20:27:04Z",
      "command_ref_hash": "sha256:439e1ccf2a90587bbec572e8bf46c4e08f16c9c81c75fcf835f736db479d3d74",
      "doc_hash_before": "sha256:b245cfe1372c44a1fb1cd8a5535aef69a38b4356d062bd9c729d2b4096ade6f0",
      "completed_at": "2026-05-30T20:27:36Z",
      "doc_hash_after": "sha256:a6035d32b4b0d5a1c9ef00ee49ac8e41e123f0b2c414201784ade412654f5228"
    }
  ]
}
<!-- arch_skill:block:auto_plan_receipts:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this cutover, a real `aim codex run --tend` invocation can run an interactive Codex TUI
without tmux or a private app-server, bind the correct top-level thread id from Codex rollout
metadata, rotate accounts only for that thread's `usageLimited` goal state, resume the same thread
id, and exit without leaving orphan tmux attach clients or private app-server processes.

## 0.2 In scope

- Preserve the CLI entry point and options for `aim codex run --tend`, including profile selection,
  `--resume <session-id>`, `--no-attach` test/noninteractive mode, pass-through Codex args, preflight
  watch, max restart limits, polling intervals, prompt timeout, and workdir handling.
- Replace Tend's tmux adapter with an AIMGR-owned PTY runtime that relays bytes between the user's
  terminal and Codex when attached.
- Add rollout-file scanning/tailing under `resolveManagedCodexHomeDir({ homeDir, env })/sessions`.
- Use `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>` for new tended sessions.
- Bind a new session only from `session_meta` with matching originator, `thread_source == "user"`,
  `source == "cli"`, and a goal-bearing rollout body.
- In resume mode, treat the supplied UUID as the owned thread and locate its rollout by filename.
- Prevent two live Tend supervisors from tending the same thread id at the same time.
- Rotate only from the owned rollout's `thread_goal_updated` state.
- Confirm Codex's built-in resume prompt through PTY output/input and prove success from rollout
  status, not from screen text alone.
- Make shared Codex auth writes atomic.
- Replace old tests that prove tmux/app-server behavior with disk-backed rollout and PTY adapter
  tests.
- Update or retire live docs that still describe Tend as tmux/app-server backed.

## 0.3 Out of scope

- Modifying Codex itself.
- Introducing a new daemon, background service, app-server client, WebSocket protocol, or headless
  goal-control API.
- Per-tender `CODEX_HOME` or per-tender auth isolation. Shared global Codex auth remains the chosen
  product posture.
- A new user-visible command or alternate Tend mode.
- Supporting Windows terminals in this implementation pass.
- Preserving old tmux sessions created by prior Tend runs.

## 0.4 Definition of done (acceptance evidence)

- `npm run lint` passes.
- `npm test` passes.
- Focused Codex Tend tests prove:
  - PTY runtime launches start/resume commands without tmux.
  - PTY runtime forwards input, output, resize, and termination events through injectable fakes.
  - new-session binding ignores sub-agent rollouts and binds the goal-bearing top-level thread.
  - first-turn latency waits without guessing.
  - bind timeout starts only after explicit goal intent or explicit resume, then fails loudly instead
    of polling forever.
  - `usageLimited -> rotate -> resume -> active` is driven by the owned rollout.
  - concurrent `--resume <same-session-id>` is blocked by a per-thread supervisor lock.
  - shared pane/usage triggers cannot rotate a healthy non-owned thread because those triggers are
    gone or hard-gated to the owned thread.
  - `auth.json` writes are atomic enough that no direct in-place writer remains on the Codex auth
    path.
- A local PTY smoke proves installed `aim codex run --tend --no-attach` and an attached Codex PTY
  session can start and exit cleanly on this machine.
- The global installed `aim`/`aimgr` command points at the updated repo after `npm run install:local`
  or the repo's canonical install script.
- No live Tend code path imports or calls `src/targets/codex-app-server.js` or shells out to tmux.

## 0.5 Key invariants (fix immediately if violated)

- One foreground terminal owner: AIMGR owns the user's terminal; Codex owns only the child PTY.
- Thread state source of truth: Codex rollout JSONL for the owned thread.
- Account state source of truth: existing AIMGR Redis/file state plus shared `~/.codex/auth.json`.
- Rotation trigger source of truth: owned rollout goal status, not global active-label usage.
- Clean cutover: no runtime shim back to tmux or app-server.
- Fail loud when identity cannot bind; never guess by newest file, cwd, or thread count.
- No duplicate Tend owner for one thread id.
- Terminal cleanup is mandatory on normal exit, child exit, signal, exception, and restart.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Restore terminal usability by removing tmux attach/client lifecycle from Tend.
2. Make thread ownership deterministic and per-run.
3. Delete the private app-server path and any unauthenticated loopback/loaded-thread dependency.
4. Preserve the existing `aim codex run --tend` UX while changing internals.
5. Keep proof behavior-level and small; no doc-grep gates or ceremonial harnesses.
6. Keep shared auth as the accepted product posture but make writes atomic.

## 1.2 Constraints

- `aimgr` is a Node ESM CLI with Node `>=20`.
- The new PTY backend requires `python3` on `PATH` or an explicit `AIMGR_PYTHON_BIN`; this is a
  local runtime prerequisite, not an npm dependency.
- Current local runtime is Node `v25.9.0`; the chosen PTY backend must pass a local spawn/render
  smoke here before implementation proceeds. `node-pty@1.1.0` already failed that smoke on this
  machine.
- Codex CLI is external; this repo can pass env/args and read Codex files but cannot change Codex
  internals.
- Codex rollout files materialize after first user input, so new-session binding must tolerate a
  pre-bind window.
- New-session binding is bounded after goal intent, not before the user has asked Codex to start a
  goal.
- Shared `~/.codex/auth.json` is intentionally global.
- Shared-auth concurrent rotation is intentionally not serialized beyond atomic file replacement;
  last writer wins remains the accepted machine-global account posture.
- The implementation must not kill existing user tmux sessions as part of normal operation.

## 1.3 Architectural principles (rules we will enforce)

- Prefer direct PTY process ownership over terminal multiplexers.
- Prefer Codex's existing rollout files over a new API or server.
- Prefer small focused modules over growing `src/targets/codex-tender.js` past 1000 lines.
- Keep lifecycle state explicit: child process, PTY, owned thread, rollout tail offset, restart
  count, and current recovery action.
- Keep fakes behavior-shaped: tests should fail when the wrong thread rotates or a PTY lifecycle
  action is skipped.
- Delete retired paths from live code; Git is the archive.

## 1.4 Known tradeoffs (explicit)

- A foreground PTY supervisor will not preserve an interactive TUI if the AIMGR parent dies. The
  accepted recovery path is a later `codex resume <T>`, not a detached tmux session.
- A repo-owned POSIX PTY helper is the chosen PTY backend. Node remains the orchestrator; the helper
  owns only PTY allocation, byte relay, resize, and child termination. If `python3` is unavailable
  or the helper smoke fails on this machine, stop and repair the plan instead of adding a second
  runtime branch.
- `--no-attach` remains for tests/automation, but the production UX is attached foreground Tend.
- `--bind-timeout-seconds` is allowed as a narrow Tend safety knob. It bounds identity/goal binding
  after a goal has actually been requested; it is not a new runtime mode.
- Pane text remains only a prompt cue for resume confirmation; it is not an authoritative trigger.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

`runCodexTender` starts a private Codex app-server, launches Codex in tmux with `--remote`, discovers
the thread by counting loaded app-server threads, reads goal state through that server, watches
generic pane/global-usage rate-limit signals, rotates the shared Codex account, sends `/exit` to
tmux, then starts another tmux session for `codex resume <threadId>`.

## 2.2 What's broken / missing (concrete)

- Private app-servers accumulate and compete with the normal Codex remote-control daemon.
- `thread/loaded/list` is not a stable "my thread" API because sub-agents are loaded too.
- Tmux attach processes can survive the AIMGR parent and keep controlling a terminal.
- Recovery can attach again even if the previous attach process did not finish.
- Generic pane/global usage triggers are shared across tenders and can rotate the wrong active
  thread.
- `auth.json` writes are direct overwrites.
- Tests mostly prove the old tmux/app-server behavior and therefore protect the wrong architecture.

## 2.3 Constraints implied by the problem

- The new runtime must remove tmux from the core control path, not just make tmux names unique.
- The new state reader must be file-backed and owned by thread id.
- The implementation must preserve interactive Codex rendering by using a real PTY, not ordinary
  subprocess pipes.
- Restart/resume must be exact-thread by UUID and verified from rollout state.

# 3) Research Grounding (external + internal "ground truth")

<!-- arch_skill:block:research_grounding:start -->
## 3.1 External anchors (papers, systems, prior art)

- POSIX pseudoterminals - adopt. A PTY is the right boundary for a terminal UI because Codex sees
  an actual tty device, not ordinary stdout pipes. Local smoke validated this on 2026-05-30:
  a fake full-screen TUI saw `stdin/stdout/stderr` as TTYs, observed the configured `100x40`
  window, received exact bytes `68656c6c6f1b5b410d`, and preserved alternate-screen enter/exit
  control bytes. A second smoke launched the real `/Users/aelaguiz/.local/bin/codex`
  (`codex-cli 0.136.0-alpha.1`) under a PTY, captured terminal-control output, and stopped the
  process cleanly.
- `node-pty` package - reject for this repo on the current machine. `npm install --prefix
  /tmp/aimgr-node-pty-smoke node-pty@1.1.0` succeeded, but `pty.spawn('/bin/sh', ...)` failed with
  `Error: posix_spawnp failed` under Node `v25.9.0`. Do not add this dependency unless a future
  smoke proves it can spawn a child on the target runtime.
- `@homebridge/node-pty-prebuilt-multiarch` - reject for this repo. `npm view` shows engine
  `>=18.0.0 <25.0.0`, while this machine is on Node `v25.9.0`.
- `node-pty-prebuilt-multiarch` - reject. The published version is `0.10.1-pre.5`, older and less
  attractive than the maintained package, and it does not address the local native PTY spawn
  failure.
- Python `pty` helper - adopt as the production PTY backend for this repo. Keep orchestration in
  Node, but use a small repo-owned helper process with Python 3 stdlib `pty`/`select`/`ioctl` to
  allocate the child PTY, relay bytes, apply resizes, and report exit status. This avoids a native
  Node addon while keeping exactly one live PTY implementation path.

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors (do not reinvent):
  - `src/cli/commands/codex.js` - `handleCodex` owns `aim codex run --tend` option handoff and must
    keep passing Redis/file state runtime, home, env, workdir, profile, resume id, Codex args,
    attach flag, thresholds, poll interval, prompt timeout, and restart limit.
  - `src/targets/codex-tender.js` - current owner of Tend orchestration, profile normalization,
    resume id validation, preflight watch, rotation, app-server lifecycle, tmux lifecycle, goal
    polling, and prompt confirmation. This file is already 975 lines; the cutover must extract
    focused modules instead of growing it into a PTY/rollout monolith.
  - `src/targets/codex-cli.js` - account activation and rotation write the shared Codex auth file
    and active label. Keep this owner path for account rotation.
  - `src/io/json-store.js` - current JSON write helpers directly overwrite files. This is the
    canonical place to add atomic write support used by Codex auth activation.
  - `src/io/paths.js` - `resolveManagedCodexHomeDir({ homeDir, env })` is the canonical Codex home
    resolver; rollout scanning must use it instead of hardcoded `~/.codex`.
  - `test/codex/codex-10.cases.js` - current Tend coverage, but it encodes tmux/app-server
    behavior and must be rewritten around PTY/rollout fakes.
- Codex source anchors:
  - `/Users/aelaguiz/workspace/codex/codex-rs/login/src/auth/default_client.rs:57-61` - Codex reads
    `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` before using the default originator.
  - `/Users/aelaguiz/workspace/codex/codex-rs/rollout/src/recorder.rs:673-684` - rollout
    `session_meta` writes id, originator, source, and thread source.
  - `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/app_server_session.rs:1365-1385` - top-level
    TUI starts with `thread_source: Some(ThreadSource::User)`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/src/codex_delegate.rs:77-91` - sub-agents use
    `thread_source: Some(ThreadSource::Subagent)`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/lib.rs:1474-1488` - `codex resume <id>` fails
    loudly when the exact id is not found.
  - `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/app/thread_goal_actions.rs:51-78` - resumed
    paused/blocked/usage-limited goals show the built-in resume prompt.
- Canonical path / owner to reuse:
  - Keep `runCodexTender` as the public orchestration function, but split implementation helpers
    into focused modules:
    - `src/targets/codex-pty.js` for PTY child lifecycle and terminal relay.
    - `src/targets/codex-rollout.js` for rollout discovery, parsing, and tailing.
    - keep account rotation in `src/targets/codex-cli.js` and `runCodexTender`.
  - Keep `handleCodex` as the CLI entry point. Remove tmux-specific option handoff when no longer
    used.
- Adjacent surfaces tied to the same contract family:
  - `README.md` target projection command list must stay truthful about `aim codex run --tend`.
  - `docs/codex-overnight-account-rotation-proposals-2026-05-23.md` describes the old tmux/app-server
    implementation and currently reads like a live operator guide. It must be retired or clearly
    marked historical by Phase 3.
  - `docs/codex-tend-multi-instance-plan-2026-05-30.md` is superseded by this plan because it keeps
    tmux as the runtime.
  - `docs/codex-tend-redesign-2026-05-30.md` contains stale `thread_source` absent claims and
    tmux-driver language; either supersede it clearly or update it to point here.
  - `docs/codex-tend-instability-findings-2026-05-30.md` remains evidence and does not become the
    execution checklist.
- Compatibility posture (separate from `fallback_policy`):
  - Preserve the user-facing CLI contract for `aim codex run --tend` where possible.
  - Clean cutover internally from tmux/app-server to PTY/rollout; no runtime bridge or fallback.
  - Retire `--tmux-session` as a live option for Tend. Because the runtime has no tmux session,
    passing it should fail loudly with a clear message rather than silently doing nothing.
  - Add `--bind-timeout-seconds <sec>` as the explicit bound for post-goal thread binding and
    explicit-resume rollout resolution. Default: `120`.
- Existing patterns to reuse:
  - Dependency injection in `runCodexTender` tests: continue injecting runtime/tailer/sleep/rotation
    fakes instead of requiring live Codex for unit tests.
  - Redis/file state runtime abstraction in `handleCodex`: preserve it exactly.
  - Status/event arrays returned from `runCodexTender`: keep them for JSON CLI reporting and tests,
    but remove tmux-shaped `sessionName` from new Tend status payloads. Return `runid`,
    `originator`, `threadId`, `rolloutPath`, `attached`, `restarts`, `rotations`, `events`, and
    `reason` instead. Tests should not preserve `sessionName` as a compatibility field because the
    runtime no longer has a tmux session concept.
  - `writeJsonFileIfChanged` readback pattern in `applyCodexCliFromState`: preserve readback, change
    write mechanics.
- Prompt surfaces / agent contract to reuse:
  - Not a prompt-repair problem. Codex's TUI remains responsible for agent behavior; AIMGR only
    supervises terminal/process/account state.
- Native model or agent capabilities to lean on:
  - Codex native TUI rendering, resume prompt, and rollout persistence. AIMGR should not create a
    deterministic replacement for Codex goal control.
- Existing grounding / tool / file exposure:
  - `~/.codex/sessions/**/rollout-*.jsonl` carries the thread identity and goal lifecycle events
    AIMGR needs.
- Duplicate or drifting paths relevant to this change:
  - `src/targets/codex-app-server.js` remains useful only if other commands use it; it must be
    removed from the Tend path.
  - tmux helpers in `src/targets/codex-tender.js` become dead live truth and should be deleted from
    that path.
  - tests asserting `--remote` become negative guidance and must be rewritten.
- Capability-first opportunities before new tooling:
  - Use Codex rollout files and Codex's own TUI prompt rather than a new app-server or goal API.
  - Use PTY wrapping only to preserve native terminal interaction; it augments Codex instead of
    replacing Codex behavior.
- Behavior-preservation signals already available:
  - `npm run lint`
  - `npm test`
  - existing `test/codex/codex-10.cases.js` for CLI/profile/resume/preflight/rotation semantics,
    after its runtime fakes are changed.
  - local PTY smoke from `docs/codex-tend-instability-findings-2026-05-30.md`.

## 3.3 Decision gaps that must be resolved before implementation

- none

## 3.4 Composer 2.5 Fast plan-review repairs

- Fresh Composer 2.5 Fast reviewed this plan on 2026-05-30 and returned `pass-with-notes` with no
  blocking findings.
- Accepted repairs folded into this artifact:
  - bind timeout is now explicit: `--bind-timeout-seconds`, default `120`;
  - goal-bearing rollout selection is specified in Section 5.4.2;
  - `src/cli/help.js` is included in the call-site audit;
  - duplicate `--resume <same-thread-id>` is handled by a per-thread lock;
  - pre-implementation and post-implementation review gates are separated.
<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->
## 4.1 On-disk structure

- `src/targets/codex-tender.js` is the live Tend runtime. It owns profile parsing, resume-id
  validation, command string construction, tmux adapter, app-server adapter, loaded-thread
  discovery, goal reads, pane/global usage rate-limit detection, account rotation, prompt
  confirmation, restart loop, and returned status/events.
- `src/targets/codex-app-server.js` starts a private `codex app-server --listen
  ws://127.0.0.1:<port> --enable goals`, provides JSON-RPC client helpers, and is imported by
  `codex-tender.js`.
- `src/targets/codex-cli.js` owns activation of the shared Codex account into the managed Codex
  home and records the active label/account state.
- `src/io/json-store.js` owns JSON write helpers used by Codex activation and other credential
  projections.
- `src/cli/args.js` still parses `--tmux-session`; `src/cli/commands/codex.js` forwards it as
  `sessionName`.
- `test/codex/codex-10.cases.js` is the primary Tend test file and contains fake tmux and fake
  private app-server helpers.
- `README.md` lists the public `aim codex run --tend` command.

## 4.2 Control paths (runtime)

Current new-session path:

1. `handleCodex` validates `codex run --tend` and calls `runCodexTender`.
2. `runCodexTender` optionally preserves live auth and preflights account selection.
3. `startCurrentAppServer()` starts a private app-server or adapts an injected fake.
4. `tmux.newSession()` runs a command from `buildCodexCommand()`.
5. `buildCodexCommand()` always includes `--no-alt-screen` and includes `--remote <private ws>`
   whenever `remoteUrl` exists.
6. If attached, `tmux.attach()` starts `tmux attach-session -t <session>` with inherited stdio.
7. The poll loop calls `discoverOwnedThreadId()` until `threadId` exists.
8. `discoverOwnedThreadId()` binds only when `thread/loaded/list` returns exactly one id.
9. Goal state is read from app-server `getThreadGoal`.
10. Recovery can trigger from owned goal state, pane rate-limit text, or global active-label usage.
11. Recovery rotates the shared Codex account, asks tmux to `/exit`, waits briefly, restarts
    private app-server, starts a new tmux session with `codex resume <threadId>`, reattaches, and
    confirms the resume prompt by tmux pane scraping.

Current explicit-resume path skips loaded-thread discovery but still uses private app-server,
`--remote`, and tmux.

## 4.3 Object model + key abstractions

- `threadId`: null until loaded-thread discovery succeeds, except explicit resume.
- `sessionName`: tmux session namespace, either caller-provided `--tmux-session` or timestamp-based.
- `appServer`: private server object with `remoteUrl`, `client`, and `stop`.
- `tmux`: adapter with `newSession`, `hasSession`, `capturePane`, `sendEnter`, `sendExit`,
  `killSession`, and `attach`.
- `recoveryTrigger`: ad-hoc object from goal, pane, or usage source.
- `events`: local status stream returned to CLI JSON.

## 4.4 Observability + failure behavior today

- Ambiguous loaded threads block as `ambiguous_loaded_threads`, sometimes leaving app-server alive
  for a live tmux session.
- If a tmux attach process remains active after exit timeout, the event is recorded but recovery
  still continues.
- Private app-server failures surface as thrown errors or app-server lifecycle events.
- Pane/global rate-limit triggers can rotate non-goal sessions and can fire for shared state that
  does not belong to the current thread.
- The user-facing terminal can be left with orphaned tmux attach clients.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No AIMGR visual UI is introduced. The UI is Codex's native TUI rendered inside a child PTY:

```text
user terminal <-> AIMGR PTY relay <-> child PTY <-> codex TUI
```
<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->
## 5.1 On-disk structure (future)

- `src/targets/codex-tender.js` remains the public Tend orchestrator but shrinks into high-level
  state transitions and dependency injection.
- `src/targets/codex-pty.js` owns PTY process lifecycle:
  - spawn Codex inside a PTY
  - optionally relay the user's terminal to the PTY
  - write input such as `/exit`, Enter, and prompt confirmation
  - expose output snapshots/recent buffer for prompt cue matching
  - resize PTY on `SIGWINCH`
  - terminate child process group and restore terminal state
- `src/targets/codex-rollout.js` owns rollout-file behavior:
  - scan `sessions/**/rollout-*.jsonl`
  - parse complete JSONL lines only
  - read `session_meta`
  - match run originator + `thread_source == "user"` + `source == "cli"`
  - select the goal-bearing top-level rollout
  - resolve explicit resume rollout by filename suffix
  - tail owned rollout for `thread_goal_updated` status changes
- `src/io/json-store.js` gains atomic text/JSON replacement and Codex auth activation uses it.
- `test/codex/codex-10.cases.js` keeps CLI/orchestration coverage but uses fake PTY and temp
  rollout fixtures instead of fake tmux/app-server.
- A focused PTY test file may be added if keeping everything in `codex-10.cases.js` becomes too
  large.

## 5.2 Control paths (future)

New-session attached path:

1. `handleCodex` calls `runCodexTender` with the same public options, except `--tmux-session` is
   rejected as obsolete.
2. `runCodexTender` performs existing preflight auth/account watch.
3. `runCodexTender` mints `runid = <pid>-<random>` and originator
   `aimgr-tend-<runid>`.
4. PTY runtime starts plain Codex:
   `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid> codex --no-alt-screen [-p profile] ...`
   without `--remote`.
5. If `attach` is true, the PTY runtime relays terminal bytes between the user terminal and Codex.
   If `attach` is false, it starts Codex in a PTY but does not attach stdin/stdout; tests can drive
   input through the runtime API.
6. The PTY runtime records goal intent when the submitted input line starts with `/goal`; before
   goal intent, Tend relays the TUI but does not start recovery or fail binding.
7. After goal intent, the rollout resolver watches the managed Codex home for the matching
   top-level, goal-bearing rollout and binds `threadId` within `bindTimeoutSeconds`.
8. After binding, Tend acquires the per-thread owner lock.
9. The owned rollout tailer watches `thread_goal_updated` events for that `threadId`.
10. On `usageLimited`, Tend rotates the shared account, sends `/exit` to the child PTY, terminates if
   needed, starts `codex --no-alt-screen [-p profile] resume <threadId>` in a new child PTY, confirms
   the built-in prompt by output cue + Enter, then verifies the owned rollout returns to `active`.
11. On complete/ended child with no recovery trigger, Tend exits, releases the owner lock, and
    restores terminal state.

Explicit resume path:

1. Validate the UUID exactly as today.
2. Set `threadId` from the supplied id.
3. Acquire the per-thread owner lock before launching Codex; fail loud if another live Tend owns the
   same thread id.
4. Resolve the rollout path by scanning for filename ending `-<threadId>.jsonl`; if no filename
   match exists, fall back to complete-line `session_meta.id == threadId` scanning before reporting
   not found. Wait up to `bindTimeoutSeconds` because old sessions may have delayed filesystem
   visibility, but never guess another id.
5. Start `codex --no-alt-screen [-p profile] resume <threadId>` in the PTY runtime.
6. Confirm prompt if visible and tail the owned rollout for status.
7. Tend only resumes goal-bearing threads. If the rollout exists but no goal-bearing event appears
   within `bindTimeoutSeconds`, block with reason `goal_bind_timeout` rather than falling back to
   pane/global usage triggers.

## 5.3 Object model + abstractions (future)

- `CodexPtySession`:
  - `start({ mode, threadId, codexBin, codexProfile, codexArgs, cwd, env })`
  - `write(data)`
  - `sendExit()`
  - `sendEnter()`
  - `snapshotOutput()`
  - `waitForExit({ timeoutMs })`
  - `terminate()`
  - `dispose()`
- `CodexRolloutResolver` pure functions:
  - `readRolloutMeta(filePath)`
  - `readCompleteJsonlRecords(filePath, { offset })`
  - `findTaggedGoalRollouts({ sessionsDir, originator, startedAtMs })`
  - `resolveOwnedThreadFromRunTag(...)`
  - `resolveRolloutForThreadId(...)`
  - `tailGoalStatus(...)`
- `TenderState` in `runCodexTender`:
  - `runid`
  - `originator`
  - `threadId`
  - `rolloutPath`
  - `goalStatus`
  - `restarts`
  - `childSession`
  - `events`
  - `rotations`

## 5.4 Invariants and boundaries

- PTY runtime is the only terminal/process boundary for Codex TUI. It must not know account
  rotation rules.
- Rollout module is the only thread/goal state reader. It must not spawn Codex, rotate accounts, or
  scrape terminal output.
- `runCodexTender` is the only place that sequences preflight, launch, bind, watch, rotate, resume,
  and final status.
- `codex-cli.js` remains the only owner of shared Codex account activation.
- Atomic JSON writes are implemented once in `json-store.js` and reused by Codex auth activation.
- No fallback to app-server or tmux is permitted by config or runtime branch.
- Pane/PTY output may cue resume prompt confirmation, but the owned rollout is the authoritative
  proof of goal status.

### 5.4.1 Second-pass hardening decisions

- PTY implementation choice is fixed for this plan: use a repo-owned POSIX PTY helper driven by
  `src/targets/codex-pty.js`. The Node module must spawn the helper, pass command/env/cwd/size,
  send input bytes and resize control messages, receive raw output bytes and exit status, and own
  disposal. Do not add `node-pty`, a second helper, tmux, or a hidden runtime alternative.
- Helper location and invocation:
  - helper path is `src/targets/codex-pty-helper.py`;
  - `src/targets/codex-pty.js` resolves it with `new URL("./codex-pty-helper.py", import.meta.url)`;
  - Python executable is `env.AIMGR_PYTHON_BIN || "python3"`;
  - if Python spawn fails with `ENOENT`, Tend blocks with reason `python3_unavailable` and a message
    naming `AIMGR_PYTHON_BIN`;
  - the local install wrapper points at the repo checkout, so the helper is shipped by being present
    in the checkout rather than bundled by npm.
- Helper protocol:
  - Node and the helper speak newline-delimited JSON over helper stdin/stdout; no raw TUI bytes are
    written directly on helper stdout;
  - Node's first message is
    `{ "type": "start", "argv": [...], "cwd": "...", "env": { ... }, "cols": 120, "rows": 40 }`;
  - Node forwards user input as `{ "type": "input", "data": "<base64 bytes>" }`;
  - Node forwards resize as `{ "type": "resize", "cols": <int>, "rows": <int> }`;
  - Node asks for graceful termination as `{ "type": "terminate" }`, then kills the helper process
    if the child does not exit before `exitTimeoutSeconds`;
  - helper sends readiness as `{ "type": "ready", "pid": <child pid|null> }` after child spawn and
    initial PTY sizing succeed;
  - helper sends child output as `{ "type": "output", "data": "<base64 bytes>" }`;
  - helper sends completion as `{ "type": "exit", "exitCode": <number|null>, "signal": <string|null> }`;
  - helper sends protocol/setup failures as `{ "type": "error", "reason": "...", "message": "..." }`;
  - helper stderr is reserved for helper diagnostics and is included in blocked/error evidence, not
    mixed into Codex TUI output.
- Helper PTY responsibilities:
  - allocate one POSIX PTY for the Codex child;
  - apply the initial window size before or immediately after child spawn;
  - run the exact Codex argv without a shell wrapper;
  - pass the requested cwd and environment, including `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`;
  - relay PTY master bytes to output frames and input frames to the PTY master;
  - apply resize messages via `TIOCSWINSZ`;
  - report child exit exactly once and then exit the helper;
  - on helper stdin close, terminate the child best-effort and exit.
- Signal behavior:
  - `SIGWINCH` sends a resize frame;
  - raw-mode Ctrl-C from the user's terminal is relayed as bytes to Codex;
  - parent `SIGINT`, `SIGTERM`, and `SIGHUP` call `dispose()`, restore the parent terminal, release
    any owner lock, terminate the child/helper, and then fail loud or exit.
- Attached-mode Node TTY ownership:
  - enter raw mode only when `process.stdin.isTTY` is true and `attach` is true;
  - save the prior raw-mode/read state before calling `process.stdin.setRawMode(true)` and
    `process.stdin.resume()`;
  - relay stdin `data` buffers to helper `input` frames and helper `output` frames to
    `process.stdout.write(...)`;
  - use `process.stdout.columns`/`rows` for initial size and `resize` events for updates;
  - restore the prior stdin mode and remove listeners in the same idempotent `dispose()` path used
    for child exit, restart, thrown errors, and parent signals.
- Timeout defaults:
  - `exitTimeoutSeconds` default remains `15`, matching the existing Tend exit timeout option;
  - `promptTimeoutSeconds` remains separate and continues to bound resume-prompt confirmation.
- The live Tend path must not contain an option, environment variable, or hidden branch that
  re-enables tmux or private app-server operation.
- The PTY adapter owns terminal restoration with a single `dispose()` path that is called from
  normal child exit, restart, thrown errors, and process signal handlers.
- Rollout binding must not begin recovery until a thread id is owned. If binding times out, the
  status is blocked with originator, Codex home, and sessions directory evidence.
- Output scraping is intentionally narrow: only prompt confirmation cues (`Resume paused goal?`,
  `Resume goal`, and active/achieved text) are read from the PTY buffer. Rate-limit detection is not
  driven from generic output text.

### 5.4.2 Binding, ambiguity, timeout, and ownership-lock rules

- Run id:
  - mint `runid` as `pid` plus random hex;
  - originator is exactly `aimgr-tend-<runid>`.
- Sessions directory:
  - `path.join(resolveManagedCodexHomeDir({ homeDir, env }), "sessions")`.
- New-session candidate scan:
  - consider only files named like `rollout-*.jsonl`;
  - prefer files with `mtimeMs >= startedAtMs - 1000`, but still inspect older files with matching
    originator if filesystem timestamp precision is coarse;
  - read only complete newline-terminated JSONL records and ignore the final partial line.
- Top-level candidate:
  - first complete record must be `type == "session_meta"`;
  - `payload.originator == originator`;
  - `payload.thread_source == "user"`;
  - `payload.source == "cli"`;
  - `payload.id` must be a UUID and becomes the candidate thread id.
- Goal-bearing candidate:
  - the rollout body contains a complete record where `type == "event_msg"` and
    `payload.type == "thread_goal_updated"` with `payload.goal`, or any future `thread_goal_*`
    event carrying a `payload.goal` object;
  - if the event carries `threadId` or `thread_id`, it must match the candidate thread id.
- Binding result:
  - zero goal-bearing candidates before goal intent: keep relaying the TUI and report
    `waiting_for_goal` events only;
  - zero goal-bearing candidates after goal intent for longer than `bindTimeoutSeconds`: block with
    reason `goal_bind_timeout`;
  - one goal-bearing candidate: bind that `threadId`, store its rollout path, and acquire the
    per-thread owner lock;
  - more than one goal-bearing candidate for the same originator: block with reason
    `ambiguous_tagged_goal_rollouts` and list candidate ids.
- Goal intent:
  - attached mode observes only bytes read from the user's stdin before forwarding them to Codex;
  - the detector keeps a small pre-submit line buffer, applies backspace/delete, splits pasted input
    on CR/LF, ignores escape/control sequences for intent purposes, and never reads Codex output;
  - when a submitted line begins with optional ASCII whitespace followed by `/goal` and then end of
    line or ASCII whitespace, emit one `goal_intent_observed` event and start the bind timeout;
  - the detector is best-effort only for starting the timeout; rollout `thread_goal_*` events remain
    the authoritative proof that a goal exists;
  - non-attached tests may inject goal intent;
  - explicit resume is already goal/thread intent and uses the same timeout for rollout resolution.
- Timeout:
  - `bindTimeoutSeconds` default is `120`;
  - values must be positive finite numbers;
  - timeout starts at goal intent for new sessions and at process start for explicit resume rollout
    resolution;
  - `maxPollIterations` may still bound tests, but production binding must not rely on an infinite
    poll loop for failure behavior.
- Per-thread owner lock:
  - once a thread id is known, acquire an exclusive lock under the AIMGR local adjunct area, e.g.
    `<home>/.aimgr/codex-tend-locks/<threadId>.json`;
  - create with exclusive open/write semantics;
  - payload includes pid, originator/runid, cwd, startedAt, and command mode;
  - if the lock exists and its pid is alive, block with reason `thread_already_tended`;
  - if the lock exists and its pid is not alive, reclaim it and record a stale-lock event;
  - release on normal exit and best-effort release during dispose/signal cleanup.

## 5.5 UI surfaces (ASCII mockups, if UI work)

Attached mode:

```text
real terminal
  |
  | raw bytes, resize, signals
  v
AIMGR foreground supervisor
  |
  | PTY bytes
  v
codex TUI child process
```

Restart mode keeps the real terminal attached to AIMGR while the child PTY is replaced:

```text
usageLimited(T) -> rotate shared auth -> stop child -> start `codex resume T` -> Enter prompt
```
<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->
## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| CLI args | `src/cli/args.js` | `--tmux-session` | Parsed for Tend | Reject as obsolete for `codex run --tend` or remove parse if no other command uses it | No tmux runtime remains | Passing `--tmux-session` fails loudly | CLI wiring test |
| CLI args | `src/cli/args.js` | bind timeout option | No bind-specific timeout | Add `--bind-timeout-seconds <sec>` with default `120` | Prevent unbounded post-goal bind waits | positive finite seconds | CLI/validation tests |
| CLI command | `src/cli/commands/codex.js` | `handleCodex` | Forwards `sessionName: opts.tmuxSession` | Stop forwarding tmux session; surface obsolete option error | Prevent silent no-op/stale UX | Public Tend options exclude tmux | CLI tests |
| CLI help | `src/cli/help.js` | Tend help text | Says Codex TUI runs under tmux and lists `--tmux-session`/tmux workdir text | Update for PTY supervisor, bind timeout, no tmux option | Help is a live user contract | help text matches runtime | help/docs review |
| Tender command | `src/targets/codex-tender.js` | `buildCodexCommand` | Builds shell string with `--remote` | Build argv/env for PTY start/resume without `--remote` | PTY spawn should not shell-quote command string | Structured child process launch | Command construction tests |
| Tender runtime | `src/targets/codex-tender.js` | `createTmuxAdapter` and tmux calls | Drives tmux sessions/panes/attach | Delete from Tend path; replace with PTY helper runtime | Removes terminal corruption class | `CodexPtySession` dependency | PTY fake tests |
| App-server | `src/targets/codex-tender.js` | `startCurrentAppServer`, `stopCurrentAppServer`, `adaptLegacyAppServerClient` | Starts/uses private app-server | Delete from Tend path | User directive and security/process leak | No Tend app-server dependency | Old fake app-server tests removed |
| App-server module | `src/targets/codex-app-server.js` | exported server helpers | Used by Tend | Leave only if another non-Tend owner exists; otherwise delete | Avoid dead live path | None for Tend | Import/search check by code review, not test gate |
| Thread binding | `src/targets/codex-tender.js` | `discoverOwnedThreadId` | Count loaded app-server threads | Replace with rollout-originator resolver | Deterministic thread ownership | `resolveOwnedThreadFromRunTag` | Rollout fixture tests |
| Thread ownership | new local lock helper or `src/targets/codex-tender.js` | none | Same thread can be tended by two live supervisors | Acquire per-thread exclusive owner lock after bind/before explicit resume | Prevent duplicate interactive TUI sessions for one thread | `thread_already_tended` fail-loud status | lock tests |
| Goal reads | `src/targets/codex-tender.js` | `readGoal` | App-server `getThreadGoal` | Tail owned rollout `thread_goal_updated` | Lock-free, owned thread state | `tailGoalStatus` | usage-limited tests |
| Recovery trigger | `src/targets/codex-tender.js` | `detectNewPaneRateLimit`, `detectActiveCodexUsageRateLimit` | Shared pane/global usage triggers rotate | Remove as rotation triggers | Prevent cross-tender spurious restarts | owned rollout status only | tests that old triggers no longer rotate |
| Prompt confirm | `src/targets/codex-tender.js` | `confirmResumePrompt`, `maybeConfirmResumePrompt` | Scrapes tmux pane and sends Enter | Read PTY output buffer and write Enter | Keep native Codex prompt path without tmux | output cue only; rollout verifies | prompt timeout/confirm tests |
| Auth writes | `src/io/json-store.js` and `src/targets/codex-cli.js` | `writeJsonFileIfChanged`, `applyCodexCliFromState` | Direct writeFile overwrite | Atomic temp write + rename for Codex auth path | Avoid torn auth under concurrency | atomic write helper | json-store/codex auth tests |
| Tests | `test/codex/codex-10.cases.js` | fake tmux/app-server helpers | Prove old architecture | Replace with fake PTY + temp rollout fixtures | Protect new architecture | injected PTY/runtime/tailer | most Tend tests |
| Docs | `README.md` | command list | Lists Tend command only | Update if option set changes | User-facing truth | no tmux mention | docs review |
| Docs | `docs/codex-tend-multi-instance-plan-2026-05-30.md` | whole doc | Says final design is tmux-backed | Mark superseded by this plan or replace content | Avoid implementing old methodology | this doc is canonical | plan audit |
| Docs | `docs/codex-tend-redesign-2026-05-30.md` | identity/tmux sections | Contains stale absent-filter and tmux-driver claims | Mark superseded or repair contradictory claims | Prevent drift | this doc is canonical | plan audit |

## 6.2 Migration notes

- Canonical owner path / shared code path:
  - `runCodexTender` remains the orchestrator.
  - New PTY process details live in `src/targets/codex-pty.js`.
  - New rollout details live in `src/targets/codex-rollout.js`.
  - Existing account rotation stays in `src/targets/codex-cli.js`.
- Deprecated APIs (if any):
  - `--tmux-session` is deprecated/obsolete for `aim codex run --tend` and must fail loudly.
  - The fake app-server injection surface in `runCodexTender` is retired.
  - `--bind-timeout-seconds` is added as a replacement safety bound for post-goal identity binding.
- Delete list:
  - `createTmuxAdapter` from the Tend path.
  - `buildCodexTenderSessionName` if no longer used.
  - `adaptLegacyAppServerClient`, `discoverOwnedThreadId`, `readGoal` app-server wrapper.
  - `detectNewPaneRateLimit` and `detectActiveCodexUsageRateLimit` as rotation triggers.
  - `startCodexAppServerImpl` dependency injection from `runCodexTender`.
  - Tests asserting `--remote` or private app-server lifecycle.
- Adjacent surfaces tied to the same contract family:
  - README command examples.
  - May 23 overnight proposal doc if it remains a live reference.
  - May 30 multi-instance/redesign docs must point at this plan or stop claiming finality.
- Compatibility posture / cutover plan:
  - Preserve `aim codex run --tend` command shape except tmux-specific option.
  - Clean internal cutover; no tmux/app-server fallback.
- Capability-replacing harnesses to delete or justify:
  - Private app-server control path is deleted from Tend because Codex's rollout/TUI already expose
    the needed native behavior.
- Live docs/comments/instructions to update or delete:
  - README and old Tend docs.
  - `src/cli/help.js` Tend help text.
  - Any comments in `codex-tender.js` that describe tmux/app-server ownership.
- Behavior-preservation signals for refactors:
  - Existing CLI/profile/resume validation tests remain.
  - Existing Redis/file runtime tests remain.
  - Rotation tests are rewritten to assert same external status/events on the new runtime.
  - PTY smoke is manual/finalization evidence, not a replacement for fakeable unit tests.

## 6.3 Second-pass adjacent-surface disposition

- `docs/codex-tend-multi-instance-plan-2026-05-30.md`: update with a top-level superseded notice
  pointing to this plan. Do not leave its "design is final" tmux language as the first truth.
- `docs/codex-tend-redesign-2026-05-30.md`: update with a top-level superseded notice pointing to
  this plan and the instability findings. Do not spend implementation time reconciling every old
  research paragraph once it is clearly historical.
- `docs/codex-tend-path-bug-analysis-2026-05-30.md`: keep as historical analysis; only touch if it
  actively misleads from a live pointer.
- `docs/codex-tend-instability-findings-2026-05-30.md`: keep as evidence; no conversion to plan.
- `docs/codex-overnight-account-rotation-proposals-2026-05-23.md`: add a top-level
  historical/superseded notice because it currently reads like a live operator guide for the old
  tmux/private-app-server Tend runtime.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope |
| ---- | ------------- | ---------------- | ---------------------- | -------------- |
| Process boundary | `src/targets/codex-pty.js` | PTY runtime adapter with injected implementation | Keeps terminal ownership out of orchestration logic | include |
| File state boundary | `src/targets/codex-rollout.js` | Complete-line JSONL parser and tail offset | Prevents partial-line bugs and duplicated rollout parsing | include |
| Credential writes | `src/io/json-store.js` | Atomic text replace helper | Prevents each target from inventing its own atomic write | include |
| Old app-server helper | `src/targets/codex-app-server.js` | No adoption for Tend | Prevents reintroducing private app-server | exclude from Tend; delete if unused |
| Shell command construction | `codex-tender.js` | Structured argv/env instead of shell string | Avoids quoting/env bugs and command injection surface | include |
<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->
> Rule: depth-first implementation protects the full destination while proving the path early.
> Treat TL;DR, Section 0, Sections 5-6, and approved decisions as the destination map: they
> preserve final known scope, not a Phase 1 checklist. Section 7 chooses the first working slice
> that proves one real path through the canonical owner path, highest-risk seam, compatibility
> posture, and verification shape. Later phases expand along named axes from that proof. Phase
> boundaries are proof gates: each phase must create evidence later work can safely rely on. No
> fallbacks/runtime shims: the system must work correctly or fail loudly. Delete superseded paths.

## Pre-implementation gates

* Goal:
  Prove this plan is ready before code changes begin.
* Checklist (must all be done):
  - Run fresh Composer 2.5 Fast plan review and fold accepted plan-readiness notes.
  - Run `$plan-audit` in plan-readiness mode and fold accepted blockers.
  - Re-run the arch stage gate `ready` check after plan repairs.
* Exit criteria (all required):
  - Composer plan review has no blocking findings.
  - Plan audit verdict is ready or equivalent with no unresolved blockers.
  - `arch_stage_gate.py ready --doc docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`
    returns `READY next=implement-loop`.

## Phase 1 - Prove PTY and rollout ownership as reusable Tend primitives

**Implementation status (2026-05-30): complete. Evidence is recorded in commits `500c63a`,
`770b127`, and the implementation-audit block above.**

* Goal:
  Establish the two replacement primitives, PTY child ownership and rollout-file ownership, with
  focused tests before cutting the full Tend loop away from tmux/app-server.
* Work:
  Add the PTY runtime boundary, rollout parser/resolver/tailer, and atomic JSON write support. Wire
  only the minimum orchestration needed for tests to prove the new seams. This phase may leave the
  old live Tend loop in place until Phase 2, but it must not add a user-visible alternate mode.
* Checklist (must all be done):
  - Add a repo-owned Python 3 POSIX PTY helper and verify it runs locally under the current machine's
    `python3`; do not add `node-pty`.
  - Implement the Node/helper JSON-lines protocol from Section 5.4.1 exactly, including base64
    output/input frames, resize frames, exit frames, setup-error frames, and helper stderr capture.
  - Add `src/targets/codex-pty.js` with an injectable helper backend and lifecycle API for start,
    write, send Enter, send `/exit`, output snapshot, resize, wait-for-exit, terminate, and dispose.
  - Add terminal relay logic for attached mode behind the PTY module, including raw-mode entry,
    restoration, resize forwarding, signal cleanup, and child termination.
  - Add goal-intent line detection in attached mode using the Section 5.4.2 heuristic, and keep an
    injection hook for non-attached tests.
  - Add `src/targets/codex-rollout.js` with complete-line JSONL parsing, `session_meta` parsing,
    tag/top-level/source matching, goal-bearing rollout selection, resume-id rollout resolution, and
    goal status tailing.
  - Add per-thread owner-lock helper behavior with exclusive create, stale-lock reclaim, live-pid
    block, and best-effort release.
  - Add atomic text/JSON write support in `src/io/json-store.js` and route Codex auth activation
    through it.
  - Add unit tests for PTY runtime using an injected fake backend.
  - Add unit tests for helper protocol framing, resize propagation, child exit propagation, and
    `python3_unavailable`.
  - Add unit tests for attached-mode goal-intent detection, including whitespace, backspace, pasted
    multiline input, escape-sequence noise, and non-goal slash commands.
  - Add unit tests for rollout parsing/resolution/tailing using temp `sessions/` fixtures. Use
    current Codex `thread_goal_updated` events for goal fixtures, and test explicit-resume fallback
    from filename suffix lookup to `session_meta.id` scanning.
  - Add unit tests for owner-lock acquire/block/reclaim/release.
  - Add unit tests for atomic JSON/text writes and the Codex auth write path.
* Verification (required proof):
  - `npm run lint`
  - focused Node tests covering `codex-pty`, `codex-rollout`, and `json-store` atomic writes
* Docs/comments (propagation; only if needed):
  - Add short comments only at the PTY lifecycle boundary and rollout complete-line parser if the
    code would otherwise hide non-obvious terminal/partial-line invariants.
* Exit criteria (all required):
  - The repo-owned POSIX helper is the only PTY implementation path in live code.
  - `package.json`/`package-lock.json` do not gain a native PTY addon dependency.
  - Rollout resolver can bind a matching top-level goal rollout and reject sub-agent/nonmatching
    rollouts in tests.
  - Atomic write tests prove writes are replacement-based, not direct in-place writes, for the helper
    used by Codex auth.
  - Owner-lock tests prove duplicate live ownership blocks and stale ownership can be reclaimed.
  - `src/targets/codex-tender.js` has not grown past 1000 lines as a result of primitive work.
* Rollback:
  Remove the new PTY/rollout modules, POSIX helper, and atomic helper changes. The old Tend
  runtime still exists until Phase 2 completes.

## Phase 2 - Cut `runCodexTender` over to PTY + rollout and delete live tmux/app-server behavior

**Implementation status (2026-05-30): complete. Evidence is recorded in commits `500c63a`,
`770b127`, and the implementation-audit block above. Full-suite and review gates belong to Phase
3.**

* Goal:
  Make the public Tend command use the new runtime end to end: start, bind, watch, rotate, resume,
  confirm, verify, and exit without tmux or private app-server.
* Work:
  Rewrite `runCodexTender` orchestration around `CodexPtySession` and rollout ownership while
  preserving public CLI behavior and returning PTY-shaped status/events. Remove the old live app-server/tmux
  branches instead of hiding them behind flags.
* Checklist (must all be done):
  - Replace `buildCodexCommand` shell string construction with structured argv/env construction for
    PTY start/resume.
  - Pass `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>` only for new-session starts.
  - Remove `--remote` from all Tend-launched Codex commands.
  - Continue rejecting user-supplied `--remote` pass-through args for Tend, but update the error and
    tests to say `--remote` is incompatible with the PTY/rollout Tend runtime instead of saying
    Tend owns a remote endpoint.
  - Remove private app-server start/stop/adaptation/discovery from `runCodexTender`.
  - Remove tmux adapter usage from `runCodexTender`.
  - Replace `discoverOwnedThreadId` with rollout-originator binding for new sessions.
  - Keep explicit resume behavior by validating UUID and resolving/tailing the matching rollout.
  - Replace app-server `getThreadGoal` reads with owned rollout status tailing.
  - Remove generic pane rate-limit and global active-label usage as recovery triggers.
  - Rotate only when the owned rollout reports `goal.status == "usageLimited"`.
  - Stop/restart the child PTY for rotation and run `codex --no-alt-screen [-p profile] resume <T>`.
  - Confirm Codex's resume prompt by PTY output cue + Enter.
  - Verify resume success from owned rollout `active` status within a bounded timeout.
  - Preserve preflight watch, Redis/file state runtime behavior, `maxRestarts`, poll interval, prompt
    timeout, bind timeout, workdir, profile normalization, pass-through args, and JSON status
    reporting.
  - Return `runid`, `originator`, `threadId`, `rolloutPath`, `attached`, `restarts`, `rotations`,
    `events`, and optional `reason`; do not return tmux `sessionName` in new Tend results.
  - Add CLI parsing/handling for `--bind-timeout-seconds <sec>` with default `120`.
  - Reject `--tmux-session` for `aim codex run --tend` with a clear obsolete-option error.
  - Rewrite `test/codex/codex-10.cases.js` Tend tests around fake PTY + rollout fixtures.
  - Delete tests that assert private app-server URLs, `--remote`, tmux attachment, or generic
    non-owned rate-limit rotation.
* Verification (required proof):
  - `npm run lint`
  - `npm test`
  - focused `node --test` invocation for Codex Tend tests during iteration
* Docs/comments (propagation; only if needed):
  - Update code comments in `codex-tender.js` only if they still describe app-server/tmux behavior.
* Exit criteria (all required):
  - No live Tend code path imports `startPrivateCodexAppServer`.
  - No live Tend command includes `--remote`.
  - No live Tend code shells out to `tmux`.
  - Tests prove `usageLimited -> rotate -> resume -> active` from owned rollout state.
  - Tests prove sub-agent rollouts sharing the originator do not bind as the owned top-level thread.
  - Tests prove first-turn latency waits or blocks without guessing.
  - Tests prove `goal_bind_timeout`, `ambiguous_tagged_goal_rollouts`, and `thread_already_tended`
    statuses.
  - Tests prove old generic pane/global usage triggers no longer rotate a healthy non-owned thread.
  - Tests prove `--tmux-session` is rejected for Tend.
* Rollback:
  Revert the Phase 2 cutover commit while keeping Phase 1 primitives if they are clean and unused.
  Do not reintroduce a runtime fallback branch inside a partially cut-over implementation.

## Phase 3 - Retire stale truth surfaces and verify local installed behavior

**Implementation status (2026-05-30): complete. Docs, full-suite tests, post-implementation smoke
receipts, Composer review, thermonuclear review, implementation audit, commit/push evidence, and
local install evidence are recorded in the worklog, commit history, and implementation-audit block
above.**

* Goal:
  Make repo truth and the local global installation match the PTY/rollout Tend runtime.
* Work:
  Update user-facing docs and historical Tend plan docs so nobody follows the superseded
  tmux/app-server methodology. Run final local tests, smoke checks, reviews, commit, push, and
  install globally.
* Checklist (must all be done):
  - Update `README.md` for current `aim codex run --tend` options, the `python3`/`AIMGR_PYTHON_BIN`
    runtime prerequisite, and remove/avoid tmux wording.
  - Update `src/cli/help.js` for PTY supervisor wording, `--bind-timeout-seconds`, and obsolete
    `--tmux-session` behavior.
  - Add a top-level superseded notice to `docs/codex-tend-multi-instance-plan-2026-05-30.md`
    pointing at this plan.
  - Add a top-level superseded notice to `docs/codex-tend-redesign-2026-05-30.md` pointing at this
    plan and the instability findings.
  - Add a top-level historical/superseded notice to
    `docs/codex-overnight-account-rotation-proposals-2026-05-23.md` pointing at this plan, or delete
    the operator-facing old tmux/app-server guidance if the doc no longer has archival value.
  - Run `npm run lint`.
  - Run `npm test`.
  - Run a local PTY smoke that launches Codex through the new supervisor, sends `/exit`, and exits
    cleanly without creating a new tmux session or private app-server process for that run.
  - Run Composer 2.5 Fast implementation review after code is complete and repair accepted
    blockers. This is separate from the pre-implementation Composer plan review.
  - Run thermonuclear code quality review after tests pass and repair accepted blockers.
  - Commit only files touched for this work.
  - Push the commit.
  - Run the repo's global install command, expected `npm run install:local`, and verify `aim` or
    `aimgr` resolves to the updated installation.
* Verification (required proof):
  - `npm run lint`
  - `npm test`
  - local PTY smoke output
  - Composer 2.5 Fast final verdict acceptable
  - thermonuclear review with no accepted blockers remaining
  - `git status --short` clean except explicitly accepted unrelated pre-existing files
  - commit hash and push result
  - install command output and `aim --help` or equivalent version/path check
* Docs/comments (propagation; only if needed):
  - README and superseded plan notices are required checklist items.
* Exit criteria (all required):
  - Live docs no longer describe tmux/app-server as the current Tend methodology.
  - The implementation is committed and pushed.
  - The updated CLI is installed globally on this machine.
  - The final completion audit can map every requirement in this plan and the user objective to
    current evidence.
* Rollback:
  Use Git to revert the implementation commit and reinstall the previous global CLI if post-install
  smoke fails. Do not leave a half-installed global binary pointing to uncommitted code.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

Avoid verification bureaucracy. Prefer existing credible signals that prove shipped behavior:
Node syntax checks, Node tests, focused fake PTY/rollout tests, one local PTY smoke, and the global
install check. Do not add keyword absence gates, repo-shape policing, or doc-inventory tests.

## 8.1 Unit tests (contracts)

- Pure rollout parser/scanner/tailer tests using temp `sessions/` directories and JSONL fixtures.
- PTY runtime adapter tests with an injectable fake PTY implementation.
- Per-thread owner-lock tests for duplicate live owner, stale lock reclaim, and release.
- Atomic JSON writer tests that prove the Codex auth path writes by replacement.

## 8.2 Integration tests (flows)

- `runCodexTender` tests for start binding, explicit resume, usage-limited rotate/resume/active,
  blocked rotation, prompt-confirm timeout, bind timeout, duplicate resume lock, and no rotation for
  non-owned/global signals.
- CLI wiring tests for preserved options and removed `--tmux-session` live behavior.

## 8.3 E2E / device tests (realistic)

- Local smoke: launch Codex through the PTY supervisor, send `/exit`, assert clean exit and no tmux
  session/app-server creation by this run.
- Global install smoke after `npm run install:local`.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

This is a clean local cutover. The updated `aim codex run --tend` uses PTY/rollout. The old
tmux/app-server implementation is not kept as a runtime fallback.

## 9.2 Telemetry changes

No external telemetry is required. Return JSON status/events from `runCodexTender` should continue
to include useful local event names for start, bind, rotate, resume, prompt confirmation, and exit.

## 9.3 Operational runbook

- Before implementation, do not kill existing user tmux sessions.
- After implementation, normal Tend runs should not create new `aimgr-codex-tend-*` tmux sessions or
  private `codex app-server --listen ws://127.0.0.1:<port> --enable goals` processes.
- If binding times out, report originator tag, Codex home, and sessions directory checked.
- If terminal cleanup fails, fail loud and restore the parent terminal before returning.

<!-- arch_skill:block:consistency_pass:start -->
## Consistency Pass

- Reviewers: self-integrator; external Composer 2.5 Fast and plan-audit gates are required before
  implementation by Section 7
- Scope checked:
  - TL;DR, Section 0, Section 5, Section 6, Section 7, Section 8, Section 9, and Decision Log
  - runtime ownership, compatibility posture, adjacent docs, required deletes, verification, and
    phase exit criteria
- Findings summary:
  - The original auto-plan draft left PTY implementation as `node-pty` with a helper contingency.
    That was too branchy for implementation readiness, and the later local smoke proved
    `node-pty@1.1.0` cannot spawn a child under Node `v25.9.0` here.
  - Fresh Composer 2.5 Fast later found non-blocking plan gaps around bind timeout, goal-bearing
    selection detail, help text, duplicate resume ownership, and review-gate wording.
  - The plan consistently rejects tmux/app-server runtime fallback and keeps shared auth as the
    chosen product posture.
  - Section 7 carries required docs, deletes, tests, reviews, commit, push, and global install work
    in checklist/exit-criteria surfaces.
- Integrated repairs:
  - Fixed PTY implementation to one chosen path: a repo-owned POSIX helper driven by
    `src/targets/codex-pty.js`.
  - Reframed Python PTY from smoke evidence into the production backend because it passed the local
    PTY and real-Codex smoke while `node-pty` failed at child spawn.
  - Kept dependency/backend failure as a blocker/plan-repair event rather than an alternate runtime
    branch.
  - Added exact Node/Python helper IPC, helper path, Python executable resolution, goal-intent input
    heuristic, and PTY-shaped return payload rules after Composer's second plan review.
  - Added `--bind-timeout-seconds` with default `120`.
  - Added explicit goal-bearing rollout selection and ambiguity rules.
  - Added per-thread owner lock for duplicate `--resume <same-thread-id>`.
  - Added `src/cli/help.js` to the call-site audit.
  - Split pre-implementation plan review gates from post-implementation code review gates.
- Remaining inconsistencies:
  - none
- Unresolved decisions:
  - none
- Unauthorized scope cuts:
  - none
- Decision-complete:
  - yes
- Decision: proceed to implement? yes
<!-- arch_skill:block:consistency_pass:end -->

# 10) Decision Log (append-only)

## 2026-05-30 - User-directed PTY cutover replaces tmux/app-server plan

Context

The prior multi-instance plan correctly removed the private app-server and loaded-thread guessing,
but kept tmux as the Tend runtime. The instability findings showed tmux attach lifecycle corruption
and live orphan attach/app-server processes.

Options

- Keep the prior tmux-backed rollout plan and harden attach lifecycle.
- Replace the Tend runtime with an AIMGR-owned foreground PTY supervisor while keeping the rollout
  identity/tailer pieces.
- Return to an app-server or daemon API.

Decision

Use the PTY supervisor cutover. Keep rollout identity/tailing and shared auth posture. Delete the
private app-server path and tmux runtime path from live Tend code.

Consequences

Tend no longer preserves a detached TUI if AIMGR dies. The reliable recovery path is exact
`codex resume <T>`. Implementation must add real terminal cleanup and PTY lifecycle tests.

Follow-ups

Run Composer 2.5 Fast and `$plan-audit` before implementation, then implement through
`$arch-step auto-implement`, test, perform exhaustive review, commit, push, and install globally.

## 2026-05-30 - Intent-derived: North Star approval from active goal

Blocker: `$arch-step new` normally pauses for explicit North Star confirmation before deeper
planning.

Consulted: User objective in the active goal, TL;DR, and Section 0.

Intent says: The user explicitly requested `$arch-step auto-plan`, fresh Composer review iteration,
`$plan-audit`, then auto-implementation, test, review, commit, push, and global install.

Decision: Treat the North Star as approved for this artifact and set `status: active`; continue the
planning arc rather than pausing on a confirmation question.

Consequences: If Composer or plan-audit finds a scope-shaping ambiguity, stop and repair or ask then.

## 2026-05-30 - Composer 2.5 Fast plan review repairs

Context

Fresh Composer 2.5 Fast reviewed this plan after `$arch-step auto-plan` reached
`READY next=implement-loop`.

Options

- Proceed directly because Composer found no blocking issues.
- Fold the non-blocking plan-readiness notes before `$plan-audit`.

Decision

Fold the notes before `$plan-audit`: explicit bind timeout, explicit goal-bearing rollout selection,
`src/cli/help.js` coverage, duplicate `--resume` locking, and clearer pre/post review sequencing.

Consequences

The plan remains a clean PTY/rollout cutover, but the implementation no longer needs to infer these
details from the superseded multi-instance plan.

Follow-ups

Run `$plan-audit` next and repair any accepted blockers before `$arch-step auto-implement`.

## 2026-05-30 - PTY backend smoke rejects `node-pty`

Context

The plan needed a cheap proof that an AIMGR-owned foreground supervisor can run a TUI child without
tmux and without corrupting rendering.

Options

- Use `node-pty@1.1.0` as the Node-native PTY dependency.
- Use a repo-owned POSIX helper process for PTY allocation and byte relay.
- Keep tmux as the PTY provider.

Evidence

- `npm install --prefix /tmp/aimgr-node-pty-smoke node-pty@1.1.0` succeeded.
- Loading the temp-installed package and calling `pty.spawn('/bin/sh', ...)` failed with
  `Error: posix_spawnp failed` under local Node `v25.9.0`.
- A Python 3 stdlib PTY smoke passed: the child saw TTY stdin/stdout/stderr, received exact
  keystrokes, observed the configured `100x40` window size, and preserved alternate-screen bytes.
- A real-Codex smoke launched `/Users/aelaguiz/.local/bin/codex` version
  `codex-cli 0.136.0-alpha.1` under the Python PTY harness, captured terminal-control output, and
  stopped the process cleanly.

Decision

Do not add `node-pty`. Use a single repo-owned POSIX PTY helper driven by Node.

Consequences

The PTY assumption is validated, but the implementation path changes. The plan now requires tests
around the Node/helper protocol, resize handling, byte relay, child exit status, and cleanup.

## 2026-05-30 - Composer second plan review repairs

Context

Fresh Composer 2.5 Fast reviewed the smoke-repaired plan and returned `pass-with-notes`, no
blocking findings, high confidence. It agreed the architecture is elegant and workable, but called
the Node/Python helper protocol and attached-mode goal intent heuristic thin spots.

Options

- Treat the notes as Phase 1 implementation detail and proceed to `$plan-audit`.
- Fold the notes into the canonical plan before `$plan-audit` so implementation has no protocol
  gaps to infer.

Decision

Fold the notes now. The plan now names the helper path, Python executable resolution, JSON-lines
base64 protocol, resize/exit/error frames, stderr handling, helper PTY responsibilities, attached
raw-input `/goal` detection heuristic, and the new PTY-shaped Tend status payload.
After a follow-up Composer pass returned `pass-with-notes` with no blockers, also clarify the
external-research marker, `exitTimeoutSeconds` default, and Node TTY raw-mode ownership.

Consequences

Implementation should not invent a helper protocol or preserve tmux-shaped `sessionName` output by
accident. `$plan-audit` can review an exhaustively specified plan instead of accepting "Phase 1 will
figure it out" as an implicit decision.

## 2026-05-30 - Explorer plan-audit coverage repairs

Context

Read-only explorer workers checked side-door coverage, rollout source assumptions, and PTY helper
repo fit before `$plan-audit`.

Decision

Fold their actionable notes into the plan: make the May 23 overnight rotation doc a mandatory
Phase 3 superseded/historical update, preserve negative validation for user-supplied `--remote`
with PTY/rollout wording, use current Codex `thread_goal_updated` fixtures, and allow explicit
resume rollout lookup to fall back from filename suffix to `session_meta.id`.

Consequences

The plan no longer leaves a public-looking tmux/app-server operator doc as a conditional cleanup,
and implementation tests should match current Codex rollout events rather than a hypothetical
`thread_goal_created` event.
