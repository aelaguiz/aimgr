---
title: "AIM Claude List Instant Performance - Mini Architecture Plan"
date: 2026-08-03
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [codex-gpt-5.6-read-only]
doc_type: mini_architecture_plan
related:
  - docs/aelaguiz/AIM_CLAUDE_RECENT_SESSIONS_2026-07-24.md
  - docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md
---

# TL;DR

`aim claude list` currently takes about **6 seconds** because it reads and
JSON-parses all **1,238 transcripts / 2.11 GiB** before keeping the newest 50.
The fix is one bounded, read-only scanner in the existing session module:

1. Discover and `stat` every transcript without reading its content.
2. Visit newest candidates first and extract only the few JSONL records that
   can define session metadata.
3. Parse that bounded candidate window sequentially, then stop as soon as
   older candidates cannot enter the result set.

The measured bounded prototype preserved all 50 rows, order, titles,
directories, and timestamps exactly. Sequential full-metadata extraction took
**39.9ms median / 42.6ms p95**. Four workers saved only **3.9ms p95**, so the
operator explicitly cut parallelism rather than add worker machinery for an
immaterial end-to-end gain. No worker, cache, index, daemon, Redis data,
Claude history mirror, or command loader refactor is needed. The implementation
target is an installed-command warm p95 of **250ms or less**.

<!-- arch_skill:block:planning_passes:start -->

planning_passes:
  mode: one-pass-mini
  internal_grounding: complete
  live_benchmark: complete
  bounded_prototype: complete
  parallel_prototype: complete_rejected_as_immaterial
  external_research: not_needed
  independent_scope_review: pass_then_superseded_by_user_scope_cut
  scope_freeze: complete_after_user_parallelism_cut
  implementation: complete

<!-- arch_skill:block:planning_passes:end -->

# 0) North Star

## 0.1 Claim

`aim claude list` feels immediate on Amir's normal local corpus even as managed
Claude transcripts grow into multiple gigabytes.

## 0.2 In scope

1. Make default and counted `aim claude list [count]` proportional to the
   requested recent rows, not all historical transcript bytes.
2. Parse each bounded recent candidate window sequentially in the foreground.
3. Preserve the current text and JSON fields, live-corpus ordering, title
   precedence, directory, account, and staged-fork exclusion behavior.
4. Keep numeric resume aligned with the exact ordering shown by `list`; preserve
   exact UUID and exact-name resume behavior.
5. Prove behavior and bounded reads with focused tests, then prove speed with
   the installed command on the real local corpus.

## 0.3 Explicitly out of scope

1. A session cache, index, database, daemon, watcher, Redis record, or use of
   Claude's `history.jsonl` as another session authority.
2. Changes to Claude launch, credentials, leases, rotation, account selection,
   session forking, cross-machine aggregation, or fleet behavior.
3. CLI output changes, new flags, search, pagination, cleanup, retention, or a
   generic session framework.
4. A persistent or generic worker pool, adjustable concurrency, autoscaling,
   byte-budget scheduling, parallel directory traversal, or all-history fanout.
5. Optimizing exact-name resume or CLI dependency loading: the measured 138.5ms
   p95 empty-home startup floor still fits the 250ms end-to-end budget.

## 0.4 Definition of done

| Result | Required bar |
|---|---|
| Default list is effectively instant | Seven warm installed-command runs on a quiescent corpus of at least 1,000 transcripts / 2 GiB have median <= 200ms and p95 <= 250ms. |
| First invocation is bounded | The first installed-command run after installation is <= 500ms on the same machine and corpus. |
| Output is unchanged | Before/after `--json` results match for rank, `lastUsedAt`, account, name, ID, and cwd on a quiescent corpus. |
| Requested limit controls work | `list 1` does not read every transcript; its result equals row 1 of the default list. |
| Resume remains trustworthy | Numeric resume selects the row just displayed; UUID/name ambiguity and missing-directory failures retain current behavior. |
| Work stays bounded | After the result bound closes, older transcript content is not read; at most one transcript buffer is live at a time. |

## 0.5 Invariants

