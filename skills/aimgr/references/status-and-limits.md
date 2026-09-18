# Reading availability, and what failures mean

## The one-line health check

```bash
aim status --compact
```

```
redis=live  accounts=59  codex=qa  claude_last=coder
```

`redis=live` is the only part you must check before selecting an account.
Without a live Redis there is no shared account state and selection fails
closed. `codex=` is the currently selected Codex label; `claude_last=` is the
last Claude label used.

## Claude availability

```bash
aim claude status                       # cached read, no provider calls
aim claude status <account> [<account>] # limit to specific accounts
aim claude status --fresh               # force live provider checks
aim claude status --json                # machine-readable
```

`aim claude usage` is an exact alias of `aim claude status`.

Sample output:

```
CLAUDE: 10 ready · 15 in use · 3 needs you · 0 unknown
account            status     5h   5h_in  week  wk_in  Fable  Fb_in  updated  next
boss               READY      0%   --     60%   2.2d   100%   2.2d   now      use now
coder              IN USE     0%   4.9h   37%   4.6d   40%    4.6d   now      session active
coder2             READY      0%   --     100%  7.6h   13%    7.6h   now      use now
qa                 NEEDS YOU  --   --     --    --     --     --     --       aim login qa
```

| Column | Meaning |
|---|---|
| `status` | `READY` — unlocked and usable. `IN USE` — a session holds it. `NEEDS YOU` — a human must reauthenticate. `UNKNOWN` — state could not be read; retry. |
| `next` | The literal next action for that account. Trust this column. |
| `5h` / `week` / `Fable` | Percentage of that window **used**, not remaining. Lower is better. |
| `5h_in` / `wk_in` / `Fb_in` | When that window resets. |
| `updated` | `now` means a live reading; anything else is the cache age. |

**How to choose:** prefer a `READY` row with low `week` and low `Fable`. In the
sample, `boss` is a better pick than `coder2`, whose weekly window is spent.

In practice you rarely choose by hand — `aim claude run fable` and
`aim claude run opus` apply this same ranking and select for you. Read the
table to report what is available, to honor a user's preference, or to explain
why a launch was blocked.

`--fresh` makes real provider requests. Default to the cached read; use
`--fresh` only when the cache is stale enough to matter.

## Claude coverage without any provider calls

```bash
aim claude inventory [--json]
```

Instant account coverage straight from Redis, zero provider requests. Use it
when you want the roster rather than live usage. Candidate-only, incomplete,
expired, and blocked records stay distinguishable here.

## Codex availability

```bash
aim status --accounts
```

```
CODEX ACCOUNTS (31)
label    st       lock  login  exp  wk_used  wk_in  resets  provider      usage_src    flags
boss     ready    free  --     10d  21%      3.9d   0       openai-codex  cache        -
coder    ready    free  --     7d   100%     35.9h  3       openai-codex  cache        week_full
pro12    blocked  free  --     4d   14%      33.6h  2       openai-codex  cache        -
pro15    blocked  free  --     6d   0%       2.6d   0       openai-codex  cache        -
```

| Column | Meaning |
|---|---|
| `st` | `ready` — selectable. `blocked` — not selectable, whatever its usage says. |
| `wk_used` | Percentage of the weekly window used. Lower is better. |
| `wk_in` | When the weekly window resets. |
| `flags` | `week_full` marks a spent weekly window. |

**How to choose:** prefer `ready` with low `wk_used` and no `week_full`. In the
sample, `boss` is the pick; `coder` is ready but spent, and `pro12` / `pro15`
are blocked regardless of usage.

Again, `aim codex run` with no label applies this ranking itself.

## Grok availability

```bash
aim grok status [label...] [--json]
aim grok inventory [--json]              # seats only, no provider requests
```

```
label              email                tier         used/limit  allow  expires
personal           you@example.com      X Premium+   0/14934     yes    2026-09-18T04:13:22.761Z
```

`allow: yes` and headroom in `used/limit` mean the seat is usable.

## Failure shapes

Each of these is a stop-and-report. Name the provider and the exact code, then
let the user decide what to do.

| What you see | What it means | What to do |
|---|---|---|
| `no_eligible_pool_account` | Nothing in the pool is selectable for that provider right now. | Report it with the provider name. Do not retry in a loop. |
| `no_alternate_pool_account` | Codex selection found no *different* eligible label. The current account is preserved and unchanged. | Report it. The current account is still usable if the user wants it. |
| `NEEDS YOU` / `reauth_required` | That account needs an interactive OAuth login from a person. | Skip the account. Report the label. Never run `aim login` yourself. |
| `redis=live` missing, or a Redis error | The shared account store is unreachable; selection fails closed. | Report it. Nothing can be selected until Redis returns. |
| `identity_conflict` | The target's stored identity does not match the label. | Report it; it needs a maintainer. |

A usage limit hit *inside* a running session is that agent's own signal, not an
`aim` failure. Report what happened and which account it was on. Deciding
whether to wait, switch, or stop is the user's call, not yours.
