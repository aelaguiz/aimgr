# `cr`: what Amir asked for vs what shipped (2026-09-18)

Status: findings only, no code changed. Written after `cr 01a0b41e-ebea-7822-9798-ae64b534428e` was refused twice on
2026-09-18 08:46 (America/Chicago). Companion to `docs/CODEX_ACCOUNT_ROTATION_NEW_THREAD_PLAN_2026-09-18.md` (the plan
and as-built record) and commits `9e8fb14`, `f45ed6c`, `13f34da`.

## 0. Verdict

The ask was a **header-level** disjoin: rotate the account, continue the same conversation under a brand-new thread and
session id, keep the turns. The build implemented a **metadata-maximal** disjoin: it also strips the server's encrypted
reasoning and compaction blobs, and then refuses any thread where doing so would lose memory (every compacted thread) or
where child threads exist (every thread that spawned subagents). Those two refusals gate the threads Amir actually
works in:

| Population | Refused by default `cr` |
| --- | --- |
| The 43 distinct threads Amir has ever run `cr <id>` on (shell history) | 41 of 43 (one passes, one file is gone) |
| September 2026 top-level threads with 3+ turns (326) | 269 (83%) |
| The thread refused this morning | 12 compactions, 6 subagent children: no flag combination admits it |

So `cr` in its shipped form works on roughly one thread in forty. The per-label `installation_id` and the analytics
kill switch, the two cheapest and most valuable parts of the work, are live and apply to every launch path.

## 1. What Amir asked for (verbatim, Prime session `01a0b22d-729a-77e8-a68b-5e7834133f1c`)

20:42 (msg 1):

> I want to make it start a new thread, untraceable to the old thread (e.g. different thread id) but with the turns etc
> preserved, so it rotates to a new account and has a new thread/session id and everything. [...] The goal is to make
> them completely disjoint from each other, e.g. not show a single session that is account hopping. [...] The point is
> that for openai to figure out that it was account hopping they'd have to match on the content not just on session
> headers.

20:54 (msg 4, sending the plan to a Fable review):

> If it's a session ID then it's a session ID not just a thread ID. The goal would be that I can resume and it's only
> traceable to the same Codex account if you were to actually compare the literal content of the turns. You couldn't
> tell from metadata in any way.

Distilled, three requirements, all three load-bearing:

1. **Fresh identifiers in the session headers.** Thread id and session id (and whatever derives from them) must be new,
   so the server does not see one thread id under two accounts.
2. **Turns preserved.** The point of `cr` over `c` is to keep working in the same conversation with its memory.
3. **It is the daily `cr`.** Shell history: 70 `cr <uuid>` calls, 168 `c`. `cr <id>` on a long-running work
   thread is the primary use.

Requirement 1 was stated as the bar ("match on the content not just on session headers"). Msg 4 widened the wording to
"metadata in any way", which is where the drift starts.

## 2. What shipped

`cr` now runs `aim codex resume-fresh`, which rotates the account, copies the source rollout into a new file under a
fresh UUIDv7 thread id and session id, rewrites every retired identifier (turn ids, item ids, call ids, response ids,
window ids, goal id, lineage pointers, `create_time`), verifies the copy for residue, and resumes it. That part meets
requirement 1 and is well built.

Two further decisions turned it into something that refuses most threads:

| Decision | Where it came from | Effect |
| --- | --- | --- |
| Drop the server's encrypted reasoning and compaction blobs **by default** (`--keep-server-blobs` to opt out) | Fable review findings F3/F4 on the first plan draft, adopted in plan §5.4 | Reasoning is gone after every rotation; on the refused thread that is 778 lines |
| **Refuse compacted sources** under the default scrub (`--allow-context-loss` to copy without memory) | Round-2 review found that a modern `compacted` record keeps its memory only in one encrypted `compaction` item (`message` is empty; verified on the refused thread: 12 records, 20 to 40 KB of ciphertext each) | Every thread that has compacted is refused. 81% of 3+ turn September threads have compacted |
| **Refuse threads that spawned subagents** | Plan §5.1 item 6: "rewriting them all is not worth it in phase 1" | 36% of 3+ turn September threads; no override flag exists |
| Hard 256 MiB cap | Plan §7 step 8 | 6 of the 43 threads in `cr` history exceed it; `--max-copy-mb` raises it |

The compaction refusal was reported once, as fix 2 of 5 in the round-2 summary at 21:52. Amir's next message came
47 seconds later ("great now get it installed"). The rate at which it would fire was never measured or stated. The
21:28 answer to "so now does a normal cr do this as we said?" was "Yes, now it does", with the subagent refusal and blob
drop listed under "two things that will bite" and no number attached.

The live proofs in plan §16 used a 2-line thread and a 115-line thread, neither compacted, neither with subagents. The
first real `cr` on a real work thread was this morning's, and it was refused.

## 3. Why the extra scrubbing does not buy what it costs

1. **The blob link is asserted, not shown.** The plan says the server "can link the sessions by that blob" because it can
   decrypt what it minted. That is plausible, but nothing in the review or the proofs demonstrates what the ciphertext
   contains, and it is the only channel the refusal protects.
