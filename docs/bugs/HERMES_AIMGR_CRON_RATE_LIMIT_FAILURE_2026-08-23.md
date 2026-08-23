---
title: "Hermes cron bypasses AIMgr after a blocked credential watch"
date: 2026-08-23
status: verifying
owners: [aimgr]
reviewers: []
related:
  - "Daily Poker News Radar → C030LCH08Q6"
  - "Daily AI News Radar → C04R4UHHHHC"
---

# Hermes/AIMgr cron rate-limit failure

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** Two `agent_growth_analyst` jobs failed at 09:00 CT on 2026-08-23 with `HTTP 429: The usage limit has been reached`.
- **Impact:** The Poker and AI news reports delivered failure notices instead of reports. No other cron errors were recorded across the Hermes fleet that day.
- **Most likely cause:** AIMgr detected the assigned `pro12` token was invalid for almost 20 hours, but its Hermes watch treats any active-home usage probe failure as a fleet-wide blocker and refuses to rebalance. At run time Hermes then recovered from the global Codex CLI auth file, outside AIMgr, and adopted `pro10`, whose weekly window was at 100%.
- **Next action:** Repair the watch so a proven-invalid active label is excluded and the affected home moves to an eligible AIM-managed label; close Hermes recovery from the global Codex auth store for AIM-managed profiles.
- **Status:** Verifying. The focused fix and regression coverage pass locally; push and deployment to `agents@amirs-mac-studio` are in progress.

<!-- bugs:block:analysis -->
## Bug North Star

AIM-managed Hermes profiles must start scheduled work with a usable AIM-selected credential. An invalid or exhausted assigned label must move to another eligible AIM account before the run. Hermes must not silently replace that assignment from an unmanaged global auth store.

## Evidence

1. The installed AIM Hermes watch is active as a system LaunchDaemon. It runs every 300 seconds with a 20% threshold and last exited `0`:
   - `/Library/LaunchDaemons/com.funcountry.agents_host.aim_hermes_watch.plist`
   - `aim hermes watch --once --rotate-below-5h-remaining-pct 20 --home /Users/agents`
2. The watch repeatedly reported `agent_growth_analyst -> pro12` as blocked by a 401 token-invalid response from 2026-08-22 12:58 CT onward. The blocker was sustained from 13:08 CT through the 09:00 CT cron run the next day.
3. The 08:59:30 CT watch receipt still said:
   - `status=blocked`
   - `agent_growth_analyst=pro12`
   - `reason=hermes_home_usage_unavailable`, `status=401`, `tokenExpired=true`
   - `triggeredRebalance=false`
4. At 09:00:10 CT, both news jobs loaded one `openai-codex` credential. Hermes logged a 401, then `Codex auth recovered from Codex CLI auth.json`.
5. The recovered credential returned `usage_limit_reached` with a reset at about 09:00 CT on 2026-08-25. Hermes retried three times against the same provider/model and both jobs failed in about 10.6 seconds.
6. At 09:04:34 CT, the next AIM receipt identified the home as `pro10`, saw 0% remaining, and moved it to `coder`. At 09:09:35 CT the fleet was clean with `coder` and at least 43% primary remaining.
7. Current AIM status confirms `pro10` is at 100% weekly usage and `coder` is usable. `pro12` has a stale 100% cache because its live usage probe is invalid.
8. All 20 Hermes profiles with readable `config.yaml` files have `fallback_providers: []`, and all have empty `cron.model` / `cron.model_provider`. The failure text about no fallback chain is therefore accurate, but it is a secondary remediation hint rather than the initiating fault.

## Code anchors

- Running AIMgr SHA: `b6e356a986f189626f56cf60c399b76ec9e2a432` on `redis-credential-coordination`.
- Fetched branch head: `7853799fd60d6a544c974f9f128bc80f907143ed`; fetched `origin/main`: `82dbab6888a0e2ac9c37bece538c86696c80d14b`.
- The deployed checkout is 12 commits behind its tracked branch, but the relevant Hermes watch behavior is unchanged in the tracked branch and current main.
- `src/pool/watch.js:339-377`: a missing active-home usage percentage adds `hermes_home_usage_unavailable`; any such blocker returns before `rebalanceHermesPool()`.
- `src/pool/hermes-rebalance.js:121-277`: rebalance already excludes labels whose usage is invalid/exhausted and can write a replacement Hermes auth file.
- `src/targets/hermes-auth.js:118-125`: AIM intentionally writes exactly one `openai-codex` credential-pool entry per Hermes home.
- Installed Hermes SHA: `165c889e5b4277b56dadd42949a4112c1e6175a6`.
- `hermes_cli/auth.py:3836-3849, 3990-4020`: on rejected refresh credentials, Hermes imports and persists tokens from `CODEX_HOME` or `~/.codex/auth.json`.
- `cron/scheduler.py:128-147`: Hermes adds the no-fallback-chain hint when `fallback_providers` is empty.

## Investigation verdict

