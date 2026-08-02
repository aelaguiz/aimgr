---
title: "AIMGR Single-Operator Simplification - Mini Architecture Plan"
date: 2026-08-02
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [kimi-code/k3]
doc_type: mini_architecture_plan
related:
  - docs/AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md
  - docs/bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md
  - docs/CONSOLIDATE_CLAUDE_CREDENTIALS_INTO_AIM_REDIS_2026-07-22.md
---

# TL;DR

Simplify AIMGR without removing the workflows Amir uses. Redis remains the one
shared credential authority; the official Claude and Codex clients remain the
refresh authorities; per-account Claude homes, session switching, model-aware
selection, status, automatic refresh, and fleet use all remain.

The implementation removes control-plane interference and duplicate truth in
three phases:

1. Make Claude credential publication retryable and reduce rotation state to
   one canonical Redis credential, one shared recovery fence, one native
   working file, and one non-secret local projection receipt.
2. Make the launch environment transparent and converge status, selection,
   Codex reconciliation, maintenance, CLI pass-through, and Redis degradation
   onto one owner each.
3. Hard-cut the retired credential authority, Tend, removed commands, and
   completed migration machinery out of the daily runtime; verify and deploy
   the same code to the fleet.

No new daemon, database, queue, event bus, plugin registry, policy framework,
or compatibility mode is introduced.

<!-- arch_skill:block:planning_passes:start -->

planning_passes:
  mode: one-pass-mini
  internal_grounding: complete
  external_research: not_needed
  independent_kimi_review: pass_after_one_narrow_repair
  review_reconciliation: complete
  scope_freeze: complete
  implementation: in_progress

<!-- arch_skill:block:planning_passes:end -->

# 0) North Star

## 0.1 Claim

AIMGR is a thin private account switcher and credential coordinator around the
official Claude and Codex clients. It helps one trusted operator choose an
account, launch the native tool with the normal development environment,
observe usage, and retain refreshed credentials. AIMGR does not decide whether
the operator may work merely because telemetry, Redis, Tailscale, optional
customization, or wrapper bookkeeping is temporarily unavailable.

## 0.2 Binding requirements

1. Preserve Redis-backed Claude and Codex credentials, status, lowest-use and
   explicit selection, automatic refresh, reauthentication, and fleet use.
2. Preserve Claude account containment, concurrent different-account use,
   session list/resume/fork/switch, exact model and effort, native arguments,
   and global/project skills, MCPs, plugins, hooks, status line, and config-root
   user/plugin state required by those enabled customizations.
3. A transient remote or observational failure must not pause or terminate an
   already-running native client. Retry later and show degraded state.
4. Keep protections only where they prevent secret disclosure, wrong-account
   projection, stale credential overwrite, or concurrent online refresh of the
   same rotating OAuth lineage.
5. No additional scope: simplify the existing AIMGR goal without adding a new
   service, product mode, public compatibility promise, or speculative system.

## 0.3 Definition of done

| User-visible result | Done bar |
|---|---|
| Native work stays usable | Claude remains alive through simulated Redis read/write/renew failures; confirmed different live ownership remains the only coordination condition allowed to stop a same-account run. |
| Accounts and sessions still work | Existing explicit/automatic selection, list/resume/fork/switch, model/effort, lock visibility, and native flag tests remain green; focused real-client smokes cover one local managed Claude launch and one Codex selection. |
| Credentials have one authority | Redis stores one canonical provider credential shape; local Claude files are versioned working caches; no local pending boolean or independently writable duplicate OAuth token copy remains. |
| Normal environment is available | Managed Claude can use inherited shell/GitHub/certificate tooling plus global/project skills, MCPs, plugins, hooks, status line, and config-root user/plugin state such as the always-on ADHD marker; optional customization failure does not block launch. |
| Daily AIMGR is smaller | Default status builds only the account/active view, selection does not require fresh telemetry, maintenance avoids the interactive stack, runtime no longer falls back to `secrets.json`, and Tend/confirmed-dead compatibility code is gone. |

## 0.4 Explicitly out of scope

1. Reimplementing Claude or Codex OAuth/refresh APIs instead of using the
   official clients.
2. A new background service, local database, event stream, queue, distributed
   lock protocol, generic provider framework, or configuration registry.
3. Public/multi-tenant threat modeling, adversarial-user policy, or protecting
   Amir from an intentional supported command.
