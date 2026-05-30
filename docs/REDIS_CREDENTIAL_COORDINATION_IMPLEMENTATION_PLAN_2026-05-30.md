---
title: "AIMGR - Redis Credential Coordination - Architecture Plan"
date: 2026-05-30
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [composer-2.5-fast]
doc_type: architectural_change
related:
  - docs/three-machine-credential-coordination-investigation-2026-05-30.md
---

# TL;DR

## Outcome

Implement the Redis-backed AIM coordination architecture from `docs/three-machine-credential-coordination-investigation-2026-05-30.md`: one Redis/Valkey primary on `agents` at Amir's Mac Studio over Tailscale becomes the only shared credential state for the three-machine pool.

## Problem

`aimgr` currently keeps durable account truth in per-machine `~/.aimgr/secrets.json` files and moves data with `sync` / `promote` authority flows. That creates stale replicas, dirty imported state, SSH coordination, hidden "which machine has truth?" decisions, and real risk of losing the freshest credential during manual coordination.

## Approach

Make a breaking clean cutover. Add Node/JS Redis coordination code using the official `redis` npm client and `WATCH` / `MULTI` / `EXEC` compare-and-set transactions. Add local AIM config in `~/.aimgr/config.yaml`, collect all legacy credentials from all three machines before cutover, import the combined best state into Redis, then route status, login, selection, watches, and target projection through Redis as the only shared source of truth.

## Plan

1. Build the Redis config and store boundary.
2. Build a non-lossy migration collector/planner/apply path before any runtime cutover.
3. Move status and account operations to Redis snapshots and sessions.
4. Move target projections and watch/tend flows to Redis-backed session writes.
5. Delete or hard-disable the old authority/consumer live path and update operator docs/tests.

## Non-negotiables

- No Lua, no daemon, no required local agents, no custom HTTP service.
- No second live way to coordinate credentials after cutover.
- No dual-write bridge between Redis and old authority files.
- No planned mass re-login; re-login after migration is acceptable only for credentials that were already invalid, unreadable, identity-conflicted, or provider-rejected.
- Having to re-login to a pile of currently usable Codex accounts after cutover is a release-blocking migration failure.
- Redis is the only shared home; local target files are projections only.
- Old `sync` / `promote` / `apply` duplicate coordination surfaces are removed as operating modes, not preserved as compatibility.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-05-30
external_research_grounding: not required 2026-05-30; repo inspection plus standard Redis transaction primitives are sufficient for this implementation plan
deep_dive_pass_2: done 2026-05-30
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

<!-- arch_skill:block:auto_plan_receipts:start -->
{
  "version": 1,
  "digest": "sha256:345a21360df7ad4e01e6729a8b3a2ee9a71d1f396e3f47e60f44dddbd5c19c25",
  "receipts": [
    {
      "stage": "research",
      "command": "research",
      "status": "complete",
      "started_at": "2026-05-30T12:14:35Z",
      "command_ref_hash": "sha256:5ad5dc9efcb3c7d0d42e1d9014e3ee66fd24b8d2f1c85eef2c5ee96543e05c96",
      "doc_hash_before": "sha256:885c7f9c4e6b1ccbf0c0bee0765eb3f6e9c753105b367f95471a70a2d214a5d6",
      "completed_at": "2026-05-30T12:15:06Z",
      "doc_hash_after": "sha256:fe234c18175610ae8ae442a738f0979cd90453fdce6d349bffafaa3275da580c"
    },
    {
      "stage": "deep-dive-pass-1",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T12:15:09Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:fe234c18175610ae8ae442a738f0979cd90453fdce6d349bffafaa3275da580c",
      "completed_at": "2026-05-30T12:16:13Z",
      "doc_hash_after": "sha256:f56f3c8e6ef28cccbb3dee138b69268a26c2a2b014c73ec22d28b8f1481b748a"
    },
    {
      "stage": "deep-dive-pass-2",
      "command": "deep-dive",
      "status": "complete",
      "started_at": "2026-05-30T12:16:16Z",
      "command_ref_hash": "sha256:c06af6026c9d59dec9c11dae8319ead3a2864dd67c05a2b8b07392ce1c62597a",
      "doc_hash_before": "sha256:f56f3c8e6ef28cccbb3dee138b69268a26c2a2b014c73ec22d28b8f1481b748a",
      "completed_at": "2026-05-30T12:16:34Z",
      "doc_hash_after": "sha256:f45197633c3b4c0993b6fd9b3eeb8b069f7d2ba31c4c05c4674d65b4314d0dbc"
    },
    {
      "stage": "phase-plan",
      "command": "phase-plan",
      "status": "complete",
      "started_at": "2026-05-30T12:16:37Z",
      "command_ref_hash": "sha256:1ce4687beab44819933a8a404a02b8e1345823a7a996f7d651f3dd25a0c54aa3",
      "doc_hash_before": "sha256:f45197633c3b4c0993b6fd9b3eeb8b069f7d2ba31c4c05c4674d65b4314d0dbc",
      "completed_at": "2026-05-30T12:17:43Z",
      "doc_hash_after": "sha256:228fb774b860dd4bfb473de4bdfaf6b9e9841bd9470607262ca18619403cd3ce"
    },
    {
      "stage": "consistency-pass",
      "command": "consistency-pass",
      "status": "complete",
      "started_at": "2026-05-30T12:17:45Z",
      "command_ref_hash": "sha256:439e1ccf2a90587bbec572e8bf46c4e08f16c9c81c75fcf835f736db479d3d74",
      "doc_hash_before": "sha256:228fb774b860dd4bfb473de4bdfaf6b9e9841bd9470607262ca18619403cd3ce",
      "completed_at": "2026-05-30T12:18:30Z",
      "doc_hash_after": "sha256:fb60be6fbdc65f4fc1a165a675e601a2f879382490ea1bf7fb1e8fed3584c2b9"
    }
  ]
}
<!-- arch_skill:block:auto_plan_receipts:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After implementation and cutover, all normal AIM commands that read or mutate shared account state use Redis/Valkey at the configured Mac Studio primary. Running the old authority sync/promote model is not possible as a live coordination mechanism. Existing usable Codex/Claude credentials from the three machines are imported into Redis without requiring a planned re-login wave.

## 0.2 In scope

- Add `~/.aimgr/config.yaml` support for Redis endpoint, key prefix, primary host, and Tailscale transport metadata.
- Add a stable machine id under `~/.aimgr/machine-id`.
- Add explicit machine-local non-credential state under `~/.aimgr/local-state.json` so old `secrets.json` does not survive as a shadow shared store.
- Add Redis/Valkey store code in JavaScript using `WATCH` / `MULTI` / `EXEC`.
- Add Redis admin commands: configure, config, ping, snapshot, export, import, and migration subcommands.
- Add Redis-era repair commands for identity rebind and explicit session handoff.
- Add a read-only migration flow that collects candidates from all three machines before apply.
- Import legacy state and target auth files into Redis labels and sessions.
- Route status, login, panel maintenance, browser policy, Codex, Claude, Pi, Hermes, OpenClaw, watches, and tend flows through Redis-backed labels/sessions.
- Remove or hard-disable old authority/consumer live behavior.
- Update README/help/tests so the operator-facing contract matches the new world.

## 0.3 Out of scope

- Redis HA, multi-primary, multi-datacenter replication, or failover.
- Security hardening beyond Tailscale/private network assumptions.
- RedisJSON, Lua/server-side Redis code, a custom HTTP service, or a required AIM daemon.
- Keeping the old file-authority coordination model as a compatibility mode.
- Guaranteeing that already-running Codex/Claude/Pi processes hot-swap credentials mid-process.
- Manufacturing independent provider token lineages from cloned rotating refresh tokens.

## 0.4 Definition of done (acceptance evidence)

- `aim redis configure`, `aim redis config`, `aim redis ping`, and `aim redis snapshot` work against a configured Redis primary.
- Migration can collect from three machine bundles, produce a deterministic plan, apply to an empty Redis prefix, and explain every candidate it did or did not import.
- Migration tests prove usable Codex/Claude credentials are preserved and that identity conflicts fail loud instead of overwriting labels.
- Migration attempts a controlled refresh/import for expired-but-refreshable candidates before marking any label as re-login-required.
- A migration plan that would force re-login for currently usable Codex/Claude accounts blocks cutover until the underlying candidate/refresh issue is fixed.
- Status reads Redis and renders the fleet/session matrix plus local projection drift.
- Login and credential refresh publish this machine's session to Redis with compare-and-set.
- Codex, Claude, Pi, Hermes, OpenClaw, watch, and tend flows consume Redis sessions and publish local rotations before exit.
- Old `sync codex`, `promote codex`, `sync claude`, `promote claude`, `sync openclaw`, `apply`, and `internal apply-*-promotion` authority flows do not operate as live state mutation paths.
- README/help and public command contract tests reflect Redis mode.
- `npm run lint`, `npm test`, and targeted Redis/migration tests pass.

## 0.5 Key invariants (fix immediately if violated)

- Redis is the only shared credential state after cutover.
- `~/.aimgr/secrets.json` is never live shared truth after cutover.
- `~/.aimgr/local-state.json` may contain only local projection receipts, local target assignments, demand/usage history, and machine-specific browser bindings; it may not contain shared credentials.
- Local `~/.codex`, `~/.claude`, Hermes, OpenClaw, and Pi auth files are projections.
- No stale local cache may drive pool selection or mutating commands.
- Every shared mutation is conditional on a Redis record version.
- Provider identity mismatch fails before writing.
- Same refresh-token lineage is not treated as independent on multiple machines.
- If Redis is unavailable, mutating commands fail loud.
- `aim internal apply-codex-promotion` and `aim internal apply-claude-promotion` are not back doors for file/SSH authority writes.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Preserve existing usable credentials during migration.
2. Remove the old authority/consumer operating model cleanly.
3. Keep the implementation simple and idiomatic for this Node ESM CLI.
4. Make concurrency correctness real at the Redis write boundary.
5. Keep target tools as projections rather than new sources of truth.
6. Keep operational setup concrete: one primary on `agents` over Tailscale.

