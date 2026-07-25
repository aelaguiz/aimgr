---
title: "AIM Claude cross-account resume"
date: 2026-07-25
status: active
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related:
  - ./AIM_CLAUDE_RECENT_SESSIONS_2026-07-24.md
---

# TL;DR

`aim claude resume <row-or-thread-id>` keeps its current same-account behavior
when the recorded account is free. If that account is busy, AIM selects the
least-used unlocked Opus account, stages a read-only snapshot of the source
transcript, and asks Claude to create a distinct fork named:

```text
[fork from <source-account>/<source-id-8>] <source-title-or-id>
```

The original transcript and active process remain untouched. AIM never bypasses
credential leases.

Worklog:
[AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25_WORKLOG.md](./AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25_WORKLOG.md)

## North Star

### Claim

Amir can run `aim claude resume <selector>` even when the session's recorded
Claude account is busy, provided another healthy account is unlocked. The
result is visibly a fork with source provenance.

### In scope

- Preserve direct resume on the recorded account when it is available.
- On that account's credential-busy error, choose the least-used unlocked Opus
  account using AIM's existing automatic-selection policy.
- Stage the selected transcript and companion directory in the destination
  managed home only for launch.
- Use Claude's native `--fork-session` and `--name` capabilities.
- Retain the new fork under the destination account and remove the staged
  source copy after Claude exits or launch fails.

### Out of scope

- Concurrent use of one credential, lease bypasses, or OAuth changes.
- A shared transcript store, session database, migration, daemon, or cleanup
  service.
- Cross-machine transcript transfer.
- New CLI flags, configurable naming, model selection, or Fable resume.
- Recovering an orphan left by an uncatchable process kill.

### Definition of done

- Free recorded account: existing account, thread ID, working directory, and
  Opus arguments remain unchanged.
- Busy recorded account: the least-used unlocked Opus account launches a
  distinct fork with the exact provenance name.
- The original transcript is unchanged; the temporary destination copy is
  removed; the new fork persists.
- No unlocked destination produces a clear safe failure.
- Focused tests, lint, full suite, one live AIM/OAuth proof, local install, and
  fleet deployment pass.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: Busy fallback triggers only for `AIMGR_CREDENTIAL_BUSY`; every other
  original-account failure remains authoritative.
- R2: Destination selection reuses `selectLeastUsedUnlockedClaudeAccount` with
  the `opus` preset and excludes the source account.
- R3: The provenance name is deterministic:
  `[fork from <account>/<first-8-of-thread-id>] <thread-name-or-full-id>`.
- R4: The destination receives Claude arguments
  `--resume <source-id> --fork-session --name <provenance-name>` after the
  existing Opus preset.
- R5: Staging refuses to overwrite an existing destination transcript or
  companion directory and cleans only paths it created.
- R6: If the source transcript changes while being staged, AIM fails instead
  of launching a questionable snapshot.
- R7: The new fork is normal destination-account session history. Only the
  temporary source-ID copy is removed.

Defaults: automatic fallback, Opus ranking, no new user choice, no compatibility
path, and no lease bypass.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- **Human-authorized outcome:** resume any listed local session when its
  recorded account is in use, retain explicit fork provenance, plan tightly,
  implement, test, and deploy.
- **Smallest sufficient solution:** one busy-error branch in the existing
  resume command plus one transcript-staging owner beside the existing session
  reader, using Claude's proven native fork/name flags.
- **Initial minimal convergence closure:** factor the existing automatic Claude
  account selection call inside `src/cli/commands/claude.js` so automatic run
  and busy-resume fallback cannot define different ranking behavior.
- **Scope freeze:** only resume orchestration, session staging, their focused
  tests, this doc/worklog, and deployment are authorized.
- **Enough proof:** direct-path regression, busy-path selection/arguments,
  source immutability, stage cleanup, retained fork, no-destination failure,
  focused tests, lint, full suite, and one real live command.
