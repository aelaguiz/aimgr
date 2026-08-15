# Prime Agent Herdr Upgrade and End-to-End Restoration Plan — 2026-08-11

> **PINNED LOCAL PRIME WORKTREE:** `/Users/aelaguiz/workspace/prime-agent-session-handoff-20260810`
>
> **PINNED LOCAL AIM WORKTREE:** `/Users/aelaguiz/workspace/aimgr-prime-session-handoff-20260810`
>
> **PINNED LOCAL RECOVERY SNAPSHOT:** `/Users/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-upgrade-20260811T192353-0500`
>
> **PINNED HOME RECOVERY SNAPSHOT:** `/home/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-upgrade-20260811T192353-0500`
>
> **MACHINE-READABLE MANIFEST:** `docs/PRIME_AGENT_HERDR_UPGRADE_RESTORATION_MANIFEST_2026-08-11.json`
>
> **STATUS:** inventory and backups complete; no daemon, pane, session, or agent has been stopped or restarted.

## Decision

Use Prime's existing transactional update-restart coordinator once on the Mac and once on the home server. Use Herdr as the pane inventory and reattachment control plane. Never answer `y` to the per-client “different Prime Agent version” prompt: that path stops the old daemon without proving that its resident sessions have durable restoration dispositions.

This plan restores session identity, saved context, subagent journals, provider binding, cwd, branch, and the original Herdr pane. It does not fork sessions, create replacement titles, or use the session picker.

The minimal architecture is:

1. One immutable recovery snapshot per machine.
2. One transactional daemon restart per machine.
3. One exact UUID per root.
4. One existing Herdr pane per root.
5. No new supervisor, lock service, registry, migration framework, or recovery daemon.

## Prime-only scope and exclusions

The inventory queried all seven running named Herdr sessions: `default`, `bugs`, `content`, `logan`, `planning`, `rustai`, and `snap`.

A pane became a restoration target only when Herdr reported `agent=prime-agent`, its foreground process had `argv0=prime-agent`, or it was the explicit SSH command attaching a remote Prime worker. Terminal content was read only after process metadata proved the pane was Prime.

| Classification | Count | Treatment |
|---|---:|---|
| Local Prime roots in Herdr | 20 | Included |
| Home-server Prime roots attached through Herdr | 1 | Included |
| Plain Codex panes | 4 | Excluded; no terminal content read |
| Plain Claude panes | 1 | Excluded; no terminal content read |
| Ordinary shell/tool panes | 3 | Excluded |
| Total Herdr panes | 29 | Reconciled |

The current Codex pane coordinating this plan is not a restoration target.

## Recovery snapshot receipt

At `2026-08-11T19:23:53-05:00`:

- Local snapshot: **20/20 valid root JSONL files**, 20 complete subagent artifact trees, local daemon descriptors/recovery journals, relevant daemon log, exact Prime/AIM worktrees, and installed wrappers. Logical size: **3.3 GB**.
- Home snapshot: **1/1 valid root JSONL file**, its complete subagent artifact tree, daemon descriptor/recovery journal, relevant daemon log, exact Prime/AIM worktrees, and installed wrappers. Logical size: **865 MB**.
- Combined root journals: **74,431 lines**, **136,006,866 bytes**.
- Combined subagent artifacts: **1,851 files**.
- No credential secret was copied into this document or its machine-readable manifest. The private snapshots retain the original journals in `~/.prime`.

## Reconciliation result

The local supervisor snapshot contains 17 resident worker roots. Every one maps to exactly one Herdr Prime pane. There are **no daemon-only local roots**.

Three additional local Herdr Prime roots have already lost their daemon worker but retain valid journals and complete artifact trees:

| Herdr session | Pane | Session UUID | Title | Cwd |
|---|---|---|---|---|
| default | wC:p3 | `019ff226-cb44-762a-a857-db387efbcb93` | Ramp up on what I'm doing in ~/workspace/coaching I want — psagentspace | `/Users/aelaguiz/workspace/psagentspace` |
| default | wX:p1 | `019ff1e1-8ac6-737e-8ff6-88b645cae558` | Did this analysis somewhere on how to get our Southeast — psagentspace | `/Users/aelaguiz/workspace/psagentspace` |
| bugs | w6:p1 | `019ff146-58bd-7426-8d57-7e74f88be413` | Ramp up on — psagentspace | `/Users/aelaguiz/workspace/psagentspace` |

