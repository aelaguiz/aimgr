---
title: "Claude Credentials — Consolidate Into AIM Redis — Plan"
date: 2026-07-22
status: active
fallback_policy: forbidden
owners: [Codex]
reviewers: []
doc_type: migration
related:
  - docs/REDIS_SHARED_CREDENTIAL_STORE_SIMPLIFIED_PLAN_2026-05-30.md
  - docs/REDIS_CREDENTIAL_COORDINATION_IMPLEMENTATION_PLAN_2026-05-30.md
  - /Users/aelaguiz/workspace/secrets/docs/claude-usage-checker/CLAUDE_USAGE_CHECKER.md
---

# TL;DR

- Outcome: AIM Redis becomes the only shared source of truth for Claude account policy and complete native credential bundles; local Claude homes and Keychain items are projections only.
- Problem: the new Claude inventory/rate-limit work bypasses Redis through a private home registry, direct Keychain reads, and a second usage cache, while live Redis contains zero Anthropic records.
- Approach: reuse AIM's existing versioned Redis credential records, native-bundle capture/import, per-label projection, rotation publication, provider usage probing, and local-state receipt patterns; migrate one live account as a canary before the rest.
- Plan: first map every duplicate reader/writer and close the Redis contracts; then wire a Redis-backed Claude account view and migration canary; finally migrate the loaded cohort, remove the private runtime path and duplicate code, and audit for one source of truth.
- Non-negotiables:
  - Never emit or persist raw tokens outside the existing Redis credential boundary and Claude's required local projection.
  - Never overwrite a credential whose stable identity differs or whose version advanced.
  - No bulk live migration before one capture/projection/rotation canary passes.
  - No compatibility fallback to the private registry or direct Keychain status path after cutover.

## North Star

### Claim

> If Claude account policy, native credential bundles, usage checks, and rotation publication all flow through the existing AIM Redis record boundary, then any attached machine can select the same canonical account label without a second credential registry, measured by a fresh remote projection and one successful identity-preserving rotation whose Redis version advances.

### In scope

- UX:
  - Preserve a fast account-labelled Claude inventory/status surface through AIM.
  - Keep missing, expired, stale, throttled, and usage-readable states explicit.
- Technical:
  - Store Claude candidate policy and complete loaded credentials in existing versioned Anthropic Redis records.
  - Reuse existing Redis identity/CAS/projection/rotation machinery.
  - Make local Claude homes and Keychain services derived projections rather than authorities.
  - Remove the private registry, direct Keychain credential reader, second usage cache, and their duplicate CLI/dependency paths from runtime.
  - Migrate the currently loaded native cohort through an identity-safe canary-first rollout.

### Out of scope

- UX:
  - Logging additional BrowserOS profiles into Google or Claude.
  - Purchasing, reactivating, or changing Claude subscriptions.
- Technical:
  - Replacing Redis infrastructure, key prefix, or transport.
  - Changing Codex, Sakana, Pi, Hermes, or OpenClaw credential semantics.
  - Adding a fallback that silently reads old local credential authorities.

### Acceptance evidence

- Primary signal:
  - From `Amirs-M3-Max-2`, AIM projects a selected migrated Claude label from Redis into a fresh per-label home, Claude reports the exact intended identity through an allowlisted status boundary, and a controlled native refresh advances only that label's Redis credential version/rotation fields.
- Optional second signal:
  - A provider-filtered Redis inventory/status repeat uses the existing bounded cache and performs zero additional provider requests.
- Metrics or thresholds:
  - Zero raw credential values in terminal output, logs, plan/worklog, local AIM state, or test snapshots.
  - At most one provider usage request per selected uncached account and no automatic retry.
  - Zero runtime imports or references to the retired private registry, direct Keychain reader, or duplicate Claude usage cache after cutover.

### Key invariants