4. Redesigning browser reauthentication, Pi, Hermes, OpenClaw, or Sakana
   behavior unless a direct shared-credential accessor must change to complete
   the canonical credential cutover.
5. Deleting an old browser/recovery path whose current use cannot be proven;
   uncertain paths stay isolated and out of the daily hot path.

## 0.5 Scope and Simplicity Contract

| Contract item | Frozen meaning |
|---|---|
| Human-authorized outcome | The requirements above plus Amir's 2026-08-02 direction to remove private-tool overbuild without removing features he uses. |
| Smallest sufficient solution | Consolidate current owners and delete interfering mechanisms. Reuse Redis, local state, provider credential modules, existing native homes, existing status cache, existing maintainer schedule, and the checkout-local installer. |
| Initial minimal convergence closure | Credential readers/writers that consume the duplicated Anthropic shape; all readers/writers of Claude pending/fence/projection state; all daily status/selection consumers; Codex use/watch reconciliation; and daily CLI imports/fallbacks must cut over together so no second authority survives. |
| Proof boundary | Focused deterministic state-transition tests first, existing full suite/lint/diff check, one contained macOS file-store/environment probe, one managed Claude canary, one Codex selection smoke, then fleet install/version/status checks. No new permanent harness. |
| Accepted residual risk | Offline use cannot prove that another machine is using the same label. Explicit offline resume may use a clean local cache with a visible warning; automatic online selection and normal maintenance still honor the shared lease. |

Scope froze on 2026-08-02 after the independent Kimi review passed its repaired
recheck. Implementation may subtract work but may not add a new surface,
guarantee, mode, owner, or proof category without explicit operator approval.

# 1) Architecture Decisions

## 1.1 One credential authority, not one physical copy

Redis is the shared credential authority. Claude's per-label
`.credentials.json` is the official client's mutable working copy and local
availability cache. A small record in existing `local-state.json` is only a
projection receipt: label, Redis credential version, committed lineage
fingerprint, file path, and reconciliation time. It stores no token.

The roles are non-overlapping:

| State | Sole meaning |
|---|---|
| Redis credential record | Canonical shared credential, identity, policy, health, version, and publication provenance. |
| Redis Claude recovery fence | A run may have rotated away from the canonical base and requires origin-aware recovery before another automatic same-label run. |
| Per-label native file | The official client's current working credential; it may temporarily differ from Redis. |
| Local projection receipt | Which canonical Redis version/fingerprint produced the local file. File-versus-receipt comparison derives clean or unpublished state. |

Delete `rotationPublicationPendingByLabel`. Do not replace it with another
boolean, status file, or Redis key. Status derives recovery from the fence,
receipt, and native file. Replace the misleading singleton `activeLabel` with
`lastRunLabel`. Cross-process live use comes from Redis lease records; within a
running AIM command, its child handle is the local lifecycle fact. Neither
`lastRunLabel` nor a projected credential path is evidence that an account is
currently active, because many different Claude accounts may run concurrently.

## 1.2 One canonical Anthropic credential shape

`credential.nativeClaudeBundle` is the only persisted Anthropic token and
native-account material after cutover. Top-level `access`, `refresh`,
`expiresAt`, subscription/tier, scopes, and identity summaries are derived by
one accessor at read time; they are not independently stored or writable.

Implementation sequence is a hard cutover, not permanent dual-read support:

1. Change all runtime consumers to the canonical accessor while existing Redis
   records still contain the complete native bundle.
2. Deploy that reader to every fleet checkout.
3. Perform one audited CAS rewrite of loaded Anthropic records using existing
   Redis store APIs, removing duplicated top-level Anthropic credential fields
   without printing values.
4. Verify the snapshot shape and then delete transitional normalization in the
   same implementation arc; do not keep an old-shape compatibility mode.

Codex keeps its existing provider-native top-level credential shape because it
does not contain a second nested copy. Shared consumers such as status, Pi,
Hermes, OpenClaw, and usage probing call a provider credential accessor rather
than reading fields whose storage shape differs by provider.

## 1.3 One online collision guard and one recovery marker

Keep the current per-label Redis lease for normal online same-account
exclusion. Keep one durable recovery fence because a crashed official client
can rotate a refresh token before publication. Simplify the fence to the facts
needed for recovery: label, origin installation/storage, base credential
version/fingerprint, run id, and creation time.

The lease and fence do different jobs and are not duplicate authority:

