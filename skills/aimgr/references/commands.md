# Launch and resume commands

Every form below comes from `aim --help`. If this file and `aim --help`
disagree, the CLI is right.

## Claude

```bash
aim claude run fable                      # let aim choose; ranked by Fable-scoped usage
aim claude run opus                       # let aim choose; ranked by shared 5h usage
aim claude run fable --resume             # same, resuming the account's last session

aim claude run <label> fable              # exact account, Fable preset
aim claude run <label> opus               # exact account, Opus preset
aim claude run <label> -- <claude args>   # exact account, raw Claude arguments
```

`fable` and `opus` are **usage-ranking presets**, not just model names. Both
select an unlocked, eligible account; they differ in which usage window they
rank by. Use `fable` unless the user asked for Opus.

### Resuming a Claude session

```bash
aim claude resume                         # interactive picker, most recent first
aim claude resume <row-number>            # pick by the row the picker showed
aim claude resume <thread-id>             # pick by exact session id
aim claude resume "<session name>"        # exact, case-insensitive; quote if it has spaces
aim claude resume <selector> --account <label>            # fork onto another account
aim claude resume <selector> --switch-account fable|opus  # override the model preset
```

The picker lists saved title, age, account, and working directory. `n` pages
to older sessions, `p` to newer, `q` or empty Enter cancels. The session
resumes in its own working directory on its recorded model and effort.

For scripts, list first and pass an explicit selector:

```bash
aim claude list [count] [--json]          # default 50 most recent
```

## Codex

```bash
aim codex run                             # select an account, then launch `codex -p yolo`
aim codex run <label> -- <codex args>     # that exact account, your own arguments
aim codex resume [<session-id>]           # select, then resume the SAME thread with -p yolo
aim codex resume-fresh <session-id>       # select, copy the thread to a NEW scrubbed thread id, resume the copy
aim codex use [label]                     # select only; does not launch
```

`resume` keeps the thread id, so the account changes under one continuing
session. `resume-fresh` rotates the account and starts a new thread with the
prior turns copied in and the old identifiers retired; use it when a session
must not look like one account hopping. It refuses paginated fork segments,
subagent threads, and threads that spawned subagents, and it verifies the copy
before launching. Flags: `--last`, `--dry-run`, `--no-goal`,
`--keep-server-blobs`, `--max-copy-mb <n>`, `--archive-source`, and `--` for
arguments passed to `codex resume`.

`aim codex run` with no arguments defaults to `codex -p yolo`. Arguments after
`--` pass through unchanged.

**Codex reads its credentials at process start.** A selection change does not
reach an already-running Codex; it needs a new process.

Example — select, verify, then launch with an explicit model:

```bash
aim codex use writer
aim status --compact
aim codex run writer -- exec --model gpt-6-astra \
  -c 'model_reasoning_effort="xhigh"' --json 'Your prompt'
```

### Shell shortcuts

If `scripts/install-codex-shortcuts.sh` has been run, two zsh functions exist:

```zsh
c()   { command aim codex run "$@"; }
cr()  { command aim codex resume-fresh "$@"; }
crr() { command aim codex resume "$@"; }
```

Both select an account before launching. In an existing terminal that predates
the install, load them with
`source "$HOME/.config/aimgr/codex-shortcuts.zsh"`.

## Prime

```bash
aim prime run codex [model]               # default gpt-5.6-sol
aim prime run codex gpt-6-astra           # explicit model
aim prime run claude                      # claude-fable-5-1
aim prime run grok                        # grok-4.6
aim prime resume <path-or-id>             # resume an existing Prime session
aim prime status
```

In a Herdr pane, run `aim prime resume` as a child process, never with `exec`,
and pass the absolute transcript path rather than the uuid.

`aim prime resume <session> --rotate` hands a live managed root to a different
same-provider account. It is an operator command; do not run it on your own
initiative.

## Grok

Grok seats are launched through Prime:

```bash
aim prime run grok
```

## Models

| Name the user says | Value |
|---|---|
| Fable | `claude-fable-5-1` |
| Opus | `claude-opus-5` |
| Astra | `gpt-6-astra` (default Codex model, `xhigh` effort) |
| Sol | `gpt-5.6-sol` (Prime's Codex default) |
| Grok | `grok-4.6` |

For Claude launches, prefer the `fable` / `opus` presets over passing a model
flag; the preset also picks the account.
