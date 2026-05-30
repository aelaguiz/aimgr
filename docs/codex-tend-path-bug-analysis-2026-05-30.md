# Codex `--tend` path: wrong-thread / wrong-goal bug analysis

**Date:** 2026-05-30
**Scope:** `aim codex run --tend` (the tmux-backed local Codex TUI tender for `/goal` sessions)
**Status:** Analysis only — no code changed. This document explains *why* the tend path
resumes the wrong thread / wrong goal and where its single-instance assumptions break when
many Codex instances run against one machine.

---

## 0. TL;DR

The tender is built on three assumptions about Codex. Two are wrong, and a third is a
machine-global singleton that silently couples every concurrent tender together:

1. **"My private app-server has exactly one loaded thread, and it's mine."** — FALSE.
   Codex loads *its own sub-agent threads* (explorers, review, compaction) into the same
   app-server. A single `/goal` that fans out makes the loaded-thread count exceed 1, so
   new-session thread discovery can bind nothing and **block as `ambiguous_loaded_threads`**.
   (Confirmed in Codex source + measured: tender goals spawn 10–23 sub-agent threads each.)

2. **"Account rotation is local to this tender."** — FALSE. Rotation rewrites the single
   machine-global `~/.codex/auth.json` and the single `~/.aimgr/secrets.json`
   `targets.codexCli.activeLabel`. Every concurrent tender (and every other `codex`
   process on the box) shares those files. Concurrent tenders **clobber each other's
   account**, collapse onto one label, and thrash. This is the real "assumes one instance"
   bug — and it is *per-machine*, not *per-repo*.

3. **"The active label in AIM state tells me which account my session is on."** — FALSE under
   concurrency. The non-goal rate-limit detector probes usage for whatever label is in shared
   state, which another tender may have just overwritten → spurious or missed rotations.

Several things people *suspect* are broken are actually robust and were ruled out (see §6):
sibling Codex instances do **not** leak into a tender's loaded-thread list; goal state is
**not** a global singleton; `threadId` **does** equal the resume `SESSION_ID`; and
`codex resume` does **not** silently fall back to the most-recent session.

The honest answer to "is it one-instance-per-repo or one-instance-per-machine?": the
thread/goal *identity* plumbing is fine across instances, but the **auth/rotation layer is a
machine-global singleton** and the **per-tender thread-discovery heuristic is defeated by
Codex's own sub-agents**. Those two are the core defects.

---

## 1. How the tend path works (ground truth)

Entry: `aim codex run --tend` → `handleCodex` (`src/cli/commands/codex.js:15-49`) →
`runCodexTender` (`src/targets/codex-tender.js:545-939`).

There are **two modes**, decided by whether a session id was supplied:

- **RESUME mode** — `--resume <id>` / `--session-id <id>` / `-- resume <id>`.
  `threadId` is set up front from the user-supplied UUID
  (`src/targets/codex-tender.js:584`, `normalizeCodexInvocation` at `:135-169`). Thread
  discovery is **skipped**.
- **NEW mode** — no session id. `threadId` starts `null` and must be *discovered* from the
  private app-server (`discoverOwnedThreadId`, `:318-336`, called at `:698-716`).

Lifecycle in both modes:

1. **Private app-server.** `startPrivateCodexAppServer` spawns
   `codex app-server --listen ws://127.0.0.1:<freeport> --enable goals` with
   `CODEX_HOME=<managed home>` (`src/targets/codex-app-server.js:209-239`). The home is
   resolved by `resolveManagedCodexHomeDir` → **`~/.codex`** unless `CODEX_HOME` is
   overridden (`src/io/paths.js:89-95`). "Private" means *private TCP port only* — the
   home is shared.
2. **TUI in tmux.** `buildCodexCommand` builds
   `codex --no-alt-screen --remote <ws-url> [-p <profile>] (resume <threadId> | <args>)`
   and `tmux.newSession` launches it (`:171-185`, `:669-685`). The TUI talks to the private
   app-server as its backend over `--remote`.
