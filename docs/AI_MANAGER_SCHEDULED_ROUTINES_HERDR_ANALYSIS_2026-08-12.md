# AI Manager scheduled routines in the Growth Herdr session

**Date:** 2026-08-12
**Repositories inspected:** `aimgr` at `98f8f40df647806835163d698556e7fcc59e9446`; current and deployed Prime Agent checkouts; Herdr 0.8.0 source and live named sessions
**Related live Prime investigation:** `019ff5b9-5d80-74fb-9b5d-674f99b2b35c`
**Status:** Architecture analysis plus a completed read-only five-seat revenue/product/technical panel. No AI Manager, Prime Agent, or Herdr source was changed; no routine was dispatched; no Herdr space was created or closed.

> **Panel update (2026-08-12):** The panel conditionally approved the `launchd` + focused AIM occurrence-runner boundary but rejected the broader V1 control plane below. For the binding implementation decision, use `/Users/aelaguiz/workspace/psagentspace/research/2026-08-12-aim-scheduled-routines-panel/DECISION.md`: three static reviewed definitions/LaunchAgents, one occurrence command, two cheap local locks, one small receipt, and a probe of Prime's existing noninteractive `--print` lane before any new Prime daemon API. Defer routine CRUD, cron compilation, mutable manifests, seven-state workflow, resident monitoring, fairness history, and distributed coordination. The panel also corrects missed-run semantics: `StartCalendarInterval` fires/coalesces after sleep, so the runner must reject late wakes using a narrow due-slot admission window.

> **Operator configuration amendment (2026-08-15):** Every static routine definition must explicitly pin the Prime `provider`, `model`, and `thinking` level, plus the destination `herdrSession` and deterministic `spaceTitleFormat`. These are required per-routine inputs and never inherit ambient Prime or Herdr defaults. The occurrence runner must verify the observed provider/model/thinking tuple and the exact created Herdr session/title before admitting the real prompt; any mismatch fails closed. The three initial routines remain Claude Fable at `xhigh` in Herdr `growth`, with their individual title formats specified below. A future definition can instead pin, for example, `openai-codex` / `gpt-5.6-sol` / `xhigh` without changing the architecture.

## Executive conclusion

**Yes.** AI Manager can become the account-and-launch owner for local unattended routines, and every occurrence can appear as a new, reviewable **Space** in Amir's already-running named `growth` Herdr session. That is a better fit than Claude Desktop if the required product is:

- independent of whichever Claude Desktop account/organization is signed in;
- usage-ranked across AIM's pooled Claude accounts;
- visible in the same Herdr workflow Amir already uses;
- a fresh isolated Prime root and a fresh Space on every occurrence;
- still local to this Mac, its repos, BrowserOS logins, MCPs, skills, and secrets.

It is **not available as a safe end-to-end command today**. The pieces exist, but the orchestration seam does not:

- AIM can choose a least-used eligible Claude account and launch Fable (`aim prime run claude`).
- Prime can run a persistent session and already has a durable cron implementation.
- Herdr can create a background workspace in the named `growth` session without stealing focus and can host/prompt Prime.
- But `aim prime run` is an interactive, inherited-stdio TUI launch that rejects passthrough arguments. It is not a scheduler-safe one-shot with a prompt, structured receipt, overall deadline, or atomic binding-to-new-root guarantee.

The key product decision is what “scheduled routine” should mean:

| Semantics | Current support | Account behavior | Herdr behavior | Recommendation |
|---|---|---|---|---|
| Repeat turns in one durable Prime root | Mostly supported now | One AIM account remains pinned to the root | One existing Space/session; no new Space per occurrence | Useful for continuity-heavy heartbeats, **not** the requested UX |
| Fresh Prime root and fresh Space for every occurrence | Not safely composed today | AIM selects a pooled account at each fire | A new background Space can appear per fire | **Recommended for these three routines** after one narrow runner/bootstrap feature |

Therefore the recommended target is a focused **`aim routine` one-shot plus OS recurrence**. The installer should compile each enabled definition's simple local-time cron into focused `launchd` `StartCalendarInterval` entries (one job per routine; `community-sweep` may have two calendar entries), rather than polling or reimplementing cron. `launchd` should wake the exact routine command; AIM should claim/dedupe the fire, select an account, create a Herdr Space, launch and account-pin Prime inside its pane, submit the prompt, then leave the Space for review. Prime remains the session/transcript owner, Herdr remains the presentation/PTY owner, Redis/AIM remains the credential-and-pool owner, and launchd remains the recurrence/wake owner.

Do **not** recreate Claude Desktop's whole scheduler inside AIM, add a resident AIM daemon, or make Herdr the schedule database.

## 1. Evidence boundary and current migration state

The other Prime session was read directly, not inferred from a summary. Its canonical transcript is:

```text
~/.prime/agent/sessions/019ff5b9-5d80-74fb-9b5d-674f99b2b35c.jsonl
```

Its complete analysis is:

```text
docs/CLAUDE_DESKTOP_SCHEDULED_ROUTINE_ACCOUNT_MIGRATION_ANALYSIS_2026-08-12.md
```

That investigation first mapped the local Claude Desktop storage model, then migrated the routines. As of its final recorded answer at 07:11 local time:

