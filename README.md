# aimgr

`aimgr` (CLI: `aim`) is a small AI account manager for one job:

- keep labeled paid-account truth in AIM
- keep browser ownership in AIM
- compile that truth into downstream targets like OpenClaw, local Codex CLI, and local Pi CLI

The operating model is intentionally simple:

- `~/.aimgr/secrets.json` is the durable SSOT
- browser binding is explicit per label:
  - `aim-profile` -> `~/.aimgr/browser/<label>/user-data`
  - `chrome-profile` -> explicit raw Chrome `user-data-dir`
  - `agent-browser` -> explicit `profile` + `session`
  - `manual-callback` -> no local browser binding
- OpenClaw assignments plus local Codex/Pi `auth.json` are derived outputs
- operators think in labels like `boss`, `lessons`, and `qa`, not raw tokens or profile IDs

## North star

One AIM-owned account pool, one obvious operator path, and no legacy drift.

That means:

- `aim <label>` is the primary human path
- `aim rebalance openclaw` is the canonical OpenClaw assignment command
- `aim codex use` is the canonical local Codex selection command
- `aim pi use` is the canonical local Pi selection command
- `aim pin`, `aim autopin openclaw`, and label-first `aim codex use` / `aim pi use` are removed

## Non-negotiables

- AIM is the only durable credential SSOT.
- OpenClaw, Codex CLI, and Pi CLI are derived targets, not competing truth.
- Operator-facing account state collapses to `ready`, `reauth`, or `blocked`.
- Labels are explicit; there is no steady-state `default` account semantics.
- Codex target management is file-backed only in v1. `keyring` and `auto` fail loud.
- The current human-facing authority for the shared Codex pool is `agents@amirs-mac-studio`.

## Install

### Prereqs

- macOS
- Node.js `>= 20`
- Google Chrome installed
- `openclaw` on `PATH` if you are using the OpenClaw workflow
- a file-backed Codex home if AIM will manage your real `~/.codex`

### Global install from this checkout

For local iteration:

```bash
cd /Users/agents/workspace/agents/work/aimgr/repo/aimgr
npm install
npm link

which aim
aim --help
```

For a fixed snapshot instead of a live symlink:

```bash
cd /Users/agents/workspace/agents/work/aimgr/repo/aimgr
npm install -g .
```

For a login-shell-stable install that does not depend on the current NVM global bin path:

```bash
cd /Users/agents/workspace/agents/work/aimgr/repo/aimgr
npm install
npm run install:local

which aim
aim --help
```

This writes `aim` and `aimgr` wrappers into `~/.local/bin` (or `$XDG_BIN_HOME`), which is usually a better fit than `npm link` when Node is managed by `nvm`.

## Quickstart

### 1) Start with status

```bash
aim status
aim status --json | jq .
```

Status answers the core operator questions:

- which labels are `ready`, `reauth`, or `blocked`
- what OpenClaw currently has assigned
- how the last weighted rebalance spread agents across accounts
- what the local Codex target currently has selected
- what the local Pi target currently has selected
- what the next-best eligible account would be
- whether the pool needs more capacity

### 2) Maintain or reauth one label

```bash
aim boss
```

On a TTY, `aim <label>` is the human front door. It opens a guided label panel with numbered choices:

```text
$ aim boss

boss · openai-codex
Status: ready
ChatGPT login: valid
Browser: agent-browser / agent-boss

What do you want to do?
  1. Open browser
  2. Reauth / refresh login
  3. Change browser setup
  4. Show details
  0. Done
```

Use explicit `aim login <label>` only when you want the one-shot maintenance/admin lane:

```bash
aim login boss
```

The maintenance flow:

1. ensures the label has a provider
2. uses the label's configured login rail
3. refreshes if possible, otherwise runs OAuth
4. writes credentials into `~/.aimgr/secrets.json`
5. records account-maintenance facts for status and automation

Important behavior:

- Browser-managed labels use the label's explicit binding, not a guessed browser lane.
- `aim-profile` uses `~/.aimgr/browser/<label>/user-data`.
- `chrome-profile` uses the exact `--user-data-dir` you configured and, when present, the exact Chrome `profile-directory`.
- `agent-browser` uses the exact `--profile` and `--session` you configured.
- Manual-callback labels print the OAuth URL and prompt for the final callback URL.
- Reauth does **not** rebalance OpenClaw or mutate downstream assignments.

When you pick `Use another Chrome profile` from the guided panel, AIM now lists the discovered raw Chrome-style browser homes on this Mac, including OpenClaw browser homes and host Chrome profiles. It tells you the exact `user-data-dir` + `profile-directory` each choice would save, and lets you confirm before writing the binding.

### 2A) Inspect or repair the browser binding

Daily operators should memorize `aim status`, `aim <label>`, `aim rebalance openclaw`, `aim codex use`, and `aim pi use`.

When you need to inspect or repair the browser substrate explicitly, use the advanced/admin surface:

```bash
aim browser show <label>
aim browser set <label> --mode aim-profile [--seed-from-openclaw <profileId>]
aim browser set <label> --mode chrome-profile --user-data-dir <abs-path> [--profile-directory <name>]
aim browser set <label> --mode agent-browser --profile <abs-path> --session <name>
aim browser set <label> --mode manual-callback
```

Non-negotiables:

- AIM never guesses from a workspace-local `agent-browser.json`.
- AIM never uses the implicit `default` `agent-browser` session.
- There is no supported "generic Chrome somehow" mode.

### 3) Rebalance OpenClaw from the shared pool

Use this when you want AIM to choose assignments across the eligible Codex pool:

```bash
aim rebalance openclaw
```

This command:

- evaluates pooled label readiness plus live usage
- refreshes AIM’s per-agent demand ledger from OpenClaw session token counters
- spreads agents many-to-one across remaining account headroom instead of burning one label per agent
- keeps current assignments when they stay within weighted hysteresis
- writes the derived OpenClaw assignments
- records an explicit receipt with `allocationMode` plus `perAccountLoad`:
  - `applied`
  - `noop`
  - `applied_with_warnings`
  - `blocked`

When recent session history exists, rebalance is demand-weighted. When it does not, cold-start agents use an explicit equal-share baseline until AIM has real usage.

If you only want to recompile the current recorded assignments into OpenClaw without reselection:

```bash
aim sync openclaw
# alias
aim apply
```

### 4) Activate local Codex CLI from the shared pool

First sync the portable pool if needed:

```bash
aim sync codex --from agents@amirs-mac-studio
```

Then activate the next-best eligible label:

```bash
aim codex use
```

This command:

- validates the local Codex home is file-backed
- probes current pool usage
- selects the next-best eligible pooled label
- writes managed `auth.json`
- verifies readback
- records a selection receipt:
  - `activated`
  - `noop`
  - `activated_with_warnings`
  - `blocked`

The contract is "next Codex process", not hot-swapping an already-running long-lived process.

### 4A) Activate local Pi CLI from the shared pool

Pi uses the same pooled OpenAI/Codex account selector as local Codex CLI, but writes Pi's canonical auth store instead of `~/.codex/auth.json`.

By default AIM targets:

- Pi agent dir: `~/.pi/agent`
- Pi auth path: `~/.pi/agent/auth.json`

You can override the Pi target dir with `PI_CODING_AGENT_DIR`.

```bash
aim pi use
```

This command:

- probes current pooled usage
- selects the next-best eligible pooled label with the same weighted ranking and hysteresis rules as `aim codex use`
- writes Pi's canonical `auth.json`
- preserves unrelated non-OpenAI Pi providers already present in that file
- verifies readback
- records a selection receipt:
  - `activated`
  - `noop`
  - `activated_with_warnings`
  - `blocked`

The contract is "next Pi process", not mutating an already-running Pi session in place.

## Removed commands

These commands are intentionally removed and now hard-error with migration guidance:

```bash
aim pin <openclaw_agent_id> <label>
aim autopin openclaw --pool ...
aim codex use <label>
aim pi use <label>
```

Use:

- `aim <label>` for reauth
- `aim rebalance openclaw` for OpenClaw assignment selection
- `aim codex use` for local Codex selection
- `aim pi use` for local Pi selection

## Codex CLI requirements

AIM only manages file-backed Codex homes in v1.

By default AIM targets:

- AIM state: `~/.aimgr/secrets.json`
- Codex home: `~/.codex`

Check the effective store mode:

```bash
grep -n 'cli_auth_credentials_store' ~/.codex/config.toml
```

If that is set to `keyring` or `auto`, AIM will refuse to manage the home.

You can also point AIM at an alternate managed Codex home:

```bash
export CODEX_HOME="$HOME/.codex"
```

## Safe local smoke test

If you want to test without touching your real `~/.aimgr` or `~/.codex`:

```bash
cd /Users/agents/workspace/agents/work/aimgr/repo/aimgr

TMP_HOME="$(mktemp -d /tmp/aimgr-smoke.XXXXXX)"
export CODEX_HOME="$TMP_HOME/.codex"

node ./bin/aimgr.js sync codex --from agents@amirs-mac-studio --home "$TMP_HOME"
node ./bin/aimgr.js status --json --home "$TMP_HOME"
node ./bin/aimgr.js codex use --home "$TMP_HOME"
node ./bin/aimgr.js status --home "$TMP_HOME"
cat "$CODEX_HOME/auth.json"
```

What you want to see:

- `sync codex` succeeds and creates `$TMP_HOME/.aimgr/secrets.json`
- `status` shows imported labels and the authority source
- `codex use` succeeds or clearly reports `blocked`
- `$CODEX_HOME/auth.json` exists after a successful activation and contains the selected account id

## Real host workflow

### Authority host

On the host that owns the shared AIM pool:

```bash
aim status
aim boss
aim rebalance openclaw
aim status
```