## 1.2 Constraints

- The repo is Node ESM and already uses local dependency injection in CLI handlers and tests.
- Current state schema is JSON, normalized through `src/state/schema.js`.
- Current auth projection writers already fail loud on target readback mismatch.
- Redis is reachable over Tailscale; local development/tests may not always have a real Redis server.
- Migration must be non-lossy before cutover, but the runtime design must not carry a dual-write bridge.

## 1.3 Architectural principles (rules we will enforce)

- Add one canonical Redis coordination boundary; commands do not hand-roll Redis keys.
- Use JavaScript transaction helpers, not Lua or server-side code.
- Use clean cutover semantics; importers may read old state, but runtime writers do not keep old state alive.
- Preserve existing projection writer behavior by rerouting their credential source, not by rewriting target file formats.
- Delete or hard-disable old live authority behavior as soon as migration apply is proven.
- Prefer existing behavior-level tests and CLI tests over repo-policing checks.

## 1.4 Known tradeoffs (explicit)

- A single Redis primary is operationally simpler but becomes the shared dependency. This is acceptable for the Tailscale three-machine pool.
- Snapshots are cheap full reads instead of streams/deltas. This is acceptable at three-machine scale.
- Migration can preserve copied token lineages but cannot make provider-invalidated clones safe for concurrent refresh.
- Some old authority metadata remains useful only inside migration reports, not as live runtime state.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

`aimgr` has one-file local state at `~/.aimgr/secrets.json`. Commands load and rewrite that file through `loadAimgrState()` and `writeJsonFileWithBackup()`. Shared pool coordination is modeled as an authority AIM file plus consumer replicas imported by `aim sync codex` / `aim sync claude` and pushed back by `aim promote codex` / `aim promote claude`.

## 2.2 What’s broken / missing (concrete)

- Different machines can each have a fresher credential for a different label.
- The old authority file is not always the true freshest source after local refresh or target rotation.
- Dirty import metadata protects some overwrites but also exposes how manual the model is.
- SSH sync/promote makes the operator decide where truth lives.
- The model encourages compatibility burden instead of a single coordination contract.

## 2.3 Constraints implied by the problem

- Migration must inspect all three machines before selecting import winners.
- Runtime coordination must not depend on a local file being current.
- The new design needs hard conflict behavior, not "best effort" overwrites.
- The old authority code must either become read-only migration support or be removed.

# 3) Research Grounding (external + internal “ground truth”)

<!-- arch_skill:block:research_grounding:start -->
## 3.1 External anchors (papers, systems, prior art)

- Redis transactions — adopt `WATCH` / `MULTI` / `EXEC` optimistic transactions for record-level compare-and-set. This keeps atomic mutation in ordinary Redis primitives and ordinary Node client code.
- Redis persistence — adopt append-only persistence for the Mac Studio primary because Redis becomes durable AIM state, not a cache.
- Tailscale private addressing — adopt the existing "private network is enough for this phase" assumption. Do not add an HTTP service or security sidecar to solve a non-goal.
- Rotating OAuth refresh-token behavior — adopt the investigation doc's one-live-lineage rule. Redis CAS prevents lost writes; it does not make cloned provider refresh tokens independent.

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors:
  - `package.json` — repo is Node ESM on `node >=20`; dependencies currently include `yaml`, so AIM config should be YAML and Redis code should be JavaScript.
  - `src/cli/main.js` — one command dispatcher owns the public CLI command routing.
  - `src/cli/args.js` — option parsing is local and explicit; Redis/migration flags should be added here, not hidden in env-only behavior.
  - `src/io/paths.js` — canonical path resolver for `~/.aimgr/secrets.json`; this is the right place to add `~/.aimgr/config.yaml`, `~/.aimgr/machine-id`, Redis cache, and migration bundle paths.
  - `src/io/json-store.js` — existing backup/write helpers already encode the repo's file-write style.
  - `src/state/schema.js` — normalizes legacy/current `secrets.json`; migration should reuse this as read-only input normalization before old state stops being live.
  - `src/credentials/codex.js` and `src/credentials/anthropic.js` — credential shape validation and fingerprinting already exist and should be reused for migration candidate identity/clone detection.
  - `src/credentials/codex-login.js` and `src/credentials/claude-native.js` — provider-specific login/refresh/capture behavior is already isolated enough to call from Redis-backed publish paths.
  - `src/targets/codex-cli.js`, `src/targets/claude-cli.js`, `src/targets/hermes-auth.js`, `src/targets/pi-cli.js`, and `src/openclaw/sync.js` — target projection writers already fail loud on readback mismatch; keep their file-format logic and replace their credential source.
  - `src/panels/actions.js` and `src/panels/maintenance.js` — the main interactive `aim <label>` path currently mutates credentials, browser setup, Hermes sync receipts, and old authority dirty metadata; this path must be cut over with login, not after it.
  - `src/cli/commands/browser.js` — browser/reauth label policy currently writes local state; split shared policy into Redis label records and machine-specific bindings into local adjunct state.
  - `src/cli/commands/auth.js` — `aim auth write hermes` currently reads local state; it must read Redis sessions or retire behind Redis-era rebalance guidance.
  - `src/cli/commands/internal.js` — `apply-codex-promotion` / `apply-claude-promotion` are hidden authority write receivers and must not survive as live commands.
  - `src/status/view.js` and `src/status/render.js` — status is the operator's truth surface and must become Redis-snapshot-backed.
  - `README.md`, `src/cli/help.js`, and `test/cli/readme-contract.test.js` — operator-facing command maps must move with the breaking cutover.

- Canonical path / owner to reuse:
  - New `src/coordination/redis-store.js` should own Redis key construction, connection, snapshot reads, and compare-and-set writes.
  - New `src/coordination/records.js` should own label/session/machine record shape normalization and conversion from legacy account/credential data.
  - New `src/config/aimgr-config.js` should own `~/.aimgr/config.yaml` read/write.
  - New `src/migration/redis-migration.js` plus narrow collectors should own read-only legacy collection, deterministic planning, backup, and apply.
  - Existing target modules should continue owning their target file formats.

- Adjacent surfaces tied to the same contract family:
  - `src/cli/commands/sync.js` and `src/cli/commands/promote.js` — must stop being live authority coordination.
  - `src/credentials/authority-locator.js`, `src/credentials/codex-import.js`, `src/credentials/codex-promotion.js`, `src/credentials/anthropic-import.js`, and `src/credentials/anthropic-promotion.js` — delete or quarantine as migration-only code; they must not remain live runtime coordination.
  - `src/state/authority-*` and `state.imports.authority` metadata — useful for migration ranking, not future live state.
  - Watch installers under `scripts/` — may continue launching `aim codex watch --once` / `aim hermes watch --once`, but those commands must read Redis config and fail loud when unattached.
  - Tests under `test/authority`, `test/codex`, `test/claude`, `test/hermes`, `test/openclaw`, `test/status`, and `test/cli` — many currently encode file-SSOT or authority behavior and must be rewritten or retired.

- Compatibility posture (separate from `fallback_policy`):
  - Clean breaking cutover. Old files are read-only migration input; old authority/sync/promote is not a runtime fallback or compatibility mode.

- Existing patterns to reuse:
  - Dependency injection in CLI tests via `runCli()` and handler dependencies.
  - `writeJsonFileWithBackup*` and mode-aware target writes for local files.
  - Existing credential fingerprint functions for conflict/clone detection.
  - Existing target readback checks for projection correctness.
  - Existing status warning style for fail-loud operator feedback.

- Prompt surfaces / agent contract to reuse:
  - Not agent-backed. No prompt or model behavior should be introduced for this implementation.

- Native model or agent capabilities to lean on:
  - Not applicable.

- Existing grounding / tool / file exposure:
  - Existing CLI has local filesystem access to AIM state and target auth files.
  - Existing authority loader can read remote `secrets.json` over SSH, but the new preferred migration path is local collection per machine plus explicit bundle transfer, not steady-state SSH authority sync.
  - `--state` remains useful for migration fixtures/tests, but after Redis cutover it must not be a shared-credential escape hatch for normal runtime commands.

- Duplicate or drifting paths relevant to this change:
  - File-backed `~/.aimgr/secrets.json` live state versus Redis shared state.
  - Authority import/promotion metadata versus Redis versioned records.
  - Target active-label receipts stored in old state versus local projection status derived from Redis plus target readback.
  - README/help/test command maps still advertise old authority behavior.

- Capability-first opportunities before new tooling:
  - Reuse existing target readers/writers and credential validators instead of inventing new token parsers.
  - Reuse schema normalization for legacy state import instead of writing an ad hoc migrator.
  - Use Redis optimistic transactions instead of a daemon, lock service, Lua, or custom HTTP coordination layer.

- Behavior-preservation signals already available:
  - `npm run lint` — syntax/check surface for every JS file.
  - `npm test` — current CLI/credential/projection behavior tests.
  - Existing target readback tests — good patterns to extend for Redis-backed projection.
  - Optional real Redis integration under `AIMGR_REDIS_TEST_URL` — needed to prove actual stale `WATCH` transaction rejection without making normal local tests require Redis.

## 3.3 Decision gaps that must be resolved before implementation

- none
<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->
## 4.1 On-disk structure

- `~/.aimgr/secrets.json` is the current durable local state file.
- `~/.aimgr/secrets.json.bak.<timestamp>` backups are created on writes through `src/io/json-store.js`.
- There is no `~/.aimgr/config.yaml` yet.
- There is no stable `~/.aimgr/machine-id` yet.
- There is no separate local-only adjunct state file; credentials, browser setup, OpenClaw assignments, demand/history, and projection receipts all currently mix in `secrets.json`.
- Codex projection writes to the managed Codex auth file under the resolved `CODEX_HOME` / `~/.codex` path.
- Claude projection writes native Claude auth/app-state files under the managed Claude home.
- Pi projection writes local Pi auth.
- Hermes writes explicit `auth.json` files supplied by caller/discovery.
- OpenClaw writes per-agent auth/profile and session/model state.