- the destination is **`amir@cratejoy.com` → Personal (Max)**;
- all three destination tasks exist and are enabled;
- the Personal manifest contains the three tasks and the separate Cratejoy Team manifest remains empty;
- exact prompt hashes were retained;
- no task was run during migration;
- the first natural destination fire remains the operational proof.

This matters for cutover: the Desktop routines are currently live. An AIM canary must not be enabled at the same cadence until the matching Desktop task is paused, or the repo and Slack side effects can duplicate.

## 2. Existing routines and non-negotiable behavior

All three currently use:

- model: `claude-fable-5`;
- cwd: `/Users/aelaguiz/workspace/psagentspace`;
- no worktree;
- Claude Desktop permission mode: `bypassPermissions`;
- local repo/global skills, MCPs, BrowserOS/Chrome sessions, network, and local secret files.

| Routine | Cron, local time | What it does | Hard behavior that must survive |
|---|---|---|---|
| `morning-report` | `0 6 * * *` | Full Morning Watch; updates state; publishes the standing report; posts the ops message | Fable-only gate; model tags; read prior state first; do not call missing coverage healthy; delivery required |
| `rpokerskill` | `0 15 * * *` | Sweeps r/PokerSkill/Reddit, reconciles live state, creates approval packet and ledger updates, sends Slack DM | **Post nothing** without Amir's explicit `post P-00X`; payment/entitlement topics flagged; Wins requires Amir's seed |
| `community-sweep` | `0 7,17 * * *` | Sweeps poker communities, builds reply drafts and approval packet, updates ledgers/learnings, sends Slack DM | **Post nothing**; AI-accusation tripwire halts the account; required verification/copy gates; exact OP quoting |

The source prompts remain in:

```text
~/.claude/scheduled-tasks/<routine-id>/SKILL.md
```

They should be snapshotted into an AIM-owned private routine-definition location during implementation. AIM must not keep treating a Claude application directory as its long-term prompt API.

## 3. What Claude Desktop owns today

Claude Desktop's local routine is split into two planes:

1. machine-global prompt file: `~/.claude/scheduled-tasks/<id>/SKILL.md`;
2. account/org-scoped scheduler manifest: `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/scheduled-tasks.json`.

The manifest owns cadence, enabled state, model, cwd, permission mode, timestamps, and dispatch state. The app does not import orphan prompt files merely because they exist. Account or organization switching loads a different manifest. This makes Desktop scheduling depend on the active app identity even though the local prompt file is shared.

The tasks are local, not Anthropic-hosted jobs: they need this Mac, app/runner availability, `psagentspace`, BrowserOS/browser logins, MCPs, skills, network, and local secret paths. Replacing Desktop with AIM therefore removes an app/account coupling; it does **not** make the routines cloud-hosted or able to run while this Mac is asleep.

## 4. AI Manager capabilities that already exist

### 4.1 Pooled account choice

`src/cli/commands/harness-target.js` already provides the correct account-policy owner:

- `resolveUseSelections` selects Codex or Claude bindings (`:159-250`).
- Claude `fable`/`opus` presets call `selectClaudePreset` (`:114-156`).
- `selectLeastUsedUnlockedClaudeAccount` ranks Fable by scoped Fable/Sonnet usage, then five-hour usage, then label (`src/status/claude-redis-view.js:1012-1059`). It excludes locked, unreadable, and exhausted accounts.
- `handleRun` maps `aim prime run claude` to Anthropic + `claude-fable-5`, asks for `avoidCurrentSelection`, installs the descriptor, and launches Prime (`harness-target.js:655-687`).
- repeated rotation history avoids cycling through the same recent labels on rotating resumes (`harness-target.js:78-112, 381-397`; `src/pool/history.js`).

Live `aim status --json` at analysis time exposed 22 eligible Anthropic labels and 22 eligible Codex labels. This is precisely the pool needed to avoid coupling these routines to the Desktop account.

### 4.2 Credential boundary and root affinity

AIM installs non-secret Prime descriptors containing an exact label and identity fingerprint (`src/targets/harness-auth.js`). Prime obtains access material through AIM's external credential helper; refresh credentials remain in AIM/Redis. Normal root sessions persist a secret-free `credential_binding` event when the provider is first resolved. Subagents inherit that root binding. A loaded/persisted tree does not hop labels merely because another invocation changes the global default.

This is the right safety model for a routine **after it is pinned**. It proves:

- one occurrence can remain on one exact account through its whole root/subagent tree;
- access refresh does not copy refresh tokens into Prime;
- an operator can identify the account on the Prime footer and in the session journal;
- Redis outage fails closed after any bounded cached access window.

### 4.3 Refresh and leases

The existing `aim auth maintain` one-shot and its M3 LaunchAgent keep Redis-backed OAuth credentials healthy. Credential-refresh leases serialize refresh for one label and different labels can refresh independently. Those leases are **credential maintenance leases**, not workload reservations; they must not be repurposed as routine-run locks.

### 4.4 What AIM does not currently own

AIM currently has no routine manifest, due-fire ledger, job runner, Herdr integration, or schedule commands. `buildRedisKeys` owns only meta and credential indexes/records (`src/coordination/redis-store.js:9-17`). `package.json` exports a CLI but no public library/RPC API. The absence is useful: there is no stale scheduler to migrate or compatibility layer to preserve.

