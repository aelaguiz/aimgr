# Investigation worklog

## Bootstrap — 2026-09-04 17:12 CDT
User asked: “Can we diagnose this FS events D thing and figure out what's going on? save all findings to disk”.

Prior exploratory observations (from this conversation; not all raw command output was retained): Mac17,6, 128 GiB RAM, 18 logical CPUs, ~21-day uptime. top at 17:07 showed fseventsd ~180–187% CPU and ~30G memory footprint; ps showed ~19.3 GiB RSS. Ghostty independently used 240–260% CPU, later 80–107%, with active stacks in font glyph rendering/locks. Colima’s VM is not the iOS simulator: lsof identified disks under ~/.colima/_lima/colima-play-poker-codex; simctl showed one booted iPhone 17 simulator. Colima profile has 2 vCPU / 2 GiB memory, virtiofs and mountInotify:true. Docker was actively running Cratejoy pytest and ~12 other database/service containers. Do not stop the VM during diagnosis.

Prior FSEvents log query showed repeated client registration and USER DROPPED notifications for PID 28737, matching colima daemon start play-poker-codex --inotify --inotify-runtime docker --inotify-dir /Users/aelaguiz/. A follow-up summary reported 24,097 Resolve user group list activities; fixed-boundary recapture is needed before precise rate claims. Colima daemon log last forwarded events were workspace file changes. Spotlight had only two low-CPU processes, so no measured Spotlight worker storm. mdutil returned unknown indexing state; that alone does not prove indexing or corruption. pmset reported no thermal warning. Host Data volume 95% full, ~209–211 GiB available. vm_stat delta showed zero swapins/swapouts over ten seconds despite ~18.7 GiB swap already allocated. Prime workers and kernels had been shut down at the user's request, supervisor idle.

Privilege limit: unprivileged sample of fseventsd/PerfPowerServices denied; sudo -n reports a password required. No sudo password requested or credential changes performed. User-owned Ghostty sample succeeded. These are observation limits, not root-cause evidence.

Next bet: identify the FSEvents client lifecycle and a safe watcher-only toggle. No services changed by this investigation yet.

## Source inspection — Colima 0.10.1, installed commit ed905203

Matching source saved in evidence/colima-source/. Correction to initial hypothesis: --inotify-dir is the VM mount allowlist; fetchVolumes reads currently running container mounts and filters them against that list, then watches only those sources recursively. Actual effective paths saved in predicted-watch-paths.json. watch.go uses rjeczalik/notify with a one-entry event channel; event delivery blocks on an unbuffered mod channel; events.go forwards each accepted path through synchronous guest stat and chmod. Volume lists are checked every 5 seconds; changed lists replace watchers with a 1-second overlap. These are potential backlog/churn mechanisms, not proof of the exact trigger.

cmd/daemon/daemon.go stop only sends SIGTERM to the PID in the profile daemon.pid and waits. Start with only --inotify runs only the helper, not vmnet or VM lifecycle. Restore command: colima daemon start play-poker-codex --inotify --inotify-runtime docker --inotify-dir /Users/aelaguiz/. A watcher-only A/B/A test is within the requested reversible diagnosis. CPU change decision rule was committed in README before measurement.

## Watcher-only intervention — 17:15:40–17:16:25 CDT

Baseline fseventsd CPU 183.6%; stopped-helper interval 105.34%, a 42.6% reduction. Precommitted >=50% rule was not met; this is an intermediate contribution, not complete causation. Group-resolution activity rate fell from 383.27 to 0.23/s (>99.9% reduction). RSS stayed about 19.5 GiB. Baseline interval and stopped interval had transient test containers changing; VM CPU also fell as tests ended, a confound for whole-machine load. Per-process fseventsd and exact client log evidence remain the targeted metrics.

The helper was stopped with colima daemon stop, then restored in a finally block with its original arguments (new PID 89333). VM PID 28817 survived. Detailed commands and timestamps: evidence/intervention-timeline.jsonl. Container IDs, start times and restart counts are captured before and after each window; compare persistent services before claiming continuity.

New source-based mechanism: notify v0.9.3 watcher_fsevents_cgo.go initializes a package-global since cursor once with FSEventsGetCurrentEventId; it is advanced only on event-ID wrap. Every new stream uses that old cursor. Colima rebuilds watchers as running container mount sets change; on this 21-day-lived helper, new streams can therefore request old history. watcher_fsevents.go discards events until HistoryDone but that does not stop the daemon doing the historical work. This is a concrete implementation mechanism consistent with repeated registrations/lookup activity; exact historical replay duration has not been measured.

Remaining unknown: why fseventsd retains ~1 CPU core and ~30 GiB footprint after this client disconnects. Requested a 5-second administrator-only sample from the user because macOS denies unprivileged process sampling and sudo -n requires a password. Continue read-only investigation while awaiting that sample.

## Restoration result and follow-up decision

A2 restored helper averaged 106.65% fseventsd CPU with 0.07 group-resolution activities/s, so the prior flood did not immediately return. The new helper reset its process-lifetime event cursor; however the active test container also ended during B1, so that mechanism is not isolated by A2 alone. Twelve persistent containers kept identical IDs, start timestamps and restart counts across all six snapshots (evidence/container-continuity.json); two transient test containers naturally entered/exited. The VM kept PID 28817.

Next bet: a new bind-mounted test container is now active after restoration. Capture a follow-up window under renewed Docker work. Rule: if lookup flood remains absent under renewed mounted work, ordinary test activity is insufficient to explain the original flood; process-lifetime watcher state/history becomes more likely. This is an observational cross-check, not a controlled recreation of 21 days of history.

## Follow-up under renewed tests — 17:18:42–17:19:13 CDT

A3 fseventsd CPU: 119.82%; group-resolution activity rate: 2.27/s, 99.41% below A1. VM CPU was 113.4%, close to A1's 116.75%, confirming the VM was busy again. This weakens ordinary ongoing Docker work as the complete explanation for the original lookup flood, and strengthens old helper/stream state as a contributor. It still does not isolate the exact historical replay or memory allocation path.

Final top capture at 17:19:47: fseventsd 100.8% CPU, 30G footprint and 10G compressed. RSS remains ~19.5 GiB. Its PID remains 337, so no Apple daemon restart occurred. Restored helper remains PID 89333; Prime stays current with zero sessions. Administrator sample still absent at this check.

Additional evidence quality notes: Colima's 2,761 SSH connection-reset errors were historical, chiefly July 6–7, not today's active error rate; saved date counts prevent misattribution. Today had only nine captured historical errors, mostly containers disappearing between ps and inspect. FSEvents CoreAnalytics lines saying a metric was dropped are telemetry filtering, not filesystem-event loss; those are counted separately from USER DROPPED. Some short-lived non-Colima clients appeared in registrations, but PID 91970 had exited before identification; do not attribute it to a specific app.
