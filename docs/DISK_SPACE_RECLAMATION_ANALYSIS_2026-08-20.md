# Disk Space Reclamation Analysis — 2026-08-20

## Executive answer

The 4 TB APFS container is effectively full:

- Container size: **4.00 TB**
- Free space: **3.1 GB**
- Data volume: **100% used**
- Visible home-directory allocation: **3.57 TiB**

There is a practical **2.13 TB cleanup route**, plus a **134 GB contingency candidate**, without touching personal case files, active project data, or dirty source changes.

The main cause is not macOS. It is a large temporary development fleet:

1. `~/workspace/psmobile-worktrees`: **1.49 TiB**
2. iOS simulator devices: **419 GiB**
3. Android virtual devices: **101 GiB**
4. Ordinary build and package caches: about **185 GiB**
5. A stopped stale Colima disk: **124 GiB allocated**

The initial scan deleted nothing. The requested stale-worktree cleanup was executed on 2026-08-21 and is recorded below.

## Executed stale-worktree cleanup — 2026-08-21

The canonical checkout at `~/workspace/psmobile` and the Git administrative root at `~/workspace/.psmobile-git-root` were excluded.

Results:

- **217 stale worktrees removed**
- **82 dirty worktrees checkpointed with commits**
- **219 worktree heads confirmed on `origin`**, including preserved exceptions
- **0 removal or push failures**
- Estimated allocation removed: **1.34 TB**
- Actual free-space increase from the run baseline: about **1.20 TB**
- Free space after the final rescan: **1.255 TB / 1.14 TiB**
- Data-volume utilization fell from **99% to 69%**
- `~/workspace/psmobile-worktrees` fell from **1.49 TiB to 357.2 GiB**
- Registered PS Mobile worktrees fell to **107**

Three worktrees were intentionally preserved:

1. `ic-01-tableruntime-authorship-20260817` changed after the cleanup plan started, so it no longer met the untouched condition.
2. `legacy-2136-20260809` contains untracked `apps/flutter/android/key.properties`. Its ordinary source changes were committed and pushed to `archive/stale-worktrees/2026-08-20/legacy-2136-20260809-ad7d6fe1ea`; the key file was not pushed.
3. `overnight-prebuild-20260809` contains the same untracked key file. Its existing HEAD was pushed to `test/overnight-prebuild-20260809`; the key file was not pushed.

Two documentation worktrees initially matched an over-broad secret-name guard because their filenames contained `token`. They were reviewed as ordinary docs, committed, pushed, and removed.

Execution receipts:

- [`evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500-summary.json`](evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500-summary.json)
- [`evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500-plan.json`](evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500-plan.json)
- [`evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500.jsonl`](evidence/disk-space-2026-08-20/stale-worktree-cleanup-20260821T061558-0500.jsonl)

## Original recommended reclaim plan

Sizes are allocated-size estimates. The table avoids double-counting. Decimal TB is used for the final target because the disk is sold as 4 TB.

| Order | Candidate | Estimated reclaim | Risk | Treatment |
|---:|---|---:|---|---|
| 1 | Generated state in inactive psmobile worktrees | **898.4 GiB** | Low | Delete only known ignored build/dependency directories |
| 2 | Remaining checkout data in 198 clean inactive psmobile worktrees | **393.6 GiB** | Medium | Remove each worktree through Git; branches remain |
| 3 | 139 shutdown iOS simulators | **415.8 GiB** | Medium | Delete selected simulator devices |
| 4 | 22 dormant Android AVDs | **92.7 GiB** | Medium | Keep the running AVD; delete old named devices |
| 5 | Conventional caches | **185.0 GiB** | Low | Clear uv, npm, Gradle, Xcode, app caches, and simulator logs |
|  | **Core total** | **1,985.6 GiB / 2.132 TB** |  |  |
| 6 | Stopped stale default Colima profile | **124.4 GiB / 133.6 GB** | Medium | Optional buffer; delete only the stopped `default` profile |
|  | **Total with buffer** | **2.266 TB** |  |  |

APFS clones, sparse disks, and open deleted files can make actual reclaimed space differ from `du`. Clean in batches and read `df -h /System/Volumes/Data` after each batch.

## 1. The main problem: psmobile worktree accumulation

`~/workspace/psmobile-worktrees` occupied **1.49 TiB** during the scan. The fleet had 300 registered worktrees in the status snapshot and continued to create new worktrees while the scan ran.

### Worktree state

| State | Count | Allocated size |
|---|---:|---:|
| Clean, no observed cwd process | **198** | **1,083.3 GiB** |
| Dirty, no observed cwd process | **91** | **391.8 GiB** |
| Clean with a cwd process | **9** | **44.7 GiB** |
| Dirty with a cwd process | **2** | **6.3 GiB** |
| **Snapshot total** | **300** | **1,526.1 GiB** |

