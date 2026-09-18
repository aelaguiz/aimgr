---
name: aimgr
description: "Use AI Manager (the `aim` CLI) to launch a Claude, Codex, Prime, or Grok session on a pooled account, see which accounts are available, and pick an available one when the others are busy or rate-limited. Use when asked to launch or start a session through AI Manager or `aim`, to run Claude, Codex, Fable, Opus, Sol, Prime, or Grok on a managed account, or to find a free account. Not for developing the aimgr codebase itself, and not for credential enrollment, `aim login`, Redis administration, browser bindings, or scheduled routines — those are human or maintainer actions."
---

# AI Manager (`aim`)

AI Manager pools many provider accounts and launches coding-agent sessions on
whichever one is healthy. You do three things with it: **launch a session**,
**see what is available**, and **choose an available account** when the one you
wanted is busy or limited.

`aim` picks the account for you. The label-free launch forms rank eligible
accounts and select one, so an agent that never types an account name is
usually more correct than one that picks. Name an account only when the user
named it, or when you are continuing an exact session.

## Requirements

- `aim` on `PATH`. If it is missing, say so and stop; do not fall back to a
  bare `claude` or `codex`, which would run on unmanaged credentials.
- Redis reachable. `aim status --compact` prints `redis=live` when it is.
  Selection fails closed without it.

## When to use

- The user asks you to launch or start a session through AI Manager or `aim`.
- The user asks for Claude, Codex, Fable, Opus, Sol, Prime, or Grok on a
  managed or pooled account.
- The user asks which accounts are free, which are rate-limited, or what the
  account pool looks like.
- A session needs to start and you need to know which account is healthy first.

## When not to use

- You are changing code in the aimgr repository itself. That is ordinary
  development work; read the repo, not this skill.
- The task is credential enrollment, OAuth repair, Redis administration,
  browser-profile binding, or scheduled routines. Those live in this tool but
  are maintainer surface, not agent surface.
- The question is *whether* to spawn a worker, delegate, or parallelize. This
  skill covers how to run `aim` once that decision is made.

## The recipe

1. **Check the coordination layer.**

   ```bash
   aim status --compact
   ```

   Expect `redis=live`. If Redis is not live, stop and report it; no account
   can be selected.

2. **See what is available** for the provider you want.

   ```bash
   aim claude status        # Claude: READY / IN USE / NEEDS YOU, with a `next` column
   aim status --accounts    # Codex: st, wk_used, and a flags column
   aim grok status          # Grok seats
   ```

   Read [references/status-and-limits.md](references/status-and-limits.md) for
   what the columns mean and which account to prefer.

3. **Launch, letting `aim` choose the account.**

   ```bash
   aim claude run fable          # Claude, ranked by Fable-scoped usage
   aim claude run opus           # Claude, ranked by shared 5h usage
   aim codex run                 # Codex, selects then launches `codex -p yolo`
   aim prime run codex           # Prime on Codex
   aim prime run claude          # Prime on Claude
   aim prime run grok            # Prime on Grok
   ```

   For an exact account, resuming a session, passing arguments through, or
   choosing a model, read
   [references/commands.md](references/commands.md).

4. **Report the account it landed on.** The launchers print the selected label.
   Say which one so the user can see where their usage went.

## Boundaries

These hold on every invocation.

- **`NEEDS YOU` is a human wall.** Skip that account. Never run `aim login`,
  even though the `next` column suggests it — that is an interactive OAuth flow
  needing a browser and a person. If every account is `NEEDS YOU`, stop and say
  so.

- **Never run credential, enrollment, or Redis-admin commands.** Not
  `aim login`, `aim claude capture-native`, `aim claude import-native`,
  `aim claude export-live`, `aim redis configure|import|export`,
  `aim label rebind`, `aim browser set`, or `aim credential-helper`. These
  move real credentials. They are the user's to run.

- **A blocked selection is a stop-and-report, not a retry loop.** If you see
  `no_eligible_pool_account` or `no_alternate_pool_account`, the pool has
  nothing to give you right now. Name the provider and the exact code and let
  the user decide. Do not launch repeatedly hoping to land somewhere.

- **Do not resume a session you did not start** unless the user asked. When
  asked: one at a time, by exact id, in that pane's own working directory.

- **One launch per request.** Do not fan out across several accounts to go
  faster.

- **`aim --help` outranks this skill.** If they disagree, the CLI is right and
  this file is stale; follow the CLI and say what differed.

## Reference map

- [references/commands.md](references/commands.md) — every launch and resume
  form per provider, model names, argument pass-through, and the `c` / `cr`
  shell shortcuts. Read when you need an exact command.
- [references/status-and-limits.md](references/status-and-limits.md) — how to
  read each status table column by column, which account to prefer, and what
  each failure code means. Read when choosing an account or when something
  failed.
