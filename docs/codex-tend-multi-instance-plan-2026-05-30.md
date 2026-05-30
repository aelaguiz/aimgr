# Multi-instance Codex `--tend` — the plan

> **Superseded on 2026-05-30.** Do not implement this tmux-backed plan. The live Tend cutover is
> `docs/CODEX_TEND_PTY_SUPERVISOR_CUTOVER_2026-05-30.md`, which replaces the tmux runtime with an
> AIMGR-owned foreground PTY supervisor and keeps the rollout-originator ownership model.

**Date:** 2026-05-30
**Status:** Plan under active review (iterating against an independent reviewer until it passes).
**Evidence base:** `docs/codex-tend-path-bug-analysis-2026-05-30.md` (bug analysis) and
`docs/codex-tend-redesign-2026-05-30.md` (protocol-free research log, with Codex source citations).
**Constraints:** Only `aimgr` changes (cannot modify Codex). No Codex app-server / WebSocket
`thread/*` protocol. No new background daemons.

---

## 1. Intent (the actual goal)

Make `aim codex run --tend` work correctly when **many tenders run at the same time** — multiple
in one repo (same `cwd`), all sharing one `~/.codex` — each tending its own `/goal` session across
the machine's account rotation. It must "just work" with no operator reasoning about cross-instance
interference. Elegant, minimal, protocol-free.

The core defect today (from the analysis): tend **guesses** which thread is "mine" by counting
loaded threads on a private Codex app-server (`discoverOwnedThreadId`). Codex's own sub-agents and
multiple instances break that guess → it binds the wrong thread, blocks as ambiguous, or resumes
the wrong goal. The fix is to stop guessing.

## 2. Design stance — what is intentionally SHARED (these are NOT bugs)

This plan deliberately does **not** isolate accounts or homes. Stated explicitly so reviewers don't
re-flag them:

- **Accounts are one shared, fungible pool.** `~/.codex/auth.json` is machine-global and is rotated
  **globally** when the active account is exhausted. A tended session continuing on whatever account
  is currently active is **by design**. (This is "Finding 1" from the analysis, intentionally kept.)
- **Tend correctness is account-independent.** All per-session state — the goal row and the rollout —
  is keyed by the globally-unique thread id `T` (`goals_1.sqlite` `thread_id PRIMARY KEY`;
  `codex resume <T>` resolves by id). So which account is in `auth.json` never changes *which thread
  or goal* a tender resumes. Shared auth cannot cause a wrong-thread/wrong-goal outcome.
- **Global rotation is the intended behavior.** When the shared account hits its limit, every tender
  on it sees its own goal flip to `usageLimited` and rotates the machine to a fresh pool account;
  they converge on a working account. Redundant rotations are tolerated (see §7).

The single thing that MUST be correct per-tender is **thread identity**. That is this plan's entire
job.

## 3. The invariant

> **Each tender owns its thread id `T` from the moment its session is created, records it, and
> operates only on `T` for everything afterward — goal status, recovery, resume, verification.
> There is no discovery-by-count and no guessing. Concurrent tenders never collide because each
> keys all of its reads and actions on its own globally-unique `T` and its own unique run tag.**

`T` is a Codex thread/session UUIDv7 (`session_meta.id`, also embedded in the rollout filename).
A tender knows `T` before it ever needs to poll or resume.

## 4. Architecture (protocol-free, shared `~/.codex`, no app-server)

The tender is a **read-only observer of Codex's on-disk files + a tmux driver of the plain Codex
TUI.** No private app-server, no `--remote`, no `thread/*` calls.

```
launch plain codex TUI in tmux  ──►  establish T (own it)  ──►  tend loop on T:
  env: CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>      ├─ tail T's rollout for goal status
  cmd: codex --no-alt-screen [-p yolo] [args]   (NO --remote)     ├─ usageLimited?  → rotate (global) → codex resume T → Enter
  watch ~/.codex/sessions for the rollout whose session_meta      └─ verify resumed (status active)
        .originator == aimgr-tend-<runid> && thread_source=="user"
        && source=="cli"   →   T = session_meta.id
```

### 4.1 Identity — establish and own `T`

