---
title: "Interrupted managed Claude run cannot resume its rotation fence"
date: 2026-07-23
status: fix-ready
owners:
  - aelaguiz
reviewers: []
related:
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
---

# Interrupted managed Claude run cannot resume its rotation fence

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** After pressing Ctrl-C once at Claude's workspace-trust prompt,
  every later `aim claude run pro5 -- ...` on the same Linux machine fails with
  `shared rotation fence is unresolved; unchanged local tokens cannot prove
  refresh continuity`.
- **Impact:** A normal cancellation permanently blocks that account on AIM
  until its credential is replaced, even though the exact fenced projection is
  intact and Redis has not changed.
- **Root cause:** AIM correctly retains a shared fence after a non-clean Claude
  exit, but its next-run recovery has only two outcomes: publish changed tokens
  or fail. It has no path to resume the interrupted operation on the exact same
  recovery storage while keeping the existing fence active.
- **Correct fix:** When Redis is still at the fence baseline, the recovery
  storage ID matches exactly, and the managed projection is complete and
  token-identical, relaunch Claude under the existing fence. Do not clear or
  replace the fence during recovery.
- **Status:** Fix-ready. Current code, current tests, and the live `pro5` state
  establish the failure and the minimal correction. No product code has been
  changed for this bug yet.

<!-- bugs:block:tldr:end -->

## Bug North Star

An interrupted `aim claude run <label> -- <args>` must be resumable on the same
AIM installation and managed config directory. The retry must keep the original
shared rotation fence active until the official Claude client either publishes
a proven token successor or completes cleanly with unchanged tokens. Other
machines must remain blocked, and AIM must never clear an ambiguous or
mismatched fence.

## Reproduction

On the Ubuntu `home` server, from
`/home/aelaguiz/workspace/rustai`:

```bash
aim claude run pro5 -- \
  --dangerously-skip-permissions \
  --model claude-fable-5 \
  --effort max
```

At Claude's workspace-trust prompt, press Ctrl-C once. Repeating the same
command then fails before Claude launches:

```text
Error: Claude label=pro5 shared rotation fence is unresolved; unchanged local
tokens cannot prove refresh continuity.
```

<!-- bugs:block:analysis:start -->

## Analysis

### Decisive evidence

| Surface | Evidence | Conclusion |
|---|---|---|
| Live shared fence | `pro5` has a valid fence whose base credential version is `3`; Redis is still version `3` with the exact baseline token-lineage fingerprint | No unrelated publication or successor exists |
| Live recovery identity | The fence recovery-storage ID matches the current Linux installation ID plus the exact managed `pro5` config directory | The retry is on the one storage location authorized to recover this fence |
| Live managed projection | The file-only projection is readable, identity-complete, and its access token, refresh token, and expiry are identical to Redis | The interrupted projection is intact; no changed token is waiting to publish |
| Live local marker | `rotationPublicationPendingByLabel.pro5.pending` is true | AIM recorded the unresolved recovery after the retry |
| Current recovery code | `recoverSharedClaudeRotationFence` throws whenever same-storage recovery reports `tokens_unchanged` | The observed failure is the designed branch, not Redis corruption |
| Current run code | Every launch unconditionally tries to create a new fence after recovery | Even if recovery stopped throwing, the retry could not proceed while the original fence remained |
| Current tests | The terminating-signal test asserts that a fence and projection remain; the non-clean-exit test asserts that a same-home retry is rejected | The test contract currently preserves the dead end |
| Process state | No Claude, AIM, or supervisor process from the interrupted run remains on `home` | This is durable coordination residue, not a still-running owner |

No credential values, Redis URL, fence identifier, recovery-storage identifier,
or token-lineage fingerprint were emitted while gathering this evidence.

### Ranked hypotheses

1. **Confirmed — exact same-storage continuation is missing.** Recovery verifies
   all prerequisites for safe ownership, sees unchanged tokens, and throws
   instead of returning the still-active fence to the run lifecycle.
2. **Contributing but not sufficient — Ctrl-C is a non-clean child exit.** The
   lifecycle intentionally retains uncertainty after a signal. Retaining the
   fence is correct; making it unrecoverable on its owning storage is not.
3. **Disproved — another machine owns the fence.** The computed recovery
   storage ID matches the live fence.
4. **Disproved — Redis advanced or was changed arbitrarily.** Its version and
   token lineage are still the exact fence baseline.
5. **Disproved — Claude rotated locally but AIM failed to publish it.** The
   managed token pair and expiry are unchanged from Redis.
6. **Disproved — a stale AIM or Claude process still owns the run.** No relevant
   process remains.

### Root cause

The shared fence has the right safety model but the run state machine lacks a
continuation transition:

```text
interrupted run
  -> fence retained
  -> same storage proves unchanged baseline
  -> current code throws forever
```

The missing transition is:

```text
same storage proves unchanged baseline
  -> retain and reuse the same fence
  -> relaunch official Claude
  -> publish a proven successor, or clear only after a clean unchanged exit
```

This is narrower and safer than clearing the fence merely because tokens are
unchanged. It preserves the fence across the entire retry and continues to
exclude every other machine.

<!-- bugs:block:analysis:end -->

## Scope contract

### Correct behavior

- A same-installation, same-managed-directory retry may continue under the
  existing fence when Redis and the managed projection both still match its
  baseline.
- The retry reuses the exact existing fence; it does not clear and recreate it.
- A changed local token pair still must publish as a fence-linked successor
  before the fence clears.
- A clean retry with unchanged tokens may clear the fence under the run
  lifecycle's existing clean-exit rule.
- Another installation, mismatched projection, changed Redis lineage, missing
  projection, unsafe storage, or lease loss remains fail-closed.

### Initial minimal convergence closure

- The same-storage unchanged-token branch in shared-fence recovery.
- Passing the retained fence into the existing run lifecycle instead of
  creating a new one.
- Focused regression expectations for signaled and nonzero interrupted runs.
- One no-model live recovery of the stranded `pro5` fence on `home`.

### Scope freeze before fix

The fix may alter only managed Claude shared-fence continuation and its directly
corresponding tests and worklog. It must not change Redis schemas, credential
formats, executable qualification, platform containment, Claude arguments,
session storage, or general process-signal handling.

### Explicitly out of scope

- Tend or Codex behavior.
- Linux/macOS executable installation or qualification.
- New Redis commands, repair commands, timeout policies, or fence expiry.
- Clearing fences from a different machine.
- Treating arbitrary Redis credentials as a rotation successor.
- Weakening identity, token-lineage, lease, managed-path, or file-ownership
  checks.
- Sending a model-bearing prompt as a test.
- Changing Claude's workspace-trust prompt or preapproved permissions.

### Enough proof

- A focused test creates a fenced, unchanged projection through a terminating
  signal, then proves the same home relaunches under the exact original fence
  and a clean unchanged completion clears it and retires the projection.
- A focused test proves a nonzero interrupted run has the same resumable
  behavior.
- Existing tests continue to prove another home cannot recover the fence,
  arbitrary Redis changes cannot pass as a successor, and changed local tokens
  publish with fence-linked provenance.
- Focused tests, the full suite, lint, and `git diff --check` pass.
- After deployment to `home`, `aim claude run pro5 -- --version` recovers the
  existing fence without a model request; a read-only post-check shows no fence,
  no pending marker, and no managed credential projection.

### Residual constraint

If Claude consumes or rotates a refresh token but is killed before persisting
the successor, unchanged local storage cannot prove that old token is still
valid. This fix does not claim otherwise: the retry remains fenced and lets the
official client continue from that exact storage. If the provider rejects the
credential, normal account reauthentication is still required.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

1. Make `recoverSharedClaudeRotationFence` return a retained-fence continuation
   only for `tokens_unchanged` after its existing Redis-baseline,
   recovery-storage, managed-storage, identity, and lease checks pass.
2. In `handleRedisClaudeRun`, reuse that exact fence for the next Claude launch;
   create a new fence only when recovery did not retain one.
3. Replace the two dead-end test expectations with continuation proofs that
   inspect the original fence during relaunch and verify cleanup after a clean
   unchanged exit.
4. Run the focused projection tests, full suite, lint, and diff check.
5. Commit and push `main`, deploy that exact commit to `home`, and run the
   no-model `--version` recovery plus sanitized state checks.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation

Implemented locally on `main`:

- `recoverSharedClaudeRotationFence` now returns the existing normalized fence
  when all existing same-storage checks pass and the managed projection reports
  `tokens_unchanged`.
- `handleRedisClaudeRun` carries that retained fence through pre-run
  reconciliation and into the Claude launch. It creates a new fence only when
  no retained fence exists.
- If a rotation appears during the second pre-run read, AIM publishes it using
  the retained fence, clears that fence, and creates a fresh fence for the new
  run. The existing race-safe transition therefore remains intact.
- The signal regression now proves that the original serialized fence is still
  present during the retry, and that a clean unchanged retry clears the fence
  and retires the credential projection.
- The nonzero-exit regression now proves that repeated interruptions relaunch
  under the same fence and retain it for another retry.
- Existing other-home and arbitrary-Redis-lineage rejection assertions remain
  unchanged and pass.

Local proof:

- Test-first reproduction: the two new continuation expectations failed at the
  reported `recoverSharedClaudeRotationFence` branch before the source change.
- Focused projection test: `12/12` pass.
- Related Claude runner, supervisor, native-storage, projection, and fence
  tests: `47/47` pass.
- Full suite: `331/331` pass.
- Lint: pass.
- `git diff --check`: pass.

Live deployment and the no-model `pro5` recovery remain pending.

<!-- bugs:block:implementation:end -->
