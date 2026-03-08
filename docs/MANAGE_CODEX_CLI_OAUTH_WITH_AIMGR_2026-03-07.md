---
title: "AI Manager — Codex CLI OAuth Pooling + Remote Sync — Architecture Plan"
date: 2026-03-07
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [aelaguiz]
doc_type: architectural_change
related:
  - docs/AI_MANAGER_APP_REFERENCE.md
  - docs/AI_ACCOUNT_MANAGER_FOR_MULTI_PROVIDER_OAUTH_2026-03-03.md
  - docs/MAKE_AI_MANAGER_OWN_OAUTH_TOKEN_REFRESH_2026-03-05.md
---

# TL;DR

- **Outcome:** AIM can manage labeled `openai-codex` OAuth accounts as a reusable pool for Codex CLI, so a developer can switch local Codex CLI between GPT Pro accounts by label without re-running browser auth when fresh credentials already exist in AIM.
- **Problem:** Today AIM only compiles labeled OAuth state into OpenClaw, while Codex CLI keeps separate auth state, so the same GPT Pro pool cannot be reused or switched cleanly on a non-OpenClaw machine.
- **Approach:** Add Codex CLI as a first-class downstream adapter under AIM, with deterministic label-to-Codex auth projection, a machine-safe sync/import path from the Mac Studio AIM SSOT, and a one-command active-label switch for local Codex CLI.
- **Plan:** Confirm the correct Codex CLI auth/storage contract, define the AIM-to-Codex adapter and remote sync model, design the operator UX for login/sync/use/status, then verify on a non-host machine with real Codex CLI behavior.
- **Non-negotiables:**
  - AIM remains the only durable credential SSOT.
  - Downstream Codex CLI auth is derived and disposable.
  - Labels remain the operator interface; no hidden “default account” semantics.
  - OpenClaw behavior must not regress.
  - No secrets in git.
  - Missing/expired credentials fail loud instead of silently falling back.

---

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-03-07
external_research_grounding: not started
deep_dive_pass_2: not started
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
-->
<!-- arch_skill:block:planning_passes:end -->

---

# 0) Holistic North Star

## 0.1 The claim (falsifiable)
> If AIM can manage Codex CLI as another downstream target for labeled `openai-codex` accounts, and a non-OpenClaw machine can sync/import those AIM-managed credentials from the Mac Studio and activate any label for local Codex CLI, then Amir can switch local Codex CLI between pooled GPT Pro identities by label without redoing browser auth, measured by a successful Codex CLI auth-dependent run under label A, a deterministic switch to label B, and loud failure when AIM credentials are expired or missing.

## 0.2 In scope
- UX surfaces (what users will see change):
  - AIM CLI flows to sync/import Codex-eligible accounts from the Mac Studio AIM state onto another machine.
  - AIM CLI flows to select which labeled account the local Codex CLI should actively use.
  - AIM status output that shows Codex CLI-relevant labels, active local label, and drift/expiry warnings.
- Technical scope (what code will change):
  - AIM SSOT/schema and adapter logic needed to project labeled `openai-codex` credentials into Codex CLI auth state.
  - AIM machine-targeting/sync logic for a non-OpenClaw Codex-only environment.
  - Codex CLI downstream state management contract, including which storage mode/path AIM will own or require for deterministic switching.

## 0.3 Out of scope
- UX surfaces (what users must NOT see change):
  - OpenClaw Slack, agent, or runtime UX unrelated to Codex CLI account reuse.
  - New generic secret-management UI beyond AIM CLI.
- Technical scope (explicit exclusions):
  - Changes to OpenClaw core/provider behavior unless later research proves a hard dependency.
  - Anthropic/Claude CLI account pooling in this first plan.
  - A bidirectional multi-host secret mesh or always-on distributed replication service.
  - Generic API-key rotation; this plan is about subscription OAuth-backed `openai-codex` reuse for Codex CLI.

## 0.4 Definition of done (acceptance evidence)
- A non-OpenClaw machine can run AIM in a Codex-only mode and import/sync the AIM-managed `openai-codex` pool from the Mac Studio without inventing a second credential truth.
- An operator can run a label-driven command to make local Codex CLI use a selected AIM-managed GPT Pro identity.
- Switching from one label to another rewrites only derived Codex CLI auth state and does not require browser login when AIM already holds fresh credentials for both labels.
- When the selected label is expired, missing, or incompatible, AIM fails loudly and points the operator back to AIM-managed remediation instead of silently using stale Codex state or an API key.
- OpenClaw AIM flows keep working as they do today for existing pinned agents.
- Evidence plan (common-sense; non-blocking):
  - Primary signal (keep it minimal; prefer existing tests/checks): targeted AIM adapter tests plus a real local Codex CLI smoke check on a non-host machine — confirm the selected label’s derived auth is written where Codex expects it and an auth-dependent Codex CLI command succeeds.
  - Optional second signal (only if needed): a label switch smoke test from label A to label B on the same machine — confirm no browser re-login occurs and the active downstream state changes deterministically.
  - Default: do NOT add bespoke screenshot harnesses / drift scripts unless they already exist in-repo or are explicitly requested.
  - Avoid negative-value tests/gates: do NOT add “deleted code not referenced” tests, visual-constant tests (colors/margins/pixels), doc-driven inventory gates, or mock-only interaction tests.
- Metrics / thresholds (if relevant):
  - Local account switch time: under 30 seconds once credentials already exist in AIM — measured via CLI flow timing on the target machine.
  - Interactive re-auth requirement for already-managed fresh labels: zero — measured via switch smoke test.

## 0.5 Key invariants (fix immediately if violated)
- AIM is the only durable credential SSOT; Codex CLI auth state is derived output.
- The operator interface stays label-first; account meaning must never depend on unlabeled defaults.
- Codex CLI switching must not require OpenClaw to be installed or running on the target machine.
- Cross-machine sync/import must fail loud on schema drift, provider mismatch, or expired credentials.
- No fallback to stale Codex auth or API-key auth when AIM-managed Codex auth is supposed to be active.
- Fallback policy (strict):
  - Default: **NO fallbacks or runtime shims** (feature must work correctly or fail loudly).
  - If an exception is truly required, it must be explicitly approved by aelaguiz by setting `fallback_policy: approved` and recording a Decision Log entry with a timebox + removal plan.

