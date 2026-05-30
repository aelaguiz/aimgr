---
title: "AIMGR - Redis Shared Credential Store - Architecture Plan"
date: 2026-05-30
status: implemented
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [composer-2.5-fast]
doc_type: architectural_change
related:
  - docs/REDIS_CREDENTIAL_COORDINATION_IMPLEMENTATION_PLAN_2026-05-30.md
  - docs/three-machine-credential-coordination-investigation-2026-05-30.md
---

# TL;DR

## Outcome

Replace the current Redis machine/session model with one central Redis credential store. A credential is identified by `provider + label`; any attached AIM install can read it, project it locally, refresh it, and atomically write the updated credential back.

## Problem

The current Redis cutover still preserved the old mental model: machines, sessions per machine, handoff, source-machine thinking, and status matrices that ask which machine has a credential. That is the bug. In a shared Redis store, machines do not own credentials.

## Approach

Make a breaking cleanup. Delete the machine-shaped credential model from runtime and migration. Keep only durable Redis connection config, global credential records, local projection state, and Redis compare-and-set writes.

## Plan

1. Convert the plan and implementation target to one Redis credential record per `provider + label`.
2. Replace `labels + sessions + machines` with global credential records and provider/label indexes.
3. Rewrite migration to import the best this-machine credential candidate per provider/label, not one row per source machine or old Redis session.
4. Rewrite runtime commands so all projections read the same credential record and all refresh/login writes update that same record.
5. Remove machine-shaped repair commands, help text, README claims, status matrices, tests, and Redis data.
6. Deploy the new build to all AIM installs and verify every install can use and update the same Redis credential keys.

## Non-negotiables

- No credential owner.
- No source machine.
- No per-machine Redis credential/session rows.
- No `sessionSourceMachineId`.
- No `aim session handoff`.
- No `sessionsByMachine`.
- No dual source of truth.
- No old SSH authority/sync/promote/apply operating mode.
- No Lua, daemon, app server, or background AIM agent.
- No mass re-login for currently usable Codex accounts.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-05-30
external_research_grounding: not required 2026-05-30; repo inspection plus Redis WATCH/MULTI/EXEC are sufficient and the user explicitly rejected added machinery
deep_dive_pass_2: done 2026-05-30
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

<!-- arch_skill:block:auto_plan_receipts:start -->
{
  "version": 1,
  "digest": "sha256:479ac70b99e396b564673460f3a2dcdce49af260494d1eabe453dff877ed0087",
  "receipts": [
    {
      "stage": "research",
      "command": "research",
      "status": "complete",
      "started_at": "2026-05-30T15:47:00Z",
      "command_ref_hash": "sha256:5ad5dc9efcb3c7d0d42e1d9014e3ee66fd24b8d2f1c85eef2c5ee96543e05c96",
      "doc_hash_before": "sha256:1f7096a5e65cd9f159eba0df884c04c67f1e53bdf83023664ef65d34941a694f",
      "completed_at": "2026-05-30T15:47:09Z",
      "doc_hash_after": "sha256:df79513f24f1dc9996b8cb1993bb31488f67d2b7e9dc98cf174a358e8020f512"
    },
    {
      "stage": "deep-dive-pass-1",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T15:47:13Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:df79513f24f1dc9996b8cb1993bb31488f67d2b7e9dc98cf174a358e8020f512",
      "completed_at": "2026-05-30T15:47:21Z",
      "doc_hash_after": "sha256:41c72ce259b202089838178ff1638059694e3d6782ddcad24b28dfa52ce7f269"
    },
    {
      "stage": "deep-dive-pass-2",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T15:47:24Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:41c72ce259b202089838178ff1638059694e3d6782ddcad24b28dfa52ce7f269",
      "completed_at": "2026-05-30T15:47:32Z",
      "doc_hash_after": "sha256:ef48f707bc6c0187430fb795eb64851984b5aea87a1c4d85af835d8dd5caba69"
    },
    {
      "stage": "phase-plan",
      "command": "phase-plan",
      "status": "complete",
      "started_at": "2026-05-30T15:47:35Z",
      "command_ref_hash": "sha256:1ce4687beab44819933a8a404a02b8e1345823a7a996f7d651f3dd25a0c54aa3",
      "doc_hash_before": "sha256:ef48f707bc6c0187430fb795eb64851984b5aea87a1c4d85af835d8dd5caba69",
      "completed_at": "2026-05-30T15:47:43Z",
      "doc_hash_after": "sha256:01653b9d4109c88f48a5f8039c5bf3b396779cf61b20621abf73406bb4eab1ea"
    },
    {
      "stage": "consistency-pass",
      "command": "consistency-pass",
      "status": "complete",
      "started_at": "2026-05-30T15:47:50Z",
      "command_ref_hash": "sha256:439e1ccf2a90587bbec572e8bf46c4e08f16c9c81c75fcf835f736db479d3d74",
      "doc_hash_before": "sha256:01653b9d4109c88f48a5f8039c5bf3b396779cf61b20621abf73406bb4eab1ea",
      "completed_at": "2026-05-30T15:55:51Z",
      "doc_hash_after": "sha256:43ef2a78bf255b3b31d28a2c1e5681e443fbf86407fe65e058cf765e6eca82f9"
    }
  ]
}
<!-- arch_skill:block:auto_plan_receipts:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

Date: 2026-05-30

Verdict: complete for the Redis hard cutover on the configured four-install fleet.

Evidence:

- Code is deployed at `ad6cf70` on this machine, `home`, `agents@amirs-mac-studio`, and `amirs-m3-max-new`.
- Live Redis contains 24 shared credential records and zero legacy `label`, `session`, or `machine` rows.
- This machine, `home`, and `amirs-m3-max-new` use `redis://amirs-mac-studio:6380`.
- `agents@amirs-mac-studio` is the Redis host and uses `redis://127.0.0.1:6380`.
- All four installs passed `aim redis ping`, `aim codex use pro10`, and `aim status --json` with 24 accounts, 24 Redis credentials, and no warnings.
- Local non-Codex projection smoke passed with `aim auth write hermes pro10 --auth-file <tmp>/auth.json`.
- Codex Tend is covered by Redis runtime tests proving successful live-auth publish and failure-without-commit behavior.
- The two-home Redis projection test proves one AIM home can publish a Codex live-auth rotation and another AIM home reads the updated shared credential without creating `~/.aimgr/secrets.json`.
- `npm run lint` passed.
- `env -u CODEX_HOME npm test` passed with 233 tests.
- Fresh Composer 2.5 Fast recheck passed: `/tmp/fresh-consult/redis-hard-cutover-composer-recheck-20260530TLPehAX/final.txt`.
- Thermo-nuclear code-quality review passed with no blocking structural regressions.