## 4.2 Control paths (runtime)

- CLI entry: `bin/aimgr.js` -> `src/cli.js` -> `src/cli/main.js`.
- Every main command parses options with `src/cli/args.js`, resolves `statePath`, calls `loadAimgrState(statePath)`, mutates local state, then writes `~/.aimgr/secrets.json`.
- Status builds a view from local state plus local target readbacks in `src/status/view.js`.
- Login uses existing provider-specific code to refresh/login/capture credentials, then writes them into local state.
- Codex/Claude/Pi/Hermes/OpenClaw projections read credentials from local state and write target auth files.
- Watch/tend flows repeatedly load local state, call projection/selection helpers, then write local state.
- The interactive panel path (`aim <label>`) routes through `src/panels/actions.js` / `src/panels/maintenance.js` and writes shared credentials plus authority dirty metadata to local state.
- `aim browser show/set` and `aim auth write hermes` read/write local state directly.
- `sync codex` / `sync claude` import from a file/SSH authority into a consumer state file.
- `promote codex` / `promote claude` push refreshed imported credentials back to the recorded authority.
- `aim internal apply-codex-promotion` / `apply-claude-promotion` receive remote promotion payloads and write authority state from stdin.

## 4.3 Object model + key abstractions

- `state.accounts.<label>` stores provider, browser/reauth policy, expected identity, and pool enablement.
- `state.credentials.<provider>.<label>` stores usable provider tokens or native Claude bundles.
- `state.targets.*` stores local derived-target receipts and active labels.
- `state.targets.openclaw.*`, demand/history helpers, and browser bindings contain local machine behavior mixed into the same file as shared credentials.
- `state.imports.authority.*` stores old import source, imported labels, base fingerprints, dirty flags, and promotion metadata.
- Credential validation/fingerprinting is provider-specific in `src/credentials/codex.js` and `src/credentials/anthropic.js`.
- Target projection logic is already separated by target module; target files are derived outputs, but their receipts currently live in the same local state file as credentials.

## 4.4 Observability + failure behavior today

- Writes are local JSON writes with timestamped backups.
- Target writers generally read back and fail on mismatch.
- Dirty import metadata blocks some unsafe authority overwrites.
- If the authority or consumer has stale state, the operator has to decide whether to sync or promote.
- A local state file can be fresher than authority for one label and older for another.
- There is no central atomic compare-and-set boundary.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No GUI work. Operator surfaces are CLI text and JSON:

```text
aim status
aim login <label>
aim codex use [label]
aim claude use [label]
aim rebalance openclaw
aim rebalance hermes
```
<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->
## 5.1 On-disk structure (future)

- `~/.aimgr/config.yaml`
  - `redis.url`
  - `redis.keyPrefix`
  - `redis.primaryHost`
  - `redis.transport`
- `~/.aimgr/machine-id`
  - stable per-machine id used in Redis session keys.
- `~/.aimgr/redis-cache.json`
  - display/diagnostic cache only; never mutating input.
- `~/.aimgr/local-state.json`
  - local-only non-credential adjunct state: projection receipts, active target labels, OpenClaw assignments for this machine, demand/history ledgers, and machine-specific browser bindings.
  - not shared truth and not a credential store.
- `~/.aimgr/redis-migration/`
  - collection bundles, migration plan, full backups, and post-import export.
- `~/.aimgr/secrets.json`
  - legacy migration input only after cutover; not live state.
- Local target auth files remain target-owned projections.

## 5.2 Control paths (future)

- Command boot reads `~/.aimgr/config.yaml` and machine id.
- Commands that require shared state connect to Redis through `src/coordination/redis-store.js`.
- Status reads a Redis snapshot, reads local target projections, and renders fleet/session/projection state.
- Mutating commands read the current record version, work locally, then publish with compare-and-set.
- Local provider refresh/login/capture still uses existing provider-specific modules, but the publish destination becomes Redis.
- Target projection modules keep their file-format and readback responsibilities, but they receive credentials from Redis session records.
- Migration is explicit: collect on all machines, plan centrally, apply once to Redis, then stop using old live state.

## 5.3 Object model + abstractions (future)

- Redis label record:
  - stable provider/label identity and policy.
  - shared label policy: provider, stable identity, expected identity hints, pool enablement, reauth mode, and shared browser mode intent.
  - no machine owner.
- Redis session record:
  - usable credential for `(provider, label, machineId)`.
  - lineage metadata explaining independent login, imported authority data, imported target data, imported clone, or handoff.
- Redis machine record:
  - machine id, display name, hostname, platform, last seen, AIM version.
- Redis meta record:
  - schema version, cutover marker, created/imported timestamps, and migration plan id.
- Local adjunct record:
  - machine-only state that is not a credential: target receipts, active local target label, OpenClaw assignment/demand receipts, usage history, and concrete browser executable/profile paths.
- Local projection status:
  - derived from Redis session plus local target readback.
  - not shared truth in v1 except via status receipts where useful.

Canonical new modules:

```text
src/config/aimgr-config.js
src/coordination/redis-store.js
src/coordination/records.js
src/coordination/machine.js
src/coordination/snapshot.js
src/state/local-state.js
src/migration/redis-migration.js
src/migration/collect-legacy-state.js
src/migration/collect-target-auth.js
src/cli/commands/redis.js
```

Redis key contract:

```text
aimgr:v1:meta
aimgr:v1:machines
aimgr:v1:labels
aimgr:v1:sessions
aimgr:v1:machine:<machineId>
aimgr:v1:label:<provider>:<label>
aimgr:v1:session:<provider>:<label>:<machineId>
aimgr:v1:sessionsByLabel:<provider>:<label>
aimgr:v1:sessionsByMachine:<machineId>
```

Store API contract:

```js
connectRedisStore({ url, keyPrefix })
readSnapshot(store)
registerMachine(store, machineInfo)
publishMeta(store, { expectedVersion, metaRecord })
publishLabel(store, { expectedVersion, labelRecord })
publishSession(store, { expectedVersion, sessionRecord })
casPutJsonRecord(store, { key, indexKeys, expectedVersion, nextRecord })
```

`casPutJsonRecord()` uses `WATCH`, reads/parses the current JSON record, validates expected version, builds the next record in JavaScript, commits `SET` plus index `SADD` operations in `MULTI` / `EXEC`, and returns `stale_version` on version mismatch or watched transaction abort.

Snapshot adapter contract:

```js
buildCoordinationView(snapshot, { machineId, homeDir, env, nowMs })
```

This adapter gives legacy pool/status/projection code a state-like read model during migration without keeping `secrets.json` live. The adapter is thin, read-only, and not a permanent dual model. It may shape Redis labels/sessions into the data structures existing ranking/projection code expects, but writes must still go back through Redis store APIs or the local adjunct state APIs for explicitly local non-credential receipts.

Migration candidate contract:

```js
{
  sourceMachineId,
  sourceKind,        // legacy-state | codex-target | claude-target | hermes-target | openclaw-target
  sourcePath,
  provider,
  label,
  identity,
  credential,
  credentialFingerprint,
  sourceMachineIdMatchesLocalMachineId,
  refreshAttempt,
  expiresAt,
  timestamps,
  oldAuthorityMeta,
  validation
}
```

Candidate planning is deterministic. The planner chooses per-label identity first, then per-machine session candidates. Same-fingerprint candidates are grouped as one lineage; only one can be marked ready as an independent live session unless evidence proves independent login.

## 5.4 Invariants and boundaries

- `src/coordination/redis-store.js` is the only module that knows raw Redis keys.
- `src/coordination/records.js` is the only module that normalizes Redis label/session/machine records.
- `src/state/local-state.js` is the only runtime home for local-only AIM receipts and target assignment metadata after cutover.
- `src/migration/*` may read old `secrets.json` and target auth files; runtime command handlers may not treat old state as shared truth.
- The migration planner may reuse old authority metadata as evidence, but no future runtime branch may consult `state.imports.authority`.
- Target modules continue to own file format and readback validation.
- Old authority import/promotion modules cannot stay wired as live command behavior.
- Same fingerprint on multiple machines is imported as same-lineage history, not as independent live sessions.
- Missing Redis config means the install is not attached to the shared pool; mutating Redis-era commands fail loud.
- No local cache may drive mutation or selection.
- No normal runtime command may write shared credentials to `~/.aimgr/secrets.json`.
- The only acceptable bridge is a read-only migration bridge that ends at `aim redis migrate apply --confirm-breaking-cutover`.

## 5.5 UI surfaces (ASCII mockups, if UI work)

Redis admin:

```bash
aim redis configure --url redis://agents:6379 --primary-host agents@amir-mac-studio
aim redis config
aim redis ping
aim redis snapshot
aim redis export --out backup.json
aim redis import --in backup.json
```

Normal Redis-era commands:

```bash
aim status
aim login <label>
aim codex use [label]
aim codex run --tend
aim claude run <label>
aim rebalance hermes
aim rebalance openclaw
```

Migration:

```bash
aim redis migrate collect --machine <machineId> --out ~/.aimgr/redis-migration/<machineId>.json
aim redis migrate plan --from ~/.aimgr/redis-migration --out ~/.aimgr/redis-migration/plan.json
aim redis migrate apply --plan ~/.aimgr/redis-migration/plan.json --confirm-breaking-cutover
```

`collect --machine` must match the local `~/.aimgr/machine-id`. The operator copies the three bundles into one migration directory, reviews one plan, and runs one apply against the Redis primary.

Repair:

```bash
aim label rebind <label> --confirm
aim session handoff <label> --from <machineId> --to <machineId> --confirm
```

`handoff` is an explicit repair for a copied rotating-token lineage. It marks the source session stale/revoked and writes the destination session as the live lineage; it is not a clone operation and it does not create an owner.

Retired live behavior:

