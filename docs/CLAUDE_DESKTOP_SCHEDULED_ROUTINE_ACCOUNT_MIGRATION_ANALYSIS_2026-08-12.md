# Claude Desktop scheduled-routine account migration analysis

**Date:** 2026-08-12
**Host inspected:** Amir's current Mac
**App inspected:** `/Applications/Claude.app` (`com.anthropic.claudefordesktop`), version `1.26832.0`
**Status:** Analysis only. No sign-out, sign-in, routine edit, scheduler edit, or account migration was performed.

## Executive conclusion

“Claw desktop” resolves to **Claude Desktop** on this Mac: no `Claw.app` or OpenClaw desktop bundle is installed, while the three requested routine names match Claude Desktop's local scheduled-task records. The small `~/.openclaw` directory contains only workspace/skill material and no matching schedule registry.

The three requested routines are **local Claude Desktop Code scheduled tasks**, not a single transferable server object. Each routine is split across two storage planes:

1. A **machine-global Markdown instruction file** under `~/.claude/scheduled-tasks/<task-id>/SKILL.md`.
2. An **account-and-organization-scoped scheduler record** under:

   ```text
   ~/Library/Application Support/Claude/
     claude-code-sessions/<account-uuid>/<org-uuid>/scheduled-tasks.json
   ```

The scheduler record is what makes the Markdown live: it carries the cadence, enabled state, model, working directory, approval mode, and run timestamps. The app does not scan orphaned `SKILL.md` files and automatically import them.

Therefore, **signing into another Claude account will leave the instruction files on disk but will select a different scheduler manifest**. The routines will not automatically appear or run for the destination account. The safest migration is to preserve the Markdown files, sign into the destination account normally, and recreate the three tasks from the Scheduled UI in manual/paused form before enabling them one at a time. Do not transplant the authenticated Electron profile or OAuth/cookie stores.

The three routines are local because every active record is tied to the local working directory `/Users/aelaguiz/workspace/psagentspace`. They need this Mac, the repo, its skills/state, local browser sessions, MCP configuration, and local secrets. They are not equivalent to Claude's fully remote account-owned scheduled tasks.

## Requested-routine mapping

The names Amir used do not exactly match every internal slug. The currently enabled records make the mapping clear, with one item worth confirming during recreation:

| Amir's name | Internal task ID | Current UI/session title | Prompt frontmatter description | Assessment |
|---|---|---|---|---|
| The morning report | `morning-report` | Morning report | Morning Report | Exact match |
| Our poker skill | `rpokerskill` | Rpokerskill | `our reddit` | Almost certainly the intended r/PokerSkill routine; preserve the existing ID/prompt rather than renaming from memory |
| Community sweep | `community-sweep` | Community sweep | Sweep Poker communities | Exact match |

Two disabled Code-task records also exist (`x-sweep` and a one-time `push-notif-test`). A separate, older disabled Cowork task called `poker-community-reply-sweep` also exists. They are not part of the requested three and should not be accidentally enabled or migrated.

## Current active inventory

All times below are the Mac's local time at inspection (`UTC-05:00`). Cron behavior is local-time based: the recorded UTC fire times line up with the local schedule.

| Task ID | Enabled | Cadence | Current model field | Working directory | Approval mode | Most recent dispatch | Instruction file |
|---|---:|---|---|---|---|---|---|
| `morning-report` | Yes | Daily at 6:00 AM (`0 6 * * *`) | `claude-fable-5` | `/Users/aelaguiz/workspace/psagentspace` | `bypassPermissions` | 2026-08-12 6:01:49 AM | `~/.claude/scheduled-tasks/morning-report/SKILL.md` |
| `community-sweep` | Yes | Daily at 7:00 AM and 5:00 PM (`0 7,17 * * *`) | `claude-fable-5` | same | `bypassPermissions` | 2026-08-11 5:09:55 PM | `~/.claude/scheduled-tasks/community-sweep/SKILL.md` |
| `rpokerskill` | Yes | Daily at 3:00 PM (`0 15 * * *`) | `claude-fable-5` | same | `bypassPermissions` | 2026-08-11 3:05:58 PM | `~/.claude/scheduled-tasks/rpokerskill/SKILL.md` |

