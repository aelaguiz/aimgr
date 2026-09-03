# Prime Agent operations runbook

How to shut the Prime stack down, bring it back, restore sessions into Herdr panes, and get unstuck. Every step here was executed on this machine on 2026-09-02 (test log at the end). Background and the lock inventory live in [PRIME_AGENT_CONTROL_PLANE_REFERENCE.md](PRIME_AGENT_CONTROL_PLANE_REFERENCE.md).

Helpers in this repo:

| Script | Does | Mutates |
|---|---|---|
| `bash scripts/prime-runtime-state.sh` | full inventory: processes, sockets, leases, guards, registry owners, worker descriptors, each recorded pid marked ALIVE or dead | nothing |
| `node scripts/prime-daemon-start.mjs` | starts one supervisor with zero sessions the way a client would (detached, `argv0` owner token) and waits for hello | spawns the supervisor only |
| `node scripts/prime-daemon-wire.mjs hello\|list\|restart\|shutdown [--force]` | raw socket commands; `restart` is the worker-preserving supervisor restart the fork removed from the CLI | as named |
| `python3 scripts/prime-restore-sessions.py <plan>` (section 9 is the tested end-to-end procedure) | resumes sessions into Herdr panes one at a time by absolute transcript path, recreating workspaces or splitting panes as the plan says, and proves each one via its worker descriptor | creates panes/workspaces, runs `aim prime resume` |

Paths used below: `$SOCKDIR` = `$(getconf DARWIN_USER_TEMP_DIR)prime-agent-501`, `$HOMEREG` = `~/.prime/supervisor-owners`, `$AGENTDIR` = `~/.prime/agent`.

---

## 0. Read the state first, every time

```bash
bash scripts/prime-runtime-state.sh
prime-agent status --json
```

Then pick the section:

| State script shows | `status` says | Go to |
|---|---|---|
| a supervisor pid, `daemon.sock: CONNECTABLE` | `current` | healthy; section 3 to stop, section 4 to restore panes |
| no supervisor pid, every recorded pid `dead` | `orphan-file` or no rows | section 2 (start) after the 30-second cleanup in section 5.1 |
| no supervisor pid, some recorded pid `ALIVE` | anything | section 5.2: that pid is the wedge |
| a supervisor pid, clients time out or panes say `reconnecting…` | `unreachable` or `current` | section 5.3 |
| supervisors appear and die every 30 s in the daemon log | `orphan-file`/`unreachable` | section 5.2; a registry guard or admission holder is alive |

Rules that hold in every section:

1. **Transcripts are the only truth.** `$AGENTDIR/sessions/<uuid>.jsonl` survives everything; anything else can be rebuilt. Never delete them.
2. **Inventory before signals.** Killing processes one at a time makes survivors elect a new launcher and bring the daemon back mid-repair, often from an old install.
3. **Do not hand-run `prime-agent --mode daemon`.** The registry refuses a supervisor without an exact process identity; use `scripts/prime-daemon-start.mjs` or let a client start it.
4. **A live pid is never auto-reclaimed.** If a lock names a pid that is alive, the lock stays until that pid exits, no matter how hung it is.
5. **Anything that opens a session starts the daemon.** `aim prime run`, `aim prime resume`, bare `prime-agent`, `--resume`, `-p`, routines, `mcp-serve`, and reconnecting panes all do. `status`, `doctor`, `list`, `stop`, `send`, `attach`, `shutdown` do not.

---

## 1. Shut everything down cleanly

Use this before a reboot, an install switch you want to be total, or when the user wants "everything stopped, then we resume".

1. **Freeze the launchers.** For the window, do not run `aim prime run|resume`. Check nothing scheduled will fire (`launchctl list | grep aimgr.routine`; the next fire times are in `~/.aimgr/config.yaml`). If `prime-agent mcp-serve` is running (`ps ax | grep mcp-serve`), stop it first, because its daemon bridge respawns the supervisor on reconnect.
2. **Close panes that are already reconnecting.** A pane showing `Daemon connection lost; reconnecting…` is a client in a 60-second loop that will relaunch the daemon after you stop it. Press `Ctrl-C` in those panes until the shell prompt is back (`herdr --session <server> pane send-keys <pane> ctrl+c`, or `herdr pane close <pane>` for a pane you created). Panes attached to a healthy daemon can stay; they receive `daemon_closing shutdown`, print `The daemon stopped this agent session…`, and stop reconnecting, but the TUI process stays open until you close it.
3. **Stop the stack.**

   ```bash
   prime-agent shutdown --force
   ```

   What this does: writes `shutdown-admission.json` in both registries (blocks every worker and supervisor launch while it runs), sends `shutdown` to the supervisor, which sends `worker_archive_and_shutdown` to every worker (session gets a `status: archived` record appended to its transcript, scheduled jobs cancelled, kernel snapshotted), waits, SIGKILLs process groups that do not exit, removes descriptors, sockets, lease and owner records. Exit code 1 means something was retained; read the lines starting `kept`. A session with **zero messages** is discarded (its transcript file is deleted), not archived.
