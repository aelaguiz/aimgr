# Codex overnight account rotation proposals

Date: 2026-05-23
Repos reviewed:

- `/Users/aelaguiz/workspace/aimgr`
- `/Users/aelaguiz/workspace/codex`

Runtime Codex binary for checks:

- Use the system-installed Codex binary for CLI/runtime verification:
  `/Users/aelaguiz/.local/bin/codex`
- Observed version on 2026-05-23: `codex-cli 0.134.0-alpha.1`
- Treat `/Users/aelaguiz/workspace/codex` as source-code reference unless the
  plan explicitly calls for Codex source changes.
- Avoid `cargo run`, `cargo test`, and other Rust source builds for exploratory
  checks. Building the source tree is slow enough to distort the workflow; prefer
  the installed `codex` binary for command-shape and runtime validation.

Implementation status:

- Implemented in AIMGR on 2026-05-23.
- New operator command:

  ```bash
  aim codex run --tend [-p <profile>] [--resume <session-id>] [-- <codex args...>]
  ```

- Core implementation files:
  - `src/targets/codex-tender.js`
  - `src/targets/codex-app-server.js`
  - `src/targets/codex-cli.js`
  - `src/cli/commands/codex.js`
  - `src/cli/args.js`
  - `src/cli/deps.js`
  - `src/cli/help.js`
  - `README.md`
  - `test/codex/codex-10.cases.js`

Implemented command options:

```bash
aim codex run --tend
aim codex run --tend --no-attach
aim codex run --tend --tmux-session overnight-codex
aim codex run --tend --codex-bin /Users/aelaguiz/.local/bin/codex
aim codex run --tend --max-restarts 3
aim codex run --tend --poll-seconds 5
aim codex run --tend --prompt-timeout-seconds 60
aim codex run --tend --workdir /path/to/repo
aim codex run --tend -p yolo
aim codex run --tend --profile yolo
aim codex run --tend --codex-profile yolo
aim codex run --tend -p yolo --resume 019e5487-026d-7f52-8fbd-1d123045f1c6
aim codex run --tend -p yolo --session-id 019e5487-026d-7f52-8fbd-1d123045f1c6
aim codex run --tend -p yolo -- resume 019e5487-026d-7f52-8fbd-1d123045f1c6
aim codex run --tend -- --model gpt-5.5 --search
aim codex run --tend -- --model gpt-5.5 -p yolo --search
```

The implemented v1 is tmux-backed. AIMGR starts the normal Codex TUI in tmux,
uses a provided Codex session UUID or owns a private Codex app-server remote for
new sessions, binds only to the single thread loaded in that private server,
polls the persisted thread goal, rotates only when the goal is `usageLimited`,
restarts through a fresh private remote with plain `codex resume <thread-id>`,
and confirms Codex's built-in resume-goal prompt by sending Enter to the tmux
pane.
Codex profile selection via `-p yolo`, `--profile yolo`, `--codex-profile yolo`,
or pass-through `-- -p yolo` is preserved on supervised resume.
Codex pass-through args cannot include `--remote` or `--remote-auth-token-env`
because AIMGR owns that endpoint to prove thread ownership.
It requires `tmux` on `PATH`.

Codex help calls the public CLI argument `SESSION_ID`. Internally, AIMGR stores
the same UUID as `threadId` because Codex app-server goal methods accept
`threadId`. This document uses `session id` when talking about the operator CLI
and `thread id` when talking about app-server state.

Implemented resumed-session behavior:

- `--resume <uuid>` and `--session-id <uuid>` start the first tmux process as
  `codex --no-alt-screen [-p profile] resume <uuid>`.
- `aim codex run --tend -- resume <uuid>` is accepted as exact Codex
  passthrough resume form.
- `--last`, thread names, missing ids, conflicting ids, and resume prompts after
  the id are rejected before tmux starts.
- With a provided UUID, AIMGR skips recent-thread discovery and polls that UUID
  directly through app-server goal state.

The implementation deliberately does not use:

```bash
codex resume <thread-id> "/goal resume"
```

Installed-binary testing proved that path is a normal user message, not a TUI
slash command.

The tender also preserves refreshed live Codex auth before rotating away from an
account. It reads the current managed Codex `auth.json`, maps it back to the
active AIMGR Codex label, updates stored AIMGR credentials when the live
access/refresh tokens changed, and marks imported labels dirty so normal
authority promotion safeguards still apply.

## Purpose

Design ways for AIMGR to keep long-running Codex goal work alive overnight by rotating
ChatGPT/Codex accounts when the active account hits, or is close to hitting, usage
limits.

This document puts the interactive developer workflow first:

1. Start a normal Codex TUI session.
2. Talk to Codex for a while.
3. Later, type `/goal ...`.
4. Walk away.
5. If the active account hits a limit, AIMGR should rotate accounts and resume the
   same Codex thread/goal with as little workflow damage as possible.

The important correction is that `codex exec --json` is not the primary workflow.
It is useful for batch jobs, but making it the default solution would force the
operator into a different Codex mode and would interfere with the way goal work is
actually started.

## Executive recommendation

Build a TUI-preserving tender first.

The first serious implementation should be an AIMGR command like:

```bash
aim codex run --tend
```

or, eventually, an alias/wrapper that lets the operator type something close to:

```bash
codex
```

while AIMGR sits around the normal Codex TUI process.

The wrapper should not change how Codex feels while the operator is present. It
should pass the terminal through to the real Codex TUI, allow normal chat, allow
normal slash commands, allow normal approval prompts, and only intervene after a
goal exists and the session becomes unattended or exits because of usage limits.

The manual workflow today is:

1. Notice Codex is rate limited.
2. Exit or close the Codex session.
3. Run AIMGR to switch Codex accounts.
4. Resume the Codex thread.
5. Resume the goal.

