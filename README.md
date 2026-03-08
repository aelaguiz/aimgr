# aimgr

`aimgr` (CLI: `aim`) is a small, opinionated **AI account manager** for people running **multiple paid AI accounts** and needing those accounts wired cleanly into downstream automation tooling (today: **OpenClaw**).

The point is dead simple:

- You should only ever need to remember the **account label** (`boss`, `coder2`, `lessons`, …).
- You run **one command** (`aim <label>`).
- `aimgr` opens the **right browser profile**, completes OAuth, stores tokens in **one plaintext file**, and then updates downstream tool state so the right agent uses the right account.

This repo is intentionally “no-magic”: when something is unclear, we read upstream source and match its behavior. No black boxes.

## Non-negotiables (v0)

- **No guessing / no black boxes:** adapters are written from upstream behavior (OpenClaw / Codex OAuth), not vibes.
- **`aimgr` is the SSOT:** we store credentials + mappings in `~/.aimgr/secrets.json`. Downstream stores are *derived outputs* and may be overwritten.
- **Plaintext secrets on disk:** no Keychain, no encryption, no secret manager. Just a flat file and automatic backups.
- **Everything is labeled:** we do **not** accept a steady state where accounts collapse to `*:default` (especially `openai-codex:default`).
- **Providers are explicit:** each label has a `provider` (today: `openai-codex` or `anthropic`).
- **One OpenClaw model (for now):** when syncing OpenClaw, pinned agents are forced to `openai-codex/gpt-5.4` and fallbacks are cleared.

## Quickstart (what you actually type)

### 0) Prereqs

- macOS (OAuth flow uses a localhost callback + opens Chrome)
- Node.js `>= 20`
- `openclaw` installed and on your `PATH` (AIM calls `openclaw config …` and optionally `openclaw gateway call …`)
- Google Chrome installed (AIM launches Chrome via `open -a "Google Chrome" …`)
- OpenClaw browser profiles already exist on disk under `~/.openclaw/browser/*/user-data`
  - If they don’t exist yet, run OpenClaw’s browser/profile flow once to create them.

### 1) Install the CLI from this repo

This repo is not published to npm (v0), so the expected dev install is:

```bash
cd <wherever-you-cloned>/aimgr
npm install
npm link

aim --help
```

You should now have both `aim` and `aimgr` available (same command; `aim` is shorter).

### 2) Login one account label (single command)

```bash
aim boss
```

What happens:

1) If `boss` doesn’t have an OpenClaw browser profile selected yet, `aim` will list OpenClaw browser profiles it finds and ask you to pick one.
2) If `boss` doesn’t have a provider configured yet, `aim` prompts you to pick one (default is `openai-codex`).
2) `aim` opens the OAuth URL in **that** browser profile.
3) If the provider is:
   - `openai-codex`: the login completes automatically via localhost callback.
   - `anthropic`: you’ll do an extra step: paste the callback URL from your browser back into the CLI.
4) Tokens are stored in `~/.aimgr/secrets.json`.
4) `aim` auto-pins `agent_boss -> boss` if `~/.openclaw/agents/agent_boss/…` exists.
5) `aim` syncs OpenClaw derived state (`auth-profiles.json`, model enforcement, and session cleanup).

Important: OpenClaw sync supports both `openai-codex` and `anthropic` now. When an OpenClaw agent is pinned to a label, AIM will:

- write labeled auth profiles into OpenClaw (`<provider>:<label>`, e.g. `openai-codex:boss`, `anthropic:claudalyst`)
- set the pinned agent’s model to a provider-appropriate default:
  - `openai-codex` → `openai-codex/gpt-5.4`
  - `anthropic` → `anthropic/claude-opus-4-6`

### 3) Pin other OpenClaw agents to accounts (pooling)

Pin one agent to one label:

```bash
aim pin agent_lessons boss
```

Or distribute **all remaining unpinned OpenClaw agents** evenly across a pool of labels:

```bash
aim autopin openclaw --pool boss,lessons,product_growth,qa,illustrator
```

### 4) Apply/sync OpenClaw (explicit)

```bash
aim sync openclaw
# (alias)
aim apply
```

## Mental model

### Labels

A **label** is a human-friendly name for a paid account (examples: `boss`, `coder2`, `qa`).

Rules:

- lowercase, digits, `_`, `-` only
- `default` is forbidden (we never want `*:default` in steady state)
- some CLI words are reserved (`status`, `login`, `pin`, `autopin`, `apply`, `sync`, `help`)

### Accounts vs pins

- **Account:** `label -> provider + browser profile + credentials`
- **Pin:** `openclaw_agent_id -> label`

When we say “pooling”, we mean: *many agents can be pinned to the same label*, so those agents share the same paid account.

## SSOT file (one file; plaintext; local-only)

`aim` reads and writes exactly one file by default:

- `~/.aimgr/secrets.json`

Every write creates an automatic timestamped backup sibling file first:

- `~/.aimgr/secrets.json.bak.<timestamp>`

### SSOT format (example)

This is the real shape (tokens shown as placeholders):

```jsonc
{
  "schemaVersion": "0.1",
  "accounts": {
    "boss": {
      "provider": "openai-codex",
      "openclawBrowserProfile": "agent-boss",
      "expect": { "email": "boss@fun.country" }
    },
    "claude": {
      "provider": "anthropic",
      "openclawBrowserProfile": "agent-claude"
    }
  },
  "pins": {
    "openclaw": {
      "agent_boss": "boss",
      "agent_lessons": "boss"
    }
  },
  "credentials": {
    "openai-codex": {
      "boss": {
        "access": "…",
        "refresh": "…",
        "expiresAt": "2026-03-13T03:21:00.000Z",
        "accountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      }
    },
    "anthropic": {
      "claude": {
        "access": "…",
        "refresh": "…",
        "expiresAt": "2026-03-13T03:21:00.000Z"
      }
    }
  }
}
```

Notes:

- `credentials.*.*.access` + `.refresh` are **sensitive** and stored plaintext on purpose (non-negotiable).
- `accountId` is used to prevent “wrong Chrome profile” mistakes and to query usage.

## Command reference

### `aim status`

Human summary of what AIM knows (accounts + pins + warnings).

```bash
aim status
```

`aim status` probes usage for each stored token and shows rate-limit windows when available.

### `aim status --json`

Machine-readable status (tokens are redacted in output).

```bash
aim status --json | jq .
```

### `aim <label>` (the “one command” flow)

Shorthand for `aim login <label>`, plus:

- ensures the label has a chosen OpenClaw browser profile (prompts if needed)
- ensures the label has an explicit provider (prompts if needed)
- refreshes tokens when possible (no browser)
- falls back to OAuth login (opens browser)
  - `anthropic` requires a paste step (by design; we don’t guess)
- auto-pins `agent_<label> -> <label>` when that agent exists on disk
- syncs OpenClaw derived state

Examples:

```bash
aim boss
aim coder2
aim product_growth
aim claude
```

### `aim login <label>`

Explicit version of the same thing:

```bash
aim login boss
```

### `aim pin <openclaw_agent_id> <label>`

Manual pin override (rare).

```bash
aim pin agent_daily_wins_reporter boss
```

### `aim autopin openclaw [--pool …]`

Evenly distributes *currently unpinned* OpenClaw agents across a pool of labels.

```bash
aim autopin openclaw --pool boss,lessons,qa,illustrator,product_growth
```

If you omit `--pool`, AIM auto-discovers pool labels from accounts it knows, excluding reserved labels (`coder`, `coder2`, `growth`) by default.

### `aim sync openclaw` / `aim apply`

Explicit “write all derived OpenClaw state from SSOT”.

```bash
aim sync openclaw
```

This is safe to run repeatedly; it’s designed to be idempotent.

## How OpenClaw integration works (ground truth)

This is what AIM changes in OpenClaw when you run `aim …` (without `--home`).

### 1) Browser profiles: AIM uses OpenClaw-managed Chrome identities

When AIM needs to do OAuth, it opens Chrome with:

- a **specific OpenClaw browser profile user-data-dir**:
  - `~/.openclaw/browser/<profileId>/user-data`

AIM discovers those profiles by listing:

- `~/.openclaw/browser/*/user-data`

And it reads friendly names/emails from:

- `~/.openclaw/browser/<profileId>/user-data/Local State`

Then it launches:

```bash
open -n -a "Google Chrome" --args --user-data-dir=<that-user-data-dir> <oauth-url>
```