## 5. Prime Agent capabilities that already exist

The **deployed** Prime build was queried through its actual launcher. `prime-agent schedule list --all --json` returned live persisted scheduled jobs with run counts, next/last times, skipped times, errors, session file, cwd, and prompt. This is working product code, not merely an unbuilt proposal.

### 5.1 Native schedule API

The public command registry exposes:

```text
prime-agent schedule list [--all] [agent] [--json]
prime-agent schedule add <agent> <schedule> -- <message>
prime-agent schedule cancel <job-id>
```

Source anchors:

- `packages/coding-agent/src/cli/command-registry.ts:55-75`
- `packages/coding-agent/src/cli/public-command.ts:100-104`
- `packages/coding-agent/src/cli/daemon-command.ts:997-1068`

The internal daemon surface also offers `daemon create ... --json`; its response includes the live session summary/active ID (`daemon-command.ts:780-800`).

### 5.2 Persistence and dispatch behavior

`packages/coding-agent/src/core/cron-jobs.ts` persists:

- stable job id/status/source;
- live and stable session identifiers;
- session file and cwd;
- prompt and parsed cron/interval/one-shot schedule;
- created/updated/next/last/skipped timestamps;
- last error and run count.

The store uses `proper-lockfile`, owner-only atomic temporary files, `fsync`, and rename. The scheduler atomically claims a due job, advances its next time, records in-flight dispatch state, serializes dispatches per active session, allows different sessions in parallel, and records interrupted dispatches as errors. The daemon can restore a nonresident scheduled session from its persisted file and queues an ordinary cron prompt as a follow-up if that root is busy.

### 5.3 The semantic mismatch

Prime cron intentionally means **future turns on one durable root**. It does not create a new root, choose a new AIM account, or create a new Herdr Space at every cron occurrence. Because the root's AIM binding is persistent, a daily Prime cron job stays on that label. That is excellent for heartbeats and continuity, but it does not satisfy “each routine run pops up as a new Space and rotates accounts.”

Prime cron is still useful for two things:

1. a near-zero-code experiment on an existing pinned root, if fresh Spaces/account rotation are temporarily waived;
2. reusing its schedule parser/store patterns or adding a deliberately different “spawn occurrence” seam later.

It should not be presented as the final requested architecture.

## 6. Herdr usage and exact Growth topology

### 6.1 Amir's actual pattern

At inspection, `herdr session list --json` showed these persistent named sessions running:

```text
default, bugs, content, growth, logan, planning, rustai, snap
```

Herdr is version 0.8.0 / protocol 20. The `growth` session contained six Spaces, each with exactly one tab and one pane:

| Space label | cwd | current occupant/state | launch shape |
|---|---|---|---|
| `user journey telem mapping` | `~/workspace/psagentspace` | Prime working | AIM `prime run claude` → Prime |
| `data on 2.1.38` | `~/workspace/psagentspace` | foreground Prime, Herdr unknown | direct Prime |
| `migrate routines` | `~/workspace/aimgr` | Prime working | AIM `prime run codex` → Prime |
| `money path alert` | `~/workspace/aimgr` | Prime done, retained | AIM `prime run codex` → Prime |
| `scheduled aimgr jobs` | `~/workspace/aimgr` | this analysis | AIM `prime run codex` → Prime |
| `pi remote control` | `~/workspace/aimgr` | another investigation | AIM `prime run codex` → Prime |

This is a clear usage grammar:

```text
one task/investigation = one named Space = one tab = one root pane = one Prime root
```

Completed work remains present (`money path alert` was `done`), so the first routine version should retain completed spaces instead of auto-closing them.

### 6.2 Background Space creation

The installed CLI directly supports the requested presentation:

```bash
herdr --session growth workspace create \
  --cwd /Users/aelaguiz/workspace/psagentspace \
  --label "morning report · 2026-08-13 06:00" \
  --no-focus
```

Creation returns JSON with `.result.workspace`, `.result.tab`, and `.result.root_pane`; the runner must parse the returned pane id rather than predicting it. Herdr source only switches to the created workspace when focus is requested (or when the session has no active workspace). Existing `growth` server logs already demonstrate both modes: API-created background workspaces without a following focus event and interactive creations followed by focus.

The relevant live config reinforces the UX:

- new interactive workspaces prompt for a name;
- agent panel is priority sorted;
- agent labels are visible on pane borders;
- Herdr toasts appear bottom-right after one second.

For scheduled routines use `--label` and `--no-focus`. Do not create a new tab inside a prior workspace; that would not appear as a new sidebar Space.

### 6.3 Prime must start inside the pane

Prime's built-in Herdr reporter is a no-op unless it inherits:

```text
HERDR_ENV=1
HERDR_SOCKET_PATH
HERDR_PANE_ID
```

Inside a Herdr pane it reports `prime-agent`, lifecycle state, and session reference over the Herdr socket (`prime-agent/.../core/extensions/builtin/herdr-agent-state.ts:124-138, 217-230`). A launchd process that launches Prime directly will not become the occupant of a Herdr Space. The OS scheduler must first create the Space, then run the process in its returned pane.

Live Herdr does not list Prime as an `agent start --kind` option. The runner must use `pane run` to start AIM/Prime, wait until the pane reports the expected Prime identity/readiness, then use `agent prompt` or a Prime structured prompt API.