The automated workflow should mirror that:

1. Detect that the current account is exhausted, near exhaustion, or the Codex
   process exited after a usage-limit state.
2. Ask AIMGR's existing account pool selector for the next eligible account.
3. Write managed `~/.codex/auth.json` for the next Codex process.
4. Restart the same Codex thread with `codex resume <thread-id>`.
5. Confirm Codex's built-in goal-resume prompt in that thread.

The tested v1 path does not require modifying Codex if AIMGR owns a PTY or tmux
session. The reliable installed behavior is:

```bash
codex resume <thread-id>
```

with no initial prompt. For a stopped goal, Codex shows its built-in startup
prompt:

```text
Resume paused goal?
1. Resume goal   Mark it active and continue when idle
2. Leave paused  Keep it paused; use /goal resume later
```

AIMGR can confirm that prompt by sending Enter through the PTY. That path was
tested end to end with the installed binary and it started a real goal
continuation turn.

One tempting shortcut is not valid:

```bash
codex resume <thread-id> "/goal resume"
```

The installed CLI accepts that shape, but runtime testing showed the prompt is
submitted as a normal user message, not parsed as a TUI slash command. It can
look like it worked if the model responds helpfully, but the persisted goal
status remains stopped. Do not build the tender around that shortcut.

A small Codex-side flag is still a good later hardening step:

```bash
codex resume <thread-id> --resume-goal
```

That would remove the PTY prompt-confirmation dependency, but it is not required
for the first AIMGR proof of concept.

## Developer workflow contract

Any good solution needs to obey these constraints.

- The Codex TUI remains the main interface.
- The operator can talk to Codex normally before deciding to start a goal.
- `/goal` remains the moment where overnight work starts.
- AIMGR should not require exact-json mode for normal goal work.
- AIMGR should not inject hidden prompts during normal human conversation.
- AIMGR should not rotate the live auth file and assume the running Codex process
  switched accounts. Codex caches auth in memory.
- AIMGR should not preemptively stop an active human conversation just because
  the active account is getting low.
- AIMGR can be more aggressive after the current thread has an active goal and the
  operator has walked away.
- Existing raw `codex` processes cannot be reliably restarted in the same terminal
  unless AIMGR is the parent process, Codex exposes a control API, or the session
  is running inside something AIMGR can control.

## Current AIMGR behavior that matters

AIMGR already has most of the account-side machinery.

`aim codex use [label]`:

- Selects a specific label or the next eligible label.
- Writes managed `~/.codex/auth.json`.
- Verifies the selected account id.
- Affects the next Codex process, not a running Codex process.

`aim codex watch`:

- Checks the active local Codex account's live usage.
- Uses `https://chatgpt.com/backend-api/wham/usage`.
- Reads primary and secondary limit windows.
- Rotates when the active account's 5h remaining percentage falls below the
  configured threshold.
- Defaults to a 300 second loop interval.
- Defaults to rotating below 20 percent 5h remaining.
- Stores a watch receipt under `targets.codexCli.lastWatchReceipt`.
- Refuses to rotate when the active target's usage is unavailable, for example
  a 401 from the usage endpoint.

Relevant files:

- `src/cli/commands/codex.js`
- `src/targets/codex-cli.js`
- `src/targets/codex-store.js`
- `src/pool/watch.js`
- `src/pool/usage.js`
- `src/pool/ranking.js`
- `src/core/constants.js`

The existing README already documents the intended low-level watch command:

```bash
aim codex watch --once --rotate-below-5h-remaining-pct 20
aim codex watch --interval-seconds 300 --rotate-below-5h-remaining-pct 20
```

That is a good primitive. It is not enough by itself because it only changes the
auth file for future Codex processes. It does not close, restart, or resume a
running TUI session.

## Current Codex behavior that matters

Codex already has the thread and goal concepts AIMGR needs to respect.

Interactive TUI:

- `codex` starts the normal TUI.
- `codex resume <session-id>` resumes a thread.
- `codex resume --last` resumes the latest thread.
- The TUI starts or connects to an app-server internally.

Goal resume behavior:

- When a goal hits usage limits, Codex marks the goal `UsageLimited`.
- Usage-limited goals do not silently continue on the next process start.
- On interactive resume, Codex can show a prompt to resume a paused, blocked, or
  usage-limited goal.
- `/goal resume` maps to setting the thread goal status back to active.
- Setting a running thread goal back to active is not just cosmetic. The
  app-server goal set path applies external goal runtime effects, and the core
  goal runtime attempts to continue the active goal when the thread is idle.
- A plain `codex resume <thread-id>` is enough to surface Codex's built-in
  startup prompt for a stopped goal, but automation must confirm that prompt.
- Supplying an initial prompt while resuming suppresses the built-in paused-goal
  startup prompt. Runtime testing showed
  `codex resume <thread-id> "/goal resume"` is a normal user message, not TUI
  slash-command dispatch.

Auth behavior:

- Codex loads auth from `~/.codex/auth.json`.
- The auth manager caches auth in memory.
- Refreshing managed ChatGPT auth can update the auth file.
- Rewriting `~/.codex/auth.json` while a Codex process is already running is not
  a reliable live account switch.

Rate-limit behavior:

- Codex parses `x-codex-primary-used-percent`,
  `x-codex-secondary-used-percent`, and related reset headers.
- A 429 `usage_limit_reached` response maps to a usage-limit error.
- The TUI displays usage warnings around 75, 90, and 95 percent.
- Those warnings are currently UI state, not an external automation API.

Relevant files:

- `codex-rs/cli/src/main.rs`
- `codex-rs/tui/src/lib.rs`
- `codex-rs/tui/src/app.rs`
- `codex-rs/tui/src/app/thread_goal_actions.rs`
- `codex-rs/tui/src/app/event_dispatch.rs`
- `codex-rs/tui/src/app_server_session.rs`
- `codex-rs/tui/src/app/session_lifecycle.rs`
- `codex-rs/tui/src/app/thread_routing.rs`
- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- `codex-rs/tui/src/chatwidget/goal_menu.rs`
- `codex-rs/tui/src/chatwidget/rate_limits.rs`
- `codex-rs/core/src/goals.rs`
- `codex-rs/core/src/codex_thread.rs`
- `codex-rs/core/templates/goals/continuation.md`
- `codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- `codex-rs/login/src/auth/manager.rs`
- `codex-rs/codex-api/src/rate_limits.rs`
- `codex-rs/codex-api/src/api_bridge.rs`

## Goal resume mechanics to rely on

This is the concrete `/goal` behavior that matters for automation.

`/goal resume` exists and is tested:

- TUI slash dispatch recognizes `resume` under `/goal`.
- It emits `AppEvent::SetThreadGoalStatus` with
  `ThreadGoalStatus::Active`.
- TUI tests cover `/goal resume` and assert that the emitted status is active.

The TUI event path uses the app-server goal API:

- `AppEvent::SetThreadGoalStatus` calls `set_thread_goal_status`.
- `set_thread_goal_status` calls `thread_goal_set` with:
  - `objective: None`
  - `status: Some(active)`
  - `token_budget: None`
- `thread_goal_set` maps to the app-server `thread/goal/set` request.

The app-server path is already the cleanest automation boundary:

```json
{
  "method": "thread/goal/set",
  "params": {
    "threadId": "<thread-id>",
    "status": "active"
  }
}
```

That request does the thing AIMGR wants semantically. It changes persisted goal
state, emits the normal goal update notification, applies external goal runtime
effects to a running thread when present, and allows the core goal runtime to
continue the active goal when idle.

The core goal runtime supports that continuation:

- `apply_external_thread_goal_status` sees the externally set `Active` status.
- It marks active goal accounting.
- It calls `maybe_continue_goal_if_idle_runtime`.
- That path checks that there is no active turn or queued input.
- It re-reads the persisted goal and only continues if the same goal is still
  `Active`.
- It injects the goal continuation prompt from
  `codex-rs/core/templates/goals/continuation.md`.
- It starts a normal Codex turn.

So the safest mental model is:

```text
thread resume != goal resume
goal resume == set persisted thread goal status to active
active goal + idle thread == Codex may start a continuation turn
```

For daemon-backed AIMGR, the preferred primitive is not "type `/goal resume`."
It is "set this thread's persisted goal status to active through Codex's real
control path." For the no-Codex-change v1, the practical primitive is "resume
without an initial prompt and confirm Codex's built-in resume-goal prompt."

### Tested command-line shortcut

This command is accepted by the installed CLI shape:

```bash
codex resume <thread-id> "/goal resume"
```

Installed-binary check:

```bash
codex resume --help
```

shows:

```text
Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
```

So the exact-thread plus prompt form is part of the installed CLI help surface.
Static code reading matches that: `codex resume` flattens the TUI CLI options,
and the TUI CLI has an optional `PROMPT` positional.

Runtime testing showed this is the wrong primitive for goal resumption.

Evidence from the disposable thread rollout:

- The initial prompt appears in the persisted conversation as a normal user
  message:

  ```text
  /goal resume
  ```

- The model then called `get_goal`.
- `get_goal` returned the persisted goal with:

  ```json
  "status": "usageLimited"
  ```

- The model answered the marker text from the test objective, but the goal was
  not resumed through Codex's goal runtime.

Ground truth:

- Positional initial prompts on `codex resume` are user messages.
- They do not pass through TUI slash-command dispatch.
- Supplying that initial prompt suppresses Codex's built-in "Resume paused
  goal?" startup prompt.
- `codex resume <thread-id> "/goal resume"` should not be used as AIMGR's v1
  resume primitive.

The tested no-Codex-change primitive is:

```bash
codex resume <thread-id>
```

with no initial prompt, then confirm the built-in prompt by sending Enter through
the PTY or tmux pane.

### Preferred Codex automation primitive

The best no-Codex-change v1 primitive is:

```bash
codex resume <thread-id>
```

with AIMGR confirming Codex's built-in resume prompt in the PTY. This is less
elegant than an API call, but it preserves the human TUI workflow and was tested
against the installed binary.

The best small Codex CLI hardening surface is:

```bash
codex resume <thread-id> --resume-goal
```

Semantics:

1. Resume exactly the requested thread.
2. Read that thread's current persisted goal.
3. If status is `paused`, `blocked`, or `usageLimited`, set it to `active`.
4. Let the normal goal continuation runtime decide whether to start a turn.
5. If there is no goal, or the goal is `complete`, report that and do not invent
   work.

This is safer than `--submit "/goal resume"` because it has one narrow meaning.
It also avoids hidden TUI keystrokes and avoids depending on startup prompt UI.
It is a good phase-2 improvement, not a blocker for AIMGR's first tender.

For daemon/app-server mode, AIMGR does not need a new CLI flag. It can call:

1. `thread/goal/get`
2. `thread/goal/set` with `status: active` when the current status is
   `paused`, `blocked`, or `usageLimited`

That is the cleanest medium-term path only when AIMGR is talking to the same
running app-server/daemon instance that owns the TUI thread. A separate
short-lived app-server process can mutate persisted goal state, but it does not
own the live TUI runtime and therefore cannot by itself start a continuation in
that TUI process.

Installed-binary app-server checks:

- `codex app-server --help` shows the experimental app-server command, including
  `daemon`, `proxy`, `generate-ts`, and `generate-json-schema`.
- `codex app-server daemon --help` shows local daemon management commands:
  `bootstrap`, `start`, `restart`, `enable-remote-control`,
  `disable-remote-control`, `stop`, and `version`.
- `codex app-server daemon version` failed on this machine because
  `/Users/aelaguiz/.codex/app-server-control/app-server-control.sock` does not
  exist. That means there was no managed daemon running during this check.

These checks were intentionally non-invasive: they validated the installed
binary's CLI surface without starting a TUI session or modifying Codex state.

Later installed-binary checks did start disposable authenticated TUI sessions;
those are recorded in the ground-truth section below.

## Proposal 1: TUI-preserving AIMGR wrapper

Status: recommended first build.

Example command:

```bash
aim codex run --tend
```

Possible later alias:

```bash
alias codex='aim codex run --tend --'
```

This command would launch the real Codex TUI as a child process and pass the
terminal through. The operator still gets the normal Codex interface and can use
normal chat, approvals, paste, shortcuts, and slash commands.

### How it works

Before starting Codex:

1. Optionally run a one-shot AIMGR account check.
2. If the currently selected local Codex account is already below the configured
   threshold, switch to a better account before launching Codex.
3. Start the real Codex TUI.

While Codex is running:

1. Do not interfere with ordinary human interaction.
2. Poll AIMGR usage state in the background.
3. If usage is getting low, mark the session as "rotate on next restart" rather
   than immediately stopping the TUI.
4. If the current thread has an active goal and the operator configured aggressive
   overnight mode, allow a restart after a hard usage-limit signal or clean TUI
   exit.

When Codex exits or reaches usage limit:

1. Determine the active thread id.
2. Determine whether that thread has an active, paused, blocked, or usage-limited
   goal.
3. If there is no goal to tend, stop and return control to the terminal.
4. If there is a goal to tend, run AIMGR rotation.
5. Start `codex resume <thread-id>` under the newly selected account with no
   initial prompt.
6. Confirm Codex's built-in goal-resume prompt through the PTY.
7. Watch for "Goal active", "Pursuing goal", "Goal achieved", or
   "Goal hit usage limits" as the visible state transition.

### Thread and goal detection

This is the main design point.

The wrapper needs to know whether a Codex exit should be treated as "done" or
"resume the overnight goal." There are a few ways to do that:

1. Implemented owner path for AIMGR-launched sessions: start a private local
   app-server remote, launch the TUI against it, and bind only to the single
   thread loaded in that private server.
2. Medium-term hardening: keep using the app-server goal API, but add a stable
   Codex-side thread identity event or CLI command if the protocol changes.
3. Good Codex-side addition: expose a small, stable `codex thread status` or
   `codex goal status --thread <id>` command that reports JSON.
4. Adequate fallback: parse the final "To continue this session, run codex resume
   <thread-id>" line, then inspect Codex state files if their format is stable
   enough.
5. Weak fallback: use `codex resume --last`. This is too risky if multiple Codex
   sessions are open.

The wrapper should avoid parsing the visual TUI stream as the primary protocol.
Terminal output is for humans. A status command or app-server endpoint is a much
cleaner automation boundary.

### Goal resume command

The wrapper should not send `/goal resume` as an initial prompt. That was tested
and it becomes a normal user message, not a slash command.

Preferred options:

1. Use the installed built-in prompt:

   ```bash
   codex resume <thread-id>
   ```

   Then send Enter when Codex shows "Resume paused goal?" with "Resume goal" as
   option 1.

2. Add one Codex CLI flag later:

   ```bash
   codex resume <thread-id> --resume-goal
   ```

3. Or add a general submit flag later:

   ```bash
   codex resume <thread-id> --submit "/goal resume"
   ```

`--resume-goal` is the safest shape because it does exactly one thing and is easy
for AIMGR to call. `--submit` is more general, but also gives automation a larger
surface area.

The v1 no-Codex-change version is the PTY confirmation path.

### Rotation behavior

The wrapper should use existing AIMGR pool selection instead of inventing new
account ranking logic.

Suggested behavior:

```bash
aim codex watch --once --rotate-below-5h-remaining-pct 20
```

If watch says the active account is still healthy, keep it. If watch rotates,
start the next Codex process under the new managed auth file.

For hard usage-limit exits, the wrapper may need to rotate even if the watch
receipt is stale. The safest account-side flow is:

1. Preserve any refreshed token material from the just-used Codex auth file.
2. Ask AIMGR for the next eligible local Codex account.
3. Write managed `~/.codex/auth.json`.
4. Verify the selected account id.
5. Start the resumed Codex process.

### Why this fits the workflow

- The operator can still use the normal Codex TUI.
- The operator can decide later to start `/goal`.
- The wrapper does not require exact-json mode.
- The wrapper models the manual recovery flow.
- Most work lives in AIMGR. After installed-binary testing, the only Codex change
  that looks useful for v1 hardening is an explicit non-interactive
  resume-goal flag; the proof of concept can proceed without it.

### Trade-offs

Pros:

- Best near-term fit for the real workflow.
- Uses AIMGR's existing account pool and usage logic.
- Does not require rewriting Codex auth internals.
- Can be tested with fake Codex child processes before touching real Codex.
- Can support a shell alias once stable.

Cons:

- The operator has to start Codex through AIMGR, or an alias must route `codex`
  through AIMGR.
- Existing already-running raw Codex sessions cannot be fully controlled.
- Reliable thread/goal detection for raw existing sessions likely needs a small
  Codex automation surface.
- Restarting the TUI is still visible if it happens while the operator is present.
- PTY supervision adds implementation complexity in AIMGR.

## Proposal 2: Passive sidecar for raw Codex sessions

Status: useful guardrail, not enough by itself.

Example command:

```bash
aim codex tend --attach
```

This would run beside a normal Codex process that was not launched by AIMGR.

The sidecar can:

- Monitor AIMGR's current selected local Codex account.
- Rotate `~/.codex/auth.json` for the next Codex process.
- Warn or log when the active account is below threshold.
- Preserve refreshed token material if AIMGR can identify it safely.

The sidecar cannot reliably:

- Restart the existing TUI in the same terminal.
- Know which TUI thread should be resumed.
- Resume the goal without a Codex control API.
- Avoid ambiguity when several Codex sessions are open.

This mode is still worth having because it is zero-interference. It can make the
next manual resume better, but it will not fully automate the overnight loop.

Best use:

```bash
aim codex watch --interval-seconds 300
```

or a slightly nicer wrapper around that command.

## Proposal 3: Codex app-server or daemon tender

Status: best medium-term architecture if Codex exposes the needed controls.

Codex already uses an app-server internally for the TUI. There is also daemon and
remote-control machinery. If the TUI and AIMGR sidecar can share a local Codex
daemon, AIMGR can avoid terminal supervision and interact with Codex at the same
level as a client.

Target shape:

1. Start a local Codex daemon.
2. The normal TUI connects to that daemon.
3. AIMGR connects to the same daemon.
4. AIMGR reads current thread id, goal status, and usage-limit state.
5. AIMGR asks Codex to interrupt, pause, resume, or continue the thread.
6. AIMGR rotates accounts at a clean boundary.
7. Codex resumes the same goal under the selected account.

This is better than PTY supervision because the terminal stays a human interface
and automation talks to an API.

Needed Codex API surface:

- Read current active TUI thread id.
- Read thread goal status.
- Set goal status to active.
- Request graceful stop/restart or handoff.
- Read current rate-limit state.
- Possibly reload auth or restart the model client cleanly.

Trade-offs:

Pros:

- Least terminal fragility.
- Best long-term fit for multiple frontends.
- Can support raw-looking `codex` workflows once the daemon is default.
- Gives AIMGR real state instead of scraping output.

Cons:

- Larger Codex-side work.
- Auth reload semantics must be designed carefully.
- If daemon auth is cached, simply rewriting `auth.json` still will not switch the
  active account.
- Restarting a daemon under a connected TUI may need reconnection handling.

This is probably the right long-term version if the goal is "I type `codex`, use
it normally, and AIMGR tends it in the background." It is not the fastest safe v1.

## Proposal 4: Native Codex account-rotation hook

Status: cleanest user experience, highest coupling.

Codex itself could call an external command when it detects a usage-limit event:

```toml
[automation]
on_usage_limit = "aim codex rotate-for-codex --json"
```

Then Codex would:

1. Hit usage limit.
2. Pause the goal.
3. Call AIMGR.
4. AIMGR selects and writes the next account.
5. Codex reloads auth or restarts the model client.
6. Codex resumes the goal.

This gives the best user experience because the thing that knows the real state,
Codex, owns the transition.

Trade-offs:

Pros:

- No wrapper needed.
- No PTY parsing.
- No ambiguity about the active thread.
- Works exactly when Codex knows the goal is usage-limited.

Cons:

- Requires deeper Codex changes.
- Codex must define safe external-hook behavior.
- Auth reload has to be correct.
- Bad hook behavior could affect normal Codex reliability.
- More likely to become a product/API design question instead of an AIMGR-only
  feature.

This is a strong long-term option, but the first implementation should probably
prove the workflow in AIMGR before moving account rotation into Codex itself.

## Proposal 5: Batch `codex exec --json` tender

Status: secondary mode only.

This mode is still useful for jobs that start as batch jobs:

```bash
aim codex exec --tend -- codex exec --json "<prompt>"
```

It can:

- Parse structured events.
- Detect usage limits cleanly.
- Rotate accounts.
- Restart the same non-interactive job.
- Produce machine-readable logs.

But it is not the right default for this workflow because the operator does not
start work in exact-json mode. The operator starts in the TUI, talks for a while,
then decides to run `/goal`.

Use this for CI-like or fully scripted jobs. Do not force it onto interactive
goal work.

## Recommended implementation sequence

### Phase 1: AIMGR wrapper proof of concept

Add:

```bash
aim codex run --tend
```

Behavior:

- Launch normal Codex TUI.
- Preserve terminal behavior.
- On child exit, identify the thread id.
- If no active or usage-limited goal exists, stop.
- If a stopped goal exists, rotate accounts and restart with
  `codex resume <thread-id>`.
- Confirm the installed built-in "Resume paused goal?" prompt by sending Enter
  through the PTY.
- Treat the visible "Goal active" / "Pursuing goal" transition as the success
  signal.

This proves the real overnight loop without changing the normal TUI experience.

### Phase 2: Add a small Codex automation surface

Add one or more minimal Codex capabilities:

```bash
codex thread status --json <thread-id>
codex goal status --json <thread-id>
codex resume <thread-id> --resume-goal
```

Or expose equivalent app-server methods usable by the same daemon-backed runtime
as the TUI.

The key is not to redesign Codex. The key is to give AIMGR a clean way to answer:

- Which thread was this?
- Does it have a goal?
- Is the goal usage-limited?
- Can I resume that goal without pretending to be a user typing keys?

### Phase 3: Background tending for daemon-backed TUI

Once the app-server path is reliable, support:

```bash
aim codex tend --daemon
```

This can tend a normal Codex TUI connected to the local daemon without wrapping
the terminal process directly.

### Phase 4: Optional native Codex hook

If the wrapper and daemon versions prove valuable, add a first-class Codex hook
for usage-limit recovery.

## Decision matrix

| Option | Preserves TUI workflow | Handles existing raw sessions | Implementation size | Reliability | Recommended role |
| --- | --- | --- | --- | --- | --- |
| TUI-preserving AIMGR wrapper | High | Low | Medium | Medium-high with small Codex status support | First build |
| Passive sidecar | Very high | Medium | Low | Low-medium | Guardrail only |
| App-server/daemon tender | Very high | High if daemon-backed | Medium-high | High | Medium-term target |
| Native Codex hook | Very high | High | High | High if designed well | Long-term target |
| `exec --json` tender | Low for this workflow | None | Medium | High for batch | Secondary batch mode |

## Important edge cases

### Multiple Codex sessions

Avoid `codex resume --last` if multiple sessions may be active. Use an exact
thread id whenever possible.

### Human intentionally exits

If the user exits a TUI with no active goal, AIMGR should stop. If the user exits
a TUI with an active goal, AIMGR should treat that as tendable only when the
wrapper was started in tending mode or the goal state explicitly indicates
overnight work should continue.

### Pre-threshold rotation

Pre-threshold rotation should be conservative.

Safe behavior:

- If Codex is not running yet, rotate before launch.
- If Codex has exited and a goal needs resuming, rotate before resume.
- If Codex is currently running and the operator may be present, do not kill it
  just because the account is at 15 percent remaining.

Aggressive overnight behavior can be a flag later:

```bash
aim codex run --tend --restart-below-5h-remaining-pct 5
```

Even then, the restart should happen only for active goal work.

### Refreshed tokens

Codex can refresh managed ChatGPT auth and persist new tokens. AIMGR should not
overwrite token improvements without preserving them. Before rotating away from
an account, AIMGR should import or preserve the refreshed auth material for the
label that was just used.

### Usage endpoint failures

If AIMGR cannot read live usage for the active target, it should not blindly
rotate. Existing AIMGR watch behavior already blocks on active target usage
failure, and the tender should preserve that safety unless there is a separate,
clear Codex hard usage-limit signal.

### Account switch is next-process only

The account switch boundary is process restart unless Codex grows a deliberate
auth reload API. AIMGR should treat `~/.codex/auth.json` as startup input for
Codex, not as live process control.

## Proposed CLI shape

Near-term:

```bash
aim codex run --tend
aim codex run --tend --rotate-below-5h-remaining-pct 20
aim codex run --tend -- --model gpt-5.1-codex
```

Possible split commands:

```bash
aim codex run       # launch supervised normal TUI
aim codex tend      # attach/passive monitor where possible
aim codex watch     # existing account-only primitive
```

Possible escape hatch:

```bash
aim codex run --tend --no-restart
```

or a key sequence handled by the wrapper to stop tending after the current TUI
exits.

## Testing strategy

AIMGR can test most of this without real Codex API calls.

Use the installed system Codex binary for Codex CLI/runtime checks:

```bash
/Users/aelaguiz/.local/bin/codex
```

Do not build the Codex source tree just to check command shapes. Use the source
repo for reading behavior and for planned code changes only.

Use fake child processes that:

- Print a fake Codex resume hint.
- Exit with success and no goal.
- Exit after writing fake usage-limit state.
- Hang like a long-running TUI.
- Emit noisy terminal output.

Test cases:

- No goal means no restart.
- Active goal plus low usage means rotate and resume.
- Usage-limited goal means rotate and resume goal.
- Multiple candidate accounts respect existing AIMGR ranking.
- Active usage endpoint 401 blocks unsafe rotation.
- Refreshed token material is preserved before account switch.
- Multiple session ambiguity refuses unsafe `--last` behavior.

Codex-side tests, if adding flags:

- `codex resume <thread-id> --resume-goal` resumes a usage-limited goal.
- The flag does not run for a thread with no goal.
- Existing interactive resume prompt still appears when no automation flag is
  provided.
- Supplying an initial prompt does not accidentally suppress required goal resume
  behavior unless the new flag explicitly handles it.

Manual installed-binary checks already run:

- `command -v codex` returned `/Users/aelaguiz/.local/bin/codex`.
- `codex --version` returned `codex-cli 0.134.0-alpha.1`.
- `codex resume --help` confirmed
  `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
