---
title: "Sakana Fugu — Multi-Key Rate-Limit Rotation — Plan"
date: 2026-06-22
status: draft
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: new_system
related:
  - README.md
  - docs/REDIS_SHARED_CREDENTIAL_STORE_SIMPLIFIED_PLAN_2026-05-30.md
  - docs/REDIS_CREDENTIAL_COORDINATION_IMPLEMENTATION_PLAN_2026-05-30.md
---

# TL;DR

- Outcome: AIM can store many Sakana API keys, choose the healthiest key for `fugu` / `fugu-ultra`, project only the selected key into Codex, and rotate away from keys that hit Sakana rate limits.
- Problem: Today `~/.codex` has one `SAKANA_API_KEY`, so every Fugu/Fugu Ultra Codex run burns the same subscription-backed API key until it fails.
- Approach: Add Sakana as an API-key credential provider in AIMGR, reuse the Redis credential records and pool/ranking receipts, and add a small Sakana target that writes `~/.codex/.env` instead of OAuth auth files.
- Plan:
  - Phase 1 adds provider/state/CLI foundations without touching Codex OAuth paths.
  - Phase 2 adds projection, selection, and status with conservative unknown-usage handling.
  - Phase 3 adds failure-driven cooldown/rotation and Tend integration for long Codex runs.
  - Phase 4 adds tests, docs, and migration/import helpers.
- Non-negotiables:
  - Never print or log raw Sakana keys.
  - Do not pretend usage is known when Sakana exposes no usage endpoint.
  - Keep OAuth provider handling separate from API-key provider handling.
  - Keep `~/.codex/.env` a derived local target file, not the shared source of truth.

## North Star

### Claim
> If we add a `sakana` API-key provider to AIMGR and project the selected key into `~/.codex/.env`, then a user can run `codex -p fugu` or `codex -p fugu-ultra` through the existing AIMGR rotation workflow and recover from per-key rate limits without manual key swapping, measured by integration tests that rotate from a synthetic limited key to an alternate key and by a real `GET /v1/models` smoke check against the selected key.

### In scope
- UX:
  - Add commands for importing, listing, selecting, marking, and watching Sakana API-key labels.
  - Show a redacted Sakana section in `aim status`.
  - Support both explicit label selection and automatic next-best selection.
- Technical:
  - Add provider constant `SAKANA_PROVIDER = "sakana"`.
  - Store Sakana API keys in Redis credential records under provider `sakana`.
  - Add a Sakana target projection that writes `SAKANA_API_KEY=<selected key>` to `~/.codex/.env` with `0600` permissions.
  - Add usage/cooldown snapshots that work even when Sakana only exposes failure signals.
  - Add Tend rotation support for Fugu/Fugu Ultra Codex profiles.

### Out of scope
- UX:
  - No Sakana OAuth or browser login UI.
  - No automatic subscription purchasing or API key creation.
- Technical:
  - No changes to Sakana's Codex model catalog content unless needed for compatibility.
  - No storing Sakana keys in `~/.codex/config.toml`.
  - No hidden fallback to OpenAI/Anthropic when a Sakana pool is empty.

### Acceptance evidence
- Primary signal:
  - `aim sakana use` writes a redacted-key-safe `~/.codex/.env`, `aim sakana watch --once` rotates away from a synthetic rate-limited key, and tests prove no raw key appears in JSON/status output.
- Optional second signal:
  - With a real key, `GET https://api.sakana.ai/v1/models` returns `fugu`, `fugu-ultra`, and `fugu-ultra-20260615`; after selecting another label, the same smoke check uses the new key.
- Metrics or thresholds:
  - A 429/402/quota-style failure marks the active key ineligible immediately.
  - Cooldown must default to a bounded conservative value when no reset time is available.
  - Pool selection must never choose a key in cooldown unless explicitly forced.

### Key invariants
- No fallbacks without explicit approval.
- No dual sources of truth.
- Raw Sakana keys only live inside Redis credential payloads and the local projected `~/.codex/.env` target.
- Redacted output uses a stable fingerprint, not the secret value.
- OAuth-specific commands keep supporting only OpenAI Codex and Anthropic.
- Existing Codex OAuth `aim codex use/watch/run --tend` behavior must not regress.

## Problem Statement

