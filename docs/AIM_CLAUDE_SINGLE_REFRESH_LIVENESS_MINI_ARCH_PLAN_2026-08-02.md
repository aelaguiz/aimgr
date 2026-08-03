---
title: "AIM Claude Single-Refresher Liveness - Mini Architecture Plan"
date: 2026-08-02
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: mini_architecture_plan
related:
  - docs/AIM_CLAUDE_STUCK_AIM_FIXING_ANALYSIS_2026-08-02.md
  - docs/AIM_CLAUDE_HUMAN_STATUS_MINI_ARCH_PLAN_2026-08-02.md
  - docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md
  - docs/bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md
---

# TL;DR

Keep exactly one auth maintainer (M3, 60s launchd) and make it able to resolve
every failure class it can encounter, so no Claude account can stay
permanently off. Three mechanism changes, all deletions or bounds rather than
new subsystems:

1. **Fence liveness:** the rotation fence's machine-binding stops being a hard
   gate and becomes advisory metadata; any fence older than a 24h TTL becomes
   recoverable by the single maintainer from the Redis bundle.
2. **Escalation:** a per-account failure that persists unchanged past a 2h
   bound is published as `reauth_required` through the existing policy write,
   so status renders `NEEDS YOU` with `aim login <label>` — the honest
   terminal state that today is unreachable.
3. **One preflight owner:** the duplicated fence/sync/guard pipeline in the
   run path and the maintainer is merged into a single shared function, so the
   two lanes cannot diverge again.

No command, flag, table shape, selection rule, or operator workflow changes.
The operator experience is identical except that stuck accounts now resolve —
by themselves or with one named command.

<!-- arch_skill:block:planning_passes:start -->

planning_passes:
  mode: one-pass-mini
  internal_grounding: complete
  external_research: not_needed
  independent_kimi_review: not_requested
  review_reconciliation: not_applicable
  scope_freeze: complete
  implementation: not_started

<!-- arch_skill:block:planning_passes:end -->

# 0) North Star

## 0.1 Claim

The single central refresher can resolve every Claude credential failure it
meets: it either repairs the account within a bounded time or converts the
failure into an explicit, accurate human action. `AIM FIXING` is always a
temporary, truthful state; `NEEDS YOU` is always reachable and always correct.
This is achieved by removing machinery (a hard machine-gate, a duplicate
guard pipeline, an unbounded retry taxonomy), not by adding any.

## 0.2 In scope

1. Rotation-fence liveness: age-bound TTL with portable recovery; delete the
   foreign-machine hard error; keep `recoveryStorageId` and add
   `createdByHost` as advisory/diagnostic metadata only.
2. Maintainer escalation: time-bounded identical failure publishes
   `reauth_required` via the existing `reauth.blockedReason` policy write;
   success resets the streak; fenced labels are recovery-eligible every pass
   even when not token-due.
3. Convergence: one shared pre-run preflight owner used by both
   `aim claude run` and the maintainer.
4. Diagnostics: per-label log/result lines carry the underlying guard or sync
   sub-reason; the maintainer exit code reflects infrastructure failure, not
   the existence of per-account retryables; `--verbose` gains fence age/owner
   and failure-streak fields (additive).
5. Focused tests, help/README accuracy, install, fleet deploy, and live
   resolution of the six currently stuck accounts.

## 0.3 Explicitly out of scope

1. CLI surface changes: no new, renamed, or removed commands or flags; no
   default table changes; no `aim claude status` exit-code change; JSON
   changes are additive only.
2. More than one maintainer, maintainer-everywhere deployment, new daemons,
   queues, backoff frameworks, or a machine registry.
3. Account selection, lease semantics, usage-cache policy, or provider
   probing changes.
4. Redis schema migration or deletion of the CAS/versioned record model,
   projection receipts, or the fence concept itself.
5. Deleting pool/fleet modules (`src/pool/*`, rebalance/watch commands) or
   any Codex-lane behavior change beyond the shared-loop effects of §0.2.2.
6. Changes to `aim login`, `aim claude capture-native`, or
   `aim claude import-native` flows beyond the reset hook in §0.2.2.

