# Plan Audit Log

Plan: `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md`
Audit log: `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30_PLAN_AUDIT.md`
Current plan verdict: ready
Current implementation code-review verdict: approve-with-notes
Last reviewed: 2026-05-31
Scope: full low-latency foreground relay implementation worktree

## Current Blocking Findings

None.

## Current Non-Blocking Findings

None.

## Current Implementation Findings

- [ ] IMP-001 - Real Codex smoke remains manual, not checked-in automation
  - Lens: proof-and-phase-exit, drift-proof-coupling
  - Scope: Phase 3 runtime proof
  - Plan expects: Phase 3 requires one real Codex attached smoke proving visible typed input and `sendExit()` close behavior through the foreground relay.
  - Code reality: The worklog records the real Codex pseudo-terminal smoke as passed, while checked-in repeatable coverage is the synthetic latency harness plus adapter/helper tests. That is acceptable for this local cutover because the plan asked to run and record the real smoke, not to add a real-Codex automation fixture.
  - Anchors: `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md` Phase 3; `scripts/smoke-codex-foreground-relay-latency.mjs`; `test/codex/foreground-relay.cases.js`
  - Required implementation repair: none before commit; future regression work should prefer a repeatable real-Codex smoke only if it can stay non-flaky and non-invasive.
  - Status: open
  - Resolution anchor:

- [ ] IMP-002 - Terminal-restore failure paths are code-covered indirectly
  - Lens: test-code-review, tiny-team-maintainability
  - Scope: foreground helper cleanup and failure handling
  - Plan expects: Helper-owned raw terminal entry/restoration, process-group cleanup, and fail-loud foreground relay startup behavior.
  - Code reality: `src/targets/codex-foreground-relay.py` restores terminal state in the `run()` `finally` path and on child-spawn failure, and `src/targets/codex-tender.js` fails loud for attached startup failures. The checked-in tests cover helper side-channel error propagation and real helper byte movement, but there is no dedicated automated test that forces every early-exit terminal-restore path.
  - Anchors: `src/targets/codex-foreground-relay.py`; `src/targets/codex-tender.js`; `test/codex/foreground-relay.cases.js`; `test/codex/codex-10.cases.js`
  - Required implementation repair: none before commit; add a narrower terminal-restore failure test only if this helper grows more cleanup branches.
  - Status: open
  - Resolution anchor:

- [ ] IMP-003 - Bounded snapshot truncation lacks a direct test
  - Lens: test-code-review, drift-proof-coupling
  - Scope: foreground helper snapshot ring
  - Plan expects: The helper keeps bounded output snapshot storage for manager-side resume prompt checks without carrying the full terminal stream over the side channel.
  - Code reality: `SNAPSHOT_LIMIT_BYTES` and ring truncation exist in `src/targets/codex-foreground-relay.py`, and resume-prompt snapshots are covered, but no checked-in test forces output beyond the bound and asserts old bytes are dropped.
  - Anchors: `src/targets/codex-foreground-relay.py`; `test/codex/foreground-relay.cases.js`
  - Required implementation repair: none before commit; add a focused truncation test if snapshot behavior becomes externally relied on beyond prompt confirmation.
  - Status: open
  - Resolution anchor:

- [ ] IMP-004 - Foreground helper errors still use the legacy `pty_helper_error` event type
  - Lens: docs-contract-drift, caller-invariant-state
  - Scope: Tend event naming
  - Plan expects: Attached foreground relay startup/runtime failures should fail loud and not look like a silent fallback to the legacy JSON PTY helper.
  - Code reality: Startup failure status/reason is foreground-specific, but generic helper-error events emitted by the foreground adapter are still recorded as `pty_helper_error`. This does not affect routing or failure behavior, but can confuse JSON event readers.
  - Anchors: `src/targets/codex-tender.js`
  - Required implementation repair: none before commit; rename or alias the event in a later cleanup if callers start consuming this diagnostic event.
  - Status: open
  - Resolution anchor:

## Relevant Code Coverage Ledger