---

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)
1) Keep AIM as the only credential truth across OpenClaw and Codex CLI.
2) Make local Codex CLI account switching label-first, fast, and deterministic.
3) Support a Codex-only machine without dragging OpenClaw runtime assumptions into it.

## 1.2 Constraints
- Correctness: The selected Codex label must compile into the exact expected ChatGPT account/workspace, and AIM must never silently reuse stale Codex auth, keyring state, or API-key auth when label-driven OAuth is expected.
- Performance: `aim codex use <label>` should be local file I/O plus validation when AIM already has fresh credentials; remote import is explicit and should not be on the hot path for a label switch.
- Offline / latency: A laptop with already-imported fresh AIM credentials must be able to switch Codex labels offline; network is only required for the initial import or when credentials are actually stale.
- Compatibility / migration (default: hard cutover; no shims): Existing `aim login`, `aim pin`, `aim autopin openclaw`, `aim apply`, and `aim sync openclaw` behavior stays intact; new state keys must be additive, and v1 Codex support is intentionally file-backed only.
- Operational / observability: `aim status` must expose source provenance, active local Codex label, target home/store mode, and drift/expiry/account mismatch warnings so wrong-account failures are diagnosable without inspecting raw files.

## 1.3 Architectural principles (rules we will enforce)
- AIM owns durable credential truth; downstreams are compiled targets.
- Machine-local Codex CLI state must be deterministic from AIM input.
- Pattern propagation via comments (high leverage; no spam):
  - When we introduce a new SSOT/contract or a non-obvious “gotcha”, add a short doc comment in the canonical boundary module explaining the invariant + how to extend it safely.
  - Do NOT comment everything; comment the tricky bits we want to propagate forward.

## 1.4 Known tradeoffs (explicit)
- Durable file-backed Codex projection vs Codex external-token bridge → choose durable file-backed projection for v1 because the operator goal is standalone local `codex` on another machine, not an embedded parent-managed session that disappears when AIM is gone.
- File-only Codex target vs supporting `file`, `auto`, and keyring-backed homes in v1 → choose file-only because `auto` and keyring hide part of the effective state outside AIM and make cross-machine switching/debugging materially less deterministic.
- Explicit pull/import from the Mac Studio vs a bidirectional sync mesh → choose explicit pull/import because it solves the real laptop workflow without inventing conflict resolution, background daemons, or multi-writer secret replication.
- Alternatives rejected + why:
  - Reusing Codex `chatgptAuthTokens` as the primary lane for v1 is rejected because it keeps refresh authority outside Codex and is elegant for embedded apps, but it does not naturally satisfy “my local `codex` command should keep working on another box after I switch labels.”
  - Writing AIM-managed Codex auth into keychain/`auto` first is rejected for v1 because it would recreate ambient state AIM cannot reliably inspect or reproduce from SSOT.

---

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today
- AIM already manages labeled `openai-codex` OAuth accounts for OpenClaw.
- AIM stores accounts, pins, and credentials in `~/.aimgr/secrets.json`.
- AIM compiles labeled auth and model/session state into OpenClaw as derived output.
- Codex CLI has its own auth storage and login flow outside AIM.
- The same GPT Pro pool is not yet reusable as a label-switched Codex CLI pool on another machine.
- Primary flows / control paths:
  - AIM label login/refresh -> AIM SSOT write -> OpenClaw derived sync.
  - Codex CLI local auth flow -> Codex-local auth storage -> local CLI usage.

## 2.2 What’s broken / missing (concrete)
- Symptoms:
  - Amir cannot point local Codex CLI at any already-managed GPT Pro label on demand.
  - Hitting limits on one account does not have a clean AIM-driven label switch path for Codex CLI.
  - A second machine cannot currently treat the Mac Studio AIM pool as reusable Codex CLI login inventory.
- Root causes (hypotheses):
  - AIM has no Codex CLI downstream adapter yet.
  - Codex CLI auth storage is separate from AIM SSOT.
  - The cross-machine sync/import model is not yet defined.
- Why now:
  - The business value is immediate: more usable GPT Pro capacity for local Codex work without reauth churn or wrong-account confusion.

## 2.3 Constraints implied by the problem
- Any solution that creates a second durable credential truth undermines AIM.
- Any solution that depends on OpenClaw being present on the target laptop misses the real goal.
- Any solution that silently falls back to stale or API-key auth defeats the operator promise.

---

<!-- arch_skill:block:research_grounding:start -->
# Research Grounding (external + internal “ground truth”)

## External anchors (papers, systems, prior art)
- OAuth 2.0 RFC 6749 section 6 — adopt standard refresh-token rotation semantics, including that a refresh response may omit a replacement refresh token and that invalid/reused refresh tokens must fail loud instead of being papered over — because OpenAI/Codex refresh handling already lives on top of these rules and AIM should not invent its own token lifecycle.
- OAuth 2.0 for Native Apps / PKCE (`localhost` callback) — adopt browser + local callback for any interactive recovery/login path and reject custom embedded auth UX — because Codex already uses this flow shape and AIM should align to the downstream contract rather than compete with it.