## 0.4 Definition of done

| User-visible result | Done bar |
|---|---|
| No account is permanently off | No Claude account remains `AIM FIXING` for >24h; it reaches `READY`/`IN USE` or escalates to `NEEDS YOU`. |
| Fences cannot wedge an account | No fence blocks maintenance past its TTL; the foreign-machine error path is deleted; `recoveryStorageId` mismatch is never thrown. |
| The honest terminal state is reachable | Escalation publishes through the existing policy fact; status shows `NEEDS YOU` with `aim login <label>`; a successful login/capture/import clears the marker and the streak. |
| One refresher, working | Exactly one maintainer (M3) resolves every failure class from Redis plus bounded recovery; no new daemon anywhere. |
| Failures explain themselves | Maintainer per-label lines and `--verbose` carry the real sub-reason (sync reason, fence age, owning host); a healthy run exits 0 regardless of per-account retryables. |
| Same operator experience | Commands, flags, default table, and selection are unchanged; the six currently stuck accounts resolve post-deploy without Redis surgery. |

## 0.5 Invariants

- Redis remains the sole credential authority; the CAS publish path is
  untouched.
- A rotation fence is still created before every managed launch and every
  maintenance probe, and cleared only after successor publication is proven.
  Only its liveness (TTL, portability) changes, not its create/clear safety.
- A local lineage that is a proven-newer unpublished rotation candidate is
  never overwritten — TTL clearing applies only when no reachable successor
  exists, and run-path candidate recovery stays first.
- Status remains a pure render-time projection over canonical facts;
  escalation state is the existing persisted `reauth.blockedReason` policy
  fact, not a new state machine or persisted operator state.
- One maintainer. This plan adds no actor, only bounds.

## 0.6 Scope and Simplicity Contract

| Contract item | Frozen meaning |
|---|---|
| Human-authorized outcome | Amir's 2026-08-02 instruction: keep one central refresher and make it work; simplify so more robust means less machinery; do not change the operator's commands or workflow; accounts must never be permanently off as they are now. |
| Smallest sufficient solution | Fence TTL + portable recovery (delete the machine gate), time-bounded escalation through the existing reauth policy write, one shared preflight owner, sub-reason logging, and an honest maintainer exit code. |
| Initial minimal convergence closure | Merge the two live pre-run guard pipelines (`src/cli/commands/claude.js` run path and `src/credentials/claude-maintenance.js`) into one owner: both define the same fence-recovery/pre-run-reconcile contract, so changing fence semantics in only one would leave a directly competing authority. No other adjacent work is included. |
| Scope freeze | Frozen at the ready verdict below. Any selection, lease, cache, receipt, pool-module, Codex-specific, or CLI-surface change requires new human approval. |
| Enough proof | Focused fence-recovery TTL matrix tests, escalation trip/reset tests, logging and exit-code tests, both-preflight-caller tests, existing focused suites green, lint, `git diff --check`, installed smoke, and the live six-account resolution check in Phase 2. |
| Do-not-build boundary | No extra maintainer, daemon, queue, backoff framework, machine registry, new status state, persisted operator state, receipt rework, pool-module deletion, or generic config system for the two time bounds (constants are fine). |
| Accepted residual risk | TTL-clearing a fence can abandon an unpublished rotation stranded on an offline machine; the worst case is one `aim login <label>`, which is strictly better than the permanent silent quarantine observed this week. The streak rides the shared reauth policy fact, so a failing label costs one small CAS policy write per maintainer pass; that write is what makes the streak visible to every machine's status and clearable fleet-wide on re-enrollment. |

# 1) Architecture Decisions

## 1.1 Bounds, not actors

The incident mechanism is an unbounded retry of an impossible recovery. The
fix is two time bounds (fence TTL, escalation window) applied inside the
existing maintainer loop. No new process, no new Redis key family, no new
status state. The two bounds are named constants with one-line rationale
comments, not a configuration system.

## 1.2 The fence's machine-binding becomes advisory

