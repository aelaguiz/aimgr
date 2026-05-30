# Codex `--tend` instability findings

Date: 2026-05-30

Scope: read-only investigation of `aim codex run --tend`, the multi-instance Tend plan in
`docs/codex-tend-multi-instance-plan-2026-05-30.md`, the current `aimgr` implementation, and the
local Codex source under `/Users/aelaguiz/workspace/codex/codex-rs`.

No code was changed for this investigation.

## Bottom line

The plan is directionally right about two core fixes:

- remove the private Codex app-server and `--remote`
- stop discovering the session by counting loaded app-server threads

But it does not fully address the user-visible failure being reported: tmux itself is currently a
major instability source. The live machine already shows the exact bad shape: many Tend tmux
sessions, orphaned `tmux attach-session` clients, orphaned private app-server processes, and one
Codex thread resumed in two live tmux sessions at the same time.

My recommendation is not to keep investing in "tmux as the Tend runtime" unless the goal is only a
small patch. The cleaner implementation is a foreground PTY supervisor: run plain `codex` in a
pseudoterminal owned by `aimgr`, relay the terminal directly, watch Codex rollout files for the
thread id and goal state, and restart `codex resume <T>` in the same foreground wrapper when a goal
hits `usageLimited`. That avoids both the app-server and tmux attach lifecycle.

## Live machine evidence

These commands were read-only snapshots taken during the investigation.

- `tmux ls` showed 9 live `aimgr-codex-tend-*` sessions.
- `tmux list-clients` showed 3 attached Tend clients:
  - `52467 /dev/ttys047 session=aimgr-codex-tend-1780094488766`
  - `78567 /dev/ttys000 session=aimgr-codex-tend-1780109277545`
  - `10214 /dev/ttys085 session=aimgr-codex-tend-1780156569121`
- `ps` showed two of those attach clients were orphaned under PID 1:
  - `52467 1 ... tmux attach-session -t aimgr-codex-tend-1780094488766`
  - `78567 1 ... tmux attach-session -t aimgr-codex-tend-1780109277545`
- `ps` showed 11 private Tend app-server parent processes still alive, all shaped like:
  - `node /Users/aelaguiz/.local/bin/codex app-server --listen ws://127.0.0.1:<port> --enable goals`
- `ps` also showed the persistent Codex remote-control daemon:
  - `/Users/aelaguiz/.codex/packages/standalone/current/codex app-server --remote-control --listen unix://`
- One Codex thread id was live in two separate Tend TUI sessions:
  - `019e7456-af5f-7561-9cb2-0db296c62b49 ttys029 pid=72081`
  - `019e7456-af5f-7561-9cb2-0db296c62b49 ttys067 pid=78518`

That last point matters. Even if a session id is correct, running the same Codex thread in two
interactive TUIs at once can create confusing UI behavior and shared-state contention. It is not
just "the wrong thread id" problem.

## Findings

### 1. The current attach lifecycle can corrupt the user's terminal

Severity: critical

Current code:

- `createTmuxAdapter.attach()` runs `tmux attach-session -t <session>` with `stdio: "inherit"`:
  `src/targets/codex-tender.js:236-237`
- recovery waits for the old attach process for at most a short window:
  `src/targets/codex-tender.js:258-274`
- the result of that wait is ignored:
  `src/targets/codex-tender.js:898-906`
- then the code can start a new tmux session and attach again:
  `src/targets/codex-tender.js:911-932`

Mechanism:

If the old `tmux attach-session` process is still attached to the same terminal, Tend can start a
new attach anyway. That gives the same terminal multiple tmux clients competing for input/output.
This matches the user's "tmux inside tmux / unusable terminal" report.

The live process table supports this. There are orphaned `tmux attach-session` processes with PPID
1. That means an `aimgr` parent process died or moved on while tmux clients remained attached.

This is not fixed by the current multi-instance plan. The plan makes tmux session names unique, but
it still keeps tmux as the runtime and does not specify a hard rule like: "never create a second
attach while the first attach process is alive."

### 2. The private app-server path is actively making the system worse

Severity: critical

Current code:

- Tend imports `startPrivateCodexAppServer`:
  `src/targets/codex-tender.js:12`
- each tender starts a private server:
  `src/targets/codex-tender.js:631-645`
- the server command is:
  `codex app-server --listen ws://127.0.0.1:<port> --enable goals`
  from `src/targets/codex-app-server.js:209-239`
