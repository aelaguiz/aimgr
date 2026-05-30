# Codex `--tend` redesign — app-server-free thread identity (LIVING DOC)

> **Superseded on 2026-05-30.** This research log is historical. The current live implementation
> plan is `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`. That plan keeps the app-server-free
> rollout identity work but removes tmux from the Tend runtime.

**Date started:** 2026-05-30
**Status:** RESEARCH IN PROGRESS — this is a living working document, updated incrementally as
findings land. Not a finished plan yet. Companion to
`docs/codex-tend-path-bug-analysis-2026-05-30.md` (the bug analysis).

> Working rule: every learning gets written here as it happens, not batched at the end.

---

## 1. North star (the redesign goal)

Replace the brittle, count-based thread *discovery* in `aim codex run --tend` with an
architecture where **AIMGR owns/knows the session id deterministically and reads everything it
needs directly from Codex's on-disk files — no Codex app-server, no `--remote`, no WebSocket
JSON-RPC `thread/*` protocol.**

User's framing (verbatim intent): *"make a note of the session id somewhere and then use it."*
And: the fix must **not depend on the app-server protocol**, and ideally must **not spawn an
app-server at all**.

---

## 2. Hard constraints / decisions (decision log)

- **2026-05-30 — No app-server protocol.** The redesign must not use the Codex app-server
  WebSocket JSON-RPC API (`thread/loaded/list`, `thread/goal/get`, etc.). It's an internal,
  experimental surface. (User directive.)
- **2026-05-30 — No app-server process at all.** The tend path currently *spawns its own*
  `codex app-server --listen` per instance, separate from the user's existing remote-control
  daemon (see §4). This is redundant and adds SQLite write-lock contention. Decision: the
  redesign **deletes** the private-app-server scaffolding from the tend path. AIMGR becomes a
  **read-only observer of Codex's files + a tmux driver**. (User directive + evidence.)
- **2026-05-30 — Cannot modify Codex source.** Only `aimgr` changes. The mechanism must rely
  on stable Codex behavior: CLI flags, env vars, on-disk rollout JSONL, and the goals SQLite.
- **2026-05-30 — AIMGR never writes Codex state.** The only "write" in the flow (re-activating
  a paused goal) is done by pressing Enter in the tmux TUI pane; the TUI performs the write.
  AIMGR only reads + drives tmux.