### What exists today
- `~/.codex/config.toml:68-75` defines a single `sakana` model provider with `base_url = "https://api.sakana.ai/v1"`, `env_key = "SAKANA_API_KEY"`, `wire_api = "responses"`, and long stream retry/timeout settings.
- `~/.codex/fugu.config.toml:1-11` selects model `fugu`, provider `sakana`, and catalog `~/.codex/fugu.json`.
- `~/.codex/fugu-ultra.config.toml:1-11` selects model `fugu-ultra`, provider `sakana`, and the same catalog.
- `~/.codex/fugu.json` defines two local model slugs, `fugu` and `fugu-ultra`, both with 1M context windows and high reasoning.
- `~/.codex/.env` currently contains exactly one `SAKANA_API_KEY` value. This is the active key for both Fugu profiles.
- `aim status --json --compact` shows Redis is live at `redis://amirs-mac-studio:6380`, key prefix `aimgr:v1:`, with 24 OpenAI Codex credentials and local Codex active label `pro3`.
- `src/core/constants.js:22-24` currently names only `openai-codex` and `anthropic` as credential providers.
- `src/core/constants.js:105-119` defines `SUPPORTED_OAUTH_PROVIDERS`, which should not become the generic provider list because Sakana has no OAuth path.
- `src/state/schema.js:144-165` initializes only `credentials.openai-codex`, `credentials.anthropic`, `pool.openaiCodex`, and `pool.anthropic`.
- `src/coordination/records.js:42-60` already accepts arbitrary normalized provider IDs in Redis credential records, so Redis is closer to provider-neutral than the local state helpers.
- `src/coordination/snapshot.js:16-39` already reconstructs a local coordination view from provider/label credential records and can carry new provider records once `ensureStateShape` preserves them.
- `src/pool/usage.js:304-361` probes only OpenAI Codex and Anthropic usage.
- `src/pool/ranking.js:14-32` exposes provider-specific pool label helpers for OpenAI Codex and Anthropic.
- `src/targets/codex-cli.js:24-78` activates OpenAI Codex by writing `~/.codex/auth.json`; this cannot be reused directly for Sakana because Sakana needs an environment key, not OAuth tokens.
- `src/openclaw/apply.js:30-85` only materializes OAuth profile records for OpenAI Codex and Anthropic into OpenClaw auth stores.
- `src/targets/codex-tender.js:16` rotates when Codex rollout goal status becomes `usageLimited`, then calls OpenAI-Codex-specific rotation code at `src/targets/codex-tender.js:190-220` and `src/targets/codex-tender.js:555-590`.

### What is broken or missing
- Symptoms:
  - Sakana Fugu/Fugu Ultra has a working Codex provider config, but AIMGR does not know it exists.
  - Rotating OpenAI Codex labels changes `~/.codex/auth.json`, not `SAKANA_API_KEY`, so it does not help Fugu/Fugu Ultra.
  - There is no shared inventory of Sakana keys, subscription tiers, cooldowns, or last-failure state.
- Likely causes:
  - AIMGR was built around OAuth subscription accounts first.
  - Existing ranking assumes live percentage windows from provider usage endpoints.
  - Sakana key rotation is a target projection problem, but there is no env-file target abstraction yet.
- Why now:
  - Fugu and Fugu Ultra are configured locally and active, but one hard-coded key creates avoidable single-key rate-limit failures.

## Research Grounding

<!-- project_flow:block:research_grounding:start -->
## Research Grounding

### Internal ground truth
- Authoritative anchor: `~/.codex/config.toml:68-75` — Codex reads Sakana credentials through `env_key = "SAKANA_API_KEY"` and uses the Responses wire API.
- Authoritative anchor: `~/.codex/fugu.config.toml:1-11` — local Fugu Codex profile uses provider `sakana`.
- Authoritative anchor: `~/.codex/fugu-ultra.config.toml:1-11` — local Fugu Ultra Codex profile uses provider `sakana`.
- Authoritative anchor: `~/.codex/.env` — current Sakana key target is a local env file, not OAuth auth JSON.
- Authoritative anchor: `src/coordination/records.js:42-60` — Redis credential records can already store arbitrary provider IDs with credential, identity, policy, health, and provenance.
- Authoritative anchor: `src/coordination/snapshot.js:16-39` — coordination view creation already loops over all Redis credential records and creates `state.credentials[record.provider]` dynamically.
- Authoritative anchor: `src/state/schema.js:144-165` — local state normalization still hardcodes OpenAI Codex and Anthropic pool scaffolding.
- Authoritative anchor: `src/pool/usage.js:7-72` — OpenAI Codex usage is a live `wham/usage` endpoint with 5h/week windows; Sakana may not have an equivalent.
- Authoritative anchor: `src/targets/codex-cli.js:465-610` — pool activation has the right receipt and history shape but is tied to OAuth usage snapshots and `auth.json` projection.
- Authoritative anchor: `src/targets/codex-tender.js:555-590` — Tend already has the desired stop/rotate/resume loop; it needs a provider-specific rotation adapter.

