---
title: "Codex pro11 and pro13 deactivation: what they were used for, and what breaks OpenAI's terms"
date: 2026-09-29
status: analysis
owners: [aimgr]
related:
  - CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md
  - src/pool/usage.js
  - src/pool/watch.js
  - src/credentials/codex-login.js
  - src/cli/commands/auth.js
---

# Codex pro11 and pro13 deactivation (2026-09-29)

Accounts: OpenAI ChatGPT Pro, pooled by AIM as Codex labels.
- `pro11`: account `45fa9e9b-4b5a-47fd-a90b-ea0a0f904e9a`, user `user-E2pY1Y2P24uLHl1tQNSGg0aw`.
- `pro13`: account `1a34a5fd-b165-446b-861c-6fc095d9c36e`, user `user-95O6QlicfA14kVPL4PNZTqHU`.

The Claude accounts with the same labels are different accounts and are fine. All times are UTC with Chicago time (CDT, UTC−5) in brackets.

## TL;DR

1. **Both accounts died days before you noticed, and neither was in use when it died.**
   - `pro11` died between 09-26 02:04Z and 10:51Z (21:04 on 09-25 to 05:51 on 09-26 CDT). Its last real use was 2.5 days earlier.
   - `pro13` died between 09-27 03:24Z and 09-28 01:54Z. Its last real use was 3 to 4 days earlier.
   - During those idle days, the only traffic on either account was automated: usage polling every 5 minutes from two machines, token refreshes, and nightly jobs checking usage.
2. **What they were used for:** heavy, mostly human-started coding work from 09-15 to 09-24 on this Mac (M5) and `home`.
   - The work: `$issue-to-pr` and milestone work, PS Mobile, rustai, psagentspace, Cratejoy.
   - Style: large subagent fleets, overnight runs, and automated "continue" nudging.
   - Volume: `pro11` took about 15,000 model responses (6,854 on M5 and about 8,160 on `home`). `pro13` took about 6,100.
   - `studio`'s Hermes cron jobs added a little: 89 calls on `pro11` and 53 on `pro13`.
3. **Account sharing is against the terms.** You believed there was no rule, but the Terms of Use say: "You may not share your account credentials or make your account available to anyone else".
4. **The clause AIM's design runs into most directly is not automation. It is getting around usage limits.**
   - The Terms of Use forbid circumventing "any rate limits or restrictions".
   - OpenAI's Sign in with ChatGPT terms name "rotating accounts" and "Pooling … Authentication Tokens".
   - AIM's pool exists to switch to a fresh account when one runs out, and that is exactly the named behavior.
   - Automation (`codex exec`, schedules) is officially supported. It matters mainly because it makes the pattern easy to detect.
5. **This matches the 09-14/09-16 round:** accounts die while idle, in or near the overnight window, with no single bad session. That points to account-level pattern detection across the pool, not to anything the accounts did that night. OpenAI never states a reason, so this is inference.

## Automations that run or use Codex accounts

Everything found on the fleet, as of 2026-09-29 23:30Z. "Stopped" means it was stopped today at your request.