`recoveryStorageId` mismatch currently throws and wedges the account forever
(`src/targets/claude-cli.js:324-328`). Post-change, fence recovery is:

1. Redis holds a proven successor → clear the fence (existing).
2. This machine's local storage holds a proven-newer candidate → publish,
   then clear (existing).
3. Fence younger than the TTL and created elsewhere → bounded skip with an
   explicit reason; not counted toward escalation (the owner's recovery
   window is respected).
4. Fence at/past the TTL → clear it and proceed from the Redis bundle
   (new portable path).

`recoveryStorageId` is still written (it identifies the creating storage) and
a `createdByHost` string is added at creation for diagnostics. Neither gates
anything.

## 1.3 Escalation reuses the existing terminal fact

The status renderer already maps `reauth.blockedReason` to `NEEDS YOU` with
`aim login <label>`, and the maintainer already publishes that fact for
wiped-file sessions (`src/credentials/claude-maintenance.js:411-441`).
Escalation is the same publish, triggered by "same reason failing
continuously past the escalation window" instead of an unbounded retry. The
streak record (`firstFailedAt`, `reason`, `count`) rides that same reauth
policy fact (`reauth.maintenance`, additive), so every machine's status can
render it and a successful re-enrollment clears it fleet-wide at the existing
single reset point.

## 1.4 Recovery is not due-gated

Today the maintainer skips non-due records before fence recovery, so a fenced
account with a fresh token is never recovered. Fenced labels become
recovery-eligible on every pass; only the `claude /usage` probe remains
due-gated.

## 1.5 One preflight owner

The fence-read → recover → sync-back → unfenced-assert → candidate-publish
sequence exists twice with near-identical guards
(`src/credentials/claude-maintenance.js:232-361`,
`src/cli/commands/claude.js:743-882`, duplicate SAFE-reason sets at
`claude-maintenance.js:52-57` and `claude.js:89-94`). It moves to one shared
function both lanes call. This is the frozen convergence closure: fence
semantics are changing, and leaving two definitions of the changed contract
would guarantee re-divergence.

# 2) Research Grounding

<!-- arch_skill:block:research_grounding:start -->

| Evidence | Conclusion |
|---|---|
| Live fence dump (2026-08-02, `.tmp/m3-diag.mjs` run on M5 and M3): four fences 1.5–3.6 days old; boss/pro4/pro5 owned by M5 with healthy matching local files; pro2 owned by no reachable machine; all M3 managed dirs empty. | The machine gate wedges accounts the single maintainer could otherwise resolve; fence age, not machine identity, must bound recovery. |
| M3 maintainer log: identical `outcome=retryable reason=local_state_conflict` for six labels every 60s across ~13k runs; pre-cutover runs show `failed=5`; run exits 1 continuously. | Retry never escalates and the exit code carries no information; the underlying sub-reason is not logged anywhere. |
| `src/coordination/redis-claude-rotation-fence.js:82-110` writes the fence `NX` with no TTL; nothing inspects `createdAt`. | Fences are immortal by construction; TTL is the missing liveness property. |
| `src/targets/claude-cli.js:295-361` (recovery, foreign throw at :324-328) and `:136-172` (unfenced projection assert). | The recovery branches to keep (successor-clear, candidate-publish) already exist; only the gate and TTL are new behavior. |
| `src/credentials/claude-native.js:410-413` treats empty managed storage as a safe pre-run state. | Portable recovery from the Redis bundle is already the designed happy path for unfenced accounts; extending it past an expired fence is a small step. |
| `src/cli/commands/auth.js:178-293` (counters, due pre-filter, exit-1-on-retryable) and `src/credentials/claude-maintenance.js:52-97` (retry taxonomy). | Escalation and exit-code repair belong in these exact spots; the due pre-filter is where fenced labels become recovery-eligible. |
| `src/status/claude-redis-view.js:1189-1221` maps `reauth.blockedReason` to `NEEDS YOU` (`aim login <label>`); `AIM FIXING` covers fence-pending and expired-complete. | The honest terminal state needs no renderer change — escalation only has to publish the existing fact. |
| `src/cli/commands/login.js:284-579`, `src/cli/commands/claude.js:390-588` (login/capture/import supersede fenced lineages and clear fences). | The human action the escalation points to already exists and already clears fences; it must also reset the escalation streak/marker. |
| `docs/AIM_CLAUDE_STUCK_AIM_FIXING_ANALYSIS_2026-08-02.md` (full incident evidence); `docs/AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md:28` (six-way recovery flagged). | This incident is the recurring cost of guard machinery without liveness; the plan removes the guard that fired. |

