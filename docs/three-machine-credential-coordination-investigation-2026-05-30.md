# Redis-backed three-machine credential coordination

Date: 2026-05-30
Status: draft after Opus consult and Node Redis transaction correction
Author: aelaguiz

## Decision

Use Redis or Valkey as the shared coordination store and durable AIM state for the three-machine pool.

The v1 deployment topology is a single Redis/Valkey primary running on `agents` at Amir's Mac Studio, reachable by the other machines over Tailscale. The other machines do not run their own Redis primaries for this pool; they are AIM clients pointed at the Mac Studio primary.

Do not build a separate AIM daemon in v1. Do not require background AIM agents in v1. Do not keep a privileged "authority" machine or a machine ownership model. Every attached machine talks directly to Redis over the VPN and uses atomic Redis operations to read current state, publish updates, and reject stale writes.

```text
machine A ─┐
machine B ─┼── Tailscale ── agents @ Amir's Mac Studio ── Redis/Valkey primary
machine C ─┘
```

Redis is the only shared home. Local `~/.aimgr`, `~/.codex`, `~/.claude`, Hermes homes, and OpenClaw stores are projections or local CLI homes. They are not shared truth.

## Goals

- Any attached machine can do any operation.
- No label or credential is owned by a machine.
- No normal manual `sync` / `promote` loop.
- Atomic mutation prevents stale machines from clobbering current Redis state.
- Commands stay simple: read Redis, work locally, conditionally write Redis, then project local target files.
- No always-on AIM process is required for v1.
- Migration preserves existing usable Codex/Claude credentials. Having to re-log into a pile of accounts after cutover is a release-blocking failure.

## Deployment Requirements

- Run one Redis/Valkey primary on `agents` at Amir's Mac Studio.
- Serve that Redis primary only over the private Tailscale network for this phase.
- Configure every AIM install with the same Redis primary endpoint and key prefix.
- Keep the Redis endpoint in `~/.aimgr/config.yaml`, not in scattered shell aliases or per-command flags.
- Treat any AIM install without Redis config as not attached to the shared pool.
- Do not run independent Redis primaries on the laptop/mini for the same `aimgr:v1:` pool.

Example `~/.aimgr/config.yaml` on each machine:

```yaml
redis:
  url: redis://agents:6379
  keyPrefix: aimgr:v1:
  primaryHost: agents@amir-mac-studio
  transport: tailscale
```

If the actual Tailscale MagicDNS name is more specific, use that in `redis.url`, for example `redis://agents.<tailnet>.ts.net:6379`. The important rule is that every AIM install records the same primary host in its local AIM config.

## Non-goals

- No custom HTTP service in v1.
- No required `aim agent` in v1.
- No multi-datacenter or high-availability design.
- No strong security design beyond "Redis is on the VPN/private network" for this phase.
- No hot-swap guarantee for already-running Codex/Claude/Pi processes.

## Breaking Cutover Requirement

This is an intentionally breaking, non-reverse-compatible change.

The old authority/consumer model should be deleted as an operating mode, not carried forward next to Redis. After migration:

- Redis is the only shared credential state.
- `~/.aimgr/secrets.json` is legacy import input, not a live source of truth.
- `aim sync codex`, `aim promote codex`, `aim sync claude`, and `aim promote claude` do not keep working in compatibility mode.
- Commands do not dual-write to Redis and the old file-backed authority model.
- The old path can remain only as a read-only importer until the cutover is complete.

The cutover still must not lose data. The migration has to import the combined best current state from all three machines before the old way is removed.

Hard success criteria:

- No planned re-login for existing usable Codex accounts.
- No planned re-login for existing usable Claude accounts.
- Every old credential candidate is either imported, superseded by a clearly better candidate for the same label/session, or reported as already invalid/unreadable before migration.
- Before deleting or ignoring old state, AIM writes a migration backup containing all source `~/.aimgr/secrets.json` files and the Redis import plan.

## No Ownership Model

Machine ownership exists today as a workaround for stale local replicas:

```text
authority JSON -> manual sync -> local replica -> local target files -> manual promote
```