- **Stamp a unique run tag.** Launch the TUI with env
  `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`. Codex writes this verbatim into the new
  session's `session_meta.originator` (`login/src/auth/default_client.rs:57-61` →
  `rollout/src/recorder.rs:673-678`). `<runid>` is **collision-resistant**: `pid` + a random
  suffix (e.g. `${pid}-${hex8}`), NOT a bare timestamp — two tenders must never share a tag.
- **Wire the env through tmux correctly (verified gap — MANDATORY).** `tmux new-session` runs the
  command in the *tmux server's* environment, not aimgr's, so setting it on aimgr's `process.env`
  does nothing. The override MUST be **embedded in the command string**
  (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=<val> codex …`, shell-quoted) or passed via
  `tmux new-session -e CODEX_INTERNAL_ORIGINATOR_OVERRIDE=<val>`. Today `buildCodexCommand`
  (`codex-tender.js:171-185`) and the tmux adapter (`:197-216`) pass **no** env — this is the one
  thing that makes identity work and it does not exist yet. (No `CODEX_HOME` is set — the tender
  uses the default `~/.codex`; homes are intentionally not isolated, §2.)
- **Watch for the rollout, match by tag (CORRECTED FILTER — verified on disk).** Poll
  `~/.codex/sessions/**/rollout-*.jsonl` for a file whose first JSONL line is
  `{type:"session_meta", payload:{…}}` with **`payload.originator == "aimgr-tend-<runid>"`** AND
  **`payload.thread_source == "user"`** AND **`payload.source == "cli"`**. `T = payload.id` (also
  the UUID in the filename). Match on the **tag**, never "newest file" (avoids TOCTOU with ~1.6k
  rollouts + concurrent writers); scope the scan by `mtime ≥ tender-start` for speed.
  - **Why `thread_source == "user"`, not absent (corrected from round 1):** plain TUI top-level
    sessions write `thread_source: Some(ThreadSource::User)` (`tui/src/app_server_session.rs:1384`),
    serialized `"user"` — NOT absent. Verified on this machine: top-level `codex-tui` sessions =
    `(thread_source="user", source="cli")`; sub-agents = `(thread_source="subagent", source=obj)`.
    The earlier "absent" claim was wrong and would have matched zero sessions.
  - **Why `source == "cli"`:** plain TUI (no `--remote`) writes `source: "cli"`; the *current*
    `--remote` tend writes `source: "vscode"` (verified on disk). So dropping `--remote` (§5) is
    required for this check to hold — and it doubles as an assertion that `--remote` is gone.
- **Sub-agent exclusion is the load-bearing discriminator.** A tended goal spawns ~10–23 sub-agent
  rollouts that inherit the same `originator` tag, but they carry `thread_source:"subagent"` /
  object `source` (`core/src/codex_delegate.rs:88-90`). The `thread_source == "user"` clause excludes
  them; combined with the unique `runid` tag, exactly one top-level session matches. Resolved by
  identity, not by count.
- **First-turn timing + bind timeout.** The rollout file materializes on the **first user turn**,
  not at launch (`core/src/session/mod.rs:1190-1196,3137`); `T` resolves once the user starts the
  `/goal`. Before that there is nothing to tend — the tender waits and never acts without `T`. But
  the wait is **bounded**: if no matching rollout appears within a configurable window after the
  first observed pane activity, fail loudly (env likely miswired) rather than heartbeat forever.
  **Binding rule (robust to pre-goal chat / multiple threads).** `T` is not merely "the first
  thread the user typed in" (the rollout binds on first *message*, which could be a pre-goal chat).
  Among tag-matching top-level (`user`/`cli`) sessions, bind the one whose rollout carries the
  `/goal` (a `thread_goal_*` record) — tend tends a goal, so identity = *my goal's thread*. Normally
  exactly one exists. If two tag-matching top-level threads both carry goals (operator ran multiple
  `/goal`s in one tended TUI), that is genuinely ambiguous → **block/warn**, don't guess.
- **RESUME mode** (`--resume <id>`): `T` is given; identity is trivially owned; skip the watch.

### 4.2 Trigger — detect that *my* goal stopped for a usage limit

- **Primary: tail `T`'s rollout** for an `event_msg` line with `payload.type ==
  "thread_goal_updated"` and `payload.goal.status == "usageLimited"` (camelCase in rollout JSON;
  written by core, `core/src/session/turn.rs:148` → `goals.rs:1209-1217` → persisted always in
  Limited mode, `rollout/src/policy.rs:143`; verified against 132 real records). The rollout is an
  **append-only plain file** — reads never take a lock and never contend, even with dozens of live
  codex processes. This is strictly more robust than reading `goals_1.sqlite` (which can throw
  `SQLITE_BUSY` under heavy writers and whose filename is versioned).
  Tail semantics: read **only complete `\n`-terminated lines** (a concurrent writer can leave a
  partial final line); track byte offset and re-read on growth.
- **Fallback: pane text.** The TUI footer renders the unique string
  `Goal hit usage limits (/goal resume)` (`tui/src/bottom_pane/footer.rs:543-567`).
- **`goals_1.sqlite` is the alternative, not the default.** If used, open `mode=ro`, retry on
  `SQLITE_BUSY`, and discover the versioned filename. Default to the rollout tail.
- **DELETE the shared-state non-goal recovery triggers (required for many-tenders).** The current
  poll loop also rotates on `detectActiveCodexUsageRateLimit` (reads the **shared** active label)
  and `detectNewPaneRateLimit` (pane rate-limit text) — `codex-tender.js:468-515,428-453,729-755`.
  Under many simultaneous tenders these fire on *another* tender's account/limit and cause
  **spurious exits/restarts** of a perfectly healthy `T`. The new trigger is **only** `T`'s own goal
  status from `T`'s rollout (with the pane `Goal hit usage limits` as a same-`T` fallback). These
  two non-goal triggers must be **removed** (or hard-gated to `T`'s rollout status), not kept.
- **Account-usage probe is used ONLY to choose the next account on rotate**, never as a trigger.
  (`activateCodexPoolSelection` already probes usage to pick the freshest pool account; that is
  global and fine, §4.3.)
- **Scope note:** tend rotates on `usageLimited` only. `budgetLimited` is a terminal token-budget
  stop (no rotation, by design) and Plan-mode turns ignore goals (`goals.rs:1172`) — documented,
  not a bug. Edge: a goal already `paused`/`blocked` when the limit hits does **not** transition to
  `usageLimited` (the transition applies only to an *active* goal, `state/src/runtime/goals.rs:335-365`),
  so neither the rollout record nor the `Goal hit usage limits` footer fires — the footer stays
  `Goal paused/blocked (/goal resume)`. This manual-pause-at-limit case is **not auto-detected**;
  it is rare for tend's active-goal use and is accepted (the operator resumes it). Do **not** rely on
  the pane fallback for it — the fallback only covers the normal active→`usageLimited` case.

### 4.3 Rotate — global account rotation (existing behavior, unchanged)

On `usageLimited` for `T`: run the existing `rotateCodexAccount` →
`activateCodexPoolSelection(avoidCurrentLabel:true)` (`codex-cli.js:456-600`), which writes the
shared `~/.codex/auth.json` to a fresh pool account chosen by remaining quota. This is global and
shared **by design** (§2). The only hardening: ensure the `auth.json` write is **atomic**
(temp-file + rename) so a concurrently-starting codex never reads a torn file.

### 4.4 Resume — continue `T` on the new account

- Exit the old TUI (`/exit`), then launch a fresh tmux session running
  `codex --no-alt-screen [-p <profile>] resume <T>` (NO `--remote`). `codex resume <T>` resolves by
  exact id and **exits fatally on a true miss** — no most-recent fallback
  (`tui/src/lib.rs:1474-1488`). The plain TUI uses an in-process embedded app-server, so the
  `Resume paused goal?` prompt behaves identically with no external server (`tui` per redesign §5.3).
- A `usageLimited` goal does **not** auto-reactivate; it needs a `status=active` write, which the
  TUI performs when Enter selects "Resume goal" (`tui/src/app/thread_goal_actions.rs:51-79`). So
  scrape the pane for `Resume paused goal?` and send Enter (existing `confirmResumePrompt`). The
  pane scrape is the cue to *act*; the **authoritative proof** reactivation worked is `T`'s rollout
  flipping to `status:"active"` (§4.5) — if it doesn't flip within a window, re-send Enter or
  re-resume rather than trusting the pane.
- **tmux session names unique per run** — default to `aimgr-codex-tend-<runid>` (the same `runid`
  as the originator tag), never a fixed name shared across tenders, so pane ops
  (`sendExit`/`sendEnter`/`capturePane`) never hit another tender's pane.

### 4.5 Verify — confirm the resume landed on `T`

After resume, confirm `T`'s goal status flipped to `active` (next `thread_goal_updated` in `T`'s
rollout, or pane shows `Pursuing goal`). Because `T` is known and resume is exact-match, there is
no wrong-thread risk; this is a safety net against the rare fuzzy-filename fallback when the shared
threads index is stale (`rollout/src/list.rs:1272-1394`).

## 5. Exact aimgr seams

**Delete from the tend path**
- `src/targets/codex-app-server.js` usage (the private app-server, the WS client, `--remote`).
- `discoverOwnedThreadId` + the `thread/loaded/list` discovery block (`codex-tender.js:318-336,
  698-716`) and `adaptLegacyAppServerClient` (`:293-316`).
- `--remote` wiring in `buildCodexCommand` (`:171-185`).
- The shared-state non-goal recovery triggers: `detectActiveCodexUsageRateLimit` and
  `detectNewPaneRateLimit` plus their poll-loop handling (`:468-515,428-453,729-755`) — they cause
  cross-tender spurious restarts (§4.2). Trigger only on `T`'s rollout goal status.

**Add**
- `runid` minting (`pid + random`) and the `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`
  env, embedded in the tmux command string (with shell quoting) or via `tmux new-session -e`.
- A rollout-dir watcher (scanning `<resolveManagedCodexHomeDir>/sessions`, not a hardcoded
  `~/.codex`) that resolves `T` by matching the run tag in `session_meta`
  (`originator==tag` + `thread_source=="user"` + `source=="cli"`) **and** picking the tag-matching
  top-level session that carries the goal (`thread_goal_*` record — this requires reading past the
  `session_meta` first line into the rollout body; normally exactly one candidate exists so it's one
  file); tolerant of first-turn latency; bounded timeout.
- Resume mode (`--resume <T>`): resolve `T`'s rollout path by scanning `sessions/` for the file
  whose name ends `-<T>.jsonl` (the UUID is in the filename) so the tailer/verify can read it.
- A unique tmux session name tied to the run: default `aimgr-codex-tend-<runid>` (replace the
  ms-based `buildCodexTenderSessionName`, `codex-tender.js:193-194`); reject a shared fixed
  `--tmux-session` across live tenders.
- A rollout tailer for `T` that reports goal status transitions (`usageLimited`, `active`,
  `complete`). Parse rollout JSON as **camelCase** (`payload.goal.status`, `threadId`, `tokensUsed`);
  only the `goals_1.sqlite` fallback uses snake_case (`usage_limited`).
- Optional read-only `goals_1.sqlite` reader (fallback), versioned-filename discovery,
  `SQLITE_BUSY` retry — only if not relying solely on the rollout tail.
- Atomic `~/.codex/auth.json` write: `writeJsonFileIfChanged` (`src/io/json-store.js:68-69`) is a
  direct overwrite → change to temp-file + `rename` so a concurrently-starting codex never reads a
  torn file.
- A bounded bind timeout for the identity watcher (fail loud if the run tag never appears →
  miswired env), instead of an unbounded heartbeat.

**Keep**
- The poll loop shape, rotation (`rotateCodexAccount`/`activateCodexPoolSelection`), preflight,
  pane resume-confirm (`confirmResumePrompt`), `/exit` + restart, the `--resume <id>` mode.

**Tests** (`test/codex/codex-10.cases.js`): replace the fake app-server
(`createFakePrivateCodexAppServers`, `:71-92`) and the discovery tests (`:436-545,1030`) with disk
fixtures — a temp `sessions/` dir + `session_meta`/`thread_goal_updated` JSONL fakes; add cases for
(a) two concurrent tenders with distinct `runid`s resolving distinct `T`s, (b) sub-agent rollouts
under the same tag being excluded, (c) first-turn latency, (d) usageLimited→rotate→resume→active.

## 6. What this fixes / intentionally leaves

- **Fixes** Finding 2 (ambiguous/wrong-thread discovery), Finding 5 (recovery gated on a thread id
  we now always have), Finding 7 (fuzzy resume — `T` known + verified), and removes the private
  app-server entirely (Finding: competing app-servers + SQLite write contention).
- **Intentionally leaves** global account rotation shared (Finding 1/3) — that is the design, not a
  defect (§2). The only related hardening is the atomic `auth.json` write.

## 7. Edge cases / hardening (tracked)

- `runid` collision-resistance (pid+random, not timestamp).
- Watcher matches the run tag, not newest file (TOCTOU under concurrent writers).
- First-turn rollout latency: wait for `T`; never act without it; heartbeat/log while waiting; a
  user who never starts a goal simply yields nothing to tend.
- Rollout tail preferred over SQLite (lock-free); if SQLite, `mode=ro` + `SQLITE_BUSY` retry +
  versioned filename discovery; `node:sqlite` needs Node ≥ 22.5 vs `engines:>=20` → prefer rollout
  tail or shell out to `sqlite3`.
- tmux unique session names; env reaches codex through tmux (command-string prefix or `-e`).
- Atomic shared `auth.json` writes so concurrent starts never read a torn file.
- Redundant global rotations (two tenders rotate near-simultaneously): tolerated; both converge on a
  valid account; `avoidCurrentLabel` reduces immediate re-rotation. Not a correctness issue.

## 8. Changelog
- 2026-05-30: Created. Re-scoped from the redesign doc per explicit direction: **no auth/home
  isolation** (shared fungible account pool + global rotation is intentional); the plan is purely
  deterministic thread identity + disk trigger + resume in the shared `~/.codex`, no app-server.
  Incorporated the verified hardening from the prior Composer review (env-into-tmux, runid
  collisions, tag-matched watcher, rollout-tail vs SQLite, unique tmux names). To be iterated against
  an independent reviewer until it passes.
- 2026-05-30 (round 2, after Composer review #1 — VERDICT was fail): Fixed the blocking identity
  filter — top-level TUI writes `thread_source:"user"` (verified on disk: `codex-tui`=`(user,cli)`,
  sub-agents=`(subagent,obj)`; `tui/src/app_server_session.rs:1384`), NOT absent; filter is now
  `originator==tag && thread_source=="user" && source=="cli"`. Made env-into-tmux mandatory and
  removed the stray `CODEX_HOME` (homes not isolated). Added: delete the shared-state non-goal
  recovery triggers (cross-tender spurious restarts), complete-line tail semantics, bounded bind
  timeout, rollout-status as the authoritative resume confirmation, named the non-atomic
  `writeJsonFileIfChanged`, `source=="vscode"` under `--remote` so dropping it is mandatory, and the
  `usageLimited`-only / `budgetLimited` / Plan-mode scope note. Re-running Composer (round 2).
- 2026-05-30 (round 3, after Composer review #2 — VERDICT pass-with-notes, no blockers): folded the
  non-blocking notes. Binding rule now selects the tag-matching top-level session **that carries the
  goal** (robust to pre-goal chat / multiple threads; block on true ambiguity). Default tmux session
  name tied to `<runid>`. Resume mode resolves `T`'s rollout path by filename. Watcher scans
  `resolveManagedCodexHomeDir/sessions`. Fixed the §5 self-contradiction (`thread_source=="user"`).
  Documented the paused/blocked-at-limit edge → pane fallback. Corrected the stale "absent" claim in
  the redesign evidence doc. Re-running Composer (round 3) to confirm a clean pass.
- 2026-05-30 (CONVERGED, after Composer review #3 — VERDICT pass-with-notes, no blockers, high
  confidence: *"correct, complete, and elegant for many simultaneous same-repo tenders… no remaining
  design blockers"*). Folded the final precision notes: corrected the paused/blocked-at-limit edge
  (the `Goal hit usage limits` footer does NOT fire for an already-paused goal — that case is
  intentionally not auto-detected, not "covered by the pane fallback"); fixed the citation to
  `state/src/runtime/goals.rs:335-365`; made explicit that the goal-bearing bind reads the rollout
  body (not just `session_meta`); noted rollout JSON is camelCase (SQLite is snake_case). The
  **design is final**; what remains is implementation (per §5) — env-into-tmux, drop `--remote`,
  rollout watcher/tailer, delete the shared-state non-goal triggers, atomic `auth.json`, unique
  tmux names — all of which are listed and non-architectural.