- on ambiguous thread discovery, Tend intentionally leaves the app-server running if the tmux
  session is still alive:
  `src/targets/codex-tender.js:622-625` and `src/targets/codex-tender.js:733-744`

Live evidence:

There were 11 private `--enable goals` app-server parent processes still alive, in addition to the
normal Codex remote-control daemon.

Mechanism:

This creates N extra app-server processes over the same `~/.codex` home. They add SQLite pressure,
make source/identity filtering more confusing, and leave background-like processes behind even
though the plan says no new daemons.

The plan is right to delete this path. The user's instinct here is correct: using the app-server for
Tend was the wrong boundary for this workflow.

### 3. The current thread discovery heuristic is broken by Codex's own sub-agents

Severity: high

Current code:

- `discoverOwnedThreadId()` binds only if `thread/loaded/list` returns exactly one thread:
  `src/targets/codex-tender.js:318-336`
- the poll loop blocks as `ambiguous_loaded_threads` when more than one loaded thread appears:
  `src/targets/codex-tender.js:730-744`

Codex source:

- `thread/loaded/list` is documented as "thread ids currently loaded in memory":
  `/Users/aelaguiz/workspace/codex/codex-rs/app-server/README.md:350-352`
- Codex filters only `SessionSource::Internal`, not sub-agents:
  `/Users/aelaguiz/workspace/codex/codex-rs/core/src/thread_manager.rs:942-950`
- `SessionSource::SubAgent` includes review, compact, and thread-spawn agents:
  `/Users/aelaguiz/workspace/codex/codex-rs/protocol/src/protocol.rs:2522-2537`
- sub-agents are not internal:
  `/Users/aelaguiz/workspace/codex/codex-rs/protocol/src/protocol.rs:2572-2574`

Mechanism:

A single goal can spawn sub-agents. Those sub-agents are loaded into the same private app-server
process and make the loaded-thread count greater than one. Tend then cannot identify the parent
thread and may block.

The plan's replacement is good: stamp a unique originator, read rollout files, and bind by
`session_meta.id`, not by loaded-thread count.

### 4. The originator-based identity design is sound, but only if the env reaches Codex

Severity: high

Codex source:

- Codex reads `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`:
  `/Users/aelaguiz/workspace/codex/codex-rs/login/src/auth/default_client.rs:37-61`
- rollout `session_meta` writes that originator:
  `/Users/aelaguiz/workspace/codex/codex-rs/rollout/src/recorder.rs:673-684`
- plain TUI top-level sessions set `thread_source: "user"`:
  `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/app_server_session.rs:1368-1385`
- sub-agents set `thread_source: "subagent"`:
  `/Users/aelaguiz/workspace/codex/codex-rs/core/src/codex_delegate.rs:80-91`

Current `aimgr` gap:

- `buildCodexCommand()` builds a command string but has no env prefix:
  `src/targets/codex-tender.js:171-185`
- `tmux new-session` does not pass `-e CODEX_INTERNAL_ORIGINATOR_OVERRIDE=...`:
  `src/targets/codex-tender.js:213-216`

Mechanism:

The plan correctly says the originator tag is the identity key. But tmux commands run under the
tmux server environment. Setting `process.env` in `aimgr` is not enough. The env must be embedded in
the command or passed through `tmux new-session -e`.

If we move to a PTY supervisor, this gets simpler: the wrapper owns the child process env directly
and can pass `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` in `spawn()`.

### 5. The plan still underestimates shared auth/account coupling

Severity: high

Current code:

- Codex home defaults to one shared `~/.codex`:
  `src/io/paths.js:113-119`
- activation writes the shared `auth.json`:
  `src/targets/codex-cli.js:49-53`
- activation updates the shared active label:
  `src/targets/codex-cli.js:64-68`
- rotation selects from the shared current label:
  `src/targets/codex-cli.js:493-498`
- `auth.json` writes use direct file overwrite, not temp-file plus rename:
  `src/io/json-store.js:46-69`

The plan intentionally keeps shared global rotation:

- `docs/codex-tend-multi-instance-plan-2026-05-30.md:24-41`
- `docs/codex-tend-multi-instance-plan-2026-05-30.md:148-154`
- `docs/codex-tend-multi-instance-plan-2026-05-30.md:245-246`

Mechanism:

Thread identity and account identity are different. The plan is right that shared auth should not
make Tend resume the wrong thread. But shared auth can still make many tenders collapse onto the
same account after rotation, because the last writer to `~/.codex/auth.json` wins.

If the product goal is "many long-running tenders share one currently active machine account", then
the plan must add a rotation lock and say clearly that Tend will not spread concurrent sessions
across accounts.

If the product goal is "many concurrent tenders use the pool without clobbering each other", then
the plan needs per-tender auth isolation, probably via per-tender `CODEX_HOME` or a Codex-supported
auth override. Without that, the pool cannot be truly per-instance.

### 6. The plan fixes identity and app-server removal, but not the reported tmux usability failure

Severity: high

Plan coverage:

- removes app-server usage:
  `docs/codex-tend-multi-instance-plan-2026-05-30.md:180-189`
- adds originator/watch identity:
  `docs/codex-tend-multi-instance-plan-2026-05-30.md:191-199`
- makes tmux session names unique:
  `docs/codex-tend-multi-instance-plan-2026-05-30.md:202-204`

Missing:

- no rule for running inside an existing tmux client
- no `switch-client` vs `attach-session` decision
- no rule that an unfinished attach process blocks recovery
- no cleanup model for orphaned attach clients
- no "do not reattach after recovery if the old attach is still alive"
- no "single foreground terminal owner" invariant

This is the key mismatch with the user's complaint. The plan is mostly about thread identity. The
reported pain is terminal ownership.

### 7. Tests currently encode the old architecture

Severity: medium

Examples:

- tests assert `--remote` remains in the launched command:
  `test/codex/codex-10.cases.js:417-419`, `test/codex/codex-10.cases.js:589-590`,
  `test/codex/codex-10.cases.js:651-652`
- tests fake app-server loaded-thread behavior:
  `test/codex/codex-10.cases.js:595-703`
- tests preserve non-goal pane/usage rotation triggers:
  `test/codex/codex-10.cases.js:888-956`, `test/codex/codex-10.cases.js:1026-1094`
- the fake tmux adapter never models nested tmux, orphaned attach clients, or two attach processes
  fighting over one tty:
  `test/codex/codex-10.cases.js:76-119`

The plan says these should be replaced with disk fixtures, which is correct. It should also add
tests for terminal ownership if tmux remains.

### 8. The companion redesign doc still contains stale contradictory identity claims

Severity: medium

`docs/codex-tend-redesign-2026-05-30.md` still says the top-level `thread_source` filter is
"absent" in the early decision section:

- `docs/codex-tend-redesign-2026-05-30.md:40-45`
- `docs/codex-tend-redesign-2026-05-30.md:75-84`

Later sections correct this to `thread_source: "user"`:

- `docs/codex-tend-redesign-2026-05-30.md:185-188`
- `docs/codex-tend-multi-instance-plan-2026-05-30.md:82-95`

This is doc drift, not a code bug, but it matters because this plan is going to guide an
implementation. A stale early section can easily recreate the exact bug the plan already fixed.

## Independent review runner

I also ran the local `$code-review` runner over the Tend plan docs and current Codex Tend
implementation.

Run directory:

- `/private/tmp/code-review/20260530_122135_55174328_acd4a56d`

Completed lens outputs:

- `architecture.final.txt`: blocking on the private app-server path still owning Tend, shared
  rotation triggers bypassing per-thread ownership, and tmux session ownership not being unique.
- `docs-drift.final.txt`: blocking on the stale `thread_source` absent-filter in the redesign doc;
  non-blocking on `docs/codex-tend-path-bug-analysis-2026-05-30.md` citing a README
  `--tmux-session overnight-codex` example that the live README no longer contains.
- `proof.final.txt`: blocking on missing disk-backed rollout fixtures for the new binding model;
  non-blocking on untested atomic auth-file hardening.
- `security.final.txt`: blocking on unauthenticated loopback app-server spoofing/port-race risk;
  non-blocking on shared `auth.json` being overwritten in place.
- `correctness.final.txt`: no findings for that lens.

Final synthesis:

- `synthesis.final.txt`: `VERDICT: not-approved`

The synthesized blocking findings were the same core issues: the live Tend path still depends on a
private app-server and `--remote`, recovery still rotates on shared signals instead of the owned
thread, and the proposed disk-backed binding path has no matching regression coverage. The synthesis
also kept the stale `thread_source` contradiction as a non-blocking doc finding. This matches the
manual conclusion here: remove the app-server path, make thread ownership disk-backed, and do not
call the current tmux runtime stable without a terminal ownership fix.