### 6.4 Named-server prerequisite

Workspace subcommands do not start a missing named Herdr server. If `growth` is stopped, they return `server_not_running`. The runner must fail visibly or a separate boot service must ensure the named server is running. It must not silently create a workspace in `default` as a fallback.

## 7. Why direct composition is unsafe today

A tempting script is:

```bash
herdr --session growth workspace create --cwd ... --label ... --no-focus
herdr --session growth pane run <pane> "~/.local/bin/aim prime run claude"
: "The controller waits for the exact Prime reporter/root, then:"
herdr --session growth agent prompt <pane> "<routine prompt>"
```

This is a valid proof outline, but not yet a production runner. Deliberately do **not** prefix the pane command with shell `exec`: Amir's restoration evidence includes an exec-launched Prime client whose workspace closed when that client exited. The pane's shell must survive so completed/failed routine Spaces remain reviewable.

### 7.1 No scheduler-safe AIM launch API

`handleRun` rejects extra Prime arguments and launches through `spawnSync` with inherited stdio (`harness-target.js:437-443, 655-687`). It cannot currently:

- accept the routine prompt;
- name the root;
- request JSON/NDJSON;
- return a session UUID and selected binding in one receipt;
- enforce a total runtime/admission deadline;
- distinguish “Prime opened” from “routine prompt admitted” for a caller.

Herdr can supply the PTY and second-step prompt, but AIM still cannot return a trustworthy launch receipt to a scheduler.

### 7.2 Descriptor-to-root bootstrap race

AIM installs the selected label into a global Prime `auth.json`, releases that file lock, then launches Prime with only provider/model. It does not pass the selected label/fingerprint as immutable launch input. Concurrent bootstraps can therefore overwrite the global descriptor between selection and root initialization.

A local **bootstrap lock** must span selection/install through successful root creation and binding verification. The lock cannot be just the existing auth-file write lock.

There is a second durability edge: a newly created root snapshots the current descriptor in its live runtime, but it does not journal `credential_binding` until the first external credential resolution. If its worker/daemon restarts before that resolution, the root can reload a newer global descriptor. A production bootstrap must synchronously pin/verify the exact non-secret binding before it claims success.

Best narrow Prime seam:

```text
daemon create + exact expected AIM binding/fingerprint
  → validate against installed descriptor
  → helper-resolve once
  → append and flush credential_binding
  → return session + binding receipt
```

Fallback for a canary: hold the bootstrap lock, create the root, immediately execute a deliberately safe initialization turn that causes a model resolution, verify the session's binding event/account footer, then release. This is less elegant and must not accidentally run the real mutating routine as the pin step.

### 7.3 Auto-selection is not a workload reservation

Refresh leases protect refresh-token mutation, not account allocation. AIM's selection reads usage and local rotation history but does not reserve a label for an active root. Two simultaneous routine fires can choose the same least-used label.

For the three known times there is no same-minute collision today, but correctness should not depend on schedules never changing. V1 can serialize all routine bootstraps on this single Mac. Only add a Redis run/account reservation with TTL/CAS if measured concurrency across machines later requires it.

Plain `aim prime run claude` only avoids the currently installed label; unlike rotating resume, it does not commit the broader recent-selection cycle. With stale/equal usage it can bounce between a small pair. The routine lane must record successful provider-local bootstrap selections and apply AIM's existing cycle-avoid helper so eligible labels get a turn before reuse. That is bounded local selection history, not a reservation service.

### 7.4 Usage probe needs a whole-operation deadline

Automatic selection currently probes all stored Codex and Anthropic credentials concurrently with an 8-second request timeout per probe (`src/pool/usage.js:312-369`), but the fanout has no explicit whole-command deadline/cancellation. A scheduler-safe one-shot needs a bounded total selection/bootstrap timeout and one classified failure, or an explicit account assignment for routines that cannot tolerate selection fanout.

### 7.5 Unattended permission equivalence is unresolved

Claude Desktop currently uses `bypassPermissions`. Herdr supplies a terminal and visibility, not an approval policy. `aim prime run` exposes no unattended policy argument. Before rollout, prove that Prime can complete the three exact prompts without stopping at an approval UI, while preserving the explicit safety gates in the prompts.

A blanket “approve everything” shim is not an acceptable substitute. The Reddit/community prompts are already draft-only, but they still reach browsers, files, Slack, and network tools.

### 7.6 Machine and server liveness

A detached Prime daemon survives terminal detach, not necessarily sleep/reboot. A persistent Herdr server likewise must be running. The system remains local:

- asleep/offline means no timely run;
- reboot needs a tested boot path for Herdr `growth`, Prime daemon, Redis/Tailscale, and the routine LaunchAgent;
- missed-run behavior must be explicit rather than assumed.

## 8. Recommended target architecture

### 8.1 Ownership

| Concern | Owner |
|---|---|
| Routine definitions and enable/disable policy | AIM private routine manifest |
| Wall-clock wake/recurrence on this Mac | one focused user LaunchAgent per routine |
| Due-fire claim, dedupe, account selection, bootstrap receipt | AIM routine one-shot |
| Credential records, usage policy, refresh | AIM + Redis |
| Terminal/visual Space, title, and focus state | `herdrSession` and `spaceTitleFormat` from the exact static routine definition |
| Root execution, exact provider/model/thinking tuple, tools, transcript, subagents | Prime Agent |
| User-facing operational result | retained Herdr Space + existing routine Slack/report outputs |

