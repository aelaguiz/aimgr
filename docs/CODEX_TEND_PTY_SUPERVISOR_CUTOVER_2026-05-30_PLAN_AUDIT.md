# Plan Audit Log

Plan: `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`
Audit log: `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30_PLAN_AUDIT.md`
Current plan verdict: ready
Current implementation code-review verdict: approve-with-notes
Last reviewed: 2026-05-30
Scope: whole plan, pre-implementation readiness plus implementation audit

## Current Blocking Findings

None.

## Current Non-Blocking Findings

None currently unresolved.

Previously raised non-blocking notes were folded into the plan before this verdict:

- Composer noted helper IPC, goal-intent detection, Tend return shape, and Python prerequisite gaps. The plan now carries helper path/invocation/protocol, raw-input `/goal` detection, PTY-shaped status payloads, and `python3`/`AIMGR_PYTHON_BIN` requirements.
- Explorer PTY-helper review noted the helper ABI needed to be pinned. The plan now pins `src/targets/codex-pty-helper.py`, `import.meta.url` resolution, NDJSON/base64 frames, resize/exit/error handling, stderr separation, signal behavior, and protocol tests.
- Explorer rollout review noted current Codex emits `thread_goal_updated`, not `thread_goal_created`, and explicit resume should tolerate a `session_meta.id` fallback. The plan now uses current `thread_goal_updated` fixtures and adds the fallback.
- Explorer side-door review noted the May 23 overnight doc was still conditional and `--remote` rejection wording could drift. The plan now makes the May 23 doc a mandatory Phase 3 superseded/historical update and preserves `--remote` rejection with PTY/rollout wording.
- Composer final pass returned `pass-with-notes`, `BLOCKING: none`, `CONFIDENCE: high`; the remaining notes were wording-level and folded where useful.

## Current Implementation Findings

### IMP-001 - Thermo-nuclear code quality review

Verdict: approve

Blocking findings: none.

Findings-first review:

- No structural code-quality blocker was found in the implemented PTY/rollout Tend cutover.
- The implementation avoided the biggest risk the plan called out: it deleted the old
  tmux/app-server runtime instead of hiding it behind a fallback branch.
- `src/targets/codex-tender.js` stayed at `610` lines, below the plan's 1000-line decomposition
  threshold.
- The code uses focused modules for the new concepts:
  - `src/targets/codex-pty.js` for the Node PTY session adapter.
  - `src/targets/codex-pty-helper.py` for POSIX PTY child ownership.
  - `src/targets/codex-rollout.js` for rollout JSONL identity and goal status.
  - `src/targets/codex-tend-lock.js` for per-thread Tend ownership locks.
  - `src/io/json-store.js` for replacement-based writes.
- The main code-quality tradeoff is intentional: `runCodexTender()` remains a single orchestration
  state machine rather than being split into many tiny abstractions. At its current size, that is
  more legible than scattering lifecycle state across a new framework.
- Non-blocking note: the later attached-latency RCA shows this first PTY architecture is not the
  final foreground-human transport. That is now tracked in
  `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md`, not treated as a blocker against
  this tmux/app-server removal plan.

### IMP-002 - `$plan-audit` implementation check

Verdict: approve-with-notes

Blocking findings: none.

Plan-code-fit result:

- Phase 1 obligations are satisfied by code:
  - repo-owned Python PTY helper exists and compiles;
  - Node/helper JSON-line protocol exists;
  - attached relay/raw-mode handling exists;
  - rollout parser/resolver/tailer exists;
  - per-thread lock helper exists;
  - atomic write helper exists;
  - focused tests cover the planned seams.
- Phase 2 obligations are satisfied by code:
  - `runCodexTender()` builds structured argv/env and removes `--remote`;
  - new starts set `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`;
  - explicit resume is UUID-validated and rollout-backed;
  - owned rollout `usageLimited` is the only rotation trigger;
  - old generic pane/global usage triggers are gone;
  - tmux/app-server code paths are not live;
  - CLI rejects obsolete `--tmux-session`.
- Phase 3 obligations are satisfied by code/docs/current evidence:
  - README/help describe the PTY supervisor and `--bind-timeout-seconds`;
  - old live-looking docs carry superseded/historical notices;
  - lint, focused Codex tests, and full tests pass;
  - local install was refreshed and `aim --help` resolves to this checkout.
- Non-blocking note: current manual smoke evidence is accepted from the durable worklog/plan
  receipts. It was not rerun in this pass because the plan explicitly says not to rerun the PTY
  smoke after compaction unless PTY helper/supervisor code changed.