A new `lockless-4195-20260820` worktree appeared after that snapshot. This means the fleet was not quiescent. Do not use the saved list as a permanent allowlist. Stop the worktree-producing jobs before an actual cleanup.

### What is duplicated inside the fleet

| Path inside worktrees | Aggregate size |
|---|---:|
| `apps/flutter/build` | **442.4 GiB** |
| `apps/flutter/.dart_tool` | **292.5 GiB** |
| Root `.venv` directories | **128.2 GiB** |
| `docs/PACKS` replicated checkouts | **167.2 GiB** |
| `skills/theme_builder` replicated checkouts | **139.5 GiB** |
| Root `node_modules` | **38.0 GiB** |
| `.code-review-graph` | **38.7 GiB** |
| `apps/analytics/node_modules` | **20.0 GiB** |
| Root `logs` | **4.3 GiB** |

The first cleanup pass can preserve every branch and dirty patch. It removes only these verified ignored generated paths:

- `apps/flutter/build`
- `apps/flutter/.dart_tool`
- `.venv`
- `node_modules`
- `apps/analytics/node_modules`
- `apps/analytics/build`
- `data/transform/target`

Across worktrees without an observed cwd process, those paths total **898.4 GiB**. Of that amount, **208.7 GiB** is inside the 91 dirty worktrees. Those dirty worktrees should remain in place after their generated state is cleared.

After that cache-only pass, removing the 198 clean inactive worktrees would release an additional **393.6 GiB** of replicated checkout data. Use `git worktree remove` per exact path. Do not use a broad `rm -rf`, and do not use `--force` as the default.

### Worktrees that were visibly active

The scan found cwd processes in these 11 worktrees, so they are excluded from the reclaim estimate:

- `coach-fixture-runner-20260820`
- `completed-path-coach-occlusion-20260814`
- `flutter-affected-test-selection-plan-20260820`
- `pvai-3p-e2e-client2-20260818`
- `pvai-3p-j2-picker-20260817`
- `pvai-3p-j3-launch-20260817`
- `pvai-3p-j4-history-20260817`
- `pvai-coach-ledger-followup-20260818`
- `pvai-coach-lens-20260818`
- `pvai-matrix-grader-20260817`
- `retention-anatomy-m2-20260820`

## 2. Simulator and emulator sprawl

### iOS CoreSimulator: 419 GiB

`~/Library/Developer/CoreSimulator/Devices` occupied **419.0 GiB**.

- Total simulator devices: **140**
- Shutdown devices: **139**, totaling **415.8 GiB**
- Booted devices: **1**, totaling **3.1 GiB**
- Most of the storage belongs to 118 shutdown iOS 26.5 devices: **379.3 GiB**

The booted device during the scan was:

- `CLAUDE 3p-e2e (pvai overnight) - iPhone 17`
- UUID `8FB120B9-48CF-47B4-90D3-E125C84E8376`

Deleting a simulator removes its installed apps, local databases, screenshots, authentication state, and other device-local data. The runtime itself remains and Xcode can create a fresh device later.

The five largest shutdown devices alone occupied about **44.6 GiB**:

| Device | Size |
|---|---:|
| `PRIME pvai client corpus 20260816 - iPhone 17` | **15.5 GiB** |
| `feat_more_effects2 - iPhone 17` | **8.9 GiB** |
| `SOL hub-liveness (pvai resume ux) - iPhone 17 Pro` | **7.0 GiB** |
| `PRIME paygate visual guide - iPhone 17` | **6.7 GiB** |
| `feat_puzzle-monetization-restoration...` | **6.4 GiB** |

### Android AVDs: 101 GiB

`~/.android/avd` occupied **101.2 GiB** across **23 AVDs**.

One AVD was running:

- `CLAUDE_pwvis2138_Pixel9Pro`
- Allocated size: about **8.5 GiB**

The other 22 AVDs occupied **92.7 GiB**. Several are one-off proof devices named for old issues and releases. The largest single AVD was `PRIME_onboarding_split_test_PR3449_API_36` at about **17.4 GiB**.

Keep any device whose local app state is still needed. Delete the rest through `avdmanager delete avd -n <name>` rather than deleting only the `.avd` directory and leaving stale `.ini` records.

## 3. Conventional caches: 185 GiB

These are normal regenerable caches. Close the owning applications and build processes before clearing them.

