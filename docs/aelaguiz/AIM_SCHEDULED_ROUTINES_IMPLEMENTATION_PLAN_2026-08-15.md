---
title: "AIM Local Scheduled Prime Routines"
date: 2026-08-15
status: active
owners: [Amir]
reviewers: []
fallback_policy: "Uninstall or boot out the affected AIM LaunchAgent and report the result. Amir alone owns Claude Desktop enable/disable state."
related:
  - ../AI_MANAGER_SCHEDULED_ROUTINES_HERDR_ANALYSIS_2026-08-12.md
  - ../../../psagentspace/research/2026-08-12-aim-scheduled-routines-panel/DECISION.md
  - ../CLAUDE_DESKTOP_SCHEDULED_ROUTINE_ACCOUNT_MIGRATION_ANALYSIS_2026-08-12.md
---

# TL;DR

Worklog: [AIM_SCHEDULED_ROUTINES_IMPLEMENTATION_PLAN_2026-08-15_WORKLOG.md](./AIM_SCHEDULED_ROUTINES_IMPLEMENTATION_PLAN_2026-08-15_WORKLOG.md)

Build this as a small local feature, not a scheduler platform: one `aim routine run <id>` command, three production records in the existing `~/.aimgr/config.yaml`, three static macOS LaunchAgents, two local locks, and one small JSON receipt per occurrence. Each accepted fire creates one non-focused Herdr Space, pins a fresh Prime session to the exact configured account/provider/model/thinking tuple, resumes that exact session as a foreground interactive Prime TUI, submits the routine prompt once, and leaves the TUI alive in that Space for Amir's later follow-up conversation.

Two phases only:

1. implement and prove the manual occurrence runner;
2. install the three LaunchAgents and cut over one routine at a time.

> **Interactive-session correction (2026-08-15):** A terminal dump, saved JSONL, or technically resumable exited process is not the product. Every occurrence must leave the exact Prime session running as a live interactive TUI in its Herdr Space after the initial answer, ready for same-session keyboard follow-ups. Schedule and interaction proofs use only the inert `test-schedule-smoke` routine pinned to `anthropic` / `claude-sonnet-5` / `low`; production routines and expensive Fable/Sol calls are not synthetic tests.

## North Star

### Claim

At each accepted local calendar occurrence, Amir gets exactly one retained, non-focused Herdr Space containing a live interactive Prime TUI on the exact configured account/provider/model/thinking tuple. The scheduled prompt is the first real turn; after its answer, the same TUI and session remain open so Amir can enter the Space and continue the conversation. The current report, ledger, Slack, and approval behavior stays unchanged.

### In scope

- The three existing routines: `morning-report`, `rpokerskill`, and `community-sweep`.
- Per-routine local configuration for calendar time, cwd, prompt file, provider, model, thinking, Herdr session, and Space title format.
- A fresh Prime session and fresh Herdr Space per occurrence, with the TUI left alive for later same-session follow-ups.
- Usage-ranked AIM account selection for `anthropic` and `openai-codex`.
- One public occurrence command plus one private worker invocation inside the created Herdr pane.
- Three static user LaunchAgents generated from the same config records.
- Fail-closed duplicate/overlap handling and a small local receipt.
- A staged AIM activation, one routine at a time, after Amir confirms he has disabled the matching Claude Desktop task.

### Out of scope

- A general scheduler, daemon, queue, web UI, routine CRUD, remote API, distributed execution, or cross-machine failover.
- A cron parser, arbitrary title templating, plugin system, model registry, or account reservation service.
- Automatic retry after prompt admission, catch-up of old missed runs, stale-lock repair, or automatic Herdr Space cleanup.
- Herdr or Prime Agent source changes. Current source already supports exact interactive resume, TUI state reporting, and prompt submission; a failure of those native capabilities stops implementation for a new scope decision.
- New prompt behavior, new reporting behavior, or changes to posting approval gates.
- Opening or automating Claude Desktop, editing its scheduled-task manifests, or enabling/disabling any Desktop task. Amir owns all Desktop state changes; AIM setup may only read the existing prompt files as source material.
- Polished external documentation or a stable third-party configuration/API contract.

### Definition of done