- Listing stays local, read-only, foreground-only, and Redis-free.
- Claude's transcript JSONL remains the sole session metadata authority.
- Latest non-empty custom title wins over latest non-empty AI title, then UUID.
- Latest valid top-level cwd, model, and effort retain their current validation
  and malformed-tail tolerance; the last valid event in append order supplies
  recency, with mtime as the existing no-timestamp fallback.
- No performance fix may weaken staged-fork exclusion, symlink rejection,
  duplicate-ID/name detection, or resume's exact model/effort requirement;
  no candidate outside the current bounded round is read.

## 0.6 Scope and Simplicity Contract

| Contract item | Frozen meaning |
|---|---|
| Human-authorized outcome | Amir's 2026-08-03 request to benchmark `aim claude list`, make it basically instant, and the later explicit simplification: "if parallelism doesn't help don't do it." |
| Smallest sufficient solution | One synchronous two-pass scanner and one targeted JSONL metadata extractor for only the bounded recent candidate window, plus focused tests and a repeat of this benchmark. |
| Initial minimal convergence closure | Numeric row resume must use the same recent-order function as `list`; otherwise a faster list could display row N while resume opens a different thread. UUID/name resolution keeps its existing contract. No other convergence is required. |
| Scope freeze | Re-frozen after the operator explicitly cut immaterial parallelism. Workers, loader work, persistence, command UX, Redis, runtime, and cleanup require separate human approval. |
| Enough proof | Existing session behavior tests, focused bounded-read/order tests, one full suite, and before/after installed-command timing on the real corpus. |
| Do-not-build boundary | No worker threads, async API conversion, pool, concurrency option, cache/index invalidation, background process, history mirror, performance service, benchmark framework, schema, compatibility path, or speculative fallback. |
| Accepted residual risk | The fast path relies on Claude's normal append-written contract: file order is event order and mtime is not earlier than the newest event. A manually edited out-of-order transcript or restored file with an artificially old preserved mtime can fall outside the expected recent order; exact UUID resume remains available. |

# 1) Benchmark and Research Grounding

<!-- arch_skill:block:research_grounding:start -->

## 1.1 Measurement setup

Measurements were taken on 2026-08-03 from the canonical local command:

```text
~/.local/bin/aim
  -> /opt/homebrew/bin/node
  -> /Users/aelaguiz/workspace/aimgr/bin/aimgr.js
  -> checkout HEAD cadf5f8a0e23d50a7fd37397d17e0dedee25d44c
```

The command output was discarded during timing. No Redis or provider call is
on the `list` branch. The local workload contained 1,238 valid transcript
files totaling 2.11 GiB.

## 1.2 End-to-end baseline

| Command/workload | Runs | Median | p95 | Finding |
|---|---:|---:|---:|---|
| `aim claude list` | 7 warm | 6,070.9ms | 7,344.9ms | Current user-visible baseline. |
| `aim claude list 1` | 2 warm | 6,290.2ms | 6,535.1ms | Asking for one row still processes the whole corpus. |
| `aim claude list 50 --json` | 2 warm | 6,169.8ms | 6,236.8ms | Rendering/format is not the bottleneck. |
| Empty-home installed command | 20 warm | 127.9ms | 138.5ms | Fixed Node/CLI floor; acceptable under the target budget. |

The first untuned run was 8.98s wall time, 7.11s user CPU, and 0.97s system
CPU. This is dominated by local parsing, not waiting on network I/O.

## 1.3 Workload isolation

| Experiment | Result | Decision |
|---|---:|---|
| Discover + stat all 1,238 candidates | 12.48ms | Directory traversal is cheap; retain it. |
| Newest 50 transcript volume | 156.2 MiB | Reading only requested candidates removes about 93% of bytes. |
| Lazy newest-51 selection using the existing full JSON parser | 420.5ms median scan-only | Moving `slice` earlier helps but is not enough for a <=250ms command. |
| Lazy newest-51 targeted metadata prototype | 38.6ms median / 43.6ms p95 scan-only | Meets the projected budget when added to the 138.5ms CLI floor. |
| Prototype fidelity against current code | 50/50 same rank, title, cwd, timestamp | The bounded architecture preserved the live result exactly. |