3. **Poll loop** (`:696-927`), every `pollSeconds` (default 5s):
   - NEW mode only: `discoverOwnedThreadId` → bind **iff exactly one** loaded thread;
     `>1` → return `blocked / ambiguous_loaded_threads`; `0` → keep waiting (`:698-716`).
   - `readGoal` → `thread/goal/get { threadId }`; if `goal.status === "usageLimited"`
     → recovery (`:718-727`).
   - Non-goal recovery triggers: new rate-limit text scraped from the tmux pane
     (`detectNewPaneRateLimit`, `:428-453`) or a hard-limited usage snapshot for the
     *shared active label* (`detectActiveCodexUsageRateLimit`, `:468-515`).
4. **Recovery** (`:781-924`): rotate account → `/exit` the old TUI → wait for it to die →
   stop+restart the private app-server → `codex resume <threadId>` in a fresh tmux session →
   for goal recovery, scrape the pane for `Resume paused goal?` and send Enter
   (`confirmResumePrompt`, `:352-407`).

Key constants: `STOPPED_FOR_ROTATION_STATUSES = {"usageLimited"}` (`:14`); session-id regex
(`:15`); pane rate-limit patterns (`:17-24`).

---

## 2. Confirmed Codex internals (from reading `~/workspace/codex/codex-rs`)

These were verified against the Codex Rust source and are the load-bearing facts for the
analysis. Citations are `codex-rs/...`.

### 2.1 `thread/loaded/list` is per-process **but includes your own sub-agents**

- It returns **only this app-server process's in-memory thread map**
  (`Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>`), never a disk/rollout scan and never
  another process's threads.
  - Handler: `app-server/src/request_processors/thread_processor.rs:2002-2013` →
    `core/src/thread_manager.rs:942-951` (`list_thread_ids`), map defined at
    `thread_manager.rs:199-200`, "process-scoped" at `message_processor.rs:303-328`.
  - README: *"returns thread ids currently loaded in memory … without scanning rollouts on
    disk"* (`app-server/README.md:352`).
- **Crucially, the list filters out only `SessionSource::Internal(_)` (memory consolidation).
  It does NOT filter `SessionSource::SubAgent(_)`** — which includes `Review`, `Compact`, and
  `ThreadSpawn` (explorers).
  - Filter: `thread_manager.rs:942-951`; `is_internal` at `protocol/src/protocol.rs:2572-2574`;
    SubAgent variants at `protocol.rs:2522-2537`; sub-agents inserted via
    `finalize_thread_spawn` (`thread_manager.rs:1310-1318`) from `agent/control.rs:228-281`.
- **Implication:** a single `/goal` session that runs reviews / compaction / spawns explorer
  agents will have **>1 loaded thread** in *its own* private app-server.

### 2.2 `thread/goal/get` and `thread/read` are id-keyed and safe

- Both resolve **by globally-unique `ThreadId` (UUIDv7)** against the shared on-disk store;
  they work whether or not the thread is loaded in this process, and cannot alias to another
  session's data. (`thread_processor.rs:2142-2156`,
  `thread_goal_processor.rs:251-268`, `:339-368`; `protocol/src/thread_id.rs:18-22`.)
- `thread/goal/get` returns `{"goal": null}` (not an error) when a thread has no goal.

### 2.3 Goal status + resume semantics

- Wire enum (camelCase): `active`, `paused`, `blocked`, **`usageLimited`**, `budgetLimited`,
  `complete` (`protocol/src/protocol.rs:3494-3504`;
  `app-server-protocol/src/protocol/v2/thread.rs:652-661`). AIM keying on `"usageLimited"`
  is **correct**.
- Goal state is **per-thread**: one row keyed by `thread_id TEXT PRIMARY KEY` in a shared
  `goals_1.sqlite` under `CODEX_HOME`; every access is `WHERE thread_id = ?`. **No global
  "active goal" singleton exists.** (`state/goals_migrations/0001_thread_goals.sql:2`;
  `state/src/runtime/goals.rs:41-59`.) → concurrent goals on *distinct* threads cannot
  confuse each other.
- A `usageLimited` goal **does not auto-reactivate on resume**; it stays `usageLimited` until
  a `status=active` write — which is exactly what AIM's Enter-on-"Resume goal" produces
  (`core/src/goals.rs:1221-1267`, `:1360-1434`). The reliance is sound.
