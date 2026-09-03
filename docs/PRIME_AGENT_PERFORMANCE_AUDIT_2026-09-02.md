# Prime Agent performance audit, 2026-09-02

Where the Prime Agent fork (`~/workspace/prime-agent`, fork commit `918d049ad`, app 0.9.1, bundle `path-resume-fix-20260902`) burns CPU and disk that it does not need to, split by process role. Findings come from four parallel source audits (supervisor, worker, TUI client, cross-cutting) plus live measurements taken on this machine (Amir-M5, 18 cores) while 32 TUIs, 12 workers and 231 daemon sessions were resident and 38 sessions were working.

Fix plan and before/after proof: `docs/aelaguiz/PRIME_IDLE_WASTE_FIX_PLAN_2026-09-02.md` on branch `perf/idle-waste-20260902` of the Prime fork (worktree `~/workspace/prime-agent-worktrees/perf-fix-20260902`).

Companion docs: [PRIME_AGENT_CONTROL_PLANE_REFERENCE.md](PRIME_AGENT_CONTROL_PLANE_REFERENCE.md), [PRIME_AGENT_OPERATIONS_RUNBOOK.md](PRIME_AGENT_OPERATIONS_RUNBOOK.md).

---

## 0. What was measured (17:00 to 17:45 CDT)

| Layer | Processes | CPU now (real-time `top`) | What the samples show |
|---|---|---|---|
| Supervisor (pid 80899) | 1 (+1 catalog) | 5 % | `hello` round trip 89 ms, `list` under 1 s, zero `daemon_registry_guard_timing` events in 10 min. Healthy. |
| Workers | 12 resident, hosting 231 sessions | 213 % total (13 to 23 % each) | Main thread mostly waiting; CPU is agent turns. Prime bookkeeping (fence polls, heartbeat admissions) blocked each worker 1.5 to 7.5 s per 5 min (0.5 to 2.5 %). |
| TUI clients | 32 attached | 418 % total (about 13 % each) | `sample` of three TUIs: about 30 % of main-thread samples are inside `lstat` reached via `Builtins_RunMicrotasks → node::fs::LStat`; JS execution is negligible. A directory walk with one `lstat` per entry runs continuously. |
| Kernels (`rlm.repl`) | 134 | 18 % total | Idle unless a tool runs. |
| Machine | | load 43 to 65 | `fseventsd` 100 to 126 % and 33 to 37 `mdworker_shared` importers: Spotlight and FSEvents rebuilding after the morning's full disk. 1100 to 2000 writes/s, 400 to 4600 reads/s. |

Other measured rates:

- `/bin/ps -p <pid> -o command=` takes 40 ms on this loaded box (normally about 10 ms). Prime spawns it for every process-identity check.
- `heartbeats_list` admissions across all workers: 123 to 639 per minute (each admission runs a supervisor-claim check that spawns `ps`, 100 to 230 ms each). 216 `Could not list heartbeats from a worker: Timed out` lines in 3000 supervisor log lines.
- Supervisor log: 300 to 400 lines per minute, dominated by relayed worker stderr (`Worker fence phase=…`, `Worker command admission …`).
- Worker fence checks over 100 ms in the last 5 min: essentially zero now that load dropped; 100 to 160 ms each earlier in the day.
- `~/.prime/agent/logs/processes`: 3378 files, 1 GB. Every Prime process appends a `process_heartbeat` record every 60 s.
- Footer git refresh: `git rev-parse HEAD` and `git branch --show-current` via `spawnSync` on every `.git` change (cheap individually; agents change `.git` constantly).
- aim footer extension (`~/.prime/agent/extensions/session-title-footer.ts`): `setInterval` every 1000 ms in every TUI, iterating `ctx.sessionManager.getEntries()`.

Verdict after the four source audits (this corrects the first-pass reading that "supervisor and workers are fine"):

- **Supervisor:** responsive today, but it is the box-wide ceiling. Every protocol command spawns `/bin/ps` synchronously (two for mutations), every mutating command costs 2 to 3 `fsync`s, every worker state change costs 1 `ps` + 5 `fsync`, and every worker stderr line is relayed through a sync log write. With 40 ms per `ps` that caps the whole machine at roughly 25 to 120 commands per second shared by all clients.
- **Workers:** not fine at idle. A summarizer bug appends an empty `agent_status` record to every session every 25 s forever (36,982 empty status records across 25 transcripts, more than the 29,258 real messages), and each append takes two exclusive `proper-lockfile` locks on the single shared `settings.json` with a busy-spin on contention. A profiled worker spent 64 % of its main thread in `lstat` inside those lock protocols. Add the 250 ms fence poll (48 `ps` spawns per second fleet-wide at idle) and the orphan journal that re-parses itself twice per subprocess with 6 `fsync`s and 4 `ps` forks.
- **TUI clients:** the continuous `lstat` is `fs.realpathSync` in `reconcileUnifiedSessions` (`modes/agents-view/agents-view-state.ts:190`), run once per roster entry and once per saved session on every `roster_update` and `heartbeats_changed` push, about 2,200 syscalls per pass and nothing memoized. The agents-view also polls `heartbeats_list` every 15 s, which the supervisor fans out to every worker, and every heartbeat change makes all 32 clients re-poll at once (384 worker RPCs per change).
- **Disk:** everything above is amplified by the Spotlight and FSEvents rebuild that followed the morning's full disk; that part is not Prime and is handled in the runbook.

---

## 1. Supervisor

Source: Opus 5 audit of `daemon-supervisor.ts`, `daemon-supervisor-ownership.ts`, `daemon-worker-cleanup.ts`, catalog/roster/journal modules and the shared guard and identity code. Measured context: 12 workers (W), 32 clients (C), 231 sessions (N).

Repo: `/Users/aelaguiz/workspace/prime-agent`, package `packages/coding-agent`.
All paths below are relative to `packages/coding-agent/src/`.

Scenario modelled throughout: **C = 32 attached TUI clients, W = 12 resident workers, N = 231 roster/daemon sessions.**

Everything here is read off the code. Where I could not prove a rate from the code I say so.

---

### Top 10, ranked by how badly cost grows with N

| # | Finding | file:line | Scaling formula | Cost at 32/12/231 | Sev |
|---|---|---|---|---|---|
| 1 | `heartbeats_list` fan-out: 1 client command → 1 RPC per worker; agents-view polls it every 15 s **and** every worker heartbeat change re-triggers it on all clients | `modes/daemon/daemon-supervisor.ts:2492-2538`; poll `modes/agents-view/agents-view-mode.ts:102,893`; amplifier `daemon-supervisor.ts:6681-6684` + `7832-7836` + `modes/daemon/daemon-mode.ts:705-708` | poll: `C/15s × W`; event: `C × W` per heartbeat change | 1,536 worker RPCs/min steady + 384 per change | critical |
| 2 | Every daemon command spawns `/bin/ps` synchronously (ownership self-identity check), mutating commands spawn 2 | `daemon-supervisor.ts:1960,2050,2061` → `1297-1316` → `daemon-supervisor-ownership.ts:275-285,1524-1540` → `core/session-lease.ts:890-898,781-821,743-766,410-412` | `commands/s × 1..2 × 40 ms` blocked | 2.1 cmd/s from the heartbeat poll alone = 85 ms/s blocked; realistic mixed load 25 cmd/s = **1–2 s blocked per wall second** | critical |
| 3 | `persistWorker` = 1 more `/bin/ps` + ~5 `fsync` + ~20 sync syscalls, every worker state change | `daemon-supervisor.ts:1465-1515` → `modes/daemon/daemon-worker-cleanup.ts:831-846,195-213,165-177,154-159,770-829` + `core/authority-mutation-guard.ts:299-345,413-451` | `worker state transitions × (1 ps + 5 fsync)` | a 12-worker reconnect cascade = 36+ ps spawns and 180 fsyncs, all on the loop | critical |
| 4 | Command journal `fsync`s twice per mutating command (3× with ack) | `modes/daemon/command-recovery-journal.ts:174-184`, called at `daemon-supervisor.ts:2014,2051,2062,2116` | `2–3 fsync × mutating cmd/s` | 20 mutations/s → 40–60 fsync/s = 40–600 ms/s blocked | critical |
| 5 | Every supervisor log line = `existsSync` + `statSync` + `appendFileSync` (+ `console.error`), and **every worker stderr line is relayed through it** | `daemon-supervisor.ts:1012-1016`, `config.ts:600-616`, relay at `daemon-supervisor.ts:3607-3612` | `4 sync fs syscalls × (worker stderr lines/s × W)` | the "Worker fence phase=…" lines are pure supervisor-loop tax; 16k-line daemon log observed | critical |
| 6 | `process-lifecycle` writes every event synchronously (`mkdir`+`exists`+`stat`+`append`) and keeps one JSONL per process for 14 days, pruned only at process start by a full `readdir`+`stat` sweep | `core/process-lifecycle.ts:361-371,351-359,420-433,28,647-650,651`; slow-`ps` feedback at `core/session-lease.ts:435-448` | `4 sync syscalls × lifecycle events/s`; prune = `O(files)` statSync at each of W+1 process starts; heartbeat = `processes × 1/60 s` | 3,378 files / 1 GB observed → 3,378 `statSync` per process start; ~46 processes × 1 heartbeat/min | critical |
| 7 | Idle-eviction sweep runs at least every 60 s and costs `2–3 × W` worker RPCs plus `O(W·N + N·C)` CPU **even with every session idle** | `daemon-supervisor.ts:1083-1097,1123-1199,1099-1121,701-707` | per sweep: `2–3·W` RPCs + `W·N` roster scans + `N·C` client scans | 24–36 RPCs + ~10,200 iterations per minute at zero user activity | high |
| 8 | `AgentRoster.entriesForWorker` is a full `O(N)` array scan, called once per worker inside per-worker loops → `O(W·N)` | `modes/daemon/agent-roster.ts:195-197`; callers `daemon-supervisor.ts:5379-5381,1107,1280,5658,5667,5683,5697,5351,5239,6052` | `O(W·N)` per sweep, `O(N)` per attach/detach | 2,772 iterations per eviction sweep; 231 per detach | high |
| 9 | `list` recomputes `publicSummary` → `attachedClientCount` (a fresh `[...this.clients]` spread + filter) for every roster row | `daemon-supervisor.ts:2857-2872,5960-5968,5953-5958` | `O(N·C)` per `list`, plus `N` array spreads | 7,392 client-set iterations + 231 spreads of a 32-element Set per `list` | high |
| 10 | `findWorker` miss fans a `list` RPC to **every** worker, then rewrites `O(N_w)` roster rows each, each firing a roster push to all clients | `daemon-supervisor.ts:5970-5982`, `5023-5064`, `5648-5655`, `5333-5344` | per miss: `W` RPCs + `O(N)` roster writes + `O(C)` pushes | one stale session id from one TUI = 12 worker RPCs + 231 roster writes + 32 socket writes | high |

---

### Critical

#### C1 — `heartbeats_list` fan-out storm (the measured 123–639/min)

**Where.** `modes/daemon/daemon-supervisor.ts:2492-2538`. With no `activeSessionId` the supervisor builds `workers = [...this.workers.values()]` and `Promise.all`s a `heartbeats_list` RPC to every worker with a 5 s timeout (`2505`). It already keeps `worker.heartbeatSnapshot` / `worker.heartbeatSnapshotStale` (`2510-2511`, invalidated at `6682`) but **only consults the cache when the live RPC fails** (`2519-2521`).

**Three independent triggers:**

1. **Unconditional 15 s poll.** `modes/agents-view/agents-view-mode.ts:102` (`HEARTBEAT_POLL_INTERVAL_MS = 15000`) and `:893` `setInterval(() => void this.refreshHeartbeats(), …)`. `refreshHeartbeats` (`:2245-2266`) calls `listDaemonHeartbeats(this.requireClient())` with no session id → global fan-out.
2. **Event amplifier.** Any worker's cron store fires `onHeartbeatChange` → `broadcastGlobal({type:"heartbeats_changed"})` (`modes/daemon/daemon-mode.ts:705-708`) → supervisor `handleWorkerFrame` relays it (`daemon-supervisor.ts:6681-6684`) → `broadcastHeartbeatsChanged()` writes to **all** clients (`7832-7836`) → each agents-view (`agents-view-mode.ts:855`) and each interactive TUI (`modes/interactive/interactive-mode.ts:5224-5225`) immediately re-issues `heartbeats_list`.
3. **Attached interactive sessions also fan out globally.** `modes/agent-connection/daemon-agent-connection.ts:784` passes an `activeSessionId` only for `ownedSession`; a normal daemon-attached TUI passes `undefined` → global fan-out.

**Scaling.**
- Steady state (idle machine): `C_agentsview × (1/15 s) × W` worker RPCs. At C=32, W=12 → **25.6 RPC/s = 1,536/min = 128/min per worker**, matching the observed 123–639/min band.
- Per heartbeat change: `C × W = 384` worker RPCs in one burst.
- Supervisor cost per command additionally includes one `/bin/ps` (see C2) → the poll alone is 2.1 ps/s.

**Failure amplification.** `2528-2531`: if *any* worker's response fails, the whole aggregated response is a failure for that client. A single wedged worker turns all 32 clients' polls into 5 s hangs and the observed "Could not list heartbeats from a worker: Timed out" spam (`2514`), each line paying the C5 log cost.

**Fix.** Serve `heartbeats_list` from the supervisor's own `worker.heartbeatSnapshot` catalog; only RPC the workers whose `heartbeatSnapshotStale === true`, and single-flight that refresh so 32 concurrent client requests share one fan-out. Debounce `broadcastHeartbeatsChanged` (~1 s) and delete the client-side 15 s poll — the `heartbeats_changed` event already exists.

#### C2 — One synchronous `/bin/ps` per daemon command

**Chain.** `handleLine` calls `assertServingCurrentOwnership()` for every command (`daemon-supervisor.ts:1960`) and again for journaled mutations (`2050`, `2061`). That reaches `assertCurrentOwnership` (`1297-1308`) → `DaemonSupervisorOwnership.assertCurrent` (`daemon-supervisor-ownership.ts:275-285`) → `assertSelfOwnedAuthority` (`:1524-1540`) → `matchesExactProcessIdentity` (`core/session-lease.ts:890-898`) → `observeProcessIdentity` (`:781-821`) → on darwin `observeDarwinProcessIdentity` (`:743-766`) → `boundedProcessQuery` → `execFileSync("/bin/ps", ["-ww","-o","command=","-p",pid], …)` (`:410-412`).

`assertRecoveryAllowed` (`daemon-supervisor.ts:1318-1324`) adds another per recovery step, and `withRegistryGuards` calls `currentProcessIdentityFields()` → yet another `observeProcessIdentity` (`daemon-supervisor-ownership.ts:669`, `:1517-1522`).

**Why this is pure waste.** The pid being probed is **the supervisor's own pid**. A process's own start identity cannot change while it is running. `core/session-lease.ts:967-972` already contains exactly the right memo (`getCurrentProcessIdentityObservation`) — but it is only used by `withLeaseGuard`, never by `matchesExactProcessIdentity`/`classifyProcessIdentityAuthority`.

**Scaling.** `ps spawns/s = commands/s × (1 for reads, 2 for mutations)`. Each spawn is a fork/exec of `/bin/ps -ww` that walks the whole process table; the code itself records timings ≥100 ms (`core/session-lease.ts:436-448`), i.e. the authors already saw this go slow. At the operator's reported ~40 ms and a modest 25 cmd/s, this is **1–2 s of blocked event loop per wall second** — the supervisor cannot keep up regardless of anything else.

**Fix.** Memoize `observeProcessIdentity(process.pid)` process-wide (reuse `getCurrentProcessIdentityObservation`). For foreign pids, cache the observation keyed by `pid + expected startId` with a ~5 s TTL and a `processIdExists(pid)` (kill(0)) fast path before the `ps`.

#### C3 — `persistWorker` = 1 `ps` + ~5 `fsync` + ~20 sync syscalls

**Chain.** `daemon-supervisor.ts:1465-1515`:
- `1471` `readCanonicalDaemonWorkerDescriptor` → `daemon-worker-cleanup.ts:476-520` → `lstat` + `open` + full `read` + `JSON.parse` + two `assertDirectory` stats.
- `1501` `persistDaemonWorkerDescriptorAtomically` → `daemon-worker-cleanup.ts:831-846`. **When no `mutationGuard` is passed** it goes through `withDaemonWorkerMutationGuardSync` (`:195-213`) → `acquireDaemonWorkerMutationGuardOnce` (`:165-177`) → `daemonWorkerGuardIdentity()` (`:154-159`) → **another `observeProcessIdentity(process.pid)` = another `/bin/ps`**.
- Guard publish: `core/authority-mutation-guard.ts:299-345` — `openSync` + `writeAllSync` + `fsyncSync` + `chmodSync` + `fstatSync` + `linkSync` + `lstatSync` + `readBoundedDescriptor` + `unlink` + `fsyncDirectory`.
- Descriptor write: `daemon-worker-cleanup.ts:770-829` — `openSync` + `writeFileSync` + `fsyncSync` + `chmod` + 2× `lstat` + `renameSync` + `fsyncDirectory`.
- Guard release: `core/authority-mutation-guard.ts:413-451` — `link` + 2× `lstat` + `read` + `unlink` + `fsyncDirectory`.

Most call sites pass **no** guard: `2421` (`retry_worker`), `3345` (`promoteOwnedWorker`), `4203`, `4231`, `4248`, `4283`, `4318`, `4391`, `4420`, `4457`, `4649`, `4724`, `4761`, `4818`, `4844`, `4866`, `4881`, `6198`, `7561`, `7825`.

**Scaling.** `(1 ps + ~5 fsync) × worker lifecycle transitions`. Idle cost is zero, but every disconnect/recovery round persists 2–4 times per worker (`recoverWorker` `4644-4898` persists on each of 3 retry rounds), so a 12-worker cascade is 36–144 ps spawns and 180–720 fsyncs, serialized on the loop.

**Fix.** Thread the already-held mutation guard through the persist calls that have one in scope, and memoize `daemonWorkerGuardIdentity()` the same way as C2.

#### C4 — Two `fsync`s per mutating command

`modes/daemon/command-recovery-journal.ts:174-184` — `append()` does `openSync` + `writeSync` + **`fsyncSync`** + `closeSync` + `chmodSync`, with no batching. It runs from `begin()` (supervisor `2014`), `recordResult()` (`2051`, `2062`) and `acknowledge()` (`2116`). `compact()` (`:186-216`) additionally rewrites the whole journal plus a directory `fsync` once every `COMPACT_AFTER_RECORDS = 4096` records (`:42`).

**Scaling.** `2–3 fsync × mutating commands/s`, independent of N but multiplied by C because every client's prompts/steers/aborts are mutations. An APFS `fsync` under a loaded machine is 1–10 ms, so 20 mutations/s = 40–600 ms/s of blocked loop.

**Fix.** Group-commit: accumulate journal records in a buffer and do one `write`+`fsync` per event-loop turn (`setImmediate` flush), resolving the awaiting commands after the flush. At minimum drop the `fsync` on the `received` record — a lost `received` degrades to "command not seen", which the protocol already tolerates.

#### C5 — Logging is synchronous and worker stderr is relayed line-for-line

`daemon-supervisor.ts:1012-1016`:
```ts
private log(message: string): void {
    console.error(message);
    structuredLog.warn(message, { socketPath: this.socketPath });
    appendRotatingLog(getDaemonLogPath(this.socketPath), …);
}
```
`appendRotatingLog` (`config.ts:600-616`) does `mkdirSync` + `existsSync` + `statSync` + `appendFileSync` **on every line**.

`daemon-supervisor.ts:3607-3612` attaches a JSONL line reader to each worker's stderr and pushes **every line** through `this.log()` as `Session worker <id> stderr: <line>` — this is where the "Worker fence phase=…" flood lands. There is no level filter and no rate limit.

Additional per-event log volume: `traceSupervisorStartup` (`1018-1040`) and `traceWorkerStartup` (`1042-1069`) each do a `log()` **and** a `recordProcessLifecycle()` (C6), and `launchWorkerWithGuard` emits ~18 of them per worker launch (`3418`, `3422`, `3506`, `3562`, `3686-3695`, `3742`, `3746`, `3818`, `3839-3844`, `3852-3877`, `3894`).

**Scaling.** `4 sync fs syscalls × (stderr lines/s summed over W workers + supervisor log lines/s)`. Log volume grows linearly with W and with recovery churn; the observed 16k-line daemon log is 64k sync syscalls of pure overhead.

**Fix.** Keep one open append fd per log file with a 250 ms buffered flush and a rotation `stat` at most once a minute. Relay worker stderr at debug level behind an env flag, or rate-limit to N lines/s per worker. Log fence/stage timings only above a threshold (e.g. 500 ms).

#### C6 — `process-lifecycle` journaling: sync writes, unbounded files, per-process heartbeat

- **Sync write per event.** `core/process-lifecycle.ts:361-371` `appendEventLine` → `mkdirSync` + `rotateOwnProcessLog()` (`:351-359`: `existsSync` + `statSync`) + `appendFileSync`. `recordProcessLifecycle` is called from ~30 supervisor sites, including every recovery attempt (`daemon-supervisor.ts:4667`, `4726`, `4790`, `4845`, `4883`), every launch stage (`1060`), every worker close (`3626`), every connection close (`4334`).
- **Feedback loop.** `core/session-lease.ts:435-448` — any `ps` probe that takes ≥100 ms writes a `process_identity_query_timing` event, i.e. 3 more sync fs syscalls. Under load, slow `ps` calls make themselves slower.
- **Unbounded growth.** One `<processInstanceId>.jsonl` per process instance (`:106`), retained 14 days (`:28` `PROCESS_LOG_RETENTION_MS`). `pruneStaleProcessLogs` (`:420-433`) runs **once per process start** via `setImmediate` (`:651`) and does `readdirSync` + a `statSync` per file. Observed 3,378 files / 1 GB → **3,378 blocking `statSync` calls at every supervisor and every worker start**, i.e. 12× at a fleet restart.
- **Idle heartbeat.** `:647-650` `setInterval(() => writeEvent("process_heartbeat", {}, {includeResources:true}), 60_000)` per process. With 12 workers + supervisor + catalog + 32 clients ≈ 46 processes, that is 46 sync `mkdir+exists+stat+append` sequences per minute across the machine, plus 46 files/min of growth, with **zero** user activity.

**Fix.** Buffer lifecycle events per process and flush on an interval. Prune by file count (keep newest K) not by age, at most once per day, guarded by a marker file so 12 workers do not each re-scan. Raise `HEARTBEAT_INTERVAL_MS` to 10 min or gate it behind a debug flag.

---

### High

#### H1 — `findWorker` miss fans out to every worker

`daemon-supervisor.ts:5970-5982`: when `matchWorkers(selector)` returns nothing, it does
```ts
await Promise.all([...this.workers.values()].map((w) => this.refreshWorkerSummaries(w, false, true).catch(...)))
```
Each `refreshWorkerSummaries` (`5023-5064`) is a `list` RPC to that worker (`5034`, 5 s timeout) and then `syncRosterFromWorkerSummaries` (`5648-5655`) rewrites every summary into the roster — each `writeRosterEntry` fires `onRosterMutation` (`5294-5303`) → a coalesced roster push to all subscribed clients (`5333-5344`).

**Trigger/frequency.** Any command carrying an activeSessionId the roster does not know: a TUI reconnecting with a stale id, a session that just moved workers, a `send_message` to a name. `findWorkerForClient` is on essentially every session-scoped command path (`2149`, `2212`, `2290`, `2385`, `2397`, `2441`, `2453`, `2466`, `2494`, `2568`, `2577`, `2605`, `2609`, `2617`, `2707`, `2711`, `2794`, `5195`, `6202`).

**Scaling.** Per miss: `W` worker `list` RPCs + `O(N)` roster writes + `O(C)` socket writes. At 12/231/32: 12 RPCs + 231 writes + 32 pushes.

**Fix.** Rate-limit the gap-fill to at most one full refresh every 2 s process-wide; try the roster's `byActiveSessionId`/`bySessionFile` indexes first (they exist, `agent-roster.ts:181-193`) and only refresh workers that could plausibly own the selector.

#### H2 — Idle-eviction sweep: `O(W)` RPCs + `O(W·N + N·C)` CPU every 60 s at idle

`daemon-supervisor.ts:1083-1097` schedules the sweep with `idleEvictionSweepIntervalMs` (`701-707`): **60 s floor**, 5 min ceiling when eviction is off. `runIdleEvictionSweep` (`1123-1199`):

1. `await this.settingsManager.reload()` (`1125`) — a settings file re-read every tick.
2. `refreshWorkerSummaries` for **every** worker (`1131-1140`) → `W` `list` RPCs + `W × O(N_w)` roster rewrites → roster pushes to all clients.
3. `workerEvictionSnapshot` per worker (`1099-1121`) → `workerRosterEntries(worker)` (an `O(N)` scan, H3) and, per session, `attachedClientCount` (`5953-5958`, an `O(C)` spread+filter).
4. `worker_passivate_idle_children` RPC to every non-candidate worker (`1151-1159`) + **another** `refreshWorkerSummaries` per worker (`1161`).
5. Inside the fence, **a third** `refreshWorkerSummaries` per candidate (`1173`) and a second `workerEvictionSnapshot` per candidate (`1180`).

The `idleEvictionMinutes === "off"` early return is at `1128`, *after* the settings reload but before the refreshes — good — yet the timer still fires every 5 minutes and still reloads settings.

**Scaling.** Per sweep: `2–3·W` worker RPCs + `W·N` roster-scan iterations + `N·C` client-scan iterations. At 12/231/32: 24–36 RPCs, 2,772 + 7,392 ≈ 10,200 iterations, **with every session idle**.

**Fix.** Index roster rows by workerId (H3). Maintain `attachedClientsByActiveSessionId: Map<string, number>` mutated in attach/detach instead of scanning `this.clients`. Reuse one `refreshWorkerSummaries` result across steps 2/4/5 instead of three round trips. Skip the whole sweep (do not even reload settings) when eviction is off and no worker changed since the last sweep.

#### H3 — `AgentRoster.entriesForWorker` is `O(N)`, used inside per-worker loops

`modes/daemon/agent-roster.ts:195-197`:
```ts
entriesForWorker(workerId: string): AgentRosterEntry[] {
    return [...this.entries.values()].filter((entry) => entry.workerId === workerId);
}
```
Full spread + filter of all 231 rows per call. Callers via `workerRosterEntries` (`daemon-supervisor.ts:5379-5381`): `workerEvictionSnapshot` (`1107`), `isEmptyDetachEvictionCandidate` (`1280`), `promoteOwnedWorker` (`5351`), `applyWorkerRosterSnapshot` (`5533`), `markWorkerRosterEntries` (`5658`), `flipWorkerRosterEntriesInactive` (`5667`), `sweepRosterStaleness` (`5683`), `clearRosterStaleness` (`5697`), `familyCatalogEntries` (`5239`), `findSummaryInWorker` (`6052`).

**Scaling.** `O(N)` per call, `O(W·N)` when looped over workers. `findSummaryInWorker` is on the create/attach path, so this is `O(N)` per attach too.

**Fix.** Maintain `agentIdsByWorkerId: Map<string, Set<string>>` in `write()`/`delete()`/`dropIndexes()` — the class already maintains two other indexes there.

#### H4 — `list` is `O(N·C)`

`daemon-supervisor.ts:2857-2872` iterates every roster entry and calls `this.publicSummary(worker, …)` (`5960-5968`), which calls `attachedClientCount` (`5953-5958`):
```ts
(summary.directAttachedClients ?? 0) + [...this.clients].filter((c) => c.attachedActiveSessionIds.has(activeSessionId)).length
```
That is a fresh array spread of the 32-client Set plus a filter, **per session**.

With `command.all` it additionally awaits `this.catalog.list(...)` (`2881`, full 231-session disk scan in the catalog child) and `this.rlmSpawnLedger().liveEdges()` (`2904`, see H5), then hydrates unseeded rows one at a time with `readSessionInfo` (`2933`, `2951-2958`).

**Scaling.** `O(N·C)` = 7,392 iterations + 231 Set spreads per `list`; `list --all` adds a full catalog scan and a full ledger parse.

**Fix.** Keep an attached-client counter per activeSessionId; cache the `list` response for ~250 ms keyed by (cwd, sessionDir, includeClientOwned).

#### H5 — RLM ledger is fully re-read and re-parsed on every ledger operation

`modes/daemon/rlm-ledger.ts` `replaySync` has **no memoization**: `existsSync(this.path)` then `readLedgerReplaySync(this.path, …)` which `readSync`-loops the whole file (bounded at `RLM_LEDGER_MAX_BYTES = 32 MB`, `:43`) and JSON-parses every line, then `validatedLedgerSessionsDir`. `liveEdgesUnlocked` (`:689-712`) then does one `await stat()` per unique child and parent path. `familyUnlocked` (`:714-771`) adds a `readdir` of the sessions dir plus a `readSessionInfo` per row (`:773-808`).

