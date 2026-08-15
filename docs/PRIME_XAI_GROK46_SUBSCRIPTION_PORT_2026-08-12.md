---
title: "Prime Agent fork — xAI SuperGrok subscription + Grok 4.6 port"
date: 2026-08-12
status: active
fallback_policy: forbidden
owners: [Amir]
reviewers: [prime-agent-architecture, pi-harness-architecture]
doc_type: architectural_change
related:
  - ../README.md
  - AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06.md
  - ../../prime-agent/packages/coding-agent/docs/providers.md
  - ../../pi-mono/packages/ai/src/auth/oauth/xai.ts
  - ../../pi-mono/packages/coding-agent/docs/providers.md
  - https://github.com/PrimeIntellect-ai/prime-agent/issues/678
  - https://github.com/PrimeIntellect-ai/prime-agent/pull/1154
---

# TL;DR

- **Outcome:** This Prime Agent fork can `/login` with a SpaceX AI SuperGrok / X Premium subscription, use Grok models over the Responses rail, and select `xai/grok-4.6` without an `XAI_API_KEY`.
- **Problem:** Upstream Prime v0.7.2 still treats xAI as API-key only. Pi 0.84 already has the device-code subscription flow, but that module will not drop into this vendored tree. This fork also carries AIM external credentials, so a blind cherry-pick of upstream PR #1154 will collide in `auth-storage.ts` / `model-registry.ts`.
- **Approach:** Port PR #1154's Prime-shaped xAI OAuth provider (not Pi's files) onto `aimgr-credential-broker`. Keep one provider id (`xai`). Remap stored-OAuth xAI models onto `openai-responses` via the existing `modifyModels` hook. Inject `grok-4.6` only while subscription credentials are the active auth source. Rebind live session models after login/logout so the rail cannot stay stale. Do not vendor Pi `packages/ai`, do not merge 247 upstream commits, do not add a `grok-cli` proxy provider, and do not teach AIM to manage xAI.
- **Plan:** Phase 1 ports subscription login, rail remap, session rebind, and tests. Phase 2 injects Grok 4.6, updates docs, and runs a live SuperGrok canary. Stop and ask if `api.x.ai/v1/responses` rejects `grok-4.6`.
- **Non-negotiables:** one `xai` id; no `~/.grok/auth.json` scrape; no cli-chat-proxy headers; AIM-managed `openai-codex` / `anthropic` stay exclusive and untouched; API-key xAI users keep today's completions catalog.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
one_pass: completed 2026-08-12
inspected:
  - prime-agent packages/ai/src/utils/oauth (no xai.ts; Copilot is the device-flow template)
  - prime-agent fork auth-storage.ts / model-registry.ts (AIM external descriptors)
  - pi-mono packages/ai/src/auth/oauth/xai.ts and providers/xai.ts
  - PrimeIntellect-ai/prime-agent#678 and PR #1154 file patches
  - local Grok CLI models_cache.json for grok-4.6 / grok-4.5
recommended_flow: review this freeze -> approve -> miniarch-step implement
note: This block tracks stage order only. It never overrides readiness blockers or required user approval.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this plan is implemented, a SuperGrok / X Premium account can run `/login`, choose xAI, approve the device code in the browser, and complete a tool-calling turn on `xai/grok-4.6` (and remapped existing xAI models) against `https://api.x.ai/v1/responses` with no `XAI_API_KEY`. `/logout` returns xAI to the generated completions catalog. AIM-managed Codex/Claude descriptors are unchanged. Inspection of `auth.json` shows a normal `xai` OAuth record, not an AIM `external` descriptor and not a copy of `~/.grok/auth.json`.

## 0.2 In scope

