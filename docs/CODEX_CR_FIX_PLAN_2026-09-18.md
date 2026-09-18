# Plan: make `cr` do what Amir asked (fix and test), 2026-09-18

Status: **implemented and tested on `main`** (2026-09-18 10:12 America/Chicago). Section 5 records the results. Follows `docs/CODEX_CR_INTENT_VS_BUILT_2026-09-18.md` (what went wrong) and
`docs/CODEX_ACCOUNT_ROTATION_NEW_THREAD_PLAN_2026-09-18.md` (the copier as built). Nothing in Codex changes.

## 0. Amir's requirements (the acceptance test)

In his words, 2026-09-17/18:

> start a new thread, untraceable to the old thread (e.g. different thread id) but with the turns etc preserved, so it
> rotates to a new account and has a new thread/session id and everything.

> for openai to figure out that it was account hopping they'd have to match on the content not just on session headers.

> we can't be sending the same session ID and thread ID and stuff to Codex servers on a different underlying Codex
> account. That's very bad.

> We're looking to get rid of as much as we can but not completely block my behavior.

As requirements:

| # | Requirement | Pass condition |
| --- | --- | --- |
| R1 | Fresh identity | The new session sends a new thread id and session id, and no identifier the old account ever sent (turn, item, call, response, window, goal, install id) |
| R2 | Conversation preserved | Prior turns are visible in the TUI and the model still has the thread's memory, including everything before compaction |
| R3 | Never block | `cr <id>` launches for every top-level thread Amir works in: compacted, subagent-spawning, or multi-hundred-MB. Refusal is reserved for things that cannot be copied at all (missing file, no alternate account, no disk) |
| R4 | Remove as much as possible | Within R2 and R3, strip every server-minted value that is not needed for memory |
| R5 | No silent same-thread rotation | No shortcut or default path resumes an existing thread id under a different account. `aim codex resume` stays as a manual, explicit command and prints a warning that the thread is about to continue under a new account (`CLAUDE.md`, "Codex account rotation rule") |

Today's build passes R1, fails R2 (drops memory), fails R3 (refuses 41 of Amir's 43 `cr` targets), and is silent on
R5 (`aim codex resume` rotates and keeps the thread id with no warning; the `crr` alias for it was removed 2026-09-18).

## 1. Decisions

New default behaviour of `cr <id>` (`aim codex resume-fresh`):

| Item | Today | New default | Why |
| --- | --- | --- | --- |
| Thread id, session id, turn ids, item and call ids, response ids, window ids, goal id, lineage, `create_time` | retired | retired (unchanged) | R1 |
| Compaction blobs (`compaction` / `context_compaction` `encrypted_content`) | dropped, source refused | **kept** | They are the memory. Dropping them fails R2 |
| Reasoning blobs (`reasoning.encrypted_content`) and `encrypted_function_args` | dropped | **dropped** | R4. Replay without them is a supported Codex path (it is what non-OpenAI providers get); cost is weaker chain-of-thought on the first turns, never lost facts |
| Compacted source | refused | **copied** | R3 |
| Source that spawned subagents | refused | **copied**; child thread ids retired and remapped like any other id, spawn-edge rows not copied | R3, R4 |
| Size cap | 256 MiB, whole file in memory | **4 GiB**, streamed; the disk-space check is the real guard | R3 (largest thread on this machine is 2.2 GB) |
| Source is itself a subagent thread, or a `history_base` fork segment | refused | refused (unchanged) | Not Amir's behaviour: 0 `cr` targets in history were either |
| `aim codex resume <id>` | rotates, same thread id, silent | unchanged behaviour plus a **warning** before launch: "thread <id> will continue under account <new> (was <old>); this links the two accounts server-side, use resume-fresh to avoid it" | R5, manual use stays possible |
| `aim codex use` / `watch` rewriting `auth.json` | silent | unchanged; no guard | Amir: not needed |

