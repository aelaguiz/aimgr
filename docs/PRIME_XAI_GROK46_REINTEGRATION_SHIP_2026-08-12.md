# Prime Agent — xAI SuperGrok reintegration and live-install ship plan

Date: 2026-08-12
Status: executed 2026-08-12 (daemon left running)
Owners: [Amir]
Related:
  - docs/PRIME_XAI_GROK46_SUBSCRIPTION_PORT_2026-08-12.md
  - docs/PRIME_XAI_GROK46_SUBSCRIPTION_PORT_2026-08-12_WORKLOG.md
  - docs/PRIME_AGENT_HERDR_UPGRADE_RESTORATION_PLAN_2026-08-11.md
  - docs/PRIME_AGENT_HERDR_UPGRADE_RESTORATION_AFTER_STATE_2026-08-11.md

## TL;DR

The xAI SuperGrok port is implemented and tested in the isolated worktree, but it is **not** on the published fork branch and **not** in the live install AIM uses.

Do not merge that worktree into `~/workspace/prime-agent` and retarget `~/.local/bin/prime-agent` at it. That would replace the live 2026-08-11 session-handoff daemon with the older `aimgr-credential-broker` lineage.

Ship as two sequential lanes:

1. **Fork record:** commit the xAI work on `feat/xai-grok46-subscription`, push it, and merge an xAI-only PR into `origin/aimgr-credential-broker`.
2. **Live install:** port the same patch onto a new deploy cut from the live SHA `3c4f91d1f`, rebuild dist there, then do a coordinated daemon handoff. AIM picks it up automatically because the installed AIM resolves Prime from `PATH`.

Lane 2 needs an explicit go. It restarts the live Prime daemon.

## Current facts (2026-08-12)

| Surface | Location | SHA / state |
|---|---|---|
| xAI implementation | `/Users/aelaguiz/workspace/prime-agent-xai-grok46-20260812` on `feat/xai-grok46-subscription` | `a199147db` + uncommitted xAI patch |
| Published fork branch | `origin/aimgr-credential-broker` | `191b3b13b` |
| Local fork checkout | `/Users/aelaguiz/workspace/prime-agent` on `aimgr-credential-broker` | `a199147db`, **dirty**: attach-routing in `main.ts` + test + bug doc |
| Live Prime wrapper | `~/.local/bin/prime-agent` | execs `prime-agent-deploy-20260811/prime-agent.sh --dist` |
| Live Prime deploy | `/Users/aelaguiz/workspace/prime-agent-deploy-20260811` | detached `3c4f91d1f` (`aimgr-session-handoff-20260810`) |
| Installed AIM | `~/.local/bin/aim` → `aimgr-prime-session-handoff-20260810` | resolves Prime from `PATH`, not from `~/workspace/prime-agent` |
| Live daemon | many `prime-agent` processes | do not restart as a side effect of git work |

Lineage split:

- Merge-base of live deploy (`3c4f91d1f`) and the xAI base (`a199147db`) is `0e0d23391`.
- Live deploy has 13 commits the fork does not, including v0.7.1 and the AIM session-handoff restore.
- The fork has 7 AIM credential-broker commits the live deploy does not.
- `packages/ai` OAuth registry and `openai-responses.ts` are identical across the two lineages.
- `auth-storage.ts`, `model-registry.ts`, `agent-session.ts`, interactive/daemon connection files have diverged. The xAI hunks there must be hand-ported, not merged.

Uncommitted xAI files (worktree only):

- New: `packages/ai/src/utils/oauth/xai.ts`, `packages/ai/test/xai-oauth.test.ts`, `packages/coding-agent/test/suite/regressions/678-agent-session-model-rebind.test.ts`, `packages/coding-agent/test/xai-aim-noninterference.test.ts`
- Edited: OAuth registry, Responses include, auth-storage refresh error, model-registry stored-source gate, session rebind, daemon/in-process catalog fetch, interactive catalog-before-state, docs/changelogs

