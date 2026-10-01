---
title: "Codex account bans: ledger, thesis and checklist"
status: living
owners: [aimgr]
updated: 2026-10-01
related:
  - CODEX_PRO11_PRO13_DEACTIVATION_ANALYSIS_2026-09-29.md
  - CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md
  - ../scripts/codex-ban-forensics/
---

# Codex account bans: ledger, thesis and checklist

Single place to check each new OpenAI (Codex) ban against what we already know.
- Add every new ban to the ledger.
- Score it against the predictions.
- Revise the thesis.

All times are Chicago time (CDT) unless marked Z (UTC).

The full evidence for each round is in [the 09-29 analysis](CODEX_PRO11_PRO13_DEACTIVATION_ANALYSIS_2026-09-29.md) (pro11, pro13, lessons) and [the 09-16 audit](CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md) (pro12, pro14, pro15, fun_country).

## When an account gets banned: checklist (about 30 min)

1. **Confirm and record.** `aim status` shows `blocked`. Also record when Redis marked it `openai_account_deactivated`.
2. **Find the death window.**
   - Last proof alive: run `cache_reads.py` on every host.
   - First proof dead: the first failed request. Look in the nightly cleanup run logs:
     - studio: `~/.local/state/mac-studio-disk-cleanup/runs/*/error.log`;
     - laptop and amir-m3-36gb: `~/.local/state/disk-cleanup/runs/`.

     Also look in the Codex logs, and in the maintainer log if it is running again.
   - Note that a failed usage read keeps its old timestamp. The first request after a ban fails at once, so it only shows the account was already dead.
3. **Find who used it.** Run `threads_for_window.py` with the account's weekly reset times on M5 and home, plus any other host that ran Codex. Run `selections.py <label>` on every host. Then find what each thread was doing and how it was driven (typed prompts, a nudger, `/goal`, a routine or job).
4. **Place it on the watch list** (below) and score each prediction.
5. **Add a ledger row** and update the thesis, the scorecard and the variables log.

```bash
cd ~/workspace/aimgr/scripts/codex-ban-forensics
python3 cache_reads.py <label>; for h in home laptop studio amir-m3-36gb; do ssh -o BatchMode=yes $h 'python3 - <label>' < cache_reads.py; done
for h in home laptop studio amir-m3-36gb; do ssh -o BatchMode=yes $h 'python3 - <label> <since-date>' < selections.py; done; python3 selections.py <label> <since-date>
python3 threads_for_window.py <reset-epoch> [<older-reset-epoch>]; ssh home 'python3 - <reset-epoch>' < threads_for_window.py
# load table for a period split, from rollouts on each Codex host:
python3 rollout_counts.py <start> <split> <end> > /tmp/c_m5.json; ssh home 'python3 - <start> <split> <end>' < rollout_counts.py > /tmp/c_home.json
python3 load_table.py --counts /tmp/c_*.json
```

The scripts depend only on the Python standard library and never read tokens. Get reset epochs from the `week_reset` field of `cache_reads.py`, or from `~/.aimgr/usage-snapshots/usage-samples.csv`.

## Ledger

