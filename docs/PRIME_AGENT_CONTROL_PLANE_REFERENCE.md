# Prime Agent + AI Manager control plane reference

Canonical description of how the Prime Agent fork (`~/workspace/prime-agent`, package `packages/coding-agent`) and AI Manager (`aim`, this repo) fit together on one machine: which processes exist, which files are locks, who may start the shared daemon, how versions are guarded, and why restarts fight you.

Companion runbook: [PRIME_AGENT_OPERATIONS_RUNBOOK.md](PRIME_AGENT_OPERATIONS_RUNBOOK.md) (shut down, start up, restore sessions, unwedge).
Read-only state dump: `bash scripts/prime-runtime-state.sh`.

Source anchors are `packages/coding-agent/src/...` in the Prime fork unless the path starts with `src/`, which is this repo. Line numbers are as of fork commit `918d049ad` and aimgr commit `f144929` (2026-09-02).

---

## 1. Process topology

One machine, one user, one shared control plane. Everything runs as the same OS user; the locks are coordination, not security.

```
launchd (pid 1)
└─ node <bundle>/cli.js --mode daemon --daemon-socket $SOCKDIR/daemon.sock        SUPERVISOR (detached, ppid 1)
   ├─ node <bundle>/cli.js ... (catalog subprocess)                                 CATALOG: saved-session scans
   ├─ node <bundle>/cli.js --mode daemon --daemon-socket $SOCKDIR/worker-<sid>-<wid>.sock   WORKER (one per root session)
   │   ├─ ~/.prime/agent/kernel-venv/bin/python -m rlm.repl prime-agent-owner-token=<64hex>   PYTHON KERNEL (RLM REPL)
   │   │   └─ python3.11 -I -S .../rlm/_bash_supervisor.py --control-fd N prime-agent-owner-token=... protocol=2
   │   │       └─ /bin/bash -c : # prime-agent-owner-token=<64hex> <the actual command>
   │   ├─ node bin/aimgr.js credential-helper                                        short-lived, per credential request
   │   └─ RLM child workers (sub-agents) as further node processes
   └─ (more workers)

Herdr pane shell
└─ node bin/aimgr.js prime run claude | prime resume <id>      AIM (spawnSync, foreground, waits for the TUI)
   └─ node <bundle>/cli.js --provider ... --model ... | --resume <id>     TUI CLIENT (attaches over daemon.sock)
```

Facts that drive every procedure below:

- **The supervisor does no agent work.** It owns the public socket, client attachments, routing, worker health, command journals and coordinated updates (`docs/daemon.md` in the fork). Providers, tools, kernels, schedules and transcript scans run in workers and the catalog subprocess.
- **Workers are detached process groups that outlive both the TUI and the supervisor.** Closing a TUI detaches a client; it does not stop the worker. A dead supervisor leaves workers running; they keep executing their current turn and keep appending to the transcript.
- **The TUI client is what talks to aim.** aim spawns `prime-agent` in the foreground with `stdio: inherit` and no wrapper process (`src/cli/commands/harness-target.js:424-460`). aim never opens the daemon socket, never passes `--daemon-socket`, and sets no `PRIME_*` env for `run`/`resume`.
- **Process identity is by argv0 token.** Processes spawned by Prime itself get `argv0 = prime-agent-owner-token=<64hex>`; `/bin/ps` shows it and Prime can then classify that pid exactly. A `prime-agent` you run from a shell has no token and only a coarse identity (its `ps lstart` time). This matters for every lock (section 3).

### 1.1 Process shapes to recognise in `ps`

**`ps` does not show Prime's argv.** Every process Prime spawns is started with `argv0 = prime-agent-owner-token=<64hex>` and then sets its process title, so `ps` prints `prime-agent prime-agent-owner-token=<hex>` for supervisors and workers alike, with no `--mode daemon` and no socket path. A TUI client prints just `prime-agent`. Roles must come from the registry (`owner.json.pid` = supervisor) and the descriptors (`<wid>.json.pid` = worker); `scripts/prime-runtime-state.sh` does exactly that.