## Internal ground truth (code as spec)
- Authoritative behavior anchors (do not reinvent):
  - `work/aimgr/repo/aimgr/src/cli.js` — AIM’s SSOT-first compiler model already exists and is the canonical basis for adding another downstream target — evidence: `resolveAimgrStatePath()`, `loadAimgrState()`, `writeJsonFileWithBackup()`, `applyOpenclawFromState()`, `syncOpenclawFromState()`, `--home`, `--state`.
  - `work/aimgr/repo/aimgr/test/cli.test.js` — current AIM behavior is already locked by tests around labeled projection, redaction, and stale-state cleanup — evidence: `status --json never leaks access/refresh tokens`, `apply writes OpenClaw auth-profiles.json with labeled profile ids`, `resetSessionEntryToDefaults clears runtime/override/authProfile fields`.
  - `/Users/agents/workspace/codex/codex-rs/core/src/auth/storage.rs` — Codex CLI’s durable auth storage contract lives here, including the exact `$CODEX_HOME/auth.json` schema and backend modes — evidence: `AuthCredentialsStoreMode`, `AuthDotJson`, `get_auth_file()`, `create_auth_storage()`, `AutoAuthStorage`.
  - `/Users/agents/workspace/codex/codex-rs/core/src/config/mod.rs` — Codex’s default storage choice is code-defined, not guesswork — evidence: `config_defaults_to_file_cli_auth_store_mode` asserts the default is `AuthCredentialsStoreMode::File`.
  - `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs` — Codex has two distinct ChatGPT auth lanes: managed durable auth and externally managed ChatGPT tokens — evidence: `login_with_chatgpt_auth_tokens()`, `AuthDotJson::from_external_access_token()`, `storage_mode()` forcing `ChatgptAuthTokens` to `Ephemeral`, `CodexAuth::Chatgpt` vs `CodexAuth::ChatgptAuthTokens`.
  - `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs` — unauthorized recovery is materially different for managed vs external auth, which is the core architecture fork for AIM/Codex integration — evidence: `UnauthorizedRecovery`, `UnauthorizedRecoveryMode::{Managed, External}`, `reload_if_account_id_matches()`, `refresh_token_from_authority()`, and the comment block describing managed vs external recovery.
  - `/Users/agents/workspace/codex/codex-rs/login/src/server.rs` — Codex’s native interactive ChatGPT login persists durable auth and extracts account/plan metadata from JWT claims — evidence: `persist_tokens_async()`, `jwt_auth_claims()`, `chatgpt_account_id`, `plan_type`, `ServerOptions.cli_auth_credentials_store_mode`.
  - `/Users/agents/workspace/codex/codex-rs/app-server-protocol/src/protocol/common.rs` — external ChatGPT tokens are a first-class public auth mode in Codex, not a hack — evidence: `AuthMode::ChatgptAuthTokens` and its comment saying tokens are supplied by an external host app and only stored in memory.
  - `/Users/agents/workspace/codex/codex-rs/app-server/src/codex_message_processor.rs` — Codex app-server already accepts externally managed ChatGPT tokens and protects that mode from being mixed with local managed auth — evidence: `LoginAccountParams::ChatgptAuthTokens`, `login_chatgpt_auth_tokens()`, `external_auth_active_error()`.
  - `/Users/agents/workspace/codex/codex-rs/app-server/src/message_processor.rs` — Codex already has a parent-app refresh bridge for externally managed ChatGPT tokens — evidence: `ExternalAuthRefreshBridge`, `ChatgptAuthTokensRefreshParams`, `ChatgptAuthTokensRefreshResponse`, `EXTERNAL_AUTH_REFRESH_TIMEOUT`.
  - `/Users/agents/workspace/work/openclaw/src/agents/cli-credentials.ts` — the repo already knows how to discover real Codex CLI credentials from macOS keychain first and `auth.json` second — evidence: `resolveCodexHomePath()`, `computeCodexKeychainAccount()`, `readCodexKeychainCredentials()`, `readCodexCliCredentials()`.
  - `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/external-cli-sync.ts` plus `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/store.ts` — OpenClaw already models “external CLI -> canonical store” as a freshness-gated adapter with read-only runtime support — evidence: `syncExternalCliCredentialsForProvider()`, `syncExternalCliCredentials()`, and the `Runtime secret activation must remain read-only` comment in `loadAuthProfileStoreForAgent()`.
- Existing patterns to reuse:
  - `work/aimgr/repo/aimgr/src/cli.js` — SSOT-first compile-later — Codex support should follow the same one-way compiler discipline as OpenClaw: write AIM truth once, then project downstream state idempotently.
  - `work/aimgr/repo/aimgr/src/cli.js` — target indirection via `--home` / `--state` — this is the natural base for Codex-only or cross-machine targeting without coupling the new flow to host OpenClaw state.
  - `/Users/agents/workspace/work/openclaw/src/agents/cli-credentials.ts` plus `/Users/agents/workspace/work/openclaw/src/agents/cli-credentials.test.ts` — dual-backend discovery — AIM should respect Codex’s real storage behavior by handling keychain-first and file fallback instead of assuming a single backend.
  - `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/external-cli-sync.ts` — freshness-gated external CLI ingestion — the repo already has a pattern for importing external CLI auth into a canonical store only when newer/fresher.
  - `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles.readonly-sync.test.ts` — read-only runtime sync — a Codex-only laptop flow can surface imported AIM credentials in-memory or in dry-run mode before any explicit apply/persist step.
  - `/Users/agents/workspace/work/openclaw/src/agents/pi-auth-json.ts` — downstream bridge compiler — AIM can project SSOT credentials into Codex’s expected downstream shape the same way OpenClaw bridges `auth-profiles.json` into legacy `auth.json`.
  - `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs` — account-id-guarded reload and external-auth precedence — AIM-driven switching should validate expected account identity and avoid silently adopting the wrong local Codex auth.
  - `/Users/agents/workspace/codex/codex-rs/core/tests/suite/auth_refresh.rs` — managed refresh behavior — if AIM chooses durable Codex projection, the adapter must preserve Codex’s expectations around disk reload, refresh, and account mismatch.
  - `/Users/agents/workspace/codex/codex-rs/app-server/src/message_processor.rs` — external refresh bridge — if AIM chooses the external-token lane, the refresh contract already exists and AIM can become the parent authority instead of teaching Codex a new refresh model.

## Open questions (evidence-based)
- Which Codex lane should AIM own first: durable managed auth projection or Codex’s existing external-token bridge? — settle this by comparing the standalone local CLI requirement against the actual contracts in `AuthCredentialsStoreMode`, `login_with_chatgpt_auth_tokens()`, and the app-server refresh bridge, then verifying the chosen path on a non-host machine.
- If durable projection wins, should AIM standardize on `cli_auth_credentials_store = "file"` for managed labels, or support `file`, `auto`, and keyring-backed homes? — settle this by verifying real read precedence and switch determinism across those modes without hidden OS prompts or stale keychain state.
- What is the smallest cross-machine AIM export/import unit for a Codex-only machine? — settle this by deriving the minimal AIM subset that still preserves `label`, `provider`, `access`, `refresh`, `expiresAt`, and `accountId`, then importing it into a clean laptop AIM state with no OpenClaw artifacts present.
- Does the first cut need to hand Codex durable refresh tokens at all, or can AIM remain the sole refresh authority and only feed Codex fresh access tokens? — settle this by comparing restart/process-lifetime behavior of Codex external auth versus durable auth and validating the desired operator workflow when AIM is not actively running.
- Should “switch local Codex label” mean rewriting one active `$CODEX_HOME`, swapping between per-label `$CODEX_HOME`s, or launching Codex through an AIM wrapper that pins home/state at process start? — settle this by testing which option best matches Codex’s actual storage isolation and produces the least silent state bleed.
<!-- arch_skill:block:research_grounding:end -->

