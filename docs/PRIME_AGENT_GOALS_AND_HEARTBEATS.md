# Prime Agent goals and heartbeats: how the loop works, why it spins, and how to use it

Written 2026-09-02 from the Prime Agent fork source (`~/workspace/prime-agent`, `packages/coding-agent/src`, commit `748188587`) and a forensic read of two real sessions from that day: a Codex root (`01a061ee-b7fa-7343-80de-80ca74b13f0c`, gpt-5.6-sol, thinking max) that burned $668 and 5.2 million goal-tokens in 6 h 41 min without ever finishing, and a Fable root (`01a05f51-826b-753f-8e38-174fe551b422`, claude-fable-5-1) that ran the same kind of goal for 5 h 30 min and completed it. This is the contract for any agent working in this repo with `/goal`, `epic-to-prs`, `goal-loop`, or `rlm_heartbeat`.

## 0. The rules (agents: read these, the rest is why)

1. **A goal continuation is automatic, immediate, and unbounded.** After every turn that ends without an error, the engine injects `<goal_context>` again with no delay, no cap, and no backoff. Ending a turn "to wait" does not wait; it costs one more full turn within seconds. "Ending quietly", "ending the turn", "heartbeat remains active" are prose; the engine does not read them.
2. **The only way a goal finishes is `await goal.complete()` from the Python REPL.** Saying "done" in text does nothing; the harness deliberately refuses to infer completion from prose. When the objective is met, audit it once against every requirement, then call `goal.complete()` in the same turn.
3. **Every goal gets a token budget.** `/goal --budget <tokens> <objective>` or `--goal-token-budget <n>` on the CLI, or `token_budget=` in `goal.create`. Unset means unbounded, and unbounded plus rule 1 is an infinite loop by construction. Default to 1,500,000 for an epic lane, 300,000 for one issue; the engine hands the turn back with a `budget_limited` status when it is crossed.
4. **Never set a goal whose completion depends on waiting for something external** (a Pro review, CI, a child agent, a human). A goal must be a bounded deliverable with a machine-checkable done condition written into the objective: "done when PR #N is merge-ready with CI green and the receipts are on the issue; then run `await goal.complete()`".
5. **Inside an active goal, waiting is done inside the turn, not by ending it.** If you must wait for an external inside a goal, sleep in the REPL in bounded chunks (`await asyncio.sleep(300)` or `time.sleep(300)`, up to the expected duration, with one cheap check per wake) so the turn stays open and no continuation fires. A blocked turn costs nothing; an ended turn costs a continuation.
6. **Heartbeats are for waiting when no goal is active, or for a child's liveness.** Create one heartbeat per thing being watched, once, keep the returned `id`, change it with `rlm_heartbeat.update(id, …)`, delete it when the thing resolves. `rlm_heartbeat.create` appends; calling it again does not replace the old one. Prefer `delivery_mode="follow_up"` (queues behind the current turn) over the default `steer` (interrupts the turn).
7. **A heartbeat is not permission to also poll by hand.** If a heartbeat watches a page, a PR, or a child, do not re-check that page, PR, or child in every continuation. The Codex session polled a Pro page 174 times while its heartbeat fired 28 times.
8. **One idle turn is one cheap check and one fixed sentence.** If nothing changed, the turn is: one combined check, one byte-identical status line, end. Do not run `git status`, `gh pr view`, `date`, rewrite the worklog, and paraphrase the non-event 39 different ways. Fresh prose about an unchanged world is the signature of a spin.
9. **Blocked on a human means stop working, not keep checking.** There is no `goal.pause()` from the REPL; only the user can `/goal pause` or `/goal clear`. So when the loop genuinely needs the user: state the one question and the recommendation, then either sleep in-turn (rule 5) or, if the wait is open-ended, call `await goal.complete()` with a clear "completed as far as authorized; remaining work: …" report and let the user re-arm. Do not leave a goal active with nothing to do.
10. **Compaction refuels the loop; do not write goal plans into compaction summaries.** The engine already persists the goal; a 52 KB compaction summary that restates it is context tax on every continuation.

## 1. How the engine actually works

All references are `packages/coding-agent/src/…` in the fork.