| # | Machine | Automation | How often | Status |
|---|---|---|---|---|
| 1 | studio | `aim hermes watch`, a LaunchDaemon (`/Library/LaunchDaemons/com.funcountry.agents_host.aim_hermes_watch.plist`, `StartInterval 300`). Checks usage for all 23 pooled OpenAI accounts at once, and reassigns 21 Hermes homes among them: 182 reassignments to or from pro11/pro13 since 09-01, 30 on 09-22 alone. | every 5 min, 24/7, since March | **running** |
| 2 | studio | 21 enabled Hermes cron jobs (for example `cj_agent_zara` every 4 h, some every 15–30 min, `agent_ops` crash reports) on whichever pooled account the watcher gave them. Each job sends the same `prompt_cache_key` / request id every run, so the same key reaches OpenAI from many accounts. | 15 min to daily | **running** |
| 3 | studio | Nightly disk cleanup, a LaunchAgent: `aim codex run -- exec --dangerously-bypass-approvals-and-sandbox --ephemeral --json`. On 09-22 it was started by hand 5 times, and two of those runs landed on pro11 and pro13. | daily 01:15 CDT | **running** |
| 4 | laptop | `aim hermes watch`, a cron job every 5 min. Checks usage for about 31 accounts, including dead ones. | every 5 min, 24/7 | **running** |
| 5 | laptop | Token maintainer (`com.funcountry.aimgr.auth-maintainer`, `aim auth maintain`). It retries dead accounts forever: pro13 about every 73 s since 09-28 (~1,100 a day), and pro12, pro14, pro15 and amir_elaguizy_fun_country ~1,250 a day each. | every 60 s | **running** |
| 6 | laptop | Hermes `maxrivers`, a Telegram agent with a daily 07:00 CT reminder cron, plus Hermes `personal`. It was on pro13 09-11 to 09-12 and on pro11 09-03 to 09-06. It moved to xai-oauth on 09-26. | daily plus chat | **running** |
| 7 | laptop | Nightly disk cleanup: `aim codex run -- exec --dangerously-bypass-approvals-and-sandbox --ephemeral`. | daily 02:15 CDT | **running** |
| 8 | home | `nightly-disk-cleanup.timer`: `aim codex run -- exec --ephemeral`, gpt-5.6-sol. | daily 01:45 CDT | **running** |
| 9 | M5 | Routine `chief-daily-maintenance`, Codex gpt-6-astra (last run on office). | daily 02:00 CDT | **running** |
| 10 | M5 | Routine `daily-disk-cleanup`, Codex gpt-5.6-sol. It ran on pro13 on 09-23 and on growth on 09-29. | daily 03:00 CDT | **running** |
| 11 | M5 | Routine `daily-sheet-maintainer`, Codex CLI through DeepSeek. It creates Codex threads under whichever account `~/.codex/auth.json` holds, but makes no OpenAI model calls. | daily 04:00 CDT | running (not OpenAI) |
| 12 | M5 | Claude sessions that drive Codex through `aim codex run -- exec` (fresh-consult reviewer fleets, "Chief" consults). Each `exec resume <id>` moves the same thread to a new account. | on demand | active when used |
| 13 | M5 | Claude "capacity monitor" (`b9a603e2`, then `2082e582`): typed "continue" / "keep going" into Codex panes every 3 minutes, 894 times. | every 3 min | not running (last write 09-22) |
| 14 | studio | `paperclip-codex` tmux session, 41 days old. No model calls, but about 480 failed token refreshes a day on pro10. | continuous | **stopped today** |
| 15 | laptop | Prime (3 supervisors and ~40 processes), including session `01a04edc` on illustrator. That session had been idle since 09-01 apart from local status writes. | continuous | **stopped today** |
| 16 | studio | Prime `mcp-serve` on port 7717, plus its supervisor. | continuous | **stopped today** |
| 17 | home | Codex Dock relay (`codex-dock-relay.service`, `0.0.0.0:4510`, phone auth off). It only retried a local socket. | continuous | **stopped today** (disabled) |

Side effect: AIM rewrites `~/.codex/auth.json`, which the ChatGPT desktop app shares. On laptop the app logs "Failed to refresh token … signed in to another account" (284 lines in 3.5 hours).

## What each account was used for

Account attribution: every Codex response records the account's weekly limit reset time (`rate_limits`, 10080-minute window, `resets_at`). That value is unique per account and week. This is the method of the 09-16 audit.

### pro11 (weekly windows: until 09-22 16:44Z, then 09-22 10:06Z → 09-29)

