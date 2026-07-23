---
title: "AIM - Zero-to-One Claude Redis Enrollment - Mini Architecture Plan"
date: 2026-07-23
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [overbuilding_check]
doc_type: mini_architecture_plan
related:
  - docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
  - docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md
  - docs/CLAUDE_ZERO_TO_ONE_REDIS_ENROLLMENT_2026-07-23_IMPLEMENTATION_LOG.md
---

# TL;DR

`aim login <label>` already reauthenticates a credentialed Claude account
through the contained, file-backed, no-Keychain path. It cannot create the
first credential for either:

- an existing Anthropic policy-only label; or
- a new label whose operator selects Anthropic.

Close only that gap. Reuse the existing provider prompt, policy-only Redis
record, contained Claude login, rotation fence, identity validation, CAS
publication, recovery, and cleanup. Change one production file, one focused
test file, and one directly stale README statement. Add no command, option,
schema, coordinator, Keychain logic, migration, or remote work.

<!-- arch_skill:block:planning_passes:start -->

planning_passes:
  mode: one-pass-mini
  internal_grounding: complete
  external_research: not_needed
  overbuilding_review: complete
  overbuilding_verdict_on_draft: OVERBUILT
  scope_reconciliation: complete
  scope_freeze: complete
  implementation: complete

<!-- arch_skill:block:planning_passes:end -->

# 0) North Star

## 0.1 Binding requirements

These are the complete requirements. Anything else is out of scope.

1. `aim login <label>` can obtain and publish the first Claude credential for
   an existing policy-only Anthropic label.
2. The same command can enroll a genuinely new label: reuse the existing
   provider prompt, ask for the expected email when Anthropic is selected,
   create the normal policy-only Redis record, then run the same login.
3. The official native macOS Claude client performs OAuth inside AIM's existing
   contained file-only boundary. No real Keychain or global Claude state is
   touched.
4. Redis remains canonical, the expected identity is checked before
   publication, and disposable login files are removed.
5. Existing credentialed Claude reauth and Codex login behavior do not change.
6. No additional scope.

## 0.2 Definition of done

- Both entry states above become one complete, identity-validated Anthropic
  Redis credential through `aim login <label>`.
- Only an exact-empty credential object may use the first-enrollment path.
  Partial or malformed credential material remains fail-closed.
- The existing fence protects the browser wait. Candidate drift clears the
  exact enrollment fence and unpublished staging before rejecting, so retry is
  safe. Post-grant publication uncertainty keeps the existing fenced recovery
  behavior.
- No Keychain function or real `security` path is called.
- Existing reauth behavior stays green.
- Focused tests, the full suite, lint, and `git diff --check` pass.

## 0.3 Explicitly out of scope

- `capture-native` suffix inference, Keychain discovery, enumeration, or
  overrides.
- New commands, flags, machine protocols, panels, or shorthand behavior.
- Changes to managed run, status, inventory, usage, import, or export.
- Bulk roster seeding, migration, deployment, remote machines, or cleanup.
- New Redis keys, schemas, fence types, coordinators, abstractions,
  dependencies, harnesses, or feature flags.
- Refactors and reviewer-suggested adjacent cleanup.
- Another live OAuth canary: the existing `pro5` proof already established the
  official no-Keychain boundary; this change is a Redis state-transition gap.

## 0.4 Scope and simplicity contract

- **Smallest sufficient change:** extend the existing direct Redis login owner
  to create or accept a policy candidate, represent its exact-empty lineage in
  the existing fence, and enter the existing contained login.
- **Convergence closure:** only `src/cli/commands/login.js`,
  `test/cli/redis-login-command.test.js`, and the directly stale README
  statement may change.
- **Proof boundary:** focused state-transition tests, existing regressions,
  full suite, lint, and diff check. No new harness or review wave.
- **Scope freeze:** implementation may remove work but may not add a surface,
  guarantee, call site, or proof category without explicit operator approval.

