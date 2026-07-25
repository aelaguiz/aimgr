---
title: "AIM Claude automatic run selection"
date: 2026-07-24
status: complete
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related: []
---

# TL;DR

Add these two short launch forms:

```text
aim claude run opus [--resume]
aim claude run fable [--resume]
```

Each command refreshes the existing Redis-backed Claude usage view, excludes
accounts with an active shared credential lease, selects the usable account
with the preset's intended metric, and launches through the existing managed
Claude run path. `fable` ranks the Fable/Sonnet weekly-scoped window; `opus`
keeps the shared five-hour ranking.

Explicit account launches such as `aim claude run pro7 opus` remain unchanged.

Worklog:
[AIM_CLAUDE_AUTO_SELECT_RUN_2026-07-24_WORKLOG.md](./AIM_CLAUDE_AUTO_SELECT_RUN_2026-07-24_WORKLOG.md)

## North Star

### Claim

Amir can choose only the model preset and let AIM select the least-used Claude
account that is not already in use on another machine.

### In scope

- Support `aim claude run opus` and `aim claude run fable`.
- Preserve optional `--resume`.
- Reuse the canonical Redis Claude usage status, including live lease state.
- Select the unlocked usable Fable account by Fable/Sonnet weekly-scoped used
  percent, then five-hour usage and label.
- Preserve the unlocked usable Opus account ranking by five-hour used percent
  and label.
- Reuse the existing account-specific projection, lease, rotation, and Claude
  launch path after selection.

### Out of scope

- Changing explicit-label launch behavior.
- A new allocator, persisted assignment, preference, daemon, or retry loop.
- Selecting from expired, unavailable, rate-limited, or locked accounts.
- Changing `aim claude status`, account rotation, credentials, or Redis schema.
- Making bare `aim claude run` choose a default model.

### Definition of done

- Both short forms expand to the existing exact Opus/Fable arguments.
- A locked account is never selected even when it has the lowest usage.
- Fable and Opus can select different accounts from the same usage snapshot.
- Fable ranks by Fable/Sonnet usage, then five-hour usage and label; Opus ranks
  by five-hour usage and label.
- No eligible account fails before Claude projection or launch.
- Focused parser, selector, and fake-Redis launch tests pass.
- Lint and the full suite pass before local installation.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: `opus` expands to
  `--dangerously-skip-permissions --model opus --effort max`.
- R2: `fable` expands to
  `--dangerously-skip-permissions --model claude-fable-5 --effort xhigh`.
- R3: Automatic selection requests the canonical usage status with
  `fresh: true`; no second usage implementation is allowed.
- R4: Eligible means `authState: "usage_readable"`, `locked !== true`, and a
  finite session/five-hour usage percentage below 100. Fable additionally
  requires a finite Fable/Sonnet weekly-scoped percentage below 100; missing
  Fable usage is unknown, never zero. The provider's `active` flag ranks the
  currently binding limit and does not invalidate an otherwise current
  measurement.
- R5: For `fable`, sort by Fable/Sonnet used percentage, then five-hour used
  percentage, then normalized label. For `opus`, sort by five-hour used
  percentage, then normalized label.
- R6: The selected label is passed into the existing `handleRedisClaudeRun`;
  that path remains the authority for lease acquisition and launch.
- R7: `aim claude run <label> opus|fable [--resume]` and the explicit
  `-- <claude args...>` form retain their current behavior.
- R8: A lease acquired after selection remains a normal fail-closed contention
  error; this feature does not add speculative retries.
- Deterministic CLI code is the correct lever; no prompt or model behavior is
  involved.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: choose `opus` or `fable` without supplying an
  account; AIM picks the non-locked account with the lowest usage and starts
  Claude.
- Smallest sufficient solution: extend the existing preset parser, add one
  pure selector over the existing usage-status result, and route the chosen
  label into the existing run owner.
- Initial minimal convergence closure: none. The usage collector and managed
  run path already own their contracts.
- Scope freeze: the requirements and two phases below are frozen before the
  first implementation edit.
- Enough proof: parser assertions, a pure selector test, one fake-Redis CLI
  launch proving a locked lower-usage account is skipped, then lint/full suite.
- Do not build: every item in North Star / Out of scope.
- Accepted residual risk: a different process can acquire the selected lease
  between status collection and run acquisition; the existing lease guard
  rejects that race and the operator reruns the command.

