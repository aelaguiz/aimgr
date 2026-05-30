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

The migration planner must preserve currently usable Codex and Claude credentials. A plan that would force mass re-login for usable accounts is a failed plan, not an acceptable cutover.

## Runtime Commands

Normal account maintenance:

```bash
aim <label>
aim login <label>
aim login <label> --manual-callback-stdio
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
aim claude run <label> [-- <claude args...>]
aim claude capture-native <label> [--source-home <dir>]
aim claude export-live --out <file> [--source-home <dir>]
aim claude import-native <label> --in <file>
aim pi use
```

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
