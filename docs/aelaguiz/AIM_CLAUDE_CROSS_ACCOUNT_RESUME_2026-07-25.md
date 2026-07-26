---
title: "AIM Claude cross-account resume"
date: 2026-07-25
status: complete
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

`aim claude resume <row-or-thread-id> --switch-account fable|opus` explicitly
skips the recorded account and immediately uses the same fork path. `fable`
ranks alternatives by Fable usage; `opus` ranks them by shared five-hour usage.

Worklog:
[AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25_WORKLOG.md](./AIM_CLAUDE_CROSS_ACCOUNT_RESUME_2026-07-25_WORKLOG.md)

## North Star

### Claim

Amir can run `aim claude resume <selector>` even when the session's recorded
Claude account is busy, provided another healthy account is unlocked. The
result is visibly a fork with source provenance. Amir can also request that
fork before the source account is busy by adding
`--switch-account fable|opus`.

### In scope

- Preserve direct resume on the recorded account when it is available.
- On that account's credential-busy error, choose the least-used unlocked Opus
  account using AIM's existing automatic-selection policy.
- Stage the selected transcript and companion directory in the destination
  managed home only for launch.
- Use Claude's native `--fork-session` and `--name` capabilities.
- Retain the new fork under the destination account and remove the staged
  source copy after Claude exits or launch fails.
- Add one explicit `--switch-account fable|opus` resume option that skips the
  recorded account and selects by the requested preset's existing ranking.

### Out of scope

- Concurrent use of one credential, lease bypasses, or OAuth changes.
- A shared transcript store, session database, migration, daemon, or cleanup
  service.
- Cross-machine transcript transfer.
- Any new CLI option beyond `--switch-account fable|opus`, configurable naming,
  an interactive account picker, or arbitrary model selection.
- Recovering an orphan left by an uncatchable process kill.

### Definition of done

- Free recorded account: existing account, thread ID, working directory, and
  Opus arguments remain unchanged.
- Busy recorded account: the least-used unlocked Opus account launches a
  distinct fork with the exact provenance name.
- The original transcript is unchanged; the temporary destination copy is
  removed; the new fork persists.
- No unlocked destination produces a clear safe failure.
- Explicit Fable/Opus switching skips the recorded account even when it is free,
  uses the matching preset and ranking, and fails safely when no alternative
  exists.
- Focused tests, lint, `git diff --check`, and the full suite pass. The prior
  real AIM/OAuth fork proof remains authoritative for the unchanged staging and
  native Claude boundary.

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
- R8: `--switch-account` accepts exactly `fable` or `opus` and is valid only on
  `aim claude resume`.
- R9: Explicit switching never attempts to acquire the recorded account. It
  excludes that label before selecting an alternative.
- R10: Fable switching uses the existing Fable/Sonnet ranking and Fable launch
  preset; Opus switching uses the existing five-hour ranking and Opus preset.
- R11: Explicit switching reuses the same provenance, staging, native
  `--fork-session`, cleanup, and destination lease path as busy fallback.

Defaults: no flag preserves automatic busy-only Opus fallback; explicit
switching requires a preset; no compatibility path and no lease bypass.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- **Human-authorized outcome:** retain the shipped busy-account fork behavior
  and add one way to resume a rate-limited session on a different account,
  selected for Fable or Opus usage, with a mini-plan, implementation, and tests.
- **Smallest sufficient solution:** one parsed resume option that enters the
  existing cross-account fork branch before the direct launch and supplies the
  requested existing selector and launch preset.
- **Initial minimal convergence closure:** factor the existing automatic Claude
  account selection call inside `src/cli/commands/claude.js` so automatic run
  and busy-resume fallback cannot define different ranking behavior.
- **Scope freeze:** only resume option parsing, orchestration through the
  existing fork path, help/README text, focused tests, and this doc/worklog are
  authorized for the explicit-switch delta.
- **Enough proof:** unflagged direct-path regression, explicit Fable selection
  when it differs from five-hour selection, exact Fable fork arguments,
  invalid-option rejection, no-alternative failure, focused tests, lint,
  `git diff --check`, and full suite.
- **Do not build:** shared storage, registries, additional options, an account
  picker, retry engines, background cleanup, remote session sync, credential
  concurrency, or a second fork implementation.