These three must be resumed from their exact journals after the new local daemon is running. They must not be included in the coordinator's expected resident count.

The home server contains one resident worker root, and it maps to the one remote Prime pane in Herdr. There are no daemon-only home roots.

## Complete restoration ledger

| # | Machine / Herdr session | Pane | Session UUID | Title | Cwd / branch | Saved AIM binding(s) | Snapshot daemon state |
|---:|---|---|---|---|---|---|---|
| 1 | local-mac / default | wB:p4 | `019ff046-2ba1-71c1-9c7f-fa5e97da2eb3` | merge ready FTL — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:boss | resident 0bcbf72c2fa5; tree=1 |
| 2 | local-mac / default | wB:p5 | `019ff091-c6e2-754b-b6d0-89afb6c8db97` | next FTL flows — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:illustrator | resident cfc600c1f813; tree=0 |
| 3 | local-mac / default | wC:p3 | `019ff226-cb44-762a-a857-db387efbcb93` | Ramp up on what I'm doing in ~/workspace/coaching I want — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:qa | disconnected; journal only |
| 4 | local-mac / default | wH:p1 | `019ff04c-47fe-7300-8508-d8d1c518a2d5` | state machines — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro3 | resident f18f82a2ef5b; tree=16 |
| 5 | local-mac / default | wJ:p2 | `019ff049-6508-7607-a80c-2bd67b9d37de` | I had a prime agent thread going that was building — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | anthropic:lessons, openai-codex:qa | resident e6b58dfb47b1; tree=8 |
| 6 | local-mac / default | wX:p1 | `019ff1e1-8ac6-737e-8ff6-88b645cae558` | Did this analysis somewhere on how to get our Southeast — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro7 | disconnected; journal only |
| 7 | local-mac / default | wY:p1 | `019ff250-54fb-714b-8ec9-3d0c6eea527e` | Okay 2.1.38 is approved for iOS I want to update — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro5 | resident 68c129b322f7; tree=1 |
| 8 | local-mac / default | wZ:p1 | `019ff2c6-ec77-716b-8a7e-fe9ee9c33997` | Find the prime agent that did this session: — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | anthropic:coder | resident f82dfa0f1114; tree=1 |
| 9 | local-mac / bugs | w2:p2 | `019ff0e9-e061-772f-b8d6-a9f11c7b8287` | issue 3538 — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:lessons | resident 316999014607; tree=1 |
| 10 | local-mac / bugs | w4:p3 | `019ff0cc-bbcd-778a-ba7d-52331b1dd347` | android payments backfill — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro6 | resident 2f41b5a64f35; tree=4 |
| 11 | local-mac / bugs | w6:p1 | `019ff146-58bd-7426-8d57-7e74f88be413` | Ramp up on — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro2 | disconnected; journal only |
| 12 | local-mac / bugs | w7:p1 | `019ff2f1-3f92-7592-9d12-aca9c3288fb6` | Pick up this investigation from claude: on staging I'm getting — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro7, anthropic:coder | resident 920e3552efc8; tree=5 |
| 13 | local-mac / content | w1:p3 | `019ff112-1dfa-70f9-b946-8d5630b57faa` | Okay I had a Prime Agent thread that was · b57faa — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | anthropic:cfo | resident 5aaec0704c53; tree=1 |
| 14 | local-mac / content | w3:p3 | `019ff098-7fda-745a-8456-9c2b5085505a` | Okay yesterday I had us working through a plan to — lessons_studio | `/Users/aelaguiz/workspace/lessons_studio` / `charter/t05-s02-builds-2026-07-07` | anthropic:product_growth, openai-codex:qa | resident 4e5353fef466; tree=2 |
| 15 | local-mac / content | w4:p2 | `019ff099-7cab-77c8-8657-3144816275de` | Yesterday I had a prime agent session going where we — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | anthropic:cfo | resident 85d7fa97a8fa; tree=0 |
| 16 | local-mac / content | w5:p1 | `019ff153-c6e1-7122-9e14-606d20a75a37` | Ramp up on this: @Ops cut a new staging build — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | anthropic:pro1, openai-codex:qa | resident 62b35d06bf51; tree=1 |
| 17 | local-mac / logan | w1:p1 | `019ff174-34d8-74dc-b0f1-a9dabef0400b` | Ramp up on HEARING_2026-07-22/07_Live_Doc/14_Fee_Law_Master.md — logan | `/Users/aelaguiz/workspace/logan` / `codex/hearing-console-cf-share` | anthropic:coder, openai-codex:qa | resident 57f3f14edc9d; tree=0 |
| 18 | local-mac / logan | w2:p1 | `019ff2f7-4ea9-7792-942b-f6d8716e430f` | The judge just signed the order yesterday or today, I — logan | `/Users/aelaguiz/workspace/logan` / `codex/hearing-console-cf-share` | anthropic:coder | resident 4f031bd575c3; tree=1 |
| 19 | local-mac / rustai | w1:p2 | `019ff0f2-b4ff-738b-9a6a-bd35fc32e9a0` | multiplayer refactor — psagentspace | `/Users/aelaguiz/workspace/psagentspace` / `main` | openai-codex:pro11 | resident 5e1a64faac1c; tree=1 |
| 20 | local-mac / snap | w1:p1 | `019ff2dd-812c-739b-831f-2b13b815e6e3` | Ramp up on how we have this panel we created — snap | `/Users/aelaguiz/workspace/snap` / `feat/snap-cfr-phase1-portability-matrix` | openai-codex:pro5 | resident af46811895e5; tree=0 |
| 21 | home-server / rustai | w2:p1 | `019ff09a-dffd-7089-aa2f-dec81b1ba687` | Alright we had a few prime agent sessions going but — rustai | `/home/aelaguiz/workspace/rustai` / `fix/rts-belief-kernel-g4-seed` | openai-codex:office | resident 2535a2654db4; tree=2 |