1. The exact configured account/provider/model/thinking tuple and Herdr session/title are visible in the receipt and match the actual live Prime TUI session and created Space.
2. A normal fire creates one Space and one fresh session, admits the configured prompt exactly once, settles the initial turn, and still has `prime-agent` interactively occupying the returned pane; duplicate or overlap creates no second Space or prompt.
3. A follow-up typed or submitted into that pane becomes the next user turn in the same Prime session file and receives its answer without relaunch or manual resume.
4. Initial-turn completion and TUI lifetime are separate: the receipt and per-routine lock settle after the first turn, while the lightweight pane worker continues waiting on the live TUI until Amir eventually quits it.
5. The reusable Sonnet 5/low smoke routine passes both manual and natural-time live-TUI proofs, including a same-session follow-up. No production prompt or expensive Fable/Sol model is used as a synthetic interaction test.
6. Each LaunchAgent uses the configured local calendar entries; delayed wake outside the fixed admission window creates no Space. Production routines are activated only after Amir confirms their matching Desktop tasks are off; implementation never reads or changes Desktop state.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: `~/.aimgr/config.yaml` remains the only routine configuration file. Add a fixed `routines` map; do not create a second manifest or config service.
- R2: Every record requires `calendar`, `cwd`, `promptFile`, `provider`, `model`, `thinking`, `herdrSession`, and `spaceTitleFormat`. Scheduled runs never inherit model, thinking, session, or title from ambient defaults.
- R3: V1 account policy is derived, not configurable: `anthropic` selects the least-used eligible Anthropic account; `openai-codex` selects the next-best eligible Codex account. Other providers fail clearly.
- R4: `spaceTitleFormat` supports only `{scheduled_local}`, expanded as `YYYY-MM-DD HH:mm z`. No general template engine.
- R5: The only public runtime surface is `aim routine run <id> [--manual] [--json]`. There is no list/enable/disable/install CRUD surface.
- R6: Scheduled mode derives the latest configured local calendar slot and admits it only within a hard-coded 10-minute window. Later launchd wake-ups record `missed` and stop before locking or Space creation. Manual mode uses a unique manual fire key and still honors overlap protection.
- R7: Before Space creation, atomically claim the fire key and acquire a per-routine ownership directory. A duplicate or active overlap stops without creating another Space. A crashed owner intentionally leaves a visible stale lock for manual inspection; V1 does not guess that it is safe to recover.
- R8: Create the Space through `herdr --session <herdrSession> workspace create --cwd <cwd> --label <expanded-title> --no-focus`. Parse and retain the returned workspace and root-pane IDs; never use the user's focused pane. Immediately request Herdr's native `workspace.move` API with `insert_index: 0` and verify the returned list starts with the new ID. Ordering failure is recorded and visible but does not suppress the routine.
- R9: The created pane runs the same installed AIM binary through one private worker. That worker spawns the verified Prime session as a foreground interactive child with inherited TTY stdio and no `--print`, JSON mode, piped stdin, detachment, or shell-built prompt command. It is not a daemon, supervisor, or public second command.
- R10: Under one shared bounded bootstrap lock, reuse `aim prime use claude|codex`, run the tiny no-tools print pin, and verify the saved account/provider/model/thinking/binding/fingerprint. Then use the installed `prime-agent` compatibility entrypoint to start `--dist --cwd <cwd> --session-dir <dir> --resume <exact-session-path> -- <effective-prompt>` as the pane worker's foreground inherited-TTY child. This lets the wrapper select the daemon-compatible client while all other sessions remain untouched; AIM must never force a new launcher, answer a takeover question, or stop the daemon.
- R11: The routine prompt is one startup-message argv element after `--`, never shell text, stdin, `@file`, or a second submission. Watch the exact pinned session journal until the latest persisted user text hash matches, then release the bootstrap lock. Continue watching that journal for a terminal assistant message for the same turn; timeout, error, TUI exit, or uncertain admission becomes `needsAttention` and is never replayed automatically. If admission is unproven at timeout, terminate only the newly launched client so a queued startup prompt cannot run later.
- R12: Initial-turn settlement and TUI lifetime are separate. After the prompt wait settles or is classified ambiguous, atomically update the owner-only receipt and release the per-routine ownership directory. The pane worker then stays alive awaiting the interactive Prime child; it may add `tuiExitedAt` when Amir eventually quits, but TUI exit does not define occurrence completion.
- R13: The receipt contains the fire key, configured/observed tuple, selected non-secret binding, Herdr IDs/title, Prime session ID/path, prompt hashes/admission, initial-turn outcome, live-interactive readiness/status, and `needsAttention`; never prompt bodies or credentials. Production Spaces remain for Amir's conversation; temporary `test-*` Spaces are closed by the operator after their follow-up proof so they do not accumulate. Missing dependencies, exact tuple/session readiness, or TTY handoff fails visibly without answering takeover prompts or falling back.
- R14: The deterministic runner is the correct lever. The routine prompt remains the authority for the business work; no extra LLM planner, evaluator, or completion classifier is added.
- R15: Claude Desktop is outside the implementation boundary. Setup may read the existing prompt files for a byte-for-byte copy, but must not open the app, inspect or write its scheduler manifests, or enable/disable tasks. Amir confirms each matching Desktop task is off before that AIM LaunchAgent is bootstrapped.

