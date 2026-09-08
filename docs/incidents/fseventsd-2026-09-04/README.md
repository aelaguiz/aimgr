# fseventsd lag investigation — 2026-09-04

Raw captures under `evidence/` are retained locally and excluded from this public
repository because they contain machine inventories and process command lines.
The report, worklog, capture scripts, and artifact manifest are versioned here.

## Current finding

Colima's long-running file-notification helper was contributing approximately **0.78 CPU core** and nearly all of the observed FSEvents user/group-resolution activity. Restarting only that helper removed the lookup flood while leaving the Docker VM and persistent containers running. **This is a partial mitigation, not a complete diagnosis:** `fseventsd` still consumes roughly one CPU core and retains a ~30 GiB memory footprint (~19.5 GiB resident). Its remaining internal work requires an administrator-only stack sample. A later `top` capture confirmed 30G footprint including 10G compressed memory; this is not merely a large virtual address reservation.

The earlier claim that Colima was necessarily watching the whole home directory was too broad. Installed source shows that `/Users/aelaguiz/` is an allowlist: actual watched paths come from running containers' host mounts. During this investigation those were Cratejoy worktrees and three mounted PostgreSQL configuration/seed files. The correction matters: limiting the VM's home mount is not yet a demonstrated fix for this machine.

## North Star and scope

Identify the cause of sustained `fseventsd` resource use, distinguish measured effects from hypotheses, and preserve reproducible findings. Preserve running terminals, workers, Docker services and iOS Simulator. No reboot, system-daemon restart, deletion, credential change, or persistent configuration edit. One bounded helper-only stop/restore experiment was performed as part of the requested diagnosis.

## Results

Each CPU value is an interval average computed from cumulative process CPU time, with samples roughly every five seconds. 100% is one CPU core, not the whole 18-core machine. Log capture uses the corresponding explicit wall-clock window with whole-second boundaries; the activity rates therefore have approximately one-second boundary uncertainty. Activity records are not equivalent to independent file changes.

| Phase | fseventsd CPU | Resident memory at end | Group-resolution activities/s |
|---|---:|---:|---:|
| A1: original helper running, ~30 s | 183.60% | 19,950.81 MiB | 383.27 |
| B1: helper stopped, ~30 s | 105.34% | 19,958.33 MiB | 0.23 |
| A2: helper restored, ~30 s | 106.65% | 19,969.08 MiB | 0.07 |
| A3: restored, new tests active, ~30 s | 119.82% | 20,003.22 MiB | 2.27 |

A3 had renewed VM CPU activity (113.4%, versus 116.75% in A1) while lookup activity stayed **99.4% below baseline**. This supports an improvement beyond simply waiting for Docker to become idle, although it is not an exact workload replay.

The stop interval reduced CPU by **42.6%**, below the precommitted 50% rule for a majority contribution. It eliminated **more than 99.9%** of the lookup activity. The three phases establish a substantial contribution from this helper, but do not attribute the residual core or retained memory to it. Test containers naturally started/finished during capture; their changing workloads confound total host/VM CPU comparisons. Twelve persistent services had unchanged IDs, start times and restart counts across all six before/after snapshots. VM PID **28817** remained running throughout. The restored helper PID is **89333**; `mountInotify` remains enabled.

Machine context: Mac17,6; 128 GiB RAM; 18 logical CPUs; macOS 26.5.2; ~21-day uptime. Host memory pressure reported normal (level 1). ~18.7 GiB swap was already allocated, but the initial 10-second interval had zero swap-in/out activity. The Data volume was 95% full with ~209 GiB available: worth recording, but not evidence that lack of disk capacity caused this symptom. No thermal warning was reported. Spotlight had only two low-CPU processes; `mdutil` returning `unknown indexing state` does not prove an indexing rebuild. Prime's remaining supervisor measured 0% CPU and had zero workers.

## Evidence and likely mechanism

