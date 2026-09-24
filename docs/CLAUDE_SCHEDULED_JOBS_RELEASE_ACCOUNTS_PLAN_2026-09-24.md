---
title: "Claude scheduled jobs: give the account back when the job is done"
date: 2026-09-24
status: steps-1-3-implemented
owners: [aimgr]
related:
  - src/routines/run.js
  - src/routines/claude.js
  - src/routines/claude-hook.js
  - src/targets/claude-idle-stop.js (uncommitted, 2026-09-24)
  - CLAUDE_CROSS_ACCOUNT_RESUME_IDENTIFIER_HYGIENE_PLAN_2026-09-23.md
  - bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md
---

# Claude scheduled jobs: give the account back when the job is done

## Implementation status (2026-09-24)

Steps 1 to 3 are on `main`. Differences from the plan below:

- Claude 2.1.282's `Stop` hook input includes `last_assistant_message` and `background_tasks`, the in-flight background work. `claude-hook.js` records the parsed status line and the background-task and cron counts on every turn end, so AIM does not guess whether background agents are still running.
- An idle session that still has background work in flight is parked only after **3 h** with no activity (`stuck`). Otherwise the limits are: `done` 10 min, `needs-input` 30 min, `blocked` or `StopFailure` 10 min, no status line 60 min, and 60 min once a person has typed in the session.
- Background task completions also fire `UserPromptSubmit`. The hook tags them `promptSource: "task-notification"`, so only typed input counts as a person joining.
- The receipt now follows the latest turn end (`lastTurn`, `parked`, `personJoinedAt`). A `StopFailure` after the first turn now changes the outcome to `needs_attention`.

Steps 4 to 6 are not built.

## TL;DR

1. **Cause:** a Claude scheduled job marks itself "completed" at the end of its first turn, then keeps the Claude process running. The account stays held until someone closes the pane (`src/routines/run.js:944-946`).
2. **Cost:** the 29 Claude job runs from 09-18 to 09-24 sat idle for **94 account-hours** after their last turn. The longest was 24.6 h and the median was 0.7 h.
3. **Why a simple fix is wrong:** "end of first turn" is not "job done". Replay-review and weekly-ops start background agents and are marked "completed" at step 1 or 3 of 9 or 10. They keep working for another 2 to 3 hours. Closing Claude at the first stop would kill that work.
4. **Plan:** each job ends its final message with one status line (`AIM-JOB: done | needs-input | blocked`). AIM watches every turn and acts on that line. If a job goes quiet without the line, AIM parks it after 60 minutes of silence. Parking stops Claude cleanly, frees the account, and leaves the pane open with a one-line resume command.
5. **Size:** steps 1 to 3 fix the hogging in about 4 hours of work. All 6 steps take about 7 hours.

## What is happening

### The code

`executeRoutineWorker` in `src/routines/run.js`:

- Line 906: the first `Stop` hook after the prompt sets `settled = true`, writes `outcome: "completed"`, and releases routine ownership.
- Line 922: the observer loop exits. After this, AIM ignores later turns, later `StopFailure` events, and background-agent completions.
- Lines 944-946: `// Keep the account lease alive for the actual interactive process, even ... when the scheduled task has already finished.` then `await interactiveExit`. The worker waits for Claude to exit, and nothing ever tells Claude to exit.

This is intended behavior. The session stays open so Amir can reply, for example to approve community-sweep posts. The flaw is that it stays open with no time limit, whether or not a reply is needed.

### The numbers (receipts in `~/.aimgr/routine-runs`, Amir-M5)

| Measure | Value |
|---|---|
| Claude job runs, 09-18 to 09-24 | 29 with a recorded exit |
| Idle account-hours after the job's last turn | 94 h in total, 0.7 h median |
| Worst holds | replay-review 09-21: 24.6 h. reddit-sweep 09-23: 17.9 h. replay-review 09-23: 14.2 h. morning-report 09-23: 13.1 h |
| How the sessions ended | Every exit has code 0 and no signal. Amir closed them by hand, often several within seconds of each other (09-22 22:27, 09-24 00:34, 09-24 12:21) |
| Receipts still saying `live` with no process | 3: morning-report 09-18 and 09-20, replay-review 09-20 |
| Jobs that failed with "No unlocked Claude account" | whats-working 09-24 04:10, morning-report 09-24 06:00, community-sweep 09-23 07:00, whats-working-test 09-23 |