```text
aim sync codex       -> error: removed by Redis cutover
aim promote codex    -> error: removed by Redis cutover
aim sync claude      -> error: removed by Redis cutover
aim promote claude   -> error: removed by Redis cutover
aim sync openclaw    -> error: use aim rebalance openclaw
aim apply            -> error: use aim rebalance openclaw
aim internal apply-codex-promotion  -> error: removed by Redis cutover
aim internal apply-claude-promotion -> error: removed by Redis cutover
```
<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->
## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| Dependencies | `package.json`, `package-lock.json` | dependencies | No Redis client | Add official `redis` package | Redis store needs Node client | `redis` npm dependency | lint/package install checks |
| Paths | `src/io/paths.js` | path resolvers | Only state/target paths | Add config, machine-id, cache, migration paths | Central path ownership | `resolveAimgrConfigPath`, `resolveAimgrMachineIdPath`, migration paths | path/config tests |
| Config | `src/config/aimgr-config.js` | new | No AIM config file | Add YAML read/write for Redis config | Per-machine primary host requirement | `readAimgrConfig`, `writeAimgrConfig`, `getRedisConfig` | config tests |
| Machine identity | `src/coordination/machine.js` | new | No stable machine id | Create/read machine id | Redis sessions keyed per machine | `getOrCreateMachineId` | machine id tests |
| Local adjunct state | `src/state/local-state.js`, `src/io/paths.js` | new | Local receipts/assignments mixed into credential state | Add `~/.aimgr/local-state.json` for non-credential local state | Prevent `secrets.json` shadow SSOT | local-only schema/read/write helpers | local-state tests |
| Redis store | `src/coordination/redis-store.js` | new | No Redis | Add connection, key builders, snapshot, CAS | Atomic shared state | store API above | unit + optional Redis tests |
| Records | `src/coordination/records.js` | new | State shape tied to `secrets.json` | Define Redis label/session/machine records | Clean shared contract | normalized record constructors | record tests |
| Coordination adapter | `src/coordination/snapshot.js` | new | Legacy code expects state-shaped data | Provide read-only state-like view over Redis snapshot during refactor | Lets target/ranking code move without a compatibility bridge | read model only; writes forbidden | status/projection tests |
| Snapshot view | `src/coordination/snapshot.js` | new | Local state direct | Build query helpers over Redis snapshot | Commands need provider/label/session lookup | `getLabel`, `getMachineSession`, `listPoolLabels` | status/selection tests |
| CLI args | `src/cli/args.js` | `parseArgs` | No Redis/migration flags | Add `--url`, `--primary-host`, `--key-prefix`, `--machine`, migration flags as needed | CLI command support | explicit options | CLI tests |
| CLI routing | `src/cli/main.js` | `COMMAND_HANDLERS` | No `redis` command; state path always resolved | Add `redis` handler; avoid requiring live state for Redis admin | Admin/migration command surface | `handleRedis` | CLI tests |
| Help | `src/cli/help.js` | `printHelp` | Advertises file SSOT and authority sync/promote | Rewrite to Redis SSOT and migration commands | Operator contract must match cutover | updated help text | readme-contract |
| Redis CLI | `src/cli/commands/redis.js` | new | None | Implement configure/config/ping/snapshot/export/import/migrate | Admin/migration entrypoint | `aim redis ...` | CLI tests |
| Status | `src/cli/commands/status.js`, `src/status/view.js`, renderers | `handleStatus`, `buildStatusView` | Reads local state | Read Redis snapshot + local projection readbacks | Status is fleet truth | Redis-backed view model | status tests |
| Login | `src/cli/commands/login.js`, `src/credentials/codex-login.js`, `src/credentials/claude-native.js` | `handleLogin` | Writes local credentials | Publish label/session to Redis with CAS | Login must update shared state | `publishSession` after provider validation | login tests |
| Interactive panel | `src/panels/actions.js`, `src/panels/maintenance.js` | `runLabelControlPanel`, `performLabelMaintenance` | Writes credentials, browser setup, authority dirty metadata, Hermes sync receipts to local state | Publish shared label/session state to Redis; write only non-credential receipts to local adjunct state | This is the main human path behind `aim <label>` | Redis label/session APIs + local adjunct state | panel/maintenance tests |
| Browser policy | `src/cli/commands/browser.js`, `src/browser/bindings*.js` | `handleBrowser`, binding helpers | Writes label browser/reauth data to local state | Store shared policy on Redis label; store concrete machine-specific browser binding paths locally | Browser policy must not keep `secrets.json` live | `publishLabel`, local binding helpers | browser CLI tests |
| Repair commands | `src/cli/main.js`, new command handlers | new | Identity mismatch/session handoff is ad hoc | Add `aim label rebind <label> --confirm` and `aim session handoff ... --confirm` | Required explicit recovery without copying files | Redis CAS updates with lineage checks | repair CLI tests |
| Codex projection | `src/targets/codex-cli.js`, `src/cli/commands/codex.js` | `applyCodexCliFromState`, `activate*` | Reads local state and writes local state receipts | Read Redis sessions; write local auth; publish rotated live auth | Codex use/watch/tend must not need sync | Redis snapshot/session APIs | codex tests |
| Codex tender | `src/targets/codex-tender.js`, tender call chain | `runCodexTenderImpl` and direct `loadAimgrState` usage | Tends through local state | Read Redis sessions; preserve live rotation to Redis before exit/restart; write local receipts to adjunct state | Prevent local-rotated-not-published bug | Redis publish on rotation | codex tend tests |
| Claude projection | `src/targets/claude-cli.js`, `src/targets/claude-status.js`, `src/cli/commands/claude.js` | `applyClaudeCliFromState`, `syncLiveClaudeRotationBackToLabel` | Reads/writes local state through `aim claude use` and native bundle commands | Make `aim claude run <label>` canonical; read/publish Redis sessions and keep native bundle readback | Source doc wants Redis-era Claude run/per-label home behavior | Redis session source + Claude launch/projection boundary | claude tests |
| Pi projection | `src/targets/pi-cli.js`, `src/cli/commands/pi.js` | `applyPiCliFromState` | Reads local state | Read Redis Codex session | Pi target is projection | Redis session source | pi tests |
| Hermes projection | `src/targets/hermes-auth.js`, `src/pool/hermes-rebalance.js`, `src/cli/commands/hermes.js`, `src/cli/commands/auth.js` | `writeHermesAuthFromState`, rebalance/watch, `handleAuth` | Reads local state | Read Redis Codex sessions and local home status; retire or reroute `aim auth write hermes` | Hermes target is projection | Redis session source | hermes/auth tests |
| OpenClaw projection | `src/openclaw/apply.js`, `src/openclaw/sync.js`, `src/openclaw/rebalance.js` | apply/sync/rebalance | Reads local state assignments/credentials | Read Redis sessions; keep runtime config and assignment/demand receipts in local adjunct state | OpenClaw target is projection | Redis-backed session inputs + local adjunct assignments | openclaw tests |
| Pool ranking | `src/pool/ranking.js`, `src/pool/weighted-planner.js`, `src/pool/watch.js`, history/demand helpers | pool helpers | Operate on local state | Accept Redis-derived state/snapshot model plus local adjunct demand/history where needed | Preserve ranking behavior without credential local state | snapshot-compatible inputs | pool tests |
| Old sync command | `src/cli/commands/sync.js` | `handleSync` | sync openclaw/codex/claude | Hard-error all old sync surfaces; route OpenClaw work through `aim rebalance openclaw` | No duplicate coordination verbs | hard error for retired flows | authority/CLI tests |
| Old promote command | `src/cli/commands/promote.js` | `handlePromote` | Pushes to file/SSH authority | Remove/hard-error | No old live coordination | removed behavior | authority/CLI tests |
| Old apply command | `src/cli/commands/apply.js` | `handleApply` | Materializes stored OpenClaw assignments | Hard-error with `aim rebalance openclaw` guidance | Avoid second OpenClaw projection path | removed behavior | CLI/openclaw tests |
| Internal authority receiver | `src/cli/commands/internal.js`, `src/credentials/authority-locator.js` | `handleInternal`, `buildRemoteAimInternalApplyCommand` | SSH remote promotion writes authority state from stdin | Remove/hard-error promotion receivers and delete remote apply usage | Prevent hidden authority side door | no successful internal promotion path | internal/authority tests |
| Authority modules | `src/credentials/authority*.js`, import/promotion files | exports | File/SSH authority logic | Move any read-only useful code into migration or delete | Avoid hidden second path | migration-only collectors | delete/compile tests |
| Authority metadata | `src/state/authority-*.js`, `src/state/authority-normalize.js` | import metadata | Dirty state / promotion status | Use only during migration ranking or remove from runtime state | Avoid legacy live metadata | migration candidate metadata | migration tests |
| State schema | `src/state/schema.js`, `src/state/empty.js`, `src/state/accounts.js` | state model | `secrets.json` runtime SSOT | Retain legacy normalizer for migration; remove runtime dependence where Redis-backed commands no longer load local state | Clean cutover | Redis records are runtime shared model | schema/migration tests |
| Sanitization | `src/core/sanitize.js` | status output | Redacts local state output | Ensure Redis sessions and migration reports redact secrets | Avoid credential leaks | redaction for Redis/migration records | status/migration tests |
| README | `README.md` | operator docs | File SSOT and authority examples | Rewrite to Redis primary, migration, no sync/promote | Live docs must match behavior | new operator contract | readme-contract |
| Watch installers | `scripts/install-codex-watch.sh`, `scripts/install-hermes-watch.sh` | generated services | Run watch commands | Keep commands, but docs/tests must reflect Redis config prerequisite | Scheduled commands need Redis | no new service shape unless needed | scripts tests |
| Tests | `test/**` | all affected tests | Many file/authority assumptions | Rewrite around Redis store and migration; delete tests that only prove removed behavior | Prove new behavior | Redis/migration fixtures | full suite |

## 6.2 Migration notes

- Canonical owner path / shared code path:
  - Redis shared state: `src/coordination/redis-store.js`.
  - Redis record shapes: `src/coordination/records.js`.
  - Legacy import: `src/migration/redis-migration.js`.
  - Per-target projection: existing target modules.
