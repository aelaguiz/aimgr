# AIM Claude Redis Authority Simplification

Status: complete
Owner: Amir
Created: 2026-08-03
Supersedes: only the Claude projection-receipt and durable rotation-fence decisions in `docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md`

## Requirements

1. `aim claude run` and `aim claude resume` must start from the shared Redis credential without asking Amir to reconcile a per-machine cache.
2. Preserve account selection, explicit-account launch, session resume/fork, model shortcuts, per-account isolation, automatic refresh publication, status, re-auth, and fleet operation.
3. Keep only the safeguards that prevent a real current failure: one active process per account, exact account identity, and compare-and-swap publication of a strictly newer credential.
4. A stale, different, unreadable, or ambiguous local managed credential file is a disposable cache. Redis overwrites it; it is not a second authority and cannot block launch.
5. No additional scope. No daemon, migration, new persistence layer, compatibility matrix, recovery protocol, new status state, or new test harness.

## Scope and Simplicity Contract

In scope:

- Remove local projection receipts as launch authority.
- Remove durable Redis Claude rotation fences and machine-specific recovery identities.
- Keep the existing Redis credential lease, identity validation, Redis version CAS, and active/exit refresh publisher.
- Make Claude status and automatic selection rely on the same launch facts: Redis credential usability plus the active lease.
- Simplify contained Claude login and maintenance to the same lease/CAS contract.

Out of scope:

- Codex behavior, account ranking formulas, Claude session storage, plugin/MCP/skill projection, UI changes, schema migrations, and background-maintainer redesign.
- Recovering a refresh that exists only in a process killed before its next publication attempt.

Accepted residual risk:

- If the machine or process dies after Claude rotates a token but before the existing periodic publisher observes it, Redis can retain the predecessor and that account may need re-login. This bounded crash window is preferable to persistent receipts/fences that routinely prevent work.
- An explicit Redis-offline launch trusts the selected per-label managed directory as its identity binding. Online launch, login, and publication still enforce the Redis expected identity; adding a second offline label-to-identity database would recreate the duplicate authority this change removes.

## Current-State Audit

- Redis already stores the canonical Claude credential and a monotonically increasing version.
- `aim claude run` already holds a per-account Redis lease for the Claude process lifetime.
- Publication already validates exact identity, requires a strictly newer expiry for changed tokens, and uses expected-version compare-and-swap.
- The launcher also maintains a local projection receipt and a durable Redis rotation fence. Those form duplicate authorities over a disposable credential cache.
- The reproduced `pro11` failure is a false conflict: local v32 is the recorded predecessor of Redis v33, but a stale v31 receipt causes launch to reject it.
- Status ignores that local rejection and reports `pro11` as READY, so automatic selection repeatedly chooses an account the launcher then blocks.

## Target Architecture

Online launch has one authority path:

1. Acquire the account lease and refresh the Redis snapshot.
2. If a complete local credential has the same identity and is strictly newer than Redis, publish it with the existing Redis version CAS.
3. Otherwise project Redis over the local managed credential file.
4. Run Claude while the lease is renewed.
5. Periodically and at exit, publish a strictly newer same-identity local credential with CAS; retry transient failures without freezing Claude.

Status and selection use Redis credential state plus the lease. Local files, receipts, and recovery metadata do not create a user-visible state.

## Call-Site Audit

| Surface | Change |
|---|---|
| `src/targets/claude-cli.js` | Delete receipt/fence helpers; retain projection and simplify newer-local publication. |
| `src/targets/claude-preflight.js` | Reconcile opportunistically under the lease; never block on stale local state. |
| `src/cli/commands/claude.js` | Remove fence lifecycle and receipt writes; retain lease, active publisher, exit publisher, and offline explicit cache launch. |
| `src/credentials/claude-maintenance.js` | Remove fence/receipt state; use the shared preflight and lease/CAS publication. |
| `src/cli/commands/login.js` | Keep isolated staging, identity checks, lease, and CAS; remove durable recovery fence. |
| `src/status/claude-redis-view.js` | Stop reading fences/receipts or rendering local projection authority. |
| `src/coordination/{runtime,login-publish}.js` | Stop writing rotation-fence provenance. |
| Tests | Replace fence/receipt assertions with observable Redis-authority, lease, and publication behavior. |

## Phase Plan

### Phase 1 — Remove duplicate authority

- Delete receipt and durable-fence production paths.
- Make online projection Redis-authoritative after one newer-local publication attempt.
- Simplify login, maintenance, status, and selection to the lease/CAS contract.
- Do not migrate live Redis data; old fence keys are inert and no longer read, while future credential writes drop old fence provenance.

Exit: a stale or independently changed local managed file cannot block an online launch.

### Phase 2 — Prove and deploy

- Run focused Claude projection, login, maintenance, status, and lease tests.
- Run the full test suite, lint, and `git diff --check`.
- Install locally and reproduce the original `pro11` path with a no-inference Claude invocation.
- Commit and push `main`; fast-forward and install on each configured AIM fleet host; verify the installed revision.

Exit: local proof succeeds, tests are green, and the same commit is installed on the reachable fleet.

## Plan Audit

PASS.

- The plan deletes two authorities and introduces none.
- Every retained mechanism maps to a current requirement: lease for concurrency, identity for account correctness, CAS for stale publication, periodic/exit publisher for refreshed tokens.
- The crash-window tradeoff is explicit and operator-approved by the instruction to remove hypothetical safety blockers.
- No feature the operator uses is removed.

## Research Audit

No external research is required. The current branch, reproduced `pro11` state, Redis record lineage, and existing tests are the authoritative evidence.

## Implementation Audit

PASS.

- Final independent read-only audit found no remaining receipt/fence reader, writer, status field, or launch decision.
- The retained lease, exact online identity validation, strict-newer publication check, and Redis CAS each map directly to a stated requirement.
- The exact `pro11` legacy state, malformed cache replacement, long-browser login lease, status/selection agreement, and live no-model launch are covered by passing evidence in the paired worklog.
- Full suite 304/304, lint, and `git diff --check` pass. No additional authority, daemon, migration, state machine, or user-facing feature was added.