- No fallbacks without explicit approval.
- No dual sources of truth.
- Redis credential CAS and stable-identity checks are mandatory for every publish.
- Claude's local secure storage may exist only as a projection selected by `aim claude run` or an equivalent existing AIM-owned boundary.
- Candidate-only accounts may have policy records with no credential, but must never appear ready.
- A local direct-login credential is migration input only; after capture it cannot remain an unsynchronized runtime authority.

## Problem Statement

### What exists today

- AIM already defines Redis as shared credential truth and stores versioned per-provider/per-label records.
- Redis-aware Claude import/capture publishes a complete native bundle; `aim claude run` projects it and publishes rotations back.
- A separate uncommitted Claude checker reads per-config macOS Keychain services directly, uses `~/.aimgr/claude-account-registry.json`, and maintains `~/.aimgr/claude-usage-cache.json`.
- Four native slots currently match their canonical account policies on `Amir-M5` (`pro1`,
  `coder`, `pro4`, and `pro5`). The slot historically attributed to `pro3` now fails exact
  identity matching and is excluded from migration.
- The configured shared Redis prefix currently has zero Anthropic records.
- `Amirs-M3-Max-2` has ordinary `~/.claude` storage and no copied AIM Claude registry/cache.
  That path is only a storage location: `default` is not an account or profile and must never become
  an AIM label.

### What is broken or missing

- Symptoms:
  - AIM's documented Redis source of truth disagrees with the actual Claude auth authorities.
  - The remote machine cannot discover or project the loaded cohort from Redis.
  - Account inventory/status duplicates identity binding, credential loading, usage caching, and output contracts outside the Redis runtime.
- Likely causes:
  - The checker was optimized first for a read-only Keychain canary and never ported back onto AIM's established Redis record model.
  - Existing native capture expects file-backed bundles and does not yet consume Claude's macOS Keychain-backed secure storage safely.
- Why now:
  - BrowserOS profiles and the remote skill environment are prepared, but expanding authentication before consolidating authority would multiply unsynchronized credentials.

<!-- project_flow:block:research_grounding:start -->
## Research Grounding

### Internal ground truth

- `aimgr.credential.v1` already stores a complete provider credential, stable identity, policy,
  health, provenance, and CAS version. `publishMaintainedCredential()` is the existing
  capture/import publication boundary, while `publishRedisStateCredential()` is the existing
  rotation publication boundary.
- `aim claude run` already projects a complete Redis bundle into a label-owned local target and
  attempts to publish post-run rotations. The existing fake-Redis projection suite proves the
  file-backed path, but not current macOS Keychain-backed Claude storage.
- The draft Claude checker adds more than 2,100 lines of parallel runtime under
  `src/targets/claude-*`: private registry parsing, native-profile discovery, Keychain credential
  reads, identity binding, usage cache/locks, provider orchestration, and rendering.
- AIM's existing `redis-cache.json` is currently a diagnostic fallback only. It does not provide a
  five-minute provider TTL, one-hour stale ceiling, per-label binding, throttling backoff, or
  single-flight behavior.
- The live shared `aimgr:v1:` prefix had zero Anthropic records at the start of this migration.
  The four identity-matched source-machine native slots are Keychain-backed; the copied repository
  and remote BrowserOS profile shells do not contain those grants. A fifth historical mapping now
  fails exact identity validation and is not a credential source for its former label.
- Three identity-matched candidates (`coder`, `pro4`, and `pro5`) have current provider evidence in
  the retired registry. `pro1` has contradictory billing evidence. Historical candidates must not
  be promoted to "active" merely because a BrowserOS profile shell or old registry row exists.

### Existing patterns to reuse

- `normalizeCredentialRecord()`, `publishCredential()`, and `casPutJsonRecord()` remain the only
  shared Redis schema/mutation boundary.
- `buildStableIdentityForCredential()`, expected-email validation, duplicate-bundle detection,
  `hasCompleteClaudeNativeBundle()`, and `derivePoolAccountStatus()` remain canonical identity and
  readiness primitives.
- `fetchClaudeUsageSnapshot()` and `buildClaudeUsageWindows()` remain the one provider request and
  response parser. The dedicated Claude command must call with `allowWebFallback: false`.