The SHA-256 hash, byte count, JSONL line count, artifact count, last saved event, daemon worker ID, snapshot PID, active-session ID, and exact restoration command for every row are in the machine-readable manifest.

## Build and dependency state

The Mac and home server are not currently on the same deployed code:

| Component | Mac snapshot | Home snapshot | Required action |
|---|---|---|---|
| Prime bundle SHA-256 | `fb6ed7da15b03aa001abe06a54b48d1a9c937cbe904a92515854c60357122034` | `b2a68d0a60a119d12ccbbd14077ce0eced902b47611b38d01206ba75c656ad2d` | Deploy the tested Mac implementation to home before restarting home |
| AIM credential helper SHA-256 | `41d8e15abd90fbd865a0a3f94cd3e28b2d0ff9c0e5feef462d03d47b0a3da900` | `7905fa5133ecb96c0d4417f72dbbda1cff7cec675466ee75af320d4caa040171` | Deploy the matching AIM helper to home |
| Installed Prime wrapper | Local handoff worktree | Home handoff worktree | Keep wrapper/worktree coupling explicit |
| Running daemon | Older in-memory Mac build | Older home build | Restart only after snapshot and deployment gates pass |

Do not mix an upstream Prime rebase into this restoration. First restore every current session on the tested fork. Update from upstream afterward as a separate change with a separate restart.

The deployment must be materialized as reviewed Prime and AIM commits from the dedicated worktrees before copying it to home. Do not overwrite the dirty home worktrees in place. Create or update dedicated home deployment worktrees at the exact reviewed commits, build there, verify hashes and symbols, and then repoint the wrappers. This keeps the dependency chain reproducible without inventing a release platform.

## Pre-restart gates

All gates are stop conditions. A failed gate leaves the current daemon running.

### Gate 1 — refresh the Prime-only inventory

Immediately before execution, rerun the same seven-session Herdr inventory. Compare the set of `machine + Herdr session + pane + session UUID` tuples with the manifest.

- If no target changed, continue.
- If a Prime root was added, removed, or changed UUID, create a new point-in-time delta snapshot and update the manifest first.
- Ignore plain Codex/Claude pane state; it is outside the restart set.

### Gate 2 — verify recovery data

Require:

- Every root snapshot passes line-by-line JSON parsing.
- Every listed artifact directory exists.
- Snapshot hashes still match the manifest.
- The live source journal may have grown; that is expected. The snapshot must never be overwritten.
- Free space remains sufficient for restart manifests, new journals, and logs.