# 1) Key Design Considerations

## 1.1 Reuse the existing fence without duplicating state

The existing Claude rotation fence already binds the label and base Redis
version and requires successor provenance. For an exact-empty policy
candidate, use one fixed, domain-separated SHA-256 sentinel as its opaque
lineage fingerprint. Do not hash the label, version, provider, or expected
email into it; those are already represented by the fence and Redis version.

Credentialed reauth continues to use its real access/refresh fingerprint.
Partial credentials use neither path and remain rejected.

## 1.2 Keep first-enrollment conflict cleanup narrow

If the candidate changes while the browser is open, reacquire the existing
label lease, clear only the matching fence, delete only its unpublished login
staging, and reject. Do not change the current credentialed-reauth conflict
behavior.

# 2) Problem Statement

The contained OAuth path is already implemented and proven. The blocker is its
starting-state check:

- an Anthropic policy-only record reaches the Claude login owner but fails
  because it has no access/refresh fingerprint;
- a new label can select Anthropic through the existing provider prompt, but
  then reaches the legacy capture/import rejection and no policy record is
  published.

Repairing legacy Keychain capture would preserve an unnecessary two-step path.
The direct login owner should instead admit the normal Redis candidate state.

# 3) Research Grounding

<!-- arch_skill:block:research_grounding:start -->

- `src/cli/commands/login.js`
  - already owns provider dispatch, contained Claude login, short leases,
    durable fencing, identity validation, Redis CAS publication, recovery, and
    cleanup;
  - currently requires a real token fingerprint before launch;
  - currently sends unknown Anthropic labels into the legacy rejection.
- `src/credentials/oauth.js`
  - already owns the unknown-label provider prompt.
- `src/coordination/runtime.js`
  - already publishes the supported policy-only Redis record.
- `src/coordination/redis-claude-rotation-fence.js`
  - accepts an opaque SHA-256 fingerprint and already stores label/version.
- `test/cli/redis-login-command.test.js`
  - already has the fake Redis, staged native login, reauth, cancellation,
    identity, uncertainty, and zero-Keychain proof infrastructure.
- The completed `pro5` canary already proved that the installed native client
  can log in through AIM's contained file store and publish to Redis without
  Keychain.

No external research or new client experiment is required.

<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

```text
credentialed Anthropic label -> aim login -> contained login -> Redis publish
policy-only Anthropic label  -> aim login -> invalid-lineage rejection
unknown label -> provider prompt -> Anthropic -> legacy rejection
```

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

```text
aim login <label>
  -> existing Anthropic record
       -> credentialed: unchanged reauth
       -> exact-empty candidate: fixed empty-lineage sentinel
       -> partial credential: reject
  -> unknown label
       -> existing provider prompt
       -> Codex: unchanged
       -> Anthropic: ask expected email, publish normal policy candidate
                      -> fixed empty-lineage sentinel
  -> existing fence + contained official login
  -> reacquire lease and require unchanged Redis version
  -> existing identity validation + CAS publication + recovery/cleanup
```

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

| File | Required change |
|---|---|
| `src/cli/commands/login.js` | Admit only exact-empty Anthropic candidates; use one fixed empty-lineage sentinel in the existing fence/recovery/completion flow; route unknown Anthropic selection through expected-email policy creation and the same login owner; clean exact candidate conflicts. |
| `test/cli/redis-login-command.test.js` | Add only the focused first-enrollment cases below using existing helpers. |
| `README.md` | Correct only the statement that capture/import are the sole Claude credential-entry paths. |

Reuse unchanged:

- provider selection in `src/credentials/oauth.js`;
- policy publication in `src/coordination/runtime.js`;
- fence schema/helpers in
  `src/coordination/redis-claude-rotation-fence.js`;
- contained runner and native file storage.

No other caller or document joins scope.

<!-- arch_skill:block:call_site_audit:end -->

# 7) One-Phase Implementation Plan

<!-- arch_skill:block:phase_plan:start -->