The few-minute difference between scheduled time and dispatch time is expected: this app version applies scheduler jitter and also defers after wake/offline conditions.

### Instruction-file fingerprint

These fingerprints make it possible to prove that the prompt survived a migration without placing a second copy in this document. A targeted secret-pattern scan found no embedded private keys, provider-token literals, Bearer literals, long token-like strings, or secret assignments in the three prompt files. Two prompts do reference the path of a local Slack secret environment file; that file was not opened and no credential value was included here.

| Task ID | Bytes | Modified locally | SHA-256 |
|---|---:|---|---|
| `morning-report` | 2,106 | 2026-08-11 10:26:22 AM | `bde2cfbbe047a9b8cbfee2ed4fc27814bec0df48d12375b7ebf217216e9516d1` |
| `community-sweep` | 7,054 | 2026-08-11 7:32:14 AM | `d4714a4abab4f354c0cab36eb1aac71feb40862199e9344e8475ec6c8232dd53` |
| `rpokerskill` | 5,054 | 2026-08-11 7:32:34 AM | `8a04dfb1a060472d0ccc9b94c4d94c1f40589d9cad49fc6dceefef9fb001daa4` |

## How Claude Desktop saves the routines

### 1. Prompt/instruction plane: global to this macOS user

The human-readable prompt is a plain Markdown skill file:

```text
~/.claude/scheduled-tasks/
  morning-report/SKILL.md
  community-sweep/SKILL.md
  rpokerskill/SKILL.md
```

Each file contains YAML frontmatter (`name` and `description`) followed by the complete unattended-run instructions. These files are outside the account UUID hierarchy. Signing out should not remove them.

This has an important consequence: if two account manifests reference the same task ID on this Mac, they resolve to the **same** `SKILL.md`. Schedule state is separate per account/org, but prompt edits are shared. Recreating a task with the same slug may rewrite that global file, so a pre-migration backup is necessary even though the file is expected to survive sign-out.

### 2. Scheduler/control plane: scoped to account and organization

The active manifest is:

```text
~/Library/Application Support/Claude/
  claude-code-sessions/<current-account-uuid>/<current-org-uuid>/
    scheduled-tasks.json
```

The current manifest is a private `0600` JSON file containing five Code-task records, three enabled. Relevant fields observed in this version include:

- `id`
- `cronExpression` or one-time `fireAt`
- `enabled`
- `filePath`
- `model`
- `createdAt`, `lastRunAt`, and `lastScheduledFor`
- `cwd`
- `useWorktree` and optional source branch
- `permissionMode`
- optional stored permission approvals, Chrome permission settings/domains, selected folders/files/projects, notification session, dispatch subscription, and watcher state

The three requested active tasks currently have no itemized `approvedPermissions` array, but they do use the broad `bypassPermissions` mode. Other local records prove that itemized approvals can be stored in this manifest, so copying manifests wholesale is not a safe general migration method.

### 3. Run/session history: also account/org scoped

Individual task runs are stored as local session JSON files in the same account/org subtree. The current disk has 11 run records for `morning-report`, 31 for `community-sweep`, and 3 for `rpokerskill`. Those records link by CLI session ID to transcripts under `~/.claude/projects/-Users-aelaguiz-workspace-psagentspace/`. That history is useful as evidence but is not required for future execution, and the transcripts may contain sensitive operational output. It should remain with the old account record rather than being reindexed into the new account.

A destination-account recreation should start with fresh run timestamps and fresh session IDs. Old session IDs, notification IDs, run history, and transcripts are not portable authority.