Contributing factor, **outside this plan:** 12 of 28 Claude accounts show `reauth_required` right now, so only 15 are usable. Stale jobs take accounts from that smaller pool. See `bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md`.

## How each job actually ends

These results come from reading the final message and any later replies in every transcript.

| Job | What the final message says | Amir replied in the session | Notes |
|---|---|---|---|
| morning-report | Report is posted. Sometimes ends with "Next: assign an owner on #5997" or "say yes or no to X" | 0 of 5 runs | The report is delivered elsewhere, so the session is not needed |
| reddit-sweep | "Nothing needs your approval" in most runs | 1 of 10 ("skip") | Should close on its own |
| community-sweep | Either "Nothing to approve" (done) or "To approve: reply 1, 2, both, or skip" (needs input) | 7 of 14 | Reply delay ranged from 30 seconds to 13 hours. 3 replies came within 10 minutes and 4 came after 2 hours or more |
| replay-review | Real finish comes 2 to 3 h after the first stop, with 4 to 47 turn-ends per run | 1 of 6 ("continue" after a rate limit) | First stop reads "Step 3 of 10 in progress". The receipt still says `completed` |
| weekly-ops-report | 09-21: "Step 1 of 9 done", then `StopFailure: rate_limit` twice | 0 | The receipt says `completed`, but the report never finished |
| gp-monday-reset | Done in 2 minutes | 0 | Should close on its own |

This gives four real end states:

1. **Done, nothing owed.** Most runs fall here. Free the account soon.
2. **Done, needs Amir's reply.** Community-sweep drafts and some morning-report questions. Keep the session briefly, then park it.
3. **Blocked or failed.** Examples: `rate_limit`, a crash, or "You've reached your Fable limit". Park it and report it. Right now the receipt wrongly says `completed`.
4. **Still working in the background.** Claude looks idle while its agents run. Never close it. Replay-review's longest quiet gap during real work was 29 minutes (09-21).

## The plan

**Rule:** the job reports how it ended, and AIM acts on that report. If the job reports nothing, AIM parks it after 60 minutes of silence.

**Park** means:

1. Stop Claude gracefully with SIGTERM through `claude-supervisor`. Claude saves the transcript.
2. The AIM lease is released on exit.
3. The worker prints a note in the pane. The pane shell stays open because the worker was started with `herdr pane run`.

`aim claude resume <id>` then continues the session on any free account. When the account differs, it uses the rekeyed fork from the 09-23 identifier-hygiene plan, so parking is safe.

### Step 1: end-of-job status line (about 30 min)

AIM adds this rule to every Claude routine with `--append-system-prompt` in `claudeRoutineArgs` (`src/routines/claude.js`). The rule does not change the prompt text, so the prompt sha256 checks stay valid. `claude --help` on this machine lists the flag for interactive use.

> When the scheduled job is completely finished, and no background agent, background shell, or Monitor you started is still running, end your final message with exactly one line:
> `AIM-JOB: done`, or `AIM-JOB: needs-input <the question>`, or `AIM-JOB: blocked <the reason>`.
> Never print this line before the job is finished.

Fallback if the flag misbehaves in the TUI: add the same paragraph to the 8 prompt files in `~/.aimgr/routines/prompts/`.

### Step 2: keep watching after the first stop (about 2.5 h including tests)

In `run.js`, the observer keeps reading `.claude.jsonl` events until it parks the session or Claude exits. `claude-hook.js` reads the last assistant text from `transcript_path` on every `Stop` and records a `jobStatus` field. Most of the reading and polling code already exists.

