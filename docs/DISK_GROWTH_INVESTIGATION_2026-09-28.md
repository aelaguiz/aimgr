# Disk growth investigation, Amir-M5, 2026-09-28

Status: findings only. Nothing was deleted for this doc beyond the emergency cleanup listed in section 1. Raw data: `~/disk-cleanup-20260928/growth/`.

## Bottom line

The Data volume (3.6 TB) went from 159.6 GB free at 03:12 to 163 MB free at about 14:09. That is **159.4 GB consumed in 10.9 hours, about 14.6 GB per hour**. No single runaway process did it. Agents create per-task storage (checkouts, emulators, simulators, Docker volumes, scratchpads, build output), and nothing deletes it when the task ends. The daily 03:00 cleanup recovers about 50 GB; agents refill that in about 4 hours.

By modification time, about 280 GB of files were written or rewritten in the same window (150 GB of it under `~/workspace`). That is more than the 159 GB net loss because rewritten files (Git repacks, rebuilt Flutter output) replace old copies and agents deleted some files, so treat the table as a ranking, not a ledger.

## 1. What the emergency cleanup did (14:10 to 14:35)

| Action | Result |
| --- | --- |
| Deleted Xcode DerivedData | 24.6 GB (it had regrown from 0.2 GB since 03:12) |
| Deleted 16 shutdown simulators with no live references, last booted more than 3 hours earlier | 55.0 GB reported device data. List: `~/disk-cleanup-20260928/quick/sims-deleted.json` |
| Result | 163 MB free to 53 GB free (15:02, still rising as APFS reclaims) |

## 2. Where the growth went (03:13 to 14:10)

Measured by files written or changed since the 03:13 report, plus before/after sizes for caches. Rewritten databases and sparse VM images inflate mtime-based numbers, so those are listed separately in section 4.

| # | Source | Growth in about 11 h | Total now | What creates it |
| --- | --- | ---: | ---: | --- |
| 1 | Per-task PS Mobile checkouts: 96 top-level `~/workspace/psmobile-<task>` folders and `~/workspace/psmobile-worktrees` | +86.7 GB (+49.0 GB in the top-level folders, +37.7 GB in `psmobile-worktrees`) | 1,054 GB (506 GB in top-level folders, 504 GB in `psmobile-worktrees`) | One full checkout per task, each 2 to 29 GB with Flutter build output, `.venv`, `docs/PACKS`, code-review graph. New today: `l10n-m8` 9.2 GB, `l10n-m9` 9.9 GB, `wt-6509-before/after` 12.4 GB, `home-m5-t3` 4 GB |
| 2 | `/private/tmp/claude-501` session scratchpads | +32.6 GB | 100 GB, 149 dirs, 1.27 M files | Agents write screenshots, video, APKs, venvs and repo clones into scratchpads; 21 GB of the growth is `psbrain` sessions |
| 3 | Xcode DerivedData | +24.4 GB | 24.6 GB before deletion | Every iOS build by every task checkout writes to one shared folder |
| 4 | Android emulators (`~/.android/avd`) | +18.5 GB (3 new AVDs) | 243.9 GB in 53 AVDs | One AVD per task; `CLAUDE_l10n_m8_320dp_API36` alone is 11.7 GB with a 4.2 GB RAM snapshot |
| 5 | Go build cache | +15.3 GB | 48.8 GB (33.5 GB at 03:00) | Shared cache with no size cap |
| 6 | Git object stores | +14.6 GB `.psmobile-git-root`, +7.8 GB `psagentspace/.git` | 13.6 GB and 10.9 GB | Repacks rewrite whole packs (10.6 GB pack written 14:19); a 1.4 GB orphan `tmp_pack_RRG5wL` was left when the disk filled |
| 7 | iOS simulators | +14.5 GB (5 new devices) | 58 GB at 03:00 | One simulator per task, never deleted at task end |
| 8 | `lessons-studio-worktrees` and `website-worktrees` | +13.6 GB and +13.4 GB | 64.6 GB and 17.4 GB | `lessons-studio`: `l10n-m9` (5.3 GB) and three `intuitions-fix-*` (6.9 GB). `website`: each checkout carries a 0.5 GB `node_modules` |
| 9 | Docker anonymous volumes | +10.7 GB (96 volumes, all created before 04:15) | 134 GB in 1,374 volumes | See section 3 |
| 10 | `~/.aimgr/claude-homes` transcripts | +9.5 GB | 48.9 GB in `.aimgr` | Session JSONL; one transcript is 0.88 GB |
| 11 | `CoreSimulator.log` | +3.7 GB | 3.7 GB plus a 3.5 GB `.prev.log` | Unbounded log |