Claude's per-account `history.jsonl` files were also evaluated: all 17 files
together are only 1.0 MiB, but their project/cwd value matched the canonical
transcript result for only 17 of the current top 50 sessions. Using that file
would be faster but would change output and create a second metadata authority,
so the plan rejects it.

## 1.4 Parallelization benchmark

Each result includes candidate discovery, worker creation where applicable,
file reads, metadata extraction, and result return. Runs were interleaved on
the same bounded recent workload.

| Strategy | Runs | Median | p95 | Decision |
|---|---:|---:|---:|---|
| Sequential full metadata, 54 candidates | 12 | 39.9ms | 42.6ms | Valid fallback baseline. |
| Best `fs.promises` batch (16) | 12 | 39.2ms | 47.3ms | Reject: worse p95 and broader async API for no gain. |
| Two one-shot workers | 7 | 41.3ms | 51.1ms | Reject: worse than sequential. |
| Four one-shot workers, full metadata | 12 | 34.1ms | 38.7ms | Reject after operator simplification: 3.9ms p95 is immaterial end to end. |
| Eight one-shot workers | 7 | 32.1ms | 42.6ms | Reject: lower median but worse p95 and twice the fanout. |

Four workers reduce scan p95 by only 3.9ms after including worker startup,
about 2% of projected end-to-end time. The operator explicitly rejected that
complexity. The implementation remains synchronous and sequential.

## 1.5 Code anchors

| Evidence | Conclusion |
|---|---|
| `src/targets/claude-sessions.js:31-101` reads each whole transcript, splits it, and `JSON.parse`s every line. | Parsing message bodies is the dominant cost even though list needs only sparse metadata records. |
| `claude-sessions.js:103-146` calls that parser for every valid transcript and only then sorts all sessions. | Work scales with total historical bytes. |
| `claude-sessions.js:148-157` applies `slice(0, limit)` after the full scan. | Requested count currently saves no I/O or parsing. |
| `claude-sessions.js:160-190` shares the same full scan for numeric, UUID, and name resolution. | Numeric resolution must move with recent-list ordering; UUID/name can specialize. |
| `src/cli/commands/claude.js:871-904` performs list/read/render locally and returns before Redis checks. | No credential, provider, or coordination change belongs in this plan. |

External research is unnecessary. The performance contract and data format are
fully determined by this repository and the measured local corpus.

<!-- arch_skill:block:research_grounding:end -->

# 2) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

```text
aim claude list [N]
  -> load Claude command graph
  -> traverse every account/project directory
  -> for every transcript:
       read entire file
       split every JSONL line
       JSON.parse every line, including large message bodies
       retain sparse session metadata
  -> sort every session by embedded timestamp
  -> slice first N
  -> render text or JSON
```

The current complexity is `O(total historical transcript bytes)` for every
invocation. The limit is presentation-only, not a work bound.

<!-- arch_skill:block:current_architecture:end -->

# 3) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

```text
aim claude list [N]
  -> discover candidates: account + UUID + path + mtime
  -> sort lightweight candidates by mtime, newest first
  -> read max(1, N-valid)+3 candidates sequentially
       targeted parser preserves title/cwd/timestamp/model/effort rules
  -> after N valid rows, stop only when next mtime < Nth timestamp
       if still open, dispatch the next bounded round
  -> sort parsed candidates with the existing comparator
  -> return first N and render unchanged
```

The same module remains the sole owner. There is no persisted derived state.
Common-case work becomes `O(file count log file count + bytes in recent N)`;
the default round reads at most 53 recent candidates instead of all 1,238.

The metadata extractor reads a candidate buffer once but only parses lines
that can define an output field. It searches backward so the first validated
match supplies the latest cwd, append-ordered timestamp, or runtime metadata.
It separately finds the latest valid custom and AI titles, then applies the
existing custom over AI precedence. Message/tool payload lines are never
parsed merely to list a session.

For every round, compute `needed = max(1, limit - validSessionCount)` and
`roundSize = min(remainingCandidateCount, needed + 3)`. Partition that round
sequentially through the canonical extractor. Apply the strict early-stop rule
and create another bounded round only if the result bound remains open. The
first default round is 53 candidates; if it yields only 49 valid sessions, the
next round is four, not another 53. This bounds speculative reads to three in
every round and live transcript content to one file buffer.