Fixed private defaults, not new config fields: durable startup-prompt admission has 30 seconds and initial-turn journal settlement has 2 hours. Exceeding either bound is ambiguous `needsAttention`, never replay permission; an unadmitted startup client is terminated so it cannot run later.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: local AIM-scheduled jobs that leave a live interactive Prime TUI in each configured Herdr Space for later same-session follow-up, with exact model/thinking/account pins, explicitly private and non-NASA-grade.
- Authorization anchors: this thread, including Amir's explicit correction that exited print/JSON output is unacceptable, his ownership of all Claude Desktop changes, the 2026-08-12 analysis/panel decision, and the 2026-08-15 operator amendments.
- Smallest sufficient solution: retain the existing config/launcher/locks/receipts, replace only the real-prompt print subprocess with one inherited-TTY Prime child plus existing Herdr agent readiness/prompt/wait calls, and split initial-turn completion from TUI process lifetime.
- Initial minimal convergence closure: keep the extracted shared Prime session-profile reader and routine-config preservation already landed; no additional owner move is needed because Prime and Herdr already expose the required interactive capabilities.
- Scope freeze: the interactive correction explicitly reopens and supersedes the earlier print-mode freeze. R1-R15 and the two repaired phases below are re-frozen before the next code edit. Failure of native interactive resume/Herdr prompt proof does not authorize a Prime API, PTY wrapper, resident supervisor, or new daemon.
- Enough proof: focused fake-process tests, AIM lint/targeted suite, then one cheap Sonnet 5/low manual interactive smoke with a same-session follow-up and one cheap natural-time interactive smoke with another same-session follow-up. No new live Fable/Sol or production-prompt test.
- Do not build: every item in North Star / Out of scope, especially scheduler machinery, dashboards, retries, generic schemas, and remote operation.
- Accepted residual risk: this Mac, Redis, Herdr, browser sessions, and network must be available; sleep beyond ten minutes skips a run; a crash can leave a stale lock/Space requiring manual cleanup; receipts prove local orchestration, not exactly-once external effects.