- Deprecated APIs:
  - `importCodexFromAuthority`, `promoteCodexToAuthority`, `importAnthropicFromAuthority`, `promoteClaudeToAuthority`, `loadAuthorityState`, `buildRemoteAimInternalApplyCommand`, `aim internal apply-codex-promotion`, `aim internal apply-claude-promotion`, `aim apply`, and `aim sync openclaw` as live runtime behavior.
- Delete list:
  - Live authority import/promotion code paths.
  - Internal remote promotion receivers and SSH authority write plumbing.
  - Help/README claims that `~/.aimgr/secrets.json` is shared SSOT.
  - Runtime shared-credential reads/writes from `~/.aimgr/secrets.json`; migration-only reads are allowed.
  - Tests whose only purpose is proving old authority sync/promote behavior.
- Adjacent surfaces tied to the same contract family:
  - README, help, CLI command map, state schema, status renderers, tests, watch installer docs.
- Compatibility posture / cutover plan:
  - Clean cutover. Migration reads old state and target files, then Redis becomes the only shared home.
- Capability-replacing harnesses to delete or justify:
  - None; not agent-backed.
- Live docs/comments/instructions to update or delete:
  - README, CLI help, comments that mention authority imports as steady-state, tests named around authority behavior where retained.
- Behavior-preservation signals for refactors:
  - Existing target projection tests should still prove file formats/readback.
  - Pool ranking tests should still prove selection behavior.
  - Migration tests should prove old data is preserved before old write paths are deleted.
- Migration winner rules:
  - Provider/label identity conflicts are blockers, not merges.
  - `collect --machine` must match the local `~/.aimgr/machine-id`; mismatch is a collection error.
  - Validated candidates beat unvalidated candidates.
  - Expired candidates with refresh material must get a controlled provider refresh/import attempt before they can be marked re-login-required.
  - Controlled refresh during planning uses credential bytes from the collected bundle on the plan/apply machine. If provider refresh requires an interactive OAuth/browser step, mark that candidate `re-login-required` with machine/source/reason instead of attempting hidden interaction.
  - Dirty-local old authority metadata beats a stale authority base when identity matches.
  - Newer verified/promoted/dirty/import timestamps beat older timestamps.
  - Later expiry breaks ties only after identity and freshness evidence.
  - Same fingerprint across machines is one lineage; preserve it, but do not label every copy as independently safe.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope (include/defer/exclude/blocker question) |
| ---- | ------------- | ---------------- | ---------------------- | -------------------------------------------------------- |
| Shared state | all command handlers | Redis snapshot/store boundary | Prevents new local-state side doors | include |
| Target projection | target modules | Existing writer/readback ownership | Avoid rewriting target formats while changing source | include |
| Config | `~/.aimgr/config.yaml` | One AIM config reader/writer | Avoid env/flag drift across machines | include |
| Migration | old state + target files | Read-only candidate collection | Preserves data without live compatibility | include |
| Authority behavior | sync/promote modules | Removed/hard-error live path | Prevents parallel coordination | include |
| Local adjunct state | target receipts, browser bindings, OpenClaw assignments, demand/history | Explicit non-credential local state file | Prevents `secrets.json` from remaining a shadow SSOT | include |
| Repair flows | identity mismatch and lineage movement | Explicit rebind/handoff commands | Avoids ad hoc file copying as repair | include |
| Redis audit stream | Redis Streams | No stream required for v1 correctness | Avoid complexity not needed for three machines | exclude |
| Daemon/agent | any new background process | None | User rejected daemon/agents as unnecessary complexity | exclude |
<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->
> Rule: depth-first implementation protects the full destination while proving the path early. Treat TL;DR, Section 0, Sections 5-6, and approved decisions as the destination map: they preserve final known scope, not a Phase 1 checklist. Section 7 should choose the first working slice that proves one real path through the canonical owner path, highest-risk seam, compatibility or migration posture, and verification shape. Later phases expand along named axes from that proof. Phase boundaries are proof gates: each phase must create evidence that later work can safely rely on. Before a phase plan is valid, run an obligation sweep and either place required work in the current phase, assign it to a named later phase in the expansion map, or stop for an explicit user decision; do not hide unresolved branches. Phase count is an outcome of dependency edges, proof gates, reversibility or migration boundaries, and user-review boundaries; split only when a phase blends separately provable units. `Work` explains the unit and is explanatory only for modern docs. `Checklist (must all be done)` is the authoritative must-do list inside the phase. `Exit criteria (all required)` names the exhaustive concrete done conditions the audit must validate. Refactors, consolidations, and shared-path extractions must preserve existing behavior with credible evidence proportional to the risk. For agent-backed systems, prefer prompt, grounding, and native-capability changes before new harnesses or scripts. No fallbacks/runtime shims - the system must work correctly or fail loudly (delete superseded paths). If a bridge is explicitly approved, timebox it and include removal work; otherwise plan either clean cutover or preservation work directly. Prefer programmatic checks per phase; defer manual/UI verification to finalization. Avoid negative-value tests and heuristic gates (deletion checks, visual constants, doc-driven gates, keyword or absence gates, repo-shape policing). Also: document new patterns/gotchas in code comments at the canonical boundary (high leverage, not comment spam).

## Operational prerequisite before real machine migration

- Code phases may be developed and tested with mocks or `AIMGR_REDIS_TEST_URL`.
- Real three-machine migration cannot apply until Redis/Valkey is installed on `agents` at Amir's Mac Studio, AOF is enabled, all three machines can `aim redis ping` over Tailscale, and all three configs point at the same primary host/key prefix.
- Do not run a partial Redis cutover on live machines; production cutover waits for Phase 8 evidence.

## Phase 1 — Redis Coordination Spine

* Implementation status:
  - Status: complete as of 2026-05-30T14:22:46Z.
  - Added the Redis dependency, AIM Redis config file support, stable machine ids, local adjunct state, Redis record normalization, Redis CAS store boundary, Redis snapshot helpers, and `aim redis configure|config|ping|snapshot|export|import`.
  - Added Phase 1 tests for config, machine ids, local adjunct state, Redis records, Redis CAS/indexing, Redis WATCH conflict handling, and Redis CLI config behavior.
  - Verified against the live Mac Studio Redis primary over Tailscale with key prefix `aimgr:phase1-smoke:20260530T142220Z:` and cleaned the smoke-test keys afterward.
  - Test note: the inherited full suite requires `CODEX_HOME` unset for temp-home isolation in Codex tests; `rtk env -u CODEX_HOME npm test` passes.
* Goal:
  - Establish the real Redis primary/config/store boundary before any runtime command depends on it.
* Work:
  - This phase proves that an AIM install can be attached to the Mac Studio Redis primary and can perform versioned Redis record reads/writes through one canonical JavaScript store module.
* Checklist (must all be done):
  - Add the official `redis` npm dependency and update the lockfile.
  - Add `~/.aimgr/config.yaml` helpers in `src/config/aimgr-config.js`.
  - Add path helpers for config, machine id, Redis cache, and migration directories.
  - Add local adjunct path helpers and `src/state/local-state.js` read/write normalization for non-credential local state.
  - Add stable machine-id creation/reading in `src/coordination/machine.js`.
  - Add Redis meta/label/session/machine record constructors/normalizers in `src/coordination/records.js`.
  - Add `src/coordination/redis-store.js` with key builders, connection, `readSnapshot`, `registerMachine`, `publishLabel`, `publishSession`, and `casPutJsonRecord`.
  - Define `registerMachine` lifecycle: every Redis-backed command registers or refreshes the local machine record at command start, updating `lastSeenAt` without implying ownership.
  - Add `src/cli/commands/redis.js` for `configure`, `config`, `ping`, `snapshot`, `export`, and `import`.
  - Wire `redis` command routing through `src/cli/main.js`.
  - Add CLI options needed by Redis admin commands.
  - Add redaction for Redis session records and export/status output.
  - Add a short code comment at `casPutJsonRecord` explaining that it is the only shared mutation boundary.
* Verification (required proof):
  - `npm run lint`.
  - Unit tests for config read/write, machine id stability, local adjunct state normalization, Redis key builders, record normalization, redaction, and stale-version return behavior through a mocked Redis client boundary.
  - Optional real Redis test gated by `AIMGR_REDIS_TEST_URL` that proves one stale `WATCH` transaction loses.
* Docs/comments (propagation; only if needed):
  - README/help can mention Redis admin commands once the CLI exists, but full operator-doc rewrite waits until Phase 7.
* Exit criteria (all required):
  - A configured AIM install can run `aim redis config` and show Redis URL, key prefix, primary host, transport, and machine id.
  - `aim redis ping` succeeds against a reachable Redis primary and fails loud otherwise.
  - `aim redis snapshot` can read an empty prefix and a seeded prefix.
  - Redis snapshots include meta/machine/label/session indexes using the `aimgr:v1:` key contract.
  - Compare-and-set write APIs reject stale expected versions.
  - No runtime command other than `aim redis ...` has been cut over yet.
* Rollback:
  - Remove the `redis` dependency, new config/coordination modules, and `redis` command routing.

## Phase 2 — Non-Lossy Breaking Migration Pipeline

* Implementation status:
  - Status: complete as of 2026-05-30T14:30:41Z.
  - Added the read-only migration boundary in `src/migration/redis-migration.js` for collecting legacy AIM state, Codex target auth, Claude native auth, Hermes auth files, and OpenClaw auth stores.
  - Added deterministic planning with machine-id enforcement, identity-conflict blocking, same-fingerprint clone grouping, controlled refresh attempts for expired refreshable candidates, Redis snapshot construction, and apply-into-empty-prefix protection.
  - Added `aim redis migrate collect|plan|apply --confirm-breaking-cutover`, with redacted operator summaries and full sensitive bundle/plan files written mode `0600`.
  - Verified migration apply against the live Mac Studio Redis primary over Tailscale with fake credentials and key prefix `aimgr:phase2-smoke:20260530T143000Z:`; cleaned the prefix afterward.
* Goal:
  - Prove that existing usable data can be collected from all three machines, ranked, backed up, and imported into Redis before deleting the old live model.