## PTY smoke validation

I ran a throwaway PTY smoke test without changing repo code.

Control result:

- a child process attached to the PTY reported `stdin_isatty=True` and `stdout_isatty=True`
- a PTY configured to `37x123` reported `stty size` as `37 123`

Codex result:

- `codex --no-alt-screen -C /Users/aelaguiz/workspace/aimgr` started inside the child PTY, emitted
  normal TUI ANSI output, accepted `/exit`, and exited `0`
- `codex -C /Users/aelaguiz/workspace/aimgr` with `TERM=xterm-256color` started inside the child
  PTY, emitted TUI control output including bracketed-paste mode, accepted `/exit`, and exited `0`

What this proves:

- Codex can run under a foreground PTY wrapper without tmux.
- Codex sees a terminal, not plain pipes.
- Basic TUI rendering, input delivery, and configured window size work.

What this does not prove yet:

- full raw-mode relay from the user's real terminal
- dynamic resize forwarding via `SIGWINCH`
- Ctrl-C/Ctrl-D behavior
- crash cleanup and terminal restoration
- Tend's rollout watcher, rotation, and resume loop

So the PTY assumption is viable, but it still needs a small real supervisor prototype before calling
it production-ready.

## Assessment of the Opus plan

What I would keep:

- Delete `src/targets/codex-app-server.js` from the Tend path.
- Drop `--remote`.
- Use `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid>`.
- Resolve the thread from rollout `session_meta` using:
  - `originator == tag`
  - `thread_source == "user"`
  - `source == "cli"`
  - rollout body contains the goal
- Tail the known rollout for `thread_goal_updated` and `goal.status == "usageLimited"`.
- Treat pane scraping as a cue only, not proof.
- Make `auth.json` writes atomic if shared auth remains.

What I would not trust:

- Keeping tmux as the primary runtime without a terminal ownership redesign.
- Treating shared global auth as "not a correctness issue" unless the product explicitly accepts
  one global active account at a time.
- Continuing to let `--tmux-session` be a fixed user-provided name in multi-instance mode.
- Any implementation that reuses the old app-server fakes in tests.

## Recommended implementation direction

### Preferred: tmux-free foreground PTY supervisor

Shape:

1. `aimgr` starts a child PTY running plain Codex:
   `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aimgr-tend-<runid> codex --no-alt-screen [-p yolo] ...`
2. `aimgr` relays user stdin/stdout directly between the real terminal and the PTY.
3. `aimgr` watches `<codexHome>/sessions/**/rollout-*.jsonl` for the matching originator and binds
   thread id `T`.
4. `aimgr` tails `T`'s rollout for goal status transitions.
5. On `usageLimited`, `aimgr` exits or terminates the child, rotates account state, then starts:
   `codex --no-alt-screen [-p yolo] resume <T>`
6. `aimgr` confirms the resume prompt by PTY output matching or by sending Enter once the prompt is
   visible, then verifies `T` flips to `active` in the rollout.
7. On parent exit, `aimgr` restores terminal mode and kills the child process group.

Why this is better:

- no `tmux attach-session`
- no nested tmux
- no orphan tmux clients
- no private app-server
- one process owns the user's terminal
- env wiring is normal child-process env
- resize, signals, and cleanup are explicit

Tradeoffs:

- needs a real PTY dependency or small native helper
- must handle raw-mode restore carefully
- does not preserve the session if the wrapper process dies
- needs focused integration tests around resize, Ctrl-C, EOF, and crash cleanup

That tradeoff looks better than the current state. The current tmux path is already leaving orphaned
attach clients and app-servers behind.

### Acceptable short-term patch if tmux is kept

If tmux stays for a v1 repair, I would require these rules before calling it stable:

- If `$TMUX` is set, do not run `tmux attach-session` from inside the existing tmux client. Use
  `tmux switch-client`, create a window in the current session, or fail loud with a clear message.
- Never start a second attach while the old attach process is still alive. Treat that as blocked.
- Remove the private app-server and `--remote`.
- Use unique unguessable session names and reject fixed `--tmux-session` in multi-instance mode
  unless `--i-know-this-is-shared` or equivalent exists.
- Add a cleanup path for orphaned app-server processes created by old Tend runs.
- Add tests where `attachProcess` never exits and recovery must not spawn another attach.
- Add tests where `$TMUX` is present.