<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- Current AIM already owns config, occurrence claims, account selection, exact print-pin verification, Herdr Space creation, static LaunchAgents, and receipts. The defect is narrow: `src/routines/run.js` resumes the real prompt with `--print --mode json` and piped stdin, so Prime must exit after rendering output.
- Prime mode selection is explicit: `packages/coding-agent/src/main.ts:173-189` chooses interactive only when `--print`/JSON are absent and stdin is a TTY; `src/cli/owned-session-worker.ts:74-90` independently treats non-TTY stdin as print mode. Therefore deleting `--print` while retaining `runStreaming()` pipes would still be wrong.
- Prime natively opens an exact resume path through `src/main.ts:474-481`. CLI parsing treats `--resume <path>` as the selector and arguments after `--` as startup messages (`src/cli/args.ts:88-96,112-124`). Using that existing compatibility entrypoint is the non-disruptive path: the exact pin/session is already verified, journal hashing proves whether the startup prompt was admitted, and Prime remains interactive afterward.
- A resumed interactive client receives startup messages (`src/main.ts:1573-1600`), and `InteractiveMode.run()` submits startup prompts then remains in `getUserInput()` (`src/modes/interactive/interactive-mode.ts:1506-1554,1639-1655`). This proves Prime can remain conversational after the scheduled turn without a Prime source change.
- Prime's newer built-in Herdr reporter can expose the exact session, but Amir's installed compatibility wrapper may intentionally route new clients through the older daemon-compatible frontend while existing sessions are busy. Scheduled coexistence therefore must not require that newer reporter or force `PRIME_AGENT_LAUNCHER_PATH` past the wrapper.
- The exact session journal is already AIM's profile and prompt-integrity authority. A terminal assistant entry after the matching user hash supplies the initial-turn boundary without taking ownership of later TUI conversation; Herdr remains responsible only for the Space/pane and inherited TTY.
- A forced current launcher may ask an interactive takeover question when an incompatible daemon is busy (`prime src/main.ts:353-397`). The routine must never force that path, answer the question, or stop the daemon. If a startup prompt is not durably admitted within the bound, terminate only the newly launched client.
- `@file` is still unsuitable because Prime wraps file contents. The worker passes the effective prompt directly as one post-`--` argv element and verifies the exact persisted user-message SHA-256 before treating admission as proven.
- macOS `launchd`, prompt copying, Desktop boundaries, and schedule admission were already grounded and are unchanged. No new external research or Prime/Herdr feature work is necessary.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

- AIM owns fixed routine config, due-slot logic, claims/locks, receipts, non-focused Herdr placement, account selection, exact print-pin verification, prompt integrity, static LaunchAgents, and Desktop confirmation gates.
- The repaired worker uses the installed compatibility entrypoint to resume the pinned session as a foreground inherited-TTY TUI with the routine prompt as one native startup message. The exact session journal proves admission and terminal assistant settlement; the TUI remains alive afterward.
- Manual and natural Sonnet 5/low proofs passed, including same-session follow-ups while Amir's other Prime sessions continued uninterrupted.
- The temporary smoke LaunchAgent is uninstalled. After Amir confirmed all Desktop counterparts off, all three production LaunchAgents were activated one at a time with `morning-report` last. New routine Spaces are moved to Herdr position 1 without changing focus.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

### Configuration

Extend the existing `~/.aimgr/config.yaml` with three fixed records. The schedule is launchd-shaped rather than cron-shaped, eliminating a cron parser:

```yaml
routines:
  morning-report:
    calendar:
      - { hour: 6, minute: 0 }
    cwd: /Users/aelaguiz/workspace/psagentspace
    promptFile: /Users/aelaguiz/.aimgr/routines/prompts/morning-report.md
    provider: anthropic
    model: claude-fable-5
    thinking: xhigh
    herdrSession: growth
    spaceTitleFormat: "morning report · {scheduled_local}"

  rpokerskill:
    calendar:
      - { hour: 15, minute: 0 }
    cwd: /Users/aelaguiz/workspace/psagentspace
    promptFile: /Users/aelaguiz/.aimgr/routines/prompts/rpokerskill.md
    provider: anthropic
    model: claude-fable-5
    thinking: medium
    herdrSession: growth
    spaceTitleFormat: "r/PokerSkill sweep · {scheduled_local}"

  community-sweep:
    calendar:
      - { hour: 7, minute: 0 }
      - { hour: 17, minute: 0 }
    cwd: /Users/aelaguiz/workspace/psagentspace
    promptFile: /Users/aelaguiz/.aimgr/routines/prompts/community-sweep.md
    provider: anthropic
    model: claude-fable-5
    thinking: medium
    herdrSession: growth
    spaceTitleFormat: "community sweep · {scheduled_local}"
```

The three production prompt files are byte-for-byte snapshots of the current Claude Desktop sources. They remain local, owner-only, and outside Redis. The inert reusable `test-schedule-smoke` record uses `anthropic`, `claude-sonnet-5`, `low`, `growth`, an `AIM schedule smoke · {scheduled_local}` title, and an owner-only no-tools exact-token prompt. Its calendar is moved to the next practical minute only for an authorized smoke; after its same-session follow-up proof, uninstall its LaunchAgent and close its temporary TUI/Space.

### Occurrence path

