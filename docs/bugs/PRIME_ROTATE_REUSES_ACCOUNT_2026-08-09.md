---
title: Repeated Prime rotating resumes reuse the same account
date: 2026-08-09
status: fixed
owners: [aimgr]
reviewers: []
related:
  - docs/bugs/prime-rotate-resume-provider.md
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** three `aim prime resume <same-session> --rotate` commands all selected Anthropic `pro2`.
- **Impact:** repeated forks concentrate fresh usage on one account while provider usage telemetry is still stale.
- **Most likely cause:** rotation excludes only the source session binding (`pro7`) and independently reruns the same least-used ranking each time; it has no short cycle across recent rotation selections.
- **Fix:** successful Prime rotations now form a tiny provider-local cycle using existing pool history; the live binding and source binding are both avoided before reuse.
- **Status:** fixed

<!-- bugs:block:analysis -->
## Bug North Star

Repeated rotating resumes from the same Prime session spread across the eligible alternate accounts before reusing one, without adding auth receipts, reservations, or another state machine.

## Evidence

- Shell history shows three consecutive rotations of session `019fe167-ebc3-7492-b368-f778dd520579`.
- That source session records provider `anthropic`, model `claude-fable-5`, and AIM binding `pro7`.
- Live Prime auth after the report has Anthropic binding `pro2`, matching the reported repeated destination.
- `handleResume` passes the source binding as the only current label to `handleUse`.
- Claude automatic selection excludes that one label and otherwise ranks the same usage snapshot. Until provider telemetry catches up, every invocation chooses the same lowest-ranked alternate.

## Investigation

This is deterministic rather than random: identical source, eligible set, locks, and stale usage produce the identical winner. The prior fix correctly preserved provider/model and excluded the source account, but did not define repeated-rotation spread.

## Scope and simplicity contract

- **Human-authorized corrected behavior:** repeated `--rotate` resumes must not all land on the same alternate and exhaust its window.
- **Smallest sufficient fix:** record successful Prime rotation selections in the existing provider pool history; avoid the most recently used distinct alternatives until every currently selectable alternative has had a turn; then start the cycle again.
- **Initial minimal convergence closure:** apply the same cycle to Codex and Anthropic because `--rotate` is provider-preserving. No other command uses the cycle.
- **Scope freeze:** frozen before implementation.
- **Enough proof:** three same-source rotations with equal/stale usage choose three distinct alternatives when available; a smaller pool alternates and a single-alternate pool still works.
- **Do not build:** no ownership receipt, pending transition, Redis reservation, session scanner, daemon, timer, or usage prediction.
- **Accepted residual risk:** separate machines keep independent rotation cycles; truly ineligible or locked accounts remain excluded.

<!-- bugs:block:fix_plan -->
## Fix plan

1. Read recent successful Prime rotation labels from the existing provider history.
2. During provider-specific ranking, avoid the last `alternatives - 1` distinct labels, while always excluding the source binding.
3. Include the currently installed live binding so the first run after upgrade immediately moves away from `pro2`.
4. Append one history entry only after a successful auth switch.
5. Add focused Claude and Codex cycle tests.

<!-- bugs:block:implementation -->
## Implementation and verification

Implemented the rotation cycle without adding new coordination machinery:

- `handleResume` marks only rotating Prime resumes for cycle-aware selection.
- The selector always excludes the source session binding when an alternative exists.
- Recent successful provider-local rotation entries suppress recently selected alternatives until the selectable pool has had a turn.
- Each successful entry also records the previous live binding, so the first run after upgrade immediately avoids the currently hot account.
- The same small selection helper is used by Anthropic and Codex; ordinary `prime use`, `pi use`, and other pool selection behavior is unchanged.
- The history entry is written only after the auth transaction succeeds.

Regression coverage exercises three repeated resumes with equal/stale usage for both providers. In each case, the live account is avoided immediately and three distinct alternates are selected before reuse. Existing single-alternate and no-alternate behavior remains covered.

Verification:

- `npm test`: 360/360 passing.
- `npm run lint`: passing.
