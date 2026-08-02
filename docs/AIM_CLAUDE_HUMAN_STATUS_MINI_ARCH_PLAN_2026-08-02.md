---
title: "AIM Claude Human Status - Mini Architecture Plan"
date: 2026-08-02
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [kimi-code/k3]
doc_type: mini_architecture_plan
related:
  - docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md
  - docs/bugs/CLAUDE_STALE_ROTATION_PENDING_HIDDEN_FROM_STATUS_2026-07-28.md
---

# TL;DR

Make the default Claude status answer one human question: **can I use this
account now, and if not, do I need to act?** Replace the raw default state and
coordination columns with five derived, non-persisted operator states:
`READY`, `IN USE`, `AIM FIXING`, `NEEDS YOU`, and `UNKNOWN`. Keep usage and
reset windows visible. Put the existing technical table behind
`aim claude status --verbose`; keep `--json` unchanged.

This is one presentation-layer cutover. It does not change credentials,
refresh, recovery, selection, Redis, caches, the maintainer, or native Claude
launches.

<!-- arch_skill:block:implementation_audit:start -->
# Implementation Audit (authoritative)
Date: 2026-08-02
Verdict (code): COMPLETE
Manual Verification: pending

## Code blockers (why code is not done)
- None.

## Reopened phases (false-complete fixes)
- None.

## Missing items (code gaps; evidence-anchored; no tables)
- None.

## Manual verification pending (screenshots / human validation)
- Deploy the committed revision through the existing fleet checkouts and run
  one read-only installed status smoke per reachable target.

The shared renderer owns both default text entry points
(`src/status/claude-redis-view.js:1278`, `src/status/render.js:54`); the scoped
flag only selects its retained technical mode (`src/cli/args.js:230`,
`src/cli/commands/claude.js:1261`). The focused state, command, parser, help,
README, and top-level render tests pass 41/41, along with lint and
`git diff --check`. No runtime, credential, Redis, recovery, selection, cache,
or maintainer path changed.
<!-- arch_skill:block:implementation_audit:end -->

<!-- arch_skill:block:planning_passes:start -->

planning_passes:
  mode: one-pass-mini
  internal_grounding: complete
  external_research: not_needed
  independent_kimi_review: pass
  review_reconciliation: complete_no_changes
  scope_freeze: complete
  implementation: code_complete_deployment_pending

<!-- arch_skill:block:planning_passes:end -->

# 0) North Star

## 0.1 Claim

`aim claude status`, its `usage` alias, and the Claude section of `aim status`
show operational truth in ordinary language. Routine access-token expiry must
never look like a dead account or a demand to sign in.

## 0.2 In scope

1. Derive one human state at render time from existing credential, lease,
   rotation, and usage facts.
2. Show a one-line fleet count plus an account table containing the human
   state, existing usage/reset windows, freshness when known, and one short
   next action.
3. Add `--verbose` to `aim claude status|usage` for the current technical table
   and diagnostics.
4. Preserve the current JSON result as the machine/debug source of truth.
5. Update focused tests, CLI help, and the README command contract.

## 0.3 Explicitly out of scope

1. Changing OAuth, credential storage, token refresh, rotation recovery,
   Redis schemas, leases, the auth maintainer, or Claude launch behavior.
2. Changing account auto-selection, usage-cache retention, stale-use policy,
   provider probing, or request counts.
3. Persisting another status field, adding a daemon, adding a status database,
   or creating a generic status/state framework.
4. Adding repair commands or guessing that an account needs login without the
   existing explicit `reauth_required` fact.
5. Redesigning Codex status or unrelated AIM output.

## 0.4 Definition of done

| User-visible result | Done bar |
|---|---|
| Access expiry is not called credential expiry | A complete credential whose Redis access token is past `expiresAt` renders `AIM FIXING`, never `credential_expired` or `NEEDS YOU`. |
| Human action is unambiguous | Only an explicit terminal credential/auth fact renders `NEEDS YOU`, with `aim login <label>` as the action. |
| Live use is obvious | A held lease renders `IN USE` instead of a separate `lock=yes` column. |
| Healthy accounts are obvious | A launchable account with readable or limited usage renders `READY`; usage percentages remain separate from launchability. |
| Internals stay available | `--verbose` renders the prior technical columns and diagnostics; `--json` remains structurally unchanged. |
| Both human entry points agree | Direct Claude status and the Claude block in top-level `aim status` use the same default renderer. |

## 0.5 Invariants