```text
launchd or Amir
  -> aim routine run <id> [--manual]
  -> load exact config; derive due slot/fire key; reject late wake
  -> atomic duplicate claim + per-routine ownership directory
  -> create configured non-focused Herdr Space and record returned IDs
  -> move that Space to Herdr list position 1 via native workspace.move
  -> run private AIM worker in that root pane
  -> acquire bounded shared bootstrap lock; select AIM account
  -> run tiny no-tools Prime print pin; verify exact saved tuple/binding
  -> spawn installed compatibility entrypoint as foreground inherited-TTY TUI
     with exact resume path + effective prompt as one startup argv message
  -> watch the exact journal until the matching user hash proves admission
  -> release bootstrap lock; never replay an admitted or uncertain prompt
  -> watch that journal for the same turn's terminal assistant message
  -> re-verify the exact session profile and final prompt hash
  -> atomically finalize receipt; release per-routine ownership
  -> keep pane worker waiting on the still-live Prime TUI for Amir's follow-ups
  -> if Amir eventually quits Prime, record tuiExitedAt and return to the shell
```

The print pin remains the only deliberate extra model call. It proves the account/model/thinking tuple before the real prompt. The installed compatibility entrypoint is intentional: it joins the currently compatible Prime runtime without touching other sessions. The foreground child owns the pane TTY, submits its startup message through Prime's native interactive path, and remains alive after the initial answer; AIM only observes the exact journal and does not emulate a terminal, create a supervisor, or proxy later conversation.

### Local state

- `~/.aimgr/routine-runs/<fire-key>.json`: one small atomic receipt.
- `~/.aimgr/routine-locks/<routine-id>/`: atomic ownership directory transferred from launcher to pane worker; a crash leaves it for manual inspection.
- `~/.aimgr/routine-bootstrap.lock`: bounded `proper-lockfile` lock covering account selection, pin verification, live-TUI attachment verification, and durable first-prompt admission—not the full model turn or later conversation.
- `~/.aimgr/logs/routine-<id>.{out,err}.log`: ordinary launchd process logs.
- The receipt separates `initialTurn` from `interactiveTui`; the latter records readiness/live evidence and optional exit time without becoming a workflow state machine.
- No database, append-only event journal, queue, monitor, PTY shim, or automatic reconciliation loop.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

### Existing implementation to repair

- `src/routines/run.js` — keep claims, Herdr Space creation, account selection, print pin, and receipts. After creation, use Herdr's native socket `workspace.move` request to place the new Space at index 0, recording any non-fatal ordering failure. Start the installed compatibility entrypoint as an inherited-TTY exact resume with one startup prompt argv; use the exact session journal for admission and initial-turn settlement, release locks at those boundaries, and continue waiting on the TUI child.
- `src/targets/prime-sessions.js` — retain the shared active-branch profile and latest-user-text readers; use them before prompt admission and again after the initial turn. Add no second parser.
- `src/routines/config.js` and `src/routines/schedule.js` — unchanged contract; the Sonnet smoke remains an ordinary validated `test-*` record.
- `src/routines/launchd.js` and `scripts/install-routines.mjs` — scheduling logic remains unchanged and must not force `PRIME_AGENT_LAUNCHER_PATH`; the installed compatibility entrypoint on `PATH` owns safe client selection. The existing `--no-desktop-counterpart` restriction remains the only live-install path for the smoke job.
- `test/routines/routine-run.test.js` — use a fake long-lived TUI and session journal. Prove the prompt is one post-`--` startup argv element rather than stdin/print, exact journal admission precedes bootstrap unlock, terminal assistant settlement precedes occurrence release, the TUI remains alive for same-session follow-up, and uncertain admission terminates only the new client without replay.
- `test/routines/launchd.test.js` — retain current static schedule and install-gate coverage; no new scheduler behavior.

### No new production owner

No Prime source, Herdr source, PTY wrapper, background service, prompt proxy, monitor, or additional production file is required. Small helpers stay inside `src/routines/run.js` unless extraction is forced by existing testability/style, not anticipated architecture.

### Deployment outputs, not source

- Owner-only prompts under `~/.aimgr/routines/prompts/`
- Staged plists under `~/.aimgr/routines/launchagents/`
- Live production plists only under `~/Library/LaunchAgents/com.funcountry.aimgr.routine.<id>.plist` after Amir's confirmation
- Receipts, locks, and logs under `~/.aimgr/`
- One retained interactive Herdr Space/TUI per accepted production occurrence; temporary test Spaces are closed after proof

