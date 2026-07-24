# aimgr

`aimgr` coordinates AI account credentials across the three-machine pool.

The shared source of truth is Redis on `agents` at Amir's Mac Studio over Tailscale. Local tool files are projections only:

- Redis URL for remote clients: `redis://amirs-mac-studio:6380`
- Redis URL on `agents@amirs-mac-studio` itself: `redis://127.0.0.1:6380`
- fallback Tailnet IP: `redis://100.96.80.106:6380`
- local config: `~/.aimgr/config.yaml`
- local-only adjunct state: `~/.aimgr/local-state.json`
- legacy `~/.aimgr/secrets.json`: migration input or backup artifact only

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

## Migration

Migration is the only path that reads old credential stores. It is read-only until the reviewed apply step.

For the hard cutover, this machine's current local Codex auth files and archived AIM snapshots are the bootstrap authority. Do not merge old Redis `session:*`, `label:*`, or `machine:*` rows back into the new store; those rows are backup-and-cleanup material only.

Collect the local bootstrap bundle on this machine:

```bash
aim redis migrate collect --out <bundle.json>
```

Plan and apply once from the reviewed bootstrap bundle directory:

```bash
aim redis migrate plan --from <bundle-dir> --out <plan.json>
aim redis migrate apply --plan <plan.json> --confirm-breaking-cutover
aim redis migrate cleanup-legacy --confirm-breaking-cutover
aim redis export --out <post-cutover-export.json>
```

The migration planner preserves currently usable Codex credentials. Generic Redis import may seed
Claude policy-only candidate records, but generic import and migration apply reject Claude credential
and identity material. A complete Claude credential enters Redis through contained
`aim login <label>`, or through the per-label leased `aim claude capture-native` and
`aim claude import-native` boundaries for legacy ingestion.

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
aim redis migrate collect --out <bundle.json>
aim redis migrate plan --from <bundle-dir> --out <plan.json>
aim redis migrate apply --plan <plan.json> --confirm-breaking-cutover
aim redis migrate cleanup-legacy --confirm-breaking-cutover
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
aim codex run --tend [-p <profile>] [--resume <session-id>] [-- <codex args...>]
aim hermes watch [--once] [--interval-seconds <sec>] [--rotate-below-5h-remaining-pct <pct>]
aim claude inventory [--json]
aim claude status [account...] [--fresh] [--json]
aim claude usage [account...] [--fresh] [--json]
aim claude list [--json]
aim claude resume <row-or-thread-id>
aim claude run <label> (opus|fable) [--resume]
aim claude run <label> [-- <claude args...>]
aim claude capture-native <label> [--source-home <dir>] [--source-config-dir <dir>]
aim claude export-live --out <file> [--source-home <dir>]
aim claude import-native <label> --in <file>
aim pi use
```

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

`aim codex run --tend` runs attached Codex sessions through an AIMGR-owned low-latency foreground
relay. It does not use tmux, a private Codex app-server, or Codex `--remote`. Tended runs require
Python 3 for the small repo-owned PTY helpers; set `AIMGR_PYTHON_BIN` if `python3` is not the desired
interpreter. `--no-attach` keeps the non-attached automation PTY helper path instead of the human
foreground relay.
`--tmux-session` is obsolete and fails loudly. Codex pass-through args after `--` must not include
`--remote` or `--remote-auth-token-env`.

Browser binding policy:

```bash
aim browser show <label>
aim browser set <label> --mode aim-profile [--seed-from-openclaw <profileId>]
aim browser set <label> --mode chrome-profile --user-data-dir <abs-path> [--profile-directory <name>]
aim browser set <label> --mode agent-browser --profile <abs-path> --session <name>
aim browser set <label> --mode manual-callback
```

## Removed Commands

These commands were removed as live coordination surfaces:

```bash
aim apply
aim sync openclaw
aim sync codex --from <authority>
aim sync claude --from <authority>
aim promote codex --to <authority> <label> [<label>...]
aim promote claude --to <authority> <label> [<label>...]
aim internal apply-codex-promotion
aim internal apply-claude-promotion
aim claude use [label]
```

Use Redis migration once, then use the Redis-backed runtime commands above. Refreshes, native Claude captures/imports/runs, Codex watch/tend rotations, and explicit repair commands publish to Redis directly.

## State Model

Redis records own shared credential truth:

- credentials: provider, label, credential, identity, shared browser/reauth/pool policy, health, and audit provenance
- meta: migration and cutover metadata

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