- `resolveAimgrRedisCachePath()` remains the sole AIM status cache path. It will receive a versioned,
  strictly allowlisted provider-usage section rather than a second Claude cache file.
- `formatStatusTable()` and the existing status account formatting semantics remain the rendering
  basis; the new Claude view may add arbitrary scoped weekly columns without another authority.
- A narrowly scoped full-Keychain capture adapter may exist only at capture/projection boundaries.
  Normal inventory/status must never import it or scan local Claude profiles.

### Evidence-based open questions

- Whether managed Claude projection should write Keychain immediately or first remain a disposable,
  file-backed proof. A live `aim claude run` is blocked until the projection reads and synchronizes
  the actual Keychain authority without placing secrets in argv or leaving mixed file identities.
- Which exact accounts beyond the currently provider-verified cohort are still actively billed.
  Historical evidence is retained as candidate provenance, not treated as current billing proof.
<!-- project_flow:block:research_grounding:end -->

<!-- project_flow:block:current_architecture:start -->
## Current Architecture

### Shared Redis path

1. `readSnapshot()` loads versioned credential records.
2. `buildCoordinationView()` projects record policy and credential data into AIM's in-memory state.
3. Capture/import calls `persistAnthropicNativeBundleForLabel()` and
   `publishMaintainedCredential()`.
4. `aim claude run` calls `activateClaudeLabelSelection()`, launches Claude, calls
   `syncLiveClaudeRotationBackToLabel()`, and publishes with `publishRedisStateCredential()`.

### Duplicate local checker path

1. `claude-account-inventory.js` treats `~/.aimgr/claude-account-registry.json` as account truth.
2. `claude-usage-status.js` scans `.claude-*` directories, derives Keychain services, reads access
   credentials directly, and writes `~/.aimgr/claude-usage-cache.json` plus a lock.
3. `claude-account-usage-status.js` maps private registry labels onto those local storage slots.
4. `aim claude inventory/status/usage` invokes that path even on Redis-configured installs.

### Confirmed defects in the shared path

- Policy-only records normalize to `health=ready`, project `credential={}`, and can render
  credentials as present.
- A successful Redis publication does not advance `runtime.snapshot`, so a second publication in
  one Claude run can CAS against an obsolete version.
- Stable-identity compatibility does not compare credential freshness; an older same-identity
  native bundle can overwrite a newer record if the caller holds the current Redis version.
- Current capture, projection, clear, status, and rotation are file-only, while current Claude on
  macOS stores native OAuth in Keychain.
- Projection writes the credential file before fully preflighting app state, so failure can leave a
  mixed identity.
<!-- project_flow:block:current_architecture:end -->

<!-- project_flow:block:target_architecture:start -->
## Target Architecture

```text
BrowserOS/native initial sign-in (only when required)
              |
              v
exact one-slot Keychain capture adapter -- complete bundle, strict identity/freshness
              |
              v
      aimgr.credential.v1 in Redis (policy + credential + identity + CAS version)
          |                                      |
          |                                      +--> thin Redis inventory/status
          |                                           + existing redis-cache.json usage section
          v
managed per-label Claude projection
          |
          +--> official Claude rotation --> strict newer-same-identity CAS publish to Redis
```

- Redis records are the only shared account-policy and credential authority.
- Candidate-only records have `credential={}`, empty verified identity, and explicit
  candidate/missing health. They never project into `state.credentials` and never probe Anthropic.
- Inventory performs one Redis read and zero provider, browser, Keychain, native-file, or Claude CLI
  calls.
- Status validates canonical Redis labels, probes only fresh complete selected credentials, performs
  at most one no-retry request per uncached account with concurrency three, and never falls back to
  claude.ai cookies.
- Provider usage lives only in a versioned, strict-allowlist section of the existing
  `redis-cache.json`; entries are bound to the authoritative Redis credential generation and never
  contain identity, policy, tokens, paths, or raw provider errors.
- Native Keychain capture is exact-path and one-label only. It is migration/maintenance input, not a
  status fallback or second authority.