This would be less disruptive than a PTY rewrite, but it still leaves Tend coupled to tmux behavior.

### Not recommended: another app-server implementation

The app-server protocol can represent thread and goal state, but it is the wrong fit for the user's
current pain:

- the user explicitly does not want it
- the current implementation already proves extra app-servers pile up
- Codex's own TUI already embeds or reaches an app-server internally
- Tend only needs identity, rollout status, account rotation, and restart

Using app-server again would solve the wrong layer.

### Limited-use option: `codex exec --json`

`codex exec --json` has deterministic thread-start events, but it is not a replacement for this
interactive `/goal` workflow. It can be useful later for batch/non-TUI tending, not for the main
Tend path unless Codex grows a real headless goal resume/control surface.

## Immediate non-code operational readout

The current local machine is already in a messy Tend state:

- 9 Tend tmux sessions
- 3 attached Tend clients
- 2 orphaned Tend attach clients under PID 1
- 11 private Tend app-server parent processes
- 1 duplicated live resumed thread across two TTYs

I did not kill or alter any of these. But this state strongly supports the user's report: the
system is not merely "sometimes wrong-thread"; it is leaking terminal-control and app-server
processes.

## Evidence map

`aimgr`:

- `src/targets/codex-tender.js:171-185` builds the Codex command with `--remote`.
- `src/targets/codex-tender.js:197-239` defines tmux session operations.
- `src/targets/codex-tender.js:258-274` waits for attach process completion.
- `src/targets/codex-tender.js:318-336` discovers a thread by loaded-thread count.
- `src/targets/codex-tender.js:428-453` triggers recovery from pane rate-limit text.
- `src/targets/codex-tender.js:468-515` triggers recovery from shared active-label usage.
- `src/targets/codex-tender.js:631-645` starts a private app-server.
- `src/targets/codex-tender.js:730-744` blocks on ambiguous loaded threads while keeping the
  app-server alive.
- `src/targets/codex-tender.js:898-932` can proceed to new attach after a bounded wait.
- `src/targets/codex-app-server.js:209-239` starts `codex app-server --enable goals`.
- `src/targets/codex-cli.js:49-68` writes shared Codex auth and active label.
- `src/targets/codex-cli.js:493-498` selects based on shared current label.
- `src/io/paths.js:113-119` resolves the managed Codex home.
- `src/io/json-store.js:46-69` writes JSON directly.
- `test/codex/codex-10.cases.js` encodes the old app-server/tmux assumptions.

Codex:

- `/Users/aelaguiz/workspace/codex/codex-rs/login/src/auth/default_client.rs:37-61`
  reads `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`.
- `/Users/aelaguiz/workspace/codex/codex-rs/rollout/src/recorder.rs:673-684`
  writes `session_meta`.
- `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/app_server_session.rs:1368-1385`
  marks top-level TUI sessions as `thread_source: "user"`.
- `/Users/aelaguiz/workspace/codex/codex-rs/core/src/codex_delegate.rs:80-91`
  marks sub-agents as `thread_source: "subagent"`.
- `/Users/aelaguiz/workspace/codex/codex-rs/core/src/thread_manager.rs:942-950`
  filters only internal sessions from loaded-thread ids.
- `/Users/aelaguiz/workspace/codex/codex-rs/protocol/src/protocol.rs:2522-2537`
  defines sub-agent sources.
- `/Users/aelaguiz/workspace/codex/codex-rs/protocol/src/protocol.rs:2572-2574`
  defines `is_internal`.
- `/Users/aelaguiz/workspace/codex/codex-rs/core/src/session/mod.rs:1190-1196`
  defers new-session rollout materialization.
- `/Users/aelaguiz/workspace/codex/codex-rs/core/src/session/mod.rs:3128-3137`
  materializes the rollout after user input is recorded.
- `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/lib.rs:1474-1488`
  fails loudly when a resume id is not found.
- `/Users/aelaguiz/workspace/codex/codex-rs/rollout/src/list.rs:1369-1394`
  contains the fallback fuzzy filename search.
- `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/app/thread_goal_actions.rs:51-78`
  shows the resume-paused-goal prompt.
- `/Users/aelaguiz/workspace/codex/codex-rs/tui/src/bottom_pane/footer.rs:543-553`
  renders the goal status footer strings.
