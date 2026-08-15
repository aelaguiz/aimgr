# Worklog

Plan doc: docs/PRIME_XAI_GROK46_SUBSCRIPTION_PORT_2026-08-12.md

## Initial entry
- Run started.
- Current phase: Phase 1 — Subscription login and rail
- Worktree: `/Users/aelaguiz/workspace/prime-agent-xai-grok46-20260812`
- Branch: `feat/xai-grok46-subscription` from `aimgr-credential-broker` @ `a199147db`
- Source Prime checkout left untouched (including its uncommitted attach-routing edits).

## Phase 1 (Subscription login and rail) Progress Update
- Work completed:
  - Ported Prime-shaped `packages/ai/src/utils/oauth/xai.ts` from #1154 and registered it.
  - Hand-applied refresh-error, stored-source `modifyModels` gate, encrypted reasoning include, and session rebind hunks onto this fork.
  - Did not touch `main.ts` (that #1154 hunk is on a newer tree).
- Tests run + results:
  - `packages/ai` `test/xai-oauth.test.ts` — 21 passed
  - `packages/coding-agent` AIM session/client + auth-flows — 34 passed
- Issues / deviations:
  - None.
- Next steps:
  - Phase 2 grok-4.6 inject and canary.

## Phase 2 (Grok 4.6, docs, live canary) Progress Update
- Work completed:
  - `applyXaiOAuthModels` injects `grok-4.6` only while stored OAuth is active.
  - Docs: `providers.md`, `quickstart.md`, both changelogs, `packages/ai/README.md`.
  - Tests: registry remap/4.6/runtime-key, rebind regression, AIM non-interference.
- Tests run + results:
  - `test/xai-oauth.test.ts` — 21 passed (includes 4.6 inject)
  - `test/model-registry.test.ts` — 77 passed
  - `test/suite/regressions/678-agent-session-model-rebind.test.ts` — 2 passed
  - `test/xai-aim-noninterference.test.ts` — 3 passed
  - `npx tsgo --noEmit` at worktree root — clean
- Issues / deviations:
  - Interactive `/login xai` not run (needs a human in the TUI).
  - Rail probe: `POST https://api.x.ai/v1/responses` returned HTTP 200 for `grok-4.5` and `grok-4.6` on a live SuperGrok bearer. Hard-stop not taken.
- Next steps:
  - In the worktree: `./prime-agent.sh`, `/login`, choose xAI SuperGrok, approve the device code, then `--model xai/grok-4.6`.

## Launcher repair
- First `./prime-agent.sh` failed: I had left `node_modules` as a symlink. Git listed it as an untracked file; `source-build-id.mjs` then `readFileSync`'d a directory (`EISDIR`).
- Removed the symlinks, ran `npm install` in the worktree.
- Re-tried: `source-build-id` and `./prime-agent.sh --help` succeed.
- `getOAuthProviders()` from this tree lists `xai` / `xAI (SuperGrok/X Premium)`.
- `./prime-agent.sh -p --offline --model xai/grok-4.6` correctly says the model is not in the catalog until subscription OAuth is stored.