- Adoption and rotation require a complete strict identity (`accountUuid`, normalized email,
  organization UUID), reject duplicate labels, reject older or equal-expiry ambiguous token sets,
  and never auto-retry a stale CAS.
- Capture, import, and run share one expiring Redis lease per Anthropic label. Managed runs create a
  durable uncertainty fence before launching the exact Claude executable behind an IPC parent-death
  supervisor. A prior fence never clears on unchanged local tokens; it resolves only through a later
  Redis version carrying the exact fence/base provenance and a different access/refresh token-pair
  fingerprint, or through an explicit identity/freshness-checked replacement. Fence deletion also
  atomically requires current lease ownership.
<!-- project_flow:block:target_architecture:end -->

<!-- project_flow:block:call_site_audit:start -->
## Call-Site Audit

### Retain and harden

- `src/coordination/{records,redis-store,runtime,snapshot,login-publish,redis-credential-lease,redis-claude-rotation-fence}.js`
- `src/credentials/{anthropic,claude-bundle,claude-native}.js`
- `src/pool/{account-status,usage}.js`
- `src/status/{redis-view,table,render,view}.js`
- `src/targets/{claude-cli,claude-status,claude-runner,claude-supervisor}.js`
- Redis projection/capture/import tests and provider-level usage-parser tests.

### Replace with one thin Redis view

- `src/targets/claude-account-inventory.js`
- `src/targets/claude-account-usage-status.js`
- `src/targets/claude-usage-status.js`
- Their three oversized test files, retaining only behavior that applies to Redis labels, bounded
  usage caching, redaction, and provider parsing.

### Remove after cutover

- `resolveClaudeAccountRegistryPath()` and `resolveClaudeUsageCachePath()`.
- Direct Keychain-reader injection from `cli/deps.js`, `cli/main.js`, and the Claude status command.
- README/help claims about private registry authority, native-profile discovery, and the second cache.
- Runtime references to `claude-account-registry.json`, `claude-usage-cache.json`,
  `nativeProfile`, profile discovery, or direct Keychain status reads.

### Add narrowly

- One versioned Redis cache-envelope/provider-usage owner.
- One provider-filtered Redis Claude view shared by inventory/status/usage.
- One exact-config-dir Keychain capture/projection helper that handles complete native bundles only
  inside credential boundaries and has no public token-bearing result.
- Regression tests for candidate semantics, stale same-identity rollback, two publications in one
  runtime, pair-safe projection, strict output allowlists, bounded requests, and zero-request repeat.
<!-- project_flow:block:call_site_audit:end -->

<!--
project_flow:phase_plan_granularize
level: 4
pass_count: 1
last_updated: 2026-07-22
-->

<!-- project_flow:block:phase_plan:start -->
## Depth-First Phase Plan

### Phase 1 — Close the Redis Claude contracts

- Goal: prove and extend the existing Redis model so candidate policy, complete credentials, provider status, and secure native capture have one authoritative representation.
- Work:
  - [x] P1.T1 — Complete the source/call-site audit and lock the delete list.
  - [x] P1.T2 — Define candidate-only versus credential-ready Anthropic record invariants and public status mapping.
  - [x] P1.T3 — Add a secret-safe native Keychain capture adapter that produces the existing Claude native bundle shape without public credential output.
  - [x] P1.T4 — Prove identity mismatch, duplicate identity, stale Redis version, expired access, and rotated refresh-token behavior with fakes.
- Verification:
  - Focused Redis record, Claude capture, and provider status tests pass with leak sentinels.
- Exit criteria:
  - One in-memory native credential can enter and leave the existing Redis record path without any old registry/cache dependency.
- Rollback:
  - Code-only rollback before live capture; no live Redis mutation in this phase.

### Phase 2 — Wire one Redis-backed account slice end to end

