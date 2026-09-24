# Codex account deactivation audit: amir_elaguizy_fun_country (2026-09-16)

Account: `amir_elaguizy_fun_country` = ChatGPT login `amir.elaguizy@fun.country` (OpenAI account id `e108f5ee-9608-42d5-9f9c-7102234fdebd`, ChatGPT Pro). Identity evidence: the Sep 16 appeal was filed from that mailbox, the Opus watcher logged thread `01a08768` as running on that login on Sep 10, and it is Chrome profile 24 in the BrowserOS map. `amir@fun.country` (profile 35, the "Work" browser profile) is a different account and is not deactivated.
Redis health: `blocked / openai_account_deactivated`, marked 2026-09-16 06:23:37 CDT.
Also deactivated two days earlier: `pro12`, `pro14`, `pro15` (marked 2026-09-14 04:51:28 CDT).
All times are CDT (UTC-5) unless marked Z. Revision 10, 2026-09-16 10:55 CDT (D2 re-ranks by observed enforcement after Amir's objection to the browser-automation placement). Sections 1 to 12 are findings; the appendix holds the raw evidence.

## 1. Answer

**What was on the account at the ban:** only the missions orchestrator (Codex thread `01a09fa4`, psagentspace) and aimgr's background polling. Attribution is exact: every Codex response carries the account's weekly-reset timestamp in its `rate_limits` block, and all responses on this account in the final 26 hours belong to that thread and its subagents.

**The tender was not active on this account at the ban, and it did not consume this account's resets.** The Opus watcher (Prime `01a0892c`) made its last call at 09:49 Sep 15, sixteen hours before the deactivation window, and never rotated a pane onto this account. Its only two mentions of the account are from Sep 10 06:31Z to 06:32Z, when it observed the "learn screen" pane already on `amir.elaguizy@fun.country`, saw it hit the weekly limit, and quit that pane.

**Did the tender use reset credits at all? Yes, twice, on other accounts.** It sent 38 Enter/option-1 keystrokes to Codex panes (Sep 10: 19, Sep 11: 6, Sep 12: 5, Sep 13: 5, Sep 14: 3). Two of them line up with a reset-credit consumption: coder2 at 20:04 CDT Sep 12 (`herdr pane send-keys w0:p1 enter` on the "short deck" rustai pane, which it narrated: "short deck was blocked on a free rate-limit-reset prompt, accepted it (option 1)") and product_growth at 21:08 CDT Sep 12 (keystrokes on content/w1T:p1 and content/w1R:p1, the learn-screen panes; five in-flight subagents of `01a08768` went from 95% to 0%). From 20:04 Sep 12 its runbook told it to accept any "Use this reset?" prompt it saw. The other 18 resets observed from this Mac and the `home` box, including both on this account (Sep 12 05:43 and Sep 15 17:39), have no watcher keystroke and no other agent keystroke within six minutes (no Claude or Prime session sent Herdr keystrokes Sep 12 to 16). Codex only consumes a reset through the TUI picker plus a confirmation (no automatic path in 0.154), so those were pressed at the keyboard. Amir confirmed on 2026-09-16 that the two resets on this account (Sep 12 05:43 and Sep 15 17:39) were his. Full table in appendix A12.

**What this account looks like over eight days (section 4):** three full weekly burns and two limit resets.

| Window | Start (reset credit or first use) | Burned by | Result |
|---|---|---|---|
| W1 | Sep 7 20:24 CDT | home-screen orchestrator `01a08768` + `01a08783` (missions/lessons settlement work) | 100% by Sep 10 01:28 |
| W2 | Sep 12 05:43 CDT (reset credit consumed while W1 had 2.6 days left) | `01a09532` (Sep 12), then the missions orchestrator from Sep 14 23:49 | 90% by Sep 15 17:39 |
| W3 | Sep 15 17:39:51 CDT (reset credit consumed at 90%, mid-flight, no restart) | missions orchestrator | 100% by Sep 16 02:00; last response 02:14:37; deactivated by 04:38 |

The "account switches" reported in revision 1 were not switches. The same in-flight subagent threads show weekly used 90% at 22:39:54Z and 0% at 22:40:16Z with a new reset timestamp: a rate-limit reset credit was consumed on the same account (Codex endpoint `/api/codex/rate-limit-reset-credits/consume`, TUI prompt "Yes, use reset"). The same thing happened on cfo at Sep 14 13:30:20 (96% to 0%, same threads). The watcher's runbook auto-accepted "free rate-limit-reset" prompts (496 mentions) and was running during the Sep 12 05:43 reset; it was off during the Sep 15 17:39 reset, and no agent activity was found at that minute, so that one was most likely accepted at the keyboard.

**What the four deactivated accounts share:** all four are pool accounts rotated under running Codex sessions on the same machines; pro12, pro14 and pro15 were rotation targets of the watcher on Sep 12 to 14 and were reported "refresh token revoked" before they died; all four deactivations landed in the same 02:00 to 05:00 CDT clock window; pro14's final window carried only 258 responses (5%). This is account-level pattern detection, not content, and not one bad session.

**Puzzle generation:** ran, but not on the deactivated accounts. Most puzzle/mission families ran as `spawn_agent` children of interactive orchestrators; the scripted `codex exec` lanes that did run (puzzledb daily-refill on Sep 14, delegated Sol reviewers on Sep 14 and 15, see Part B section B8) were on lessons, pro17, pro4, office, qa, cfo, growth, pro7 and pro9, never on pro12, pro14, pro15 or this account. The biggest: 1,144 `evaluation_repair` agents on Sep 12 (5,180 responses, on pro1), the `cases*`/`daily_refill`/`run*_strategy_owner` pipeline on pro6, pro16, boss, the ten `*_author` agents on Sep 15 on illustrator, and the `missions_*` work on this account. Puzzle generation touched fun_country only through the missions orchestrator's `missions_*_puzzle` family (659 responses).

**Browser automation:** real and heavy (226, 136, 163, 84 chatgpt.com browser calls per day Sep 12 to 15), but it ran under `amir@fun.country` and `pro4`, neither of which was deactivated, and no browser reads under the pro12/pro14/pro15/amir.elaguizy logins were found. Amir's objection stands; this is not the trigger.

## 2. Timeline

| Time (CDT) | Event | Source |
|---|---|---|
| Sep 7 20:24 | fun_country W1 begins (first use after prior reset) | rollout fingerprints (reset Sep 15 01:24:30Z) |
| Sep 8 to Sep 10 01:28 | W1 burned 2% to 100% by `01a08768` (home screen / missions settlement) and `01a08783` | rollouts |
| Sep 10 01:31 | Watcher notes "learn screen (content/w1R:p1) hit a usage limit on amir.elaguizy@fun.country", quits the pane | Prime 01a0892c |
| Sep 10 to 12 | Watcher: ~2,000 sweeps/day, 815 to 965 "at capacity" sightings/day, rotates panes onto boss, claudalyst, coder2, pro1, pro11, pro17, pro9, office, pro12, pro14, pro15, pro2, pro5 | Prime 01a0892c |
| Sep 11 to 12 | Watcher notes "refresh token revoked" on coder2, pro14, boss | Prime 01a0892c |
| Sep 12 05:43:48 | fun_country W2 begins: reset credit consumed (W1 still had 2.6 days) while `01a09532` ran; watcher active | fingerprints, watcher call counts |
| Sep 13 22:03 | Last successful Codex response on pro12 (M5) | fingerprints |
| Sep 14 03:33 | Last successful Codex response on pro15 (M5, SNG orchestrator) | fingerprints |
| Sep 14 04:49 to 04:54 | `home` box: 14 `aim codex run/resume` launches in 5 min, flip-flopping pro15/pro14, then lessons/pro17; watcher's last "continue" 04:49 | home history, watcher |
| Sep 14 04:51:28 | pro12, pro14, pro15 marked `openai_account_deactivated` | Redis |
| Sep 14 06:19 | Missions orchestrator `01a09fa4` created via `aim codex run` (cfo) | state_5.sqlite, history |
| Sep 14 06:21 to 13:30 | Orchestrator burns cfo 29% to 96% (cfo window that began Sep 13 20:17) | fingerprints |
| Sep 14 13:30:20 | cfo reset credit consumed mid-flight (96% to 0%); orchestrator burns cfo 0% to 100% by 23:48 | fingerprints |
| Sep 14 23:49 | Orchestrator resumed; now on fun_country W2 at 36% | transcript, fingerprints |
| Sep 15 11:33 | auth.json on M5 set to illustrator; no selections until Sep 16 05:56 | history |
| Sep 15 12:45 | Amir: "pick the next most fundamental P1 issue(s)... $issue-to-pr... delegate as much as possible to sol agents even testing" | transcript |
| Sep 15 09:49 | Watcher's last call | Prime 01a0892c |
| Sep 15 17:39:51 | fun_country W3 begins: reset credit consumed at 90%, in-flight threads continue | fingerprints |
| Sep 15 17:39 to Sep 16 02:14 | 8,961 responses; 2% at 18:00, 32% at 20:00, 72% at 22:00, 89% at 00:00, 99% at 02:00 | fingerprints |
| Sep 16 01:16 | Studio hermes-watch sees 95%+, moves its two Hermes homes off the account | studio log |
| Sep 16 02:14:37 | Last successful response (100%) | fingerprints |
| 02:14 to 04:38 | Deactivation (Amir's notice: 03:45) | bounded |
| Sep 16 04:38:33 | Orchestrator host process (pid 58601) fails every rate-limit read (292 failures) until relaunch 05:05 | logs_2.sqlite |
| Sep 16 05:08 | Amir starts a new capacity watcher (Claude, coder home) for the dynamic-missions space | Claude session 95c5e6ba |
| Sep 16 06:04 to 06:27 | Five `aim codex use` runs see the account at 100% | history |
| Sep 16 06:23:37 | Redis record set to `openai_account_deactivated` | Redis |

Deactivation windows (last success to first failure): pro12 22:03 Sep 13 to 04:51 Sep 14; pro15 03:33 to 04:49 Sep 14; pro14 unknown to 04:51 Sep 14; fun_country 02:14 to 04:38 Sep 16.

## 3. The final burn (W3) in detail

| | |
|---|---|
| Responses | 8,961 (peak 1,516 per hour, 47 in one minute) |
| Threads | orchestrator (gpt-6-astra xhigh) + 22 subagents (gpt-5.6-sol high) |
| Concurrency | 3 to 6 threads responding in the same minute for 431 of 511 minutes; max 8 |
| Input tokens | 1,195,815,104 (1,169,243,008 cached) |
| Uncached input / output | 26,572,096 / 3,499,304 |
| Tool use | code-mode `exec` (4,022 over its life), BrowserOS to Google Sheets, GitHub, Buildkite, Slack, chatgpt.com |
| After 100% | one `usage_limit_exceeded` at 02:14:36; no retry storm (six 429-tagged log rows 02:13 to 02:18, then silence until the 04:38 rate-limit failures) |

The previous night (cfo, W2 of cfo) had the same shape: 4,602 responses, 0% to 100% in 10.3 hours, 1 to 5 concurrent threads. cfo is still `ready`.

## 4. This account across the eight days

See appendix A2 for the hourly tables. Totals: W1 3,324 responses (12 threads), W2 9,087 responses (51 threads), W3 8,966 responses (23 threads). Two reset credits consumed; one remains (`resetCreditsAvailable: 1`).

## 5. The three accounts deactivated on Sep 14

| Account | Codex responses Sep 12 to 14 (M5 + home) | Used | Last success | What | Watcher rotated onto it | resets left |
|---|---|---|---|---|---|---|
| pro12 | 842 | 0% to 14% | Sep 13 22:03 | "sol agents audit our app for dead experiments", SNG orchestrator | Sep 12 (9 mentions), Sep 13 | 2 |
| pro14 | 258 (final window; 4,807 in the window before it) | 1% to 5% | Sep 14 08:14 (home, rustai) | rustai `01a0931b` on home; `01a08204` on M5 | Sep 10 (5, subgame solver), Sep 12 (4), Sep 14 (6); "refresh token revoked" Sep 11 | 1 |
| pro15 | 1,819 | 0% to 12% | Sep 14 03:33 | SNG orchestrator `01a091fb` (sng_system_*) | Sep 12 (4); "worked, then saturated" Sep 14 | 0 |

No puzzle or lesson drafting on any of them. The studio Hermes fleet held all three at times on Sep 10 to 12 (appendix A8).

## 6. The Opus capacity watcher (Prime 01a0892c)

Prompt (Sep 9): "set a timeout every 5 minutes, check the API tracking herdr space, and if it says Selected model is at capacity send the command continue... also watch learn screen and planning tracking". From its transcript:

- Calls per day (ipython): Sep 10 2,014; Sep 11 1,871; Sep 12 2,000; Sep 13 574; Sep 14 342; Sep 15 202 (last call 09:49 CDT Sep 15). "at capacity" sightings: 815, 835, 965, 262, 145, 91.
- Watched panes: rustai/wG:p4, rustai/wZ:p1, rustai/w0:p1, rustai/wK:p3 (`home` box), bugs/w6P:p1, bugs/w82:p1, bugs/w86:p1, bugs/w7W:p1, content/w1Q:p1, content/w1T:p1, content/w1G:p2, growth/w8A:p1.
- Its procedure: "Procedure for a capacity/usage-limit event... allow up to TWO cr attempts in a single sweep"; "A free rate-limit-reset prompt ('Use this reset?' / 'Press enter to confirm') is not capacity: accept option 1 with send-keys" (496 mentions); "short deck accepted a free rate-limit-reset prompt (enter)".
- Accounts it reports landing on: Sep 10 boss, claudalyst, coder2, pro1, pro11, pro17, pro9; Sep 12 office (15), pro12 (9), pro14 (4), pro15 (4), pro11, pro17, pro2, pro5; Sep 13 coder (11), coder2, pro1, pro12, pro8, productgrowth; Sep 14 boss (7), pro14 (6), pro11, pro13, claudalyst, coder, illustrator, lessons; Sep 15 lessons (5), pro9 (5), growth, marcus.
- Its notes: "pro14, pro15, pro11: resume fails with 'Your access token could not be refreshed because your refresh token was revoked'"; "Known dead accounts: pro13, pro14, coder2. pro12 is currently the only account that reliably resumes"; "Rotation history tonight: boss (FAILED, refresh token revoked) -> pro15 (worked) -> pro14 (worked, then saturated one sweep later) -> office (current)".
- Mentions of this account: two, both Sep 10 06:31Z to 06:32Z (observed, then `/status` and `/quit`). It never rotated onto it.
- Keystrokes: 38 `send-keys ... enter` calls over its life. Two match reset-credit consumptions (coder2 Sep 13 01:04:28Z, product_growth Sep 13 02:08:26Z and 02:08:40Z). None match the resets on this account.

## 7. Browser automation against ChatGPT web (not the trigger)

Profile map (from a Sep 13 session): 1 pro6, 2 pro7, 4 pro8, 5 pro9, 6 fleet, 7 pro1, 8 pro10, 9 pro11, 10 boss, 11 coder, 12 coder2, 13 growth, 14 lessons, 15 pro3, 16 pro4, 17 pro5, 18 cfo, 19 office, 20 pro2, 21 product_growth, 22 illustrator, 23 qa, 24 amir.elaguizy@fun.country, 25 claudalyst, 26 amir@cratejoy, 28 aelaguiz@gmail.com, 29 pro12, 30 pro13, 31 pro14, 32 pro15, 33 pro16, 34 pro17, 35 amir@fun.country.

| Day | chatgpt.com browser calls (M5 Codex) | Distinct conversations | Logins visible in page reads |
|---|---|---|---|
| Sep 12 | 226 | 132 | amir@fun.country 116, pro4 101 |
| Sep 13 | 136 | 80 | amir@fun.country 58, pro4 49 |
| Sep 14 | 163 (113 from the missions orchestrator) | 75 | amir@fun.country 55, pro4 17 |
| Sep 15 | 84 | 33 | amir@fun.country 79 |
| Sep 16 | 21 | 30 | amir@fun.country 8 |

The `home` box added 480 such lines on Sep 12 (amir@fun.country 136). Reads showing `amir.elaguizy@fun.country` are all profile-map dumps, not ChatGPT pages. No reads under pro12, pro14 or pro15 on M5 Sep 8 to 14. The missions orchestrator's Pro consultations ran under `profile: 'Work (explicit Amir exception)'` = amir@fun.country.

## 8. aimgr-side signals

- `aim codex use` probes usage for all ~30 accounts per run; `home` ran 14 in 5 minutes on Sep 14, M5 8 in 31 minutes on Sep 16, the studio hermes-watch one every 5 minutes.
- M3 auth-maintainer: repeated `retryable reason=maintenance_failed` on amir_personal (24,856 lines), pro4 (5,722), qa (4,756), cfo (3,860).
- The same account drained from two machines at once (`home` and M5 fingerprints overlap for cfo, illustrator and the window that started Sep 14 01:17Z).
- Pinned processes whose account was refreshed elsewhere keep sending a dead token: 401 "invalidated oauth token" storms on Sep 13 (238), Sep 14 (303), Sep 15 (154), Sep 16 (64).

## 9. Content review

Term scan of the 382 MB orchestrator transcript: zero hits for exploit, vulnerability, jailbreak, malware, phishing, brute force, sqlmap, metasploit, reverse shell, keylogger, chemical, nuclear, explosive. Hits that exist are benign (browser-skill rules, base64 image data, the repo's own "play-money teaching toy, not a gambling platform" doctrine, policy text about never storing credentials). The work is a Flutter app feature, Google Sheets, GitHub issues and PRs.

## 10. Not involved (checked)

- Batch puzzle lanes (`codex exec`) on the deactivated accounts: none. Lanes that ran are inventoried in Part B section B8.
- Scheduled routines: daily-disk-cleanup on pro17 / boss / boss; daily-sheet-maintainer on office / lessons / pro7 (appendix A9).
- Hermes: assigned this account continuously but zero sessions in W3 on the assigned studio homes; fleet total since Sep 10 is 23.6M input / 372M cache-read / 1.9M output tokens across 21 homes.
- Prime (Codex binding illustrator), Pi (no Codex), Codex Desktop (amir_cratejoy_personal), studio `~/.codex` (idle since Aug).
- `amir-m3-36gb`: unreachable (ssh timeout); not checked.

## 11. Open items

1. Who accepted the Sep 15 17:39:51 reset on this account (no agent activity found at that minute; watcher off).
2. Exact deactivation time: between 02:14:37 and 04:38:33 CDT.
3. Whether the "refresh token revoked" errors the watcher saw on Sep 11 to 14 were OpenAI revocations or aimgr's own refresh-token rotation racing harness leases.
4. `amir-m3-36gb` was never reachable.

## 12. What to change

1. Retire automatic cross-account rotation on limit events (the watcher's `cr` procedure and any resume-retry loop); when an account is capped, wait.
2. Stop consuming reset credits on accounts that are still being driven by a running orchestrator; a reset followed by 100% in eight hours, twice, is the most distinctive thing this account did. Twenty resets were consumed across the pool in four days (A12); two by the watcher, the rest at the keyboard.
3. Take `amir_*` labels out of the pool (`pool.enabled=false`).
4. Cap per-account burn per session; do not drain one account from two machines at once.
5. For the appeal: "Codex CLI on my own repo with parallel sub-agents" is true for the last night; the account also had two limit resets and sat in a rotated pool. Decide what to disclose before writing it; do not claim there was no automation.

---

# Appendix: raw evidence

Method for account attribution: every Codex `token_count` event in `~/.codex/sessions/**.jsonl` carries `rate_limits.{primary|secondary}` with `window_minutes` and `resets_at`. The 10080-minute window's `resets_at` is stable per (account, weekly window) and changes only when the window expires or a reset credit is consumed. Rows with `limit_id = codex_bengalfox` are a separate limit bucket whose `resets_at` slides with every request; they are excluded. Labels come from `aim status --json` weekly `resetAt` values (exact match within 10 s); windows that have since been replaced show `?`.

## A1. Pool state at 06:35 CDT Sep 16

| label | health | resets left | weekly used | weekly reset (UTC) |
|---|---|---|---|---|
| amir_elaguizy_fun_country | blocked (openai_account_deactivated, 2026-09-16T11:23:37Z) | 1 | 100% | 2026-09-22 22:39:51 |
| pro12 | blocked (openai_account_deactivated, 2026-09-14T09:51:28Z) | 2 | 14% | 2026-09-19 09:01:07 |
| pro14 | blocked (openai_account_deactivated, 2026-09-14T09:51:28Z) | 1 | 1% | 2026-09-19 13:47:06 |
| pro15 | blocked (openai_account_deactivated, 2026-09-14T09:51:28Z) | 0 | 0% | 2026-09-20 13:30:57 |
| amir_cratejoy_personal | candidate (credential_missing; codex_desktop_reserved) | | | |
| amir_personal | ready | 0 | 100% | 2026-09-20 11:49:56 |
| boss | ready | 0 | 20% | 2026-09-21 20:45:21 |
| cfo | ready | 1 | 100% | 2026-09-21 18:30:24 |
| claudalyst | ready | 0 | 100% | 2026-09-19 10:35:58 |
| coder | ready | 3 | 100% | 2026-09-19 11:20:00 |
| coder2 | ready | 0 | 100% | 2026-09-20 01:05:09 |
| growth | ready | 3 | 77% | 2026-09-19 11:20:48 |
| illustrator | ready | 1 | 100% | 2026-09-22 16:33:03 |
| lessons | ready | 0 | 29% | 2026-09-19 13:35:35 |
| office | ready | 1 | 47% | 2026-09-19 10:00:38 |
| pro1 | ready | 1 | 100% | 2026-09-19 08:10:10 |
| pro2 | ready | 2 | 100% | 2026-09-19 14:04:14 |
| pro3 | ready | 2 | 35% | 2026-09-22 12:39:23 |
| pro4 | ready | 3 | 25% | 2026-09-19 17:13:50 |
| pro5 | ready | 2 | 100% | 2026-09-19 17:22:20 |
| pro6 | ready | 1 | 100% | 2026-09-19 17:39:36 |
| pro7 | ready | 3 | 14% | 2026-09-19 18:52:53 |
| pro8 | ready | 0 | 100% | 2026-09-19 21:08:26 |
| pro9 | ready | 0 | 54% | 2026-09-22 22:57:26 |
| pro10 | ready | 0 | 100% | 2026-09-19 13:46:06 |
| pro11 | ready | 1 | 18% | 2026-09-22 16:44:27 |
| pro13 | ready | 3 | 32% | 2026-09-19 10:33:13 |
| pro16 | ready | 0 | 100% | 2026-09-19 13:55:48 |
| pro17 | ready | 0 | 15% | 2026-09-19 10:56:40 |
| product_growth | ready | 2 | 100% | 2026-09-20 02:08:31 |
| qa | ready | 1 | 21% | 2026-09-19 13:00:42 |

## A2. amir_elaguizy_fun_country: the three weekly windows (M5 rollouts)

**W1** weekly reset 2026-09-15T01:24:30+00:00 (window start 2026-09-08T01:24:30+00:00): responses 3,324; used 2% to 100%; first 2026-09-08T14:06:27.695Z; last 2026-09-10T06:28:55.272Z; uncached input 9,017,731; cached input 414,840,448; output 1,406,708; threads 12

per day: 2026-09-08: 118, 2026-09-09: 431, 2026-09-10: 2775

roots: 01a08768-d214: 2732, 01a08783-1174: 474, 01a08157-155e: 89, 01a082bd-ace1: 29

| hour (UTC) | responses | used % |
|---|---|---|
| 2026-09-08T14Z | 89 | 2 to 3 |
| 2026-09-08T20Z | 29 | 14 to 15 |
| 2026-09-09T18Z | 13 | 40 to 40 |
| 2026-09-09T19Z | 48 | 40 to 42 |
| 2026-09-09T20Z | 174 | 42 to 45 |
| 2026-09-09T21Z | 66 | 45 to 46 |
| 2026-09-09T22Z | 63 | 46 to 47 |
| 2026-09-09T23Z | 67 | 47 to 49 |
| 2026-09-10T00Z | 43 | 49 to 50 |
| 2026-09-10T03Z | 580 | 51 to 60 |
| 2026-09-10T04Z | 879 | 60 to 76 |
| 2026-09-10T05Z | 1057 | 76 to 94 |
| 2026-09-10T06Z | 216 | 94 to 100 |

**W2** weekly reset 2026-09-19T10:43:48+00:00 (window start 2026-09-12T10:43:48+00:00): responses 9,087; used 0% to 90%; first 2026-09-12T10:43:51.042Z; last 2026-09-15T22:40:16.014Z; uncached input 32,411,878; cached input 1,150,453,632; output 3,821,384; threads 51

per day: 2026-09-12: 688, 2026-09-13: 59, 2026-09-14: 465, 2026-09-15: 7875

roots: 01a09fa4-6248: 7875, 01a09532-1d68: 688, 01a09dbf-7109: 390, 01a09fa2-4aaf: 75, 01a09a87-2cca: 59

families: ROOT: 3386, issue#_implementation: 1825, issue#_flutter: 799, issue#_app_evidence: 530, audit#_r#: 423, issue#_delivery_finish: 304, issue#_outcomes: 198, missions_#_ui: 186, issue#_outcomes_finish: 185, missions_#_puzzle: 173, missions_next_triage: 119, missions_consolidate: 109, clarity_implementation: 105, missions_consolidation_tracking: 104

| hour (UTC) | hour (CDT) | responses | used % | threads | uncached in | out |
|---|---|---|---|---|---|---|
| 2026-09-12T10Z | 09-12 05:00 | 49 | 0 to 2 | 1 | 271,220 | 32,996 |
| 2026-09-12T11Z | 09-12 06:00 | 151 | 2 to 8 | 1 | 637,309 | 104,179 |
| 2026-09-12T12Z | 09-12 07:00 | 133 | 8 to 13 | 1 | 358,497 | 91,825 |
| 2026-09-12T13Z | 09-12 08:00 | 34 | 13 to 14 | 1 | 297,553 | 13,367 |
| 2026-09-12T14Z | 09-12 09:00 | 195 | 15 to 21 | 1 | 532,085 | 64,410 |
| 2026-09-12T15Z | 09-12 10:00 | 40 | 21 to 22 | 1 | 302,385 | 23,304 |
| 2026-09-12T16Z | 09-12 11:00 | 71 | 22 to 25 | 1 | 668,802 | 34,936 |
| 2026-09-12T17Z | 09-12 12:00 | 15 | 25 to 25 | 1 | 40,178 | 16,856 |
| 2026-09-13T11Z | 09-13 06:00 | 42 | 25 to 26 | 1 | 254,456 | 40,446 |
| 2026-09-13T12Z | 09-13 07:00 | 17 | 26 to 26 | 1 | 61,083 | 7,397 |
| 2026-09-14T11Z | 09-14 06:00 | 101 | 26 to 28 | 2 | 492,334 | 27,849 |
| 2026-09-14T12Z | 09-14 07:00 | 243 | 28 to 34 | 2 | 373,831 | 76,524 |
| 2026-09-14T13Z | 09-14 08:00 | 119 | 34 to 36 | 2 | 959,229 | 73,065 |
| 2026-09-14T14Z | 09-14 09:00 | 2 | 36 to 36 | 1 | 3,346 | 2,550 |
| 2026-09-15T04Z | 09-14 23:00 | 87 | 36 to 37 | 3 | 508,806 | 47,934 |
| 2026-09-15T05Z | 09-15 00:00 | 548 | 37 to 40 | 3 | 1,981,396 | 207,739 |
| 2026-09-15T06Z | 09-15 01:00 | 420 | 40 to 43 | 7 | 1,753,304 | 209,290 |
| 2026-09-15T10Z | 09-15 05:00 | 670 | 43 to 46 | 7 | 2,267,834 | 307,991 |
| 2026-09-15T11Z | 09-15 06:00 | 939 | 46 to 51 | 6 | 2,194,339 | 325,948 |
| 2026-09-15T12Z | 09-15 07:00 | 720 | 51 to 56 | 6 | 1,871,119 | 258,309 |
| 2026-09-15T13Z | 09-15 08:00 | 407 | 56 to 58 | 4 | 866,271 | 145,572 |
| 2026-09-15T14Z | 09-15 09:00 | 294 | 58 to 60 | 4 | 808,485 | 126,975 |
| 2026-09-15T15Z | 09-15 10:00 | 556 | 60 to 64 | 6 | 2,102,596 | 231,763 |
| 2026-09-15T16Z | 09-15 11:00 | 795 | 64 to 69 | 20 | 4,172,569 | 381,592 |
| 2026-09-15T17Z | 09-15 12:00 | 215 | 69 to 71 | 4 | 969,657 | 100,118 |
| 2026-09-15T18Z | 09-15 13:00 | 500 | 71 to 74 | 3 | 1,588,466 | 193,148 |
| 2026-09-15T19Z | 09-15 14:00 | 355 | 74 to 76 | 3 | 1,237,250 | 123,599 |
| 2026-09-15T20Z | 09-15 15:00 | 354 | 76 to 79 | 5 | 1,518,210 | 144,999 |
| 2026-09-15T21Z | 09-15 16:00 | 504 | 79 to 82 | 5 | 1,760,876 | 235,792 |
| 2026-09-15T22Z | 09-15 17:00 | 511 | 82 to 90 | 4 | 1,558,392 | 170,911 |

**W3** weekly reset 2026-09-22T22:39:51+00:00 (window start 2026-09-15T22:39:51+00:00): responses 8,961; used 0% to 100%; first 2026-09-15T22:39:57.382Z; last 2026-09-16T07:14:37.658Z; uncached input 26,572,096; cached input 1,169,243,008; output 3,499,304; threads 23

per day: 2026-09-15: 1237, 2026-09-16: 7724

roots: 01a09fa4-6248: 8961

families: ROOT: 1734, missions_final_journeys: 1107, missions_#_lifecycle: 891, missions_#_journey_audit: 621, missions_#_ui: 608, issue#_flutter: 575, issue#_outcomes_finish: 565, issue#_delivery_finish: 498, missions_#_puzzle: 486, missions_#_adaptive: 439, missions_#_final_audit: 362, missions_batch_#_#_#_audit: 202, missions_client_reaudit: 170, missions_native_reaudit: 164

| hour (UTC) | hour (CDT) | responses | used % | threads | uncached in | out |
|---|---|---|---|---|---|---|
| 2026-09-15T22Z | 09-15 17:00 | 176 | 0 to 2 | 3 | 396,465 | 57,976 |
| 2026-09-15T23Z | 09-15 18:00 | 1061 | 2 to 16 | 5 | 2,864,080 | 373,444 |
| 2026-09-16T00Z | 09-15 19:00 | 966 | 16 to 32 | 10 | 3,075,341 | 436,150 |
| 2026-09-16T01Z | 09-15 20:00 | 1495 | 31 to 52 | 8 | 4,319,385 | 572,540 |
| 2026-09-16T02Z | 09-15 21:00 | 1538 | 52 to 72 | 9 | 6,028,117 | 682,310 |
| 2026-09-16T03Z | 09-15 22:00 | 1275 | 72 to 83 | 10 | 4,502,796 | 530,397 |
| 2026-09-16T04Z | 09-15 23:00 | 686 | 83 to 89 | 7 | 1,506,842 | 228,290 |
| 2026-09-16T05Z | 09-16 00:00 | 662 | 89 to 94 | 6 | 1,809,573 | 262,883 |
| 2026-09-16T06Z | 09-16 01:00 | 897 | 94 to 99 | 6 | 1,704,975 | 289,281 |
| 2026-09-16T07Z | 09-16 02:00 | 205 | 99 to 100 | 4 | 364,522 | 66,033 |

## A3. Every weekly window seen from M5, Sep 8 to 16 (limit_id = codex, 20+ responses)

Windows whose start is less than 7 days after the previous window of the same account, while that account was still in use, are reset-credit consumptions. Confirmed in-flight resets: fun_country Sep 15 22:39:51Z (threads 01a0a71e-5d5d and 01a0a71e-2c58: 90% at 22:39:54Z, 0% at 22:40:16Z), cfo Sep 14 18:30:20Z (threads 01a0a121, 01a0a12c, 01a09fa4: 96% at 18:30:35Z, 0% at 18:30:44Z), fun_country Sep 12 10:43:48Z (W1 had 2.6 days left).

| window start (UTC) | weekly reset (UTC) | label (current map) | responses | used % | first -> last response (UTC) | per day | uncached in | cached in | out | top roots |
|---|---|---|---|---|---|---|---|---|---|---|
| 09-08 06:09:35 | 09-15 06:09:35 | ? | 8419 | 0 to 96 | 09-08T06:09 -> 09-09T19:10 | 09-08:1278 09-09:7141 | 24,837,362 | 1,104,110,336 | 3,232,650 | 01a082fd-81a5:8042 01a08157-6938:310 |
| 09-08 01:21:47 | 09-15 01:21:47 | ? | 618 | 27 to 92 | 09-08T06:16 -> 09-08T23:24 | 09-08:618 | 2,193,763 | 79,393,664 | 341,260 | 01a080e9-185b:356 01a07367-ea95:216 |
| 09-08 01:25:09 | 09-15 01:25:09 | ? | 3283 | 38 to 100 | 09-08T10:08 -> 09-08T20:36 | 09-08:3283 | 10,717,208 | 392,299,776 | 1,589,087 | 01a07e2d-ce47:2088 01a080e5-753a:1195 |
| 09-08 01:33:41 | 09-15 01:33:41 | ? | 5570 | 4 to 100 | 09-08T11:11 -> 09-10T10:58 | 09-08:1233 09-09:353 09-10:3984 | 18,442,987 | 693,649,792 | 2,849,792 | 01a08719-fa5a:3857 01a06dd9-e9b4:775 |
| 09-08 01:48:59 | 09-15 01:48:59 | ? | 7124 | 0 to 95 | 09-08T11:12 -> 09-09T17:02 | 09-08:357 09-09:6767 | 24,367,512 | 902,058,496 | 3,415,306 | 01a08324-7cc3:6957 01a080b7-9573:167 |
| 09-08 11:14:30 | 09-15 11:14:30 | ? | 96 | 0 to 32 | 09-08T11:14 -> 09-09T00:38 | 09-08:86 09-09:10 | 380,940 | 11,208,320 | 29,258 | 01a080b9-d172:86 01a08398-2ace:10 |
| 09-08 01:22:02 | 09-15 01:22:02 | ? | 9122 | 1 to 100 | 09-08T11:15 -> 09-10T20:21 | 09-08:802 09-09:3489 09-10:4831 | 26,882,377 | 1,149,625,088 | 3,735,379 | 01a07bb4-56b4:3489 01a0863d-ec39:2556 |
| 09-08 11:15:42 | 09-15 11:15:42 | ? | 2465 | 0 to 45 | 09-08T11:15 -> 09-12T05:53 | 09-08:602 09-10:68 09-11:38 09-12:1757 | 7,157,758 | 299,360,384 | 496,980 | 01a09341-5d4a:1757 01a080bb-0f1f:602 |
| 09-08 11:16:00 | 09-15 11:16:00 | ? | 2081 | 0 to 100 | 09-08T11:16 -> 09-10T09:47 | 09-08:580 09-10:1501 | 6,983,681 | 280,003,584 | 899,074 | 01a0863d-ec39:1501 01a080bb-53d0:580 |
| 09-08 11:26:53 | 09-15 11:26:53 | ? | 1058 | 0 to 74 | 09-08T11:27 -> 09-12T02:32 | 09-08:445 09-09:145 09-10:304 09-11:99 09-12:65 | 5,137,855 | 135,312,640 | 350,122 | 01a080c4-8d59:401 01a08ce5-ba27:276 |
| 09-08 11:29:23 | 09-15 11:29:23 | ? | 4150 | 0 to 100 | 09-08T11:29 -> 09-12T00:45 | 09-08:503 09-10:2029 09-11:1497 09-12:121 | 17,618,822 | 547,876,352 | 2,298,071 | 01a09080-b08b:1128 01a08b5e-4bb6:937 |
| 09-08 11:39:06 | 09-15 11:39:06 | ? | 4238 | 0 to 96 | 09-08T11:39 -> 09-10T23:33 | 09-08:515 09-09:2230 09-10:1493 | 20,108,675 | 518,538,496 | 2,104,855 | 01a08204-90bb:2102 01a08849-4ca2:1477 |
| 09-08 11:43:10 | 09-15 11:43:10 | ? | 4160 | 0 to 92 | 09-08T11:43 -> 09-11T20:47 | 09-08:522 09-10:221 09-11:3417 | 13,716,961 | 513,584,512 | 1,549,797 | 01a08768-d214:1914 01a07ea1-a586:1142 |
| 09-08 12:02:38 | 09-15 12:02:38 | ? | 3502 | 0 to 59 | 09-08T12:02 -> 09-12T06:21 | 09-08:177 09-10:324 09-11:2421 09-12:580 | 14,939,859 | 416,334,464 | 1,021,840 | 01a08204-90bb:2169 01a08b69-6882:523 |
| 09-08 10:05:18 | 09-15 10:05:18 | ? | 10079 | 1 to 100 | 09-08T12:03 -> 09-11T05:46 | 09-08:1162 09-10:2193 09-11:6724 | 33,683,796 | 1,287,320,960 | 4,894,830 | 01a08719-fa5a:5054 01a087c1-7400:3741 |
| 09-08 01:30:46 | 09-15 01:30:46 | ? | 6433 | 0 to 100 | 09-08T12:03 -> 09-11T06:43 | 09-08:525 09-10:2447 09-11:3461 | 22,649,078 | 807,382,656 | 3,336,395 | 01a08768-d214:3461 01a0713d-631e:995 |
| 09-08 01:25:50 | 09-15 01:25:50 | ? | 12474 | 6 to 100 | 09-08T12:06 -> 09-12T04:20 | 09-08:2833 09-09:3200 09-10:2449 09-11:2114 09-12:1878 | 39,778,324 | 1,591,913,472 | 5,244,847 | 01a08300-bf72:4095 01a08719-fa5a:2414 |
| 09-08 01:28:55 | 09-15 01:28:55 | ? | 11350 | 5 to 100 | 09-08T12:53 -> 09-10T07:35 | 09-08:205 09-09:6259 09-10:4886 | 29,459,345 | 1,478,653,696 | 5,193,696 | 01a0863d-ec39:8577 01a087c1-7400:1391 |
| 09-08 13:54:38 | 09-15 13:54:38 | ? | 6234 | 0 to 100 | 09-08T13:54 -> 09-10T03:24 | 09-08:196 09-09:2737 09-10:3301 | 17,092,927 | 799,285,248 | 2,385,573 | 01a08768-d214:4593 01a08204-90bb:1003 |
| 09-08 01:56:35 | 09-15 01:56:35 | ? | 3951 | 0 to 100 | 09-08T14:06 -> 09-10T06:05 | 09-08:1319 09-09:26 09-10:2606 | 15,253,689 | 479,248,128 | 1,710,645 | 01a08204-90bb:2606 01a08156-ba28:1179 |
| 09-08 01:24:30 | 09-15 01:24:30 | ? | 3324 | 2 to 100 | 09-08T14:06 -> 09-10T06:28 | 09-08:118 09-09:431 09-10:2775 | 9,017,731 | 414,840,448 | 1,406,708 | 01a08768-d214:2732 01a08783-1174:474 |
| 09-08 11:00:34 | 09-15 11:00:34 | ? | 3418 | 6 to 56 | 09-08T14:39 -> 09-12T02:24 | 09-08:751 09-09:1604 09-10:133 09-11:678 09-12:252 | 11,615,106 | 415,294,976 | 832,893 | 01a082ff-d697:2128 01a0908d-1dd7:552 |
| 09-08 12:04:19 | 09-15 12:04:19 | ? | 5701 | 8 to 95 | 09-08T17:16 -> 09-09T00:33 | 09-08:5468 09-09:233 | 25,811,865 | 677,717,632 | 2,851,193 | 01a08204-90bb:4006 01a06dd9-e9b4:1695 |
| 09-08 21:32:50 | 09-15 21:32:50 | ? | 4496 | 0 to 92 | 09-08T21:35 -> 09-11T18:18 | 09-08:209 09-10:630 09-11:3657 | 15,068,909 | 587,451,904 | 2,328,003 | 01a0863d-ec39:1843 01a087c1-7400:1171 |
| 09-09 12:08:35 | 09-16 12:08:35 | ? | 4746 | 0 to 59 | 09-09T12:08 -> 09-12T02:26 | 09-09:587 09-10:114 09-11:3410 09-12:635 | 15,521,587 | 603,877,632 | 2,045,110 | 01a0908c-1cb9:1975 01a08768-d214:1110 |
| 09-09 12:12:58 | 09-16 12:12:58 | ? | 6181 | 0 to 61 | 09-09T12:13 -> 09-12T02:23 | 09-09:2363 09-10:1259 09-11:1325 09-12:1234 | 20,400,345 | 777,725,696 | 1,843,275 | 01a0881d-870a:2561 01a08768-d214:2222 |
| 09-09 13:27:39 | 09-16 13:27:39 | ? | 4361 | 0 to 98 | 09-09T13:28 -> 09-10T22:11 | 09-09:3 09-10:4358 | 11,826,860 | 562,463,488 | 1,774,316 | 01a08b17-acec:2433 01a08768-d214:1925 |
| 09-07 22:59:18 | 09-14 22:59:18 | ? | 37 | 6 to 7 | 09-09T16:57 -> 09-09T17:43 | 09-09:37 | 299,868 | 4,925,184 | 31,318 | 01a08719-fa5a:37 |
| 09-09 17:01:18 | 09-16 17:01:18 | ? | 783 | 0 to 4 | 09-09T17:01 -> 09-09T17:42 | 09-09:783 | 1,987,569 | 106,154,112 | 357,257 | 01a0863d-ec39:783 |
| 09-09 17:02:07 | 09-16 17:02:07 | ? | 4822 | 0 to 78 | 09-09T17:02 -> 09-12T07:18 | 09-09:2042 09-10:212 09-11:2111 09-12:457 | 14,736,236 | 611,091,328 | 2,155,428 | 01a08324-7cc3:2110 01a08849-4ca2:1388 |
| 09-09 17:11:27 | 09-16 17:11:27 | ? | 154 | 0 to 3 | 09-09T17:11 -> 09-09T17:39 | 09-09:154 | 321,986 | 20,498,560 | 51,632 | 01a08611-84e1:100 01a08204-90bb:54 |
| 09-07 10:00:45 | 09-14 10:00:45 | ? | 405 | 3 to 13 | 09-09T17:11 -> 09-09T17:40 | 09-09:405 | 934,982 | 54,591,104 | 167,026 | 01a08324-7cc3:405 |
| 09-09 17:43:07 | 09-16 17:43:07 | ? | 8103 | 0 to 100 | 09-09T17:43 -> 09-10T06:43 | 09-09:316 09-10:7787 | 21,825,045 | 1,040,994,048 | 3,611,256 | 01a08719-fa5a:6119 01a08849-4ca2:1714 |
| 09-09 13:00:26 | 09-16 13:00:26 | ? | 5891 | 0 to 100 | 09-09T21:19 -> 09-11T09:19 | 09-09:203 09-10:390 09-11:5298 | 22,822,988 | 771,139,584 | 3,211,413 | 01a08719-fa5a:5298 01a08849-4ca2:501 |
| 09-09 21:55:41 | 09-16 21:55:41 | ? | 1324 | 33 to 97 | 09-10T06:51 -> 09-10T11:35 | 09-10:1324 | 4,699,192 | 169,837,440 | 681,107 | 01a08849-4ca2:1293 01a08afe-a5f9:16 |
| 09-10 10:14:48 | 09-17 10:14:48 | ? | 4413 | 0 to 58 | 09-10T10:15 -> 09-12T08:10 | 09-10:1324 09-11:2526 09-12:563 | 18,052,506 | 557,161,984 | 1,615,415 | 01a08204-90bb:1104 01a087c1-7400:780 |
| 09-10 11:34:28 | 09-17 11:34:28 | ? | 2585 | 0 to 100 | 09-10T11:34 -> 09-10T14:56 | 09-10:2585 | 7,368,187 | 340,549,120 | 1,212,966 | 01a08849-4ca2:2572 01a08809-7066:13 |
| 09-10 21:45:09 | 09-17 21:45:09 | ? | 1726 | 1 to 36 | 09-10T22:04 -> 09-12T01:49 | 09-10:56 09-11:1572 09-12:98 | 6,809,925 | 216,193,664 | 538,904 | 01a08719-fa5a:1139 01a09193-24bf:211 |
| 09-11 18:18:56 | 09-18 18:18:56 | ? | 3050 | 0 to 54 | 09-11T18:19 -> 09-12T06:26 | 09-11:2340 09-12:710 | 9,472,729 | 395,771,264 | 1,792,382 | 01a0863d-ec39:2839 01a091fb-675c:205 |
| 09-11 20:47:32 | 09-18 20:47:32 | ? | 987 | 0 to 14 | 09-11T20:49 -> 09-11T23:26 | 09-11:987 | 3,378,161 | 115,307,136 | 394,901 | 01a08768-d214:658 01a07ea1-a586:329 |
| 09-12 08:09:59 | 09-19 08:09:59 | ? | 10054 | 0 to 100 | 09-12T08:10 -> 09-13T01:02 | 09-12:9935 09-13:119 | 28,226,563 | 1,061,776,896 | 6,349,654 | 01a08b69-6882:7026 01a09454-0f16:2372 |
| 09-12 09:01:07 | 09-19 09:01:07 | pro12 | 842 | 0 to 14 | 09-12T10:30 -> 09-14T03:03 | 09-12:114 09-13:636 09-14:92 | 3,123,076 | 112,391,296 | 230,078 | 01a09a7f-af0a:399 01a091fb-675c:237 |
| 09-12 10:31:11 | 09-19 10:31:11 | ? | 8377 | 0 to 95 | 09-12T10:31 -> 09-13T22:43 | 09-12:124 09-13:8253 | 23,935,966 | 1,106,936,704 | 1,731,477 | 01a08768-d214:3824 01a098a1-8a07:2731 |
| 09-12 10:33:13 | 09-19 10:33:13 | pro13 | 3219 | 0 to 32 | 09-12T10:33 -> 09-16T10:56 | 09-12:167 09-13:1557 09-14:975 09-15:460 09-16:60 | 11,213,502 | 392,776,832 | 932,847 | 01a09771-b36c:1578 01a08768-d214:737 |
| 09-12 10:35:58 | 09-19 10:35:58 | claudalyst | 5983 | 0 to 100 | 09-12T10:38 -> 09-14T03:13 | 09-12:1825 09-13:3345 09-14:813 | 15,208,912 | 767,443,072 | 2,560,487 | 01a091fb-675c:2671 01a07ea1-a586:1825 |
| 09-12 10:43:45 | 09-19 10:43:45 | ? | 9087 | 0 to 90 | 09-12T10:43 -> 09-15T22:40 | 09-12:688 09-13:59 09-14:465 09-15:7875 | 32,411,878 | 1,150,453,632 | 3,821,384 | 01a09fa4-6248:7875 01a09532-1d68:688 |
| 09-12 10:56:30 | 09-19 10:56:30 | pro17 | 2704 | 0 to 16 | 09-12T10:56 -> 09-16T12:04 | 09-12:339 09-13:17 09-14:1038 09-15:1141 09-16:169 | 15,853,448 | 292,344,704 | 1,682,617 | 01a08768-d214:322 01a0a802-85e4:136 |
| 09-12 11:14:40 | 09-19 11:14:40 | ? | 3970 | 0 to 100 | 09-12T11:14 -> 09-12T21:14 | 09-12:3970 | 9,072,020 | 510,578,816 | 1,158,284 | 01a09341-5d4a:3970 |
| 09-12 11:20:00 | 09-19 11:20:00 | coder | 10647 | 0 to 100 | 09-12T11:20 -> 09-13T06:06 | 09-12:6231 09-13:4416 | 19,750,309 | 1,456,617,728 | 3,509,491 | 01a091fb-675c:10647 |
| 09-12 11:20:48 | 09-19 11:20:48 | growth | 3050 | 0 to 77 | 09-12T11:20 -> 09-16T10:03 | 09-12:2855 09-14:188 09-15:1 09-16:6 | 8,381,536 | 391,496,704 | 1,053,539 | 01a09080-b08b:2855 01a0a00c-a6dd:70 |
| 09-12 11:23:53 | 09-19 11:23:53 | ? | 14422 | 0 to 100 | 09-12T11:24 -> 09-15T15:33 | 09-12:10637 09-13:2847 09-14:21 09-15:917 | 36,177,762 | 1,985,598,592 | 5,749,094 | 01a0955b-9d77:13447 01a0a232-d81e:917 |
| 09-12 13:35:29 | 09-19 13:35:29 | lessons | 3591 | 0 to 37 | 09-12T13:35 -> 09-16T12:05 | 09-12:16 09-13:205 09-14:1075 09-15:818 09-16:1477 | 16,831,398 | 431,574,400 | 1,641,660 | 01a09fa4-6248:1477 01a09add-9194:234 |
| 09-12 13:46:03 | 09-19 13:46:03 | pro10 | 4375 | 0 to 100 | 09-12T13:46 -> 09-13T12:12 | 09-12:4276 09-13:99 | 10,358,205 | 546,723,840 | 1,953,648 | 01a095dd-ddee:4375 |
| 09-12 13:55:38 | 09-19 13:55:38 | pro16 | 4333 | 0 to 100 | 09-12T13:55 -> 09-12T17:32 | 09-12:4333 | 18,073,437 | 523,980,544 | 1,941,368 | 01a08204-90bb:4333 |
| 09-12 14:04:14 | 09-19 14:04:14 | pro2 | 3601 | 0 to 100 | 09-12T14:04 -> 09-12T17:21 | 09-12:3601 | 9,765,018 | 463,619,072 | 1,454,064 | 01a08768-d214:3601 |
| 09-12 16:17:32 | 09-19 16:17:32 | ? | 12152 | 0 to 100 | 09-12T16:17 -> 09-15T12:37 | 09-12:714 09-13:91 09-14:9589 09-15:1758 | 28,744,999 | 1,643,994,112 | 4,069,187 | 01a08768-d214:11250 01a09667-cb84:714 |
| 09-12 17:22:11 | 09-19 17:22:11 | pro5 | 4160 | 0 to 100 | 09-12T17:22 -> 09-12T21:28 | 09-12:4160 | 11,977,424 | 560,043,648 | 1,548,197 | 01a08768-d214:4160 |
| 09-12 17:39:27 | 09-19 17:39:27 | pro6 | 4801 | 0 to 100 | 09-12T17:39 -> 09-14T23:36 | 09-12:3588 09-13:13 09-14:1200 | 23,382,233 | 575,928,320 | 2,210,221 | 01a08204-90bb:4415 01a0a1db-852d:386 |
| 09-12 13:16:45 | 09-19 13:16:45 | ? | 2827 | 13 to 89 | 09-12T17:49 -> 09-13T13:16 | 09-12:2260 09-13:567 | 8,187,980 | 349,216,640 | 1,082,171 | 01a08d7f-9236:2260 01a09a86-d273:564 |
| 09-12 10:00:38 | 09-19 10:00:38 | office | 2433 | 4 to 47 | 09-12T18:17 -> 09-15T06:32 | 09-12:289 09-13:371 09-14:210 09-15:1563 | 10,501,225 | 287,273,984 | 1,345,942 | 01a09a85-605e:364 01a0863d-ec39:289 |
| 09-12 21:08:23 | 09-19 21:08:23 | pro8 | 11495 | 0 to 100 | 09-12T21:08 -> 09-13T20:08 | 09-12:289 09-13:11206 | 38,448,758 | 1,476,410,752 | 6,056,797 | 01a09771-b36c:9185 01a09b4e-6474:2310 |
| 09-12 21:15:15 | 09-19 21:15:15 | ? | 3780 | 0 to 99 | 09-12T21:15 -> 09-14T02:54 | 09-12:1 09-13:3121 09-14:658 | 9,211,175 | 485,063,936 | 1,588,590 | 01a095dd-ddee:3779 01a09341-5d4a:1 |
| 09-12 21:15:43 | 09-19 21:15:43 | ? | 9107 | 0 to 100 | 09-12T21:15 -> 09-13T19:14 | 09-12:1025 09-13:8082 | 24,688,125 | 1,199,954,560 | 3,317,024 | 01a09341-5d4a:9070 01a09b4f-f5d3:37 |
| 09-12 21:29:23 | 09-19 21:29:23 | ? | 3676 | 0 to 95 | 09-12T21:29 -> 09-13T02:08 | 09-12:2568 09-13:1108 | 11,202,080 | 509,597,440 | 1,465,156 | 01a08768-d214:3676 |
| 09-12 13:00:41 | 09-19 13:00:41 | qa | 3518 | 0 to 21 | 09-13T01:04 -> 09-16T11:19 | 09-13:1494 09-14:698 09-15:1320 09-16:6 | 14,914,655 | 411,326,976 | 1,691,325 | 01a08b69-6882:1494 01a0a19b-80c7:53 |
| 09-13 02:08:31 | 09-20 02:08:31 | product_growth | 8450 | 0 to 100 | 09-13T02:08 -> 09-13T10:52 | 09-13:8450 | 21,742,248 | 1,180,793,728 | 3,182,958 | 01a08768-d214:8450 |
| 09-12 18:52:53 | 09-19 18:52:53 | pro7 | 1324 | 0 to 14 | 09-13T03:45 -> 09-16T11:11 | 09-13:325 09-14:680 09-15:16 09-16:303 | 7,747,575 | 159,740,160 | 562,119 | 01a09b2b-b16e:552 01a098de-66fd:238 |
| 09-13 01:05:09 | 09-20 01:05:09 | coder2 | 11974 | 3 to 100 | 09-13T06:09 -> 09-13T17:31 | 09-13:11974 | 26,183,655 | 1,546,677,632 | 2,833,081 | 01a091fb-675c:7494 01a09a7c-0124:4454 |
| 09-13 11:49:56 | 09-20 11:49:56 | amir_personal | 10441 | 0 to 100 | 09-13T11:50 -> 09-14T21:11 | 09-13:684 09-14:9757 | 41,083,793 | 1,187,081,728 | 4,435,145 | 01a091fb-675c:5638 01a09d33-4137:3804 |
| 09-13 13:30:57 | 09-20 13:30:57 | pro15 | 1813 | 0 to 12 | 09-13T13:31 -> 09-14T08:33 | 09-13:21 09-14:1792 | 5,428,592 | 236,833,152 | 607,671 | 01a091fb-675c:1792 01a09adb-5534:21 |
| 09-12 17:13:50 | 09-19 17:13:50 | pro4 | 2814 | 1 to 25 | 09-13T14:20 -> 09-16T10:59 | 09-13:139 09-14:2101 09-15:564 09-16:10 | 12,369,196 | 339,839,616 | 982,248 | 01a0a046-580f:1272 01a0a504-9f8f:155 |
| 09-13 19:15:59 | 09-20 19:15:59 | ? | 7659 | 0 to 100 | 09-13T19:16 -> 09-15T02:17 | 09-13:1403 09-14:5701 09-15:555 | 32,193,915 | 865,936,512 | 3,450,690 | 01a09341-5d4a:5429 01a091fb-675c:2230 |
| 09-13 22:43:28 | 09-20 22:43:28 | ? | 8261 | 0 to 100 | 09-13T22:43 -> 09-15T16:43 | 09-13:1142 09-14:5197 09-15:1922 | 26,874,860 | 929,427,200 | 2,103,285 | 01a098a1-8a07:6136 01a09a7c-0124:1580 |
| 09-14 01:17:49 | 09-21 01:17:49 | ? | 2966 | 29 to 96 | 09-14T11:21 -> 09-14T18:30 | 09-14:2966 | 14,482,418 | 376,935,040 | 1,640,510 | 01a09fa4-6248:2944 01a08d7f-9236:22 |
| 09-14 18:30:24 | 09-21 18:30:24 | cfo | 4600 | 0 to 100 | 09-14T18:30 -> 09-15T04:48 | 09-14:2916 09-15:1684 | 14,442,413 | 580,518,656 | 1,927,877 | 01a09fa4-6248:4387 01a0a148-d491:51 |
| 09-14 20:45:21 | 09-21 20:45:21 | boss | 1780 | 0 to 20 | 09-14T20:59 -> 09-16T08:00 | 09-14:583 09-15:1195 09-16:2 | 7,592,584 | 192,352,128 | 524,276 | 01a08204-90bb:1241 01a095dd-ddee:261 |
| 09-15 02:19:54 | 09-22 02:19:54 | ? | 10555 | 0 to 97 | 09-15T02:20 -> 09-15T22:58 | 09-15:10555 | 31,183,746 | 1,349,737,216 | 4,115,574 | 01a091fb-675c:5569 01a09341-5d4a:4986 |
| 09-15 12:39:23 | 09-22 12:39:23 | pro3 | 3795 | 0 to 37 | 09-15T12:39 -> 09-16T12:39 | 09-15:3423 09-16:372 | 15,193,350 | 494,198,784 | 1,049,302 | 01a08768-d214:2992 01a0a56c-5ae6:803 |
| 09-15 16:33:03 | 09-22 16:33:03 | illustrator | 4693 | 0 to 93 | 09-15T16:33 -> 09-16T02:27 | 09-15:4207 09-16:486 | 16,939,789 | 617,993,600 | 2,457,219 | 01a0a232-d81e:4693 |
| 09-15 16:44:27 | 09-22 16:44:27 | pro11 | 1391 | 0 to 18 | 09-15T16:44 -> 09-16T10:56 | 09-15:1213 09-16:178 | 3,449,503 | 158,048,896 | 421,076 | 01a098a1-8a07:1384 01a0a9dc-4861:6 |
| 09-15 22:39:51 | 09-22 22:39:51 | amir_elaguizy_fun_country | 8961 | 0 to 100 | 09-15T22:39 -> 09-16T07:14 | 09-15:1237 09-16:7724 | 26,572,096 | 1,169,243,008 | 3,499,304 | 01a09fa4-6248:8961 |
| 09-15 22:57:26 | 09-22 22:57:26 | pro9 | 7364 | 0 to 55 | 09-15T22:58 -> 09-16T12:05 | 09-15:390 09-16:6974 | 25,785,991 | 913,512,704 | 3,483,780 | 01a09341-5d4a:4417 01a091fb-675c:2698 |

## A4. Missions orchestrator 01a09fa4: window sequence

| weekly reset (UTC) | account | responses | used % | first -> last (UTC) |
|---|---|---|---|---|
| 09-21 01:17:41 | cfo (window from Sep 14 01:17:41Z) | 2,968 | 29 to 96 | 09-14 11:21 -> 09-14 18:30 |
| 09-21 18:30:20 | cfo (reset credit at 18:30:20Z) | 4,602 | 0 to 100 | 09-14 18:30 -> 09-15 04:48 |
| 09-19 10:43:48 | amir_elaguizy_fun_country W2 | 7,875 | 36 to 90 | 09-15 04:49 -> 09-15 22:40 |
| 09-22 22:39:51 | amir_elaguizy_fun_country W3 (reset credit at 22:39:51Z) | 8,961 | 0 to 100 | 09-15 22:39 -> 09-16 07:14 |
| 09-19 11:20:48 | growth | 6 | 77 | 09-16 10:03 (after relaunch) |
| 09-19 13:35:35 | lessons | 1,477 | 1 to 37 | 09-16 10:0x -> 12:05 (after relaunch) |

Operator prompts to this thread: 57 user turns, Sep 14 06:20 to Sep 16 (see revision 1 excerpt list in git history; key ones quoted in section 2). Children: 139 spawned over its life (91 gpt-5.6-sol high, 46 gpt-5.6-sol xhigh, 2 gpt-6-astra xhigh); 57 sol-high spawned after Sep 15 07:00. spawn_agent timestamps in the final hours (UTC): 00:54, 00:57, 00:58, 01:52, 01:56, 02:20, 02:47, 02:52, 02:53, 02:59, 03:11, 03:37, 03:41, 04:19, 05:06, 06:25.

Subagent concurrency on W3 (distinct threads responding within the same minute, 511 minutes observed): 1 thread 16 min, 2: 40, 3: 148, 4: 140, 5: 79, 6: 64, 7: 23, 8: 1. On cfo the night before: 1: 151, 2: 200, 3: 110, 4: 48, 5: 14.

Responses per thread on W3: orchestrator 1,734; missions_final_journeys 1,107; missions_5842_lifecycle 891; missions_5808_journey_audit 621; missions_5696_ui 608; issue5838_outcomes_finish 565; issue5838_delivery_finish 498; missions_5837_puzzle 486; issue5836_flutter 463; missions_5840_adaptive 439; missions_5837_final_audit 221; missions_batch_5840_5841_5842_audit 202; others smaller.

## A5. Puzzle, mission, lesson and other pipeline agent families, Sep 8 to 16 (M5)

| family (agent_path) | threads | responses | per day | roots | accounts / windows |
|---|---|---|---|---|---|
| evaluation_repair | 1144 | 5180 | 09-12:5180 | 01a08b69-6882:2711 01a09454-0f16:2469 | pro1:4802 window@09-10T10:14:288 window@09-09T17:02:90 |
| sng_audit_# | 270 | 4779 | 09-14:4256 09-15:523 | 01a091fb-675c:4779 | amir_personal:3073 window@09-13T19:16:1706 |
| existing_home_regressions | 1 | 2919 | 09-12:1649 09-13:1270 | 01a08768-d214:2919 | product_growth:1040 pro5:833 pro2:614 |
| home_startup_readiness | 1 | 2831 | 09-12:1358 09-13:1473 | 01a08768-d214:2831 | product_growth:919 window@09-12T21:29:639 window@09-12T10:31:505 |
| sng_native_journeys | 1 | 2638 | 09-12:2034 09-13:604 | 01a091fb-675c:2638 | coder:2638 |
| home_publication_owner | 1 | 2618 | 09-12:1328 09-13:1290 | 01a08768-d214:2618 | product_growth:1022 pro5:609 pro2:392 |
| home_play_settlement | 1 | 2246 | 09-12:1283 09-13:963 | 01a08768-d214:2246 | product_growth:726 window@09-12T21:29:647 pro5:414 |
| puzzle_review_b#_b# | 2 | 2176 | 09-11:2176 | 01a08719-fa5a:2176 | window@09-09T13:00:1291 window@09-08T10:05:885 |
| flutter_home_resolution | 1 | 2138 | 09-14:1533 09-15:605 | 01a08768-d214:2138 | window@09-12T16:17:2138 |
| sng_ui_ci_finish | 1 | 2105 | 09-13:2105 | 01a091fb-675c:2105 | coder2:2105 |
| sng_game_finish | 1 | 2069 | 09-13:2069 | 01a091fb-675c:2069 | coder2:2069 |
| home_puzzle_mission_settlement | 1 | 1969 | 09-12:857 09-13:1112 | 01a08768-d214:1969 | product_growth:929 pro2:396 window@09-12T21:29:354 |
| puzzle_curator_new_#_# | 2 | 1820 | 09-11:1820 | 01a08719-fa5a:1820 | window@09-09T13:00:1098 window@09-08T10:05:722 |
| sng_table_ui | 1 | 1755 | 09-12:1679 09-13:76 | 01a091fb-675c:1755 | coder:1755 |
| home_current_state_policy | 1 | 1606 | 09-12:500 09-13:1106 | 01a08768-d214:1606 | product_growth:952 pro5:382 window@09-12T10:31:154 |
| finish_d1_first_lesson | 1 | 1593 | 09-09:1593 | 01a07bb4-56b4:1593 | window@09-08T01:22:1593 |
| home_play_runtime | 1 | 1508 | 09-10:1508 | 01a08768-d214:1508 | window@09-09T13:27:908 window@09-08T01:24:600 |
| sng_strategy_finish | 1 | 1198 | 09-13:1198 | 01a091fb-675c:1198 | coder2:1198 |
| home_error_go_proof | 1 | 1133 | 09-12:965 09-13:168 | 01a08768-d214:1133 | window@09-12T21:29:425 pro5:367 pro2:308 |
| missions_final_journeys | 1 | 1107 | 09-16:1107 | 01a09fa4-6248:1107 | amir_elaguizy_fun_country:1107 |
| sng_foundation | 1 | 1087 | 09-12:1041 09-13:46 | 01a091fb-675c:1087 | coder:1087 |
| home_stack_checks | 1 | 1037 | 09-09:399 09-10:638 | 01a08768-d214:1037 | window@09-08T13:54:1037 |
| go_home_resolution | 1 | 974 | 09-14:883 09-15:91 | 01a08768-d214:974 | window@09-12T16:17:974 |
| home_policy_runtime | 1 | 950 | 09-13:950 | 01a08768-d214:950 | product_growth:893 window@09-12T10:31:57 |
| sng_system_service_tests | 1 | 920 | 09-14:920 | 01a091fb-675c:920 | amir_personal:606 pro15:314 |
| sng_p1_native_evidence | 1 | 899 | 09-15:899 | 01a091fb-675c:899 | window@09-15T02:19:897 window@09-13T19:16:2 |
| missions_#_lifecycle | 1 | 891 | 09-16:891 | 01a09fa4-6248:891 | amir_elaguizy_fun_country:891 |
| sng_native_finish | 1 | 872 | 09-13:872 | 01a091fb-675c:872 | coder2:841 pro12:31 |
| sng_history_availability_# | 1 | 806 | 09-15:806 | 01a091fb-675c:806 | window@09-15T02:19:806 |
| sng_analysis_ui | 1 | 799 | 09-12:726 09-13:73 | 01a091fb-675c:799 | coder:799 |
| missions_#_ui | 1 | 794 | 09-15:558 09-16:236 | 01a09fa4-6248:794 | amir_elaguizy_fun_country:608 window@09-12T10:43:186 |
| sng_launch_protocol | 1 | 781 | 09-13:781 | 01a091fb-675c:781 | coder:781 |
| puzzle_b#_curation | 2 | 779 | 09-10:779 | 01a08719-fa5a:779 | window@09-08T01:33:779 |
| sng_lobby_ui | 1 | 760 | 09-12:682 09-13:78 | 01a091fb-675c:760 | coder:760 |
| sng_absence_runtime | 1 | 694 | 09-13:569 09-14:125 | 01a091fb-675c:694 | claudalyst:694 |
| home_play_entry | 1 | 681 | 09-09:360 09-10:321 | 01a08768-d214:681 | window@09-08T13:54:681 |
| home_recovery_finish | 1 | 668 | 09-10:668 | 01a08768-d214:668 | window@09-09T13:27:668 |
| missions_#_puzzle | 1 | 659 | 09-15:562 09-16:97 | 01a09fa4-6248:659 | amir_elaguizy_fun_country:486 window@09-12T10:43:173 |
| sng_launch_learning | 1 | 640 | 09-13:640 | 01a091fb-675c:640 | coder:640 |
| missions_#_journey_audit | 1 | 621 | 09-16:621 | 01a09fa4-6248:621 | amir_elaguizy_fun_country:621 |
| sng_launch_strategy | 1 | 602 | 09-13:602 | 01a091fb-675c:602 | coder:602 |
| sng_launch_game | 1 | 581 | 09-13:581 | 01a091fb-675c:581 | coder:581 |
| sng_system_client_native | 1 | 551 | 09-14:551 | 01a091fb-675c:551 | pro15:551 |
| home_physical_signup | 1 | 511 | 09-10:511 | 01a08768-d214:511 | window@09-09T13:27:292 window@09-08T01:24:219 |
| home_state_captures | 1 | 507 | 09-09:181 09-10:326 | 01a08768-d214:507 | window@09-08T13:54:507 |

## A6. Opus capacity watcher (Prime session 01a0892c-c908-774a-960a-a8f43f65abf9)

| day | ipython calls | "at capacity" sightings | "continue" sends | accounts it reports landing on (mentions) | revoked/dead mentions |
|---|---|---|---|---|---|
| Sep 10 | 2,014 | 815 | 5 | boss 4, claudalyst 4, coder2 4, pro1 4, pro11 4, pro17 4, pro9 4 | |
| Sep 11 | 1,871 | 835 | 0 | | coder2 3, pro14 1 |
| Sep 12 | 2,000 | 965 | 0 | office 15, pro12 9, pro14 4, pro15 4, pro11 2, pro17 2, pro2 2, pro5 2 | boss 13 |
| Sep 13 | 574 | 262 | 0 | coder 11, coder2 1, pro1 1, pro12 1, pro8 1, productgrowth 1 | boss 1 |
| Sep 14 | 342 | 145 | 1 (04:49 CDT) | boss 7, pro14 6, pro11 2, coder 2, claudalyst 1, illustrator 1, lessons 1, pro13 1 | boss 11, pro11 6 |
| Sep 15 | 202 (last 09:49 CDT) | 91 | 0 | lessons 5, pro9 5, growth 1, marcus 1 | |

Hourly on Sep 15 (UTC): 00h 12, 01h 12, 02h 24, 03h 12, 04h 14, 05h 14, 06h 16, 07h 12, 08h 12, 09h 12, 10h 12, 11h 12, 12h 14, 13h 12, 14h 12; nothing after 14:49Z. Last event in the session: 2026-09-16T12:29Z (heartbeat prompt; taskState needs_input).

Mentions of the deactivated account: 2026-09-10T06:31Z "01a08768-d214-7621-8024-7f216f4c52b9 amir.elaguizy@fun.country" and 2026-09-10T06:32Z "learn screen (content/w1R:p1) hit a usage limit on amir.elaguizy@fun.country (blocked until Sep 14). /status -> /quit".

Watched panes (mentions): rustai/wG:p4 78, bugs/w6P:p1 56, content/w1Q:p1 41, rustai/wZ:p1 32, bugs/w82:p1 27, rustai/w0:p1 27, rustai/wK:p3 26, bugs/w86:p1 23, content/w1T:p1 21, growth/w8A:p1 18, bugs/w7W:p1 14, content/w1G:p2 14.

Replacement watcher: Claude session `coder/.../arch-skill/95c5e6ba` started 2026-09-16 10:08Z (05:08 CDT), prompt "there was a session where I had you monitoring and urging on any stuck codex sessions every few minutes... watch the herdr space dynamic missions... /goal resume... heartbeat every 5 minutes"; heartbeats every ~5 min from 10:16Z.

## A7. Browser automation (BrowserOS) against chatgpt.com

Per day (M5 Codex rollouts): Sep 12 226 calls / 132 conversations / logins amir@fun.country 116, pro4 101, amir.elaguizy 31 (profile dumps), cloudqa 5, claude 4; Sep 13 136 / 80 / amir@fun.country 58, pro4 49; Sep 14 163 / 75 / amir@fun.country 55, pro4 17; Sep 15 84 / 33 / amir@fun.country 79; Sep 16 21 / 30 / amir@fun.country 8. Roots: Sep 12 01a0955b 50, 01a098a1 47, 01a095dd 45, 01a09771 43; Sep 14 01a09fa4 113; Sep 15 01a09fa4 32, 01a091fb 22, 01a09341 17, 01a08768 7.

Hour by hour, Sep 15 12:00Z to Sep 16 12:00Z (calls / roots): 12Z 1, 13Z 1, 14Z 3, 15Z 9, 16Z 3, 17Z 5, 18Z 3, 19Z 2, 20Z 2, 21Z 5, 22Z 1, 23Z 5, 00Z 4, 01Z 5, 02Z 9, 03Z 11, 04Z 2, 06Z 1, 10Z 7, 11Z 6. Login visible in reads in every one of those hours: amir@fun.country.

`home` box: Sep 12 480 browseros+chatgpt lines (amir@fun.country 136); Sep 13 to 16 3 to 5 lines/day. Prime sessions: 01a09c9d (417 chatgpt.com references; amir@fun.country 12, pro1 7, pro4 2), 01a0a824 (84; pro1 12, amir@fun.country 10).

Orchestrator 01a09fa4 ChatGPT URLs: chatgpt.com/g/g-p-6a89c1cafaec8191b7016f9d3ca90d2a/c/6aa7c273-... (pasted by Amir Sep 14 11:38Z), chatgpt.com/g/g-p-6a9816e4e5988191b5e4a13030061476-ps-architecture/project and /c/6aa89143-... (Sep 14 22:41Z, Sep 15 00:30Z, Sep 16 11:09Z). Consultation state recorded as profile 'Work (explicit Amir exception)', model '6 Pro', connector 'GitHub selected from real picker'.

## A8. Studio Hermes assignments (hermes-watch log, hold intervals, UTC)

amir_elaguizy_fun_country, Sep 7 to 16: agent_ops 09-07 02:30 -> 13:17; cj_agent_coder 13:17 -> 16:33; cj_agent_designer 16:33 -> 17:19; cj_agent_paid_media 09-07 17:19 -> 09-09 11:41; cj_agent_merch_bot 09-09 11:41 -> 12:32; agent_product_growth 12:32 -> 17:15; agent_support 17:15 -> 17:40; cj_agent_writer 09-09 17:40 -> 09-10 03:09; (none 09-10 03:09 -> 09-12 16:31); agent_ads_analyst 09-12 16:31 -> 20:17; cj_agent_pilot 09-12 20:17 -> 09-13 06:09; cj_agent_paid_media 06:09 -> 09:25; cj_agent_designer 09:25 -> 11:21; cj_agent_danalyst 11:21 -> 11:32; cj_agent_paid_media 11:32 -> 14:18; cj_agent_merch_bot 14:18 -> 22:43; cj_agent_pilot 09-13 22:43 -> 09-14 05:12; cj_agent_paid_media 05:12 -> 07:33; cj_agent_merch_bot 07:33 -> 07:43; cj_agent_coder 07:43 -> 18:05; cj_agent_boss 18:05 -> 18:15; cj_agent_arthur_sterling 18:15 -> 18:30; cj_agent_coder 09-14 18:30 -> 09-15 12:42; cj_agent_writer 09-14 23:44 -> 09-15 01:04; cj_agent_seo 01:04 -> 02:20; cj_agent_seo 12:42 -> 17:49; cj_agent_buyer_experience_sentinel 17:49 -> 20:50; agent_product_growth 20:50 -> 21:26; agent_writer 20:50 -> 23:42; agent_coder 21:26 -> 23:42; cj_agent_seo 09-15 23:42 -> 09-16 00:38; agent_support 09-15 23:42 -> 09-16 01:18; cj_agent_merch_bot 01:18 -> 02:09; cj_agent_paid_media 02:09 -> 02:34; cj_agent_buyer_experience_sentinel 02:34 -> 03:44; agent_writer 03:44 -> 05:25; agent_coder 03:44 -> 05:40; agent_writer 05:40 -> 06:16; agent_product_growth 05:40 -> 06:16; removed 06:16:14Z (exhaustion usage_window_95).

Studio 5-minute reads of remaining weekly % for this account: Sep 15 11:26Z 51, 12:42Z 46, 14:38Z 40, 17:49Z 30, 20:35Z 22, 21:26Z 20, 22:37Z 11; then (new window) 23:42Z 89, 00:38Z 74, 01:18Z 63, 02:09Z 44, 02:34Z 35, 03:44Z 19, 04:55Z 11, 05:40Z 8, 06:01Z 6.

Hermes state.db sessions started in W3 on the assigned studio homes: 0. Fleet since Sep 10 (sessions / input / cache-read / output): agent_ads_analyst 7 / 324,428 / 1,281,152 / 25,730; agent_coder 2 / 849,018 / 5,586,560 / 27,848; agent_growth_analyst 27 / 7,347,531 / 79,275,264 / 440,251; agent_ops 65 / 5,067,943 / 56,829,312 / 463,702; agent_product_growth 6 / 444,294 / 1,739,264 / 42,954; agent_writer 6 / 39,259 / 22,528 / 1,208; cj_agent_buyer_experience_sentinel 7 / 806,919 / 21,094,016 / 48,732; cj_agent_support 14 / 903,238 / 4,720,000 / 45,555; cj_agent_zara 51 / 8,484,738 / 195,303,168 / 783,368; all other homes 0.

pro14 on studio Hermes: agent_illustrator 09-10 00:03 -> 03:09, agent_growth_analyst 03:09 -> 16:15, agent_ops 09-10 16:15 -> 09-11 20:50, plus cj_agent_* holds on 09-11. pro12: agent_ops 09-10 00:03 -> 16:15, cj_agent_zara, cj_agent_writer, agent_illustrator 09-10 17:56 -> 09-11 12:00, cj_agent_* 09-11, cj_agent_coder/buyer_experience_sentinel 09-12 01:13 -> 01:28. pro15: cj_agent_designer, cj_agent_boss, cj_agent_arthur_sterling, agent_illustrator 09-10 08:26 -> 17:56, agent_coder 09-10 17:56 -> 09-11 00:57, cj_agent_arthur_sterling 09-11 00:57 -> 11:25, cj_agent_coder 11:25 -> 15:32. M3 Hermes homes (maxrivers, personal): none of these labels since Sep 8.

## A9. aimgr selection histories, routine receipts, processes

### M5 aimgr Codex selection history (local-state.json, 200-entry cap; selections only)

| observedAt (UTC) | status | label | reason |
|---|---|---|---|
| 2026-09-13T01:03:42.716Z | activated | qa | next_best |
| 2026-09-14T08:00:06.127Z | activated | pro17 | next_best |
| 2026-09-14T09:42:09.013Z | activated | pro11 | next_best |
| 2026-09-14T09:50:20.307Z | activated | pro12 | next_best |
| 2026-09-14T09:51:39.780Z | activated | amir_personal | next_best |
| 2026-09-14T09:56:09.637Z | activated | pro13 | next_best |
| 2026-09-14T11:16:47.489Z | activated | office | next_best |
| 2026-09-14T11:19:05.352Z | activated | cfo | next_best |
| 2026-09-14T11:45:45.956Z | activated | amir_elaguizy_fun_country | next_best |
| 2026-09-14T16:54:24.097Z | activated | pro17 | explicit_label |
| 2026-09-14T16:54:33.038Z | noop | pro17 | explicit_label |
| 2026-09-14T17:45:13.871Z | noop | pro17 | explicit_label |
| 2026-09-14T18:16:31.359Z | activated | growth | next_best |
| 2026-09-15T06:23:35.586Z | activated | pro17 | explicit_label |
| 2026-09-15T06:23:35.954Z | noop | pro17 | explicit_label |
| 2026-09-15T06:23:47.070Z | activated | office | explicit_label |
| 2026-09-15T06:23:47.417Z | noop | office | explicit_label |
| 2026-09-15T08:00:14.236Z | activated | boss | next_best |
| 2026-09-15T10:09:37.036Z | activated | illustrator | next_best |
| 2026-09-15T11:04:11.802Z | activated | lessons | next_best |
| 2026-09-15T16:33:25.249Z | activated | illustrator | explicit_label |
| 2026-09-16T12:28:18.698Z | activated | pro4 | next_best |
| 2026-09-16T12:30:01.074Z | activated | pro7 | next_best |

Exhaustion entries (usage_window_95) recorded for amir_elaguizy_fun_country: 2026-09-16T12:28:18.698Z, 2026-09-16T12:30:01.074Z

### Routine receipts Sep 12 to 16 (~/.aimgr/routine-runs)

| fire key | account | started (UTC) | completed (UTC) | exit | error |
|---|---|---|---|---|---|
| community-sweep--2026-09-12T07-00-0500 | pro1 | 2026-09-12T12:00:05.883Z | 2026-09-12T12:11:47.597Z | 0 |  |
| community-sweep--2026-09-12T17-00-0500 | office | 2026-09-12T22:00:16.144Z | 2026-09-12T22:32:12.666Z | 0 |  |
| community-sweep--2026-09-13T07-00-0500 | lessons | 2026-09-13T12:00:08.091Z | 2026-09-13T12:10:10.888Z | 1 | Prime initial turn ended with stopReason=error. |
| community-sweep--2026-09-13T17-00-0500 | lessons | 2026-09-13T22:00:05.558Z | 2026-09-13T22:05:57.351Z | 1 | Prime initial turn ended with stopReason=error. |
| community-sweep--2026-09-14T07-00-0500 | pro10 | 2026-09-14T12:00:05.178Z | 2026-09-14T12:26:42.307Z | 0 |  |
| community-sweep--2026-09-14T17-00-0500 | pro16 | 2026-09-14T22:00:15.496Z | 2026-09-14T22:01:03.449Z | 1 | Prime interactive TUI exited during prompt admission with code 1. |
| community-sweep--2026-09-15T07-00-0500 | pro13 | 2026-09-15T12:00:08.878Z | 2026-09-15T12:16:28.459Z | 1 | Prime initial turn ended with stopReason=error. |
| community-sweep--2026-09-15T17-00-0500 | pro11 | 2026-09-15T22:00:03.796Z | 2026-09-15T22:21:37.933Z | 0 |  |
| community-sweep--2026-09-16T07-00-0500 | pro15 | 2026-09-16T12:00:05.210Z | 2026-09-16T12:32:21.311Z | 0 |  |
| daily-disk-cleanup--2026-09-14T03-00-0500 | pro17 | 2026-09-14T08:00:05.275Z | 2026-09-14T08:05:12.709Z | 0 |  |
| daily-disk-cleanup--2026-09-15T03-00-0500 | boss | 2026-09-15T08:00:05.925Z | 2026-09-15T08:00:21.316Z | 1 | Codex turn failed: Selected model is at capacity. Please try a differe |
| daily-disk-cleanup--2026-09-16T03-00-0500 | boss | 2026-09-16T08:00:03.172Z | 2026-09-16T08:00:18.991Z | 1 | Codex turn failed: Selected model is at capacity. Please try a differe |
| daily-sheet-maintainer--2026-09-13T06-49-0500--manual-9fc86faa-ceef-4396-bf | amir_personal | 2026-09-13T11:49:34.766Z | 2026-09-13T13:39:12.629Z | 0 |  |
| daily-sheet-maintainer--2026-09-14T06-16-0500--manual-feb6c7ba-9d41-4d34-ab | office | 2026-09-14T11:16:46.722Z | 2026-09-14T12:59:46.121Z | 0 |  |
| daily-sheet-maintainer--2026-09-15T06-04-0500--manual-89be9ea2-7bf8-499b-ab | lessons | 2026-09-15T11:04:10.584Z | 2026-09-15T12:49:05.072Z | 0 |  |
| daily-sheet-maintainer--2026-09-16T06-04-0500--manual-3ec78199-ed2c-415c-ac | pro7 | 2026-09-16T11:04:02.463Z | 2026-09-16T11:07:07.138Z | 1 | Codex turn failed: Selected model is at capacity. Please try a differe |
| gp-monday-reset--2026-09-14T06-00-0500 | lessons | 2026-09-14T11:00:05.174Z | 2026-09-14T11:02:19.092Z | 0 |  |
| morning-report--2026-09-12T06-00-0500 | office | 2026-09-12T11:00:05.767Z | 2026-09-12T11:14:24.797Z | 0 |  |
| morning-report--2026-09-13T06-00-0500 | office | 2026-09-13T11:00:05.753Z | 2026-09-13T11:16:10.757Z | 0 |  |
| morning-report--2026-09-14T06-00-0500 | lessons | 2026-09-14T11:00:05.160Z | 2026-09-14T11:17:42.844Z | 0 |  |
| morning-report--2026-09-15T06-00-0500 | coder | 2026-09-15T11:00:06.272Z | 2026-09-15T11:00:35.662Z | 1 | Prime initial turn ended with stopReason=error. |
| morning-report--2026-09-16T06-00-0500 | pro11 | 2026-09-16T11:00:05.108Z | 2026-09-16T11:16:08.327Z | 0 |  |
| reddit-sweep--2026-09-12T12-00-0500 | office | 2026-09-12T17:00:11.444Z | 2026-09-12T17:03:15.978Z | 1 | Prime initial turn ended with stopReason=error. |
| reddit-sweep--2026-09-13T12-00-0500 | lessons | 2026-09-13T17:00:16.218Z | 2026-09-13T17:18:50.396Z | 0 |  |
| reddit-sweep--2026-09-14T12-00-0500 | coder | 2026-09-14T17:00:12.337Z | 2026-09-14T17:02:51.282Z | 1 | Prime initial turn ended with stopReason=error. |
| reddit-sweep--2026-09-15T12-00-0500 | pro11 | 2026-09-15T17:00:14.336Z | 2026-09-15T17:01:25.200Z | 1 | Prime initial turn ended with stopReason=error. |
| replay-review--2026-09-12T03-00-0500 | cfo | 2026-09-12T08:00:05.861Z | 2026-09-12T08:04:10.778Z | 0 |  |
| replay-review--2026-09-13T03-00-0500 | boss | 2026-09-13T08:00:04.995Z | 2026-09-13T08:03:47.690Z | 0 |  |
| replay-review--2026-09-14T03-00-0500 | boss | 2026-09-14T08:00:05.275Z | 2026-09-14T08:04:27.513Z | 0 |  |
| replay-review--2026-09-15T03-00-0500 | cfo | 2026-09-15T08:00:05.925Z | 2026-09-15T08:02:35.892Z | 0 |  |
| replay-review--2026-09-16T03-00-0500 | coder | 2026-09-16T08:00:03.172Z | 2026-09-16T08:05:12.283Z | 0 |  |
| weekly-ops-report--2026-09-14T04-00-0500 | lessons | 2026-09-14T09:00:05.237Z | 2026-09-14T09:00:15.284Z | 1 | Prime interactive TUI exited during prompt admission with code 1. |
| weekly-ops-report--2026-09-14T06-17-0500--manual-04cec0aa-5d53-4f00-8ed6-d5 | office | 2026-09-14T11:17:12.285Z | 2026-09-14T11:25:28.380Z | 0 |  |

### `home` box selections (local-state.json)

| observedAt (UTC) | status | label | reason |
|---|---|---|---|
| 2026-09-14T09:49:14.202Z | activated | pro15 | next_best |
| 2026-09-14T09:49:42.215Z | activated | pro14 | next_best |
| 2026-09-14T09:50:32.290Z | activated | pro15 | next_best |
| 2026-09-14T09:51:01.674Z | activated | pro14 | next_best |
| 2026-09-14T09:51:11.116Z | activated | pro15 | next_best |
| 2026-09-14T09:51:16.243Z | activated | pro14 | next_best |
| 2026-09-14T09:51:27.815Z | activated | pro15 | next_best |
| 2026-09-14T09:51:48.631Z | activated | lessons | next_best |
| 2026-09-14T09:51:56.222Z | activated | pro17 | next_best |
| 2026-09-14T09:52:00.214Z | activated | lessons | next_best |
| 2026-09-14T09:52:24.399Z | activated | pro17 | next_best |
| 2026-09-14T09:53:17.971Z | activated | lessons | next_best |
| 2026-09-14T09:53:45.111Z | activated | pro17 | next_best |
| 2026-09-14T09:54:10.882Z | activated | lessons | next_best |
| 2026-09-15T02:20:39.745Z | activated | pro9 | next_best |
| 2026-09-15T16:42:28.784Z | activated | illustrator | next_best |
| 2026-09-16T11:34:32.965Z | activated | pro7 | next_best |

`home` box Codex threads Sep 14: 09:51:28Z "hi", 09:52:24Z "recr 01a0931b...", 09:53:45Z "read 01a0931b... and cr 01a0931b...", 09:54:12Z "ramp up on 01a0931b... and review everything I asked it to do overnight" (ran to Sep 16 10:10Z).

### Codex processes on M5 at 06:49 CDT Sep 16 (start time, command)

Sep 13 06:20:54 `aim codex run` (pid 96186, pinned to pro12; threads Sep 13 11:22Z to 18:22Z; 401 "invalidated oauth token" from Sep 16 07:26:52Z, 57 by 11:38Z); Sep 13 07:31 `aim codex resume 01a095dd`; Sep 13 09:28 `aim codex run`; Sep 13 15:09 `aim codex resume 01a09771`; Sep 14 04:56 `aim codex run` (thread 01a09f58, aimgr); Sep 14 08:12 `aim codex run` (pid 64033: threads 01a0a00c, 01a0a049, 01a0a04e; idle since Sep 14 14:26Z); Sep 14 13:44 `aim codex run`; Sep 14 15:51 `aim codex run`; Sep 14 16:19 `aim codex resume 01a091fb`; Sep 14 17:15 `aim codex resume 01a09b7b`; Sep 14 17:16 `codex -p dsflash`; Sep 14 21:29 `aim codex resume 01a09341`; Sep 15 05:09 `aim codex resume 01a0a232`; Sep 15 07:22 `aim codex run`; Sep 15 07:49 daily-sheet-maintainer codex; Sep 15 09:47, 11:40, 12:06, 12:41 `codex -p dsflash`; Sep 15 16:39 `aim codex run`; Sep 15 21:32 `aim codex run`; Sep 16 05:05 `aim codex resume 01a09fa4` (pid 93173); Sep 16 06:11 `aim codex resume 01a08768`; Sep 16 06:25 `aim codex run`; Sep 16 06:40 `aim codex run`. Gone by then: pid 58601 (hosted the missions orchestrator Sep 14 23:49 to Sep 16 05:03 CDT; 63 threads).

Orchestrator host pid 58601 on Sep 16 (UTC): last model responses 07:14:37Z; `usage_limit_exceeded` 07:14:36Z; 429-tagged log rows 07:02 1, 07:13 6, 07:14 3, 07:17 2, 07:18 2; no rate-limit reads 07:20Z to 09:38Z; rate-limit reads 09:30Z 16 (17 failed), 09:40Z 118 (118 failed), 09:50Z 117 (117 failed), 10:00Z 40 (40 failed); process exit 10:03:20Z.

401 "invalidated oauth token" rows per hour (M5 logs_2.sqlite): Sep 13 07h 7, 08h 20, 09h 27, 10h 26, 11h 146, 12h 12; Sep 14 07h 7, 08h 135, 09h 71, 10h 14, 11h 29, 12h 18, 13h 23, 14h 6; Sep 15 17h 50, 18h 104; Sep 16 07h 8, 08h 13, 09h 19, 10h 15, 11h 9.

## A12. Reset-credit consumptions observed in-flight (M5 and `home` rollouts)

Detection: within one thread, the weekly `resets_at` jumps to now+7d while the old window still had time left. Rows with several threads (or several roots) changing in the same second are in-flight resets, not restarts. Watcher keystrokes: the Opus watcher's `send-keys ... enter` calls within 6 minutes. No other agent sent Herdr keystrokes Sep 12 to 16 (Claude session files list the tool but never call it; other Prime sessions never call it).

| time (UTC) | time (CDT) | account (current map) | old used % | in-flight threads (roots) | watcher keystroke | note |
|---|---|---|---|---|---|---|
| 09-10 10:15:10 | 09-10 05:15 | ? | 90 | 2 (01a087c1) | none within 6 min (watcher active, 19 keystrokes that day) | |
| 09-10 11:34:34 | 09-10 06:34 | ? | 97 | 7 (01a08849); also seen on `home` 11:34:44 | none within 6 min | |
| 09-12 08:19:10 | 09-12 03:19 | pro1 | 78 | 2 (01a08b69, evaluation_repair burst) | none | |
| 09-12 10:43:48 | 09-12 05:43 | amir_elaguizy_fun_country (W2 start) | W1 100% | not in-flight; `01a09532` started 10:38Z and first responded on W2 at 10:43:51Z | none | Amir's new interactive session; Amir confirmed 2026-09-16 he pressed it |
| 09-12 11:14:47 | 09-12 06:14 | ? | 43 | 2 (01a09341) | none | |
| 09-12 17:22:57 | 09-12 12:22 | pro5 | 100 | 7 (01a08768) | none | |
| 09-12 17:40:09 | 09-12 12:40 | pro6 | 100 | 7 (01a08204) | none | |
| 09-12 21:15:55 | 09-12 16:15 | ? | 100 | 4 (01a09341) | none | |
| 09-12 21:29:34 | 09-12 16:29 | ? | 100 | 8 (01a08768) | none | |
| 09-13 01:05:00 | 09-12 20:05 | coder2 | 90 | `home` short-deck pane (rustai/w0:p1); M5 01a091fb/01a09a7c then burned it 0% to 100% by 17:31Z | **yes, 01:04:28Z `send-keys w0:p1 enter`**, narrated | watcher |
| 09-13 02:08:47 | 09-12 21:08 | product_growth | 95 | 5 (01a08768, learn screen) | **yes, 02:08:26Z and 02:08:40Z on content/w1T:p1 and content/w1R:p1** | watcher |
| 09-13 11:50:10 | 09-13 06:50 | amir_personal | 0 | 1 (01a09a99) | none | possibly a restart, not a reset |
| 09-13 13:31:11 | 09-13 08:31 | pro15 | 76 | 1 (01a09adb) | none | |
| 09-13 19:16:30 | 09-13 14:16 | ? | 100 | 3 (01a09341) | none | |
| 09-13 22:43:47 | 09-13 17:43 | ? | 95 | 3 threads across 3 roots (01a098a1, 01a09a7c, 01a08768) | none | account-wide, seen by three sessions |
| 09-14 01:17:41 | 09-13 20:17 | cfo (first window) | `home` 100% | `home` 01:32:13Z, 3 threads | none | |
| 09-14 18:30:20 | 09-14 13:30 | cfo | 96 | 3 (01a09fa4); `home` 18:30:33Z and 18:32:42Z | none | Amir prompting the orchestrator at 18:13Z, 18:14Z, 18:30Z |
| 09-15 02:20:54 | 09-14 21:20 | ? | 100 | 5 (01a091fb, 01a09341) | none | |
| 09-15 12:39:48 | 09-15 07:39 | pro3 | 100 | 3 (01a08768) | none | |
| 09-15 16:33:03 | 09-15 11:33 | illustrator | 100 | 7 (01a0a232); `home` 16:42:49Z | none | `aim codex use illustrator` (explicit) at 16:33:25Z |
| 09-15 22:39:51 | 09-15 17:39 | amir_elaguizy_fun_country (W3 start) | 90 | 3 (01a09fa4) | none (watcher stopped 14:49Z) | Amir confirmed 2026-09-16 he pressed it |
| 09-15 22:58:43 | 09-15 17:58 | pro9 | 97 | 4 (01a09341, 01a091fb); `home` 22:59:13Z | none | |

Reset credits remaining now (A1): 0 on amir_personal, boss, claudalyst, coder2, lessons, pro10, pro15, pro16, pro17, pro8, pro9; 1 on fun_country, cfo, illustrator, office, pro1, pro11, pro14, pro6, qa; 2 on pro12, pro2, pro3, pro5, product_growth; 3 on coder, growth, pro13, pro4, pro7.

## A10. Codex and aimgr facts relied on

- Codex CLI 0.154.0-alpha.3 pins a process to the account it loaded: `AuthManager::reload_if_account_id_matches` (login/src/auth/manager.rs:2444) skips reload when auth.json holds a different account id; unconditional `reload()` only on login/logout paths and after the process's own token refresh.
- Reset credits: TUI `consume_rate_limit_reset_credit` (tui/src/app/background_requests.rs:170), prompt "Yes, use reset / Thanks for using Codex! You've been granted one free rate limit reset", backend `/api/codex/rate-limit-reset-credits/consume`; the 90% switch prompt threshold is `RATE_LIMIT_SWITCH_PROMPT_THRESHOLD = 90.0` (tui/src/chatwidget/rate_limits.rs:16). aimgr only reads `resetCreditsAvailable` (src/status/redis-cache.js:83); it never consumes.
- aimgr credential-helper `advance` requires `policy.pool.automaticFailoverApproved`, which is set on 0 records; it did not move any session.
- Subagents spawned with `spawn_agent` run inside the parent process and share its auth.
- `aim codex run/resume` selects an account (`next_best` or explicit), writes `~/.codex/auth.json`, and launches Codex; selections are appended to `local-state.json` (200-entry cap).

## A11. Evidence paths

- Rollouts: `~/.codex/sessions/2026/09/{08..16}/` (orchestrator `2026/09/14/rollout-2026-09-14T06-19-05-01a09fa4-6248-7c03-96ec-921af4bcc3e7.jsonl`, 382 MB); `~/.codex/logs_2.sqlite` (from Sep 6); `~/.codex/state_5.sqlite`.
- Prime watcher: `~/.prime/agent/sessions/01a0892c-c908-774a-960a-a8f43f65abf9.jsonl`. Replacement watcher: `~/.aimgr/claude-homes/coder/.claude/projects/-Users-aelaguiz-workspace-arch-skill/95c5e6ba-948d-45fe-ae2c-93cb09ca6341.jsonl`.
- Profile map: `~/.codex/sessions/2026/09/13/rollout-2026-09-13T06-16-53-*.jsonl`.
- aimgr: `~/.aimgr/local-state.json`, `~/.aimgr/routine-runs/*.json`, Redis via `aim redis snapshot`, `aim status --json`.
- Studio: `/tmp/agents_host_aim_hermes_watch.out.log`, `/Users/agents/.hermes/profiles/*/state.db`. M3: `~/.aimgr/logs/auth-maintainer.out.log`. `home`: `/home/aelaguiz/.aimgr/local-state.json`, `/home/aelaguiz/.codex/sessions/2026/09/`.
- Scratch scripts (not committed): `scan_rl.py` (fingerprint extraction), `remote_scan.py`, `hermes_parse3.py`, `hermes_load.py`.

---

# Part B: pro12, pro14, pro15 (deactivated 2026-09-14 04:51:28 CDT)

Same method as Part A: every Codex response carries the account's weekly-reset timestamp; windows are matched to accounts by the current `aim status` reset value or, for windows that have since been replaced, by fitting the window's used% trajectory to the studio's 5-minute usage readings for that account (mean absolute error shown). Machines scanned: this Mac (M5, Sep 8 to 16), `home` (Sep 8 to 16), M3 laptop (no Codex sessions in September), studio `~/.codex` (none), old-m1 (unreachable), `amir-m3-36gb` (on the tailnet, ssh and port 7337 closed, not scanned), `claw` (ssh permission denied).

## B1. Identity and state

| label | Chrome profile | health | resets left | last usage snapshot | weekly reset (current window) |
|---|---|---|---|---|---|
| pro12 | Profile 29 | blocked, openai_account_deactivated 2026-09-14T09:51:28Z | 2 | 14%, observed 2026-09-14T03:59Z | 2026-09-19 09:01:07Z (window from Sep 12 09:01:07Z) |
| pro14 | Profile 31 | blocked, same timestamp | 1 | 1%, observed 2026-09-14T03:59Z | 2026-09-19 13:47:06Z (window from Sep 12 13:47:06Z) |
| pro15 | Profile 32 | blocked, same timestamp | 0 | 0%, observed 2026-09-14T03:59Z | 2026-09-20 13:30:57Z (window from Sep 13 13:30:57Z) |

Redis marked all three at the same instant, during the `home` box's `aim codex use` burst (04:49 to 04:54 CDT). The M3 auth-maintainer log shows `lease_busy` skips for pro14 (4,562) and pro15 (3,892); no revocation outcome lines.

## B2. Windows and what consumed them

| account | window | start (UTC) | how it started | end | used at end | M5 responses | home responses | other consumers |
|---|---|---|---|---|---|---|---|---|
| pro12 | A | Sep 8 11:15:42 | first use after prior reset (studio read 100% at Sep 7 11:01Z) | Sep 12 09:01:07 reset credit | ~44% (studio 05:31Z) | 2,465 (20 threads) | 2,301 (15 threads, rustai) | studio Hermes agent_support / agent_ops / cj_agent_zara / agent_illustrator assigned; light |
| pro12 | B | Sep 12 09:01:07 | reset credit at ~44% | deactivated Sep 14 | 14% | 842 (8 threads) | 0 | studio Hermes cj_agent_zara / cj_agent_danalyst / cj_agent_coder assigned |
| pro14 | A | Sep 8 12:02:38 | first use (studio read 100% at Sep 8 07:48Z) | Sep 12 13:47:06 reset credit | ~58% (studio 05:46Z) | 3,502 (45 threads) | 1,305 (27 threads) | studio Hermes agent_ops and cj_agent_* assigned |
| pro14 | B | Sep 12 13:47:06 | reset credit at ~58% | deactivated Sep 14 | 3% to 5% | 20 (1 thread, `01a08204`, 4 minutes) | 238 (`01a0931b`, rustai, Sep 14 04:30 to 08:14Z) | cj_agent_zara / cj_agent_coder assigned |
| pro15 | A | Sep 8 ~07:48 | first use (studio read 100% at 07:48Z) | Sep 11 20:47:32 reset credit | 91% (studio 20:30Z) | none matched | none matched | **unidentified**: burned 10% to 91% between Sep 10 16:15Z and Sep 11 20:30Z at a steady 3 points per 30 to 45 minutes while assigned to studio homes whose state.db show zero sessions (cj_agent_arthur_sterling, cj_agent_coder, cj_agent_seo, cj_agent_pilot, cj_agent_writer) |
| pro15 | B | Sep 11 20:47:32 | reset credit at 91% | Sep 13 13:30:57 reset credit | ~12% (studio Sep 11 22:57Z) | 987 (19 threads, `01a08768` home screen + `01a07ea1`) | 0 | |
| pro15 | C | Sep 13 13:30:57 | reset credit | deactivated Sep 14 | 12% | 1,813 (7 threads, SNG orchestrator `01a091fb`) | 0 | |

Reset credits consumed on these accounts inside the four days: pro12 once (Sep 12 04:01 CDT, at ~44%), pro14 once (Sep 12 08:47 CDT, at ~58%), pro15 twice (Sep 11 15:47 CDT at 91%, Sep 13 08:30 CDT at ~12%). None coincides with a watcher keystroke (A12 method); pro15 now has zero resets left.

What ran on them (roots are interactive Codex TUIs on M5 unless noted):

- pro12 A: `01a09341` "ramp up on M1 epic #5605: Skills on one completed puzzle result" 1,757 (its `home_puzzle_mission_settlement` / mission work), `01a0863d` (agentspace) 1,503, `01a080bb` 602; on `home`: `01a081f1` rustai (SNG training) 2,300 on Sep 10 13:03 to 20:55Z, which is exactly when the watcher rotated the rustai panes onto pro12 (nine rotations 15:22 to 16:26Z).
- pro12 B: `01a09a7f` "explain issue 5746" 399, SNG orchestrator `01a091fb` 237, `01a09341` 114, `01a09dbf` "sol agents audit our app for dead experiments" 92. Families: ROOT 808, sng_native_finish 31.
- pro14 A: `01a08204` "read 01a080d3 session end to end" (the cases/missions pipeline orchestrator) 2,169, `01a08b69` 523, `01a08719` 265; on `home`: `01a08175` 415, `01a081f1` rustai 290, `01a0906a` 251 (Sep 8 to 11).
- pro14 B: `01a08204` 20 responses at Sep 12 13:47Z, then only the `home` rustai thread `01a0931b` (238 responses, Sep 14 04:30 to 08:14Z), which was the pane the watcher and Amir were rotating that morning.
- pro15 B: `01a08768` "home screen stuff" 658 and `01a07ea1` 329, Sep 11 20:49 to 23:26Z.
- pro15 C: SNG orchestrator `01a091fb` 1,792 (families sng_system_client_native 551, sng_system_service_tests 314, sng_cursor_repair 262, sng_system_test_inventory 68, sng_system_strategy_repair 63) and `01a09adb` 21, Sep 13 13:31Z to Sep 14 08:33Z.

Nothing puzzle- or lesson-generation shaped ran on any of the three except pro12 A's `01a09341` (M1 epic: skills on a completed puzzle result, a feature build, not content generation).

## B3. Deactivation windows

| account | last successful response | first failure | where |
|---|---|---|---|
| pro12 | Sep 14 03:03:03Z (22:03 CDT Sep 13), M5 `01a09dbf` | 09:51:28Z Redis mark | |
| pro14 | Sep 14 08:14:56Z (03:14 CDT), home `01a0931b` | 09:49:42Z `home` `aim codex run` selected pro14 and failed; 09:51:01Z again | Redis mark 09:51:28Z |
| pro15 | Sep 14 08:33:19Z (03:33 CDT), M5 `01a091fb` | 09:49:14Z `home` selected pro15 and failed; 09:50:32Z, 09:51:11Z, 09:51:27Z again | Redis mark 09:51:28Z |

The watcher's Sep 14 10:00Z note: "CR rotation landed on pro14, pro15, and pro11 - all revoked. Repeated `cr <uuid>` attempts never reattached." pro11 is still `ready`, so "revoked" there was a token problem, not a deactivation.

## B4. Volume per hour

Appendix B1 (M5) and B2 (home) hold the hourly tables per window. Peak hours: pro12 A on M5 Sep 12 01:xxZ to 05:xxZ (the M1 epic orchestrator), pro14 A on M5 Sep 8 to 9 (`01a08204` cases pipeline: cases#_source, quality, copy, strategy, assembly, metadata families ran on pro6/pro16 later on Sep 12, but on pro14 on Sep 8 to 9), pro15 C on M5 Sep 14 04:00Z to 08:33Z (1,792 responses in 4.5 hours, SNG system subagents, 6 to 7 threads at once).

## B5. Hermes holds and Hermes usage

Studio hermes-watch assigned all three to Hermes homes continuously (appendix B3 series shows the assigned agents at every reading). Studio Hermes state.db sessions Sep 8 to 13 for the homes that held pro15 during its unexplained burn: cj_agent_arthur_sterling 0, cj_agent_coder 0, cj_agent_seo 0, cj_agent_pilot 0, cj_agent_writer 0, cj_agent_buyer_experience_sentinel 4 sessions (617k input / 4.9M cache-read / 27k output), cj_agent_support 10 (723k / 3.2M / 29k), agent_ads_analyst 6 (307k / 1.3M / 23k), agent_writer 5 (36k / 15k / 1k). Homes with real volume in that period were on other accounts: agent_ops 59 sessions (4.5M / 50M / 405k), agent_growth_analyst 17 (4.9M / 54M / 353k), cj_agent_zara 40 (7.6M / 175M / 750k). Hermes does not explain pro15 A.

## B6. Watcher rotations onto these accounts

From the watcher transcript (appendix B4 has the dated notes). Sep 10 (UTC): 07:37 pro12 (Gate2 work pane), 10:23 pro14 (`01a0820d` rustai pane, "Resume paused goal? -> Enter"), 11:14 pro14 (planning tracking content/w1Q:p1), 12:55 pro12 (journey strategy growth/w80:p1), 13:10 pro14 (POC embed organic/wT:p1), 14:59 to 16:28 subgame solver rustai/wK:p3 rotated nine times onto pro12 and five onto pro14 while "still at capacity", 22:16 pro12 (identity mismatch bugs/w82:p1). Sep 11: 00:24 pro14 (fees cratejoy/w3:p4), 13:22 to 15:32 rustai panes to pro12 six times, each after a first rotation onto a revoked account (pro13, pro14, coder2). Sep 12: 04:25 pro15 (after boss revoked), 07:14 "boss (FAILED) -> pro15 (worked) -> pro14 (worked, then saturated one sweep later) -> office", 11:15 pro12 (planning tracking). Sep 13: 19:29 pro12 (PVAI PVP). Sep 14 10:00 (05:00 CDT): pro14, pro15, pro11 "all revoked".

## B7. Scripted lanes (`codex exec`) on M5, Sep 8 to 16

The Part A statement "zero codex_exec rollouts" was wrong (a grep with the wrong spacing). Actual inventory, from rollout `originator = codex_exec`:

| day | cwd | threads | responses | window | accounts / windows | what |
|---|---|---|---|---|---|---|
| Sep 8 | psmobile-worktrees/4850-ai-action-server-error-patrol | 1 | 17 | 06:09 to 06:17Z | win Sep 8 06:09 | patrol |
| Sep 8 | website-worktrees/hands2-integration | 4 | 213 | 15:19 to 15:37Z | win Sep 8 11:26 | plan_research, workbook_model, built_review |
| Sep 8, 9 | psagentspace | 2 | 50 | | win Sep 8 01:56 | plan review, SEO cold review |
| Sep 10 | puzzledb-worktrees/precommit-math-owner, puzzledb-probe-case01-2 | 3 | 10 | 02:32 to 02:38Z | win Sep 8 11:15 / 11:26 | brief_author probe |
| Sep 13 | psagentspace | 1 | 178 | 11:49 to 13:39Z | amir_personal | daily-sheet-maintainer |
| Sep 13 | psmobile-worktrees/sng-fixture-ui-5735-review | 1 | 238 | 03:45 to 06:08Z | pro7 | review |
| Sep 14 | psagentspace | 111 | 3,966 | 08:00 to 23:59Z | lessons 1,001, pro17 859, pro4 829, others | 52 "Do not read other row reports or the aggregate audit" (missions requirement row audits), 20 "Do not run Flutter, Dart pub, native builds" reviewers, 19 "PuzzleDB Batch Worker Packet: Intake", 14 backend reviewers, 7 "GPT-5.6 Sol extra-high reviewer" |
| Sep 14 | puzzledb-worktrees/rev2-brief-generator-4732-20260910 (+6 worker dirs) | 27 | 393 | 17:41 to 21:29Z | cfo 129, pro17 123, growth 118 | `puzzledb batch-run` daily-refill-20260914-real, six workers (preflop-cash, flop-tournament, turn-cash, river-bluffcatch, tournament-shortstack, cash-pressure), route sol_author = gpt-5.6-sol low |
| Sep 14 | logan | 1 | 56 | 16:54 to 17:58Z | pro17 | |
| Sep 15 | psagentspace | 157 | 5,372 | 00:00 to 20:38Z | office 1,563, qa 1,320, pro17 1,141, others | 101 "Search only when needed within the named repository" (delegated designers), 47 backend reviewers, daily-sheet-maintainer, disk-cleanup |
| Sep 16 | psmobile-worktrees/home-mvp-consolidated | 9 | 587 | 02:18 to 10:59Z | pro7 214, pro9 199, pro17 136, pro13 27 | Sol implementation workers, learning_facts |
| Sep 16 | psagentspace | 2 | 8 | | pro7, boss | routines |

None of these lanes ran on pro12, pro14, pro15 or amir_elaguizy_fun_country. The `puzzledb` batch runner (`puzzledb/batch_runner/__init__.py`) launches `codex exec` with the default `~/.codex`, so lanes take whatever account aimgr has in auth.json at launch; on Sep 14 that was cfo, pro17 and growth. Lesson generation: no Codex lanes with a lessons-studio cwd in the period; lesson-shaped agent families are `home_lesson_settlement` (Sep 12, 310 responses, pro2), `onboarding_lessons` (Sep 12), `missions_lesson_launch_*` (Sep 16). Puzzle-shaped agent families: `evaluation_repair` 1,144 agents / 5,180 responses on Sep 12 (pro1), `cases#_*` pipeline on Sep 12 (pro6, pro16), `run#_strategy_owner` Sep 14 (pro6), `daily_refill_builder_#` Sep 14 (boss), ten `*_author` agents Sep 15 (illustrator), `missions_#_puzzle` Sep 15 to 16 (this account).

## B8. Repositories by account, Sep 8 to 16 (M5 responses)

psagentspace 366,297 (codex-tui 356,723; codex_exec 9,574); agentspace 47,599; arch_skill 1,827; home-mvp-consolidated 587; herdr 397; rev2-brief-generator 393; sng-fixture-ui 238; hands2-integration 213; aimgr 202; GPT-Image2-Skill 115; logan 56; as2 56. `home` box: rustai 82,601; psagentspace 9,271; rustai-sng-epic-678 39.

## B9. Unresolved

1. pro15 window A (Sep 8 to 11): 80 points of weekly quota consumed from somewhere not scanned. `amir-m3-36gb` is online on the tailnet (100.84.218.85) but ssh and the aim MCP port are closed from here; `claw` refuses the key. Either could hold Codex sessions.
2. Whether the "refresh token revoked" errors on pro13, pro14, coder2, boss, pro11 (Sep 11 to 14) were OpenAI actions or aimgr refresh-token rotation racing harness leases; pro11 and coder2 are `ready` today, so at least those were not deactivations.

## B10. Corrections to Part A

- "0 codex_exec rollouts Sep 1 to 16": wrong. See B7.
- "pro14 had zero Codex traffic on any reachable machine": wrong. pro14 carried 4,807 responses in its Sep 8 to 12 window (M5 3,502 + home 1,305) and 258 in its final window; the final-window volume is what was tiny.
- The Part A "tender" conclusions are unchanged: it never touched this account, and its two reset acceptances were on coder2 and product_growth.

## B11. What the sessions on pro12, pro14 and pro15 were doing

Every session that produced responses on these accounts, profiled from its rollout (M5 unless marked home). "responses" is the session's lifetime count across all accounts it touched; the share on the account in question is in B2. All are interactive Codex TUIs driven by Amir's prompts; none is a scripted lane.

| session | cwd | started | responses (lifetime) | user turns | spawn_agent | tool profile (code-mode calls) | external hosts touched | what it was |
|---|---|---|---|---|---|---|---|---|
| `01a09341` | psagentspace | Sep 11 20:35 CDT | 12,135 | 75 | 117 | exec 10,210; BrowserOS 2,279; figma 19; mobile 26; db 12 | github, share.fun.country, buildkite, chatgpt.com 98, figma, docs.google | "ramp up on M1 epic #5605: Skills on one completed puzzle result", Figma mock review, epic with sub-issues, Pro consultations, build/test |
| `01a0863d` | agentspace (Cratejoy) | Sep 9 07:56 CDT | 12,487 | 29 | 22 | exec 9,065; BrowserOS 3,867; shopify 7 | github, admin.shopify.com 93, chatgpt.com 82, qa16151-my.cratejoy.com, myshopify.com, circleci | Cratejoy Paywhirl paywall QA gates: drives a Shopify QA store through the browser, works "with Pro, Browser OS, ChatGPT web skill", goal-armed |
| `01a080bb` | psagentspace | Sep 8 06:15 CDT | 419 | 10 | 3 | exec 164; BrowserOS 140; mobile 5 | sentry.io, github, buildkite | `$issue-to-pr` #5320 Android startup assertion, Sentry triage, staging build |
| `01a09a7f` | psagentspace | Sep 13 06:20 CDT | 426 | 15 | 0 | figma 196; BrowserOS 157; exec 57; view_image 32 | figma.com | PVP SNG Figma mocks: propose missing UI states, edit Figma components |
| `01a09dbf` | psagentspace | Sep 13 21:29 CDT | 374 | 5 | 4 | exec 340; BrowserOS 97 | github, buildkite, chatgpt.com 7, posthog, slack, codemagic | "sol agents audit our app for dead experiments (clarity pricing)", spec removal, Fable review |
| `01a08204` | psagentspace | Sep 8 12:15 CDT | 11,512 | 84 | 414 | exec 9,600; BrowserOS 1,147; apply_patch 391 | github, chatgpt.com 51, docs.google, buildkite, gtowizard.com 20, holdemresources.net 6 | `$epic-to-prs` on the puzzle cases pipeline (cases#_source / quality / copy / strategy / assembly / metadata families, daily_refill_builder), goal-armed; Amir on Sep 9: "use the Pro2 browseros window for chatgpt, pro1 is rate limited" |
| `01a08b69` | psagentspace | Sep 10 08:02 CDT | 4,829 | 67 | 37 | exec 3,752; BrowserOS 1,478; db 30 | docs.google 175, github, chatgpt.com 58, buildkite, share.fun.country, blog.duolingo.com 24 | Missions system: mission levers spreadsheet, competitor research (Duolingo, Elevate, Strava), epic and issues, `$epic-to-prs`; parent of the Sep 12 `evaluation_repair` burst |
| `01a08719` | psagentspace | Sep 9 11:57 CDT | 6,738 | 22 | 49 | exec 6,033; BrowserOS 554; codex_apps 25 | github, share.fun.country, chatgpt.com 38, upswingpoker.com 22, pokerstars.com | Skills MVP for post-puzzle classification: semantic classes (blind stealing, c-betting), puzzle inventory, handoff doc |
| `01a08768` | psagentspace | Sep 9 13:23 CDT | 20,393 | 167 | 139 | exec 14,365; BrowserOS 3,208; mobile 255; view_image 280; figma 14 | github 584, share.fun.country, 127.0.0.1, buildkite, chatgpt.com 77, docs.google, figma | New home screen / routing layer: iOS sim screenshots, Figma comparison, plan, implement, later P1 issue-to-PR dispatch; the "learn screen" pane the watcher tracked |
| `01a07ea1` | psagentspace | Sep 7 20:28 CDT | 4,930 | 117 | 13 | exec 3,497; BrowserOS 1,583; mobile 165; db 14 | github 446, sentry.io 80, buildkite, dev.appsflyer.com, codemagic | Staging build of psmobile + rustai, overnight autonomous staging test, Sentry triage, AppsFlyer, gh-issue-filing |
| `01a09adb` | psagentspace | Sep 13 08:01 CDT | 59 | 2 | 0 | exec 84; BrowserOS 42 | docs.google, github | GWS spreadsheet analysis; "types of usage gates on puzzles" tab |
| `01a091fb` | psagentspace | Sep 11 14:39 CDT | 13,952 | 105 | 400 | exec 9,946; BrowserOS 1,857; figma 290; view_image 362; mobile 100 | github 457, share.fun.country 400, figma 189, chatgpt.com 70, docs.google | PVP / play-vs-AI SNG feature: 2P/3P lobby spec with Pro, Figma mockups, implementation, `sng_system_*` subagent fan-out, Fable/Pro sign-off |
| `01a081f1` (home) | rustai | Sep 8 11:54 CDT | 12,480 | 18 | 48 | exec 8,300; BrowserOS 1,571; code_review_graph 13 | github, chatgpt.com 18, buildkite | rustai epic via `$epic-to-prs`, goal-armed, "use Pro2 window for Pro access"; the rustai SNG training pane |
| `01a08175` (home) | rustai | Sep 8 09:39 CDT | 257 | 2 | 4 | exec 193 | none | ramp-up on a devolved session, diagnose-and-solve plan with Pro |
| `01a0906a` (home) | rustai | Sep 11 07:21 CDT | 1,507 | 52 | 12 | exec 796; BrowserOS 267 | github, chatgpt.com, buildkite | ramp-up on `01a0820d`, HU SNG training test plan with Pro |
| `01a0931b` (home) | rustai | Sep 11 19:53 CDT | 4,275 | 91 | 9 | exec 3,712; BrowserOS 773; code_review_graph 9 | github, docs.google 74, chatgpt.com 39, pokertracker docs, holdemmanager docs | HU SNG training: deconfound cash vs SNG, plan and run training; the pane rotated onto pro14 Sep 14 04:30Z |
| `01a0820d` (home) | rustai | Sep 8 12:25 CDT | 2,742 | 24 | 6 | exec 1,945; BrowserOS 871; apply_patch 308 | github, chatgpt.com 31, buildkite, cloud.google.com | training plan via `$epic-to-prs`, training VMs, Fable reviews (Amir: "you're way overdoing Fable") |

Common shape across all of them: coding and product work on Amir's own repos (psagentspace, agentspace, rustai), goal-armed long-running loops with 3 to 8 subagents at a time, Buildkite/GitHub/Sentry/Figma/Google Sheets access through BrowserOS or CLIs, and Pro consultations through the ChatGPT web UI in Chrome (chatgpt.com appears in the code of 15 of the 17 sessions; Amir's own instruction on Sep 9: "use the Pro2 browseros window for chatgpt, pro1 is rate limited"). No web search calls. No email, no scraping of third-party sites beyond reading vendor docs and a Shopify QA store the team owns.

Term scan (same list as Part A) over these rollouts: "exploit" counts (693 in `01a08719`, 360 to 371 in the rustai sessions) are the poker term "exploitative strategy"; "password" and "credential" counts in `01a0863d` (960 / 3,976) are the Shopify QA store logins and credential-handling rules in the Cratejoy agent skills; "captcha" and "bypass" are the BrowserOS skill rules; "nmap", "ddos", "nsfw" are substrings inside base64 image data ("unmapped", etc.). Nothing that reads as policy-violating content. (Context samples: appendix B7.)

## B12. Reconciliation: does the seen volume explain each window's usage?

Calibration from Part A: on this workload 8,961 responses consumed 100% of fun_country's weekly window (about 90 responses per point).

| account / window | used at end (studio) | responses seen (M5 + home) | implied share seen | verdict |
|---|---|---|---|---|
| pro12 A | 44% | 2,465 + 2,301 = 4,766 | ~53% | accounted for |
| pro12 B | 14% (Sep 14 00:59Z 13%) | 842 | ~9% | accounted for |
| pro14 A | 58% | 3,502 + 1,305 = 4,807 | ~53% | accounted for |
| pro14 B | 3% to 5% | 20 + 238 = 258 | ~3% | accounted for |
| pro15 A | 91% | 0 | 0% | **not accounted for**: ~8,000 responses' worth from a machine not scanned (m3-36gb or claw) or a consumer outside Codex CLI |
| pro15 B | ~12% | 987 | ~11% | accounted for |
| pro15 C | 12% | 1,813 | ~20% | accounted for (rate varies with cache hit ratio) |

Browser-driven ChatGPT under these accounts' own logins: none found on M5 or home (zero page reads showing pro12@, pro14@ or pro15@fun.country Sep 8 to 14). Their Chrome profiles (29, 31, 32) exist but were not seen in use.

Hermes (studio) sessions on homes assigned to these accounts Sep 8 to 13: small (B5). Watcher rotations onto them: B6. aimgr `aim codex use` selections that touched them on the `home` box: the Sep 14 04:49 to 04:54 CDT burst only (appendix B6).

---

# Part C: ranked causes, with rationale

Written after Parts A and B. The ranking weighs three things: what all four deactivated accounts share, what separates them from the 27 pool accounts that are still `ready`, and what the deactivation timing says about how OpenAI detected it.

## C0. The constraints any explanation has to satisfy

1. Four accounts in one pool went down in two batches: pro12, pro14, pro15 between 08:33Z and 09:49Z on Sep 14; fun_country between 07:14Z and 09:38Z on Sep 16. Both inside a 07:00Z to 10:00Z band (02:00 to 05:00 CDT, midnight to 03:00 Pacific). Nothing else in the data happens at that hour on both days. That is the signature of a scheduled batch job acting on features aggregated over a lookback window, not a real-time trip-wire.
2. No content anywhere: every session on all four accounts is coding and product work on Amir's own repositories; term scans resolve to poker vocabulary, QA environment variables, skill rules and base64 image data.
3. Per-account volume does not separate the four from the rest. fun_country was the heaviest single burn in the period, but cfo, coder, coder2, pro8, amir_personal, pro16 were driven to 100% in comparable time and are still ready; pro14 and pro15 were barely used in their final windows (5% and 12%).
4. No single feature in the collected data isolates the four: watcher rotations, reset credits, revoked-token churn, Hermes exposure, two-machine concurrency and browser automation each touch banned and unbanned accounts alike. Whatever OpenAI keyed on is either cluster-level, or lives in data this audit cannot see (account creation and payment metadata, the unreachable `amir-m3-36gb` and `claw` hosts, the unidentified consumer of pro15's first window).

## C1. Ranked

**1. Pool-level detection: one operator running ~31 ChatGPT Pro accounts as a rotating quota pool with automation. Likelihood: high.**
Rationale: it is the only thing all four accounts share that is also a standard enforcement category (multiple accounts, circumventing usage limits, account sharing). The linkage OpenAI can see is dense: all 31 accounts log in from the same few machines and IPs; every token is refreshed from one host (M3 auth-maintainer, tens of thousands of maintenance lines, thousands of failed refreshes on some labels); the studio polls every account's usage every 5 minutes, 288 times a day; sessions hop accounts under a running process; the same account is drained from two machines at once (cfo, illustrator and a Sep 14 window show identical fingerprints on M5 and `home` at the same hours); 20 reset credits were consumed in four days, mostly at 90 to 100%; every account has a Chrome profile logged into ChatGPT on the same Mac; the labels themselves (pro1 to pro17) read as a farm. The nightly batch timing fits a linkage or fraud model run rather than a per-request rule, and the fact that the four are not distinguishable from the other 27 by any behavior in this audit is what a cluster-level action with staged or sampled enforcement looks like. Prediction if this is right: more of the 27 go down in the same 07:00Z to 10:00Z window on later nights, regardless of what they were doing that day.

**2. Third-party clients using the ChatGPT subscription OAuth (Hermes fleet on the studio; possibly OpenClaw on `claw`). Likelihood: medium, and probably a component of 1 rather than a separate cause.**
Rationale: aimgr writes these accounts' OAuth tokens into Hermes agent homes, and the Hermes gateway processes (a non-OpenAI harness) call the Codex backend with them; OpenAI restricts subscription OAuth to its own clients and has enforced against third-party harnesses. The banned accounts had Hermes traffic: pro12 was held by agent_ops (59 sessions, 4.5M input / 50M cache-read tokens Sep 8 to 13) on Sep 9 to 10, pro14 by agent_ops on Sep 10 to 11 and cj_agent_zara on Sep 13 to 14, fun_country by agent_ads_analyst on Sep 12. But the fleet rotates through all 30 accounts, so exposure is not unique to the four, and the volume on the banned accounts was small. The `claw` host (OpenClaw; aimgr has `aim rebalance openclaw` and per-machine OpenClaw assignment state) could not be checked; if pooled accounts are assigned to OpenClaw agents there, this moves up.

**3. Refresh-token churn that looks like credential sharing or compromise. Likelihood: medium-low as a trigger, likely part of the linkage in 1.**
Rationale: aimgr's maintainer and long-lived Codex processes hold the same refresh tokens; rotation by one invalidates the other, producing "Your access token could not be refreshed because your refresh token was revoked" (watcher: coder2, pro13, pro14 on Sep 11, boss on Sep 12 and 14, pro11, pro14, pro15 on Sep 14) and 401 "invalidated oauth token" storms on this Mac (238, 303, 154, 64 per day Sep 13 to 16, up to 146 in one hour). Repeated use of revoked tokens from several hosts is a classic account-compromise signal. Against it: coder2, pro13, boss and pro11 showed the same symptom and are still ready; the M3 maintainer's failed-refresh champions (amir_personal 24,856 lines, pro4, qa, cfo) are still ready.

**4. Reset credits consumed and immediately re-burned. Likelihood: medium for fun_country, low for the other three.**
Rationale: fun_country used a free reset at Sep 12 05:43 and again at Sep 15 17:39 (at 90%, mid-flight), then hit 100% within 8.3 hours and was deactivated that night; pro15 used two resets in 40 hours and has none left. That pattern ("reset, 100% in hours, repeat") is legible and fits the fun_country timing exactly. Against it: pro12 and pro14 used one reset each at 44% and 58% and then used little; ten still-ready accounts have zero resets left, several after the same burn-and-reset shape (cfo twice on Sep 14).

**5. Volume and parallelism of the Codex sessions (agentic fan-out). Likelihood: low on its own.**
Rationale: fun_country's final night was 8,961 responses in 8.6 hours with 3 to 8 subagents active, 1.2B input tokens, and it was banned that night; that is the strongest single-account signal in the data. But the identical pattern on cfo the night before (4,602 responses, 0% to 100%, same orchestrator) and on coder, coder2, pro8, amir_personal (100% burns) drew nothing, and pro14 and pro15 were nearly idle in their final windows. Volume is at most the thing that made fun_country the next pick, not the reason the pool is being acted on.

**6. Browser automation of chatgpt.com. Likelihood: very low for these four.**
Rationale: heavy (226, 136, 163, 84 browser calls to chatgpt.com per day Sep 12 to 15, 30 to 132 conversations a day) but under amir@fun.country, pro4 and pro1, none of which is deactivated; the four banned logins were never seen driven in a browser. If web automation were the trigger, amir@fun.country would have gone first. It remains a live risk for those three accounts.

**7. Content. Likelihood: very low.**
Rationale: no policy-relevant content found in any session on the four accounts (B11, B7, section 9).

**8. Scripted puzzle or lesson generation. Likelihood: very low for these four.**
Rationale: the scripted lanes that ran (puzzledb daily-refill on Sep 14, delegated Sol reviewers on Sep 14 and 15, home-mvp workers on Sep 16) used lessons, pro17, pro4, office, qa, cfo, growth, pro7 and pro9, none of which is banned; the Sep 12 `evaluation_repair` burst ran on pro1 (ready). The only generation-shaped work on a banned account was pro14 carrying the cases pipeline orchestrator on Sep 8 to 9, at ordinary volume.

## C2. What would change the ranking

- If more pool accounts are deactivated in the 07:00Z to 10:00Z window over the next nights with no notable activity the day before, 1 is confirmed and 2 to 5 are just how OpenAI picks the order.
- If pro12, pro14 and pro15 were created in one batch with one payment method and fun_country shares that method, creation/payment linkage inside 1 is the specific mechanism.
- If `claw` or `amir-m3-36gb` turn out to run OpenClaw or Hermes agents on pooled accounts, and in particular if either was the consumer of pro15's first window (80 quota points, no session found anywhere reachable), 2 moves to first.
- If OpenAI's appeal response names a category ("cyber abuse", "account sharing", "circumventing limits"), it maps directly: account sharing or limit circumvention confirms 1; cyber abuse would point at the revoked-token churn in 3 or the QA-store browser work in `01a0863d` on pro12, which this audit found benign.

---

# Part D: the behaviors, ranked by risk from a capacity-protection standpoint (first pass; see D2 for the corrected order)

Premise: multiple accounts per person are permitted; the same handful of IPs is unavoidable. The question is which observed behaviors defeat or abuse the per-account rate limit that OpenAI uses to protect capacity, and how visible each one is server-side. Every item cites where in this document the behavior is measured.

| rank | behavior | what OpenAI sees | evidence here | why it ranks here |
|---|---|---|---|---|
| 1 | Moving a running session to another account when the current one is capped or saturated (aimgr `next_best` on `aim codex run/resume`; the watcher's `cr` rotations on "at capacity") | The same Codex thread id continues under a new account seconds after the old one hit its limit. Codex sends the thread id as the server-side prompt cache key on every request, so the hop is linkable without any IP analysis, and the timing (account A limited at T, account B starts at T+10s with the same thread) is the textbook definition of circumventing a limit. | `01a08768` alone appears on 15+ weekly windows in eight days (A3, B5); `01a09fa4` on four; watcher rotation log (B6, appendix B4); `home` history 14 launches in 5 minutes (appendix B6) | Rate limits are the capacity control; this is the one behavior whose purpose is to defeat them, and it is the most legible one in the request stream. |
| 2 | Automated retry and rotation during capacity errors ("Selected model is at capacity") | Bursts of new-account logins and requests aimed at a model tier precisely while it is overloaded, from one operator. | Watcher: 815 / 835 / 965 capacity sightings per day Sep 10 to 12, ~2,000 sweeps a day, "nine failed rotations across pro12/pro13/pro14" inside one hour on Sep 10 (A6, B6); `home` box burst Sep 14 04:49 to 04:54 | This is literally load added at the moment they are protecting capacity. Low token cost per attempt, but it is the behavior a capacity team would single out. |
| 3 | Consuming free reset credits and re-burning 100% right after | An account that used a goodwill reset and then consumed a full week's quota in 8 hours, repeatedly, across a pool. | 20 resets in four days (A12); fun_country twice with 100% in 8.3 h after the second (A2); pro15 twice in 40 h; ten accounts now at zero resets (A1) | Converts a capacity allowance meant for one stuck user into 2 to 3 weekly quotas per account. Very legible per account. |
| 4 | Third-party harnesses on the subscription OAuth (Hermes fleet on the studio; possibly OpenClaw on `claw`) | Requests to the Codex backend from a client that is not Codex, carrying a ChatGPT subscription token, on 30 rotating accounts. | Studio hermes-watch assignments for every account (A8, B5); agent_ops 59 sessions, agent_growth_analyst 17, cj_agent_zara 40 in Sep 8 to 13 | Policy breach independent of volume; subscription capacity is priced for OpenAI's own clients. Volume on the banned accounts was small, which is why it is 4 and not 1. |
| 5 | Driving the ChatGPT web UI with a browser automation tool (Pro consultations, connectors, 3 to 5 minute generations) | Scripted CDP traffic to chatgpt.com under a login, dozens of conversations a day. | 226 / 136 / 163 / 84 browser calls per day, 132 / 80 / 75 / 33 conversations, under amir@fun.country, pro4, pro1 (A7) | Explicitly prohibited (programmatic access to ChatGPT outside the API) and the requests are the most expensive kind (GPT-6 Pro with connectors). Not what took these four accounts; the exposed logins are the three above. |
| 6 | Refresh-token churn from multiple holders (M3 auth-maintainer plus long-lived Codex processes rotating the same refresh token) | "Refresh token revoked" errors, dead access tokens retried for hours, thousands of failed refreshes from one host. | 401 storms 238 / 303 / 154 / 64 per day, 146 in one hour (appendix A9); watcher notes on coder2, pro13, pro14, boss, pro11, pro15; maintainer `maintenance_failed` 24,856 lines on amir_personal, 5,722 pro4, 4,756 qa, 3,860 cfo (section 8) | Reads as credential sharing or compromise to a security system; also pure wasted traffic. Not a capacity signal, but it is what turns a usage question into a security flag. |
| 7 | One account drained from two machines at the same time by automated sessions | Two concurrent agentic workloads on one account from two devices. | M5 and `home` fingerprints overlap for cfo, illustrator and the Sep 14 01:17Z window at the same hours (A3, B5) | A person on two machines is normal; two unattended orchestrators on one account is the "account sharing" shape. |
| 8 | Bulk usage polling: every `aim codex use` reads all 31 accounts' rate limits, and the studio does it every 5 minutes | 31 accounts' rate-limit endpoints hit from one IP in the same second, ~288 times a day, plus bursts (8 selections in 31 minutes on Sep 16, 14 in 5 minutes on Sep 14 on `home`). | local-state histories (appendix A9, B6), studio hermes-watch cadence (A8) | Negligible load, maximal linkage: it hands over the full account list as one cluster. |
| 9 | Sustained fan-out per account: 3 to 8 subagents at once, 1,000 to 1,500 responses an hour, 1.2B input tokens a night | The load itself. | A2, A4, B4 | Within the limits by construction; this is what the plan sells. It is the reason the other behaviors matter, not an offense on its own, and identical burns on cfo, coder, coder2, pro8 drew nothing. |
| 10 | Idle Codex TUIs kept alive for days polling rate limits, some with dead tokens | Steady metadata polling every 5 to 30 s from 18 processes, hundreds of failed reads. | pid 96186 idle since Sep 13 with 257 failed reads on Sep 16; 18 Codex processes alive (appendix A9) | Noise. Cheap for them, but it keeps dead accounts in view. |

Not on the list because the data does not support them as capacity or policy signals: content of the sessions (section 9, B11), scripted puzzle or lesson generation (B7), the specific repositories worked on.

One structural note outside the ranking: the account that matters to you (amir.elaguizy@fun.country) sat in the same pool and did 1, 3 and 6 like the rest; the cost of a pool action lands on whichever accounts are in it.

## D2. Re-ranking by observed enforcement (supersedes the table above)

The first table weighted what is prohibited on paper alongside what has drawn enforcement. Two facts pulled after Amir's objection change the order:

1. Browser automation of chatgpt.com has run at scale for the whole month with no action on the driven logins: browser-and-chatgpt lines per day on this Mac Sep 1 to 11 were 163, 0, 179, 4,268, 5,702, 1,954, 3,305, 4,442, 7,451, 2,558, 3,676, with 31, 0, 69, 202, 284, 150, 258, 279, 409, 156, 204 distinct conversations, then 132, 80, 75, 33, 30 on Sep 12 to 16. About 3,000 conversations in 16 days under amir@fun.country, pro4 and pro1, all still active. Whatever OpenAI is enforcing, it is not this, at least not yet.
2. The heaviest third-party (Hermes) home on the studio, agent_ops (59 sessions Sep 8 to 13), spent its time since Sep 7 on pro7 24%, pro14 18%, boss 15%, coder 14%, pro12 13%, office 10%, fun_country 5%: three of the four deactivated accounts are among its seven main holders (43%, against a 13% base rate of 4 banned in 31). cj_agent_zara (40 sessions): boss 23%, pro12 16%, pro16 11%, pro7 9%, office 8%, pro14 8%. cj_agent_support and agent_ads_analyst held pro15 4% each. Small numbers, but it is the most enriched signal in the audit.

Enrichment of each behavior among the four deactivated accounts versus the pool (share of the behavior's accounts that were banned; base rate 4/31 = 13%):

| behavior | accounts showing it in the week before | of which deactivated | enrichment |
|---|---|---|---|
| held by the heaviest Hermes home (agent_ops top 7) | pro7, pro14, boss, coder, pro12, office, fun_country | 3 | 43% |
| reset credit consumed (A12, 20 events) | 6 of 20 events on banned accounts | pro12, pro14, pro15 x2, fun_country x2 | 30% of events, 2.3x base |
| "refresh token revoked" noted by the watcher | coder2, pro13, pro14, boss, pro11, pro15 | pro14, pro15 | 33% |
| watcher rotation target Sep 10 to 15 | ~20 accounts | pro12, pro14, pro15 | 15% |
| driven to 95%+ weekly by this Mac (A3) | ~25 accounts | 4 | 16% |
| drained from two machines at once | cfo, illustrator, pro12, pro14, window Sep 14 01:17Z, others | pro12, pro14 | ~20% |
| browser automation under the account's own login | amir@fun.country, pro4, pro1 | 0 | 0% |
| bulk usage polling, idle rate-limit polling | all 31 | 4 | 13% (base rate) |

Re-ranked, observed enforcement first, paper prohibition second:

1. **Limit-driven account hopping under a running session.** Present for all four, it is the core of what rate limits exist to prevent, and the thread id travels with the request as the prompt cache key.
2. **Consuming reset credits and re-burning.** All four used at least one reset within four days of deactivation; banned accounts are 2.3x over-represented among reset events; fun_country's second reset preceded its ban by nine hours.
3. **Third-party harness traffic (Hermes; possibly OpenClaw on `claw`).** Highest enrichment in the data (3 of agent_ops's 7 accounts), policy breach independent of volume, and the one machine that could not be inspected runs exactly this kind of client.
4. **Automated retry and rotation during capacity errors.** Sep 10 to 12 for pro12, pro14 and pro15 via the watcher; the Sep 14 04:49 burst on `home` hit pro14 and pro15 minutes before the mark. Not present for fun_country.
5. **Refresh-token churn from multiple holders.** Two of the six accounts the watcher saw revoked were deactivated; the shape is a security flag, not a capacity one.
6. **Two unattended workloads draining one account from two machines.** pro12 and pro14 in their first windows; not fun_country's final window.
7. **Bulk usage polling and idle rate-limit polling.** Pure linkage; base-rate enrichment.
8. **Per-account fan-out volume.** 100% burns on many unbanned accounts; no enforcement correlation.
9. **Browser automation of chatgpt.com.** Prohibited on paper; zero enforcement after ~3,000 conversations in 16 days on three logins. Ranked by what has happened, it belongs at the bottom; it stays on the list only because the paper risk is real and the three logins that carry it are the ones you use by hand.

Caveat on all enrichment figures: four events against thirty-one accounts. A 43% figure is three accounts. These numbers say where to look, not what happened.

---

# Appendix B: raw evidence for pro12, pro14, pro15

## B1. Hourly tables, this Mac (M5)

### pro12 on this Mac (M5)

**window A (Sep 8 11:15:42Z to reset Sep 12 09:01:07Z)**: responses 2,465; threads 20; used 0% to 45%; first 2026-09-08T11:15:57.682Z; last 2026-09-12T05:53:31.861Z; uncached input 7,157,758; cached input 299,360,384; output 496,980

roots: 01a09341-5d4a: 1757, 01a080bb-0f1f: 602, 01a08ce5-ba27: 51, 01a08204-90bb: 35, 01a08929-2f15: 9, 01a08b5e-4bb6: 3

cwd: psagentspace: 2451, precommit-math-owner-20260905: 9, agentspace: 5

families: ROOT: 1510, m1_flutter_ramp: 269, m1_backend: 188, m1_unblocker: 150, m1_backend_review_fixes: 129, android_startup_retry: 97, causal_reproduction: 81, m1_flutter_review_fix: 20, studio_fast: 14, android_startup: 5, brief_author: 2

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-08T11Z | 130 | 0 to 2 | 3 |
| 2026-09-08T12Z | 282 | 2 to 4 | 3 |
| 2026-09-08T13Z | 190 | 4 to 6 | 2 |
| 2026-09-10T02Z | 9 | 6 to 7 | 2 |
| 2026-09-10T07Z | 2 | 7 to 7 | 1 |
| 2026-09-10T10Z | 2 | 7 to 7 | 1 |
| 2026-09-10T12Z | 3 | 7 to 7 | 1 |
| 2026-09-10T22Z | 51 | 27 to 28 | 1 |
| 2026-09-10T23Z | 1 | 28 to 28 | 1 |
| 2026-09-11T09Z | 35 | 28 to 29 | 2 |
| 2026-09-11T11Z | 1 | 29 to 29 | 1 |
| 2026-09-11T12Z | 2 | 29 to 29 | 1 |
| 2026-09-12T01Z | 73 | 29 to 30 | 1 |
| 2026-09-12T02Z | 659 | 30 to 34 | 4 |
| 2026-09-12T03Z | 414 | 34 to 37 | 4 |
| 2026-09-12T04Z | 417 | 37 to 42 | 4 |
| 2026-09-12T05Z | 194 | 42 to 45 | 3 |

**window B, current (Sep 12 09:01:07Z)**: responses 842; threads 8; used 0% to 14%; first 2026-09-12T10:30:12.475Z; last 2026-09-14T03:03:03.428Z; uncached input 3,123,076; cached input 112,391,296; output 230,078

roots: 01a09a7f-af0a: 399, 01a091fb-675c: 237, 01a09341-5d4a: 114, 01a09dbf-7109: 92

cwd: psagentspace: 842

families: ROOT: 808, sng_native_finish: 31, flags_inventory: 1, monetization_audit: 1, flags_inventory_retry: 1

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-12T10Z | 87 | 0 to 1 | 1 |
| 2026-09-12T11Z | 27 | 1 to 2 | 1 |
| 2026-09-13T11Z | 34 | 2 to 3 | 1 |
| 2026-09-13T12Z | 83 | 3 to 4 | 1 |
| 2026-09-13T13Z | 192 | 4 to 7 | 1 |
| 2026-09-13T14Z | 20 | 7 to 7 | 1 |
| 2026-09-13T15Z | 69 | 7 to 9 | 1 |
| 2026-09-13T16Z | 1 | 9 to 9 | 1 |
| 2026-09-13T17Z | 168 | 9 to 11 | 2 |
| 2026-09-13T18Z | 69 | 11 to 12 | 1 |
| 2026-09-14T02Z | 80 | 13 to 14 | 4 |
| 2026-09-14T03Z | 12 | 14 to 14 | 1 |


### pro14 on this Mac (M5)

**window A (Sep 8 12:02:38Z)**: responses 3,502; threads 45; used 0% to 59%; first 2026-09-08T12:02:52.000Z; last 2026-09-12T06:21:09.466Z; uncached input 14,939,859; cached input 416,334,464; output 1,021,840

roots: 01a08204-90bb: 2169, 01a08b69-6882: 523, 01a08719-fa5a: 265, 01a080e5-f1d8: 177, 01a091f7-8733: 163, 01a0908c-bd19: 140

cwd: psagentspace: 3500, agentspace: 2

families: ROOT: 2509, strategy_case#: 266, heads_up_evidence_probe: 133, b#_semantic_repair: 75, b#_source_authoring: 70, rev2_ci_finish: 41, eval_repair_#: 40, clean_answer_audit: 39, navigation_fix: 38, b#_successor_repair: 37, glossary_product_repair: 36, case#_fresh_answer_audit: 36

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-08T12Z | 176 | 0 to 1 | 4 |
| 2026-09-08T13Z | 1 | 1 to 1 | 1 |
| 2026-09-10T10Z | 5 | 6 to 6 | 1 |
| 2026-09-10T11Z | 260 | 6 to 8 | 7 |
| 2026-09-10T13Z | 38 | 8 to 8 | 3 |
| 2026-09-10T17Z | 21 | 9 to 10 | 1 |
| 2026-09-11T00Z | 2 | 11 to 11 | 1 |
| 2026-09-11T09Z | 99 | 12 to 13 | 2 |
| 2026-09-11T10Z | 180 | 13 to 16 | 1 |
| 2026-09-11T11Z | 259 | 16 to 20 | 3 |
| 2026-09-11T12Z | 4 | 22 to 23 | 1 |
| 2026-09-11T13Z | 132 | 23 to 26 | 2 |
| 2026-09-11T14Z | 250 | 26 to 32 | 5 |
| 2026-09-11T15Z | 660 | 32 to 40 | 6 |
| 2026-09-11T16Z | 366 | 40 to 45 | 6 |
| 2026-09-11T17Z | 121 | 45 to 47 | 2 |
| 2026-09-11T19Z | 57 | 47 to 48 | 1 |
| 2026-09-11T20Z | 49 | 48 to 49 | 1 |
| 2026-09-11T21Z | 242 | 49 to 53 | 1 |
| 2026-09-12T01Z | 7 | 53 to 53 | 1 |
| 2026-09-12T02Z | 50 | 53 to 54 | 1 |
| 2026-09-12T04Z | 137 | 54 to 55 | 8 |
| 2026-09-12T05Z | 285 | 55 to 58 | 15 |
| 2026-09-12T06Z | 101 | 58 to 59 | 1 |

**window B, current (Sep 12 13:47:06Z)**: responses 20; threads 1; used 0% to 0%; first 2026-09-12T13:47:07.626Z; last 2026-09-12T13:51:34.895Z; uncached input 295,842; cached input 1,327,360; output 7,140

roots: 01a08204-90bb: 20

cwd: psagentspace: 20

families: ROOT: 20

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-12T13Z | 20 | 0 to 0 | 1 |


### pro15 on this Mac (M5)

**window B (Sep 11 20:47:32Z)**: responses 987; threads 19; used 0% to 14%; first 2026-09-11T20:49:15.933Z; last 2026-09-11T23:26:00.323Z; uncached input 3,378,161; cached input 115,307,136; output 394,901

roots: 01a08768-d214: 658, 01a07ea1-a586: 329

cwd: psagentspace: 987

families: ROOT: 440, appsflyer_observability_impl: 329, home_engine_#: 24, balanced_luna_a2: 17, home_client_#: 17, balanced_luna_b5: 16, home_replay_#: 16, balanced_luna_b3: 14, balanced_luna_b4: 14, balanced_luna_b2: 12, full_luna_b1: 11, full_luna_b7: 11

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-11T20Z | 33 | 0 to 1 | 1 |
| 2026-09-11T21Z | 342 | 1 to 5 | 15 |
| 2026-09-11T22Z | 379 | 6 to 12 | 2 |
| 2026-09-11T23Z | 233 | 12 to 14 | 5 |

**window C, current (Sep 13 13:30:57Z)**: responses 1,813; threads 7; used 0% to 12%; first 2026-09-13T13:31:11.950Z; last 2026-09-14T08:33:19.847Z; uncached input 5,428,592; cached input 236,833,152; output 607,671

roots: 01a091fb-675c: 1792, 01a09adb-5534: 21

cwd: psagentspace: 1813

families: ROOT: 555, sng_system_client_native: 551, sng_system_service_tests: 314, sng_cursor_repair: 262, sng_system_test_inventory: 68, sng_system_strategy_repair: 63

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-13T13Z | 21 | 0 to 0 | 1 |
| 2026-09-14T03Z | 1 | 0 to 0 | 1 |
| 2026-09-14T04Z | 277 | 0 to 3 | 2 |
| 2026-09-14T05Z | 276 | 3 to 5 | 3 |
| 2026-09-14T06Z | 374 | 5 to 8 | 5 |
| 2026-09-14T07Z | 682 | 8 to 12 | 4 |
| 2026-09-14T08Z | 182 | 12 to 12 | 1 |


## B2. Hourly tables, home box


### pro12 on the home box

**window A (Sep 8 11:15:47Z)**: responses 2,301; threads 15; used 7% to 27%; first 2026-09-10T13:03:36.317Z; last 2026-09-10T20:55:12.097Z; uncached input 9,181,344; cached input 307,850,240; output 456,488

roots: 01a081f1-06bd: 2300, 01a0820d-9a9d: 1

cwd: rustai: 2301

families: ROOT: 1183, root: 1118

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-10T13Z | 1 | 7 to 7 | 1 |
| 2026-09-10T14Z | 3 | 7 to 7 | 1 |
| 2026-09-10T15Z | 39 | 7 to 7 | 3 |
| 2026-09-10T16Z | 151 | 7 to 9 | 1 |
| 2026-09-10T17Z | 607 | 9 to 15 | 6 |
| 2026-09-10T18Z | 555 | 15 to 19 | 4 |
| 2026-09-10T19Z | 527 | 19 to 23 | 4 |
| 2026-09-10T20Z | 418 | 23 to 27 | 6 |

**window B, current**: no responses on home


### pro14 on the home box

**window A (Sep 8 12:02:42Z)**: responses 1,305; threads 27; used 1% to 29%; first 2026-09-08T14:40:08.649Z; last 2026-09-11T14:35:08.251Z; uncached input 8,864,850; cached input 158,770,688; output 320,452

roots: 01a08175-9f5e: 415, 01a081f1-06bd: 290, 01a0906a-c125: 251, 01a0820d-9a9d: 249, 01a08279-9a65: 100

cwd: rustai: 1205, psagentspace: 100

families: ROOT: 940, root: 365

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-08T14Z | 105 | 1 to 2 | 2 |
| 2026-09-08T15Z | 308 | 2 to 5 | 5 |
| 2026-09-08T16Z | 2 | 5 to 5 | 1 |
| 2026-09-10T10Z | 18 | 6 to 6 | 2 |
| 2026-09-10T15Z | 58 | 9 to 9 | 5 |
| 2026-09-10T16Z | 16 | 9 to 9 | 1 |
| 2026-09-10T23Z | 8 | 10 to 10 | 2 |
| 2026-09-11T00Z | 97 | 10 to 11 | 3 |
| 2026-09-11T02Z | 2 | 11 to 11 | 1 |
| 2026-09-11T06Z | 43 | 11 to 11 | 2 |
| 2026-09-11T09Z | 55 | 12 to 13 | 2 |
| 2026-09-11T10Z | 55 | 11 to 16 | 2 |
| 2026-09-11T11Z | 148 | 16 to 21 | 3 |
| 2026-09-11T12Z | 148 | 21 to 23 | 4 |
| 2026-09-11T13Z | 122 | 24 to 27 | 9 |
| 2026-09-11T14Z | 120 | 26 to 29 | 3 |

**window B, current**: responses 238; threads 1; used 1% to 5%; first 2026-09-14T04:30:10.947Z; last 2026-09-14T08:14:56.293Z; uncached input 559,684; cached input 44,212,480; output 13,448

roots: 01a0931b-1d9d: 238

cwd: rustai: 238

families: ROOT: 238

| hour (UTC) | responses | used % | threads |
|---|---|---|---|
| 2026-09-14T04Z | 32 | 1 to 1 | 1 |
| 2026-09-14T05Z | 62 | 1 to 3 | 1 |
| 2026-09-14T06Z | 65 | 3 to 4 | 1 |
| 2026-09-14T07Z | 65 | 4 to 5 | 1 |
| 2026-09-14T08Z | 14 | 5 to 5 | 1 |


### pro15 on the home box

**window B (Sep 11 20:47:32Z)**: no responses on home

**window C, current**: no responses on home


## B3. Studio 5-minute readings (remaining weekly %, assigned Hermes agents), Sep 7 to 14

```
=== pro12: 1058 readings
  2026-09-07T00:04:21Z remaining= 51% agents=['cj_agent_danalyst']
  2026-09-07T02:15:28Z remaining= 51% agents=['cj_agent_coder']
  2026-09-07T02:30:37Z remaining= 51% agents=['cj_agent_writer']
  2026-09-07T10:35:51Z remaining= 51% agents=['cj_agent_seo']
  2026-09-07T11:01:01Z remaining=100% agents=['cj_agent_coder']
  2026-09-07T11:21:09Z remaining=100% agents=['cj_agent_arthur_sterling']
  2026-09-07T13:17:09Z remaining=100% agents=['agent_support']
  2026-09-08T22:26:11Z remaining= 94% agents=['agent_support']
  2026-09-09T11:41:42Z remaining= 94% agents=['agent_ops']
  2026-09-09T17:00:06Z remaining= 98% agents=['agent_ops']
  2026-09-10T03:09:24Z remaining= 93% agents=['agent_ops']
  2026-09-10T16:15:31Z remaining= 93% agents=['cj_agent_zara']
  2026-09-10T17:11:11Z remaining= 90% agents=['cj_agent_zara']
  2026-09-10T17:31:22Z remaining= 87% agents=['cj_agent_zara']
  2026-09-10T17:56:37Z remaining= 85% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T18:42:09Z remaining= 82% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T19:22:35Z remaining= 79% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T20:08:15Z remaining= 76% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T20:33:32Z remaining= 74% agents=['agent_illustrator']
  2026-09-11T00:57:09Z remaining= 72% agents=['agent_illustrator', 'cj_agent_buyer_experience_sentinel']
  2026-09-11T02:48:35Z remaining= 72% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-11T03:44:04Z remaining= 72% agents=['agent_illustrator', 'cj_agent_seo']
  2026-09-11T06:11:39Z remaining= 72% agents=['agent_illustrator', 'cj_agent_pilot']
  2026-09-11T07:47:43Z remaining= 72% agents=['agent_illustrator', 'cj_agent_paid_media']
  2026-09-12T01:13:32Z remaining= 71% agents=['agent_ops', 'cj_agent_buyer_experience_sentinel', 'cj_agent_coder']
  2026-09-12T01:28:40Z remaining= 71% agents=['cj_agent_zara']
  2026-09-12T02:34:35Z remaining= 68% agents=['cj_agent_zara']
  2026-09-12T03:14:57Z remaining= 65% agents=['cj_agent_zara']
  2026-09-12T04:05:25Z remaining= 62% agents=['cj_agent_zara']
  2026-09-12T04:45:45Z remaining= 59% agents=['cj_agent_zara']
  2026-09-12T05:31:11Z remaining= 56% agents=['cj_agent_zara']
  2026-09-12T13:49:47Z remaining= 98% agents=['cj_agent_zara']
  2026-09-13T13:02:54Z remaining= 95% agents=['cj_agent_danalyst']
  2026-09-13T15:09:09Z remaining= 92% agents=['cj_agent_danalyst']
  2026-09-13T17:55:49Z remaining= 89% agents=['cj_agent_danalyst']
  2026-09-14T00:59:43Z remaining= 87% agents=['cj_agent_coder']
=== pro14: 1050 readings
  2026-09-07T00:04:21Z remaining= 27% agents=['agent_product_growth']
  2026-09-07T01:35:07Z remaining= 24% agents=['agent_product_growth']
  2026-09-07T02:30:37Z remaining= 22% agents=[]
  2026-09-08T07:48:20Z remaining=100% agents=['cj_agent_pilot']
  2026-09-08T22:26:11Z remaining= 95% agents=['agent_ops']
  2026-09-09T11:41:42Z remaining= 95% agents=['cj_agent_buyer_experience_sentinel']
  2026-09-09T17:15:11Z remaining= 22% agents=[]
  2026-09-09T17:40:20Z remaining= 94% agents=['agent_illustrator']
  2026-09-10T03:09:24Z remaining= 94% agents=['agent_growth_analyst']
  2026-09-10T16:15:31Z remaining= 91% agents=['agent_ops']
  2026-09-11T06:11:39Z remaining= 89% agents=['agent_ops', 'cj_agent_buyer_experience_sentinel']
  2026-09-11T06:26:47Z remaining= 89% agents=['agent_ops', 'cj_agent_writer']
  2026-09-11T08:02:51Z remaining= 88% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T10:19:14Z remaining= 85% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T10:59:36Z remaining= 84% agents=['agent_ops', 'cj_agent_pilot']
  2026-09-11T11:19:58Z remaining= 82% agents=['agent_ops', 'agent_product_growth']
  2026-09-11T11:50:15Z remaining= 79% agents=['agent_ops', 'agent_product_growth']
  2026-09-11T12:00:21Z remaining= 79% agents=['agent_illustrator', 'agent_ops']
  2026-09-11T12:05:23Z remaining= 78% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T13:21:16Z remaining= 75% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T14:21:51Z remaining= 72% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T14:52:20Z remaining= 69% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T15:07:29Z remaining= 66% agents=['agent_ops', 'cj_agent_writer']
  2026-09-11T15:37:47Z remaining= 63% agents=['agent_ops', 'cj_agent_writer']
  2026-09-11T15:57:58Z remaining= 60% agents=['agent_ops', 'cj_agent_writer']
  2026-09-11T16:18:10Z remaining= 57% agents=['agent_ops', 'cj_agent_writer']
  2026-09-11T16:33:17Z remaining= 56% agents=['agent_ops', 'cj_agent_seo']
  2026-09-11T16:58:30Z remaining= 55% agents=['agent_ops', 'cj_agent_pilot']
  2026-09-11T19:45:01Z remaining= 52% agents=['agent_ops', 'cj_agent_pilot']
  2026-09-11T20:50:37Z remaining= 51% agents=['cj_agent_arthur_sterling', 'cj_agent_pilot']
  2026-09-11T21:41:42Z remaining= 48% agents=['cj_agent_arthur_sterling', 'cj_agent_pilot']
  2026-09-12T04:45:45Z remaining= 45% agents=['cj_agent_arthur_sterling', 'cj_agent_pilot']
  2026-09-12T05:46:19Z remaining= 42% agents=['cj_agent_arthur_sterling', 'cj_agent_pilot']
  2026-09-13T11:32:04Z remaining=100% agents=['cj_agent_coder']
  2026-09-13T13:02:54Z remaining=100% agents=['cj_agent_zara']
  2026-09-14T05:47:24Z remaining= 97% agents=['cj_agent_zara']
=== pro15: 948 readings
  2026-09-07T00:04:21Z remaining= 52% agents=['cj_agent_arthur_sterling']
  2026-09-07T02:30:37Z remaining= 52% agents=['cj_agent_seo']
  2026-09-07T10:35:51Z remaining= 52% agents=['cj_agent_pilot']
  2026-09-07T11:31:13Z remaining= 52% agents=['cj_agent_writer']
  2026-09-07T14:07:45Z remaining= 52% agents=['cj_agent_seo']
  2026-09-07T17:19:23Z remaining= 52% agents=['agent_coder']
  2026-09-07T21:06:33Z remaining= 52% agents=[]
  2026-09-07T23:22:40Z remaining= 48% agents=[]
  2026-09-07T23:37:48Z remaining= 47% agents=['agent_ads_analyst']
  2026-09-08T00:38:18Z remaining= 45% agents=['agent_ads_analyst', 'cj_agent_support']
  2026-09-08T07:48:20Z remaining=100% agents=['cj_agent_seo']
  2026-09-08T22:26:11Z remaining= 93% agents=['cj_agent_merch_bot']
  2026-09-09T11:41:42Z remaining= 93% agents=['agent_illustrator']
  2026-09-09T17:15:11Z remaining= 45% agents=[]
  2026-09-09T17:40:20Z remaining= 93% agents=['cj_agent_designer']
  2026-09-10T03:09:24Z remaining= 93% agents=['cj_agent_boss']
  2026-09-10T05:20:22Z remaining= 93% agents=['cj_agent_arthur_sterling']
  2026-09-10T08:26:29Z remaining= 93% agents=['agent_illustrator']
  2026-09-10T16:15:31Z remaining= 90% agents=['agent_illustrator', 'cj_agent_buyer_experience_sentinel']
  2026-09-10T16:40:50Z remaining= 89% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T17:16:13Z remaining= 86% agents=['agent_illustrator', 'cj_agent_writer']
  2026-09-10T17:56:37Z remaining= 86% agents=['agent_coder', 'cj_agent_seo']
  2026-09-10T18:27:01Z remaining= 83% agents=['agent_coder', 'cj_agent_seo']
  2026-09-10T18:57:20Z remaining= 80% agents=['agent_coder', 'cj_agent_seo']
  2026-09-10T19:32:42Z remaining= 77% agents=['agent_coder', 'cj_agent_seo']
  2026-09-10T20:08:15Z remaining= 74% agents=['agent_coder', 'cj_agent_seo']
  2026-09-10T20:23:27Z remaining= 74% agents=['agent_coder']
  2026-09-10T23:16:04Z remaining= 71% agents=['agent_coder']
  2026-09-11T00:57:09Z remaining= 69% agents=['cj_agent_arthur_sterling']
  2026-09-11T01:27:29Z remaining= 66% agents=['cj_agent_arthur_sterling']
  2026-09-11T02:07:56Z remaining= 63% agents=['cj_agent_arthur_sterling']
  2026-09-11T02:58:40Z remaining= 60% agents=['cj_agent_arthur_sterling']
  2026-09-11T03:33:58Z remaining= 57% agents=['cj_agent_arthur_sterling']
  2026-09-11T04:19:29Z remaining= 54% agents=['cj_agent_arthur_sterling']
  2026-09-11T05:15:31Z remaining= 51% agents=['cj_agent_arthur_sterling']
  2026-09-11T10:14:12Z remaining= 48% agents=['cj_agent_arthur_sterling']
  2026-09-11T11:25:02Z remaining= 45% agents=['cj_agent_coder']
  2026-09-11T11:40:10Z remaining= 42% agents=['cj_agent_coder']
  2026-09-11T12:30:37Z remaining= 39% agents=['cj_agent_coder']
  2026-09-11T13:01:00Z remaining= 36% agents=['cj_agent_coder']
  2026-09-11T13:36:25Z remaining= 33% agents=['cj_agent_coder']
  2026-09-11T14:21:51Z remaining= 30% agents=['cj_agent_coder']
  2026-09-11T15:07:29Z remaining= 27% agents=['cj_agent_coder']
  2026-09-11T15:32:44Z remaining= 25% agents=['cj_agent_seo']
  2026-09-11T15:37:47Z remaining= 25% agents=['cj_agent_pilot']
  2026-09-11T16:18:10Z remaining= 22% agents=['cj_agent_pilot']
  2026-09-11T16:58:30Z remaining= 20% agents=['cj_agent_seo']
  2026-09-11T17:54:02Z remaining= 17% agents=['cj_agent_seo']
  2026-09-11T18:19:17Z remaining= 17% agents=['cj_agent_writer']
  2026-09-11T18:24:20Z remaining= 17% agents=['cj_agent_buyer_experience_sentinel']
  2026-09-11T19:09:43Z remaining= 14% agents=['cj_agent_buyer_experience_sentinel']
  2026-09-11T19:39:58Z remaining= 12% agents=['cj_agent_support']
  2026-09-11T19:45:01Z remaining= 12% agents=['agent_ads_analyst', 'agent_writer', 'cj_agent_support']
  2026-09-11T20:30:27Z remaining=  9% agents=['agent_ads_analyst', 'agent_writer', 'cj_agent_support']
  2026-09-11T20:50:37Z remaining=100% agents=['cj_agent_zara']
  2026-09-11T21:15:50Z remaining= 97% agents=['cj_agent_zara']
  2026-09-11T21:46:45Z remaining= 94% agents=['cj_agent_zara']
  2026-09-11T22:32:10Z remaining= 91% agents=['cj_agent_zara']
  2026-09-11T22:57:22Z remaining= 88% agents=['cj_agent_zara']
  2026-09-13T11:32:04Z remaining=100% agents=['cj_agent_danalyst']
  2026-09-13T13:02:54Z remaining=100% agents=['cj_agent_coder']
  2026-09-13T16:09:42Z remaining=100% agents=['cj_agent_buyer_experience_sentinel', 'cj_agent_coder']
  2026-09-13T18:41:13Z remaining=100% agents=['cj_agent_coder', 'cj_agent_writer']
  2026-09-13T18:46:17Z remaining=100% agents=['cj_agent_coder', 'cj_agent_seo']
  2026-09-13T19:01:24Z remaining=100% agents=['cj_agent_coder', 'cj_agent_pilot']
  2026-09-13T19:16:36Z remaining=100% agents=['cj_agent_coder']
  2026-09-13T19:46:53Z remaining=100% agents=['cj_agent_coder', 'cj_agent_writer']
  2026-09-13T19:56:58Z remaining=100% agents=['cj_agent_coder', 'cj_agent_seo']
  2026-09-13T22:43:30Z remaining=100% agents=['cj_agent_coder']
  2026-09-14T00:59:43Z remaining=100% agents=['agent_support']
  2026-09-14T04:51:54Z remaining= 97% agents=['agent_support']
  2026-09-14T06:12:36Z remaining= 94% agents=['agent_support']
  2026-09-14T07:08:04Z remaining= 91% agents=['agent_support']
  2026-09-14T07:33:20Z remaining= 89% agents=['agent_support', 'cj_agent_coder']
```

## B4. Watcher notes mentioning pro12, pro14, pro15 (dated, UTC)

- 2026-09-10T07:37 | imit. First `cr` rotation landed on `pro1@fun.country`, which returned capacity immediately. Second rotation landed on `pro12@fun.country` and took the turn - now **Pursuing goal (7h 55m)** on the Gate2 work.  Other six healthy: API tracking (5h), learn screen (9h 35m), plan
- 2026-09-10T10:23 | wo earlier "continue" nudges had bounced off. Recovery: 1. `/status` -> session `01a0820d-9a9d-\u2026`, account `pro14@fun.country`. 2. `/quit` -> `cr 01a0820d-\u2026` rotated the account. 3. "Resume paused goal?" -> Enter. 4. Now **Pursuing goal (5h 44m)** on the HU 
- 2026-09-10T11:14 | red, other 9 clear.  **planning tracking** (`content/w1Q:p1`) hit capacity with a stalled goal. One `cr` rotation to `pro14@fun.country` cleared it - now **Pursuing goal (9h 24m)**. Its context is down to 20% left, so expect a compaction soon.  Others unchanged: API tracking
- 2026-09-10T12:55 | ney strategy** (`growth/w80:p1`) hit capacity for real this sweep - its own "continue" bounced. `cr` rotated to `pro12@fun.country`, then "resume where you stopped" - now **Working** on the gws sheet review."}], "api": "anthropic-messages", "provider": "anthropic", "mod
- 2026-09-10T13:10 |  embed recovered, other 12 clear.  **POC embed** (`organic/wT:p1`) hit capacity with a stalled goal. `cr` rotated to `pro14@fun.country`, then "keep going" - now **Pursuing goal (56m)**.  Fast-mode check ran for the first time: it was OFF before the reclaim and came back OFF
- 2026-09-10T14:59 | other 12 clear.  **subgame solver** (`rustai/wK:p3`) bounced back to capacity on `pro6`. A second `cr` rotated it to `pro12@fun.country` and "carry on with the current task" - now **Pursuing goal (21h 24m)**, inspecting worker status. Fast mode unchanged (OFF)."}], "api": "a
- 2026-09-10T15:09 | : subgame solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) hit capacity again. `cr` rotated to `pro12@fun.country`, then "continue on" - now **Pursuing goal (21h 32m)**. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anthropic"
- 2026-09-10T15:22 | ty watch: subgame solver still blocked, other 12 clear.  **subgame solver** (`rustai/wK:p3`) - rotated again to `pro12@fun.country`; still "Selected model is at capacity". That is five failed rotations across `pro12`/`pro14`/`pro13`. Its model tier is saturated across the ro
- 2026-09-10T15:26 | at is the second spontaneous drop on this pane tonight. - **subgame solver** (`rustai/wK:p3`) - rotated again to `pro12@fun.country`, still at capacity. Seven failed rotations; the model tier is saturated across the pool.  Everything else is running normally."}], "api": "ant
- 2026-09-10T15:28 | tch: subgame solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) finally cleared. `cr` rotated to `pro14@fun.country` and "keep going" took - the pane is working again with no capacity warning. That ends a run of nine failed rotations. Fast mode unchanged 
- 2026-09-10T15:42 | me solver still blocked, other 12 clear.  **subgame solver** (`rustai/wK:p3`) hit capacity again and the rotation to `pro14@fun.country` did not clear it. Same pattern as earlier: this pane burns through the account pool faster than the tier frees up. I retry on the next sweep."}
- 2026-09-10T15:44 | Capacity watch: subgame solver still blocked, other 12 clear.  **subgame solver** (`rustai/wK:p3`) - rotated to `pro12@fun.country`, still at capacity. Second consecutive failed rotation in this stretch. Nothing else needs action; I keep retrying each sweep."}], "api": "anth
- 2026-09-10T15:45 |  recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) cleared on the fourth try this stretch. `cr` -> `pro12@fun.country`, "keep working the plan" - working with no capacity warning. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anth
- 2026-09-10T15:47 | atch: subgame solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) hit capacity again. `cr` -> `pro14@fun.country`, "go ahead and continue the work" - clear and working. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anthropic"
- 2026-09-10T15:48 | ear.  **subgame solver** (`rustai/wK:p3`) hit capacity again about a minute after the last recovery; the rotation to `pro12@fun.country` did not clear it. This pane now alternates between one short working turn and a capacity block. Everything else is running."}], "api": "anthrop
- 2026-09-10T15:50 | "Capacity watch: subgame solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) cleared. `cr` -> `pro12@fun.country`, "keep going" - working, no capacity warning. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anthropic", "model"
- 2026-09-10T15:53 | bgame solver still blocked, other 12 clear.  **subgame solver** (`rustai/wK:p3`) hit capacity again; the rotation to `pro14@fun.country` did not clear it. It keeps alternating between one working turn and a block. I retry next sweep."}], "api": "anthropic-messages", "provider": "
- 2026-09-10T15:57 |  solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) cleared after four failed tries. `cr` -> `pro14@fun.country`, "keep working the plan" - working, no capacity warning. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anthropi
- 2026-09-10T16:09 | e solver recovered, other 12 clear.  **subgame solver** (`rustai/wK:p3`) cleared after six failed tries. `cr` -> `pro14@fun.country`, "keep working the plan" - working, no capacity warning. Fast mode unchanged (OFF)."}], "api": "anthropic-messages", "provider": "anthropi
- 2026-09-10T16:22 | uch it. I check it fresh next sweep. - **subgame solver** (`rustai/wK:p3`) - still at capacity after rotating to `pro12@fun.country`. I keep retrying each sweep.  The other 12 panes are clear."}], "api": "anthropic-messages", "provider": "anthropic", "model": "claude-opus-5"
- 2026-09-10T16:26 | /wK:p3`) - rotated to `pro12@fun.country`, still at capacity. Retry next sweep. - **appsflyer RC double check** - still `pane_not_found`; awaiting your call on which workspace to map, or whether
- 2026-09-10T16:28 | n.country`, "continue on". Working, fast mode preserved ON. - **subgame solver** (`rustai/wK:p3`) - rotated to `pro14@fun.country`, still at capacity. - **appsflyer RC double check** - still `pane_not_found`, awaiting your call."}], "api": "anthropic-messages", "provide
- 2026-09-10T16:29 | : subgame solver recovered, 12 clear, 1 missing.  - **subgame solver** (`rustai/wK:p3`) - capacity. `cr` -> `pro12@fun.country`, "continue from your last step". Clear and working. - **stage build** - running fine on its own now (52% context left). - **appsflyer RC d
- 2026-09-10T16:31 | weeps, and a `cr` rotation frequently lands on another already-saturated AIMgr account (seen rotating among pro12/pro13/pro14@fun.country with cap still True immediately afterward). Rules for this session: do at most ONE cr recovery per pane per sweep; if it does not clear, repor
- 2026-09-10T22:16 |  1 recovery, 14 clear, 1 missing.  - **identity mismatch** (`bugs/w82:p1`) - hit capacity again. CR rotated to **pro12@fun.country**, nudged "go ahead and continue the work", now **Working**. Fast mode preserved (ON). - **appsflyer RC double check** (`bugs/w7Q:p1`) - st
- 2026-09-10T22:16 | r` in the same sweep landed on coder2@fun.country and reached Working. A later sweep required one more `cr`, landing on pro12@fun.country.  Rule for this pane: allow up to TWO cr attempts in a single sweep (a first rotation onto another saturated account is not a failure), vary t
- 2026-09-11T00:24 | ecovery, 12 clear, 1 exited, 2 missing.  - **fees** (`cratejoy/w3:p4`) - capped again on coder2. CR rotated to **pro14@fun.country**, nudged "resume where you stopped", now **Pursuing goal (1h 4m)**. - **organizing morning work** (`growth/w8A:p1`) - still at a shell pro
- 2026-09-11T09:34 | anished, 1 needs you.  - **puzzlegen** (`content/w1G:p2`) - capacity again (3rd rotation this hour). CR -> **pro12@fun.country**, nudged "go ahead and continue the work", **Pursuing goal (10h 28m)**. - **API tracking** - still stalled on the iPhone UI Automation tog
- 2026-09-11T13:22 |  **coder2@fun.country**, whose refresh token was revoked ("Please log out and sign in again"). Rotated again -> **pro12@fun.country**, nudged "resume the run"; pane is working. - Note: **coder2@fun.country** appears to have a dead refresh token. I will avoid relying on it and
- 2026-09-11T14:36 |  - capacity. First rotation landed on **pro14**, which now has a **revoked refresh token**; rotated again -> **pro12@fun.country**, **Pursuing goal (53m)**. - New account problem: **pro14@fun.country** refresh token revoked (joins coder2). - **API tracking** still human-
- 2026-09-11T14:38 | ai/wG:p4`) - capacity again. First rotation hit **pro13** with a **revoked refresh token**; rotated again -> **pro12@fun.country**, **Pursuing goal (53m)**. - Revoked-token accounts now: **coder2, pro13, pro14**. - **API tracking** still human-blocked (iPhone UI Automati
- 2026-09-11T14:42 | ** (`rustai/wG:p4`) - capacity. Rotation 1 landed on **pro13** (revoked token, still stalled); rotation 2 -> **pro12@fun.country**, **Pursuing goal (56m)**. - This pane now cycles into capacity every few sweeps and pro13/pro14/coder2 are dead accounts - the rotation
- 2026-09-11T14:45 | ver** (`rustai/wK:p3`) - capacity. Rotation 1 -> **pro13** (revoked token, still stalled); rotation 2 -> **pro12@fun.country**, **Pursuing goal (1d 17h 56m)**. - Both rustai panes now land on pro12 as the only healthy account in rotation; pro13/pro14/coder2 have revo
- 2026-09-11T14:46 | n in again."), leaving the pane still showing "Goal stalled (/goal resume)". Known dead accounts: pro13@fun.country, pro14@fun.country, coder2. pro12@fun.country is currently the only account that reliably resumes. Procedure for a capacity/usage-limit event on the two no-agent ru
- 2026-09-11T14:48 | SNG training** (`rustai/wG:p4`) - capacity again. Rotation 1 -> **pro13** (revoked token); rotation 2 -> **pro12@fun.country**, **Pursuing goal (1h)**. - Pattern is now steady: the two rustai panes hit capacity every few sweeps and each recovery costs two `cr` rotati
- 2026-09-11T15:29 | - **subgame solver** (`rustai/wK:p3`) - capacity. Rotation 1 -> **pro13** (revoked token); rotation 2 -> **pro12@fun.country**, **Pursuing goal (1d 18h 39m)**. Context is at 90% used there, so expect a compact soon. - Vanished: issue 3538, issue 5580, organizing morn
- 2026-09-11T15:32 | ustai SNG training** (`rustai/wG:p4`) - capacity. Rotation 1 -> **pro13** (revoked token); rotation 2 -> **pro12@fun.country**, **Pursuing goal (1h 43m)**. - Vanished: issue 3538, issue 5580, organizing morning work, identity mismatch."}], "api": "anthropic-messages"
- 2026-09-11T17:17 | sh token was revoked." Every rustai CR recovery now costs two rotations (first lands on pro13/pro14, second lands on **pro12@fun.country**, the only healthy account in that pool). - [x] Late-night recoveries: rustai SNG training (many, -> pro12/pro13/pro14), subgame solver (s
- 2026-09-11T20:30 | not be refreshed because your refresh token was revoked." Rustai CR recoveries cost two rotations to land on healthy **pro12@fun.country**. - [x] `learn screen` -> **Goal achieved (2h 54m)**; `POC embed` -> Goal achieved (12h 13m). - [x] 3-strike rule applied to issue 547
- 2026-09-11T23:33 | accounts**: `coder2`, `pro13`, `pro14` - refresh token revoked. Rustai CRs cost two rotations to land on healthy **pro12@fun.country**. - [x] `learn screen` -> Goal achieved (2h 54m); `POC embed` -> Goal achieved (12h 13m); `puzzlegen` -> Goal achieved; `rustai S
- 2026-09-12T04:25 | usage limit -> CR rotation. First rotation landed on `boss@fun.country` (refresh token revoked), second landed on **pro15@fun.country** -> goal resumed, "Pursuing goal (1h 20m)", fast stayed OFF.  Note for morning: `boss@fun.country` now also has a revoked refresh token a
- 2026-09-12T06:24 | pacity watch: 5 clear, 1 recovered, 1 parked.  dynamic missions (content/w1T:p1) hit capacity -> CR rotation to **pro14@fun.country** -> "Pursuing goal (3h 16m)", fast stayed OFF.  planning tracking remains parked (shared simulator/backend blocker, needs you)."}], "api": 
- 2026-09-12T07:14 | eeding CR recovery this session.  Rotation history tonight: boss@fun.country (FAILED - refresh token revoked) -> pro15@fun.country (worked) -> pro14@fun.country (worked, then saturated one sweep later) -> office@fun.country (current, 'Pursuing goal').  Rules: fast mode is OF
- 2026-09-12T11:15 |  space | action | landed | | --- | --- | --- | | planning tracking (content/w1Q:p1) | capacity -> CR rotation | **pro12@fun.country**, "Pursuing goal (3h 7m)", fast OFF | | rustai SNG training (rustai/wG:p4) | capacity -> CR rotation | **office@fun.country**, "Pursuing go
- 2026-09-12T11:15 | rially changed watch state: content/w1Q:p1 (planning tracking) hit 'Selected model is at capacity', was CR-recovered to pro12@fun.country and now reports 'Pursuing goal (3h 7m)' with fast OFF, contradicting the existing local memory that says it is parked on a shared simulator/ba
- 2026-09-12T11:15 | ard CR recovery (/status -> parse Session UUID -> /quit -> `herdr pane run content w1Q:p1 "cr <uuid>"`) rotated it to pro12@fun.country and it now reports 'Pursuing goal (3h 7m)' with fast OFF.  Handling now: treat it as an ordinary watched pane. Capacity string -> CR recovery. G
- 2026-09-12T11:15 | hurn panes (both took a capacity rotation in the same sweep): - planning tracking (content/w1Q:p1) - recovered to pro12@fun.country, 'Pursuing goal', fast OFF. No longer parked. - rustai SNG training (rustai/wG:p4) - new goal started, then capacity; recovered to office@
- 2026-09-12T17:48 | fun.country **revoked refresh token**, then pro15 -> pro14 -> office -> marcus), planning tracking -> **pro12@fun.country**, rustai SNG training -> **office@fun.country**, PVAI PVP -> **office@fun.country**, checkout warning -> **pro11@fun.country** (f
- 2026-09-13T19:29 | TtXMjmTspLorDDF8IGDONBqAYAQ=="}, {"type": "text", "text": "Capacity watch: PVAI PVP hit capacity -> CR-recovered to pro12@fun.country ("keep working the plan"), now working with fast OFF as before. Other 5 clear; dynamic missions still mid-turn under a stalled banner."}], "ap
- 2026-09-14T09:54 | n that pane. Training VMs and checkpoints are untouched.  PVAI PVP also hit capacity this sweep and recovered fine to pro12@fun.country. Other 4 panes clear."}], "api": "anthropic-messages", "provider": "anthropic", "model": "claude-opus-5", "usage": {"input": 2, "output": 671, "
- 2026-09-14T10:00 | could not be refreshed because your refresh token was revoked. Please log out and sign in again.' CR rotation landed on pro14@fun.country, pro15@fun.country, and pro11@fun.country - all revoked. Repeated `cr <uuid>` attempts never reattached; the pane now holds an unrelated 
- 2026-09-14T10:00 | hese accounts, but expect immediate failure and plan for extra attempts.  2026-09-14 overnight watch observations: - pro14@fun.country, pro15@fun.country, pro11@fun.country: resume fails with 'Your access token could not be refreshed because your refresh token was revoked. Please
- 2026-09-14T10:00 | ign in again.' All three were hit consecutively during CR rotation on rustai/wG:p4. - pro12@fun.country: WORKED. Recovered PVAI PVP (rustai/wZ:p1) from capacity in a single cr rotation; pane returned to 'Relaying repair status ... esc to interrupt'. - lessons@fu

## B5. Every weekly window seen from the home box, Sep 8 to 16 (20+ responses)

| window start (UTC) | weekly reset (UTC) | responses | used % | first -> last | per day | top roots | cwd | top families |
|---|---|---|---|---|---|---|---|---|
| 09-08 01:22:04 | 09-15 01:22:04 | 362 | 70 to 100 | 09-08T06:54 -> 09-08T09:13 | 09-08:362 | 01a07e10-8f7f:362 | rustai:362 | root:362 |
| 09-08 01:25:50 | 09-15 01:25:50 | 63 | 0 to 5 | 09-08T11:27 -> 09-08T14:02 | 09-08:63 | 01a07e10-8f7f:63 | rustai:63 | root:63 |
| 09-08 12:04:14 | 09-15 12:04:14 | 620 | 0 to 6 | 09-08T12:04 -> 09-08T13:34 | 09-08:620 | 01a080e8-ce65:321 01a080e7-7ce4:299 | psagentspace:620 | ROOT:424 root:196 |
| 09-08 11:00:34 | 09-15 11:00:34 | 565 | 0 to 6 | 09-08T12:05 -> 09-08T13:14 | 09-08:565 | 01a080e7-d88d:565 | psagentspace:565 | ROOT:353 root:212 |
| 09-08 06:09:35 | 09-15 06:09:35 | 509 | 3 to 18 | 09-08T13:03 -> 09-08T16:47 | 09-08:509 | 01a07e65-2d2b:509 | psagentspace:509 | root:509 |
| 09-08 12:02:42 | 09-15 12:02:42 | 1305 | 1 to 29 | 09-08T14:40 -> 09-11T14:35 | 09-08:415 09-10:100 09-11:790 | 01a08175-9f5e:415 01a081f1-06bd:290 | rustai:1205 psagentspace:100 | ROOT:940 root:365 |
| 09-08 13:54:44 | 09-15 13:54:44 | 3665 | 1 to 27 | 09-08T16:53 -> 09-09T00:08 | 09-08:3610 09-09:55 | 01a081f0-1427:3665 | psagentspace:3665 | root:2616 ROOT:1049 |
| 09-08 11:14:33 | 09-15 11:14:33 | 12476 | 1 to 100 | 09-08T16:54 -> 09-09T21:57 | 09-08:4503 09-09:7973 | 01a081f1-06bd:12476 | rustai:12476 | root:12111 ROOT:365 |
| 09-08 01:24:30 | 09-15 01:24:30 | 5405 | 3 to 100 | 09-08T17:26 -> 09-10T06:33 | 09-08:2394 09-09:2344 09-10:667 | 01a0820d-9a9d:5405 | rustai:5405 | root:3374 ROOT:2031 |
| 09-08 01:30:46 | 09-15 01:30:46 | 3130 | 4 to 26 | 09-08T19:25 -> 09-09T02:41 | 09-08:2120 09-09:1010 | 01a08279-9a65:3130 | psagentspace:3130 | root:2627 ROOT:503 |
| 09-07 20:01:43 | 09-14 20:01:43 | 345 | 1 to 4 | 09-09T16:56 -> 09-09T17:41 | 09-09:345 | 01a081f1-06bd:345 | rustai:345 | root:345 |
| 09-07 10:00:45 | 09-14 10:00:45 | 37 | 23 to 24 | 09-09T17:11 -> 09-09T18:09 | 09-09:37 | 01a0820d-9a9d:37 | rustai:37 | root:30 ROOT:7 |
| 09-09 21:55:41 | 09-16 21:55:41 | 5310 | 0 to 97 | 09-09T21:56 -> 09-10T11:36 | 09-09:809 09-10:4501 | 01a081f1-06bd:5310 | rustai:5310 | root:5310 |
| 09-09 13:00:26 | 09-16 13:00:26 | 5120 | 3 to 100 | 09-09T23:38 -> 09-11T09:19 | 09-09:31 09-10:190 09-11:4899 | 01a081f1-06bd:4899 01a0820d-9a9d:190 | rustai:5120 | root:3666 ROOT:1454 |
| 09-10 10:14:48 | 09-17 10:14:48 | 375 | 0 to 16 | 09-10T10:23 -> 09-10T13:02 | 09-10:375 | 01a0820d-9a9d:375 | rustai:375 | root:248 ROOT:127 |
| 09-10 11:34:28 | 09-17 11:34:28 | 1569 | 0 to 100 | 09-10T11:34 -> 09-10T14:56 | 09-10:1569 | 01a081f1-06bd:1569 | rustai:1569 | root:1569 |
| 09-08 11:15:47 | 09-15 11:15:47 | 2301 | 7 to 27 | 09-10T13:03 -> 09-10T20:55 | 09-10:2301 | 01a081f1-06bd:2300 01a0820d-9a9d:1 | rustai:2301 | ROOT:1183 root:1118 |
| 09-08 21:32:50 | 09-15 21:32:50 | 765 | 8 to 31 | 09-10T13:04 -> 09-10T20:55 | 09-10:765 | 01a0820d-9a9d:765 | rustai:765 | root:526 ROOT:239 |
| 09-08 11:26:59 | 09-15 11:26:59 | 5737 | 9 to 73 | 09-10T14:59 -> 09-12T00:51 | 09-10:131 09-11:5506 09-12:100 | 01a081f1-06bd:4224 01a0906a-c125:1474 | rustai:5698 rustai-sng-epic-678:39 | ROOT:3782 root:1955 |
| 09-10 21:00:46 | 09-17 21:00:46 | 122 | 0 to 1 | 09-10T21:33 -> 09-10T22:21 | 09-10:122 | 01a081f1-06bd:122 | rustai:122 | root:71 ROOT:51 |
| 09-10 21:45:09 | 09-17 21:45:09 | 3150 | 0 to 57 | 09-10T21:45 -> 09-12T08:09 | 09-10:905 09-11:679 09-12:1566 | 01a09327-b4c6:1566 01a081f1-06bd:947 | rustai:2513 psagentspace:637 | ROOT:2455 root:695 |
| 09-11 18:18:56 | 09-18 18:18:56 | 94 | 32 to 44 | 09-12T00:53 -> 09-12T02:50 | 09-12:94 | 01a0931b-1d9d:94 | rustai:94 | ROOT:94 |
| 09-12 08:09:57 | 09-19 08:09:57 | 8152 | 0 to 90 | 09-12T08:09 -> 09-13T01:05 | 09-12:8006 09-13:146 | 01a09327-b4c6:8152 | rustai:8152 | root:5354 ROOT:2798 |
| 09-12 10:00:38 | 09-19 10:00:38 | 162 | 0 to 2 | 09-12T10:28 -> 09-12T11:09 | 09-12:162 | 01a0931b-1d9d:162 | rustai:162 | ROOT:81 root:81 |
| 09-12 11:14:40 | 09-19 11:14:40 | 3366 | 0 to 100 | 09-12T11:15 -> 09-12T21:14 | 09-12:3366 | 01a0931b-1d9d:3366 | rustai:3366 | root:2023 ROOT:1343 |
| 09-12 13:16:42 | 09-19 13:16:42 | 9142 | 0 to 100 | 09-12T13:16 -> 09-13T21:14 | 09-12:3550 09-13:5592 | 01a095c2-4b78:9142 | rustai:9142 | root:8464 ROOT:678 |
| 09-12 17:13:50 | 09-19 17:13:50 | 37 | 0 to 0 | 09-12T20:25 -> 09-12T20:40 | 09-12:37 | 01a0974c-06b4:37 | psagentspace:37 | ROOT:37 |
| 09-12 21:15:10 | 09-19 21:15:10 | 3115 | 0 to 100 | 09-12T21:15 -> 09-14T04:29 | 09-12:343 09-13:2320 09-14:452 | 01a0931b-1d9d:3115 | rustai:3115 | ROOT:2518 root:597 |
| 09-13 01:05:05 | 09-20 01:05:05 | 88 | 0 to 3 | 09-13T01:05 -> 09-13T01:49 | 09-13:88 | 01a09327-b4c6:88 | rustai:88 | ROOT:88 |
| 09-14 01:17:49 | 09-21 01:17:49 | 5374 | 0 to 96 | 09-14T01:32 -> 09-14T18:32 | 09-14:5374 | 01a095c2-4b78:5374 | rustai:5374 | root:5374 |
| 09-12 13:47:05 | 09-19 13:47:05 | 238 | 1 to 5 | 09-14T04:30 -> 09-14T08:14 | 09-14:238 | 01a0931b-1d9d:238 | rustai:238 | ROOT:238 |
| 09-12 13:35:35 | 09-19 13:35:35 | 111 | 4 to 14 | 09-14T09:54 -> 09-15T02:14 | 09-14:95 09-15:16 | 01a09f56-a9a2:111 | rustai:111 | ROOT:111 |
| 09-14 18:30:24 | 09-21 18:30:24 | 4707 | 0 to 100 | 09-14T18:30 -> 09-15T04:48 | 09-14:2994 09-15:1713 | 01a095c2-4b78:4707 | rustai:4707 | root:4707 |
| 09-15 02:19:54 | 09-22 02:19:54 | 260 | 0 to 92 | 09-15T02:21 -> 09-15T22:59 | 09-15:260 | 01a09f56-a9a2:260 | rustai:260 | ROOT:260 |
| 09-15 16:33:03 | 09-22 16:33:03 | 3917 | 3 to 100 | 09-15T16:42 -> 09-16T04:22 | 09-15:2446 09-16:1471 | 01a095c2-4b78:3917 | rustai:3917 | root:2003 ROOT:1914 |
| 09-15 22:57:26 | 09-22 22:57:26 | 134 | 0 to 59 | 09-15T22:59 -> 09-16T13:27 | 09-15:1 09-16:133 | 01a09f56-a9a2:134 | rustai:134 | ROOT:134 |
| 09-12 18:52:53 | 09-19 18:52:53 | 57 | 14 to 15 | 09-16T11:35 -> 09-16T13:16 | 09-16:57 | 01a0a9ff-5429:57 | rustai:57 | ROOT:57 |

## B6. Home box aimgr selections

| observedAt (UTC) | status | label | reason |
|---|---|---|---|
| 2026-09-14T09:49:14.202Z | activated | pro15 | next_best |
| 2026-09-14T09:49:42.215Z | activated | pro14 | next_best |
| 2026-09-14T09:50:32.290Z | activated | pro15 | next_best |
| 2026-09-14T09:51:01.674Z | activated | pro14 | next_best |
| 2026-09-14T09:51:11.116Z | activated | pro15 | next_best |
| 2026-09-14T09:51:16.243Z | activated | pro14 | next_best |
| 2026-09-14T09:51:27.815Z | activated | pro15 | next_best |
| 2026-09-14T09:51:48.631Z | activated | lessons | next_best |
| 2026-09-14T09:51:56.222Z | activated | pro17 | next_best |
| 2026-09-14T09:52:00.214Z | activated | lessons | next_best |
| 2026-09-14T09:52:24.399Z | activated | pro17 | next_best |
| 2026-09-14T09:53:17.971Z | activated | lessons | next_best |
| 2026-09-14T09:53:45.111Z | activated | pro17 | next_best |
| 2026-09-14T09:54:10.882Z | activated | lessons | next_best |
| 2026-09-15T02:20:39.745Z | activated | pro9 | next_best |
| 2026-09-15T16:42:28.784Z | activated | illustrator | next_best |
| 2026-09-16T11:34:32.965Z | activated | pro7 | next_best |

## B7. Term-context samples for the sessions in B11 (top repeated contexts per term)

```
=== 01a08719-fa5a / exploit (./09/rollout-2026-09-09T11-57-01-01a08719-fa5a-7c70-8d2a-0572a70d2096.jsonl)
  57 t is card math, not a read on what he actually jams.\ • A fold is an exploit you have to pay for with a read, and 11 hands with nothing unusual in
  51 urface/choices/0/choice_explanation", "excerpt": "• Folding is an exploit, and it only pays once you know this player does not jam without a re
  26 d8h3sQh checkfacesBTN6295allin firstopponriverbetaftercallcall. Sourceexploitcall37.6% versusfold usingaggressive45handsprofile, missedoppondraws a
  24 e hands and overpolarizes your line against competent opponents. It's exploitable if Villain adjusts or if the Ace meaningfully improved their rang
=== 01a0863d-ec39 / password (./09/rollout-2026-09-09T07-56-40-01a0863d-ec39-7742-a744-5b3a50a7e5af.jsonl)
 122 tion confirms build/www is absent. No application POST, login, forgot-password, mail or seller mutation ran. Seller page139 is about:blank; sanitize
  96  postgresql://${QA_POSTGRES_USER:?set QA_POSTGRES_USER}:${QA_POSTGRES_PASSWORD:?set QA_POSTGRES_PASSWORD}@postgres:5432/${QA_POSTGRES_DB:?set QA_POS
  90 ransform repair. No seller credentials, native authentication, forgot-password submission or mail has run. C12/B3 remains the serving runtime with t
  86      QA_SCHEMA_HEAD QA_PUBLICATION_GOLDEN_SHA256         QA_POSTGRES_PASSWORD QA_ELASTIC_PASSWORD QA_TYPESENSE_ADMIN_KEY QA_TYPESENSE_SEARCH_KEY  
=== 01a091fb-675c / nsfw (./11/rollout-2026-09-11T14-39-27-01a091fb-675c-78f1-9f66-c86c30a99fac.jsonl)
 176 +IttcstDFtQu8JB4nQAoIBMQl3kyxhAiJkMIChACAQKFaGliFtTNoK2DaZW0ZePoGWvqTQNsFWjGrSEDNiAAsBGCNAiEMICNAUaDJgRQRKYBwDyHFASG5PkLLguuSIMAxLOYK2wjAARTg0tP
 169 cAYAEtsblZuvn7B/c7vDqBAgEnEFQYECDBGFvczIK4wIEAGAyAkcMK8L9xwzZzjOx0AFy8NSFwmBbYBiBCnT/TcfP2C+20tKhLPsrEo3HT9glrEv+TS/shsFoAAg3k2Q0i82CN2eMzDdjhxr
 169 92wwe7eAAYJDAjAPA8h7ARAEhFQinigo1XS0gCMo/nZ37iLu8+ueOWXPsn11yy47syMU8dnSFwmwWJeeOnHnuBVXvY0d967ZJgSEELYIIEkMo0tnoMEBsxltpEEQCgQz2bACBA2gHig+azwf
  92 MA2Epc5TbaGARARgQDbANjGgCQkka1hAQgQxkjChpAwYEAhhDDCGBtkgwQSBUgbOcA8k7BNSFwmLpPEZRJCAAiICLABASCBAAMhkESEsKFJYIOEIsANIYy5n3kBBJjLzBUGwIAwYPNsBmNAY
=== 01a091fb-675c / ddos (./11/rollout-2026-09-11T14-39-27-01a091fb-675c-78f1-9f66-c86c30a99fac.jsonl)
 169 UUaq3UrmN5tOSXf/mX+YM/+CNKrQC8wRu8PidPnOAbv+lbWa3WlFJ5+7d/G3Z3LzEMAzffdDOS6LqKBBd3L/FjP/HT/MPjHo/EMxkAG44fO8a7vfM78rSn38rx48e49ppriBJ0tYLgaU9/Bj
 169 uM9N5/a5JbTM05tdtRSmJpZT43D5cTZ/ZG/e8I+mzV4lesW1NURDznRsSgTR5hZ33G0HlkdDoSEQpQQkliPCRKz2hMSQoCYCPrNh8Di4UzrC2jxMOiugbIAAgSYZzEggW1ASGAbSQDYRggEt
 169 MIIAUgIgcAJAiSwITEATpAEEdgGTAQ4ucxOhBEAxgYBxmAjoJv1PP3pT+fC+fOslivGcSSdDOs16/XAOI5M00Ta2IltMGBjwAA2ALZ5QSRx11138Vd//ddEVBD/RqLWikpw1913gfkP5WFNW
 163 s7AKzXa+65527uu/ce5vMFN99yCzs7x+j7npd7+Vek63q+7qu/gvPnz3Hu7H38yR/9ITfddDOSeNCDH8KDHvRgnva0p/LcJPHoxzyWa6+9DoCDgwP++q/+ktVqBcBiseDt3vGdef03eCO6rs
=== 01a08204-90bb / exploit (./08/rollout-2026-09-08T12-15-32-01a08204-90bb-7141-8d8f-fffec36e6581.jsonl)
  66 pair-discipline", "short-stack-dynamics", "range-composition", "exploitative-assumptions"], "provenance": {"generation_date_utc": "2026
  66 ange-composition", "surface": "learner_facing"}, {"term_id": "exploitative-assumptions", "surface": "learner_facing"}]}, "primary_con
  65 pair-discipline", "short-stack-dynamics", "range-composition", "exploitative-assumptions"], "term_refs": [{"term_id": "pot-odds", "su
  52 utput from opponent reads, population assumptions, puzzle framing, or exploitative judgment. - Save evidence for the material claims, not a screen
=== 01a0863d-ec39 / credential (./09/rollout-2026-09-09T07-56-40-01a0863d-ec39-7742-a744-5b3a50a7e5af.jsonl)
 525 re dispatch**. PayWhirl uses a shared global hostname: require the QA credentials and `/test` exact-shop result as well as allowed network destination
 525  tokens, shop/store/product/location/publication/market IDs; PayWhirl credentials/headers; DB/queue/ownership namespace; carrier callback; API hosts/C
 518 images/digests/source revisions and shared versioned QA configuration/credential identity. Preserve protocol/retention/incompatible-worker exclusion/t
 502 ups → dismiss and continue.\ - Login gates → notify user; proceed if credentials provided.\ - CAPTCHA, 2FA → pause and ask user to resolve manually.
=== 01a08768-d214 / nsfw (./09/rollout-2026-09-09T13-23-08-01a08768-d214-7621-8024-7f216f4c52b9.jsonl)
  97 CiFurGNmWxQZkviNmC/vgpou/5t3Cb2P27P8PZAJhfcwM3vfm7cOoVX4uy2EClgE1OE8u7nsFw8RzLu+/ghVGpHHvsy7C4/iaGSxdwNi7+3Z+xPnsPh894Ckd33879Tr70K1G3dvjPNO5dBB
   9 BJd14H4V3Gaixd3Wa5WXPWim89n9H1P13V0XWUaJ9bDwGq1ZhxHrrrqhZnNZjzolpu57bZnsFwu+Q9E5T9Yaw1nUkrhfmlz1X+dbMn/JAaWyyXL5ZKr/vMslyuWyxVX/c8xjiPjOHLVVf8Wp
   7 MwqtQRXXfUfTYK+BotZJUJcddVVV13132McJ+6441buuOPpZCZXXXXVVf+RbHPhwjme9rQnsFwectVV/9uMw5pn3PZU7r37dv4vuefuu3jcP/wdtzzowbz267wBp06d4X8rSWxubfGKr/Rqv
   6 Zb4P8zV9BhNRL5dhrfWWNlQd2zSw/36ErXrR0FYpe6iVjYxMUDRKwdOVa9mTtOvW27tx77NSFw8fPrlq3ycTUlPk2yN/wUSXklOfXIBbL149Z5TJY8wMLEYqvV5/+Uq9+5yFYWVkZWd536AT

```