1. The original helper, PID **28737**, was the named target of **2,670 USER DROPPED notifications** in the saved 20-minute non-lookup capture, plus repeated stream registrations. Apple documents USER DROPPED as an event-buffering failure that requires a watched-tree rescan; it does not by itself identify the component responsible for the failure. [Apple reference](https://developer.apple.com/documentation/coreservices/kfseventstreameventflaguserdropped).
2. Installed Colima is **0.10.1**, commit `ed905203afdbc6fd4eae6cc301918099ff31e86e`. Binary build metadata confirms `github.com/rjeczalik/notify v0.9.3` and CGO enabled. Its inotify helper checks running container mounts every five seconds and rebuilds watchers when that list changes. [Colima source](https://github.com/abiosoft/colima/blob/ed905203afdbc6fd4eae6cc301918099ff31e86e/daemon/process/inotify/events.go), [mount selection](https://github.com/abiosoft/colima/blob/ed905203afdbc6fd4eae6cc301918099ff31e86e/daemon/process/inotify/volumes.go).
3. The dependency initializes a package-global `since` event ID once, at process startup. Each new FSEvents stream uses that same ID; the code advances it only when event IDs wrap. The old helper had been alive for 21 days. **Inference:** newly watched container worktrees can trigger historical-event processing from that old cursor rather than starting from the current event ID. The library discards callbacks until `HistoryDone`, so old-history work can consume daemon resources without producing useful forwarded events. [Cursor and stream creation](https://github.com/rjeczalik/notify/blob/v0.9.3/watcher_fsevents_cgo.go), [history filtering](https://github.com/rjeczalik/notify/blob/v0.9.3/watcher_fsevents.go).
4. Source also shows potential backpressure: a one-entry notification channel feeds an unbuffered modification channel, while the handler synchronously runs guest `stat` and `chmod` per accepted event. This may amplify bursts. It was not independently isolated. Likewise, incomplete dropped-event handling exists in the dependency but does not prove why Apple's daemon retains 30 GiB. Do not label this a proven memory leak from source alone.
5. A similar upstream report exists: [Colima issue 1569](https://github.com/abiosoft/colima/issues/1569). It is corroboration only. Its pasted analysis confuses virtual address space and memory footprint; this report does not rely on that explanation.

## Ranked hypotheses after the experiment

| Rank | Hypothesis | Evidence and remaining test |
|---|---|---|
| 1 | Old process-lifetime event cursor plus container-mount churn drives the Colima-related lookup flood | Concrete source mechanism, original client identified, flood disappears after helper restart. Exact replay work not directly traced; fresh helper and changing mounted workloads are confounded. |
| 2 | Independent `fseventsd` internal work, another client, or an accumulated backlog drives the remaining core | Sustained ~105–107% CPU with original helper absent and after restoration. Need privileged stacks to distinguish journal processing, allocation/cleanup, locks, or another delivery path. |
| 3 | Historical allocation/leak explains retained ~30 GiB footprint | Footprint remains after client shutdown; current evidence cannot separate live allocations, retained allocator memory, backlog, or a leak. Stack sample first; targeted memory summary only if needed. |
| 4 | Ordinary current build/test file churn alone explains the original flood | Weakened by the helper-only intervention; renewed VM work in A3 had 99.4% less lookup activity than A1, further weakening this explanation. |

## What changed and what did not

At 17:15:40 CDT, ran `colima daemon stop play-poker-codex` after verifying its PID and that it ran only inotify, not networking. At 17:16:13, restored its original arguments: `colima daemon start play-poker-codex --inotify --inotify-runtime docker --inotify-dir /Users/aelaguiz/`. Source and live continuity checks show this is a helper restart, not a VM restart. No persistent settings changed. No containers, database services, iOS Simulator, user terminals, or Apple system services were stopped by this investigation.

## Investigation status

Available unprivileged investigation and the helper-only intervention are complete. The remaining root cause is **awaiting the requested privileged sample**. No claim is made that all machine lag is solved. Recorded separately: Ghostty renderer load and PerfPowerServices remain material consumers but are outside this FSEvents investigation.

## Next diagnostic

Unprivileged `sample` is denied for the root-owned daemon; `sudo -n` requires the user's password. A request is pending for this read-only capture, with the password entered only in the user's terminal:

```sh
sudo /usr/bin/sample 337 5 10 -file /Users/aelaguiz/workspace/aimgr/docs/incidents/fseventsd-2026-09-04/evidence/fseventsd-root.sample.txt
```

Verify PID 337 is still `fseventsd` before reusing this later. Read the active stacks before deciding whether a targeted service restart or a code/configuration change is appropriate. Restarting `fseventsd` before sampling would erase useful evidence; no such restart has been performed.

Potential longer-term fix to investigate: advance the notify stream-start cursor appropriately when creating replacement watches rather than repeatedly requesting history from process initialization. Keep historical catch-up semantics and dropped-event behavior explicit. Simply disabling mount-inotify is an operational workaround with a real tradeoff: guest development tools relying on forwarded host file notifications may stop auto-reloading. Neither change was applied.

## Saved artifacts

- [WORKLOG.md](WORKLOG.md): decisions, corrections, test rules, limitations and chronology.
- [Phase comparison CSV](evidence/phase-comparison.csv), plus each A1/B1/A2/A3 phase directory: raw samples, exact command/log boundaries, full FSEvents logs, summaries and Docker continuity snapshots.
- [Intervention timeline](evidence/intervention-timeline.jsonl) and [container continuity](evidence/container-continuity.json): exact mutations and service-preservation proof.
- [External sources](evidence/sources.md), matching Colima/notify source snapshots and [compiled metadata](evidence/colima-compiled-metadata.txt).
- [Evidence directory](evidence/): original exploratory captures, watcher/Ghostty stack samples, process inventory, memory/disk/thermal observations, historical helper errors and FSEvents event timelines.

The scripts under `scripts/` preserve the capture and intervention procedure. `capture_window.py` is read-only apart from saving artifacts. **Do not rerun `watcher_ab_test.py` blindly:** it intentionally pins the original helper PID and the original one-time output directories to refuse a stale or duplicate intervention.