### Existing patterns to reuse
- `src/coordination/redis-store.js` — CAS-backed Redis record writes, provider indexes, and snapshot reads.
- `src/coordination/runtime.js` — Redis runtime load/mutate/write-local-state boundary.
- `src/core/sanitize.js` — redaction boundary for user-visible JSON.
- `src/pool/history.js` — append-only selection/exhaustion history receipts.
- `src/pool/ranking.js` / `src/pool/weighted-planner.js` — reusable weighted candidate ranking once Sakana can produce comparable capacity snapshots.
- `src/targets/codex-store.js` — fail-loud checks before mutating a Codex target home.
- `src/cli/commands/codex.js` — model for Redis-backed command handlers and scheduler-safe `watch --once` output.

### Evidence-based open questions
- Does Sakana expose a usage or rate-limit status endpoint? — evidence needed: official docs or an authenticated endpoint that returns remaining quota/limit windows.
- Does Sakana return `x-ratelimit-*`, `retry-after`, or equivalent headers on generation 429s? — evidence needed: captured 429 response headers/body from a real limited key.
- Does Codex convert a Sakana 429 into rollout goal status `usageLimited`? — evidence needed: a controlled Fugu/Fugu Ultra run against a deliberately exhausted or invalid limited key.
- Are Sakana limits per API key, per subscription account, or per billing plan even when multiple keys share the same subscription? — evidence needed: Sakana console/help docs or direct support answer.
<!-- project_flow:block:research_grounding:end -->

## External Research

<!-- project_flow:block:external_research:start -->
## External Research

### Topics researched
- Sakana Fugu API shape — determines whether AIMGR should treat Sakana like OpenAI-compatible API-key projection instead of OAuth.
- Sakana model support and endpoints — determines which smoke tests and model IDs should be supported.
- Sakana billing/subscription limits — determines which metadata operators should enter per key.
- Sakana rate-limit observability — determines whether rotation is proactive or failure-driven.

### Findings and how we apply them

#### API and Codex setup
- Best practices:
  - Sakana's docs describe Fugu as usable like a standard LLM through the Sakana API and supporting both Chat Completions and Responses endpoints.
  - Sakana's docs show Codex setup with provider `sakana`, base URL `https://api.sakana.ai/v1`, env key `SAKANA_API_KEY`, and the same stream retry/timeout fields already present locally.
- Recommended default for this plan:
  - Store keys in AIMGR Redis, then project exactly one selected key into `~/.codex/.env` as `SAKANA_API_KEY`.
- Pitfalls:
  - Do not store keys in `config.toml`; the local provider already points at an env var.
- Sources:
  - Sakana console `Get Started` — `https://console.sakana.ai/get-started` — official setup page; scraped locally on 2026-06-22.
  - Local `~/.codex/config.toml` — current installed setup matches the official provider block.

#### Supported models and smoke check
- Best practices:
  - Sakana's model docs list OpenAI-compatible Chat Completions, Responses, and Models APIs and recommend Responses for generation.
  - Local authenticated smoke check on 2026-06-22: `GET https://api.sakana.ai/v1/models` returned HTTP 200 with `fugu`, `fugu-ultra`, and `fugu-ultra-20260615` and no visible rate-limit headers.
- Recommended default for this plan:
  - Use `/v1/models` only as a key-validity smoke check, not as a quota check.
- Pitfalls:
  - A successful `/v1/models` proves the key is valid, not that generation quota remains.
- Sources:
  - Sakana console `Models` — `https://console.sakana.ai/models` — official model/API page; scraped locally on 2026-06-22.
  - Local API probe artifact was temporary and should not be committed.

#### Billing and subscription metadata
- Best practices:
  - Sakana pricing docs distinguish pay-as-you-go from subscription plans.
  - Subscription tiers include Standard, Pro, and Max; every tier includes both Fugu and Fugu Ultra.
  - The docs say Pro is 10x Standard usage and Max is 20x Standard usage, but they do not expose exact remaining quota windows on the pricing page.
- Recommended default for this plan:
  - Treat tier as operator-entered metadata (`standard`, `pro`, `max`, `payg`) that only influences ranking weight, not truth about current remaining quota.
- Pitfalls:
  - Do not infer exact limits from tier names unless Sakana exposes exact reset/remaining fields.