External research is unnecessary: every behavior change is defined by current
repo facts and the live incident evidence.

<!-- arch_skill:block:research_grounding:end -->

# 3) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

```text
maintainer (M3 only, every 60s)
  -> due-gate skips fenced accounts with fresh tokens entirely
  -> fence recovery: Redis-advanced -> clear | local candidate -> publish+clear
       | foreign machine -> THROW (no TTL, no age check, no other exit)
  -> pre-run guards duplicated from the run path (second copy)
  -> claude /usage probe -> publish on rotation
  -> any failure -> retryable (bucket reason only) -> exit 1
  -> retryable forever: no counter, no escalation, no age bound
status
  -> rotationPending or credential_expired -> "AIM FIXING / AIM will retry"
  -> NEEDS YOU unreachable: nothing ever publishes reauth_required
```

The four stuck fences are 1.5–3.6 days old; three are owned by M5, which has
no maintainer; one is owned by no reachable machine. The two expired
unfenced accounts fail in the post-run catch-all with an unlogged sub-reason.
Every actor is behaving as coded; the design has no path to resolution.

<!-- arch_skill:block:current_architecture:end -->

# 4) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

```text
maintainer (M3 only, every 60s — unchanged topology)
  -> fenced labels are recovery-eligible every pass (probe stays due-gated)
  -> shared preflight (one owner, run path + maintainer):
       fence: Redis-advanced -> clear
              | local proven candidate -> publish+clear
              | younger than TTL, foreign -> bounded skip (not a failure)
              | past TTL -> clear, proceed from Redis bundle
  -> probe -> publish on rotation (unchanged)
  -> failure -> log real sub-reason; streak += 1 in local state
       same reason past escalation window -> publish reauth_required
  -> success -> streak reset
  -> exit code: non-zero only when the run itself failed
status
  -> unchanged renderer; AIM FIXING now always bounded
  -> NEEDS YOU reachable via the existing policy fact
  -> --verbose adds fence age/owner and failure streak (additive)
```

Net machinery change is negative: the foreign-machine gate, the duplicate
preflight copy, and exit-code poisoning are deleted; the additions are two
time bounds, one small local streak record, one advisory fence field, and
log detail.

<!-- arch_skill:block:target_architecture:end -->

# 5) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