- **Do not build:** shared storage, registries, new options, retry engines,
  background cleanup, remote session sync, or credential concurrency.
- **Accepted residual risk:** an uncatchable kill can leave the exact staged
  source copy in the destination home; AIM will refuse to overwrite it rather
  than guessing that it is safe to delete.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- `src/cli/commands/claude.js` currently resolves a session and always passes
  `session.account` to `handleRedisClaudeRun`; the lease failure occurs before
  credential projection or Claude launch.
- `src/targets/claude-sessions.js` already owns discovery, thread identity,
  title precedence, account ownership, and working-directory validation.
- Claude Code `2.1.219` exposes native `--fork-session` and `--name`.
- A contained real-binary probe copied a real transcript into another config
  root, loaded inherited context, created a distinct thread ID, persisted the
  provenance title, and left the source hash unchanged.
- A real AIM/OAuth proof then forked
  `pro10/fcb28534-a7d5-4774-8546-2d9f64ae4ec6` onto `pro11` as
  `89f2b2b8-11bd-4dbc-bf5b-1d8246e6d05c`; Claude consumed 40,167 cached-context
  tokens, `aim claude list` showed the exact provenance title, and the source
  hash remained unchanged.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`handleClaude` resolves the selected transcript, validates Redis, and invokes
`handleRedisClaudeRun` with the transcript's recorded account. The run owner
acquires that account's Redis credential lease and fails immediately when
another process holds it. Session files remain isolated below each managed
account's `.claude/projects` tree, so another account cannot resolve the UUID
without a staged copy.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

The recorded account remains the first and authoritative launch attempt. Only
its credential-busy result activates fallback. AIM refreshes its existing
account-usage view, selects the least-used unlocked Opus account excluding the
source, and invokes the same run owner with fork metadata. After the destination
lease is acquired, the session owner stages the source transcript and optional
companion directory. Claude launches with native fork/name arguments. AIM's
existing run `finally` path removes the staged source while retaining Claude's
new thread.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `src/cli/commands/claude.js`
  - `handleClaude`: direct attempt, busy-only fallback, destination selection,
    provenance arguments, and user-facing fallback line.
  - `handleRedisClaudeRun`: stage after destination lease acquisition and clean
    during its existing lifecycle cleanup.
  - automatic `claude run opus|fable`: reuse the factored selection helper with
    no behavior change.
- `src/targets/claude-sessions.js`
  - expose the resolved transcript path internally.
  - own safe stage/cleanup for a cross-account fork.
- `test/cli/redis-projection-command.test.js`
  - direct resume regression and busy fallback integration.
- `test/claude/claude-sessions.test.js`
  - staging collision, stability, provenance, and cleanup behavior where
    focused unit coverage is clearer.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Phase Plan

### Phase 1 — Busy-only fork path

- Add safe session staging/cleanup and deterministic provenance naming.
- Keep direct resume unchanged.
- Reuse automatic Opus selection after the recorded-account busy error.
- Launch the destination with native fork/name flags and clean the staged
  source in the run lifecycle.

### Phase 2 — Proof and deployment

- Run focused session and CLI tests, lint, `git diff --check`, and the full
  suite.
- Run one real local AIM/OAuth busy-account resume proof and verify list
  provenance, original integrity, destination health, and cleanup.
- Install locally, commit/push `main`, fast-forward the fleet, install there,
  and run read-only smoke checks.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

`PASS`. The plan has two phases and every item maps to the explicit human
outcome or the frozen selection-helper convergence closure. It uses Claude's
proven native capabilities instead of a session service. The original direct
path and credential lease remain authoritative. Tests exercise behavior and
cleanup rather than adding repo-policing machinery. The only accepted
unhandled case is an uncatchable process kill, which fails closed on the next
attempt.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

Pending finish mode.
<!-- arch_skill:block:implementation_audit:end -->