Known residuals:

- Dormant non-Redis local `secrets.json` fallback paths still exist for unconfigured installs. They are inactive on the configured cutover fleet and are not a live shared credential source.
- `src/migration/redis-migration.js` and `src/targets/codex-tender.js` remain below, but close to, the 1k-line review threshold.

Decision: implementation accepted for the hard cutover.
<!-- arch_skill:block:implementation_audit:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After implementation and cutover, Redis contains one live credential record per `provider + label`. No AIM runtime path chooses credentials by local machine id, source machine, owner, handoff, or per-machine session. Running the same label from this machine, `home`, `agents@amirs-mac-studio`, or `amirs-m3-max-new` reads and updates the same Redis key.

## 0.2 In scope

- Keep Redis on `agents@amirs-mac-studio`, served over Tailscale, as the single central credential store.
- Keep durable local config at `~/.aimgr/config.yaml` with `redis.url`, `redis.keyPrefix`, `redis.primaryHost`, and `redis.transport`.
- Replace Redis `label`, `session`, and `machine` credential truth with one global credential record keyed by provider and label.
- Store account identity, token material, policy, health, version, and timestamps on the credential record.
- Keep local target auth files as projections only.
- Keep `~/.aimgr/local-state.json` for local projection receipts, target history, and local browser bindings only.
- Bootstrap from this machine's currently usable local sessions into Redis; the other installs then read Redis instead of contributing competing import truth.
- Rewrite migration so it chooses the best current credential per provider/label from this machine's local legacy/session sources and writes one Redis credential record.
- Keep old authority and machine-shaped coordination commands removed as live behavior; any retained command stubs must hard-error with shared-credential guidance only.
- Migrate existing usable Codex credentials without forcing planned re-login.
- Treat Claude/Anthropic as incidental provider-shaped data only where existing generic provider code already handles it; do not let Claude-specific work expand the plan.

## 0.3 Out of scope

- Redis high availability or multi-primary replication.
- Additional security hardening beyond the private Tailscale network assumption for this phase.
- RedisJSON, Lua scripts, daemons, app servers, background AIM agents, or lock services.
- A compatibility bridge that keeps the old per-machine session model alive.
- New Claude product work; Claude is not a driver for this plan.
- Hot-swapping credentials inside already-running external processes.

## 0.4 Definition of done (acceptance evidence)

- `src/coordination/redis-store.js` exposes credential-shaped Redis helpers, not machine/session helpers for shared credential truth.
- `src/coordination/records.js` normalizes `aimgr.credential.v1` records and no longer requires `machineId` for credential data.
- `src/coordination/snapshot.js` builds state from global credential records without filtering by machine id.
- Login, Codex, Pi, Hermes, and watch/tend paths read/update global credentials through the same Redis runtime boundary.
- Migration apply writes one credential record per provider/label and reports how every candidate was imported, superseded, blocked, or declared invalid.
- The initial cutover imports this machine's currently usable sessions into Redis as bootstrap data, then treats those local files as projections or archives only.
- `aim session handoff` and `aim label rebind --machine ...` are removed or hard-error with replacement guidance.
- README and CLI help describe shared Redis credentials, not machine sessions.
- Tests prove two different AIM homes can read and update the same Redis credential record.
- Existing currently usable Codex accounts are imported into Redis without planned mass re-login.
- Live smoke passes from this machine, `home`, `agents@amirs-mac-studio`, and `amirs-m3-max-new`.

## 0.5 Key invariants (fix immediately if violated)

- Redis is the only shared credential truth.
- Credential identity is `provider + label`, not `provider + label + machineId`.
- Local auth files are projections only.
- `~/.aimgr/secrets.json` is migration input or archive only.
- `~/.aimgr/local-state.json` never stores shared credentials.
- All shared credential writes use Redis compare-and-set on the exact credential key.
- Identity mismatch fails before writing a credential.
- Redis-unavailable mutation fails loud; no stale local cache can drive mutation.
- Existing source paths may appear in migration reports, but never become runtime ownership or routing.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Preserve currently usable Codex credentials.
2. Remove machine ownership and per-machine session thinking completely.
3. Keep Redis as a simple central key/value store with atomic writes.
4. Keep runtime commands ergonomic: read Redis, project local files, update Redis if tokens rotate.
5. Delete old live authority/sync/promote paths instead of carrying compatibility burden.
6. Keep implementation idiomatic for this Node ESM CLI and existing tests.

## 1.2 Constraints

- This repo already has Redis plumbing using the official `redis` npm package.
- The current Redis implementation committed a machine/session model that must be replaced, not extended.
- Current target writers already know how to project credentials to Codex, Pi, Hermes, Claude homes, and OpenClaw stores.
- Existing migration code already collects useful credential candidates from old files and target auth stores.
- Redis is reachable over Tailscale; every install must use the same configured primary and key prefix.
- Existing remote installs may already have per-machine Redis session rows that must be backed up and deleted after the new credential store is verified.

## 1.3 Architectural principles (rules we will enforce)

- One credential record owns all shared credential truth for a provider/label.
- Redis CAS helpers own raw key mutation; command handlers do not hand-roll transaction logic.
- Migration can remember source file and source host as provenance only; runtime cannot route through that provenance.
- Local projection state can record what was written locally, but cannot answer "which credential is current?"
- Repair commands must be label-shaped, not machine-shaped.
- Git is the history for retired designs; live docs/help/comments must describe the current model only.

## 1.4 Known tradeoffs (explicit)

- A single Redis primary is a dependency, but it is the simplest correct shared state for this three-install pool.
- One central credential row means concurrent refreshes race on one key; Redis version checks make stale writes lose cleanly.
- A provider may invalidate a refresh token during rotation; AIM cannot make invalid provider tokens valid, but it can prevent stale local files from overwriting a newer Redis credential.
- Removing machine sessions reduces diagnostic detail about which host last used a token. If needed, `updatedBy` or an append-only audit note can track writer provenance without becoming identity.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

The current branch has Redis code, but it models credentials as:

```text
label policy + per-machine session + machine registry
```