- `codex app-server --help` confirmed the app-server command exists.
- `codex app-server daemon --help` confirmed daemon management commands exist.
- `codex app-server daemon version` failed because no daemon control socket
  exists, so no running managed daemon was available for app-server runtime
  checks.
- A real authenticated disposable TUI session was started under `tmux`.
- A real stopped goal was set on that thread through installed app-server JSONL.
- `codex resume <thread-id> "/goal resume"` was tested and shown not to parse the
  slash command.
- Plain `codex resume <thread-id>` was tested and showed Codex's built-in resume
  prompt.
- Sending Enter to that prompt started a real goal continuation turn.
- AIMGR's Codex use/watch tests passed with temp homes and fake credentials:
  `node --test test/codex/use-watch.test.js`.

## Ground truth checks run on 2026-05-23

All checks in this section used the installed Codex binary:

```bash
/Users/aelaguiz/.local/bin/codex
```

No Rust source build was used.

### Installed CLI surface

Confirmed:

```bash
command -v codex
```

returned:

```text
/Users/aelaguiz/.local/bin/codex
```

Confirmed:

```bash
codex --version
```

returned:

```text
codex-cli 0.134.0-alpha.1
```

Confirmed:

```bash
codex resume --help
```

shows:

```text
Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
```

Ground truth from this check:

- The installed interactive `codex resume` command publicly accepts both an
  optional session id and an optional prompt.
- The command shape needed for `codex resume <thread-id> "/goal resume"` exists.
- Runtime testing later proved that this prompt is a normal user message, not a
  slash command. The help shape is real, but it is not the right goal-resume
  primitive.

Confirmed:

```bash
codex app-server --help
codex app-server daemon --help
```

Ground truth from this check:

- The installed binary exposes app-server tooling.
- The installed binary exposes local daemon management.
- The local daemon command set includes `bootstrap`, `start`, `restart`,
  `enable-remote-control`, `disable-remote-control`, `stop`, and `version`.

Confirmed:

```bash
codex app-server daemon version
```

failed with:

```text
failed to connect to /Users/aelaguiz/.codex/app-server-control/app-server-control.sock
No such file or directory (os error 2)
```

Ground truth from this check:

- No managed app-server daemon was running at the time of testing.
- Daemon-mode tending cannot be tested against an already-running daemon until
  one is started.

### Disposable app-server JSONL checks

Started the installed app-server over stdio with a temporary `CODEX_HOME`:

```bash
CODEX_HOME="$(mktemp -d /tmp/codex-appserver-groundtruth.XXXXXX)" \
  codex app-server --listen stdio:// --enable goals
```