### 4. Separate legacy Cowork lane

Claude Desktop also has a different local task lane:

```text
~/Library/Application Support/Claude/
  local-agent-mode-sessions/<account-uuid>/<org-uuid>/scheduled-tasks.json

~/Claude/Scheduled/<task-id>/SKILL.md
```

The current legacy manifest has one disabled `poker-community-reply-sweep` entry. It is not the active `community-sweep` Code task. The two lanes have different prompt roots and should not be mixed.

### 5. What is not authoritative routine storage

The following are Electron/browser/auth state, not the canonical local routine manifest:

- `~/Library/Application Support/Claude/config.json`
- `Cookies`
- `IndexedDB/`
- `Local Storage/`
- `Session Storage/`
- macOS preference plists

`config.json` includes the last account ID and encrypted OAuth token caches; `Cookies` is an authenticated Chromium cookie database. Copying these to “move the routines” would move or corrupt authentication state without correctly recreating account-scoped scheduled tasks.

## Evidence from the installed app

Inspection of the packaged code in `/Applications/Claude.app/Contents/Resources/app.asar` showed the following behavior in version `1.26832.0`:

1. The Code scheduler constructs its manifest path as `userData/claude-code-sessions/<accountId>/<orgId>/scheduled-tasks.json`.
2. `initialize(accountId, orgId)` loads exactly that manifest.
3. A missing manifest returns an empty scheduled-task list; there is no import-by-scanning of `~/.claude/scheduled-tasks`.
4. During load, each record's saved `filePath` is normalized to `<task-files-root>/<task-id>/SKILL.md`.
5. `reset()` clears the in-memory scheduler and its pending dispatches before another account/org is initialized.
6. The app persists the full scheduled-task array and scheduler state back to the account/org manifest.
7. The prompt-file helper resolves Code task files to `~/.claude/scheduled-tasks`, while the older Cowork helper resolves them to `~/Claude/Scheduled`.

The local app log corroborates this: scheduler reset/initialize events include an `accountId` and `orgId`, and the task creation logs name the `~/.claude/scheduled-tasks/.../SKILL.md` files.

This is enough to establish the account-switch behavior without signing out of the live account.

## What will happen on account switch

Expected sequence:

1. Claude Desktop signs out and its in-memory scheduler resets.
2. Signing into another account changes the active account ID; choosing a different organization can also change the org ID.
3. Claude initializes the scheduler against the destination `<account-uuid>/<org-uuid>` manifest.
4. If that manifest does not exist, the destination account sees no local Code routines.
5. The three `SKILL.md` files still exist but remain orphaned until destination scheduler records are created.
6. Once recreated, new local runs are launched as sessions under the destination account/org and are expected to consume that destination account's allowance. This last usage-routing point follows from the account-scoped scheduler/session initialization; it should be confirmed with the first destination run because no billing mutation was performed during this analysis.

A switch between organizations under the same Claude account has the same scheduler-visibility boundary. The manifest key is the pair `(account ID, organization ID)`, not only the login email.

## Local versus remote scheduled tasks

Anthropic's current help article says account-hosted scheduled tasks can run remotely with the computer asleep or Claude Desktop closed, are visible from Scheduled “on any surface,” and use connectors plus files saved to the Claude account. It also says a task that requires local files or apps “will only run locally.”

Source: [Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork), accessed 2026-08-12.

The three inspected tasks are decisively in the local category because their scheduler records use a local `cwd` and their prompts depend on local repositories, skills, state, browsers, and secrets. They require this Mac to be awake, Claude Desktop and the local runner to be ready, and the network to be online; they do not inherit the remote “runs while the computer sleeps” guarantee. A remote task owned by the old Claude account would be a different migration problem: copying local files would not transfer its server ownership, account-uploaded files, connector authorizations, or remote run history. Such tasks must be recreated in the destination account's Scheduled page.

## Routine-specific dependency analysis