The prior print-mode receipts and Spaces remain historical evidence only; they do not satisfy the corrected interactive contract.
<!-- arch_skill:block:call_site_audit:end -->


<!-- arch_skill:block:phase_plan:start -->
## Phased Implementation Plan

### Phase 1 — Repair the occurrence runner around a live interactive TUI

**Outcome:** a cheap manual `test-schedule-smoke` occurrence runs its opening turn and remains as the exact live Prime TUI in the returned Herdr pane; a follow-up continues the same session.

1. **Preserve the proven deterministic front half.**
   - Keep config validation, due-slot/fire-key admission, duplicate/overlap ownership, non-focused Space creation, in-pane worker dispatch, account selection, bounded bootstrap lock, tiny print pin, exact profile/binding verification, prompt hashes, and Desktop/install gates.
   - Do not repeat live Fable/Sol probes. Their pin evidence is sufficient; all new behavior tests use Sonnet 5/low.

2. **Replace the exited real-prompt subprocess with the daemon-compatible native TUI.**
   - After print-pin verification, resolve the installed `prime-agent` entrypoint from the pane's normal `PATH`; do not propagate or force `PRIME_AGENT_LAUNCHER_PATH` around its compatibility policy.
   - Spawn `prime-agent --dist --cwd <cwd> --session-dir <dir> --resume <sessionPath> -- <effectivePrompt>` with argv, `stdio: "inherit"`, `detached: false`, no shell, no `--print`, no JSON mode, and no stdin pipe. The prompt is exactly one startup message argv element.
   - This wrapper-selected client must coexist with every already-running Prime session. AIM never answers takeover prompts or stops/restarts a daemon.

3. **Prove admission and settlement in the exact journal; keep the TUI.**
   - Poll the pinned session journal. When its latest user text has the configured effective SHA-256, record admission and release the bootstrap lock. If admission remains uncertain, mark `needsAttention`, release ownership, terminate only this new client, and never retry.
   - Continue polling the same active branch for a terminal assistant message after that user entry. Success settles `initialTurn`; provider error, TUI exit, or the two-hour bound becomes `needsAttention`. Re-verify the final profile and prompt hash.
   - Release the per-routine ownership directory when the initial turn settles even though Prime remains alive. Continue awaiting the TUI child; when Amir eventually quits it, only add `tuiExitedAt` and return the pane to its shell.

4. **Prove the corrected UX cheaply.**
   - Focused fakes prove: pin is still no-tools print/JSON; the real prompt is one startup argv message in an inherited-stdio long-lived TUI; prompt hash precedes bootstrap release; terminal journal settlement precedes routine-lock release; TUI exit is not completion; and uncertain admission kills only the new client without replay.
   - Run targeted AIM tests and lint. Do not turn the two unrelated existing full-suite expectation failures into this feature's scope.
   - Manually dispatch only `test-schedule-smoke` on `anthropic` / `claude-sonnet-5` / `low`. Require its exact initial response, then submit `Reply exactly AIM_SCHEDULE_FOLLOWUP_OK` in the same pane and verify it is the next turn in the same session ID/path. The TUI must remain live after both answers.

**Phase 1 stop gate:** no LaunchAgent—test or production—may be loaded until the manual Sonnet smoke proves the live TUI and same-session follow-up. Failure stops for a new decision; it does not authorize Prime/Herdr changes, a PTY layer, or a supervisor.

### Phase 2 — Natural interactive proof and Amir-gated production activation

**Outcome:** `launchd` creates the same follow-up-ready TUI without using a production routine as a test, then production schedules cut over one at a time only after Amir's Desktop confirmations.

1. **Prove one natural scheduled interactive occurrence.**
   - Move only `test-schedule-smoke` to the next practical minute, prepare it, and install it with `--no-desktop-counterpart`.
   - Require a natural non-focused `growth` Space, exact Sonnet 5/low account/session tuple, exact initial prompt hash/answer, live `prime-agent` TUI, and a successful `AIM_SCHEDULE_FOLLOWUP_OK` next turn in the same session.
   - Immediately uninstall the smoke LaunchAgent after the same-session follow-up proof so it cannot recur, then close that temporary test Space/TUI so test jobs do not accumulate.