This is why we don’t need a separate “Chrome profile manager” inside AIM: OpenClaw’s browser profiles are already the correct SSOT for “which Chrome identity belongs to which agent/account”.

### 2) Auth profiles: labeled, non-default OpenClaw auth store

AIM writes OpenClaw auth profiles to:

- `~/.openclaw/agents/main/agent/auth-profiles.json` (the shared store)
- `~/.openclaw/agents/<agent_id>/agent/auth-profiles.json` (per-agent overrides)

Key behavior:

- Each AIM label becomes an OpenClaw auth profile id: `openai-codex:<label>`
- `openai-codex:default` is not used for managed accounts
- The `main` store gets **all** managed `openai-codex:*` profiles (AIM overwrites the `openai-codex` provider set)
- Each pinned agent store gets an `order.openai-codex = ["openai-codex:<label>"]` and `lastGood.openai-codex` set to that id

### 3) Model enforcement: pinned agents are forced to `openai-codex/gpt-5.4`

For each pinned agent id in `pins.openclaw`, AIM enforces:

- `agents.list[...].model.primary = "openai-codex/gpt-5.4"`
- if that agent had `fallbacks`, they are cleared to `[]`

This is done by calling OpenClaw config:

- `openclaw config get agents.list --json`
- `openclaw config set --strict-json <path> <value>`

### 4) Session cleanup: prevent “old sessions” from reintroducing wrong models/providers

When agents change provider/model, OpenClaw sessions can keep runtime/override fields like:

- `modelProvider`, `model`
- `providerOverride`, `modelOverride`
- `authProfileOverride`, plus fallback notice fields

Those stale session fields can cause the gateway to “pick up” an old session on restart and keep using the wrong provider/model (and/or wrong tool references).

On every sync, AIM scans pinned agents’ session stores:

- `~/.openclaw/agents/<agent_id>/sessions/sessions.json`

If sessions need reset, AIM tries **gateway mode** first:

- probes: `openclaw gateway call sessions.list`
- patches: `openclaw gateway call sessions.patch --params '{"key":"…","model":"openai-codex/gpt-5.4"}'`

If the gateway is unavailable or patching fails, AIM falls back to **disk mode**:

- it edits `sessions.json` to remove the stale runtime/override fields (with backup-on-write)

## Dev/test mode: `--home` (don’t touch real state)

If you pass `--home`, AIM treats that as `HOME` and writes state under it:

- `<home>/.aimgr/secrets.json`
- `<home>/.openclaw/**`

And it intentionally **skips**:

- OpenClaw config changes (`openclaw config set …`)
- live gateway session patching (`openclaw gateway call …`)

This is used by `npm test` and is the safe way to iterate without touching your real OpenClaw setup.

## Security / risk (read this)

- `~/.aimgr/secrets.json` contains plaintext OAuth tokens. This is intentional.
- Treat it like `~/.ssh/id_rsa`:
  - keep it local
  - don’t back it up to random cloud drives
  - consider `chmod 600 ~/.aimgr/secrets.json`
- Backups are also secrets (`~/.aimgr/secrets.json.bak.*`).

## Troubleshooting

### “Refusing to clobber: accountId=… is already assigned to label=…”

This almost always means: you selected the wrong OpenClaw browser profile for the label.

Fix:

1) Run `aim <label>` again and choose the correct OpenClaw browser profile.
2) Then re-run `aim sync openclaw`.

### “No OpenClaw browser profiles discovered…”

You likely don’t have OpenClaw browser profiles on disk yet.

Create them via OpenClaw first (OpenClaw is the SSOT for browser identities), then retry `aim <label>`.

### “Gateway service not loaded”

This is an OpenClaw service/launchd issue, not an AIM issue.

At a minimum, you want the gateway running so AIM can patch live sessions:

```bash
openclaw gateway status
openclaw gateway install   # loads the launchd service (one-time)
openclaw gateway start
```

If you’re managing OpenClaw as a host service, prefer your host runbook / launchd tooling.

## Development

```bash
npm test
npm run lint
```

Tests use `--home` temp dirs and validate:

- we never print access/refresh tokens in `aim status --json`
- OpenClaw auth profile writing is labeled (`openai-codex:<label>`)
- model enforcement ops are generated correctly
- session cleanup logic clears the right fields