---

<!-- arch_skill:block:current_architecture:start -->
# 4) Current Architecture (as-is)

## 4.1 On-disk structure
```text
work/aimgr/repo/aimgr/
├── src/
│   └── cli.js
└── test/
    └── cli.test.js

config/openclaw/
└── openclaw.mac_host.json5

~/.aimgr/
└── secrets.json
   └── { schemaVersion, accounts, pins.openclaw, credentials }

~/.openclaw/
├── browser/
│   └── <profileId>/user-data
└── agents/
    ├── main/
    │   └── agent/
    │       └── auth-profiles.json
    └── <agentId>/
        ├── agent/
        │   └── auth-profiles.json
        └── sessions/
            └── sessions.json

$CODEX_HOME/
└── auth.json

macOS Keychain
└── service: "Codex Auth"
    └── account: "cli|<sha256(codex_home)[:16]>"

/Users/agents/workspace/codex/codex-rs/
├── core/src/
│   ├── auth.rs
│   ├── auth/storage.rs
│   ├── config/mod.rs
│   └── token_data.rs
├── cli/src/
│   └── login.rs
├── login/src/
│   └── server.rs
└── app-server/src/
    ├── message_processor.rs
    └── codex_message_processor.rs

/Users/agents/workspace/work/openclaw/src/agents/
├── cli-credentials.ts
├── pi-auth-json.ts
└── auth-profiles/
    ├── constants.ts
    ├── external-cli-sync.ts
    ├── store.ts
    └── types.ts
```

## 4.2 Control paths (runtime)

* AIM login / refresh -> OpenClaw compile:
  * `aim <label>` / `aim login <label>` -> `loadAimgrState()` + `ensureStateShape()` -> `ensureProviderConfiguredForLabel()` -> `ensureCodexAccountConfig()` -> `refreshOrLoginCodex()` or `refreshOrLoginAnthropic()` -> `writeJsonFileWithBackup(~/.aimgr/secrets.json)` -> `syncOpenclawFromState()`.
* AIM apply / sync OpenClaw:
  * `aim apply` / `aim sync openclaw` -> `applyOpenclawFromState()` writes `auth-profiles.json` for `main` and per-agent order/`lastGood` pins -> `buildOpenclawModelSyncOps()` / `applyOpenclawModelSyncOps()` enforces provider-specific model refs -> gateway `sessions.patch` plus disk `sessions.json` resets clear stale runtime identity fields.
* OpenClaw auth resolution at runtime:
  * `loadAuthProfileStore*()` loads `auth-profiles.json`, backfills legacy auth when needed, merges `main` + agent stores, applies provider order selection, and only then resolves a concrete auth identity for a provider; external CLI sync can inject fresh runtime creds, but Codex CLI is not a first-class managed source today.
* Codex managed ChatGPT auth:
  * `codex login` / app-server login -> `run_login_server()` or device-code flow -> token exchange -> `persist_tokens_async()` -> `save_auth(..., cli_auth_credentials_store_mode)` -> `AuthManager::reload()` -> later `AuthManager::unauthorized_recovery()` does guarded reload then refresh-token exchange.
* Codex external ChatGPT auth:
  * `LoginAccountParams::ChatgptAuthTokens` -> `login_with_chatgpt_auth_tokens()` -> ephemeral auth only -> `AuthManager::reload()` -> on 401 `ExternalAuthRefreshBridge` sends `account/chatgptAuthTokens/refresh` to the parent app and reloads returned tokens.
* OpenClaw external CLI ingestion:
  * `loadAuthProfileStore*()` coerces `auth-profiles.json` / legacy `auth.json` -> optionally inherits `main` store -> calls `syncExternalCliCredentials()` on every load; today Qwen and MiniMax can be persisted or injected read-only, while Codex is only readable via `readCodexCliCredentials*()` and is not a managed profile source.

## 4.3 Object model + key abstractions

* Key types:
  * AIM durable SSOT: `accounts[label]`, `pins.openclaw[agentId] = label`, and `credentials[provider][label] = { access, refresh, expiresAt, accountId? }`.
  * OpenClaw auth store: `AuthProfileStore { version, profiles, order, lastGood, usageStats? }`, with provider-scoped profile ids like `openai-codex:boss`.
  * Codex durable auth payload: `AuthDotJson { auth_mode, OPENAI_API_KEY, tokens, last_refresh }`.
  * Codex storage strategy: `AuthCredentialsStoreMode::{File, Keyring, Auto, Ephemeral}`.
  * Codex runtime auth: `CodexAuth::{ApiKey, Chatgpt, ChatgptAuthTokens}` behind `AuthManager`.
  * Operator identity is always label-first; AIM rejects steady-state `default`, so downstream identity is expected to map back to a human label.
* Ownership boundaries:
  * AIM owns labeled provider identity and durable refresh-capable OAuth material.
  * OpenClaw owns runtime auth-profile stores, model refs, and session identity cleanup.
  * Codex owns its local auth storage semantics, reload/refresh state machine, and workspace restriction enforcement.
  * There is currently no direct AIM -> Codex compiler; OpenClaw only knows how to scrape Codex credentials, not how to make Codex consume AIM labels.
* Public APIs:
  * `main(argv) -> Promise<void>`
  * `applyOpenclawFromState(params, state) -> { wrote }`
  * `syncOpenclawFromState(params, state) -> { auth, models, sessions }`
  * `login_with_chatgpt_auth_tokens(codex_home, access_token, chatgpt_account_id, chatgpt_plan_type) -> io::Result<()>`
  * `AuthManager::refresh_token() -> Result<(), RefreshTokenError>`
  * `readCodexCliCredentials() -> CodexCliCredential | null`

## 4.4 Observability + failure behavior today