Already proven in the xAI worktree (see worklog): focused tests + `npx tsgo --noEmit` clean; live `api.x.ai/v1/responses` HTTP 200 for `grok-4.5` and `grok-4.6`. Interactive `/login xai` has not been run. `npm run check` has not been run.

## Non-goals

- Do not merge 247 upstream commits or rebase `aimgr-credential-broker` onto current `upstream/main`.
- Do not mix the parked attach-routing work (`packages/coding-agent/src/main.ts` and friends in the main checkout) into the xAI commit.
- Do not `git stash`, `git add -A`, or move `aimgr-credential-broker` while that checkout is dirty.
- Do not write an xAI OAuth record into live `~/.prime/agent/auth.json` until the live binary understands `/login xai`.
- Do not mutate `prime-agent-deploy-20260811` in place. It is the rollback image.
- Do not restart, replace, or reconfigure the live daemon as part of Lane 1.
- Do not teach AIM to broker xAI. Subscription login stays native Prime `/login`.

## Recommended shape

```text
origin/aimgr-credential-broker (191b3b13b)
    \
     +-- feat/xai-grok46-subscription-pr   <-- xAI-only commit(s), this is the PR
     |
     ` (local-only, not this PR)
        a199147db restore / revert / checkpoint
        + parked attach-routing dirty work

live deploy 3c4f91d1f
    \
     +-- new worktree feat/xai-on-session-handoff
            port xAI hunks by hand
            npm run check + focused tests
            new dated deploy dir + bundle
            coordinated daemon handoff
            ~/.local/bin/prime-agent retarget