- lease: who is currently allowed to perform normal online same-label refresh;
- fence: whether an unpublished successor may exist after that ownership ends.

Transient lease/Redis failure leaves the native child untouched. A confirmed
different live lease owner remains a terminal collision because concurrent
official-client refresh can invalidate the account. Explicit reauthentication
or import that successfully publishes a new same-identity credential becomes
canonical and clears a superseded fence; it does not have to reconstruct a
stale local branch first.

## 1.4 Cache availability without pretending offline coordination exists

Online launch reconciles Redis, the local receipt, and the local file before
starting. Clean older cache is replaced from Redis; clean matching cache is
reused; a same-origin unpublished successor is retried; a different-lineage
candidate cannot overwrite Redis.

Offline behavior is deliberately bounded:

- list and session resolution stay local;
- an explicit account or session resume may use a complete clean local cache;
- the CLI prints `coordination=offline` with receipt age;
- any rotation remains only in the native file until Redis returns;
- no offline lock emulation, peer discovery, or automatic conflict resolver is
  built.

Blind automatic selection may use the last cached usage/lock snapshot only
when the operator did not name an account, with the same visible offline
warning. This accepts the named one-operator risk rather than manufacturing a
second distributed coordinator.

## 1.5 Thin wrapper, not no wrapper

Keep a small supervisor only for exact executable spawn, inherited terminal
streams, ordinary signal forwarding, and parent-death cleanup while the parent
owns the online lease. Delete pause/resume IPC and every coordination callback
that can signal the child. Publication and usage live outside the supervisor.

Parent-death cleanup is retained as a real rotating-token guard, not as remote
failure policy: Redis/Tailscale loss does not disconnect IPC or terminate the
parent. If implementation evidence shows parent-death cleanup is what kills
healthy sessions across normal macOS sleep, stop and ask for the explicit
trade-off rather than silently reintroducing orphaned same-account refresh.

# 2) Research Grounding

<!-- arch_skill:block:research_grounding:start -->

## 2.1 Current source anchors

| Contract | Current owner/evidence | Planning conclusion |
|---|---|---|
| Active rotation | `src/cli/commands/claude.js:417-475` aborts the child on any active publication exception; `src/credentials/claude-native.js:337-357` mutates runtime state before Redis accepts it. | Make native reconciliation pure and update runtime state only after CAS. Transport failure retries without touching the child. |
| Recovery state | `claude.js:352-370,501-573,841-905`; `src/coordination/redis-claude-rotation-fence.js`; `src/status/claude-redis-view.js:692-700`. | Retain one shared fence, remove the local pending map, and derive status from shared fence plus local receipt/file. |
| Local projection | `claude.js:1064-1069`; `src/credentials/claude-native-storage.js:753-777` deletes the credential after clean exit. | Keep the private file and record only non-secret projection provenance in existing local state. |
| Duplicate OAuth | `src/credentials/claude-bundle.js:208-227` writes top-level tokens plus `nativeClaudeBundle`; fingerprint/projection/status read different copies. | Persist only the native bundle for Anthropic and route all consumers through one derived accessor. |
| Launch policy | `src/targets/claude-runner.js` qualifies builds, disables updates, broadly scrubs env, reparses plugin state, and prepends `native/claude/security_shim.c`. | Resolve/run the selected executable, alter only credential selectors/config roots, and keep customization best-effort. |
| Status/selection | `src/status/view.js`, `src/status/redis-view.js`, `src/status/claude-redis-view.js`, and `claude.js:326-349` duplicate acquisition and force fresh provider calls. | One provider snapshot powers status and selection; freshness is provenance, not credential permission. |
| Redis behavior | `src/coordination/runtime.js:18-31` uses default reconnect while status uses bounded options and a one-hour cache cutoff. | Three explicit connection policies at the existing store boundary; no new client wrapper. |
| Codex reconciliation | `src/cli/commands/codex.js`, `src/targets/codex-cli.js:221-302`, and `src/targets/codex-tender.js` preserve or overwrite local refresh differently. | One identity/freshness reconcile function for explicit use and watch; Tend is deleted. |
| Maintenance | `src/cli/commands/auth.js:172-245` calls `maintainRedisClaudeCredential`, which re-enters the full Claude command handler. | Extract a narrow due-record operation using existing provider modules and one runtime. |
| Legacy paths | `src/cli/main.js`, `status.js`, `codex.js`, `login.js`, `rebalance.js`, migration, and removed-command handlers keep file authority and dead surfaces active. | Runtime credentials require Redis; keep explicit recovery/migration only until the hard cutover finishes, then remove it from daily loading. |