Early-stop is exact under the frozen append-written contract: continue until
at least `N` valid sessions exist, sort parsed sessions by
`lastUsedMs DESC, threadId ASC`, and stop only when
`nextCandidate.mtimeMs < nthSession.lastUsedMs`. Equality must continue because
a lower thread ID can still win the tie.

Selector behavior stays explicit:

- Numeric selector: call the same bounded recent selector through the requested
  rank, then validate the chosen cwd.
- UUID selector: parse every filename match across homes and report ambiguity
  only when more than one match produces a valid session, matching the current
  malformed/no-cwd exclusion rule.
- Name selector: parse candidates as needed to preserve global exact-name
  ambiguity detection; inspect all valid sessions before declaring a unique
  match. This path is correct-first and has no new speed promise.

<!-- arch_skill:block:target_architecture:end -->

# 4) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

| Surface | Required change | Explicit non-change |
|---|---|---|
| `src/targets/claude-sessions.js` | Separate discovery from extraction; add bounded synchronous recent selection and specialized numeric/UUID/name resolution without changing returned session shape. | No workers, async API conversion, scheduler, configuration, persistence, or fallback reader. |
| `test/claude/claude-sessions.test.js` | Preserve existing contracts; cover bounded rounds, large payloads, append order, mtime equality, malformed/duplicate inputs, and selector alignment. | No timing assertion in unit tests and no new benchmark harness. |
| `src/cli/commands/claude.js` | No change: the existing synchronous list/resolver calls keep their contract. | No output, Redis, launch, option, or top-level CLI change. |
| Unchanged surfaces: `src/cli/main.js`, `src/cli/deps.js`, help, README | Measure the existing loader only; no user-facing command change. | No loader optimization, migration guide, or duplicate performance report. This document is the planning SSOT. |

No other production caller owns recent-session ordering. Direct callers of
`readManagedClaudeSessions`, `listRecentManagedClaudeSessions`, and
`resolveManagedClaudeSession` are confined to this module's list/resume path
and focused tests.

<!-- arch_skill:block:call_site_audit:end -->

# 5) Phase Plan

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 - Bounded scanner and proof

**Status: COMPLETE**

**Completed work:** The canonical synchronous session module now discovers
lightweight candidates, reads only bounded recent transcript buffers, decodes
only metadata-bearing JSONL records, and uses the same bounded ordering for
numeric resume. No worker or async API was added.

**Goal:** Make the installed default list complete in <=250ms p95 without a
new source of truth or any runtime/credential change.

**Checklist:**

- [x] Factor traversal into lightweight candidate discovery and replace
  parse-every-line behavior with one targeted reverse metadata extractor,
  preserving label/file/symlink/UUID/marker validation plus cwd, title, model,
  effort, append-ordered recency, and malformed-tail behavior.
- [x] Parse `max(1, limit - validSessionCount) + 3` candidates per round through
  the synchronous canonical extractor, capped by remaining candidates; repeat
  only while the strict early-stop bound remains open.
- [x] Route numeric resume through the same bounded selector; preserve valid-only
  UUID duplicate detection and full-session exact-name ambiguity semantics.
- [x] Extend only `test/claude/claude-sessions.test.js`, then run that file,
  lint, `git diff --check`, and the existing full suite once.
- [x] Repeat the installed-command benchmark, compare quiescent
  before/after JSON results, and record the measured result in this document's
  implementation audit before claiming completion.

**Exit criteria:**

- The Definition of Done table passes in full.
- A focused test proves old candidates are not opened after the bound closes.
- Focused tests prove equality does not close the bound, malformed UUID matches
  do not create false ambiguity, and name uniqueness still scans all valid
  sessions.
- Focused proof shows older transcript content is not read after the bound
  closes; list/resume/fork behavior remains unchanged.
- The diff stays within the call-site audit (plus this plan's later audit
  update) and contains no cache, index, daemon, history reader, Redis change,
  loader fast path, or new command surface.

<!-- arch_skill:block:phase_plan:end -->

# 6) Verification Protocol

1. Capture one quiescent pre-change `aim claude list 50 --json` result in a
   temporary file outside the repo; delete it after comparison.
