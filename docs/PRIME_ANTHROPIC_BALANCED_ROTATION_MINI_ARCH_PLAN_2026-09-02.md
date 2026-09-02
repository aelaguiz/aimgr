---
title: "Prime Anthropic Rotation Regression Fix - Architecture Plan"
date: 2026-09-02
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: architectural_change
related:
  - docs/bugs/PRIME_ROTATE_REUSES_ACCOUNT_2026-08-09.md
  - docs/PRIME_ANTHROPIC_BALANCED_ROTATION_MINI_ARCH_PLAN_2026-09-02_WORKLOG.md
---

# TL;DR

- **Outcome:** repeated Anthropic `aim prime resume <root> --rotate` calls cycle
  through eligible accounts instead of bouncing between the same two labels.
- **Problem:** the seamless-handoff rewrite kept the existing cycle helper but
  replaced its history input with `[]`, so only the current label is excluded.
- **Approach:** collect accepted Anthropic bindings while reading the root's
  existing active branch and feed those labels to the existing cycle helper.
- **Plan:** make the two-line data-flow repair and add one repeated-rotation
  regression test that appends the same binding record as a successful handoff.
- **Non-negotiables:** no randomness, capacity frontier, ranking refactor, new
  state store, other-provider behavior change, help rewrite, or test framework.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
research: complete
deep_dive_pass_1: complete
phase_plan: complete
recommended_flow: implement
note: The user explicitly narrowed the previously approved design to the regression fix only on 2026-09-02.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

With three or more eligible Anthropic accounts and unchanged usage, repeatedly
rotating the same Prime root does not select a recently used alternate until
the other selectable alternatives have had a turn.

## 0.2 In scope

- Anthropic `aim prime resume <root> --rotate` only.
- Successful binding labels already present on that root's active JSONL branch.
- The existing least-used selector and recent-cycle helper.
- One focused behavior-level regression test.

## 0.3 Out of scope

- Random selection, capacity bands, candidate-ranking refactors, or thresholds.
- Codex, xAI, `prime run`, `prime use`, managed Claude, or plain resume changes.
- New persistence, Redis schema, reservations, fleet scans, flags, or telemetry.
- README/help changes or broad test expansion.

## 0.4 Definition of done (acceptance evidence)

- A same-root Anthropic rotation sequence with at least three accounts advances
  beyond the prior two-label loop.
- Each selection remains the least-used currently selectable, non-recent label.
- Existing single-rotation, failed-handoff, and no-alternate tests stay green.
- The focused Prime target test file passes.

### Scope and Simplicity Contract

- **Human-authorized outcome:** fix the confirmed Anthropic rotate regression
  without going past the fix.
- **Authorization anchors:** the 2026-09-02 reports of `boss <-> pro13`, followed
  by "if it's a regression just fix it" and explicit `$startup-pragmatism` use.
- **Smallest sufficient solution:** return active-provider binding history from
  the existing Prime profile read and pass it to the existing cycle helper.
- **Initial minimal convergence closure:** none; the canonical helpers already
  exist and only their disconnected data flow is repaired.
- **Scope sign-off:** regression-only boundary approved by the user on
  2026-09-02 before code edits.
- **Enough proof:** one repeated-rotation integration test plus the existing
  Prime target tests.
- **Do not build:** randomness, frontier math, exported ranking primitives,
  configuration, new ledgers, cross-root coordination, extra test categories.
- **Residual risk accepted by this plan:** separate roots may choose the same
  least-used label; changing that would be a new randomized-placement feature.

## 0.5 Key invariants (fix immediately if violated)

- The current binding is still excluded.
- Only AIM credential bindings on the resolved root's active branch count.
- Failed handoffs do not create history because Prime appends no binding record.
- Existing usage, lock, exhaustion, and model-preset rules remain unchanged.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Restore the removed recent-cycle input.
2. Preserve seamless in-place handoff behavior.
3. Keep the diff and test surface minimal.

## 1.2 Constraints

- No new durable writer: Prime's accepted binding record is already authoritative.
- Ordinary Claude selection must retain its empty-history behavior.
- The returned profile field must remain non-secret and additive.

## 1.3 Architectural principles (rules we will enforce)

- Reconnect existing owners instead of introducing a selection subsystem.
- Keep selection deterministic: least used among alternatives not in the recent
  cycle; fall back through the existing selector chain.

## 1.4 Known tradeoffs (explicit)

This restores the prior cycle contract, not the previously proposed random
near-free policy. A later random-placement feature would need separate intent.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

`readPrimeSessionProfile()` already walks the root's active branch and keeps the
latest binding. `selectClaudePreset()` already invokes
`buildRecentSelectionCycleAvoidLabels()`.