## Relevant Code Coverage Ledger

| Area | Files/symbols read | Why relevant | Reader | Status |
| --- | --- | --- | --- | --- |
| Canonical owner path | `src/targets/codex-tender.js`: `runCodexTender`, `buildCodexCommand`, `createTmuxAdapter`, `discoverOwnedThreadId`, app-server goal reads, pane/global usage triggers | Current Tend architecture to replace | Parent + explorer | read |
| CLI caller family | `src/cli/commands/codex.js`, `src/cli/args.js`, `src/cli/help.js`, `README.md` | Public `aim codex run --tend` contract and stale tmux/help surfaces | Parent + explorer | read |
| Private app-server side door | `src/targets/codex-app-server.js`, imports from `codex-tender.js`, `rg codex-app-server` | Confirm whether helper can be deleted or must be kept for non-Tend owners | Explorer + Composer | read |
| Auth write path | `src/io/json-store.js`, `src/targets/codex-cli.js` | Atomic `auth.json` write requirement and shared-auth tradeoff | Composer + parent | read |
| Managed path patterns | `src/io/paths.js`, `scripts/install-local-bin.sh`, `bin/aimgr.js`, `package.json`, `package-lock.json` | Helper path, local install, Node ESM, Python prerequisite, no npm PTY dependency | Explorer + Composer | read |
| Tests and proof surfaces | `test/codex/codex-10.cases.js`, `test/codex/use-watch.test.js`, `package.json` test scripts | Existing tests protect old tmux/app-server behavior; new `.test.js` convention | Explorer + parent | read |
| Superseded docs and side doors | `docs/codex-tend-multi-instance-plan-2026-05-30.md`, `docs/codex-tend-redesign-2026-05-30.md`, `docs/codex-tend-path-bug-analysis-2026-05-30.md`, `docs/codex-tend-instability-findings-2026-05-30.md`, `docs/codex-overnight-account-rotation-proposals-2026-05-23.md` | Ensure humans/agents cannot follow old tmux/app-server guidance after implementation | Explorer + parent | read |
| Codex rollout source | `/Users/aelaguiz/workspace/codex/codex-rs/protocol/src/protocol.rs`, `rollout/src/recorder.rs`, `rollout/src/list.rs`, `core/src/goals.rs`, `core/src/codex_delegate.rs`, `core/src/thread_manager.rs`, `tui/src/app_server_session.rs`, `tui/src/lib.rs`, `tui/src/app/thread_goal_actions.rs`, `login/src/auth/default_client.rs` | Validate originator, `session_meta`, `thread_source`, `source`, `thread_goal_updated`, resume-by-id, complete-line JSONL, sub-agent discrimination | Explorer | read |
| Composer external plan review | `/tmp/fresh-consult/codex-tend-pty-plan-composer2-20260530-ivvP2Y`, `/tmp/fresh-consult/codex-tend-pty-plan-composer4-20260530-HiZCLr` | User-requested Composer25 Fast gate | Parent | read |
| Current implementation | `src/targets/codex-tender.js`, `src/targets/codex-pty.js`, `src/targets/codex-pty-helper.py`, `src/targets/codex-rollout.js`, `src/targets/codex-tend-lock.js`, `src/io/json-store.js`, `src/cli/commands/codex.js`, `src/cli/help.js`, `README.md`, `test/codex/codex-10.cases.js` | Plan-backed implementation audit and thermo-nuclear code-quality review | Parent | read |

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
- [x] Conditional lens: docs-contract drift
- [x] Conditional lens: security/process/auth boundary

## Ambiguity And Decision Ledger