2. Run `node --test test/claude/claude-sessions.test.js`, `npm run lint`,
   `git diff --check`, and `npm test` once.
3. Install through the existing local installer only after functional tests
   pass; do not deploy to the fleet in this scope.
4. Capture one first-run timing, then seven warm runs of default, `1`, and JSON
   modes with output discarded.
5. Verify the performance budget and exact before/after JSON projection; if
   p95 exceeds 250ms, stop and report the remaining measured stage rather than
   adding loader work or persistence.

# 7) Compatibility and Rollback

- Text and JSON schemas do not change.
- Transcript JSONL remains canonical; no data migration or invalidation exists.
- Rollback is one code revert. No cleanup or state repair is needed.
- Exact UUID resume remains the stable escape hatch for any unusual restored
  transcript excluded by the mtime early-stop assumption.

# 8) Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-03 | Optimize transcript selection/parsing, not rendering or Redis. | Limit 1 and JSON take the same six seconds; the list branch performs no Redis work. |
| 2026-08-03 | Reject a persisted index/cache and Claude `history.jsonl`. | Neither is needed; history failed cwd fidelity and persistence adds invalidation/authority complexity. |
| 2026-08-03 | Use targeted reverse JSONL extraction. | Simply parsing only the newest 51 still measured 420.5ms scan-only; targeted extraction measured 43.6ms p95 with exact live output. |
| 2026-08-03 | Keep CLI loader optimization out of scope. | The measured startup floor plus prototype scan projects below the 250ms budget. |
| 2026-08-03 | Keep exact-name search correctness-first. | The requested outcome is instant listing; changing name semantics or adding an index is unnecessary. |
| 2026-08-03 | Treat Claude JSONL order as event order on the fast path. | Preserving defensive max-over-arbitrarily-reordered timestamps would require scanning historical message records and is not needed for Claude-written append-only files. Hand-edited/recovered anomalies are an accepted residual with UUID resume available. |
| 2026-08-03 | Use four one-shot workers for bounded recent extraction. | Four workers improved full-metadata scan p95 from 42.6ms to 38.7ms including startup; async reads and two/eight workers had worse p95. Persistent pools and tuning knobs are not justified. |
| 2026-08-03 | Scope cut (user-approved): omit worker parallelism. | Amir explicitly said, "if parallelism doesn't help don't do it." A 3.9ms scan-p95 gain is immaterial against the ~180ms projected end-to-end command, so implementation stays synchronous and avoids a worker file plus Promise call-site churn. |

# 9) Completion Verdict

Complete. The installed canonical command meets every latency budget without
parallelism: default `aim claude list` measured **179.0ms median / 185.0ms
p95**, and the first post-install JSON invocation measured **193.6ms**. The
bounded result matched the full canonical scan for all 50 rows on the live
corpus. The only production change is the existing synchronous session module.

# 10) Implementation Audit

<!-- arch_skill:block:implementation_audit:start -->

| Proof | Result |
|---|---|
| Focused session suite | PASS: 8/8, including bounded reads, equality-bound continuation, valid-only duplicate UUID handling, list/resume ordering, titles, model/effort, malformed tails, and fork staging. |
| Full suite | PASS: 307/307 with `--test-concurrency=1`. Two ordinary parallel `npm test` runs exposed the pre-existing security-adapter subprocess flake; its focused file passed 4/4. |
| Static checks | PASS: `npm run lint` and `git diff --check`. |
| Live ordering | PASS: bounded and full canonical scans matched all 50 fields on the live corpus. The earlier before/after capture had 42 stable rows match exactly; eight active rows advanced while sessions were writing. |
| Installed default | PASS: seven runs, 179.0ms median / 185.0ms p95. |
| Installed `list 1` | PASS: seven runs, 147.0ms median / 165.5ms p95. |
| Installed JSON | PASS: seven runs, 175.6ms median / 184.2ms p95. |
| First post-install invocation | PASS: 193.6ms, 50 rows, below the 500ms ceiling. |
| Scope | PASS: no workers, Promise conversion, cache, index, daemon, Redis, loader, output, or fleet changes. |

Implementation verdict: **COMPLETE**.

<!-- arch_skill:block:implementation_audit:end -->