- Goal: replace the duplicate Claude inventory/status path with a thin Redis provider view and prove one live account can move safely.
- Work:
  - [x] P2.T1 — Implement account-labelled Redis inventory/status using existing records, usage probing, cache/backoff, and redaction contracts.
  - [ ] P2.T2 — Migrate the canonical candidate policy roster into Redis without credentials and prove candidate-only rows stay closed.
  - [ ] P2.T3 — Capture one loaded `Amir-M5` canary after exact identity and Redis-version checks.
  - [ ] P2.T4 — Project the canary on `Amirs-M3-Max-2`, verify exact identity, and prove one official rotation publishes back to Redis.
- Verification:
  - Local tests plus one bounded live canary; immediate status repeat makes zero additional provider requests.
- Exit criteria:
  - The canary is usable remotely from Redis, its local source is no longer required for runtime, and no other credential metadata changed.
- Rollback:
  - Restore the canary from its untouched local Keychain source only if projection fails before rotation; never overwrite a newer Redis version.

### Phase 3 — Migrate the cohort and delete the duplicate path

- Goal: finish the source-of-truth cutover and remove every parallel runtime reader, cache, schema, flag, test, and documentation claim.
- Work:
  - [ ] P3.T1 — Migrate each remaining loaded native account sequentially with the proven identity/CAS protocol.
  - [x] P3.T2 — Replace direct per-account runtime launchers with AIM-owned Redis projection entry points or mark them migration-only.
  - [x] P3.T3 — Delete the private registry reader, direct Keychain status reader, duplicate usage cache/locks, duplicate CLI dependency injection, and obsolete tests/help/docs.
  - [ ] P3.T4 — Archive or remove superseded local registry/cache artifacts recoverably after code no longer references them.
  - [ ] P3.T5 — Run full tests, lint, static old-path searches, and a cross-machine read-only Redis inventory.
- Verification:
  - Full suite and lint pass; old-path trap searches are empty; Redis reports the expected Anthropic policy roster and loaded credential count; no live raw secrets are emitted.
- Exit criteria:
  - Redis is the only shared Claude account/credential authority and every remaining local auth surface is a derived projection or documented backup artifact.
- Rollback:
  - Per-account only using preserved local Keychain state until that account's first successful Redis-backed rotation; no global rollback or dual-read fallback.

### Phase 4 — Independent implementation audit

- Goal: prove the code and live topology match this plan before calling the migration complete.
- Work:
  - [x] P4.T1 — Run a clean code-vs-plan audit of contracts, call sites, delete expectations, and proof freshness.
  - [x] P4.T2 — Record blockers, reopen false-complete phases, and resolve them before final status.
- Verification:
  - Implementation audit verdict is COMPLETE with manual QA either complete or explicitly scoped.
- Exit criteria:
  - No code blocker, parallel writer/reader, or unsupported completion claim remains.
- Rollback:
  - n/a
<!-- project_flow:block:phase_plan:end -->

<!-- project_flow:block:implementation_audit:start -->
## Implementation Audit

Offline cutover verdict: **PASS**. The audit found and the implementation closed the practical
parallel-authority and continuity blockers: normalized generic Anthropic import/migration side doors,
policy-only false readiness, stale-snapshot publication, same-token and expiry-only false successors,
cross-machine lease/fence races, arbitrary higher-version fence clearing, direct refresh writers,
duplicate private registry/cache readers, and browser-cookie usage fallback.

Fresh proof on 2026-07-22:

- Focused Claude/Redis suite: 63/63 passed.
- Full AIM suite: 310/310 passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- Static traps for the retired private registry/cache modules, direct Anthropic refresh calls,
  claude.ai cookie fallback, and the abandoned process-group receipt experiment: empty.

The audit does **not** claim that live migration is complete. No live Redis credential population,
Keychain capture, Anthropic request, BrowserOS operation, or cross-machine rotation canary occurred in
this implementation pass. P2.T2–P2.T4, P3.T1, P3.T4, and the live portion of P3.T5 remain open. The
next state-changing step is still exactly one identity-checked account canary, not a cohort migration.
<!-- project_flow:block:implementation_audit:end -->