* Logs:
  * `aim status` is the operator-facing surface: it sanitizes secrets, probes usage, and emits warnings for expiry, account collisions, and usage/auth failures.
  * Codex uses `tracing` plus auth/account notifications (`AccountLoginCompleted`, `AccountUpdated`, `AuthStatusChange`) around login, reload, and refresh failures.
  * OpenClaw logs auth-profile coercion failures, external CLI sync events, keychain reads, inheritance from `main`, and legacy-store migration behavior.
* Metrics:
  * No dedicated AIM metrics yet; status output and warnings are the main operator signals.
  * Codex account status and refresh behavior are observable through notifications and tracing, not a separate metrics layer in this plan.
* Failure surfaces:
  * AIM throws on malformed state, unsupported providers, invalid pins, missing credentials, invalid `expiresAt`, account-id collisions, malformed OpenClaw stores, or invalid desired model refs.
  * Codex login/server flows fail loud on missing auth code, state mismatch, workspace restriction violations, token endpoint failures, and persist failures.
  * Codex external auth fails loud on missing parent refresher, refresh timeout, JSON-RPC error, or refreshed-account mismatch.
  * OpenClaw’s Codex reader can scrape whichever local Codex account is active because it has no label/account guard.
* Common failure modes:
  * AIM credential expiry or wrong OpenClaw browser profile causing an `accountId` collision.
  * OpenClaw session drift preserving old provider/model/auth-profile overrides until `syncOpenclawFromState()` resets them.
  * Codex keychain/file divergence when store mode is `Auto` and the real active auth is not the file a human inspects.
  * Codex external-auth mode being unsuitable for standalone CLI use because refresh depends on a live parent app.
  * AIM mutations are backup-first rather than transactional; the failure mode is loud overwrite with timestamped backup receipts, not silent partial state reuse.

## 4.5 UI surfaces (ASCII mockups, if UI work)

```ascii
aim status

Accounts (N)
- openai-codex boss accountId:... expires=... usage=...
- anthropic claudalyst browser:... expires=... usage=...

OpenClaw pins
- agent_boss -> boss
- agent_lessons -> lessons

Warnings (M)
- credentials_expired label=claudalyst provider=anthropic
```
<!-- arch_skill:block:current_architecture:end -->

---

<!-- arch_skill:block:target_architecture:start -->
# 5) Target Architecture (to-be)

## 5.1 On-disk structure (future)

```text
work/aimgr/repo/aimgr/
├── src/
│   ├── cli.js
│   ├── state.js
│   ├── remote-import.js
│   └── targets/
│       ├── openclaw.js
│       └── codex-cli.js
└── test/
    ├── cli.test.js
    ├── remote-import.test.js
    └── codex-cli.target.test.js

~/.aimgr/
└── secrets.json
   └── {
       schemaVersion,
       accounts,
       pins.openclaw,
       credentials,
       imports.codexCli?,
       targets.codexCli?
      }

$CODEX_HOME/
├── auth.json
└── config.toml                  # read-only input to verify file-store semantics; not rewritten in v1

~/.openclaw/
└── ...                          # unchanged OpenClaw derived target
```

## 5.2 Control paths (future)

* Remote pool import (new):
  * `aim sync codex --from <file-or-ssh-locator>` -> load local AIM state -> fetch remote AIM state -> validate schema/provider/label/accountId/expiry -> import only portable `openai-codex` account metadata and credentials into local AIM SSOT -> drop host-local `openclawBrowserProfile` bindings and OpenClaw pin state -> record `imports.codexCli` provenance and freshness -> stop without mutating OpenClaw.
* Local Codex activation (new):
  * `aim codex use <label>` -> validate label exists and is `openai-codex` with fresh credentials -> resolve target `CODEX_HOME` and assert effective file-backed semantics -> compile Codex `AuthDotJson` from AIM credentials -> semantic-diff write `auth.json` -> read back and verify expected account/workspace -> record `targets.codexCli.activeLabel` and `targets.codexCli.lastAppliedAt` -> guarantee the next Codex process sees the new identity, while already-running long-lived Codex runtimes must restart or reload explicitly.
* Local Codex status / drift detection (new):
  * `aim status` -> build standard account view -> inspect target `CODEX_HOME/auth.json` and effective store mode -> report active local Codex label, source provenance, target home, and drift warnings when Codex does not match AIM SSOT.
* Existing OpenClaw flow (unchanged in behavior):
  * `aim login`, `aim pin`, `aim autopin openclaw`, `aim apply`, and `aim sync openclaw` continue to use the current one-way compiler into OpenClaw.

## 5.3 Object model + abstractions (future)

* New types/modules:
  * `state.js` owns state load/shape/migration so `cli.js` stops being the only schema boundary.
  * `remote-import.js` owns one-way import from another AIM state into the local AIM SSOT.
  * `targets/codex-cli.js` owns label -> Codex compiler, readback, and drift detection.
* Explicit contracts:
  * `credentials.openai-codex[label]` remains the only durable refresh-capable source for Codex OAuth material.
  * `imports.codexCli` stores only provenance/freshness metadata for the last remote import; it must not become a second credential map.
  * Remote import copies portable account identity only; host-local OpenClaw bindings like `openclawBrowserProfile` do not cross machines.
  * `targets.codexCli` stores only machine-local target metadata such as `homeDir`, `storeMode`, `activeLabel`, `expectedAccountId`, and `lastAppliedAt`; it must not duplicate access or refresh tokens.
  * The Codex compiler writes managed ChatGPT auth (`auth_mode: chatgpt`), not `chatgptAuthTokens`, because the target is a standalone local CLI.
  * The Codex compiler may synthesize `TokenData.id_token` from access-token claims, mirroring Codex’s own `from_external_tokens()` logic, because AIM does not currently store a raw `id_token`.
* Public APIs (new/changed):
  * `importCodexPoolFromAimSource(args, state) -> { importedLabels, source, wrote }`
  * `buildCodexAuthDotJson({ credential, account }) -> AuthDotJson`
  * `applyCodexCliFromState({ label, codexHome }, state) -> { label, accountId, authPath, wrote }`
  * `readCodexCliTargetStatus({ codexHome }, state) -> { activeLabel, storeMode, drift, accountId }`
  * Migration notes:
    * Existing OpenClaw compiler helpers can be extracted into `targets/openclaw.js`, but their operator behavior should stay byte-for-byte equivalent in the first implementation pass.
    * No OpenClaw or Codex upstream code changes are required for v1; the plan relies on their current contracts.