The Markdown prompt is only the top-level recipe. Execution depends on a larger machine-local graph.

### Shared dependencies

All three depend on:

- `/Users/aelaguiz/workspace/psagentspace`
- repo-local ledgers, prior artifacts, and living state
- repo-local skills
- global Claude skills such as `cf-share`
- the destination account having the scheduled Code/Cowork feature and requested model
- Claude Desktop staying available locally for local runs
- sufficient file/tool/network approval for unattended work

The referenced skills were found on disk, including `morning-watch`, `pokerskill-report-theme`, `pokerskill-subreddit-posts`, `fc-authored-copy`, `poker-kb`, and the venue-specific voice skills.

### Morning report

- Hard-gates itself to the `claude-fable-5` family.
- Reads and writes the morning-watch state in `psagentspace`.
- Publishes a standing report and updates repo state.
- Sends an operations Slack message, with fallback delivery behavior.
- A destination account without Fable access will make this task deliberately stop before doing work.

### r/PokerSkill routine (`rpokerskill`)

- Reads live Reddit through the machine's logged-in BrowserOS session.
- Reads and writes approval packets and posting ledgers in `psagentspace`.
- Requires repo skills and verification tools.
- Sends a Slack notification through a local environment file.
- Must continue to draft only and post nothing without Amir's explicit approval.

### Community sweep

- Reads multiple logged-in community/forum sessions through local browser automation.
- Reads and updates community ledgers, learning records, and approval packets.
- Invokes several repo-local voice and poker-verification skills.
- Sends a Slack notification through the same local secret source.
- Must remain draft-only; it must not post automatically.

### Connector and credential boundary

Because the migration stays on the same Mac, these local assets should remain present:

- `claude_desktop_config.json` and local MCP process definitions
- BrowserOS/Chrome profiles and their site logins
- repo files and global skills
- local secret files

But “present on disk” is not the same as “authorized for the new Claude account.” The new account may need fresh connector/plugin enablement, tool approvals, organization permission, or browser-control permission. Account-owned connectors do not automatically transfer merely because a local MCP definition remains.

No credential value was copied into this analysis. The routine source contains paths to secret material; any backup of the prompt files and scheduler manifest should be kept private.

## Recommended migration procedure

This is the safest, supportable path. It deliberately migrates task intent and cadence, not old authenticated state.

### Phase 1: preserve and quiesce the source

1. While still signed into the old account, open Scheduled and verify the exact three task IDs/titles and cadences above.
2. Pause the three source routines before cutover. This avoids duplicate writes and Slack notices if the old account is later reopened.
3. Fully quit Claude Desktop before taking the final snapshot; the scheduler writes `lastRunAt` and other state during operation.
4. Back up only:
   - `~/.claude/scheduled-tasks/morning-report/`
   - `~/.claude/scheduled-tasks/community-sweep/`
   - `~/.claude/scheduled-tasks/rpokerskill/`
   - the current account/org `claude-code-sessions/.../scheduled-tasks.json` as a private reference
5. Verify the three prompt hashes against the fingerprint table.

Do **not** back up or restore the whole `~/Library/Application Support/Claude` directory for this purpose.

### Phase 2: sign into the destination normally

1. Sign out through Claude Desktop and sign into the intended destination account.
2. Select the intended destination organization.
3. Confirm the Scheduled feature is present and the account can select `claude-fable-5`.
4. Let the app create its new account/org directories naturally. Do not edit OAuth token caches or cookie databases.

### Phase 3: recreate, do not transplant

For each routine, use Scheduled → New task → Set up manually.