Runtime uses a local machine id to build the credential view. Status renders a machine/session matrix. Migration imports sessions per source machine. Repair commands include `aim session handoff` and `aim label rebind --machine`.

## 2.2 What’s broken / missing (concrete)

- A shared Redis store should not ask which machine owns a credential.
- Filtering credentials by local machine recreates the old "this machine has it, that machine does not" bug.
- Importing remote sessions into Redis creates multiple apparent truths for the same label.
- `handoff` preserves the old copying model instead of deleting it.
- Status matrices make missing machine sessions look like real credential bugs.
- The implementation burden grows because every command has to reason about machines instead of reading one credential.

## 2.3 Constraints implied by the problem

- The fix must remove machine/session concepts from shared credential truth, not add a source-machine escape hatch.
- The migration must collapse legacy candidates into one best credential per provider/label.
- The bootstrap import can read this machine's current local sessions first, but those files are never a runtime source of truth after Redis import.
- Runtime projections must not need local machine credentials to exist before a label can be used.
- Compatibility with the machine/session Redis schema is not required; safe data migration is required.

<!-- arch_skill:block:research_grounding:start -->
# 3) Research Grounding (external + internal “ground truth”)

## 3.1 External anchors (papers, systems, prior art)

- Redis `WATCH` / `MULTI` / `EXEC` compare-and-set — adopt. It is enough for one-key credential updates and avoids Lua, daemons, or lock services.
- Redis strings and sets — adopt. JSON strings plus set indexes match the current repo pattern and avoid RedisJSON.
- Distributed ownership/lease patterns — reject for v1. The user intent is explicitly a shared credential store, not lease ownership.

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors:
  - `src/coordination/redis-store.js` — currently owns Redis key construction, `readSnapshot`, `publishLabel`, `publishSession`, `registerMachine`, `importSnapshot`, and CAS mutation. This is the canonical place to replace machine sessions with credential records.
  - `src/coordination/records.js` — currently normalizes `machine`, `label`, and `session` records. This is where `credential` normalization belongs.
  - `src/coordination/snapshot.js` — currently builds runtime state by filtering sessions to `machineId`; this is the central bug to remove.
  - `src/coordination/runtime.js` — currently registers the machine and publishes per-machine sessions. This must become the global credential runtime boundary.
  - `src/migration/redis-migration.js` — already collects candidates from legacy `secrets.json`, Codex auth, Claude native auth, Hermes, and OpenClaw. Its planner/apply layer must emit one credential per provider/label instead of sessions per machine.
  - `src/status/redis-view.js` — currently renders `redisMachines` and `redisSessionMatrix`. Status must become credential health and projection status.
  - `src/cli/commands/repair.js` and `src/cli/help.js` — currently expose machine-shaped repair commands. These must be removed or replaced with label-shaped repair only.
  - `test/cli/redis-projection-command.test.js`, `test/coordination/redis-store.test.js`, `test/migration/redis-migration.test.js`, and `test/cli/redis-repair-command.test.js` — current tests lock in the machine/session model and must be rewritten.
- Canonical path / owner to reuse:
  - `src/coordination/redis-store.js` remains the only raw Redis boundary.
  - `src/coordination/runtime.js` remains the command-facing runtime boundary.
  - `src/migration/redis-migration.js` remains the import planner/apply owner.
- Adjacent surfaces tied to the same contract family:
  - `README.md`, `src/cli/help.js`, `test/cli/readme-contract.test.js`, and superseded Redis docs must stop advertising sessions, handoff, or machine ownership.
  - Remote live Redis data under key prefix `aimgr:v1:` must be backed up, then old `label/session/machine` records must be deleted after this machine's local credential import is verified.
  - `~/.aimgr/config.yaml` remains durable connection config; no source-machine field may be added.
- Compatibility posture (separate from `fallback_policy`):
  - Clean cutover. The old file authority model and the machine/session Redis model are not compatibility modes.
- Existing patterns to reuse:
  - Existing CAS helper shape in `casPutJsonRecord`.
  - Existing fake Redis test clients.
  - Existing target projection tests that assert `~/.aimgr/secrets.json` is not rewritten.
  - Existing migration candidate validation and refresh-attempt scoring.
- Duplicate or drifting paths relevant to this change:
  - `registerMachine`, `normalizeMachineRecord`, `publishSession`, `sessionsByMachine`, and `findMachineSession` are duplicate truth paths for credentials and should disappear from runtime credential flow.
  - `aim session handoff` and `aim label rebind --machine` preserve the old model and must not survive as live repair commands.
- Auto-plan research pass:
  - Confirmed from repo inspection that the current implementation filters Redis credential material by `machineId` in `buildCoordinationView()` and publishes per-machine sessions from both login and watch/preserve flows. This is not an operator mistake; it is the current code model that the implementation plan must replace.
- Behavior-preservation signals already available:
  - `npm run lint`
  - `env -u CODEX_HOME npm test`
  - Targeted Redis tests for store, migration, projection, status, and repair commands.
  - Live Redis smoke against `redis://amirs-mac-studio:6380`.

## 3.3 Decision gaps that must be resolved before implementation

- none
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
# 4) Current Architecture (as-is)

## 4.1 On-disk structure

- `~/.aimgr/config.yaml` stores Redis connection metadata.
- `~/.aimgr/machine-id` stores a generated local machine id.
- `~/.aimgr/local-state.json` stores projection receipts and local target state.
- `~/.aimgr/secrets.json` is legacy input/archive only after Redis cutover.
- Redis currently stores `meta`, `machines`, `labels`, and `sessions` sets/records under the configured key prefix.
- During cutover, this machine's currently usable target auth files and legacy AIM files are read-only bootstrap inputs. They do not remain live sources after Redis import.

## 4.2 Control paths (runtime)

- `loadRedisRuntime()` reads config, connects to Redis, registers the current machine, reads a snapshot, then builds state for only `machine.machineId`.
- `buildCoordinationView()` copies label policy and only sessions matching the local machine id into runtime credentials.
- `publishMaintainedLabelSession()` and `publishRedisStateSession()` write label records plus a session record for the local machine.
- Target commands such as `codex use`, `pi use`, `auth write hermes`, `claude run`, and watch flows consume the local-machine credential view.
- Status reads Redis and renders a machine/session matrix.

## 4.3 Object model + key abstractions

Current Redis shared credential truth is split across:

```text
aimgr:v1:label:<provider>:<label>
aimgr:v1:session:<provider>:<label>:<machineId>
aimgr:v1:machine:<machineId>
```