**Supervisor call sites:**
- `applyWorkerRosterSnapshot` (`daemon-supervisor.ts:5520`) — on **every worker roster snapshot frame**, i.e. every worker authentication/reconnect.
- `handleList` with `all` (`daemon-supervisor.ts:2904`).
- `seedRosterLedger` (`daemon-supervisor.ts:5399`) — once per family at startup.
- `edgeByChildPath` (`daemon-supervisor.ts:2677`, `2692`) — twice per saved-session delete.
- `rlmLedgerSiblings` → `siblings()` (`daemon-supervisor.ts:5721`) from `createOrReuseWorker` with a name (`3161`), `savedSessionNameReservationInput` (`5732`), `assertSupervisorSavedSessionNameAvailable` (`5763`).

**Scaling.** Per call: full ledger parse `O(records)` + `O(edges)` `stat` syscalls; `siblings()`/`family()` add `O(N)` session-file reads. A W-worker reconnect storm = W full parses back to back.

**Fix.** Cache the replay keyed by the ledger file's `(size, mtimeNs)` and invalidate on this process's own appends; cache `liveEdges()` for ~1 s.

#### H6 — Name-availability checks scan the entire saved-session catalog

`assertSupervisorSessionNameAvailable` (`daemon-supervisor.ts:5275-5287`) → `familyCatalogEntries` (`5233-5251`), which:
- filters `[...this.workers.values()]` calling `workerSessionsDir` + `ledgerKey` per worker and `workerRosterEntries` per worker (`5237-5239`) → `O(W·N)`;
- awaits `this.catalog.list(undefined, sessionDir)` (`5243`) → a **full 231-session disk scan** in the catalog child plus IPC of all rows.

Runs on every `create` that carries a name (`3171-3178`) and on every `rename`/`set_session_name` (`2816-2829`).

**Fix.** Cache the catalog listing for a few seconds; resolve name collisions from the roster + ledger (both already in memory) and fall back to the disk catalog only on a near-miss.

#### H7 — Attach/detach each cost extra worker RPCs and multiple `O(N)` roster scans

- `attachClient` ends with `void this.syncWorkerExtensionUi(activeSessionId)` (`daemon-supervisor.ts:6341`) → `matchWorkers` `O(N)` (`6644`) + a `worker_subscribe` RPC (`6648`, `4149-4167`) **even when the extension-UI flag did not change**.
- `detachClient` (`6627-6641`) per target: `matchWorkers` `O(N)` (`6630`), `syncWorkerExtensionUi` (RPC, `6638`), `evictEmptySessionOnLastDetach` (`6639`) → `matchWorkers` `O(N)` again (`1240`) + `refreshWorkerSummaries` (a `list` RPC, `1251`) + `isEmptyDetachEvictionCandidate` → `workerRosterEntries` `O(N)` + `attachedClientCount` `O(C)` per session (`1271-1287`).
- Client disconnect loops **all** attached sessions doing both (`1653-1657`).
- `writeRosterEntry` also triggers `evictEmptySessionOnLastDetach` whenever a row's `directAttachedClients` falls to 0 (`5367-5369`).

**Scaling.** Per attach or detach ≈ 2 worker RPCs + 2–3 × `O(N)` roster scans + `O(C)`. 32 TUIs reconnecting after a daemon restart, each with a handful of attached sessions, is hundreds of RPCs and tens of thousands of scan iterations.

**Fix.** Only re-subscribe when the computed `supportsExtensionUi` actually differs from the last value sent for that session. Debounce empty-session eviction (200 ms) and short-circuit it when the roster already shows `messageCount > 0` for every row of that worker, avoiding the `list` RPC entirely.

---

### Medium

#### M1 — `roster_update` is JSON-serialized once per client

`daemon-supervisor.ts:5333-5344` loops subscribed clients calling `this.write(client, {...})`, and `write` (`7828-7830`) calls `serializeJsonLine(message)` **per client**. Full-roster paths make this worse: the drain resync (`1664-1668`) and `roster_subscribe` (`2122`) both build `rosterEntriesForClient()` (`5347-5351`, all N visible entries) and then serialize the whole thing per client.

Contrast the session-event path at `7067`, which correctly serializes once (`publicPayload`) and calls `writeSerialized`.

**Scaling.** `C × JSON.stringify(payload)`. A resync burst = 32 × stringify(231 entries).

**Fix.** Serialize once above the loop; use `writeSerialized`.

#### M2 — `Atomics.wait` blocks the event loop

- `core/authority-mutation-guard.ts:378` `Atomics.wait(guardWaitBuffer, 0, 0, retryMs)` — a hard synchronous sleep on guard contention. Registry guards (`daemon-supervisor-ownership.ts:690-710`) and worker guards (`daemon-worker-cleanup.ts:179-193`) pass `attempts: 1` and retry asynchronously, so they avoid it — but `SessionLease.withLeaseGuard` (`core/session-lease.ts:979-991`) passes `attempts: 100, retryMs: 10`, i.e. **up to 1 s of fully frozen event loop** per contended lease.
- `core/orphan-process-journal.ts:748` `Atomics.wait(journalLockWaitBuffer, 0, 0, 10)` inside `acquireJournalWriteLock`, looping until `JOURNAL_WRITE_LOCK_TIMEOUT_MS = 1_000` (`:150`) — up to 100 blocking 10 ms sleeps.

**Scaling.** Contention grows with the number of processes touching the same authority path, i.e. with W. 12 workers stopping at once contend on the same orphan journals.

**Fix.** Never `Atomics.wait` on the supervisor loop. Convert both to async retry loops (the worker guard at `daemon-worker-cleanup.ts:179-193` is the pattern to copy).

#### M3 — Orphan reap polls process identity at 25 ms with a `/bin/ps` per poll

`core/orphan-process-journal.ts:1471-1481`:
```ts
while (!orphanProcessCandidateCleanupProven(orphan, options) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
```
`orphanProcessCandidateCleanupProven` (`:1404-1421`) calls `observeProcessIdentity` → a `ps` on darwin. `reapOrphanProcessCandidate` (`:1503-1529`) calls it 5 more times directly and runs the poll twice (500 ms then 1000 ms budgets). `reapOrphanProcessAuthority` (`:1557-1559`) loops candidates **serially** and then re-verifies every candidate (`:1569-1571`).

**Scaling.** Up to `(1500 ms / 25 ms) + 5 ≈ 65` `ps` spawns per candidate, serial across candidates. Reached from `stopWorker` (`daemon-supervisor.ts:7667`) and `recoverUncertainWorkerOperations` (`4942`) — so every worker stop, and a 12-worker shutdown is potentially ~780 serialized `ps` spawns.

**Fix.** Probe `processIdExists` (kill(0)) every poll and only run the `ps` identity check when the pid is still present and at most every 250 ms — this is exactly the throttle the supervisor already applies in `stopWorkerUntracked` (`daemon-supervisor.ts:7612-7624`, `LIVENESS_IDENTITY_RECHECK_MS = 500` at `:248`).

#### M4 — Stop and stop-finalization poll loops

- `daemon-supervisor.ts:7626-7628` and `7640-7642`: `while (isWorkerProcessAlive() && …) await delay(25)` — 40 loop wakeups/s per stopping worker; the `ps` inside is throttled to 500 ms, so 2 `ps`/s per stopping worker.
- `finalizeTimedOutWorkerStop` (`7709-7778`): a per-worker `unrefDelay(STOP_FINALIZATION_RECHECK_MS = 250)` loop (`:241`, `7758`) that runs until the process dies, with a `ps` every 500 ms, then retries the whole `stopWorker` every `STOP_FINALIZATION_RETRY_MS = 5000` (`:243`, `7775`) **forever** while the registration persists.

**Scaling.** `2 ps/s × (wedged workers)`, unbounded in time. A permanently wedged worker is a permanent 2 `ps`/s background load.

**Fix.** Exponential backoff on the finalization recheck (250 ms → 5 s) and a cap on total retry duration before parking the registration as failed.

#### M5 — `matchWorkers` is an `O(N)` scan on hot paths despite existing indexes

`daemon-supervisor.ts:6026-6048` iterates `this.roster().values()` for every selector lookup. `AgentRoster` already has `byActiveSessionId` and `bySessionFile` (`agent-roster.ts:181-193`) which would answer the exact-match case in O(1). Callers on hot paths: `detachClient` (`6630`), `syncWorkerExtensionUi` (`6644`), `evictEmptySessionOnLastDetach` (`1240`), `createOrReuseWorker` (`3047`), `findWorker` (`5974`, `5981`).

**Fix.** Try `byActiveSessionId` / `bySessionFile` first; fall back to the linear scan only for suffix and session-name matches.

#### M6 — `list_saved_sessions` emits one frame per session per client

`daemon-supervisor.ts:3007-3029`: `onSession` writes a `session_list_item` outbound per session, and `onProgress` a `session_list_progress` per step. Upstream, `modes/daemon/daemon-catalog-process.ts:158-161` sends one IPC message per session from the catalog child.

**Scaling.** `N` IPC messages + `N` socket writes (+ `N` `serializeJsonLine`) per call per client. 231 × 32 if every TUI opens the saved list.

**Fix.** Batch items into chunks of ~25 and throttle progress to ~10 updates total.

#### M7 — Unbounded / long-lived state

| What | Where | Growth |
|---|---|---|
| `~/.prime/agent/logs/processes/*.jsonl` | `core/process-lifecycle.ts:106,28,420-433,651` | one file per process instance, 14-day retention, pruned only at process start. Observed 3,378 files / 1 GB. |
| `CommandRecoveryJournal.entries` | `command-recovery-journal.ts:54,111-126` | shrinks only on `ack_result` (`daemon-supervisor.ts:2116`). A client that never acks leaks one entry per mutating command until `COMPACT_AFTER_RECORDS = 4096` (`:42`) forces a full rewrite+fsync. |
| `publishedRosterIds` | `daemon-supervisor.ts:811,5325,5349` | grows with every published agentId; shrinks only when a removal is flushed (`5318`, `5327`). |
| Snapshot transcript memory | `snapshot-transcript-cache.ts:223` (`SNAPSHOT_MEMORY_CACHE_BYTES = 4 MB`), spilled to disk above that (`:473-496`) | up to 4 MB resident **per activeSessionId per generation** per worker. At N=231 that is a multi-hundred-MB RSS ceiling before spilling. |
| Daemon log | `config.ts:592` (`MAX_LOG_BYTES = 5 MB`), one `.old` | bounded at 10 MB — fine; the cost is the per-line `stat`, not the size. |
| `rlmSpawnLedgerInstances` | `daemon-supervisor.ts:805,5703-5715` | one per sessions dir — bounded. |

---

### Low

- **L1** `hasPersistedWorkerDescriptors` (`daemon-supervisor.ts:1458-1463`) — `existsSync` per worker + a `readdirSync`. Shutdown only.
- **L2** Startup descriptor load: `loadWorkerDescriptors` (`daemon-supervisor.ts:1351-1422`) `readdirSync` + `readFileSync`+`JSON.parse` per descriptor, plus `enumerateCanonicalDaemonWorkerDescriptors` (`daemon-worker-cleanup.ts:623-687`) which `readdir`s every scope dir and fully reads every descriptor. `O(descriptors)`, startup only.
- **L3** `sweepRosterStaleness` (`daemon-supervisor.ts:5676-5692`, timer at `970-971`, `ROSTER_WATCHDOG_INTERVAL_MS = 15_000` at `:221`) — `O(W)` per tick in the normal case; only degrades to `O(W·N)` when a worker is actually stale (workers heartbeat every `ROSTER_HEARTBEAT_INTERVAL_MS = 15_000`, `daemon-worker-protocol.ts:53`, against a 45 s staleness threshold, `daemon-supervisor.ts:222`).
- **L4** `scheduleOwnedWorkerCleanup` / `cancelOwnedWorkerCleanup` (`daemon-supervisor.ts:1677-1685`, `1757-1791`) — `[...this.clients].some(...)` per worker, `O(W·C)`, only on connect/disconnect.

---

### Explicit non-findings (checked, not a problem)

- **The supervisor is mostly event-driven.** The only supervisor-owned periodic timers are the roster staleness watchdog (15 s, `daemon-supervisor.ts:970-971`, `O(W)`) and the idle-eviction sweep (60 s–5 min, `1083-1097`, H2). There is **no** per-session or per-client supervisor poll. The heartbeat storm is entirely client-driven (C1).
- **Session summarization is not supervisor cost.** `DaemonSessionSummarizer` (`modes/daemon/daemon-session-summarizer.ts:206`, 25 s sweep at `:227-232`) is constructed only in the worker process (`modes/daemon/daemon-mode.ts:646`). The supervisor never runs it.
- **Saved-session disk scans are off the supervisor loop.** `SessionManager.list/listAll` runs in the `daemon-catalog` child (`daemon-catalog-process.ts:138-172`); the supervisor pays IPC and per-row forwarding cost only (M6).
- **Per-session-event fan-out is already efficient.** `handleWorkerFrame` (`daemon-supervisor.ts:7049-7068`) serializes the payload once and does an `O(C)` write loop with no per-client recomputation, and `publicSummary` is not called on the common event path.
- **No `execFileSync`/`spawnSync` in the supervisor module itself.** Every synchronous subprocess spawn reaches the loop through `core/session-lease.ts:410-412` (`observeProcessIdentity`). There is no `JSON.parse` of a large payload on the command path other than the RLM ledger (H5) and the per-frame snapshot parsing, which is bounded per chunk.
- **`snapshotLoads` correctly single-flights concurrent attaches** to the same session+capability (`daemon-supervisor.ts:6226-6291`), so 32 clients attaching to one session produce one worker `attach` RPC.
- **I could not determine the `heartbeats_changed` emission rate from the code alone** — it is driven by `cronStore.onHeartbeatChange` (`daemon-mode.ts:705`), which fires on scheduler state changes whose frequency depends on the user's registered heartbeat jobs.

---

### Recommended order of attack

1. **Memoize self process identity** (`core/session-lease.ts:890-898,896` + `daemon-worker-cleanup.ts:154-159`) — removes 1–2 `/bin/ps` spawns from *every single daemon command* and from every `persistWorker`. One-line-ish change, largest single win.
2. **Serve `heartbeats_list` from the supervisor's own snapshot catalog and single-flight the refresh**, plus delete the agents-view 15 s poll — removes ~1,500 worker RPCs/min at idle and the timeout spam.
3. **Group-commit the command journal fsyncs** and **buffer `appendRotatingLog`**; demote worker stderr relay below info.
4. **Index the roster by workerId** and **maintain an attached-client count per activeSessionId** — kills H2/H3/H4/H7's quadratic terms in one change.
5. **Cap `logs/processes` by file count and raise the process heartbeat interval** — stops the 1 GB / 3,378-file directory and the 3,378-`statSync` startup stall.


## 2. Worker

Source: Opus 5 audit of `daemon-mode.ts`, the worker protocol and journals, `agent-session-runtime.ts`, `agent-session.ts`, `session-manager.ts`, `rlm-runtime.ts`, cron, orphan journal, exec/bash, kernel management, and the shared guard and identity code, plus `sample` profiles of live workers and counts over 25 transcripts.

Repo: `/Users/aelaguiz/workspace/prime-agent` (package `packages/coding-agent`).
Target: the detached **worker** process (`runDaemonMode` with `options.worker`), one per root session, hosting the root `AgentSession`, its RLM child sessions, a Python kernel, tools and the cron scheduler.

Fleet shape assumed throughout: **W = 12 workers**, **N = 231 sessions** (roots + RLM children), **S = N/W ≈ 19 sessions per worker**, 38 working at once.
`M` = messages in a session, `E` = transcript entries, `J` = orphan-journal size, `B` = cumulative subprocess spawns in a worker's lifetime.

Everything marked **[measured]** was taken from the live machine on 2026-09-02 (`ps`, `sample(1)`, and direct inspection of `~/.prime/agent`). Everything else is read off the code with a `file:line`. All paths are relative to `packages/coding-agent/src/` unless absolute.

---

### Top 10, ranked by how badly cost grows with N

| # | What | file:line | Scaling formula | Severity |
|---|---|---|---|---|
| 1 | Orphan-process journal: every subprocess spawn re-reads + re-JSON-parses the **whole** never-compacted journal **twice**, under a lock protocol built from ~20 `lstatSync` calls | `core/orphan-process-journal.ts:1020-1062`, `:723-790` | `2·B·J(B)` where `J` grows with `B` ⇒ **O(B²)** per worker | **critical** |
| 2 | `agent_status` appended to the transcript **every 25 s per session, forever, with an empty summary** | `modes/daemon/daemon-session-summarizer.ts:7,227-231,308-311,328-332,358-364` | `N/25` = **9.2 transcript appends/s** fleet-wide + 9.2 LLM attempts/s + 1 permanent tree node per session per 25 s | **critical** |
| 3 | Each of those appends wakes a trace flush that takes **two exclusive `proper-lockfile` locks on the single shared `settings.json`** — just to learn traces are off | `core/agent-traces.ts:674-681,726,867-882,918-941`; `core/settings-manager.ts:243-268,274-306,394-406,498-524` | `N/60 · 2` = **7.7 exclusive lock cycles/s on one file across 12 processes**, with a 20 ms × 10 **busy-spin** on contention | **critical** |
| 4 | `flushRoster` rebuilds the **entire** worker roster on **every** session event from **any** session | `modes/daemon/daemon-mode.ts:7473,7635-7650,7702-7806`; `modes/daemon/daemon-session-list.ts:148-216,230,248,255,261,301-315` | `events/s · S · (M + subtree + statSync + JSON.stringify)` ⇒ **O(events × S × M)** | **critical** |
| 5 | Supervisor fence: a synchronous `/bin/ps` fork **4×/s per worker** *and once per relayed command* | `modes/daemon/daemon-mode.ts:421,903-938,4274`; `core/session-lease.ts:743-766,411` | `ps/s = W·(4 + cmds/s)` = **48/s idle**; **[measured]** 108–127 ms per check | **critical** |
| 6 | RLM child fan-in: every child **streaming token** emits `rlm_child_update` up the whole ancestor chain → two O(S) scans + a full roster flush; the child preview text is rebuilt from scratch each token | `core/agent-session.ts:10524-10532,10606-10667,10649-10655`; `modes/daemon/daemon-mode.ts:8037-8052,7653-7662` | per token: `O(depth) + O(S)·2 + O(L)` + a scheduled `O(S·M)` flush ⇒ **O(L²)** per child message | **critical** |
| 7 | One Python kernel process **per session** | `core/kernel/repl-manager.ts` (one manager per session) | `RSS = N · 55 MB`; **[measured] 149 kernels, 8.0 GB RSS, 2.8 % CPU** | **high** |
| 8 | RLM spawn ledger: full 2.09 MB / 6 512-line read + `JSON.parse` + `realpathSync`-per-edge on **every** `edges()` call, no cache | `modes/daemon/rlm-ledger.ts:562-564,996-1004,912-951` | `edges_calls/s · 6 512 lines`; called on every attach, create, agent-message, observe, passivation sweep | **high** |
| 9 | Cron store re-reads **every** session's `scheduled-jobs.json` ~8× per fired job and ~4× per `wake()`; `wake()` fires from ~18 sites | `core/cron-jobs.ts:794-799,803-818,992,1047-1071,1541-1550`; `modes/daemon/daemon-mode.ts:7718` | `4–8·S` full file reads per tick; **[measured]** one 197 KB file was 85/86 cancelled jobs | **high** |
| 10 | `captureGitContext` = **3 blocking `spawnSync("git")`** at `agent_start` and again at `agent_end` | `core/agent-session.ts:3776,3780`; `core/session-manager.ts:1640-1647`; `utils/git.ts:251-272` | `6 · turns/s · S` blocking forks per worker; **[measured]** `spawnSync` was the top non-idle leaf (~7 %) in worker 90474 | **high** |

**[measured] profile evidence.** `sample(1)` on three live workers:

| pid | %CPU | main-thread samples | dominant non-idle leaf |
|---|---|---|---|
| 6346 | 14.7 | 6 767 (8 s) | **`lstat` 4 328 = 64 %**, all via `node::fs::LStat` (i.e. `fs.lstatSync`) on the **main thread** inside JS microtasks; `fsync` 130 = 1.9 %; a further 208 samples building V8 stack traces for `lstatSync` ENOENT throws |
| 90474 | 14.0 | 4 374 (5 s) | **`node::SyncProcessRunner::Spawn` ≈ 307 = 7 %** (i.e. `execFileSync`/`spawnSync`) |
| 59769 | 13.7 | 4 383 (5 s) | `lstat` 86, `posix_spawn` 12 |

Measured worker CPU is dominated by **synchronous `lstat`/`mkdir` lock storms** (findings 1 and 3) and **synchronous process spawns** (findings 5 and 10). None of it does any agent work.

**[measured] fleet snapshot.** 36 node `prime-agent` processes, 75.5 % total CPU, 8.6 GB RSS. 149 `rlm.repl` Python kernels, 2.8 % CPU, 8.0 GB RSS. 12 bash supervisors. `~/.prime/agent`: `session-artifacts` 8.8 GB, `sessions` 1.5 GB, `logs` 1.1 GB (1 662 files; `logs/processes` alone 1.0 GB / 3 378 files), `daemon-workers` 72 MB, `rlm-ledger` 3.0 MB, `session-leases` 446 entries.

---


### C1. Orphan-process journal: O(B²) blocking I/O on every subprocess spawn

**file:line** `core/orphan-process-journal.ts:1020-1062` (`appendRecordToExistingAuthority`), `:723-758` (`acquireJournalWriteLock`), `:760-781` (`releaseJournalWriteLock`), `:986` (`readFileSync` of the whole journal), `:877-975` (`parseJournalContents`), `:792-796` (`openedPathIsCurrent`), `:748` (`Atomics.wait`), `:1053` (the second full read).
**Callers** `utils/shell.ts:206` (`enrollOrphanProcess` — every tracked detached child, i.e. every bash / `pi.exec` subprocess), `utils/shell.ts:224` (`retireOrphanProcess`), `core/kernel/repl-manager.ts:1087,1386,1564` (kernel start/exit), `cli/owned-session-worker.ts:780`.

One append does, **synchronously, on the event loop**:

1. lock acquire: `assertSecureClaimsDirectory` (`:726`, `mkdirSync`+`lstatSync`), `createJournalWriteLockCandidate` (`:651`) → `observeProcessIdentity(process.pid)` (`:657` → `:524-529`) → **a `/bin/ps` fork** → `openSync`+`fchmodSync`+`writeAllSync`+**`fsyncSync`** (`:668`), `linkSync` (`:735`), `safelyRemoveOwnCandidate` (`:641`, `fstatSync`+`lstatSync`+`unlinkSync`);
2. `openSync(O_RDWR|O_APPEND)` (`:1026`);
3. **`readFileSync(descriptor)` of the entire journal** (`:1028`);
4. **`JSON.parse` on every line** (`:1029`);
5. linear `candidates.some(...)` scan (`:1035`);
6. `openedPathIsCurrent` → `fstatSync`+`lstatSync` (`:1048`);
7. write + **`fsyncSync`** (`:1050-1051`);
8. `openedPathIsCurrent` again (`:1052`);
9. **`readJournalSnapshot` — a second complete read + full re-parse of the whole file, purely to verify the append** (`:1053`);
10. lock release: a second `observeProcessIdentity(process.pid)` (`:590`) → **a second `/bin/ps` fork**, another **`fsyncSync`** (`:596`), and ~8 more `lstatSync`/`fstatSync`.

≈ **45 syscalls, 3 fsyncs, 2 full reads, 2 full JSON parses, 2 synchronous `/bin/ps` forks per record** — and 2 records (enroll + retire) per bash call ⇒ **4 ps forks, 6 fsyncs, 4 full journal reads per `bash()`**.

Worse, `enrollOrphanProcess` at `:1262` calls `observeProcessIdentity(pid)` for the child immediately after `utils/contained-shell.ts:464` already asked the same question — a fifth `ps` fork for a value already in hand.

**The journal is never compacted.** Retirement *appends another line* (`:1322-1342`); it never removes the enrollment line. The reducer at `:965` deletes from an in-memory Map only. The only shrink is `clearOrphanProcessJournal` (`:1588`), called solely at worker shutdown (`cli/owned-session-worker.ts:1071`, `modes/daemon/daemon-worker-cleanup.ts:1501,1905`). The ceiling is `ORPHAN_JOURNAL_STRICT_MAX_BYTES = 64 MB` (`:162`).

Contention path: `:748` `Atomics.wait(journalLockWaitBuffer, 0, 0, 10)` — a **fully blocking 10 ms sleep on the event loop**, retried up to `JOURNAL_WRITE_LOCK_TIMEOUT_MS = 1_000` (`:150`), with a `readJournalWriteLockRecord` (open + fstat + lstat + 16 KB alloc + read + `JSON.parse`) on each iteration.

**Trigger and frequency** every subprocess the agent spawns. **[measured]** the largest journal is 913 859 B / 1 643 records (823 enrolled + 819 retired) for one worker; fleet journals total 6.4 MB / 11 864 records across 32 files and grew 23 485 B in 30 s ≈ **1.4 records/s**.

**Cost at 12 workers / 231 sessions** at the measured rate with an average journal of ~200 KB: **≈ 560 KB/s of blocking `readFileSync` + `JSON.parse`, ~4 fsync/s, ~5.6 synchronous `/bin/ps` forks/s, ~28 `lstatSync`/s** across the fleet, purely as bookkeeping. Because each append re-reads a file one record longer, lifetime work is `Σᵢ 2·i·556 B` ≈ **750 MB of JSON parsing for the single worker measured**, accelerating. This plus C3 is the source of the **64 % of main-thread samples in `lstat`** on pid 6346.

**Fix** (a) memoize the worker's own `observeProcessIdentity(process.pid)` at `:524-529` — it is immutable and already memoized elsewhere (`core/session-lease.ts:967-972`); removes 4 `ps` forks per bash call; (b) delete the post-append verification re-read at `:1053` (the record is already fsynced under an exclusive lock); (c) compact on append once `enrolled+retired` exceeds a threshold — the live-set reducer at `:877-975` already computes exactly what to rewrite, taking 914 KB → <10 KB.

---

### C2. `agent_status` written to every transcript every 25 s, forever, with an empty summary

**file:line** `modes/daemon/daemon-session-summarizer.ts:7` (`SWEEP_INTERVAL_MS = 25_000`), `:227-231` (the sweep iterates **every** session in the worker), `:308` (`owesSummary = !isWorking && !previous?.summary`), `:309-311` (the early-return guard), `:328-332` (the failure fallback stores `summary: previous?.summary ?? ""`), `:358-364` (`appendAgentStatus` runs whenever `!isWorking`, **not gated on `changed`** — only the in-memory broadcast at `:365` is).
Started unconditionally in workers at `modes/daemon/daemon-mode.ts:804`, constructed at `:646` with `listSessions = () => [...this.sessions.values()]`.
Write path: `core/session-manager.ts:1612-1626` → `:1410-1415` → `:1390-1408`.

The bug is self-sustaining. When `generateAgentStatus` returns `undefined` (`:319`; it returns `undefined` **with no network call** when the summary model `prime-inference` / `qwen/qwen3-30b-a3b-instruct-2507` (`:11-12`) is unresolvable — `:40-46`, `:155-158`), the fallback at `:328-332` stores `summary: ""`. Since `owesSummary` is `!previous?.summary` and `!"" === true`, the guard at `:309` **can never fire again**. Every 25 s, for every idle session, forever: one model-call attempt, one transcript append, one new node in the session tree.

Corroborating dead code: `agentStatusChanged` is exported at `:188` and **never called anywhere in the repo** — the change gate was intended and got dropped.

**[measured] proof.** Across the 25 most recently modified transcripts in `~/.prime/agent/sessions`:

```
agent_status           36 982   ← every single one has summary:"" , taskState:"needs_input"
message                29 258
child_usage_attributed 12 907
custom                  7 948
```

There are **more empty status records than real messages**. Timestamps in one file: `22:44:30.534`, `22:44:55.560`, `22:45:20.565`, `22:45:45.591` — exactly 25.0 s apart.

**Cost at 12 workers / 231 sessions**
`writes/s = N / 25 = 9.2` transcript appends per second fleet-wide, each `existsSync` + `mkdirSync` + `appendFileSync`; the same 9.2/s of attempted LLM summary requests; **9.2 new branch nodes/s** added permanently, inflating every later `getBranch()`, `getEntries()`, `getFlatTree()` and `scanSessionInfo()`.

Three compounding downstream effects, each of which is a finding in its own right:

- **C3** — each append fires `_notifyPersistListeners` (`core/session-manager.ts:1406`) → the trace-upload debounce → a locked settings read.
- The append changes size+mtime, so it **invalidates the session-info cache** (`core/session-manager.ts:951,960-966`), forcing a full line-by-line rescan of the multi-MB transcript on the next roster/list walk (`modes/daemon/daemon-mode.ts:1828` → `scanSessionInfo`, `core/session-manager.ts:969-1075`).
- It also defeats the trace-upload dedupe at `core/agent-traces.ts:930-934` (`(path,size,mtime)` signature), so the upload path always proceeds.

Secondary waste on the same function: `:313-314` copies the **whole** `messages` array (`[...messages, streaming]`) for a working session on every sweep and every debounce, only for `buildStatusContext` to `slice(-8)` it (`:81`).

**Fix** three lines: (1) at `:358`, only append when `changed`; (2) at `:328-332`, do not manufacture a status with an empty summary — leave `summaryState` unset and retry, or set a sentinel that satisfies `owesSummary`; (3) at `:313`, pass `messages.slice(-8)`.