4. **Verify.**

   ```bash
   bash scripts/prime-runtime-state.sh | sed -n '/== processes/,/worker socket files/p'
   ```

   Expect: no `cli.js` processes, no `rlm.repl` kernels, `daemon.sock: absent`, `worker socket files: 0`. Registry `.owner` dirs for the default socket should be gone.
5. **If `shutdown` itself fails** with `Could not coordinate daemon supervisor registry` or hangs past 30 s, a registry guard or another admission is held by a live pid. Go to section 5.2, then come back.

Time: about 20 s with 20 workers.

---

## 2. Start everything up cleanly

Precondition: section 0 shows no supervisor pid and no ALIVE holders.

1. **Confirm the launcher you are about to run.**

   ```bash
   readlink -f "$(command -v prime-agent)"; prime-agent --version
   ```

   The supervisor and every worker it spawns will run this exact bundle for their whole life. Old clients still running elsewhere would launch *their* bundle instead; that is why step 1 of section 1 matters.
2. **Start the supervisor with zero sessions.**

   ```bash
   node scripts/prime-daemon-start.mjs
   ```

   It prints the spawned pid, then `ready: pid … version … sessions 0` once the hello is served. Cold start is 2 to 20 s; adoption of N leftover descriptors adds roughly 70 ms each.
3. **Verify identity and health.**

   ```bash
   prime-agent status
   node scripts/prime-daemon-wire.mjs hello    # pid, generation, buildId, entrypoint
   tail -3 ~/.prime/agent/logs/daemon.sock.*.log
   ```

   `entrypoint` must be the bundle from step 1. The log's last line must be `... phase=ready ...` followed by `listening on`.
4. **Start the prime-fleet MCP if you use it** (it is not launchd-managed here; the `prime-fleet` entry in `~/.claude.json` expects `127.0.0.1:7717`):

   ```bash
   prime-agent mcp-serve --port 7717 --bind 127.0.0.1
   ```

   Run it in its own Herdr pane. It exits if the daemon is unreachable at start.
5. **Restore sessions** (section 4).

---

## 3. Restart only the supervisor, keeping every worker

Use when the supervisor is wedged or you switched the bundle and want new sessions on the new code without stopping old ones.

- **Same bundle, worker-preserving:** `node scripts/prime-daemon-wire.mjs restart`. The supervisor releases its socket, lease and owner record, spawns a replacement from its own entrypoint, exits; the replacement adopts every live worker (8 at a time). Panes show a brief update-reconnect and come back on their own (120 s budget). Sessions keep their ids. The replacement is spawned from the old supervisor's own `argv[1]` path, so it picks up **whatever files are at that path now**: with a fresh install directory it stays on the old bundle; after reinstalling into the same prefix (section 9 step 8) it comes up on the new code, workers preserved.
- **New bundle, worker-preserving:** re-point the symlink first, then run Prime's update coordinator, which holds the shutdown admission so workers cannot race to relaunch the old bundle:

  ```bash
  ln -sfn ~/.prime/installs/<new>/lib/node_modules/prime-agent/dist/bundle/cli.js /opt/homebrew/bin/prime-agent
  prime-agent update --internal-update-restart-coordinator --daemon-socket "$SOCKDIR/daemon.sock" --internal-update-restart-status /tmp/prime-update-status.json
  ```

  Accept only `phase complete, failed 0` in the status file. Workers keep running the old bundle until each is stopped and resumed; a worker that is not `ready` blocks the coordinator (`Cannot prepare update restart while resident worker … is …`); stop that worker first.
- **Emergency (supervisor hung, workers alive):** `kill -TERM <supervisor pid>`. The SIGTERM handler shuts down without stopping workers. Within about 5 s a worker wins the launch lease and spawns a replacement **from the worker's bundle**; if you want the new bundle instead, run `node scripts/prime-daemon-start.mjs` immediately after the kill so your spawn wins. Verify with `prime-agent list` that every session is back and with `node scripts/prime-daemon-wire.mjs hello` that the entrypoint is what you expect.

Never SIGKILL a supervisor you intend to replace unless the SIGTERM handler is dead too: SIGKILL leaves `daemon.sock.lock` and the `.owner` records for the next supervisor to reclaim (it will, because supervisors have exact identities), but any client mid-command gets an uncertain result.

---

## 4. Restore sessions into Herdr panes

1. **List what was resident when things died.** Parked descriptors keep the root session id even after the process is gone:

   ```bash
   for f in ~/.prime/agent/daemon-workers/*/*.json; do python3 - "$f" <<'PY'
   import json,sys; d=json.load(open(sys.argv[1])); print(d['rootSessionId'], d['lifecycle'], (d.get('lastError') or '')[:50])
   PY
   done
   ```

   Titles: `grep -m1 '"type":"session_info"' ~/.prime/agent/sessions/<uuid>.jsonl`. The pane-to-session map from the last incident is in `HERDR_PRIME_SESSION_INVENTORY_2026-09-02.md`.
