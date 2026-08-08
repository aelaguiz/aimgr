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
# Explicit provider bindings; omitted providers remain unchanged
aim pi use --codex <auto|label|off> --claude <fable|opus|label|off>
aim pi status
aim pi uninstall [--provider <openai-codex|anthropic>]
aim prime use --codex <auto|label|off> --claude <fable|opus|label|off>
aim prime run codex [--codex <exact-label>]
aim prime run claude
aim prime resume <path-or-id> [--rotate]  # human interactive convenience only
aim prime status [--brief-json]
aim prime create --request-json -
aim prime create status --request-json -
aim prime identity install | aim prime identity status
aim prime uninstall [--provider <openai-codex|anthropic>]
```


### Pi and Prime managed credentials

`aim pi use` keeps its bare behavior: it selects the next-best pooled Codex
label, resolves it to one exact identity, and installs a non-secret external
descriptor for **new root sessions**. `aim prime use` uses the same descriptor
owner. Explicit `--codex` and `--claude` selections may name an exact label;
Codex also accepts `auto`, Claude accepts the existing `fable`/`opus` ranking,
and `off` performs the same guarded local removal as uninstall. An omitted
provider is unchanged.

AIM remains the only managed refresh-token authority. Pi and Prime invoke the
machine-only `aim credential-helper` directly with bounded JSON over stdin and
receive only an access token in memory. Target `auth.json`, AIM local receipts,
status, backups, argv, and environment never receive an AIM-managed access or
refresh token. The exact label and opaque AIM identity fingerprint are
non-secret and may be persisted by a harness to keep a root session tree
stable across resume and subagents. Account changes apply to a new root tree;
loaded trees never hop labels.

`aim prime status --brief-json` is the content-free account-projection view. It
separates the current validated descriptor's `configuredBinding` from the
persisted `lastSelectedBinding`, reports path and ownership conflicts, and omits
paths, fingerprints, provider record details, and helper material.

`aim prime create --request-json -` is the machine-safe account-aware root lane.
Its strict stdin request carries `schemaVersion`, a stable `operationId`, the
exact target agent directory, one managed provider and exact label or `auto`,
`preserveOtherProvider: true`, and a strict `prime` object containing socket,
cwd, optional name, and optional model. It never accepts a prompt. AIM journals
the projection change before writing, keeps the distinct target-selection lock
through Prime admission, releases the short `auth.json` lock before invoking
Prime, and returns a typed committed, rolled-back, partial-effect, or uncertain
receipt. Recover a lost response with `aim prime create status --request-json -`;
do not replay under a new operation ID.

For a disposable isolated literal run, use:

```bash
aim prime run codex --codex <exact-label> -- \
  --no-env --offline --daemon-socket <absolute> --session-dir <absolute>
```

This skips usage probing and accepts only that ordered Prime tail. It is a
human/test convenience, not the account-aware machine-create lane.

Plain and rotating `aim prime resume` remain human interactive conveniences,
not structured machine-control surfaces. They do not install extension code.
All Prime mutations fail with `path_conflict` before auth, extension, selection,
or launch effects when the persisted owner path differs from the resolved
`PRIME_AGENT_CODING_AGENT_DIR`.

Session identity is also separately authorized. `aim prime identity install`
installs or updates the managed extension, while `aim prime identity status` is
read-only. Account selection, run, resume, status, and create never install it
implicitly. The extension's below-editor banner shows title, AIM account, git
branch, and cwd; automatic names and colors remain stored in the session JSONL,
and a manual `/name` or `/rename` remains authoritative.

Unknown native provider entries are not replaced unless `--replace-native-auth`
is explicit. AIM then keeps at most one private displaced-native backup per
target/provider. `aim pi uninstall` and `aim prime uninstall` are local-only:
they restore that backup (or remove the descriptor) only when the current entry
exactly equals AIM's last installed descriptor. Stop active Pi/Prime workers
before uninstall. A conflicting edit is left untouched and the backup path is
reported.

`status` always reports local ownership even when Redis is unavailable. A
loaded harness may use an already cached, unexpired access token only until its
five-minute freshness skew; new bindings and refresh-due calls fail closed
until Redis returns. Managed providers never fall through to native stored
auth, environment keys, or another label. Reauthenticate the exact AIM label
for `reauth_required`; for `identity_conflict`, update the target and start a
new root tree.

This boundary prevents accidental persistent secret copies and competing
refresh writers; it is not isolation from another process running as the same
OS user, which can invoke the helper with the user's authority.

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
disposable per-label projection. Claude capture, import, login, and run share one per-label lease. A
strictly newer, same-identity local rotation is published back with Redis compare-and-swap during
managed runs and at exit. Stale or divergent local projections are overwritten from Redis and never
quarantine an account. Genuine reauthentication is shown as `NEEDS YOU` with `aim login <label>`.
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

- active target metadata
- OpenClaw assignments and exclusions
- Codex/Pi/Claude/Hermes local history
- local concrete browser bindings

Local target files are derived outputs:

- Codex: `~/.codex/auth.json`
- Claude: `~/.claude/.credentials.json` and `~/.claude.json`
- Pi: `~/.pi/agent/auth.json` (non-secret external descriptors for managed providers)
- Prime: `~/.prime/agent/auth.json` (non-secret external descriptors for managed providers)
- AIM rollback: `~/.aimgr/backups/harness-auth/` (one private displaced native entry per target/provider)
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