## 2.2 Existing patterns worth reusing

- Existing Redis CAS and lease primitives already express the real shared
  credential guarantees.
- Existing per-label Claude directories and storage containment checks already
  isolate accounts and protect secret files.
- Existing Claude session index already owns list/resume/fork provenance and
  must stay independent of credential coordination.
- Existing status cache and provider usage probes can be narrowed; no new cache
  store is needed.
- Existing checkout-local installer and per-host fast-forward deployment are
  sufficient for this private fleet.

## 2.3 Experiments required before choosing one implementation

Only one decision needs a contained experiment: current native macOS Claude
file-store behavior. In a temporary managed config directory with no global
credential writes, determine whether the installed Claude build now exposes a
supported file-only selector. If yes, delete AIMGR's `security` shadow. If no,
retain one narrowly scoped adapter that intercepts only Claude's credential
service and delegates every other command to `/usr/bin/security`.

This is a selection test, not a permanent runtime mode. The implementation
keeps exactly one result and deletes the rejected path.

<!-- arch_skill:block:research_grounding:end -->

# 3) Current Architecture

<!-- arch_skill:block:current_architecture:start -->

```text
daily aim command
  -> eager global parser + every command import
  -> Redis configured?
       yes -> Redis snapshot / command runtime
       no  -> legacy secrets.json becomes live authority

aim claude run/resume
  -> fresh provider-wide usage probe for automatic selection
  -> Redis lease
  -> Redis rotation fence
  -> local pending-marker recovery
  -> disposable native projection
  -> build/signature/update/environment/plugin/security policy
  -> IPC supervisor
  -> official Claude
       -> active file reconciliation mutates memory before Redis CAS
       -> any publication error may abort the child
  -> terminal reconciliation
  -> delete native credential file

status/selection
  -> broad legacy status model
  -> separate Claude Redis/usage/lock model
  -> separate caches and age/failure rules
  -> narrow rendered output

maintenance
  -> outer Redis scan
  -> full Claude interactive handler + nested Redis runtime per due account

Codex
  -> explicit use, watch, and Tend each reconcile native auth differently
```

The recurring failures are structural: observation, policy, recovery, and
native process lifetime are coupled, while the same credential/status facts
have multiple writers or interpretations.

<!-- arch_skill:block:current_architecture:end -->

# 4) Target Architecture

<!-- arch_skill:block:target_architecture:start -->

```text
thin aim CLI
  -> resolve one command
  -> load one handler
  -> parse AIM-owned prefix
  -> pass native remainder unchanged
  -> one redacted expected-error boundary

Redis credential authority
  -> one canonical credential shape per provider
  -> CAS publication
  -> one online per-label lease
  -> one Claude recovery fence

Claude per-label runtime
  -> local projection receipt + persistent native file
  -> reconcile against Redis when reachable
  -> set only Claude config roots and competing auth selectors
  -> generic best-effort user customization and config-root state bridge
  -> exact installed Claude + thin signal supervisor
  -> pure native candidate detection
  -> best-effort CAS publication and retry
  -> never signal child for observation/publication failure

provider account snapshot
  -> credential readiness
  -> live/cached usage with age
  -> live/stale/unavailable lock provenance
  -> consumed by status and automatic selection

small auth maintainer
  -> one Redis runtime
  -> due records only
  -> official-client refresh operation
  -> CAS if newer / reauth on terminal auth failure / retry otherwise
```

## 4.1 Final ownership table

| Owner | Owns | Explicitly does not own |
|---|---|---|
| `src/coordination/*` | Redis record/version, CAS, connection policy, lease, Claude recovery fence. | Native files, TUI lifetime, usage ranking, optional customization. |
| `src/credentials/*` | Canonical provider credential extraction, identity, freshness, native candidate planning. | Redis I/O, process signals, CLI rendering. |
| `src/targets/claude-cli.js` + storage | Per-label native projection/cache and non-secret local receipt. | Shared authority, duplicate pending state, plugin policy. |
| `src/targets/claude-runner.js` + thin supervisor | Exact executable, minimal environment delta, inherited TTY/signals, additive customization paths. | Version policy, Redis, selection, publication, pause/resume. |
| Provider status/selection modules | One account snapshot with credential, usage, lock, and provenance facts. | Credential writes, broad legacy orchestration metrics. |