2. **Write a plan and run the restore script** (one line per session; see the script's docstring for the three forms):

   ```text
   bugs    pane  w51:p1                     /Users/aelaguiz/workspace/psagentspace 01a05f54-b86e-770a-98b2-b8f356b83823
   growth  new   chatgpt_ads                /Users/aelaguiz/workspace/psagentspace 01a05ece-0927-76f7-ab63-2743e9b75407
   rustai  split w9:p3                      /Users/aelaguiz/workspace/coaching     01a06194-d1be-748d-889e-86feb6bbc440
   ```

   ```bash
   python3 scripts/prime-restore-sessions.py plan.txt --stop-on-failure
   ```

   It does, per line: get or create the pane (`herdr --session <srv> workspace create --cwd … --label … --no-focus`, or `pane split <pane> --direction right --cwd …`), check the pane is at a `zsh` prompt, run `cd <cwd> && aim prime resume ~/.prime/agent/sessions/<uuid>.jsonl` **without `exec`**, wait until the worker descriptor for that root is `ready` with a live pid (3 to 9 s each on 2026-09-02), retry up to three times only on the lookup-timeout error, then pause 8 s before the next one.

   Doing it by hand is the same three commands; the rules that matter are in section 7. Plain resume keeps the account the session was pinned to; never use `--rotate` on a session that is not resident.
3. **Verify each one from the daemon, not the screen:** `bash scripts/prime-runtime-state.sh` lists `WORKER <wid> root=<uuid> ready`; `prime-agent list` shows the session with a worker state; the pane footer shows title, account and branch. The old parked descriptor for that root is reclaimed and replaced. A one-line `Error: Cannot list heartbeats while session worker is starting` in the pane is a transient from the TUI's first heartbeat poll and means nothing.
4. **One at a time, not waves.** Every resume restores a kernel snapshot (a CPU burst and 150 to 500 MB) and re-attaches the root's RLM children as daemon sessions (24 roots became 111 daemon sessions). Five in parallel pushed load to 9 and made the uuid lookup lane time out for the next five.
5. **Mid-turn sessions** come back with a `recovery` marker in the transcript and the last turn possibly incomplete; re-prompt them. Sessions closed by `shutdown --force` carry `status: archived` but resume normally.

Expected errors and what they mean:

| Output in the pane | Meaning | Do |
|---|---|---|
| `AuthorityGuardContentionError: Could not coordinate daemon launch lease` | the launch-lease guard is held by a live pid | section 5.2 |
| `Could not look up active agent '<uuid>': Could not query N background services; … Timed out after 3000ms … "get_state"` | a **uuid** selector goes through the client's 3 s `get_state` lane, which times out whenever the daemon is momentarily busy (kernel restores, child re-attach); the daemon itself answered `Unknown active session` in time | resume by **absolute transcript path** instead (the `list` lane, 30 s); or wait 15 s and retry |
| `Session is already active in <id>` | a live worker already owns that transcript | `prime-agent attach <uuid>` instead |
| `Waiting for a client with fresh runtime context` in `prime-agent list` | parked descriptor; not an error | resuming it is exactly what supplies the context |

---

## 5. Unclean recovery

### 5.1 Everything is dead, leftovers on disk (after a SIGKILL sweep, a crash, or a full disk)

This is the state the 2026-09-02 sweep left: stale `daemon.sock`, `daemon.sock.lock` naming a dead pid, two `.supervisor-launch-*.lock` dirs naming a dead client, `.owner` records for a dead supervisor in both registries, 22 dead worker sockets and 22 parked descriptors.

None of it needs manual deletion. Supervisors and Prime-spawned workers carry exact identities, so every one of those records classifies as exactly dead and the next supervisor reclaims them during its own startup; clients reclaim the launch lease the same way.

1. Prove every recorded pid is dead: `bash scripts/prime-runtime-state.sh | grep -c ALIVE` must print `0`.
2. **Save the list of what was resident before anything else** (section 4 step 1). The parked descriptors are the only record of it, and the next step deletes them.
3. Tidy: `prime-agent doctor --fix`. Observed on 2026-09-02 (19 s): it removed the stale `daemon.sock`, `daemon.sock.lock`, all 22 dead `worker-*.sock` files **and all 22 parked descriptors** of the dead default daemon, and left the two dead-pid launch-lease dirs and the registry `.owner` records for the next launcher and supervisor to reclaim. It never stops or restarts the default daemon.
4. Start: section 2. With descriptors gone the supervisor logs `descriptors_loaded workerCount=0` and is `ready` in well under a second. If you skipped step 3, expect one `Could not adopt worker …: Session worker process is no longer running` per dead descriptor followed by `ready`; those descriptors stay parked (`Waiting for a client with fresh runtime context`) and each is reclaimed when its session is resumed.

What is safe to delete by hand **only when `grep -c ALIVE` printed 0**: `$SOCKDIR/daemon.sock`, `$SOCKDIR/daemon.sock.lock`, `$SOCKDIR/.supervisor-launch-*`, `$SOCKDIR/worker-*.sock`, `$SOCKDIR/supervisor-owners/*.owner`, `$HOMEREG/*.owner`, `$HOMEREG/.guard*`, `$HOMEREG/shutdown-admission.json`, `$HOMEREG/startup-fences/*`, `$HOMEREG/offline-maintenance/*`. Do not delete `$AGENTDIR/daemon-workers` descriptors: they are the list of what was resident (section 4 step 1) and their orphan journals let recovery reap dev servers a dead worker left behind.

### 5.2 A lock names a pid that is ALIVE

This is the wedge that took the fleet down. Pattern: clients fail with `Could not coordinate daemon launch lease`, or replacement supervisors die every 30 s with `Could not coordinate daemon supervisor registry: ~/.prime/supervisor-owners`, while `ps` shows a live holder.

1. Find every holder in one pass:

   ```bash
   bash scripts/prime-runtime-state.sh | grep ALIVE
   ```

   Holders live in: `.supervisor-launch-*.lock/pid`, `.supervisor-launch-*.lock.guard`, `daemon.sock.lock`, `$HOMEREG/.guard`, `$SOCKDIR/supervisor-owners/.guard`, `shutdown-admission.json`, `offline-maintenance/*.json`, `startup-fences/*.json`, and every `daemon-workers/*/*.json`.
2. Identify each live holder. The state script's process table already names the role (SUPERVISOR from the registry, WORKER plus root session id from the descriptors, CATALOG, KERNEL, CLIENT/TUI, AIM-LAUNCHER). `ps` alone does not help: every Prime-spawned process retitles itself to `prime-agent prime-agent-owner-token=<hex>` and hides its argv. For a pid the script does not classify, `ps -o pid,ppid,tty,etime -p <pid>`: `??` tty with ppid 1 is a detached supervisor or worker; a tty with an `aimgr.js prime` parent is a TUI.
3. Decide per holder:
   - **A worker that is idle or whose pane is dead** (transcript's last events are `agent_status`, no tool activity): `kill -TERM <pid>`. It snapshots its kernel, closes sessions, releases its socket and exits; the guard it held is reclaimed by the next contender within 10 ms. The session resumes later by id.
   - **A worker doing real work** (transcript advancing, child processes busy): let it finish if you can wait; otherwise `kill -TERM` anyway. The transcript keeps everything up to the last event; the current turn is lost.
   - **A hung client** (`cli.js --resume …` or `--provider …`, `aim prime …` parent): `kill -TERM` the client. Its launch lease is coarse-identity and is reclaimed only once the pid is gone.
   - **A hung `prime-agent shutdown`/`doctor --fix`/`update` CLI** holding `shutdown-admission.json`: `kill -TERM` it. That file never expires by time.
   - **A pid that is not a Prime process at all** (pid reuse: the record has a token but `ps` shows a shell or editor): the lock is wedged until that process exits; if it is yours, exit it; if you cannot, delete the specific record by hand (`.guard` file, lease dir, owner dir) since the identity check proves it is not the recorded process.
   - **A record that will not parse** (hand-edited, truncated by a full disk, non-canonical whitespace in the `ps:lstart` hint): Prime treats it as held forever even after the pid is gone (T4a′ in the test log). Delete that one file. The launchers retry within 5 s and reclaim normally afterwards.
4. Re-run the state script until `grep -c ALIVE` is 0 or only lists workers you intend to keep. Launchers that are still alive (workers every 5 s, reconnecting TUIs every few seconds) bring the supervisor back on their own within seconds; if none are alive, start it yourself (section 2). With live workers present the new supervisor adopts them (about 300 ms each). Do not run `doctor --fix` in the same breath, because it takes the admission that blocks adoption.

### 5.3 Supervisor alive but nothing answers

Symptoms: `Timed out waiting for daemon worker response to heartbeats_list`, `create` timing out at 120 s, panes reconnecting although `daemon.sock` exists.

1. `tail -20 ~/.prime/agent/logs/daemon.sock.*.log`. If the last startup trace is not `phase=ready`, the supervisor is still adopting (workers 8 at a time, 2 s connect budget each, 3 recovery retries, then up to 10 deferred rounds of 5 s). Wait up to 3 min before judging.
2. If it is `ready` and still unresponsive, or `hello=deferred acceptedDuringStartup=N` keeps printing, check load: `top -l1 | head -12`; `fseventsd` above 100 % or a full disk (`df -h /`) makes every guard `fsync` and `/bin/ps` spawn crawl. Fix the machine first.
3. Otherwise restart the supervisor, keeping workers: `node scripts/prime-daemon-wire.mjs restart`; if the socket does not answer even that within 30 s, `kill -TERM <supervisor pid>` (section 3 emergency path).
4. A supervisor that logged `Daemon socket lease was compromised` closes its server but does not exit; `kill -TERM` it.

### 5.4 Things that look like wedges but are not

- `Waiting for a client with fresh runtime context` on a descriptor: parked, resume it.
- `.guard.release-<token>` or `.guard.publish-<token>` files: inert leftovers, ignorable. Only `.guard.reclaim-<token>` matters (it blocks reclamation of that guard; delete it when no reclaimer is running).
- `.owner` dirs pointing at `/tmp/prime-mcpserve-*.sock` or `/tmp/prime-stale-*.sock` with dead pids: test-run leftovers with a different scope; they do not conflict with the default socket.
- `com.funcountry.prime-cutover.20260820` in `launchctl list` with status 1: a dead launchd job from the August cutover whose plist no longer exists; `launchctl remove com.funcountry.prime-cutover.20260820` to silence it.

---

## 6. What will get you (gotchas, ranked by how often they bit)

1. **Whichever process wins the launch lease spawns the supervisor from its own executable.** After you switch `/opt/homebrew/bin/prime-agent`, every still-running client and worker is a launcher for the old install. On 2026-09-02 a client born the previous evening kept spawning supervisors from the retired `lock-free-reads` bundle. Restart panes after an install switch, or use the update coordinator.
2. **Killing "just the stuck one" relaunches the daemon underneath you.** Workers notice a dead socket within 250 ms, take the launch lease, and spawn a replacement within 5 s; reconnecting panes do the same every few seconds for 60 s. Freeze launchers, then act.
3. **A hung holder is not a dead holder.** The reclaim rule needs the pid gone or an exact-identity mismatch. A wedged worker sitting in a guard blocks every replacement supervisor forever (registry guard, 2026-09-02 10:24 to 11:07).
4. **Shell-launched Prime processes have no exact identity.** They cannot be a supervisor, and locks they leave behind are reclaimed only when the pid disappears.
5. **`doctor --fix` will not fix the default daemon.** It removes orphan socket files and finishes stop-tombstoned workers; it explicitly skips the default socket and anything with sessions. It is not a restart tool.
6. **`prime-agent shutdown` needs the registry guard to take the admission.** If the guard is wedged, shutdown fails before doing anything; unwedge first (5.2).
7. **Adoption failures abort supervisor startup** when a descriptor is malformed or two descriptors claim one worker (`Split worker authority`). A dead worker is fine (parked); a corrupt descriptor file is not. Move the offending file aside, keep a copy.
8. **`mirrorRequired` records need both registries.** macOS purges `$TMPDIR` after 3 days of non-use; if the mirror copy disappears, the running supervisor reports `supervisor_generation_stale` and must be restarted (section 3).
9. **The version prompt is dead code.** A client whose protocol/schema/app version differ from the daemon logs `differs from this client (connecting anyway)` and connects. Nothing replaces an old daemon automatically; only `update` or a restart does.
10. **aim adds nothing on top of Prime here.** `aim prime run|resume` is a foreground `spawnSync` of `prime-agent`; it sets no env, holds no lock, and cannot inspect or restart the daemon. `aim prime run` does rewrite `auth.json` for that provider (new root sessions only), so a throwaway test session should use `prime-agent --provider … --model …` directly.
11. **Routines are launchers too.** `launchd` fires `aim routine run` at 06:00, 07:00, 12:00, 15:00, 17:00 and Mondays; each one does a `--print` pin run and a `--resume`, both of which start a daemon if none is up.
12. **Disk full breaks the guards first, then Spotlight finishes the job.** Every guard claim is `fsync` plus a `/bin/ps` spawn; with `fseventsd` pinned, guard waits reached 40 s and the 30 s command timeouts fired everywhere. Check `df` before blaming Prime. After the disk is freed, `fseventsd` replays its lost journal and Spotlight rebuilds its index of every worktree under `~/workspace`: 33 concurrent `mdworker_shared … MDSImporterWorker`, `fseventsd` at 100 %, 1100 writes/s, load above 60 for the rest of the day while the agents used about 6 cores. Diagnose with `ps -axo etime=,command= | awk '$1 ~ /^0?0:0[0-9]$/'` (what is being spawned right now) and `mdutil -s /System/Volumes/Data` (`unknown indexing state` = rebuilding). Fix: `sudo bash scripts/spotlight-exclude-workspace.sh` (adds `~/workspace` and `~/.prime` to the Spotlight privacy list and restarts `mds`).

---

### 6.x Un-archiving a session and rotating its account (tested 2026-09-03)

- `ctrl+x` in the TUI archives the session: it appends `session_state {status: "archived"}` to the transcript, releases the worker, and **cancels every live heartbeat the root had** (`cancelJobsForSession`, all jobs flip to `cancelled` with that timestamp). Resuming re-marks the transcript `active` but does not restore the heartbeats; the agent has to re-arm them.
- `aim prime resume <uuid> --rotate` on an archived session fails with `Unknown active session`: the credential handoff needs the session live in the daemon roster. Sequence that works, in the pane's own cwd: `aim prime resume /abs/path/<uuid>.jsonl` (plain, no `--rotate`) → wait for the TUI → `ctrl+d` detaches and leaves the worker resident → `aim prime resume <uuid> --rotate` in the same pane (handoff, then reattach by uuid). Verify with the `aimgr_credential_binding_v1` custom record at the end of the transcript.
- Old `Provider usage limit reached (429)` lines stay in the pane scrollback after the rotation; check the transcript for assistant messages after the binding record before concluding the new account also failed.

### 6.y Resume fails with "Could not query N background services; /tmp/prime-agent-forkserver-…/control.sock" (home / Linux, tested 2026-09-03)

- Cause: when the session is not active on the default daemon, `--resume <uuid|path>` fans out to every socket `discoverDaemons()` finds under `$TMPDIR/prime-agent-*` (`cli/daemon-ps.ts` `scanSocketDir`). On Linux that glob also matches the transient Python kernel fork-server dirs (`prime-agent-forkserver-<rand>/control.sock`) and kernel dirs that workers create and delete while spawning children. One ENOENT/ECONNRESET on any of them throws `Could not query N background services` before the resume ever starts a worker (`findActiveDaemonSessionAcrossDaemons`). Nothing is wedged; the daemon and workers are fine.
- Fix: pass the daemon socket explicitly, which disables the fan-out: `prime-agent --daemon-socket /tmp/prime-agent-<uid>/daemon.sock --resume /abs/path/<uuid>.jsonl` in the session's cwd (`aim prime resume` cannot pass extra Prime arguments). Once the worker is resident, plain `aim prime resume <uuid>` works again because the default daemon answers first and no fan-out happens. To hand a session back to the user's own terminal: resume it in a detached `tmux`, wait for the descriptor + live pid, `tmux send-keys C-d` to exit that TUI (worker stays resident, `prime-agent list` shows 0 clients), then the user attaches by uuid.
- Fork fix owed: skip `prime-agent-forkserver-*` and `prime-agent-kernel-*` entries in `scanSocketDir`, and treat per-socket connect failures as "not here" when the default daemon already answered.

## 7. Mass restore, 2026-09-02: what happened and what will bite you

24 sessions across 7 Herdr servers were restored between 11:52 and 12:12 CDT. The first ten went in two waves of five by uuid and worked. The next thirteen were launched with `exec aim prime resume <uuid>` while ten kernels were still restoring; every one of them died on the uuid lookup timeout, and because of `exec` the shell died with the TUI, Herdr closed the pane, and ten single-pane workspaces vanished. They were recreated with their original labels and cwds and resumed one at a time by absolute path; all thirteen succeeded on the first attempt.

**Herdr**

1. **Never `exec` the resume in a pane.** When `aim` exits, an exec'd pane's process is gone, Herdr closes the pane, and a single-pane workspace disappears with it. Run `cd <cwd> && aim prime resume <path>` as a child; on failure the prompt comes back with the error still on screen.
2. **Pane ids are not stable across recreation** (`w1F:p2` became `w1F:p3`, workspaces got new ids). Re-list before every step; never reuse ids from an old inventory without checking `pane process-info`.
3. **Screen text lies.** `pane read --source recent` and `wait-output` (default `recent`) search scrollback that still holds yesterday's errors; `--source visible` still shows the old content until the new TUI redraws. Judge success by the worker descriptor and failure by `pane process-info` showing only `zsh` in the foreground.
4. **Address servers explicitly**: `herdr --session <name> …` for `bugs`, `content`, `cratejoy`, `growth`, `pvai`, `rustai`, `tools`. The Herdr MCP tool in Claude Code only sees the session it was started in (`tools`). `herdr session list` shows which are running.
5. **Key names are `ctrl+c`, `esc`, `enter`**; `ctrl-c` is rejected with `unsupported key`.
6. **`workspace create --cwd … --label … --no-focus`** returns `.result.root_pane.pane_id`; `pane split <pane> --direction right --cwd … --no-focus` returns `.result.pane.pane_id`. Wait about a second before sending a command to a new pane.
7. **Scheduled routines keep firing while you restore.** The 12:00 Reddit sweep created its own `growth` workspace and session in the middle of the run; expect extra `AIM routine binding check` sessions in `prime-agent list`.

**Prime**

8. **Resume by absolute transcript path, not uuid, when the daemon is loaded.** The uuid goes through the client's 3 s `get_state` lane (`Could not look up active agent … Timed out after 3000ms`), the path through the 30 s `list` lane. This needs the `path-resume-fix-20260902` bundle or later.
9. **Daemon session count is not root count.** Each resumed root re-attaches its RLM children; 24 roots showed as 111 sessions. Count roots from `daemon-workers/<sid>/*.json`.
10. **`Error: Cannot list heartbeats while session worker is starting`** appears once in a freshly resumed pane and is harmless.
11. **Load is the real limiter.** Five simultaneous resumes took the machine to load 9 and broke the next five; one at a time with an 8 s gap never failed.

**Shell scripting from an agent on this Mac**

12. **The Bash tool runs zsh**: `set -- $line` and `for x in $var` do not word-split; `$(grep -l …)` in a `for` loop yields one string. Use `read -r a b c` or Python.
13. **`/bin/bash` is 3.2**: no `mapfile`, no associative arrays, no `${var,,}`. Anything beyond a loop belongs in Python (`scripts/prime-restore-sessions.py` is the template).
14. **`ps` hides Prime argv** (see reference §1.1); classify by registry and descriptors.
15. **Prompt detection is fragile**: the zsh prompt here is two lines and the `❯` line is often trimmed from `visible`; use `pane process-info` instead.

## 8. Test log, 2026-09-02 (this machine, bundle `path-resume-fix-20260902`, app 0.9.1)

Starting state at 11:30 CDT: zero Prime processes after the 11:11 SIGTERM/SIGKILL sweep; stale `daemon.sock`; `daemon.sock.lock` naming dead pid 12807; two launch-lease dirs naming dead client 41464; `.owner` records for dead supervisor 12807 in both registries; 22 dead `worker-*.sock`; 22 parked descriptors (`lifecycle: failed`, `Waiting for a client with fresh runtime context`).

| # | Scenario | Steps run | Result |
|---|---|---|---|
| T1 | Unclean recovery, everything dead (5.1) | state script → `grep -c ALIVE` = 0; `prime-agent doctor --fix` (19 s); `node scripts/prime-daemon-start.mjs` | doctor removed socket, socket lock, 22 worker sockets and all 22 descriptors, kept lease dirs and owner records. Supervisor pid 49271 `ready` **151 ms** after spawn, `current`, entrypoint = current bundle, 0 sessions. Owner records for the dead supervisor were reclaimed by the new one. |
| T2 | Resident throwaway session | Herdr pane in `tools/wV`; `prime-agent --provider openai-codex --model gpt-5.6-sol` | session `01a062fb…` on pro2, worker + kernel resident, `prime-agent list` shows it. |
| T3 | Supervisor SIGTERM, keep workers (3) | `kill -TERM 49271` | Replacement pid 52247 spawned **within 1 s by the TUI client** (`launchTrigger: ensure_daemon_running`, not by the worker), adopted the worker in 322 ms, `ready` at 687 ms. Worker 50266 never died; pane unchanged. |
| T4a | Launch-lease guard wedge, holder alive (5.2) | planted `.supervisor-launch-<sid>.lock.guard` owned by a live `sleep`; `kill -KILL` supervisor | Worker log every 7 s: `failed to launch replacement supervisor: AuthorityGuardContentionError: Could not coordinate daemon launch lease`. Pane: `Daemon connection lost; reconnecting…`. `status` = `unreachable` (tracked worker alive). State script showed the guard file. |
| T4a′ | Same, holder dead but record malformed | killed the `sleep`; record's `ps:lstart` hint had a double space | **Not reclaimed after 40 s.** An unparseable record is treated as held forever. Fix is manual: delete that `.guard` file. |
| T4b | Same, holder dead, record valid | rewrote the hint in canonical form | Reclaimed in **1 s**; client relaunched supervisor 65224; worker adopted; pane intact. |
| T4c | Registry guard wedge (the 10:24 incident) | planted `~/.prime/supervisor-owners/.guard` owned by a live `sleep`; `kill -KILL` supervisor | Client relaunched a supervisor every ~13 s; each died after ~9.7 s with `Daemon supervisor startup failed: AuthorityGuardContentionError: Could not coordinate daemon supervisor registry`. State script: `.guard pid=65896 -> ALIVE`. Killed the holder → the in-flight replacement (76316) acquired the registry within 1 s, adopted the worker, `ready` at 8.9 s. |
| T5 | Clean shutdown (1) | `prime-agent shutdown --force` | `stopped background service (pid 76316)` in **4.7 s**, exit 0. Afterwards: no supervisor/worker/kernel, `daemon.sock` absent, worker sockets 0, launch-lease dirs and default `.owner` records removed, descriptor dir emptied. The TUI stayed open showing `The daemon stopped this agent session…` until its pane was closed. The throwaway session had 0 messages, so its transcript was **discarded, not archived**. |
| T6 | Clean start + restore (2, 4) | `node scripts/prime-daemon-start.mjs`; `herdr --session pvai pane run w15:p1 "cd ~/workspace/psagentspace && exec aim prime resume 01a06297-612d-769b-9ece-89b500064cf5"` | Supervisor 80899 `ready` in 134 ms. Resume: TUI loaded the 3.5 MB transcript (~4 s at 100 % CPU), worker 81763 `ready` 588 ms after create, `prime-agent list` shows the session with 149 messages on pro2, transcript got `session_state: active`, pane shows the prompt with 217k (80 %) context. |

Not exercised: `prime-agent update --internal-update-restart-coordinator` (section 3, new-bundle path) and the `restart` wire command; both are documented from code, not from a run.

Corrections the tests forced into this runbook: `doctor --fix` deletes parked descriptors (5.1); `ps` shows Prime processes as `prime-agent prime-agent-owner-token=<hex>` with no argv, so roles must come from the registry and descriptors (the state script does this); a malformed guard record is a permanent wedge; the TUI, not the worker, usually wins the relaunch race; Herdr key names are `ctrl+c` style (`herdr --session <s> pane send-keys <pane> ctrl+c`).

## 9. Full stop, install from `main`, restore: what actually worked on 2026-09-02 evening

This is the procedure that survived contact, in order. It replaces the deploy sketch in section 3 for the "new bundle, everything restarted" case.

**Before touching anything: inventory every pane, three ways.** Footers on the visible or scrollback screen (`session-id: <uuid>`), the launcher argv still alive in the pane (`ps -o command= -p <foreground pid>` shows `aimgr.js prime resume <uuid>`; a `prime run` pane has no uuid), and the worker descriptors (`rootSessionId`). Save it to a file. Panes whose TUI sits on the alternate screen show no footer in scrollback; the argv is the only record for them. A `prime run` pane whose session had zero messages leaves nothing: shutdown discards empty sessions.

1. **Graceful stop.** `node scripts/prime-daemon-wire.mjs shutdown` (no `--force`): workers get 5 s to archive and snapshot kernels. Watch `ps` for the owner-token processes to drain. Expect a **relaunched supervisor**: a worker that has not yet exited notices the socket close and spawns a replacement from its own bundle (`launchTrigger: worker_supervisor_recovery`). That is why the second pass exists.
2. **Kill what the worker shutdown leaves behind.** Detached grandchildren of tool shells survive: two `cargo test` binaries at 1100 % CPU had load at 796. `ps -r | grep -E "cargo|rustc|target/release|flutter"`, then `kill -TERM` the binary and its `cargo` parent.
3. **Stop the clients, knowing which panes it will close.** TUIs that received `daemon_closing shutdown` stay open and do not relaunch; TUIs in `reconnecting…` do relaunch. Stopping them all is the only way to be sure. **Any pane whose shell was replaced by `exec aim prime resume` dies with its launcher and Herdr closes the pane, and a single-pane workspace with it.** Nine workspaces went that way tonight. Check first: `herdr --session <s> pane process-info --pane <p>`; if the foreground list has no `zsh`, that pane will close. There is no clean way to keep such a pane through a full stop; write down its label and cwd and recreate it after.
4. `prime-agent shutdown --force` for the relaunched supervisor, then `bash scripts/prime-runtime-state.sh`: 0 Prime-spawned processes, 0 kernels, 0 TUIs, 0 ALIVE holders.
5. **Build, then pack, then install.** `scripts/pack-prime-agent-release.mjs` does **not** build; it packs whatever `dist/bundle` holds and only errors if `dist` is missing. Tonight it happily packed a Sep 1 bundle from a checkout that had just merged twelve commits. Sequence from `~/workspace/prime-agent` on `main`:

   ```bash
   npm run build                                   # tsgo per package, then the bundle; prints the new bundle-v1 id
   OUT=$PWD/packages/coding-agent/release/main-$(git rev-parse --short HEAD)
   node scripts/pack-prime-agent-release.mjs --out-dir "$OUT" --base-url "file://$OUT"
   mkdir -p "$OUT/releases/v0.9.1" && cp "$OUT"/artifacts/*.tgz "$OUT/releases/v0.9.1/"   # the specs point at <base-url>/releases/v<ver>/
   npm install -g --no-audit --no-fund --prefix ~/.prime/installs/main-<sha> "$OUT/releases/v0.9.1/prime-agent-0.9.1.tgz"
   grep -o 'bundle-v1:[0-9a-f]*' ~/.prime/installs/main-<sha>/lib/node_modules/prime-agent/dist/bundle/cli.js   # must differ from the old install
   ln -sfn ~/.prime/installs/main-<sha>/lib/node_modules/prime-agent/dist/bundle/cli.js /opt/homebrew/bin/prime-agent.new && mv -f /opt/homebrew/bin/prime-agent.new /opt/homebrew/bin/prime-agent
   ```

   Compare the build id against the previous install before trusting anything else; identical ids mean you packed the old bundle. The husky hook and `npm run check` are not part of this.
6. **Every fix that matters must be on `main`.** The absolute-path resume fix (`fix/path-resume-probe-timeout`, cherry-picked to `main` as `748188587` tonight) was only ever installed from a side branch; a build from `main` silently lost it, and every resume then failed on the 3 s `get_state` lane as soon as the daemon held more than about a hundred sessions. If a bundle was built from a branch, its fixes are not in `main` until someone merges them.
7. **Start with zero sessions and prove the build.** `node scripts/prime-daemon-start.mjs`, then `node scripts/prime-daemon-wire.mjs hello` and read `buildId` and `entrypoint`.
8. **Hotfix without stopping workers.** Reinstalling into the *same* prefix path and sending `node scripts/prime-daemon-wire.mjs restart` picks up the new supervisor code (the replacement is spawned from the same entrypoint path, which now holds new files) while every worker and session stays up. New TUIs launched afterwards get the new client code. Used tonight to add the path-resume fix under 16 live sessions.
9. **Restore one pane, look at it, then the rest.** `scripts/prime-restore-sessions.py` with a one-line plan: pane at a `zsh` prompt, `aim prime resume <absolute transcript path>` as a child (never `exec`), wait for the worker descriptor to be `ready`. Verify the footer, `prime-agent list`, and a 2 s `sample` of the new TUI (no `lstat` leaf). Then the same script on the rest, `--stop-on-failure`. Closed workspaces are recreated by label with `new <label_with_underscores>` rows; new ids are assigned, so re-list before addressing anything.
10. **Retire the rest only after everything runs from the new install.** `ps -axo command= | grep installs/<old>` must be empty (it will be, since the whole stack was restarted), then delete the old `~/.prime/installs/*` and `git worktree remove` the branch worktree. `main-c8bc030` is now the only install.

Numbers after the restore (28 roots, 253 daemon sessions, 28 TUIs attached, 4 working): TUI clients 0.5 % CPU total (418 % before the fixes), workers 0.2 % (213 %), supervisor 0 %, no `lstat` or `posix_spawn` in any sample, zero heartbeat fan-out admissions since the restart.
