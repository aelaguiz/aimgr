---
title: "AIM - Active Claude Rotation Live Redis Publish - Mini Architecture Plan"
date: 2026-07-24
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: architectural_change
related:
  - docs/AIM_COMBINED_OAUTH_MAINTAINER_2026-07-24.md
  - docs/CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md
---

# Requirements

1. While `aim claude run <label>` is still running, publish any real token
   rotation from its contained `.credentials.json` back to that label in
   Redis.
2. Do not wait for the Claude process to exit before Redis becomes current.
3. Preserve the exact existing launch UX and arbitrary forwarded arguments.
4. Keep the existing Redis lease, rotation fence, identity, and CAS safety
   boundaries.
5. Do not interrupt or mutate the already-running `pro5` process.
6. Make no Codex, status, maintainer, Keychain, browser, provider-protocol, or
   schema change.
7. Add no additional scope.

# TL;DR

- **Problem:** An active Claude session refreshes its contained credential, but
  AIM currently reads and publishes it only when that session exits. Redis can
  therefore report `credential_expired` while the live session is healthy.
- **Smallest fix:** The already-authoritative `aim claude run` owner checks its
  own contained credential every 30 seconds. If token lineage changed, it uses
  the existing publication path immediately. An unchanged check is a no-op.
- **Preserved:** Existing exit-time synchronization remains the final catch-up
  and cleanup boundary.
- **Deployment:** Ship the exact tested commit to `home` and
  `amirs-m3-max-new`. The existing `pro5` process continues untouched and gains
  the behavior only after its next normal restart.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
research: complete (2026-07-24)
deep_dive_pass_1: complete (2026-07-24)
phase_plan: complete (2026-07-24)
north_star_confirmation: confirmed by implementation instruction (2026-07-24)
recommended_flow: implement -> prove -> audit implementation -> deploy exact commit
note: The user's single instruction authorizes the complete plan-to-deployment arc.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

Given a managed `aim claude run proX` child that remains alive and changes its
contained OAuth tokens, Redis advances that same label before the child exits.
A later unchanged check does not advance Redis again, and the existing
exit-time fence cleanup still completes normally.

## 0.2 In scope

- The existing managed Claude run owner in
  `src/cli/commands/claude.js`.
- One fixed 30-second in-run check.
- The existing
  `syncLiveClaudeRotationBackToLabelFromStorage`,
  `publishRotationIfNeeded`, lease, rotation-fence, identity, and CAS paths.
- One focused regression test in the existing managed-run test file.
- Existing full-suite/lint preservation proof.
- Exact-commit deployment to `home` and `amirs-m3-max-new`.

## 0.3 Out of scope

- New daemon, command, Redis key, schema, state, status, or configuration.
- Changes to `aim auth maintain`, Codex, account selection, or Tend.
- Keychain, browser, model inference, direct Anthropic refresh calls, or
  provider reverse engineering.
- File watching, a generic polling framework, a generic lifecycle hook, or a
  new module for one private loop.
- Retry/backoff policy, metrics, notifications, or exhaustive malformed-file
  handling.
- Interrupting, restarting, inspecting secrets from, or otherwise modifying
  the currently running `pro5` process.
- Unrelated cleanup, refactors, tests, documentation, or machine work.

## 0.4 Definition of done (acceptance evidence)

- A focused integration test holds the fake Claude child open, rotates the
  contained credential, triggers the in-run check, and observes Redis advance
  before the child resolves.
- The same test triggers one unchanged check and proves no second Redis
  version advance.
- The child then exits and the existing projection/fence cleanup still passes.
- Existing managed-run tests, the full suite, lint, and `git diff --check`
  pass.
- The exact tested commit is installed on `home` and `amirs-m3-max-new`; the
  focused test passes from the deployed checkout(s).

### Scope and Simplicity Contract

- **Human-authorized outcome:** Eliminate the misleading expired Redis copy
  while a managed Claude session is actively refreshing its contained copy.
- **Authorization anchor:** Amir's 2026-07-24 instruction to create a tightly
  scoped MiniArch plan, then implement, test, and deploy.
- **Smallest sufficient solution:** One serialized recurring timer inside the
  existing Claude run owner, calling the existing sync and publish functions.
- **Initial minimal convergence closure:** None. The live run already owns the
  label's lease and fence; this merely publishes during that ownership window.
- **Scope freeze:** Frozen on 2026-07-24 before production code changes.
- **Enough proof:** One failure-shaped integration test, existing managed-run
  tests, full suite/lint/diff checks, and deployed-checkout verification.
- **Do not build:** A second maintainer, generic watcher, new storage concept,
  new status state, configuration surface, or alternate refresh path.
- **Residual risk accepted:** Redis may trail a rotation by at most one
  30-second interval. A process already running old AIM code is not hot-patched.

## 0.5 Key invariants (fix immediately if violated)

- Only the active label can be published.
- The existing lease and fence remain held for every in-run publication.
- Checks serialize; there is never more than one credential read/publication
  tick in flight.
- A real token-lineage change is the only reason to publish.
- Publication failure follows the existing continuity-failure safety posture;
  it cannot silently clear the fence or overwrite newer Redis state.