2. **Activate production without synthetic production runs.**
   - Amir disables one exact Desktop counterpart and confirms it. Install only that production AIM LaunchAgent with `--desktop-off-confirmed`; do not manually dispatch its prompt as a test.
   - Observe the first ordinary scheduled occurrence for exact account/model/thinking/prompt and a live follow-up-ready TUI. On failure, uninstall only that AIM LaunchAgent and report; Amir alone decides Desktop rollback.
   - Repeat only after the next confirmation. Move `morning-report` last. Never inspect/mutate Desktop, replay an ambiguous prompt, close production Spaces, or add monitoring machinery.

**Phase 2 completion gate:** the cheap manual and natural interactive proofs pass; Amir has confirmed all three Desktop tasks are off; all four daily occurrences are owned by the three AIM LaunchAgents; and each accepted occurrence leaves exactly one live same-session Prime TUI. AIM rollback remains per-routine bootout/uninstall.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

**PASS — daemon-compatible interactive contract is minimal and frozen.**

- The North Star is the real UX: each fire creates a fresh live TUI while every existing Prime session continues uninterrupted.
- The installed Prime compatibility entrypoint owns client/daemon version matching. AIM neither forces a newer launcher nor restarts, replaces, or answers takeover questions for the daemon.
- The exact print pin plus exact `--resume <path> -- <startup-message>` argv is sufficient. The pinned session journal remains the authority for profile, prompt admission, and initial-turn settlement; newer Herdr reporter metadata is not a dependency.
- The repair remains concentrated in `src/routines/run.js`, `src/targets/prime-sessions.js`, and focused tests. Scheduling, config, prompts, Desktop gates, and account selection did not grow.
- Uncertain startup is fail-closed: AIM kills only its new unadmitted client, releases locks, records attention, and never replays. Admitted/error cases leave the TUI for human continuation.
- Initial-turn completion and TUI lifetime remain separate, so tomorrow's occurrence is not blocked by today's retained conversation.
- Manual and natural Sonnet 5/low proofs, each with a same-session follow-up, are the sufficient acceptance evidence. No new Fable/Sol or production-prompt test is authorized.
- R1-R15 and the two phases are re-frozen around this non-disruptive path; no Prime/Herdr source work, PTY layer, supervisor, Desktop automation, or generalized lifecycle machinery is permitted.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

**Status: PRODUCTION ACTIVE — interactive and placement acceptance pass.**

- `src/routines/run.js` keeps the exact print pin, then starts the installed compatibility entrypoint as an inherited-TTY foreground exact resume with one post-`--` startup prompt argv. It hashes admission, settles the initial turn from the exact journal, releases locks, and keeps awaiting the live TUI.
- New routine Spaces are created without stealing focus and immediately moved to Herdr list position 1 through the native `workspace.move` socket API. The returned order is verified and recorded; ordering failure is visible but non-fatal to the routine. Live proof moved community Space `w1D` to the top.
- `src/targets/prime-sessions.js` supplies the active-branch latest-turn reader used for deterministic settlement. No prompt bodies enter receipts and no prompt is submitted through shell/stdin/`@file` or replayed.
- AIM does not force `PRIME_AGENT_LAUNCHER_PATH`; the existing wrapper safely selects the client matching the busy daemon. Other Prime sessions remain running. No daemon restart, takeover answer, Prime/Herdr source change, PTY layer, or supervisor is used.
- Focused runner tests pass 11/11 and lint passes. Manual and natural Sonnet acceptance both passed with same-session follow-ups; completed test Spaces are closed after proof.
- Amir confirmed all matching Desktop tasks off. The owner-only LaunchAgents for `rpokerskill`, `community-sweep`, and `morning-report` are installed and loaded with schedules 15:00, 07:00/17:00, and 06:00; `morning-report` was activated last.
- The requested manual `community-sweep` fire created `w1D`, exact Fable/xhigh session `01a0064f-752f-70ae-9f59-810d45d31cce`, admitted the production prompt once, and remains a live interactive TUI. Amir confirmed it is working.

Production rollback remains per-routine AIM bootout/uninstall. AIM never changes Claude Desktop state.
<!-- arch_skill:block:implementation_audit:end -->