- Sources:
  - Sakana console `Pricing` — `https://console.sakana.ai/pricing` — official billing/tier page; scraped locally on 2026-06-22.

#### Rate-limit observability
- Best practices:
  - Prefer provider-reported `remaining`, `resetAt`, and `retry-after` when available.
  - If no status endpoint exists, use failure-driven health: mark a key cooling down on 429/quota-style failures, keep the last error body/status, and rotate to another key.
- Recommended default for this plan:
  - Implement a probe interface that can return three states: `ok_known`, `ok_unknown`, and `limited`. Start with `ok_unknown` for valid keys and move keys to `limited` only after observed quota errors or manual marking.
- Pitfalls:
  - Ranking unknown keys as 100% fresh can keep hammering the same key. Ranking them equally with round-robin and cooldown is safer.
- Sources:
  - No official public rate-status endpoint was found in the pages above.
  - Local `/v1/models` probe returned no visible rate-limit headers on success.
<!-- project_flow:block:external_research:end -->

## Current Architecture

<!-- project_flow:block:current_architecture:start -->
## Current Architecture

### On-disk structure
```text
~/.codex/
  config.toml                  # global Codex config; includes [model_providers.sakana]
  fugu.config.toml             # profile selecting model=fugu provider=sakana
  fugu-ultra.config.toml       # profile selecting model=fugu-ultra provider=sakana
  fugu.json                    # local model catalog
  .env                         # contains the single active SAKANA_API_KEY today
  auth.json                    # OpenAI Codex OAuth target managed by aim codex use/watch

~/.aimgr/
  config.yaml                  # Redis attachment
  local-state.json             # local target receipts/history

src/
  coordination/                # Redis records/runtime/snapshot
  pool/                        # usage, ranking, history, watch loops
  targets/                     # Codex OAuth, Claude, Pi, Hermes target projection
  cli/commands/                # user-facing command handlers
```

### Runtime/control paths
- Flow A: OpenAI Codex OAuth selection
  - Redis credential records -> `buildCoordinationView()` -> `activateCodexPoolSelection()` -> `applyCodexCliFromState()` -> write `~/.codex/auth.json`.
- Flow B: OpenAI Codex proactive watch
  - `aim codex watch --once` -> probe `wham/usage` for every Codex OAuth label -> rotate if the active 5h remaining percentage is below the threshold.
- Flow C: OpenAI Codex long-run Tend recovery
  - `aim codex run --tend` -> Codex session goal becomes `usageLimited` -> preserve live OAuth token -> select another Codex OAuth account -> resume the same Codex session.
- Flow D: Sakana today
  - User runs Codex profile `fugu` or `fugu-ultra` -> Codex reads provider `sakana` -> provider reads `SAKANA_API_KEY` from environment / `~/.codex/.env` -> no AIMGR state mutation or rotation.

### Key abstractions and boundaries
- Types or modules:
  - Redis credential record: provider-neutral storage shape.
  - `ensureStateShape`: provider-specific local state scaffolding.
  - usage snapshot: provider-specific live capacity view.
  - target projection: local file write plus readback receipt.
- Ownership boundaries:
  - Redis owns shared credential truth.
  - `~/.aimgr/local-state.json` owns local receipts/history.
  - `~/.codex/.env` should become a derived Sakana target file.
- Public APIs:
  - Existing: `aim codex use/watch/run --tend` for OpenAI Codex OAuth.
  - Proposed: `aim sakana ...` for Sakana API-key pool.

### Failure behavior today
- Logs:
  - OpenAI Codex and Anthropic usage failures are represented as `ok: false` snapshots in `src/pool/usage.js`.
  - Selection failures are recorded in target receipts and pool history.
- Assertions:
  - Codex OAuth target refuses unsupported store modes and non-Codex labels before writing `auth.json`.
  - OpenClaw apply refuses unsupported provider assignments.
- Common failure modes:
  - Sakana key rate-limited: Codex run fails; AIMGR does not observe or rotate.
  - Sakana key invalid/revoked: Codex run fails; AIMGR does not mark health.
  - Multiple Sakana keys exist outside AIMGR: no shared history, no safe redaction, no ranked selection.
<!-- project_flow:block:current_architecture:end -->

## Target Architecture

<!-- project_flow:block:target_architecture:start -->
## Target Architecture

