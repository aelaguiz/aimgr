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
aim codex watch [--once] [--interval-seconds <sec>] [--rotate-below-weekly-remaining-pct <pct>]
aim hermes watch [--once] [--interval-seconds <sec>] [--rotate-below-weekly-remaining-pct <pct>]
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
aim prime use --codex <auto|label|off> --claude <fable|opus|label|off> --grok <auto|label|off>
aim prime run codex
aim prime run claude
aim prime run grok
aim prime resume <path-or-id> [--rotate]
aim prime status
aim prime uninstall [--provider <openai-codex|anthropic|xai>]
```

`aim codex use` rotates away from the current Codex account on every successful
call. It prefers labels that have not been selected recently, then uses the
current weekly usage as the tie-breaker, so repeated launches walk the
eligible pool instead of bunching on one low-usage account.
If no eligible alternative exists, it fails with `no_alternate_pool_account` and
preserves the current account. `aim codex use <label>` selects that exact label,
including when it is already active.

For the normal interactive path, use `aim codex run`, which rotates and then
launches `codex -p yolo` as one command. `aim codex run -- <codex args...>` passes
explicit arguments through, and `aim codex run resume [<session-id>]` or
`aim codex resume [<session-id>]` rotates before resuming a session.

To launch on an explicitly chosen account, use `aim codex run <label> -- <codex args...>`.
It selects that exact label, including when it is already active, without automatic
pool selection. Arguments after `--` pass through unchanged; omit them to launch
`codex -p yolo`. For example, after selecting and checking `writer`:

```zsh
aim codex use writer
aim status --compact
aim codex run writer -- exec --model gpt-6-astra -c 'model_reasoning_effort="xhigh"' --json 'Your prompt'
```

For a resume on that label, pass the native resume arguments after `--`, for
example `aim codex run writer -- -p yolo resume <session-id>`; `resume` before
`--` remains the rotating resume shorthand. Install the same rotating shell
shortcuts on macOS or Linux with `bash scripts/install-codex-shortcuts.sh`
(also run by `scripts/install-local-bin.sh`):

```zsh
c() { command aim codex run "$@"; }
cr() { command aim codex resume "$@"; }
```

The installer loads these definitions at the end of `.zshrc`, overriding older
dotfile definitions that called Codex directly. New terminals pick them up
automatically; in an existing terminal, run
`source "$HOME/.config/aimgr/codex-shortcuts.zsh"`. Interactive launches print
the selected AIM account and previous label before opening Codex. Both `cr`
and `cr <session-id>` rotate, and neither launches if no eligible alternate exists.

`aim prime run codex|claude|grok` selects the account and model, then starts a new
Prime session directly. Use `aim prime resume <path-or-id>` when you want an
existing session instead.

### Scheduled Prime, Codex, and Claude jobs

Add jobs under `routines` in `~/.aimgr/config.yaml`. Set `agent: codex` to run
the native Codex CLI, or `agent: claude` for native Claude Code. Definitions without `agent` keep using Prime, including
existing Prime jobs with `provider: openai-codex`.

```yaml
routines:
  codex-morning-review:
    agent: codex
    calendar:
      - hour: 8
        minute: 0
        weekday: 1
    cwd: /Users/you/workspace/project
    promptFile: /Users/you/.aimgr/routines/prompts/morning-review.md
    herdrSession: work
    spaceTitleFormat: "Codex morning review · {scheduled_local}"
    model: gpt-6-astra
    thinking: xhigh
    profile: yolo
```

The example runs every Monday at 08:00 in the machine's local timezone. Omit
`weekday` for every day, or add calendar entries for more times; weekdays are
0 (Sunday) through 6 (Saturday). Both paths must be absolute and the named
Herdr session must already be running with a focused workspace. The new job's
workspace opens without taking focus.

For Codex, `provider` defaults to `openai-codex`, `model` to `gpt-6-astra`,
`thinking` to `xhigh`, and `profile` to `yolo`. The profile must exist in the
Codex configuration and supplies permissions and other settings; use a custom
profile for jobs that need different permissions. The routine explicitly sets
the model/reasoning and uses AIM-selected ChatGPT account authentication.
Prime retains its existing required provider/model/thinking fields.

For Claude, use the same schedule fields with `agent: claude`:

```yaml
routines:
  claude-morning-review:
    agent: claude
    calendar:
      - hour: 8
        minute: 0
    cwd: /Users/you/workspace/project
    promptFile: /Users/you/.aimgr/routines/prompts/morning-review.md
    herdrSession: work
    spaceTitleFormat: "Claude morning review · {scheduled_local}"
    model: claude-fable-5-1
    thinking: xhigh