1. Use the existing task identity (`morning-report`, `community-sweep`, or `rpokerskill`) rather than inventing a renamed version.
2. Copy the prompt body from the corresponding backed-up `SKILL.md`.
3. Set the model to Fable.
4. Set the working folder to `/Users/aelaguiz/workspace/psagentspace`.
5. Review the approval mode explicitly. The source tasks use `bypassPermissions`, which is powerful; do not assume it should be inherited invisibly.
6. Initially choose **manual** frequency if the UI permits. Task creation is enabled by default in the installed implementation, so a manual cadence prevents a race before validation.
7. Re-enable any required connectors/plugins and local tool access under the destination account.

Because the prompt root is machine-global, creating the same slug can rewrite the existing `SKILL.md`. Keep the source backup and re-check the SHA-256 after each recreation.

### Phase 4: validate without causing duplicate operations

A real “Run now” is not a harmless dry run: these routines can write repo state, publish a report, and send Slack messages. Safer validation is:

1. Use a separate, temporary non-mutating probe to confirm the destination account can:
   - select Fable,
   - read `psagentspace`,
   - see the required skills,
   - reach required browser/MCP tools.
2. Inspect each recreated task in the UI and confirm the full prompt, local folder, model, and approval mode.
3. Keep the old account's routines paused.
4. Enable only one destination routine for its next natural cadence.
5. Watch the first run's local session, expected repo artifact/state update, and expected Slack delivery.
6. Repeat for the other two only after the first routine proves the account/tool path.

### Phase 5: finish and retain rollback

1. Confirm the destination account's manifest has exactly the intended records and cadences.
2. Confirm each task's first new run has a fresh destination-account session ID and new run timestamp.
3. Leave the old account manifest and run history intact but paused for rollback.
4. Retain the private snapshot until several successful destination runs have completed.

## Why raw manifest copying is not recommended

A whole-record copy can carry stale or inappropriate authority:

- broad approval mode
- itemized tool approvals
- Chrome domain grants
- selected local folders/files
- account-owned project UUIDs or `spaceId`
- notification session IDs
- dispatch subscription/watch state
- old run timestamps and skip cursors
- one-time `fireAt` values
- source-branch/worktree state

There are also operational hazards:

- If the app is running, it already has an in-memory snapshot and may overwrite a hand-edited file.
- The schema and path-shortening behavior are app-version dependent.
- A raw copy could immediately enable all source routines under the destination account. The scheduler checks frequently and can consider missed occurrences, so an enabled import is not safely inert.
- Old timestamps could change missed-run/backfill behavior.
- No timezone field is stored; cron follows the host's local time. This same-Mac migration keeps the current wall clock, but a later move to another timezone would not.
- Existing prompt files are global and can be overwritten during recreation.

If the UI path proves unusable, the fallback should be a separately reviewed, **fresh destination manifest** created while Claude is fully quit, with every task disabled and all approvals/session/history/workspace identifiers omitted. It should not be a wholesale copy. That fallback was not executed or validated here.

## Validation checklist

A migration is complete only when all of the following are true:

- [ ] Old account tasks are paused.
- [ ] Destination account and destination organization are the intended pair.
- [ ] Destination account offers scheduled local tasks and Fable.
- [ ] Three destination scheduler records exist: `morning-report`, `community-sweep`, `rpokerskill`.
- [ ] Prompt hashes match the source snapshot after recreation.
- [ ] Working directory is exactly `/Users/aelaguiz/workspace/psagentspace`.
- [ ] Cadences are 6:00 AM, 7:00 AM + 5:00 PM, and 3:00 PM local time respectively.
- [ ] Approval mode was consciously selected for the destination account.
- [ ] Required repo/global skills are readable.
- [ ] BrowserOS/Chrome and MCP dependencies are usable from a destination-account probe.
- [ ] No disabled legacy/test task was accidentally enabled.
- [ ] First destination run creates a new session under the new account/org.
- [ ] First destination run produces its intended artifact/state change and notification.
- [ ] No duplicate old-account run occurs.

## Rollback

Rollback is straightforward if the source records are preserved:

1. Pause the destination tasks.
2. Quit Claude Desktop.
3. Sign back into the original account and original organization normally.
4. Confirm the old manifest reappears and the three tasks are still paused.
5. Restore the prompt directories from the snapshot only if their hashes changed unexpectedly.
6. Resume old tasks one at a time.

Do not restore old OAuth caches or Cookies as a rollback mechanism.

## Evidence paths inspected

- `/Applications/Claude.app/Contents/Info.plist`
- `/Applications/Claude.app/Contents/Resources/app.asar`
- `~/Library/Application Support/Claude/config.json` (keys/identity relationship only; tokens not disclosed)
- `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/scheduled-tasks.json`
- `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/scheduled-tasks.json`
- `~/.claude/scheduled-tasks/*/SKILL.md`
- `~/Claude/Scheduled/*/SKILL.md`
- `~/Library/Logs/Claude/main.log` and `main1.log` scheduler events
- `/Users/aelaguiz/workspace/psagentspace/skills/` dependency presence
- Anthropic Help Center article linked above

## Confidence and open questions

**High confidence:** local path layout, task inventory, prompt/scheduler split, account/org scoping, scheduler reset/initialization behavior, global prompt sharing, current cadences/models/working directory, and unsafe profile-copy boundary. These are supported by the current files, installed app code, and logs.

**Medium-high confidence:** future usage will debit the destination account after correct recreation. The task dispatch and session storage are explicitly account/org scoped, but no destination-account run or billing check was performed.

**Resolved during execution:** `rpokerskill` was migrated as the requested “our poker skill” routine; the destination was confirmed as `amir@cratejoy.com` / Personal; the Personal workspace shows Max with Fable available; and the source `bypassPermissions` setting was intentionally reproduced as requested. No manual run was launched during migration because these routines have real publishing, repository-write, and notification side effects. The first scheduled run remains the end-to-end operational proof.


## Migration execution record: amir@cratejoy.com / Personal

**Executed:** 2026-08-12
**Result:** Completed for the local Claude Desktop Code scheduler.

The destination identity was confirmed from three independent local surfaces:

- Claude account data: `amir@cratejoy.com`
- Claude account/workspace menu: `Personal` selected with plan `Max`; `Cratejoy` was present but not selected
- Claude Desktop startup log: the scheduler initialized for the new account and the Personal organization

The destination Personal manifest was empty before migration. A private copy of that empty manifest was saved beside the source snapshot before any write.

The following three fresh destination records were created and enabled:

| Task ID | Destination cadence | Model | Working directory | Approval mode |
|---|---|---|---|---|
| `morning-report` | Daily at 6:00 AM | `claude-fable-5` | `/Users/aelaguiz/workspace/psagentspace` | `bypassPermissions` |
| `rpokerskill` | Daily at 3:00 PM | `claude-fable-5` | same | `bypassPermissions` |
| `community-sweep` | Daily at 7:00 AM and 5:00 PM | `claude-fable-5` | same | `bypassPermissions` |

The existing machine-global prompt files were retained byte-for-byte and reverified against the source SHA-256 fingerprints. Source account UUIDs, source organization UUIDs, old run timestamps, session IDs, notification IDs, permissions arrays, and run history were not copied.

Safety sequence:

1. Seeded the three destination definitions disabled.
2. Started Claude Desktop against the destination identity and confirmed it initialized the Personal account/org manifest without dispatching a task.
3. Quit that newly started instance, enabled exactly the three destination records, and started it again in the background.
4. Confirmed the scheduler initialized against Personal, all three records remained present and enabled, no destination run session had been created, and no task was dispatched during migration.
5. Confirmed the separate Cratejoy Team manifest remained empty.

The destination tasks were assigned fresh creation times after the already-passed 6:00 AM and 7:00 AM slots. The first expected destination dispatch after migration is `rpokerskill` at 3:00 PM local time, subject to the scheduler's normal bounded jitter. The first real run remains the operational proof of destination-account usage and end-to-end tool access.
