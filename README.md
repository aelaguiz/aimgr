# aimgr

`aimgr` (CLI: `aim`) is a small, opinionated AI account manager for people running multiple paid AI accounts and wiring them into downstream tools without guessing which account is active.

The operating model is simple:

- AIM stores the durable labeled account truth in `~/.aimgr/secrets.json`.
- OpenClaw and Codex CLI are derived targets, not competing sources of truth.
- Operators work in labels like `boss`, `lessons`, `qa`, not raw tokens or browser profiles.

Right now there are two real workflows:

- Authority-host workflow: manage shared labeled accounts and compile them into OpenClaw.
- Consumer-laptop workflow: pull the portable Codex pool from the authority host and switch local Codex CLI by label.

## Non-negotiables

- AIM is the SSOT. OpenClaw/Codex auth files are derived outputs.
- Secrets are plaintext on disk on purpose. No keychain or secret manager abstraction in AIM.
- Labels are explicit. No steady-state `default` profile semantics.
- Provider behavior is grounded in real upstream contracts, not inferred.
- Codex CLI target management is file-backed only in v1. Keyring/`auto` homes fail loud.
- The current human-facing authority for the shared Codex pool is `agents@amirs-mac-studio`.

## Install

### Prereqs

- macOS
- Node.js `>= 20`
- Google Chrome installed
- `openclaw` installed and on your `PATH` if you are using the authority/OpenClaw workflow
- A file-backed Codex home if you want AIM to manage your real `~/.codex`

### Global install from this checkout

For normal local use while iterating on this repo, use `npm link`:

```bash
cd /Users/aelaguiz/workspace/aimgr
npm install
npm link

which aim
aim --help
```

That gives you both `aim` and `aimgr` globally from this working tree.

If you want a fixed installed snapshot instead of a live symlink:

```bash
cd /Users/aelaguiz/workspace/aimgr
npm install -g .
```

## Quickstart

### Authority host: manage labeled accounts for OpenClaw

Use this on the machine that owns the shared AIM state and OpenClaw/browser profiles.

Login or refresh a label:

```bash
aim boss
```

That flow:

1. Ensures the label has a provider.
2. Ensures the label is mapped to the right OpenClaw browser profile.
3. Runs refresh if possible, otherwise browser OAuth.
4. Stores credentials in `~/.aimgr/secrets.json`.
5. Auto-pins `agent_<label>` when present.
6. Syncs derived OpenClaw state.

Explicit OpenClaw operations still work as before:

```bash
aim pin agent_lessons boss
aim autopin openclaw --pool boss,lessons,qa,illustrator
aim sync openclaw
aim apply
```

### Consumer laptop: switch local Codex CLI by label

Use this on your laptop when you want local Codex CLI to consume the shared labeled Codex pool from the authority host.

The normal operator loop is:

```bash
aim sync codex --from agents@amirs-mac-studio
aim codex use boss
aim status
```

What that means:

- `aim sync codex --from agents@amirs-mac-studio` pulls the portable `openai-codex` labels and credentials from the authority host into local AIM state.
- `aim codex use <label>` writes the managed local Codex `auth.json` for that label.
- `aim status` shows the authority source, import freshness, active local Codex label, and warnings.

Important behavior:

- First-time bootstrap is explicit. If your laptop has no `~/.aimgr/secrets.json`, the first `aim sync codex --from agents@amirs-mac-studio` creates it.
- Label switching does not run browser login on the laptop.
- The contract is “next Codex process,” not hot-swapping an already-running long-lived Codex process.
- If no imported replica exists yet, `aim codex use <label>` fails loud and tells you to sync first.

## Codex CLI requirements

AIM only manages file-backed Codex homes in v1.

By default AIM targets:

- AIM state: `~/.aimgr/secrets.json`
- Codex home: `~/.codex`

Check your Codex store mode:

```bash
grep -n 'cli_auth_credentials_store' ~/.codex/config.toml
```

If that is set to `keyring` or `auto`, AIM will refuse to manage the home. For the real global flow, the store should be `file` or absent.

You can also point AIM at an alternate managed Codex home with `CODEX_HOME`:

```bash
export CODEX_HOME="$HOME/.codex"
```

## Safe local smoke test

If you want to test the laptop flow without touching your real `~/.aimgr` or `~/.codex`, use a temp home:

```bash
cd /Users/aelaguiz/workspace/aimgr

TMP_HOME="$(mktemp -d /tmp/aimgr-smoke.XXXXXX)"
export CODEX_HOME="$TMP_HOME/.codex"

node ./bin/aimgr.js sync codex --from agents@amirs-mac-studio --home "$TMP_HOME"
node ./bin/aimgr.js status --json --home "$TMP_HOME"
node ./bin/aimgr.js codex use boss --home "$TMP_HOME"
node ./bin/aimgr.js status --home "$TMP_HOME"
cat "$CODEX_HOME/auth.json"
```

What you want to see:

- `sync codex` succeeds and creates `$TMP_HOME/.aimgr/secrets.json`
- `status` shows imported labels and the authority source
- `codex use boss` succeeds
- `$CODEX_HOME/auth.json` exists and contains the selected account id

## Real laptop smoke test

Once the isolated test looks right, test the real flow:

```bash
ssh agents@amirs-mac-studio 'test -f ~/.aimgr/secrets.json && echo ok'

aim sync codex --from agents@amirs-mac-studio
aim status
aim codex use boss
aim status
```

Then start a fresh `codex` process and run one auth-dependent command you trust. Switch labels and repeat:

```bash
aim codex use lessons
aim status
```

Confirm:

- no browser login happens on the laptop
- a fresh Codex process picks up the selected label
- switching labels changes the next-process identity deterministically

## Command reference

### `aim status`

Human-readable summary of:

- known labels
- warnings
- OpenClaw pins
- Codex authority source/import freshness
- active local Codex label/home/store mode

```bash
aim status
aim status --json
```

### `aim <label>` / `aim login <label>`

Authority-host login/refresh flow for a label:

```bash
aim boss
aim login boss
```

This is the command that manages browser OAuth state and OpenClaw derived state.

For `openai-codex` labels, AIM now supports two interactive login modes:

- `OpenClaw browser profile`
- `External browser / paste callback URL`

The external-browser lane is for extra ChatGPT Pro / OpenAI Pro accounts that are not browser-managed on the host. The first time you add one of those labels:

```bash
aim <label>
```

Then:

1. choose `openai-codex`
2. choose `External browser / paste callback URL`
3. click or open the printed OAuth URL on your laptop browser
4. finish login there
5. copy the final `http://localhost:1455/auth/callback?...` URL from the browser address bar
6. paste that full callback URL back into AIM on the host

After that, AIM stores normal durable credentials for the label in `~/.aimgr/secrets.json`, and later refreshes/re-auth for that label reuse the same manual-callback lane automatically.

### `aim pin <openclaw_agent_id> <label>`

Manual OpenClaw pin override:

```bash
aim pin agent_daily_wins_reporter boss
```

### `aim autopin openclaw [--pool ...]`

Evenly distributes currently unpinned OpenClaw agents across a pool of labels:

```bash
aim autopin openclaw --pool boss,lessons,qa,illustrator
```

### `aim sync openclaw` / `aim apply`

Explicitly rewrites derived OpenClaw state from AIM:

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

For the normal human-facing workflow, prefer `agents@amirs-mac-studio`.

### `aim codex use <label>`

Activates one imported label for local Codex CLI:

```bash
aim codex use boss
```

This writes managed `auth.json` into the current Codex home, verifies readback, and updates local AIM target metadata.

## State layout

Default durable AIM state lives at:

- `~/.aimgr/secrets.json`

Backups are created automatically on write:

- `~/.aimgr/secrets.json.bak.<timestamp>`

Current state shape:

```jsonc
{
  "schemaVersion": "0.2",
  "accounts": {
    "boss": {
      "provider": "openai-codex",
      "expect": { "email": "boss@example.com" }
    }
  },
  "credentials": {
    "openai-codex": {
      "boss": {
        "access": "...",
        "refresh": "...",
        "idToken": "...",
        "expiresAt": "2026-03-13T03:21:00.000Z",
        "accountId": "acct_123"
      }
    },
    "anthropic": {}
  },
  "imports": {
    "authority": {
      "codex": {
        "source": "agents@amirs-mac-studio",
        "importedAt": "2026-03-08T03:21:00.000Z",
        "labels": ["boss", "lessons"]
      }
    }
  },
  "targets": {
    "openclaw": {
      "pins": {
        "agent_boss": "boss"
      },
      "browserProfiles": {
        "boss": "agent-boss"
      }
    },
    "interactiveOAuth": {
      "bindings": {
        "boss": {
          "mode": "openclaw-browser-profile",
          "profileId": "agent-boss"
        },
        "<label>": {
          "mode": "manual-callback"
        }
      }
    },
    "codexCli": {
      "activeLabel": "boss",
      "homeDir": "/Users/you/.codex",
      "storeMode": "file",
      "expectedAccountId": "acct_123",
      "lastAppliedAt": "2026-03-08T03:25:00.000Z"
    }
  }
}
```

Portable truth is in `accounts` and `credentials`. Machine-local downstream metadata lives under `targets.*`.

`targets.interactiveOAuth.bindings` stores how a label completes interactive OAuth on the current machine:

- `openclaw-browser-profile` means AIM should use the bound OpenClaw browser profile
- `manual-callback` means AIM should print the OAuth URL and prompt you to paste back the final callback URL

## OpenClaw integration

OpenClaw remains the existing authority-host downstream target.

AIM still:

- uses OpenClaw-managed Chrome profiles under `~/.openclaw/browser/*/user-data`
- writes labeled auth profiles into OpenClaw `auth-profiles.json`
- enforces pinned-agent model defaults
- cleans stale session/runtime model overrides during sync

The OpenClaw-specific metadata now lives under `targets.openclaw`, but the operator commands and sync behavior are intentionally preserved.

## Troubleshooting

### `aim codex use <label>` says to sync first

Bootstrap the local replica:

```bash
aim sync codex --from agents@amirs-mac-studio
```

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
npm run lint
npm test
```

Current tests cover:

- secret redaction in `aim status --json`
- OpenClaw auth profile writes
- Codex authority import/bootstrap
- Codex activation and file-backed store enforcement
- model/session helper logic for OpenClaw