That model creates the question "which machine has the newest real token?" Redis removes that question.

The new rule:

```text
No machine owns a label.
Every machine can read current state.
Every machine can propose an update.
Redis commits the update only if it is based on the current version.
```

If another machine updated first, the Redis store helper returns `stale_version`. The caller rereads and retries or tells the operator what changed.

## Core Model

Split identity from usable auth material:

```text
label   = stable account identity and policy
session = usable auth material for one machine
target  = local projected files for a tool/runtime
```

Example:

```text
label: boss
  provider: openai-codex
  stableIdentity: acct_123 / ChatGPT Pro
  poolPolicy: local + hermes + openclaw

sessions:
  boss on mac-studio      ready
  boss on laptop          ready
  boss on mini            stale

targets on a machine:
  codex-cli auth.json
  pi auth.json
  hermes profile auth.json
  openclaw auth-profiles.json
```

Runtime is a projection target, not a credential boundary in v1. Start with one session per `(provider, label, machineId)`. Codex, Pi, Hermes, and OpenClaw on the same machine can project the same OpenAI/Codex session into their own local auth files.

If a future runtime truly needs a distinct token lineage, add a `sessionScope` later. Do not start with per-runtime credential records.

## Token Rotation Rule

Atomic Redis writes prevent lost updates. They do not make a stale refresh token usable after a provider invalidates it.

For rotating-refresh-token providers, use this rule:

```text
One refresh-token lineage may be live on at most one machine.
```

That still does not create ownership of a label. It only says copied refresh tokens are not independent sessions.

Preferred flow:

- Each machine logs into the same label independently when it needs a local session.
- Each machine rotates and publishes its own session.
- A session can be handed off to another machine as a repair action, but the source copy is then considered dead.
- Do not clone one refresh token and let two machines keep using it concurrently.

This is the rule that keeps no-owner coordination honest. CAS handles stale Redis writes; independent token lineages handle provider-side refresh invalidation.

## Redis Data Layout

Use plain Redis strings and sets. Do not require RedisJSON. Store records as JSON strings so the repo only needs a normal Node Redis client.

This repo is Node ESM. Keep coordination code in JavaScript alongside the existing command code. Redis provides atomicity through normal transaction primitives: `WATCH`, `MULTI`, and `EXEC`.

Key prefix:

```text
aimgr:v1:
```

Core keys:

```text
aimgr:v1:meta
aimgr:v1:machines
aimgr:v1:labels
aimgr:v1:sessions
```

Machine keys:

```text
aimgr:v1:machine:<machineId>
```

Label keys:

```text
aimgr:v1:label:<provider>:<label>
```

Session keys:

```text
aimgr:v1:session:<provider>:<label>:<machineId>
```

Indexes:

```text
aimgr:v1:labels                              set of label keys
aimgr:v1:sessions                            set of session keys
aimgr:v1:machines                            set of machine keys
aimgr:v1:sessionsByLabel:<provider>:<label>  set of session keys
aimgr:v1:sessionsByMachine:<machineId>       set of session keys
```

Future option:

- Add a capped Redis Stream later if change-feed/audit becomes useful.
- Do not require streams for v1 correctness.

## Record Shapes

### Machine Record

```jsonc
{
  "kind": "aimgr.machine.v1",
  "machineId": "mac-studio",
  "hostname": "amirs-mac-studio",
  "displayName": "Mac Studio",
  "aimVersion": "0.0.0",
  "platform": "darwin",
  "lastSeenAt": "2026-05-30T12:00:00.000Z",
  "createdAt": "2026-05-30T12:00:00.000Z",
  "updatedAt": "2026-05-30T12:00:00.000Z",
  "version": 3
}
```

`machineId` is stable and local. Store it in `~/.aimgr/machine-id`. It is an identifier, not an owner.

### Label Record