| ID | Ambiguity/constraint question | Interpretations | Impact | Required decision | Decision owner | Plan carry-through evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | Should Tend keep tmux as the terminal runtime? | Keep tmux and harden names/attach, or remove tmux entirely | User-visible terminal corruption remains if tmux stays | Remove tmux from Tend runtime | User + plan | TL;DR non-negotiables, Section 5.4, Phase 2 exit criteria | resolved |
| DEC-002 | Should Tend keep a private Codex app-server? | Keep private app-server or read rollout files directly | Keeps process leaks, loopback security risk, loaded-thread ambiguity | Remove private app-server from Tend runtime | User + plan | TL;DR non-negotiables, Section 6 delete list, Phase 2 exit criteria | resolved |
| DEC-003 | Which PTY backend should implementation use? | `node-pty`, prebuilt addon, tmux, or repo-owned POSIX helper | Native addon failed local smoke; multiple backends create branches | Use one repo-owned Python/POSIX helper | Parent with smoke evidence | Smoke receipt, Section 3.1, Section 5.4.1, Decision Log | resolved |
| DEC-004 | Should shared Codex auth be isolated per tender? | Keep machine-global auth or isolate per tender | Changes product/account model and Codex home behavior | Keep shared auth, make writes atomic only | Plan + prior plan stance | Section 1.4, Section 5.4, auth write call-site audit | resolved |
| DEC-005 | Should old tmux/app-server docs remain conditional cleanup? | Leave historical docs alone unless touched, or mark live-looking docs superseded | Humans/agents may follow stale operator guidance | Mandatory superseded notices for old live-looking docs | Plan audit repair | Section 6.3 and Phase 3 checklist | resolved |

## Pass History

### Pass 1 - 2026-05-30

- Mode: plan-readiness
- Scope: full canonical full-arch plan for Codex Tend PTY supervisor cutover
- Baseline reviewed: worktree plan plus current repo and local Codex source anchors
- Test/CI context accepted, if supplied: no implementation tests run in plan-readiness mode
- Agents/lenses run:
  - Composer25 Fast fresh consult: `pass-with-notes`, no blockers, high confidence, notes folded
  - Explorer side-door coverage: one blocker around May 23 doc; folded
  - Explorer rollout/Codex-source assumptions: ready, no blockers; non-blocking notes folded
  - Explorer PTY helper repo fit: one blocker around helper ABI; folded
- Code areas read: see coverage ledger
- Findings added: none currently open
- Findings resolved:
  - PTY helper ABI underspecified
  - goal-intent heuristic underspecified
  - return shape after tmux removal underspecified
  - Python prerequisite missing from docs surface
  - May 23 stale doc cleanup conditional
  - `--remote` rejection wording stale
  - `thread_goal_created` fixture risk
  - explicit-resume rollout lookup too filename-only
- Findings carried forward: none
- Verdict: ready
- Next audit focus: implementation-audit after code exists

### Pass 2 - 2026-05-30

- Mode: implementation-audit
- Scope: full implemented PTY/rollout Tend cutover against
  `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`
- Baseline reviewed: current `redis-credential-coordination` branch at `770b127`
- Test/CI context accepted:
  - `python3 -m py_compile src/targets/codex-pty-helper.py` passed
  - `npm run lint` passed
  - `node --test test/codex/use-watch.test.js` passed: 58 tests, 58 pass
  - `npm test` passed: 235 tests, 235 pass
- Native subagents/lenses run:
  - No native subagents spawned; current harness tool rules only permit subagents on explicit user
    delegation requests.
  - Lenses run locally: plan-code-fit, outcome-realization, requirement-traceability,
    phase-frontier-review, code-and-diff-map, canonical-owner-and-SSOT, existing-pattern-fit,
    deletion-and-side-door-closure, drift-proof-coupling, caller-invariant-state,
    elegance-and-code-judo, tiny-team-maintainability, test-code-review, docs-contract-drift,
    security/process/auth boundary.
- Code areas read: see coverage ledger.
- Obligations checked:
  - Phase 1 PTY/rollout/lock/atomic-write primitives
  - Phase 2 `runCodexTender()` cutover and old side-door deletion
  - Phase 3 docs/help/install/test/review evidence
- Findings added:
  - IMP-001
  - IMP-002
- Findings resolved: none required.
- Verdict: approve-with-notes
- Next audit focus: `docs/CODEX_TEND_LOW_LATENCY_FOREGROUND_RELAY_2026-05-30.md` once that separate
  plan is implemented.

## Plan-Readiness Verdict

VERDICT: ready
Confidence: high

The plan has a clear North Star, resolves the user-directed tmux/app-server removal, names the canonical owner paths, closes old side doors, keeps shared auth as an explicit accepted tradeoff, proves the highest-risk PTY seam first, and carries concrete phase exit criteria. Relevant repo code, old docs, tests, install path, and Codex rollout source were inspected through parent and explorer reads. Composer25 Fast found no blockers after repairs.

## Recommended Next Move

Proceed to `arch_stage_gate.py ready` and then `$arch-step auto-implement` / `implement-loop` against this plan. Do not rerun the pre-implementation PTY smoke; the plan's smoke receipt is authoritative until implementation changes the PTY helper/supervisor code.