### Consumer machine

On the machine that wants to consume the shared Codex pool:

```bash
aim sync codex --from agents@amirs-mac-studio
aim codex use
aim status
```

Then start a **new** Codex or `codex_local` process and verify it picks up the selected identity.

## Command reference

### `aim status`

Human-readable or JSON summary of:

- labels and operator states
- warnings
- OpenClaw assignments and last rebalance receipt
- weighted spread details (`allocationMode`, `perAccountLoad`)
- Codex authority source, active label, and last selection receipt
- next-best candidate and capacity projection

```bash
aim status
aim status --json
```

### `aim <label>` / `aim login <label>`

Primary human path plus explicit admin lane:

```bash
aim boss
aim login boss
```

Rules:

- `aim <label>` opens the guided label panel on a TTY
- non-TTY `aim <label>` behaves like explicit `aim login <label>`
- `aim login <label>` keeps the one-shot JSON-style maintenance contract for scripts/tests/admin use

### `aim rebalance openclaw`

Selects pooled Codex labels for configured OpenClaw agents and writes the derived assignment/auth/session state:

```bash
aim rebalance openclaw
```

The rebalance planner is intentionally different from Codex next-best label selection:

- it imports per-agent OpenClaw session token counters into AIM’s demand ledger
- it can assign multiple agents to the same account when remaining headroom supports that
- it only skips agents when projected weighted demand exceeds remaining eligible supply

### `aim sync openclaw` / `aim apply`

Recompiles already-recorded OpenClaw target state:

```bash
aim sync openclaw
aim apply
```

### `aim sync codex --from <authority>`

Imports or refreshes the portable Codex pool from an authority source:

```bash
aim sync codex --from agents@amirs-mac-studio
```

Supported locator forms:

- `agents@amirs-mac-studio`
- `ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json`
- `/absolute/path/to/secrets.json`

### `aim codex use`

Activates the next-best eligible pooled label for the local managed Codex home:

```bash
aim codex use
```

## State layout

Default durable AIM state lives at:

- `~/.aimgr/secrets.json`

Backups are created automatically on write:

- `~/.aimgr/secrets.json.bak.<timestamp>`

Current shape:

```jsonc
{
  "schemaVersion": "0.2",
  "accounts": {
    "boss": {
      "provider": "openai-codex",
      "expect": { "email": "boss@example.com" },
      "reauth": {
        "mode": "manual-callback",
        "lastVerifiedAt": "2026-03-21T03:21:00.000Z"
      },
      "pool": { "enabled": true }
    }
  },
  "credentials": {
    "openai-codex": {
      "boss": {
        "access": "...",
        "refresh": "...",
        "idToken": "...",
        "expiresAt": "2026-03-21T05:21:00.000Z",
        "accountId": "acct_123"
      }
    },
    "anthropic": {}
  },
  "imports": {
    "authority": {
      "codex": {
        "source": "agents@amirs-mac-studio",
        "importedAt": "2026-03-21T03:21:00.000Z",
        "labels": ["boss", "lessons"]
      }
    }
  },
  "pool": {
    "openaiCodex": {
      "history": []
    }
  },
  "targets": {
    "openclaw": {
      "assignments": {
        "agent_boss": "boss"
      },
      "exclusions": {},
      "lastApplyReceipt": {
        "status": "applied"
      }
    },
    "codexCli": {
      "activeLabel": "boss",
      "homeDir": "/Users/you/.codex",
      "expectedAccountId": "acct_123",
      "lastSelectionReceipt": {
        "status": "activated"
      }
    }
  }
}
```

Durable truth lives in:

- `accounts`
- `credentials`
- `imports.authority.codex`
- minimal pool history

Derived target state lives in:

- `targets.openclaw`
- `targets.codexCli`

## Troubleshooting

### `aim codex use` says to sync first

Bootstrap the local replica:

```bash
aim sync codex --from agents@amirs-mac-studio
```

### `aim codex use` returns `blocked`

There is no eligible pooled account right now.

Fix readiness or capacity first:

```bash
aim status
```

Then reauth a label with `aim <label>` or add more pool capacity.

### Codex home is rejected as `keyring` or `auto`

Use a file-backed Codex home instead, or test with a temp `CODEX_HOME`.

### SSH import fails

Verify the authority host is reachable and has AIM state:

```bash
ssh agents@amirs-mac-studio 'test -f ~/.aimgr/secrets.json && echo ok'
```

### Wrong account still appears active after switching

Start a new Codex process. AIM guarantees next-process behavior, not live hot-swap.

### `aim status --json` and secrets

Status output is redacted. The durable state file itself is not.

## Development

```bash
npm test
```

Current tests cover:

- secret redaction in `aim status --json`
- migration and import boundaries
- AIM-owned login state and manual-callback behavior
- OpenClaw auth/profile writes and rebalance helpers
- Codex activation and file-backed store enforcement
- model/session helper logic for OpenClaw