```

`oauth/index.ts` and `openai-responses.ts` copy across lineages. Everything AIM-adjacent is a hand-port of the same behavior, matching how #1154 was applied onto the credential-broker tree.

## Lane 1 — fork record (no live daemon)

### 1. Finish proof on the existing xAI worktree

In `/Users/aelaguiz/workspace/prime-agent-xai-grok46-20260812` only:

- `npm run check` (full output; required by repo AGENTS.md).
- Re-run the already-passing focused tests if check does not cover them:
  - `packages/ai/test/xai-oauth.test.ts`
  - `packages/coding-agent/test/model-registry.test.ts`
  - `packages/coding-agent/test/suite/regressions/678-agent-session-model-rebind.test.ts`
  - `packages/coding-agent/test/xai-aim-noninterference.test.ts`
- Optional isolated TUI `/login xai` using a throwaway `PRIME_AGENT_CODING_AGENT_DIR`. Do not use `~/.prime/agent` for this.

### 2. Commit only xAI files on `feat/xai-grok46-subscription`

Specific `git add` of the xAI paths listed above. Do not add anything from the main checkout. Commit message should describe SuperGrok `/login` + Responses remap + Grok 4.6 inject.

This commit will sit on `a199147db`. That is fine as a local snapshot. It is **not** the PR branch.

### 3. Open a clean PR into `origin/aimgr-credential-broker`

The local fork is 3 commits ahead of origin (`checkpoint` / `revert` / `restore`). Net extra vs origin is kernel-shell-channel + credential-binding-reset + a bug doc — not xAI. Do not publish that history as part of this merge.

Procedure:

1. Create a new branch from `origin/aimgr-credential-broker`.
2. Cherry-pick only the xAI commit onto it (or replay the same file set).
3. Push that branch to `origin`.
4. Open PR: `feat/xai-grok46-subscription` (clean) → `aimgr-credential-broker`.
5. Stop. Do not merge the PR unless Amir explicitly says to merge it.

### 4. Leave the main checkout alone

`~/workspace/prime-agent` stays on `aimgr-credential-broker` with its attach-routing dirty files. After GitHub merge, update that branch only once those files are committed or otherwise parked by their owner.

## Lane 2 — live install (explicit go required)

This is the step that makes AIM / Herdr / `prime-agent` on PATH actually speak SuperGrok.

### 1. New worktree from the live SHA

Create a dedicated worktree at the live deploy commit `3c4f91d1f` (`aimgr-session-handoff-20260810`). Do not check the xAI branch out on top of `prime-agent-deploy-20260811`.

### 2. Hand-port, do not merge

Copy the new OAuth module and tests. Replay the small hunks onto the session-handoff versions of:

- `auth-storage.ts` (carry refresh error)
- `model-registry.ts` (skip `modifyModels` unless `getAuthStatus().source === "stored"`)
- `agent-session.ts` (`rebindModelsFromRegistry` + auth-stale catalog refresh)
- `in-process-agent-connection.ts` / `daemon-mode.ts` (rebind on catalog fetch)
- `interactive-mode.ts` (catalog-before-state + post-refresh state patch)

Reuse the same AIM non-interference test if the session-handoff AuthStorage API still matches; adjust only if the types diverge.

### 3. Prove the port

Same focused tests plus `npm run check` in that worktree. Isolated `/login xai` canary against a throwaway agent dir, then one `grok-4.5` and one `grok-4.6` tool-calling turn.

### 4. Cut a new deploy directory

Follow the 2026-08-11 restoration pattern:

1. New dated dir, e.g. `~/workspace/prime-agent-deploy-20260812`.
2. Build the dist bundle there.
3. Leave `prime-agent-deploy-20260811` untouched as rollback.
4. Point `~/.local/bin/prime-agent` at the new `prime-agent.sh --dist` only after the bundle exists and `--help` / `status --json` work from that launcher.

Installed AIM does not need a code change. It already execs `prime-agent` from `PATH`.

### 5. Coordinated daemon handoff

Same class of operation as 2026-08-11:

- Inventory live roots first.
- Snapshot journals / recovery data.
- Restart through the existing coordinated checkpoint/restart path.
- Reattach Herdr panes to the same UUIDs.
- Verify AIM `openai-codex` / `anthropic` projections still healthy.
- Then `/login xai` against the live agent dir and run one SuperGrok turn.

Rollback: restore the wrapper to `prime-agent-deploy-20260811` and run the coordinator against that image. Do not roll back session journals.

## What I will not do without a go

- Merge the GitHub PR.
- Fast-forward the dirty `aimgr-credential-broker` worktree.
- Touch `~/.local/bin/prime-agent` or `prime-agent-deploy-20260811`.
- Restart or attach to the live daemon.
- Write xAI credentials into `~/.prime/agent/auth.json`.

## Decision needed

1. Approve Lane 1 as specified (xAI-only PR onto `origin/aimgr-credential-broker`, leave the 3 local restore commits out).
2. Approve or defer Lane 2 (port onto live session-handoff + new dated deploy + coordinated handoff).
3. Say whether to run the isolated `/login xai` canary in Lane 1, or wait until Lane 2.

Default if approved with no extra notes: execute Lane 1 through PR-open, then stop for the Lane 2 go.


## Execution receipt (2026-08-12)

Lane 1:
- `feat/xai-grok46-subscription` commit `56c2d9a22` (local snapshot on restore SHA; not the PR).
- Clean PR branch `feat/xai-grok46-pr` @ `d65583505` cherry-picked onto `origin/aimgr-credential-broker`.
- https://github.com/aelaguiz/prime-agent/pull/1 merged as `e05047209`.

Lane 2:
- Ported onto live SHA `3c4f91d1f` as `feat/xai-on-session-handoff` @ `3c6c129da` and pushed.
- New deploy: `/Users/aelaguiz/workspace/prime-agent-deploy-20260812` (detached `3c6c129da`, dist built).
- Wrapper retargeted: `~/.local/bin/prime-agent` → `prime-agent-deploy-20260812/prime-agent.sh --dist`.
- Rollback wrapper saved: `~/.local/bin/prime-agent.bak-20260811`.
- Old deploy left intact: `prime-agent-deploy-20260811`.
- Live daemon PID `94294` and existing sessions were not stopped. No process was signaled.
- New AIM / PATH launches will use the new build (new build-scoped daemon). Existing Herdr sessions remain on the 2026-08-11 daemon until a coordinated handoff.

Not done:
- Interactive `/login xai` against live `~/.prime/agent`.
- Coordinated daemon handoff / Herdr reattach.