- The TUI "Resume paused goal?" prompt appears **iff** the resumed thread's goal is
  `Paused | Blocked | UsageLimited`, AND (for the `codex resume <id>` startup path) **no
  initial prompt/images were passed**, AND the displayed thread still matches
  (`tui/src/app/thread_goal_actions.rs:51-78`; `tui/src/app/thread_routing.rs:1316-1324`).
  The tender's resume command passes no initial prompt, so this gate is satisfied — good.
- The steady-state "running" indicator text is literally **`Pursuing goal`**, not
  `Goal active` (`tui/src/bottom_pane/footer.rs:544-566`). AIM's regex
  `/Goal active|Pursuing goal|Goal achieved/` happens to include `Pursuing goal`, so it still
  matches — but the footer can collapse to nothing under narrow width or when a
  collaboration-mode indicator is shown (`footer.rs:529,579-580`), so pane scraping is not
  guaranteed.

### 2.4 `threadId == SESSION_ID`, and resume is exact (no most-recent fallback)

- The printed `codex resume <uuid>` hint is the session `conversation_id` =
  rollout `meta.id`. On resume the app-server thread's id is set to that `meta.id`, so
  `threadId == SESSION_ID` under normal operation. A *new* (non-resumed) thread gets a fresh
  `Uuid::now_v7()`. (`core/src/session/session.rs:520-525`;
  `app-server/src/request_processors/thread_processor.rs:3008-3022,3932-3935`.)
- `codex resume <id>` on a miss **exits fatally** ("No saved session found with ID …") — it
  does **not** load the most-recent session (`tui/src/lib.rs:1474-1488,1549-1559`).
  Bare `codex resume` opens the picker; most-recent only happens with `--last`.
- **One non-exact path exists:** if the shared SQLite `threads` index misses/errs, resolution
  falls back to a **nucleo fuzzy filename match (`limit=1`, not re-verified)** over all
  rollouts (`rollout/src/list.rs:1272-1395`, `:1369-1372`). For a full 36-char UUID a false
  hit is improbable but not impossible — relevant under heavy concurrent DB load (§5.5).

### 2.5 Empirical confirmation (this machine's `~/.codex`, 2026-05-30)

- **1,584 distinct session rollouts**; **0** UUIDs appear in more than one file → `codex
  resume` reuses the id (appends), it does **not** fork → the tender's stored `threadId`
  stays valid across resumes. (Rules out a resume-fork bug.)
- **Many concurrent Codex instances per repo, sharing `~/.codex`.** In the last ~120 rollouts:
  PRIMARY (non-subagent) sessions by originator = `aimgr_codex_tender: 3`, `codex-tui: 2`,
  `codex_exec: 1`; SUBAGENT sessions = `aimgr_codex_tender: 29`, `codex-tui: 8`,
  `codex_exec: 7`, `codex_dock_relay: 2`. The single repo `gw_controls` had **42** sessions
  including **≥2 concurrent `aimgr_codex_tender` primary goals** (`019e788c`, `019e7899`) plus
  a `codex_exec` primary.
- **Each tender goal spawns ~10–23 explorer sub-agents** (originator `aimgr_codex_tender`,
  `thread_source: subagent`, `agent_role: explorer`), first sub-agent landing +70s to +567s
  after the parent.
- **Single shared `~/.codex/auth.json`** with one `account_id` — the machine-global account.

---

## 3. FINDING 1 (HIGH impact, HIGH likelihood) — rotation is a machine-global singleton

**This is the central multi-instance defect.**

The managed Codex home is `~/.codex` for every tender (`src/io/paths.js:89-95`), so there is
exactly **one** `~/.codex/auth.json` and **one** `~/.aimgr/secrets.json` for the whole
machine. Rotation writes both:

- `applyCodexCliFromState` writes `~/.codex/auth.json` and sets
  `state.targets.codexCli.{activeLabel,expectedAccountId,homeDir,lastAppliedAt}`
  (`src/targets/codex-cli.js:44-72`).
- `activateCodexPoolSelection` (the rotation called from the tender) re-selects a label and
  calls `applyCodexCliFromState`, then `writeJsonFileWithBackup(statePath, state)`
  (`src/targets/codex-cli.js:456-601`; invoked from `rotateCodexAccount`,
  `src/targets/codex-tender.js:521-543`).
- `preserveLiveCodexAuthForActiveLabel` reads the same `~/.codex/auth.json` and the same
  `target.activeLabel` (`src/targets/codex-cli.js:212-308`).