Flags after the change: `--keep-reasoning` (max quality, keeps every blob), `--drop-compaction` (max scrub, loses
pre-compaction memory; replaces `--allow-context-loss`), `--max-copy-mb`, `--last`, `--dry-run`, `--no-goal`,
`--archive-source`. `--keep-server-blobs` is removed (its meaning is now `--keep-reasoning`).

What stays linkable, unchanged and by design: repo remote URL, HEAD sha, cwd, client version, egress IP, adjacent
timestamps (Codex sends these on every turn), the kept compaction blobs (server-readable summary text), and the literal
transcript. The receipt prints this once per launch.

## 2. Changes (do now)

1. **Blob policy** (`src/targets/codex-thread-copy.js`): split `DROP_ITEM_TYPES` into reasoning
   (`reasoning`) and compaction (`compaction`, `context_compaction`); `rewriteRecord` takes `{ dropReasoning,
   dropCompaction }`; delete `assertCompactionPolicy`; the verifier already classes kept blob items as `blob-item`.
   `src/cli/commands/codex.js` and `src/cli/args.js`: new flags, remove the compaction refusal, receipt line
   "kept N compaction blob(s), dropped M reasoning blob(s)".
2. **Subagents** (`codex-thread-copy.js`, `codex-rollout.js`): `scanThreadRollout` collects child ids from
   `agent_thread_id`, `SubAgentActivity`, `CollabAgentToolCall` payloads and `thread_spawn_edges`; `buildRewriteMap`
   remaps them; `rewriteValue` gains a token pass so a UUID inside a longer string (tool output text) is remapped too,
   so the verifier's content-mention list is empty for child ids. Delete `subagentEvidence` and the
   `source_spawned_subagents` throw in `codex.js`.
3. **Streaming** (`codex-thread-copy.js`): `scanThreadRollout`, `copyThreadRollout`, `verifyCopiedRollout` read with
   `readline` over `createReadStream` instead of `readFileSync`; the copy pass re-reads the source instead of holding
   `scan.lines`; progress line every 100 MiB on a TTY. Default `MAX_COPY_MB_DEFAULT` = 4096. Disk budget stays
   2 × source + 64 MiB.
4. **Warning on `aim codex resume`** (`src/cli/commands/codex.js`): after rotation and before the child starts, print
   one stderr line: `[aim] WARNING: thread <id> will continue under account <new> (was <old>). Codex will send this
   thread id and session id under the new account, which links the two accounts. Use aim codex resume-fresh <id>
   to avoid that.` Behaviour is otherwise unchanged; no guard on `use` or `watch`.
5. **Docs**: README `resume-fresh` section and flag list, `skills/aimgr/references/commands.md`, `src/cli/help.js`,
   and the "As built" table in the rotation plan gets a one-line pointer to this document.

Later, only if needed: multi-segment (`history_base`) concatenation, per-label `CODEX_HOME`.

## 3. Tests

Unit (`test/codex/thread-copy.test.js`, `test/codex/resume-fresh.test.js`, `test/codex/use-watch.test.js`):

1. A compacted fixture copies with the `compaction` item and its `encrypted_content` intact, `message` items intact,
   reasoning lines dropped, verifier clean with the blob reported as `blob-item`, and no refusal.
2. A fixture with `SubAgentActivity`, `CollabAgentToolCall`, and a child id inside a tool-output string: all child ids
   remapped, zero content mentions, spawn-edge count irrelevant.
3. A generated 600 MiB fixture (env-gated, `AIMGR_BIG_FIXTURE=1`) copies with RSS under 500 MB and the verifier passes.
4. `aim codex resume <id>` still rotates and launches (the existing tests at `use-watch.test.js:175-230` stay) and
   the warning line names both labels and the thread id.

Live, in this order, on this machine (about 1 hour):

1. `cr 01a0b41e-ebea-7822-9798-ae64b534428e --dry-run`: no refusal; prints 12 compaction blobs kept, ~778 reasoning
   blobs dropped, 6 child ids retired, size and disk budget.