- **Accepted residual risk:** an uncatchable kill can leave the exact staged
  source copy in the destination home; AIM will refuse to overwrite it rather
  than guessing that it is safe to delete.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- `src/cli/commands/claude.js` first passes `session.account` to
  `handleRedisClaudeRun`; a busy lease triggers the shipped Opus fork path
  before credential projection or Claude launch.
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
- `selectLeastUsedUnlockedClaudeAccount` already supports both required
  policies: Fable/Sonnet usage with five-hour tie-breaking for `fable`, and
  shared five-hour usage for `opus`.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`handleClaude` resolves the selected transcript, validates Redis, and invokes
`handleRedisClaudeRun` with the transcript's recorded account. The run owner
acquires that account's Redis credential lease and fails immediately when
another process holds it. Session files remain isolated below each managed
account's `.claude/projects` tree, so another account cannot resolve the UUID
without a staged copy.

There is no explicit way to choose a new account while the recorded account is
still unlocked, so rate-limited sessions take the direct path and reopen on the
same quota.
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

When `--switch-account fable|opus` is present, `handleClaude` skips the direct
attempt and enters that same fork branch with the requested selector and preset
arguments. Without the option, the current direct and busy-fallback behavior is
unchanged.
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
- `src/cli/args.js`
  - parse and validate the single resume-only `--switch-account` option.
- `src/cli/help.js` and `README.md`
  - document the exact explicit-switch command.
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

### Phase 2 — Explicit preset-aware switch

- Parse `--switch-account fable|opus` only for Claude resume.
- Route it directly through the existing selection and native fork path,
  excluding the recorded account and using the matching preset arguments.
- Preserve unflagged direct resume and busy-only Opus fallback unchanged.

### Phase 3 — Proof

- Add focused integration coverage for explicit Fable ranking/arguments,
  invalid option values, and no-alternative failure.
- Run focused CLI tests, lint, `git diff --check`, and the full suite.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

`PASS`. The amended plan has three phases and the new phase maps exactly to the
explicit request to move a resumed session to different Fable or Opus quota.
It reuses the shipped selector, staging, naming, native fork, cleanup, and lease
owners. The no-flag path remains authoritative. No new storage, picker,
selection policy, concurrency behavior, or runtime service is authorized.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

Prior busy-fallback implementation: `PASS`.

- `src/cli/commands/claude.js` preserves direct resume, catches only the
  credential-busy result, reuses the existing Opus selector, excludes the
  source account, and launches the destination through the existing lease and
  rotation owner.
- `src/targets/claude-sessions.js` owns deterministic provenance, stable
  source staging, companion copying, collision refusal, a private marker that
  hides the temporary duplicate, and exact cleanup.
- Focused tests passed 4/4 and 22/22; lint and `git diff --check` passed; the
  full suite passed 369/369.
- The real installed command produced provenance fork
  `92ae17a3-54fe-4d2f-9448-fad2dd8bc518` on `pro11`, preserved the source hash,
  removed the staged source/marker, retained the fork, and released the
  destination lease.
- Commit `b351576` was installed and smoke-tested on Amir-M5,
  Amirs-M3-Max-2, Mac Studio, home, and claw. No out-of-scope session service,
  CLI option, retry engine, daemon, migration, or credential behavior was
  added.

Explicit `--switch-account fable|opus` delta: `PASS`.

- `src/cli/args.js` accepts only `fable` or `opus` on Claude resume and rejects
  missing, invalid, and unrelated-command use before Redis or launch work.
- `src/cli/commands/claude.js` skips the direct source launch only when the
  option is present, excludes the source label, selects through the existing
  preset-aware policy, and reuses the existing fork/staging/cleanup path with
  the matching preset arguments.
- The explicit Fable integration proof kept the source account unlocked, made
  Fable and five-hour rankings disagree, selected the Fable-low alternative,
  used the exact Fable/native-fork arguments, preserved the source, and removed
  the staged copy.
- Focused suites passed 17/17 and 23/23; lint and `git diff --check` passed; the
  full suite passed 371/371.
- Final scope audit found no new storage, selector, picker, lease behavior,
  concurrency path, daemon, or fork implementation.
<!-- arch_skill:block:implementation_audit:end -->