- Rendering is pure: no provider request, Redis write, credential read beyond
  the existing collection path, or local-state mutation.
- Existing `authState`, `credentialState`, lease, rotation, local-projection,
  source, and JSON fields remain canonical facts.
- `READY` promises current launchability, not unused model capacity; the Fable,
  Opus, five-hour, and weekly columns continue to show capacity separately.
- Unknown coordination or usage evidence is never promoted to `READY`.

## 0.6 Scope and Simplicity Contract

| Contract item | Frozen meaning |
|---|---|
| Human-authorized outcome | Amir's 2026-08-02 approval of the five-state human status UX, followed by the instruction to plan, Kimi-review, implement, test, and deploy without overbuilding. |
| Smallest sufficient solution | Two small pure rendering helpers in the existing Claude Redis view, one parser flag, existing renderer call sites, focused tests, and command documentation. |
| Initial minimal convergence closure | `aim claude status`, its `usage` alias, and the Claude table embedded in `aim status` already share `renderClaudeRedisAccountUsageStatus`; change that one owner. No adjacent convergence is required. |
| Scope freeze | Freeze after Kimi K3 passes this plan. Any maintainer, auth, recovery, selection, cache, or new-command change requires new human approval. |
| Enough proof | Focused parser/Claude-status/top-level-status tests, lint, and one local CLI smoke using read-only status. No new harness or live credential mutation. |
| Do-not-build boundary | No persisted operator state, new status service, new recovery command, new cache policy, compatibility renderer, or speculative edge-state framework. |
| Accepted residual risk | Default status can explain only facts already collected. It will say `UNKNOWN` rather than infer a cause when coordination or usage evidence is unavailable. |

# 1) Architecture Decisions

## 1.1 Operational status is a projection, not a new source of truth

The renderer derives a display-only state from the existing account object.
It does not add an `operatorState` field to Redis, local state, cache, or JSON.
This prevents a second state machine from drifting from the canonical facts.

## 1.2 Five states with explicit precedence

The human state precedence is:

1. Held lease: `IN USE` (`session active`).
2. Explicit `reauth_required` or a non-refreshable credential defect:
   `NEEDS YOU` (`aim login <label>`).
3. Pending rotation, `refresh_in_progress`, expired complete access token, or
   stale-access response: `AIM FIXING` (`AIM will retry`).
4. Complete credential plus healthy readable/limited usage: `READY`.
5. Anything whose usability cannot be established: `UNKNOWN` (`retry status`).

The precedence is intentionally not a general transition system. It is one
pure classification for one table row.

## 1.3 Default human table; verbose technical table

The default table removes `plan`, `lock`, `rotation`, `local`, and `source`.
Those are debugging inputs, not user decisions. It keeps the account label,
human state, existing usage/reset columns, a compact freshness cell derived
from existing `ageMs`, and one `next` cell. A fleet summary counts each human
state.

`--verbose` selects the exact current technical table and diagnostics. JSON is
unchanged and remains the full machine-readable surface.

# 2) Research Grounding

<!-- arch_skill:block:research_grounding:start -->

| Evidence | Conclusion |
|---|---|
| `src/status/claude-redis-view.js:304-370` assigns `credential_expired` solely from the Redis access-token timestamp while preserving a complete native bundle. | Access expiry is an internal refresh condition, not human reauthentication evidence. |
| `claude-redis-view.js:883-899` already attaches lock, rotation, and local-projection facts to every status account. | No new collection or storage path is needed for the human classification. |
| `claude-redis-view.js:1179-1221` owns the one shared Claude text renderer. | One renderer cutover updates direct Claude status and top-level status. |
| `src/status/render.js:50-61` embeds that renderer in `aim status`. | Keep this call site; do not build a second Claude table. |
| `src/cli/commands/claude.js:1244-1262` routes `status` and `usage` through one collection and render path. | Add only a render-mode flag; probing behavior stays untouched. |
| `test/claude/redis-usage-view.test.js` and `test/status/status.test.js` already cover raw states, locking, rotation, averages, and both text entry points. | Extend focused tests instead of creating a new test harness. |

External research is unnecessary: the change is entirely defined by current
repo facts and the approved operator language.

<!-- arch_skill:block:research_grounding:end -->

# 3) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

```text
existing account facts
  -> one Claude status renderer
       -> state=credential_expired / usage_readable / ...
       -> lock=yes
       -> rotation=pending
       -> local=missing / unpublished / ...
       -> source=redis / cache / live
  -> human must infer whether launch works and whether login is needed
```