There is **no lock, pidfile, or per-instance namespace** anywhere in the codex path (verified
by grep: the only isolation primitive is the `CODEX_HOME` env override).

**Failure mode with N concurrent tenders (the user's actual setup):**

1. Tender A hits `usageLimited`, rotates to label **X**, writes `auth.json = X`,
   `state.activeLabel = X`.
2. Tender B hits `usageLimited` (or a non-goal trigger) microseconds later, rotates to **Y**,
   writes `auth.json = Y`, `state.activeLabel = Y` — clobbering A.
3. A's fresh `codex resume <A-thread>` starts and reads `auth.json` — now **Y**. **A's
   session silently runs under B's account.** Both A and B are now on **Y** → both exhaust Y →
   both rotate again → **rotation thrash** and collapse onto a single account, defeating the
   whole point of the pool.
4. `avoidCurrentLabel: true` (`src/targets/codex-tender.js:816`) is computed from the shared
   `currentLabel`, so both tenders "avoid" the *same* current label and tend to **pick the
   same next label**, amplifying the collapse rather than spreading load.

**Why the user perceives this as "wrong":** the resumed session is on the wrong *account*,
hits limits immediately, and may bounce through several restarts. The thread content is
correct (rollouts are local), but the behavior — repeated rotations, limited account, churn —
reads as the tender mishandling the session.

**Note on framing:** this is *per-machine*, not *per-repo*. Even one tender per repo across
several repos collides, because they all share `~/.codex/auth.json`.

---

## 4. FINDING 2 (HIGH-confidence design flaw, situational impact) — sub-agents defeat thread discovery

`discoverOwnedThreadId` binds the thread **iff `thread/loaded/list` returns exactly one id**,
returns `blocked / ambiguous_loaded_threads` if it returns more than one, and keeps waiting if
zero (`src/targets/codex-tender.js:318-336`, loop at `:698-716`). `cwd` is carried on each
thread object but **never used to disambiguate**.

Per §2.1, the loaded list includes the tender's **own** sub-agent threads. Per §2.5, tender
goals spawn 10–23 of them. So the "exactly one" invariant is violated by Codex's own
architecture — no second human instance required.

**Concrete failure:** if the tender's first non-empty poll lands *after* the goal has spawned
sub-agents, it sees `>1` and returns `blocked / ambiguous_loaded_threads`, leaving the live
session running but un-tended (`app_server_left_running_for_live_session`,
`:701-711`). Because `cwd` is ignored, there is no way for it to pick "the parent in this
repo."

**Timing nuance (why it's intermittent, not constant):** the parent thread is created first
and sub-agents appear +70s..+567s later, while the tender polls every 5s. So a freshly
started NEW-mode session usually catches the parent-only window and binds correctly. It fails
when: a goal fans out fast, the first poll is delayed, `--poll-seconds` is large, or the
tender is pointed at an **already-active** goal that is mid-exploration. This matches the
reported "sometimes."

**Test blind spot:** `test/codex/codex-10.cases.js` fakes `listLoadedThreads` with a
hardcoded single id (`createFakePrivateCodexAppServers`, `:71-92`; "binds to its private
loaded thread", `:436-497`). The "instead of a same-cwd sibling" guarantee is **assumed by
the mock, never exercised against real Codex behavior**, so this whole failure class is
invisible to the suite.

---

## 5. Secondary findings

### 5.1 FINDING 3 (MEDIUM) — non-goal rate-limit detection reads the *shared* active label

`detectActiveCodexUsageRateLimit` loads `~/.aimgr/secrets.json`, takes
`activeLabel ?? inferredLabel`, and probes usage for **that** label
(`src/targets/codex-tender.js:468-515`). Under concurrency the active label may belong to a
*different* tender (Finding 1), so tender A may probe label Y's usage and either **rotate
spuriously** (A's real account was fine) or **miss a real limit** on A's account. Spurious
rotations restart A's session under a new account for no reason and feed the thrash in
Finding 1.

### 5.2 FINDING 4 (MEDIUM) — resume confirmation depends on fragile tmux pane scraping

`confirmResumePrompt` (`:352-407`) polls `tmux capture-pane` for
`/Resume paused goal\?/ && /Resume goal/` and, on timeout, returns
`blocked / resume_prompt_unconfirmed` (`:907-918`). The capture window is `-S -240` lines
(`:225`). Per §2.3 the prompt *should* appear for the tender's own resume (no initial
prompt), but pane-text detection is not guaranteed: the footer/indicator can collapse under
narrow width or a collaboration-mode indicator (`footer.rs:529,579-580`), and capture timing
under a busy TUI is racy. A missed prompt → the `usageLimited` goal is **never re-activated**
(it needs the Enter, §2.3) → the goal stays paused and the tender blocks, which presents as
"it didn't resume my goal." The robust signal (`thread/goal/set status=active`, or reading
`thread/goal/get` status) is available over the app-server but unused for confirmation.

### 5.3 FINDING 5 (MEDIUM) — recovery is gated on a `threadId` that NEW mode may never get

Non-goal recovery is buffered in `pendingRateLimitRecovery` until a `threadId` exists
(`:729-732,757-766`). In NEW mode, if discovery is permanently ambiguous (Finding 2), a real
rate limit is detected but **never acted on** — the tender either blocks (ambiguous) or spins
to `poll_limit_reached`. The recovery path structurally assumes discovery succeeds.

### 5.4 FINDING 6 (LOW) — fixed `--tmux-session` reused across instances → pane cross-talk

The default session name is unique-ish (`aimgr-codex-tend-<ms>`, `:193-194`), but the README
advertises a **fixed** name (`--tmux-session overnight-codex`, README `:747`). Two tenders
sharing one tmux session name will collide: the second `new-session` fails, or pane operations
(`sendExit`, `sendEnter`, `capturePane`) target the **wrong** TUI — sending `/exit` or Enter
into another tender's session. That is a direct "acts on the wrong session" path, but only if
the operator reuses a fixed name.

### 5.5 FINDING 7 (LOW / situational) — fuzzy resume fallback under shared-DB contention

Per §2.4, when the shared `threads` SQLite index misses, `codex resume <id>` / `thread/read`
fall back to an unverified `limit=1` nucleo fuzzy filename match
(`rollout/src/list.rs:1369-1372`). With 1,584 rollouts and many app-servers hammering the one
`state_db` under `~/.codex`, transient index miss/contention is plausible. A full UUID makes a
wrong hit improbable, but this is the *only* code path that can resume a genuinely different
rollout than requested, so it cannot be fully excluded as a rare "wrong thread" cause.

---

## 6. Ruled out (suspected but verified NOT the cause)

Stating these explicitly because they're the intuitive guesses and they're wrong:

- **Sibling Codex instances leaking into the loaded list** — NO. `thread/loaded/list` is
  strictly per-process in-memory; other tenders / `codex-tui` / `codex_exec` against the same
  `~/.codex` are invisible to a tender's app-server (§2.1). The list-pollution comes from the
  tender's *own* sub-agents, not siblings.
- **Goal state being a global/"current goal" singleton** — NO. Per-thread row, `thread_id`
  primary key, every query `WHERE thread_id=?`; no singleton anywhere (§2.3).
- **`threadId` differing from the resume `SESSION_ID`** — NO under normal operation; they are
  the same `meta.id` (§2.4).
- **`codex resume` silently grabbing the most-recent session on a miss** — NO; it exits
  fatally (§2.4).
- **`codex resume` forking to a new id each time, stranding the stored `threadId`** — NO;
  0/1,584 UUIDs are duplicated, resume appends to the same rollout (§2.5).

---

## 7. The single-instance assumptions, named

| # | Assumption baked into the tender | Reality | Where it bites |
|---|----------------------------------|---------|----------------|
| 1 | One Codex **account** per machine; this tender owns `auth.json` + active label | `~/.codex/auth.json` and `~/.aimgr/secrets.json` are machine-global singletons; every tender + every `codex` shares them | Finding 1, 3 |
| 2 | My private app-server has exactly **one loaded thread** (mine) | Codex loads my own sub-agent threads too; count > 1 | Finding 2, 5 |
| 3 | The pane reliably shows the resume prompt / active text | tmux capture is racy; footer can collapse | Finding 4 |
| 4 | Recovery always has a `threadId` | NEW mode may never resolve one | Finding 5 |
| 5 | tmux session name is mine alone | fixed `--tmux-session` is shared | Finding 6 |
| 6 | Resume resolves my id exactly | true unless the shared DB index misses → fuzzy fallback | Finding 7 |

The user's hypothesis ("assumes one instance per repo") is directionally right but **mislocated**:
the breakage is **per-machine** (auth/state singleton, Finding 1) and **per-single-goal**
(sub-agent discovery, Finding 2), not specifically per-repo.

---

## 8. What a correct design must guarantee (requirements, not fixes)

Recorded for the eventual fix; nothing here is implemented.

1. **Per-instance account isolation.** A tender's account/rotation must not be visible to or
   clobbered by other tenders. Candidates: a dedicated `CODEX_HOME` per tender (the one
   isolation primitive Codex already honors), or per-tender auth wiring, so rotation is local.
   Whatever the choice, the "active label" used for usage detection (Finding 3) must be the
   one *this* tender activated, not shared state.
2. **Identity-based thread binding, not count-based.** NEW-mode discovery must identify *the
   thread this tender started* (e.g., capture the `thread/start` id from the app-server event
   stream, or filter `thread/loaded/list` to non-sub-agent top-level threads by
   `session_source`/`cwd`) instead of assuming exactly one loaded thread. It must tolerate the
   tender's own sub-agents.
3. **App-server-truth for goal lifecycle.** Confirm/resume via `thread/goal/get` status and
   `thread/goal/set status=active` rather than scraping the tmux pane (Finding 4); reads are
   already exact and id-keyed (§2.2).
4. **Verify resume landed on the requested id.** After `codex resume <id>`, confirm the live
   thread id equals the requested id (guards Finding 7's fuzzy fallback).
5. **Unique tmux session per tender**, always (guard Finding 6).

---

## 9. Evidence index

**aimgr (`src/`)**
- Tender core + discovery + recovery: `src/targets/codex-tender.js`
  (`:14`, `:135-185`, `:318-336`, `:468-515`, `:521-543`, `:545-939`, `:698-716`, `:781-924`).
- Private app-server + WS client: `src/targets/codex-app-server.js`
  (`:186-207`, `:209-239`).
- Shared managed home: `src/io/paths.js:89-95`.
- Rotation / auth write / preserve / active-label: `src/targets/codex-cli.js`
  (`:19-73`, `:75-116`, `:212-308`, `:456-601`); `src/targets/codex-store.js`.
- CLI wiring + args: `src/cli/commands/codex.js:15-49`; `src/cli/args.js:149-208`.
- Test fiction (single hardcoded loaded thread): `test/codex/codex-10.cases.js:71-92,436-545`.

**Codex (`~/workspace/codex/codex-rs/`)**
- Loaded-list per-process + sub-agent inclusion: `app-server/src/request_processors/thread_processor.rs:2002-2013`;
  `core/src/thread_manager.rs:199-200,942-951,1310-1318`; `app-server/src/message_processor.rs:303-328`;
  `protocol/src/protocol.rs:2522-2537,2572-2574`; `app-server/README.md:352`.
- Goal status enum + per-thread store: `protocol/src/protocol.rs:3494-3504`;
  `app-server-protocol/src/protocol/v2/thread.rs:652-661`; `state/goals_migrations/0001_thread_goals.sql:2`;
  `state/src/runtime/goals.rs:41-59`; `core/src/goals.rs:1221-1267,1360-1434`.
- Resume prompt gating: `tui/src/app/thread_goal_actions.rs:51-78`; `tui/src/app/thread_routing.rs:1316-1324`;
  footer text: `tui/src/bottom_pane/footer.rs:529,544-566,579-580`.
- threadId == SESSION_ID + exact/fuzzy resume: `core/src/session/session.rs:520-525`;
  `app-server/src/request_processors/thread_processor.rs:3008-3022,3932-3935`;
  `tui/src/lib.rs:1474-1488,1549-1559`; `rollout/src/list.rs:1272-1395`; `protocol/src/thread_id.rs:18-22`.

**Empirical (`~/.codex`, 2026-05-30)**
- 1,584 rollouts, 0 duplicate UUIDs; concurrent `aimgr_codex_tender` primaries in one repo;
  10–23 sub-agents per tender goal; single shared `auth.json` / one `account_id`.