| Area | Files/symbols read | Why relevant | Reader | Status |
| --- | --- | --- | --- | --- |
| Canonical owner path | `src/targets/codex-tender.js`, `runCodexTender()`, `waitForResumePrompt()` | Attached/no-attach runtime selection, Tend state machine, resume prompt side-channel control | parent | read |
| Foreground relay primitive | `src/targets/codex-foreground-relay.py`, `src/targets/codex-foreground-relay.js` | Raw human byte path, PTY child setup, side-channel protocol, snapshots, cleanup | parent | read |
| Legacy and non-attached path | `src/targets/codex-pty.js`, `createCodexPtySession()` | Confirms JSON helper remains scoped to `--no-attach` and legacy tests, not attached default | parent | read |
| Caller families | `src/cli/commands/codex.js`, `src/cli/help.js`, `README.md` | Public command behavior, obsolete tmux option error, user-facing docs | parent | read |
| Tests as code | `test/codex/codex-10.cases.js`, `test/codex/foreground-relay.cases.js`, `test/codex/use-watch.test.js` | Runtime selection, fail-loud behavior, adapter side channel, helper integration, aggregator wiring | parent | read |
| Contract/proof surfaces | `scripts/smoke-codex-foreground-relay-latency.mjs`, implementation worklog receipts | Latency gate, output-load guard, recorded real smoke context | parent | read |
| Historical doc drift | `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md` | Avoid stale PTY-supervisor wording as current foreground proof | parent | read |

## Required Lens Checklist

- [x] Outcome North Star
- [x] Ambiguity and miscommunication
- [x] Requirements, constraints, and simplicity
- [x] Tiny-team maintainability
- [x] Depth-first implementation risk
- [x] Code-truth map
- [x] Canonical owner and SSOT
- [x] Existing pattern and convergence
- [x] Caller, invariant, and state model
- [x] Drift-proof coupling
- [x] Elegance and code-judo
- [x] Deletion and side-door closure
- [x] Proof and phase exit
- [x] Conditional lenses: docs-contract-drift, security/process-boundary

## Ambiguity And Decision Ledger

| ID | Ambiguity/constraint question | Interpretations | Impact | Required decision | Decision owner | Plan carry-through evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | none | none | none | none | none | none | resolved |

## Pass History

### Pass 1 - 2026-05-31

- Mode: implementation-audit
- Scope: full worktree implementation for `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md`
- Baseline reviewed: current worktree on branch `redis-credential-coordination`
- Test/CI context accepted, if supplied: worklog says `node --test test/codex/use-watch.test.js`, `npm run lint`, `npm test`, latency smoke, real Codex foreground smoke, Tend resume-prompt side-channel smoke, runtime search, and `npm run install:local` passed before this audit; after test-file decomposition, `node --test test/codex/use-watch.test.js` was rerun and passed 64 tests.
- Agents/lenses run: parent implementation-audit lenses; no native audit subagents because the changed behavior is confined to the Tend runtime boundary, one new relay helper/adapter, one latency script, and associated tests/docs.
- Code areas read: `src/targets/codex-tender.js`, `src/targets/codex-foreground-relay.py`, `src/targets/codex-foreground-relay.js`, `src/targets/codex-pty.js`, `test/codex/codex-10.cases.js`, `test/codex/foreground-relay.cases.js`, `test/codex/use-watch.test.js`, `scripts/smoke-codex-foreground-relay-latency.mjs`, `src/cli/commands/codex.js`, `src/cli/help.js`, `README.md`, and the historical PTY-supervisor plan doc.
- Findings added: IMP-001, IMP-002
- Findings resolved: none
- Findings carried forward: IMP-001, IMP-002 as non-blocking notes
- Verdict: approve-with-notes
- Next audit focus: rerun only if `$fresh-consult` or final verification finds a blocker, or if code changes after this pass.

### Pass 2 - 2026-05-31

- Mode: implementation-audit consult reconciliation
- Scope: fresh-consult notes against the same foreground relay implementation worktree
- Baseline reviewed: current worktree after relay test-file decomposition
- Test/CI context accepted, if supplied: parent reran `npm run lint`, `npm test`, and `node scripts/smoke-codex-foreground-relay-latency.mjs`; fresh consult also reported focused tests, full tests, and latency smoke passing.
- Agents/lenses run: `$fresh-consult` with `runtime=agent`, `model=composer-2.5-fast`, `effort=encoded-in-model`; parent reconciled notes under implementation-audit lenses.
- Code areas read: no new code edits in this pass; consult read the plan, audit log, foreground relay helper/adapter, Tend runtime, legacy PTY path, CLI/help/docs, tests, and latency harness.
- Findings added: IMP-003, IMP-004
- Findings resolved: none
- Findings carried forward: IMP-001, IMP-002, IMP-003, IMP-004 as non-blocking notes
- Verdict: approve-with-notes
- Next audit focus: no blocker-driven audit remains before commit; rerun only if code changes after this point.
