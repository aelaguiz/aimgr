---
title: "Claude auto-select rejects READY accounts during usage refresh"
date: 2026-08-07
status: resolved
owners:
  - aelaguiz
reviewers: []
related:
  - docs/aelaguiz/AIM_CLAUDE_REDIS_AUTHORITY_SIMPLIFICATION_2026-08-03.md
  - docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md
---

<!-- bugs:block:tldr:start -->
# TL;DR

- **Symptom:** `aim claude status` can report unlocked accounts as `READY` with readable cached five-hour usage while `aim claude run opus` immediately says no unlocked account with readable five-hour usage exists.
- **Impact:** automatic Claude launch is spuriously blocked even though the status surface says accounts can be used now.
- **Most likely cause:** a concurrent/still-running usage refresh projects cached usage with `authState: refresh_in_progress`; the human renderer classifies the Redis credential plus free lease as `READY`, but the selector admits only `authState: usage_readable`.
- **Next action:** none; the selector and regression proof are complete.
- **Status:** Resolved.
<!-- bugs:block:tldr:end -->

<!-- bugs:block:analysis:start -->
# Analysis

## Bug North Star

When `aim claude status` says an account is `READY` / `use now` and exposes a usable cached ranking window, automatic `opus` or `fable` selection must not reject that account merely because another process is refreshing the same usage cache.

## Bug summary

The status collector intentionally single-flights provider refreshes. A losing caller receives `refresh_in_progress` plus still-usable cached usage. That transitional telemetry state is not a credential or lease failure. The default renderer correctly treats the complete Redis credential and free Redis lease as launchable, but the pure automatic selector still uses the older telemetry-as-authorization rule.

## Evidence

1. Operator repro on 2026-08-07:
   - `aim claude status` reported `18 ready`, `0 in use`, and multiple `0%` five-hour rows.
   - `aim claude run opus` returned `No unlocked Claude account with readable five-hour usage is available.`
2. Deterministic source-level repro against the current checkout:
   - An unlocked, credential-ready account with `authState: refresh_in_progress` and cached `5h: 0%` renders `READY ... use now`.
   - `selectLeastUsedUnlockedClaudeAccount(..., {preset: "opus"})` returns `null` for the same account.
3. Code anchors:
   - `src/status/claude-redis-view.js` `buildRefreshInProgressAccount` retains stale usage and sets `authState: refresh_in_progress` when the cache refresh lock is held elsewhere.
   - The same file's `describeClaudeOperatorState` uses Redis credential readiness plus `locked === false` to render `READY`.
   - The same file's `selectLeastUsedUnlockedClaudeAccount` currently requires `authState === "usage_readable"`, rejecting the transitional row before examining its cached ranking windows.
4. Existing architecture decision:
   - `docs/aelaguiz/AIM_CLAUDE_REDIS_AUTHORITY_SIMPLIFICATION_2026-08-03.md:23` requires status and automatic selection to rely on the same launch facts: Redis credential usability plus the active lease.
   - `docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md:504-506,528-530` requires cached usage for selection and says usage telemetry must not erase a valid target.

## Investigation and ranked hypotheses

1. **Confirmed — selector/status eligibility drift during single-flight refresh.** The deterministic repro produces the exact contradiction from one account object.
2. **Rejected — preset parsing loses `opus`.** `parseArgs(["claude", "run", "opus"])` correctly sets `claudeAutoSelectPreset: "opus"` and expands the native model arguments.
3. **Rejected for the captured repro — every account is actually leased.** The operator status reported `0 in use`, and the live read-only JSON status later showed all 18 leases free.
4. **Rejected — missing five-hour windows.** Both the operator table and live JSON include finite five-hour windows below 100%.

## Blast radius

- Affects label-free `aim claude run opus|fable` and automatic account switching/resume paths that share the selector.
- Explicit-label runs do not use this selector.
- No credential, Redis schema, lease, provider probe, ranking formula, or launch-path change is required.

## Scope and Simplicity Contract

| Contract item | Frozen meaning |
|---|---|
| Human-authorized corrected behavior | Resolve the reported contradiction: a status-READY, unlocked account with usable cached ranking usage remains eligible for automatic Claude selection while usage refresh is in progress. |
| Smallest sufficient fix | Replace the selector's telemetry-state authorization check with the canonical launchability facts already present on the account; retain finite-below-100 ranking checks and exclusion of usage-limited accounts. |
| Initial minimal convergence closure | The selector and its focused tests only. Status already expresses the intended launchability contract; the collector already retains bounded cached usage. |
| Scope freeze | Frozen before implementation. |
| Enough proof | A regression test for READY + `refresh_in_progress` + cached usage, preservation of locked/limited/missing-window exclusions, focused Claude tests, lint, and the full test suite. |
| Do-not-build boundary | No retries/waits, cache-policy changes, lock changes, provider refresh changes, new status states, explicit-label changes, or live Claude launch. |
| Accepted residual risk | Automatic selection still cannot rank an account when no finite relevant cached/live usage window exists; post-selection lease contention remains fail-closed in the existing launch owner. |

## Resolution verdict

**Resolved.** The contradictory predicate was isolated and corrected, and the regression proof reproduces the original single-flight state without launching or mutating a live Claude session.
<!-- bugs:block:analysis:end -->

<!-- bugs:block:fix_plan:start -->
# Fix plan

1. Update `selectLeastUsedUnlockedClaudeAccount` to require a usable Redis credential and a confirmed free lease rather than the exact `usage_readable` telemetry state.
2. Continue excluding `usage_limited` and any account whose required ranking windows are missing, non-finite, or exhausted.
3. Extend focused selector coverage with a credential-ready `refresh_in_progress` row backed by stale cached usage; keep locked and limited exclusions explicit.
4. Run focused tests, lint, the full suite, and `git diff --check` without installing or launching Claude.
<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->
# Implementation and verification

## What changed

- `src/status/claude-redis-view.js`
  - Automatic selection still accepts the established `usage_readable` shape.
  - It now also accepts other non-limited telemetry states when the account has a usable Redis credential and a confirmed free lease, including `refresh_in_progress` with bounded cached usage.
  - It rejects exhausted active windows before ranking, preserving the existing fail-closed capacity rule.
- `test/claude/redis-usage-view.test.js`
  - Added a pure selector regression for `refresh_in_progress`.
  - Added an integrated single-flight regression: seed cached usage, hold one provider refresh, collect concurrently, and prove the concurrent READY account is selected without a duplicate provider request.
  - Preserved locked, usage-limited, missing-window, and credential-unavailable exclusions.

## Verification

- Deterministic before/after repro:
  - Before: the same READY row rendered `use now` but selected `null`.
  - After: it selects `{label: "ready", usedPercent: 0}`.
- `node --test test/claude/redis-usage-view.test.js`: **22/22 passed**.
- `node --test test/pi/prime-target.test.js`: **14/14 passed**.
- `npm run lint`: **passed**.
- `npm test`: **359/359 passed**.
- `git diff --check`: **passed**.

No live Claude process was launched, no credential/Redis state was mutated, and no local install was required because the installed `aim` wrapper executes this checkout directly.

## Outcome

Resolved. A usage-cache single-flight refresh can no longer turn readable bounded cached usage into a false “no unlocked account” result when the account's canonical credential and lease facts say it is launchable.
<!-- bugs:block:implementation:end -->