### Future structure
```text
src/providers/
  sakana.js                    # credential shape, fingerprint, status classification

src/pool/
  sakana-usage.js              # validity probe + optional rate-limit parser
  provider-ranking.js          # small provider-neutral candidate helpers, or Sakana-specific ranking if simpler

src/targets/
  sakana-codex-env.js          # write/read/verify ~/.codex/.env SAKANA_API_KEY projection
  codex-tender-provider.js     # adapter layer for OpenAI OAuth vs Sakana env-key rotation, if needed

src/cli/commands/
  sakana.js                    # import/use/watch/status/mark commands

state / Redis
  credentials.sakana.<label>   # local view from Redis records
  pool.sakana.history          # local provider-specific receipts
  targets.sakanaCodex          # local active key projection metadata
```

### Future control paths
- Flow A: Import key
  - `aim sakana import <label> --key-stdin --tier pro --subscription <name>` -> validate with `/v1/models` -> store Redis credential record provider `sakana` with key fingerprint identity.
- Flow B: Select key
  - `aim sakana use [label]` -> choose explicit label or next eligible label -> write only `SAKANA_API_KEY=<key>` to `~/.codex/.env` -> read back fingerprint -> write `targets.sakanaCodex.lastSelectionReceipt`.
- Flow C: Watch key
  - `aim sakana watch --once` -> run cheap validity probe -> if active key is marked limited/cooling down or probe says limited, choose another key -> otherwise no-op.
- Flow D: Fugu/Fugu Ultra tended run
  - `aim codex run --tend -p fugu-ultra --provider sakana` or `aim sakana run --tend -p fugu-ultra` -> preflight selected key -> run Codex -> on `usageLimited` or Sakana 429 classifier -> mark active key limited -> project next key -> resume session.
- Flow E: Manual operator override
  - `aim sakana mark-limited <label> --reset-at <iso>` or `aim sakana mark-ready <label>` -> mutate health/cooldown in Redis/local history without exposing key.

### Contracts and invariants
- New or changed contracts:
  - `credential.provider = "sakana"` means `credential.apiKey` is required and `credential.access/refresh/expiresAt` are not required.
  - `identity.keyFingerprint` is the stable identity, e.g. `sha256:<first16>`.
  - `health.status` values: `ready`, `unknown_usage`, `cooling_down`, `rate_limited`, `invalid`, `revoked`, `disabled`.
  - `usage.windows` is optional for Sakana. Unknown usage must be represented explicitly, not coerced into fake 0% usage.
- Single source of truth:
  - Redis credential record is the shared key source.
  - `~/.codex/.env` is always a derived local projection.
- Fail-loud boundaries:
  - Refuse to import an empty key.
  - Refuse to print a raw key.
  - Refuse to overwrite unrelated `~/.codex/.env` keys unless the writer preserves all unrelated lines.
  - Refuse to select a cooling-down key unless `--force` is passed.
- Performance or determinism boundaries:
  - Do not call generation endpoints just to estimate usage.
  - Use `/v1/models` as an optional low-cost validity check only.
  - Keep selection deterministic: cooldown/invalid filtered first, then tier weight, then least recent selection, then label.
<!-- project_flow:block:target_architecture:end -->

## Call-Site Audit

<!-- project_flow:block:call_site_audit:start -->
## Call-Site Audit