### 8.2 Minimal new surface

Suggested CLI:

```text
aim routine list [--json]
aim routine run <id> [--scheduled-for <ISO>] [--dry-run]
aim routine enable <id>
aim routine disable <id>
aim routine install [<id>]
```

`enable`/`disable` mutate the private manifest; `install` reconciles only the corresponding reviewed LaunchAgent plist(s). `install` validates the supported cron subset and renders one focused user LaunchAgent per enabled routine with `StartCalendarInterval`; the plist names only the routine id and never embeds its prompt. Each launched occurrence derives one canonical calendar slot from the routine id, local clock, and a small admission window (or accepts an explicit slot for manual/test invocation); a delayed wake outside that window is recorded as missed rather than backfilled. Keep the accepted cron surface deliberately small enough to compile to `StartCalendarInterval`; reject unsupported expressions instead of adding a general scheduler. There is no periodic polling tick.

A minimal routine definition needs:

```yaml
id: morning-report
enabled: true
cron: "0 6 * * *"
timezone: local
provider: anthropic
model: claude-fable-5
thinking: xhigh
account: auto-fable
cwd: /Users/aelaguiz/workspace/psagentspace
herdrSession: growth
spaceTitleFormat: "morning report · {scheduled_local}"
promptFile: ~/.aimgr/routines/morning-report.md
catchUp: skip
maxRuntime: 4h
retention: keep
```

`provider`, `model`, `thinking`, `herdrSession`, and `spaceTitleFormat` are required, not optional defaults. `thinking` uses Prime's native vocabulary (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) and is passed as `--thinking`; the runner rejects a level the selected model does not support. `spaceTitleFormat` supports exactly one substitution, `{scheduled_local}`, rendered as `YYYY-MM-DD HH:mm z` from the admitted local calendar slot. No general template language is needed.

The three initial static definitions pin these exact execution and presentation values:

| Routine | Provider | Model | Thinking | Herdr session | Space title format |
|---|---|---|---|---|---|
| `morning-report` | `anthropic` | `claude-fable-5` | `xhigh` | `growth` | `morning report · {scheduled_local}` |
| `rpokerskill` | `anthropic` | `claude-fable-5` | `xhigh` | `growth` | `r/PokerSkill sweep · {scheduled_local}` |
| `community-sweep` | `anthropic` | `claude-fable-5` | `xhigh` | `growth` | `community sweep · {scheduled_local}` |

A Sol routine uses the same record shape with `provider: openai-codex`, `model: gpt-5.6-sol`, and `thinking: xhigh`. The account policy must match the configured provider; model or thinking fallback is forbidden.

Keep definitions local/private at first because the prompts name secret-file paths and local operator identifiers. Use `0600` files under `~/.aimgr/routines/` or a reviewed repo-private location. Store prompt hashes in status/receipts, never prompt bodies in Redis.

### 8.3 One occurrence

```text
launchd wakes `aim routine run morning-report --scheduled-for T`
  → load/validate definition, exact provider/model/thinking tuple, Herdr destination/title format, and prompt hash
  → atomically claim (routine id, scheduled-for) locally
  → verify cwd, prompt, AIM Redis, Prime launcher, and the configured named Herdr server
  → take the local routine-bootstrap lock
  → select one eligible account for the configured provider/account policy with a whole-operation deadline
  → expand the configured title from the admitted slot and create it in the configured Herdr session --no-focus; record returned ids and observed title
  → launch Prime/AIM inside the returned root pane with the exact provider/model/--thinking tuple, preserving the pane's shell
  → create the Prime root and durably bind the exact expected AIM label/fingerprint
  → verify Prime reporter/session/account/provider/model/thinking/cwd and exact Herdr session/title
  → submit the full prompt once only after those checks; record prompt admission
  → release bootstrap lock after account pin/admission (not after the long run)
  → a small supervised worker waits for the exact Prime root to settle and records the terminal outcome
  → leave the Space and its shell alive for review
```

Configured title examples for a CDT occurrence are:

```text
morning report · 2026-08-13 06:00 CDT
r/PokerSkill sweep · 2026-08-13 15:00 CDT
community sweep · 2026-08-13 17:00 CDT
```

Do not put the AIM account label in the Space title; Prime's footer already displays it. The small routine receipt records both the configured and observed provider/model/thinking tuple, Herdr session/title, and non-secret account binding so configuration drift is visible without leaking credentials.

### 8.4 Dedupe and overlap

Use a stable fire key:

```text
<routine-id>/<scheduled-local-date-time>/<timezone-or-offset>
```

V1 single-machine state can live in `~/.aimgr/routines/runs.json` under an atomic file lock. States should be small and explicit:

```text
claimed → space_created → root_bound → prompt_admitted → running → succeeded|failed|needs_attention
```

This is not a distributed workflow engine. Its only job is to prevent duplicate dispatch and make a partial bootstrap diagnosable. The occurrence worker owns the transition from admitted to terminal and has a finite `maxRuntime`; launchd should not launch a second instance of the same routine while that worker exists. If a process crashes after Space creation, the next invocation may reconcile the exact receipt/Prime session once, then retain the Space and mark the fire failed/partial if completion cannot be proved. It must not create a second Space automatically without an operator retry.

