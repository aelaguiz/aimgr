---
title: "AIM Prime Rotate Resume"
date: 2026-08-06
status: complete
owners: [Amir]
reviewers: [prime-agent-architecture]
fallback_policy: forbidden
related:
  - ../AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06.md
  - ../../README.md
  - ../../../prime-agent/packages/coding-agent/docs/providers.md
  - ../../../prime-agent/packages/coding-agent/docs/sessions.md
---

# TL;DR

Add `aim prime resume <session> --rotate`: select the next-best eligible Codex account without a status lookup, clone the saved Prime session so its conversation context remains intact, drop only the clone's `openai-codex` external credential binding, and launch the clone on `gpt-5.6-sol`. The original session remains unchanged. Plain `aim prime resume <session>` resumes normally on its recorded account.

## North Star

### Claim

When one AIM-managed Codex account rate-limits, a user can continue a saved Prime thread with one command and no account cross-referencing, while the old root remains identity-pinned and untouched.

### In scope

- `aim prime resume <path-or-id> [--rotate]`.
- Existing Prime session selector resolution for paths and IDs.
- Existing AIM next-best Codex ranking, with rotation away from the currently installed Prime Codex label.
- A new Prime root/session clone that retains conversation history and resets only the Codex credential binding.
- Focused tests, help/docs, and the Prime coding-agent changelog.

### Out of scope

- Automatic mid-turn or provider-error failover.
- A generic account migration framework, UI, daemon protocol, background watcher, or new usage policy.
- Mutating the source session, moving live kernels/subagents/queues, or preserving a running worker identity.
- Explicit destination-account selection; `--rotate` owns this use case.

### Definition of done

1. Plain AIM Prime resume launches the selected saved session without changing account selection.
2. `--rotate` selects the next-best eligible Codex label without requiring status output, leaves unrelated providers unchanged, and launches a fork with full saved conversation context.
3. The fork omits only the `openai-codex` `credential_binding`; the first request pins the newly installed AIM label through the existing external-auth path.
4. The source JSONL is unchanged, no credential material is copied, and no daemon wire contract changes.
5. Focused AIM and Prime tests plus repository-required static checks pass.

<!-- lilarch:block:requirements:start -->
## Requirements

- **R1 — One-command rotation:** `aim prime resume <session> --rotate` is the default operator path after a Codex rate limit.
- **R2 — Automatic account choice:** reuse the same next-best eligible Codex selector as `aim prime run codex`; do not require or add an account lookup step.
- **R3 — Context continuity:** create a new Prime session from the saved source history rather than summarize or paste it.
- **R4 — Explicit new root:** reset only the forked root's `openai-codex` external binding; never rewrite the source root's binding.
- **R5 — Normal resume:** without `--rotate`, use Prime's existing resume behavior and recorded account.
- **R6 — Lean failure:** if no alternate eligible account exists, print the existing blocked reason and do not launch Prime.
- **Defaults:** Codex provider, `gpt-5.6-sol`, current working directory, existing Prime selector semantics, unrelated provider descriptors unchanged.
- **Non-requirements:** no automatic failover, retry daemon, generic binding editor, new Redis schema, live runtime transfer, or compatibility shim.
- **Implementation lever:** deterministic CLI/session code; no prompt or model behavior is involved.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- **Human-authorized outcome:** the 2026-08-06 request to resume a Prime Codex thread with `--rotate`, automatically choosing the next-best account and avoiding account-status cross-reference.
- **Authorization anchors:** the user request above and the existing AIM/Prime credential-binding contract.
- **Smallest sufficient solution:** one AIM resume/rotate command plus one narrow Prime fork option that omits a named external credential binding while copying the existing session.
- **Initial minimal convergence closure:** reuse Prime's canonical `SessionManager.forkFrom` and AIM's canonical next-best selector; do not create a second session parser or account-ranking owner.
- **Scope freeze:** frozen on 2026-08-06 before code edits; only the AIM command, the Prime fork-reset seam, their focused proof, and live docs/changelog are authorized.
- **Enough proof:** focused parser/command tests in AIM, focused fork/binding tests in Prime, `npm test`/lint in AIM, the required Prime focused test and `npm run check`.
- **Do not build:** auto-failover machinery, provider hooks, daemon commands, new persistence formats, or account-policy abstractions.
- **Accepted residual risk:** a new root preserves saved conversation state but not the source worker's live kernel namespace, active descendants, pending queue, or heartbeat.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- `aimgr/src/cli/commands/harness-target.js` already owns Prime target selection and launch. `handleRun()` calls the canonical `handleUse()` with `avoidCurrentSelection: true`, then launches the integrated Prime bundle.
- `aimgr/src/targets/pi-cli.js::selectNextBestPiCodexLabel()` owns next-best Codex ranking. Its current avoid-current fallback may return the same label when no alternative exists, so rotate-resume must reject that fallback instead of relaunching the known-limited account.
- `prime-agent/packages/coding-agent/src/core/session-manager.ts::forkFrom()` already copies a saved session to a new root ID while retaining the full history and leaving the source untouched.
- `SessionManager.appendCredentialBinding()` stores binding entries outside model context and does not advance the conversation leaf. `forkFrom()` currently copies those entries unchanged.
- `prime-agent/packages/coding-agent/src/main.ts::createSessionManager()` resolves `--fork` through the canonical path/ID selector before daemon connection. Therefore a narrow fork option can reset one binding without a daemon command or schema change.
- Existing focused proof surfaces are `aimgr/test/pi/prime-target.test.js`, Prime's `test/args.test.ts`, and `test/external-credential-session.test.ts`.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`aim prime run codex` installs a usage-ranked external descriptor and starts a new Prime root. A saved Prime root persists its `(provider, source, binding, identityFingerprint)` tuple. Native resume and fork restore that tuple, so changing the global descriptor does not move the old tree to another account. There is no AIM Prime resume command and no Prime fork seam that deliberately omits one external binding.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

