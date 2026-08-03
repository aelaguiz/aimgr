# aimgr

`aimgr` coordinates AI account credentials across the three-machine pool.

The shared source of truth is Redis on `agents` at Amir's Mac Studio over Tailscale. Local tool files are projections only:

- Redis URL for remote clients: `redis://amirs-mac-studio:6380`
- Redis URL on `agents@amirs-mac-studio` itself: `redis://127.0.0.1:6380`
- fallback Tailnet IP: `redis://100.96.80.106:6380`
- local config: `~/.aimgr/config.yaml`
- local-only adjunct state: `~/.aimgr/local-state.json`
- legacy `~/.aimgr/secrets.json`: backup artifact only; runtime commands ignore it

The Redis cutover is intentionally breaking and non-reverse-compatible. Runtime credential coordination no longer has file ownership, SSH authority pulls, or promote-back flows.

## Setup

Configure each machine to point at the same Redis primary and key prefix:

Remote clients use the Tailscale hostname:

```bash
aim redis configure \
  --url redis://amirs-mac-studio:6380 \
  --key-prefix aimgr:v1: \
  --primary-host agents@amirs-mac-studio \
  --transport tailscale
```

The Redis host itself, `agents@amirs-mac-studio`, connects to its own container over localhost:

```bash
aim redis configure \
  --url redis://127.0.0.1:6380 \
  --key-prefix aimgr:v1: \
  --primary-host agents@amirs-mac-studio \
  --transport tailscale
```

Check the attachment:

```bash
aim redis config
aim redis ping
aim redis snapshot
```

## Redis snapshots

Use `aim redis export --out <snapshot.json>` for a reviewable backup. A reviewed snapshot can seed a
new Redis prefix with `aim redis import --in <snapshot.json>`. Generic import accepts Claude policy-only
candidate records, but rejects Claude credential and identity material. Complete Claude credentials
enter Redis through contained `aim login <label>`, or through the per-label leased
`aim claude capture-native` and `aim claude import-native` boundaries.

## Runtime Commands

Normal account maintenance:

```bash
aim <label>
aim login <label>
aim login <label> --manual-callback-stdio
```

Scheduled OAuth maintenance on the M3:

```bash
aim auth maintain
cd ~/workspace/aimgr
bash scripts/install-auth-maintainer.sh
bash scripts/install-auth-maintainer.sh --uninstall
```

Redis administration and repair:

```bash
aim redis configure --url <redis-url> [--key-prefix <prefix>] [--primary-host <host>] [--transport tailscale]
aim redis config
aim redis ping
aim redis snapshot
aim redis export --out <snapshot.json>
aim redis import --in <snapshot.json>
aim label rebind <label> --provider <provider> --confirm
```

Status:

```bash
aim status
aim status --json
aim status --compact
```

Target projections:

```bash
aim rebalance openclaw
aim rebalance hermes
aim auth write hermes <label> --auth-file <abs-path>
aim codex use [label]
aim codex watch [--once] [--interval-seconds <sec>] [--rotate-below-5h-remaining-pct <pct>]
aim hermes watch [--once] [--interval-seconds <sec>] [--rotate-below-5h-remaining-pct <pct>]
aim claude inventory [--json]
aim claude status [account...] [--fresh] [--verbose] [--json]
aim claude usage [account...] [--fresh] [--verbose] [--json]
aim claude list [count] [--json]
aim claude resume <row-or-thread-id-or-name> [--account <label>] [--switch-account fable|opus]
aim claude run (opus|fable) [--resume]
aim claude run <label> (opus|fable) [--resume]
aim claude run <label> [-- <claude args...>]
aim claude capture-native <label> [--source-home <dir>] [--source-config-dir <dir>]
aim claude export-live --out <file> [--source-home <dir>]
aim claude import-native <label> --in <file>
aim pi use
```

The label-free Claude presets select only unlocked readable accounts. `fable`
ranks by Fable/Sonnet usage and uses five-hour usage as its tie-break;
`opus` ranks by the shared five-hour usage.

Claude resume uses the session's recorded account by default. Add
`--account <label>` to fork onto an exact account; combine it with
`--switch-account fable|opus` to override the resumed model preset. Session
names are exact, case-insensitive matches and must be quoted when they contain
spaces; ambiguous names require a row number or thread ID.

`aim claude inventory` is the instant account-coverage view for Redis-backed Claude labels. It reads
the configured AIM Redis credential records once and makes zero Anthropic, BrowserOS, Keychain,
native-file, or Claude CLI calls. Candidate-only policy records remain visible as non-ready rows;
complete, expired, incomplete, blocked, and identity-conflicting records remain distinguishable.
Local Claude directories and browser profiles are projections or enrollment surfaces, never account
names or inventory authority.