Then sent JSON-RPC JSONL messages directly over stdio.

Confirmed:

- `initialize` succeeds with `clientInfo.name = "aimgr_groundtruth"`.
- The server reports the temporary `codexHome`.
- `thread/goal/get` is a real installed method.
- `thread/goal/set` is a real installed method.
- For a fake UUID thread id, both `thread/goal/get` and `thread/goal/set`
  return:

```text
thread not found: 00000000-0000-0000-0000-000000000000
```

Ground truth from this check:

- The installed app-server accepts the exact goal API methods AIMGR would need.
- The goal APIs are not hypothetical source-only APIs.
- The handlers validate thread existence before reading or mutating goal state.
- AIMGR must use a real materialized thread id, not `--last` or a guessed id.

### Disposable thread-start boundary

Attempted to start a new thread in a temporary `CODEX_HOME` through app-server:

```json
{ "method": "thread/start", "id": 2, "params": {} }
```

Observed result:

- No `thread/start` response arrived within the test window.
- The installed app-server logged:

```text
failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses
```

Ground truth from this check:

- A disposable `CODEX_HOME` without valid auth cannot materialize a live thread
  for continuation testing.
- Testing actual goal continuation requires either a real authenticated Codex
  home/session or a mocked app-server/Codex backend.
- This check did not prove or disprove goal continuation. It only identified the
  auth boundary for a disposable runtime test.