### Gate 3 — freeze deployable code

On the local dedicated Prime and AIM branches:

- Inspect the complete diffs.
- Run the focused recovery tests and full repository checks already required by each repository.
- Commit the exact reviewed changes.
- Rebuild the local Prime bundle.
- Confirm the installed wrappers point at those exact worktrees.
- Record the final commit IDs and bundle/helper hashes in this document and manifest before restarting.

On home:

- Preserve the current deployment snapshot already captured.
- Create dedicated worktrees at the exact local reviewed commits.
- Build and test on Linux.
- Confirm the new Prime bundle contains `foldAimCredentialSessionState` and `persistedHelperProviders`.
- Confirm the matching AIM helper supports the intended protocol.
- Repoint wrappers only after those checks pass.

### Gate 4 — make both AIM helper routes available

All 21 captured journals predate the new helper-route persistence field. Their saved account labels are intact, but their journal entries report `helperRoutePersisted=false`.

Before either daemon restart, use the existing explicit dual-provider AIM configuration so a restored legacy session can discover the helper route for either provider:

```bash
aim prime use --codex <ready-codex-label> --claude <ready-claude-label>
aim prime status --json
```

The selected global labels are bootstrap descriptors, not replacements for the session-specific bindings in the manifest. Each restored session continues using its own saved binding. Require both providers to report `installed: true`; do not proceed on a Redis read failure, missing helper, expired bootstrap descriptor, or native-auth fallback.

After a restored session successfully resolves AIM credentials, the new Prime build appends the helper route to that session's existing non-secret binding event so later restarts no longer depend on mutable global provider configuration.

### Gate 5 — prove coordinator readiness

The local daemon must have exactly the live resident roots discovered at execution time, and every worker must be `ready` and connected. The home daemon must satisfy the same rule independently.

Do not require the whole session tree to be idle. The update coordinator is responsible for fencing mutation, preparing each worker checkpoint, persisting the aggregate manifest, committing the checkpoint, restarting once, and restoring it.

If any worker cannot prepare, the coordinator must fail before stopping the daemon. Do not fall back to the destructive confirmation prompt.

## Local Mac execution

Use the installed new bundle to invoke the existing internal update-restart coordinator against the exact old socket:

```bash
restart_status="$HOME/.prime/agent/update-restarts/herdr-$(date +%Y%m%dT%H%M%S).json"
mkdir -p "$HOME/.prime/agent/update-restarts"

prime-agent update \
  --internal-update-restart-coordinator \
  --daemon-socket /var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501/daemon.sock \
  --internal-update-restart-status "$restart_status"
```

This command is preferable to `prime-agent daemon restart` and the interactive `y` prompt because it:

1. Acquires the existing single restart coordinator lease.
2. Asks every resident worker to prepare a durable checkpoint.
3. Persists the aggregate restart manifest before stopping anything.
4. Starts the successor daemon through the installed new bundle.
5. Restores every manifest session and reports exact `total/restored/resumed/failed` counts.

Acceptance for the coordinator:

- Status phase is `complete`.
- `failed == 0`.
- The successor daemon identity differs from the predecessor.
- The prepared manifest accounts for every live resident root and each included busy tree session.
- No duplicate session file appears in the manifest.

If preparation fails, stop. The predecessor should still be running. Fix the exact unavailable worker and rerun the coordinator; do not kill the supervisor.

## Herdr reattachment algorithm

After the local coordinator completes, process the 20 local ledger rows one at a time. Use the row's named Herdr session and pane ID.

1. Read `pane process-info`. If the Prime client automatically reconnected and displays the exact manifest UUID, leave it running.
2. If an old client remains disconnected, send `ctrl+c` to that exact pane and wait until its foreground process is the shell.
3. Run the row's exact restoration command in the same pane. Do not use the session picker and do not add `--rotate` unless credential health independently requires a manual rotation.
4. Wait until Herdr recognizes Prime or process metadata again shows `argv0=prime-agent`.
5. Read the pane and require the same UUID, title, cwd, branch, and saved AIM binding.

Examples:

```bash
# Default Herdr session
herdr pane process-info --pane wH:p1
herdr pane run wH:p1 "cd /Users/aelaguiz/workspace/psagentspace && exec aim prime resume 019ff04c-47fe-7300-8508-d8d1c518a2d5"

# Named Herdr session
herdr --session content pane process-info --pane w3:p3
herdr --session content pane run w3:p3 "cd /Users/aelaguiz/workspace/lessons_studio && exec aim prime resume 019ff098-7fda-745a-8456-9c2b5085505a"
```

Only run `pane run` after process-info proves that pane is at an interactive shell. Never send the command into a still-running Prime UI.

For the three disconnected roots, resume their journals after the successor daemon is healthy. For the 17 coordinator-restored roots, the command should attach to the restored worker, not create a second root. After each attach, verify the daemon still has one worker owner for that root session file.

Do not close, recreate, move, rename, or focus any user pane.

## Home-server execution

The home server is a separate Prime daemon and a separate restart transaction. Do it only after every Mac row passes.

1. Verify the home wrappers point to the newly deployed, Linux-built Prime and AIM worktrees.
2. Verify the home bundle/helper hashes correspond to the reviewed commits.
3. Rerun the home snapshot delta and validate the remote UUID `019ff09a-dffd-7089-aa2f-dec81b1ba687`.
4. Run the same coordinator on the home socket `/tmp/prime-agent-1000/daemon.sock`.
5. Require `phase=complete` and `failed=0`.
6. Inspect Herdr session `rustai`, pane `w2:p1`. If its SSH attach did not reconnect, return it to its local shell and run:

```bash
ssh -t home 'cd /home/aelaguiz/workspace/rustai && exec aim prime resume 019ff09a-dffd-7089-aa2f-dec81b1ba687'
```

Require the restored pane to show the same UUID, cwd, branch `fix/rts-belief-kernel-g4-seed`, and AIM binding `openai-codex:office`.

Do not restart the Mac and home daemons concurrently.

## Post-restore verification

A row is restored only when all of these are true:

- Herdr pane and named Herdr session match the manifest.
- Prime displays the exact root UUID.
- Cwd and Git branch match the captured session header.
- The root JSONL remains valid and has grown from or equals the captured snapshot.
- AIM resolves the saved provider binding without native-auth fallback, `No API key`, `lease_busy`, or provider-usage-unavailable errors.
- The daemon has exactly one worker owner for the root session file.
- Coordinator-restored subagents appear under the original root rather than as a new fork.
- A lightweight input reaches the existing session without creating another UUID.

Run `/usage` only after the pane is reattached; a disconnected client cannot service it. Confirm that both provider and AIM account labels are visible. Do not send substantive “continue working” prompts until all rows on that machine pass identity and credential verification.

Generate an after-state manifest with the same schema and compare:

- Target UUID set: unchanged.
- Herdr pane mapping: unchanged.
- Missing roots: zero.
- Duplicate roots: zero.
- Restore failures: zero.
- Provider fallback: zero.

## Failure and rollback rules

1. **Coordinator fails before stop:** leave the old daemon running. Do not answer `y`, kill it, or manually resume roots against it.
2. **Coordinator fails after checkpoint:** preserve the coordinator status file and prepared restart manifest. Rerun the coordinator so it can complete restoration; do not invent a second recovery path.
3. **One root fails while others restore:** leave successful roots alone. First resume the original live journal by UUID. If it is invalid, resume from the immutable snapshot path without overwriting the original.
4. **New build cannot run:** restore the preserved deployment worktree/wrapper from the machine's snapshot, then run the coordinator against the prepared manifest. Never roll back session journals.
5. **Credential bootstrap fails:** keep both helper descriptors installed, repair AIM health separately, and do not fork or rewrite the affected Prime session.

The private snapshots are rollback inputs, not live working directories. Never edit them in place.

## Completion receipt

The operation is complete only after producing:

- Local coordinator status JSON.
- Home coordinator status JSON.
- After-state Prime-only Herdr manifest.
- Per-row restore verdict for all 21 UUIDs.
- Final bundle/helper hashes on both machines.
- Explicit zero counts for missing roots, duplicate roots, restore failures, and native-auth fallbacks.

No pane or daemon action should begin until the user explicitly authorizes execution of this plan.