| Signal | Action | Receipt `outcome` |
|---|---|---|
| `AIM-JOB: done`, and Amir has not typed for 10 min | Park | `completed` |
| `AIM-JOB: needs-input …` | Wait 30 min for a reply, then park | `needs_input` (new value) |
| `AIM-JOB: blocked …`, or `StopFailure` with no later `Stop` within 10 min | Park | `needs_attention`, with the error saved |
| No status line, Claude idle, and no transcript write for 60 min | Park | `needs_attention: went quiet without a status line` |
| Amir typed in the session after the first stop | The session is now his. Park after 60 min idle | Unchanged |

Also: stop treating the first `Stop` as final. `outcome` is final only when the session is parked or exits. This fixes weekly-ops 09-21 and replay-review 09-22 being reported as `completed`.

The 60-minute silence limit is twice the longest quiet gap measured during real work (29 min). If a status line says `done` but the transcript shows a background `tool_use` with `run_in_background: true` that has no matching `<task-notification>`, keep waiting. That check is optional and covers a job that prints the line too early.

### Step 3: park and leave a note (about 1 h)

The worker creates its own `AbortController` and combines it with the lease signal it passes to `runClaudeCli`. Aborting it sends SIGTERM to Claude through the supervisor. The existing exit path then releases the account. After exit, the worker prints a note in the pane like this:

```
[aim] community-sweep 09-24 07:00: needs your input: "reply 1, 2, both, or skip"
[aim] Account pro5 released at 08:14.
[aim] Continue: aim claude resume <session-id>
```

Reuse `stopNotice` from `src/targets/claude-idle-stop.js`.

### Step 4: one list of what needs you (about 1 h, optional)

`aim routine inbox` reads receipts from the last 72 h. It lists every `needs_input` and `needs_attention` run with its question or reason and the resume command. It makes no provider calls.

### Step 5: fix stale `live` receipts (about 45 min)

Record the Claude pid in `interactiveTui`. When `aim routine` reads a receipt that says `live` but whose pid is dead, it rewrites the receipt as `exited`, with `exitReason: "worker-gone"`. Three receipts need this today.

### Step 6: make the in-progress idle-stop safer (about 1 h)

`src/targets/claude-idle-stop.js` is uncommitted work from today. It frees an account by stopping the least recently used idle session. The check at line 95 treats `status !== "busy"` as idle. A replay-review run waiting for its investigators can look idle, so it could be stopped mid-run. That needs to be checked. Change it to:

1. Stop routine sessions that already printed `AIM-JOB: done` or `needs-input` first.
2. Never stop a routine session that has no status line yet, because it may still be working.
3. Stop Amir's least recently used sessions last. This is the current behavior.

After steps 1 to 3, this fallback should rarely run.

## Not doing

- **Switching jobs to `claude -p`.** Community-sweep approvals happen inside the session, and 7 of 14 runs got a reply there.
- **Auto-resuming a rate-limited job on another account.** This is worth doing later. For now it is parked and reported.
- **Auto-closing Herdr workspaces.** The pane is where Amir reviews the result. Parking frees the account and leaves the pane.

## Defaults chosen (change if wrong)

1. Hold for a reply: **30 min**. Past replies came between 30 seconds and 13 hours after the question, and resuming later takes one command.
2. Grace after `done`: **10 min**, which is enough to reply if Amir is watching a manual run.
3. Sessions Amir has typed into: **park after 60 min idle**. The other choice is never auto-parking them.

## Verification

1. Unit tests in `test/routines/routine-run.test.js`, one case per row of the Step 2 table, using the existing fake event harness.
2. Live test: `aim routine run reddit-sweep --manual`. Expect the account to be released about 10 minutes after `AIM-JOB: done`, a `completed` receipt, and the resume line in the pane. Then run `aim claude resume <id>` and confirm the conversation continues.
3. Metric after 7 days: idle account-hours after the last turn should drop from 94 per week to under 5 per week. Measure it by comparing each run's last `Stop` or `StopFailure` time in `*.claude.jsonl` with `interactiveTui.exitedAt` in the receipt.