## 5.4 Invariants and boundaries

* Fail-loud boundaries:
  * `aim codex use <label>` must refuse when the label is missing, on the wrong provider, expired, missing `accountId`, or when the target Codex home is not effectively file-backed.
  * Remote import must refuse schema drift, unsupported providers, duplicate `accountId` collisions, or malformed upstream records instead of guessing.
  * Readback must flag account/workspace mismatch immediately after apply; AIM must not assume the downstream target consumed the intended identity.
  * AIM must not promise hot-swapping a long-lived Codex runtime that has already cached auth; the contract is “next process or explicit reload,” not magic in-place mutation.
* Single source of truth:
  * AIM state is the only durable credential SSOT.
  * Codex `auth.json` is compiled output and must never be reverse-imported back into AIM as truth.
  * V1 intentionally avoids Codex keychain/`auto` as an AIM-managed target so hidden state cannot outrank AIM.
* Determinism contracts (time/randomness):
  * For the same AIM state, label, and target `CODEX_HOME`, the compiled Codex auth payload must be stable except for an intentional `lastAppliedAt` metadata update in AIM state.
  * The compiler should perform semantic-diff writes so no-op reapply does not churn `auth.json`.
* Performance / allocation boundaries:
  * `aim codex use <label>` is local-only when credentials are fresh; it should not make network calls or browser launches.
  * `aim status` may inspect local Codex files but should not trigger Codex login or remote import implicitly.

## 5.5 UI surfaces (ASCII mockups, if UI work)

```ascii
aim sync codex --from agents@AmirsMacStudio:~/.aimgr/secrets.json
Imported 8 openai-codex labels from AmirsMacStudio
Local Codex pool is now fresh as of 2026-03-07T...

aim codex use boss
Active local Codex label: boss
CODEX_HOME: ~/.codex
accountId: org_...
status: ready

aim status
Codex target: label=boss home=~/.codex store=file source=AmirsMacStudio synced=2m ago
Warnings (0)
```
<!-- arch_skill:block:target_architecture:end -->

---

<!-- arch_skill:block:call_site_audit:start -->
# 6) Call-Site Audit (exhaustive change inventory)

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| CLI surface | `work/aimgr/repo/aimgr/src/cli.js` | `parseArgs()`, `printHelp()`, `main()` | Only knows `status`, `login`, `pin`, `autopin openclaw`, `apply`, `sync openclaw`, plus label shorthand. | Add explicit Codex import / activation / status paths while preserving existing OpenClaw commands unchanged. | The operator needs a first-class laptop flow, not an implied side effect of OpenClaw login. | `aim sync codex --from <locator>` and `aim codex use <label>` (or equivalent explicit codex subcommands) become the supported interface. | Extend `work/aimgr/repo/aimgr/test/cli.test.js` for new commands and non-regression on current commands. |
| State schema | `work/aimgr/repo/aimgr/src/cli.js` or extracted `src/state.js` | `createEmptyState()`, `loadAimgrState()`, `ensureStateShape()` | SSOT contains only `accounts`, `pins.openclaw`, and `credentials`. | Add additive machine-local metadata for `imports.codexCli` and `targets.codexCli`, with backward-compatible load/migration. | The plan needs provenance for imported pool state and a tracked active local Codex label without creating a second state file. | `ensureStateShape()` guarantees `imports.codexCli` / `targets.codexCli` objects when present, but credentials remain in the existing top-level map. | Add migration/shape tests in `cli.test.js` and a focused state-load test if extraction happens. |
| Host-local account binding | `work/aimgr/repo/aimgr/src/cli.js` or extracted `src/state.js` / `src/remote-import.js` | `ensureCodexAccountConfig()`, `accounts[label].openclawBrowserProfile` | AIM stores OpenClaw browser profile selection directly on the labeled account record. | Preserve browser-profile binding for host OpenClaw login flows, but strip it from remote Codex-pool imports and treat it as host-local metadata only. | Browser profile ids resolve to one host’s `~/.openclaw/browser/<profileId>/user-data` and are not portable to a Codex-only laptop. | Remote Codex import copies portable account identity and credentials only; host-local bindings remain local. | Add import tests that prove `openclawBrowserProfile` does not cross machines and existing login tests still preserve it locally. |
| Codex compiler | `work/aimgr/repo/aimgr/src/targets/codex-cli.js` (new) | `buildCodexAuthDotJson()`, `applyCodexCliFromState()` | No AIM -> Codex adapter exists today. | Compile AIM `openai-codex` credentials into managed Codex `AuthDotJson`, write file-backed `auth.json`, and verify account/workspace on readback. | This is the core feature: make local `codex` consume a selected AIM label. | `AuthDotJson` is derived from `credentials.openai-codex[label]`, with `auth_mode=chatgpt`, refresh token preserved, and `id_token` metadata synthesized from access-token claims when AIM has no raw `id_token`. | Add `codex-cli.target.test.js` for auth payload shape, semantic-diff writes, and readback drift detection. |
| Codex target validation | `work/aimgr/repo/aimgr/src/targets/codex-cli.js` (new) | `resolveTargetCodexHome()`, `assertCodexFileStoreMode()` | AIM has no opinion about Codex home or store mode. | Support only effective file-backed Codex homes in v1 and fail loud on `keyring` / `auto` ambiguity unless a dedicated file-backed target home is configured. | The compiler must own the real active target, not just a file Codex may ignore. | `targets.codexCli = { homeDir, storeMode: "file", activeLabel, expectedAccountId, lastAppliedAt }` becomes the local-target contract. | Add validation tests for default `~/.codex`, explicit alternate homes, and store-mode mismatch errors. |
| Codex process visibility | `work/aimgr/repo/aimgr/src/targets/codex-cli.js` (new) and `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs` | `applyCodexCliFromState()`, `AuthManager` reload boundary | Long-lived Codex runtimes cache auth and do not observe external `auth.json` changes until reload or restart. | Make the operator contract explicit: applying a label updates the next Codex process deterministically, but already-running Codex runtimes must restart or reload. | Without this, the UX would imply magic in-place account switching that Codex does not guarantee today. | `aim codex use <label>` reports file apply success separately from runtime pickup, and status can warn when a live process may still be stale. | Add contract tests for apply/readback and document manual smoke check around “new process vs existing process.” |
| Remote import | `work/aimgr/repo/aimgr/src/remote-import.js` (new) | `importCodexPoolFromAimSource()` | No cross-machine AIM sync exists. | Read AIM state from a file or SSH locator, validate it, and import only portable `openai-codex` labels/credentials into local AIM SSOT without touching OpenClaw. | The whole laptop workflow depends on reusing the Mac Studio pool without interactive login on the laptop, but host-local OpenClaw bindings cannot leak into a Codex-only machine. | Import is one-way and explicit; imported credentials overwrite local label records only when the incoming record is valid and fresher by policy, and `openclawBrowserProfile` is intentionally stripped. | Add `remote-import.test.js` for schema validation, provider filtering, account-id collision handling, provenance recording, and host-local field stripping. |
| Operator status | `work/aimgr/repo/aimgr/src/cli.js` | `buildStatusView()`, `renderStatusText()`, `buildWarningsFromState()` | Reports accounts, OpenClaw pins, expiry, usage, and account collisions, but nothing about local Codex target state. | Add Codex target status, active label, target home/store mode, import provenance, and drift warnings. | Once Codex becomes a downstream target, the operator needs to see whether the active local CLI really matches AIM intent. | `aim status` must expose `codexCli` target state as explicitly as it exposes OpenClaw pins today. | Extend status redaction/non-regression tests and add Codex target warning assertions. |
| Existing OpenClaw compiler | `work/aimgr/repo/aimgr/src/cli.js` or extracted `src/targets/openclaw.js` | `applyOpenclawFromState()`, `syncOpenclawFromState()` | One-way compiler from AIM SSOT into OpenClaw auth/profile/model/session state. | Extract only if needed for maintainability; keep behavior unchanged in the first implementation pass. | This work cannot regress the live OpenClaw fleet while adding Codex support. | OpenClaw remains a parallel downstream target compiled from the same AIM SSOT. | Existing `cli.test.js` OpenClaw apply/session tests remain the guardrail. |
| Codex contract anchoring | `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs`, `/Users/agents/workspace/codex/codex-rs/core/src/auth/storage.rs` | `AuthDotJson`, `AuthCredentialsStoreMode`, `AuthManager`, `UnauthorizedRecovery` | These upstream contracts already define the auth file shape, storage modes, and wrong-account/refresh behavior. | No code changes in v1; use them as compatibility constraints when building AIM’s compiler and validation. | AIM should compile to the native Codex contract instead of inventing a parallel one. | V1 target chooses managed `chatgpt` + file mode and deliberately does not use `chatgptAuthTokens` as the primary lane. | Manual smoke check plus new AIM target tests must reflect these upstream expectations. |
| Operator docs | `docs/AI_MANAGER_APP_REFERENCE.md` | operator reference | Describes AIM as OpenClaw-centric today. | Document Codex-only machine flows, remote import contract, supported file-store target, and loud-failure cases. | The operator interface is changing materially enough that the SSOT docs must match reality. | The operator contract includes explicit Codex pool import and local activation flows. | No automated tests; doc update is part of rollout. |