* Work:
  - This phase builds the migration bridge. It is read-only until apply, and it ends at Redis import. It is not a runtime compatibility layer.
* Checklist (must all be done):
  - Add `src/migration/redis-migration.js` as the migration orchestration boundary.
  - Add read-only legacy state collection using `loadAimgrStateFromJsonValue()` / `ensureStateShape()`.
  - Add read-only collectors for Codex target auth, Claude native bundles, Hermes auth files, and OpenClaw auth stores.
  - Require `collect --machine <machineId>` to match the local `~/.aimgr/machine-id`; fail collection on mismatch.
  - Write each bundle with machine id, hostname, AIM version, source paths, collection timestamp, and a redacted summary.
  - Reuse existing credential validation and fingerprint helpers for candidate shape, identity, and clone detection.
  - Define migration bundle JSON with source machine, source path, provider, label, identity, credential fingerprint, expiry, timestamps, old authority metadata, and validation status.
  - Add deterministic `migrate plan` ranking rules from Section 6.2.
  - Add controlled refresh/import attempts for expired-but-refreshable Codex and Claude candidates using existing provider maintenance/refresh code before marking them unusable.
  - Run controlled refresh from collected credential bytes on the plan/apply machine; do not require interactive browser/OAuth during migration planning.
  - If a candidate can only be repaired by interactive OAuth, report it as re-login-required with exact machine/source evidence instead of hiding the failure.
  - Record refresh attempt status, refreshed identity, refreshed expiry, and provider rejection reason in the migration report.
  - Add identity-conflict blocking behavior with exact source-file reasons.
  - Add same-fingerprint lineage grouping so clones are preserved as history but not mislabeled independent sessions.
  - Add migration backup bundle containing all collected source files and the generated plan.
  - Define bundle aggregation workflow: copy all three bundles into one `~/.aimgr/redis-migration/` directory on the chosen apply machine, run one plan, review conflicts, then run one apply.
  - Add `migrate apply` that is a single-writer operation and writes selected labels/sessions/meta to an empty Redis prefix or explicit dry-run prefix.
  - Add migration report output listing imported, superseded, cloned, skipped, and re-login-required labels.
  - Add command routing for `aim redis migrate collect`, `plan`, and `apply --confirm-breaking-cutover`.
* Verification (required proof):
  - Unit tests for every collector against fixtures.
  - Migration planner tests for dirty-local preference, newer timestamp preference, expiry tie-breaks, identity conflicts, same-fingerprint clones, controlled refresh attempts, and unusable credentials.
  - CLI tests proving machine-id mismatch fails collection and apply refuses non-empty Redis prefixes unless an explicit dry-run/test prefix is used.
  - CLI tests for collect/plan/apply output and redaction.
  - Apply test that imports multiple machine bundles into Redis and then snapshots expected labels/sessions.
* Docs/comments (propagation; only if needed):
  - Add a short migration planner comment explaining that it is allowed to read legacy state but runtime commands are not.
* Exit criteria (all required):
  - Migration can consume three machine bundles before apply.
  - Bundles cannot be accidentally assigned to the wrong machine id.
  - Plan/apply are run once from one reviewed bundle directory; there is no per-machine apply race.
  - Migration refuses provider/label identity conflicts without overwriting.
  - Migration preserves all usable Codex/Claude credential candidates or explains why a candidate is superseded.
  - Migration never asks for planned mass re-login and treats re-login for currently usable credentials as a failed plan.
  - Expired-but-refreshable candidates are refreshed or provider-rejected with source-specific reasons before being marked re-login-required.
  - A label appears in the re-login-required report only when evidence says it was already invalid, unreadable, identity-conflicted, or provider-rejected.
  - `aim redis migrate apply --confirm-breaking-cutover` writes Redis meta/labels/sessions and a backup/export without enabling old live sync/promote.
* Rollback:
  - Delete the Redis prefix imported by the failed apply and restore from the migration backup/export. Legacy files remain untouched because collection is read-only.

## Phase 3 — Redis Status And Read Model

* Implementation status:
  - Status: complete as of 2026-05-30T14:32:59Z.
  - Added Redis-backed status routing: when `~/.aimgr/config.yaml` contains a Redis URL, `aim status` builds the read model from Redis snapshots plus `~/.aimgr/local-state.json` instead of loading shared credentials from `~/.aimgr/secrets.json`.
  - Added Redis session matrix and machine summaries to `aim status --json`.
  - Added diagnostic-only `~/.aimgr/redis-cache.json` writes after successful Redis status reads and cache fallback for Redis-unavailable status.
  - Verified live `aim status --json` against Mac Studio Redis with key prefix `aimgr:phase3-smoke:20260530T143400Z:` and cleaned the prefix afterward.
* Goal:
  - Make `aim status` tell the truth from Redis before changing daily mutating commands.
* Work:
  - This phase proves the read model and operator visibility over imported Redis data, local projection drift, and machine sessions.
* Checklist (must all be done):
  - Add `src/coordination/snapshot.js` helpers for label/session/machine lookup.
  - Build a thin read-only state-like adapter only for reuse by ranking/status code during the cutover; forbid writes through this adapter.
  - Update `src/status/view.js` to read Redis snapshots when Redis config is present.
  - Render machine/session status matrix for labels across the three machines.
  - Add local projection drift detection for Codex, Claude, Pi, Hermes, and OpenClaw using existing target readback helpers.
  - Write `~/.aimgr/redis-cache.json` after successful status reads for diagnostics only.
  - Ensure Redis-unavailable status can show cache timestamp while mutating commands still fail.
* Verification (required proof):
  - Status tests with a seeded Redis snapshot containing three machines and mixed ready/stale/missing sessions.
  - Status tests for local projection drift without using cache as source.
  - Existing redaction tests updated for Redis sessions.
* Docs/comments (propagation; only if needed):
  - Update status-specific README/help examples if touched by this phase.
* Exit criteria (all required):
  - `aim status --json` does not read shared credentials from `~/.aimgr/secrets.json` when Redis is configured.
  - Status shows imported labels/sessions from Redis.
  - Status identifies current machine projection drift.
  - Cache is display-only and never used for selection or mutation.
  - New code added in this phase does not call `loadAimgrState()` for shared credentials.
* Rollback:
  - Revert status routing to pre-phase behavior and leave Redis store/migration code unused.

## Phase 4 — Redis Login, Label Policy, And Repair

* Goal:
  - Move account maintenance, shared label policy, and explicit repair from local state writes to Redis label/session writes with identity checks and stale-write protection.
* Work:
  - This phase proves the first mutating daily path through Redis: provider login/refresh/capture on one machine publishes that machine's current session, while panel/browser flows stop keeping shared state in `secrets.json`.
* Checklist (must all be done):
  - Update `aim login <label>` and shorthand `aim <label>` maintenance paths to read Redis labels/sessions.
  - Refactor every `writeJsonFileWithBackup(statePath, state)` path in `src/panels/actions.js` and `src/panels/maintenance.js` so provider maintenance publishes Redis labels/sessions and writes only local non-credential receipts to `~/.aimgr/local-state.json`.
  - Replace old authority dirty metadata updates in maintenance with Redis session lineage/version updates.
  - Treat panel-triggered Hermes sync as an interim local projection effect: by the end of Phase 6 it must read Redis sessions and write only local adjunct receipts.
  - Update `aim browser show/set` to store shared label policy in Redis and machine-specific concrete browser binding data in local adjunct state.
  - Create missing label records only after provider identity is known.
  - Validate returned provider identity against existing label identity before writing.
  - Publish this machine's session with `publishSession` and version CAS.
  - Preserve existing OpenAI Codex refresh-before-login behavior.
  - Preserve existing Claude native bundle capture/import behavior but publish to Redis.
  - Register `label` and `session` command handlers in `src/cli/main.js` or an equivalent routed command surface so `aim label rebind` and `aim session handoff` are real commands, not only helper functions.
  - Add `aim label rebind <label> --confirm` to intentionally replace `stableIdentity` only after showing the current identity, proposed identity, source session, and affected sessions.
  - Add `aim session handoff <label> --from <machineId> --to <machineId> --confirm` as an explicit same-lineage repair that marks the source session stale/revoked and writes the destination session with `lineage.mode = "handoff"`.
  - Return actionable `stale_version` errors when another process updates first.
  - Stop writing shared credential changes to `~/.aimgr/secrets.json`.
* Verification (required proof):
  - Login tests for new label creation, existing label refresh, identity mismatch, stale CAS rejection, and Claude native bundle publish.
  - Existing OAuth/callback tests adapted to assert Redis publish.
  - Panel maintenance tests proving `aim <label>` writes Redis shared records and only local adjunct receipts.
  - Browser command tests proving shared policy writes Redis and machine-specific binding writes local adjunct state.
  - Repair command tests for rebind confirmation, identity mismatch protection, handoff lineage update, and source session stale/revoked marking.
* Docs/comments (propagation; only if needed):
  - Comment provider publish boundary if needed to make "local refresh must publish before exit" obvious.
* Exit criteria (all required):
  - `aim login <label>` produces/updates Redis label/session records.
  - `aim <label>` and panel maintenance do not mutate shared credentials in `~/.aimgr/secrets.json`.
  - Browser/reauth shared policy is visible in Redis label records; machine-specific binding paths are local-only.
  - Rebind and handoff repairs exist and require explicit confirmation.
  - Identity mismatch does not mutate Redis.
  - Stale Redis version does not overwrite a newer session.
  - Shared credential data in old local state is no longer written by login.
* Rollback:
  - Revert login command routing to previous local-state write behavior before deleting old authority code.

## Phase 5 — Codex And Pi Projection From Redis

* Goal:
  - Move the highest-volume OpenAI/Codex target paths to Redis sessions and publish local rotations.
* Work:
  - This phase proves the OpenAI session path across local Codex, Codex watch/tend, and Pi without using sync/promote.