- **Goal state** is a `thread_goal_state` custom record in the transcript (`core/goals.ts:13-26`): `goalId`, `objective`, `status` (`active`, `complete`, `budget_limited`, `error`, `idle`), `tokensUsed`, `timeUsedSeconds`, `continuationsUsed`, `tokenBudget`. It is rewritten on nearly every message as a token ledger; 2,091 records in the Codex session were 119 continuations, not 2,091.
- **Continuation.** `_getGoalContinuationMessages` (`core/agent-session.ts:3408-3444`) runs after every turn whose stop reason is not `error` or `aborted`; if the goal is `active` it returns the `<goal_context>` prompt (`core/goals.ts:215-230`: "The goal persists across turns. Ending one turn does not reduce or redefine the objective. If the goal is not complete yet, make concrete progress…"). `packages/agent/src/agent-loop.ts:428-443` feeds it straight back into the `while (true)` loop, without emitting `agent_end` and without any delay. `continuationsUsed` is incremented (`agent-session.ts:2202, 2968, 3429`) and compared against nothing; no `max` symbol exists.
- **Exits.** `await goal.complete()` from the kernel (`agent-session.ts:3081`, `3389-3406`); `tokensUsed > tokenBudget` (`agent-session.ts:2296`; budget defaults to `undefined`, `goals.ts:86-94`); a provider `error` or an abort; the user's `/goal pause` or `/goal clear`. The kernel exposes exactly `goal.get`, `goal.create`, `goal.complete` (`agent-session.ts:3070-3081`); there is no pause from inside the session.
- **Text is ignored on purpose.** `test/suite/agent-session-goal.test.ts:392` pins that a prose "done" does not complete a goal. A Codex `incomplete` response (output truncated) normalizes to stop reason `length` (`packages/ai/src/providers/openai-responses-shared.ts:525-543`) and is treated like a clean finish, which re-prompts.
- **No provider branch.** Nothing in the goal path checks the model. Codex and Anthropic stop reasons normalize the same way; `service_tier` and `thinking=max` only change cost and effort. The difference in outcomes is behavioural (section 2).
- **Heartbeats** are cron jobs in `session-artifacts/<root>/scheduled-jobs.json` (`core/cron-jobs.ts`). A firing heartbeat is a real agent run (`core/agent-messages.ts:441-448`) delivering the raw job prompt (`core/messages.ts:465`); default delivery `steer` interrupts the current turn (`cron-jobs.ts:1365-1369`); after the heartbeat turn ends, the goal continuation fires again. `rlm_heartbeat.create` appends a job every call (`cron-jobs.ts:370-401`); only the user-level `/heartbeat` replaces (`cron-jobs.ts:313-354`).
- **Compaction** (`~256K` context) carries `continuationsUsed` and `tokensUsed` through and, in 13 of 19 cases in the Codex session, was immediately followed by another `<goal_context>` injection.

## 2. What happened in the Codex session (and what Fable did)

`01a061ee…`, root in `~/workspace/psagentspace`, `epic-to-prs` over psmobile epic #4818, goal set by the skill at 19:57:32Z with **no token budget**.

| | Codex (gpt-5.6-sol) goal 1 | Fable (claude-fable-5-1) `01a05f51…` |
|---|---|---|
| Wall clock under the goal | 6 h 19 min, ended by a **429 usage limit** (`status: error`), then re-armed by the user and restarted identically | 5 h 30 min, ended by **`await goal.complete()`** with a final PR table |
| Continuations | 111 (119 incl. goal 2) | 424 |
| Turns triggered by a human | 2 ("continue", "re-arm") | comparable |
| `goal.complete()` calls | **0** (it ran `inspect.signature(goal.complete)` once at 02:17Z and still did not call it) | 1 |
| Idle turn shape | **7.5 tool calls, 13 s median**: poll the Pro page (174×), `rlm_heartbeat.list()` (27×), `git status` (41×), `gh pr view` (14×), `date` (43×), rewrite the worklog (65×), then a fresh paraphrase of "nothing changed" (39 distinct status texts, 0 repeats) | **1.3 tool calls, 6 s**: one combined check, one byte-identical line ("Concrete check: Pro plan review still generating. Watcher armed." ×130, "Ending the turn." ×132) |
| Continuations that changed nothing | 79 % | most, but cheap |
| Fastest spin | 26 consecutive continuations under 20 s each (01:29:58Z to 01:33:32Z); four full poll-and-report cycles in 52 s at 02:30Z | a 147-turn run of sub-20 s turns |
| Heartbeats | 16 created, all cancelled in churn (one per phase), max 2 concurrent, 28 firings, plus 174 manual polls of the same page; read `rlm_heartbeat.create.__doc__` 9 times, wrong kwargs twice | armed a watcher and mostly left it alone |
| Compactions | 19, summaries grew 3.5 KB → 52 KB, each restating the goal | 1 |
| Cost | $668 in the goal window ($419 parent + $249 children), $66/h, $5.61 per continuation, about $440 of it re-observing unchanged state | about $60/h, and it finished |
| `agent_status.taskState` | `needs_input` in all 1,132 records while the loop ran | same field, same meaninglessness |