| Role | What `ps` shows | Parent | Identified by |
|---|---|---|---|
| Supervisor | `prime-agent prime-agent-owner-token=<hex>` | 1 (detached), or the client/worker that just spawned it | pid in `~/.prime/supervisor-owners/<gen>.owner/owner.json` |
| Worker | `prime-agent prime-agent-owner-token=<hex>` | supervisor pid, or 1 after the supervisor died | pid in `~/.prime/agent/daemon-workers/<sid>/<wid>.json` |
| Catalog | `node <install>/dist/modes/daemon/daemon-catalog-entry.js` | supervisor | argv |
| Kernel | `kernel-venv/bin/python -m rlm.repl prime-agent-owner-token=` | worker | argv |
| Bash supervisor | `python3.11 -I -S .../rlm/_bash_supervisor.py --control-fd N prime-agent-owner-token=` | kernel | argv |
| Tool shell | `/bin/bash -c : # prime-agent-owner-token=<hex> <command>` | bash supervisor | argv |
| TUI client | `prime-agent` on a tty | `aimgr.js prime …` or a shell | tty + parent |
| aim launcher | `node bin/aimgr.js prime run|resume …` | Herdr pane shell (after `exec`, it *is* the pane's process) | argv |
| aim MCP (port 7337) | `node bin/aimgr.js mcp serve` | launchd `com.funcountry.agents_host.aim_mcp_serve` | argv |
| prime-fleet MCP (port 7717) | `prime-agent` (retitled) | manual; no launchd job on this machine | `lsof -iTCP:7717` |

Identity strings: the 12-hex **socket id** `a9cccd67a53b` is `sha256(realpath(daemon.sock))[0:12]` (`modes/daemon/daemon-launch-lease.ts:357-362`). It names the worker descriptor directory, worker sockets, launch-lease directory and the daemon log. It changes only if the socket path changes (different `TMPDIR`, uid or `--daemon-socket`); it never changes across restarts or builds. The un-normalised `/var/...` spelling hashes to `aeccb21d06a0`, which is why a second `.supervisor-launch-aeccb21d06a0.lock` exists next to the canonical one.

---

## 2. On-disk map

`$SOCKDIR` = `$(getconf DARWIN_USER_TEMP_DIR)prime-agent-501` = `/private/var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501` (from `tmpdir()` + uid; `modes/daemon/daemon-socket.ts:316-319`).
`$AGENTDIR` = `~/.prime/agent` (override: `PRIME_AGENT_CODING_AGENT_DIR`).
`$HOMEREG` = `~/.prime/supervisor-owners` (override: `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR`, which also disables the mirror).
`$TMPREG` = `$SOCKDIR/supervisor-owners` (legacy mirror of `$HOMEREG`; every owner record must exist in both).

| Path | What it is | Who writes it | Survives what |
|---|---|---|---|
| `$SOCKDIR/daemon.sock` | public JSONL socket, mode 0600 | supervisor | a stale inode survives SIGKILL; next supervisor quarantines and unlinks it |
| `$SOCKDIR/daemon.sock.lock` | socket-path authority guard record `{pid, processStartId, token}` | supervisor, for its lifetime | SIGKILL; reclaimed when the pid is exactly dead |
| `$SOCKDIR/.supervisor-launch-<sid>.lock/` (`pid`, `lease.json`) | daemon **launch lease**: elects the one process allowed to probe/replace/spawn the supervisor | a client or a recovering worker, for seconds up to 120 s | SIGKILL; reclaimed only when the owner pid is gone or exactly dead |
| `$SOCKDIR/.supervisor-launch-<sid>.lock.guard` | mutex around edits to the launch lease dir | whoever is mutating it, milliseconds | SIGKILL; reclaimed when the pid is exactly dead |
| `$SOCKDIR/worker-<sid>-<wid>.sock` | private worker socket | worker | stale inode survives worker death |
| `$SOCKDIR/update-restart-coordinators/` | proper-lockfile records for `prime-agent update` restarts | update coordinator | — |
| `$HOMEREG/<generation>.owner/{owner.json,scope.json}` + `$TMPREG/...` | supervisor **registry**: which generation owns which socket and descriptor dir; `mirrorRequired: true` means both copies must exist | supervisor, for its lifetime | SIGKILL; reclaimed by the next supervisor when the pid is exactly dead |
| `$HOMEREG/.guard`, `$TMPREG/.guard` | registry mutation guard | any registry mutator, milliseconds | SIGKILL; `.guard.release-*` / `.guard.publish-*` leftovers are inert; `.guard.reclaim-*` leftovers permanently block reclamation |
| `$HOMEREG/shutdown-admission.json` (+ mirror) | "a shutdown/reap is in progress": blocks supervisor start and worker recovery | `prime-agent shutdown`, `reap`, update-restart; renewed every 1 s | never expires by time; reclaimed when the holder pid is exactly dead |
| `$HOMEREG/offline-maintenance/<token>.json` (+ compat `.owner` + sentinel) | scope lock while `reap` deletes a dead worker's artifacts | `prime-agent reap` | same rule |
| `$HOMEREG/startup-fences/<sha256>.json` | predecessor supervisor identity written by update-restart; a new supervisor waits up to 10 s for it to be exactly dead | update-restart | blocks every supervisor start until the recorded pid is gone |
| `$AGENTDIR/daemon-workers/<sid>/<wid>.json` | **worker descriptor**: pid, token, socket, root session id and file, lifecycle (`ready`/`recovering`/`failed`), `lastError` | supervisor and worker | survives everything; a replacement supervisor adopts or parks every descriptor it finds |
| `$AGENTDIR/daemon-workers/<sid>/<wid>.recovery.jsonl` | worker recovery journal (operations in flight, sub-session holds) | worker | survives; replayed as "uncertain, not replayed" on recovery |
| `$AGENTDIR/daemon-workers/<sid>/<wid>.orphans.jsonl` | detached subprocess journal (dev servers, long builds) so recovery can reap them | worker | survives |
| `$AGENTDIR/session-leases/<sha256(session path)>.lock/owner.json` | **session lease**: which worker owns a transcript; concurrent opens get `session_already_active` | worker (only when `PRIME_AGENT_INTERNAL_SESSION_LEASES=1`, which the supervisor sets) | SIGKILL; reclaimed when the worker pid is exactly dead |
| `$AGENTDIR/sessions/<uuid>.jsonl` | the transcript (durable truth) | worker | always; this is what you restore from |
| `$AGENTDIR/session-artifacts/<uuid>/` | scheduled jobs, sub-session transcripts | worker | always |
| `$AGENTDIR/auth.json` | provider bindings; aim writes non-secret `external` descriptors pointing at `bin/aimgr.js credential-helper` | aim (`prime use/run`) | always |
| `$AGENTDIR/logs/daemon.sock.<8hex>.log` | supervisor log with startup phase traces | supervisor | append-only |
| `$AGENTDIR/logs/client-errors.log` | client-side launch traces (`daemon-launch: trace=... phase=...`) | clients | append-only |
| `$AGENTDIR/logs/processes/<uuid>.jsonl` | per-process lifecycle log (`process_start`, `signal_received`, `uncaught_exception`, `process_exit`, `launchTrigger`) | every Prime process | append-only |
| `$AGENTDIR/logs/crash-reports/` | Node diagnostic reports on fatal errors | any | — |
| `~/.prime/installs/<name>/lib/node_modules/prime-agent/dist/bundle/cli.js` | immutable installed bundle; `/opt/homebrew/bin/prime-agent` is a symlink to one of these | manual install | — |

---

## 3. Locks, leases, guards

Every lock in this layer is a **file, directory or hard link**. None is a kernel lock. The kernel releases nothing when a process dies; only an explicit `release()` does. Recovery from a dead holder is always by *the next contender* classifying the holder's pid as "exactly dead".

### 3.1 The base primitive: authority mutation guard (`core/authority-mutation-guard.ts`)

- Claim = write a temp file, `fsync`, then `linkSync(temp, <guard path>)`; `EEXIST` means contended. The holder keeps the fd open and pins dev/inode.
- On contention the contender parses the holder record, classifies the holder pid, and reclaims **only** if the classification is `exact-dead`. Otherwise it sleeps with `Atomics.wait` (blocks the whole event loop) and retries.
- Error on exhaustion: `AuthorityGuardContentionError`, `code: authority_guard_contended`, message is the caller's, e.g. `Could not coordinate daemon launch lease: <dir>` or `Could not coordinate daemon supervisor registry: <dir>`.
- Budgets: launch lease 100 × 10 ms; session lease 100 × 10 ms; socket lock 601 × 25 ms (about 15 s); registry guard 1 attempt inside, 500 outer async retries × 10 ms. Each contended retry may spawn `/bin/ps` up to twice (2 s timeout each), so those are floors.

### 3.2 Process identity and the "exactly dead" rule (`core/session-lease.ts:781-878`)

1. `kill(pid, 0)`: `ESRCH` → absent → **exact-dead**.
2. Otherwise `/bin/ps -ww -o command= -p <pid>`. If the command line carries exactly one `prime-agent-owner-token=<64hex>` the identity is **exact** (`token:<hex>`); if the record's expected token differs → exact-dead; if equal → exact-live.
3. Anything else (no token, two tokens, `EPERM`, `ps` timeout) → **retained**. Retained is never reclaimed.

Consequences you will hit:

- A **hung but alive** holder is never reclaimed. This is the launch-lease wedge from 2026-09-02: worker PID 19763 held `.supervisor-launch-a9cccd67a53b.lock`, was alive but not serving, and every client got `authority_guard_contended`.
- A **shell-launched** `prime-agent` (no token) that is alive is never reclaimed, no matter how stuck it is.
- **PID reuse** by any tokenless process (a shell, an editor) turns an exact record into retained. The lock stays wedged until that unrelated pid exits.
- A leftover `<guard>.reclaim-<token>` hard link from a crashed reclaimer permanently blocks reclamation of that guard.
- A **malformed or partial** `*.owner/` dir, `offline-maintenance/*.json`, `shutdown-admission.json` or `startup-fences/*.json` makes the reader throw instead of ignoring it, which fails every supervisor start.
- `prime-agent --mode daemon` **run by hand from a shell fails** at registry acquisition with `daemon_supervisor_exact_identity_required`, because the registry refuses owners without an exact identity (`daemon-supervisor-ownership.ts:799-803`). Start the supervisor through a client, or spawn it yourself with `argv0` set to an owner token (the runbook shows both).

### 3.3 Lock-by-lock summary

| Lock | Holder | Held for | Contended error | Auto-reclaim when |
|---|---|---|---|---|
| Launch lease dir | client or recovering worker | until hello or 120 s | `Could not coordinate daemon launch lease` (guard) or silent `undefined` (dir held by a live owner; caller keeps polling the socket) | owner pid gone, or `released` marker matches, or exact-dead |
| `daemon.sock.lock` | supervisor | lifetime | `Daemon socket path is already owned` after ~15 s | exact-dead |
| Registry `.owner` | supervisor | lifetime | `daemon_supervisor_already_running` | exact-dead, checked by the next supervisor's conflict scan |
| Registry `.guard` | any mutator | ms | `Could not coordinate daemon supervisor registry` | exact-dead |
| Shutdown admission | `shutdown`/`reap`/update | command duration | `daemon_shutdown_in_progress`; worker recovery pauses and retries every 5 s | exact-dead |
| Offline maintenance | `reap` | command duration | `daemon_offline_maintenance_in_progress` after 5.5 s | exact-dead |
| Startup fence | update-restart | until predecessor exits | `Timed out waiting for predecessor daemon process <pid> to exit` after 10 s | exact-dead |
| Session lease | worker | session open | `session_already_active` (carries the owner's active session id) | exact-dead |

### 3.4 What changed on 2026-09-01 (commit `adc4c4e78`)

Read-only authority checks (the worker fence poll every 250 ms, worker command admission, the supervisor's per-command ownership assertion, the shutdown-admission read) no longer take the registry guard. Mutations still do. Workers started before that build still spin on the guard among themselves; recycle them (stop and resume) to get the benefit. Full analysis: fork `docs/bugs/daemon-registry-lock-contention.md`.

---

## 4. Who can start a supervisor (why restarts fight you)

Any of these will spawn a new supervisor the moment `daemon.sock` does not answer a connect:

| Source | Trigger | Executable it spawns from |
|---|---|---|
| Any session-opening `prime-agent` client: bare `prime-agent`, `--resume <id>`, `-c`, `--fork`, `-p`/`--mode json|rpc|acp`, hence `aim prime run` and `aim prime resume` | `maybeStartDaemonEarly` runs before `main` is even imported (`cli-main.ts:38`), then `ensureInteractiveDaemonRunning` (`main.ts:1261`); both go through `ensureDaemonRunning` (`cli/daemon-launch.ts:603-660`) | **its own bundle**: `process.execPath` plus its own resolved `argv[1]` (`cli/subprocess-launch.ts:48-62`), even if the symlink has since moved. On 2026-09-02 client PID 41464 (started 09-01 18:52) spawned supervisors from the retired `lock-free-reads-20260901-1805` install. |
| Every attached TUI or agents view that loses its socket | reconnect loop calls `ensureInteractiveDaemonRunning` before every attempt, for 60 s (TUI) or 120 s (agents view) (`modes/agent-connection/daemon-agent-connection.ts:1589-1676`) | its own bundle. In the tests below the TUI won the race against the worker every time (within 1 s). |
| Every live worker | availability check 100 ms after the supervisor socket closes, then every 5 s: takes the launch lease, spawns a replacement (`modes/daemon/daemon-mode.ts:989-1127`, `launchTrigger: worker_supervisor_recovery`). Only when the socket is *unreachable*; a hung-but-listening supervisor is never replaced. | the worker's own bundle |
| `prime-agent mcp-serve` (prime-fleet MCP, port 7717) | `DaemonBridge.start` on `absent`, and on every auto-reconnect (`modes/mcp-serve/daemon-bridge.ts:55-70, 201-212`) | its own bundle |
| `prime-agent update` coordinator | after stopping the old daemon (`package-manager-cli.ts:1356`) | the new CLI's bundle (this is the designed upgrade path) |
| Scheduled routines (`launchd com.funcountry.aimgr.routine.*` → `aim routine run` → Herdr pane → `prime-agent --print` pin, then `--resume <path>`) | the pin run and the resume are ordinary session-opening clients | current symlink |

Things that do **not** start a supervisor (they connect to an existing socket or fail): `prime-agent status`, `doctor` (with or without `--fix`), `list`, `attach <id>`, `stop`, `send`, `schedule`, `shutdown`, `--help`, `--version`; `aim prime status|use|uninstall`, `aim status`; reading transcripts; `scripts/prime-runtime-state.sh`.

Rules that follow:

1. To stop the daemon for real you must first stop **every** client and worker, or the survivors will immediately elect a launcher and bring it back, possibly from an old install.
2. To upgrade the bundle without a stop-the-world, use the update-restart coordinator or the worker-preserving `restart` wire command (runbook), not "kill and let a client relaunch". A client relaunch runs whatever bundle that client was born with.
3. When you see supervisors starting and dying in a loop (`Daemon supervisor startup failed: AuthorityGuardContentionError ... supervisor-owners`), the launchers are healthy; a **registry guard or admission holder** is wedged. Find that holder; do not kill the launchers.

---

## 5. Supervisor and worker lifecycle

Sources: `cli/daemon-launch.ts`, `modes/daemon/daemon-supervisor.ts`, `modes/daemon/daemon-mode.ts`, `modes/daemon/daemon-client.ts`.

### 5.1 Client startup algorithm (traces land in `logs/client-errors.log` as `daemon-launch: trace=… phase=…`)

```
initial_probe            connect (250 ms, then 2 s) + hello (2 s) → current | unresponsive | absent
                         hello received = current, even if versions differ (logged, connect anyway)
waiting_for_launch_lease launchLease=contended:<ms>; re-probe every 250 ms until the winner's hello
launch_lease_acquired
leader_probe             re-probe under the lease; unresponsive → wait out the remaining budget, never kill
spawning_supervisor      command=node <bundle>/cli.js --mode daemon --daemon-socket <sock>
                         detached, stdio ignored, argv0 = prime-agent-owner-token=<hex>, cwd = client cwd
<poll every 25 ms for hello, up to 120 s total (DAEMON_STARTUP_TIMEOUT_MS), then attach>
```

Constants: startup budget 120 s; child exit grace 2 s; `connect` 3 s and request 30 s on the attach client; `create` 120 s; reconnect loop 60 s (TUI) / 120 s (agents view) calling `ensureInteractiveDaemonRunning` before every attempt. The launch-lease guard itself gives up after 100 × 10 ms and **throws out of the launcher** (`Could not coordinate daemon launch lease`), which is the stack trace the user sees; the reconnect loop swallows it and retries, a fresh `aim prime resume` dies on it.

### 5.2 Supervisor startup phases (observed in `logs/daemon.sock.<id>.log`)

```
begin → socket_authority_acquired (daemon.sock.lock) → [startup fence wait]
→ registry ownership (both .guard, conflict scan, .owner published mirror-first)
→ descriptors_loaded (workerCount=N) → socket_listening → catalog_started
→ roster_seeded → worker_adoption_started (concurrency=8)
→ per worker: worker_adoption_wait → worker_adoption_result status=adopted|failed
→ worker_adoption_finished → ready → "listening on <sock>" (daemon_hello now served)
```

The socket is listening **before** adoption finishes, but `daemon_hello` is withheld until `ready`; every command from a client that connected early blocks on the ready gate. A client in that window sees `unresponsive`, waits, and never spawns a second supervisor. While waiting the supervisor logs `phase=<current> hello=deferred acceptedDuringStartup=N` every 5 s.

Order of the guarded steps and what each can fail with: `daemon.sock.lock` (601 × 25 ms → `Daemon socket path is already owned`), startup fence (10 s → `Timed out waiting for predecessor daemon process <pid> to exit`), registry ownership (500 × 10 ms → `Could not coordinate daemon supervisor registry`; or `Daemon shutdown is in progress`, `Daemon supervisor <gen> already owns <socket>`), socket prepare (`Daemon socket already in use` if something answers on it). Catalog start failure is non-fatal. **Any throw out of a single worker's adoption fails the whole startup** (`Split worker authority for <id>` when two descriptor files claim one worker; a malformed descriptor is skipped with `Ignoring invalid worker descriptor`).

### 5.3 What adoption does with each descriptor

- Worker pid alive and authenticates with its token → adopted, fenced to the new generation (`worker_adoption_result … status=ready`, about 300 ms each, 8 in parallel).
- Worker pid dead → `Could not adopt worker <wid>: Session worker process is no longer running`, then `Recovered worker <wid> without replaying uncertain operations: ...`, then the descriptor is parked with `lifecycle: failed`, `lastError: Waiting for a client with fresh runtime context`. **Resident roots are never relaunched by the supervisor.** They come back only when a client resumes that session, which supplies env and credentials; the parked registration is reclaimed when its process is confirmed dead.
- Worker alive but not answering → `recovering`, retries at 250 ms, 1 s, 5 s, then up to 10 deferred rounds of 5 s, then `failed` with `Live session worker did not answer recovery probes for 10 rounds`. It is never killed ("leak over kill"). Manual retry is the `retry_worker` wire command (MCP `restart_session`).
- Adoption never deletes descriptors. `prime-agent doctor --fix` does (observed: all 22 parked descriptors of the dead default daemon were removed), and so does a clean `stop`/`shutdown`.

### 5.4 Worker behaviour when the supervisor dies

- Availability check 100 ms after the socket closes, then every 5 s; the worker keeps running its current turn. It takes the launch lease and spawns a replacement from its own bundle only when the socket is **unreachable**; a hung-but-listening supervisor is never replaced. In practice an attached TUI wins the race (it retries every few seconds and spawned the replacement within 1 s in every test).
- Fence poll every 250 ms validates the bound supervisor claim against the registry; a replacement supervisor's authentication revokes the old claim and ends the old socket. Sessions keep their active session id; a `recovery` marker is appended to the transcript.
- SIGTERM to a worker: kills tracked detached children, closes every session (kernel snapshot, RLM children cascaded), releases its socket, exits. SIGKILL: nothing runs; kernels and tool shells stay alive as orphans tagged with the owner token; the next supervisor's recovery or `stop` reaps them via the orphan journal (SIGTERM, 500 ms, SIGKILL, 1 s).

### 5.5 Shutdown paths

- `prime-agent shutdown --force`: takes the shutdown admission (needs the registry guard; loops forever if another admission is retained), plans per discovered socket (`orphan-file` → remove; `unreachable` with pid → kill; reachable → `shutdown` wire), which makes every worker close its sessions with reason `killed` (archived, scheduled jobs cancelled, kernel snapshotted; a 0-message session is discarded), waits 2 s (500 ms with force), SIGKILLs process groups, then removes descriptors, sockets, lease and owner records. Measured: 4.7 s with one worker.
- SIGTERM to the supervisor: `shutdown(stopWorkers=false)`; workers survive and get adopted by whoever launches next.
- `restart` wire command (`scripts/prime-daemon-wire.mjs restart`): same as SIGTERM but the supervisor itself spawns the replacement from its own entrypoint before exiting, and clients get `daemon_closing update` so they reconnect quietly for up to 120 s.
- `prime-agent update --internal-update-restart-coordinator`: two-phase prepare (all workers checkpoint), shutdown, startup fence, spawn from the *new* CLI, restore. The only path that changes the supervisor's bundle while keeping workers.

---

## 6. Version and build guards

- **Hello contents**: `protocol {name: prime-agent.daemon, version: 7}`, `schemaId protocol-7-schema-26-fac530c4c6dd`, `appVersion 0.9.1`, `runtime.buildId` (`bundle-v1:<sha256>` of the bundle), `supervisorGeneration`, `supervisorPid`. `scripts/prime-daemon-wire.mjs hello` prints them.
- **Client ↔ daemon admission in this fork is log-only.** `probeDaemonVersion` returns `current` for any hello; a protocol/schema/app mismatch only writes `running daemon on <sock> differs from this client (connecting anyway)` to `client-errors.log`. The `stale` status, the `StaleDaemonError` text (`An incompatible Prime Agent daemon is running… Daemon: unknown build`) and the `y` prompt are unreachable code. Per-command gating still exists (`The running Prime Agent daemon does not support <capability>`), and `prime-agent status` still labels a mismatched daemon `stale` for display.
- **Worker ↔ supervisor** connections authenticate with per-worker tokens and are fenced to the supervisor generation; an old supervisor cannot keep commanding an adopted worker. The supervisor only requires that the worker's hello carries a `runtime`; a worker without the roster capability is SIGKILLed and relaunched, anything else is parked.
- **Update replacement** is strict: the coordinator refuses a replacement whose protocol/schema/app version differ from the CLI (`Replacement daemon is v…, expected v…`).
- **Installed bundles are immutable and content-addressed.** `~/.prime/installs/<name>/...` is never rebuilt in place; switching is an atomic re-point of `/opt/homebrew/bin/prime-agent`. Running workers keep loading late-imported chunks from the install they started from, which is why retired installs must stay on disk until their workers are recycled.
- **`prime-agent.sh` (tsx source lane)** is what `scripts/sync-fleet.sh` installs on the fleet boxes as `~/.local/bin/prime-agent`; this machine uses the bundle symlink instead. Mixing both on one machine gives two "current" builds and the incompatible-daemon prompt.
- **The one-release update handoff** keeps protocol v1 only for preparing and stopping an older daemon; `prime-agent update --internal-update-restart-coordinator` is the two-phase path (checkpoint all workers → persist manifest → stop old → start new → adopt).

Current state on this machine: launcher → `path-resume-fix-20260902` (`bundle-v1:97126916…`, app 0.9.1). Retained: `lock-free-reads-20260901-1805` (`bundle-v1:6d9f6fc3…`, app 0.9.1). Same app version, so the two are wire-compatible; the difference is the absolute-path resume fix.

---

## 7. How aim drives Prime

| Command | What it does | Daemon contact |
|---|---|---|
| `aim prime run codex|claude|grok` | selects an account from Redis (Codex: lowest 5h usage and not exhausted; Claude: least-used unlocked; Grok: ready seat), writes an external descriptor into `~/.prime/agent/auth.json`, installs the footer extension, then `spawnSync prime-agent --provider <p> --model <m>` in the foreground | none by aim; the client launches the daemon if needed |
| `aim prime resume <sel>` | installs the footer extension, then `spawnSync prime-agent --resume <sel>`; no Redis, no session read | same |
| `aim prime resume <sel> --rotate` | reads the transcript's active branch for provider/model/binding history, selects a different account, runs `prime-agent __aim-handoff-credential <sid> <p> <m> <old> <oldfp> <new> <newfp> --json` (a daemon wire command that swaps the live root's credential generation without restarting the worker), then plain `--resume` | requires the session to be resident in the daemon |
| `aim prime use ...` / `status` / `uninstall` | descriptor management only | none |
| `aim routine run <id>` | claims the occurrence, creates a Herdr workspace in the `growth` session, runs a worker that does `aim prime use`, a `--print --mode json` pin run, then `prime-agent --cwd ... --session-dir ... --resume <abs path> -- <prompt>` with `PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND=1` | ordinary client |
| `aim mcp serve` (port 7337) | remote `aim_exec`; refuses `prime run|resume` | none |
| credential helper | each worker spawns `node bin/aimgr.js credential-helper`; Redis load 5 s, hard deadline 40 s, Prime kills it at 45 s | none |

aim has no command to inspect, stop or restart the daemon. Use `prime-agent status|doctor|shutdown|reap`.

Historic runbooks in this repo (`PRIME_AGENT_CUTOVER_FAST_RUNBOOK_2026-08-12.md`, `PRIME_AGENT_AIMGR_SINGLE_MAIN_RECOVERY_PLAN_2026-08-20.md`, `PRIME_AGENT_HERDR_UPGRADE_RESTORATION_PLAN_2026-08-11.md`) predate the immutable-install layout and still reference `--dist`, `~/.local/bin/prime-agent` and pinned worktrees. Their per-pane restore pattern (`herdr pane run <pane> "cd <cwd> && exec aim prime resume <uuid>"`) is now known to be wrong on two counts: `exec` closes the pane when the TUI fails, and a uuid selector goes through the 3 s `get_state` lane; use `scripts/prime-restore-sessions.py` (runbook §4 and §7).

---

## 8. Failure catalogue (symptom → cause → what actually fixes it)

| What you see | Layer | Cause | Fix |
|---|---|---|---|
| `AuthorityGuardContentionError: Could not coordinate daemon launch lease: .../.supervisor-launch-<sid>.lock` with `EEXIST ... .lock.guard` | client | the launch-lease **guard** is held by a live pid (hung client or worker) | find the pid in `.lock/pid` and `.lock.guard`; if it is a dead-frontend worker, SIGTERM it; the guard is reclaimed once the pid is gone |
| `Daemon supervisor startup failed: AuthorityGuardContentionError: Could not coordinate daemon supervisor registry: ~/.prime/supervisor-owners` repeating every 30 s | supervisor | `$HOMEREG/.guard` (or the mirror's) is held by a live pid | read `.guard` → pid; if it is a wedged worker (the 2026-09-02 case: PID 19201 holding it since 10:24), SIGTERM that worker |
| `Timed out waiting for daemon worker response to heartbeats_list` / `create` / `get_state` | client | supervisor alive but overloaded, or mid-restart adoption | wait for `phase=ready`; if it never comes, it is a guard wedge above |
| `Daemon connection lost; reconnecting…` in a pane | client | supervisor died; the pane is re-probing (and will itself try to launch) | fix the daemon; the pane reattaches by itself once a compatible hello appears |
| `The daemon stopped this agent session. Its transcript remains saved` | client | worker was stopped/killed; transcript is durable | `aim prime resume <uuid>` after the daemon is healthy |
| `Could not look up active agent '<abs path>': Timed out after 3000ms ... get_state` | client | pre-`path-resume-fix` bundle sends absolute paths through the 3 s `get_state` lane | use the `path-resume-fix-20260902` bundle (current symlink) or resume by uuid |
| `Timed out waiting for the running Prime Agent daemon on <sock> to finish startup.` / `… accepted connections but did not finish startup within 120 seconds. It was left running` | client | supervisor listening but never reached `ready` (adoption of a wedged worker, fence, registry guard) | read the last `phase=` in the daemon log; runbook 5.3 |
| `Timed out waiting for the elected Prime Agent daemon launcher on <sock>.` | client | another launcher held the lease for 120 s without producing a hello | its trace is in `client-errors.log`; it is usually itself stuck on a guard |
| `Prime Agent daemon exited during startup (code 1). Recent daemon log: …` | client | supervisor start failed; the tail names the guard, admission, fence or owner conflict | runbook 5.2 |
| `Daemon: unknown build` / incompatible-build prompt (`y` to replace) | client | unreachable code in this fork; if you see it you are on a different build | never answer `y` on a daemon with live workers |
| `Session is already active in <owned-...>` / `session_already_active` | worker | another live worker owns that transcript's lease | attach to the existing one (`prime-agent attach <id>`); if the owner pid is dead the lease is reclaimed automatically |
| `Daemon socket path is already owned` after ~15 s | supervisor | `daemon.sock.lock` owner is alive (or its pid was reused) | stop the owner or wait for the reused pid to exit |
| `supervisor_generation_stale ... restart the daemon to recover — sessions are preserved` | supervisor | one registry copy of a `mirrorRequired` owner disappeared (macOS `dirhelper` purges `$TMPDIR` after 3 days) | restart the supervisor (worker-preserving) |
| Whole fleet laggy, creates take 50 to 160 s | all | pre-2026-09-01 workers spinning on the registry guard, or disk full (`fseventsd` at 100 %) | recycle old workers; free disk |

Incident that produced this document (2026-09-02, this machine): disk filled → supervisor generation `90d4e688` died around 10:24 CDT → worker 19201 was mid-registry-guard and never released it → every replacement supervisor failed on the registry guard every 30 s → worker 19763 meanwhile held the launch lease → every client got `authority_guard_contended` → panes disconnected while workers kept working → all Prime processes were SIGTERM/SIGKILLed at 11:11 CDT, leaving stale socket, lease, owner and 22 dead descriptors, which the runbook's unclean-recovery procedure clears.