### Real `~/.codex` read-only app-server checks

Started installed app-server over stdio with the real Codex home:

```bash
codex app-server --listen stdio:// --enable goals
```

Then sent:

```json
{ "method": "thread/list", "id": 2, "params": { "limit": 5 } }
```

Confirmed:

- `thread/list` works against the real `~/.codex` state without starting a model
  turn.
- It returned recent persisted sessions.
- The most relevant returned session for this investigation was:

```text
019e528d-c6c2-7f43-98aa-d48180e7a155
```

with preview beginning:

```text
understand this repo ramp up on ~/workspace/aimgr ...
```

Then sent a read-only goal query:

```json
{
  "method": "thread/goal/get",
  "id": 2,
  "params": {
    "threadId": "019e528d-c6c2-7f43-98aa-d48180e7a155"
  }
}
```

Observed:

```json
{ "goal": null }
```

Ground truth from this check:

- AIMGR can use installed app-server JSONL to list real Codex threads.
- AIMGR can use installed app-server JSONL to read a real thread's goal state.
- The current investigation thread did not have a persisted `/goal` at the time
  of this read-only check.
- Because the checked thread had no goal, this specific read-only check could
  not prove goal continuation behavior. Later disposable tmux checks covered
  that.

### Real tmux resume checks

Started a real authenticated disposable Codex TUI session under tmux:

```bash
tmux new-session -d -s aimgr_goal_test_20260523_1 \
  -c /Users/aelaguiz/workspace/aimgr \
  '/Users/aelaguiz/.local/bin/codex --no-alt-screen "AIMGR_DISPOSABLE_GOAL_RESUME_TEST_20260523. Reply exactly AIMGR_TEST_READY_20260523 and do not run commands or edit files."'
```

Observed in the tmux pane:

```text
• AIMGR_TEST_READY_20260523
```

Then used installed app-server JSONL against real `~/.codex` to find the
materialized thread:

```text
019e52ad-96dd-73e3-946b-8096e4c38d16
```

Set a disposable stopped goal on that thread:

```json
{
  "threadId": "019e52ad-96dd-73e3-946b-8096e4c38d16",
  "objective": "AIMGR disposable resume-goal test. On the next goal continuation turn, reply exactly AIMGR_GOAL_TURN_20260523 and do not edit files.",
  "status": "usageLimited",
  "tokenBudget": null
}
```

Verified with `thread/goal/get` that the persisted goal status was:

```json
"status": "usageLimited"
```

#### Initial-prompt shortcut test

Ran:

```bash
codex resume 019e52ad-96dd-73e3-946b-8096e4c38d16 "/goal resume"
```

Observed in the tmux pane:

```text
› /goal resume
• AIMGR_GOAL_TURN_20260523
```

At first glance that looks successful, but the rollout file proved it was not a
real slash-command resume. The persisted session contained `/goal resume` as a
normal user message, then the model called `get_goal`, and `get_goal` returned:

```json
"status": "usageLimited"
```

Ground truth from this check:

- `codex resume <thread-id> "/goal resume"` does not parse `/goal resume` as a
  TUI slash command.
- It suppresses the built-in startup prompt.
- It can produce a model answer, but it does not resume the goal runtime.
- AIMGR should not use this shortcut.

#### Built-in startup prompt test

Reset the same disposable goal to `usageLimited` with a new marker objective:

```text
AIMGR plain resume startup-prompt test. On the next real goal continuation turn,
reply exactly AIMGR_STARTUP_GOAL_20260523 and do not edit files.
```

Then ran plain resume with no initial prompt:

```bash
codex resume 019e52ad-96dd-73e3-946b-8096e4c38d16
```

Observed Codex's built-in startup prompt:

```text
Resume paused goal?
Goal: AIMGR plain resume startup-prompt test. On the next real goal continua

› 1. Resume goal   Mark it active and continue when idle
  2. Leave paused  Keep it paused; use /goal resume later

Press enter to confirm or esc to go back
```

Sent Enter to the tmux pane. Observed:

```text
• Goal active Objective: AIMGR plain resume startup-prompt test. On the next
real goal continuation turn, reply exactly AIMGR_STARTUP_GOAL_20260523 and do
not edit files.

• AIMGR_STARTUP_GOAL_20260523
```

Then `thread/goal/get` returned:

```json
{
  "status": "complete",
  "timeUsedSeconds": 11
}
```

Ground truth from this check:

- Plain `codex resume <thread-id>` detects a stopped goal and shows the built-in
  resume prompt.
- Confirming the prompt with Enter marks the goal active.
- The real goal runtime starts a continuation turn.
- No Codex source modification is required for a v1 AIMGR tender if AIMGR owns a
  PTY or tmux pane and can confirm this prompt.

### AIMGR use/watch tests

Ran:

```bash
node --test test/codex/use-watch.test.js
```

Observed:

```text
tests 44
pass 44
fail 0
```

Ground truth from this check:

- Existing AIMGR tests cover `codex use` writing managed `auth.json`.
- Existing AIMGR tests cover `codex watch --once` no-op, rotate, and blocker
  behavior.
- Existing AIMGR tests cover pool ordering, skipped expired labels, non-file
  backed Codex home refusal, and stale managed auth cleanup.
- New AIMGR tests cover `aim codex run --tend` CLI wiring.
- New AIMGR tests cover `--resume <session-id>` and
  `--session-id <session-id>` CLI wiring.
- New AIMGR tests cover `-p yolo`, `--profile yolo`, `--codex-profile yolo`,
  and pass-through `-- -p yolo` Codex profile handling.
- New AIMGR tests cover rejecting conflicting Codex profile inputs before
  starting `tmux`.
- New AIMGR tests cover blocked tender exit-code behavior.
- New AIMGR tests cover starting the first tmux session as
  `codex resume <session-id>` when the operator provides an existing Codex
  session UUID.
- New AIMGR tests cover exact Codex passthrough resume form:
  `aim codex run --tend -- resume <session-id>`.
- New AIMGR tests cover rejecting `--last`, thread names, conflicting session
  ids, extra resume prompts, and pass-through args that would be silently
  ignored during a tended resume.
- New AIMGR tests cover usage-limited goal detection, account rotation, plain
  `codex resume <thread-id>`, and Enter confirmation of the built-in
  resume-goal prompt.
- New AIMGR tests assert that the tender never uses
  `codex resume <thread-id> "/goal resume"`.
- New AIMGR tests cover blocking after one rotation if Codex's resume-goal
  prompt cannot be confirmed, instead of repeatedly rotating accounts.
- New AIMGR tests cover preserving refreshed live Codex auth into AIMGR state
  before account rotation.
- This validates the account-side primitive without mutating real local AIMGR
  state.

### Full AIMGR verification after implementation

Ran:

```bash
npm run lint
```

Observed:

```text
node --check completed for ./bin ./src ./test
```

Ran:

```bash
node --test test/cli/readme-contract.test.js
```

Observed:

```text
tests 2
pass 2
fail 0
```

Ran:

```bash
npm test
```

Observed:

```text
tests 202
pass 202
fail 0
```

Ground truth from this check:

- The new command is documented in both CLI help and README.
- JavaScript syntax checks pass across `bin`, `src`, and `test`.
- The full AIMGR test suite passes after adding the tmux tender, app-server
  client, credential-preservation path, CLI parser changes, help text, README
  docs, Codex profile preservation, existing-session resume support, and tests.

### Production soak not run

The full overnight tender has not yet been run until a real account hits a live
rate limit, rotates to another real account, resumes the thread, confirms the
prompt, and continues for hours.

That is a production soak, not an unimplemented code path. The implemented and
tested state machine now covers the same transition with fake app-server/tmux
adapters, and the installed-binary tmux check proved Codex's real prompt and
continuation behavior.

Ground truth status after testing:

```text
Verified: installed CLI and app-server surfaces exist.
Verified: app-server goal get/set methods exist and validate real thread ids.
Verified: real thread listing and goal reads work through installed app-server.
Verified: no daemon was running during checks.
Verified: codex resume <thread-id> "/goal resume" is not a real slash-command resume.
Verified: plain codex resume <thread-id> + Enter on the built-in prompt resumes a real goal.
Verified: AIMGR can now port an existing Codex session UUID into tending with
`--resume`, `--session-id`, or exact `-- resume <uuid>` passthrough.
Verified: AIMGR Codex use/watch/tender tests pass.
Verified: full AIMGR lint and test suite pass.
Not run: a multi-hour production soak under real rate-limit pressure.
```

## Bottom line

The right first product is not "run Codex in JSON mode overnight."

The implemented first product is:

```bash
aim codex run --tend
```

It does not need a Codex source change for v1 if AIMGR owns the `tmux`/PTY:
launch or resume the normal TUI, rotate accounts between processes, run plain
`codex resume <thread-id>`, and press Enter on Codex's own resume-goal prompt.

It should feel like normal Codex while the operator is present, then perform the
same manual recovery sequence the operator already does when a `/goal` session
hits usage limits:

1. Stop at a real boundary.
2. Rotate with AIMGR.
3. Resume the same thread.
4. Confirm Codex's built-in goal-resume prompt.

`codex exec --json` remains useful, but only for jobs that were batch jobs from
the start.