| Area | File | Symbol / Call site | Current behavior | Required change | Why | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | -------------- |
| Provider constants | `src/core/constants.js` | provider constants, `SUPPORTED_OAUTH_PROVIDERS` | Only OpenAI Codex and Anthropic are named; OAuth list doubles as supported provider list in some paths. | Add `SAKANA_PROVIDER`; add separate API-key/provider registries without adding Sakana to OAuth login choices. | Sakana has no OAuth path. | `test/credentials/oauth.test.js`, provider normalization tests |
| State shape | `src/state/schema.js` | `ensureStateShape` | Initializes OpenAI/Anthropic credentials and pools only. | Preserve/init `credentials.sakana`, `pool.sakana.history`, `targets.sakanaCodex`. | Local view must carry Sakana Redis records and target receipts. | state/schema tests, status tests |
| Empty state | `src/state/empty.js` | `createEmptyState` | No Sakana buckets. | Add Sakana buckets or make provider buckets lazy but stable. | Avoid data loss during normalization. | state fixtures |
| Redis identity | `src/coordination/login-publish.js` | `buildStableIdentityForCredential` | Unknown providers return `{}`. | Return key fingerprint for provider `sakana`. | CAS identity checks need to prevent accidental label/key swaps. | Redis publish tests |
| Credential validation | new `src/providers/sakana.js` | n/a | No shape/fingerprint helpers. | Add `assertSakanaCredentialShape`, `buildSakanaCredentialFingerprint`, `redactSakanaKey`, `classifySakanaApiError`. | Keeps secret handling centralized. | new provider tests |
| Import CLI | new `src/cli/commands/sakana.js` | n/a | No way to add key labels. | Add `import`, `use`, `watch`, `mark-limited`, `mark-ready`, `status`. | Operator UX for key inventory and rotation. | CLI command tests |
| Help | `src/cli/help.js`, `src/cli/main.js` | command map/help text | No Sakana command. | Register `sakana` command and concise help. | Discoverability. | help contract tests |
| Status | `src/status/*`, `src/panels/*` if needed | rendered status | Shows OpenAI/Anthropic and targets. | Add redacted Sakana pool and active key summary. | Operators need confidence without secrets. | status snapshots |
| Usage probing | `src/pool/usage.js` or new `sakana-usage.js` | `probeUsageSnapshotsByProvider` | Only OpenAI/Anthropic. | Include Sakana validity/rate-limit probe with unknown-usage state. | Selection needs health even without windows. | pool usage tests |
| Ranking | `src/pool/ranking.js` / `weighted-planner.js` | label collection and candidate ranking | Requires provider-specific status and mostly percentage windows. | Add Sakana-specific ranking: filter health/cooldown, prefer known-good, weight by tier, rotate least-recent. | Unknown usage cannot use fake percent windows. | pool planner tests |
| Target projection | new `src/targets/sakana-codex-env.js` | n/a | Only `auth.json` projection exists for Codex OAuth. | Preserve unrelated `.env` lines and write selected `SAKANA_API_KEY`. | Fugu profile consumes env key. | new target tests |
| Local state | `src/state/local-state.js` | local target shape | Stores existing target receipts. | Preserve `targets.sakanaCodex` and `pool.sakana`. | Redis runtime writes local receipts after selection. | local-state tests |
| Tend | `src/targets/codex-tender.js` | `rotateCodexAccount`, `runPreflight` | Hardcoded OpenAI Codex rotation. | Add a provider adapter selected by profile/provider; Sakana adapter marks active key limited and rotates `.env`. | Long Fugu runs need same recovery loop. | codex tender tests |
| OpenClaw | `src/openclaw/apply.js`, `src/openclaw/sync.js`, `src/openclaw/models.js`, `src/openclaw/sessions.js` | supported providers and enforced model refs | OpenClaw auth materialization is OAuth-only. | Do not include Sakana in OpenClaw assignment path until OpenClaw supports API-key profiles for provider `sakana`; fail clearly if assigned. | Avoid leaking keys into unsupported store shape. | openclaw tests |
| Sanitization | `src/core/sanitize.js` | redaction | Redacts common token fields. | Add `apiKey`, `SAKANA_API_KEY`, `fish_*`, and Sakana credential fields. | Raw key must never appear in CLI JSON. | sanitize tests |
| Migration/import | `src/migration/*` or new admin command | migration planner | OAuth-focused migration. | Prefer explicit `aim sakana import`; optional local collect can detect `~/.codex/.env` and propose one label. | Existing single key can be onboarded safely. | migration tests, if added |

### Delete / cleanup list
- Do not delete current `~/.codex/fugu.config.toml`, `~/.codex/fugu-ultra.config.toml`, or `~/.codex/fugu.json`.
- Do not remove existing OpenAI Codex OAuth target code.
- After Sakana projection exists, stop treating the manually edited `~/.codex/.env` key as canonical.
<!-- project_flow:block:call_site_audit:end -->

## Phase Plan

<!-- project_flow:block:phase_plan:start -->
## Depth-First Phase Plan

### Phase 1 — Provider and Secret Shape Foundation
- Goal:
  - Make AIMGR able to represent Sakana API-key credentials without using OAuth code paths.
- Work:
  - Add `SAKANA_PROVIDER = "sakana"` in `src/core/constants.js`.
  - Split provider concepts:
    - OAuth providers: OpenAI Codex, Anthropic.
    - Credential providers: OpenAI Codex, Anthropic, Sakana.
    - Target providers: Codex OAuth auth, Sakana env key, Claude, Pi, Hermes.
  - Add `src/providers/sakana.js` with:
    - key shape validation: `{ apiKey, createdAt?, tier?, subscription?, notes? }`.
    - fingerprinting: SHA-256 of the raw key, stored as identity only.
    - redaction helpers for `fish_*` and any `apiKey` value.
    - error classifier for HTTP 401/403/402/429 and text containing quota/rate-limit terms.
  - Update `ensureStateShape`, `createEmptyState`, and local-state shape to preserve `credentials.sakana`, `pool.sakana.history`, and `targets.sakanaCodex`.
  - Update Redis identity publishing for provider `sakana`.