`src/cli/commands/*.js` remains orchestration only. It does not become another
state owner. No new manager class, registry, or generic lifecycle framework is
created.

## 4.2 Failure policy

| Failure | Required behavior |
|---|---|
| Provider usage unavailable | Use labeled cached usage where available; explicit account remains usable; keep current valid target. |
| Redis unavailable before an online mutation | Fail within a bounded interval or use the explicitly permitted clean local cache path; never hang indefinitely. |
| Redis unavailable during a native run | Keep the child running; leave the local candidate/fence recoverable; retry publication. |
| Confirmed different live same-label owner | Stop the conflicting same-account run or refuse its launch; this is the one retained collision guard. |
| Optional customization malformed/unavailable | Skip that category with one warning; do not block credential-valid launch. |
| Credential identity/lineage conflict | Refuse only the unsafe write; show account, phase, and exact recovery action without secret values. |

<!-- arch_skill:block:target_architecture:end -->

# 5) Call-Site Audit

<!-- arch_skill:block:call_site_audit:start -->

| Surface | Required convergence | Delete or stop using |
|---|---|---|
| Anthropic credential shape | `src/credentials/claude-bundle.js`, `anthropic.js`, `claude-native.js`, `anthropic-portable.js`; shared accessors in status/usage/Pi/Hermes/OpenClaw; Redis record tests. | Independent top-level Anthropic token/metadata storage and direct field reads. |
| Claude run/recovery | `src/cli/commands/claude.js`, `login.js`, `src/coordination/redis-claude-rotation-fence.js`, `src/targets/claude-cli.js`, `src/credentials/claude-native-storage.js`. | `rotationPublicationPendingByLabel`, orphan-marker repair, stale `activeLabel`/credential-path claims, pre-commit runtime mutation, clean-exit credential deletion. |
| Claude process control | `src/targets/claude-runner.js`, `claude-supervisor.js`, active publisher callbacks and tests. | `registerProcessControl`, process-control IPC type, SIGSTOP/SIGCONT state/tests, publication-triggered `AbortController`. |
| Claude environment | `src/targets/claude-runner.js`, `native/claude/security_shim.c`, local installer, focused native-storage tests. | Build/version/hash/link-topology policy, updater suppression, broad loader/debug env scrub, per-launch seven-case shim validation, plugin-ID-specific preference policy. |
| Status and selection | `src/status/claude-redis-view.js`, `redis-view.js`, `render.js`, `src/pool/ranking.js`, Claude/Codex command selectors and status cache. | Default call into broad `buildStatusView`, forced `fresh:true` selection, usage-as-credential eligibility, hard stale-display cutoff, duplicate Claude/general account truth. |
| Redis runtime behavior | `src/coordination/redis-store.js`, `runtime.js`, callers that observe, mutate once, or hold a lease. | Caller-specific reconnect defaults and broad catch blocks that hide failure class. |
| Codex reconciliation | `src/targets/codex-cli.js`, `src/cli/commands/codex.js`, `src/pool/watch.js`, Codex tests. | Separate use/watch preservation policies; all Tend callers and reconciliation branches. |
| Maintenance | `src/cli/commands/auth.js`, lower-level Claude/Codex credential operations, launchd output/tests. | Recursive call into `handleRedisClaudeRun`, nested Redis runtime, aggregate-only `failed=N` diagnostics. |
| CLI and legacy authority | `bin/aimgr.js`, `src/cli/main.js`, command-local parsers/help, `status.js`, `codex.js`, `login.js`, `rebalance.js`, authority locator/migration lane. | Eager all-command imports, global native-flag rejection, runtime `secrets.json` credential fallback, dead redirects, daily migration import. |
| Tend and completed migration | Codex CLI/help/package/scripts/tests/docs directly advertising active behavior; Redis migration help/tests only until cutover proof completes. | `codex-tender.js`, tend lock, PTY/relay JS/Python/helpers/tests/smoke script; completed migration code and removed-command shims after verified cutover. |

## 5.1 User workflows that must remain covered