That split makes `machineId` part of credential selection. It is the wrong abstraction for the desired shared store.

## 4.4 Observability + failure behavior today

- Status reports missing machine sessions, which are not meaningful in the desired model.
- CAS prevents stale writes to a specific record, but the specific record is still machine-shaped.
- If a different install has the only imported session for a label, another install cannot simply use it without a source-machine hack.
- Deep-dive pass 1 finding: the operational hazard is not just stale docs. Runtime, status, migration, repair commands, and tests all agree on the wrong abstraction, so implementation must converge the whole contract family in one clean cutover.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No UI work is in scope.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
# 5) Target Architecture (to-be)

## 5.1 On-disk structure (future)

- `~/.aimgr/config.yaml` keeps only durable Redis connection metadata:

```yaml
version: 1
redis:
  url: redis://amirs-mac-studio:6380
  keyPrefix: "aimgr:v1:"
  primaryHost: agents@amirs-mac-studio
  transport: tailscale
```

`url` is per-install connection metadata, not ownership. Remote clients use `redis://amirs-mac-studio:6380`. The Redis host itself, `agents@amirs-mac-studio`, uses `redis://127.0.0.1:6380` because it talks to its own local Docker/Colima Redis container. `redis://100.96.80.106:6380` remains the direct Tailnet IP fallback.

- `~/.aimgr/local-state.json` keeps only local projection receipts and local target preferences.
- `~/.aimgr/machine-id` is not part of credential identity, credential selection, credential writes, migration apply, repair, or projection. `aim redis configure`, `aim redis config`, `aim redis ping`, and Redis snapshots must not create, register, or return a credential machine id. If any non-credential diagnostic still needs a local install id, that work must be named separately and must not reuse Redis session/machine credential records.
- Redis stores global credentials:

```text
aimgr:v1:credential:<provider>:<label>
aimgr:v1:credentials
aimgr:v1:credentialsByProvider:<provider>
aimgr:v1:meta
```

## 5.2 Control paths (future)

All runtime paths follow one pattern:

```text
read credential:<provider>:<label> -> project local target files -> if tokens changed, CAS-write credential:<provider>:<label>
```

No runtime step asks which machine owns the credential.

## 5.3 Object model + abstractions (future)

The Redis credential record is:

```json
{
  "kind": "aimgr.credential.v1",
  "provider": "openai-codex",
  "label": "boss",
  "identity": {
    "accountId": "acct_123"
  },
  "credential": {
    "access": "...",
    "refresh": "...",
    "idToken": "...",
    "accountId": "acct_123",
    "expiresAt": "2026-05-30T20:00:00.000Z"
  },
  "policy": {
    "expect": {},
    "reauth": {},
    "browser": {},
    "pool": {
      "enabled": true
    }
  },
  "health": {
    "status": "ready",
    "reason": null
  },
  "provenance": {
    "lastSourceType": "migration",
    "lastSourcePath": "~/.codex/auth.json"
  },
  "createdAt": "2026-05-30T15:00:00.000Z",
  "updatedAt": "2026-05-30T15:30:00.000Z",
  "updatedBy": "amir-m5-9933d682",
  "version": 12
}
```

`updatedBy` and `provenance` are audit fields only. They are never credential identity, ownership, selection, routing, migration grouping, repair targeting, or projection targeting.

## 5.4 Invariants and boundaries

- `src/coordination/redis-store.js` owns all Redis keys and CAS writes.
- `src/coordination/runtime.js` owns command-facing credential reads/writes.
- `src/migration/redis-migration.js` owns legacy candidate collection and one-record-per-label import.
- Commands never publish machine sessions.
- Status never reports "missing session on this machine" as a credential failure.
- Repair commands never name a source machine. Identity repair is label/provider-shaped and updates the single credential record only after explicit confirmation.
- Deep-dive pass 2 hardening: writer provenance may stay as `updatedBy`, but only as an audit string on a credential record. No code path may use writer provenance to select, route, import, repair, or project credentials.

## 5.5 UI surfaces (ASCII mockups, if UI work)