- Verification:
  - `npm run lint`.
  - Unit tests for Sakana validation, fingerprint compatibility, state normalization, and Redis publish identity.
- Exit criteria:
  - A synthetic Redis snapshot with `provider: "sakana"` survives load -> normalize -> view -> publish without data loss.
  - No OAuth prompt lists Sakana as a login provider.
- Rollback:
  - Revert provider/state changes; no target file writes in this phase.

### Phase 2 — Sakana Import, Status, and `.env` Projection
- Goal:
  - Let an operator store many keys and select one active key for local Codex Fugu profiles.
- Work:
  - Add `src/targets/sakana-codex-env.js`:
    - resolve managed Codex home.
    - read `~/.codex/.env` preserving unrelated lines.
    - write/update exactly `SAKANA_API_KEY=<selected>` with mode `0600`.
    - read back active key fingerprint without printing it.
  - Add `aim sakana import <label> --key-stdin [--tier standard|pro|max|payg] [--subscription <name>]`.
    - Use stdin or env source; never accept a key as a positional arg if that would echo into shell history.
    - Optionally call `/v1/models` to validate and capture supported model IDs.
  - Add `aim sakana use [label]`.
    - Explicit label writes the selected key.
    - No label chooses next eligible Sakana label.
  - Add `aim sakana status [--json]` and status rendering.
  - Add secret redaction to sanitize output.
- Verification:
  - Tests write a temp `.codex/.env` containing unrelated variables and prove only `SAKANA_API_KEY` changes.
  - CLI tests prove import/use/status do not include raw `fish_...` strings.
  - Real optional smoke: selected key can call `GET /v1/models` and returns expected model IDs.
- Exit criteria:
  - `aim sakana use key1` can switch active Fugu key without touching `~/.codex/auth.json`.
  - `aim status --json` shows active Sakana label/fingerprint and no secret values.
- Rollback:
  - Remove `targets.sakanaCodex`; restore previous `.env` from backup if needed.

### Phase 3 — Unknown-Usage Ranking and Failure-Driven Cooldown
- Goal:
  - Rotate keys safely even if Sakana does not expose current remaining quota.
- Work:
  - Add `src/pool/sakana-usage.js` with a provider probe returning:
    - `ok_known`: only if future Sakana docs/API expose real windows.
    - `ok_unknown`: key validates but quota windows are unavailable.
    - `limited`: provider returned 429/402/quota signal or Redis health says cooldown is active.
    - `invalid`: 401/403/revoked key.
  - Add Sakana ranking:
    - Filter disabled/invalid/cooling-down keys.
    - Prefer keys with known remaining capacity if available.
    - Otherwise use tier weight (`max > pro > standard`, payg configurable), least-recent active, least-recent limited, then label.
  - Add `aim sakana watch --once`:
    - no-op if active key is healthy/unknown and not cooling down.
    - rotate if active key is limited/cooling down/invalid.
  - Add manual controls:
    - `aim sakana mark-limited <label> [--reset-at <iso>] [--cooldown-minutes <n>]`.
    - `aim sakana mark-ready <label>`.
    - `aim sakana disable/enable <label>` if the existing pool policy path is not enough.
  - Record history entries in `pool.sakana.history` with reason, status, active label, alternate label, and cooldown reset time.
- Verification:
  - Unit tests for every classifier status.
  - Planner tests for unknown-usage rotation and cooldown filtering.
  - CLI tests for `watch --once` rotating after a synthetic `mark-limited`.
- Exit criteria:
  - A rate-limited active key is never selected again before reset unless forced.
  - With three unknown-usage ready keys, repeated `use`/`watch` distributes selection by least-recent use, not always lexicographic first.
- Rollback:
  - Manual `aim sakana use <known-good-label>` remains available; cooldown history can be ignored.

### Phase 4 — Tend Integration for Fugu and Fugu Ultra
- Goal:
  - Long Fugu/Fugu Ultra Codex runs recover from key exhaustion using the same stop/rotate/resume loop as OpenAI Codex.
