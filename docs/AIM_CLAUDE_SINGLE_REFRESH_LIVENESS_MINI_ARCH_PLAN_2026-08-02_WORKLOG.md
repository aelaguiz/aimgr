# Worklog

Plan doc: `docs/AIM_CLAUDE_SINGLE_REFRESH_LIVENESS_MINI_ARCH_PLAN_2026-08-02.md`

## Initial entry

- Run started after the user approved implementation, end-to-end testing, and
  fleet deployment of the frozen plan.
- Current phase: Phase 1 — Liveness mechanism and preflight convergence.
- Frozen boundary: fence TTL + portable recovery, escalation via existing
  reauth policy fact, one shared preflight owner, sub-reason logging, honest
  maintainer exit code, focused tests. No CLI/selection/topology changes.

## Phase 1 (Liveness mechanism and preflight convergence) Progress Update

- Work completed:
  - All six Phase 1 checklist items implemented (fence TTL + portable
    recovery, shared preflight owner, escalation, per-pass fence recovery
    eligibility, sub-reason logging, honest exit code).
  - One intent-derived decision: the escalation streak rides the Redis reauth
    policy fact (`reauth.maintenance`) instead of maintainer-local state —
    required by the plan's own verbose-streak and fleet-wide-reset rows;
    recorded in the plan Decision Log.
- Tests run + results:
  - Baseline before edits: 294/294. After: 311/311 (17 new focused tests).
    `npm run lint` clean, `git diff --check` clean. Parent re-ran the full
    gates against the raw diff: same result.
  - Intentional expectation updates: 3 (deleted foreign-machine throw message,
    retryables now exit 0, retryable results carry `detail`).
- Issues / deviations:
  - None beyond the recorded streak-medium decision.
- Next steps:
  - Phase 2 surface (verbose fields, help/README), then install + fleet
    deploy + live acceptance matrix.

## Phase 2 (Surface, deploy, and live unstick) Progress Update

- Work completed:
  - Verbose surface (fence age/owner, maintenance diagnostics line; additive
    JSON), help.js + README paragraph. Gates 312/312, lint, diff-check.
  - Committed `8d37558`, pushed, installed on local (M5), M3, home, Studio,
    Claw — all at `8d37558`.
  - Live: maintainer exit code now 0 with retryables present; new maintainer
    refreshed pro8/pro9/pro10; qa self-resolved to v31 via a scoped run lane.
- Tests run + results:
  - Full suite 312/312 locally; installed smokes on all five machines.
  - Live M3 log shows real `detail=` on codex failures and clean exit 0.
- Issues / deviations:
  - Live unstick revealed a deeper defect: the shared `state.accounts` view
    is keyed by bare label across providers, so a same-label Codex record
    with empty `policy.expect` shadows the Anthropic account
    (`buildCoordinationView`, snapshot.js:25-41). The unscoped maintainer
    lane throws cause-less `local_state_conflict` at `requireExpectedEmail`
    for every collided label (boss, growth, pro2, pro4, pro5 — and pro3 once
    the pre-filter change exposed it), and its reauth publishes die on the
    provider-conflict guard. This — not the fence gate — was the active M3
    wedge all along; the fence gate was real but latent behind it.
  - The earlier analysis doc's framing needs a correction note (queued).
  - Coder subagent unavailable (provider quota); parent is applying the
    record-based repair directly per the Decision Log authorization.
- Next steps:
  - Implement the collision repair in `claude-maintenance.js` + collision
    regression tests; gates; commit/push; redeploy fleet; finish the live
    acceptance matrix (fences clear, accounts reach READY or NEEDS YOU; pro3
    recovers); final record commit.