Set per-routine overlap policy to `skip` initially. A second `community-sweep` should not start if the prior occurrence still owns a live run. Do not queue hours of stale browser/community work.

The runner can guarantee **at-most-one prompt admission per fire key**, not transactional exactly-once external effects. A crash after a Slack API call, browser action, or report upload can occur before the local terminal receipt is written. Do not automatically replay an admitted prompt. Reconcile the routine's own ledger/artifacts and require an explicit operator retry for ambiguous outcomes; preserve the existing prompt-level idempotency and draft-only gates.

### 8.5 Missed-run semantics

Recommended first policy:

- no backfill after reboot/wake;
- record `missed` with the scheduled time and reason;
- compute only the next future cron occurrence;
- allow explicit `aim routine run <id>` for manual catch-up;
- never run two missed occurrences at once.

This is safer than importing Claude Desktop's inferred wake/jitter behavior and safer for prompts with repo/Slack side effects.

### 8.6 Failure presentation

Once a Space exists, failures should stay visible there. Before Space creation, log to an owner-only file and show a macOS/Herdr notification if possible. Suggested terminal/Space outcomes:

```text
BLOCKED · growth Herdr server unavailable
BLOCKED · no eligible Fable account
BLOCKED · account could not be durably pinned
FAILED  · Prime did not report ready within 60s
FAILED  · prompt admission not acknowledged
DONE    · routine completed (account <label>, session <uuid>)
```

Do not close a failed Space. The artifact is the diagnostic and matches Amir's current retained-work usage.

## 9. Alternative architectures considered

### A. Keep Claude Desktop

**Pros:** already migrated and enabled; existing schedule UI, permission model, jitter/wake behavior, run history.
**Cons:** tied to active Desktop account/org; no AIM rotation; not a Herdr Space; app lifecycle dependency.
**Use:** current production lane until AIM canary passes.

### B. Prime cron on one pinned root

**Pros:** already shipped; durable/locked; session restore; busy queueing; no new scheduler; avoids automatic account-probe fanout on every fire.
**Cons:** same root/account every occurrence; no fresh Space; long-lived context can accumulate; rotating resume forks and does not migrate the schedule.
**Use:** lowest-effort experiment only if Amir accepts one Space and one account.

### C. launchd directly composes Herdr + `aim prime run` + `agent prompt`

**Pros:** quickest prototype; visually matches current Spaces.
**Cons:** stringly shell orchestration, descriptor bootstrap race, no exact binding receipt, no AIM prompt API, difficult partial-failure handling, approval/readiness ambiguity.
**Use:** bounded non-mutating canary after the bootstrap lock/binding proof, not the permanent architecture.

### D. AIM one-shot + launchd + Herdr Space per fire

**Pros:** exact requested UX; fresh root/account; clean owners; no resident AIM daemon; easy staged cutover.
**Cons:** small new AIM runner/state surface and one Prime bind/create seam; requires liveness and permission proof.
**Use:** **recommended**.

### E. Build a general distributed scheduler in AIM/Redis

**Pros:** cross-machine failover and reservations.
**Cons:** duplicate scheduler/run-history architecture, harder secrets/tool locality, split brain with Herdr/Prime, not justified by three local tasks.
**Use:** do not build without measured multi-machine need.

## 10. Required implementation changes

### AI Manager

Primary extension points:

- `src/cli/args.js`: routine flags and safe separator rules;
- `src/cli/help.js`: commands and semantics;
- `src/cli/main.js` / dispatch and `src/cli/deps.js`: route `routine` and load only the dependencies it needs;
- new focused `src/cli/commands/routine.js`: definition/status/run orchestration;
- `src/cli/commands/harness-target.js`: extract reusable account selection and Prime launcher/bootstrap functions instead of shelling through the interactive command;
- `src/io/paths.js`: private definition/run/lock paths;
- focused LaunchAgent installer modeled on `scripts/install-auth-maintainer.sh`, but invoking a routine tick rather than embedding schedules/prompts;
- tests near `test/pi/prime-target.test.js`, plus new routine/installer tests.

Do not expose or import arbitrary AIM internals as a public package API. Keep subprocess boundaries explicit and JSON receipts typed.

### Prime Agent

Smallest robust addition:

- structured daemon/root creation with exact expected external binding + identity fingerprint;
- helper resolution and flushed `credential_binding` before the creation response succeeds;
- returned binding/session receipt;
- structured prompt-admission command/result suitable for AIM;
- no new scheduler if the final recurrence stays in launchd.

If Prime already gains a public create+bind+prompt command before AIM implementation, use it instead of adding an AIM-specific integration.

### Herdr

No source change is required for V1. Use the existing named-session CLI and returned IDs. A future convenience command that starts an unsupported/custom agent is not necessary because `pane run` plus Prime's reporter already works.

### State/locking

- one local bootstrap lock spanning selection through durable root bind/prompt admission;
- one local due-fire claim/dedupe lock;
- no reuse of credential-refresh lease;
- no Redis reservation in V1 unless parallel/multi-machine evidence forces it.

## 11. Verification and rollout plan

### Phase 0: capability probe, no real routine side effects

