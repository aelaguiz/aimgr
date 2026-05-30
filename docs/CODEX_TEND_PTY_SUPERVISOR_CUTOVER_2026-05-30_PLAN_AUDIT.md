# Plan Audit Log

Plan: `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`
Audit log: `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30_PLAN_AUDIT.md`
Current plan verdict: ready
Current implementation code-review verdict: not-run
Last reviewed: 2026-05-30
Scope: whole plan, pre-implementation readiness

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

Not run. No implementation exists yet.

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

## Plan-Readiness Verdict

VERDICT: ready
Confidence: high

The plan has a clear North Star, resolves the user-directed tmux/app-server removal, names the canonical owner paths, closes old side doors, keeps shared auth as an explicit accepted tradeoff, proves the highest-risk PTY seam first, and carries concrete phase exit criteria. Relevant repo code, old docs, tests, install path, and Codex rollout source were inspected through parent and explorer reads. Composer25 Fast found no blockers after repairs.

## Recommended Next Move

Proceed to `arch_stage_gate.py ready` and then `$arch-step auto-implement` / `implement-loop` against this plan. Do not rerun the pre-implementation PTY smoke; the plan's smoke receipt is authoritative until implementation changes the PTY helper/supervisor code.