- The final exit-time sync and cleanup remain authoritative.

# 1) Key Design Considerations

## 1.1 Priorities (ranked)

1. Redis truth must follow a healthy active session.
2. Preserve credential-lineage safety.
3. Keep the patch immediately understandable.
4. Preserve the user's launch command and process behavior.

## 1.2 Constraints

- The official Claude client owns refresh behavior inside the contained home.
- The managed run already owns the correct per-label lease and rotation fence.
- The child can remain alive for many hours.
- The present exit-only read is correct but too late for shared status and
  cross-machine continuity.

## 1.3 Architectural principles

- Put responsibility in the existing owner.
- Reuse the existing mutation boundary.
- Poll slowly and serially; do not add an eventing abstraction.
- Keep exit-time reconciliation as the final safety net.

## 1.4 Known tradeoffs

- Fixed 30-second polling is intentionally not configurable.
- A transient publication failure may end the managed run through its existing
  fail-closed continuity path rather than let Redis and the live file diverge
  indefinitely.
- Existing processes need a normal restart to load the new code.

# 2) Problem Statement

## 2.1 What exists today

`aim claude run` projects one Redis credential into an AIM-owned Claude home,
holds the label lease and rotation fence while the child runs, then reads the
contained file and publishes a successor after the child exits.

The separate OAuth maintainer correctly skips a label whose lease is actively
owned.

## 2.2 What is broken

A long-running client can refresh its contained credential hours before exit.
During that interval Redis retains the earlier credential and status can call
it expired even though the live session is healthy. Other machines also cannot
see the successor until process exit.

## 2.3 Constraint implied by the failure

The fix belongs inside the existing lease/fence owner. Making the external
maintainer race the active run, reading arbitrary process files from another
owner, or changing status to guess would weaken the architecture.

# 3) Research Grounding

<!-- arch_skill:block:research_grounding:start -->

## 3.1 External evidence

No external research is needed. The concrete `pro5` observation established
the failure:

- Redis retained an expired version-3 credential.
- The active managed run continued heartbeating its Redis lease.
- Its contained file held a newer, still-valid token refreshed during the run.
- The rotation fence correctly remained open at the Redis base version.

## 3.2 Internal ground truth

- `handleRedisClaudeRun` owns the lease, managed projection, fence, child
  lifecycle, post-run sync, publication, and cleanup.
- `syncLiveClaudeRotationBackToLabelFromStorage` already distinguishes a
  changed credential from `tokens_unchanged`.
- `publishRotationIfNeeded` already uses the active runtime snapshot and
  existing CAS publication.
- Successful publication updates the runtime snapshot, so a later tick can
  safely publish the next successor or no-op.
- The current post-run path begins only after `runClaudeCliImpl` resolves.

## 3.3 Decision gaps

None. The active owner, existing publication path, cadence, failure posture,
and proof boundary are fixed above.

<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

## 4.1 Control path

```text
Redis vN -> project -> create fence -> run Claude for hours
                                      -> contained token becomes vN+1
                                      -> Redis remains vN
             child exits -> read contained token -> publish vN+1 -> cleanup
```

## 4.2 Ownership

The active `aim claude run` process exclusively owns the label lease, fence,
contained home, and publication right. The scheduled maintainer sees the lease
and skips.

## 4.3 Failure behavior

Exit-time reconciliation is fail-closed: publication uncertainty retains the
fence/projection and marks rotation pending rather than pretending continuity
is safe.

## 4.4 UI impact

None. Correcting Redis makes existing inventory/status output truthful.

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

## 5.1 Control path

```text
Redis vN -> project -> create fence -> run Claude
                                      -> every 30s, serially:
                                           read managed file
                                           unchanged: no-op
                                           changed: existing CAS publish
                                      -> Redis becomes vN+1 before exit
             child exits -> stop/await tick -> existing final sync -> cleanup
```

## 5.2 Implementation shape

- Add one private fixed interval constant.
- Add one private start/stop loop in `claude.js`.
- Start it after the run fence exists and immediately before launching Claude.
- Each tick:
  1. reads/reconciles the existing managed descriptor;
  2. renews/asserts the existing lease before mutation;
  3. calls existing publication with the existing run fence;
  4. asserts the successor against that fence;
  5. schedules the next tick only after the current tick finishes.
- On child completion or launch failure, stop the loop and await any in-flight
  tick before the existing final synchronization.

## 5.3 Failure behavior

The first tick failure is retained, aborts the child through the existing
guard, and enters the existing post-run continuity handling. It does not clear
the fence or add a fallback writer.

## 5.4 Compatibility

`aim claude run <label> -- <arbitrary Claude arguments>` remains unchanged.
The maintainer's bounded `/usage` mode also retains its current behavior.

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

## 6.1 Change map