| Path or cache | Size | Notes |
|---|---:|---|
| `~/.cache/uv` | **59.3 GiB** | Python package cache; `uv cache clean` regenerates on demand |
| `~/Library/Caches` | **47.6 GiB** | Led by BrowserOS 12.2 GiB, Go build 10.3 GiB, Chrome 9.4 GiB |
| `~/Library/Developer/Xcode/DerivedData` | **26.8 GiB** | Xcode intermediates and module cache |
| `~/.npm` cache plus `_npx` | **18.5 GiB** | 13.6 GiB content cache and 4.8 GiB npx installs |
| `~/.gradle/caches` | **17.2 GiB** | Mostly Gradle 8.14 transforms and downloaded modules |
| `~/Library/Logs/CoreSimulator` | **15.7 GiB** | Per-simulator logs |
| **Total** | **185.0 GiB** | About **198.7 GB decimal** |

Other smaller cache candidates were found but are not needed for the core 2 TB route:

- `~/Library/Developer/Xcode/iOS DeviceSupport`: **31.8 GiB**
- CoreDevice `AppInstallationBinaryDeltas`: **30.5 GiB**
- `~/.codex`: **45.7 GiB** total
- `~/.prime/agent/session-artifacts` older than seven days: **30.5 GiB**
- `~/workspace/rustai-worktrees/*/target`: **72.6 GiB**
- `~/workspace/puzzledb-worktrees`: **43.6 GiB**

The Codex cleanup tool could not run because Codex and the ChatGPT Codex app-server were live. The July Codex session subtree alone is **33.2 GiB**, and `~/.codex/logs_2.sqlite` is about **3.8 GiB**. When Codex is fully stopped, use the installed `codex-cleanup` dry run instead of deleting Codex state by hand.

## 4. Colima: a strong 124 GiB contingency candidate

`~/.colima` occupied **160.8 GiB** across two profiles.

### Stopped `default` profile

- Status: **Stopped**
- Configured disk size: **10 GiB**
- Existing sparse `datadisk` logical size: **500 GiB**
- Allocated host blocks: **124.4 GiB**
- Last disk modification observed: **2026-07-31**

The 500 GiB disk does not match the current 10 GiB profile configuration. This looks like stale container data from an older profile configuration. `colima delete default --data` is the correct deletion path if nothing in that old profile is needed.

### Running `play-poker-codex` profile

- Status: **Running**
- Allocated host blocks: about **33.5 GiB**
- Docker build cache: **10.1 GB**
- Several containers and named volumes were live

Do not include the running profile in an automatic cleanup. The core cleanup route already reaches 2.13 TB without it.

## 5. Other large paths that should not be swept automatically

| Path | Size | Decision |
|---|---:|---|
| `~/workspace/psagentspace` | **193.6 GiB** | Exclude: heavily active; contains research and evidence artifacts |
| `~/workspace/logan` | **133.4 GiB** | Exclude: personal legal/case records, not cache |
| `~/workspace/rustai-worktrees` | **109.3 GiB** | Optional separate pass; 72.6 GiB is `target`, but use a fresh exact-scope check |
| `~/.prime/agent` | **99.4 GiB** | Exclude from broad cleanup: active session state and recovery data |
| `~/workspace/puzzledb-worktrees` | **43.6 GiB** | Optional separate pass; mostly replicated virtualenvs and published puzzle data |
| `~/workspace/puzzledb` | **34.1 GiB** | Exclude: active processes and source artifacts |
| `~/workspace/snap` | **33.2 GiB** | Optional project-specific pass; 11.5 GiB is Rust `target` |

`psagentspace` contains two roughly 49 GiB user-value telemetry copies and 64 GiB of `_artifacts`, but many processes had their cwd there. Those files may be expensive evidence rather than disposable cache. They are not needed for the 2 TB target.

Four Prime/Herdr recovery snapshots total about **33.5 GiB**. They are explicitly pinned by existing restoration documents, so this report does not recommend deleting them.

`logan` is large because of discovery responses, exhibit packets, and archived case material. It is not cleanup material.

## 6. Cleanup command outline — not executed

### A. Clear generated state inside a selected psmobile worktree

Run the dry form first for each selected inactive worktree. `-X` limits Git to ignored files.

```bash
wt=/exact/psmobile-worktree/path
paths=(
  apps/flutter/build
  apps/flutter/.dart_tool
  .venv
  node_modules
  apps/analytics/node_modules
  apps/analytics/build
  data/transform/target
)

git -C "$wt" clean -ndX -- "${paths[@]}"
# After reviewing that output:
git -C "$wt" clean -fdX -- "${paths[@]}"
```

This preserves tracked files and non-ignored untracked patches. Do not add `.qa-derived` or `.code-review-graph` to the first pass.

### B. Remove an exact clean worktree