No UI work is in scope.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
# 6) Call-Site Audit (exhaustive change inventory)

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| Redis keys | `src/coordination/redis-store.js` | `buildRedisKeys` | Defines `machines`, `labels`, `sessions`, `session:<provider>:<label>:<machineId>`, `sessionsByMachine` | Define `credential:<provider>:<label>`, `credentials`, `credentialsByProvider:<provider>`, and `meta`; remove credential use of machine/session keys | Makes Redis schema match one shared credential store | `publishCredential`, `readSnapshot`, `importCredentialsSnapshot` | `test/coordination/redis-store.test.js` |
| Redis records | `src/coordination/records.js` | `normalizeMachineRecord`, `normalizeLabelRecord`, `normalizeSessionRecord` | Credential data requires session `machineId`; label policy split from token material | Add `normalizeCredentialRecord`; keep only meta + credential records for shared truth | Credential identity is provider/label only | `aimgr.credential.v1` | `test/coordination/records.test.js` |
| Runtime view | `src/coordination/snapshot.js` | `buildCoordinationView`, `findMachineSession` | Filters credentials by local machine id | Build accounts and credentials from global credential records; delete `findMachineSession` | Any install can use the same Redis credential | Snapshot credentials are global | Projection/status tests |
| Runtime writes | `src/coordination/runtime.js` | `loadRedisRuntime`, `publishRedisStateSession`, `publishCodexPreserveResult` | Registers local machine and writes per-machine sessions | Stop registering machines; publish one credential record for provider/label | Removes ownership and source-machine paths | `publishRedisCredentialFromState` | Codex watch, Claude import/run tests where still applicable |
| Login writes | `src/coordination/login-publish.js` | `publishMaintainedLabelSession` | Publishes label plus per-machine session | Publish one credential record carrying policy + credential + identity | Login updates the central credential | `publishMaintainedCredential` | Login command tests |
| Login command | `src/cli/commands/login.js` | `performRedisLabelMaintenance`, panel persistence | Loads local-machine credential view and reports session versions | Load global credential view and report credential version | Login from any install updates same record | `redis.credentialVersion` | Redis login tests |
| Redis command | `src/cli/commands/redis.js` | `configure`, `config`, `ping`, `snapshot`, `export`, `import`, `migrate collect/apply` | Creates/returns machine ids, registers machines, imports labels/sessions/machines | Stop creating/registering machine records for admin commands; snapshot/export/import credential records; collect without requiring `--machine`; apply one credential per label | Admin surface must not recreate deleted machine keys | `aim redis migrate collect --out <bundle.json>` | Redis command + migration command tests |
| Command routing | `src/cli/main.js` | `COMMAND_HANDLERS` | Routes removed `session` repair surface if command stays registered | Remove or hard-error the session route so no live command reaches machine handoff behavior | Deleting help text is not enough if routing still exists | No `session` command surface | Repair/main command tests |
| Migration planner | `src/migration/redis-migration.js` | `buildRedisMigrationPlan`, `buildRedisSnapshotFromMigrationPlan`, `applyRedisMigrationPlan` | Groups candidates by machine, emits `sessions` and `machines` | Pick one selected credential per provider/label; keep source details as candidate provenance only | Prevents multiple Redis truths for one label | Plan has `credentials`, not `sessions` | Migration tests |
| Status | `src/status/redis-view.js` | `buildSessionMatrix`, `buildRedisSummary`, `buildRedisStatusView` | Reports machine count/session matrix | Report credential count/health and local projection drift only | Missing machine sessions are no longer meaningful | `redisCredentials` or credential summary | Status tests |
| Repair commands | `src/cli/commands/repair.js` | `handleLabel`, `handleSession` | `rebind --machine`, `session handoff --from --to` | Delete `session` repair and replace machine rebind with label/provider-shaped rebind | Machine repair is old model | `aim label rebind <label> --provider <provider> --confirm` | Repair tests |
| Browser policy | `src/cli/commands/browser.js` | `handleRedisBrowser` | Registers machine, builds machine-filtered state, publishes label policy | Read/update browser policy on the credential record; keep concrete local browser bindings in `local-state.json` | Browser policy is a Redis write path and must not preserve label/session split | Credential `policy.browser` plus local bindings | Browser/repair tests |
| Rebalance/projection | `src/cli/commands/rebalance.js` | `handleRebalance` | Uses `loadRedisRuntime`, so it inherits machine-filtered credentials | Verify rebalance commands read global credentials after runtime refactor | OpenClaw/Hermes projections must not drift | Global credential runtime | Rebalance tests |
| Target projections | `src/cli/commands/pi.js`, `src/cli/commands/auth.js`, `src/cli/commands/hermes.js`, `src/cli/commands/claude.js`, `src/cli/commands/codex.js` | `handlePi`, `handleAuth`, `handleHermes`, `handleClaude`, `handleCodex` | Consume `loadRedisRuntime` state and can inherit machine-filtered credentials | Verify every in-scope target projection reads global credentials and writes only local projections or credential CAS updates | Prevents hidden old-model runtime targets | Global credential runtime | Projection/watch tests |
| Old authority commands | `src/cli/commands/apply.js`, `src/cli/commands/sync.js`, `src/cli/commands/promote.js`, `src/cli/commands/internal.js` | `handleApply`, `handleSync`, `handlePromote`, `handleInternal` | Hard-error surfaces may still mention authority, machines, or sessions | Keep removed as live behavior and rewrite error text to point to shared Redis credentials without source-machine/session language | Avoids teaching old model through dead commands | Removed-command guidance only | Legacy command tests |
| Help | `src/cli/help.js` | command lines/options | Advertises `--machine`, handoff, session repair | Remove machine-shaped surfaces; keep Redis config and migration surfaces | Operator contract must match reality | Shared credential commands only | README/help parity |
| README | `README.md` | setup/runtime/state model | Describes sessions by machine and machine metadata | Describe shared credentials and local projections | Live docs must not preserve old mental model | Credential store docs | README contract |
| Tests | `test/cli/redis-projection-command.test.js` | seed helpers and assertions | Seed per-machine sessions | Seed one credential and prove multiple homes use/update it | Proves no ownership | Global credential fixtures | Projection tests |
| Tests | `test/cli/redis-repair-command.test.js` | handoff tests | Enforces handoff behavior | Remove handoff tests; add label-shaped identity repair if needed | Handoff must disappear | No session repair | Repair tests |
| Tests | `test/cli/redis-command.test.js` | configure/config/ping/snapshot assertions | Expects machine id creation/registration on Redis admin commands | Assert admin commands report shared credential config/status without machine ids | Prevents old model from returning through config UX | Credential-shaped Redis admin output | Redis command tests |
| Live data | Redis `aimgr:v1:*` | existing production keys | May contain `session:*`, `sessions`, `machines` | Backup old keys, import this machine's local credential snapshot, delete old keys after verification | Avoid two Redis schemas and avoid treating old Redis as import authority | One live Redis schema | Live smoke |
| Remote installs | local repos/wrappers on all machines | global `aim` install | Some installs may run old build | Pull new build, reinstall wrapper, configure same Redis, smoke test | All clients must speak same schema | Same `aimgr:v1:` credential keys | Live smoke |

## 6.2 Migration notes