* Checklist (must all be done):
  - Update Codex pool selection to use Redis-derived labels/sessions.
  - Update `aim codex use [label]` to project the current machine's Redis session into Codex auth files.
  - If this machine lacks a ready session, fail with a clear `aim login <label>` or explicit `aim session handoff ... --confirm` instruction; do not silently clone another machine's lineage.
  - Update `preserveLiveCodexAuthForActiveLabel` to publish live rotation back to Redis before command exit.
  - Update `aim codex watch` to load Redis snapshot and write Redis session/receipts.
  - Update `src/targets/codex-tender.js` / `aim codex run --tend` integration so direct `loadAimgrState` reads are replaced with Redis snapshot/session reads and rotation/restart preserves session changes in Redis.
  - Update `aim pi use` to read Redis sessions and write local Pi auth.
  - Move Codex/Pi active-label and projection receipts to `~/.aimgr/local-state.json`.
  - Preserve existing target readback mismatch failures.
* Verification (required proof):
  - Codex use tests for explicit label, pool label, missing local session, stale session, and projection readback mismatch.
  - Watch tests proving live rotation writes Redis, not local state.
  - Pi projection tests proving Redis session source and readback.
  - Pool ranking tests proving selection output remains equivalent for equivalent input.
* Docs/comments (propagation; only if needed):
  - Update any touched comments that say Codex/Pi require imported authority replicas.
* Exit criteria (all required):
  - `aim codex use` does not require `aim sync codex`.
  - `aim codex watch --once` and `aim codex run --tend` do not leave locally rotated auth unpublished.
  - `aim pi use` uses Redis session source.
  - Codex/Pi receipts are local adjunct state, not shared credential state.
  - Old local state is not a shared credential input for these paths.
* Rollback:
  - Revert Codex/Pi command routing to previous local-state source while keeping Redis store/migration phases intact.

## Phase 6 — Claude, Hermes, And OpenClaw Projection From Redis

* Goal:
  - Move remaining target projections and rebalancers to Redis-backed sessions.
* Work:
  - This phase expands the proven projection pattern to Anthropic and multi-target OpenAI consumers.
* Checklist (must all be done):
  - Add `aim claude run <label>` as the canonical Redis-era Claude command: project this machine's Anthropic session into a per-label Claude home when possible, launch Claude with that home, then publish any native bundle rotation back to Redis.
  - Retire or hard-error `aim claude use` as a duplicate normal operating command unless the implementation keeps it only as an internal helper behind `aim claude run`; do not leave two operator-facing Claude activation models.
  - Update Claude live native bundle sync/capture/import/export paths so stored session changes publish to Redis.
  - Update Hermes rebalance/watch to read Redis Codex sessions and write Hermes auth files.
  - Update or retire `aim auth write hermes` so it cannot read credentials from old local state.
  - Update OpenClaw rebalance projection to read Redis sessions and keep runtime config outside AIM.
  - Keep Hermes/OpenClaw demand, assignment, and receipt behavior in `~/.aimgr/local-state.json` unless a field is explicitly promoted to Redis status later.
  - Preserve target readback mismatch failures.
  - Store only local projection receipts locally when needed; do not make them shared truth unless explicitly part of Redis status.
* Verification (required proof):
  - Claude run/capture/import tests proving Redis publish, per-label home projection, launch environment, and target readback.
  - Hermes rebalance/watch tests proving Redis source and unchanged target file contract.
  - Auth command tests proving `aim auth write hermes` is Redis-backed or retired with Redis-era guidance.
  - OpenClaw rebalance tests proving Redis source and existing model/session cleanup behavior.
  - Status tests showing these projections as local derived state.
* Docs/comments (propagation; only if needed):
  - Update touched comments that identify old state as the source for Hermes/OpenClaw/Claude projections.
* Exit criteria (all required):
  - Claude, Hermes, and OpenClaw no longer require old authority import state.
  - Claude's Redis-era public surface matches the investigation's `aim claude run <label>` behavior or has an explicit hard-error for any old duplicate surface.
  - All target writers still fail loud on unreadable or mismatched target files.
  - Redis remains the only shared credential source.
* Rollback:
  - Revert these target command paths to old local-state source before Phase 7 deletes the old path.

## Phase 7 — Delete Old Live Coordination And Update Operator Contract

* Goal:
  - Finish the breaking cutover so there is no second way to coordinate credentials.
* Work:
  - This phase removes the burden of the past implementation after all replacement paths exist.
* Checklist (must all be done):
  - Remove or reduce `sync codex`, `promote codex`, `sync claude`, `promote claude`, `sync openclaw`, `apply`, `internal apply-codex-promotion`, and `internal apply-claude-promotion` to hard-error stubs with Redis-era guidance.
  - Delete or quarantine authority import/promotion modules that are no longer used by migration.
  - Delete remote internal promotion plumbing from authority locator code so SSH authority writes cannot be invoked under another command.
  - Remove runtime use of `state.imports.authority`.
  - Restrict `--state` and legacy state-path behavior to migration/test contexts where needed; normal Redis-era commands must not use it as a shared-credential override.
  - Retire duplicate public Claude activation surfaces if Phase 6 introduced `aim claude run <label>` as canonical.
  - Update `src/cli/help.js` to describe Redis SSOT and migration.
  - Rewrite `README.md` to describe Redis primary on `agents`, Tailscale, config, migration, and no sync/promote operating mode.
  - Update `test/cli/readme-contract.test.js` to the new public command surface.
  - Remove or rewrite tests that assert old authority sync/promote success.
  - Keep only migration tests for old state reading.
  - Ensure old `~/.aimgr/secrets.json` references in live docs are migration-only or local legacy backup references.
* Verification (required proof):
  - CLI tests assert retired commands fail with Redis-cutover guidance.
  - README/help parity test passes with the new command surface.
  - `npm run lint`.
  - `npm test`.
* Docs/comments (propagation; only if needed):
  - This phase owns all live README/help/comment cleanup needed by the cutover.
* Exit criteria (all required):
  - There is no successful old authority sync/promote path.
  - There is no successful hidden internal authority promotion receiver.
  - Operator docs no longer teach file authority as the normal model.
  - Tests no longer encode old authority coordination as desired behavior.
  - Migration remains able to read old files.
  - `~/.aimgr/secrets.json` is only a legacy migration/backup artifact in live docs and comments.
* Rollback:
  - Restore previous command handlers/docs/tests only if the Redis runtime paths are also rolled back before production cutover.

## Phase 8 — Three-Machine Cutover Proof

* Goal:
  - Prove the implementation against the actual intended operating topology before considering the goal shipped.
* Work:
  - This phase is the final ops proof over `agents` at Amir's Mac Studio and the other two machines.
* Current live primary:
  - SSH target: `studio` (`agents@amirs-mac-studio`).
  - Tailscale node/IP: `amirs-mac-studio` / `100.96.80.106`.
  - Redis URL for AIM config: `redis://amirs-mac-studio:6380`.
  - Fallback Tailnet URL: `redis://100.96.80.106:6380`.
  - Tailscale Serve mapping: TCP `6380` to `tcp://127.0.0.1:6380`, tailnet-only.
  - Container: Docker/Colima `aimgr-redis` using `redis:7-alpine`.
  - Durable storage: Docker volume `aimgr-redis-data` mounted at `/data`.
  - Redis persistence: `appendonly yes`, `appendfsync everysec`.
  - Restart policy: `unless-stopped`.
* Checklist (must all be done):
  - Install/configure Redis or Valkey on `agents` at Amir's Mac Studio with AOF enabled.
  - Configure all three AIM installs with the same Redis URL, key prefix, primary host, and transport.
  - Run `aim redis ping` from all three machines.
  - Run migration collect on all three machines.
  - Copy the three migration bundles to one reviewed migration directory on the chosen apply machine.
  - Confirm each bundle's declared machine id matches the expected machine.
  - Review conflict/re-login-required output and apply the migration plan once as the single writer.
  - Export Redis after migration apply.
  - Run `aim status` from all three machines and confirm the same shared labels/sessions are visible.
  - Activate at least one Codex label from a non-primary machine without `sync` / `promote`.
  - Confirm migration report does not require mass Codex/Claude re-login.
* Verification (required proof):
  - Manual runbook evidence from the three machines.
  - Redis export artifact after cutover.
  - Saved migration plan/report showing no planned mass re-login for currently usable Codex/Claude accounts.
  - Command output snippets for config/ping/status and one target projection.
* Docs/comments (propagation; only if needed):
  - Update README operational notes if real Tailscale hostname differs from `redis://agents:6379`.
* Exit criteria (all required):
  - All three machines point to the same primary host/key prefix.
  - Redis has imported combined best data.
  - Old coordination commands are not needed for normal work.
  - Existing usable credentials were not discarded into a planned re-login wave.
* Rollback:
  - Stop using Redis commands, restore from migration backups, and clear the Redis prefix only before any new Redis-only session rotations are accepted as production truth.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

Avoid verification bureaucracy. Prefer existing credible signals that genuinely prove behavior. Keep the proof set lean but sufficient. Do not create tests whose main job is proving deletes, policing repo shape, scanning docs for terms, or enforcing absence by grep.

## 8.1 Unit tests (contracts)

- Redis key builders, record normalization, version compare-and-set behavior through a mockable Redis client boundary.
- Config read/write, machine-id creation, and local adjunct state shape.
- Migration candidate extraction, controlled refresh attempt handling, conflict detection, candidate ranking, clone-lineage detection, and plan apply transformation.
- Rebind/handoff command behavior and confirmation gates.
- Old command hard-error behavior for retired authority flows.

## 8.2 Integration tests (flows)

- CLI tests for `aim redis configure`, `config`, `ping`, `snapshot`, `migrate collect`, `migrate plan`, and `migrate apply`.
- Status from Redis snapshot with multiple machines and local projection drift.
- Panel maintenance and browser policy flows writing Redis plus local adjunct state.
- Codex/Claude/Pi/Hermes/OpenClaw projection flows reading Redis sessions and writing target auth files.
- Optional real Redis integration when `AIMGR_REDIS_TEST_URL` is set, focused on `WATCH` / `MULTI` / `EXEC` stale-write rejection.

## 8.3 E2E / device tests (realistic)