## 2.2 What's broken / missing (concrete)

The selector passes `recentLabels: []`. After an in-place handoff, the new
binding becomes the source, so stable usage produces `boss -> pro13 -> boss`.

## 2.3 Constraints implied by the problem

The repair must preserve the handoff and derive history from records it already
writes successfully, rather than reviving the old AIM local-state ledger.

# 3) Research Grounding (external + internal ground truth)

## 3.1 External anchors

None needed; repository history fully defines the regression.

## 3.2 Internal ground truth

- Commit `98f8f40` added recent-account cycling and repeated-rotation tests.
- Commit `bb73bb2` introduced safer in-place handoff but removed history wiring
  and those tests, leaving the helper call with an empty history array.
- `src/targets/prime-sessions.js` already filters to the active branch.
- `src/cli/commands/harness-target.js` already owns Anthropic selection and the
  cycle helper call.

## 3.3 Decision gaps that must be resolved before implementation

None. The user explicitly chose regression restoration over the broader design.

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->

```text
active root binding -> exclude current label -> recentLabels=[]
                    -> least used remaining label -> in-place handoff
```

The next invocation sees the destination only as the new source, not as part of
a recent cycle.

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->

```text
active root branch -> current binding + active provider bindingHistory[]
                   -> exclude current label
                   -> existing recent-cycle helper(bindingHistory)
                   -> existing least-used selector -> unchanged handoff
```

The additive `bindingHistory` profile field is the chronological set of accepted
AIM labels encountered on the active branch for the active provider. No API is
removed, no fallback is added, and callers that ignore the field are unchanged.

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->

| Area | File / symbol | Required change | Tests impacted |
|---|---|---|---|
| Profile read | `src/targets/prime-sessions.js` / `readPrimeSessionProfile()` | Collect and return active-provider binding history during the existing branch walk. | `test/pi/prime-target.test.js` |
| Anthropic selection | `src/cli/commands/harness-target.js` / `selectClaudePreset()` | Accept recent labels and replace the literal empty array. | `test/pi/prime-target.test.js` |
| Prime rotate wiring | `src/cli/commands/harness-target.js` / `selectPrimeRotation()` | Pass profile history only for this Anthropic rotate call. | `test/pi/prime-target.test.js` |
| Regression | `test/pi/prime-target.test.js` | Add one repeated same-root handoff sequence. | New focused case |

No migration, delete, help, configuration, Redis, or other-provider change is
required.

<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 - Reconnect Anthropic rotation history

**Status:** COMPLETE

**Goal:** restore the prior recent-account cycle through the current in-place
handoff architecture.

**Work:** collect the root's accepted active-provider binding labels, pass them
to the existing Anthropic cycle helper, and pin the reported sequence.

**Checklist (must all be done):**

- [x] Return active-provider `bindingHistory` from `readPrimeSessionProfile()`.
- [x] Feed that history only to Anthropic Prime rotate selection.
- [x] Add one same-root repeated-rotation regression test.

**Verification (required proof):**

`node --test test/pi/prime-target.test.js`

**Docs/comments (propagation; only if needed):** none.

**Exit criteria (all required):**

- [x] The regression test advances through all eligible labels before reuse.
- [x] Existing Prime rotation tests pass unchanged.
- [x] No out-of-scope source or test file is modified.

**Rollback:** revert the three focused file edits.

<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; evidence planning)

## 8.1 Unit tests (contracts)

No new unit-test category; the behavior is observable at the command boundary.

## 8.2 Integration tests (flows)

One existing-fixture Prime test performs repeated rotates and appends the
successful binding record between invocations.

## 8.3 E2E / device tests (realistic)

Not needed for this reversible CLI regression fix.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

Ship as the normal CLI fix.

## 9.2 Telemetry changes

None.

## 9.3 Operational runbook

None.

# 10) Decision Log (append-only)

## 2026-09-02 - Scope cut (user-approved): restore only the regression

- **Cut:** random selection, the 10-point capacity frontier, exported ranking
  refactor, broad ranking/history tests, and README/help changes.
- **Why it looked necessary:** those additions implemented a broader placement
  policy when the observed behavior traces to a removed history input.
- **Intent evidence checked:** the prior TL;DR, North Star, and two-phase plan;
  commit `98f8f40`; and the current literal `recentLabels: []` call.
- **User approval:** "if it's a regression just fix it. Don't go past the fix,"
  followed by "use `$startup-pragmatism` and don't overbuild past simply fixing."
- **Consequences:** one phase, three code/test files, one focused test, and no
  randomized-placement feature.