```jsonc
{
  "kind": "aimgr.label.v1",
  "provider": "openai-codex",
  "label": "boss",
  "stableIdentity": {
    "accountId": "acct_123",
    "email": "boss@example.com",
    "plan": "pro"
  },
  "pool": {
    "enabled": true,
    "uses": ["local-codex", "hermes", "openclaw", "pi"]
  },
  "expect": {
    "email": "boss@example.com"
  },
  "reauth": {
    "mode": "manual-callback"
  },
  "createdAt": "2026-05-30T12:00:00.000Z",
  "updatedAt": "2026-05-30T12:00:00.000Z",
  "updatedBy": "mac-studio",
  "version": 12
}
```

Labels change rarely. They answer "what account identity does this label mean?" and "how may it be used?"

Changing `stableIdentity` is a rebind and should require an explicit command:

```bash
aim label rebind boss --confirm
```

That explicitness is not ownership. It prevents accidentally turning `boss` into a different account because a device logged into the wrong account.

### Session Record

```jsonc
{
  "kind": "aimgr.session.v1",
  "provider": "openai-codex",
  "label": "boss",
  "machineId": "mac-studio",
  "sessionId": "openai-codex:boss:mac-studio",
  "credential": {
    "access": "...",
    "refresh": "...",
    "idToken": "...",
    "expiresAt": "2026-05-30T17:00:00.000Z",
    "accountId": "acct_123"
  },
  "identity": {
    "accountId": "acct_123",
    "email": "boss@example.com",
    "plan": "pro"
  },
  "lineage": {
    "mode": "independent-login",
    "handedOffFrom": null,
    "handedOffAt": null
  },
  "health": {
    "status": "ready",
    "reason": null,
    "lastVerifiedAt": "2026-05-30T12:00:00.000Z"
  },
  "createdAt": "2026-05-30T12:00:00.000Z",
  "updatedAt": "2026-05-30T12:00:00.000Z",
  "updatedBy": "mac-studio",
  "version": 9
}
```

For Claude, `credential` contains the native Claude bundle AIM already knows how to capture/import today.

`lineage.mode` can be:

- `independent-login`: logged in directly on this machine.
- `imported-authority`: imported from an old `~/.aimgr/secrets.json` candidate.
- `imported-local-target`: imported from a local target auth file that was fresher than old AIM state.
- `imported-clone`: preserved from an old copied credential that shares a fingerprint with another machine.
- `handoff`: explicitly moved from one machine to another.

These modes explain history and risk. They do not create ownership.

## Versioning Rules

Every mutable record has `version`.

The JavaScript Redis store performs compare-and-set with `WATCH`, `MULTI`, and `EXEC`.

Clients call the store with:

```jsonc
{
  "expectedVersion": 8,
  "nextRecord": { "...": "..." }
}
```

The store helper:

1. Reads the current JSON record.
2. Verifies `current.version === expectedVersion`.
3. Builds the next record in JavaScript.
4. Sets `version = expectedVersion + 1`.
5. Sets `updatedAt` and `updatedBy`.
6. Commits `SET` plus index `SADD` operations in one Redis transaction.
7. Treats an aborted watched transaction as a concurrent update.
8. Returns the written record.

If the expected version does not match:

```jsonc
{
  "ok": false,
  "code": "stale_version",
  "currentVersion": 9,
  "current": { "...": "..." }
}
```

Identity validation stays in JavaScript, where the existing code already validates account ids, Claude native bundle identity, duplicate labels, and expected emails. Redis only enforces the atomic commit boundary.

## Redis Store Helpers

Keep Redis logic small and ordinary. The v1 store needs read helpers and one compare-and-set write helper.

### `readSnapshot`

Reads the current fleet state.

Behavior:

- `SMEMBERS` the `labels`, `sessions`, and `machines` index sets.
- `MGET` the referenced JSON records.
- Drop missing/null records if an index contains a stale pointer.
- Parse and sort records in JavaScript before rendering status or selecting a label.

This does not need a global lock. For three machines, full snapshots are cheap. If a command needs to mutate state, the later compare-and-set write still checks the exact record version before it commits.

### `casPutJsonRecord`

Creates or updates one label/session/machine record.

Inputs:

```js
{
  key,
  indexKeys,
  expectedVersion, // null for create
  nextRecord,
  machineId,
  observedAt
}
```

Behavior:

- `WATCH` the record key.
- Read and parse the current record.
- If creating, current key must not exist.
- If updating, current version must equal `expectedVersion`.
- Build the written record with the next version, `updatedAt`, and `updatedBy`.
- Use `MULTI` / `EXEC` to `SET` the record and `SADD` all relevant indexes.
- If the watched transaction aborts, reread and return `stale_version` or retry a bounded number of times.
- Return the written record.

## Client Library Boundary

Do not let command code hand-roll Redis key manipulation.

Add one coordination module:

```text
src/coordination/redis-store.js
```

Likely public functions:

```js
connectRedisStore({ url, keyPrefix })
readSnapshot(store)
registerMachine(store, machineInfo)
publishLabel(store, { expectedVersion, labelRecord })
publishSession(store, { expectedVersion, sessionRecord })
casPutJsonRecord(store, { key, indexKeys, expectedVersion, nextRecord })
```

Provider-specific code should not know Redis key names. It should talk in labels, sessions, versions, and records.

## Command Behavior

### `aim status`

New behavior:

1. Read Redis snapshot.
2. Read local target projections from disk.
3. Render a matrix:

```text
label        identity             mac-studio     laptop        mini
boss         acct_123 / Pro        ready          ready         stale
lessons      acct_456 / Pro        ready          missing       ready
claudalyst   org_boss / Max        ready          ready         missing
```

Machine cell states:

- `ready`: session exists and credentials are fresh.
- `stale`: session exists but is expired or failing provider verification.
- `missing`: no session exists for that machine.
- `blocked`: identity mismatch, unreadable local files, or unsupported target mode.
- `drifted`: current machine has a local target projection that does not match its Redis session.

Local token rotation must publish synchronously before a Redis-backed command exits. A normal command should not leave behind "locally rotated but not published" state.

### `aim login <label>`

New behavior:

1. Read label from Redis.
2. Run provider login/refresh on this machine.
3. Validate returned identity against `label.stableIdentity`.
4. Publish this machine's session with compare-and-set.
5. Project the session into the requested local target if relevant.

If label does not exist:

- Create the label, then create this machine's first session.
- If session creation fails after label creation, status shows this machine as `missing`; that is repairable and simpler than adding multi-record transactions in v1.

If label exists but returned identity differs:

- Fail with `identity_mismatch`.
- Offer explicit `aim label rebind <label> --confirm`.

### `aim codex use [label]`

New behavior:

1. Read Redis snapshot.
2. Pick a label using current pool ranking.
3. Prefer this machine's OpenAI/Codex session for that label.
4. If missing:
   - run login on this machine, or
   - explicitly hand off an existing session and mark the source copy dead.
5. Write local `CODEX_HOME/auth.json`.

This keeps the current next-process contract.

### `aim codex run --tend`

Same selection logic as `codex use`, but it reads/writes Redis sessions before rotating. When Codex refreshes live auth, AIM preserves that machine session back to Redis with CAS before the command exits.

### `aim claude run <label>`

Preferred Redis-era behavior:

1. Use a per-label local Claude home, not global `~/.claude`, when possible.
2. Read this machine's Anthropic session for the label from Redis.
3. If present, project/import it into that per-label Claude home.
4. Launch Claude with the per-label config env.
5. After Claude exits or before switching away, read the native bundle and publish this machine's session if tokens rotated.

This removes global-home clobbering without inventing ownership.

### `aim rebalance hermes`

New behavior:

1. Read Redis snapshot.
2. Choose labels across current pool status.
3. For each Hermes home on this machine, use or create this machine's OpenAI/Codex session.
4. Write that Hermes home's `auth.json`.
5. Report local projection status in `aim status`.

Hermes profile homes are already aligned with the projection model.

### `aim rebalance openclaw`

New behavior:

1. Read Redis snapshot.
2. Select labels for OpenClaw agents.
3. Project machine-local sessions into OpenClaw auth stores.
4. Report local projection status in `aim status`.

OpenClaw assignment state can stay local initially unless we want fleet-visible OpenClaw status. If we want all machines to see assignment state, add target projection records later.