- Built-in xAI subscription login on this Prime fork (`aelaguiz/prime-agent`, branch `aimgr-credential-broker`).
- RFC 8628 device flow against `https://auth.x.ai` using the public Grok CLI client id already used by Pi and this Grok TUI (`b1a00492-073a-47ea-816f-4c329264a828`).
- One provider id: `xai`. Subscription and API key share that id, matching Anthropic.
- OAuth-active rail: every current generated xAI `openai-completions` model remapped to `openai-responses` at `https://api.x.ai/v1`.
- `grok-4.6` available after subscription login, Responses rail, thinking levels `low|medium|high|xhigh`, `off`/`minimal` mapped away.
- Live-session model rebind after login, logout, and auth-stale so a session cannot keep a pre-auth request shape.
- Encrypted reasoning replay on xAI Responses (`include: ["reasoning.encrypted_content"]`).
- Actionable refresh-failure text (`Run /login and sign in to xAI again.`).
- Docs: `packages/coding-agent/docs/providers.md` and the two package changelogs.
- Unit/regression tests ported from #1154 plus fork-specific AIM non-interference.
- Opt-in live SuperGrok canary.

## 0.3 Out of scope

- Merging upstream Prime `main` (this fork is ~247 commits behind).
- Vendoring Pi 0.84 `packages/ai` or copying `src/auth/oauth/xai.ts` as-is.
- A second provider id (`xai-oauth`, `grok-cli`, `spacex`).
- Reading or wrapping `~/.grok/auth.json`.
- `cli-chat-proxy.grok.com` and Grok-CLI client headers.
- AIM-managed xAI / SpaceX AI accounts, Redis records, or `aim prime use --grok`.
- Changing Anthropic, Codex, Copilot, or Prime Inference auth.
- Regenerating `models.generated.ts` or changing the API-key xAI default (`grok-4.20-0309-reasoning`).
- Auto-switching the current session to `grok-4.6` after login.
- Pi changes. Pi already has subscription login; 4.6 is not this plan.
- Upstream PR authorship or waiting for #1154 to merge.

## 0.4 Definition of done (acceptance evidence)

1. `/login` lists **xAI (SuperGrok/X Premium)** next to Claude, Codex, and Copilot.
2. Device login stores `{ type: "oauth", access, refresh, expires }` under `xai` in `~/.prime/agent/auth.json`.
3. While that OAuth record is the active auth source, every generated xAI model is served as `api: "openai-responses"` at `https://api.x.ai/v1`, and `xai/grok-4.6` is present with `thinkingLevelMap` `{ off: null, minimal: null, low, medium, high, xhigh }`.
4. A new session and an already-open session both send the remapped shape after login. `/logout` and a runtime `--api-key` restore the generated completions catalog and drop `grok-4.6`.
5. Tests prove: device-code parse, pending/slow_down/denied/expired, refresh rotation when `refresh_token` is omitted, `modifyModels` only when `getAuthStatus(xai).source === "stored"`, session rebind on rail change, AIM `external` descriptors for `openai-codex` / `anthropic` still exclusive.
6. Opt-in live canary on a real SuperGrok account: `/login xai`, one `grok-4.5` tool-calling turn, one `grok-4.6` tool-calling turn, one refresh, `/logout`.
7. `providers.md` documents `/login xai` → **Use a subscription** and that `XAI_API_KEY` remains the API-key path.

If step 6's `grok-4.6` request returns a model-not-found / 404 from `api.x.ai`, stop. Do not invent a proxy provider. That is a new human decision.

### Scope and Simplicity Contract