- AIM adds `prime resume <session> [--rotate]`.
- Plain resume launches Prime with its existing `--resume` selector and performs no account mutation.
- Rotate resume reuses `handleUse()` with Codex `auto`, unrelated providers omitted, replacement enabled, and strict avoidance of the currently installed Prime Codex label. If the ranking fallback returns that same label, AIM blocks rather than launching it.
- AIM launches Prime with its existing `--fork <session>` plus one narrow `--reset-credential-binding openai-codex` option and the normal Codex model selection.
- Prime extends `SessionManager.forkFrom()` with an option to omit selected credential-binding providers while copying and relinking the rest of the JSONL. The new root has the full saved context, no Codex binding, and therefore pins the newly installed AIM descriptor on its first managed resolution.
- This is startup-local work before daemon attachment; daemon command/event/response shapes are unchanged.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

| Repo | Surface | Change |
|---|---|---|
| aimgr | `src/cli/args.js` | Parse `--rotate` only for `prime resume`. |
| aimgr | `src/cli/commands/harness-target.js` | Add plain/rotating resume launch and strict alternate-account handling. |
| aimgr | `src/cli/help.js`, `README.md` | Document the one-command workflow and new-root semantics. |
| aimgr | `test/pi/prime-target.test.js` | Prove plain resume, automatic rotation, live-descriptor avoidance, no-same-label block, and launch arguments. |
| prime-agent | `packages/coding-agent/src/cli/args.ts` | Parse the narrow fork binding-reset option. |
| prime-agent | `packages/coding-agent/src/main.ts` | Validate it with `--fork` and pass it through canonical session resolution. |
| prime-agent | `packages/coding-agent/src/core/session-manager.ts` | Omit selected binding metadata when creating the fork; preserve all other entries. |
| prime-agent | `packages/coding-agent/src/cli/command-registry.ts`, `docs/usage.md`, `CHANGELOG.md` | Describe the fork option and user-visible behavior. |
| prime-agent | `packages/coding-agent/test/credential-binding-reset.test.ts` | Prove parsing, validation surface, startup wiring, source immutability, context preservation, and provider-specific reset. |
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Phase Plan

### Phase 1 — Prime fork-reset seam

Add the provider-scoped binding reset to `SessionManager.forkFrom()`, wire the CLI option through startup-only fork resolution, document it, and prove that the clone keeps conversation history and unrelated bindings while leaving the source unchanged.

### Phase 2 — AIM rotate resume

Add `aim prime resume <session> [--rotate]`, reuse the existing selector/launcher and next-best account owner, require a genuinely different account for rotation, update help/README, and run focused plus repository-required checks.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

**PASS — ready and frozen.** Every edit maps directly to the requested one-command rotate-resume outcome or the pre-freeze convergence closure. The design reuses the existing account ranker, session selector, session fork owner, and external binding path instead of creating a second parser or migration framework. It does not add runtime failover, Redis state, daemon protocol, or a generic policy layer. The only deliberate validation is that binding reset is a fork-only operation and rotate must not select the same label; both protect the requested semantics rather than restrict unrelated behavior. Residual loss of live kernel/subagent state is explicit and accepted because the supported operation is a new root with saved conversation context.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

**PASS.** The implementation matches the frozen two-phase design:

- Prime parses a fork-only, repeatable `--reset-credential-binding` option and routes it through canonical session resolution into `SessionManager.forkFrom()`.
- The fork copies the saved user/assistant context, keeps unrelated credential bindings, relinks around omitted metadata, and never writes the source JSONL.
- AIM plain resume delegates directly to Prime's existing `--resume` path without Redis or account mutation.
- AIM rotating resume reads the live installed AIM Codex descriptor (so stale/missing local target state cannot cause a same-account relaunch), reuses the canonical next-best selector, rejects its same-label fallback, preserves unrelated providers, and launches the source Prime CLI from the descriptor-owning agent directory with the new fork/reset flag.
- An independent defect review found the stale-local-state same-account edge case; the live-descriptor read and a regression test closed it. A final independent gate reported no actionable findings. No daemon, Redis schema, runtime failover, or generic migration surface was added.

Fresh proof:

- `cd aimgr && npm test` — 348 tests passed.
- `cd prime-agent/packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/credential-binding-reset.test.ts` — 2 tests passed.
- `cd prime-agent && npm run check` — Biome, TypeScript, installer render, and browser smoke checks passed.
- `cd prime-agent && ./prime-agent.sh --help 2>&1 | grep -- '--reset-credential-binding'` — the source launcher exposes the new option.
- `git diff --check` passed in both repositories.
<!-- arch_skill:block:implementation_audit:end -->