---

### C3. Every persisted entry ends in two exclusive locks on the one shared `settings.json`

**file:line**
- `core/session-manager.ts:1406` — `_persist` calls `_notifyPersistListeners()` on every appended entry.
- `core/agent-session-services.ts:223` → `core/agent-traces.ts:958-968` — `installAgentTraceUpload` registers `sessionManager.onPersist(controller.schedule)` for **every** session.
- `core/agent-traces.ts:867-882` — `schedule()` arms a debounce of `max(TRACE_UPLOAD_DEBOUNCE_MS = 1_000, throttleDelay)`, where `throttleDelay` keeps it to one flush per `TRACE_UPLOAD_MIN_INTERVAL_MS = 60_000` per session (`:19-20`).
- `core/agent-traces.ts:918-941` — `runFlush()` short-circuits at `:931` only if the `(path,size,mtime)` signature is unchanged — **which C2 guarantees it never is** — then calls `uploadAgentTraceSession`.
- `core/agent-traces.ts:726` — `performAgentTraceUpload` calls `getAgentTracesEnabled(options)` **first, before anything else**.
- `core/agent-traces.ts:674-681` — `getAgentTracesEnabled` does `await options.settingsManager.reload()` because `reloadConfig !== false`.
- `core/settings-manager.ts:498-524` — `reload()` calls `tryLoadFromStorage` **twice** (global `:500`, project `:514`).
- `core/settings-manager.ts:394-406` — `loadFromStorage` is a *read*, but it goes through `storage.withLock(...)`.
- `core/settings-manager.ts:274-306` — `withLock` does `existsSync` (`:280`), then `acquireLockSyncWithRetry` (`:282`) → **`lockfile.lockSync(path)`** (`:243`, `proper-lockfile`), then `readFileSync` (`:284`), then `release()` (`:303`).
- `core/settings-manager.ts:260-268` — on `ELOCKED`, **a synchronous busy-spin**:
  ```ts
  const start = Date.now();
  while (Date.now() - start < delayMs) { /* Sleep synchronously */ }
  ```
  with `maxAttempts = 10`, `delayMs = 20` (`:236-237`) ⇒ up to **200 ms of 100 % CPU event-loop-blocking spin** per contended acquire.

`proper-lockfile.lockSync` is `mkdir`-based: `mkdirSync(<path>.lock)`, `statSync` on EEXIST for staleness, `utimesSync` + a refresh `setInterval` while held, `rmdirSync` on release. That is the **second source of the measured `lstat`/`stat` storm**, and it is an *exclusive* lock taken for a pure read.

The global file is `join(agentDir, "settings.json")` (`core/settings-manager.ts:231`) = **one `~/.prime/agent/settings.json` shared by all 12 workers and all 231 sessions.**

**Scaling formula** `lock_cycles/s = N/60 × 2 = 7.7` exclusive acquire/release pairs per second on that single file, contended across 12 processes — and every one of them ends by returning `{status:"disabled"}` at `core/agent-traces.ts:727`. **[measured]** `~/.prime/agent/settings.json` has no `agentTraces` key, so traces are off and 100 % of this work is wasted.

Note the direction of causality: with C2 fixed, an idle session persists nothing, so its trace controller never re-schedules and this whole chain goes quiet for idle sessions.

**Fix** (a) at `core/agent-traces.ts:726`, read `settingsManager.getAgentTracesEnabled()` **without** `reload()` (or cache the reload with a TTL) — the enable flag does not change per upload; (b) at `core/settings-manager.ts:394-406`, do not take an exclusive lock for a read — read the file directly and tolerate a torn read by retrying the `JSON.parse`; (c) at `:260-268`, replace the busy-spin with an async delay.

---

### C4. `flushRoster` is O(sessions × messages) and runs on essentially every session event

**file:line** `modes/daemon/daemon-mode.ts:7473` (`observeRosterEvent` is called from `broadcastToSession` for **every** outbound), `:7635-7650` + `:8223-8238` (`ROSTER_SESSION_EVENT_TRIGGERS`: `turn_start/end`, `bash_start/end`, `compaction_start/end`, `auto_retry_start/end`, **`tool_execution_start/end`**, `message_end`, `session_action_update`, `session_info_changed`, `thinking_level_changed`), `:7702-7713` (`scheduleRosterFlush`, coalesced only to one per `setImmediate` tick — during token streaming that is effectively one per token), `:7715-7806` (`flushRoster`).

Each flush:

- `:7718` `this.cronStore.list()` — a full S-file cron scan (see H3);
- `:7719` `buildSessionList([...this.sessions.values()], [], scheduledJobs)` → `summaryForActiveSession` for **every** session, each doing:
  - `modes/daemon/daemon-session-list.ts:227-234` — `savedSession` is always `undefined` here (flushRoster passes `[]`), so the **`statSync(session.sessionFile)`** always runs — one filesystem stat per session per flush;
  - `:248` → `:301-315` `latestMessageActivityAt(session.messages)` — **iterates every message in the session**;
  - `:255` `session.sessionName` → `core/session-manager.ts:1557-1566` `getSessionName()` → `getEntries()` (`:1807-1809`), which **allocates a full copy of the entire entry array** before its reverse scan;
  - `:261` `session.hasRunningRlmChildren()` → `core/agent-session.ts:10238-10254`, **recursive over the whole child tree**;
  - `:267` `getSessionActionSnapshot()` (`core/agent-session.ts:6559-6588`, 3 array allocations + previews), `:277-279` `firstUserMessageText()`, `:268` `streamingMessage`, `:292` `[...runtime.diagnostics]`;
- `:7737-7770` two more passes over `lastComposed`;
- `:7773-7776` **`JSON.stringify(entry)` for every entry**.

Insult to injury: `modes/daemon/agent-roster.ts:77-79` `workerRosterEntryFromSummary` **strips `streamingMessage`, `sessionActions` and `diagnostics` immediately after** `summaryForActiveSession` built them — that work is computed and discarded on every flush.

**Scaling formula**
```
cost/flush = S × ( M timestamp comparisons + full entry-array copy + subtree recursion
                   + 1 statSync + 1 JSON.stringify(large) ) + S cron-file reads
total      = flushes/s × that
```
At S = 19 and M ≈ 1 500, **one `tool_execution_end` anywhere in the worker costs ~28 500 timestamp comparisons, 19 full entry-array copies, 19 `statSync` calls, 19 large `JSON.stringify` calls and 19 cron-file reads** — to produce a delta that usually contains one changed row.

**Fix** recompute only the summary of the session that emitted the event plus a dirty set; cache `latestMessageActivityAt` (update it in the append path); drop the per-flush `statSync` and `getSessionName()` entry-array copy; skip building the three fields `agent-roster.ts:78` throws away; coalesce with a ~250 ms timer instead of `setImmediate`.

---

### C5. Supervisor fence: a blocking `/bin/ps` 4×/s per worker, plus one per relayed command