| Workflow | Required owner after cutover |
|---|---|
| `aim status`, `aim claude status`, `aim claude inventory` | Provider snapshots plus one renderer/cache provenance. |
| `aim codex use [label]`, label-free use, and watch | One Codex identity/freshness reconciliation plus existing selection policy. |
| `aim claude run [label|fable|opus]`, native flags, and offline explicit use | Claude selection plus one per-label runtime; no separate legacy run path. |
| `aim claude list/resume/fork/switch-account/--account` | Existing local session index and fork provenance, calling the same per-label runtime after resolution. |
| `aim login`, native Claude enrollment/reauth, and `aim auth maintain` | Existing official-client login plus one lower-level due-record operation and Redis CAS. |

No other caller joins implementation merely because it is nearby. A newly
discovered same-contract writer is reported for operator approval unless it is
already named in the convergence table above.

<!-- arch_skill:block:call_site_audit:end -->

# 6) Three-Phase Implementation Plan

<!-- arch_skill:block:phase_plan:start -->

Status: IMPLEMENTED AND REVIEWED — DEPLOYMENT IN PROGRESS

## Phase 1 — Make Claude runtime state singular and non-blocking

Status: COMPLETE

### Goal

Running or resuming Claude no longer depends on a web of pending markers and
does not terminate because publication transport failed. Redis retains shared
authority and rotating-token safety; the local native credential remains a
versioned working cache.

### Work

1. Make native-file reconciliation return an immutable `unchanged`,
   `candidate`, `unreadable`, or `lineage_conflict` result. Do not mutate the
   runtime credential before successful Redis CAS.
2. Keep one shared fence, remove the local pending map, add the non-secret
   per-label projection receipt to existing local state, retain clean native
   files, and derive recovery/status from the fence + receipt + file.
3. Make active and terminal publication retryable. Transport/unreachable
   results retain the fence and candidate but never abort/pause the child;
   confirmed different live ownership remains terminal.
4. Canonicalize persisted Anthropic credentials to `nativeClaudeBundle` only,
   route every direct consumer through the provider accessor, and perform the
   fleet-safe one-time CAS rewrite after all readers are deployed.
5. Preserve session resolution/forking/model/effort exactly; add the bounded
   offline clean-cache path and visible coordination provenance without an
   offline lock substitute.

### Required deletions

- `rotationPublicationPendingByLabel` readers, writers, tests, and login cleanup.
- Orphan pending-marker repair branches and generic “managed storage could not
  be reconciled” error laundering.
- Duplicated stored Anthropic token/metadata fields and independent readers.
- Clean-exit removal of the managed credential file.
- Active-publication process abort and any lease-to-pause callback.

### Verification

| Proof | Required assertion |
|---|---|
| Active publish transport failure | Child remains alive; runtime canonical state stays unchanged; next tick can publish the same local candidate. |
| Confirmed lease replacement | Same-account conflict remains terminal and cannot publish stale lineage. |
| Recovery matrix | Clean same version, clean older version, local unpublished same-origin, Redis newer different lineage, fence on another machine, and missing/corrupt receipt each have one deterministic result. |
| Offline behavior | List/session resolution work; explicit clean-cache resume starts with visible stale age; dirty or identity-ambiguous cache refuses only the unsafe launch. |
| Canonical credential | Redis fixtures and live snapshot after rewrite contain one Anthropic token representation; all status/usage/target projections derive the same values. |

### Phase 1 done bar

- No transient Redis/storage/publication test can signal a healthy child.
- Exactly one local receipt and one shared fence represent recovery; no shadow
  pending/active state remains.
- Existing run/resume/fork/account/model/effort behavior stays green.
- One local managed canary proves projection, native identity, and publish-back
  with no raw secret output.

## Phase 2 — Make launch, status, selection, and maintenance transparent

Status: COMPLETE

### Goal

The wrapper changes only what account isolation requires, while daily status,
selection, Codex reconciliation, and maintenance each use one existing owner
and degrade predictably.

### Work

1. Run the contained current-Claude file-store probe. Keep one selected
   implementation: native file-only setting if supported, otherwise a
   service-specific `security` adapter that delegates all unrelated operations
   to `/usr/bin/security` and is materialized once by the existing installer.
2. Reduce runner preflight to exact executable resolution/X_OK, real HOME and
   cwd, inherited PATH/environment, two Claude config roots, and only competing
   credential/backend env removal. Stop build qualification and update
   suppression.