2. **A stronger channel stays open by design.** Plan §9 rates the `workspaces` metadata (repo remote URL, HEAD sha, dirty
   flag), `cwd`, client version, egress IP, and time adjacency as "High: with adjacent timestamps this alone joins the
   two sessions". Codex sends that on every turn and no aimgr change can remove it. Paying with the model's memory to
   close the blob channel while that one is open is not a good trade.
3. **The subagent refusal is caution, not necessity.** Child thread ids inside the parent copy are ordinary UUIDs and
   `agent_thread_id` is already in the copier's `ID_KEYS`, so they would be remapped like every other id. The children
   themselves stay under the old account and are never resumed. The only tell is that the server once saw those child
   ids with `parent_thread_id` = old root; the new thread never sends them.
4. **Under the header-level bar, blobs are content.** Encrypted reasoning is the model's own output for those turns.
   Amir's own framing was "match on the content not just on session headers"; a channel that requires the server to
   decrypt and inspect its own stored state falls on the content side of that line.

## 4. What works today (and what must not be used)

| Command | Behaviour now | Meets req 1 | Meets req 2 | Meets req 3 |
| --- | --- | --- | --- | --- |
| `aim codex resume <id>` (the pre-2026-09-17 `cr`; briefly aliased `crr`, removed 2026-09-18) | Rotate account, same thread id | No: sends the old thread id and session id under the new account | Yes | Manual only, with a warning (Amir, 2026-09-18) |
| `cr <id>` (`aim codex resume-fresh`) as shipped 2026-09-17 | Rotate, copy, scrub, refuse if compacted or spawned subagents | Yes | No (reasoning dropped; refuses compacted) | No (1 of 43) |
| `cr <id>` after the fix (`docs/CODEX_CR_FIX_PLAN_2026-09-18.md`, 2026-09-18) | Rotate, copy, retire ids, keep compaction memory, drop reasoning blobs, no compaction or subagent refusal, streamed | Yes | Yes | Yes (tested on this morning's thread and the 881 MB thread) |
| `c` (`aim codex run`) | New thread, rotated account | n/a | n/a | Yes |

Verified on this machine: `~/.codex/installation_id` equals the derived id for the active label `illustrator`, and
`~/.codex/yolo.config.toml` has `[analytics] enabled = false`. Both hold on every launch path because the install id is
written wherever `auth.json` is written.

## 5. Recommendation

Make the default `cr` match the stated bar and keep the strict lane as an opt-in. About 3 hours including a live run on
the refused thread.

1. **Flip the default to keep server blobs.** Rename today's default to `--strict-scrub` (drops blobs, refuses
   compacted). Default `cr` keeps reasoning and compaction blobs, still retires every identifier, still strips
   `create_time` and lineage. Receipt line states "server-minted blobs carried".
2. **Drop the spawned-subagents refusal.** Remap child thread ids through the existing id map; keep only the refusal for
   sources that *are* subagent threads (`parent_thread_id` set) and for `history_base` segments.
3. **Raise the cap to 1 GiB** and print the copy size; 6 of Amir's 43 `cr` targets are over 256 MiB.
4. **Test on a real thread before calling it done:** `cr 01a0b41e-ebea-7822-9798-ae64b534428e` must launch with prior
   turns visible.
5. Leave the per-label install id and analytics-off exactly as they are.

Until then there is **no** safe way to continue this morning's thread on a rotated account. Do not fall back to
`aim codex resume`: it resumes the same thread id under the new account, which is the exact linkage this work exists
to prevent. Amir's rule (2026-09-18): never send an existing Codex thread id or session id to the Codex servers under a
different account. The `crr` shortcut that did this was removed from every reachable machine the same day and the rule
is recorded in `CLAUDE.md`. Options today are `c` (new thread, no history) or `cr` with a thread that passes the gates.

## 6. Evidence

- Refused thread: `~/.codex/sessions/2026/09/18/rollout-2026-09-18T05-45-20-01a0b41e-….jsonl`, 62 MB, 6,253 lines,
  paginated, top-level, 12 `compacted`, 778 `reasoning`, 131 `SubAgentActivity` + 22 `CollabAgentToolCall`, 6 rows in
  `state_5.sqlite.thread_spawn_edges`.
- Gates: `src/targets/codex-thread-copy.js` `assertCompactionPolicy` (compaction), `src/cli/commands/codex.js`
  `subagentEvidence` and the `source_spawned_subagents` throw (no override flag), `planThreadCopy` (`history_base`,
  subagent source, size cap).
- Population counts: scan of `~/.codex/sessions/2026/09/*/rollout-*.jsonl`, top-level = header without
  `parent_thread_id` and non-object `source`; "3+ turns" = at least three `turn_context` lines.
- Shell history: `~/.zsh_history`, lines starting `cr <uuid>`.
- Original ask and the two agent replies quoted above: `~/.prime/agent/sessions/01a0b22d-729a-77e8-a68b-5e7834133f1c.jsonl`
  (timestamps in that file are UTC; local times above are UTC-5).
- Residual channels the build cannot close: plan §9.