## Conflict Cases

### Two Shells Update The Same Machine Session

This happens when two shells on the same machine race.

Resolution:

- One CAS wins.
- The other receives `stale_version`.
- The loser rereads and decides whether retry is safe.

### Two Machines Update Different Sessions For The Same Label

No conflict.

```text
boss/mac-studio v8 -> v9
boss/laptop v2 -> v3
```

Both can commit because sessions are separate records.

### Machine Logs Into Wrong Account For Existing Label

Fail.

If `boss.stableIdentity.accountId = acct_123`, a login returning `acct_999` must not update `boss`.

The operator can:

- create a new label, or
- run explicit `aim label rebind boss --confirm`.

### Machine Copies A Session To Another Machine

This is a hand-off, not a clone.

```text
boss/mac-studio session moves to boss/laptop
boss/mac-studio session becomes revoked/stale
boss/laptop gets the live lineage
```

The source machine can immediately log in again if it wants its own independent session.

### Redis Is Unreachable

State-changing commands fail loud.

Read-only status can show:

- last local cached snapshot, if available
- cache timestamp
- warning that Redis is unreachable and local data may be stale

Do not refresh or write credentials while disconnected unless the operator passes an explicit emergency flag. The no-owner design depends on central atomic state.

## Local Cache

Store a redacted or encrypted last snapshot in:

```text
~/.aimgr/redis-cache.json
```

Purpose:

- faster status
- diagnostics when Redis is down
- migration/debugging

Not allowed:

- treating the cache as source of truth
- using the cache as an input to pool selection
- using the cache as an input to mutating commands
- committing local mutations while offline by default
- auto-replaying offline credential writes later without user confirmation

## Redis Persistence

Redis is the shared home, so persistence must be enabled on `agents` at Amir's Mac Studio.

Minimum practical settings:

```text
appendonly yes
appendfsync everysec
```

RDB snapshots are useful as an extra backup, but AOF is the important one for recent mutations.

Backups:

- periodic copy of AOF/RDB to local disk or NAS
- optional `aim redis export --out <file>` to produce a JSON snapshot for disaster recovery
- AOF/RDB backups contain refresh tokens and native bundles. For this phase, the assumed control is that they live on the VPN/private machine storage.

Restore:

```bash
aim redis import --in backup.json
```

## Breaking Migration From Current AIM State

Current state is spread across the three machines:

```text
~/.aimgr/secrets.json
local Codex auth files
local Claude native bundles
Hermes auth.json files
OpenClaw auth stores
```

Because the old process involved manual sync/promote, any one of the three machines might have the best current data for a specific label. Migration must collect all candidates first, then import the best combined result into Redis. Do not pick one old "authority" file and assume it has everything.

Migration commands:

```bash
aim redis migrate collect --machine <machineId> --out ~/.aimgr/redis-migration/<machineId>.json
aim redis migrate plan --from ~/.aimgr/redis-migration --out ~/.aimgr/redis-migration/plan.json
aim redis migrate apply --plan ~/.aimgr/redis-migration/plan.json --confirm-breaking-cutover
```

Collection rules:

1. Run collection on all three machines before applying anything.
2. Normalize each machine's `~/.aimgr/secrets.json` through the existing schema code.
3. Read local target auth files as credential candidates too, because a target may have fresher tokens than AIM's old state file.
4. Record source machine, source file, provider, label, account identity, token expiry, credential fingerprint, and any old authority metadata.
5. Do not mutate credentials during collection.
6. Write a full migration backup before applying the plan.

Planning rules:

1. Every old `accounts.<label>` becomes a Redis label record unless it is a duplicate of the same provider/identity.
2. Every usable `credentials.openai-codex.<label>` candidate becomes an OpenAI/Codex session candidate.
3. Every usable `credentials.anthropic.<label>` candidate becomes an Anthropic session candidate.
4. If multiple candidates exist for the same provider/label/machine, prefer the one that validates successfully.
5. If multiple candidates validate, prefer the newest `reauth.lastVerifiedAt`, `lastPromotedAt`, `dirtyObservedAt`, `importedAt`, then newest `expiresAt`.
6. If old import metadata says a local credential is dirty relative to the old authority, treat that local credential as a serious candidate, not as trash.
7. If candidates disagree on account identity for the same label, stop and require an explicit label split or rebind decision.
8. If the same credential fingerprint appears on multiple machines, preserve the best candidate and mark duplicates as same-lineage clones instead of pretending they are independent sessions.

