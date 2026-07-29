---
title: "Stale Claude rotation-pending state blocks automatic runs but is hidden from status"
date: 2026-07-28
status: resolved
owners:
  - aelaguiz
reviewers: []
related:
  - CLAUDE_CTRL_C_STRANDS_ROTATION_FENCE_2026-07-23.md
---

# Stale Claude rotation-pending state blocks automatic runs but is hidden from status

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** Repeated `aim claude run fable` calls fail with
  `rotation publication is pending`, while `aim status` shows every account as
  credential-ready and does not identify the blocked account.
- **Impact:** Automatic selection repeatedly chooses `pro9` because it is the
  lowest-usage unlocked Fable account, then fails before launch.
- **Root cause:** Local state has
  `rotationPublicationPendingByLabel.pro9.pending=true`, but Claude usage
  status reads only Redis credential health and live leases. The local
  operational blocker is omitted from both JSON and text status.
- **Current state:** The `pro9` marker is stale: it predates an authoritative
  Redis rotation from base version 14 to version 15; no shared fence or managed
  credential projection remains.
- **Status:** Resolved locally. Automatic selection and marker reconciliation
  remain unchanged until separately authorized.

<!-- bugs:block:tldr:end -->

## Bug North Star

`aim claude status` and top-level `aim status` must show when a local Claude
label is blocked by a pending rotation publication marker. Status must remain
read-only and must not clear the marker, alter Redis, or change selection.

<!-- bugs:block:analysis:start -->

## Analysis

### Decisive evidence

| Surface | Evidence | Conclusion |
|---|---|---|
| Automatic selection | Unlocked `pro9` has 39% Fable usage; the next unlocked account, `pro2`, has 40% | `aim claude run fable` selects `pro9` |
| Local AIM state | `pro9.pending=true`, observed `2026-07-27T14:34:39.286Z` | The thrown branch is driven by a local marker |
| Managed storage | `pro9/.claude/.credentials.json` is absent | Pre-run recovery returns `native_storage_empty` |
| Redis credential | Current version 15 was published from rotation base version 14 at `2026-07-28T20:37:48.099Z` | Redis advanced after the local marker |
| Shared coordination | No `pro9` rotation fence exists | Durable rotation coordination is no longer pending |
| Status collector | It annotates Redis lease locks but never reads `rotationPublicationPendingByLabel` | The blocking state is hidden by construction |

At `src/cli/commands/claude.js:887`, the run reads the local pending marker.
With an empty managed projection, lines 935–943 reject the launch. At
`src/status/claude-redis-view.js:758–807`, usage status reads Redis records and
leases only, so it reports `pro9` as ordinary `usage_readable`.

### Root cause

The run path and status path use different operational state:

```text
run preflight: Redis + local rotation-pending marker
status:        Redis + live lease only
```

The marker also contains only `pending` and `observedAt`, so it cannot
automatically prove that a later Redis rotation superseded it. That stale-state
repair is real but separate from the authorized visibility change.

<!-- bugs:block:analysis:end -->

## Scope contract

- **Authorized behavior:** Surface local rotation-pending state per Claude
  account in `aim claude status`, its JSON result, and top-level `aim status`.
- **Smallest sufficient fix:** Annotate existing status accounts from
  `local-state.json` and render one `rotation` column.
- **Initial convergence closure:** The shared Claude usage-status collector is
  already used by both command surfaces; no additional caller migration.
- **Enough proof:** A pending account is `rotationPending=true` in JSON and
  renders `pending`; an ordinary account renders `--`; existing status and
  selection tests pass.
- **Do not build:** No marker deletion, Redis mutation, auto-skip policy,
  repair command, schema change, or provider request.
- **Accepted residual risk:** `pro9` remains blocked until its stale marker is
  separately reconciled.

<!-- bugs:block:fix_plan:start -->

## Fix plan

1. Read pending labels from existing local state inside the shared Claude usage
   status collector.
2. Add `rotationPending` to each account and a `rotation` text column.
3. Add one focused collector/renderer regression and update exact status table
   expectations.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation

- The shared Claude usage-status collector now reads the existing local
  `rotationPublicationPendingByLabel` map and adds a boolean
  `rotationPending` field to every account.
- Both `aim claude status` and top-level `aim status` render a `rotation`
  column with `pending` or `--`.
- Status remains read-only. Automatic selection, local marker lifecycle, Redis
  data, leases, and provider probing are unchanged.
- Focused status suites: `23/23` pass.
- Full AIM suite: `372/372` pass.
- Lint and `git diff --check`: pass.
- Live read-only proof shows:
  `pro9 ... lock=-- rotation=pending ...`.

<!-- bugs:block:implementation:end -->
