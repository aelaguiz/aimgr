# AIM Grok OAuth fleet plan

Date: 2026-08-13
Status: draft
Owner: Amir
Repo: aimgr (`~/workspace/aimgr`)

Goal: AI Manager can enroll, refresh, inventory, and hand out Grok subscription seats the same way it already does Claude Max and Codex, so a fleet of Grok workers can run without xAI API keys.

This plan is grounded in current AIM code, the Prime xAI SuperGrok port, and today's `pro1@fun.country` Google SSO signup on Profile 7.

---

## 0. Decision

Build this. The 2026-08-12 Prime xAI port said "do not teach AIM to manage xAI." That was right for a single-process Prime login. It is wrong for a 20-seat fleet. Fleet ownership belongs in AIM/Redis, not in each worker's `/login`.

Do **not** bill the fleet on API keys. API list prices for this week's Claude-shaped traffic are $1.4k to $4k per 8 days even with a 200k cap. The Claude analog is SuperGrok (or SuperGrok Heavy) subscription OAuth, then extra credits only as overflow.

---

## 1. What already exists

### AIM today

- OAuth providers are a closed set of two: `openai-codex` and `anthropic` (`src/core/constants.js` `SUPPORTED_OAUTH_PROVIDERS`).
- Redis records are already `provider + label` (`aimgr.credential.v1` in `src/coordination/records.js`). Dual-provider labels (`boss`, `lessons`, `pro1` Claude+Codex) already live in Redis from the original cutover.
- First enrollment cannot attach a second provider. `publishRedisCredentialPolicyFromState` calls `findConflictingCredential` and refuses if the label exists under any other provider. That is why `aim login amir_elaguizy_fun_country` could not add Claude.
- `state.accounts[label].provider` is a **single** string. Local account state is one-provider. Redis is many-provider. That split is the trap.
- Login: `aim login <label>` then provider prompt 1=Codex / 2=Claude. Claude uses contained `claude auth login` plus PKCE `code#state` paste. Codex uses browser-managed or manual-callback.
- Refresh: `aim auth maintain` refreshes due Claude and Codex OAuth.
- Usage: `src/pool/usage.js` hits ChatGPT `wham/usage` and Anthropic `api/oauth/usage`. Percents only. No Grok adapter.
- Workers: Prime and Pi consume AIM through `aimgr-credential-v1` external descriptors. `HARNESS_MANAGED_PROVIDERS` is hardcoded to Codex + Anthropic (`src/targets/harness-auth.js`). Hermes write path is Codex-only today.
- BrowserOS bindings are per-label (`aim browser set`). `pro1` is currently `manual-callback` with no stored Chrome profile. The live pro1 window is BrowserOS **Profile 7**, Gmail `pro1@fun.country`.

### Grok / xAI today

- Account we just created: SpaceXAI account `pro1@fun.country`, Google SSO, `https://accounts.x.ai/account`, created 2026-08-13. Subscription unset.
- Prime fork already implements RFC 8628 device-code OAuth against `https://auth.x.ai`:
  - Client id: `b1a00492-073a-47ea-816f-4c329264a828` (public Grok CLI client)
  - Token URL: `https://auth.x.ai/oauth2/token`
  - Device URL: `https://auth.x.ai/oauth2/device/code`
  - Scopes: `openid profile email offline_access grok-cli:access api:access`
  - Access tokens authorize `https://api.x.ai/v1` Responses, not Chat Completions
  - File: `prime-agent-xai-grok46-20260812/packages/ai/src/utils/oauth/xai.ts`