Apply rules:

1. Start from an empty Redis `aimgr:v1:` prefix or an explicit dry-run snapshot.
2. Import the selected label records.
3. Import the selected machine session records.
4. Import same-lineage clone metadata so status can explain where old copied tokens came from.
5. Export Redis immediately after import.
6. Leave old `~/.aimgr/secrets.json` files in a timestamped backup, but stop using them as live state.
7. Remove or hard-disable the old authority/consumer write path.

Re-login policy:

- The migration must not discard usable credentials and ask the user to re-login.
- Having to re-login to 20 Codex accounts after cutover is a failed migration.
- If a token is expired but has a refresh token, migration should attempt a controlled refresh/import path rather than giving up.
- Re-login is acceptable only for labels that were already invalid, unreadable, identity-conflicted, or provider-rejected before Redis import.
- The migration report must list any such labels with exact source files and reasons.

After apply:

```bash
aim status
aim codex use
aim claude run <label>
```

There should be no normal "repair missing sessions by re-logging into everything" step.

## Minimal Implementation Plan

### Phase 0: Primary Host Setup

- Install Redis/Valkey on `agents` at Amir's Mac Studio.
- Bind it to the Tailscale-reachable interface or hostname, not the public internet.
- Enable AOF persistence.
- Verify the other two machines can reach it over Tailscale.
- Add `~/.aimgr/config.yaml` on each machine with `redis.url`, `redis.keyPrefix`, `redis.primaryHost`, and `redis.transport`.

Exit criteria:

- `aim redis ping` succeeds from all three machines.
- `aim redis config` shows the same `primaryHost` and `keyPrefix` everywhere.
- No non-Mac-Studio install is running its own primary for `aimgr:v1:`.

### Phase 1: Redis Store Foundation

- Add the official `redis` npm package unless the repo already has another Redis client.
- Add `src/coordination/redis-store.js`.
- Add config read/write helpers for `~/.aimgr/config.yaml`; the repo already has a YAML dependency.
- Add JavaScript Redis helpers for snapshots and compare-and-set writes.
- Add machine ID creation under `~/.aimgr/machine-id`.
- Add `aim redis configure`, `aim redis config`, `aim redis ping`, and `aim redis snapshot`.

Exit criteria:

- Can connect to the Mac Studio Redis primary from each machine.
- Can write/read labels/sessions in Redis.
- Can reject stale CAS writes in tests.

### Phase 2: Non-Lossy Breaking Cutover Migration

- Add read-only legacy collectors for `~/.aimgr/secrets.json`.
- Add target auth collectors for Codex, Claude, Hermes, and OpenClaw.
- Add `aim redis migrate collect`, `aim redis migrate plan`, and `aim redis migrate apply`.
- Add a migration report that shows chosen candidates, superseded candidates, conflicts, and any labels that truly need re-login.
- Add a migration backup bundle before writing Redis.
- Remove or hard-disable the old authority/consumer write path after apply.

Exit criteria:

- Can collect migration candidates from all three machines.
- Can produce a deterministic import plan that chooses the best current candidate per label/session.
- Can import all usable existing Codex/Claude credentials without planned mass re-login.
- Can explain every skipped credential candidate.
- Old `sync`/`promote` flows no longer operate as a second live coordination system.

### Phase 3: Status From Redis

- Teach `aim status` to use Redis when configured.
- Render label/session/machine matrix.
- Keep current local target warnings.

Exit criteria:

- Status shows all labels and all three machines.
- Missing/stale/ready/drifted cells are visible.

### Phase 4: Codex Session Projection

- Port `aim codex use` to read Redis label/session state.
- Publish session updates when live Codex auth rotates.
- Keep current file-backed `CODEX_HOME/auth.json` writer.