| File | Symbol / site | Required change | Why | Proof |
|---|---|---|---|---|
| `src/cli/commands/claude.js` | constants/private helpers | Add fixed serialized in-run publisher | Existing active owner must keep Redis current | Focused integration test |
| `src/cli/commands/claude.js` | `handleRedisClaudeRun` around `runClaudeCliImpl` | Start after fence; stop/await before final sync; preserve existing final path | Prevent race and preserve cleanup | Existing + focused managed-run tests |
| `test/cli/redis-projection-command.test.js` | managed Claude run coverage | Hold child open, rotate, trigger tick, inspect Redis before exit, then prove unchanged no-op and cleanup | Reproduces the actual defect | Direct assertions |

## 6.2 Explicit non-call-sites

No change to the maintainer, runner/supervisor, lease/fence modules, credential
storage module, Redis publication module, status, help, installer, schema,
dependencies, README, or unrelated tests/docs.

## 6.3 Migration

No data migration. New processes use the behavior. Existing processes continue
under their loaded code until normal exit/restart.

<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 - Implement and prove the active-owner fix

**Status:** COMPLETE

### Goal

Publish a contained Claude token rotation to Redis before the managed child
exits, without changing any adjacent architecture.

### Checklist (must all be done)

- [x] Create a feature branch from `f01bf8d`.
- [x] Add the private serialized 30-second publisher inside `claude.js`.
- [x] Start it only after the existing run fence is established.
- [x] Stop and await it before the existing post-run synchronization.
- [x] Route tick failure into the existing fail-closed continuity behavior.
- [x] Add one focused pre-exit publication/no-duplicate/cleanup regression test.
- [x] Run focused managed-run tests.
- [x] Run the full suite, lint, and `git diff --check`.
- [x] Perform a post-working implementation audit against this frozen scope.

### Exit criteria

- [x] Redis advances before the fake child exits.
- [x] An unchanged follow-up tick does not advance Redis.
- [x] Existing exit cleanup still removes the projection and fence.
- [x] Existing interactive and maintenance behaviors remain green.
- [x] No file outside the Section 6 change map changed, except this plan and
  its worklog.

### Rollback

Revert the one production change and its regression test. Existing exit-time
publication behavior remains intact.

## Phase 2 - Publish and deploy the exact tested commit

**Status:** ACTIVE

### Goal

Make future managed Claude runs use the proven fix on both AIM hosts.

### Checklist (must all be done)

- [ ] Commit the scoped implementation and documentation.
- [ ] Fast-forward/push `main` to the tested commit.
- [ ] Fast-forward `home` and `amirs-m3-max-new` AIM checkouts to that exact
  commit using their established canonical install path.
- [ ] Run the focused regression test from deployed checkout(s).
- [ ] Confirm canonical `aim` resolves to the deployed checkout.
- [ ] Confirm the M3 OAuth maintainer remains loaded and healthy.
- [ ] Do not stop or modify the already-running `pro5` session.

### Exit criteria

- [ ] Local, origin, home, and M3 resolve to the same tested commit.
- [ ] Deployed focused proof passes.
- [ ] No deployment created a second installation or service.
- [ ] Existing `pro5` continues untouched; its next normal run will load the
  fix.

### Rollback

Fast-forward the deployed checkouts to a revert commit. Do not manually edit
Redis credentials or active session files.

<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy

## 8.1 Focused regression

Use the existing fake Redis and managed Claude helpers:

1. Start `aim claude run` with a promise-controlled fake child.
2. Confirm Redis is at version N.
3. Change only the contained credential to a valid successor.
4. Trigger the scheduled tick without a real 30-second wait.
5. Confirm Redis is N+1 while the child promise is unresolved.
6. Trigger an unchanged tick and confirm Redis remains N+1.
7. Resolve the child and confirm the existing fence/projection cleanup.

## 8.2 Preservation

```text
node --test test/cli/redis-projection-command.test.js
npm test
npm run lint
git diff --check
```

## 8.3 Deployment proof

Run the focused fake-Redis test from the deployed source. Do not launch a real
second Claude session merely to prove deployment, and do not disturb `pro5`.

# 9) Rollout / Operations

1. Local proof.
2. Post-working read-only audit.
3. Commit feature branch.
4. Fast-forward and push `main`.
5. Update `home`, then M3, to the exact commit.
6. Re-run the focused proof and verify canonical installation/service state.

No new operator command is introduced.

# 10) Decision Log (append-only)

## 2026-07-24 - Fix the active owner, not the external maintainer

- **Context:** A live `pro5` process held a healthy refreshed contained token
  while Redis showed its older credential as expired. The scheduled maintainer
  skipped the label because the live owner correctly held its lease.
- **Decision:** Make the existing managed run publish real contained rotations
  every 30 seconds while it owns the lease/fence.
- **Rejected:** Racing the live lease from the maintainer, teaching status to
  infer hidden live state, a generic file watcher, or another daemon.
- **Consequence:** Redis becomes current during future long-running sessions;
  an already-running old process remains unchanged until normal restart.

## 2026-07-24 - Freeze scope before implementation

- **Context:** Amir explicitly required a tightly scoped MiniArch plan followed
  by implementation, testing, and deployment.
- **Decision:** Freeze Sections 0, 5, 6, 7, and 8 before production edits.
- **Consequence:** Testing and deployment may prove only this behavior; they
  cannot add adjacent cleanup, abstractions, or product changes.