1. Verify the installed AIM wrapper points to the intended reviewed checkout. At analysis time `~/.local/bin/aim` points to `aimgr-prime-session-handoff-20260810`, not this clean `aimgr` main checkout; pin this deliberately before any implementation test.
2. Verify the installed Prime launcher/build is the reviewed schedule-capable build. The deployed launcher path is `~/workspace/prime-agent-deploy-20260811/prime-agent.sh`; a different source checkout reported a build-scoped daemon mismatch when asked to list schedules. Use the installed lane's status/build id rather than assuming every checkout talks to the same daemon.
3. From a harmless static probe definition, create a non-mutating Prime root in its configured `herdrSession` with its configured `spaceTitleFormat`; prove exact cwd/provider/model/thinking/account/footer and exact observed Herdr session/title, read a harmless file, list expected skill names, and test BrowserOS/MCP availability without posting/writing.
4. Prove no focus change in the TUI and that `done` remains unseen until opened.
5. Prove failure handling by targeting a nonexistent named Herdr session in a test fixture, never by stopping the live `growth` server.

### Phase 1: one manual dry-run routine definition

Use a harmless probe definition, not one of the three prompts. Prove:

- one scheduled fire key makes one Space with the exact configured Herdr session/title and one Prime root;
- a duplicate invocation returns the prior receipt and creates nothing;
- selected account equals persisted binding;
- observed provider/model/thinking exactly equal the required definition tuple, with no inherited default or fallback;
- prompt admission happens once and only after tuple and Herdr destination/title verification;
- bootstrap times out cleanly;
- the Space remains for review.

### Phase 2: one real routine canary

1. Choose `rpokerskill` or `community-sweep`, because both are explicitly draft-only; still expect ledger writes and Slack notification.
2. Pause the exact Desktop source task first.
3. Run one AIM occurrence manually at a known time.
4. Verify live-read evidence, packet/ledger changes, Slack `ok`/timestamp, **zero posts**, exact provider/model/thinking/account/cwd, and the retained Space's exact configured Herdr session/title.
5. If it fails, disable AIM and re-enable only the paused Desktop task.

### Phase 3: staged scheduled cutover

- enable one AIM definition at its natural cadence;
- observe at least three successful fires, including sleep/wake if local availability matters;
- then migrate the next routine;
- move `morning-report` last because it publishes a standing report and channel message;
- keep Desktop records present but paused for rollback;
- after stable operation, decide whether to retain or remove Desktop task definitions.

### Acceptance checklist

- [ ] Exact prompt hash and cron are versioned privately.
- [ ] Every static definition explicitly requires `provider`, `model`, `thinking`, `herdrSession`, and `spaceTitleFormat`; scheduled runs never inherit those values from ambient defaults.
- [ ] The Space is created with `--no-focus` in the exact configured Herdr session, with the exact expanded configured title and cwd.
- [ ] One fire creates exactly one Space/root/prompt admission.
- [ ] Prime reports the exact configured provider/model/thinking tuple, stable session UUID, and exact AIM label before prompt admission; unsupported values or any observed mismatch fail closed without fallback.
- [ ] Binding remains correct across daemon/worker restart after bootstrap.
- [ ] Account selection has a total deadline and excludes unavailable/exhausted/locked labels.
- [ ] Duplicate and overlapping fire policy is proven.
- [ ] Missing configured Herdr session, Redis, repo, prompt, BrowserOS, or Prime returns a classified non-duplicating failure.
- [ ] Repo/global skills and MCP dependencies are visible in Prime. At analysis time the configured Prime skills include `~/.agents/skills` and `~/.claude/skills`, and BrowserOS plus other needed global MCP bridges are configured; the `psagentspace` routine skills also exist under `.agents`, `.claude`, and `skills`. Presence is not execution proof.
- [ ] Unattended permissions do not block or over-authorize the run.
- [ ] Draft-only prompts post nothing.
- [ ] One fire key admits at most one prompt; ambiguous post-admission outcomes do not auto-replay.
- [ ] Expected Slack/report side effects are reconciled against their own receipts/ledgers before any manual retry.
- [ ] The occurrence worker records terminal success/failure/needs-attention and releases the overlap claim after a bounded runtime.
- [ ] The receipt contains configured and observed provider/model/thinking plus Herdr session/title, without prompt bodies or credentials.
- [ ] Completed/failed Space and its shell are retained and do not steal focus.
- [ ] Desktop counterpart was paused before each AIM cutover.

## 12. Security and policy boundaries

- Never place OAuth/access/refresh tokens, browser cookies, Slack tokens, prompt bodies, or provider responses in a routine receipt or Herdr label.
- Keep prompt and run-state files owner-only. Prompt files name local secret paths even when they do not contain secret values.
- Execute through the stable installed `~/.local/bin/aim` wrapper only after verifying its target; do not bake a temporary worktree path into a LaunchAgent or routine definition.
- Account rotation should use only Amir's legitimately enrolled AIM pool and provider-compliant identities. This architecture reduces accidental throttling; it is not a license to evade a provider's contractual controls.
- Prime's root binding must be visible and auditable. Silent mid-run account hopping is forbidden.
- `aim prime resume --rotate` currently forks. It is not a schedule-failover primitive and does not automatically migrate a schedule.
- Never run these local browser/Slack routines on another pool machine merely because Redis credentials exist there. Their logged-in browser state, local repo truth, and secrets are machine-bound.