Status: COMPLETE

Completed work:

- Added the five focused tests before production changes.
- Extended only the existing Redis login owner, using the existing policy,
  fence, contained-login, publication, and cleanup paths.
- Corrected the one stale README statement.
- Verified 14/14 focused tests, 327/327 full tests, clean lint, and clean
  `git diff --check`.

## 7.1 Write the focused failing tests first

In `test/cli/redis-login-command.test.js`, prove:

1. An existing exact-empty Anthropic candidate completes login, publishes one
   credential, uses no Keychain path, and removes its fence/staging.
2. An unknown label selecting Anthropic records the expected-email policy and
   completes the same transition.
3. Partial or malformed credential material is rejected before Claude starts.
4. Candidate version/policy drift during the browser wait clears the exact
   fence and unpublished staging, then rejects without publication.
5. Candidate publication uncertainty remains recoverable through the existing
   fenced staging path.

Do not duplicate existing generic cancellation, wrong-identity, or
credentialed-reauth tests.

## 7.2 Make the narrow owner change

In `src/cli/commands/login.js` only:

1. Reuse the existing provider prompt for an unknown label.
2. If Anthropic is selected, collect a non-empty normalized expected email,
   publish the existing policy-only candidate shape, reload it, and call the
   existing Claude login owner. Leave Codex unchanged.
3. Resolve the fence baseline as:
   - current access/refresh fingerprint for complete credentials;
   - the fixed domain-separated empty-lineage sentinel for an exact-empty
     credential object;
   - rejection for every partial/malformed credential.
4. Use that baseline in the existing preparation, recovery, and completion
   checks. Do not change the fence schema or extract a new owner.
5. On candidate-only drift, clear the matching fence and delete unpublished
   staging while holding the reacquired lease, then reject.
6. Correct the one README statement and stop.

## 7.3 Verify

1. Run the focused login test after each meaningful change.
2. Run the repository's existing full test and lint commands.
3. Run `git diff --check`.
4. Confirm the diff contains only the three authorized paths.

No live account enrollment, remote proof, or additional reviewer is required.

## Exit criteria

- All five focused behaviors pass.
- Existing Claude reauth and Codex login tests remain green.
- Full suite, lint, and diff check pass.
- Only the three frozen paths changed.
- No Keychain path, public surface, Redis schema/key, new abstraction, or
  adjacent work was added.

<!-- arch_skill:block:phase_plan:end -->

# 8) Rollback

Remove the candidate/unknown-Anthropic branches and empty-lineage sentinel.
Leave the existing credentialed reauth path and any policy-only Redis record
intact. No data migration or feature flag is involved.

# 9) Decision Log

- **2026-07-23 — Direct enrollment, not Keychain capture.** New Claude tokens
  enter through contained `aim login`; the legacy suffix mismatch stays out of
  scope.
- **2026-07-23 — Existing fence, fixed sentinel.** The independent reviewer
  correctly found that hashing label/version/email duplicated fields already
  protected by the fence and CAS.
- **2026-07-23 — Unknown labels remain in scope.** The reviewer proposed
  limiting work to pre-seeded candidates. Rejected: that would still require
  an out-of-band Redis import and would not satisfy the requested direct path
  for a genuinely new account. The existing provider prompt and policy record
  are reused; no new public surface is added.
- **2026-07-23 — No second live canary.** Accepted reviewer cut: the native
  no-Keychain boundary is already proven; focused tests cover the new Redis
  transition.
- **2026-07-23 — Exact-empty only and retry-safe drift.** Accepted reviewer
  corrections prevent partial credential overwrite and stale candidate fences.
- **2026-07-23 — Scope frozen.** Plan-only work is complete. Implementation has
  not started.
- **2026-07-23 — Implementation complete without scope expansion.** The three
  frozen product paths changed; no live login, Keychain work, remote action,
  new public surface, schema, abstraction, dependency, harness, or additional
  review phase was added.
