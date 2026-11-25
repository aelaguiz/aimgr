---
title: Claude account switch recovery
date: 2026-11-25
status: complete
doc_type: project_plan
related:
  - https://github.com/aelaguiz/aimgr/issues/41
  - https://github.com/aelaguiz/aimgr/issues/38
  - https://github.com/aelaguiz/aimgr/issues/39
---

# Claude account switch recovery

`aim claude resume <session> --switch-account opus` should reopen the conversation on an account that can run Opus and has room to keep working. A switch should use current evidence for its destination. When every eligible destination is limited, the command should report the earliest known reset before it creates a fork.

## What happened

On November 25, four copies of a resumed session reached the five-hour cap on Team seats in about two minutes. The first request on one of those copies returned `usage_limit_reached` in under half a second. A fleet read across 11 machines showed 50 of 67 Claude accounts limited. One Team seat that the switching Mac had at 86% of its week was already at 100% in a newer fleet reading. The installed selector also ranked a Team seat at 98% of its five-hour allowance with two local sessions above a Max 20x account at 81% of its week. The Max response had omitted the five-hour meter.

The provider documents separate five-hour and weekly usage limits. Team limits are per seat. The pool dashboard estimates a Team seat at 0.46 of a Max 20x week from observed fleet usage. That estimate is appropriate for comparing weekly capacity. Use the short-window meter independently to detect an immediate cap or an account close to one. [Anthropic usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) · [Anthropic Team plans](https://support.claude.com/en/articles/9266767-what-is-the-team-plan) · [Weekly pool measurement](https://github.com/aelaguiz/aimgr/issues/39)

## Behavior review

| Path | Current behavior | Decision |
| --- | --- | --- |
| Automatic `claude resume --switch-account` | Excludes the source label after collecting status. Assigns a score of -1 whenever the five-hour meter is absent, even with a recent weekly reading. Treats every active scoped cap as applicable to every preset. Can pick an expired local login with days-old usage projected through its reset. | Give this path a recovery policy with model-specific ranking and confirmation before staging history. |
| Plain `claude resume` | Opens the original account. If its login is unavailable, the existing automatic fallback requires a live reading. | Keep its current recovery behavior. |
| Resume with `--account`, including an explicit preset | Uses the label the operator supplied and the existing cross-account fork. | Keep explicit choice available. |
| Preset launch, scheduled Claude, and legacy Prime/Pi | Choose accounts through the existing primary or legacy selectors. The operator is starting work or choosing a harness binding. | Keep their separate policies. |
| Claude status and cluster status | The former reads local statusline and OAuth observations. The latter gathers all machines over SSH and takes the freshest reading for display. | Use the existing local status collector and targeted provider requests for recovery. |

The [CLI's resume branch](../src/cli/commands/claude.js) owns selection before the fork. The [status collector](../src/status/claude-redis-view.js) owns route validation, cache identity, provider checks, and the stale-window projection. The [usage parser](../src/pool/usage.js) recognizes general windows and model windows, including the shared Fable/Sonnet meter. The [local session counter](../src/targets/claude-machine-lease.js) tells the picker how many live AIM sessions on this machine share an account. The [native maintainer](../src/credentials/claude-local-maintenance.js) can renew one local login through the existing reviewed path when an access token is too old for a usage request.

## Recovery behavior

- Keep local login, pool membership, plan admission, and assigned route as eligibility conditions. Exclude the source account from the candidates. Confirm the destination before forking. Preserve the existing history, preset, effort, working directory, and launch protections.
- Use the first applicable limit to assess how much work fits. Consider the general five-hour and weekly windows and the requested model's scoped windows. An Opus switch can use a seat with a full Fable/Sonnet meter when the general and Opus meters permit it. A fresh Max weekly reading remains useful when the provider omits a short-window meter. Compare observed headroom per local session, using the current plan weight for weekly capacity. Where provider meter coverage differs, use available evidence as an estimate of relative room.
- A fresh provider observation or recent usable sample is enough for a clear choice. If the decision rests on stale, missing, or near-limit observations, check the most promising destinations through the existing usage route. Cap the extra checks at three per switch and keep the provider call concurrency already used by status. The initial status read retains the existing validation of configured proxy routes. If a plausible idle candidate needs OAuth renewal, use the reviewed native maintenance path once with a short deadline before reading its usage. Re-rank on the returned meters. Treat failed checks as unverified and honor recent provider throttling.
- A cached meter that has passed its reset is a reason to check the account again. A full applicable meter with a reset still ahead is evidence that it will block. If there is no verified destination, show the earliest known reset across eligible accounts. For an account with several full applicable windows, it is the latest of those resets. Describe an inconclusive check as unverified rather than as known exhaustion.
- Answer the selection question with local usage and targeted requests to the provider, which sees the account's use across machines. The cluster SSH inventory is for operators. It would fan out status requests during a time-sensitive resume, and the optional macOS maintenance service cannot supply dependable fleet telemetry. The switch uses the live session count available on its own machine. Work started elsewhere can spend the same capacity after a check.

## Implementation and verification

1. Add the recovery ranking and reset calculation using normalized usage windows. Prove the incident case with a near-full Team seat and a Max 20x account whose provider response omits the five-hour meter. Cover healthy Team seats, concurrent sessions, scope-specific limits, and multiple resets.
2. Wire the policy into automatic switches. Reuse local cache and routed provider status for candidate verification. Prove the real CLI path chooses a different destination if a fresh check finds the preferred account full, declines a blind fork when no account can be verified, and keeps the selected model and saved effort. Cover route failures, expired local access, and exact-account resume.
3. Run the affected suites and the full suite locally. Replay the selector with production-shaped observations and verify the installed release on the AIM fleet through devcluster. Verify the switch path with fixture sessions so existing conversations stay available to their owners.

## Implementation audit

Automatic resume switches are the sole caller of the new ranking and verification policy. The selector uses normalized quota windows, the plan weights from the pool table, and the existing local session counts. The resume command uses the existing launcher to stage and fork only after a destination has been confirmed. [Ranking](../src/pool/claude-switch.js) · [Resume](../src/cli/commands/claude.js).

Replaying the two-account incident through the previous selector picked the 98%-used Team seat. The recovery selector picked the Max 20x account with the 81%-used weekly meter. CLI fixtures exercise the full selection and fork path, including a stale favorite going to 100%, an unrelated model cap, a recent 429, and expired local access. The broad suite passed 1,037 tests and skipped 17. Its five proxy transport fixture failures reproduced on the prior release, `7cbfe6b`. [Ranking tests](../test/pool/claude-switch.test.js) · [CLI tests](../test/cli/claude-route-selection.test.js).

The rollout record belongs with the issue. The release is installed and checked using the [AIM fleet process](FLEET.md). [Issue #41](https://github.com/aelaguiz/aimgr/issues/41).