`aim claude status` and its exact `aim claude usage` alias accept only canonical Anthropic labels in
the shared Redis store. Invalid labels fail before external I/O. Unknown labels fail after the one
Redis read and before any provider request. Candidate-only, incomplete, or expired credentials are
reported locally and never sent to Anthropic.

The usage commands are browserless and cookie-free: they do not inspect browser state, invoke a
model, rotate credentials, or fall back to `claude.ai`. A normal run reuses the strictly allowlisted
provider-usage section in AIM's existing `~/.aimgr/redis-cache.json`. An uncached run makes exactly
one no-retry OAuth usage `GET` per selected ready account, with at most three requests in flight;
`--fresh` bypasses a fresh success entry while preserving the one-request-per-account limit.
Transient failures are briefly backed off, and usage observed within the prior hour may be shown
only when clearly marked stale. The cache is written atomically with owner-only (`0600`) permissions.

Human output uses an `account` column, and JSON uses `accounts[].label` plus `missingAccounts`.
Neither schema nor the provider-usage cache contains tokens, authorization headers, raw Redis
credentials, email addresses, account or organization UUIDs, identity/policy objects, native paths,
Keychain identifiers, browser-profile names, raw provider errors, or full provider responses.
Only canonical labels, closed plan metadata, credential/auth states, rate-limit percentages and
resets, bounded timestamps, cache age, and fixed error classifications are exposed.

Claude access-token expiry is not the same thing as subscription inactivity. `credential_expired`
means the stored access credential needs maintenance; `stale_auth` means Anthropic rejected it.
Neither state by itself proves that billing was cancelled. Initial login or genuine reauthentication
may use the approved BrowserOS/native protocol, but a complete identity-checked native bundle must
then be captured into Redis. After capture, Redis is the authority and each managed Claude home is a
derived per-label projection whose newer token rotations are published back with Redis CAS. Claude
capture, import, and run share one per-label lease. Managed runs retain a durable uncertainty fence
until the exact supervised Claude child exits cleanly without rotation or a genuinely new
access/refresh token pair is published as that fence's explicit successor.
Fence and retry liveness are bounded. A rotation fence can quarantine an account for at most 24h;
past that bound any machine may clear it and recover the account from the Redis bundle. A
per-account maintenance failure that persists unchanged past 2h is published as `reauth_required`,
so status renders `NEEDS YOU` with `aim login <label>` instead of retrying forever. `AIM FIXING`
is therefore always a temporary state.
Each normal managed launch also inherits the machine's complete user-level
Claude MCP definitions, personal skills, enabled user plugins, and user hooks
at launch time. AIM passes field-only MCP/hook overlays through Claude's native
options; credentials, sessions, project trust, and unrelated user settings
remain label-isolated.

Sakana Fugu / Fugu Ultra are API-key accounts (no OAuth). Configure one account name plus its API
key per Sakana subscription. Keys are stored only in the shared Redis credential store; status/list
output shows a redacted fingerprint, never the raw key:

```bash
aim sakana add <account-name> [--key <api-key>] [--tier standard|pro|max|payg] [--subscription <name>] [--notes <text>]
aim sakana use <account-name>
aim sakana list [--json]
aim sakana show <account-name>
aim sakana remove <account-name>
```

Provide the key with `--key`, by piping it on stdin (`echo "$KEY" | aim sakana add pro1`), or
interactively when prompted. The raw key is never echoed back and never written to `local-state.json`.
`aim sakana use <account-name>` preserves unrelated `~/.codex/.env` lines, updates only
`SAKANA_API_KEY`, writes the file as `0600`, and records only a redacted local receipt.

Browser binding policy:

```bash
aim browser show <label>
aim browser set <label> --mode aim-profile [--seed-from-openclaw <profileId>]
aim browser set <label> --mode chrome-profile --user-data-dir <abs-path> [--profile-directory <name>]
aim browser set <label> --mode agent-browser --profile <abs-path> --session <name>
aim browser set <label> --mode manual-callback
```

## State Model

Redis records own shared credential truth:

- credentials: provider, label, credential, identity, shared browser/reauth/pool policy, health, and audit provenance
- meta: Redis coordination schema metadata

`~/.aimgr/local-state.json` owns local-only facts:

- target projection receipts
- active target metadata
- OpenClaw assignments and exclusions
- Codex/Pi/Claude/Hermes local history
- local concrete browser bindings

Local target auth files are derived outputs:

- Codex: `~/.codex/auth.json`
- Claude: `~/.claude/.credentials.json` and `~/.claude.json`
- Pi: `~/.pi/agent/auth.json`
- Hermes: explicit `auth.json` paths
- OpenClaw: configured agent auth stores and session metadata

## Development

Run syntax checks:

```bash
npm run lint
```

Run tests:

```bash
npm test
```

Run coverage:

```bash
npm run test:coverage
```

In this Codex shell, prefer:

```bash
env -u CODEX_HOME npm test
```

because an inherited `CODEX_HOME` can point tests at the real Codex home instead of a temp home.