- Canonical owner path / shared code path: `src/coordination/redis-store.js`, `src/coordination/runtime.js`, and `src/migration/redis-migration.js`.
- Deprecated APIs: `registerMachine` as any Redis credential/admin behavior, `publishLabel`, `publishSession`, `findMachineSession`, `buildSessionMatrix`, `aim session handoff`, `aim label rebind --machine`, `aim redis migrate collect --machine`, and old authority/sync/promote/apply guidance that implies machine/source ownership.
- Delete list: Redis machine/session key helpers, machine/session record normalizers, session handoff command, machine-shaped CLI help/docs, per-machine migration plan output, per-machine projection fixtures.
- Adjacent surfaces tied to the same contract family: README, CLI help, args parser, main command router, readme-contract test, Redis command tests, browser policy tests, Redis plan docs, migration bundles/plans, live Redis `aimgr:v1:` data.
- Compatibility posture / cutover plan: breaking clean cutover. Migration converts data; runtime does not support both schemas.
- Live docs/comments/instructions to update or delete: README, superseded docs, command help, comments that call session/machine an ownership boundary.
- Behavior-preservation signals for refactors: targeted Redis tests, full `env -u CODEX_HOME npm test`, live Redis smoke on all installs.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope |
| ---- | ------------- | ---------------- | ---------------------- | -------------- |
| Redis mutation | `casPutJsonRecord` | Keep one CAS helper for credential records | Avoids command-local Redis writes | include |
| Candidate import | `buildRedisMigrationPlan` | Keep candidate scoring/refresh, change output shape | Preserves non-lossy migration without machine ownership | include |
| Projection state | `writeRedisLocalStateFromView` | Keep local projection receipts separate from credentials | Prevents local state from becoming shadow truth | include |
| Browser policy | `buildSharedBrowserPolicy` + local bindings | Store shared policy on credential, local concrete paths in local state | Avoids machine identity while preserving local browser path differences | include |
| Claude-specific runtime | `src/cli/commands/claude.js` | Keep only generic provider behavior needed by existing code | User does not use Claude; avoid plan expansion | defer any nonessential Claude-specific work |
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: depth-first implementation protects the full destination while proving the path early. Treat TL;DR, Section 0, Sections 5-6, and approved decisions as the destination map: they preserve final known scope, not a Phase 1 checklist. Section 7 should choose the first working slice that proves one real path through the canonical owner path, highest-risk seam, compatibility or migration posture, and verification shape. Later phases expand along named axes from that proof. Phase boundaries are proof gates: each phase must create evidence that later work can safely rely on. Before a phase plan is valid, run an obligation sweep and either place required work in the current phase, assign it to a named later phase in the expansion map, or stop for an explicit user decision; do not hide unresolved branches. Phase count is an outcome of dependency edges, proof gates, reversibility or migration boundaries, and user-review boundaries; split only when a phase blends separately provable units. `Work` explains the unit and is explanatory only for modern docs. `Checklist (must all be done)` is the authoritative must-do list inside the phase. `Exit criteria (all required)` names the exhaustive concrete done conditions the audit must validate. Refactors, consolidations, and shared-path extractions must preserve existing behavior with credible evidence proportional to the risk. No fallbacks/runtime shims - the system must work correctly or fail loudly (delete superseded paths). If a bridge is explicitly approved, timebox it and include removal work; otherwise plan either clean cutover or preservation work directly. Prefer programmatic checks per phase; defer manual verification to finalization. Avoid negative-value tests and heuristic gates. Also: document new patterns/gotchas in code comments at the canonical boundary only where a short comment prevents future reintroduction of machine ownership.

## Phase 1 - Credential Store Spine

* Goal:
  * Replace the Redis store and record model with global credential records while keeping a narrow fake-Redis test path green.
* Work:
  * This phase proves the core schema and CAS boundary before any command migration.
* Checklist (must all be done):
  * Add `normalizeCredentialRecord` for `aimgr.credential.v1`.
  * Replace credential truth keys with `credential:<provider>:<label>`, `credentials`, and `credentialsByProvider:<provider>`.
  * Add `publishCredential` and credential snapshot reads.
  * Remove `publishSession`, `sessionsByMachine`, and machine registration from shared credential store APIs used by credential runtime and Redis admin commands.
  * Update store tests to prove create, update, stale-version rejection, import/export, and one key per provider/label.
  * Update Redis admin tests so configure/config/ping/snapshot no longer create, register, or return credential machine ids.
* Verification (required proof):
  * `node --test test/coordination/redis-store.test.js test/coordination/records.test.js`
* Docs/comments (propagation; only if needed):
  * Add one short comment at the Redis key builder if helpful: credential keys must not include machine identity.
* Exit criteria (all required):
  * Tests can create/update a credential without any machine id.
  * No credential store test expects a session id containing a machine id.
  * The Redis store API has one obvious write path for shared credentials.
* Rollback:
  * Revert Phase 1 code/tests before touching runtime command paths.

## Phase 2 - Runtime Projection Uses One Credential

* Goal:
  * Make one real runtime path, `aim codex use <known-valid-label>`, project from a global Redis credential with no local-machine credential filter.
* Work:
  * This is the first end-to-end slice through the real command boundary.
* Checklist (must all be done):
  * Rewrite `buildCoordinationView` to load credentials from global credential records.
  * Rewrite `loadRedisRuntime` to stop registering machines for credential runtime.
  * Update `aim codex use` path to consume the global credential view.
  * Update `aim pi use`, `aim auth write hermes`, `aim rebalance openclaw`, `aim rebalance hermes`, and any retained watch/projection path that uses `loadRedisRuntime` to consume the same global credential view.
  * Rewrite `buildRedisStatusView` to report credential count/health and local projection drift, not machine/session matrices.
  * Add a test where two different temp homes use the same Redis credential without seeding two machine rows.
  * Keep local target files and `local-state.json` as projections only.
* Verification (required proof):
  * `node --test test/cli/redis-projection-command.test.js test/status/redis-view.test.js`
* Docs/comments (propagation; only if needed):
  * None unless touched comments still describe local-machine sessions.
* Exit criteria (all required):
  * A second temp home can use a Redis credential created by the first temp home without session cloning or handoff.
  * Codex, Pi, Hermes auth write, and rebalance projections read global credentials.
  * Status has no machine/session matrix and no missing-machine-session warning.
  * Projection writes no shared credential material to `~/.aimgr/local-state.json`.
  * No runtime projection path filters credentials by `machineId`.
* Rollback:
  * Revert runtime/snapshot changes and tests if projection breaks before command expansion.

## Phase 3 - Runtime Writes Update The Same Credential

* Goal:
  * Make login, Codex watch, and maintained-label writes update the same global credential record.
* Work:
  * This phase closes the read/write loop and proves any install can mutate the central credential.
* Checklist (must all be done):
  * Replace `publishMaintainedLabelSession` with credential-shaped publish logic.
  * Replace `publishRedisStateSession` with credential-shaped publish logic.
  * Update login/manual callback/panel persistence to report credential version, not label/session versions.
  * Move `aim browser set/show` Redis behavior to credential policy reads/writes, with concrete local browser paths still stored only in local state.
  * Update Codex watch/tend preservation tests to assert the same credential key changes.
  * Update browser policy tests so they assert credential policy writes, not label writes.
  * Preserve identity mismatch protection before write.
* Verification (required proof):
  * `node --test test/cli/redis-login-command.test.js test/cli/redis-projection-command.test.js`
* Docs/comments (propagation; only if needed):
  * None unless touched comments still describe sessions as credential truth.
* Exit criteria (all required):
  * Refresh from one temp home updates the credential read by another temp home.
  * Stale credential writes fail with Redis stale-version behavior.
  * Login writes no per-machine session record.
  * Browser policy writes no label/session/machine records.
* Rollback:
  * Revert write-path changes while keeping Phase 1/2 if they remain green, or revert all Redis credential changes if needed.