3. Replace plugin-specific/hard-fail projection with one generic best-effort
   customization bridge. Keep skills, MCPs, plugins, hooks, status line,
   project-local discovery, and user/plugin state markers read from the
   redirected config root. This marker category includes
   `.i-have-adhd-always` while the corresponding global customization is
   enabled, but discovery is based on canonical user config-root state rather
   than a hard-coded plugin ID. Never bridge native credentials, account state,
   sessions, project trust, caches, logs, or another label's state. An optional
   category failure produces one warning and leaves the others usable.
4. Make provider snapshots the shared status/selection input; bound Redis
   observe/mutate/leased connection modes; use cached usage with age instead
   of forced fleet refresh; preserve valid credentials when telemetry fails.
5. Unify Codex use/watch reconciliation, extract the narrow due-record
   maintainer, lazy-load command handlers, pass native arguments after the AIM
   prefix, and add one endpoint-aware redacted CLI error boundary.

### Required deletions

- Build/version/hash/team/link-topology gates and update-disabling variables.
- Broad DYLD/LD/debug and operator routing/header environment deletion.
- Process-tree-wide rejection of unrelated `security` commands and per-launch
  helper compilation/semantic probes.
- Plugin-ID-specific preference logic and launch-fatal optional customization
  topology rules; the generic config-root marker category remains.
- Forced fresh usage on blind launch, broad default status assembly, recursive
  maintenance CLI entry, and command-dependent Codex reconciliation.

### Verification

| Proof | Required assertion |
|---|---|
| Environment parity | Managed Claude inherits Git/`gh`, certificate/security CLI behavior, CODEX_HOME, normal shell variables, and project cwd while still selecting the intended Claude account. |
| Customization parity | A managed home sees global and project skills, MCPs, plugins, hooks, status line, and required config-root user/plugin markers including `.i-have-adhd-always`; native credentials/account/session/project-trust state are not bridged; one malformed optional category does not block launch. |
| Status degradation | With Redis/provider usage live, stale, unavailable, and unconfigured, account tables and local active facts render with correct provenance and no false `active=none`. |
| Selection degradation | Explicit valid labels never require usage; automatic Fable/Opus/Codex selection uses fresh then cached usage, excludes confirmed live locks and labels with a recovery fence, and keeps a valid target when only telemetry is unavailable. |
| Maintenance/reconciliation | One Redis runtime, safe per-label outcomes, official-client refresh, Codex newer-local/newer-Redis/identical/conflict matrix, and no interactive customization/supervisor path for maintenance. |

### Phase 2 done bar

- Plain and managed native tool capability surfaces match except for the two
  intentional Claude config roots and competing auth selectors.
- `aim status` and automatic selection share provider facts; no hidden broad
  status build or pre-launch provider sweep remains.
- Auth maintenance retries recoverable failures and marks reauth only for a
  terminal auth result.
- Native flags no longer require AIMGR to learn each upstream option.

## Phase 3 — Hard cutover, delete dead architecture, verify, and deploy

Status: IN PROGRESS

### Goal

Remove superseded paths so the smaller architecture is the only architecture,
then install the same verified revision everywhere.

### Work

1. Remove runtime credential fallback to `secrets.json`; when Redis is absent,
   status shows `redis=unconfigured` plus local facts and credential mutations
   fail quickly. Keep legacy file reading only long enough to complete the
   explicit one-time canonical-record rewrite/recovery export.
2. Delete Tend's CLI/options/help, tender, locks, PTY/relay helpers, smoke
   script, tests, and active documentation. Preserve ordinary Codex use/watch
   and native Codex sessions.
3. Remove dead command routes and completed migration loading after confirming
   current Redis records/backups and fleet versions. Before removing Redis-less
   credential paths, confirm no requested fleet host still runs Pi, Hermes, or
   `aim auth write hermes` without Redis; if one does, stop the cutover rather
   than create compatibility. Do not delete an uncertain browser/reauth lane;
   isolate it from daily imports instead.
4. Remove transitional old-shape readers, unused authority-import state,
   obsolete status models/tests, dead process-control tests, and stale docs in
   the same cutover; do not keep compatibility toggles.
5. Run the full verification matrix, commit/push one reviewed revision, install
   it locally and through the existing fleet process, and verify version,
   status, one managed Claude smoke, and one Codex selection on representative
   macOS and Linux hosts.

### Required deletions

- Live `secrets.json` credential authority and `--state` runtime escape hatch.
- Tend and its complete PTY/foreground relay/lock surface.
- Removed-command redirects that no longer provide a valid recovery action.
- Daily eager imports of migration, browser, and unrelated providers.
- Transitional duplicate-record and removed-state compatibility code.