## 6.2 Migration notes

* Deprecated APIs (if any):
  * None required for v1. `aim apply` and `aim sync openclaw` stay exactly what they are today.
* Delete list (what must be removed; include legacy shims/parallel paths if any):
  * Do not add a reverse “read Codex auth.json back into AIM as truth” path.
  * Do not add a keychain/`auto`-managed Codex target path in v1.
  * Do not make Codex external `chatgptAuthTokens` the default v1 lane; keep it as an explicit alternative if an embedded parent-managed integration is pursued later.
  * Do not copy `pins.openclaw` or `openclawBrowserProfile` into the portable remote-import contract for Codex-only machines.

## 6.3 Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope (include/defer/exclude) |
| ---- | ------------- | ---------------- | ---------------------- | ------------------------------------- |
| AIM operator status | `work/aimgr/repo/aimgr/src/cli.js::buildStatusView`, `work/aimgr/repo/aimgr/src/cli.js::buildWarningsFromState` | Treat local Codex CLI as an explicit derived target with drift, expiry, and account-id reporting. | Without this, Codex target drift becomes invisible even though AIM now owns the intent. | `include` |
| Browser-profile portability | `work/aimgr/repo/aimgr/src/cli.js::ensureCodexAccountConfig`, `discoverOpenclawBrowserProfiles()`, `resolveOpenclawBrowserUserDataDir()` | Keep `openclawBrowserProfile` host-local and out of the remote Codex import contract. | Current browser profile ids resolve to a specific host’s `~/.openclaw/browser/<profileId>/user-data`, so importing them onto a laptop would create fake portability and wrong-account confusion. | `include` |
| Codex target determinism | `/Users/agents/workspace/codex/codex-rs/core/src/auth/storage.rs::create_auth_storage`, `/Users/agents/workspace/codex/codex-rs/core/src/config/mod.rs::config_defaults_to_file_cli_auth_store_mode` | Standardize AIM-managed Codex on effective file-backed state. | `auto` and keychain can outrank the file AIM writes, which would recreate hidden second truth. | `include` |
| Downstream auth compiler pattern | `/Users/agents/workspace/work/openclaw/src/agents/pi-auth-json.ts::ensurePiAuthJsonFromAuthProfiles` | Keep Codex projection as a one-way compiler with semantic-diff writes. | This is the closest existing “canonical store -> downstream auth file” pattern and avoids reverse sync drift. | `include` |
| Downstream runtime cache reset | `work/aimgr/repo/aimgr/src/cli.js::resetSessionEntryToDefaults()`, `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs::AuthManager` | Make cache/reset boundaries explicit after AIM-driven applies. | Writing derived state alone is not enough when OpenClaw sessions are sticky and Codex long-lived runtimes cache auth until reload. | `include` |
| OpenClaw raw Codex import | `/Users/agents/workspace/work/openclaw/src/agents/cli-credentials.ts::readCodexCliCredentials` | If OpenClaw ever imports AIM-managed Codex, make it label/account-aware instead of scraping whatever local Codex is active. | The current reader can import the wrong GPT Pro identity because it has no label guard. | `defer` |
| OpenClaw external CLI sync framework | `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/external-cli-sync.ts::syncExternalCliCredentials`, `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/store.ts::loadAuthProfileStoreForAgent` | Reuse the freshness-gated, read-only-safe external CLI sync pattern if Codex ever becomes an OpenClaw-importable external source. | The pattern already solves “external tool state visible at runtime without becoming durable truth.” | `defer` |
| OpenClaw auth labeling | `/Users/agents/workspace/work/openclaw/src/agents/model-auth-label.ts`, `/Users/agents/workspace/work/openclaw/src/agents/model-auth.ts` | Surface AIM labels anywhere OpenClaw resolves or displays auth identity. | Once many Codex identities exist, “OAuth” is not enough to debug wrong-account issues. | `defer` |
| OpenClaw OAuth refresh ownership | `docs/MAKE_AI_MANAGER_OWN_OAUTH_TOKEN_REFRESH_2026-03-05.md`, `work/aimgr/repo/aimgr/src/cli.js::applyOpenclawFromState()`, `/Users/agents/workspace/work/openclaw/src/agents/auth-profiles/oauth.ts::refreshOAuthTokenWithLock()` | Continue moving AIM-managed providers toward AIM-owned durable refresh with OpenClaw as a short-lived downstream. | It is the same SSOT-vs-downstream ownership problem, but broadening this cut would drag in live OpenClaw refresh semantics. | `defer` |
| OpenClaw OpenAI onboarding | `/Users/agents/workspace/work/openclaw/src/commands/auth-choice.apply.openai.ts::applyAuthChoiceOpenAI` | Hand off to AIM or write AIM-compatible metadata instead of creating unmanaged OpenAI/Codex auth. | Otherwise the repo keeps a second place that can mint Codex auth outside AIM. | `exclude` for this cut; follow-up after AIM/Codex works |
| Codex external-token bridge | `/Users/agents/workspace/codex/codex-rs/app-server/src/message_processor.rs::ExternalAuthRefreshBridge`, `/Users/agents/workspace/codex/codex-rs/app-server/src/codex_message_processor.rs::login_chatgpt_auth_tokens` | Use Codex’s native external-auth lane only for embedded parent-managed sessions. | It is elegant, but it is the wrong primary abstraction for standalone local CLI persistence. | `exclude` for v1; keep as documented alternative |
| Codex wrong-account guard | `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs::enforce_login_restrictions`, `/Users/agents/workspace/codex/codex-rs/core/src/auth.rs::refresh_external_auth` | Mirror the same expected-account guard in AIM readback/status validation. | AIM’s label intent must survive local drift and bad refreshes. | `include` |
<!-- arch_skill:block:call_site_audit:end -->