- On Tailscale, run Redis/Valkey on `agents` at Amir's Mac Studio.
- Configure all three machines with the same primary host and key prefix.
- Run migration collection on all three machines, apply once, then confirm `aim status` from each machine shows the same shared labels/sessions.
- Confirm one Codex label can be used from a non-primary machine without old sync/promote.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

1. Install and persist Redis/Valkey on `agents` at Amir's Mac Studio.
2. Configure all AIM installs with `~/.aimgr/config.yaml`.
3. Run migration collect on all three machines.
4. Copy all three bundles to one migration directory and confirm machine ids.
5. Review the migration plan for conflicts, controlled refresh failures, skipped credentials, and any re-login-required labels.
6. Apply once to an empty Redis prefix from one chosen apply machine.
7. Export Redis immediately after apply.
8. Run status and target projection checks.
9. Remove/hard-disable old authority flows.

## 9.2 Telemetry changes

No external telemetry. Local command receipts and status output should expose Redis source, machine id, session freshness, projection drift, stale-version conflicts, migration plan decisions, and skipped credential reasons.

## 9.3 Operational runbook

- Redis primary: `agents` at Amir's Mac Studio over Tailscale.
- Redis runtime: Docker/Colima container `aimgr-redis`, image `redis:7-alpine`, volume `aimgr-redis-data:/data`, restart policy `unless-stopped`.
- Redis endpoint: `redis://amirs-mac-studio:6380`; fallback direct Tailnet IP endpoint `redis://100.96.80.106:6380`.
- Tailscale Serve: TCP `6380` forwards to remote-local `127.0.0.1:6380`; Redis is bound to Mac Studio localhost and served over the tailnet.
- Config path: `~/.aimgr/config.yaml`.
- Machine id path: `~/.aimgr/machine-id`.
- Backup before cutover: migration bundle plus Redis export.
- Redis persistence: AOF enabled with `appendfsync everysec`.
- Redis unavailable: status may show cache diagnostics; mutating commands fail loud.
- Production cutover: no partial Redis cutover on live machines before Phase 8 passes.
- Local adjunct state: `~/.aimgr/local-state.json` contains only local non-credential receipts, bindings, assignments, demand/history, and active-target metadata.

<!-- arch_skill:block:consistency_pass:start -->
## Consistency Pass

- Reviewers: self-integrator, composer-2.5-fast fresh consult
- Scope checked:
  - TL;DR, Section 0, Section 3, Section 5, Section 6, Section 7, Section 8, Section 9, and Section 10.
  - Compatibility posture, migration boundary, Redis owner path, delete list, no-relogin requirement, no-Lua/no-daemon constraints, OpenClaw command consolidation, hidden internal authority receivers, panel/browser/auth paths, local adjunct state, repair commands, and Claude command drift.
- Findings summary:
  - The main plan consistently chooses a clean Redis cutover with a read-only migration bridge only.
  - The authoritative phase plan includes the required Redis primary/config setup, non-lossy migration, Redis-backed status/login/projections, old-path deletion, and three-machine proof.
  - The consult found real blockers: `aim internal apply-*-promotion`, panel/maintenance/browser/auth state paths, controlled migration refresh, explicit repair commands, three-machine bundle/apply workflow, and local non-credential state location. The plan now assigns each blocker to a section and phase.
- Integrated repairs:
  - Added `aim apply` and `aim sync openclaw` to retired duplicate surfaces.
  - Added a Decision Log entry explaining why `aim rebalance openclaw` is the single Redis-era OpenClaw command.
  - Added `aim internal apply-codex-promotion` / `apply-claude-promotion` and remote SSH promotion plumbing to the delete/hard-error scope.
  - Added controlled refresh/import attempts to Phase 2, with reportable provider rejection reasons.
  - Added panel maintenance, browser policy, auth command, and local adjunct state to the call-site audit and phase plan.
  - Added explicit `aim label rebind` and `aim session handoff` repair commands.
  - Added one-bundle-directory/one-apply-writer migration workflow and machine-id validation.
  - Made `aim claude run <label>` the canonical Redis-era Claude surface from the investigation doc.
  - Incorporated second-consult notes: explicit `label`/`session` command routing, bundle-based controlled refresh host semantics, `src/targets/codex-tender.js`, full panel write coverage, and the Phase 4-to-Phase 6 Hermes sync boundary.
- Remaining inconsistencies: none
- Unresolved decisions: none
- Unauthorized scope cuts: none
- Decision-complete: yes
- Decision: proceed to implement? yes
<!-- arch_skill:block:consistency_pass:end -->

# 10) Decision Log (append-only)

## 2026-05-30 - Intent-derived: clean Redis cutover

Blocker: Whether the implementation should preserve old authority/sync behavior as a compatibility mode.

Consulted: `docs/three-machine-credential-coordination-investigation-2026-05-30.md`, TL;DR, Section 0.

Intent says: The user explicitly wants a breaking non-reverse-compatible change that deletes the old way, keeps Redis as the only shared home, and avoids carrying multiple coordination models.

Decision: Plan a clean Redis cutover. Old authority files may be read for migration, but old sync/promote behavior must not remain live after cutover.

Consequences: Migration has to be strong enough to preserve current usable data before deleting/hard-disabling old behavior.

## 2026-05-30 - Intent-derived: remove duplicate OpenClaw apply surface

Blocker: Whether `aim apply` and `aim sync openclaw` should survive because they are target projection commands rather than file-authority credential sync.

Consulted: TL;DR non-negotiables, Section 0.2, Section 5.5, Section 7 Phase 7, and the source investigation doc's command surface.

Intent says: The user wants one clean new way without multiple operating modes, and the source investigation names `aim rebalance openclaw` as the Redis-era OpenClaw command.

Decision: Retire `aim apply` and `aim sync openclaw` as successful live commands. `aim rebalance openclaw` owns OpenClaw projection in the Redis era.

Consequences: Phase 7 must update help, README, command tests, and OpenClaw tests so old OpenClaw apply/sync surfaces do not remain a second way to do the same thing.

## 2026-05-30 - Consult-derived: delete hidden internal authority receivers

Blocker: `aim internal apply-codex-promotion` and `aim internal apply-claude-promotion` can write authority state from stdin and are invoked through SSH promotion plumbing.

Consulted: Fresh consult `composer-2.5-fast`, `src/cli/commands/internal.js`, `src/credentials/authority-locator.js`, Section 6, and Section 7.

Intent says: The Redis cutover cannot leave a second live way to coordinate credentials, even if it is hidden behind an internal command.

Decision: Retire or hard-error the internal promotion receivers and remove remote internal promotion plumbing from runtime code. Migration may keep read-only authority parsing, but no remote authority write survives.

Consequences: Phase 7 owns deletion/hard-error tests for internal promotion, not only public `promote` commands.

## 2026-05-30 - Consult-derived: controlled migration refresh is mandatory

Blocker: The migration could otherwise classify expired-but-refreshable accounts as re-login-required and fail the no-mass-relogin bar.

Consulted: Fresh consult `composer-2.5-fast`, source investigation re-login policy, Section 0.4, Section 6.2, and Section 7 Phase 2.

Intent says: Having to re-login to many currently usable Codex/Claude accounts after cutover is a failed migration.

Decision: Phase 2 must attempt controlled refresh/import for expired candidates that still contain refresh material before marking a label re-login-required. Provider rejection is recorded as evidence; silent discard is forbidden.

Consequences: Migration fixtures and reports must cover refresh success, refresh identity mismatch, provider rejection, and truly unusable credentials.

## 2026-05-30 - Consult-derived: explicit local adjunct state replaces shadow `secrets.json`

Blocker: Browser bindings, OpenClaw assignments, demand ledgers, usage history, and projection receipts currently live beside credentials in `secrets.json`.

Consulted: Fresh consult `composer-2.5-fast`, `src/panels/actions.js`, `src/panels/maintenance.js`, `src/cli/commands/browser.js`, `src/cli/commands/auth.js`, Section 5, Section 6, and Section 7.

Intent says: Redis is the only shared home after cutover, but target tools still need local non-credential receipts/config.

Decision: Add `~/.aimgr/local-state.json` for local-only non-credential state. Shared credential and label policy goes to Redis; machine-specific browser paths, projection receipts, OpenClaw assignments, demand/history, and active target metadata go to local adjunct state.

Consequences: Runtime code must not use old `secrets.json` as a shadow SSOT. Tests must prove panel/browser/projection paths write Redis plus local adjunct state, not shared credentials in `secrets.json`.

## 2026-05-30 - Investigation-aligned: Claude run is the canonical Redis-era Claude surface

Blocker: Current code exposes `aim claude use`, while the investigation specifies `aim claude run <label>` with per-label homes when possible.

Consulted: Fresh consult `composer-2.5-fast`, source investigation command surface, `src/cli/commands/claude.js`, `src/targets/claude-cli.js`, Section 5.5, and Section 7 Phase 6.

Intent says: The implementation should get onto the new way cleanly instead of carrying parallel operator models.

Decision: Plan `aim claude run <label>` as the canonical Redis-era Claude command. Old `aim claude use` should be retired or hidden as an internal helper, not remain a second public activation flow.

Consequences: Phase 6 must handle launch/projection, per-label home behavior where possible, native bundle publish after rotation, and help/README/test updates.

## 2026-05-30 - Investigation-aligned: repair is explicit, not file copying

Blocker: Identity mismatch and copied refresh-token lineage repair could otherwise fall back to ad hoc manual copying.

Consulted: Source investigation `aim label rebind` and handoff sections, fresh consult `composer-2.5-fast`, Section 5.5, and Section 7 Phase 4.

Intent says: No machine owns a label, but wrong-account changes and rotating-token lineage movement must be intentional.

Decision: Add `aim label rebind <label> --confirm` and `aim session handoff <label> --from <machineId> --to <machineId> --confirm`. Rebind changes stable identity only after explicit review; handoff marks the source session stale/revoked and records destination lineage as `handoff`.

Consequences: Repair commands require confirmation and CAS. They are not compatibility shims and do not clone one refresh token for concurrent use on multiple machines.