**file:line** `modes/daemon/daemon-mode.ts:421` (`SUPERVISOR_FENCE_POLL_MS = 250`), `:903-911` (re-armed timer — **not `.unref()`'d**), `:913-938` (`checkSupervisorFences` loops every claim and re-arms at `:937`), `:940-967` (`assertSupervisorClaimCurrent`), and **`:4274`** — the same check runs again for **every command relayed from the supervisor**.
Downstack: `modes/daemon/daemon-supervisor-ownership.ts:993-1020` → `:1012` `matchesExactProcessIdentity` → `core/session-lease.ts:890-898` → `:781-821` `observeProcessIdentity` → `:743-766` `observeDarwinProcessIdentity` → `:749` `existsSync("/bin/ps")` → **`:752-757` `execFileSync("/bin/ps", ["-ww","-o","command=","-p",pid])`** via `:409-411`; if the argv token is absent it falls through at `:765` to a **second** `ps` spawn (`:700-706`).

Per check the worker also pays: `configuredRegistryDirs` → `canonicalRegistryDirs` (`daemon-supervisor-ownership.ts:606-613`) doing a **`mkdirSync(recursive)` + `realpathSync` per registry dir on every call**; then per dir `existsSync` + `readFileSync(owner.json)` + `JSON.parse` + `readFileSync(scope.json)` + `JSON.parse` (`:2089-2105`); then a sha256 fingerprint (`:2049-2051`); all inside `withConsistentRegistryRead`, which retries up to 3× (`:642-643,645-656`).

The legacy branch (`daemon-mode.ts:955-966` → `daemon-supervisor-ownership.ts:1041-1115`) is worse: **two** `observeProcessIdentity` calls (`:1080-1081`) and **two** full owner-record reads (`:1057-1061`, `:1088-1091`) ⇒ 2 `ps` forks per check.

**[measured]** live supervisor log:
```
Session worker 3ce5bc0e7f61 stderr: Worker command admission type=heartbeats_list id=worker_5083
  phase=supervisor_claim_check_completed elapsedMs=127
... worker_5084 elapsedMs=121 / worker_5085 elapsedMs=113 / worker_5086 elapsedMs=108
```
`elapsedMs` is only logged at ≥ 100 ms (`daemon-mode.ts:922`, `:4281`), so **every logged admission cost ≥ 100 ms**. A bare `/bin/ps -o command=` on this box is 6.7 ms p50 **[measured, 2 552 processes]** — the 100–127 ms is event-loop queueing behind C1/C3, so the fence both causes and suffers from the stall.

**Scaling formula** `ps_forks/s = W × (4 + relayed_commands/s)`. Idle floor **48 forks/s** fleet-wide, more per relayed command; `heartbeats_list` fans out to *every* worker (H2), so one client polling at 15 s adds `W/15` = 0.8/s per client.

**Fix** the socket already reports supervisor death immediately (`daemon-mode.ts:3970-3996`). Replace the 250 ms re-validation with socket-close detection plus a 5 s slow poll, and cache the identity observation per `(pid, processStartId)` for a few seconds so the per-command admission at `:4274` reuses the fence's result. Also `.unref()` the timer at `:907`.

---

### C6. RLM child fan-in: a parent event, an O(depth) re-emit, two O(S) scans and a roster flush per child *token*

**file:line**
- `core/agent-session.ts:10606` — the parent subscribes to **every** event of every child.
- `:10649-10655` — on `message_start` and **every `message_update`** (i.e. every streamed token) it runs `compactRlmText(readAssistantText(event.message))`. `readAssistantText` (`:1012-1017`) joins **all** text blocks; `compactRlmText` (`:997-1003`) runs `text.replace(/\s+/g," ").trim()` over the **entire accumulated text** before slicing to 160 chars ⇒ **O(L²) per child assistant message**.
- `:10524-10530` `emitChildUpdate` builds a snapshot (`_rlmChildSnapshotForRun`, `:10136-10158`, which itself calls `child._contextTokensForCurrentMessages()` at `:9469-9472`) and `JSON.stringify`s it for change detection — but `answerPreview` changes every token, so the dedupe at `:10527` never suppresses.
- `:10607-10609` — a child's `rlm_child_update` is re-`_emit`ted verbatim by the parent, and by the grandparent ⇒ **O(depth) emit loops per event**.
- `:10656-10664` — also emits on every `tool_execution_start`/`end`.

On the daemon side each parent `rlm_child_update` costs:
- `modes/daemon/daemon-mode.ts:7472` → `:8037-8052` `stampRlmChildActiveSessionId` — **linear scan of all sessions**;
- `:7473` → `:7638-7639` → `:7653-7662` `observeRosterChildUpdate` → `:7664-7672` `hasSessionForRlmChild` — **another linear scan of all sessions** — then `scheduleRosterFlush()` ⇒ the full C4 cost;
- `:7468-7470` — `rlm_child_update` is in `RECOVERY_CHECKPOINT_EVENTS` (`:426-443`) → `recordWorkerRecoveryState` (`:7833-7851`), change-deduped but on change does `openSync`+`writeSync`+**`fsyncSync`**+`closeSync`+`chmodSync` (`modes/daemon/worker-recovery-journal.ts:95-104`).

Two more O(M) allocations on the same subscription, per child assistant `message_end`:
- `core/agent-session.ts:10622` → `:9488-9492` `_findAssistantEntryForMessage` = `sessionManager.getEntries().find(...)` — **a full copy of the parent's entire entry array** (`core/session-manager.ts:1808`) then a linear scan;
- `:10624-10629` — `messages.lastIndexOf(assistant)` (O(M)) then `messages.slice(0, i).reverse().find(...)` — a **full array copy plus a full reverse**.
Then `appendChildUsageAttribution` (`core/session-manager.ts:1507-1531`) appends another entry, and `:10647` fires `flushAgentTraceUpload(child.sessionManager)` ⇒ C3.
**[measured]** 12 907 `child_usage_attributed` entries across 25 transcripts — each one paid all of the above.

**Scaling formula** per streaming token of any child in the worker:
`O(depth) emits + 2 × O(S) scans + O(L) text rebuild + 1 JSON.stringify + a scheduled O(S·M) roster flush`.
A child streaming a 20 KB answer in ~4 000 deltas spends ~80 MB on the preview recompute alone, and flushes the roster on most of those turns.

**Fix** (1) recompute `answerPreview` only on `message_end` and on a ~250 ms throttle; (2) do not `scheduleRosterFlush` for an `rlm_child_update` that originated from a `message_update`; (3) index sessions by `rlmChildId` in a `Map` so `stampRlmChildActiveSessionId` and `hasSessionForRlmChild` are O(1); (4) replace `getEntries().find(...)` at `:9489` with a `byId`/`WeakMap` lookup and `slice().reverse().find()` at `:10626-10629` with a backward `for` loop.

---


### H1. One Python kernel process per session

**file:line** `core/kernel/repl-manager.ts` (one `ReplManager` per `AgentSession`; enrollment at `:1087`, `:1386`).
**[measured]** 149 `rlm.repl` Python processes alive, **8.0 GB RSS** (~55 MB each), 2.8 % CPU total.

**Scaling formula** `RSS ≈ N × 55 MB`. At 231 sessions that is **~12.7 GB resident** for interpreters that are almost entirely idle. Not a CPU cost; the single largest memory cost, strictly linear in session count.

Kernel *start* is expensive and **not memoized across starts**: `core/kernel/bootstrap.ts:941-951` memoizes only the in-flight promise and nulls it on settle (`:947`), so every start re-runs `normalizePythonSkills` (`readFileSync` + sha256 per skill `pyproject.toml`, `:122`; `readdirSync` of siblings, `:257`), `hashRuntimeSource` (recursive readdir + SHA-256 of **every** `.py` file, `:712-745`), and spawns a full Python interpreter **twice** for `hasPrimeAgentRuntime` (`:913`, `:917`). `core/kernel/boot-gate.ts:6` allows up to 16 of these concurrently.

Steady state is clean: **no health-check timer, no readiness poll, no `ps` liveness sweep on a running kernel**; readiness is a one-shot frame with a 30 s deadline (`core/kernel/repl-manager.ts:92`, `:1872`), output is parsed incrementally on `stdout` `data` (`:1461`).

**Fix** pool or lazily start kernels — a session with no Python cell in flight does not need a live interpreter; cache the bootstrap fingerprint on disk keyed by venv mtime.

### H2. `heartbeats_list` fans out to every worker, and each fan-out costs a `/bin/ps`

**file:line** `modes/daemon/daemon-supervisor.ts:2492-2527` — with no `activeSessionId`, the supervisor forwards to **every live worker** via `Promise.all`. Each forward hits the worker's per-command claim check (`daemon-mode.ts:4274`, C5) and then `listHeartbeats` (`daemon-mode.ts:2684-2697`), which calls `cronStore.list()` (H3) and `summaryForActiveSession(state)` per heartbeat (C4 per-session cost).
Poller: `modes/agents-view/agents-view-mode.ts:893`, `HEARTBEAT_POLL_INTERVAL_MS = 15000` (`:102`).

**Scaling formula** `commands/s = clients × W / 15`. **[measured]** the supervisor log shows four `heartbeats_list` admissions to the *same* worker inside one millisecond, each 108–127 ms.

**Fix** serve `heartbeats_list` from the roster the workers already push (`daemon-mode.ts:7786-7805`); the supervisor already caches `worker.heartbeatSnapshot` (`daemon-supervisor.ts:2510`) — make that the default answer, refreshed from roster deltas.

### H3. Cron store rescans every session's job file 4–8× per tick, and `wake()` fires from ~18 sites

**file:line** `core/cron-jobs.ts:794-799` (`readStates` maps over **every** registered session file, no cache, no mtime check), `:803` and `:818` (`heartbeatCatalogSignature(this.readJobs())` before **and** after every mutation), `:808-812` (read + two `JSON.stringify` of the whole state per path), `:992` → `:1056` → `:781` (`nextActiveRunAt()` re-reads everything just to arm the timer), `:1011` → `:707`, `:1024` → `:721` (`recordDispatchResult` → another `mutateStates`), `:1541-1550` (`readJobsState`), `:1566` (`JSON.stringify(state, null, 2)` — pretty-printed), `:1567` + `:1575` (**two** `fsyncSync` per write), `:1496-1539` (a `mkdirSync` + `proper-lockfile` `lockSync` per path; the retry at `:1525` is a 10 ms `Atomics.wait` that **freezes the event loop**, and it allocates a fresh `SharedArrayBuffer` per retry).
`wake()` (`:961`) is called from `modes/daemon/daemon-mode.ts:2072,2564,2593,2610,2639,2670,2679,2710,2727,2740,2764,2771,2891,5580`. `flushRoster` also opens with `cronStore.list()` (`daemon-mode.ts:7718`), so **every roster flush is also a full cron scan**.

**Scaling formula** `≈ 8·S` full `readFileSync` + `JSON.parse` per fired job, `≈ 4·S` per bare `wake()`, `≈ 1·S` per roster flush.
**[measured]** 95 `scheduled-jobs.json`, 2 037 546 B total, largest 197 454 B — one sampled file held **86 jobs of which 85 were `cancelled`**. Cancelled jobs are never pruned: `cancel` only flips `status` (`:628`) and `mergeFreshJobs` (`:1641`) keeps every id forever.

**Fix** cache `readJobsState` by `(path, mtime, size)`; hoist the duplicate `readJobs()` at `:803`/`:818`/`:992`; prune terminal jobs on write at `:1552-1558`; drop `null, 2` at `:1566`.

### H4. RLM spawn ledger: a full 2 MB read + parse + `realpathSync`-per-edge on every `edges()`

**file:line** `modes/daemon/rlm-ledger.ts:562-564` (`edges()`), `:996-1004` (`replaySync` — `existsSync` + full synchronous read + replay, **no cache**), `:293-308` (`readAllSync`), `:231-291` (`JSON.parse` per line), `:311,501,510,526,535,569,570` (`canonicalSessionPath` = `realpathSync`, `core/session-lease.ts:259-270`), `:912-951` (`appendRecord`: full read + full replay + **two** `fsyncSync` per record).
**Callers in the worker** `modes/daemon/daemon-mode.ts:1803` (`listPassiveRlmSubagents`) ← `:1879` `buildRlmChildSnapshotsWithPassiveRlmSubagents` ← `:5961` and `:5968` `createSessionSnapshot` (**up to 4× per snapshot**, retry loop `:5962-5969`) ← every attach, every `session_replaced`, every backpressure catch-up (`:7927`); also `:1908` (`list`), `:2242`/`:3001`/`:6718` `findPassiveRlmSubagent` (every `create`, every agent-message target resolution), `:3346` `sessionPassivationSnapshot`, `:3795` observe, `:6302`/`:6401` family catalog; plus `:1349,1624,2094,3132` with `includeDeleted`.

**[measured]** the ledger is `65ac3aeeffdfc304.jsonl` = **2 092 648 B, 6 512 lines (4 211 spawn + 2 300 delete)**; tombstones are never compacted out, so 35 % of every parse is dead. `listPassiveRlmSubagents` then calls `canonicalSessionPath` once per edge in the grouping loop (`daemon-mode.ts:1806`) and again per visit (`:1819`) — thousands of `realpathSync` per invocation — plus a `readSessionInfo` per passive child (`:1828`).

**Scaling formula** `edges_calls/s × (2 MB read + 6 512 JSON.parse + ~6 512 realpathSync)`. Grows with total historical children ever spawned, not with live ones.

**Fix** cache the replay keyed on `(mtimeMs, size)`, invalidated by own appends; memoize `canonicalSessionPath` in a `Map`; compact tombstones past ~30 %.

### H5. `captureGitContext`: three blocking `spawnSync("git")` per turn start and per turn end

**file:line** `core/agent-session.ts:3776` (`agent_start`) and `:3780` (`agent_end`) → `core/session-manager.ts:1640-1647` `recordGitStateIfChanged` → `utils/git.ts:261-272`, which runs `:251-259` `runGit` **three times** (`rev-parse HEAD`, `branch --show-current`, `remote get-url origin`), each a `spawnSync` (`utils/git.ts:1`). The "IfChanged" guard is applied *after* the three forks. Also on `newSession` (`core/session-manager.ts:1229`), `materializeSessionFile` (`:1355`), `createBranchedSession` (`:1909`), `forkFrom` (`:2080`).

**Scaling formula** `6 × turns/s × S` blocking forks per worker. **[measured]** `node::SyncProcessRunner::Spawn` was the dominant non-idle leaf in worker 90474 (≈ 307 of 4 374 main-thread samples).

**Fix** cache per `(cwd, .git/HEAD mtime)`; or collapse to one `git rev-parse HEAD --abbrev-ref HEAD` plus a cached remote — 6 forks → 1 per turn.

### H6. `createAgentFamilyCatalog` scans every saved session on disk, on every rename

**file:line** `modes/daemon/daemon-mode.ts:6340-6406`: `listSupervisorAgentPeers()` (`:6273-6292` — opens a **new socket to the supervisor**, `connect` + `waitForHello` + `request`), `createAgentMessageListResult` (`:6294-6338`, which calls `listPassiveRlmSubagents` ⇒ H4), **`SessionManager.listAll(...)`** (`:6352-6356`) — a full scan of every session file in the sessions dir — plus `canonicalSessionPath` (`realpathSync`) at `:6350,6361,6369,6389,6391,6399,6403`, and another `listPassiveRlmSubagents` at `:6401`.
**Trigger** `assertFamilySessionNameAvailable` (`:6415-6433`) ← `assertStateSessionNameAvailable` (`:6442-6462`) ← `setStateSessionName` (`:6519-6544`) ← `addRuntime` when a name is supplied (`:1997`), `rename` / `set_session_name` / `rename_saved_session` (`:4848,4804,4876`), and the agent-facing `roster()` tool (`:3758` → `:6408-6413`).
**[measured]** `~/.prime/agent/sessions` is 1.5 GB across 165 entries; `listAll` runs `scanSessionInfo` (`core/session-manager.ts:969-1075`) over each.

**Fix** answer name-availability from the ledger plus the in-worker session map; skip `listAll` entirely for depth-0 checks.

### H7. `readSessionInfo` re-scans the entire multi-MB transcript whenever the file changed

**file:line** `core/session-manager.ts:953-967` (cache keyed on `(size, mtimeMs)`) and `:969-1075` (`scanSessionInfo` — streams every line, `JSON.parse` each). The cache is correct for *passive* files but **always misses for a live session**, because C2 changes size and mtime every 25 s.
**Hot callers** `modes/daemon/daemon-mode.ts:2902` `isPersistedCronJobRunnable` (once per cron-job attempt, on the live file), `:2841`/`:2843` `restoreRlmHeartbeatSession`, `:1418` fence building, `:1828` per passive child.
**[measured]** a single live transcript is 2 677 845 B.

**Fix** for the cron liveness check, read only the header plus the last `session_state` (tail read), or consult the resident `SessionManager` when the session is in-worker.

### H8. Worker recovery journal: fsync + chmod per record, compaction only when *all* sessions are idle

**file:line** `modes/daemon/worker-recovery-journal.ts:95-104` (`openSync` + `writeSync` + **`fsyncSync`** + `closeSync` + `chmodSync` per record), `:82-84` (`compact()` only when `[...latest.values()].every(e => !e.busy)`), `:106-113` (full rewrite).
Written from `modes/daemon/daemon-mode.ts:7833-7851` for every event in `RECOVERY_CHECKPOINT_EVENTS` (`:426-443` — 16 types including `tool_execution_start/end` and `rlm_child_update`), plus `:5037,5063,5106,5132,5146,2040,7392`. The `(busy, operation, sessionFile)` dedupe at `:68-74` suppresses repeats, but the normal alternating sequence is not deduped, and in a 19-session worker **some session is always busy**, so `compact()` never runs.
**[measured]** recovery journals total 28 553 180 B; largest 8 885 009 B / 26 419 records.

**Fix** add a size trigger (compact past ~256 KB) independent of the all-idle condition; drop the per-record `chmodSync`.

### H9. `process_heartbeat` fills 1.0 GB of logs; the retention prune runs once, at startup

**file:line** `core/process-lifecycle.ts:647-650` (`setInterval`, `HEARTBEAT_INTERVAL_MS = 60_000` at `:30`), `:373` + `:337` (`process.memoryUsage()` + `process.resourceUsage()` + sanitize per event), `:353` (`existsSync` + `statSync` per event), `:363-365` (`mkdirSync` + `appendFileSync` per event), `:22` (5 MB rotation, one `.old`), `:28` (14-day retention), `:420` + **`:651`** (the prune is armed with a single `setImmediate` at install and never re-runs).
**[measured]** `~/.prime/agent/logs/processes` = **1.0 GB / 3 378 files**; the largest live worker log is 5 143 780 B of which **5 656 of 5 660 records are `process_heartbeat`** (~897 B each).

**Scaling formula** `bytes/s = processes × 897 / 60` ≈ **2.8 KB/s written forever** across the fleet; a worker rotates a 5 MB log about every 4 days on heartbeats alone.

Amplification hazard: `core/session-lease.ts:435-448` calls `recordProcessLifecycle("process_identity_query_timing", …)` whenever a `/bin/ps` probe exceeds 100 ms — i.e. exactly when the worker is already stalled it adds another synchronous disk write. `modes/daemon/daemon-mode.ts:737-744` `traceRuntimeCreate` does the same per create stage (~12 stages per session create).

**Fix** make `pruneStaleProcessLogs` periodic (hourly); gate `process_heartbeat` behind a debug flag or raise it to 15 min.

### H10. Twelve extra node processes each waking 10×/s to compare `ppid`

**file:line** `cli/owned-session-worker.ts:155-157` — inside the `-e` gate wrapper source, `setInterval(() => { if (process.ppid !== originalParentPid) abandonForParentDeath(); }, 100)`. This runs in a **separate node process per worker**. Same poll in the worker itself at `:1134-1137`, but only when `process.channel` is absent (`:1130`), so normally inactive there.
**Scaling formula** `W` extra node processes × 10 wakeups/s = 120 timer wakeups/s fleet-wide, each with a full node runtime resident.
**Fix** the gate already handles `process.once("disconnect", …)` (`:153`); drop the poll where IPC is available, or raise it to 1 s.

---


### M1. `getEntries()` copies the whole entry array on every call

**file:line** `core/session-manager.ts:1807-1809` — `this.fileEntries.filter(...)`. Callers: `getSessionName` (`:1558`), `getSessionState` (`:1569`), `hasUserContent` (`:1594`), `getFlatTree` (`:1812`), `core/agent-session.ts:8084` `_loadRefinementHistory`, `core/agent-session.ts:9489` `_findAssistantEntryForMessage` (**per child assistant message**, C6), `modes/agent-connection/snapshot.ts:49` (per attach), `core/agent-session.ts:11864` `computeOwnAndTotalUsage`. `getSessionName` is on the per-flush roster path (C4).
Because C2 grows `fileEntries` by one entry per 25 s per session, this copy grows without bound.
**Fix** return a cached readonly view, invalidated on append.

### M2. `_emitQueueUpdate` does two full `JSON.stringify`s per call, purely to detect change

**file:line** `core/agent-session.ts:1525-1530`:
```ts
const actions = this.getSessionActionSnapshot();
if (JSON.stringify(actions) === JSON.stringify(this._lastSessionActionSnapshot)) return;
```
The snapshot embeds the full preview text of every queued message. Called from `:5663` (every admission), `:5770,5814,5901` (every pump transition), `:3510` (message_end), `:5925,5933,5955`, `:6388`, `:6481,6489,6530`.
**Fix** a version counter bumped by the mutators, or a structural comparison.

### M3. `createAgentConnectionState` scans all entries and rebuilds the branch

**file:line** `modes/agent-connection/snapshot.ts:49` — `sessionManager.getEntries().filter(e => e.type === "compaction").length` (O(E) copy + filter); `:56` `session.getContextUsage()` → `core/agent-session.ts:11800-11844`, which calls `sessionManager.getBranch()` (`core/session-manager.ts:1780-1791`, **a full O(E) array allocation of the leaf-to-root chain**) then `getLatestCompactionEntry` (reverse scan) then `branchEntries.lastIndexOf(latestCompaction)` (`:11815`, another O(E) scan).
Called from `modes/daemon/daemon-mode.ts:6212-6219` ← `createSessionSnapshot:5971` (every attach, replacement, catch-up) and `get_connection_state:5371`. C2 makes the branch mostly empty status nodes.
Per-turn: `_getThresholdContextTokens` (`core/agent-session.ts:11466-11467`) plus its own `getBranch()` at `:2758` and `:8527` ⇒ **two full branch rebuilds per turn**.
**Explicit negative:** token estimation itself is well optimised — `core/compaction/compaction.ts:173-201` only sums messages after the last usage record (`:190-193`); the full scan at `:177-180` runs only when no usage record exists at all. It is **not** on any per-event or per-token path.
**Fix** maintain a running compaction count; cache `getBranch()` keyed on `leafId`.

### M4. Trace upload reads and JSON-parses the whole transcript **twice**

**file:line** `core/agent-traces.ts:770` — `await readFile(sessionFile, "utf8")` of the entire transcript; then `:775` `activeGitContext(body, header)` → `:228-256`, which **splits the whole multi-MB body on `\n` and `JSON.parse`s every line** to build a `byId` map, just to find the active `git_state`. With traces enabled, `getAgentTracesEnabled` is additionally called three times per upload (`:726`, `:763`, `:793`), i.e. three settings reloads (C3).
**Fix** find the active `git_state` from the already-resident `SessionManager.byId` instead of re-parsing the file.

### M5. `getContextTree()` — heavy synchronous disk walk with `statSync` inside a sort comparator

**file:line** `core/agent-session.ts:11860-11897` → `core/context-tree.ts:300+`:
- `:211-236` `listChildSessionDirs` — `readdirSync` + `statSync` per entry, and **the sort comparator at `:232-236` calls `statSync` twice per comparison** ⇒ O(n log n) syscalls;
- `:194-210` `findSessionFile` — `readdirSync` + `statSync` per file, per child dir;
- `:150` `sessionEntriesFromFile` → `loadEntriesFromFile` — **`readFileSync` + `JSON.parse` of every line of each child's whole transcript**;
- `:142` `estimateContextTokens(buildSessionContext(allEntries).messages)` per child; recurses into grandchildren.
Triggered only by `get_context_tree` (`modes/daemon/daemon-mode.ts:5397`), but one `/context` on a wide tree fully blocks the worker.
**Fix** hoist the `statSync` into a decorate-sort-undecorate; cache child entry loads.

### M6. `this.log()` writes three places, with a stat per line

**file:line** `modes/daemon/daemon-mode.ts:714-718` — `console.error` + `structuredLog.warn` + `appendRotatingLog`; `config.ts:604,612` — `appendRotatingLog` does `mkdirSync(recursive)` + `existsSync` + `statSync` + `appendFileSync` **per line**. Worker stderr is relayed to the supervisor, which logs it again, so one worker log line becomes ~5 writes across two processes.
**[measured]** `agent.jsonl` 11.5 MB (rotates at 20 MB), `daemon.sock.a9cccd67.log` 4.7 MB, one worker log 4.4 MB — dominated by the C5 fence-timing lines.
**Fix** buffer `appendRotatingLog` and size-check every N lines; downgrade fence timing to a counter.

### M7. `Atomics.wait` and synchronous spin loops block the whole event loop

**file:line** `core/authority-mutation-guard.ts:378` (`Atomics.wait(guardWaitBuffer, 0, 0, retryMs)`; `core/session-lease.ts:982-983` passes `attempts: 100, retryMs: 10` ⇒ up to **1 s frozen**), `core/orphan-process-journal.ts:748` (10 ms per retry up to 1 s), `core/cron-jobs.ts:1525` (10 ms × up to 100 attempts, allocating a fresh `SharedArrayBuffer` each time), `core/settings-manager.ts:264-267` (a literal `while (Date.now() - start < 20) {}` busy-spin, up to 10 times ⇒ 200 ms at 100 % CPU).
**Fix** convert the callers to async and `await delay()`; at minimum cut the attempt ceilings.

### M8. Guard publish/release does 3 fsyncs and ~10 lstats per lock, and throws for control flow

**file:line** `core/authority-mutation-guard.ts:299-345` (`publishGuard`: `openSync` O_EXCL + `writeAllSync` + **`fsyncSync`** + `chmodSync` + `fstatSync` + `linkSync` + `lstatSync` + re-read + `unlinkSync` + **`fsyncDirectory`**), `:385-407` (`assertFilesystemCurrent`: `fstatSync` + `lstatSync` + a full re-read — and `withRegistryGuards` calls `guard.assertCurrent()` after **every** directory acquire at `modes/daemon/daemon-supervisor-ownership.ts:715` and again at `:721`), `:413-451` (`release`: `linkSync` + 2 `lstatSync` + re-read + `unlinkSync` + **`fsyncDirectory`**), `:154-180` (`openPinnedGuardFile`: 2 `lstatSync` per call).
The 208 samples in `v8::internal::Isolate::CaptureAndSetErrorStack` **[measured on pid 6346]** come from `lstatSync` throwing ENOENT inside these `try/catch` blocks — V8 builds a full stack trace for each swallowed error.
**Fix** use `lstatSync(path, {throwIfNoEntry: false})` to eliminate the exception construction; hoist the duplicated `assertCurrent()`.

### M9. `canonicalSessionPath` is `realpathSync` and is called in loops

**file:line** `core/session-lease.ts:259-270`. Loop callers: `modes/daemon/daemon-mode.ts:1806,1819,1730,1755,2093,2097,2102-2113,3128-3133`, `:7211-7213` (`findActiveSessionByFile` — a realpath per session per call), `:7602-7607` (`rosterEntryForSessionPath` — a realpath per composed roster entry).
**Fix** one process-wide `Map<string,string>` memo; session files do not move.

### M10. Subprocess reaping polls `/bin/ps` every 25 ms

**file:line** `core/orphan-process-journal.ts:1471-1481` (bounded 500 ms / 1 000 ms at `:1522,1528`), `core/kernel/repl-manager.ts:418-431` (**bounded 5 000 ms**, called at `:830,846`), `utils/contained-shell.ts:639-645`. Each iteration runs a `/bin/ps`-backed probe.
A single 5 s `waitForOrphanCandidateDeath` is up to **200 synchronous `/bin/ps` forks**; `retireCleanupProvenKernelAuthorities` (`repl-manager.ts:815-871`) runs it per candidate in two nested loops, so a kernel teardown with K children can fork `ps` 200·K times. `reapOrphanProcessCandidate` (`:1503-1529`) adds ~8 more before the loops start. `repl-manager.ts:815-871` also calls `trackKernelJournalChildren` **three times per lineage** (`:781,801,842,859`) — three full journal reads per teardown.
**Fix** exponential backoff (25→50→100→250 ms) and a `process.kill(pid, 0)` fast path before the `ps` probe.

### M11. `session-artifacts` is 8.8 GB; kernel snapshots re-pickle every 1.5 s of activity

**file:line** `core/kernel/repl-manager.ts:2840-2846` with `DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500` (`core/kernel/shared.ts:8`) — after every successful cell the whole Python namespace is dill-pickled to disk.
**[measured]** `~/.prime/agent/session-artifacts` = 8.8 GB across 226 directories.
**Scaling formula** `bytes/s = active_kernels × namespace_size / 1.5 s`.
**Fix** raise the debounce; skip the write when the namespace hash is unchanged.

### M12. `_rebuildSystemPrompt` re-reads harness state from disk twice, every time

**file:line** `core/agent-session.ts:8073-8079` `_loadMergedHarnessState()` → `core/refinement.ts:281-301` `loadHarnessState` = `existsSync` + `readFileSync` + `JSON.parse`, **twice** (global + local), on every `_rebuildSystemPrompt` (`core/agent-session.ts:4440`), which fires from `setActiveToolsByName` (`:4243`), `_refreshToolRegistry` (`:9116`), `_ensureGoalRuntimeActive` (`:2076`), `_applyRefine` (`:8416`), `setRlmMaxDepth` (`:11433`), `_reloadRlmMaxDepthFromBranch` (`:1677`).
**Fix** cache by `(path, mtime)`.

### M13. `SessionManager._persist` scans entries and `mkdir`s on every append

**file:line** `core/session-manager.ts:1390-1408`. Per append: `:1393` `fileEntries.some(e => e.type === "message" && e.message.role === "assistant")`, `:1400` `existsSync`, `:1404` **`mkdirSync(dirname, {recursive:true})` on a directory that already exists**, `:1405` `appendFileSync`.
Precision note: the `.some()` short-circuits at the **first** assistant message, so in a normal session it is O(1)–O(5), not O(N). It is only a full scan for a session that has not yet produced an assistant message — and that case also sets `flushed = false` (`:1396`), which makes the *next* append a **full-file rewrite** via `_rewriteFile` (`:1400-1402` → `:1279-1298`: `JSON.stringify` of every entry + `writeFileSync` + `chown` + `chmod` + `rename` + `rmSync`).
**No `fsync` anywhere in `SessionManager`** — that part is fine.
**Fix** cache the has-assistant boolean; hoist the `mkdirSync` out of the per-append path.

### M14. `createSessionSnapshot` builds the passive child list up to four times

**file:line** `modes/daemon/daemon-mode.ts:5961-5969` — `buildRlmChildSnapshotsWithPassiveRlmSubagents` is called once, then up to `MAX_SESSION_SNAPSHOT_STABILIZATION_RETRIES = 3` more times (`:282`) if the session object identity changed. Each call is a full H4 ledger read plus a `readSessionInfo` per passive child.
**Fix** compare `session.sessionId` instead of object identity; reuse the ledger snapshot across retries.

### M15. Auto-refine serialises the whole conversation then discards all but 80 KB

**file:line** `core/agent-session.ts:8280` — `serializeConversation(convertToLlm(this.agent.state.messages)).slice(-80_000)`; also `:8061` `reviewAutoRefine(this.agent.state.messages, …)`. Turn-interval triggered, not periodic.
**Fix** slice the message array before serialising.

---


### L1. Unbounded growth

| What | file:line | Why it never shrinks |
|---|---|---|
| **`_rlmChildSessions`** — holds a whole `AgentSession` (with its full `messages` array) per finished child | `core/agent-session.ts:1197`; comment at `:1195-1196` says retention is deliberate; removed only by `_removeRlmSubagentTracking` (`:10000-10015`) or dispose | **the primary memory + per-event-CPU scaling factor with child count**; iterated by at least 8 methods (`:10200,10238,10256,10267,10325,10351,10379`) |
| `_deletedRlmChildIds`, `_rlmChildCleanupFailures`, `_rlmChildUnsubscribes`, `_abandonedRlmQuiescenceChildIds` | `core/agent-session.ts:1198,1201,1211,1192` | keyed per child, same lifecycle |
| **`_unpersistedOutcomes`** | `core/agent-session.ts:1132`; pushed at `:8325`, `:8638`; **never trimmed** | re-merged into the message array on **every** `buildSessionContext()` (`:4264` → `_mergeUnpersistedOutcomes`, `:4268-4276`, a backwards walk per outcome) |
| `_lateIpythonSentAgentMessages` | `core/agent-session.ts:1130`; cleared only wholesale at `:1533` | grows per ipython tool call that sent an agent message |
| `fileEntries` / `byId` | `core/session-manager.ts:1132-1133` | monotonic for the session's life; `byId` entries survive branch navigation. C2 adds one per 25 s |
| `rosterReporter.lastComposed` / `lastComposedJson` | `modes/daemon/daemon-mode.ts:663-664`; re-inserted at `:7759-7770` | `flushRoster` re-adds every vanished agent as a "passivated" row **from `lastComposed` itself**, so entries are immortal; each flush `JSON.stringify`s all of them (`:7774`) |
| `cronStore.sessionArtifactFiles` | `core/cron-jobs.ts:170`; registered at `:191-201` | **no unregister**; every session ever hosted is re-read on every scan |
| `trackedDetachedChildren` | `utils/shell.ts:191,221-227` | `untrackDetachedChildPid` returns early without deleting whenever `retireOrphanProcess` cannot prove death (`core/orphan-process-journal.ts:1404-1421` requires both leader gone **and** `kill(-pid,0) → ESRCH`); one surviving grandchild pins the entry for the worker's life and leaves the journal record un-retired |
| `kernelOrphanCandidates`, `kernelPidsAwaitingDescendantCleanup`, `windowsTargetsAwaitingJobEmptyProof`, `windowsHeldJobEmptyProofs` | `core/kernel/repl-manager.ts:565,567,569,571`; deletes at `:797,838,854,868,905,1565` | all deletes gated on unprovable death |
| `sessionInfoCache` | `core/session-manager.ts:951` | pruned only for the directory currently being listed (`:1101-1106`); other directories persist for process life |
| Correctly bounded, for contrast | `handledHostRequestIds` ≤1024 (`repl-manager.ts:96,2386`), `lateSentAgentMessageHandlers` ≤256 (`kernel/shared.ts:13`), `kernelStderr` ≤32 KB (`repl-manager.ts:99`), `pendingBackgroundOutput` ≤64 KB (`repl-manager.ts:98`), `peerGrants` ≤1024 (`daemon-mode.ts:465`), `dispatchLanes` self-cleaning (`cron-jobs.ts:1039-1043`) | — |

### L2. Other repeated-scan spots

- `core/agent-session.ts:11757-11768` `getSessionStats()` — three `.filter()` passes over all messages plus a fourth `for` loop; one pass would do.
- `core/session-manager.ts:1743-1751` `getChildren` — full `byId` iteration per call.
- `core/agent-session.ts:1552-1556` — reverse scan over all messages per late-ipython sent message.
- `core/agent-session.ts:9433,9439,9449-9460` — `mkdirSync` per kernel build, plus a 100-attempt retry loop on child dir creation.
- `core/agent-session.ts:9212` — `existsSync(snapshotPathIn(...))` per runtime build.
- `core/aim-external-auth.ts:280-315` `assertTrustedAimExecutable` — `lstatSync` + `statSync` on the file **and on every parent directory up to `/`**; called at `:394` and `core/aim-usage.ts:76`.
- `utils/shell.ts:136-166` `sanitizeBinaryOutput` — `Array.from(str)` + per-code-point `.filter()` + `.join("")` on **every** bash output chunk; async and bounded, but a high constant factor.
- `utils/child-process.ts:32,42` `isZombieProcess` — a `readFileSync("/proc/<pid>/stat")` that **always** fails on darwin, then `execFileSync("ps", …)`. Supervisor-only (`daemon-supervisor.ts:4217,4646`).

### L3. Confirmed *not* a problem

- **`core/exec.ts` and `core/bash-executor.ts` are clean.** Fully async `spawn` + streams, no sync fs, no polling. `exec.ts:80-85` uses a bounded SIGTERM→SIGKILL ladder with `clearTimeout` at `:113`; `bash-executor.ts:80-83` bounds `outputChunks` to `DEFAULT_MAX_BYTES * 2` (`:48`).
- **`core/agent-session.ts`, `core/session-manager.ts`, `core/agent-session-runtime.ts` and `core/rlm-runtime.ts` contain no `setInterval` and no long re-armed `setTimeout`** (only one-shots at `agent-session.ts:3986,7361,7897,11115` and `session-manager.ts:598,639`). All periodic work lives in the daemon/worker layer.
- **Nothing in `agent-session.ts` or `session-manager.ts` re-reads the session file** on events, status refreshes, `get_state`, snapshot building, or child updates — those all read the in-memory `fileEntries`/`byId`. The whole-file reads are `loadEntriesFromFile` (`session-manager.ts:614-617`), `scanSessionInfo` (`:969-1075`), the trace upload (`agent-traces.ts:770`, M4) and `context-tree.ts:150` (M5).
- **There is no periodic orphan-journal sweeper** — every journal read is append- or teardown-driven.
- **The Python kernel is event-driven, not polled** (H1).
- **The 20+ threads per worker are not JS timers.** They are the libuv threadpool plus V8 platform threads, driven by the `fs.*Sync` / `execFileSync` volume above.
- **`ROSTER_HEARTBEAT_INTERVAL_MS = 15_000`** (`modes/daemon/daemon-worker-protocol.ts:53`, armed at `daemon-mode.ts:811-815`, `.unref()`'d) is one socket write per worker per 15 s — 0.8 frames/s fleet-wide. Negligible.
- **`MutationDrainLatch`** (`modes/daemon/mutation-drain-latch.ts`) is O(waiters) and correct.
- The status prompt context **is** bounded — `daemon-session-summarizer.ts:81` slices to 8 messages with 600-char clamps (`:14-15`).
- `core/tools/bash.ts:377`'s 1 s interval is a TUI render invalidation and does not run in a detached worker; likewise every timer in `modes/interactive/*` and `modes/agents-view/*`.
- `modes/daemon/daemon-supervisor-ownership.ts:216-220`'s 1 s renewal timer only runs while a shutdown-admission or offline-maintenance record is held — not steady state.
- `recovery-snapshots` (33 GB) is four dated one-off backups from 2026-08-11, not ongoing growth.

### L4. Not determinable from the code

- Which of the two causes drives C2 in this deployment: the summary model `prime-inference/qwen3-30b-a3b-instruct-2507` being unresolvable (`daemon-session-summarizer.ts:40-46`, no network call) versus the model call failing. **[measured]** 36 982 records with `summary:""` prove the loop is active; the code does not distinguish.
- Actual event rates per session (tool calls/s, tokens/s). The scaling formulas are given per event, because the code does not fix the rate.

---


Everything below runs with no user, no model call, and no agent work in progress.

| Source | file:line | Rate | Work per firing |
|---|---|---|---|
| Supervisor fence poll | `daemon-mode.ts:421,903-938` | **4 Hz** | 1 synchronous `/bin/ps` fork + 2 `mkdirSync` + 2 `realpathSync` + 4 `readFileSync`+`JSON.parse` + 1 sha256 |
| Summarizer sweep | `daemon-session-summarizer.ts:227-231` | 0.04 Hz | iterates all 19 sessions; each still-empty-summary session does one model-call attempt and one `appendFileSync` ⇒ **0.76 transcript appends/s per worker**, 9.2/s fleet-wide |
| Trace flush woken by those appends | `agent-traces.ts:867-882,726`; `settings-manager.ts:274-306` | 19/60 s ≈ 0.32 Hz | **2 exclusive `proper-lockfile` acquire/release on the shared `settings.json`** (mkdir + stat + read + rmdir), then returns "disabled" |
| Cron `scheduleNext` re-arm | `cron-jobs.ts:1047-1071` → `:781` | per due job (≥ every 5 min per heartbeat) | `19 × readFileSync + JSON.parse` of `scheduled-jobs.json` |
| Roster flush | `daemon-mode.ts:7702-7806` | once per `agent_status` change / heartbeat change | `19 × (statSync + full message scan + full entry-array copy + JSON.stringify)` + a 19-file cron scan |
| `process_heartbeat` | `process-lifecycle.ts:647-650` | 0.017 Hz | `memoryUsage` + `resourceUsage` + `existsSync` + `statSync` + `appendFileSync` (~897 B) |
| Roster heartbeat frame | `daemon-mode.ts:811-814` | 0.067 Hz | one socket write |
| Parent-death gate process | `cli/owned-session-worker.ts:155-157` | **10 Hz**, in a separate node process | one `getppid` compare |

**Idle steady state per worker:** ≈ **4 `/bin/ps` forks/s**, **~0.76 transcript `appendFileSync`/s**, **~0.64 exclusive settings-lock cycles/s on a file shared with 11 other workers**, ~16 small `readFileSync`+`JSON.parse`/s, ~8 `realpathSync`/s, one `statSync` per session per roster flush, plus 10 timer wakeups/s in a sidecar process.
**Fleet idle:** **≈ 48 synchronous `ps` forks/s, ≈ 9.2 transcript appends/s, and ≈ 7.7 exclusive lock cycles/s on one `settings.json`** — none of which does any agent work. Once a session is *not* idle, C1 (journal), C4 (roster) and C6 (child fan-in) dominate and grow with `S`, `M` and `B`.

---


1. **`daemon-session-summarizer.ts:358` and `:328-332`** — gate the persist on `changed`, and stop re-storing an empty `summary`. Two lines. Kills the 25 s write loop and, transitively, the settings-lock storm (C3), the session-info cache invalidation (H7), and the ongoing transcript bloat that slows every later scan. *(C2)*
2. **`core/agent-traces.ts:726`** — drop the `reload()` from the enabled check (or cache it with a TTL); **`core/settings-manager.ts:394-406`** — stop taking an exclusive lock for a read; **`:264-267`** — remove the busy-spin. *(C3)*
3. **`core/orphan-process-journal.ts:524-529`** — memoize the worker's own process identity; **`:1053`** — delete the post-append verification re-read; **`:877-975`** — compact on append. Removes 4 `ps` forks + 2 full-file parses per bash call and caps the journal. *(C1)*
4. **`daemon-mode.ts:421` / `:4274`** — raise `SUPERVISOR_FENCE_POLL_MS` to 5 000, cache the identity observation so per-command admission reuses it, and rely on socket close (`:3970-3996`) for liveness. Removes ~44 of the 48 idle `ps` forks/s. *(C5)*
5. **`daemon-mode.ts:7715-7806` + `daemon-session-list.ts:230,248,255,261`** — make `flushRoster` recompute only dirty rows; cache `latestMessageActivityAt`; drop the per-session `statSync` and the `getEntries()` copy; skip the three fields `agent-roster.ts:78` discards. *(C4)*
6. **`agent-session.ts:10649-10655`** — throttle `answerPreview`/`emitChildUpdate` to `message_end` plus a 250 ms timer; index sessions by `rlmChildId` (`daemon-mode.ts:8037-8052`, `:7664-7672`); replace `getEntries().find()` at `:9489` and `slice().reverse().find()` at `:10626`. *(C6)*
7. **`rlm-ledger.ts:996-1004`** — cache `replaySync` by `(mtimeMs, size)`; memoize `canonicalSessionPath`. *(H4, M9)*
8. **`cron-jobs.ts:1541`** — cache `readJobsState` by `(path, mtime, size)`; prune terminal jobs on write. *(H3)*
9. **`session-manager.ts:1640-1647`** — cache `captureGitContext` per `(cwd, .git/HEAD mtime)`. *(H5)*
10. **`process-lifecycle.ts:651`** — make the retention prune periodic; raise the heartbeat interval. **`worker-recovery-journal.ts:82`** — add a size trigger to `compact()`. *(H9, H8)*


## 3. TUI client

Source: Opus 5 audit of `modes/interactive`, `modes/agents-view`, `modes/agent-connection`, `daemon-client`, footer/resource/skills/git code, `packages/tui`, and the aim footer extension, plus `sample` profiles of three live TUIs (pids 6166, 89681, 74971).

Repo: `/Users/aelaguiz/workspace/prime-agent` (packages/coding-agent, packages/tui)
Installed bundle under audit: `~/.prime/installs/path-resume-fix-20260902/lib/node_modules/prime-agent/dist/bundle/cli.js`
Live measurement taken during this audit: `sample` on three attached TUI clients (pids 6166, 89681, 74971) on 2026-09-02.
Fleet state at measurement time: **204 daemon worker processes**, **163 saved session files** (`~/.prime/agent/sessions`, 1.5 GB), 32 attached TUIs.

**Headline: the lstat storm is not a directory walk and not glob/path-scurry. It is `fs.realpathSync` called once per live roster entry and once per saved session, inside `reconcileUnifiedSessions`, re-run from scratch on every roster push and every heartbeat push. It is proven by profile, not inferred.**

---

### Top 10, by severity

| # | Sev | What | file:line | Trigger / frequency | Cost at 32 TUIs | Fix (1–2 sentences) |
|---|-----|------|-----------|---------------------|-----------------|---------------------|
| 1 | **critical** | `reconcileUnifiedSessions` calls `realpathSync` per live roster entry **and** per saved session; nothing is memoized | `modes/agents-view/agents-view-state.ts:136,140,144,156,190` via `utils/paths.ts:10` | every `roster_update` push, every `heartbeats_changed` push, 15 s poll, every `refreshSessions` | **43–47 % of a core per TUI is inside the `lstat` syscall** (measured); ≈ 2,200 lstat syscalls per reconcile at N=367 | Memoize `canonicalSessionPath` in a module-level `Map<string,string>` (session files never move), or drop `realpathSync` entirely and use `resolve(path)` — identity only needs to be stable, not symlink-resolved. |
| 2 | **critical** | `reconcileCatalogs()` is called **once per streamed saved session** during a saved-catalog refresh → O(N²) realpath + O(N) full row rebuilds + O(N) repaints | `modes/agents-view/agents-view-mode.ts:2200-2206` (`onSession` callback) | every `refreshSavedSessions()` | 163 reconciles × 367 realpath × 6 lstat ≈ **359,000 lstat syscalls per catalog refresh**, plus 163 `ui.requestRender()` | Accumulate streamed sessions and call `reconcileCatalogs()` once on completion, or throttle the progressive callback to ~200 ms. |
| 3 | **high** | `reconcileCatalogs()` rebuilds every derived structure (unified records, index, scope frames, subtree, rows) and repaints, with no coalescing | `modes/agents-view/agents-view-mode.ts:2146-2177` | same triggers as #1 | O(N_live + N_saved) allocations + full repaint per roster/heartbeat push | Coalesce reconciles behind a single `setTimeout(…, 100)`/animation-frame latch; diff the roster delta instead of rebuilding from the full list. |
| 4 | **high** | Agents-view animation timer rebuilds **all rows** 4×/s whenever any row has `lastHeardFromAt` (i.e. essentially always) and repaints | `modes/agents-view/agents-view-mode.ts:895-904` (`WORKING_ICON_INTERVAL_MS = 250`, `modes/interactive/theme/working-icon.ts:4`) | every 250 ms, idle or not | 32 TUIs × 4 full row rebuilds + repaints/s, independent of any data change | Only re-render the age column (or bump a frame counter and let the row renderer read it) instead of calling `rebuildRows()`; skip the tick when the view is not visible. |
| 5 | **high** | aim extension `session-title-footer.ts` 1 s interval calls `update(ctx, false, true)` with `force = true`, so it re-pushes `setWidget` + `setTitle` to every attached client every second even when nothing changed | `~/.prime/agent/extensions/session-title-footer.ts` (`refreshTimer = setInterval(…, 1000)` in the `session_start` hook) | 1 Hz per session worker, fanned out to every attached client | 204 workers × 1 Hz socket write; each client tears down and rebuilds the widget `Container`/`Text` components and calls `renderWidgets()` → `ui.requestRender()` (`modes/interactive/interactive-mode.ts:3571-3601, 3658-3663`) plus an OSC title write, 1×/s minimum | Drop `force: true` and rely on the existing `lastRenderedWidget` equality check; re-send the unchanged banner only on a client-attach event, not on a timer. |
| 6 | **high** | Same extension scans the **entire transcript** 2–3× per second: `isHumanOwnedTitle` iterates all entries, `sessionBindings` iterates all entries, both called from the 1 s tick | same file (`isHumanOwnedTitle`, `sessionBindings`, `resolveAccount`, `maybeUpgradeFromRecap`) | 1 Hz per worker | O(entries) × 3 per second × 204 workers; a 5,000-entry session = 15,000 entry visits/s/session in the worker process | Compute the title from the last entry (`latestAgentRecap` already walks backwards — stop at the first hit) and cache `sessionBindings` until a new `custom` entry arrives. |
| 7 | **medium** | Uncapped full-transcript rebuild on reconnect, compaction, `/reload`, thinking-block toggle | `modes/interactive/interactive-mode.ts:2983-2986` (`renderResyncedSession`), `:6749-6752` (`rebuildChatFromMessages`), `:6563-6685` (`renderSessionContext`) | every `session_resynced` (daemon reconnect), every compaction end (`:5751`), every `/reload` | O(all messages) component construction + markdown re-lex per rebuild; on a long session this is seconds of blocked main thread | Reuse the 400-message cap (`INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT`, `:574`) on the resync/rebuild paths too. |
| 8 | **medium** | No coalescing on streaming renders: `message_update`, `tool_execution_update`, `bash_output` each call `ui.requestRender()` per delta/chunk | `modes/interactive/interactive-mode.ts:5602, 5666, 5514` | per token / per shell output chunk | bounded by the TUI's own 16 ms frame cap (`packages/tui/src/tui.ts:322, 844-861`), so the repaint rate is capped at 60 fps — but each repaint is a **full tree re-render** (#9) | Leave the calls, but reduce repaint cost (#9) or lower `MIN_RENDER_INTERVAL_MS` to 33 ms for attached-but-unfocused clients. |
| 9 | **medium** | Every repaint re-renders the whole component tree and does an O(total rendered lines) line-by-line ANSI diff | `packages/tui/src/tui.ts:274-288, 1561, 1714-1722`; `components/box.ts:86-88` | every repaint | Markdown is fully re-lexed per render (`packages/tui/src/components/markdown.ts:253`) → O(n²) over a streaming response's length | Cache the marked lexer output keyed on the text prefix, and early-out container subtrees whose children are all cache-valid. |
| 10 | **medium** | `filterUnifiedSessions` re-parses the search query once per record per rebuild | `modes/agents-view/agents-view-state.ts:396-413` → `modes/agents-view/session-view-search.ts:139-142` | every `rebuildRows()` (4×/s, #4) and every reconcile (#1) | N_records query re-parses × 4/s × 32 TUIs | Parse the query once per `rebuildRows()` call and pass the parsed form down. |

---

### The lstat question — answered, with evidence

#### What the profile actually shows

`sample <pid> 2` on three attached TUIs. All three have an identical main-thread shape:

```
uv_run → uv__io_poll → uv__stream_io → LibuvStreamWrap::OnUvRead
      → EmitToJSStreamListener::OnStreamRead → CallJSOnreadMethod
      → v8::Function::Call → [JS socket data handler]
      → MicrotaskQueue::PerformCheckpointInternal → RunMicrotasks
        → [JS frame A]                      (queueMicrotask emit)
          → [JS frame B]                    (onRosterUpdate → reconcileCatalogs)
            → [JS frame C]  ← the loop      (reconcileUnifiedSessions)
              ├─ [JS frame D] ─┐            (summaryIdentityAliases)
              └─ [JS frame E] ─┴→ [JS frame F] → node::fs::LStat → uv_fs_lstat → lstat(2)
                                              (savedIdentityAliases) (canonicalizePath/realpathSync)
```

Per-process numbers (1 ms sampling):

| pid | main-thread samples | in this path | top-of-stack in `lstat(2)` |
|-----|--------------------|--------------|-----------------------------|
| 6166 | 1725 | 868 (50 %) | 804 (**47 %**) |
| 89681 | 1714 | 828 (48 %) | ~805 (**47 %**) |
| 74971 | 1718 | 1381 (80 %) | 747 (**43 %**) |

Raw samples saved at `/private/tmp/claude-501/-Users-aelaguiz-workspace-aimgr/8e617d07-dfb4-4b44-b6c4-798e97ab09ca/scratchpad/sample6166.txt`, `s89681.txt`, `s74971.txt`.

#### Why this is `fs.realpathSync`, not glob/path-scurry

The JS frames are unsymbolized (`??? (in <unknown binary>)`), but the V8 builtins interleaved with the `lstat` calls identify the function unambiguously. Node's JS-implemented `fs.realpathSync` (`lib/fs.js`) is the only Node API whose body contains **all** of these together:

- `Builtins_SetConstructor`, `Builtins_SetPrototypeAdd`, `Runtime_SetGrow`, `Builtins_FindOrderedHashSetEntry` → `const knownHard = new SafeSet()` plus `knownHard.has(base)` / `knownHard.add(base)` per path component.
- `Runtime_BigIntToNumber` / `Builtins_ToNumberConvertBigInt` → `binding.lstat(baseLong, /* bigint */ true)` followed by `isFileType()`'s `Number(mode)` coercion of the BigInt mode field.
- `Builtins_StringIndexOf`, `Builtins_StringSubstring`, `Builtins_StringAdd_CheckNone`, `Runtime_StringCharCodeAt` → the `p.indexOf(sep, pos)` / `p.slice()` / `charCodeAt` component walk.
- A **flat** (non-recursive) stack — a `glob`/path-scurry tree walk would show recursion depth; `realpathSync` is one function with a `while` loop.
- The syscall is **synchronous** `lstat` on the main thread inside `node::fs::LStat` (async `fs.lstat` would run on a libuv worker thread; those threads are all parked in `uv_cond_wait` in every sample).

`glob@13`/path-scurry **is** in the bundle, but `globSync` is reachable only from `core/package-manager.ts:2080` (`collectFilesFromManifestEntries`), which runs only inside `resourceLoader.reload()` (`core/resource-loader.ts:336`) — a startup-only path (`core/agent-session-services.ts:178`) plus the explicit `/reload` command (`modes/interactive/interactive-mode.ts:9038`). It is not on any repeating path. **The operator's "only `lstat(` call site is path-scurry" reading of the bundle was a false lead: the hot `lstat` comes from Node's own `lib/fs.js`, which is inside the node binary, not the bundle.**

#### The exact caller

```
modes/agents-view/agents-view-state.ts:136   function canonicalSessionPath(path) { return resolve(canonicalizePath(path)); }
modes/agents-view/agents-view-state.ts:140   function fileIdentity(path) { return `file:${canonicalSessionPath(path)}`; }
modes/agents-view/agents-view-state.ts:144   function summaryIdentityAliases(summary)  →  fileIdentity(summary.sessionFile)      ← call site 1
modes/agents-view/agents-view-state.ts:156   function savedIdentityAliases(saved)      →  fileIdentity(saved.path)                ← call site 2
modes/agents-view/agents-view-state.ts:190   export function reconcileUnifiedSessions(daemonSummaries, savedSessions, heartbeats)
                                                 for (const daemon of daemonSummaries) summaryIdentityAliases(daemon)   ← loop 1
                                                 for (const saved of savedSessions)    savedIdentityAliases(saved)      ← loop 2
utils/paths.ts:10                            export function canonicalizePath(p) { return realpathSync(p); }
```

Two sibling JS frames under one parent, both calling the same leaf — exactly the profile shape. The observed split (6166: 447/402; 74971: 808/537) tracks `N_live_roster : N_saved_sessions` ≈ 204 : 163. In both samples the two sibling frames' JIT addresses are **0x470 apart**, consistent with two adjacent function definitions in the same source file (lines 144 and 156).

`realpathSync` is called with no `cache` option, so nothing is reused between the 367 calls, and nothing is reused between reconciles.

#### The chain that fires it

```
supervisor: any roster mutation (agent status, token count, activity)
  → daemon-supervisor.ts:5305 scheduleRosterPush()  [coalesced per setImmediate]
  → daemon-supervisor.ts:5314 flushRosterUpdates() → write {type:"roster_update"} to EVERY roster-subscribed client
client: daemon-client.ts:458 JSON.parse(line)
  → roster-store.ts:42 applyUpdate() → scheduleEmit() → queueMicrotask   ← the microtask checkpoint in the profile
  → agents-view-mode.ts:2124 onRosterUpdate()
  → agents-view-mode.ts:2139 applySessionList() → :2146 reconcileCatalogs()
  → agents-view-state.ts:190 reconcileUnifiedSessions()   ← 367 × realpathSync × ~6 lstat
  → :2176 this.ui.requestRender()
```

Same entry point from `heartbeats_changed` (`agents-view-mode.ts:855` → `refreshHeartbeats` → `:2253 reconcileCatalogs`) and from the 15 s `heartbeats_list` poll (`:893`).

#### Scaling formula

```
lstat_syscalls_per_sec_per_TUI
    = reconcile_rate_hz × (N_live_roster + N_saved_sessions) × path_components

reconcile_rate_hz = roster_update_pushes/s + heartbeats_changed_pushes/s + 1/15
```

Today: `N_live_roster ≈ 204`, `N_saved_sessions = 163`, `path_components = 6`
(`/Users`, `/Users/aelaguiz`, `/.prime`, `/agent`, `/sessions`, `/<uuid>.jsonl`)
→ **≈ 2,200 lstat syscalls per reconcile per TUI**.

Back-solving from the measurement (0.43–0.47 core in `lstat`, ~1.3 µs/lstat warm APFS) gives **≈ 500,000 lstat/s per TUI ⇒ ≈ 230 reconciles/s per TUI**, i.e. the supervisor is pushing roster/heartbeat frames at a few hundred Hz. Across 32 TUIs that is **~16 million lstat syscalls per second machine-wide**, all redundant.

Everything in the formula is multiplicative and everything is growing: more agents raises `N_live_roster` **and** `reconcile_rate_hz`, more history raises `N_saved_sessions`, more panes raises the TUI multiplier. **Cost is quadratic in fleet size and linear in session-history size.**

#### The one-line fix

```ts
// utils/paths.ts  (or local to agents-view-state.ts)
const canonicalCache = new Map<string, string>();
export function canonicalizePath(path: string): string {
  const hit = canonicalCache.get(path);
  if (hit !== undefined) return hit;
  let out: string;
  try { out = realpathSync(path); } catch { out = path; }
  canonicalCache.set(path, out);
  return out;
}
```

Session files are created once and never relocated, so an unbounded process-lifetime cache is correct here. This alone should remove ~45 % of every TUI's CPU. The better fix is to stop symlink-resolving for identity at all: `fileIdentity` only needs a *stable* key, and `resolve(path)` gives one with zero syscalls.

---

### 1. Every periodic timer in the TUI client

| file:line | Period | Work | Scales with |
|---|---|---|---|
| `modes/agents-view/agents-view-mode.ts:895` | **250 ms** (`WORKING_ICON_INTERVAL_MS`) | `rebuildRows()` (filter + sort + build every row) + `ui.requestRender()` whenever any row has `lastHeardFromAt` — near-always | N_rows; **runs while idle** |
| `modes/agents-view/agents-view-mode.ts:893` | 15 s (`HEARTBEAT_POLL_INTERVAL_MS`, `:102`) | `heartbeats_list` RPC → `reconcileCatalogs()` | N_live + N_saved (see #1) |
| `~/.prime/agent/extensions/session-title-footer.ts` | **1 s** | worker-side: 2–3 full `getEntries()` scans + `execFileSync git` only on `agent_start`/`agent_end`; client-side: forced widget rebuild + repaint + OSC title | transcript length (worker), 1 repaint/s (client) |
| `modes/interactive/interactive-mode.ts:3421` | 250 ms | `tickWorkingPulse()` → unconditional `ui.requestRender()` | only while streaming |
| `modes/interactive/interactive-mode.ts:3263` | 1 s | `updateWorkingLoaderMessage()` | only while streaming |
| `modes/interactive/interactive-mode.ts:5885` | 1 s | goal-tray tick → `ui.requestRender()` | only while a goal is active |
| `modes/interactive/interactive-mode.ts:3353` | `FEATURE_HINT_ANIMATION_INTERVAL_MS` | hint animation → `ui.requestRender()` | only while a hint is shown |
| `modes/interactive/interactive-mode.ts:9929` | min(60 s, next-run), 5 s floor | heartbeat-manager refresh RPC | only while that overlay is open |
| `packages/tui/src/components/loader.ts:69` | 80 ms | spinner frame + `ui.requestRender()` | any active loader → 12.5 repaints/s |
| `packages/tui/src/terminal.ts:597` | 1 s | OSC 9;4 progress keepalive | constant |
| `packages/tui/src/tui.ts:849` | ≤16 ms | render coalescing timer (not periodic; a throttle) | — |
| `core/footer-data-provider.ts:293` | **250 ms** `watchFile` poll | `stat` poll of `<gitdir>/reftable/tables.list`, layered on top of an `fs.watch` on the same file | only in reftable repos; 4 stat/s/TUI |
| `core/process-lifecycle.ts:647` | `HEARTBEAT_INTERVAL_MS` | `process_heartbeat` log line (`appendRotatingLog` → `existsSync`+`statSync`+`appendFileSync`) | constant, small |

**Idle floor per attached TUI in the agents view:** 4 row rebuilds/s + 4 repaints/s (timer) + 1 widget rebuild + repaint/s (extension) + ~230 reconciles/s (roster/heartbeat pushes). Only the last one is large, and it dominates everything else.

### 2. Synchronous blocking calls on the TUI client main thread

- **`realpathSync` × 367 per reconcile** — `utils/paths.ts:10` (finding #1). This is the whole story.
- `JSON.parse(line)` per inbound socket line, including 512 KB snapshot chunks — `modes/daemon/daemon-client.ts:458`. No worker offload.
- `readdirSync` + `statSync` per file-path autocomplete keystroke (0 ms debounce for slash/path contexts) — `packages/tui/src/autocomplete.ts:596, 608`; debounce at `packages/tui/src/components/editor.ts:2236-2244`. Non-recursive, single directory. `@`-mentions go out-of-process to `fd` with a 20 ms debounce — fine.
- `findGitPaths` walks upward from cwd with `existsSync`/`statSync`/`readFileSync` — `utils/git.ts:207-239`; once at construction and once per `setCwd()` (`core/footer-data-provider.ts:65,124`). Not per event.
- `spawnSync` in the client is only on explicit user commands: external editor (`interactive-mode.ts:7492`), `/share` (`:9181`), `/update` (`:8887, 8962`).
- **Correction to the brief:** `core/footer-data-provider.ts` does **not** run `git rev-parse HEAD` / `git branch --show-current` on watched-file changes. It reads `.git/HEAD` with `readFileSync` (`:176-186`), debounces 500 ms (`:139-151`), and resolves asynchronously with `execFile` (`:19-37`); the only `spawnSync` there (`:9-16`) fires solely on the `ref: refs/heads/.invalid` edge case. The blocking `git` triple (`rev-parse HEAD`, `branch --show-current`, `remote get-url origin`) is `utils/git.ts:262-264 captureGitContext`, called from `core/session-manager.ts:1642` twice per turn (`core/agent-session.ts:3775, 3779`) — **in the worker, not the client**. The `execFileSync("git", ["branch","--show-current"])` in the aim extension likewise runs in the worker, on `agent_start`/`agent_end`.

### 3. Render cost per event

- Repaint is scheduled, never inline, and coalesced behind a boolean flag with a **16 ms floor** — `packages/tui/src/tui.ts:322, 632-658, 844-861`. So event storms cannot exceed 60 fps.
- But **every repaint re-renders the entire component tree**: `Container.render` calls `child.render(width)` on all children unconditionally (`tui.ts:274-288`), `Box.render` likewise (`components/box.ts:86-88`). There is no subtree early-out; only leaf-level exact-match caches (`render-cache.ts:1-25`, `components/text.ts:13-15`, `components/markdown.ts:187-189`).
- Non-fullscreen mode then does an **O(total rendered transcript lines)** line-by-line diff every repaint (`tui.ts:1714-1722`) plus `applyLineResets` (`:1338-1345`) and `collectKittyImageIds` (`:1353-1360`), both O(total lines). Fullscreen mode's paint diff is viewport-bounded (`fullscreen.ts:640-668`) but still re-renders every scroll component first (`tui.ts:1487-1499`).
- **Markdown is fully re-lexed on every render** (`components/markdown.ts:253`) and the last (growing) block is never cached (`:268`) → streaming a long assistant reply is O(n²) in lexing over the reply length.
- Child-session / roster events: chat mode's roster handler is `modes/interactive/interactive-mode.ts:5160-5163` — `updateSubagentSummaryLine()` + unconditional `ui.requestRender()`, no debounce. Agents-view's is the reconcile path (#1). `rlm_child_update` renders per child status change (`:5819` → `:6029-6036`).
- Retained transcript: capped at 400 rendered messages on initial load (`:574`) but **`initialRenderMessages` still scans the entire uncapped message array** to build the tool-call map (`:580-590`), and `renderResyncedSession`/`rebuildChatFromMessages` rebuild **uncapped** (#7).
- Extension widget: each `setWidget` from the daemon tears down and reconstructs the widget components (`:3571-3601`) and calls `renderWidgets()` → `ui.requestRender()` (`:3658-3663`) — 1×/s minimum thanks to the aim extension's `force: true`.

Scaling: `render_cost = repaint_rate (≤60 Hz) × (Σ component render cost + total_rendered_lines)`, where `Σ component render cost` includes a full markdown re-lex of every visible assistant message.

### 4. Polling over the socket, per TUI

- `heartbeats_list`: **every 15 s** (`agents-view-mode.ts:893`) plus once per `heartbeats_changed` push (`:855`) plus once per reconnect (`:2427`). Agents view only.
- Live session roster: **push-based**, not polled — `roster_subscribe` once (`roster-store.ts:50`), then server-pushed `roster_update` (`:42-46`).
- `list`: not polled. One on-demand call before deleting a saved session (`agents-view-mode.ts:1882`).
- `get_state` / `usage`: not polled at all. `usage` only on the `/usage` command (`interactive-mode.ts:9381-9414`).
- `get_messages` / `get_connection_state`: on demand, but the snapshot cache is invalidated on **every** session event (`modes/agent-connection/daemon-agent-connection.ts:1761`), which silently negates the in-place streaming patch two lines above (`:1755`, `:2211-2212`). Any caller that reads `getMessages()` between events pays a full-transcript refetch, and the daemon pays a full re-serialization (`daemon-supervisor.ts:6432-6435` keys the snapshot cache on `lastEventSequence`, so every event is a miss).

So: the socket cadence per idle TUI is dominated not by client polling but by **server push fan-out** — every roster mutation anywhere in the 204-worker fleet reaches all 32 clients.

### 5. Reconnect loops

- `DaemonAgentConnection.reconnect()` — `daemon-agent-connection.ts:1589-1676`. Exponential 100→2000 ms, 60 s deadline (`:115, 1595`). **But the deadline is removed entirely when a direct worker link is held** (`:1602-1604`) → retries forever. `await recoverDaemon()` (`:1611`) has no internal timeout.
- Post-update recovery — `daemon-agent-connection.ts:136-164` then `:1933-1991`, chained (`:1907`). Both use a **flat 100 ms** retry with a 120 s deadline each, so worst case ~240 s, and each iteration issues a full `{type:"list"}` RPC — ~10 full session-list requests per second per client for up to two minutes after every daemon self-update. With 32 clients that is ~320 list RPCs/s hitting a daemon that is already struggling.
- `DaemonClient.autoReconnect()` — `daemon-client.ts:585-631`, exponential, 60 s deadline.
- Agents view — `agents-view-mode.ts:2417-2452`, 1 s retry, 120 s deadline.

None spin the CPU (all are `setTimeout`-based awaits). The cost when the daemon is slow is RPC amplification, not busy-waiting.

### 6. Everything O(N) per event

| Where | N | Trigger |
|---|---|---|
| `agents-view-state.ts:190` `reconcileUnifiedSessions` | N_live + N_saved, each with 6 syscalls | every roster/heartbeat push (**the critical one**) |
| `agents-view-mode.ts:2200-2206` progressive `onSession` | N_saved², via N_saved reconciles | every saved-catalog refresh |
| `agents-view-state.ts:396-413` `filterUnifiedSessions` | N_records × query re-parse | every rebuild (4 Hz) |
| `interactive-mode.ts:580-590` tool-call index | all messages (uncapped) | session load |
| `interactive-mode.ts:6543-6561` `orderMessagesForTranscript` | all messages | every `renderSessionContext` |
| `interactive-mode.ts:2983, 6749` transcript rebuild | all messages | resync / compaction / `/reload` / thinking toggle |
| `interactive-mode.ts:7422-7447` `applyChatExpansion` | rendered components | every expand/collapse keypress |
| `packages/tui/src/tui.ts:1714-1722` ANSI diff | total rendered lines | every repaint |
| `packages/tui/src/components/markdown.ts:253` lexer | total text length | every repaint of a markdown block |
| `packages/tui/src/components/editor.ts:1714-1737` `buildVisualLineMap` | editor buffer lines | every arrow-key press (twice for up/down) |
| `packages/tui/src/components/select-list.ts:233-239`, `settings-list.ts:116` column width | all items, not the visible window | every render |
| aim extension `isHumanOwnedTitle` / `sessionBindings` | all session entries | 1 Hz, worker-side |

---

### Extension hooks: which fire per event, and what the aim extension does

`core/extensions/types.ts` declares the hook surface (`session_start:994`, `agent_start:1019`, `agent_end:1020`, `input:1034`, and the rest). `~/.prime/agent/extensions/session-title-footer.ts` registers five:

| Hook | Fires | What the aim extension does |
|---|---|---|
| `session_start` | once per session in the worker | `configuredBindings()` reads `auth.json`; `gitBranch(cwd)` = blocking `execFileSync git branch --show-current` (1 s timeout); `getEntries()` full scan for identity state; possibly `setSessionName`; then **installs the 1 s `setInterval`** |
| `input` | per user submission | regex checks + possible `queueAutoTitle` |
| `agent_start` | per turn | `update(ctx, true)` → **blocking `execFileSync git`** + `getEntries()` scan + widget/title push |
| `agent_end` | per turn | `maybeUpgradeFromRecap` (`getEntries()` scan + backwards `agent_status` scan) then `update(ctx, true)` → another **blocking `execFileSync git`** |
| `session_shutdown` | once | clears the interval, clears the widget |

The 1 s interval body is `maybeUpgradeFromRecap(ctx)` + `update(ctx, false, true)`:
`isHumanOwnedTitle` → `ctx.sessionManager.getEntries()` full forward scan; `latestAgentRecap` → backward scan; `resolveAccount` → `sessionBindings` → another full forward scan; then `ctx.ui.setWidget(...)` and `ctx.ui.setTitle(...)` **unconditionally** because `force = true`.

Cost formula: `worker_cost = Σ_sessions 1 Hz × 3 × entries(session)`; `client_cost = attached_clients × 1 Hz × (widget teardown/rebuild + full repaint + OSC title write)`.

---

### What is *not* shown by the code, and what would settle it

1. **The actual `roster_update` / `heartbeats_changed` push rate.** I inferred ~230 reconciles/s per TUI by dividing measured lstat time by an assumed 1.3 µs/lstat. To measure it directly: `sudo fs_usage -w -f filesys -p <tui-pid> | grep -c lstat` for 1 s gives the exact syscall count, and dividing by 2,202 gives the reconcile rate. Alternatively add a counter in `reconcileCatalogs()` behind an env flag.
2. **How many of the 32 TUIs are on the agents view vs. in chat.** All three sampled clients showed the agents-view reconcile signature, so at least those three are. A chat-only TUI would not run `reconcileUnifiedSessions`; its idle cost would instead be the 1 Hz extension widget push plus roster-bar repaints (`interactive-mode.ts:5160-5163`). To settle: sample the remaining pids, or check which ones have `fullscreen` active.
3. **Whether `.prime`/`sessions` involves symlinks.** `ls -la ~/.prime` shows plain directories, so `realpathSync` does 6 `lstat` and no `readlink`; if any component were a symlink the cost per call would be higher. A `stat -f%HT` on each component confirms.
4. **The 18 `tokio-runtime-worker` threads per TUI** come from the optional `@mariozechner/clipboard` native module (`clipboard.darwin-universal.node` frames appear in all samples). They are all parked in `__psynch_cvwait` — no CPU, but 32 × 18 = 576 threads and their stacks. Not investigated further; `PI_NO_CLIPBOARD`-style opt-out (if one exists) would settle whether they cost memory that matters.
5. **Whether `resourceLoader.reload()` ever re-runs after startup in an attached client.** From source: no — only `createAgentSessionServices` (`core/agent-session-services.ts:178`) and `/reload` (`interactive-mode.ts:9038`). But note `main.ts:1505` runs a **full** `prepareRuntimeServices()` (settings reload + package resolve + globSync + `loadExtensions` via jiti) **once per session opened from the agents view** — a per-navigation cost worth measuring with `PI_TIMINGS` if navigation feels slow.


## 4. Cross-cutting: timers, spawns, fsync, logging, fan-out

Source: Opus 5 machine-wide inventory across `packages/coding-agent`, `packages/agent`, `packages/ai`, `packages/tui`: every timer, external process spawn, fsync, blocking sync I/O on a hot path, busy wait, log stream, protocol fan-out, and process-identity call site, each with which roles run it, what it scales with, and whether it runs when idle.

Repo: `/Users/aelaguiz/workspace/prime-agent` @ `918d049ad`
Scope: `packages/coding-agent/src`, `packages/agent/src`, `packages/ai/src`, `packages/tui/src` (tests excluded).
Operator scale used throughout: **1 supervisor, 12 daemon workers, 32 TUI clients, 231 daemon sessions, 2551 total processes on the box.**

Every row cites `file:line`. Where the code does not show something, the row says **not in code**.

### Ground truth measured on this box (2026-09-02)

| Fact | Value | How measured |
|---|---|---|
| `/bin/ps -ww -o command= -p <pid>` cost | **8.4 ms** in an idle shell; **~40 ms** operator-measured under real load | 20-iteration loop; operator's number |
| Total processes | 2551 | `ps -ax \| wc -l` |
| `~/.prime/agent/logs/processes` | **3378 files, 1.0 GB** | `ls`, `du -sh` |
| Size of one `process_heartbeat` record | **~1005 bytes** | 360 KB / 358 records in a sampled worker jsonl |
| `agent.jsonl` (shared by ALL processes) | 11 MB live + 20 MB `.old` | `du -sh` |
| `client-errors.log` | 2.9 MB live + 5.0 MB `.old` | `du -sh` |
| Sampled lifecycle jsonl event mix | `process_heartbeat` 358/361 lines for an idle client | `python3` counter over the file |

---

### A. TIMERS — every `setInterval` and self-rescheduling `setTimeout` loop

Legend for **Roles**: `sup` = supervisor (`DaemonSupervisor`), `wrk` = daemon worker (`DaemonMode` with `options.worker`), `cli` = TUI client (interactive / agents-view), `cat` = catalog subprocess, `all` = every Prime process.

#### A1. `setInterval`

| # | file:line | Roles | Interval constant (value) | Trigger | Runs when idle? | Scales with | Cost note |
|---|---|---|---|---|---|---|---|
| A1 | `core/process-lifecycle.ts:647` | **all** | `HEARTBEAT_INTERVAL_MS = 60_000` (`:30`) | `installProcessLifecycle()` | **YES** | **processes** (workers + clients + sup + cat + children) | `writeEvent("process_heartbeat", {}, {includeResources:true})` → `mkdirSync`+`existsSync`+`statSync`+`appendFileSync` (`:361-366`) writing a **~1 KB** record. Total = `(1 sup + 12 wrk + 32 cli + children) × 1 KB / 60 s`. Measured 1.0 GB accumulated. |
| A2 | `modes/daemon/daemon-mode.ts:811` | **wrk** | `ROSTER_HEARTBEAT_INTERVAL_MS = 15_000` (`daemon-worker-protocol.ts:53`) | worker daemon `listen()` | **YES** | **workers** | `broadcastRosterFrame({type:"roster_heartbeat"})` → one frame to the supervisor. Cheap (1 socket write). |
| A3 | `modes/daemon/daemon-supervisor.ts:970` | **sup** | `ROSTER_WATCHDOG_INTERVAL_MS = 15_000` (`:221`) | supervisor startup complete | **YES** | **workers × roster entries** | `sweepRosterStaleness()` (`:5676`) iterates all workers × all their roster entries. Local only, no RPC, no disk. Cheap at 231 sessions. |
| A4 | `modes/daemon/daemon-session-summarizer.ts:227` | **wrk** | `SWEEP_INTERVAL_MS = 25_000` (`:7`) | `summarizer.start()` from `daemon-mode.ts:804` | **YES** | **sessions per worker** | `for (const state of this.listSessions()) void this.summarize(state)` — fires an LLM call per session (`SUMMARY_MODEL_ID = "qwen/qwen3-30b-a3b-instruct-2507"`, `:12`). Total = `231 sessions / 25 s` worth of inference attempts if all resident. **This is the only timer in the tree that costs network + tokens.** |
| A5 | `modes/daemon/daemon-supervisor-ownership.ts:216` | **sup** (and any holder) | `refreshMs` ctor param; callers pass `SHUTDOWN_ADMISSION_REFRESH_MS = 1000` (`:39`, used `:359`) and `OFFLINE_MAINTENANCE_REFRESH_MS = 1000` (`:42`, used `:440`) | only while a shutdown-admission or offline-maintenance lease is held | **no** (lease-scoped) | **none** | Each tick → `withRegistryGuards` (`:658`) → `currentProcessIdentityFields()` (`:669` → `:1517`) = **1 `/bin/ps` spawn**, plus guard acquire/release = **4 fsyncs**. 1 Hz while held. |
| A6 | `cli/owned-session-worker.ts:1134` | owned worker (client-owned session process) | **100 ms**, hardcoded | `installOwnedSessionWorkerOwnerWatch()` when there is no IPC channel | **YES** | **owned workers** | `if (process.ppid !== ownerPid) terminate()` — `process.ppid` is a cheap libuv call, not a syscall storm, but it is 10 wakeups/sec/process. `unref()`'d (`:1136`). |
| A7 | `cli/owned-session-worker.ts:155` | contained-shell launcher child (inline JS, `require` at `:51`) | **100 ms**, hardcoded | every contained-shell launch | **YES** while the child lives | **contained shells** | Same `process.ppid` poll, in a separate node process per contained shell. Not `unref()`'d in this inline script. |
| A8 | `cli/daemon-update-restart.ts:355` | update-restart coordinator | `COORDINATOR_STATUS_HEARTBEAT_MS` | `startHeartbeat()` | no (update only) | **none** | `touch()` → `writeJsonAtomically` per tick. One-shot lifecycle. |
| A9 | `core/tools/bash.ts:377` | wrk (renderer) / cli | **1000 ms**, hardcoded | a bash tool result is rendering partially | no | **in-flight bash calls** | `context.invalidate()` → re-render. Cleared at `:382` when not partial. |
| A10 | `modes/agents-view/agents-view-mode.ts:893` | **cli** | `HEARTBEAT_POLL_INTERVAL_MS = 15000` (`:102`) | agents-view opened | **YES** | **clients** | `refreshHeartbeats()` (`:2245`) → `listDaemonHeartbeats` → supervisor `heartbeats_list` (`daemon-supervisor.ts:2492`) which **fans out an RPC to every worker** (`:2500-2504`, uncapped `Promise.all`). Total = `32 clients / 15 s × 12 workers` = **~26 worker RPCs/sec at steady idle**. See G. |
| A11 | `modes/agents-view/agents-view-mode.ts:895` | **cli** | `WORKING_ICON_INTERVAL_MS = 250` (`theme/working-icon.ts:4`) | agents-view opened | **YES** if any row is running or has a stale age | **clients × rows** | Early-returns when nothing is running (`:896-898`), otherwise `rebuildRows()` + `requestRender()` at **4 Hz**. With 231 sessions the rebuild is O(rows) per tick, per client. Total = `32 × 4 × 231 row-builds/sec` worst case. |
| A12 | `modes/interactive/interactive-mode.ts:3263` | **cli** | **1000 ms**, hardcoded | agent working | no (only while streaming) | **clients** | `updateWorkingLoaderMessage()`. `unref()`'d (`:3264`). |
| A13 | `modes/interactive/interactive-mode.ts:3421` | **cli** | `WORKING_ICON_INTERVAL_MS = 250` (`theme/working-icon.ts:4`) | agent streaming | no | **clients** | `tickWorkingPulse()` → render at 4 Hz. |
| A14 | `modes/interactive/interactive-mode.ts:3353` | **cli** | `FEATURE_HINT_ANIMATION_INTERVAL_MS = 160` (`components/feature-hint.ts:8`) | a feature hint is shown | no | **clients** | `advance()` + `requestRender()` at **6.25 Hz**. `unref()`'d. |
| A15 | `modes/interactive/interactive-mode.ts:5885` | **cli** | **1000 ms**, hardcoded | `goal.status === "active"` | **YES while a goal is active** | **clients** | `subagentSummaryLine.invalidate()` + `requestRender()` every second. `unref()`'d (`:5890`). |
| A16 | `modes/interactive/interactive-mode.ts:7069` | **cli** | `2 ** 30` ms (~12.4 days) | Ctrl-Z suspend | no | **none** | Keep-alive only; cleared on `SIGCONT`. Harmless. |
| A17 | `modes/interactive/components/armin.ts:182` | **cli** | `1000/60` (glitch) or `1000/30` ms | easter-egg animation | no | **none** | 30–60 FPS render loop. Self-stops at `:187`. |
| A18 | `modes/interactive/components/daxnuts.ts:78` | **cli** | **80 ms** | easter-egg animation | no | **none** | 12.5 FPS render loop, self-limits via `maxTicks`. |
| A19 | `modes/interactive/components/countdown-timer.ts:16` | **cli** | **1000 ms** (fixed) | a timed prompt | no | **none** | 1 Hz render. |
| A20 | `modes/interactive/components/prime-onboarding-splash.ts:62` | **cli** | `options.animationIntervalMs ?? ANIMATION_INTERVAL_MS` | onboarding splash | no | **none** | First-run only. |
| A21 | `packages/tui/src/components/loader.ts:69` | **cli** | `DEFAULT_INTERVAL_MS = 80` (`:10`), overridable | spinner shown | no | **clients** | **12.5 FPS** spinner: `updateDisplay()` + `ui.requestRender()` (`:79`). This is the highest-frequency timer in a TUI. Total = `32 clients × 12.5 renders/sec` when all are working. |
| A22 | `packages/tui/src/terminal.ts:597` | **cli** | `TERMINAL_PROGRESS_KEEPALIVE_MS = 1000` (`:16`) | `setProgress(true)` | no | **clients** | Writes an OSC 9;4;3 sequence to stdout every second. Total = 32 stdout writes/sec fanning into the terminal emulator. |

#### A2. Self-rescheduling `setTimeout` loops (the dangerous ones)

| # | file:line | Roles | Interval | Trigger | Runs when idle? | Scales with | Cost note |
|---|---|---|---|---|---|---|---|
| A23 | **`modes/daemon/daemon-mode.ts:907`** (`scheduleSupervisorFenceCheck`) → `checkSupervisorFences` `:912` → reschedules itself at `:936` | **wrk** | **`SUPERVISOR_FENCE_POLL_MS = 250`** (`daemon-mode.ts:421`) | armed the moment the supervisor authenticates (`:4211`), never disarmed while claimed | **YES — this is the single worst idle cost on the box** | **workers** | Each tick calls `assertSupervisorClaimCurrent` (`:940`) → `assertDaemonSupervisorOwnerCurrent` (`daemon-supervisor-ownership.ts:979`) → `matchesExactProcessIdentity` (`:1010`) → `observeProcessIdentity` → **`execFileSync("/bin/ps", ...)`** (`core/session-lease.ts:31` `runProcessQuery`, called from `observeDarwinProcessIdentity` `:751`). **Formula: total = 12 workers × 4 ps/sec = 48 `/bin/ps` spawns/sec, forever, at idle.** At 8.4–40 ms each that is **0.4–1.9 CPU-seconds/sec of `ps`**, and each worker's event loop is blocked `4 × 8.4–40 ms = 34–160 ms/sec` doing nothing. The legacy branch (`assertDaemonSupervisorOwnerCurrentForWorkerAuthentication`, `:1041`) calls `observeProcessIdentity` **twice** (`:1076`, `:1077`) → 96 ps/sec. |
| A24 | `modes/daemon/daemon-supervisor.ts:1086` (`scheduleIdleEvictionSweep`) → reschedules at `:1092` | **sup** | `idleEvictionSweepIntervalMs(...)` (`:701`), clamped to `[IDLE_EVICTION_MIN_SWEEP_INTERVAL_MS = 60_000` (`:251`)`, IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS = 300_000` (`:250`)`]`; default `idleEvictionMinutes = 90` (`core/settings-manager.ts:140`) → `min(300_000, 90*60_000/3)` = **300 s** | supervisor startup (`:969`) | **YES** | **workers (×3 rounds)** | `runIdleEvictionSweep` (`:1123`) does up to **3 uncapped `Promise.all` fan-out rounds over all 12 workers** (`:1131`, `:1146`, `:1172`) plus `stopWorker` per evictable (`:1185`). Formula: `total = 3 × 12 = 36 worker RPCs per 5 min`. `unref()`'d. |
| A25 | `modes/daemon/daemon-mode.ts:840` (`scheduleSupervisorAvailabilityCheck`) → re-arms at `:846`/`:854` | **wrk** | 1500 ms first, then 5000 ms on failure | worker with `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` and no authenticated supervisor | only while orphaned | **orphaned workers** | `canConnectToSupervisor` (`:967`) opens a unix socket per probe with a 250 ms timeout (`:983`). Stops once the supervisor authenticates. |
| A26 | `modes/daemon/daemon-mode.ts:7882` (`client.catchupRetryTimer`) | **wrk** | `CLIENT_CATCHUP_RETRY_MS = 250` (`:419`) | client catch-up backpressure | no | **clients in catch-up** | 4 Hz retry per stuck client. |
| A27 | `modes/daemon/daemon-supervisor.ts:1777` (`worker.ownerCleanupTimer`) | **sup** | `OWNED_WORKER_DISCONNECT_GRACE_MS = 30_000` (`:249`) | owner client disconnects | no | **workers** | One-shot per disconnect; the guard at `:1774-1779` does a full `[...this.clients].some(...)` scan. |

**Not in code:** no `setInterval`/`setTimeout` loops at all in `packages/agent/src` or `packages/ai/src`.

---

### B. PROCESS SPAWNS of external binaries

| # | file:line | Binary | Roles | Hot path? | Runs when idle? | Scales with | Cost note |
|---|---|---|---|---|---|---|---|
| B1 | **`core/session-lease.ts:411`** (`runProcessQuery` → `execFileSync`) | **`/bin/ps`** | **all** | **HOT — timer (A23), per protocol command, per guard acquisition, per orphan enroll/retire** | **YES** | **workers × 4/s + commands + guard acquisitions** | The single most-executed external spawn in the codebase. Reached from `observeDarwinProcessIdentity` (`:751`, `ps -ww -o command= -p <pid>`) and `observePortableProcessIdentityWithPath` (`:381`, `ps -p <pid> -o lstart=`). Darwin takes the second call only when the target has no `prime-agent-owner-token=` in argv (`:25`, `cli-main.ts:13`), so Prime-to-Prime probes cost 1 spawn and probes of foreign PIDs cost 2. **See table H for every call site.** |
| B2 | `utils/child-process.ts:42` (`execFileSync`) | `ps -p <pid> -o stat=` | all | per `isZombieProcess`/`isProcessAlive` call | depends | **child processes probed** | Only reached on non-Linux after the `/proc/<pid>/stat` read fails (`:31-38`) — i.e. always on macOS. |
| B3 | `utils/git.ts:252` (`spawnSync`) via `captureGitContext` `:261` | **`git`** ×3 (`rev-parse HEAD`, `branch --show-current`, `remote get-url origin`) | **wrk** | **HOT — per agent turn** | no | **turns × sessions** | Called from `SessionManager.recordGitStateIfChanged` (`core/session-manager.ts:1642`), which `agent-session.ts:3776` fires on `agent_start` and `agent-session.ts:3780` on `agent_end`. **Formula: 6 blocking `git` spawns per turn per session**, on the worker's event loop. Also at session create (`session-manager.ts:1229`), `saveTo` (`:1355`), header rebuild (`:1909`), and fork (`:2080`). |
| B4 | `core/footer-data-provider.ts:9` (`spawnSync`) | `git symbolic-ref` | **cli** | one-shot per TUI, then cached | no | **clients** | `getGitBranch()` (`:70`) memoizes into `cachedBranch` and re-resolves only on an fs-watch event. Not hot. Async twin at `:22`. |
| B5 | `cli/daemon-ps.ts:263,267,272,276,290,294,455,1198` (`spawnSync`) | `ss`, **`lsof`** ×4, **`ps -axo pid=,comm=,args=`** ×2, `ps -o pid=,etimes=` | CLI (`prime ps`) | one-shot per CLI invocation | no | **none** (but each `ps -axo` walks all 2551 procs) | Not on any timer. A single `prime ps` costs up to 8 external spawns including two full process-table dumps and four `lsof` runs. |
| B6 | `modes/daemon/daemon-runtime-identity.ts:25,33` (`execFileSync`) | `git -C <root> ...` | sup/wrk | one-shot at daemon startup | no | **daemon launches** | Two `git` calls to fingerprint the source tree. |
| B7 | `core/resolve-config-value.ts:35` (`spawnSync`) / `:64` (`execSync`) | user shell / `sh -c` | all | per `!command` config value resolution | no | **config values** | 10 s timeout. Check whether the result is memoized before calling it hot — `executeCommandUncached` (`:74`) implies a cache wrapper exists; the uncached function itself is a full shell spawn. |
| B8 | `config.ts:210` (`spawnSync` in `readCommandOutput`) | `npm`/`bun`/`pnpm` | cli | self-update check | no | **none** | One-shot. |
| B9 | `core/aim-usage.ts:78` (`spawn`) | `aim status --json` | cli | usage query | no | **none** | Async, 15 s timeout. |
| B10 | `modes/shared/startup-notices.ts:69` (`spawn`) | `tmux show -gv` | cli | TUI startup | no | **clients** | Async, 2 s timeout, one per option queried. Runs on every one of 32 TUI launches. |
| B11 | `packages/tui/src/autocomplete.ts:164` (`spawn`) | `fd` | **cli** | **per file-autocomplete query** | no | **keystrokes** | Async with `AbortController` (`:177-179`); **no debounce found in `autocomplete.ts`** — `getSuggestions` (`:280`) is the only entry point. Verify the caller debounces. |
| B12 | `core/kernel/repl-manager.ts:4`, `core/kernel/bootstrap.ts:1` (`spawn`) | `python`/`uv` | wrk | per kernel boot | no | **kernels** | Gated by `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS`. |
| B13 | `modes/daemon/daemon-catalog-process.ts:401` (`spawn`) | node (self, catalog role) | **sup** | per catalog request batch | no | **catalog requests** | Long-lived child; requests are framed over its stdio. |
| B14 | `modes/daemon/daemon-supervisor.ts:1` / `daemon-mode.ts:9` / `cli/daemon-launch.ts:8` (`spawn`) | node (self, worker role) | sup | per worker launch | no | **workers** | One-shot per worker. |
| B15 | `utils/clipboard.ts:14,16,69,72,78,92` (`execSync`) | `xclip`/`xsel`/`pbcopy`/`clip`/`termux-clipboard-set`/`which wl-copy` | cli | per copy action | no | **user actions** | User-initiated only. |
| B16 | `utils/clipboard-image.ts:82` (`spawnSync`) | `osascript` (macOS) / `powershell` | cli | per image paste | no | **user actions** | User-initiated. |
| B17 | `utils/tools-manager.ts:103,227` (`spawnSync`) | `<tool> --version`, `tar xzf` | cli | tool bootstrap | no | **none** | One-shot install path. |
| B18 | `core/package-manager.ts:2431` (`spawnSync`) | package managers | cli | extension install | no | **none** | One-shot. |
| B19 | `core/session-file-actions.ts:28` (`spawnSync`) | `trash` | cli | per session delete | no | **user actions** | User-initiated. |
| B20 | `modes/interactive/interactive-mode.ts:7492`, `components/extension-editor.ts:113` (`spawnSync`) | `$EDITOR` | cli | user opens editor | no | **none** | Blocking by design. |
| B21 | `modes/interactive/interactive-mode.ts:8887,8962` (`spawnSync`) | update / relaunch command | cli | self-update | no | **none** | One-shot. |
| B22 | `modes/interactive/interactive-mode.ts:9181` (`spawnSync`) | `gh auth status` | cli | GitHub flow | no | **none** | One-shot, blocking. |
| B23 | `core/orphan-process-journal.ts:1738` (`spawnSync`) | `taskkill` (Windows only) | wrk | orphan reap | no | **none on macOS** | Windows-only. |

---

### C. FSYNC AND DURABILITY

#### C1. Cost of one authority-guard acquire + release

`acquireAuthorityMutationGuard` (`core/authority-mutation-guard.ts:347`) + `release()` (`:407`), happy path with no contention:

| Step | file:line | fsyncs |
|---|---|---|
| `publishGuard` writes the owner record and fsyncs the fd | `:314` | 1 |
| `publishGuard` fsyncs the containing directory after unlinking the publication path | `:329` → `fsyncDirectory` `:201` (`openSync`+`fsyncSync`+`closeSync`) | 1 |
| `release()` fsyncs the directory after `unlinkSync(lockfilePath)` | `:434` | 1 |
| `release()` fsyncs the directory again after removing the release hard-link | `:447` | 1 |
| **Total, uncontended** | | **4 fsyncs** |
| Contended reclaim path adds `reclaimExactDeadGuard` dir-fsyncs | `:280`, `:291` | **+2** |

Plus, before the guard is even taken, every caller resolves its own identity:
`session-lease.ts:970` (memoized in `currentProcessIdentityObservation`, **cached**) vs `daemon-supervisor-ownership.ts:1517` `currentProcessIdentityFields()` (**NOT cached — 1 `/bin/ps` per call**, used at `:669`, `:798`, `:899`, `:1123`) and `orphan-process-journal.ts:524` `processIdentityRecordFields()` (**NOT cached — 1 `/bin/ps` per call**, used at `:590`, `:657`).

**So one registry guard acquisition = 1 `/bin/ps` spawn + 4 fsyncs.**

#### C2. Cost of one appended transcript entry

**Zero fsyncs.** `SessionManager._persist` (`core/session-manager.ts:1390`) → `appendFileSync(this.sessionFile, ...)` (`:1405`). There is no `fsyncSync` anywhere in `session-manager.ts`. Per appended entry it costs:
- `this.fileEntries.some(...)` scan for the first assistant message (`:1392`) — short-circuits, cheap
- `existsSync(this.sessionFile)` (`:1400`)
- `mkdirSync(dirname(...), {recursive:true})` (`:1404`) — **unconditional, every append**
- `appendFileSync` (`:1405`)

→ **3 syscalls + 1 write per transcript entry, no fsync.** This is the one hot path in the tree that is *not* over-durable.

#### C3. Every other fsync site

| # | file:line | File | Roles | Trigger | fsyncs per operation | Scales with |
|---|---|---|---|---|---|---|
| C3.1 | `core/authority-mutation-guard.ts:205,280,291,314,329,434,447` | `<authority>.guard` lockfile + its directory | all | every guard acquire/release | **4** (6 on reclaim) | **guard acquisitions** |
| C3.2 | **`modes/daemon/command-recovery-journal.ts:178`** (`append`) and `:204`,`:211` (`compact`) | `<descriptorDir>/command-journal.jsonl` (`daemon-supervisor.ts:887`) | **sup** | **every *mutating* supervisor command** | **3 fsyncs per command**: `begin`→`append` (`:88`), `recordResult`→`append` (`:107`), `acknowledge`→`append` (`:120`); each does `openSync`+`writeSync`+`fsyncSync`+`closeSync`+`chmodSync` | **mutating commands × clients** |
| C3.3 | `core/orphan-process-journal.ts:596` (`claimJournalWriteLockRemoval`), `:668` (`createJournalWriteLockCandidate`), `:1051` (`appendRecordToExistingAuthority`), `:1077` (`initializeOrphanProcessJournal`), `:1198`, `:1222` | orphan journal + its lock/claim files | wrk | **every detached child spawn and retire** | **≥3 fsyncs + 3 `/bin/ps` spawns** per enroll (`:1262` `observeProcessIdentity`, `:657` and `:590` `processIdentityRecordFields`) and again per retire | **spawned shells / kernels** |
| C3.4 | `modes/daemon/rlm-ledger.ts:881,939,947,950` | `rlm-spawn-ledger` jsonl per sessions-dir | sup | every RLM (subagent) spawn/close | **2–3 fsyncs**, and `appendRecord` (`:912`) **reads the entire ledger file** (`readAllSync` `:924`) and replays it before every append | **cumulative subagent count** |
| C3.5 | `core/cron-jobs.ts:1567,1575` (`writeJobsState`) | `cron-jobs.json` + its directory | sup | every cron mutation / claim | **2** | **cron dispatches** |
| C3.6 | `modes/daemon/worker-recovery-journal.ts:99` | worker recovery journal | wrk | worker recovery record | 1 | **workers** |
| C3.7 | `modes/daemon/daemon-worker-cleanup.ts:761,799,1108` | worker cleanup records | sup | worker stop/cleanup | 1–3 | **workers** |
| C3.8 | `modes/daemon/rlm-subagent-display.ts:62` | `rlm-subagents.jsonl` (`daemon-mode.ts:467`) | wrk | subagent display update | 1 | **subagents** |

---

### D. BLOCKING SYNC I/O ON HOT PATHS

#### D1. Truly hot (per event / per command / per timer tick / per render)

| # | file:line | Function | Touches | Trigger | Runs when idle? | Scales with | Cost |
|---|---|---|---|---|---|---|---|
| D1 | **`config.ts:604-612`** (`appendRotatingLog`) | every log line | `mkdirSync` + `existsSync` + `statSync` + `appendFileSync` on the daemon log **and again** on `agent.jsonl` | every `this.log()` (`daemon-mode.ts:713`, `daemon-supervisor.ts:1012`) | on any activity | **log lines × 2 files × amplification 4** | **8 sync syscalls per logical log line per process**, 16 machine-wide after the stderr relay. On the request path. |
| D2 | **`core/process-lifecycle.ts:361-366`** (`appendEventLine`) | every lifecycle event | `mkdirSync` + `existsSync` + `statSync` (`rotateOwnProcessLog` `:351-358`) + `appendFileSync` | `writeEvent`, 116 `recordProcessLifecycle` call sites + the 60 s heartbeat | **YES (heartbeat)** | **processes × events** | 4 syscalls + a ~1 KB write per event. `(1+12+32+…) × 1/60 s` at pure idle. |
| D3 | **`core/session-manager.ts:1400-1405`** (`_persist`) | every appended transcript entry | `existsSync(sessionFile)` + **unconditional `mkdirSync(dirname, {recursive:true})`** + `appendFileSync` | every message/tool/state entry during streaming | no | **stream tokens × sessions** | 3 syscalls per entry. No fsync (good). The `mkdirSync` is pure waste on every append. |
| D4 | **`modes/daemon/worker-recovery-journal.ts:95-103`** (`append`) | `<workerId>.recovery.jsonl` | `openSync` + `writeSync` + **`fsyncSync`** + `closeSync` + `chmodSync`, plus `[...this.latest.values()].every(...)` at `:81` | 16 session event types (`daemon-mode.ts:426-443`) via `broadcastToSession` `:7468` | no | **tool calls × sessions** | **~4 fsyncs per tool call.** The hottest fsync in the system. |
| D5 | **`modes/daemon/command-recovery-journal.ts:174-183`** | `command-journal.jsonl` | `openSync`+`writeSync`+**`fsyncSync`**+`closeSync`+`chmodSync` | 3× per mutating supervisor command | no | **mutating commands × clients** | 3 fsyncs per command on the supervisor's single event loop. |
| D6 | **`modes/daemon/rlm-ledger.ts:912-950`** (`appendRecord`) | `rlm-ledger/<sha16>.jsonl` | `mkdirSync` + `existsSync` + `truncateTornTailSync` + `openSync("a+")` + **`readAllSync` of the ENTIRE ledger** (`:924`) + `replayLedgerContents` + 2–3 `fsyncSync` | every RLM subagent spawn/close | no | **cumulative subagent count (never compacted)** | O(whole ledger) read **per append**, up to the 32 MiB fail-closed bound (`:43`). Gets slower forever. |
| D7 | **`core/orphan-process-journal.ts:1025-1058`** (`appendRecordToExistingAuthority`) | `<workerId>.orphans.jsonl` + lock + claim files | `withJournalWriteLock` (2 `/bin/ps` + 2 fsync) + `openSync` + full-file `readJournalUtf8Strict` (`:1029`) + parse + `writeAllSync` + `fsyncSync` (`:1051`) + **a second full re-read** `readJournalSnapshot` (`:1053`) | every detached child spawn (`utils/shell.ts:206`) and every retire (`:224`) | no | **spawned shells** | **~3 `/bin/ps` (24–120 ms) + ≥3 fsyncs + 2 full-file reads per spawn, and the same again per retire.** |
| D8 | `core/authority-mutation-guard.ts:154-179` (`openPinnedGuardFile`) | guard lockfile | `lstatSync` + `openSync` + `fstatSync` + `lstatSync` again | every guard open, and `assertCurrent()` (`:379-403`) re-does `fstatSync` + `lstatSync` + a full record re-read **on every assertion** | every guarded mutation, several times each | no | **guard acquisitions** | `withLeaseGuard` (`session-lease.ts:993-1000`) calls `assertCurrent()` **twice** per action. |
| D9 | `core/footer-data-provider.ts:293` | `watchFile(tablesListPath, {interval: 250})` | **polling `stat` at 4 Hz** in the libuv threadpool | git reftable repos only | **YES** | **clients** | `32 clients × 4 stats/sec = 128 stat/sec` when all TUIs are in reftable repos. Plus 3 `fs.watch` handles per TUI (`:252`, `:269`, `:283`) = up to 96 kqueue FDs. |
| D10 | `core/session-lease.ts:379-411`, `:751` | `resolvePosixPsPath(existsSync)` before every `ps` | `existsSync("/bin/ps")` | before every process-identity probe | **YES** | **ps probes** | An extra `existsSync` on top of every one of the 48 ps/sec. |

#### D2. Directory scans (`readdirSync` + `statSync`/`lstatSync` loops)

| # | file:line | Directory | Stats every entry? | Cached? | Trigger | Runs when idle? | Scales with | Cost at operator scale |
|---|---|---|---|---|---|---|---|---|
| D11 | **`core/process-lifecycle.ts:420-432`** (`pruneStaleProcessLogs`) | **`~/.prime/agent/logs/processes` — 3378 files, 1.0 GB** | **YES — `statSync(path)` per entry (`:430`)** | **NO** | `setImmediate` at **every process start** (`:651`) | no (startup) | **processes started × files in dir** | **3378 `statSync` per Prime process launch.** Every TUI open, every worker spawn, every catalog spawn. 45 processes × 3378 = **152 000 stats** just to boot the current fleet. Formula: `total = processes_started × 3378`. |
| D12 | `core/process-lifecycle.ts:436-441` (`pruneCrashReports`) | `logs/crash-reports` | YES — `statSync` per `.json` (`:438`) | NO | daemon-worker / catalog / update-coordinator startup (`:452`) and every fatal report (`:530`) | no | **crash reports** | Small (capped at 20). |
| D13 | `core/session-manager.ts:741-747` (`findMostRecentSession`) | sessions dir | **YES — `readSessionHeader` (open+read) AND `statSync` per file** | NO | `--continue` / session resolution | no | **sessions on disk** | 231+ opens + 231 stats per invocation. Blocking, in the TUI's startup path. |
| D14 | `core/session-manager.ts:773-789` (`findMostRecentSessionForCwd`) | sessions dir | **YES — `readSessionHeader` + `statSync` per file** | NO | `--continue` in a cwd | no | **sessions on disk** | Same as D13. |
| D15 | `core/session-manager.ts:1096-1116` (`listSessionsFromDir`) | sessions dir | `stat` per file, then a **full-file scan on cache miss** (`scanSessionInfo` `:968`) | **YES — `sessionInfoCache` keyed on `(size, mtimeMs)` (`:951`, `:961`)** | catalog `list` | no | **sessions** | **Correctly designed**: async (`readdir`/`stat`), cached, and it runs in the **catalog subprocess** (`daemon-catalog-process.ts:401`) so it never blocks the supervisor. Sequential `await` per file (`:1111`), no concurrency. |
| D16 | `modes/daemon/daemon-worker-cleanup.ts:633`, `:650` | `daemon-workers` root + each worker dir | `readdirSync().sort()` ×2 nested | NO | worker cleanup sweeps | no | **workers × descriptor files** | O(workers × files). Called from cleanup, not a timer. |
| D17 | `modes/daemon/daemon-worker-cleanup.ts:1002`, `:1011`, `:1030`, `:2175`, `:2225`, `:2232`, `:2244`, `:2298`, `:2322` | claims / quarantine / descriptor dirs | mostly `.length` checks | NO | per worker stop / claim reclaim | no | **workers** | Nine separate `readdirSync` calls in the cleanup path; several re-read the same directory to re-verify. |
| D18 | `modes/daemon/daemon-supervisor.ts:1354`, `:1460` | `this.descriptorDir` | NO (name filter only) | NO | descriptor enumeration / existence probe | no | **workers** | Cheap. |
| D19 | `modes/daemon/daemon-supervisor-ownership.ts:1759`, `:1784`, `:2054`, `:2240` | registry dirs | NO | ownership acquisition / stale sweep | no | **generations** | Small dirs. |
| D20 | **`core/skills.ts:299`** (`loadSkillsFromDir`) | skills tree, **recursive** | `statSync` on symlinks (`:310`); reads and parses **every `SKILL.md`** (`loadSkillFromFile` `:319`) | **NO cache anywhere** | `resource-loader.ts:512` `updateSkillsFromPaths`, per `ResourceLoader` construction, i.e. **per session/runtime creation** | no | **session creates × skill files** | Full recursive tree walk + parse of every skill, repeated for every session created. With a large `~/.claude/skills` tree this is hundreds of file reads per session create. |
| D21 | `core/prompt-templates.ts` (2 `readdirSync`), `core/resource-loader.ts` (2), `core/extensions/loader.ts` (1), `modes/interactive/theme/theme.ts` (2), `core/context-tree.ts` (3) | prompt templates / extensions / themes / project context | varies | NO | same `ResourceLoader` construction path | no | **session creates** | Same shape as D20: repeated per session create, never memoized across sessions. |
| D22 | `core/package-manager.ts:2080` (**`globSync`** from `glob@13`) | extension workspace patterns | glob/path-scurry full walk | NO | extension install / workspace resolution | no | **none at steady state** | The only `glob` use in the tree. Not on a hot path. |
| D23 | `migrations.ts` (6 `readdirSync`), `utils/tools-manager.ts` (2), `packages/tui/src/autocomplete.ts` (2), `modes/daemon/daemon-runtime-identity.ts` (2) | migration dirs / tool dirs / completion paths / source tree | varies | NO | one-shot startup or per-completion | no | **process starts** | `migrations.ts` runs at every process start. |


#### D3. Additional verified hot paths

| # | file:line | Function | Touches | Trigger | Runs when idle? | Scales with | Cost |
|---|---|---|---|---|---|---|---|
| D24 | **`core/cron-jobs.ts:793-797`** (`readStates` in `sessionArtifactMode`) | one `existsSync` + `readFileSync` + `JSON.parse` **per registered session artifact** (`readJobsState` `:1540-1550`) | `nextActiveRunAt` `:781` ← `scheduleNext` `:1047` (fired after **every** `wake()` — 13 call sites in `daemon-mode.ts`) and `mutateStates` `:800`, which calls `readJobs()` **twice more** (`:802`, `:816`) plus one read per path inside the lock (`:807`) | **YES** (scheduler re-arms continuously) | **sessions per worker** | **`total = 3 × sessions_in_worker` full JSON reads per cron mutation**, and `withCronJobsStateLocks` (`:1496-1531`) takes a `proper-lockfile` **per path** with the 100 × 10 ms `Atomics.wait` busy loop at `:1525` → worst case `sessions × 1000 ms` of frozen event loop. |
| D25 | **`modes/daemon/rlm-ledger.ts:996-1001`** (`replaySync`) | `existsSync` + `statSync` + `openSync` + `fstatSync` + **full `readAllSync` + `JSON.parse` per line** + a second `statSync` | `edges()` `:563`, `edgeByChildPath()` `:570`, `siblings()` `:595` (**calls `replaySync` twice**), `appendSpawn()` `:667`, `familyUnlocked()` `:718`, `appendRename/Delete` `:511`/`:536` — reached from `daemon-mode.ts:1349`, `:1624`, `:1803`, `:3132` and `daemon-supervisor.ts:2904`, `:5399`, `:5520` | no | **cumulative subagent count** | **A full ledger read + parse per protocol command that touches session topology.** Bounded only by the 32 MiB fail-closed cap (`:43`); it never shrinks, so every such command gets monotonically slower. |
| D26 | `modes/daemon/daemon-session-list.ts:230` | `statSync(session.sessionFile)` when `savedSession?.modified` is absent | `daemon-mode.ts:2690`, `:3347`, `:3869`, `:4472` (attach), `:4696` (create), `:4849` (rename), `:5366` (`get_state`), `:5974`, and `daemon-session-list.ts:176`, `:203` for the full list | no | **active sessions × list builds** | `total = O(active sessions)` stats per session-list build, per command. |
| D27 | `modes/daemon/daemon-worker-cleanup.ts:770-828` (`persistDaemonWorkerDescriptorUnderGuard`) | `openSync` O_EXCL temp + `fstatSync` + `writeFileSync` + **`fsyncSync`** + `chmodSync` + 2× `lstatSync` + `renameSync` + **`fsyncDirectory`** | `persistWorker` — ~20 call sites in `daemon-supervisor.ts` (`:2421`, `:3345`, `:3743`, `:4137`, `:4203`, `:4231`, `:4248`, `:4283`, `:4318`, `:4391`, `:4420`, `:4457`, …) | no | **worker lifecycle transitions** | **2 fsyncs per attach/detach/promote/recover/rename**, plus a full guard acquire (see C1 = 1 ps + 4 fsyncs). |
| D28 | **`utils/shell.ts:55-88`** (`getShellConfig`) | `existsSync("/bin/bash")` (`:76`) then `isExecutableRegularFile` (`:27` `lstatSync`, `:29` `statSync`, `:30` `accessSync`); worst case `findBashOnPath` `:37-45` stats every PATH entry | `core/tools/bash.ts:63` | no | **bash tool calls** | **4+ syscalls per bash call, completely unmemoized** — the resolved shell cannot change within a process. |
| D29 | `packages/ai/src/env-api-keys.ts:208-212` (`getPrimeTeamId`) | `existsSync` + `readFileSync` of `~/.prime/config.json`, **no memoization** | `openai-completions.ts:540`, inside request-header construction, for `provider === "prime-inference"` | no | **LLM requests** | A blocking open+read on **every** prime-inference model call — which includes every summarizer sweep (A4/D13). |
| D30 | **`packages/tui/src/autocomplete.ts:596`, `:608`** (`getFileSuggestions`) | `readdirSync` of the typed directory + `statSync` per symlink entry | `getSuggestions:363-368` ← `editor.ts:2257` ← `requestAutocomplete:2182`; **debounce is 0** for non-`@`/`#` path-shaped tokens (`editor.ts:2244`) | no | **keystrokes × clients** | Blocking `readdirSync` on the keystroke path. A monorepo root or `node_modules` stalls that TUI's render loop per character. |
| D31 | `core/context-tree.ts:234` (`listChildSessionDirs` sort comparator) | **`statSync(a)` and `statSync(b)` inside `.sort()`** | `getContextTree()` ← `/context` (`interactive-mode.ts:9790`, `daemon-mode.ts:5397`) | no | **RLM children** | **O(n log n) `statSync` calls instead of O(n)** — a plain bug. Plus `context-tree.ts:150` `readFileSync` of each child's whole transcript. |
| D32 | `core/session-manager.ts:1393` | `this.fileEntries.some(e => e.type === "message" && e.message.role === "assistant")` | every `_persist` (`:1390`) | no | **transcript length until the first assistant message** | Short-circuits at the first assistant entry, so bounded in practice — noted only because it is an O(n) scan per append. |
| D33 | `core/session-manager.ts:1279-1298` (`_rewriteFile`) | **rewrites the whole transcript**: stringify all entries + `mkdirSync` + `statSync` + `writeFileSync` + `chownSync` + `chmodSync` + `renameSync` + `rmSync` | `_persist:1401` when `!flushed || !existsSync(file)`; `flushNow:1386`; `materializeSessionFile:1367`; the error path of `_appendEntryWithRollback:1719` | no | **transcript size** | MB-scale rewrite, but correctly gated to pre-first-assistant-message entries and rollback failures. Not on the steady streaming path. |

#### D4. Startup scans (one-shot per process — but 32 TUIs restart constantly)

Ordered by cost, with the operator's actual install verified:

1. **`modes/daemon/daemon-runtime-identity.ts:157` `computeRuntimeBuildId`** ← `getDaemonRuntimeIdentity()` ← `cli/daemon-launch.ts:612` `ensureDaemonRunning` — **runs on every client start**.
   - Source-checkout path `computeSourceBuildId` (`:42-79`) = 3 `git` spawns + `readFileSync` + SHA-256 of **every** file matching `packages/*/package.json` and `packages/*/src/**`. Measured in this repo: **417 files, 7.4 MB hashed per process start.**
   - **Verified NOT hit on this box.** The operator runs from `~/.prime/installs/<name>/lib/node_modules/prime-agent/dist/bundle/`, whose `cli.js` carries the `// prime-agent-bundle-build-id: bundle-v1:9712…` marker, so `readEmbeddedBundleBuildId` (`:95-111`) short-circuits after a 4 KB read. A source-checkout deploy would pay the full 7.4 MB hash per TUI launch.
2. **`migrations.ts:412` `runMigrations`** ← `main.ts:1226`, **unconditional on every process start**: `:102` `readdirSync(agentDir)` + `readFirstLineSync` per stray jsonl, `:169` **`readdirSync` over the entire sessions dir**, `:182`/`:210` legacy dirs, `:221` 2× `statSync` + 2× full `readFileSync` for content comparison, `:341` `readdirSync(toolsDir)`.
3. `core/process-lifecycle.ts:651` → `pruneStaleProcessLogs` — **3378 `statSync`** (see D11).
4. `core/process-lifecycle.ts:459` → `pruneCrashReports` — `readdirSync` + `statSync` per `.json`.
5. `core/agent-session-services.ts:178` `resourceLoader.reload()` → `PackageManager.resolve():855` — recursive skills/prompts/themes/extensions walks, `globSync` (`package-manager.ts:2080`), and `existsSync` on `.agents/skills` in **every ancestor dir up to the git root** (`collectAncestorAgentsSkillDirs:433-452`). **No caching in `resolve()`** — runs per session creation, not just per process.
6. `core/session-manager.ts:771` `findMostRecentSessionForCwd` — bounded 64 KB read of **every** session file, on `--continue` starts.
7. `daemon-supervisor.ts:872` + `:888` — 6 `readdirSync` of the descriptor dir plus a full `daemon-workers` tree walk. Supervisor start only.

**Directories asked about with no scanning loop in code:** `daemon-update-restarts`, `session-artifacts` (path-joined at `session-manager.ts:319`, never enumerated), `snapshot-cache` (explicitly skipped at `daemon-worker-cleanup.ts:640`).

**TUI render path: not in code** — no `fs` call is reachable from `TUI.requestRender`/render in `packages/tui/src`. The only `fs` writes in `tui.ts` are the crash dump (`:1866`) and the env-gated debug dump (`:1931`).

---

### E. `Atomics.wait` AND BUSY WAITS (event-loop-blocking)

| # | file:line | Roles | What blocks | Duration per wait | Loop bound | Worst-case block |
|---|---|---|---|---|---|---|
| E1 | **`core/authority-mutation-guard.ts:378`** | **all** | `Atomics.wait(guardWaitBuffer, 0, 0, retryMs)` — a **shared module-level `Int32Array`** (`:23`) that is never notified, so this is a pure synchronous sleep on the main thread | `retryMs` from the caller | `attempts` from the caller | `session-lease.ts:982` passes `attempts: 100, retryMs: 10` → **up to 1000 ms of hard event-loop block per session-lease mutation**. `daemon-launch-lease.ts:455` also `attempts: 100`. `daemon-socket.ts:239` `attempts: 2, retryMs: 0`. `daemon-supervisor-ownership.ts:695` and `daemon-worker-cleanup.ts:170` use `attempts: 1` (no wait) and retry asynchronously instead. |
| E2 | `core/orphan-process-journal.ts:748` | wrk | `Atomics.wait(journalLockWaitBuffer, 0, 0, 10)` inside `acquireJournalWriteLock`'s `while(true)` (`:735`) | 10 ms | `JOURNAL_WRITE_LOCK_TIMEOUT_MS` deadline (`:729`) | Blocks the whole event loop in 10 ms slices until the deadline. Contended when several shells spawn at once. |
| E3 | `core/cron-jobs.ts:1525` | sup | `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)` — **allocates a fresh `SharedArrayBuffer` per retry** | 10 ms | 100 attempts (`:1503`) | Up to **1000 ms** of blocked event loop, plus 100 SAB allocations. |

Async (non-blocking) retry loops, for contrast — these are fine: `daemon-supervisor-ownership.ts:707` (`await delay(REGISTRY_LOCK_RETRY_MS = 10)` × `REGISTRY_LOCK_RETRIES = 500`, `:32-33`) and `:647` (`await delay(CONSISTENT_READ_RETRY_MS = 25)` × 3, `:642-643`).

---

### F. LOGGING VOLUME AND ROTATION

**Every diagnostic sink in these four packages is synchronous.** There is no async logger, no buffered writer, no worker thread. `packages/agent/src` contains no logging at all.

#### F1. The 4× write-amplification chain

One logical worker log line costs **4 file appends across 2 processes**:

1. `DaemonMode.log()` (`modes/daemon/daemon-mode.ts:713-717`) → `console.error(message)` (`:714`)
2. → `structuredLog.warn(...)` (`:715`) → `appendRotatingLog(agent.jsonl, ...)` (`core/logging.ts:24`)
3. → `appendRotatingLog(<workerSocket>.log, ...)` (`:716`)
4. The worker's stderr from step 1 is piped to the supervisor (`daemon-supervisor.ts:3569` `stdio:["ignore","ignore","pipe","pipe"]`) and re-logged by `attachJsonlLineReader` → `this.log("Session worker <id> stderr: " + line)` (`daemon-supervisor.ts:3609`), which itself does steps 1–3 again → supervisor `agent.jsonl` + supervisor daemon log.

`appendRotatingLog` (`config.ts:600-614`) costs **`mkdirSync` + `existsSync` + `statSync` + `appendFileSync`** = 4 syscalls per line, and it is invoked **twice** per `this.log()`. So one worker log line ≈ **16 synchronous syscalls machine-wide**, and `agent.jsonl` is a **single shared file that all 45 processes append to unsynchronized** (rotation at `:604-607` can rename it out from under 44 other writers).

Confirmed on disk: the live daemon log tail is dominated by `supervisor: Session worker <id> stderr: ...` lines.

#### F2. Per-process steady-state log rate

| Process role | What it writes at idle | Rate | Runs when idle? | Scales with |
|---|---|---|---|---|
| **every process** | `process_heartbeat` (~1 KB, `includeResources:true`) to its own `logs/processes/<uuid>.jsonl` (`core/process-lifecycle.ts:647-650`, `:365`) | **1/min/process** = `(1+12+32+cat+children) ≈ 45+ KB/min` = **~65 MB/day** | **YES** | **processes** |
| supervisor | worker stderr relay (`daemon-supervisor.ts:3609`) + own `this.log` | matches worker output ×2 files | on worker activity | **workers × worker log lines** |
| daemon worker | `Worker fence phase=...` **only when `elapsedMs >= 100`** (`daemon-mode.ts:922`) | 0/s healthy; **up to 4/s per worker** under fs contention → ×16 syscalls | conditional | **workers** |
| daemon worker | `Worker command admission ... phase=...` **only when `elapsedMs >= 100`** (`daemon-mode.ts:4280`) | 0/s healthy; 1 per slow command | conditional | **commands** |
| daemon worker | `Worker auth trace=... phase=...` — **ungated, always 2 lines** (`daemon-mode.ts:4179`, `:4184`/`:4190`) | 2 per supervisor↔worker connection | reconnect storms | **reconnects** |
| daemon worker | **`<workerId>.recovery.jsonl` — an `openSync`+`writeSync`+`fsyncSync`+`closeSync`+`chmodSync` per session event** (`daemon-mode.ts:7468` → `worker-recovery-journal.ts:95-103`) | **~4 fsyncs per tool call** (16 checkpoint event types at `daemon-mode.ts:426-443`; dedup key is `(busy, operation, sessionFile)` at `:67-73`, and `operation` is the event type, so consecutive distinct events all write) | no | **tool calls × sessions** |
| supervisor | `command-journal.jsonl` — 3 fsync'd appends per **mutating** command (`command-recovery-journal.ts:174-183` from `daemon-supervisor.ts:2014`, `:2051`, `:2116`) | 3 fsyncs/mutating command | no | **mutating commands** |
| supervisor | `traceWorkerStartup` ~31 lines per worker launch (`daemon-supervisor.ts:1042`, 32 call sites) | burst | no | **worker launches** |
| daemon worker | `traceRuntimeCreate` ~24 lines per session create (`daemon-mode.ts:720`, 24 call sites) → ~96 log appends + 24 process-JSONL events | burst | no | **session creates** |
| TUI client | `client-errors.log` (`agents-view-mode.ts:2924`, `cli/daemon-launch.ts:62`) | error-only | no | **clients** |
| catalog subprocess | **no log file of its own** — spawned with stderr `"ignore"` (`daemon-catalog-process.ts:404`); writes only `agent.jsonl` + its process JSONL | 1 heartbeat/min | YES | **catalog processes** |
| mcp-serve | **no log file of its own** — `console.error` only (`modes/mcp-serve/mcp-serve-mode.ts:66`, `:148`) + shared sinks | 1 heartbeat/min | YES | **mcp processes** |

Roster heartbeat (`daemon-mode.ts:811`) and the roster watchdog (`daemon-supervisor.ts:970`, `:5676`) **write no log** — the supervisor early-returns on roster heartbeat frames (`:6678-6680`).

#### F3. Rotation and retention

| Log file | Path expression (file:line) | Rotation | Retention | Verdict |
|---|---|---|---|---|
| `logs/<socket-basename>.<sha8>.log` (supervisor **and one per worker**) | `config.ts:576-580`; written `config.ts:612` from `daemon-supervisor.ts:1015` and `daemon-mode.ts:717` | `MAX_LOG_BYTES = 5 MiB` (`config.ts:592`), single `.old` generation (`:604-607`) | **NONE for the set of files** | **FLAG — unbounded file count.** Every worker socket ever created leaves a `worker-*.sock.*.log` (up to 10 MiB with its `.old`) and nothing ever deletes them. This is the 1660 files in `~/.prime/agent/logs`. |
| `logs/agent.jsonl` | `config.ts:567-569`; sink `core/logging.ts:20-25` | `AGENT_LOG_MAX_BYTES = 20 MiB` (`core/logging.ts:5`) | one `.old` | Bounded at 40 MiB (measured 11 + 20 MB). **But 45 processes write it concurrently and each can trigger the rename.** |
| `logs/processes/<uuid>.jsonl` | `core/process-lifecycle.ts:106` | `MAX_PROCESS_LOG_BYTES = 5 MiB` (`:21`), rotate `:351-358` | **YES — `PROCESS_LOG_RETENTION_MS = 14 d` (`:28`), `pruneStaleProcessLogs` `:420-432`, scheduled once per process start (`:651`)** | Bounded per file, but 14 days × ~1 KB/min/process = the measured **3378 files / 1.0 GB**. The pruner is the only thing keeping it finite. |
| `logs/client-errors.log` | `config.ts:544-546`; `agents-view-mode.ts:2924` | 5 MiB default | one `.old` | Bounded 10 MiB (measured 2.9 + 5.0 MB). |
| `logs/crash-reports/*.json` | `core/process-lifecycle.ts:451`, `:509` | n/a | `MAX_CRASH_REPORTS = 20` (`:29`), `pruneCrashReports` `:434-443` | Bounded. Note `native-crash-*.json` share the same 20 slots. |
| `logs/agent-traces.log` | `config.ts:562-564`; `core/agent-traces.ts:718`, `:984` | 5 MiB default | one `.old` | Bounded. |
| `rlm-ledger/<sha16>.jsonl` | `modes/daemon/rlm-ledger.ts:208-212`; append `:921`, `:949`, fsync `:950` | **NONE** | **NONE** | **FLAG.** `RLM_LEDGER_MAX_BYTES = 32 MiB` / `RLM_LEDGER_MAX_RECORDS = 100_000` (`:43-44`) are read-side **fail-closed** bounds that *throw* (`:297`, `:328`, `:379`, `:966`) — there is no compaction path. A heavy subagent user eventually gets a permanently unreadable ledger. |
| `daemon-workers/<workerId>.recovery.jsonl` | `daemon-supervisor.ts:1401`, `:3392`, `:3481`; append `worker-recovery-journal.ts:95-103` | Compaction **only when every tracked session is non-busy** (`:81-83`) | **NONE** | **FLAG — no size bound.** One perpetually busy session prevents compaction forever while the file grows ~4 fsync'd lines per tool call. |
| `daemon-workers/<workerId>.orphans.jsonl` | `daemon-supervisor.ts:1402`, `:3483`; append `core/orphan-process-journal.ts:1049-1051` | **NONE** | Cleared only at worker teardown (`:1588`) | **FLAG — no rotation, no retention** (bounded in practice by spawned-process count). |
| `descriptorDir/command-journal.jsonl` | `daemon-supervisor.ts:887`; `command-recovery-journal.ts:174` | Compaction at `COMPACT_AFTER_RECORDS = 4096` (`:42`, triggered `:106`, `:123`) | n/a | Bounded. |
| session `<id>.jsonl` transcript | `core/session-manager.ts:305`, append `:1405` | **NONE** | **NONE** | Intentional (it is the transcript), but there is no cap. |
| `refinements.jsonl` | `core/refinement/refinement.ts:361-363`, append `:377` | **NONE** | **NONE** | **FLAG.** |
| `~/.prime/agent/pi-debug.log` | `packages/tui/src/tui.ts:1673`, append `:1675` | **NONE** | **NONE** | **FLAG** — gated on `PI_DEBUG_REDRAW=1`. |
| `/tmp/tui/render-<ts>-<rand>.log` | `packages/tui/src/tui.ts:1906-1908`, write `:1931` | **NONE — one new file per render frame** | **NONE** | **FLAG** — gated on `PI_TUI_DEBUG=1`. |
| `PI_TUI_WRITE_LOG` target | `packages/tui/src/terminal.ts:162-174`, append `:495` | **NONE** | **NONE** | **FLAG** — `appendFileSync` on **every terminal write**, i.e. 60+/s per TUI when set. |
| `~/.prime/agent/prime-agent-debug.log` | `config.ts:648-650`; `interactive-mode.ts:10280` | truncating `writeFileSync` | n/a | Bounded; `/debug` command only. |

#### F4. Verbosity knobs

`PI_TUI_WRITE_LOG`, `PI_DEBUG_REDRAW`, `PI_TUI_DEBUG`, `PI_TIMING` all *increase* volume. There is **no way to turn logging down**: `getLogger`'s levels all route to the same unconditional sink (`packages/ai/src/log.ts:61-79` → `core/logging.ts:22-25`), and both daemon `log()` helpers hard-code `structuredLog.warn` (`daemon-mode.ts:715`, `daemon-supervisor.ts:1013`). No `LOG_LEVEL`, `DEBUG`, `NODE_DEBUG`, `VERBOSE`, or `settings.json` logging key exists — **not in code**.

---

### G. PROTOCOL FAN-OUT

#### G1. Handlers that iterate all workers or all sessions per request

| # | Handler (file:line) | Iterates | Worker RPC? | Runs when idle? | Scales with | Caller + frequency |
|---|---|---|---|---|---|---|
| G1 | **`case "heartbeats_list":` `daemon-supervisor.ts:2492`** | ALL workers (`:2497`) | **YES — uncapped `Promise.all`, 5 s timeout each** (`:2500-2504`) | **YES** | **clients × workers** | `heartbeat-catalog.ts:6` ← `agents-view-mode.ts:893` `setInterval(…, 15000)`. **Formula: total = 32 clients / 15 s × 12 workers = ~26 worker RPCs/sec at pure idle.** Also `daemon-agent-connection.ts:784` (global when `ownedSession` is false) driven from `interactive-mode.ts:2606`. Per-worker `heartbeatSnapshot` cache (`:2508-2527`) is a **fallback only** — a live ready worker is always re-queried. |
| G2 | **`broadcastHeartbeatsChanged` `daemon-supervisor.ts:7832`** | ALL clients, unfiltered (`:7833`) | no (notification) | on any worker heartbeat/cron change | **clients × workers (amplified)** | Origin: `daemon-mode.ts:706` `broadcastGlobal({type:"heartbeats_changed"})`, relayed at `daemon-supervisor.ts:6681`. **This is the amplifier: 1 worker-side change → 32 client notifications → 32 `heartbeats_list` requests → 32 × 12 = 384 worker RPCs.** Clients react at `agents-view-mode.ts:855` and `interactive-mode.ts:5224`. |
| G3 | `case "list":` `daemon-supervisor.ts:2118` → `handleList` `:2850` | all roster entries twice (`:2857`, `:2910`) + all spawn-ledger edges (`:2924`) | no | no | **sessions** | `mcp-serve/tools.ts:778`, `cli/daemon-command.ts:645,823`, `cli/daemon-launch.ts:160`, `cli/daemon-ps.ts:569`, `daemon-agent-connection.ts:1948`. **No polling timer** — agents-view deliberately uses the roster subscription instead. With `all`, adds a catalog `readdir`+`stat`+full-file scan per session (`core/session-manager.ts:1099,1112,953`) and an unbounded `Promise.all` hydrate (`:2917`). |
| G4 | **`findWorker` `daemon-supervisor.ts:5970`** | on a selector **miss** (`:5972`) fires `Promise.all` of `refreshWorkerSummaries` — a `{type:"list"}` RPC — to **every** worker (`:5976-5980`) | **YES, uncapped** | no | **workers × stale selectors** | Entry point for ~30 per-session handlers (`attach`, `prompt`, `steer`, `cron_*`, `heartbeat_*`, `get_direct_worker_transport`, …) via `findWorkerForClient` `:6008`. **Any stale session id from any of 32 clients costs a full 12-worker round-trip. No negative cache.** |
| G5 | `runIdleEvictionSweep` `daemon-supervisor.ts:1123` | ALL workers × up to 3 rounds (`:1131`, `:1146`, `:1172`) | **YES, 3 uncapped `Promise.all`** | **YES** (timer A24) | **workers** | Every 300 s at default settings. `total = 36 worker RPCs / 5 min`. |
| G6 | `case "cron_list":` `:2464` (unqualified branch `:2465`) | ALL workers (`:2470-2478`) | **YES, uncapped** | no | **workers** | **No in-repo caller for the fan-out branch** — CLI always passes `activeSessionId`. |
| G7 | `case "cron_cancel":` `:2575` (unqualified branch `:2576`) | ALL live workers, **two rounds** (`:2580-2591`, then `:2599`) | **YES ×2, uncapped** | no | **workers** | Not in code for the fan-out branch. |
| G8 | `case "agent_messages_pause"/"resume":` `:2450-2451` (unqualified `:2455`) | ALL live workers (`:2456-2460`) | **YES, uncapped, no timeout override** | no | **workers** | Not in code for the fan-out branch. |
| G9 | `case "prepare_update_restart":` `:2435` → `prepareUpdateRestartFenced` `:7268` | ALL workers × up to 4 rounds (`:7281`, `:7315`, `:7375`, `:7394`) | **YES ×4, `Promise.allSettled`, no cap** | no | **workers** | Update flow only. 90 s per-worker timeout (`:231`), 100 s overall (`:236`). |
| G10 | `case "list_saved_sessions":` `:2156` → `handleSavedSessionList` `:2991` | catalog child scans all sessions on disk (`:3028`); streams **one `session_list_item` frame per session** to the client (`:3020-3025`) | no | no | **sessions** | agents-view saved search (`agents-view-mode.ts:889`). At 231 sessions that is 231 socket frames per request. |
| G11 | `familyCatalogEntries` `:5232` | ALL workers (`:5236-5239`) + full `catalog.list` disk scan (`:5244`) | no | no | **workers + sessions** | Session-name reservation on `rename_saved_session` / `create`. |
| G12 | `matchWorkers` `:6066` | full roster scan | no | no | **sessions** | Per call from `detachClient` `:6630`, `syncWorkerExtensionUi` `:6644`, `createOrReuseWorker` `:3045`. |
| G13 | **`assertServingCurrentOwnership` `:1310`, called at `:1960` for EVERY inbound command** | registry dirs | no | on every command | **commands** | → `ownership.assertCurrent()` (`daemon-supervisor-ownership.ts:275`) → `requireOwnerCopies` (`:1994`, `readFileSync` per registry dir, up to 3 attempts, `:642`) → **`assertSelfOwnedAuthority` (`:1524`) → `matchesExactProcessIdentity` (`:1529`) → `/bin/ps`**. **Formula: every supervisor command costs ≥1 `/bin/ps` (8.4–40 ms) on the supervisor's single event loop → a hard machine-wide ceiling of ~25–120 commands/sec.** |
| G14 | Session-event relay `:7049-7069` | ALL clients, filtered by `attachedActiveSessionIds` (`:7050`) | no | per worker frame | **clients × events** | Iterates all 32 clients for every session-bearing frame from every worker. |
| G15 | `scheduleCompactCatchup` `:7105` | ALL clients filtered to attached (`:7112`), then `Promise.all(catchUpClient)` (`:7115`) | no | on undecodable compact delta | **clients** | Uncapped. |
| G16 | `mcp-serve/tools.ts:65` (`status` tool) | one `list` (`:778`) **plus** an unbounded `Promise.all` `get_last_assistant_text` per `waiting_on_user` session (`:781-793`, `PENDING_QUESTION_TIMEOUT_MS = 5_000` `:36`) | **YES, uncapped** | no | **sessions waiting on user** | Every `status` call from every MCP client. |

#### G2. Roster refresh

- `broadcastRosterFrame` is **worker-side**: `daemon-mode.ts:7817`; recipients are only supervisor-claimed clients (`:7819-7822`) — in practice exactly 1. Idle keepalive at `:811` (15 s); event-driven via `scheduleRosterFlush` `:7702` coalesced to one `setImmediate`, called from 16 sites (`:707, 1701, 2015, 4227, 4751, 4962, 5283, 5567, 5581, 5621, 5642, 6883, 7415, 7650, 7661`).
- Supervisor ingest `consumeWorkerRosterDelta` `:5436`; `applyWorkerRosterSnapshot` `:5513` reads the whole spawn ledger and may `readSessionInfo` per unseeded family edge inside the apply loop (`:5567`).
- Supervisor re-publish `flushRosterUpdates` `:5314` iterates ALL clients (`:5333`); full resyncs at `:1667` (drain) and `:2122` (`roster_subscribe`) materialize the entire roster via `rosterEntriesForClient` `:5347`.
- Worker-side `case "list":` `daemon-mode.ts:4599` → `buildSessionListWithPassiveRlmSubagents` `:1903` walks the RLM ledger with a **sequential `await readSessionInfo`** per edge (`daemon-mode.ts:1827`) — no concurrency, no batching.

**Concurrency limiting:** the only capped fan-out in the whole supervisor is startup adoption, `STARTUP_WORKER_CONNECTION_CONCURRENCY = 8` (`daemon-supervisor.ts:220`, semaphore at `:923`). Every other fan-out is a bare `Promise.all`/`Promise.allSettled`.

---

### H. PROCESS IDENTITY — every `/bin/ps` call site

`observeProcessIdentity` (`core/session-lease.ts:781`) is the only entry point. On darwin it runs `ps -ww -o command= -p <pid>` (`:751`) and, if no `prime-agent-owner-token=` marker is found in argv, a second `ps -p <pid> -o lstart=` (`:381`). Both via `execFileSync` (`:411`) — **synchronous, blocks the event loop.**

| # | Call site (file:line) | Roles | Cached? | Trigger | Frequency at operator scale |
|---|---|---|---|---|---|
| H1 | **`daemon-supervisor-ownership.ts:1010`** (`matchesExactProcessIdentity` inside `assertDaemonSupervisorOwnerCurrent` `:979`) | **wrk** | **NO** | worker fence poll (A23) **and** every worker command admission (`daemon-mode.ts:4272`) | **48 ps/sec idle** (12 workers × 4 Hz) + 1 per command |
| H2 | **`daemon-supervisor-ownership.ts:1076` AND `:1077`** (`assertDaemonSupervisorOwnerCurrentForWorkerAuthentication` `:1041`) | wrk | **NO** | same as H1 on the legacy claim branch | **2 ps per check** → 96 ps/sec if any worker is on the legacy path |
| H3 | **`daemon-supervisor-ownership.ts:1529` + `:1536`** (`assertSelfOwnedAuthority` `:1524`) reached from `ownership.assertCurrent()` `:280` | **sup** | **NO** | **every inbound supervisor command** (`daemon-supervisor.ts:1960`) and again per journaled result (`:2050`, `:2061`) | **≥1 ps per command, on the supervisor's single event loop** |
| H4 | **`daemon-supervisor-ownership.ts:1518`** (`currentProcessIdentityFields`, used `:669`, `:798`, `:899`, `:1123`) | sup | **NO** | every `withRegistryGuards` acquisition | 1 ps per registry mutation; 1 Hz while a shutdown-admission or offline-maintenance lease is held (A5) |
| H5 | `core/session-lease.ts:970` (`getCurrentProcessIdentityObservation`) | all | **YES — module-level memo `currentProcessIdentityObservation` (`:968`)** | first `withLeaseGuard` | 1 ps per process lifetime. **This is the pattern the other sites should copy.** |
| H6 | `core/session-lease.ts:243` (`observeProcessIdentity` for a coarse-hint owner) | all | NO | session-lease owner validation | per lease check |
| H7 | `core/session-lease.ts:868` (`classifyProcessIdentityAuthority`), `:896` (`matchesExactProcessIdentity`), `:902` (`getProcessStartId`) | all | NO | the shared reducers — every caller below funnels through these | — |
| H8 | `core/orphan-process-journal.ts:525` (`processIdentityRecordFields`, used `:590`, `:657`) | wrk | **NO** | every journal write-lock candidate + every removal claim | **2 ps per orphan journal lock cycle** |
| H9 | `core/orphan-process-journal.ts:1262` (`enrollOrphanProcess`) | wrk | NO | **every detached child spawn** (`utils/shell.ts:206`) | 1 ps per spawn; with H8 that is **~3 ps per enroll and ~3 per retire** |
| H10 | `core/orphan-process-journal.ts:515`, `:1411`, `:1429`, `:1444`, `:1451` | wrk | NO | orphan reap/liveness probes | 1–2 ps per probed orphan |
| H11 | `core/kernel/repl-manager.ts:1372` (`observeProcessIdentity(targetPending.targetPid)`) | wrk | NO | kernel REPL target validation | per kernel op |
| H12 | `modes/daemon/daemon-socket.ts:109` and `:237` | sup/wrk | NO | socket lease acquire | one-shot per daemon start / cleanup |
| H13 | `modes/daemon/daemon-launch-lease.ts:159`, `:171`, `:250`, `:298`, `:309`, `:324`, `:420` | sup | NO | daemon launch lease contention checks | one-shot per launch, but up to 7 ps in a contended launch |
| H14 | `cli/daemon-ps.ts:395`, `:408`, `:1250`, `:1255`, `:1267`, `:1273`, `:1393`, `:1398`, `:1445`, `:1755`, `:1780` | CLI | NO | `prime ps` | **11 potential ps spawns per `prime ps`**, on top of B5's own `ps`/`lsof` calls |
| H15 | `cli/daemon-launch.ts:244`, `:304` | CLI | NO | daemon launch/probe | one-shot |
| H16 | `cli/daemon-update-restart.ts:431` | CLI | NO | update restart | one-shot |
| H17 | `core/session-lease.ts:1015`, `:239` | all | NO | lease reclamation | per reclaim |

---

### I. ENV / CONFIG that could tune any of this without code changes

| Knob | Where read (file:line) | Tunes | Verdict |
|---|---|---|---|
| `PRIME_AGENT_CODING_AGENT_DIR` | `core/process-lifecycle.ts:20`, `:80` | Moves `logs/processes` (and everything else) to another path — e.g. a tmpfs | **Usable today**: pointing this at a fast/ephemeral volume removes the 1 GB jsonl churn from the main disk. |
| `settings.json` → `idleEvictionMinutes` (default 90) | `core/settings-manager.ts:140`, `:803`; consumed by `idleEvictionSweepIntervalMs` `daemon-supervisor.ts:701` | Idle-eviction sweep period, clamped to `[60 s, 300 s]` (`:250-251`), **and** whether idle sessions are evicted at all | **The single most useful existing knob**: lowering it from 90 evicts idle workers sooner (fewer workers → less of everything in the top-15), but also makes the sweep fan-out more frequent (`min` clamp is 60 s). `"off"` disables eviction and pins the sweep at 300 s. |
| `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR` | `daemon-supervisor-ownership.ts:27` | Registry location (affects guard fsync target filesystem) | Internal; pointing it at a tmpfs would make the 4-fsync guard cycle nearly free, at the cost of durability across reboots. |
| `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS` | kernel bootstrap | Kernel boot concurrency | Only affects Python kernels. |
| `PRIME_AGENT_TELEMETRY`, `PRIME_AGENT_TELEMETRY_ENDPOINT`, `PRIME_AGENT_TRACES_*` | telemetry setup | External telemetry | Does not affect local log volume. |
| `PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND` | `cli/owned-session-worker.ts:1091` | Legacy owned-worker frontend | Off by default; not a perf knob. |

**Not in code — there is no env var or settings key for any of these:**
- `HEARTBEAT_INTERVAL_MS = 60_000` (`core/process-lifecycle.ts:30`) — lifecycle heartbeat period
- `SUPERVISOR_FENCE_POLL_MS = 250` (`daemon-mode.ts:421`) — **the 48 ps/sec loop**
- `ROSTER_HEARTBEAT_INTERVAL_MS = 15_000` (`daemon-worker-protocol.ts:53`)
- `ROSTER_WATCHDOG_INTERVAL_MS = 15_000` (`daemon-supervisor.ts:221`)
- `HEARTBEAT_POLL_INTERVAL_MS = 15000` (`agents-view-mode.ts:102`) — the client poll driving G1
- `SWEEP_INTERVAL_MS = 25_000` (`daemon-session-summarizer.ts:7`) — the LLM summarizer sweep
- `MAX_PROCESS_LOG_BYTES = 5 MB` / `PROCESS_LOG_RETENTION_MS = 14 d` (`core/process-lifecycle.ts:21`, `:28`)
- `MAX_LOG_BYTES = 5 MB` (`config.ts:592`) / `AGENT_LOG_MAX_BYTES = 20 MB` (`core/logging.ts:5`)
- Any log-level / verbosity gate: `structuredLog.warn` is called unconditionally from `daemon-mode.ts:715` and `daemon-supervisor.ts:1013`. **There is no `DEBUG`, `LOG_LEVEL`, or `VERBOSE` switch anywhere in these four packages.**
- Any way to disable the process-identity `ps` probe or substitute a cheaper one.
</content>
</invoke>

---


Scale variables: **W = 12** workers, **C = 32** clients, **S = 231** sessions, **P ≈ 45** Prime processes. `ps_cost` = 8.4 ms measured idle / ~40 ms operator-measured under load. Every entry below is something whose **total cost grows with workers, clients, or sessions**.

---

#### 1. CRITICAL — Worker fence loop spawns `/bin/ps` 4× per second, per worker, forever

`modes/daemon/daemon-mode.ts:907` (`SUPERVISOR_FENCE_POLL_MS = 250`, `:421`) → `:940` → `daemon-supervisor-ownership.ts:979` → `:1010` `matchesExactProcessIdentity` → `core/session-lease.ts:781` → `:411` `execFileSync("/bin/ps", …)`.

**`total = W × (1000 / 250) × ps_cost = 12 × 4 × 8.4–40 ms = 0.40–1.92 CPU-seconds per second`**, and every worker's event loop is **blocked 34–160 ms out of every second** while completely idle. The legacy branch (`:1041`) probes twice (`:1076`, `:1077`) → **96 ps/sec**.

**Fix:** the supervisor's pid/start-id cannot change without the socket dropping. Validate once at `worker_auth` (`daemon-mode.ts:4184`) and re-validate only on a socket event, or memoize with a 30 s TTL — the pattern already at `core/session-lease.ts:968-971`.

---

#### 2. CRITICAL — Every supervisor command spawns `/bin/ps` on the supervisor's single event loop

`daemon-supervisor.ts:1960` → `:1310` → `daemon-supervisor-ownership.ts:275` → `:1529` `matchesExactProcessIdentity(identity.pid, …)` where `identity.pid` **is the supervisor's own pid**. Repeated per journaled result at `:2050` and `:2061`.

**`machine_ceiling = 1 / ps_cost ≈ 25–120 commands/sec` for all 32 clients combined.** Every `list`, `attach`, `prompt`, and `heartbeats_list` pays it, serialized.

**Fix:** memoize `assertSelfOwnedAuthority`'s self-probe at module scope (a process's own start-id is immutable). Keep the registry `readFileSync` comparison; only the `ps` goes.

---

#### 3. CRITICAL — Every command *to* a worker spawns another `/bin/ps` on that worker

`daemon-mode.ts:4272` `assertSupervisorClaimCurrent(...)` on every admitted command.

**`per_worker_ceiling = 1 / ps_cost ≈ 25–120 commands/sec`.** Combined with #4, the idle poll alone costs `26 RPC/s × 40 ms ≈ 1.0 CPU-second per second` of blocked worker loops.

**Fix:** `boundClaim.ownerFingerprint` is already threaded through (`:4294`). Give it a 1 s TTL and let the (fixed) fence loop be the only re-validator.

---

#### 4. CRITICAL — Uncapped fan-out over all workers on every client action

Three paths, all bare `Promise.all` with no semaphore:
- `heartbeats_list` `daemon-supervisor.ts:2492` → `:2500-2504`, driven by `agents-view-mode.ts:893` `setInterval(…, HEARTBEAT_POLL_INTERVAL_MS = 15000)` (`:102`).
- `broadcastHeartbeatsChanged` `daemon-supervisor.ts:7832` notifies **all** clients unfiltered (`:7833`), each of which answers with a global `heartbeats_list`.
- `findWorker` on a selector miss `daemon-supervisor.ts:5972` → `Promise.all` of `refreshWorkerSummaries` to **every** worker (`:5976-5980`); this is the entry point for ~30 per-session handlers via `findWorkerForClient` (`:6008`), with no negative cache.

**`idle_total = (C / 15 s) × W = (32/15) × 12 ≈ 26 worker RPCs/sec`, each triggering #3 → ≈ 1.0 CPU-s/s.**
**`burst_total = 1 change → C × W = 32 × 12 = 384 RPCs`.**
**`stale_selector_total = W × ps_cost = 12 × 40 ms = 480 ms` of aggregate worker blocking per miss** — and after a worker restart all 32 clients miss at once.

**Fix:** serve `heartbeats_list` from the existing `worker.heartbeatSnapshot` cache (`:2508-2527`) with a 5 s TTL, cap all three fan-outs with the semaphore already imported for startup adoption (`:220`), coalesce `broadcastHeartbeatsChanged` per tick, and add a 2–5 s negative cache for missed selectors.

---

#### 5. HIGH — Cron scheduler re-reads one JSON file **per session** three times per mutation, each behind a busy-wait lock

`core/cron-jobs.ts:793-797` `readStates()` in `sessionArtifactMode` does `existsSync` + `readFileSync` + `JSON.parse` **per registered session artifact** (`readJobsState` `:1540-1550`). `mutateStates` (`:800`) calls `readJobs()` at `:802` and again at `:816`, plus one read per path inside the lock (`:807`). `nextActiveRunAt` (`:781`) does another full pass and is re-armed by `scheduleNext` (`:1047`) after **every** `wake()` — 13 call sites in `daemon-mode.ts`. `withCronJobsStateLocks` (`:1496-1531`) takes a `proper-lockfile` **per path** with the 100 × 10 ms `Atomics.wait` at `:1525`.

**`reads_per_mutation = 3 × sessions_in_worker`; `worst_case_block = sessions_in_worker × 1000 ms` of frozen event loop.** At ~19 sessions/worker that is ~57 full JSON reads and up to 19 s of theoretical stall per cron mutation.

**Fix:** cache each artifact's parsed state keyed on `(size, mtimeMs)` — the same trick `readSessionInfo` already uses (`core/session-manager.ts:951-966`) — and take one lock over the whole set instead of one per path.

---

#### 6. HIGH — `process_heartbeat` writes a 1 KB record from every process every 60 s

`core/process-lifecycle.ts:647-650`, `HEARTBEAT_INTERVAL_MS = 60_000` (`:30`), with `includeResources: true` (`memoryUsage` + `resourceUsage` dominate the payload).

**`total = P × 1 KB / 60 s ≈ 45 KB/min ≈ 65 MB/day`, plus `P × 4 syscalls/min` (`appendEventLine` `:361-366`).** Measured on disk: **3378 files, 1.0 GB**; a sampled idle client's jsonl was **358 of 361 lines pure heartbeat**.

**Fix:** drop `includeResources: true` from the heartbeat (keep it for `process_start` and crash events) — that removes ~80% of the bytes — and raise the interval to 300 s. Add an env override; there is none today.

---

#### 7. HIGH — Every process start scans two large directories and the whole sessions dir

- `core/process-lifecycle.ts:420-432` `pruneStaleProcessLogs` — `readdirSync` + **`statSync` per entry over 3378 files**, scheduled unconditionally at `:651`.
- `migrations.ts:412` `runMigrations` ← `main.ts:1226`, unconditional: `readdirSync(agentDir)` (`:102`), **`readdirSync` over the entire sessions dir** (`:169`), plus `statSync`/`readFileSync` pairs at `:221`.
- `core/process-lifecycle.ts:459` `pruneCrashReports` — `readdirSync` + `statSync` per report.

**`total = processes_started × (3378 + |sessions| + |crash reports|) stats`.** Booting the current fleet costs **~152 000 `statSync`** from the pruner alone, and #6 is what creates those files — a closed loop.

**Fix:** write a `.last-prune` stamp and skip the scan unless it is >24 h old; gate `runMigrations` on a schema-version file instead of re-scanning every start.

---

#### 8. HIGH — An `fsync` per session event in the worker recovery journal

`daemon-mode.ts:7468` (16 checkpoint event types at `:426-443`) → `worker-recovery-journal.ts:66` → `:95-103` `openSync`+`writeSync`+**`fsyncSync`**+`closeSync`+`chmodSync`. The dedup key at `:67-73` is `(busy, operation, sessionFile)` where `operation` *is* the event type, so consecutive distinct events all write.

**`total ≈ 4 fsyncs per tool call × concurrently-streaming sessions`** — tens of disk barriers per second across 12 workers during normal work. The file **never compacts while any session is busy** (`:81-83`), so it also grows without bound.

**Fix:** debounce the checkpoint per session to ~250 ms and fsync once; recovery only needs the latest state, which a debounce preserves.

---

#### 9. HIGH — The RLM ledger is fully re-read and replayed on every topology command, and never compacts

`modes/daemon/rlm-ledger.ts:996-1001` `replaySync` = `existsSync` + `statSync` + `openSync` + `fstatSync` + **full `readAllSync` + `JSON.parse` per line**. Reached from `edges()` `:563`, `edgeByChildPath()` `:570`, `siblings()` `:595` (**twice per call**), `appendSpawn()` `:667`, `familyUnlocked()` `:718` — i.e. from `daemon-mode.ts:1349`, `:1624`, `:1803`, `:3132` and `daemon-supervisor.ts:2904`, `:5399`, `:5520`. `appendRecord` (`:912-950`) additionally re-reads the whole file (`:924`) and fsyncs 2–3 times per append.

**`cost_per_command = O(ledger_size)`, and `ledger_size` grows monotonically with cumulative subagent count with no compaction path.** `RLM_LEDGER_MAX_BYTES = 32 MiB` (`:43`) is a read-side bound that **throws** (`:297`, `:328`, `:379`, `:966`) — the ledger eventually fails closed.

**Fix:** cache the replay keyed on `(size, mtimeMs)`, stop calling `replaySync` twice in `siblings()`, and add a compaction pass before the 32 MiB cliff.

---

#### 10. HIGH — 4× log write amplification onto one shared file written by 45 processes

`daemon-mode.ts:713-717` writes stderr + `agent.jsonl` + the worker's own log; the supervisor's stderr reader (`daemon-supervisor.ts:3609`) then re-logs the same text into *its* `agent.jsonl` + daemon log. `appendRotatingLog` (`config.ts:604-612`) costs `mkdirSync`+`existsSync`+`statSync`+`appendFileSync` and runs **twice per `this.log()`**.

**`total = worker_log_lines × 16 syscalls`; measured 300–400 daemon lines/min ⇒ ~100 syscalls/sec**, all converging on one 20 MB `agent.jsonl` that all 45 processes rotate against each other (`config.ts:604-607`). There is **no log-level knob anywhere** (`packages/ai/src/log.ts:61-79`).

**Fix:** stop relaying worker stderr into the supervisor's own log — the worker already writes it twice. Gate `daemon-supervisor.ts:3609` behind a debug flag.

---

#### 11. HIGH — Every bash/detached spawn costs ~6 `/bin/ps`, 6 fsyncs, and 4 full journal reads

Enroll: `orphan-process-journal.ts:1262` (1 ps) → `appendRecordToExistingAuthority` `:1025` → `withJournalWriteLock` `:783` → `createJournalWriteLockCandidate` `:657` (1 ps + fsync `:668`) + `claimJournalWriteLockRemoval` `:590` (1 ps + fsync `:596`) + the record itself (**full-file read `:1029`, fsync `:1051`, second full re-read `:1053`**). Retire (`utils/shell.ts:224`) repeats all of it. On top, `utils/shell.ts:55-88` `getShellConfig` does 4 unmemoized syscalls per bash call.

**`total = bash_tool_calls × 2 × (3 ps + 3 fsync + 2 full reads) ≈ 50–240 ms of blocked worker event loop per bash call.`**

**Fix:** memoize `processIdentityRecordFields()` (`:524-528`, probes `process.pid`, immutable) — that removes 4 of the 6 ps immediately — and memoize `getShellConfig`.

---

#### 12. HIGH — Every registry guard acquisition costs 1 `/bin/ps` + 4 fsyncs

`daemon-supervisor-ownership.ts:669` `currentProcessIdentityFields()` → `:1517-1518` `observeProcessIdentity(process.pid)` (**self, uncached**), then `authority-mutation-guard.ts:314`, `:329`, `:434`, `:447` = 4 fsyncs uncontended, 6 on reclaim. Every worker lifecycle transition also pays `persistDaemonWorkerDescriptorUnderGuard` (`daemon-worker-cleanup.ts:770-828`) = 2 more fsyncs on top of the guard.

**`total = registry_mutations × (1 ps + 4 fsync)`, plus `worker_transitions × (1 ps + 6 fsync)`;** at 1 Hz while a shutdown-admission or offline-maintenance lease is held (`:359`, `:440`), a sustained ps + 4 fsyncs per second.

**Fix:** one line — memoize `currentProcessIdentityFields()` at module scope, mirroring `core/session-lease.ts:968-971`.

---

#### 13. MEDIUM-HIGH — `Atomics.wait` freezes the event loop for up to 1000 ms, and contention grows with process count

`authority-mutation-guard.ts:378` (`attempts: 100, retryMs: 10` from `session-lease.ts:982` and `daemon-launch-lease.ts:455`); `cron-jobs.ts:1525` (100 × 10 ms, allocating a fresh `SharedArrayBuffer` per retry); `orphan-process-journal.ts:748` (10 ms slices to the deadline).

**`worst_case_block = attempts × retryMs = 1000 ms` per contended mutation, and collision probability rises with `W + C` — exactly the operator's regime.** With cron (#5) taking one lock per session, the compounded worst case is `sessions × 1000 ms`.

**Fix:** convert these three callers to the async pattern the ownership module already proves works — `attempts: 1` plus an outer `await delay(...)` loop (`daemon-supervisor-ownership.ts:700-709`).

---

#### 14. MEDIUM — Summarizer fires an LLM call per session every 25 s

`daemon-session-summarizer.ts:227` `setInterval(…, SWEEP_INTERVAL_MS = 25_000)` (`:7`) → `for (const state of this.listSessions()) void this.summarize(state)`. Each resulting call also pays an unmemoized `readFileSync` of `~/.prime/config.json` (`packages/ai/src/env-api-keys.ts:208-212`) and writes a session entry via `_persist` (`daemon-session-summarizer.ts:360`).

**`total = S / 25 s = 231 / 25 ≈ 9 inference attempts per second` fleet-wide at idle** — network, tokens, CPU, and a transcript append each.

**Fix:** skip sessions whose activity timestamp predates their last summary. The debounced `notifyActivity` path (`:279`, `SETTLE_DEBOUNCE_MS = 2_000`) already covers real changes, so the sweep can drop to a 5-minute backstop.

---

#### 15. MEDIUM — Agents-view rebuilds every row 4× per second in all 32 TUIs

`agents-view-mode.ts:895` `setInterval(…, WORKING_ICON_INTERVAL_MS = 250)` (`theme/working-icon.ts:4`); whenever any row is running or has a stale age it calls `rebuildRows()` + `requestRender()` (`:899-902`). Each `heartbeats_list` refresh behind it also costs `O(active sessions)` `statSync` on the daemon side (`daemon-session-list.ts:230`).

**`total = C × 4 × rows = 32 × 4 × 231 ≈ 30 000 row-builds/sec` machine-wide**, purely to animate a spinner and tick age labels.

**Fix:** advance `workingIconFrame` without `rebuildRows()`; recompute age labels only when the displayed minute changes (≤1 Hz).

---

### The one-sentence version

**Most of it is one bug repeated.** `observeProcessIdentity` (`core/session-lease.ts:781`) shells out to `/bin/ps` with `execFileSync`, and **only one of its ~17 call sites memoizes the result** (`:968-971`). Items 1, 2, 3, 11, 12 and most of 4 dissolve by caching self-identity — which provably cannot change — and giving foreign-identity probes a TTL. That is worth roughly **48 `/bin/ps` spawns per second at pure idle, plus one more per protocol command**, on a box already carrying 2551 processes. The second theme is **uncached O(sessions) file re-reads** (cron #5, RLM ledger #9, session-list #15) where the codebase already contains the right pattern — `readSessionInfo`'s `(size, mtimeMs)` cache at `core/session-manager.ts:951-966` — just not applied there.


## 5. Ranked fix list

Ranked by how much total machine cost the change removes at 12 workers, 32 clients, 231 sessions, with the smallest fixes first inside each tier. File references are `packages/coding-agent/src/…` in the fork.

### Tier 1: small changes, large effect (do these first)

| # | Change | Where | Removes |
|---|---|---|---|
| 1 | Memoize `observeProcessIdentity` per `(pid, expected start id)` with a short TTL (5 s), and memoize the process's own identity for its lifetime. Prefer `kill(pid, 0)` plus the cached record; spawn `ps` only on a cache miss. | `core/session-lease.ts:781-821` and its ~17 call sites (`daemon-mode.ts:907` fence, `:4274` admission, `daemon-supervisor.ts:1960` per command, `daemon-worker-cleanup.ts` persist, `orphan-process-journal.ts`, guard acquire) | 48 `ps` spawns per second at idle plus 1 to 2 per command, 4 per bash call; the 100 to 160 ms stalls on every worker event loop |
| 2 | Raise the worker supervisor fence poll from 250 ms to 2 to 5 s and rely on socket close for the fast path (the socket already closes when the supervisor dies). | `modes/daemon/daemon-mode.ts:421` (`SUPERVISOR_FENCE_POLL_MS`), `:903-938` | 12 workers × 4 checks per second of pure bookkeeping |
| 3 | Gate the `agent_status` append on a real change, and stop treating a failed summary (`summary: ""`) as "owed" (back off instead). | `modes/daemon/daemon-session-summarizer.ts:308, 328-332, 358` | 9 transcript appends per second fleet-wide at idle, and everything they drag in (#4, #7) |
| 4 | Cache the "traces enabled" flag; never take an exclusive `settings.json` lock for a read. | `core/agent-traces.ts:726` → `core/settings-manager.ts:498, 264-267` | 7.7 lock cycles per second on one shared file across 12 processes, and the 20 ms × 10 busy-spin under contention |
| 5 | Memoize `canonicalizePath` (session files never move) or use `resolve()` for identity. | `modes/agents-view/agents-view-state.ts:190, 204, 163` | about 45 % of each TUI's CPU; 2,200 `lstat`s per roster push per client |
| 6 | Serve `heartbeats_list` from the supervisor's own `heartbeatSnapshot` cache, single-flight the refresh of stale workers, debounce `broadcastHeartbeatsChanged` to about 1 s, and delete the 15 s client poll (the `heartbeats_changed` event already exists). | `modes/daemon/daemon-supervisor.ts:2492-2538, 6681-6684, 7832-7836`; `modes/agents-view/agents-view-mode.ts:102, 893` | 1,536 worker RPCs per minute at idle, 384 per heartbeat change, each costing a supervisor `ps`; the `Could not list heartbeats` timeouts |
| 7 | Reconcile catalogs once per refresh batch instead of once per streamed session. | `modes/agents-view/agents-view-mode.ts:2200-2206` | about 359,000 `lstat`s and 163 repaints per catalog refresh per client |

### Tier 2: journals, fsync, and logging

| # | Change | Where | Removes |
|---|---|---|---|
| 8 | Orphan-process journal: keep an in-memory index, append-only writes, periodic compaction; stop re-reading and re-parsing the whole file on enroll and retire. | `core/orphan-process-journal.ts:1020-1062` | O(spawns²) reads, 6 `fsync` and 4 `ps` per subprocess |
| 9 | Group-commit the durability writes: one `fsync` per tick for the command journal, worker recovery journal, and descriptor persist, instead of 2 to 6 per event. | `modes/daemon/command-recovery-journal.ts:174-184`; `modes/daemon/worker-recovery-journal.ts:99`; `daemon-supervisor.ts:1465-1515` → `daemon-worker-cleanup.ts:831-846` | 40 to 60 `fsync` per second under moderate command load |
| 10 | Stop relaying worker stderr through the supervisor log; buffer log writes (no `existsSync` + `statSync` per line); log fence and admission timings only above 500 ms; add a log-level knob. | `daemon-supervisor.ts:1012-1016, 3607-3612`; `config.ts:600-616` | 300 to 400 supervisor log lines per minute, 16 syscalls per worker log line |
| 11 | Lifecycle logs: heartbeat every 5 min instead of 60 s without `includeResources`, rotate the `processes/` dir by count, prune lazily in the supervisor rather than with a `statSync` sweep of 3,378 files at every process start. | `core/process-lifecycle.ts:28-30, 361-371, 420-433, 647-651` | 1 GB of heartbeat files; 3,378 blocking stats per worker or supervisor start |

### Tier 3: algorithmic scaling inside the worker and supervisor

| # | Change | Where | Removes |
|---|---|---|---|
| 12 | `flushRoster` incrementally per session, debounced; do not rebuild every row with a `statSync`, full message scan and `JSON.stringify` on every tool event. | worker roster flush (`daemon-mode.ts`, see §2 C4) | O(events × sessions × messages) per worker |
| 13 | RLM child token fan-in: scan only the new delta instead of re-running a regex over the whole accumulated answer per token; coalesce the ancestor re-emit and roster flush. | `daemon-mode.ts`, see §2 C6 | O(L²) per streamed child token |
| 14 | Index the roster by worker id and keep an attached-client counter, so the eviction sweep and `list` stop being O(W·N) and O(N·C). | `modes/daemon/agent-roster.ts:195-197`; `daemon-supervisor.ts:1083-1199, 2857-2872, 5953-5968` | about 10,200 iterations per minute at idle; 7,392 per `list` |
| 15 | Cron store: read each session's job file once per tick and cache; drop the per-mutation triple read behind `proper-lockfile` with `Atomics.wait`. | `core/cron-jobs.ts:793` | O(sessions) × 3 JSON reads per mutation |
| 16 | RLM ledger: cache the parsed ledger and memoize `realpathSync` per edge; compact it. | `modes/daemon/rlm-ledger.ts` (2 MB, 6,512 lines re-read per `edges()`) | a 2 MB parse per call |
| 17 | `captureGitContext`: run the three `git` calls async and once per turn, not sync at turn start and turn end. | `utils/git.ts:262` | 6 blocking `spawnSync` per turn per session |
| 18 | Kernels: start a child session's Python kernel lazily and shut idle kernels down with a snapshot; 149 kernels were 8 GB RSS. | `core/kernel/*` | about 55 MB per session of resident memory |

### Tier 4: knobs that do not exist yet

Nothing in `settings.json` or the environment tunes the fence poll, heartbeat interval, client poll, summarizer sweep, or log level; the only lever today is `idleEvictionMinutes`. Add env overrides for each interval so the fleet can be tuned without a rebuild.

### What an operator can do today, before any code change

1. Close TUIs and agents views you are not looking at; workers keep running detached. Each attached client costs a `realpathSync` storm on every roster push and a 15 s heartbeat fan-out.
2. Keep `~/workspace` and `~/.prime` out of Spotlight (runbook §6 item 12) so the guards' `fsync`s and the `ps` spawns are not competing with an indexer.
3. Prune `~/.prime/agent/logs/processes` by hand (files older than a few days) so every new worker does not `stat` 3,378 files at start.
4. Expect idle cost per resident session of roughly one transcript append plus two lock cycles every 25 s until #3 and #4 ship.

## 6. Deployed, 2026-09-02 evening

Rounds one and two are merged to the fork's `main` (`c8bc03079`, plus the path-resume fix `748188587`), built and installed as `~/.prime/installs/main-c8bc030` (bundle `a592690b…`), and the whole fleet was stopped and restored onto it (runbook §9). Live, with 28 roots, 253 daemon sessions and 28 attached TUIs: TUI clients 0.5 % CPU total (was 418 %), workers 0.2 % (was 213 %), supervisor 0 %, no `lstat` or `posix_spawn` leaves in any 2 s sample, no heartbeat fan-out admissions since the restart. Load fell from 796 (two runaway Rust test binaries plus the old fleet) to the 30s.