| Surface | Required change | Delete/retain |
|---|---|---|
| `src/coordination/redis-claude-rotation-fence.js` | Accept and normalize optional `createdByHost`; expose fence age to callers. | Retain fence record shape and NX create (additive field only; no TTL index, no schema migration). |
| `src/targets/claude-cli.js` | Rework `recoverSharedClaudeRotationFence` per §1.2; add `createdByHost` at fence creation; host the shared preflight (or a new single-owner module it exports). | Delete the foreign-machine throw (:324-328) and the "recovery blocked" dead end for past-TTL fences; retain successor proof and candidate publish. |
| `src/credentials/claude-maintenance.js` | Call the shared preflight (replacing :232-361's own copy); streak read/increment/reset; escalation publish reusing the :411-441 policy path; carry sub-reasons into results. | Delete the duplicated guard copy and the local SAFE-reason set; retain lease, due-window, probe, and publish behavior. |
| `src/cli/commands/claude.js` | Run path calls the same shared preflight (replacing its :743-882 copy and its SAFE-reason set). | Retain launch, mid-run publication, and post-run semantics; no command-surface change. |
| `src/cli/commands/auth.js` | Fenced labels bypass the not-due skip for recovery (:201-213); log the carried sub-reason per label; exit non-zero only on infrastructure failure (:291). | Retain counter line shape and record iteration order. |
| `src/cli/commands/login.js`, `claude.js` capture/import | On successful re-enroll, clear the escalation streak and any `blockedReason` for the label. | Retain flows unchanged otherwise. |
| `src/status/claude-redis-view.js` | Verbose renderer adds fence age/owner host and failure streak fields from existing collected facts. | Retain default table, labels, precedence, and JSON structure (additive fields only). |
| `src/cli/help.js`, `README.md` | One paragraph documenting bounded retry/escalation semantics; no new commands. | Retain command documentation shape. |
| Focused tests (`test/claude/*`, `test/credentials/*`, `test/status/*`, `test/cli/*`) | TTL recovery matrix, escalation trip/reset, sub-reason logging, exit-code rule, both preflight callers, verbose additions. | Retain existing suites; update expectations that assert the deleted throw or the old exit rule. |

No other caller defines fence-recovery or retry semantics; the pool/status
readers consume only the existing fence key and policy fact.

<!-- arch_skill:block:call_site_audit:end -->

# 6) Verification and Rollout

1. Run the focused fence, maintenance, auth-command, status, CLI/help, and
   README contract suites; full AIM suite; lint; `git diff --check`.
2. Install from the checkout with the canonical installer locally and on M3,
   then the remaining fleet hosts.
3. Live verification on the real incident (the acceptance matrix):
   - boss, pro4, pro5 (fences owned by M5, healthy files): resolve to
     `READY` or escalate — no permanent `AIM FIXING`.
   - pro2 (fence owned by no reachable machine): past-TTL portable recovery
     clears the fence; account heals from the Redis bundle or escalates to
     `NEEDS YOU`.
   - growth (divergent M5 lineage), qa (expired today): the probe either
     refreshes or the escalated `NEEDS YOU` appears with the real logged
     sub-reason.
   - For any account that escalates, run `aim login <label>` and confirm the
     marker clears and the streak resets.
4. Confirm a maintainer pass with only healthy/dues-skipped accounts exits 0,
   and `aim claude status` shows zero `AIM FIXING` rows older than 24h.

# 7) Phase Plan

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 — Liveness mechanism and preflight convergence

**Status: COMPLETE**

**Completed work:**
- Fence TTL (`CLAUDE_ROTATION_FENCE_TTL_MS` = 24h) and portable recovery in
  `recoverSharedClaudeRotationFence`; foreign-machine throw deleted; young
  foreign fences return a bounded `deferred` skip; `createdByHost` stamped at
  creation (additive, legacy fences parse).
- Shared preflight owner `src/targets/claude-preflight.js`; run path and
  maintainer both call it; duplicate spine and duplicate SAFE-reason set
  deleted from `claude.js`/`claude-maintenance.js`.
- Escalation: 2h identical per-account failure publishes the existing
  `reauth.blockedReason` fact (`escalated_persistent_failure`); streak rides
  the reauth policy fact (`reauth.maintenance`); success and
  login/capture/import clear it (single reset point in `login-publish.js`).
- Fenced labels are recovery-eligible every pass (Anthropic due-skip removed
  from the pre-filter; probe stays due-gated inside the maintainer).
- Per-label log lines carry `detail="..."`; maintainer exits non-zero only
  when the run itself fails.
- Proof: 311/311 full suite (294 baseline + 17 new), lint clean,
  `git diff --check` clean.

**Goal:** Make every maintainer failure class bounded and self-explaining,
with one preflight owner.

**Checklist (must all be done):**

- [ ] Rework fence recovery: TTL + portable clear, bounded foreign skip,
      `createdByHost` metadata; delete the foreign-machine throw.
- [ ] Merge the run-path and maintainer pre-run guard pipelines into one
      shared owner; delete the duplicate copy and duplicate SAFE-reason set.
- [ ] Add the escalation streak in maintainer-local state; publish
      `reauth_required` past the escalation window; reset on success;
      clear streak/marker on login/capture/import.
- [ ] Make fenced labels recovery-eligible every pass (probe stays due-gated).
- [ ] Carry real sub-reasons into per-label results and logs; exit non-zero
      only on infrastructure failure.
- [ ] Focused tests for all of the above; full suite, lint, `git diff --check`.

**Exit criteria (all required):**

- A fence past TTL cannot block any machine; the deleted throw has no
  remaining references; tests cover the §1.2 branch matrix.
- A persistent identical failure produces `NEEDS YOU` within the escalation
  window in tests; success and re-enroll reset it.
- Log lines name the underlying guard/sync reason; a clean pass exits 0.

## Phase 2 — Surface, deploy, and live unstick

**Status: IN PROGRESS**

**Goal:** Ship the mechanism fleet-wide and resolve the six stuck accounts.

**Checklist (must all be done):**

- [ ] `--verbose` gains fence age/owner and failure-streak fields; help and
      README describe the bounded-retry semantics in one paragraph.
- [ ] Install locally and on M3, then the fleet; verify installed commits.
- [ ] Run the Section 6 live acceptance matrix over boss, pro2, pro4, pro5,
      growth, qa; `aim login <label>` for any escalated account.
- [ ] Confirm exit-code behavior and zero stale `AIM FIXING` rows.

**Exit criteria (all required):**

- All six previously stuck accounts are `READY`/`IN USE` or were explicitly
  re-authenticated after an accurate `NEEDS YOU`.
- The maintainer log shows real sub-reasons and a clean exit on a healthy
  pass; no `AIM FIXING` row persists past its bound.

<!-- arch_skill:block:phase_plan:end -->

# 8) Compatibility and Rollback

- No CLI or workflow change; no Redis schema migration. Fence records gain
  one optional field; old code ignores it.
- Rollback is one revert + reinstall. Data written by the new code is safe
  under old code: a cleared fence is simply absent, and an escalation-written
  `reauth.blockedReason` is honored by the old code's existing
  `reauth_already_required` skip and `NEEDS YOU` rendering.
- The two time bounds are constants; adjusting them later is a one-line
  change with focused test updates, not a migration.

# 9) Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-02 | One maintainer, made sufficient — no maintainer-everywhere. | Human constraint: a single refresher is the desired operating model; sufficiency comes from bounds, not more actors. |
| 2026-08-02 | Fence machine-binding demoted to advisory; TTL + portable recovery. | The gate produced permanent quarantine for accounts whose files were healthy on another machine (boss/pro4/pro5) or gone everywhere (pro2). |
| 2026-08-02 | Escalation reuses `reauth.blockedReason`; streak kept in maintainer-local state. | Zero new status machinery and zero new Redis writes per failure; one refresher makes local streak state authoritative enough. |
| 2026-08-02 | Merge the duplicate preflight pipelines as the frozen convergence closure. | Both lanes define the same fence/recovery contract; changing it in one would guarantee re-divergence. |
| 2026-08-02 | No pool-module, receipt, selection, or CLI-surface work. | Human constraint: same commands, same workflow; those cuts are separate future decisions. |
| 2026-08-02 | Intent-derived: the escalation streak rides the Redis reauth policy fact (`reauth.maintenance`), not maintainer-local state. | Blocker: §1.3 said maintainer-local state, but §0.2.4/§5 promise `--verbose` streak fields from collected facts and §0.4 requires re-enrollment to clear the streak — both impossible with machine-local state under a single maintainer. Consulted: §0.2.2, §0.4, §1.3, §5, Phase 1 checklist. Decision: store the streak as additive fields on the existing policy fact (one small CAS write per failing label per pass), with the single reset point in `login-publish.js`; the 2026-08-02 "zero new Redis writes" rationale is superseded by this entry. Consequences: §1.3 and §0.6 residual-risk text repaired to match; no new key family, no new write path. |

# 10) Readiness Verdict

Ready for `miniarch-step implement`. The Scope and Simplicity Contract is
frozen as written; implementation may not expand into selection, leases,
caches, receipts, pool modules, Codex-specific behavior, or CLI surface. The
live six-account incident doubles as the acceptance matrix in Section 6, so
success is observable in production within one day of deploy.