The engine spins on both models. The difference is that Fable's idle turn is cheap and honest and it eventually makes the terminating call; Codex's idle turn is expensive and novel every time and it never does. Neither model waited: the Codex blocker was a ChatGPT Pro generation that took 40 minutes, and its answer was to re-check the page every continuation instead of sleeping or letting the heartbeat carry it.

Two other findings from the transcript worth knowing: after an `rlm_child_failure` at 00:16Z the loop went silent for 31 minutes until the user typed "continue" (the one moment action was needed, nothing happened), and 1,132 `agent_status` records all said `needs_input` while it ran, so the daemon's own status never reflected the spin.

## 3. Operator checklist

- Start goals with a budget: `/goal --budget 1500000 <objective>` in the TUI, `--goal-token-budget 1500000` on `prime-agent`, or `token_budget=` in `goal.create` from a skill.
- Write the done condition into the objective and name the call: "…the moment that holds, run `await goal.complete()`".
- When a goal is waiting on Pro, CI, or a human and you can see it re-checking, `/goal pause` costs nothing and stops the burn; `/goal clear` if the remaining work is not a deliverable.
- The `epic-to-prs` and `issue-to-pr` skills tell the agent "never park in waiting-for-user" and "a generated goal continuation is never license to re-ask". Under this engine, "never park" must mean "sleep in-turn or complete", not "keep checking"; the skills should say so.
- Watch `prime-agent list`: a goal session showing `working` for hours with a stable PR set is spinning. The transcript tell is a new `thread_goal_state` record every few seconds with `continuationsUsed` climbing and `tokensUsed` in the millions.
- Codex specifically: expect the expensive idle turn. Give Codex goals a smaller budget and a tighter done condition than Fable goals, and prefer Fable for open-ended loops until the engine changes below land.

## 4. Fork changes that make spinning impossible (recommended, not yet implemented)

From the source audit, each with its site in `packages/coding-agent/src`:

1. Cap continuations without user input: read `continuationsUsed` (already incremented at `agent-session.ts:2202, 2968, 3429`) against a `maxGoalContinuations` (default 50) in `_getGoalContinuationMessages` (`:3415`) and the two side doors (`:2945`, `:2190`); on the cap, mark the goal `budget_limited` and hand the turn back.
2. Minimum interval between goal-driven turns: stamp `_lastGoalContinuationAt` at `:3425`; if the previous continuation ended less than 60 s ago and mutated nothing (reuse the workspace snapshot from `core/autonomous.ts:294-311, 370-423`), sleep the difference before re-injecting, doubling up to 10 min.
3. Default the token budget: in `_startGoal` (`:1918`) replace `undefined` with 1,500,000 unless the caller passed one; add a wall-clock cap next to the token check at `:2296`.
4. Treat a `length` stop reason as non-progress at `:3412` (count it; three in a row ends the goal `budget_limited`).
5. Dedupe agent heartbeats: `createRlmHeartbeat` (`core/cron-jobs.ts:370-401`) replaces a job with the same label instead of appending, and refuses more than 3 active per session.
6. Make `agent_status.taskState` reflect a running goal loop (it said `needs_input` throughout) so the TUI, `prime-agent list`, and the summarizer can show "goal loop, N continuations, M tokens".
7. Print `Continuations: n/max` in the goal status line (`agent-session.ts:6272-6274`), as the autonomous mode already does (`:2089-2093`).

## 5. Where this doc lives

Same text in `psagentspace`, `rustai`, and `psmobile` as `docs/PRIME_AGENT_GOALS_AND_HEARTBEATS.md`, linked from each repo's `AGENTS.md` and `CLAUDE.md`. Source of truth for the engine analysis: `~/workspace/aimgr/docs/PRIME_AGENT_PERFORMANCE_AUDIT_2026-09-02.md` (fleet-level) and the fork's `docs/aelaguiz/` plans.