## Operator Scope Amendment — Model-specific selection

On 2026-07-24 the operator clarified and approved the exact rule:

```text
Fable ranks by Fable usage; Opus ranks by shared five-hour usage.
```

This amendment supersedes the earlier five-hour-only ranking and the earlier
exclusion of model-specific selection. The implementation boundary remains the
existing parser signal, pure selector, command routing, help text, and focused
tests. No other scope is reopened.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- `src/cli/args.js` already owns exact Opus/Fable preset expansion.
- `collectClaudeRedisAccountUsageStatus` already returns normalized account
  usage, `authState`, and live Redis `locked` state.
- Claude's normalized five-hour window is identified by `kind: "session"` or
  label `5h`.
- `handleRedisClaudeRun` already owns credential lease acquisition, projection,
  official-client launch, rotation publication, and cleanup for one label.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

Preset parsing requires an account label before `opus` or `fable`.
`handleRedisClaudeRun` then normalizes that label and performs the complete
managed launch. Usage status and shared lease visibility exist, but no Claude
run caller uses them for automatic selection.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

The parser distinguishes the two label-free preset forms. The Claude command
handler obtains the canonical fresh usage result and asks one pure selector for
a label. It rewrites only the in-memory positional label and calls the existing
run owner. Explicit-label callers bypass selection exactly as before.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `src/cli/args.js` — recognize label-free preset forms.
- `src/status/claude-redis-view.js` — own the pure unlocked/lowest-5h selector.
- `src/cli/commands/claude.js` — collect fresh usage for automatic forms and
  pass the selected label to the existing run path.
- `src/cli/help.js`, `README.md` — expose the two short forms.
- Existing Claude parser, Redis usage-view, and projection-command tests —
  prove parsing, ranking, and end-to-end launch wiring.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Implementation Plan

### Phase 1 — Select and launch

- Add label-free preset parsing.
- Add the pure unlocked lowest-five-hour selector.
- Route automatic forms through fresh canonical status and the existing label
  run owner.

### Phase 2 — Prove and install

- Add focused parser, selector, no-eligible, and fake-Redis launch coverage.
- Update help/README.
- Run focused tests, lint, full suite, and install the proven CLI locally.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

PASS. Every planned edit directly implements the requested short launch forms.
The design reuses both existing authorities—Claude usage/locks and managed
label launch—and adds no allocation state, background process, retry
orchestration, new credential behavior, or model-specific policy. The
post-status lease race is explicitly left to the existing fail-closed lease
guard. Scope is frozen.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

PASS.

- R1–R2: `src/cli/args.js` recognizes both label-free presets and expands them
  to the same frozen argument arrays used by explicit-label runs, including
  optional `--resume`.
- R3–R6: `handleClaude` requests the canonical usage view with `fresh: true`,
  passes the preserved automatic preset to
  `selectLeastUsedUnlockedClaudeAccount`, and routes the selected label into
  the unchanged `handleRedisClaudeRun` owner. Fable ranks its scoped window;
  Opus preserves the shared five-hour ranking.
- R4 was verified against the live provider shape: Anthropic can mark a valid
  current five-hour window `active: false` when another limit is binding. The
  selector correctly treats that as priority metadata, not invalid usage.
- R5: Fable usage sorts first, then five-hour usage and label. Opus sorts by
  five-hour usage and label. Missing Fable usage is excluded rather than
  treated as zero.
- R7–R8: focused parsing keeps explicit-label and explicit-passthrough forms
  unchanged; the existing lease guard remains authoritative after selection.
- Focused proof: 54/54 parser, usage-view, and fake-Redis projection tests
  passed. The integration test held a lease on the 0% account and proved
  Fable selected the account with 10% Fable usage despite its worse 70%
  five-hour usage, with exact Fable arguments.
- Repository proof: lint passed and the full suite passed 362/362.
- Live read-only proof: current Redis/provider status reported eight locked
  labels and five readable unlocked labels; the selector chose `claudalyst` at
  0% without launching Claude.
- Local deployment proof: `npm run install:local` installed the canonical
  wrappers and installed help exposes both short forms.
- Final scope audit: no allocator, persistent selection state, daemon, retry
  loop, credential change, Redis schema change, or explicit-label behavior
  change was added. The only new policy is the operator-approved Fable ranking
  metric.
<!-- arch_skill:block:implementation_audit:end -->