| # | Account | Batch | Redis marked | Death window | Last real use | What touched it inside the window | Notes |
|---|---|---|---|---|---|---|---|
| 1 | pro12 | Aug 16–17 | 09-14 04:51 | 09-13 22:03 → 09-14 04:51 | 09-13 22:03 (M5) | in watcher rotation | "refresh token revoked" seen before it died |
| 2 | pro14 | Aug 16–17 | 09-14 04:51 | ? → 09-14 04:51 | in rotation | in watcher rotation | only 258 responses in its final window |
| 3 | pro15 | Aug 16–17 | 09-14 04:51 | 09-14 03:33 → 04:49 | 03:33 (M5 SNG orchestrator) | active use | died mid-use |
| 4 | amir_elaguizy_fun_country | Mar or older | 09-16 06:23 | 09-16 02:14 → 04:38 | 02:14 (missions orchestrator, 100%) | active use | 3 full weekly burns in 8 days, 2 reset credits |
| 5 | pro11 | May 28 | 09-29 17:48 | 09-25 21:04 → 09-26 05:51 | 09-23 18:09 (M5 TUI `01a0cf7d`) | usage polls only; no refresh was due | heavy 09-21 to 09-23 (home ~8,000 + M5); idle 2.5 days |
| 6 | pro13 | Aug 16–17 | 09-29 17:48 | 09-26 22:24 → 09-27 20:54 | 09-23 21:52 (M5 TUI `01a0cf87`) | usage polls; the refresh at 20:54 failed on its first try | heavy 09-22 to 09-24; idle 3–4 days |
| 7 | lessons | Mar or older | 09-30 07:05 | 09-29 19:44 → 09-30 01:16 | 19:44 (Amir's TUI `01a0ef43`, 328 responses, 3%) | Amir's `cr` all-account checks at 17:33; investigation probe bursts at 17:40 and 17:46; studio nightly job at 01:16 found it already dead | 79% of its 09-19 → 09-26 week |
| 8 | pro17 | Aug 16–17 | 10-01 06:37 | 09-30 21:09 → 10-01 06:37 | 09-30 19:18 (M5 psagentspace thread `01a0f2ee`) | desktop app signed into it from 17:37 (M5 still ran the old `c`); last night's nightly jobs picked other accounts | quiet 09-25 to 09-29, then 09-30: laptop and amir-m3-36gb nightly jobs (02:16, 02:45) plus four M5 threads (~2,200 responses, 13% of week). Aug batch now 5 of 6 |

## Current thesis (v1, 2026-09-30)

OpenAI runs automated per-account decisions over a rolling window of recent activity and applies them in overnight runs. It treats the pool as one operator: the accounts are linked by shared IPs, one email domain, all-account usage checks, and conversations resumed across accounts.
- **Which account dies is probabilistic.** The banned accounts were mid-pack on load, while heavier accounts survive.
- **Young accounts are over-represented.**
- **The trigger is not what the account does that day**, and not one switch flipped by a single action.

**Confidence: medium.** The data is 7 bans. OpenAI never states a reason.

## Hypothesis scorecard

| Hypothesis | Status | Evidence |
|---|---|---|
| Rolling-window review with a 0–8 day lag, applied overnight | **Supported** | All 7 died 0–8 days after their hottest use; every window covers late-night hours (narrowest: 02:14–04:38 and 03:33–04:49) |
| Account age raises the odds | **Supported** | Aug batch: 5 of 6 banned (pro17 on 10-01); March-or-older: 2 of 17; Apr–May: 0 of 5; May 28 pair: 1 of 2 |
| Pure volume decides | **Rejected** (for 09-19 to 09-24) | Banned accounts ranked 11th, 14th, 15th by load; pro2 (29,693), pro8 (17,043) and 8 others heavier and alive; pro16 and pro17 matched pro13's load and are alive |
| Cross-account resume is the trigger | **Weak**; maybe a linking signal | All 7 had it, but so did at least 6 survivors (boss, pro4, pro7, pro8, pro9, pro16) |
| Hermes or third-party harness detection | **Weak** | Hermes has used nearly every account since March, but bans began in mid-September; banned accounts had tiny Hermes volume (89 and 53 calls in 2 weeks) |
| Banned when first reused, or at token refresh | **Rejected** | First requests after idle failed at once (already dead); pro11 died with no use and no refresh |
| Activity-triggered review: an account is scored, and banned if its recent history is bad, when it shows activity (usage polling counted until 09-29) | **Emerging** | Since polling stopped (09-29 ~18:50), both deaths (lessons, pro17) were accounts used the evening before after quiet days; quiet heavy accounts (pro9, coder, boss, pro1, coder2) are alive. Before that, pro11 and pro13 died while only polled |
| A script working through an old backlog from weeks ago | **Weakened** | The heaviest early-September accounts (pro1: 1,144 agents on 09-12; cfo: two burns on 09-14) are alive |

## Predictions to score on the next ban

| # | Prediction | How to score |
|---|---|---|
| P1 | pro16 and pro17 are the most at risk | **Hit: pro17 banned 10-01.** pro16 is the last Aug account |
| P2 | If the window is about a week, bans thin out after about 10-01 to 10-03 for accounts quiet since 09-24 | A ban after 10-03 on an account quiet since 09-24 means a longer window, or pool-level enforcement |
| P3 | Bans keep landing overnight | Death-window bounds |
| P4 | Mop-up versus new behavior can be read off the watch list | See the rules under the watch list. Count nightly jobs too: they leave no rollouts, so pro17 looked quiet when it was not |
| P5 | Under activity-triggered review, a quiet account survives until it is used again | The next ban is an account used the day before; a ban on an account untouched since 09-25 (pro9, coder, boss, pro1, coder2) weakens this |

## Variables log

These are the changes that affect how a later ban should be read.

| When | Change |
|---|---|
| 09-18 | Rule: never continue a thread under another account with `aim codex resume`; `resume-fresh` is the default. **Gap:** `aim codex run -- exec resume <id>` still rotates. Claude sessions did it 44 times from 09-14 to 09-26; last seen 09-26. |
| ~09-24 | Codex volume fell about 98%: M5 went from about 40,000 responses a day to about 1,200; home stopped after 09-26. |
| 09-29 13:41 | Codex CLI 0.161 installed on M5. It checks the account at startup (`/wham/accounts/check`) and fails hard on a revoked token. |
| 09-29 ~17:40 and ~17:46 | Investigation probe bursts from M5 sent all 31 accounts' tokens to `/wham/accounts/check` and `/wham/usage`. A confounder for lessons. |
| 09-29 evening | Killed: paperclip-codex (studio, 41 days, failing refresh on pro10), Prime (laptop and studio), Codex Dock relay (home, disabled). |
| 09-29 ~18:47 | laptop: `aim hermes watch` cron removed (backup `~/.aimgr/backups/crontab-20260929T184737.txt`); `aim auth maintain` launchd job disabled. It had been retrying dead accounts about 1,100–1,250 times a day each. |
| 09-29 ~18:52 | studio: `aim hermes watch` LaunchDaemon booted out and disabled by Amir. This ended the 5-minute all-account polling and the Hermes rotation. |
| 09-30 ~17:55 | M5 only: AIM Codex runs moved to `~/.aimgr/codex-cli` (branch `codex-desktop-split`, not on `main`), so `c` no longer writes the desktop app's login. The old `c` had put pro17 in the desktop app at 17:37. |
| 10-01 ~06:00 | studio: the 7 Poker Skill Hermes gateways booted out and disabled, and their 13 cron jobs paused. The Camofox browser service and the Poker Skill `db_mcp` toolbox were turned off; Camofox was deleted. |
| 10-01 ~07:15 | studio: 9 idle Cratejoy Hermes gateways turned off (no human Slack message in 40+ days): arthur_sterling, boss, coder, designer, merch_bot, paid_media, pilot, seo, writer. |
| 10-01 ~07:20 | All five nightly disk cleanups moved off pooled ChatGPT accounts to DeepSeek (`codex exec -p dsflash`; on M5, routine provider `deepseek`). Studio's had failed with 401 on 09-30 and 10-01. |

**Still on pooled ChatGPT accounts as of 10-01:**
- M5 `chief-daily-maintenance` at 02:00.
- 3 Cratejoy Hermes agents on studio (buyer_experience_sentinel, support, zara) and their 13 cron jobs, pinned to the accounts they last held. Zara's sweep runs every 4 hours.
- AIM's all-account usage check on every `aim codex use` or `run`.

## Watch list: load per account (computed 2026-09-30)

These are Codex responses on M5 and home, attributed by weekly reset time. About 26% of the hot period could not be attributed, so pro11 is understated. Nightly jobs and Hermes on other hosts are not included.

| Account | Batch | 09-19 → 09-24 | 09-25 → 09-30 | Category |
|---|---|---:|---:|---|
| pro2 | Mar | 29,693 | 859 | mixed |
| pro8 | May | 17,043 | 106 | mixed |
| product_growth | Mar | 11,244 | 54 | mixed |
| pro10 | May 28 | 11,015 | 359 | mixed |
| pro5 | Mar | 10,506 | 76 | mixed |
| pro9 | May | 9,818 | 0 | **quiet since 09-25** |
| claudalyst | Apr | 8,548 | 555 | mixed |
| coder | Mar | 7,298 | 0 | **quiet since 09-25** |
| cfo | Mar | 7,161 | 302 | mixed |
| growth | Mar | 6,935 | 376 | mixed |
| pro11 | May 28 | 6,770+ | 0 | banned 09-26 |
| pro6 | May | 6,043 | 379 | mixed |
| pro17 | Aug | 5,078 | 0 | banned 10-01 (was used 09-30, after this table was computed) |
| lessons | Mar | 4,960 | 488 | banned 09-30 |
| pro13 | Aug | 4,951 | 0 | banned 09-27 |
| boss | Mar | 4,943 | 0 | **quiet since 09-25** |
| office | Mar | 4,919 | 357 | mixed |
| pro4 | Mar | 4,768 | 406 | mixed |
| pro1 | Mar | 4,717 | 0 | **quiet since 09-25** |
| pro16 | Aug | 4,527 | 492 | mixed (P1) |
| qa | Mar | 3,649 | 481 | mixed |
| illustrator | Mar | 3,275 | 168 | mixed |
| amir_personal | Mar | 2,969 | 241 | mixed |
| pro7 | May | 1,719 | 18 | mixed |
| pro3 | Mar | 436 | 183 | **mostly recent** |
| coder2 | Mar | 312 | 0 | quiet since 09-25 |

**Reading the next ban:**
- **Mop-up of old use:** it is a *quiet since 09-25* account (pro9, coder, boss, pro1, coder2). Check nightly-job selections first. The only traffic on those since then has been usage checks.
- **Recent use counts:** it is a *mostly recent* account (pro3).
- **Tells you nothing:** a *mixed* account.

## What OpenAI can see

1. **One operator behind many accounts:**
   - the same egress IP per machine;
   - one email domain (`fun.country`);
   - AIM's all-account usage check before each job (until 09-29 also every 5 minutes from studio and laptop);
   - conversation IDs continued under several accounts.
2. **Rotating to get past limits:** accounts burned to 100%, then work moved to another. The Terms of Use forbid circumventing "any rate limits or restrictions"; the Sign in with ChatGPT terms name "rotating accounts" and "Pooling … Authentication Tokens".
3. **One account on several hosts at once:** OpenAI's CI guide says not to share one `auth.json` across machines or concurrent jobs.
4. **Unattended patterns:** fixed nightly job times, the 3-minute "continue" nudger (894 sends, stopped 09-22), overnight `/goal` loops, and Hermes cron jobs.
5. **Identical request content across accounts:** working directory paths, `AGENTS.md`, the skills list, and the same nightly prompt files.

## Method notes and gaps

- **Attribution** uses each Codex response's `rate_limits` block: the 10080-minute window's `resets_at` is unique per account and week. Skip `limit_id` values other than `codex`. `base_model_inference` and `codex_bengalfox` slide with every request.
- **Mapping windows to accounts** needs a record of each account's reset time at that moment. `usage-samples.csv` exists only for 09-22 to 09-25 (M5); each host's `redis-cache.json` holds only the current window. Older windows stay unattributed unless an earlier doc recorded them.
- **Selection history in `local-state.json` is incomplete.** It misses switches by `aim codex run` and by routines. `~/.codex/state_5.sqlite` `threads.creator_account_id` is a better per-thread source.
- **Laptop maintainer logs** have no per-line timestamps, and cleanup trims them.
- **Nightly runs** use `--ephemeral`, so they leave no rollouts. Their run directories hold `events.jsonl`, `error.log` and `summary.json`.