## 13. Do not build

- No resident AIM routine daemon.
- No copied Claude scheduler manifest or authenticated Electron profile.
- No second generic cron engine inside AIM.
- No distributed workflow engine, run DAG, event bus, or cross-machine executor.
- No account reservation service before concurrent-fire evidence.
- No new Herdr plugin or Herdr source change for V1.
- No automatic Space cleanup before Amir establishes a retention preference.
- No automatic catch-up/backfill for missed repo/browser/Slack routines.
- No generic rotate-on-429 or mid-stream replay.
- No blanket permission bypass invented outside Prime's supported policy surface.

## 14. Decision

Proceed only as a small, explicit product slice:

> Build a scheduler-safe AIM routine one-shot that creates a background Space in the existing `growth` Herdr session, starts a fresh Fable Prime root on a usage-ranked AIM account, durably pins and verifies that binding, submits one prompt, and leaves the Space visible. Let launchd own recurrence and keep the three Desktop routines live until staged canaries pass.

The project is technically feasible and mostly an integration exercise, not a new agent platform. The two load-bearing implementation issues are **durable exact account binding during unattended root creation** and **safe one-fire/one-Space orchestration with explicit failure semantics**. Solve those narrowly; reuse everything else.

## 15. Source and live-evidence ledger

### Prior Prime session and panel

- `~/.prime/agent/sessions/019ff5b9-5d80-74fb-9b5d-674f99b2b35c.jsonl`
- `docs/CLAUDE_DESKTOP_SCHEDULED_ROUTINE_ACCOUNT_MIGRATION_ANALYSIS_2026-08-12.md`
- private prompt/migration snapshot mentioned by that session; contents were not copied into this document
- five-seat integrated decision: `/Users/aelaguiz/workspace/psagentspace/research/2026-08-12-aim-scheduled-routines-panel/DECISION.md`

### AIM

- `README.md`
- `src/cli/args.js`
- `src/cli/help.js`
- `src/cli/commands/harness-target.js`
- `src/targets/prime-agent.js`
- `src/targets/harness-auth.js`
- `src/credentials/harness-access.js`
- `src/pool/usage.js`
- `src/pool/ranking.js`
- `src/status/claude-redis-view.js`
- `src/coordination/redis-store.js`
- `src/coordination/redis-credential-lease.js`
- `scripts/install-auth-maintainer.sh`
- `test/pi/prime-target.test.js`
- `docs/AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06.md`
- `docs/aelaguiz/AIM_PRIME_ROTATE_RESUME_2026-08-06.md`
- `docs/AI_MANAGER_PRIME_AGENT_ARCHITECTURE_PANEL_2026-08-10.md`
- `docs/PRIME_AGENT_HERDR_UPGRADE_RESTORATION_AFTER_STATE_2026-08-11.md`

### Prime Agent

- deployed launcher: `/Users/aelaguiz/workspace/prime-agent-deploy-20260811/prime-agent.sh`
- current source inspected under `/Users/aelaguiz/workspace/prime-agent/packages/coding-agent/src/`
- `cli/command-registry.ts`
- `cli/public-command.ts`
- `cli/daemon-command.ts`
- `core/cron-jobs.ts`
- `modes/daemon/daemon-mode.ts`
- `modes/daemon/daemon-supervisor.ts`
- `core/session-action-store.ts`
- `core/extensions/builtin/herdr-agent-state.ts`
- live `prime-agent schedule list --all --json` output (summarized only; no raw prompt corpus retained here)

### Herdr

- installed CLI `herdr 0.8.0`, protocol 20
- `herdr session list --json`
- `herdr --session growth workspace list`
- `herdr --session growth agent list`
- `herdr --session growth pane process-info ...`
- `~/.config/herdr/config.toml` (non-secret UI settings only)
- `~/.config/herdr/sessions/growth/session.json`
- `~/.config/herdr/sessions/growth/herdr-server.log`
- `/Users/aelaguiz/workspace/herdr/src/cli/workspace.rs`
- `/Users/aelaguiz/workspace/herdr/src/app/creation.rs`
- `/Users/aelaguiz/workspace/herdr/src/cli/server_not_running.rs`
- `/Users/aelaguiz/workspace/herdr/docs/preview/website/src/content/docs/agent-automation.mdx`

## Confidence and remaining questions

**High confidence:** technical feasibility; existing AIM account selection and root-affinity model; Prime schedule persistence; Herdr new-Space/no-focus behavior; current Growth topology; Desktop routine definitions/migration status; the semantic mismatch between Prime recurring turns and fresh-per-fire Spaces.

**Must be decided before implementation:**

1. Confirm fresh Space + fresh root/account selection on **every** fire, rather than one Space per routine.
2. Confirm missed fires should be skipped, not backfilled.
3. Confirm completed Spaces should be retained indefinitely for the first version.
4. Choose the Prime exact-bind seam versus a safe first-turn binding probe.
5. Decide the unattended Prime approval policy for these tool-heavy prompts.
6. Decide whether all routine bootstraps serialize locally, or whether one rare concurrent launch may share an account.
7. Confirm the stable source-of-truth location for copied prompts after cutover.