**Primary defect:** The AIM watcher fails closed at the wrong boundary. A confirmed-invalid active credential is actionable evidence to exclude that label and rebalance the affected home, but one such record currently blocks the whole fleet.

**Compounding defect:** The AIM projection is not exclusive at runtime. Hermes can replace AIM-projected tokens from the global Codex CLI store. In this incident that side door changed the profile from invalid `pro12` to exhausted `pro10` instead of another eligible AIM assignment.

**Not causal:**
- The gateway was running.
- The jobs and Slack delivery target were valid.
- The X and Google tools were never reached; inference failed on the first model call.
- The deployed AIM checkout being behind was not causal because the relevant blocker logic remains in fetched latest code.
- Generic provider instability was not the cause; the upstream error included a plan usage-limit reset about 48 hours later.

<!-- bugs:block:fix_plan -->
## Candidate fix plan

### Scope and simplicity contract

- **Human-authorized corrected behavior:** On 2026-08-23 the user authorized a pushed and deployed fix so AIM-managed Hermes profiles rotate away from hard-invalid credentials instead of failing scheduled work.
- **Smallest sufficient fix:** For a hard credential result such as token-invalid or provider-declared exhaustion, exclude that label and invoke the existing Hermes rebalancer when another eligible AIM label exists. Keep transient/ambiguous usage failures fail-closed.
- **Known adjacent authority gap (not part of this deployment):** Hermes can import `~/.codex/auth.json` after rejected refresh credentials. Closing that path requires a separately approved Hermes or runtime-configuration change; this AIMgr watch deployment does not change it.
- **Enough proof for the authorized AIMgr change:** A focused watch test with one invalid assigned label plus one eligible alternative must move only affected homes; transient failures and the no-spare case must still block; the live fleet must stay clean through two watch ticks.
- **Do not build:** No generic provider router, new fallback framework, retry daemon, new credential store, or staged rollout.
- **Accepted residual risk:** A provider can still reject a credential between five-minute watch ticks. Closing that final request-time window would require an explicit Hermes-to-AIM failure handoff or a separately approved fallback policy.
- **Scope sign-off:** Approved by the user on 2026-08-23 before implementation.

### Proposed sequence

1. Change the AIM Hermes watch classification so a hard-invalid/hard-limited active label triggers the existing rebalance path when eligible alternatives exist.
2. Keep unavailable, malformed, DNS, and timeout usage probes as blockers unless there is hard provider evidence that the current label is unusable.
3. Treat isolation from the global Codex CLI recovery path as separate follow-up work that needs explicit runtime-change approval.
4. Prove the 2026-08-23 sequence with focused fixtures and two live watch ticks before any manual cron rerun.

## Verification plan

- AIM unit/integration: invalid assigned label + spare capacity causes a replacement write.
- AIM regression: transient usage endpoint failure causes no write.
- AIM regression: no eligible alternative remains blocked with clear evidence.
- Separate follow-up proof after explicit approval: rejected projected refresh cannot adopt the global Codex CLI account.
- Live evidence: `agent_growth_analyst` stays mapped to an AIM label with readable non-exhausted usage through at least two watch ticks.

<!-- bugs:block:implementation -->
## Implementation

Implemented locally on 2026-08-23:

- `src/pool/watch.js` now treats provider-proven 401/403 token invalidation and hard 409/429 usage limits as rotation signals when another eligible AIM label exists.
- Unknown, network, malformed, and ordinary provider failures remain fail-closed.
- A triggered rebalance now copies its blocker list into the parent receipt so serialized proof remains an array instead of `[circular]`.
- `test/hermes/hermes-05.cases.js` covers 401 rotation, 429 rotation, no-spare blocking, and transient 503 blocking.

Local proof:

- Focused Hermes suite: 25 passed, 0 failed.
- `npm run lint`: passed.
- Full `npm test`: 398 passed, 0 failed.

Deployment and live verification completed on 2026-08-23:

- Pushed implementation commit `dfc420a266aa0da173571de47be16d1d6dafe9be` to `origin/main`.
- Fast-forwarded the Mac Studio AIMgr checkout from `b6e356a` to the pushed commit.
- Refreshed `/Users/agents/.local/bin/aim` so interactive commands and the LaunchDaemon use the same canonical checkout.
- Remote focused Hermes suite: 25 passed, 0 failed.
- Live tick 1 at `2026-08-23T17:14:28.256Z`: `noop`, 21 homes, 0 warnings, 0 blockers; `agent_growth_analyst` remained on `coder`.
- Live tick 2 at `2026-08-23T17:14:29.233Z`: `noop`, 21 homes, 0 warnings, 0 blockers; `agent_growth_analyst` remained on `coder`.
- No gateway restart was required: the LaunchDaemon invokes a fresh AIMgr `hermes watch --once` process from the canonical checkout on every interval.

The authorized AIMgr rotation fix is deployed. Hermes's upstream global Codex-auth recovery remains unchanged and is recorded as separate follow-up work requiring explicit runtime-change approval.