2. Scratch home, no `auth.json`: copy the same thread, `codex app-server` `thread/resume` on the new id returns the
   thread with `forkedFromId: null`, `parentThreadId: null`, and `thread/turns/list` shows the prior turns.
3. Real `cr 01a0b41e-…`: account label changes, TUI shows the history, first prompt is "what was the very first thing
   I asked you in this thread, and what did we decide?" and the answer must come from before the last compaction.
4. Residue on the new rollout: `grep -c` for the old thread id, session id, the 6 child ids, and 3 sampled source
   turn ids all return 0; `thread_spawn_edges` has no row for the new id.
5. `cr` on the largest thread in shell history (over 256 MiB) to prove streaming and the copy time; then
   `npm test`, `npm run lint`.

Optional, timeboxed to 30 minutes: capture one real request through a local HTTPS proxy (`HTTPS_PROXY` with mitmproxy,
if the Codex binary honours it) and assert no retired id appears in headers, `client_metadata`,
`x-codex-turn-metadata`, or `input[]`. If the proxy is not honoured, stop and rely on steps 3 and 4.

## 4. Rollout

1. Commit on `main`, push.
2. `bash scripts/install-local-bin.sh` here; on home, studio, laptop, M3 Max: `git pull` then the same script.
   `amirs-m3-36gb` and `old-m1` were unreachable on 2026-09-18; do them when they are up.
3. Confirm with `cr --dry-run` on one host.

Effort: about one working day. Changes 1 and 2 about 2 hours, change 3 about 3 hours, change 4 about 2 hours, tests
and live runs about 2 hours.

## 5. Results (2026-09-18)

Shipped: `src/targets/codex-thread-copy.js` (blob policy split, child-id retirement, UUID-in-text remap, streaming
scan/copy/verify, strong-id residue rule, 4 GiB cap), `src/targets/codex-rollout.js` (`listSpawnedSubagentIds`),
`src/cli/commands/codex.js` (no refusals, `--keep-reasoning`/`--drop-compaction`, receipts, resume warning),
`src/cli/args.js`, `src/cli/help.js`, README, skill reference, tests. `npm test`: 523 passing; `npm run lint` clean.

| Check | Result |
| --- | --- |
| `cr 01a0b41e-… --dry-run` | No refusal. 62 MB, 6,253 lines, 12 compactions kept, 1,260 reasoning items to drop, 6 child ids retired, 5,162 ids, 2,852 `create_time` values |
| Scratch home (no `auth.json`), `codex app-server` `thread/resume` on the copy | `sessionId` = new id, `forkedFromId: null`, `parentThreadId: null`, `historyMode: paginated`, `thread/turns/list` returns the real user turns |
| Real `resume-fresh` through the CLI path with the launch replaced by `codex -p yolo exec resume <new-id>` | Rotated `qa` → `illustrator`; new thread `01a0b512-e89c-…`; 766 reasoning blobs dropped, 12 compaction blobs kept; source unchanged (size and mtime) |
| Memory question on that real turn ("what was the very first thing I asked you in this thread?") | Answered correctly from turn 1, which sits behind 12 compactions; exit 0, no auth or id complaints |
| Residue on the real copy after the live turn | 0 hits for the old thread id, all 6 child ids, and sampled turn ids; no `create_time`, no `encrypted_function_args`, no reasoning items; `thread_spawn_edges` has no row for the new id; a `threads` row was read-repaired |
| Largest thread in `cr` history (`01a07bb4-…`, 881 MB, 47,088 lines, 61 compactions) | Streamed copy in 11 s at 400 MB RSS; verifier clean after the strong-id rule (a directory name `revalidation-20260908` had been a false positive) |
| `aim codex resume` | Still rotates and launches; prints the WARNING line naming the thread and both labels |

Not done: the optional proxy capture of one raw request. The live turn's acceptance and the on-disk residue scan are
the evidence; the request assembly is Codex code that the copier cannot see.