```bash
wt=/exact/clean/inactive/worktree
git -C "$wt" status --porcelain --untracked-files=normal
git -C /Users/aelaguiz/workspace/psmobile worktree remove "$wt"
git -C /Users/aelaguiz/workspace/psmobile worktree prune
```

The status command must return no lines. Git preserves the branch and commit objects. Avoid `--force`; it can erase ignored local configuration and evidence.

### C. Delete selected simulator and emulator devices

```bash
# iOS: inspect, then delete exact UUIDs one at a time
xcrun simctl list devices
xcrun simctl delete <UUID>

# Android: use exact AVD names
$HOME/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager delete avd -n <AVD_NAME>
```

Delete only shutdown iOS devices and dormant Android AVDs that no longer need local state.

### D. Clear conventional caches after closing their owners

```bash
uv cache clean
npm cache clean --force
rm -rf "$HOME/.npm/_npx"
rm -rf "$HOME/.gradle/caches"
rm -rf "$HOME/Library/Developer/Xcode/DerivedData"/*
rm -rf "$HOME/Library/Logs/CoreSimulator"/*
find "$HOME/Library/Caches" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
```

### E. Optional Colima buffer

```bash
colima list
colima delete default --data
```

This deletes all container runtime data in the stopped `default` profile. It does not target the running `play-poker-codex` profile.

### F. Measure after each batch

```bash
df -h /System/Volumes/Data
lsof +L1 2>/dev/null | sort -k7 -n | tail
```

The second command finds processes holding deleted files open. Space held that way returns only after the owning process exits.

## 7. Why the disk filled again

The repeating mechanism is clear:

1. Agent and review work creates large, isolated psmobile worktrees.
2. Each checkout replicates hundreds of MiB of docs, media, theme assets, and other source files.
3. Flutter, Python, Node, analytics, and review tools then add per-worktree generated state.
4. Finished worktrees are retained instead of removed.
5. One-off simulator and emulator devices are also retained after their task ends.
6. Package caches have no effective size cap.

The current psmobile fleet averages about **5.1 GiB per registered worktree**, but several old worktrees exceed 20 GiB and one clean worktree reached 75 GiB.

### Prevention changes

1. **Clean on worker completion.** Remove known ignored build directories as soon as an agent or review lane finishes.
2. **Retire clean worktrees automatically.** Keep the branch, remove the checkout, and preserve dirty worktrees for review.
3. **Cap device pools.** Reuse a small named simulator/AVD pool instead of creating a new device per issue.
4. **Set storage guardrails.** Stop creating worktrees below 100 GB free and alert below 500 GB free.
5. **Run weekly cache hygiene.** Prune uv, npm, Gradle, Xcode DerivedData, simulator logs, and Codex state through their supported cleanup paths.

A worktree TTL alone is not enough. Some old dirty worktrees contain real uncommitted work, while some same-day worktrees are already disposable. Lifecycle state must be the primary signal; age is only a fallback.

## 8. Scope and limits

- Scan time: **2026-08-20**, approximately 21:20–21:40 local time.
- The scan was read-only except for writing this report and its CSV inventories.
- `du` used allocated KiB on one filesystem. APFS shared extents and sparse images can change actual reclaim.
- macOS denied reads to several privacy-protected Library subtrees. The visible home scan still accounted for about **95%** of the Data-volume `du` total.
- No local Time Machine snapshots were present.
- The user Trash was empty or inaccessible with zero visible allocation.
- The accessible `/private/var` scan showed about **18.4 GiB** and is not the primary problem.
- The system was active during the scan. Counts are a point-in-time inventory, not a permanent deletion list.

## Evidence files

- [`evidence/disk-space-2026-08-20/top-level-sizes.csv`](evidence/disk-space-2026-08-20/top-level-sizes.csv)
- [`evidence/disk-space-2026-08-20/reclaim-candidates.csv`](evidence/disk-space-2026-08-20/reclaim-candidates.csv)
- [`evidence/disk-space-2026-08-20/psmobile-worktrees.csv`](evidence/disk-space-2026-08-20/psmobile-worktrees.csv)
- [`evidence/disk-space-2026-08-20/active-psmobile-worktree-processes.csv`](evidence/disk-space-2026-08-20/active-psmobile-worktree-processes.csv)
- [`evidence/disk-space-2026-08-20/ios-simulators.csv`](evidence/disk-space-2026-08-20/ios-simulators.csv)

## Bottom line

The executed stale-worktree pass increased free space by about **1.20 TB**, leaving **1.255 TB free**. The canonical checkout was untouched. The remaining large opportunities are dormant virtual devices, ordinary caches, and the stopped Colima profile; no additional PS Mobile worktree deletion is required for immediate disk safety.