- Device flow needs no loopback and no `code#state` paste. AIM opens `verification_uri_complete` in the right BrowserOS profile and polls. That is simpler than Claude.
- Grok 4.6 list prices: $2 / $0.50 / $6 under 200k prompt tokens; 2x if the prompt is 200k or more, for **all** tokens on that request.
- SuperGrok has a weekly Heavy limit on grok.com. The Grok CLI does **not** expose a Claude-style 5h/week/Fable meter. It does call a real billing API (proven 2026-08-13 against this machine's Grok CLI OAuth):
  - `GET https://cli-chat-proxy.grok.com/v1/billing` with the SuperGrok bearer
  - Returns `config.monthlyLimit.val`, `config.used.val`, `onDemandCap`, period start/end, and prior-cycle `includedUsed` / `onDemandUsed` / `totalUsed`
  - Live sample on SuperGrok Heavy: used `113` of limit `10000` for Aug 2026 (units look like cents or credits, not tokens)
  - `GET https://cli-chat-proxy.grok.com/v1/settings` returns `allow_access`, `subscription_tier_display` (`SuperGrok Heavy`), `subscription_watch_interval_secs` (60)
  - `/usage` in the TUI is this billing payload, not session tokens. Session `/status` is context-window only.
  - `x.ai/auth/check_subscription` is an in-process RPC name in the binary; it is a subscribed-or-exhausted gate, not a percent meter.
  - Weekly Heavy UI on grok.com is **not HTML-only**. BrowserOS Network on `https://grok.com/?_s=usage` (2026-08-13) captured:
    - `POST https://grok.com/rest/rate-limits` JSON `{"modelName":"heavy"}` -> `{windowSizeSeconds:7200, remainingQueries, totalQueries}` (2-hour query cap, not the weekly bar)
    - `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` grpc-web empty body. Decoded window is **exactly 7 days** and matches the page reset (`2026-08-06T18:51:08Z` to `2026-08-13T18:51:08Z` = 1:51 PM CDT).
    - Also: `GetRemainingResets`, `GetPrepaidBenefits` (grpc-web).
  - Proven 2026-08-13 with a fresh SuperGrok device-code bearer (`grok-cli:access api:access`), **no cookies**:
    - `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` **works**. grpc-web 200, same 7-day window as the website (`2026-08-06T18:51:08Z` to `2026-08-13T18:51:08Z`). Field 1 was a float (29 then 31 across two pulls). Field 12 is 10000. This is the weekly-shaped payload.
    - `POST https://grok.com/rest/rate-limits` **does not work** with OAuth: 403 `Action cannot be performed by OAuth2 token users`. Cookie-only.
    - `GET https://cli-chat-proxy.grok.com/v1/billing` still works and is still the **monthly** bucket (113/10000, Aug 1 to Sep 1).
  - **Amir ruling 2026-08-13: do not poll weekly Heavy in AIM.** The weekly endpoint exists, but a fleet-wide sweep is not a cheap per-pick check. A periodic bulk job is also not useful: the limit is moving, and a weekly remaining number is not a minute-to-minute rank key. Rotate on monthly leftover and hard fail (`allow_access` / weekly exhausted error). Leave `GetGrokCreditsConfig` and `/rest/rate-limits` out of the pool.

### Three xAI products (do not mix them)

| Product | What it is | Fleet? |
|---|---|---|
| SpaceXAI account + Google SSO | Identity we just created | Prerequisite |
| SuperGrok / SuperGrok Heavy subscription | Seat, like Claude Max | **Yes. This is the fleet.** |
| Console API key / extra usage credits | Pay-as-you-go at list prices | Overflow only, not the pool |

Sakana already covers API-key style providers. Do not invent a second key vault for xAI.

---

## 2. North star

An operator can:

1. Sit in the `pro1` BrowserOS window (Profile 7, `pro1@fun.country`).
2. Subscribe that Google identity to SuperGrok (Ramp card, later).
3. Run `aim login pro1` and pick Grok / `xai`.
4. Approve the device-code page in **that same window**.
5. See `aim status` / `aim grok status pro1` as live.
6. Run `aim prime use --grok pro1` or `aim prime run grok` and get a Grok 4.6 worker from the pool.

Same Google person, same AIM label, third provider record. Claude and Codex on `pro1` stay untouched.

Definition of done for v1:

- `xai` is a supported OAuth provider.
- `aim login <label>` can publish the **first** xAI credential onto a label that already has Claude and/or Codex.
- Refresh works through `aim auth maintain`.
- Identity is checked (email `pro1@fun.country`) before publish.
- Prime can consume an AIM xAI descriptor without using Prime's native `/login xai`.
- Existing Claude/Codex tests stay green.
- One live canary: `pro1`.

---

## 3. Design

### 3.1 Provider id

Use `xai`. One id. Match Prime. Do not add `grok`, `spacex`, or `xai-oauth`.

Add to `SUPPORTED_OAUTH_PROVIDERS`:

```text
xai  -  xAI (SuperGrok subscription)
```

Login prompt becomes 1=Codex, 2=Claude, 3=Grok.

### 3.2 Redis

Reuse `aimgr.credential.v1`. No new key type.

Credential body (same shape as Codex, not a Claude native bundle):

```text
access
refresh
expires / expiresAt
emailAddress
accountId          # from id token / userinfo if present
subscription       # super_grok | super_grok_heavy | unknown
```

Identity:

```text
emailAddress
accountId
```

Policy.expect.email is required, same as Claude.

Do not store API keys in this record.

### 3.3 Local account state

`state.accounts[label].provider` is one string and is the bug. Do not invent a provider registry.

For login, do not go through `ensureProviderConfiguredForLabel` when the operator already passed `--provider xai` or chose 3. That helper returns the existing Claude/Codex provider and never asks again.

Add an explicit attach path:

```bash
aim login pro1 --provider xai
```

That publishes or updates the `xai:pro1` Redis record even if `anthropic:pro1` and `openai-codex:pro1` exist.

`findConflictingCredential` must not fire for this attach. Change it to: conflict only if the **same** provider+label exists as a different identity, not if another provider owns the label. That is the real first-enroll wall. Fix it once, for Grok, and Claude attach later can reuse it. Do not build a generic multi-provider framework around the fix.

### 3.4 OAuth

Port the Prime device-code functions into AIM (`src/credentials/xai-login.js`). Do not import Prime packages. Copy the proven request/poll/refresh. Keep the same public client id and scopes.

Flow:

1. Create or accept a policy-only `xai:<label>` Redis record with expected email.
2. POST device code.
3. Open `verification_uri_complete` in the label's BrowserOS binding. If unbound, print the URL and require the operator to open it in the known profile (pro1 = Profile 7). Do not let the OS default browser steal the session.
4. Poll until tokens or timeout.
5. Fetch userinfo / decode id_token. Email must match `policy.expect.email`.
6. Publish credential. Delete any staging files.

Reauth of an existing xAI record is the same device flow if refresh fails, or silent refresh if the refresh token is live.

This is easier than Claude: no PTY, no `code#state`, no Keychain, no contained Claude CLI.

### 3.5 Refresh

Extend `aim auth maintain` with an xAI branch next to Codex/Claude.

- Refresh at `TOKEN_URL` with `grant_type=refresh_token`.
- Keep the previous refresh token if xAI does not rotate.
- Refresh five minutes before expiry (Prime already uses this skew).
- `invalid_grant` marks the seat `reauth_required` and does not touch other providers on that label.

### 3.6 Status / inventory

v1: credential health **and** the billing meter.

```text
aim grok status [label...]
aim grok inventory
```

Show: label, email, `subscription_tier_display`, token expiry, lock, `used/limit` from `/v1/billing`, period end.

Add `fetchXaiUsageSnapshot` next to the Claude/Codex fetchers. It is a GET to `https://cli-chat-proxy.grok.com/v1/billing` plus `/v1/settings` for tier and `allow_access`. Cache like Claude (300s).

This is **not** a 5h/week/Fable triplet. It is one monthly included bucket plus optional on-demand. Rank by remaining `monthlyLimit - used`. Treat `allow_access: false` as exhausted.

Do not scrape grok.com HTML. Do not use `https://api.x.ai/v1/usage` (404). Confirm the same JSON shape on a `pro1` SuperGrok token before trusting units (cents vs credits).

### 3.7 Workers

v1 worker is Prime. That is the only harness that already speaks xAI Responses + grok-4.6.

Changes:

- Add `xai` to `HARNESS_MANAGED_PROVIDERS`.
- `aim prime use --grok <auto|label|off>` next to `--codex` / `--claude`.
- `aim prime run grok` selects the next-best unlocked xAI seat and starts Prime on `xai/grok-4.6` (default effort `high`).
- When AIM grok is on, Prime must use the AIM external descriptor, not native `/login xai`. Same exclusivity rule as Claude.
- Native Prime `/login xai` remains for non-fleet use when `--grok off`.

Out of v1:

- Hermes Grok homes
- OpenClaw Grok
- `aim grok run` wrapping the Grok TUI
- Context-cap machinery inside AIM

Those can come after Prime proof. Do not block the fleet on them.

### 3.8 Pool pick

Reuse the existing least-used / unlocked picker.

v1 rank key: not locked, credential ready, not `reauth_required`, oldest `lastUsedAt`.

If a monthly leftover exists, rank by remaining included credits. Do **not** add a weekly Heavy rank key.

Lock: same Redis lock as Claude so two Primes do not steal one SuperGrok seat.

### 3.9 BrowserOS

Same rule as Claude OAuth: the device-code page must load in the label's Google profile.

`pro1` today has no `aim browser` binding. Bind it before fleet enrollment:

```bash
aim browser set pro1 --mode chrome-profile --user-data-dir <BrowserOS Profile 7 path>
```

Or keep manual-callback and have the login command print: open this URL in the existing pro1 window. Today's signup already proved Profile 7 is that window.

Do not call `tabs new` and hope. It has no profile argument.

### 3.10 Enrollment runbook (operator)

Per seat, same as Claude Max:

1. Open that label's BrowserOS window (Google already signed in).
2. Confirm `https://accounts.x.ai/account` is that email. Create it with Google SSO if missing. `pro1` is done.
3. Subscribe SuperGrok (or Heavy if that is the product decision). Ramp Product-or-service, vendor **xAI**, monthly cap TBD, name `First_Last@fun.country grok` (`pro` is OpenAI, do not use it here).
4. `aim login <label> --provider xai` with expected email.
5. Approve device code in that window.
6. `aim grok status <label>` live.
7. One Prime canary turn.

Do not put AIM in the Ramp or checkout path.

---

## 4. What not to build

- A new Redis schema, fence type, or provider framework.
- API-key fleet, console key minting, or Sakana-for-xAI.
- Scraping `~/.grok/auth.json` or Grok CLI profiles.
- Teaching AIM to click SuperGrok checkout.
- Context-length governors, 200k cappers, or routing by prompt size.
- Hermes/OpenClaw/Grok-TUI in v1.
- Fake Claude-style 5h/week/Fable percentages. Use the real monthly billing fields.
- Weekly Heavy polling (`GetGrokCreditsConfig`, grok.com `/rest/rate-limits`, or any periodic bulk weekly sweep). Amir 2026-08-13.
- Changing Claude or Codex login except the shared "attach second provider" conflict check.
- Bulk-enrolling all 23 seats in the first PR.

---

## 5. Phases

### Phase 1. Attach + refresh (one seat)

- Provider constant + login prompt 3 / `--provider xai`.
- Device-code login + email check + Redis publish.
- Relax `findConflictingCredential` to same-provider-only.
- `aim auth maintain` xAI refresh.
- `aim grok status` / inventory (health only).
- Tests: first enroll on empty label, attach onto existing Claude+Codex label, identity mismatch fail-closed, refresh rotate/no-rotate, Claude/Codex login unchanged.
- Live: enroll `pro1` after SuperGrok is subscribed.

Exit: Redis has `xai:pro1` ready. `anthropic:pro1` and `openai-codex:pro1` versions unchanged.

### Phase 2. Prime worker

- Harness allowlist + `--grok` + `aim prime run grok`.
- Next-best unlocked xAI picker.
- Prove one tool-calling turn on `xai/grok-4.6` high from AIM, not from Prime native login.
- Prove `--grok off` still allows native Prime xAI.

Exit: a second machine can `aim prime run grok` and get `pro1` without local secrets.

### Phase 3. Billing meter (short)

- Implement `fetchXaiUsageSnapshot` against `cli-chat-proxy.grok.com/v1/billing` and `/v1/settings`.
- Prove identical JSON on the `pro1` token after SuperGrok subscribe.
- Add used/limit columns and rank by remaining monthly included. No HTML scrape. No weekly Heavy poll.

### Phase 4. Fleet

- Bind BrowserOS profiles for the seats you actually want (start with 3, not 23).
- Subscribe + `aim login --provider xai` each.
- `aim grok watch --once` only if usage exists; otherwise skip.
- Write a short enrollment page next to `BROWSEROS_RAMP_MAX20_AIM_ENROLLMENT_GUIDE.md`. Do not duplicate this plan.

---

## 6. Risks

| Risk | What to do |
|---|---|
| Public Grok CLI client id gets revoked or rate-limited | One client, already used by Prime and Grok CLI. If it dies, stop. Do not mint a second unofficial client. |
| SuperGrok OAuth is not the same as the SpaceXAI API account | Prove with `pro1` after subscribe. If device login fails on an unsubscribed account, the runbook order is subscribe then login. |
| Extra usage credits vs seat | Credits stay on grok.com. AIM does not manage them. |
| No usage API | Ship without percents. Locked/expired is enough to start. |
| Long-context 2x | Worker problem, not AIM. Prime/Grok sessions should compact under 200k. Out of this plan. |
| Attach-provider fix is over-applied | Only skip conflict when providers differ. Same provider + different email still fails. |
| Prime native xAI vs AIM xAI fight | AIM on means descriptor only. Document `--grok off`. |
| Overnight expiry | Same maintain job as Claude/Codex. Canary: leave `pro1` overnight, confirm refresh. |

---

## 7. Proof

Minimum receipts before calling this real:

1. `aim login pro1 --provider xai` on a subscribed SuperGrok, email `pro1@fun.country`.
2. Redis `xai:pro1` ready. `anthropic:pro1` version unchanged. `openai-codex:pro1` version unchanged.
3. `aim grok status pro1` live.
4. Kill the access token, run `aim auth maintain`, new access, same refresh or rotated refresh stored.
5. `aim prime run grok` completes one grok-4.6 high tool turn.
6. Full AIM suite + lint still pass.
7. A Claude `aim login` on another label still works (no prompt numbering regression: 2 is still Claude).

---

## 8. Suggested first PR

One PR, Phase 1 only, on a dedicated aimgr worktree. Not this shared `psagentspace` checkout.

Files that should move (expected, not a quota):

- `src/core/constants.js`
- `src/credentials/oauth.js`
- `src/credentials/xai-login.js` (new)
- `src/cli/commands/login.js`
- `src/cli/commands/auth.js`
- `src/coordination/runtime.js` (conflict check)
- `src/coordination/login-publish.js` (identity helper)
- `src/cli/commands/grok.js` (new, status/inventory only)
- tests next to the existing redis-login and usage tests

No README novel. No new command family beyond `aim grok status|inventory`.

---

## 9. Open questions for Amir (do not block Phase 1 code)

1. SuperGrok or SuperGrok Heavy as the seat SKU?
2. Same labels (`pro1`) or a `pro1` Grok-only suffix? This plan assumes same labels.
3. Monthly Ramp cap per seat? Claude used $250. Grok list prices are lower; $100 may be enough if extra credits are the overflow.
4. How many seats in the first fleet cut: 1 (`pro1`), 3, or all 23?

Until those are answered, implement and canary **one** seat: `pro1`.