## Phase 4 - Migration Collapses Candidates Into Credentials

* Goal:
  * Preserve this machine's existing usable data while converting local legacy/session sources into one Redis credential per provider/label.
* Work:
  * This phase replaces the non-lossy migration output shape without keeping source ownership.
* Checklist (must all be done):
  * Remove mandatory `--machine` from migration collect; if source id is recorded, keep it as provenance only.
  * Read this machine's currently usable local sessions as the bootstrap candidate source.
  * Change migration plans from `labels + sessions + machines` to selected `credentials` plus candidate audit fields.
  * For each provider/label, choose one best fresh candidate after refresh attempts.
  * Block identity conflicts.
  * Mark already invalid/unrefreshable labels as re-login required.
  * Treat existing Redis `session:*`, `label:*`, and `machine:*` rows as old-schema debris for backup and cleanup only, not as import candidates.
  * Emit a migration report that names selected, superseded, blocked-conflict, and invalid/relogin candidates without turning source host/path into ownership.
  * Produce the conversion/delete path for existing live `aimgr:v1:` session/machine keys, but do not delete production old keys until Phase 6 fleet verification.
  * Archive old `~/.aimgr/secrets.json` files without using them as runtime state.
* Verification (required proof):
  * `node --test test/migration/redis-migration.test.js test/cli/redis-migration-command.test.js`
  * Live Redis export before and after conversion.
* Docs/comments (propagation; only if needed):
  * Migration command docs and README migration section.
* Exit criteria (all required):
  * Migration apply writes one credential per provider/label.
  * Plan output explains every old candidate.
  * No currently usable Codex credential is dropped or turned into planned re-login.
  * This machine's currently usable sessions have been imported or explicitly reported as invalid/conflicting.
  * Existing Redis `session:*` rows are backed up and handled as cleanup-only old-schema debris, not import candidates or runtime fallback records.
  * The migration code can produce a post-conversion Redis snapshot with one credential per provider/label and no machine/session credential truth in a test prefix.
* Rollback:
  * Restore from Redis export and archived legacy files before deleting old local archives.

## Phase 5 - Delete Machine-Shaped Commands And Docs

* Goal:
  * Remove operator-facing surfaces that would teach the old model.
* Work:
  * This phase clears stale live truth from commands, help, README, and tests.
* Checklist (must all be done):
  * Delete `aim session handoff` from the live command surface.
  * Remove `session` routing from `src/cli/main.js` unless the route exists only to emit removed-command guidance with no handoff implementation.
  * Replace `aim label rebind --machine` with `aim label rebind <label> --provider <provider> --confirm`.
  * Remove stale parser options that only existed for removed machine-shaped commands, including `--machine`, `--from`, and `--to`, unless another non-credential command still owns them.
  * Keep `aim apply`, `aim sync`, `aim promote`, and `aim internal apply-*` removed as live behavior and rewrite their error text so it points to shared Redis credentials without authority/source-machine/session language.
  * Remove machine-shaped Redis help options and README command examples.
  * Update `test/cli/readme-contract.test.js`.
  * Mark old plan docs superseded by this plan and remove active machine/session claims from live docs.
* Verification (required proof):
  * `node --test test/cli/redis-repair-command.test.js test/cli/readme-contract.test.js`
  * `npm run lint`
* Docs/comments (propagation; only if needed):
  * README, CLI help, superseded Redis docs.
* Exit criteria (all required):
  * No user-facing command asks for a source machine to repair or select a credential.
  * `aim session handoff` is not a supported command.
  * Old authority/sync/promote/apply errors do not describe a live authority, source machine, or machine session model.
  * README state model says credentials, not sessions by machine.
  * The current plan remains the only active Redis credential architecture doc.
* Rollback:
  * Restore command docs only if code rollback also restores the machine/session schema.

## Phase 6 - Full Verification And Fleet Cutover

* Goal:
  * Prove the same shared credential store works from every AIM install.
* Work:
  * This phase deploys and checks the completed code across the four known installs.
* Checklist (must all be done):
  * Run `env -u CODEX_HOME npm test` locally.
  * Commit and push the final implementation.
  * Pull/reinstall on this machine, `home`, `agents@amirs-mac-studio`, and `amirs-m3-max-new`.
  * Ensure every install has the same durable Redis config values.
  * Run `aim redis ping`, `aim status --json`, and `aim codex use pro10` on each install for the current cutover, because `pro10` is the known-valid imported Codex credential.
  * Run at least one non-Codex projection smoke from the retained target set (`aim pi use` or `aim auth write hermes pro10 --auth-file <tmp-auth-file>`) against the same Redis credential.
  * Trigger or simulate one refresh/update from one install and confirm another install reads the updated credential.
  * Confirm old live `~/.aimgr/secrets.json` files are absent or archived.
  * Delete old production Redis `session:*`, `sessions`, `machine:*`, and `machines` keys only after every install is on the new build and the shared credential smoke passes.
* Verification (required proof):
  * Local full test run.
  * Remote smoke command outputs summarized in the worklog.
  * Redis snapshot showing one credential row per provider/label.
* Docs/comments (propagation; only if needed):
  * Worklog with deployment evidence.
* Exit criteria (all required):
  * All installs use/update the same Redis credential keys.
  * No install requires re-login for currently usable Codex accounts because of the migration.
  * No live runtime path depends on machine-owned sessions.
  * Live Redis no longer contains credential-truth `session:*`, `sessions`, `machine:*`, or `machines` keys after fleet cutover verification.
* Rollback:
  * Use Redis backup/export and archived legacy files. Because runtime compatibility is forbidden, rollback means reverting the deployed build and restoring the old data as a whole, not running both models together.

## Obligation Sweep

- Store/schema replacement is required in Phase 1.
- Runtime read path convergence, target projections, and status rewrite are required in Phase 2.
- Runtime write path convergence, including browser policy writes, is required in Phase 3.
- Non-lossy one-credential migration is required in Phase 4.
- This machine's usable local sessions are bootstrap import input in Phase 4; they are not a runtime source after import.
- Command/help/docs cleanup and old authority error cleanup are required in Phase 5.
- Fleet deployment and production Redis old-key deletion are required in Phase 6.
- No required implementation obligation remains only in Section 5, Section 6, migration notes, docs/comments, or this sweep.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