```

Claude defaults to `provider: anthropic`, `model: claude-fable-5-1`, and
`thinking: xhigh`. Thinking maps to Claude's `--effort` and accepts `low`,
`medium`, `high`, `xhigh`, or `max`; the chosen model must support that effort.
`profile` is Codex-only. Claude jobs run with `--dangerously-skip-permissions`
for unattended execution, as the native AIM Claude presets do.

From this checkout, prepare and install a schedule with:

```sh
node scripts/install-routines.mjs --prepare codex-morning-review
node scripts/install-routines.mjs codex-morning-review --desktop-off-confirmed
```

Replace `codex-morning-review` with `claude-morning-review` for the Claude example.

Use `--desktop-off-confirmed` only after confirming no Desktop automation also
runs this job. Installing does not run the job immediately. To test one occurrence
now, run `aim routine run codex-morning-review --manual --json`. Remove its
schedule with `node scripts/install-routines.mjs --uninstall codex-morning-review`.

Each Codex occurrence selects an account through `aim codex use`, runs the prompt
file through `codex exec --json`, and opens `codex resume <exact-session-id>` in
the same Herdr pane after the initial task finishes. The prompt is submitted only
once. Codex sessions remain available for interactive follow-up while subsequent
scheduled occurrences can start. Jobs inherit `aim codex use`'s requirement for
an eligible alternate account. A blocked selection fails before the prompt runs.

Each Claude occurrence selects the least-used unlocked eligible account through
the native AIM Claude account path and opens the normal interactive Claude UI
immediately, with the scheduled prompt supplied once at launch. Progress, tool
calls, errors, and the input box are visible while the task runs. You can interrupt
or give further instructions without waiting for completion. The same process
stays open for follow-up; there is no print-mode run or resume handoff.

Account isolation, credential leases, native identity preflight, user
skills/hooks/plugins, and token rotation use the same managed launcher as
`aim claude run`. The account lease stays held for the interactive session;
later occurrences choose an unlocked account. Redis must be reachable for
selection. No eligible account fails before prompt submission. The configured
project's existing trust decision in your normal Claude config carries over to
the selected account, so MCP header helpers retain that permission. AIM also
honors your existing `skipDangerousModePermissionPrompt` preference. Any remaining
first-use Claude dialogs appear directly in the interactive UI.

Claude lifecycle logs use `<fire-key>.claude.jsonl`; the full conversation stays
in Claude's native transcript. Receipts record the account, exact session ID,
model, transcript path, prompt hash, turn status, and interactive exit. Native
`UserPromptSubmit` and `Stop`/`StopFailure` hooks observe the scheduled turn.
Later messages and background notifications do not invalidate the prompt.
Completion or a native API failure releases the job's overlap lock while the
interactive session stays available. Observation errors and the two-hour
observation deadline flag attention without terminating Claude; an unsettled
job keeps its overlap lock until it settles or its UI exits. Credential-lease
loss still stops the process through the managed launcher's existing protection.
Failed occurrences are never automatically replayed. Hook details follow the
[official Claude hooks reference](https://code.claude.com/docs/en/hooks).

Receipts live in `~/.aimgr/routine-runs/<fire-key>.json`; Codex event logs sit
beside them as `<fire-key>.codex.jsonl`. Receipts include the chosen account,
session ID, prompt hash, usage, completion status, and interactive resume exit.
Codex prompt admission is recorded from `turn.started`; completion requires
`turn.completed` plus a successful process exit. Failures after admission need
attention and are never automatically replayed. Execution times out after two
hours and stops the job's process group. A failed interactive resume preserves
the completed task's result and records that the follow-up UI needs attention.

All three agents share duplicate prevention, per-job overlap protection, and the
ten-minute admission window after a scheduled time. `--manual` creates a unique
occurrence but still respects overlap protection. Scheduling uses macOS launchd.
Codex's event protocol follows the [official non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).


### Pi and Prime managed credentials

`aim pi use` keeps its bare behavior: it selects the next-best pooled Codex
label, resolves it to one exact identity, and installs a non-secret external
descriptor for **new root sessions**. `aim prime use` uses the same descriptor
owner. Explicit `--codex`, `--claude`, and Prime-only `--grok` selections may
name an exact label; Codex and Grok also accept `auto`, Claude accepts the
existing `fable`/`opus` ranking, and `off` performs the same guarded local
removal as uninstall. An omitted provider is unchanged.

AIM remains the only managed refresh-token authority. Pi and Prime invoke the
machine-only `aim credential-helper` directly with bounded JSON over stdin and
receive only an access token in memory. Target `auth.json`, AIM local state,
status, backups, argv, and environment never receive an AIM-managed access or
refresh token. The exact label and opaque AIM identity fingerprint are
non-secret and may be persisted by a harness to keep a root session tree
stable across resume and subagents. Ordinary target changes apply to a new root
tree; a loaded Prime root changes labels only through an explicit successful
`aim prime resume <session> --rotate` handoff.

Plain `aim prime resume <path-or-id>` delegates to Prime's ordinary pinned resume
path without changing AIM account state. Add `--rotate` after the active
account is rate limited: AIM reads the session's provider, model, exact binding,
and identity fingerprint; selects the next-best eligible *different* label for
that provider; and asks Prime to compare-and-swap the binding inside that exact
already-live root. AIM writes no target auth or selection history. After Prime
confirms the handoff, AIM attaches the same root through ordinary resume. An
inactive or busy root, stale expected binding, failed handoff, or lack of an
eligible alternate exits without attaching or mutating the saved session. This
manual same-provider handoff supports managed Codex, Claude, and Grok roots.
Automatic credential `advance` remains Codex-only; Claude and Grok never switch
accounts without this explicit operator command.

AIM-managed Pi and Prime homes also receive one global session-identity
extension. Its below-editor banner always shows title, AIM account, git branch,
and cwd. Prime sessions show the full canonical session UUID on a dedicated
second row, so the exact `aim prime resume <session-id>` selector remains visible
even if daemon commands stop working. Unnamed sessions derive a compact title
from the first request; Prime may improve that fallback once from its existing
persisted agent recap. Each new session chooses a colored title pill and stores
that color in the session JSONL, so reloads, exact resumes, and continuity forks
retain the same visual identity. A manual `/name` or `/rename` remains
authoritative.

An explicit AIM provider selection replaces that provider entry immediately. If
it displaces native auth, AIM keeps one private backup at a deterministic path
so turning the provider off can restore direct native use. The backup is passive:
there is no ownership receipt, exact-descriptor guard, or pending-transition
state. `aim pi uninstall` and `aim prime uninstall` restore the backup when the
live entry is AIM-managed; an already-native or foreign live entry is left
untouched and never blocks the command.

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

The label-free Claude presets select only unlocked readable accounts. Both
`fable` and `opus` rank eligible accounts only by shared five-hour usage;
provider-blocked or exhausted accounts remain ineligible.

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

## MCP server

`aim mcp serve` exposes this machine's `aim` CLI to MCP clients (Claude Code, Codex, Prime Agent,
a phone) so a remote agent can read pool state and take account actions without an ssh session.

```bash
aim mcp serve                          # Streamable HTTP on this machine's Tailscale IPv4, port 7337
aim mcp serve --port 7337 --bind <ip>  # explicit listener
aim mcp serve --stdio                  # one client over stdin/stdout instead of HTTP
bash scripts/install-mcp-server.sh     # LaunchAgent: RunAtLoad + KeepAlive, logs to ~/.aimgr/logs/mcp-serve.*.log
bash scripts/install-mcp-server.sh --status
bash scripts/install-mcp-server.sh --uninstall
```

The endpoint is `http://<tailscale-ip>:7337/mcp`. Three tools:

- `aim_exec` — run any non-interactive `aim` command, e.g. `["status","--json"]`,
  `["claude","status","--json"]`, `["codex","use"]`, `["auth","maintain"]`. Interactive lanes
  (`login`, `credential-helper`, `claude`/`prime` `run|resume`, `codex`/`hermes` `watch` without
  `--once`) are rejected with the reason. Run `["help"]` for the full command surface.
- `aim_machine_info` — hostname, Tailscale IPv4, aimgr git rev, disk free, `aim redis ping` duration,
  watcher log mtime and age, newest routine receipt per routine. Facts only, no health verdict.
- `aim_log_tail` — tail `auth-maintainer`, `codex-watch`, `hermes-watch`, `mcp-serve`, or an absolute path.

**The MCP server is unauthenticated — the tailnet is the trust boundary.** Anyone who can reach the
port gets the same authority ssh to this machine already grants, including `aim redis export`. Bind
it to the Tailscale address, never to a public interface. Without `--bind` the server waits for this
machine's Tailscale IPv4 (retrying every 5s, one log line per 30s) and binds only when it appears, so
a LaunchAgent that starts before tailscaled converges on the tailnet address instead of exposing every
interface. An explicit `--bind`, including `--bind 0.0.0.0`, skips the wait and is the operator's call.

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
