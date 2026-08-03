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

## 2026-08-03 Codex Handoff Checkpoint

- Current checkpoint: `bab2b2a` plus Kimi's uncommitted import-only start in
  `src/credentials/claude-maintenance.js`; unrelated untracked `.tmp/` and
  `.antigravitycli/` artifacts are preserved and out of scope.
- Active frozen slice: only the Phase 2 provider-collision repair already
  authorized in the Decision Log — record-based Anthropic expected-email
  lookup, Claude-maintenance-owned reauth policy publication, collision
  regressions, gates, fleet redeploy, and the named live acceptance matrix.
- Code read: `claude-maintenance.js`, `coordination/runtime.js`,
  `coordination/snapshot.js`, `coordination/redis-store.js`,
  `targets/claude-cli.js`, `targets/claude-preflight.js`, and the maintenance
  fixtures in `test/cli/redis-projection-command.test.js`.
- Do not redo unless invalidated: Phase 1 and the Phase 2 verbose/help surface
  remain proven by the 312/312 gate recorded above and deployed at `8d37558`.
- Next useful move: complete the interrupted collision helper and focused
  regressions without changing the shared `state.accounts` representation or
  the provider-scoped run/capture/import/login lanes.

## 2026-08-03 Provider-Collision Repair Slice

- Work completed:
  - Claude maintenance now reads expected identity from the exact Anthropic
    record and publishes reauth changes by CAS over that record only.
  - A pass-local Anthropic account overlay keeps rotation policy correct, then
    restores the shadowed Codex account view. The collided label's pre-existing
    local browser binding is retained across maintenance-owned state writes.
  - The unscoped `auth maintain` dispatcher routes Anthropic records through
    the same owner even when refresh material is incomplete; Codex behavior is
    unchanged. The terminal reauth mutation renews its lease immediately
    before publication.
- Focused collision proofs:
  - Same-label Codex shadow still reaches the Claude probe; incomplete
    Anthropic material reaches accurate `reauth_required`; rotation preserves
    Anthropic policy; reauth publication leaves the Codex twin unchanged;
    stale CAS cannot clobber a concurrent Anthropic update; local browser
    binding and the caller's shadowed account view survive the pass.
- Gates:
  - Collision slice 5/5; command + projection subsystem 48/48; full suite
    317/317; `npm run lint` clean; `git diff --check` clean.
  - Fresh clean-room recheck: APPROVE with no findings against implementation
    and test diff `ab196fe980ae430da7d558dc420bc50fcc69431b5f287b98b8ddc1ba215cfb17`.
- Scope:
  - No shared `state.accounts` redesign and no provider-scoped
    run/capture/import/login changes. Unrelated `.tmp/` and `.antigravitycli/`
    artifacts remain untouched.
- Next step:
  - Commit/push, exact-SHA fleet deploy, and the frozen M3 live acceptance
    matrix.

## 2026-08-03 Final Rollout and Live Acceptance

- Implementation commit `296a8a0` pushed to `origin/main`; exact SHA installed
  and wrapper-smoke-tested on local M5, M3, home, Studio, and Claw. Existing
  unrelated untracked files on local, home, Studio, and Claw were preserved.
- Per the repository security rule, M3 maintainer bootstrap was delegated only
  for that sensitive step to Claude Opus 5. Receipt:
  `/tmp/agent-delegate/m3-maintainer-bootstrap-20260803T000000Z-fqrsHe`
  (session `ad8504ce-06f6-4ade-aecf-1f46d9a3bebc`). Installer exit 0; plist
  mode 600; first RunAtLoad exit 0.
- First repaired M3 pass refreshed boss, growth, pro2, pro3, pro4, pro5, and
  qa (`credential_rotated`). The following pass skipped each as `not_due` and
  exited 0. Its only retryable was the pre-existing out-of-scope Codex label
  `amir_personal` (`HTTP 401`); Claude maintenance remained stable.
- Live human acceptance: 6 READY (boss, growth, pro3, pro4, pro5, qa), pro2
  accurately NEEDS YOU with `aim login pro2`, 0 AIM FIXING, 0 unknown. Verbose
  state showed clean local projections and no rotation fence for every named
  label.
- Analysis correction added to
  `docs/AIM_CLAUDE_STUCK_AIM_FIXING_ANALYSIS_2026-08-02.md`: the fence defect
  was real but latent; the provider collision was the active blocker in front
  of it. Phase 2 and the plan are complete without shared-map or workflow
  expansion.

## 2026-08-03 M3-Login/M5-Consumer Follow-up

- Operator workflow clarified after rollout: Claude login and maintenance run
  on `amirs-m3-max-new`; local M5 consumes the resulting shared Redis
  credential through `aim claude run <label>`.
- Read-only live `qa` metadata isolated the defect without exposing token
  values: Redis v32 was credential-ready; no live fence or local receipt
  existed; M5 and Redis had the same stable account identity; M5 reconciled as
  `unchanged:stale_candidate`; and Redis v32 named M5's exact fingerprint as
  its v31 rotation base. The guard rejected that proven successor before the
  existing safe Redis projection could run.
- Commit `f9fa31a` admits only that exact proof: Anthropic label match,
  same-identity stale candidate, valid rotation fence provenance, a base
  version below the current record, exact local-base fingerprint match, and a
  supported `login-maintenance` or `native-claude-rotation` publisher. Missing
  receipts without proof and independently changed branches still fail closed.
- The two reported errors now lead with `Claude account "<label>"`. Busy work
  explains that another AIM process is using or refreshing the account. A
  genuine two-branch conflict no longer recommends capturing M5's cache; it
  explains how to preserve it while choosing the shared M3 login.
- Proof: focused projection/fence subsystem 48/48; full suite 318/318; lint and
  diff check clean. Independent review found and repaired the initial omission
  of the real `login-maintenance` publisher, then returned PASS. The exact
  commit was pushed and fast-forwarded onto local M5, M3, home, Studio, and
  Claw with tracked-clean worktrees; unrelated untracked files were preserved.
