# Worklog

Plan:
`docs/CLAUDE_ACTIVE_ROTATION_LIVE_REDIS_PUBLISH_2026-07-24.md`

## Initial entry

- Recorded at: 2026-07-24T16:51:05Z.
- Starting branch: `main`.
- Starting commit: `f01bf8d1feec8ab849c4bdc3eeea1c9378916dfc`.
- Current phase: Phase 1 - implement and prove the active-owner fix.
- Frozen production scope: `src/cli/commands/claude.js`.
- Frozen test scope: one focused case in
  `test/cli/redis-projection-command.test.js`.
- Frozen documentation scope: this plan and worklog only.
- Explicit exclusions: no maintainer/Codex/status/schema/Keychain/browser/model
  work, no generic watcher or daemon, no refactor, no unrelated cleanup, and no
  mutation of the existing `pro5` process.
- Pre-existing unrelated untracked files are preserved and excluded.
- Self-check: on track; on scope; no drift detected.
- Next step: create the feature branch, implement the smallest owner-local
  serialized publisher, and prove the pre-exit Redis update.

## Phase 1 implementation and repair proof

- Recorded at: 2026-07-24T17:01:41Z.
- Branch: `feature/claude-live-rotation-publish`.
- Implemented one private, fixed 30-second serialized publisher inside the
  existing managed Claude run owner.
- It starts only after the existing lease/fence boundary, uses the existing
  managed-file reconciliation and Redis CAS publisher, stops before the
  existing exit-time reconciliation, and is disabled for the bounded
  maintenance run.
- The focused test holds the fake child open and proves:
  - first real token rotation publishes Redis v1 to v2 before child exit;
  - an expiry-only rewrite of the same tokens does not create v3;
  - a second real token rotation under the same fence publishes v2 to v3;
  - a fully unchanged tick leaves Redis at v3;
  - normal exit clears the fence and disposable credential projection.
- Fresh audit initially found the expiry-only duplicate-version edge. The
  accepted repair compares the candidate token lineage with the current Redis
  record before publication; no new abstraction or test case was added.
- Final post-repair local proof:
  - focused managed-run file: 16/16 passed;
  - full repository suite: 346/346 passed;
  - lint: passed;
  - `git diff --check`: passed.
- The audit role is rechecking the exact repair before Phase 1 closes.
- Self-check: on track; on scope; no drift detected. Production and test edits
  remain inside the frozen two-file change map; the unrelated untracked files
  remain untouched.

## Phase 1 audit closeout

- Result: APPROVED / PASS.
- The first audit's same-lineage finding was repaired and proved.
- The repair recheck found one guard-order issue: a wrong resolved label had
  to fail before the same-lineage early return. The existing label assertion
  was moved ahead of that return.
- Post-repair proof was rerun again: 346/346 passed, lint passed, and
  `git diff --check` passed.
- Final independent verdict: no remaining findings; every Phase 1 checklist
  item and exit criterion passes; implementation complexity is appropriate
  and not overbuilt.
- Phase 1 is complete. Phase 2 is active.
- Self-check: on track; on scope; no drift detected.