- **Human-authorized outcome:** port SpaceX AI / SuperGrok subscription support and Grok 4.6 into this Prime Agent fork, in the neatest way.
- **Authorization anchors:** the 2026-08-12 request in this Grok session; current `aimgr-credential-broker` fork; Pi 0.84 xAI OAuth; PrimeIntellect #678 / PR #1154; local Grok CLI catalog fetched 2026-08-12 (`grok-4.6`, `api_backend: responses`, `supported_in_api: true`).
- **Smallest sufficient solution:** one new `packages/ai/src/utils/oauth/xai.ts` registered beside Copilot, plus the #1154 rail/rebind/error hunks applied by hand onto the AIM-touched files. Inject `grok-4.6` inside `applyXaiOAuthModels`. Reuse existing `/login` picker, device-code dialog, `modifyModels`, AuthStorage, and Responses transport.
- **Initial minimal convergence closure:** (1) live-session rebind after credential-driven rail change, otherwise login and the open session disagree on API shape; (2) `modifyModels` only when stored OAuth is the active source, otherwise `--api-key` / env / stale fallback keep a split catalog; (3) keep a single `xai` id, otherwise login, catalog, and AIM later would grow a competing provider.
- **Scope freeze:** frozen 2026-08-12 when Amir approved implementation of this doc. Worktree: `/Users/aelaguiz/workspace/prime-agent-xai-grok46-20260812` on `feat/xai-grok46-subscription`.
- **Enough proof:** #1154-class unit tests plus one AIM non-interference test plus the opt-in live canary above.
- **Do-not-build:** Pi file copy, upstream merge, grok-cli proxy, auth.json scrape, AIM xAI broker, catalog regen, default-model change, auto-switch to 4.6 on login.
- **Accepted residual risk:** `api.x.ai` may not serve `grok-4.6` or `xhigh` even though the Grok CLI catalog lists both. The canary is the gate. xAI may later restrict the public client; that is a policy risk, not something this port can solve.

<!-- arch_skill:block:research_grounding:start -->

# 1) Research grounding

## 1.1 What was inspected

| Source | What it shows |
|---|---|
| `prime-agent` `upstream/main` @ `965941c` / v0.7.2 | No `oauth/xai.ts`. Login list is Codex, Claude, Copilot. xAI is `XAI_API_KEY` only. #678 still open. |
| This fork `aimgr-credential-broker` | AIM `external` descriptors in `auth-storage.ts` (+424 vs upstream) and `model-registry.ts`. `packages/ai/src/utils/oauth/` is untouched vs upstream. Uncommitted `main.ts` attach-routing work must be parked. |
| Pi `packages/ai/src/providers/xai.ts` + `src/auth/oauth/xai.ts` | Shipped SuperGrok device OAuth. Different types: `ProviderAuthInteraction.notify({ type: "device_code" })`. Same HTTP endpoints and client id. |
| PR #1154 (`MERGEABLE`, +955/−20) | Already rewrote that flow into Prime's `OAuthProviderInterface`. This is the source to port. |
| Copilot `packages/ai/src/utils/oauth/github-copilot.ts` | Local template: device poll + `onAuth({ url, instructions })` + optional `modifyModels`. |
| `login-dialog.ts` / `auth-flows.ts` | Picker is `getOAuthProviders()`. Registering `xai` is enough to appear. `loginXai` already calls `onAuth` + `onProgress`. |
| Generated catalog `models.generated.ts` `"xai"` | `grok-4.20-0309-*`, `grok-4.3`, `grok-4.5`, `grok-build-0.1`, `grok-code-fast-1` — all `openai-completions`. No `grok-4.6`. Default in `model-resolver.ts` is `grok-4.20-0309-reasoning`. |
| Grok CLI `~/.grok/models_cache.json` (2026-08-12) | `grok-4.6`: Responses, 500k context, efforts `low/medium/high/xhigh`, `supported_in_api: true`. CLI `base_url` is the chat proxy; this plan still talks to `api.x.ai`, matching Pi and #1154. |
| AIM helper `src/cli/commands/credential-helper.js` | Only `openai-codex` and `anthropic`. xAI login cannot be an AIM descriptor unless we build that (out of scope). |

## 1.2 Pattern to reuse

Do not import Pi. Lift these Prime-native pieces from #1154 and Copilot:

1. New `xaiOAuthProvider` with `id: "xai"`, `login` / `refreshToken` / `getApiKey` / `modifyModels`.
2. `applyXaiOAuthModels(models)` remaps `provider === "xai" && api === "openai-completions"` → `openai-responses` and sets `compat.supportsLongCacheRetention = false`. Reasoning models get `thinkingLevelMap.off/minimal = null` (live API rejects `effort: "none"`).
3. Inject `grok-4.6` in that same function (our addition; #1154 does not have 4.6).
4. `AgentSession.rebindModelsFromRegistry()` after catalog rebuild.
5. `ModelRegistry` skips `modifyModels` unless `getAuthStatus(id).source === "stored"`.
6. `openai-responses.ts` adds `include: ["reasoning.encrypted_content"]` when `model.provider === "xai"`.

## 1.3 Constraints the code already imposes

- Prime OAuth providers must implement `OAuthProviderInterface` in `packages/ai/src/utils/oauth/types.ts`. Pi's `xaiOAuth` object will not typecheck.
- `AuthStorage.set` / `login` call `assertProviderMutable`. That blocks writes only for AIM-managed providers. xAI is not managed, so native OAuth writes are allowed.
- `auth.json` OAuth wins over `XAI_API_KEY`. `/logout` must delete the `xai` OAuth record so the env key returns.
- Daemon + in-process connections already refresh catalogs on `onAuthChanged`. The missing piece is rebinding the *live* `agent.state.model` object, not another login UI.
- `generate-models.ts` is a blast-radius machine. 4.6 is not in that snapshot. Injecting via `modifyModels` avoids a regen and keeps API-key users off a model they may not have.

## 1.4 Capability-first note

This is deterministic auth and catalog routing, not an agent-prompt problem. No new helper binary, no skill, no scrape of Grok TUI state.

<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->

# 2) Current architecture

```text
/login picker
    -> getOAuthProviders()
        -> anthropic | github-copilot | openai-codex
        -> xai is absent, so xAI is API-key / env only

auth.json
    openai-codex:  type=external   (AIM)
    anthropic:     type=external   (AIM)
    xai:           missing

ModelRegistry
    generated xAI models, all openai-completions @ api.x.ai
    default xai/grok-4.20-0309-reasoning
    modifyModels only used today by Copilot (baseUrl)

AgentSession
    holds a Model object captured at select time
    login/logout refresh the catalog but do not swap the live Model
```

Pi already does the subscription half. This fork does not. Grok 4.6 exists only in the Grok CLI catalog, not in Prime or Pi.

<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->

# 3) Target architecture

```text
/login picker
    -> getOAuthProviders()
        -> anthropic | github-copilot | openai-codex | xai

/login xai  (device code, no loopback)
    -> auth.x.ai/oauth2/device/code + token
    -> auth.json.xai = { type: "oauth", access, refresh, expires }

Auth resolution for xai (unchanged order, new OAuth branch)
    1. AIM external descriptor, if one is ever installed (none today)
    2. stored oauth / api_key
    3. XAI_API_KEY
    4. none

When stored oauth is the active source
    applyXaiOAuthModels():
      remap every generated xAI completions model -> openai-responses
      append grok-4.6 (responses, 500k, low/medium/high/xhigh)
    AgentSession.rebindModelsFromRegistry()
    Requests go to api.x.ai/v1/responses with encrypted reasoning include

When stored oauth is not the active source
    generated catalog only, no grok-4.6, completions rail
```

Ownership:

| Concern | Owner |
|---|---|
| Device login, refresh, rail remap, 4.6 inject | `packages/ai/src/utils/oauth/xai.ts` |
| Provider registry | `packages/ai/src/utils/oauth/index.ts` |
| Encrypted reasoning include | `packages/ai/src/providers/openai-responses.ts` |
| Active-source gate for `modifyModels` | `packages/coding-agent/src/core/model-registry.ts` |
| Refresh error surfacing | `packages/coding-agent/src/core/auth-storage.ts` |
| Live model rebind | `packages/coding-agent/src/core/agent-session.ts` plus the small daemon / in-process / interactive catalog-order hunks from #1154 |
| AIM Codex/Claude | unchanged |

`grok-4.6` is subscription-shaped. It is not added to `models.generated.ts`. API-key users never see it. That is the neat cut: one hook, two behaviors, no second provider.

<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->

# 4) Call-site audit

## 4.1 New files

| Path | Role |
|---|---|
| `prime-agent/packages/ai/src/utils/oauth/xai.ts` | Device flow + `applyXaiOAuthModels` + 4.6 inject |
| `prime-agent/packages/ai/test/xai-oauth.test.ts` | HTTP/device/refresh/remap/4.6 tests |
| `prime-agent/packages/coding-agent/test/suite/regressions/678-agent-session-model-rebind.test.ts` | Live rebind |
| `prime-agent/packages/coding-agent/test/xai-aim-noninterference.test.ts` | AIM Codex/Claude still exclusive; xAI OAuth still writable |

## 4.2 Existing files to edit

| Path | Change | Collision with this fork |
|---|---|---|
| `packages/ai/src/utils/oauth/index.ts` | Export + register `xaiOAuthProvider`; keep refresh error detail | None |
| `packages/ai/src/providers/openai-responses.ts` | xAI `include` encrypted reasoning | None |
| `packages/ai/README.md` + both `CHANGELOG.md` | Note subscription login | Low |
| `packages/coding-agent/docs/providers.md` | Add xAI subscription section (copy Pi's wording, Prime paths) | None |
| `packages/coding-agent/src/core/auth-storage.ts` | Carry OAuth refresh error on empty key | **Yes — apply the 6-line hunk by hand** |
| `packages/coding-agent/src/core/model-registry.ts` | Skip `modifyModels` unless source is `stored`; surface refresh error | **Yes — apply the 10-line hunk by hand** |
| `packages/coding-agent/src/core/agent-session.ts` | `rebindModelsFromRegistry` + auth-stale catalog refresh | Low if #1154 still applies; verify |
| `packages/coding-agent/src/main.ts` | Only if #1154's 22-line hunk is still required after reading the current file | **Park the uncommitted attach-routing edit first** |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Catalog-before-state + post-refresh state patch | Medium; this fork already has `onAuthChanged` → `refreshConnectionModelsAfterAuthChange` |
| `.../in-process-agent-connection.ts`, `.../daemon-mode.ts` | Serve rebound models during catalog fetch | Low |
| `packages/coding-agent/test/model-registry.test.ts` | #1154 cases | Medium; AIM tests already live here |

## 4.3 Do not touch

- `src/targets/prime-agent.js`, AIM `credential-helper.js`, Redis, Pi.
- `packages/ai/scripts/generate-models.ts` / `models.generated.ts`.
- `model-resolver.ts` default map.
- `assertProviderMutable` / external descriptor protocol.

## 4.4 Deletes

None. There is no local `models.json` grok-cli workaround to remove.

## 4.5 Landing constraint

Implement on a worktree of `aimgr-credential-broker`, not on a rebase onto upstream `main`. Do not `gh pr checkout 1154` onto this branch. Copy the new OAuth module and tests, then replay the small AIM-adjacent hunks by hand.

<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->

# 5) Phase plan

## Phase 1 — Subscription login and rail (ship-blocking)

Status: COMPLETE

**Goal:** SuperGrok `/login` works; OAuth-active xAI traffic uses Responses; live sessions rebind; AIM is untouched.

**Work:**

1. Park uncommitted `packages/coding-agent/src/main.ts` attach-routing work (stash or finish it first). Create a worktree from `aimgr-credential-broker`.
2. Add `packages/ai/src/utils/oauth/xai.ts` from #1154 (Prime interface, not Pi). Register it in `index.ts`. Keep #1154's refresh-error detail change.
3. Add `applyXaiOAuthModels` remap only (no 4.6 yet). Wire `modifyModels`.
4. Apply the `openai-responses.ts` encrypted-reasoning include.
5. Hand-apply the #1154 `auth-storage.ts` and `model-registry.ts` hunks onto the AIM versions. Do not take the rest of those files from #1154.
6. Add `rebindModelsFromRegistry` and the auth-stale / catalog-order hunks. If a hunk fails to apply, read the current function and reproduce the behavior; do not force a 0.7.2 patch.
7. Port `xai-oauth.test.ts` and `678-agent-session-model-rebind.test.ts`. Add the AIM non-interference test.

**Verify:**

- `packages/ai` xAI OAuth tests pass without network.
- Coding-agent rebind + model-registry tests pass.
- AIM existing harness-auth tests still pass.
- Manual: `/login` shows xAI. Do not burn the live SuperGrok token until Phase 2.

**Done:** stored xAI OAuth remaps the generated catalog to Responses and rebinds live models.

## Phase 2 — Grok 4.6, docs, live canary (ship-blocking)

Status: COMPLETE

Manual Verification Pending: interactive `/login xai` in this worktree's TUI (device approval needs a human).

**Goal:** `xai/grok-4.6` is selectable on subscription auth and proven on a real account.

**Work:**

1. In `applyXaiOAuthModels`, if no `grok-4.6` is already present, append:

   ```ts
   {
     id: "grok-4.6",
     name: "Grok 4.6",
     api: "openai-responses",
     provider: "xai",
     baseUrl: "https://api.x.ai/v1",
     reasoning: true,
     input: ["text", "image"],
     contextWindow: 500_000,
     maxTokens: 500_000,
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
     compat: { supportsLongCacheRetention: false },
     thinkingLevelMap: {
       off: null,
       minimal: null,
       low: "low",
       medium: "medium",
       high: "high",
       xhigh: "xhigh",
     },
   }
   ```

2. Tests: OAuth catalog contains 4.6; API-key / `--api-key` / logout catalogs do not; 4.6 thinking map includes `xhigh` and nulls `off`/`minimal`.
3. Update `packages/coding-agent/docs/providers.md`:

   - Subscriptions list: add `xAI (Grok / SuperGrok / X Premium)`.
   - Section: `/login xai` → use a subscription; `XAI_API_KEY` remains the API-key path.
   - Note Grok 4.6 is listed only after subscription login.

4. Live canary, opt-in, after `grok login` if the current SpaceX AI token is expired:

   1. `/login xai` in this fork's source launcher.
   2. `prime-agent --model xai/grok-4.5` — one tool-calling turn.
   3. `prime-agent --model xai/grok-4.6` — one tool-calling turn.
   4. Force refresh (wait or expire `expires`) and confirm a new access token is persisted.
   5. `/logout` xAI; confirm `grok-4.6` disappears and `XAI_API_KEY` path is unchanged.

**Verify:** canary receipt in the later worklog. If `grok-4.6` 404s or `xhigh` 400s, record the exact status/body and stop. Drop `xhigh` from the map only if the live API rejects it and Amir confirms. Do not add the CLI proxy.

**Done:** subscription users can select Grok 4.6; docs match; canary passed or a blocked 4.6 finding is written back to this doc for a human decision.

## Follow-ups (not this plan)

- Contribute the 4.6 inject back to #1154 / upstream after this fork ships.
- AIM-managed SpaceX AI accounts.
- Change the API-key default away from `grok-4.20-0309-reasoning`.
- Port `grok-4.6` into Pi.

<!-- arch_skill:block:phase_plan:end -->

# 6) Readiness

**Status:** `active`. Implementation landed on `feat/xai-grok46-subscription` in `/Users/aelaguiz/workspace/prime-agent-xai-grok46-20260812`.

Worklog: `docs/PRIME_XAI_GROK46_SUBSCRIPTION_PORT_2026-08-12_WORKLOG.md`

`api.x.ai/v1/responses` accepted both `grok-4.5` and `grok-4.6` (HTTP 200) on a live SuperGrok bearer, so the 4.6 hard-stop did not fire. Interactive Prime `/login` still needs a human device approval.

Later docs cleanup is `arch-docs`.