## 3. Docker leak (largest single reclaimable pile)

- Colima `default` VM: guest data disk 173 GB used. Docker reports 1,393 local volumes, 143 GB, **133.7 GB (93%) reclaimable**. Only 33 volumes are in use.
- 1,374 of the volumes are anonymous (64-hex names, no compose labels). 808 of them hold Postgres data. Sampled volumes contain the `cratejoy_test` database.
- Creation pace: 147 volumes on 09-23, 200 on 09-24, 683 on 09-27 (30 to 100 per hour from 09:00 to 23:00), 96 on 09-28. The newest volume was created 04:15 on 09-28, so Docker is **not** the source of today's growth after that time.
- One confirmed source: `cjdev/src/run_m2_instance_map_gate.py:55` starts `postgres:14` with `docker run -d` and no `--rm`. Cleanup at line 40 is `docker rm -f <name>` without `-v`, which leaves the anonymous data volume behind. Each run leaks one volume.
- The 683-volume burst on 09-27 is more than that one script explains. Docker keeps no container-create history (`docker events --since 72h` returned nothing), so the other callers are not identified.
- The host image does not shrink on its own. `_lima/_disks/colima/datadisk` uses 192.8 GB on the Mac while the guest reports 173 GB used. Deleting volumes only frees Mac space after `fstrim` runs in the VM.
- Also in Docker: 94 containers (76 exited), 12.1 GB reclaimable images, one crash-looping container (`pspuzzle-pgvector`, "Restarting (1)").
- Other Colima profiles hold 25.4 GB (`play-poker-codex`), 8.4 GB (`cln-a`), 5.5 GB and 5.3 GB.

## 4. Large items that are not new growth

| Item | Size | Note |
| --- | ---: | --- |
| `~/.android/avd`, 44 AVDs untouched for more than 7 days | 199.7 GB | Task emulators, by modification time. Only one emulator (`CLAUDE_6509_paid_no_txid`) is running |
| `~/workspace/logan/case` | 127.4 GB | Static, no writes since 03:13 |
| `~/workspace/puzzledb-worktrees`, `rustai-worktrees`, `rustai` | 170.8 GB, 92.3 GB, 70.5 GB | No writes since 03:13; not part of today's growth |
| `~/workspace/psagentspace` | 440 GB | `_artifacts` 125 GB, `roadmaps` 101 GB, `research` 69 GB, `tools` 50 GB |
| `~/.codex` | 126.7 GB | `thread_history_1.sqlite` 21.7 GB (rewritten today), `logs_2.sqlite` 4.1 GB. Growth rate not measurable from mtime |
| `~/.cache` (uv 78 GB) | 116 GB | Active environments |
| Wispr Flow | 3.7 GB database plus a 3.7 GB backup written 17:00 UTC | Backup doubles the database daily |
| Photos library | 39 GB | Photos and media-analysis databases are 5.3 GB and 1.2 GB |

## 5. Why it keeps happening