- **2026-05-30 — Identity mechanism LOCKED: unique-originator stamp + rollout-dir watch.**
  Forcing the session UUID is impossible (no Codex flag/env; id is always `Uuid::now_v7()`).
  Instead AIMGR sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>` (unique per tended
  session), launches the plain TUI, and watches `~/.codex/sessions/` for the one rollout whose
  `session_meta.originator == aimgr-tend-<runid>` AND `thread_source` absent AND `source == "cli"`.
  Its `session_meta.id` is `T`. (Evidence in §5.) This is deterministic under concurrency.
- **2026-05-30 — Trigger LOCKED: per-thread goal status (disk) + account usage probe.**
  Primary: read `T`'s goal status directly — `goals_1.sqlite` `thread_goals.status` (snake_case
  `usage_limited`) and/or the rollout `thread_goal_updated` marker (camelCase `usageLimited`).
  This is per-thread, so it's correct even under the shared-auth confusion (Finding 1). The
  existing account usage probe stays for choosing a good next account on rotation + as
  corroboration. Pane string `Goal hit usage limits` is the fallback.
- **2026-05-30 — "Plain TUI" still has an *in-process* app-server, and that's fine.** The codex
  binary runs an embedded in-process JSON-RPC app-server (`AppServerTarget::Embedded`) even
  without `--remote`. That is internal to the codex process, NOT the external WS server AIMGR
  spawns today. "App-server-free" means *AIMGR no longer spawns or talks to one* — the codex
  binary's internal one is unavoidable and harmless.

---

## 3. Target architecture (current best shape — may refine)

```
Today:   AIMGR ⇄ private `codex app-server` (WS thread/* protocol) ⇄ ~/.codex   + tmux TUI
                 ^ spawned per tender, competes with user's daemon on shared sqlite

New:     AIMGR → reads ~/.codex/sessions/*.jsonl   (session identity)
                 reads ~/.codex/goals_1.sqlite      (goal status, read-only)
                 reads account usage/quota probe    (already protocol-free)
                 → drives plain `codex` TUI in tmux (launch / resume / Enter / exit)
         No app-server. No --remote. No WS protocol.
```

Three protocol-free pieces:

1. **Identity** — AIMGR owns the session UUID `T` via **unique-originator stamp + rollout-dir
   watch** (LOCKED; force-id ruled out, see §5.1):
   - AIMGR mints `runid` and launches the TUI with env
     `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`.
   - AIMGR watches `~/.codex/sessions/**/rollout-*.jsonl` for the new file whose first-line
     `session_meta` has `originator == "aimgr-tend-<runid>"` AND `thread_source` absent AND
     `source == "cli"`. `T = session_meta.id` (also the UUID in the filename).
   - Deterministic under concurrency: the unique `runid` is the discriminator (no other process
     writes it); the `thread_source`-absent filter excludes this session's own sub-agents (which
     inherit the same originator but are tagged `subagent`); other tenders use other `runid`s.
2. **Trigger** (when to rotate) — read goal status directly + account usage probe:
   - Primary candidate: `SELECT status FROM thread_goals WHERE thread_id='T'` on
     `goals_1.sqlite` (read-only) → react to `usage_limited` (and possibly `paused`/`blocked`).
   - Plus the existing account usage/quota probe (`detectActiveCodexUsageRateLimit`) as the
     authoritative "account exhausted" signal.
   - Plus tmux pane text as a fallback.
3. **Resume** (unchanged, already protocol-free) — `codex resume <T>` in tmux, then confirm the
   "Resume paused goal?" prompt by sending Enter. Re-activation is the TUI's write, not AIMGR's.

This collapses 4 of the 7 bug-analysis findings: ambiguous discovery, recovery-gated-on-threadId,
fuzzy-resume (mitigated by knowing/verifying `T`), and app-server-based goal polling.

---

## 4. Confirmed by direct inspection (evidence)

### 4.1 The tend path spawns a competing app-server (process reality)
- User already runs a persistent app-server: **pid 85770**,
  `…/codex app-server --remote-control…`, up since **May 27** (the remote-control daemon;
  `~/.codex/app-server-daemon/` + `settings.json {"remoteControlEnabled": true}`).
- `startPrivateCodexAppServer` spawns an **additional** `codex app-server --listen
  ws://127.0.0.1:<random-port> --enable goals` per tender, pointed at the shared `~/.codex`
  (`src/targets/codex-app-server.js:209-239`). Strictly additive; does not reuse the daemon.
- ⇒ N tenders = N+1 app-servers on one `~/.codex`, all touching the shared SQLite stores.
  ~49 codex processes were running at inspection time. Multiple writers → `database is locked`
  contention (the `codex-cleanup` pattern). This is a reason to remove it, not reuse it.

### 4.2 Goal status is directly readable from SQLite (read-only) — DEMONSTRATED
- File: `~/.codex/goals_1.sqlite` (+ `-wal` ~4.5 MB, `-shm` — WAL mode, actively written).
- Schema (read-only dump):
  ```sql
  CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('active','paused','blocked','usage_limited','budget_limited','complete')),
      token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL );
  ```
- Live read, no app-server, no write lock (`sqlite3 -readonly`):
  `active|44  blocked|2  complete|112  paused|7  usage_limited|7`.
  ⇒ The exact `usage_limited` signal the tender wants is one read-only SELECT away.
- WAL note for the plan: open with `mode=ro` (NOT `immutable=1`) so the reader sees the latest
  committed rows including the `-wal`. `immutable` would ignore the WAL and read stale data.

### 4.3 Session identity is on disk in `session_meta`
- Rollout files: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. First JSONL line
  is `type: "session_meta"` with payload fields observed: `id` (the session/thread UUID,
  matches filename), `originator`, `cwd`, `thread_source` (`"subagent"` for sub-agents; absent
  for top-level), `forked_from_id`, `source.subagent.thread_spawn.parent_thread_id`.
- Plain TUI writes rollouts the same way (empirical: `originator: codex-tui` sessions exist on
  disk), so disk-watch works WITHOUT `--remote`/app-server.
- Scale/contention reality (this machine): **1,584** rollouts; many concurrent originators
  (`aimgr_codex_tender`, `codex-tui`, `codex_exec`, `codex_dock_relay`); a single repo had ≥2
  concurrent `aimgr_codex_tender` primary goals; each tender goal spawns **10–23** explorer
  sub-agents. ⇒ identity must filter sub-agents and disambiguate concurrent same-cwd tenders.

### 4.4 Carried-over Codex internals (from the bug-analysis phase, still load-bearing)
- `threadId == SESSION_ID`: a resumed thread reuses the rollout's `meta.id`; a new thread gets a
  fresh `Uuid::now_v7()`. Resume does NOT fork the id (0 of 1,584 UUIDs duplicated across files).
  ⇒ a known `T` stays valid across resumes. (`core/src/session/session.rs:520-525`.)
- `codex resume <id>` exact-matches by id and content-verifies via the threads DB; on a true
  miss it **exits fatally** ("No saved session found with ID …") — no most-recent fallback.
  Only non-exact path: if the shared SQLite index misses, it falls back to a fuzzy filename
  match (`limit=1`, unverified). ⇒ knowing/verifying `T` removes this risk.
  (`tui/src/lib.rs:1474-1488,1549-1559`; `rollout/src/list.rs:1272-1395`.)
- A `usage_limited` goal does **not** auto-reactivate on resume; it needs a `status=active`
  write, which is exactly what the TUI does when Enter selects "Resume goal". So the existing
  pane-scrape + Enter resume confirmation keeps working with no app-server.
  (`core/src/goals.rs:1221-1267,1360-1434`; `tui/src/app/thread_goal_actions.rs:51-78`.)
- The "Resume paused goal?" prompt shows iff the resumed goal is `Paused|Blocked|UsageLimited`
  AND (startup-resume path) no initial prompt/images were passed. The tender's resume command
  passes no initial prompt ⇒ the prompt will render. Footer "running" text is `Pursuing goal`
  (not `Goal active`); footer can collapse under narrow width ⇒ pane scraping is a fallback,
  not the source of truth. (`tui/src/bottom_pane/footer.rs:529,544-566`.)

---

## 5. RESOLVED — protocol-free mechanisms confirmed (Codex source evidence)

Both research questions are now answered from `~/workspace/codex/codex-rs`. Citations are
`codex-rs/...`.

### 5.1 Identity: force-id is impossible; unique-originator watch is the way

- **Cannot force a NEW session's id.** No flag/env/config seeds it; it is unconditionally
  `Uuid::now_v7()` (`core/src/session/session.rs:520-525`; `protocol/src/thread_id.rs:18-22,
  53-57`). The `--session-id`/`SESSION_ID` args only SELECT existing sessions on `resume`/`fork`
  (`cli/src/main.rs:296-300,321-326`; `exec/src/cli.rs:180`). `CODEX_THREAD_ID` is **output-only**
  — codex exports it into the child shell env, never reads it back (`protocol/src/shell_environment.rs:6,106`).
- **`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` works and lands in `session_meta.originator`.** Declared
  at `login/src/auth/default_client.rs:37`; env wins over the hardcoded per-binary originator
  (`default_client.rs:57-61`; even overrides `codex-tui`/`codex_exec`, see
  `app-server/src/request_processors/initialize_processor.rs:120-124`). Written verbatim into the
  rollout: `rollout/src/recorder.rs:673-678` (`originator: originator().value`), a non-skipped
  `String` (`protocol/src/protocol.rs:2668`). Value must be a valid HTTP header → `aimgr-tend-<runid>` is fine.
- **Top-level vs sub-agent is distinguishable on disk.** `thread_source` is
  `#[serde(skip_serializing_if="Option::is_none")]`; **CORRECTED 2026-05-30:** a top-level *plain-TUI*
  session writes `thread_source:"user"` (NOT absent) via `tui/src/app_server_session.rs:1384`
  (`ThreadSource::User`), verified on disk; the earlier `thread_manager.rs:567-577` "absent" reading
  was the wrong code path. Sub-agents write `"thread_source":"subagent"`
  (`core/src/codex_delegate.rs:90`). Redundant signal: `source == "cli"` for top-level vs
  `subagent_*` for sub-agents (`protocol.rs:2548`).
- **TIMING CAVEAT (must design around):** the rollout file does NOT appear at bare TUI launch.
  For a new session it materializes on the **first user turn** (first message), not at startup
  (`core/src/session/mod.rs:1190-1196,3137`; app-server even reports "not materialized yet …
  unavailable before first user message", `thread_processor.rs:3795,3817`). So AIMGR's watch
  resolves `T` once the user (or AIMGR) submits the first `/goal` prompt — not before. That's
  fine: there's nothing to tend until the goal starts. (`codex exec` always submits its prompt
  first, so for an exec-based variant the file is immediate — but we keep the interactive TUI.)
- **Alternative id sources (noted, not chosen):** `codex exec --json` prints
  `thread.started {thread_id}` as its first stdout event (`exec/src/exec_events.rs:39-43`;
  `event_processor_with_jsonl_output.rs:598`) — deterministic, but exec not TUI. The TUI can be
  configured to render the id in-pane via `tui.status_line = ["thread-id"]`
  (`tui/src/bottom_pane/status_line_setup.rs:124-126`) for a pane-scrape fallback (off by default).
- Protocol-free dir scanning already exists in Codex as reference behavior:
  `rollout/src/list.rs` (`get_threads`, `find_thread_path_by_id_str:1400`,
  `parse_timestamp_uuid_from_filename:930`); doctor `cli/src/doctor/thread_inventory.rs:98,440-523`.

### 5.2 Trigger: the goal stop is on disk three independent ways

- **Rollout marker (verified against 132 real records):** an `event_msg` line with
  `payload.type == "thread_goal_updated"` and `payload.goal.status == "usageLimited"`
  (**camelCase** in rollout JSON). Emitted by **core**, not the app-server
  (`core/src/session/turn.rs:148,298,387` → `core/src/goals.rs:1168,1209-1217` → `send_event` →
  `persist_rollout_items`, `core/src/session/mod.rs:1771-1774`), always persisted (Limited mode,
  `rollout/src/policy.rs:143`). Resume is the mirror: a later `thread_goal_updated` with
  `status == "active"`. A real lifecycle was observed on disk: active → usageLimited → active →
  complete. Full status set (rollout camelCase): `active, paused, blocked, usageLimited,
  budgetLimited, complete` (`protocol/src/protocol.rs:3497-3504`).
- **SQLite (demoed in §4.2):** `goals_1.sqlite` `thread_goals.status` (**snake_case**
  `usage_limited`). ⚠️ Case differs from the rollout JSON — handle both spellings.
- **`token_count` rollout event** carries `rate_limits {primary/secondary {used_percent,
  resets_at}}` (`protocol/src/protocol.rs:1995-2048`) — useful for the *reset time*, but
  `rate_limit_reached_type` is usually `null` even at the pause, so it's corroboration only.
- **Pane fallback:** the footer renders the unique string **`Goal hit usage limits (/goal resume)`**
  for UsageLimited (`tui/src/bottom_pane/footer.rs:543-567`; `tui/src/chatwidget/goal_status.rs:45-66`).
- **No separate on-disk quota cache exists** (`~/.codex` has only `auth.json` tokens, no live
  quota file). So AIMGR's account usage probe is a genuinely independent backend signal.

### 5.3 Resume + confirm works with no external app-server (verified)

- The plain TUI defaults to an **in-process embedded** app-server (`AppServerTarget::Embedded`,
  `tui/src/lib.rs:289-301,825-841`) — no `--remote`, no WS. `codex resume <T>` shows the
  **"Resume paused goal?"** prompt for a `usageLimited` goal exactly as before
  (`tui/src/app/thread_goal_actions.rs:51-79`; prompt at `tui/src/chatwidget/goal_menu.rs:35-68`;
  triggered post-resume at `tui/src/app/session_lifecycle.rs:749-753`). Default option is
  "Resume goal" → sets status Active. So AIMGR's existing pane-scrape + Enter keeps working.
- A `usage_limited` goal does NOT auto-reactivate; it needs the Active write the Enter produces
  (carried-over fact, §4.4). Confirm resumption via the SQLite/rollout status flipping to
  `active`, or pane text `Pursuing goal`.
- **No headless goal driving:** `codex exec` has zero goal affordances — keep the TUI as the
  interface.

---

## 6. aimgr code seams (what changes — preliminary)

To be expanded once the design is locked. Known touch points:
- `src/targets/codex-tender.js` — remove `startCurrentAppServer`/`discoverOwnedThreadId`/the
  `thread/loaded/list` discovery block (`:318-336,609-624,698-716`); replace with identity
  acquisition + SQLite/usage trigger; keep tmux launch/resume/exit + pane confirm.
- `src/targets/codex-app-server.js` — DELETE from the tend path (no private app-server, no WS
  client). (`listCodexThreads`/`requestCodexAppServer` helpers go too unless used elsewhere.)
- `buildCodexCommand` (`:171-185`) — drop `--remote`; add the id-forcing flag/env if available.
- New: a small read-only reader for `goals_1.sqlite` (Node `node:sqlite` if engine ≥ 22.5, else
  shell out to the `sqlite3` binary present on macOS), and a `session_meta` reader / dir watcher.
- Tests `test/codex/codex-10.cases.js` — the fake app-server (`:71-92`) and discovery tests
  (`:436-545,1030`) get replaced with disk/sqlite fakes.

---

## 7. Risks / edge cases to address in the plan

- Identity race if forcing the id isn't possible: need a unique marker for the watch; define it.
- Rollout-file appearance latency (created at start vs first turn) — watch must tolerate the gap.
- SQLite read robustness under heavy concurrent writes: use `mode=ro`, retry on transient
  `SQLITE_BUSY`, never write.
- `goals_1.sqlite` filename is versioned (`_1`) — handle a future bump (discover the file).
- This redesign fixes IDENTITY + removes the app-server. It does NOT fix Finding 1 (machine-global
  `auth.json`/state rotation cross-talk) — call that out as separate/again.

---

## 8. Independent review (fresh-consult, Cursor Composer 2.5 Fast — 2026-05-30)

Ran an adversarial fresh-consult on this plan + both codebases, focused on many simultaneous
tends in one repo. (First attempt on gpt-5.5 xhigh was blocked by a Codex `auth.json` 401 — the
live machine-global-auth fragility; re-run on Composer 2.5 Fast.) Run dir:
`/tmp/fresh-consult/tend-redesign-composer-20260530T144809Z-OPqJ98/`.

**VERDICT: fail** — not because the identity design is wrong (the reviewer agrees it's well
grounded in Codex and fixes the discovery bug), but because **fixing thread identity alone does
NOT make multiple simultaneous tends in one repo "just work."** Shared-auth (Finding 1) is the
unsolved other half and is a **blocking prerequisite**, not an optional follow-up.

### 8.1 Blocking (agreed after spot-check)
- **Auth isolation is the real blocker for multi-tend.** Rotation still rewrites the single
  `~/.codex/auth.json` + the single `state.targets.codexCli.activeLabel`
  (`codex-cli.js:44-63,456-600`). Two tenders in one repo: A rotates → auth=X; B rotates μs later
  → auth=Y (clobbers A); A's `codex resume <T_A>` then reads **Y's** tokens → **right thread,
  wrong account**; `avoidCurrentLabel` (computed from shared `currentLabel`,
  `codex-tender.js:844-852`) makes both pick the **same** next label → thrash. The per-thread
  goal trigger is immune to this (good) but does nothing to fix it.
- **Non-goal usage detection reads the shared active label** (`detectActiveCodexUsageRateLimit`,
  `codex-tender.js:468-515`) → spurious/missed rotations under concurrency (Finding 3).
- **The identity env-var is NOT wired into the tmux launch (VERIFIED in current code).**
  `buildCodexCommand` emits a bare `codex --no-alt-screen …` string (`codex-tender.js:171-185`)
  and `createTmuxAdapter.newSession` runs `tmux new-session … <command>` with **no env**
  (`:197-216`). `tmux new-session` runs the command in the **tmux server's** environment, so
  `process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE` set by aimgr will **not** reach the codex
  process. The implementation MUST either embed `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=<val>` as a
  prefix in the command string (shell-quoted) or use `tmux new-session -e KEY=val`. Until then
  the identity mechanism is design-only.

### 8.2 Hardening requirements the plan must specify (agreed)
- **Collision-resistant `runid`.** Do NOT derive it from bare `Date.now()` (cf.
  `buildCodexTenderSessionName`, `codex-tender.js:193-194`) — two tenders in the same ms collide.
  Use PID + random/UUID so concurrent same-repo tenders never share an originator.
- **Watcher must match `originator == aimgr-tend-<runid>`, not "first new rollout."** With ~1.5k
  rollouts and concurrent writers a naive newest-file watch binds the wrong session (TOCTOU).
- **Goal-status reads: prefer the rollout tail under write storms.** Append-only rollout JSONL
  never takes a lock; `goals_1.sqlite` readers can still hit `SQLITE_BUSY` under dozens of
  writers → retries are mandatory if using SQLite. Reviewer recommends rollout-`thread_goal_updated`
  keyed by `T` as the more robust trigger; SQLite is the simpler-but-lockable alternative.
- **`goals_1.sqlite` is a versioned filename** (`state/src/lib.rs:82`) → discover it, don't hardcode.
- **`node:sqlite` needs Node ≥ 22.5; `package.json` engines say ≥ 20** → either require 22.5+ or
  shell out to the `sqlite3` CLI (or read the rollout instead and avoid SQLite entirely).
- **Fixed `--tmux-session` across tenders still collides** (Finding 6) — keep names unique per run.

### 8.3 Confirmed (reviewer independently corroborated the Codex-source claims)
Originator override read from env first (`login/src/auth/default_client.rs:57-61`) → written to
`session_meta.originator` (`recorder.rs:673-678`); top-level TUI `thread_source: None`
(`thread_manager.rs:567-571`); sub-agents `Subagent` (`codex_delegate.rs:88-90`); `codex exec`
sets `thread_source: User` (excluded by the absent-filter); `source == "cli"`; `codex resume <T>`
fatal-on-miss with a fuzzy filename fallback only when the index misses. So the identity FILTER
(`originator==runid` AND `thread_source` absent AND `source=="cli"`) is sound for the new-session
case — the gap is wiring + auth, not the filter logic.

### 8.4 Decision this forces (for the user)
The user's goal is "multiple simultaneous tends in one repo just works." That requires BOTH:
(1) the thread-identity fix in this doc, AND (2) **account isolation** — currently out of scope as
Finding 1. With one shared `auth.json`, all concurrent codex processes use whichever account is in
that file *right now*; true per-tender accounts are impossible without isolating auth. Options to
evaluate next: **per-tender `CODEX_HOME`** (real isolation, but plain `codex resume` from the
default `~/.codex` won't see those sessions unless that home is exported — aimgr would own the
resume path) vs. a **rotation lock + accept one shared account at a time** (no load-spreading
across simultaneous tends). This is a scope decision, not a detail.

## 9. Changelog of this doc
- 2026-05-30: Created. Seeded with redesign direction, competing-app-server evidence, the
  goals_1.sqlite read-only demonstration, session_meta identity facts, carried-over Codex
  internals, open research questions, code seams, risks. Two protocol-free agents in flight.
- 2026-05-30 (update): Both protocol-free investigators returned. LOCKED the identity mechanism
  (force-id impossible → `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` unique-originator + rollout-dir
  watch) and the trigger (per-thread goal status from SQLite/rollout + usage probe; pane
  fallback). Added §5.1–5.3 with full Codex source citations; recorded the first-turn
  materialization timing caveat and the camelCase(rollout)/snake_case(sqlite) status spelling
  difference. Confirmed plain-TUI resume + Enter needs no external app-server. Next: write the
  full implementation plan (state machine, exact seams, migration, tests).
- 2026-05-30 (review): Adversarial fresh-consult (Composer 2.5 Fast) returned VERDICT: fail —
  added §8. Core point: the identity design is sound but does NOT make multi-tend "just work"
  while shared-auth (Finding 1) is unfixed; auth isolation is a blocking prerequisite. VERIFIED a
  real implementation gap: the originator env var is not wired into the tmux launch and tmux's
  server-env semantics require embedding it in the command string. Logged hardening reqs
  (collision-resistant runid, originator-match watcher, SQLITE_BUSY/rollout-tail, node:sqlite
  version, fixed-tmux-name). Next: get the user's scope decision on auth isolation (per-tender
  CODEX_HOME vs. rotation lock) before writing the implementation plan.