- Work:
  - Add a provider adapter boundary in `src/targets/codex-tender.js`:
    - OpenAI Codex adapter keeps current `preserveLiveCodexAuthForActiveLabel` + `activateCodexPoolSelection` behavior.
    - Sakana adapter uses `readSakanaCodexTargetStatus` + `activateSakanaPoolSelection`.
  - Detect Sakana mode from explicit option first:
    - Preferred UX: `aim sakana run --tend -p fugu-ultra -- <codex args>`.
    - Acceptable minimal UX: `aim codex run --tend -p fugu-ultra --provider sakana` if argument parsing already supports it cleanly.
  - On recovery trigger:
    - If rollout goal status is `usageLimited`, mark current Sakana key limited with unknown reset.
    - If Codex does not set `usageLimited` for Sakana 429s, add a narrow parser for rollout/session stderr or event payloads that classifies provider 429/quota messages.
    - Rotate to another Sakana key and resume the same Codex thread.
  - Keep max restarts and thread lock semantics unchanged.
- Verification:
  - Tests inject a fake Tend session where active provider is Sakana and goal status becomes `usageLimited`; assert `.env` rotates and the session resumes.
  - Tests inject a fake Sakana 429 payload if available.
  - Existing Codex Tend tests still pass unchanged.
- Exit criteria:
  - Fugu/Fugu Ultra tended runs can rotate at least once without touching `~/.codex/auth.json`.
  - OpenAI Codex tended runs keep their current behavior.
- Rollback:
  - Disable Sakana Tend adapter; `aim sakana use/watch` still works manually.

### Phase 5 — Documentation, Migration Helper, and Operator Runbook
- Goal:
  - Make the workflow safe for real multi-key operations.
- Work:
  - Update `README.md` with Sakana commands and examples.
  - Add a one-time helper:
    - `aim sakana import-current --label <label>` reads current `~/.codex/.env`, validates, stores it, and immediately projects it back as a managed target.
  - Add runbook examples:
    - import multiple keys.
    - choose Fugu/Fugu Ultra profile.
    - mark a key limited manually.
    - inspect redacted status.
    - recover if all keys are limited.
  - Add docs note: If Sakana later exposes true usage windows, wire them into `sakana-usage.js` without changing the user command surface.
- Verification:
  - README command snippets are covered by CLI help/snapshot tests where practical.
  - `npm test` and `npm run lint`.
- Exit criteria:
  - A new operator can import two keys and rotate Fugu/Fugu Ultra using only documented `aim sakana` commands.
- Rollback:
  - Docs-only rollback; code remains independently tested.
<!-- project_flow:block:phase_plan:end -->

## Implementation Notes

### Proposed Redis credential record shape

```json
{
  "kind": "aimgr.credential.v1",
  "provider": "sakana",
  "label": "sakana_pro_1",
  "credential": {
    "apiKey": "<secret>",
    "tier": "pro",
    "subscription": "personal-pro-1",
    "createdAt": "2026-06-22T00:00:00.000Z"
  },
  "identity": {
    "keyFingerprint": "sha256:<first16>",
    "subscription": "personal-pro-1"
  },
  "policy": {
    "pool": { "enabled": true },
    "expect": {},
    "reauth": { "mode": "api-key-manual" },
    "browser": {}
  },
  "health": {
    "status": "ready",
    "reason": null,
    "limitedAt": null,
    "resetAt": null,
    "lastStatus": null
  },
  "provenance": {
    "lastSourceType": "sakana-import"
  }
}
```

### Proposed local target receipt shape

```json
{
  "targets": {
    "sakanaCodex": {
      "homeDir": "/Users/aelaguiz/.codex",
      "envPath": "/Users/aelaguiz/.codex/.env",
      "activeLabel": "sakana_pro_1",
      "expectedKeyFingerprint": "sha256:<first16>",
      "lastAppliedAt": "2026-06-22T00:00:00.000Z",
      "lastSelectionReceipt": {
        "action": "sakana_use",
        "status": "activated",
        "label": "sakana_pro_1",
        "reasons": ["explicit_label"],
        "wroteEnv": true,
        "warnings": [],
        "blockers": []
      }
    }
  }
}
```

### Default cooldown policy when Sakana gives no reset time

- 429 with `Retry-After`: use that exact reset time.
- 429 without reset: default cooldown `6h` for subscription keys; allow override via `--cooldown-minutes`.
- 402/payment/credit exhausted: mark `rate_limited` or `billing_blocked` until manual `mark-ready`.
- 401/403: mark `invalid` and disable pool eligibility until re-import.
- Network/5xx: do not mark limited; record transient warning only.

### First implementation path I would choose

Start small and avoid abstracting everything at once:

1. Add Sakana provider helpers and `.env` projection.
2. Add `aim sakana import/use/status`.
3. Add cooldown state and `watch --once`.
4. Only then refactor Tend through a provider adapter.

That sequence gives useful manual key rotation before the harder long-running-session automation lands.