The default view exposes several implementation facts at equal visual weight.
The `state` label falsely promotes short-lived access-token expiry into an
account-level credential failure.

<!-- arch_skill:block:current_architecture:end -->

# 4) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

```text
existing canonical account facts (unchanged)
  -> pure human-state classification
       -> READY | IN USE | AIM FIXING | NEEDS YOU | UNKNOWN
  -> default renderer
       -> fleet counts + account/status/usage/freshness/next
  -> --verbose renderer
       -> existing technical table + diagnostics
  -> --json
       -> existing machine shape unchanged
```

There is still one collector and one renderer owner. The only new concept is a
display classification local to that renderer.

<!-- arch_skill:block:target_architecture:end -->

# 5) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

| Surface | Required change | Delete/retain |
|---|---|---|
| `src/status/claude-redis-view.js` | Add pure row classification and human rendering; retain the current table as verbose rendering. | Delete raw technical columns from default only; retain all facts and JSON. |
| `src/cli/args.js` | Parse `--verbose` only for `aim claude status|usage`. | No generic verbosity framework. |
| `src/cli/commands/claude.js` | Pass the selected render mode. | Collection and exit-code behavior unchanged. |
| `src/status/render.js` | Continue using the shared renderer in default human mode. | No second top-level formatter. |
| `src/cli/help.js`, `README.md` | Document `--verbose` and its purpose. | No new guide or migration doc. |
| Existing focused tests | Assert state precedence, default simplification, verbose preservation, parser scope, and both render call sites. | No snapshot suite or live mutation harness. |

No other caller of the text renderer defines a competing human-status
contract.

<!-- arch_skill:block:call_site_audit:end -->

# 6) Verification and Rollout

1. Run the focused Claude Redis view, CLI argument/command, help, README
   contract, and top-level status tests.
2. Run the repository's existing lint command and `git diff --check`.
3. Install from the checkout with the existing canonical installer.
4. Run local read-only `aim claude status` and `--verbose` smokes.
5. Commit/push one change, deploy that exact commit with the existing fleet
   path, and verify the installed commit plus a read-only status command on
   each reachable target.

# 7) Phase Plan

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 — Human status cutover and deployment

**Status: IN PROGRESS**

**Goal:** Replace the misleading default Claude table without changing any
credential or runtime behavior.

**Checklist (must all be done):**

- [x] Implement the five-state pure render classification and one-line fleet
  counts in `claude-redis-view.js`.
- [x] Render the compact human table by default and preserve the current
  technical table behind `--verbose`.
- [x] Wire `--verbose` only through `aim claude status|usage`; leave JSON,
  collection, probing, selection, auth, recovery, and maintenance untouched.
- [x] Update the existing focused tests, CLI help, and README command examples.
- [ ] Run the verification and rollout sequence in Section 6.

**Exit criteria (all required):**

- Default output contains none of `credential_expired`, `lock`, `rotation`,
  `local`, or `source` as columns.
- Expired complete access maps to `AIM FIXING`; explicit reauthentication maps
  to `NEEDS YOU`; a held lease maps to `IN USE`; healthy usage maps to
  `READY`; uncertain evidence maps to `UNKNOWN`.
- `--verbose` retains the previous technical visibility and `--json` retains
  its previous keys.
- Focused tests and lint pass; the same committed code is installed locally
  and on the fleet.

<!-- arch_skill:block:phase_plan:end -->

# 8) Compatibility and Rollback

- Text output is intentionally changed; scripts must continue to use `--json`.
- `--verbose` is the explicit human escape hatch for the retired raw default.
- Rollback is one commit revert and reinstall; no data or schema rollback is
  needed because the implementation performs no writes or migrations.

# 9) Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-02 | Derive human state only at render time. | Avoid a duplicate persisted status authority. |
| 2026-08-02 | Preserve raw facts in verbose/JSON rather than the default. | Human decisions and diagnostics have different information needs. |
| 2026-08-02 | Do not change cache, refresh, recovery, or maintainer behavior. | Those are separate runtime problems and unnecessary to correct the misleading status UX. |

# 10) Readiness Verdict

Ready for `miniarch-step implement`. Independent Kimi K3 review passed with
high confidence and no blocking changes. The Scope and Simplicity Contract is
frozen as written; implementation may not expand into auth, refresh, recovery,
maintenance, selection, Redis, cache policy, or new status infrastructure.