Avoid verification bureaucracy. The useful checks are behavior checks that prove one shared Redis credential row is read and written correctly. When a phase lists one of these checks as required proof, it is required for that phase; "non-blocking" means this section does not add extra ceremony outside the phase checklist.

## 8.1 Unit tests (contracts)

- Redis store tests for credential key construction, CAS create/update, stale-version rejection, import/export, and snapshot reads.
- Record normalization tests for `aimgr.credential.v1`.
- Migration planner tests for best candidate selection, refresh-before-relogin, identity conflict blocking, and one output credential per provider/label.

## 8.2 Integration tests (flows)

- CLI projection test where two temp homes use the same Redis credential.
- CLI watch/login test where one temp home updates a credential and another temp home reads the update.
- README/help parity test after command surface cleanup.
- Status test for credential health and local projection drift without machine/session matrix.

## 8.3 E2E / device tests (realistic)

- Live Redis smoke on `redis://amirs-mac-studio:6380`.
- `aim codex use pro10` from this machine, `home`, `agents@amirs-mac-studio`, and `amirs-m3-max-new`.
- One non-Codex projection smoke from the retained target set.
- One cross-install update/readback check.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

1. Export current Redis `aimgr:v1:` data.
2. Back up all old local AIM credential files and target auth files.
3. Apply the schema/data conversion to one credential record per provider/label.
4. Deploy the new build to all installs before normal use resumes.
5. Run live smoke checks on every install.
6. Delete or archive old local `secrets.json` files and old Redis machine/session keys only after verification.

## 9.2 Telemetry changes

No new telemetry system is required. Status should report credential count, provider/label health, Redis connection metadata, and local projection state.

## 9.3 Operational runbook

Expected config on remote-client installs:

```yaml
version: 1
redis:
  url: redis://amirs-mac-studio:6380
  keyPrefix: "aimgr:v1:"
  primaryHost: agents@amirs-mac-studio
  transport: tailscale
```

Expected config on the Redis host itself:

```yaml
version: 1
redis:
  url: redis://127.0.0.1:6380
  keyPrefix: "aimgr:v1:"
  primaryHost: agents@amirs-mac-studio
  transport: tailscale
```

The direct Tailnet fallback is `redis://100.96.80.106:6380`.

Normal checks:

```bash
aim redis config
aim redis ping
aim status --json
aim codex use pro10
```

If Redis is unavailable, do not mutate credentials locally. Fix Redis connectivity or restore from the last Redis backup/export.

<!-- arch_skill:block:consistency_pass:start -->
## Consistency Pass
- Reviewers: explorer 1, explorer 2, self-integrator, composer-2.5-fast fresh consult
- Scope checked:
  - TL;DR, North Star, target architecture, call-site audit, phase plan, verification, rollout, and decision log all describe one shared Redis credential store with no owner model.
  - Runtime read/write paths, migration, Redis admin commands, repair commands, status, CLI routing, docs, tests, and live Redis cleanup are assigned to Section 7 phases.
  - The bootstrap path imports this machine's existing usable sessions into Redis without leaving local files as a second source of truth.
- Findings summary:
  - The plan is implementation-ready and aligned on one `credential:<provider>:<label>` record as the shared truth.
  - Explorer and Composer notes found only specification gaps, not architectural blockers.
- Integrated repairs:
  - Removed hidden compatibility language and strengthened the ban on source-machine, per-machine session, handoff, and dual-schema behavior.
  - Added explicit coverage for browser policy writes, Redis admin machine-id removal, CLI `session` routing, old authority error text, non-Codex projections, and Redis command tests.
  - Moved production deletion of old Redis machine/session keys to fleet cutover after verification.
  - Added explicit migration handling for this machine's bootstrap sessions, with existing Redis `session:*` rows kept cleanup-only so Redis cannot become a second import authority.
- Remaining inconsistencies:
  - none
- Unresolved decisions:
  - none
- Unauthorized scope cuts:
  - none
- Decision-complete:
  - yes
- Decision: proceed to implement? yes
<!-- arch_skill:block:consistency_pass:end -->

# 10) Decision Log (append-only)

## 2026-05-30 - Replace machine sessions with shared credentials

Context

The previous Redis implementation preserved machines, per-machine sessions, handoff, and source-machine thinking. The user clarified that this was the wrong abstraction: a shared Redis store should simply hold credentials that any attached install can use and update.

Options

- Keep per-machine sessions and configure a canonical source machine.
- Keep per-machine sessions and import every machine's local rows.
- Replace sessions/machines with one shared credential record per provider/label.

Decision

Use one shared Redis credential record per provider/label. Machines may appear only as writer provenance, never as credential identity, routing, ownership, or selection.

Consequences

- The current machine/session Redis code must be replaced, not extended.
- Existing live Redis data must be converted or deleted after backup.
- `aim session handoff`, `sessionsByMachine`, and machine-shaped repair/help/docs must go away.

Follow-ups

- Run `arch-step auto-plan` receipts against this doc.
- Get a fresh Composer 2.5 Fast read before implementation starts.

## 2026-05-30 - Clean cutover, no compatibility bridge

Context

The user explicitly does not want multiple ways of doing credential coordination.

Options

- Keep old authority files as fallback.
- Support both Redis machine sessions and Redis credentials for a transition.
- Convert once and run only the new Redis credential model.

Decision

Convert once and run only the new Redis credential model.

Consequences

- Migration quality is release-blocking.
- Runtime fallback policy stays forbidden.
- Rollback is whole-build/data rollback, not dual-mode operation.

Follow-ups

- Preserve exports/backups before deleting old local files or Redis keys.

## 2026-05-30 - This-machine bootstrap is the import authority

Context

Live Redis already contained old `label/session/machine` rows, but the user clarified that this machine already had the sessions that should seed the new store. Treating old Redis rows as import candidates would recreate a competing source of truth during cutover.

Options

- Merge old Redis `session:*` rows into the new credential import.
- Import from this machine's local AIM/session snapshots, then delete old Redis machine/session keys after verification.

Decision

Use this machine's local AIM/session snapshots as the one-time bootstrap import source. Old Redis machine/session rows are backup-and-cleanup material only.

Consequences

- `aim redis migrate collect` must not read old Redis rows as credential candidates.
- The hard cutover writes `credential:<provider>:<label>` rows from the local bootstrap plan.
- Legacy Redis keys stay in place only until fleet smoke passes, then `cleanup-legacy` deletes them.

Follow-ups

- Keep the regression test that proves legacy Redis rows do not become migration candidates.