---

# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: systematic build, foundational first; every phase has exit criteria + explicit verification plan (tests optional).

## Phase 1 — North Star confirmed + Codex auth contract grounded

* Goal: Lock the Codex CLI downstream contract before proposing implementation details.
* Work: Complete research grounding for Codex auth storage, external token semantics, and machine-sync constraints.
* Verification (smallest signal): Source anchors are identified and the plan can name the exact downstream state AIM will own.
* Docs/comments (propagation; only if needed): Update this doc only.
* Exit criteria: North Star is confirmed and the current/target architecture sections are fully grounded.
* Rollback: Keep the doc in `draft` and do not implement.

## Phase N — Codex CLI adapter plan complete

* Goal: Reach an implementation-ready architecture that covers AIM SSOT, Codex adapter behavior, and cross-machine sync/import.
* Work: Complete target architecture, change inventory, phase plan, rollout, and verification details.
* Verification (smallest signal): Plan audit says the design is specific enough to implement without inventing missing contracts mid-flight.
* Docs/comments (propagation; only if needed): Update this doc only.
* Exit criteria: This document is implementation-ready and accepted as the single SSOT.
* Rollback: Revert to the previous draft state of this doc if the direction is wrong.

---

# 8) Verification Strategy (common-sense; non-blocking)

> Principle: avoid verification bureaucracy. Prefer the smallest existing signal. If sim/video/screenshot capture is flaky or slow, rely on targeted instrumentation + a short manual QA checklist and keep moving.
> Default: 1–3 checks total. Do not invent new harnesses/frameworks/scripts unless they already exist in-repo and are the cheapest guardrail.
> Default: keep UI/manual verification as a finalization checklist (don’t gate implementation).
> Default: do NOT create “proof” tests that assert deletions, visual constants, or doc inventories. Prefer compile/typecheck + behavior-level assertions only when they buy confidence.
> Also: document any new tricky invariants/gotchas in code comments at the SSOT/contract boundary so future refactors don’t break the pattern.

## 8.1 Unit tests (contracts)

* What invariants are unit-locked: To be completed after North Star confirmation.

## 8.2 Integration tests (flows)

* Critical flows: To be completed after North Star confirmation.
* Failure injection: To be completed after North Star confirmation.

## 8.3 E2E / device tests (realistic)

* Scenarios: To be completed after North Star confirmation.
* Evidence / artifacts (optional; do not block): To be completed after North Star confirmation.

---

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

* Flags / gradual rollout (only if needed; avoid long-lived dual paths): To be completed after North Star confirmation.
* Rollback plan (preferred over runtime shims): revert commit / kill-switch / disable new path

## 9.2 Telemetry changes

* New events: To be completed after North Star confirmation.
* New properties: To be completed after North Star confirmation.
* Dashboards / alerting: To be completed after North Star confirmation.

## 9.3 Operational runbook

* Debug checklist: To be completed after North Star confirmation.
* Common failure modes + fixes: To be completed after North Star confirmation.

---

# 10) Decision Log (append-only)

## 2026-03-07 — Start with Codex CLI, not generic downstream pooling

* Context: The immediate operator need is to reuse the existing GPT Pro pool for local Codex CLI work on another machine and switch labels when limits hit.
* Options:
  - Plan a generic “all downstream tools” system first.
  - Plan Codex CLI as the next explicit downstream adapter under AIM.
* Decision: Start with Codex CLI as the next downstream target and keep the first plan scoped to `openai-codex` OAuth reuse for Codex CLI.
* Consequences:
  - The plan stays tied to an immediate operator win.
  - Anthropic/other CLI adapters are intentionally deferred.
* Follow-ups:
  - Confirm the North Star before deeper architecture work.