### Verification

| Proof | Required assertion |
|---|---|
| Static ownership audit | Every shared credential write reaches Redis CAS; every Anthropic token read reaches the canonical bundle accessor; no pending marker/Tend/pause/runtime legacy credential branch remains. |
| Full repository checks | Focused phase tests, full `npm test`, `npm run lint`, and `git diff --check` pass. No new audit script or layout-policing test is added. |
| User workflow smoke | Status, explicit/automatic Codex selection, Claude Fable/Opus/explicit selection, native flags, list/resume/fork/switch, reauth, and maintainer status each work. |
| Fleet parity | All requested fleet checkouts report the same commit and installed wrapper target; no host relies on Redis-less Pi/Hermes credential operation; macOS and Linux smokes use their native Claude installs. |
| Failure smoke | One bounded Redis-unavailable launch/status scenario reports degraded state or a short actionable failure without hanging or killing an established child. |

### Phase 3 done bar

- Only Redis plus explicit local projection/session facts remain live.
- No feature in the binding requirements was removed or silently weakened.
- Dead compatibility and Tend code is deleted rather than hidden behind flags.
- The canonical plan and execution worklog record the cutover; stale plans are
  handled later through `arch-docs`, not copied into new runtime checks.

<!-- arch_skill:block:phase_plan:end -->

# 7) Rollback and Failure Boundaries

This is a hard architectural cutover, but each live credential mutation keeps
the existing Redis version/CAS boundary and a pre-change encrypted or
owner-private export. Code rollback is permitted only before the canonical
record rewrite. After the rewrite, roll forward with the canonical accessor;
do not restore dual token storage or live `secrets.json` authority.

If a phase fails:

| Failure | Action |
|---|---|
| Focused architecture proof fails | Stop that phase and repair inside its frozen owner boundary. |
| Native file-store probe finds neither supported mode nor a narrow delegating adapter | Stop before changing the runner; report the exact current-client evidence for a human decision. |
| Fleet contains an old reader before record rewrite | Do not rewrite Redis; update the fleet first. |
| Real credential identity/CAS conflict appears | Preserve Redis and local candidate, redact values, and stop the unsafe write only. |
| Reviewer proposes adjacent behavior | Record it as out of scope unless Amir explicitly expands and refreezes this plan. |

# 8) Review Questions for Kimi K3

The independent review must answer all of these with a strict pass/fail:

1. Does the plan materially simplify AIMGR while retaining every workflow in
   the binding requirements?
2. Is every remaining state object a distinct authority, working copy,
   receipt, lease, or recovery marker—or does any duplicate source of truth
   remain?
3. Does any proposed helper, accessor, cache, adapter, connection mode, or
   migration step recreate the overbuilding being removed?
4. Are the three phases cuttable and safe, with explicit deletion/cutover
   rather than indefinite compatibility?
5. Are any real rotating-token, secret, identity, or fleet invariants lost in
   the name of convenience?

# 9) Independent Review and Reconciliation

Kimi K3 reviewed this plan read-only in a clean external session using
`kimi-code/k3` at `max` effort.

| Review turn | Verdict | Result |
|---|---|---|
| Initial | Fail | One used behavior was under-specified: deleting plugin-ID-specific preference copying could lose config-root state such as `.i-have-adhd-always`, and the parity proof would not catch it. |
| Recheck | Pass, high confidence | The bridge now preserves generic config-root user/plugin markers with explicit credential/account/session exclusions; live-use provenance, blind fence exclusion, and Redis-less Pi/Hermes fleet checks are explicit. |

Accepted changes were limited to those four precision corrections. No new
state store, compatibility mode, service, framework, or proof harness was
added. Kimi's final judgment was that the plan is materially subtractive,
retains the binding workflows, and leaves no duplicate writable authority.

Review receipt:

```text
/tmp/fresh-consult/aimgr-simplification-kimi-20260802TC70jUK
session_401b8243-3cb1-46f7-8987-5b834f5ce24c
```

# 10) Readiness Verdict

**READY FOR IMPLEMENTATION.** The independent review passed, its one narrow
failure was repaired and rechecked, the Scope and Simplicity Contract is
frozen, and implementation remains not started.

The implementation handoff is:

```text
miniarch-step implement docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md
```

Implementation creates the worklog. This planning pass does not.