Exit criteria:

- Any machine can activate a Redis-backed Codex label.
- Stale session updates are rejected.
- No `sync codex` / `promote codex` required in normal flow.

### Phase 5: Claude Session Projection

- Move Claude toward per-label homes.
- Store native bundle sessions in Redis.
- Publish rotated Claude session after local refresh.

Exit criteria:

- Any machine can run or repair a Claude label.
- No global `~/.claude` switch is required for the happy path.
- Wrong-account capture fails against stable label identity.

### Phase 6: Hermes/OpenClaw Projection

- Read Redis sessions for local Hermes/OpenClaw target writes.
- Keep runtime config outside AIM.

Exit criteria:

- Rebalance works from any machine that has required local homes/config.
- Status can explain which machine projected what.

## Command Surface After Redis

Normal:

```bash
aim status
aim login <label>
aim codex use [label]
aim codex run --tend
aim claude run <label>
aim rebalance hermes
aim rebalance openclaw
```

Admin/repair:

```bash
aim redis configure --url redis://agents:6379 --primary-host agents@amir-mac-studio
aim redis config
aim redis ping
aim redis snapshot
aim redis migrate collect --machine <machineId> --out ~/.aimgr/redis-migration/<machineId>.json
aim redis migrate plan --from ~/.aimgr/redis-migration --out ~/.aimgr/redis-migration/plan.json
aim redis migrate apply --plan ~/.aimgr/redis-migration/plan.json --confirm-breaking-cutover
aim redis export --out backup.json
aim redis import --in backup.json
aim label rebind <label> --confirm
```

Legacy:

```bash
aim sync codex
aim promote codex
aim sync claude
aim promote claude
```

These old authority/consumer implementations should be removed as live behavior. If the CLI command names remain during the transition, they should only hard-error with guidance. Running both coordination models against the same labels invites split-brain.

## Open Questions

- Should sessions be per machine only, or per machine plus runtime?
  - Recommendation: per machine only for v1. Runtime is a local projection target.
- Should healthy sessions be seedable across machines?
  - Recommendation: not as concurrent clones for rotating-token providers. Use independent login per machine, or explicit hand-off where the source copy is marked dead.
- Should OpenClaw assignments be shared Redis state?
  - Recommendation: not in v1. Start with credential/session sharing. Add target projection records after the core model is working.
- Should Redis Streams be required for correctness?
  - Recommendation: no. Current records are truth. Add streams later if audit/change-feed becomes useful.
- Should commands work offline?
  - Recommendation: read-only status from cache, yes. Mutating offline writes, no by default.

## Fresh Consult Incorporation

A fresh Claude Opus 4.8 max consult reviewed this document after the first Redis draft. The resulting changes were:

- clarified that CAS prevents lost Redis writes but does not solve provider-side refresh-token invalidation
- added the one-live-token-lineage rule
- removed concurrent session cloning as a default
- changed sessions from per machine/runtime to per machine
- moved Redis atomicity into normal JavaScript Redis transactions
- removed `globalVersion` and required Redis Streams from v1
- made local cache display-only
- changed legacy `sync`/`promote` behavior in Redis mode to hard-error with guidance
- added the later requirement that this is a breaking cutover, with a non-lossy migration from all three machines before deleting the old operating model

Consult run directory:

```text
/tmp/fresh-consult/redis-aimgr-arch-20260530T113924Z-7eaZcL
```

## Summary

The minimal architecture:

```text
Redis/Valkey is the only shared home.
The Redis/Valkey primary runs on agents at Amir's Mac Studio over Tailscale.
Every AIM install records that primary in local config.
This is a breaking cutover, not a compatibility mode.
Migration imports the combined best existing data from all three machines first.
Labels define account identity and policy.
Sessions define usable auth per machine.
Commands read Redis, work locally, and publish via JavaScript compare-and-set Redis transactions.
Local files are projections only.
There is no owner.
There is no required AIM daemon.
There is no planned mass re-login.
```

This solves the three-machine coordination problem without recreating authority/consumer sync in a new form.
