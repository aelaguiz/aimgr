# aimgr

`aimgr` coordinates AI account credentials across the host fleet.

The shared source of truth is Redis Cloud Essentials. Every configured host, including the Mac Studio, connects directly over TLS and password authentication. Fly workloads use the same public TLS endpoint.

- Endpoint and credentials: read from the private connection config on an attached host
- Replication, persistence, and remote backups: off
- Local private connection config: `~/.aimgr/config.yaml` (mode `600`)
- Local-only adjunct state: `~/.aimgr/local-state.json`
- Legacy `~/.aimgr/secrets.json`: old artifact only; runtime commands ignore it

Redis holds shared account metadata and credentials for the legacy harnesses.
Managed Claude and Codex keep their primary login and refresh tokens in the
environment where each account signed in; those tokens are not Redis projections.
There is no Redis VM or container to maintain.

## Setup

Before installing or updating the Claude launcher, follow
[Installing a reviewed Claude runtime](#installing-a-reviewed-claude-runtime-without-interrupting-coding).

For a new Claude release, invoke **`$agent-upgrade-test`**: “Sandbox-test Claude
version X before we approve it.” The [skill](skills/agent-upgrade-test/SKILL.md)
teaches the agent to investigate how information reaches Anthropic, pursue
unexpected behavior and distinguish new exposure from accepted risks. Existing
offsite tests preserve known privacy and workflow guarantees; they do not limit
the investigation. The skill retains the complete tested bundle and obtains a
cold code review of both the implementation and the explanation of its protection.
It currently supports Claude only; testing and review do not grant normal-use
approval. Its [plan and accepted-risk audit](docs/aelaguiz/AGENT_UPGRADE_TEST_SKILL_PLAN_2026-11-02.md)
record the scope and validation.

Install the `skills/agent-upgrade-test` directory into the established local skill
store (`~/.agents/skills/agent-upgrade-test`) and expose it to the desired runtime's
skill directory. Keep `skill-authoring` (including its shared orchestration policy)
and `model-routing` installed alongside the existing skill collection. The package
locates a separate aimgr checkout and does not depend on its own installed path
being inside this repository. It does not install or launch Claude.

Configure every machine with the same authenticated TLS URL and key prefix. Obtain the password from the Redis Cloud console or copy the private Redis configuration from an already attached host. Replace the example hostname, port and password below with the private connection details; never commit the real URL.

```bash
aim redis configure \
  --url 'rediss://default:<password>@redis.example.com:6379' \
  --key-prefix aimgr:v1: \
  --primary-host redis.example.com \
  --transport tls
```

Normal certificate verification works with the system trust store; no custom CA or client certificate is required. The Mac Studio uses this same configuration. The temporary relay for sessions started before the October 20 migration removes itself after those connections finish. See the [migration record](docs/REDIS_CLOUD_MIGRATION_2026-10-20.md) for its status path. The current deployment targets are listed in the [fleet inventory](docs/FLEET.md).

Check the attachment:

```bash
aim redis config
aim redis ping
aim redis snapshot
```

## Redis snapshots

Use `aim redis export --out <snapshot.json>` for a reviewable backup. A reviewed snapshot can seed a
new Redis prefix with `aim redis import --in <snapshot.json>`. Generic import accepts Claude policy-only
candidate records, but rejects Claude credential and identity material. Managed Claude primary
credentials stay local. Existing separate Prime/Pi Anthropic grants remain Redis-backed and refresh on demand.
New shared-grant enrollment through `aim login` has been removed.

## Runtime Commands

Normal account maintenance:

```bash
aim claude login <label> --manual-callback-stdio
aim codex login <label> --manual-callback-stdio
```

Scheduled OAuth maintenance on the M3:

```bash
aim auth maintain
cd ~/workspace/aimgr
bash scripts/install-auth-maintainer.sh
bash scripts/install-auth-maintainer.sh --uninstall
```

`aim auth maintain` handles local Claude and Codex logins and shared xAI credentials. Prime/Pi Anthropic credentials refresh on demand through their separate legacy path.


Redis administration and repair:

```bash
aim redis configure --url <redis-url> [--key-prefix <prefix>] [--primary-host <host>] [--transport tls]
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

The text tables hide blocked Codex and Claude accounts. Counts and averages use
the displayed accounts. `aim status --json` retains all accounts.

Under the Codex and Claude tables, a `Next 24h` line says how much of that pool's weekly
capacity comes back in the next 24 hours: the weekly usage on accounts whose weekly limit
resets by then, as a share of every measured account's full week. It also shows how much of
the pool is free now and how much will be free after those resets, before any new use.
Blocked accounts are not in the pool and are left out.

Hourly usage and agent activity history (foreground process, stop with Ctrl-C):

```bash
node scripts/snapshot-aim-usage.mjs --watch
```

The first capture runs immediately when no recent snapshot exists. On restart it waits until
one hour after the last completed capture. `--once` captures a single sample, and `--rebuild`
regenerates the CSV files from saved JSON without contacting providers. Private files under
`~/.aimgr/usage-snapshots/` include
timestamped JSON snapshots, `usage-samples.csv` with within-window drain rates, and
`activity-sessions.csv` with recent Codex and Claude sessions on the current host and `home`.
Codex account labels inferred from matching weekly reset times are marked as inferred;
Claude managed-home labels are exact. Process matches and recent transcript activity are
separate columns, so a recently changed session is not automatically called live.

Target projections:

```bash
aim rebalance openclaw
aim rebalance hermes
aim auth write hermes <label> --auth-file <abs-path>
aim codex use [label]
aim codex resume-fresh <session-id> | --last [--dry-run] [--no-goal] [--keep-reasoning] [--drop-compaction] [--max-copy-mb <n>] [--archive-source]
aim codex watch [--once] [--interval-seconds <sec>] [--rotate-below-weekly-remaining-pct <pct>]
aim codex privacy status [--json]
aim codex login <label> --manual-callback-stdio
aim codex logout <label>
aim codex mcp-migrate
aim codex mcp-recover
aim hermes watch [--once] [--interval-seconds <sec>] [--rotate-below-weekly-remaining-pct <pct>]
aim claude login <label> [--email <email>] [--proxy <profileRef>] [--manual-callback-stdio]
aim claude logout <label>
aim claude inventory [--json]
aim claude status [account...] [--fresh] [--verbose] [--json]
aim claude usage [account...] [--fresh] [--verbose] [--json]
aim claude list [count] [--json]
aim claude resume [<row-or-thread-id-or-name>] [--account <label>] [--switch-account fable|opus|sonnet]
aim claude run (opus|fable|sonnet) [--resume]
aim claude run <label> (opus|fable|sonnet) [--resume]
aim claude run <label> [-- <claude args...>]
aim pi use
# Explicit provider bindings; omitted providers remain unchanged
aim pi use --codex <auto|label|off> --claude <fable|opus|sonnet|label|off>
aim pi status
aim pi uninstall [--provider <openai-codex|anthropic>]
aim prime use --codex <auto|label|off> --claude <fable|opus|sonnet|label|off> --grok <auto|label|off>
aim prime run codex
aim prime run claude
aim prime run grok
aim prime resume <path-or-id> [--rotate]
aim prime status
aim prime uninstall [--provider <openai-codex|anthropic|xai>]
```

Run `aim claude resume` in a terminal to choose a local managed Claude session.
The picker lists the most recently used sessions first, with their saved title
(or a preview of the first user prompt), age, account, and working directory.
Type a displayed number and press Enter to resume; `n` shows older sessions,
`p` shows newer sessions, and `q` or an empty Enter cancels. The selected session
resumes in its own working directory with its recorded model and effort, using
the original account when available. If that account is busy or requires login,
AIM forks the conversation onto another available account while preserving the
recorded model and effort. Cross-account forks stage a temporary copy with new
session, message, request, and tool IDs, then resume the full history under a
fresh destination session. The original transcript stays untouched. Exact
conversation text and tool output still cross to the destination account and
can correlate the accounts by content. Raw `aim claude run <label> -- --resume`
also stages a source transcript when it belongs to a different account.
Login failures require a successful live usage check
on the replacement account before launch. `--account` and `--switch-account` also work with
the picker. For scripts, use `aim claude list --json` and an explicit selector.

Codex uses an approved immutable runtime and a separate account directory for
each local login. `aim codex login <label>` authorizes that account on this
machine; `auth.json` and refresh tokens are never imported from the shared pool
or exported to another machine. Each destination needs its own login. Prime/Pi
credentials retain their separate authority. Shared settings remain editable,
including relative paths and skill enable switches; a new vendor-visible folder
outside the launch grants needs a new session. Ordinary shell tools keep their
normal permissions. Codex's optional diagnostic exporters are disabled, including
custom collectors. Organization-owned remote policy is an accepted gap.

Independent MCP credentials retain their native OS-user scope across Codex
account homes. On Mac, native MCP requires the approved read/write exception
for the selected default Keychain database and its own lock and temporary files.
This exposes unrelated account/service names and permits whole-database writes;
native password encryption and item permissions remain. Linux allows same-user
mount-table reads so unchanged native read-only reviewers keep working.

Install an explicitly approved complete Codex bundle with
`scripts/install-local-bin.sh --codex-runtime-bundle /absolute/bundle`. This uses
the same protected copy/admission transaction as Claude, provisions a local
environment identity, and installs required local Codex policy. It requires
neither a proxy nor Chrome. An upgrade preserves the environment identity and
running sessions. On a cloned destination, run
`sudo python3 scripts/install-codex-runtime.py /absolute/bundle --node /absolute/node --user "$USER" --activate --provision-clone`
before using Codex; that replaces the copied identity and requires fresh local
logins. Keep the source machine's identity unchanged.

`aim codex privacy status --json` checks the approved immutable installation, local policy,
environment provisioning and pending maintenance without running Codex or
contacting Redis/OpenAI. For an existing File-backed MCP OAuth store, let the
current Codex sessions finish and run `aim codex mcp-migrate` once. It converts
the shared MCP tokens into the native OS keyring and preserves conflicting
credentials. AIM refuses new Codex launches while conversion is pending;
conversion does not stop processes or change OS schedules. `aim codex mcp-recover`
finishes an interrupted conversion in the same boot after reacquiring its locks.
It verifies a matching destination without rewriting it, retries the exact saved
credential if the destination is absent, and preserves a different credential.
On Mac, use the native Keychain **Always Allow** choice for the approved Codex
application when prompted. Import verifies that unchanged Codex can read the
selected entries before retiring File storage; a denied read preserves the
original store for explicit recovery. AIM does not request or handle the
Keychain password.
OAuth MCP servers require a usable native keyring, including an existing D-Bus/Secret Service session on Linux. Without one, AIM cannot use those OAuth logins; an existing nonempty File store keeps AIM launches refused until conversion can succeed. The original store stays unchanged. Sessions without MCP do not require a running keyring.
Recovery of an already committed migration never imports old credentials again.
Recovery never reboots the host or restarts its shared credential service. Ordinary launch
does not start conversion. The full contract and test plan are in the
[Codex privacy and proxy plan](docs/aelaguiz/CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md).

Codex's built-in file and image tools can use the whole `~/workspace`, `/tmp`,
Downloads and the screenshot directory, including subdirectories and files
created after launch. macOS uses its screenshot-location preference (Desktop by
default) and its per-user temporary folder, so screenshot thumbnails work too. Linux respects XDG Downloads/Pictures locations and includes
`Pictures/Screenshots`. Add other workspace or screenshot folders in the
machine's existing `~/.aimgr/config.yaml`:

```yaml
codexWorkingDirectories:
  - ~/another-workspace
  - /mnt/screenshots
```

Unavailable optional default folders are skipped; an invalid directory explicitly added to AIM config produces an error. These are recursive read/write grants; the selected native Codex permission
mode still applies. Paths may be absolute or relative to
the user's home; `~/` is supported. New directory settings take effect in new
sessions. `--add-dir` selects an additional directory for a launch; `--image`
selects the individual outside image without granting its siblings. The whole
home or disk cannot be granted as a work directory. Ordinary shells, browsers,
MCP servers and developer tools keep their normal OS permissions; the vendor
file policy does not impose a blanket sandbox on those tools. Files within an
approved working directory are readable regardless of their contents.

Managed Claude primary login is local to each machine. Run `aim claude login <label>`
on every machine where that account is used; `aim claude logout <label>` removes that
machine’s primary login. For a new label with an assigned proxy, select its existing
profile with `aim claude login <label> --email <email> --proxy <profileRef>`.
Both providers always use a manual callback; neither opens or selects a browser.
`--manual-callback-stdio` selects JSONL input/output for automation; without it,
Claude accepts a callback URL or native `code#state` and Codex accepts a callback URL
as plain text. An existing proxy assignment cannot be changed by login.
Existing label homes, history, settings and third-party credentials remain in place.

For a remote machine whose browser is on the original host, run
`aim claude login <label> --manual-callback-stdio` on the destination. A new
label also needs `--email <email>` and, when assigned, `--proxy <profileRef>`.
The command emits a JSON line with `type: "auth_url"` and a URL. Validate the
original browser profile and assigned route on the browser host, then open that
URL there. Return the complete native callback privately to the destination as
one JSON line on stdin: `{"url":"<callback URL>"}` or
`{"code":"<native code#state>"}`. The destination validates the callback and
its native Claude process completes the exchange. Keep the URL and callback out
of shell history and shared logs; do not copy browser state or primary tokens.
The command emits a result or error as JSON and times out after five minutes.

Prime/Pi's legacy Anthropic helper may refresh its separate Redis-backed grant
on demand when the token is due or rejected. That maintenance uses a separate
legacy home and does not refresh or export the managed Claude primary login.

Claude proxy routing is optional and configured per account. Accounts without
an assignment do not need proxy infrastructure, Chrome/CDP bindings or route
helpers. All AIM-managed Claude executions require an explicitly approved exact
Claude runtime; `aim claude privacy status [account] [--json]` inspects the selected
build, approval and local process inventory without running Claude or contacting
a provider. For an enrolled account, native
Claude and AIM requests use its assigned route, and login uses its existing
account-specific Chrome/CDP instance. On macOS, a transient connectivity check
failure gets up to 60 seconds to recover while existing sessions keep their
assigned route; new launches wait for verification. An unexpected exit address
or a lost tunnel/adapter still stops affected work. The Mac proxy service
restarts automatically after failure, with a ten-second launchd throttle, and
verifies the same assigned exit before admitting work again. Recovery does not
automatically resume a session or replay a failed scheduled job; later independent
scheduled occurrences retain the normal scheduling rules. Same-account sessions
remain concurrent.
Reinstalling the macOS proxy helper with the same assignments reloads its monitor
code in place: active sessions, SSH tunnels and network adapters keep running.
Changing proxy assignments still requires the affected work to stop.

`aim status` and `aim claude status` show each Claude account's assigned proxy
(`none` for accounts without an assigned proxy) and its current native service health: `running`,
`stopped`, `starting`, `not installed`, or `unknown`. A stopped service displays
`PROXY DOWN` and `restart assigned proxy` instead of `READY / use now`. The JSON
field is `egress.health`; local health is checked again even when usage or Redis
data comes from cache. This reads the Mac service's failure markers and recorded
process lifetimes, or Linux systemd service state. It does not restart services
or send extra network probes; native launch still verifies the assigned exit.
When that profile is not configured on this machine, it shows
`NO ROUTE` and `don't have a route to this account`. Automatic selection,
including scheduled jobs, skips that account without probing its credentials.
Installing its local profile makes it available to the picker. A configured
route that fails still stops the launch with a clear proxy error; an explicit
account launch also requires its assigned route. Cached usage cannot override
these checks, and Redis-down status rechecks the current local configuration.

Follow the [Claude privacy setup and transition plan](docs/aelaguiz/CLAUDE_PRIVACY_PROXY_WORKLOG_2026-10-30.md#8-implementation-order-and-scheduled-transition)
to install the Linux or macOS helper and configure the local profile before
enrolling a stopped account with `aim claude proxy set <label> <profileRef>`.
After enrollment, use the normal commands and schedules without a daily proxy
flag. The plan also records the telemetry opt-outs, acceptance tests and verified
platform limits.

The [per-machine Claude plan](docs/CLAUDE_PER_MACHINE_PRIVACY_AND_LOGIN_2026-11-07.md)
applies private installation IDs and scoped vendor file/device access to all managed
Claude sessions, whether direct or proxied. It preserves native tools, skills, MCP,
concurrent sessions, history, scheduled work, normal background Bash and local
subagents. Managed sessions disable detached conversations/agent view, Remote Control
and remote feature flags, prevent unapproved updates, and fix custom HTTP headers
at startup. Header edits and newly selected outside paths take effect in a new session.
The default working areas include workspace, temp, Downloads and screenshots, along
with previously trusted projects and configured or explicitly selected directories.
Configure additional roots with `claudeWorkingDirectories` in `~/.aimgr/config.yaml`.
Claude-specific telemetry, error reporting and detailed tracing are disabled; AIM
preserves generic `OTEL_*` settings in Claude's launch environment. Claude 2.1.317
itself removes them from ordinary child processes. Collector acceptance is tracked in
the plan.
On macOS, Claude's privacy sandbox ends when it executes an ordinary tool.
Shells, Chrome, MCP servers and their children retain normal host access;
direct Claude self-spawns retain Claude's restrictions. Assigned proxy routing
is independent of this sandbox and remains enforced.

Once an exact runtime bundle has been reviewed and explicitly approved, install
it with
`scripts/install-local-bin.sh --claude-runtime-bundle /absolute/path/to/approved-bundle`.
The installer validates the approved manifest and immutable package before
activating it. It does not approve arbitrary downloaded versions. The plan's
upgrade playbook defines review, testing and rollback for later Claude updates.


### Claude detached sessions and existing daemons

New AIM sessions disable Claude's optional detached-conversation system. Native
`--bg`, `--background`, agent-view, daemon and detached-job management
commands (`attach`, `logs`, `stop`, `kill`, `respawn`, `rm`) fail locally with an
explanation when native Claude would interpret them as commands. Literal prompt
text remains available with `-p`. `/background` and agent-view prewarming stay off; `/fork` uses an
ordinary asynchronous subagent instead. The built-in `claude` agent subtype is
unavailable, while `general-purpose`, background Bash, normal concurrency,
skills, MCP, history/CLI fork and AIM schedules remain available. See the
[review and implementation plan](docs/aelaguiz/CLAUDE_DETACHED_SESSION_REMOVAL_PLAN_2026-11-02.md).

This does not stop an already running daemon. `aim claude privacy status --json`
reads kernel executable identity and reports observed process roles without
running Claude, contacting Redis or signaling anything. To retire an old owner,
first agree which work may end, record its PID, kernel executable and start time,
and recheck all three immediately before sending that exact PID `SIGTERM`.
On Mac use `proc_pidpath`/the inventory helper for the executable and
`ps -p <PID> -o lstart=` for the start time; on Linux use `/proc/<PID>/exe` and
`/proc/<PID>/stat` start time. Re-inventory after exit. An unknown role, changed
identity or uncertain work means investigate, not a wildcard kill. Never use
`pkill claude`, delete saved jobs/settings, or run the raw vendor's management
fast path as a shortcut around AIM admission. Existing session cleanup is a
separate explicit transition; installing this change does not perform it.

### Installing a reviewed Claude runtime without interrupting coding

The [Claude 2.1.317 verification record](docs/aelaguiz/CLAUDE_2_1_317_UPGRADE_VERIFICATION_2026-11-03.md) records the tested bundles, final source, cold review, installation and retained evidence for the latest completed upgrade.

The installed `aim` wrapper executes the checkout it names. If that path is a
working checkout, `git pull`, switching branches or updating `main` changes the
live launcher immediately. **Install the launcher from a fixed release directory
or dedicated checkout that will not move with development.** Keep the previous
working release until the replacement passes its installation checks.

A Claude version, a passing test report and an installable runtime bundle are
three different things. The bundle contains the exact tested Claude executable,
launcher, credential adapter/other helpers, policy and complete manifest. Its
approval covers their hashes, platform and policy, not just the Claude version
string. The version lock applies to Claude and its reviewed runtime artifacts;
it does not lock macOS or Linux releases or require machines to run the same OS
version. The recorded test OS is evidence provenance, not a launch requirement.
An actual failure to apply the sandbox still stops the launch. Before terminating a test VM, retain that complete bundle
in durable restricted storage, record its digest and source revision, then
retrieve it into a fresh directory and verify every file against the manifest.
Retaining source code and test logs alone is insufficient. Do not call a bundle
available until this retrieval check passes.

Use this order for a runtime change:

1. Inspect the selected Claude bytes, installed approval and running owners
   with `aim claude privacy status [account] --json`, which does not execute
   Claude. If the current release predates that command, run the new release's
   `node /absolute/path/to/release/bin/aimgr.js claude privacy status --json`
   directly without changing the live wrapper. Distinguish a different version from a
   missing, invalid or incompatible runtime. Do not run an unapproved
   `claude --version`, and do not download a new Claude merely to repair a
   missing AIM bundle.
2. Complete offsite verification and cold review, retain/retrieve the full
   tested bundle, and record the user's approval of those exact artifacts for
   normal use. Test-only authorization does not authorize a personal machine.
3. Prepare the fixed AIM release and its exact dependencies (`npm ci` in that
   release, not through another checkout's `node_modules` symlink). Run the
   file-only installer to stage the approved bundle. Staging needs administrator
   access but does not activate the bundle or stop running sessions.
   Coordinate administrator authentication with the user. A system dialog may
   identify only `osascript`, which is ambiguous with several agents working;
   label the prompt as AI Manager and say whether it stages files or activates
   them. A canceled dialog is not permission to reopen it unexpectedly.
4. Arrange the accepted transition for affected sessions and schedules. Inventory
   them first; never kill unrelated sessions to satisfy the installer. The
   Mac activation selects future starts and preserves existing sessions and bundles.
   Linux activation still requires stopped owners before reclaiming AppArmor
   policies; per-account identity/proxy transitions retain their own guards. Activate the
   bundle with `scripts/install-local-bin.sh --claude-runtime-bundle
   /absolute/path/to/approved-bundle` **from the fixed release**, so failed
   activation leaves the previous wrappers intact. Do not omit the bundle
   argument on a machine without an approved runtime: the no-argument wrapper
   installer does not check that prerequisite.
5. Verify installed approval, selected binary hash, ordinary/protected modes as
   applicable and the relevant smoke checks before declaring the transition
   complete. Keep the approved compatible rollback and preserve account state.
   Do not resume or replay interrupted work automatically.

Include the user's automatic preset command (for example, `aim claude run opus`)
in the installation smoke test. A successful explicit-account launch alone does
not verify automatic selection. The runtime supports individual Pro/Max OAuth
accounts; automatic sessions and scheduled jobs skip other subscription types
before ranking usage, while those accounts remain visible in account inventory.
The launch-time credential check still applies, and a failed assigned proxy
still stops selection rather than choosing another route.

**2026-11-02 installation incident:** updating the development checkout changed
its live wrapper to code requiring a runtime that had not been installed. The
selected Claude 2.1.316 matched the tested vendor bytes; it was not a version
mismatch. The exact tested Mac bundle had not been retained before rental
cleanup. The user explicitly authorized temporarily restoring the previous
working launcher, preserving the earlier proxy protections while accepting that
the new file/device sandbox and exact-build lock are not active in that temporary
release. This is a specific recovery decision, not permission for a future agent
to bypass admission. A rebuilt helper must be compared with the original approved
hashes. Changed bytes require new verification; never relabel a different bundle
as the original tested artifact.

The temporary local release is
`~/.local/share/aimgr/releases/354be9e-before-runtime-install`; its private
installation receipt records the recovery decision. Previous wrappers are saved
in `~/.local/share/aimgr/launcher-backup-before-temporary-restore`. Do not switch
back to the development checkout as an installation shortcut.

The exact original Mac artifact set was subsequently recovered byte for byte
and freshly retrieved/verified into restricted storage on both the test VM and
the local machine. The [recovery record](docs/aelaguiz/evidence/agent-upgrade-test-2026-11-02/runtime-recovery.json)
distinguishes available files from an active installation. Local copies are under
`~/.local/share/aimgr/runtime-bundles/`; the original test-only archive is retained
separately from the normal-use manifest recording the user's installation request.
The bundle has been staged into the administrator-owned runtime and its complete
inventory verified. The stopped-owner transition remains unfinished. The temporary
launcher remains selected; staging the bundle has not silently activated the new
sandbox. The exact OS-release gate was an unintended expansion of the Claude
version lock and was removed after the user corrected it on 2026-11-02. The
bundle's recorded test OS stays unchanged as historical evidence.

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
c()   { command aim codex run "$@"; }
cr()  { if [ "$#" -eq 0 ]; then command aim codex resume-fresh --last; else command aim codex resume-fresh "$@"; fi }
```

The installer loads these definitions at the end of `.zshrc`, overriding older
dotfile definitions that called Codex directly. New terminals pick them up
automatically; in an existing terminal, run
`source "$HOME/.config/aimgr/codex-shortcuts.zsh"`. Interactive launches print
the selected AIM account and previous label before opening Codex. `cr` and
`cr <session-id>` rotate too, and neither launches if no eligible alternate exists.

There is no same-thread resume shortcut. `aim codex resume` rotates the account
and keeps the Codex thread id, which sends that thread id and session id to the
Codex servers under the new account and links the two accounts. It stays
available as a deliberate manual command and warns before launching; do not
alias it (see `CLAUDE.md`, "Codex account rotation rule").

### New thread on a rotated account: `aim codex resume-fresh`

`aim codex resume-fresh <session-id>` rotates the account, copies the thread's
rollout into a **brand-new** thread with the prior turns preserved, and then
resumes the copy:

```bash
aim codex resume-fresh 01a0b222-95ce-7fa3-96d8-680acb15cbcc
aim codex resume-fresh --last --dry-run     # plan only: sizes, retired ids, disk (no rotation, no writes)
aim codex resume-fresh <session-id> --max-copy-mb 512 -- goals
```

What the copy retires, so the two threads are not linkable by metadata:

- the thread id **and** the session id (Codex sends both, plus `prompt_cache_key`
  derived from the session id)
- every turn id and `create_time` inside the replayed items, server-issued item
  ids and `call_id`s, response ids, and context-window ids
- `forked_from_id` / `parent_thread_id` / `history_base` lineage pointers
- the goal row's `goal_id` (the goal itself is carried with a fresh id)
- child thread ids of any subagents the thread spawned (the children stay under
  the old account and are not carried)
- by default, the server's encrypted reasoning and tool-argument blobs

What the copy keeps: the prior turns, and the encrypted compaction blobs that
hold the pre-compaction memory, so a long thread resumes with its history intact.
Codex also gets a per-label `installation_id` instead of one id shared by every
pooled account, and `[analytics] enabled = false` is ensured in the `yolo`
profile file aim launches with.

`--keep-reasoning` keeps the reasoning blobs too (best model continuity);
`--drop-compaction` removes the compaction blobs as well, at the cost of the
pre-compaction memory. The copy is verified before launch: any retired
identifier left outside literal conversation content deletes the copy and aborts
without launching. Only sources that are themselves subagent threads or
paginated fork segments are refused. Copies stream, so multi-GB threads work
(default cap 4 GiB, `--max-copy-mb`). The source thread is never modified.

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

For an installed DeepSeek Codex profile, set `provider: deepseek`,
`profile: dsflash`, `model: deepseek-flash`, and `thinking: high`. This lane
uses the profile's existing DeepSeek API credential and does not select or
rotate a ChatGPT account. The same provider/profile applies to the initial
execution and exact-session interactive resume.
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

Account isolation, local authentication, native identity preflight and user
skills/hooks/plugins use the same managed launcher as `aim claude run`. Later
occurrences may share an account on the same machine. Redis must be reachable for
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
job keeps its overlap lock until it settles or its UI exits. Failed occurrences
are never automatically replayed. Hook details follow the
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
After a machine restart, the next launch recovers routine and bootstrap locks
left by the previous boot. Interrupted occurrences retain their receipts and
session IDs; a lock created during the current boot still prevents overlap.
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

Claude sessions on one machine may share an account’s local folder and login;
Claude Code serializes native token refreshes there. Another machine signs in
independently and uses its own local credentials.

The label-free Claude presets pick the account with the most usage left per
session. All of `fable`, `opus`, and `sonnet` score each eligible account by the
tighter of its remaining five-hour and weekly usage, divided by the sessions
that would share it on this machine. Ties go to fewer sessions, then lower
weekly usage, then account name. Provider-blocked or exhausted accounts remain
ineligible.

Claude resume uses the session's recorded account by default. Add
`--account <label>` to fork onto an exact account; combine it with
`--switch-account fable|opus|sonnet` to override the resumed model preset. Every
`aim claude resume` preserves the session's last recorded thinking effort,
including account switches and automatic forks: a `max` session stays `max`.
Missing saved model/effort stops the resume instead of substituting preset defaults.
Session names are exact, case-insensitive matches and must be quoted when they
contain spaces; ambiguous names require a row number or thread ID.

`aim claude inventory` lists shared Claude account metadata without fetching primary
credentials from Redis. Local sign-in determines whether a managed account can run
on this machine; labels and account policy remain shared metadata.

`aim claude status` and its exact `aim claude usage` alias accept only canonical Anthropic labels in
the shared account metadata. Invalid labels fail before external I/O. Local credential
availability determines whether an account can be checked or launched on this machine.

The usage commands are browserless and cookie-free: they do not inspect browser state, invoke a
model, rotate credentials, or fall back to `claude.ai`. A normal run reuses the strictly allowlisted
provider-usage section in AIM's existing `~/.aimgr/redis-cache.json`. An uncached run makes exactly
one no-retry OAuth usage `GET` per selected ready account, with at most three requests in flight;
`--fresh` bypasses a fresh success entry while preserving the one-request-per-account limit.
Transient failures are briefly backed off. The cache is written atomically with owner-only (`0600`)
permissions.

Accounts whose access token has expired are never sent to Anthropic, and AIM does not refresh idle
accounts. Their last reading is shown for up to eight days with its age in `updated`: usage inside a
window only rises through use, so the reading holds until the window resets, and a window whose
reset time has passed reads `0%`. An unlocked account with a full window reads `LIMITED` with the
time until it frees up, and automatic selection skips it.

Each managed Claude session also records its own usage. AIM wraps the session's status line with
`src/targets/claude-statusline-tap.sh`, which saves the five-hour and weekly usage Claude Code reads
from each response's headers to `.aimgr-session-usage.json` in that label's config directory, then
runs the user's own status-line command unchanged. A reading under five minutes old replaces the
usage request for that account (`source=session` in `--verbose`), so accounts in use on this machine
cost no provider request. Sessions launched before this change pick up the tap on their next launch.

Human output uses an `account` column, and JSON uses `accounts[].label` plus `missingAccounts`.
Neither schema nor the provider-usage cache contains tokens, authorization headers, raw Redis
credentials, email addresses, account or organization UUIDs, identity/policy objects, native paths,
Keychain identifiers, browser-profile names, raw provider errors, or full provider responses.
Only canonical labels, closed plan metadata, credential/auth states, rate-limit percentages and
resets, bounded timestamps, cache age, and fixed error classifications are exposed.

Claude access-token expiry is not the same thing as subscription inactivity. `credential_expired`
means the stored access credential needs maintenance; `stale_auth` means Anthropic rejected it.
Neither state by itself proves that billing was cancelled. Native Claude owns local
refresh; managed primary tokens are not published to Redis. Genuine reauthentication
is shown as `NEEDS YOU` with `aim claude login <label>`. A label without a
local login is shown as `NOT SIGNED IN` with the same guidance.
Each normal managed launch also inherits the machine's complete user-level
Claude MCP definitions, personal skills, enabled user plugins, and user hooks
at launch time. AIM passes field-only MCP/hook overlays through Claude's native
options; credentials, sessions, project trust, and unrelated user settings
remain label-isolated.

Saved memories are shared across accounts. Claude Code normally keeps a
project's memories inside the config directory, which would give every managed
account its own copy. AIM launches each account with
`CLAUDE_CODE_REMOTE_MEMORY_DIR` set to the normal `~/.claude`, so every account
(and plain `claude`) reads and saves to `~/.claude/projects/<project>/memory/`.
Each launch also moves in anything a session saved in its own account home,
such as a session that was already running before this existed. A same-named
memory with different text is kept beside the shared one as
`<name>--<label>.md`; nothing is overwritten. `aim claude memory` shows the
store, moves stragglers in on demand, and flags a project whose `MEMORY.md`
is past the 200 lines or 25 KB that Claude loads at session start. The store is
per machine. Claude does not document this variable: if a Claude Code update
stops honoring it, the move-in notice will print on every launch.

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

Claude/Codex login workflow:

Use `~/workspace/secrets/bin/aim-logins` on the destination machine: `claim`,
`authorize`, then `finish --callback -`. The wrapper invokes the provider's local
login command with `--manual-callback-stdio`. Open its authorization URL yourself
in the account's verified existing BrowserOS profile and return the full callback
through stdin. Browser profile selection, sign-in and tab cleanup belong to the
operator or BrowserOS agent. AIM neither copies a profile nor opens a browser.

The generic `aim login` and `aim <label>` Claude/Codex paths, the guided browser
setup panel and `aim browser` commands have been removed. Saved browser bindings
cannot select a different login flow. Existing legacy grants can still refresh,
but cannot be newly enrolled through those retired paths. Grok's explicit
`aim login <label> --provider xai` device-code flow is separate.

## Agent skill

`skills/aimgr/` is an agent skill that teaches coding agents the three basics of this CLI:
launch a session, see which accounts are available, and choose an available one when the others
are busy or rate-limited. It deliberately omits the credential, enrollment, Redis-admin, and
routine surfaces, and it tells agents never to run them.

Install it globally on a machine with [`npx skills`](https://github.com/vercel-labs/skills):

```bash
npx skills add aelaguiz/aimgr -g -a '*'
```

That materializes the skill in the canonical store at `~/.agents/skills/aimgr/` and symlinks it
into every installed agent's directory (`~/.claude/skills/`, `~/.codex/skills/`, and so on), so
one update refreshes all of them. Limit the fan-out with `-a claude-code -a codex` instead of
`-a '*'`.

Refresh after a change lands:

```bash
npx skills update aimgr      # pull the latest
npx skills check             # report whether an update is pending
npx skills list -g           # confirm what is installed
```

Installs read the **pushed** GitHub state, so a local edit is not live until it is committed and
pushed. To test an unpushed change, install from the working copy:

```bash
npx skills add /path/to/aimgr -s aimgr -g -a '*' -y
```

### Known issue: the Claude Code symlink on machines with managed Claude homes

On a machine where AIM has created managed Claude homes, `~/.aimgr/claude-homes/<label>/.claude/skills`
is a symlink to `~/.claude/skills`. `npx skills` measures the relative depth from the managed-home
path (five levels) but writes the link into the physically shared `~/.claude/skills`, where five
levels overshoots to `/`. The result is one dead symlink for Claude Code while every other agent
installs correctly. Repair it after any install or update:

```bash
ln -sfn ../../.agents/skills/aimgr ~/.claude/skills/aimgr
test -e ~/.claude/skills/aimgr && echo ok
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

Redis records own shared account metadata and credentials for legacy harnesses:

- credentials: provider, label, credential, identity, shared browser/reauth/pool policy, health, and audit provenance
- meta: Redis coordination schema metadata

`~/.aimgr/local-state.json` owns local-only facts:

- active target metadata
- OpenClaw assignments and exclusions
- Codex/Pi/Claude/Hermes local history
- local concrete browser bindings

Local primary credentials for managed Claude stay in the existing
`~/.aimgr/claude-homes/<label>/.claude` native home. Legacy Prime/Pi Anthropic
maintenance uses separate `.legacy-<label>` homes.

Other local target files include:

- Codex: `~/.codex/auth.json`
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