1. Nothing deletes per-task storage at task end. Checkouts, AVDs, simulators, scratchpads and Docker volumes are all created by agents and none has an owner that cleans up.
2. The cleanup rules protect exactly the folders that grow fastest. Top-level `~/workspace/psmobile-*` checkouts are "protected canonical checkouts", so the daily job skips 506 GB of task checkouts. Inside `psmobile-worktrees` the job is allowed to act, but the 03:00 run removed 3 of 434 audited candidates: 243 had submodules, 171 had uncommitted work.
3. Shared caches have no size cap (DerivedData, Go build cache, uv, Gradle).
4. There is no free-space floor. Agents kept working at 163 MB free, and a Git repack failed and left the orphan `tmp_pack`.
5. The daily cleanup runs once at 03:00. Growth is 14.6 GB per hour, so it cannot keep up.

## 6. Recommended actions, ranked by space per minute

| # | Action | Reclaims | Needs approval? |
| --- | --- | ---: | --- |
| 1 | `docker volume prune -f` on the `default` Colima context (removes unused anonymous volumes only, keeps the 33 in use and named volumes), then `colima --profile default ssh -- sudo fstrim -av` and check host free space | about 130 GB | Yes: deletes unused test databases |
| 2 | Delete the 44 Android emulators untouched for more than 7 days with `avdmanager delete avd -n <name>`, after a live-reference check | about 200 GB | Covered by the daily simulator authorization, but confirm since this is a one-time 200 GB delete |
| 3 | Delete stale scratchpads under `/private/tmp/claude-501` older than 3 days that no live session references | about 40 GB (41.6 GB is older than 72 h) | Yes: some sessions may still be live |
| 4 | Fix `run_m2_instance_map_gate.py` to use `docker rm -fv` and `--rm` | stops one leak | No |
| 5 | Add a task-end reaper to `aim` (delete the task's simulator, AVD, checkout build output, Docker volumes) and a free-space floor that pauses new sessions below 100 GB | stops the 14.6 GB per hour growth | Needs a design decision |
| 6 | Review the 96 top-level `~/workspace/psmobile-*` checkouts for retirement (506 GB); the cleanup rules currently protect them | up to several hundred GB | Yes: policy decision, some may hold uncommitted work (not checked) |

The full workspace scan finished (250 folders, 2.43 TB, 149.5 GB written since 03:13). It moved PS Mobile checkouts up to the top of the ranking; `puzzledb`, `rustai` and `website` added little.

## 7. How this was measured

- Free space: `df` on `/System/Volumes/Data` (03:12 report vs 14:09 and 15:02).
- Files changed since 03:13: Python `os.walk` over each candidate owner, summing allocated blocks for files with mtime or ctime after `~/disk-cleanup-20260928/report.md`. Script: `growth/scan_new.py`, output `growth/scan_new.out` and `growth/scan_new.json`.
- Docker: `docker system df`, volume metadata (`vol-meta.txt`), per-volume `du` (`vol-size.txt`), container list (`containers.txt`), database names read from `global/1262` in sampled volumes.
- AVDs: per-directory allocated size and creation/modification times (`avds.json`).
- Limits: mtime counts rewritten files as new; sparse images (Colima) report full allocation; the 03:00 baselines for Go, Gradle and simulators come from `~/disk-cleanup-20260928/report.md`.

## 8. Result of the PS Mobile cleanup (same day, after the doc above)

The rewritten `disk-cleanup` skill was run on the PS Mobile checkouts. 223 old task checkouts (784.7 GB by `du`) were deleted, and free space went from 39 GiB to 713 GiB. Registered PS Mobile worktrees dropped from 274 to 55. 168 salvage branches (`salvage/<name>-20260928`) were pushed to `funcountry/psmobile` and verified. Kept: 2 canonical checkouts, 12 in live use, 38 edited within 48 hours, 1 locked by another host. One gap: nested repositories ignored by the parent (such as `backend/.native`) were not scanned before deletion. Details: `~/disk-cleanup-20260928/psmobile/report.md`.

Still open from section 6: Docker volume prune plus `fstrim` (about 130 GB), 44 stale Android emulators (about 200 GB), stale `/private/tmp/claude-501` scratchpads (about 40 GB), and the task-end reaper and free-space floor for `aim`.