| When | Where | What | Driven by | Volume |
|---|---|---|---|---|
| 09-15 16:44 → 09-16 02:31 | M5 | Conductor TUI `01a098a1`, Cratejoy P1 issues; you typed "back from rate limit continue" | human, 25 Sol subagents | 1,384 responses |
| 09-16 22:12 → 09-17 07:01 | M5 | Overnight fresh-consult reviewer fleet (website SEO PRs), driven by Claude `64547480` | agent-driven; `nohup` retry loops every 3/10/20 min; "Reply ok" probes | up to 12 threads at once, 921 responses/h peak |
| 09-16 21:17 → 09-17 13:26 | home | `01a0ac14`: poker training tasks, GWS sheet review | human (probable attribution) | ~200 |
| 09-18, 09-20 | M5 | `01a0b48e` (Cratejoy #16185 exec, 5 subagents), `01a0bba8` TUI | mixed | 733 in 25 min; 821 |
| 09-21 12:58 → 09-22 04:45 | home | `01a0c40b` (`$issue-to-pr` 760), then `01a0c07b` plus 4 subagents | human plus the 3-minute nudger | ~3,400; took the old window to 100% |
| 09-22 10:06 → 09-23 01:14 | home | `01a0c07b` plus 7 subagents: PS Mobile M1/M2 `$issue-to-pr` (#6073, #5678, #5681, #5684) | human 12:14–19:21, plus nudges | 4,574; 0% → 65% |
| 09-22 11:03 → 21:19 | M5 | "Chief" voice chat `01a0c8c8`; `codex exec` dry run `01a0caf4` (launched by Claude) | human and agent | ~100 |
| 09-23 18:19 → 23:09 | M5 | TUI `01a0cf7d`, `$issue-to-pr 6116` plus subagent | human; the first turn ran 3.5 h on its own | 2,100; 65% → 77% |
| 09-15, 09-19 | studio | Hermes cron: seller-support queue summary, buyer queue sweep, ad-comment drafts | schedule | 89 calls |
| **after 09-23 23:09** | — | **No model use.** Only usage polls and one successful refresh by the maintainer at 23:54 | automated | — |

Two anomalies:
- `home`'s thread `01a0c07b` kept pro11 for 29.5 hours after AIM had switched `auth.json` to another account. Codex pins each process to the account it started with.
- pro11 ran on `home` and M5 at the same moment on 09-22 around 21:10Z.

### pro13 (weekly windows: 09-19 11:51Z → 09-26, then from 09-27 03:24Z)

| When | Where | What | Driven by | Volume |
|---|---|---|---|---|
| 09-15 02:25 → 10:07 (21:25–05:07 CDT) | M5 | Lessons Studio TUI `01a0a232`: `/goal` continuation turns with nobody at the keyboard | goal loop | overnight |
| 09-18 12:02 → 09-19 16:19 | M5 | TUI `01a0b464`, fixing the morning-report routine; one "continue" → a 4.5 h autonomous turn | human | 1,065 |
| 09-20 19:27 → 20:19 | home | `01a0c04a`, PS Mobile milestone planning from a spreadsheet | human | 77 |
| 09-22 13:17 → 23:58 | M5 | TUI `01a0c942` plus 3 subagents, milestone/PR/CI work; the capacity monitor typed "continue" 3 times | human plus nudger | 2,767, up to 4 threads |
| 09-22 23:04 → 09-23 11:40 | M5 | Claude "Chief" consult threads resumed under a new account each time (boss → pro13 → pro7, etc.) | agent | small |
| 09-22 12:11 → 12:16 | studio | Hand-started nightly disk-cleanup `exec` | manual start of an automation | 6 commands |
| 09-21, 09-22 | studio | Hermes `agent_ops`: crash reports, staging build, store sweep | schedule | 53 calls |
| 09-23 08:00 (03:00 CDT) | M5 | Routine `daily-disk-cleanup` | schedule | 19 |
| 09-23 18:29 → 09-24 02:52 | M5 | TUI `01a0cf87` plus 2 subagents: BigQuery cost emails, `$issue-to-pr` 6097/6111 | human | 1,203 |
| **after 09-24 02:52** | — | **No model use.** Only usage polls; the refresh on 09-28 got a 401 | automated | — |

## When they died

The evidence is the last good and first failed usage read, from `~/.aimgr/redis-cache.json` on each machine and the laptop maintainer log.

| Account | Last proof alive | First proof dead | Window (CDT) |
|---|---|---|---|
| pro11 | 09-26 02:04:01Z, good usage read on M5 | 09-26 10:51Z, failed usage read on laptop | 09-25 21:04 → 09-26 05:51 |
| pro13 | 09-27 03:24:10Z, good usage read on M5 | 09-28 01:54:53Z, refresh gets 401 on laptop | 09-26 22:24 → 09-27 20:54 |

- AIM marked both `openai_account_deactivated` in Redis at 09-29 22:48:31Z.
- The previous round was pro12/pro14/pro15 on 09-14 (about 04:51 CDT) and amir_elaguizy_fun_country on 09-16 (02:14–04:38 CDT).
- pro11's window covers that same overnight hour range.
- For comparison, the fleet runs its nightly Codex jobs from 01:15 to 03:00 CDT: studio 01:15, home 01:45, M5 02:00 and 03:00, laptop 02:15. They check every account's usage as they select one. That overlap is a correlation only, not a proven cause.

## What OpenAI can see, and which terms it touches

| Signal | Evidence | Terms it touches |
|---|---|---|
| **Rotating across accounts to avoid limits** | The pool switches account when one is exhausted. `aim codex run` picks a new account on every call. `resume-fresh` exists to continue work on a new account. | Terms of Use: "circumvent any rate limits or restrictions". Pro help: "You cannot bypass a limit". Sign in with ChatGPT terms: "Creating multiple accounts, splitting usage, rotating accounts, or otherwise bypassing usage limits". **Most direct.** |
| **One conversation sent under several accounts** | 8 threads on M5 were resumed under different accounts (`exec resume` with rotation); home's `01a0c07b` moved across accounts; Hermes job keys repeat across accounts | Links the accounts server-side, so the pool shows up as one operator |
| **One account used from several hosts at once** | pro11 ran on home and M5 together (09-22); pro13's token was refreshed on one host and checked from three | CI/CD guide: "Do not share the same file across concurrent jobs or multiple machines". Sign in with ChatGPT terms ban "Pooling, transferring … Authentication Tokens" |
| **Round-the-clock checks of 23–31 accounts from one IP** | studio and laptop each check every account every 5 min (about 285–288 requests per account per day, user agent `CodexBar`); AIM also checks every account on each `aim codex use`/`run` | Not named anywhere, but it is a machine-driven pattern that ties all the accounts to one operator and one IP |
| **Refresh storms on dead accounts** | ~1,100 to 1,250 failed refreshes per dead account per day, from one IP and one OAuth client | Looks like credential abuse; the 09-16 audit flagged it |
| **Unattended loops** | The 3-minute "continue" nudger (894 sends); `/goal` overnight; `nohup` retry loops; 21 Hermes cron jobs | "Automatically or programmatically extract data or Output" only loosely. Codex officially supports automation and scheduled tasks. It mainly adds volume and regularity to the pattern. |
| **Account sharing** | 31 accounts serve one person, so this is the rotation problem above. If any Hermes agent answers people other than you (for example on Slack or Telegram), that is also sharing. | Terms of Use: "You may not share your account credentials or make your account available to anyone else"; Sign in with ChatGPT terms: "Another user's activity must not trigger requests to the authenticated user's account" |

Sources, accessed 2026-09-29:
- [Terms of Use](https://openai.com/policies/terms-of-use/)
- [Account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
- [ChatGPT Pro](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)
- [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), which appear to have been published on 2026-09-29
- [Codex CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth)
- [Codex auth](https://developers.openai.com/codex/auth)
- [Why accounts are deactivated](https://help.openai.com/en/articles/10562188-why-was-my-openai-account-deactivated)
- [Appeal form](https://openai.com/form/appeal/)

OpenAI's docs recommend API keys for automation ("API keys are still the recommended default for automation"). They do not forbid ChatGPT login for it.

## What the accounts were not used for

- **No browser scraping on these accounts.** Hermes jobs call APIs (Sentry, Sheets, BigQuery, App Store Connect).
- **No Prime or Pi sessions** used pro11 or pro13 in the window.
- **No OpenClaw agents.**
- **No `codex exec` automation on pro11/pro13 on `home`.**
- **No activity at the time of death**, on any machine.

## Options

Ranked by how much each lowers the risk to the remaining accounts. Each is a decision for you.

1. **Stop the refresh storm today (bug).**
   - The maintainer only gives up on OpenAI's `invalid_grant` response (`src/credentials/codex-login.js:63-68`), not on 401 or a deactivated account.
   - It also ignores `health.reason = openai_account_deactivated` (`src/cli/commands/auth.js:73-75`).
   - Fix: treat 401/deactivated as terminal, and skip blocked accounts in the maintainer and in every usage check. About 1 hour.
2. **Cut the polling.** Two machines check every account every 5 minutes, all day.
   - Poll only accounts that something is using, at most hourly.
   - Or turn off `aim hermes watch` on laptop and studio if Hermes doesn't need rotation.
3. **Stop moving one conversation across accounts.** `aim codex run -- exec resume <id>` rotates on every call, which breaks your own 2026-09-18 rule for `aim codex resume`. Pin `exec resume` to the thread's account or fail.
4. **One account, one machine at a time for Codex.** Give Codex a lease like Claude's, so a pinned process can't keep using an account on another host after AIM moves on.
5. **Decide what automation should run on ChatGPT accounts.**
   - The candidates are the Hermes cron fleet (21 jobs), the four nightly `codex exec` cleanups, and `chief-daily-maintenance`.
   - OpenAI's stated path for automation is API keys. Moving these to an API key removes them from the pool's pattern entirely.
6. **The structural question.** The pool's purpose, switching to another subscription when one runs out, is the behavior the terms name most directly. Options 1–5 reduce how visible the pattern is. None of them makes rotation itself compliant.

## Addendum: `lessons` (deactivated overnight 09-29/30)

Account `d9b5f50c-6b5d-43d9-b70b-6ea40248d02e` (lessons@fun.country, Pro). Redis marked it `openai_account_deactivated` at 09-30 12:05Z (07:05 CDT).

**When it died:** between **00:44:30Z and 06:16:52Z (19:44 CDT on 09-29 to 01:16 CDT on 09-30)**.
- Its last model response was at 00:44:30Z, on M5 thread `01a0ef43`.
- Studio's nightly cleanup picked it at 06:16:50Z. Within 2 seconds it got "Encountered invalidated oauth token" (401) and "your refresh token was revoked", and never got a model response (`~/.local/state/mac-studio-disk-cleanup/runs/20260930T061505Z.fizFuZ`).

**Unlike pro11 and pro13, it was in use until a few hours before it died.**

| Window | Use |
|---|---|
| 09-28 07:17Z → death (final week) | **3% total.** The amir-m3-36gb nightly cleanup on 09-28 used under 1%. M5 Codex TUI `01a0ef43` (psagentspace, gpt-6.1-sol xhigh) ran 09-29 22:23Z to 09-30 00:44Z: you root-causing Phil's dynamic-missions production bug. 11 prompts typed by you, 328 responses, no subagents, no errors. |
| 09-19 21:00Z → 09-26 21:00Z (week before) | **79% used**: about 3,600 responses on M5 and about 1,540 on home (copies of forked rollouts removed). This includes the home rustai session on 09-20 (0% to 20%), M5 fleets on 09-21, one thread `01a0c59a` running overnight 09-21 20:14Z to 09-22 13:43Z (1,212 responses), psbrain and psmobile threads, and reviewer thread `01a0d548` (09-25 03:33Z to 09-26 02:04Z). Claude sessions `84d2b72d` and `6f5de89c` resumed `01a0d548` under a different account each time with `aim codex run -- exec resume`. |

**Traffic between its last use and its death:**
- The five-minute Hermes polling on laptop and studio, and the laptop maintainer, had been stopped at about 18:47 to 18:52 CDT on 09-29.
- The remaining traffic was AIM's selection checks. Each `aim codex use` or `run` checks every account; that includes Amir's two `cr` runs at 17:33 CDT.
- It also includes the investigation's own two probe bursts from M5, at about 17:40 and 17:46 CDT. They sent all 31 accounts' tokens to `/wham/accounts/check` and `/wham/usage` within seconds. That burst has the same shape as AIM's selection check, so the data cannot say whether it mattered.

**Pattern across all three accounts:**
- Each was heavily used the week before (pro11 and lessons around 80%, pro13 around 56%), then lightly used or idle.
- Each died overnight.
- At least one thread was resumed under another pool account for pro13 and lessons: the Chief chains and `01a0d548`. That is consistent with OpenAI linking pooled accounts together and banning them as a cluster. This is inference; OpenAI gives no reason.

## Watch list: load per account, hot period vs since (computed 2026-09-30)

These are Codex responses from rollouts on M5 and home, matched to accounts by weekly `resets_at`. About 26% of the hot period's responses could not be matched, because their windows ended before AIM's usage samples begin or were replaced by reset credits. So pro11's count is understated; home alone ran about 8,000 on it on 09-21 to 09-23. Nightly jobs and Hermes on other machines are not included; they are small.

| Account | Batch | 09-19 → 09-24 | 09-25 → 09-30 | Status |
|---|---|---:|---:|---|
| pro2 | Mar | 29,693 | 859 | alive |
| pro8 | May | 17,043 | 106 | alive |
| product_growth | Mar | 11,244 | 54 | alive |
| pro10 | May 28 | 11,015 | 359 | alive |
| pro5 | Mar | 10,506 | 76 | alive |
| pro9 | May | 9,818 | 0 | alive |
| claudalyst | Apr | 8,548 | 555 | alive |
| coder | Mar | 7,298 | 0 | alive |
| cfo | Mar | 7,161 | 302 | alive |
| growth | Mar | 6,935 | 376 | alive |
| **pro11** | May 28 | 6,770+ | 0 | **banned 09-26** |
| pro6 | May | 6,043 | 379 | alive |
| pro17 | Aug | 5,078 | 0 | alive |
| **lessons** | Mar | 4,960 | 488 | **banned 09-30** |
| **pro13** | Aug | 4,951 | 0 | **banned 09-27** |
| boss | Mar | 4,943 | 0 | alive |
| office | Mar | 4,919 | 357 | alive |
| pro4 | Mar | 4,768 | 406 | alive |
| pro1 | Mar | 4,717 | 0 | alive |
| pro16 | Aug | 4,527 | 492 | alive |
| qa | Mar | 3,649 | 481 | alive |
| illustrator | Mar | 3,275 | 168 | alive |
| amir_personal | Mar | 2,969 | 241 | alive |
| pro7 | May | 1,719 | 18 | alive |
| pro3 | Mar | 436 | 183 | alive |
| coder2 | Mar | 312 | 0 | alive |

**What it shows:**
- The banned accounts were mid-pack, ranked 11th, 14th and 15th by load.
- Ten heavier accounts survive, including pro2 at 29,693 responses.
- pro16 and pro17 carried almost exactly pro13's load, came from the same August batch, and are alive.
- So load alone does not decide it. That fits a probabilistic decision, or signals other than volume.

**How to read the next ban:**
- **Pure mop-up:** it hits one of the accounts with **no use since 09-25**: pro9, coder, boss, pro1, pro17, coder2. The only traffic on those since then has been usage checks.
- **This week's use counts:** it hits an account whose load is mostly recent (pro3 is the only one that comes close).
- **Anything else** (pro2, pro8, pro16, claudalyst…) cannot tell the two apart, because it had both.

## Corrections to earlier statements

- **Laptop Prime session `01a04edc` was not active.** It was bound to illustrator and made no model calls after 09-01. Its growing transcript was local status lines written every 25 seconds.
- **Death dates.** "Overnight" is accurate for pro11: it died on the night of 09-25/26. pro13 died on 09-27. AIM only noticed on 09-29, because failed usage checks keep the old timestamp and never raise an alert.

## Evidence index

- **M5:**
  - `~/.codex/sessions/**` (rate-limit fingerprints), `~/.codex/state_5.sqlite` (`creator_account_id`);
  - `~/.aimgr/local-state.json` pool history (incomplete: it misses switches by routines and by `aim codex run`);
  - `~/.aimgr/routine-runs/*.json`, `~/.aimgr/usage-snapshots/usage-samples.csv`, `~/.aimgr/redis-cache.json`;
  - scratch parser output in the session scratchpad (`ev.pkl`).
- **home:**
  - `~/.codex/sessions/2026/09/20/rollout-2026-09-20T14-27-52-01a0c04a-….jsonl` and `…T15-21-47-01a0c07b-….jsonl`;
  - `~/.codex/logs_2.sqlite` ("Skipping auth reload due to account id mismatch");
  - `~/.aimgr/local-state.json(.bak.*)`.
- **laptop:**
  - `~/.aimgr/logs/auth-maintainer.out.log` (it has no per-line timestamps, and cleanup cut it at 09-23 07:15Z);
  - `/tmp/agents_host_aim_hermes_watch.out.log`, `~/.hermes/profiles/maxrivers/state.db`, `~/.aimgr/redis-cache.json`.
- **studio:**
  - `/Library/LaunchDaemons/com.funcountry.agents_host.aim_hermes_watch.plist`, `/tmp/agents_host_aim_hermes_watch.out.log` (52,230 runs);
  - `~/.hermes/profiles/<home>/state.db`, `logs/agent.log*`, `cron/jobs.json`;
  - `~/.local/state/mac-studio-disk-cleanup/runs/20260922T114535Z.z36gek` and `…T121118Z.O1rotp`.
- **Prior round:** [CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md](CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md).
