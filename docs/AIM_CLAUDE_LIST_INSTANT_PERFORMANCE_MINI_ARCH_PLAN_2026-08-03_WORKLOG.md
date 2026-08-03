# Worklog

Plan doc: `docs/AIM_CLAUDE_LIST_INSTANT_PERFORMANCE_MINI_ARCH_PLAN_2026-08-03.md`

## Initial entry

- Run started on `perf/aim-claude-list-instant-20260803`.
- Current phase: bounded scanner and proof.
- Pre-change `aim claude list 50 --json` completed in 7.4 seconds.
- Operator cut worker parallelism after benchmarks showed only a 3.9ms p95
  scan improvement; implementation will remain synchronous.

## Phase 1 (bounded scanner and proof) Progress Update

- Work completed:
  - Added lightweight candidate discovery and bounded recent selection in the
    existing synchronous session owner.
  - Read transcript files as buffers and decode only metadata-bearing JSONL
    records; numeric resume uses the same bounded ordering as list.
  - Installed the canonical local wrapper with `npm run install:local`.
- Tests run + results:
  - Focused session suite: 8/8 passed.
  - Full serialized suite: 307/307 passed; lint and `git diff --check` passed.
  - Installed default list: 179.0ms median / 185.0ms p95 across seven runs.
  - Installed first invocation: 193.6ms; returned 50 rows.
- Issues / deviations:
  - Worker parallelism was removed by explicit operator direction because it
    saved only 3.9ms p95.
  - Two ordinary parallel full-suite runs hit the existing security-adapter
    subprocess flake; its focused suite passed 4/4 and the serialized full
    suite passed 307/307.
- Next steps:
  - None. Phase complete.
