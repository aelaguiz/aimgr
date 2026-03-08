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
worklog: docs/MANAGE_CODEX_CLI_OAUTH_WITH_AIMGR_2026-03-07_WORKLOG.md
---

# TL;DR

- **Outcome:** AIM can manage labeled `openai-codex` OAuth accounts as a reusable pool for Codex CLI, so a developer can switch local Codex CLI between GPT Pro accounts by label without re-running browser auth when fresh credentials already exist in AIM.
- **Problem:** On Amir's laptop, local Codex usage keeps running into OpenAI five-hour and weekly usage limits, while roughly eight AIM-managed `openai-codex` accounts on the current authoritative AIM host, Amir's Mac Studio, are already being used successfully by agents and still have spare capacity. Today AIM only compiles labeled OAuth state into OpenClaw, while Codex CLI keeps separate auth state, so the laptop cannot easily rotate onto that existing AIM-managed account pool for local Codex work.
- **Approach:** Extend AIM's existing SSOT-to-downstream compiler model so Codex CLI becomes a clean first-class downstream peer to OpenClaw, with deterministic label-to-Codex auth projection, a machine-safe import/sync path from an authoritative AIM instance, and a one-command active-label switch for local Codex CLI. The current operator path is Mac Studio -> laptop, but the abstraction should not be bespoke to those two machines.
- **Plan:** Confirm the correct Codex CLI auth/storage contract, define the AIM-to-Codex adapter and remote sync model, design the operator UX for login/sync/use/status, then verify on a non-host machine with real Codex CLI behavior.
- **Non-negotiables:**
  - AIM remains the only logical credential SSOT.
  - Downstream Codex CLI auth is derived and disposable.
  - Codex support must feel like a natural extension of AIM, not a second credential manager bolted onto the side.
  - Labels remain the operator interface; no hidden “default account” semantics.
  - OpenClaw behavior must not regress.
  - No secrets in git.
  - Do not build a bespoke "Amir's laptop <-> Amir's Mac Studio" mirror system; build a reusable authority-to-consumer abstraction instead.
  - Do not overbuild a distributed secret platform or multi-writer sync system for this cut.
  - Missing/expired credentials fail loud instead of silently falling back.

---

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-03-07
external_research_grounding: not started
deep_dive_pass_2: done 2026-03-08
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
-->
<!-- arch_skill:block:planning_passes:end -->

---

# 0) Holistic North Star

## 0.0 Immediate goal for this doc
- Goal 1 only: extend AIM so Amir can use local Codex CLI on his laptop and rotate across the existing AIM-managed `openai-codex` account pool that already lives on Amir's Mac Studio.
- The motivating problem is practical, not abstract architecture purity: the laptop's currently active OpenAI/Codex account keeps exhausting five-hour or weekly usage limits, while the Mac Studio pool has multiple additional accounts that agents are already using without exhausting those limits.
- The current authoritative AIM instance happens to be Amir's Mac Studio, where AIM already manages the shared account inventory and durable OAuth state for the team and for OpenClaw; the laptop should consume that same AIM-managed truth instead of inventing a second local truth for Codex.
- Operator intent: when one OpenAI/Codex account on the laptop is rate-limited or usage-capped, AIM should make it easy to switch local Codex CLI to another label from the Mac Studio-managed pool instead of forcing a browser re-login or leaving capacity stranded on the Mac Studio.
- Architectural intent: solve this in a way that is generic in shape, meaning AIM owns durable provider truth and radiates derived auth to downstream tools from an authoritative AIM instance to consumer machines, but do not overbuild an abstract platform before there is a second concrete downstream need.
- Non-goal: we are not designing a special-purpose laptop-to-Mac-Studio mirroring product; Mac Studio is just the current authoritative AIM host in the motivating workflow.
- Other goals are intentionally deferred until Goal 1 is solved cleanly.

## 0.1 The claim (falsifiable)
> If AIM can expose an authoritative AIM-managed labeled `openai-codex` account pool to a consumer machine as another downstream target for Codex CLI, then Amir can keep using local Codex CLI on his laptop even after the laptop's current OpenAI/Codex account hits five-hour or weekly usage limits, measured by a successful Codex CLI auth-dependent run under label A, a deterministic switch to label B from the same pool without redoing browser auth, and loud failure when AIM credentials are expired or missing.

## 0.2 In scope
- UX surfaces (what users will see change):
  - AIM CLI flows to sync/import Codex-eligible accounts from an authoritative AIM instance onto a consumer machine, with the initial operator path being Mac Studio -> laptop.
  - AIM CLI flows to select which labeled AIM-managed account the local laptop Codex CLI should actively use.
  - AIM status output that shows Codex CLI-relevant labels, active local label, and drift/expiry warnings.
- Technical scope (what code will change):
  - AIM SSOT/schema and adapter logic needed to project labeled `openai-codex` credentials into Codex CLI auth state.
  - AIM authority-to-consumer import/sync logic, with the laptop as the initial non-OpenClaw Codex-only consumer environment.
  - Codex CLI downstream state management contract, including which storage mode/path AIM will own or require for deterministic switching.
  - Target/module boundaries that preserve a generic "AIM SSOT -> downstream projection" pattern so future downstreams can fit naturally without redesigning the whole system.

## 0.3 Out of scope
- UX surfaces (what users must NOT see change):
  - OpenClaw Slack, agent, or runtime UX unrelated to Codex CLI account reuse.
  - New generic secret-management UI beyond AIM CLI.
- Technical scope (explicit exclusions):
  - A special-purpose machine-pair mirroring system that is hardcoded to Amir's laptop and Amir's Mac Studio.
  - Changes to OpenClaw core/provider behavior unless later research proves a hard dependency.
  - Anthropic/Claude CLI account pooling in this first plan.
  - A generic downstream-tool platform beyond the abstractions actually needed to support Codex CLI cleanly.
  - A bidirectional multi-host secret mesh or always-on distributed replication service.
  - Generic API-key rotation; this plan is about subscription OAuth-backed `openai-codex` reuse for Codex CLI.

## 0.4 Definition of done (acceptance evidence)
- Amir's laptop can run AIM in a Codex-only consumer mode and import/sync the AIM-managed `openai-codex` pool from the current authoritative AIM host without inventing a second credential authority.
- The same explicit pull command handles first-time bootstrap and later refresh: if local AIM state does not yet exist on the laptop, the initial `aim sync codex --from agents@amirs-mac-studio` creates it and imports the portable Codex pool.
- An operator can run a label-driven command to make local laptop Codex CLI use a selected AIM-managed GPT Pro identity from that Mac Studio pool.
- Switching from one label to another rewrites only derived Codex CLI auth state and does not require browser login when AIM already holds fresh credentials for both labels.
- When the selected label is expired, missing, or incompatible, AIM fails loudly and points the operator back to AIM-managed remediation instead of silently using stale Codex state or an API key.
- OpenClaw AIM flows keep working as they do today for existing pinned agents.
- The resulting design is clearly reusable as "authoritative AIM instance -> consumer machine -> downstream target" and not described or implemented as a one-off laptop/Studio mirror.
- Evidence plan (common-sense; non-blocking):
  - Primary signal (keep it minimal; prefer existing tests/checks): targeted AIM adapter tests plus a real local Codex CLI smoke check on a non-host machine — confirm the selected label’s derived auth is written where Codex expects it and an auth-dependent Codex CLI command succeeds.
  - Optional second signal (only if needed): a label switch smoke test from label A to label B on the same machine — confirm no browser re-login occurs and the active downstream state changes deterministically.
  - Default: do NOT add bespoke screenshot harnesses / drift scripts unless they already exist in-repo or are explicitly requested.
  - Avoid negative-value tests/gates: do NOT add “deleted code not referenced” tests, visual-constant tests (colors/margins/pixels), doc-driven inventory gates, or mock-only interaction tests.
- Metrics / thresholds (if relevant):
  - Local account switch time: under 30 seconds once credentials already exist in AIM — measured via CLI flow timing on the target machine.
  - Interactive re-auth requirement for already-managed fresh labels: zero — measured via switch smoke test.

## 0.5 Key invariants (fix immediately if violated)
- AIM defines the only logical credential SSOT; Codex CLI auth state is derived output.
- In v1, one authoritative AIM instance manages the shared account inventory; consumer machines may import AIM-managed credentials for local use, but imported state is not a peer management authority.
- The operator interface stays label-first; account meaning must never depend on unlabeled defaults.
- Codex CLI switching must not require OpenClaw to be installed or running on the target machine.
- Cross-machine sync/import must fail loud on schema drift, provider mismatch, or expired credentials.
- No fallback to stale Codex auth or API-key auth when AIM-managed Codex auth is supposed to be active.
- The design should generalize naturally to other downstream consumers and other authority-to-consumer machine pairings, but v1 must not introduce a generalized control plane, daemon, or multi-writer replication system.
- Fallback policy (strict):
  - Default: **NO fallbacks or runtime shims** (feature must work correctly or fail loudly).
  - If an exception is truly required, it must be explicitly approved by aelaguiz by setting `fallback_policy: approved` and recording a Decision Log entry with a timebox + removal plan.

---

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)
1) Keep AIM as the only logical credential truth across OpenClaw and Codex CLI.
2) Make local Codex CLI account switching label-first, fast, and deterministic.
3) Make Codex support a natural extension of AIM's existing downstream-compiler model, not a parallel subsystem.
4) Preserve a reusable authority-to-consumer abstraction instead of a bespoke laptop/Studio bridge.
5) Support a Codex-only machine without dragging OpenClaw runtime assumptions into it.
6) Preserve a generic downstream pattern at the boundary level without overbuilding a platform.

## 1.2 Constraints
- Correctness: The selected Codex label must compile into the exact expected ChatGPT account/workspace, and AIM must never silently reuse stale Codex auth, keyring state, or API-key auth when label-driven OAuth is expected.
- Performance: `aim codex use <label>` should be local file I/O plus validation when AIM already has fresh credentials; remote import is explicit and should not be on the hot path for a label switch.
- Offline / latency: A laptop with already-imported fresh AIM credentials must be able to switch Codex labels offline; network is only required for the initial import or when credentials are actually stale.
- Compatibility / migration (default: hard cutover; no shims): Existing `aim login`, `aim pin`, `aim autopin openclaw`, `aim apply`, and `aim sync openclaw` behavior stays intact; new state keys must be additive, and v1 Codex support is intentionally file-backed only.
- Operational / observability: `aim status` must expose source provenance, active local Codex label, target home/store mode, and drift/expiry/account mismatch warnings so wrong-account failures are diagnosable without inspecting raw files.

## 1.3 Architectural principles (rules we will enforce)
- AIM owns durable credential truth; downstreams are compiled targets.
- In v1, a single authoritative AIM instance remains the operational home for managing shared account inventory and refresh-capable OAuth state; consumer-machine activation consumes that truth.
- Machine-local Codex CLI state must be deterministic from AIM input.
- Codex CLI support should reuse the same one-way SSOT -> derived target pattern that AIM already uses for OpenClaw.
- Cross-machine movement should be modeled as authority-to-consumer import/replication of AIM-managed state, not as a bespoke mirror between two named hosts.
- Generalize the boundary, not the whole world: keep interfaces and target metadata generic enough that another downstream can fit later, but do not build background services, distributed coordination, or policy engines that this use case does not need.
- Pattern propagation via comments (high leverage; no spam):
  - When we introduce a new SSOT/contract or a non-obvious “gotcha”, add a short doc comment in the canonical boundary module explaining the invariant + how to extend it safely.
  - Do NOT comment everything; comment the tricky bits we want to propagate forward.

## 1.4 Known tradeoffs (explicit)
- Clean AIM extension vs Codex-only sidecar hack → choose a clean AIM extension because the authoritative AIM host should keep managing shared accounts for both OpenClaw and Codex consumers, and consumer machines should consume that same truth instead of growing a separate login manager.
- Reusable authority-to-consumer abstraction vs bespoke Mac-Studio-to-laptop mirroring → choose the reusable abstraction because the current operator story happens to be Studio -> laptop, but the architecture should not encode that pairing as a special case.
- Generic downstream pattern vs generic downstream platform → choose the pattern, not the platform: keep the shape reusable, but only implement the concrete Codex CLI path needed for this operator workflow.
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
  - On Amir's laptop, the currently active OpenAI/Codex account keeps hitting five-hour or weekly usage limits during local Codex work.
  - Amir cannot point local laptop Codex CLI at any already-managed GPT Pro label from the Mac Studio pool on demand.
  - Hitting limits on one account does not have a clean AIM-driven label switch path for local Codex CLI.
  - The laptop cannot currently treat the Mac Studio AIM pool as reusable Codex CLI login inventory.
- Root causes (hypotheses):
  - AIM has no Codex CLI downstream adapter yet.
  - Codex CLI auth storage is separate from AIM SSOT.
  - The cross-machine sync/import model is not yet defined.
- Why now:
  - The operator pain is immediate: local laptop Codex work stalls when the active OpenAI/Codex account hits usage caps, even though the Mac Studio already has multiple AIM-managed accounts with spare capacity.
  - The business value is immediate: more usable GPT Pro capacity for local Codex work without reauth churn or wrong-account confusion.

## 2.3 Constraints implied by the problem
- Any solution that creates a second durable credential truth undermines AIM.
- Any solution that depends on OpenClaw being present on the target laptop misses the real goal.
- Any solution that silently falls back to stale or API-key auth defeats the operator promise.

---

<!-- arch_skill:block:research_grounding:start -->
# Research Grounding (external + internal “ground truth”)

## External anchors (papers, systems, prior art)
- OAuth 2.0 RFC 6749 section 6 — adopt standard refresh-token rotation semantics, including that refresh may succeed with a new access token and either rotate or preserve the refresh token, and that invalid/reused refresh tokens must fail loud — because Codex’s managed auth already expects standard refresh-token behavior and AIM should not invent a custom lifecycle.
- OAuth 2.0 for Native Apps / PKCE (`localhost` callback) — adopt browser + local callback only for interactive recovery/login paths — because Codex’s native login server already uses this shape, so AIM should treat browser auth as the fallback path, not build a competing embedded auth UX.

## Internal ground truth (code as spec)
- Authoritative behavior anchors (do not reinvent):
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — AIM already implements the canonical one-file state boundary and one-way downstream compilation model — evidence: `createEmptyState()`, `loadAimgrState()`, `writeJsonFileWithBackup()`, `ensureStateShape()`, `applyOpenclawFromState()`, `syncOpenclawFromState()`, `--home`, and `--state`.
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — host-local browser-profile binding is currently stored directly on account records and is therefore a portability boundary, not shared truth — evidence: `ensureCodexAccountConfig()` reads/writes `accounts[label].openclawBrowserProfile` and refuses to guess when the profile is missing on the current host.
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — AIM status is already the operator-facing observability surface and already treats secret redaction plus drift-like warnings as first-class behavior — evidence: `buildStatusView()`, `renderStatusText()`, `sanitizeForStatus()`, `buildWarningsFromState()`, `buildWarningsFromStatusAccounts()`.
  - `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` — current AIM behavior is already locked by tests around labeled projection, secret redaction, expiry warnings, and stale runtime cleanup — evidence: `status --json never leaks access/refresh tokens`, `status warns when tokens are expired or rejected`, `apply writes OpenClaw auth-profiles.json with labeled profile ids`, and `resetSessionEntryToDefaults clears runtime/override/authProfile fields`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth/storage.rs` — Codex CLI’s durable auth storage contract lives here, including the exact `$CODEX_HOME/auth.json` shape and backend modes — evidence: `AuthCredentialsStoreMode`, `AuthDotJson`, `get_auth_file()`, `create_auth_storage()`, and `AutoAuthStorage`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/src/config/mod.rs` — Codex’s default CLI auth storage choice is code-defined, not guesswork — evidence: `config_defaults_to_file_cli_auth_store_mode` asserts the default is `AuthCredentialsStoreMode::File`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth.rs` — Codex enforces workspace/account restrictions and has an explicit reload boundary for external file changes — evidence: `enforce_login_restrictions()`, `forced_chatgpt_workspace_id`, and the `AuthManager` comment that external `auth.json` changes are not observed until `reload()` is called.
  - `/Users/aelaguiz/workspace/codex/codex-rs/login/src/server.rs` — Codex native login persists managed auth from JWT claims and extracts workspace/plan metadata into stored tokens — evidence: `persist_tokens_async()`, `jwt_auth_claims()`, `chatgpt_account_id`, `plan_type`, and `ensure_workspace_allowed()`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/login/tests/suite/login_server_e2e.rs` — the persisted browser-login path is already end-to-end tested for “overwrite stale auth”, “create missing `CODEX_HOME`”, and “refuse writes on workspace mismatch” — evidence: `end_to_end_login_flow_persists_auth_json`, `creates_missing_codex_home_dir`, and `forced_chatgpt_workspace_id_mismatch_blocks_login`.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/tests/suite/auth_refresh.rs` — managed ChatGPT auth refresh is durable-storage-backed and fail-loud by reason class — evidence: `refresh_token_succeeds_updates_storage`, `refresh_token_returns_permanent_error_for_expired_refresh_token`, and `refresh_token_returns_transient_error_on_server_failure`.
  - `/Users/aelaguiz/workspace/codex/docs/authentication.md` — Codex officially documents `auth.json` as host-portable for headless/remote use after local login — evidence: the “Authenticate locally and copy your credentials to the headless machine” section says `$CODEX_HOME/auth.json` may be copied to another machine and should then “just work”.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts` — OpenClaw already models real Codex CLI discovery as keychain-first and file-second, which is exactly the hidden-state problem AIM must account for — evidence: `resolveCodexHomePath()`, `computeCodexKeychainAccount()`, `readCodexKeychainCredentials()`, and `readCodexCliCredentials()`.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.test.ts` — the keychain/file precedence is not hypothetical; it is explicitly tested — evidence: `reads Codex credentials from keychain when available` and `falls back to Codex auth.json when keychain is unavailable`.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/store.ts` plus `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/external-cli-sync.ts` — OpenClaw already has an explicit “external source -> canonical store” ingest pattern with freshness gating and inheritance from a main authority — evidence: `syncExternalCliCredentials()`, `syncExternalCliCredentialsForProvider()`, `loadAuthProfileStoreForAgent()`, and `ensureAuthProfileStore()`.
  - `/Users/aelaguiz/workspace/openclaw/src/agents/auth-profiles.ensureauthprofilestore.e2e.test.ts` plus `/Users/aelaguiz/workspace/openclaw/src/agents/auth-profiles/oauth.fallback-to-main-agent.e2e.test.ts` — OpenClaw already has end-to-end tests for “main authority + local consumer override/fallback” semantics — evidence: `merges main auth profiles into agent store and keeps agent overrides`, `falls back to main agent credentials when secondary agent token is expired and refresh fails`, and `adopts newer OAuth token from main agent even when secondary token is still valid`.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.ts` — the repo already has a one-way canonical-store -> downstream-auth-file compiler that writes only when semantics change — evidence: `ensurePiAuthJsonFromAuthProfiles()`, `convertCredential()`, and `credentialsEqual()`.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.test.ts` — the downstream-compiler contract is tested directly — evidence: `writes openai-codex oauth credentials into auth.json for pi-coding-agent discovery`, `second.wrote` is false on no-op reapply, and `preserves existing auth.json entries not in auth-profiles`.
- Existing patterns to reuse:
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — SSOT-first compile-later — Codex support should follow the same one-way compiler discipline as OpenClaw: AIM writes shared truth once, then projects deterministic downstream state.
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — target indirection via `--home` / `--state` — this is the natural base for consumer-machine targeting, isolated tests, and eventual authoritative-source selection without coupling Codex flows to OpenClaw runtime assumptions.
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — backup-first state mutation — authority-side writes already preserve the previous file on every mutation, which is the existing safety posture for a one-writer AIM authority.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/store.ts` plus `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/external-cli-sync.ts` — freshness-gated external ingest with main-store inheritance — this maps well to “authoritative AIM instance -> consumer AIM replica/cache” if the import path stays explicit and one-way.
  - `/Users/aelaguiz/workspace/openclaw/src/agents/auth-profiles.ensureauthprofilestore.e2e.test.ts` plus `/Users/aelaguiz/workspace/openclaw/src/agents/auth-profiles/oauth.fallback-to-main-agent.e2e.test.ts` — main-authority inheritance plus consumer-side override/fallback — this is the closest existing in-repo proof that an authority-to-consumer model can stay reusable without becoming a generic distributed sync platform.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.ts` plus `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.test.ts` — downstream bridge compiler with no-op reapply semantics — this is the closest existing pattern for an AIM Codex adapter that writes derived auth files deterministically and only when needed.
  - `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts` plus `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.test.ts` — hidden-state discovery pattern — this shows why status/drift detection must account for keychain-vs-file precedence and why file-only enforcement may be required for deterministic AIM control.
  - `/Users/aelaguiz/workspace/codex/docs/authentication.md` — documented host-portable auth-file workflow — this is external-facing evidence that a consumer machine can legitimately receive a copied `auth.json`, which supports the authority-to-consumer framing without requiring a bespoke mirror protocol.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth.rs` — explicit reload boundary — this should map directly into the operator contract that `aim codex use <label>` guarantees the next Codex process or explicit reload, not magical in-place session mutation.
  - `/Users/aelaguiz/workspace/codex/codex-rs/core/tests/suite/auth_refresh.rs` — durable managed-refresh expectations — if consumer machines persist imported refresh-capable auth locally, the AIM adapter must preserve Codex’s assumptions about on-disk refresh behavior and error classes.
  - `/Users/aelaguiz/workspace/aimgr/src/cli.js` — host-local metadata boundary — `openclawBrowserProfile` is already a concrete example of state that belongs to a machine-specific boundary and should not cross an authority-to-consumer import by default.

## Open questions (evidence-based)
- What is the exact consumer-state contract inside AIM on non-authoritative machines? — settle this by deciding whether imported credentials live in the same `credentials` map with provenance/role metadata or in a separate imported namespace, then checking which option preserves existing `loadAimgrState()`, `ensureStateShape()`, `sanitizeForStatus()`, and downstream compiler flows without making consumer state look like a peer authority.
- What local persistence model is acceptable on consumer machines? — settle this by deciding whether imported AIM-managed refresh-capable credentials may persist locally for offline rotation, then checking that choice against the new invariant “authoritative AIM instance is the only writer for shared account inventory” and against Codex’s managed-refresh expectations in `auth_refresh.rs`.
- Should AIM standardize on `cli_auth_credentials_store = "file"` for managed Codex consumers, or support an explicitly configured dedicated file-backed `CODEX_HOME` when the user’s default Codex setup is keyring/auto? — settle this by comparing determinism requirements against `AuthCredentialsStoreMode`, `AutoAuthStorage`, and the keychain-first behavior proven by `readCodexCliCredentials()`.
- What is the smallest authority-to-consumer import unit that still supports fast local rotation? — settle this by deriving the minimal portable subset of AIM state needed for a consumer machine (`label`, `provider`, `access`, `refresh`, `expiresAt`, `accountId`, provenance/freshness metadata), then checking that host-local fields like `openclawBrowserProfile` remain local-only.
- What is the correct collision/freshness rule when importing into consumer AIM state? — settle this by combining AIM’s existing `accountId` collision behavior in `assertNoCodexAccountIdCollisions()` with the freshness-gated ingest pattern in `syncExternalCliCredentialsForProvider()`, then deciding whether label match, accountId match, or freshness wins when they disagree.
- Should `aim codex use <label>` rewrite one active `$CODEX_HOME`, target a dedicated AIM-managed Codex home, or become an AIM wrapper that pins the target home at process start? — settle this by testing which option best matches Codex’s actual reload boundary, avoids silent keychain/file precedence issues, and keeps the operator story simple.
<!-- arch_skill:block:research_grounding:end -->

---

<!-- arch_skill:block:current_architecture:start -->
# 4) Current Architecture (as-is)

## 4.1 On-disk structure
```text
/Users/aelaguiz/workspace/aimgr/
├── docs/
│   └── MANAGE_CODEX_CLI_OAUTH_WITH_AIMGR_2026-03-07.md
├── src/
│   └── cli.js
└── test/
    └── cli.test.js

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

/Users/aelaguiz/workspace/codex/
├── docs/
│   └── authentication.md
└── codex-rs/
    ├── core/src/
    │   ├── auth.rs
    │   ├── auth/storage.rs
    │   └── config/mod.rs
    ├── core/tests/suite/
    │   └── auth_refresh.rs
    └── login/
        ├── src/server.rs
        └── tests/suite/login_server_e2e.rs

/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/
├── cli-credentials.ts
├── pi-auth-json.ts
└── auth-profiles/
    ├── external-cli-sync.ts
    └── store.ts

/Users/aelaguiz/workspace/openclaw/src/agents/
├── auth-profiles.ensureauthprofilestore.e2e.test.ts
└── auth-profiles.oauth.fallback-to-main-agent.e2e.test.ts
```

## 4.2 Control paths (runtime)

* Flow A - AIM login / refresh -> OpenClaw sync:
  * `aim <label>` or `aim login <label>` enters `main()` in `/Users/aelaguiz/workspace/aimgr/src/cli.js`, loads `~/.aimgr/secrets.json` via `loadAimgrState()` / `ensureStateShape()`, runs provider-specific login or refresh (`refreshOrLoginCodex()` / `refreshOrLoginAnthropic()`), persists with `writeJsonFileWithBackup()`, then recompiles OpenClaw state through `syncOpenclawFromState()`.
* Flow B - AIM status / warnings:
  * `aim status` loads the same state file, builds a redacted operator view via `buildStatusView()` and `sanitizeForStatus()`, and emits warnings from `buildWarningsFromState()` / `buildWarningsFromStatusAccounts()` about expiry, account collisions, usage probe failures, and other state issues.
* Flow C - Codex native login / persistence:
  * `codex login` runs Codex's native browser callback flow in `/Users/aelaguiz/workspace/codex/codex-rs/login/src/server.rs`, persists tokens through `persist_tokens_async()` + `save_auth()`, and loads them through `AuthManager`; external changes to `auth.json` are not observed until reload or a new process.
* Flow D - OpenClaw authority inheritance / external CLI ingestion:
  * OpenClaw loads `auth-profiles.json` via `ensureAuthProfileStore()` / `loadAuthProfileStoreForAgent()`, can inherit fresher credentials from `main`, and can ingest external CLI state through `syncExternalCliCredentials()`. Codex is only a readable external source today through `readCodexCliCredentials()` in `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts`; AIM does not currently drive Codex as a first-class downstream target.

## 4.3 Object model + key abstractions

* Key types:
  * AIM logical SSOT in `/Users/aelaguiz/workspace/aimgr/src/cli.js`: `accounts[label]`, `pins.openclaw[agentId] = label`, and `credentials[provider][label] = { access, refresh, expiresAt, accountId? }`.
  * AIM currently mixes a host-local field into account records: `accounts[label].openclawBrowserProfile`.
  * OpenClaw auth store in `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/store.ts`: `AuthProfileStore { version, profiles, order, lastGood, usageStats? }`.
  * Codex durable auth contract in `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth/storage.rs`: `AuthDotJson` plus `AuthCredentialsStoreMode::{File, Keyring, Auto}`.
  * Codex runtime auth in `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth.rs`: `AuthManager` owns loaded auth, refresh, reload, and wrong-account/workspace enforcement.
* Ownership boundaries:
  * AIM owns labeled provider identity plus durable refresh-capable OAuth material.
  * OpenClaw owns auth-profile stores, agent-level inheritance, model refs, and session cleanup.
  * Codex owns the local auth file/keychain contract, reload boundary, refresh behavior, and workspace restrictions.
  * There is no direct AIM -> Codex compiler today; OpenClaw only knows how to read local Codex credentials, not how to make Codex consume an AIM-selected label.
* Public APIs:
  * `main(argv) -> Promise<void>`
  * `loadAimgrState(params) -> state`
  * `applyOpenclawFromState(params, state) -> { wrote }`
  * `syncOpenclawFromState(params, state) -> { auth, models, sessions }`
  * `AuthManager::refresh_token() -> Result<(), RefreshTokenError>`
  * `readCodexCliCredentials() -> CodexCliCredential | null`
  * `ensurePiAuthJsonFromAuthProfiles() -> { wrote, path }`
  * No current API or CLI command exists to import a remote AIM-managed Codex pool or activate a local Codex label from AIM state.

## 4.4 Observability + failure behavior today

* Logs:
  * `aim status` is the primary AIM operator surface: it redacts secrets, probes usage, and surfaces warnings around expiry, account collisions, and auth failures.
  * Codex emits auth and account notifications plus `tracing` around login, reload, refresh, and workspace mismatch failures.
  * OpenClaw logs main-store inheritance, external CLI sync decisions, keychain reads, and legacy auth-store migration behavior.
* Metrics:
  * No dedicated AIM metrics layer exists; status output and warnings are the main operator signal.
  * Codex and OpenClaw expose behavior through logs/tests rather than a shared telemetry contract.
* Failure surfaces:
  * AIM throws on malformed state, unsupported providers, invalid pins, invalid `expiresAt`, account-id collisions, and malformed OpenClaw stores.
  * Codex login fails loud on auth-code issues, workspace restriction violations, token endpoint failures, and persist failures.
  * Codex's effective live auth can diverge from a file on disk when keychain or `auto` mode outranks the file a human inspects.
  * OpenClaw's Codex reader can ingest whichever local Codex account is active because it has no AIM label/account guard.
* Common failure modes:
  * A host-local `openclawBrowserProfile` binding points at the wrong browser profile or is missing on the current machine.
  * OpenClaw session state keeps stale provider/model/auth-profile identity until `syncOpenclawFromState()` clears it.
  * Codex keychain/file divergence makes local auth ambiguous when the store mode is `Auto`.
  * Codex `auth.json` changes do not affect already-running long-lived processes until reload or restart.
  * AIM writes are backup-first rather than transactional; failures are loud with backup artifacts, not silently merged state.

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

No Codex target section exists today.
```
<!-- arch_skill:block:current_architecture:end -->

---

<!-- arch_skill:block:target_architecture:start -->
# 5) Target Architecture (to-be)

## 5.1 On-disk structure (future)

```text
/Users/aelaguiz/workspace/aimgr/
├── docs/
│   └── MANAGE_CODEX_CLI_OAUTH_WITH_AIMGR_2026-03-07.md
├── src/
│   └── cli.js
└── test/
    └── cli.test.js

V1 note: the state/import/target boundaries are currently implemented as helper groups inside `src/cli.js` and locked by focused CLI-level tests in `test/cli.test.js`. Extraction into dedicated modules remains optional follow-up work, not a ship requirement for Goal 1.

~/.aimgr/
└── secrets.json
   └── {
       schemaVersion,
       accounts,
       credentials,
       imports.authority?,
       targets.openclaw?,
       targets.codexCli?
      }

$AIM_MANAGED_CODEX_HOME/
├── auth.json
└── config.toml      # validated when reusing an existing Codex home; not rewritten in v1

~/.openclaw/
└── ...              # existing OpenClaw derived target remains
```

## 5.2 Control paths (future)

* Flow A - authoritative AIM host keeps managing shared truth:
  * The authoritative AIM instance continues to own browser login, refresh-capable OAuth state, label assignment, and existing OpenClaw sync behavior. Nothing about the Mac Studio is hardcoded except that it is the current authority in the motivating workflow.
* Flow B - explicit authority -> consumer import:
  * `aim sync codex --from <authority>` works both as first-time bootstrap and later refresh: it loads local AIM state if present, creates it if missing, fetches authoritative AIM state, validates schema/provider/label/accountId/expiry, imports portable `openai-codex` account metadata plus credentials into the local AIM replica, strips host-local fields such as `openclawBrowserProfile`, records provenance in `imports.authority`, and does not activate any label or mutate OpenClaw as a side effect. For the current operator path, the human-facing authority form should be `agents@amirs-mac-studio`; lower-level `ssh://...` and file-path locators remain parser support, not the preferred daily UX.
* Flow C - local Codex activation:
  * `aim codex use <label>` validates that a local imported replica exists, validates the selected label, resolves one verified file-backed Codex home, compiles an `AuthDotJson` payload from AIM credentials, writes `auth.json` with semantic-diff behavior, reads back what Codex will see, and records machine-local target metadata in `targets.codexCli`.
* Flow D - status / drift / fail-loud checks:
  * `aim status` reports imported-source provenance, active local Codex label, effective target home/store mode, and drift or expiry warnings when local Codex state no longer matches AIM intent. The contract is "next Codex process or explicit reload", not in-place mutation of already-running runtimes.

## 5.3 Object model + abstractions (future)

* New types/modules:
  * V1 implementation note: these boundaries currently live as helper groups inside `/Users/aelaguiz/workspace/aimgr/src/cli.js` to minimize churn while the contract settles; extraction into dedicated modules remains a follow-up if the file becomes the limiting factor.
  * `src/cli.js` state helpers own load, migration, redaction helpers, and portability boundaries.
  * `src/cli.js` authority-import helpers own one-way import from an authoritative AIM source into local consumer AIM state.
  * `src/cli.js` OpenClaw target helpers keep operator behavior unchanged while reading target-local metadata.
  * `src/cli.js` Codex target helpers own label -> Codex compiler, readback, and drift detection.
* Explicit contracts:
  * One authoritative AIM instance is the only writer for shared account inventory and refresh-capable provider credentials.
  * Consumer machines reuse the same `accounts` and `credentials` maps for imported labels, but imported records carry provenance under `imports.authority`; there is no second credential map and no peer authority.
  * Imported local state may persist credentials for offline rotation, but that persistence is replica/cache state derived from the authority, not an independent management surface.
  * Host-local fields such as `openclawBrowserProfile`, OpenClaw pins, and other machine bindings do not belong in portable shared truth; they live under `targets.openclaw` or other machine-local target metadata and do not cross the authority-to-consumer import boundary.
  * `targets.openclaw` owns OpenClaw-specific machine metadata such as agent pins, browser-profile bindings, and apply metadata.
  * `targets.codexCli` stores only machine-local target metadata such as `homeDir`, `storeMode`, `activeLabel`, `expectedAccountId`, `lastAppliedAt`, and last readback result; it does not duplicate tokens.
  * The Codex target writes managed ChatGPT auth into one verified file-backed home and explicitly does not manage keychain or `auto` as part of v1.
  * OpenClaw and Codex remain sibling downstream targets compiled from the same AIM truth.
* Public APIs (new/changed):
  * `loadAimgrState(params) -> AimState`
  * `importFromAuthority({ from }, state) -> { importedLabels, source, wrote }`
  * `buildCodexAuthDotJson({ credential, account }) -> AuthDotJson`
  * `applyCodexCliFromState({ label, codexHome }, state) -> { label, accountId, authPath, wrote }`
  * `readCodexCliTargetStatus({ codexHome }, state) -> { activeLabel, storeMode, drift, accountId }`
  * Migration notes:
    * Existing OpenClaw compiler helpers can be extracted into `targets/openclaw.js`, but their operator behavior should stay byte-for-byte equivalent in the first implementation pass.
    * No upstream Codex or OpenClaw code changes are required for v1; AIM adapts to their current contracts.

## 5.4 Invariants and boundaries

* Fail-loud boundaries:
  * `aim codex use <label>` before any successful import fails with an explicit “sync from authority first” error instead of trying to infer or create local Codex auth.
  * `aim codex use <label>` refuses missing labels, wrong providers, expired credentials, missing `accountId`, malformed token payloads, and target homes that are not effectively file-backed.
  * Authority import refuses schema drift, unsupported providers, malformed upstream records, and duplicate `accountId` collisions instead of guessing.
  * Readback flags account or workspace mismatch immediately after apply; AIM does not assume the downstream target consumed the intended identity.
  * AIM does not promise hot-swapping a long-lived Codex process that has already cached auth; the contract is "next process or explicit reload."
* Single source of truth:
  * AIM defines the only logical credential truth.
  * In v1, one authoritative AIM instance writes shared inventory; consumer AIM state is an imported replica/cache, not a peer management plane.
  * Codex `auth.json` is compiled output and is never reverse-imported into AIM as truth.
  * V1 avoids keychain and `auto` as AIM-managed target modes so hidden state cannot outrank AIM intent.
* Determinism contracts (time/randomness):
  * For the same AIM state, label, and target home, the compiled Codex auth payload is stable except for intentional target metadata timestamps.
  * The Codex compiler performs semantic-diff writes so no-op reapply does not churn `auth.json`.
* Performance / allocation boundaries:
  * `aim codex use <label>` is local-only when credentials are already present and fresh; it does not trigger browser login.
  * `aim status` may inspect local Codex files and metadata, but it does not trigger login or implicit remote import.

## 5.5 UI surfaces (ASCII mockups, if UI work)

```ascii
aim sync codex --from agents@amirs-mac-studio
Imported 8 openai-codex labels from agents@amirs-mac-studio
Consumer replica updated at 2026-03-08T...

aim codex use boss
Active local Codex label: boss
CODEX_HOME: ~/.codex
accountId: org_...
status: ready

aim status
Codex target: label=boss home=~/.codex store=file source=authority-host synced=2m ago
Warnings (0)
```

## 5.6 Developer UX Contract (normative; lock this so it does not drift)

The laptop UX is intentionally narrow. The authoritative AIM host owns browser login, refresh-capable OAuth state, and shared account management. The laptop does not manage the shared pool; it only pulls a replica, activates one label for local Codex, inspects status, and switches labels when needed.

### First-time bootstrap on a new laptop

Expected behavior:
- The laptop may start with no `~/.aimgr/secrets.json` and no imported Codex pool.
- `aim sync codex --from agents@amirs-mac-studio` must work as the first pull for the current setup. It creates local AIM state if missing, imports portable `openai-codex` labels and credentials, records provenance under `imports.authority`, and does not activate any label implicitly.
- For Amir's day-to-day operator UX, `<authority>` should be easy to remember: `agents@amirs-mac-studio` means “read `~/.aimgr/secrets.json` over SSH from that host”.
- After the initial pull, the operator explicitly chooses a label with `aim codex use <label>`.

Required command contract:
```text
aim sync codex --from agents@amirs-mac-studio
```
- Success means: local AIM replica exists, imported labels are visible in `aim status`, and no OpenClaw target state changed as a side effect.
- Failure means: no partial hidden activation; the operator gets a loud error naming the import problem.
- Lower-level locator forms such as `ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json` remain valid, but the dev UX should prefer the shorter authority form above.

### Steady-state daily loop on the laptop

Expected behavior:
1. Optional refresh of the imported pool:
   `aim sync codex --from agents@amirs-mac-studio`
2. Activate the local Codex label:
   `aim codex use <label>`
3. Verify local state quickly:
   `aim status`
4. Run normal local `codex` commands.

Required semantics:
- `aim codex use <label>` is local file I/O plus validation when imported credentials are already present and fresh.
- Switching labels must not trigger browser login on the laptop.
- If the imported replica is already fresh, label switching must work offline.
- Already-running long-lived Codex processes are not hot-swapped; the guarantee is “next Codex process or explicit reload”.

### Pre-bootstrap and failure UX

Expected fail-loud behavior:
- If the operator runs `aim codex use <label>` before any successful import, AIM must fail loudly and point to `aim sync codex --from agents@amirs-mac-studio`.
- If the selected label is missing, expired, provider-mismatched, missing `accountId`, or otherwise incompatible, `aim codex use <label>` must fail without touching the active local Codex target.
- If the managed Codex target is not effectively file-backed because keychain or `auto` would outrank the file AIM writes, activation must fail loudly instead of proceeding ambiguously.
- If imported state is stale or drifted from the authority, `aim status` must make that visible before the operator starts guessing at raw files.

### Status UX

`aim status` is the operator’s single debug surface on the laptop. It must answer, in one command:
- Which authority source this laptop last imported from
- How fresh that imported replica is
- Which Codex label is active locally
- Which managed Codex home/store mode is being used
- Whether the local Codex target has drifted, expired, or mismatched the AIM-selected account

### Out-of-scope UX for v1

The laptop must not:
- perform shared-pool browser login management
- perform implicit background sync
- silently choose a default label
- silently fall back to stale local Codex auth, keychain auth, or API-key auth
- mutate OpenClaw as part of `aim sync codex` or `aim codex use`
<!-- arch_skill:block:target_architecture:end -->

---

<!-- arch_skill:block:call_site_audit:start -->
# 6) Call-Site Audit (exhaustive change inventory)

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| CLI surface | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `parseArgs()`, `printHelp()`, `main()` | Only supports `status`, `login`, label shorthand, `pin`, `autopin openclaw`, `apply`, and `sync openclaw`. | Add explicit consumer-machine Codex commands without changing existing OpenClaw command behavior. | The laptop workflow needs a first-class operator path, not an implicit side effect of OpenClaw login. | `aim sync codex --from <locator>` and `aim codex use <label>` become supported commands; `aim status` grows Codex target reporting. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for command parsing, help text, and non-regression on current commands. |
| First-time bootstrap path | `/Users/aelaguiz/workspace/aimgr/src/cli.js` or extracted `/Users/aelaguiz/workspace/aimgr/src/state.js` + `/Users/aelaguiz/workspace/aimgr/src/remote-import.js` | `createEmptyState()`, `loadAimgrState()`, `main()` `sync codex` branch | AIM can already tolerate a missing local state file, but there is no consumer-machine import path that turns “no local AIM state” into a usable Codex replica. | Make `aim sync codex --from <locator>` the explicit first pull as well as the steady-state refresh path: if local AIM state is absent, bootstrap it, import the portable Codex pool, and leave the local Codex target inactive until `aim codex use <label>`. | The laptop UX needs an initial pull that is explicit, repeatable, and free of hidden activation. | First import creates local AIM replica state and records provenance, but does not pick an active label automatically. | Add a CLI/bootstrap test for “no local state -> sync codex -> state created -> no active label yet”. |
| State schema + persistence | `/Users/aelaguiz/workspace/aimgr/src/cli.js` or extracted `/Users/aelaguiz/workspace/aimgr/src/state.js` | `resolveAimgrStatePath()`, `createEmptyState()`, `loadAimgrState()`, `ensureStateShape()`, `writeJsonFileWithBackup()` | AIM stores `accounts`, `credentials`, and `pins.openclaw` in one file with backup-first writes. | Keep the single state file, move machine-local OpenClaw metadata under `targets.openclaw`, add `imports.authority` and `targets.codexCli`, and centralize portability rules. | Consumer provenance and active-target metadata need a home, but we do not want a second source-of-truth file or portable state polluted with host-local bindings. | Portable shared truth stays in `accounts` / `credentials`; `imports.authority` records provenance; `targets.openclaw` and `targets.codexCli` own machine-local target metadata. | Add state-shape and migration coverage in `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` and a focused `/Users/aelaguiz/workspace/aimgr/test/state.test.js` if extraction happens. |
| Host-local metadata boundary | `/Users/aelaguiz/workspace/aimgr/src/cli.js` or extracted `/Users/aelaguiz/workspace/aimgr/src/state.js` + `/Users/aelaguiz/workspace/aimgr/src/remote-import.js` | `ensureCodexAccountConfig()`, `discoverOpenclawBrowserProfiles()`, `resolveOpenclawBrowserUserDataDir()` | AIM stores `accounts[label].openclawBrowserProfile` directly on the account record and keeps OpenClaw pins in portable state. | Move browser-profile bindings and OpenClaw pins into `targets.openclaw`, preserve them for the authoritative OpenClaw host, and exclude them from authority-to-consumer import. | Browser profile ids and agent ids are deployment-local and should not travel with portable credential truth. | Remote import copies portable identity and credentials only; OpenClaw machine bindings stay local to the machine that actually runs OpenClaw. | Add import tests proving host-local fields are stripped and migration tests proving legacy state is lifted into `targets.openclaw`. |
| Status / warnings | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `buildStatusView()`, `renderStatusText()`, `sanitizeForStatus()`, `buildWarningsFromState()`, `buildWarningsFromStatusAccounts()` | Status shows accounts, OpenClaw pins, usage, expiry, and collision warnings, but no Codex target state. | Add Codex target home, store mode, active label, provenance age, and drift or readback mismatch warnings. | Once Codex becomes a downstream target, operators need to see whether local CLI state still matches AIM intent. | `aim status` becomes the single debug surface for both OpenClaw and Codex downstreams. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for redaction plus Codex target warnings. |
| OpenClaw pinning surface | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `planEvenLabelAssignments()`, `resolveAutopinPoolLabels()`, `main()` `pin` / `autopin` branches | `pin` and `autopin` mutate portable `pins.openclaw` state directly today. | Retarget these commands to `targets.openclaw.pins` and keep their operator behavior unchanged. | OpenClaw agent ids are machine-local downstream metadata, not portable credential truth. | `pin` and `autopin openclaw` remain first-class commands, but they mutate the OpenClaw target block instead of shared portable state. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for state migration plus pinning non-regression. |
| Existing OpenClaw compiler | `/Users/aelaguiz/workspace/aimgr/src/cli.js` or extracted `/Users/aelaguiz/workspace/aimgr/src/targets/openclaw.js` | `applyOpenclawFromState()`, `syncOpenclawFromState()` | AIM already compiles one-way into OpenClaw auth, model, and session state using shared state plus portable `pins.openclaw`. | Extract into a sibling target module only if it reduces risk, and update it to read OpenClaw-specific metadata from `targets.openclaw` instead of portable state. | Codex should fit as a second downstream target, and OpenClaw-specific machine metadata should live with the OpenClaw target instead of shared truth. | OpenClaw remains a sibling downstream compiled from the same AIM truth, but its pins and browser bindings become target-local. | Existing `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` OpenClaw apply/session tests remain the guardrail. |
| Authority-to-consumer import | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `resolveAuthorityLocator()`, `loadAuthorityState()`, `importCodexFromAuthority()` | No cross-machine AIM import exists today. | Add explicit file or SSH-based import of portable `openai-codex` labels and credentials from an authoritative AIM state into local consumer AIM state. | The whole laptop workflow depends on reusing the existing Mac Studio-managed pool without redoing browser login on the laptop. | Import is one-way, explicit, provenance-aware, and strips host-local metadata while refusing malformed records. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for bootstrap, provider filtering, collision handling, and field stripping. |
| Codex target compiler | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `buildCodexAuthDotJson()`, `applyCodexCliFromState()` | No AIM -> Codex adapter exists today. | Compile AIM `openai-codex` credentials into Codex `AuthDotJson`, perform semantic-diff writes to `auth.json`, and verify account/workspace on readback. | This is the core feature that makes local `codex` consume a selected AIM label. | `targets.codexCli` becomes the machine-local contract for `homeDir`, `storeMode`, `activeLabel`, `expectedAccountId`, and apply/readback timestamps. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for payload shape, no-op reapply behavior, and status readback. |
| Codex target validation | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `resolveManagedCodexHomeDir()`, `ensureFileBackedCodexHome()`, `readCodexCliTargetStatus()` | AIM currently has no opinion about which Codex home is active or whether Codex is using file, keyring, or `auto`. | Support only one effective file-backed target home in v1 and fail loud on keychain or `auto` ambiguity unless an explicitly managed file-backed home is configured. | Deterministic AIM control is impossible if hidden stores can outrank the file AIM writes. | V1 contract is "AIM manages one verified file-backed Codex target"; keychain and `auto` are outside the managed path. | Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for default `~/.codex` and store-mode mismatch failures. |
| Pre-bootstrap activation failure | `/Users/aelaguiz/workspace/aimgr/src/cli.js` | `applyCodexCliFromState()`, `main()` `codex use` branch | There is currently no local AIM-driven Codex activation path, so there is also no contract for using a label before any import exists. | Make `aim codex use <label>` fail loudly when no imported replica is present and point to `aim sync codex --from agents@amirs-mac-studio` instead of inferring from ambient local Codex auth. | The initial laptop UX has to be explicit or it will drift into hidden fallback behavior. | No imported replica means no activation attempt and no mutation of the managed Codex target. | Add a CLI-level failure test for `aim codex use <label>` before any successful import. |
| Codex runtime cache boundary | `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth.rs` and `/Users/aelaguiz/workspace/codex/codex-rs/login/src/server.rs` | `AuthManager`, `enforce_login_restrictions()`, `persist_tokens_async()` | Codex caches auth in memory and enforces workspace/account restrictions; external `auth.json` changes are not seen until reload or a new process. | No upstream change in v1; AIM must align its apply/readback semantics and status wording with that runtime boundary. | Without this, the operator story would imply a hot-swap capability Codex does not actually provide. | `aim codex use <label>` guarantees the next Codex process or explicit reload, not in-place mutation of an existing long-lived session. | Cover in AIM contract tests and a short manual smoke checklist. |
| OpenClaw hidden-state discovery | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts` | `resolveCodexHomePath()`, `readCodexKeychainCredentials()`, `readCodexCliCredentials()` | OpenClaw reads Codex auth keychain-first and file-second, with no AIM label guard. | No v1 code change required here; use it as the proof that file/keychain ambiguity is real and must be excluded from AIM's managed Codex path. | This is the strongest local evidence that "just write auth.json" is insufficient when keychain or `auto` are in play. | AIM-managed Codex target must validate the effective store mode, not just the file contents. | No direct v1 OpenClaw tests required; keep `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.test.ts` as an external contract anchor. |
| Reusable downstream patterns | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/store.ts`, `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/external-cli-sync.ts`, `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.ts` | `ensureAuthProfileStore()`, `syncExternalCliCredentialsForProvider()`, `ensurePiAuthJsonFromAuthProfiles()` | OpenClaw already has main-authority inheritance, freshness-gated ingest, and semantic-diff downstream file writes. | Reuse these patterns conceptually inside AIM rather than inventing a second sync/compiler style. | They are the closest in-repo examples of reusable "one authority, one canonical store, many derived consumers" behavior. | Use freshness-gated import plus semantic-diff apply in AIM; no v1 upstream OpenClaw change is required. | Existing OpenClaw unit and e2e tests remain contract references, not code we need to change in v1. |
| Upstream Codex storage contract | `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth/storage.rs` and `/Users/aelaguiz/workspace/codex/codex-rs/core/src/config/mod.rs` | `AuthDotJson`, `AuthCredentialsStoreMode`, `config_defaults_to_file_cli_auth_store_mode` | Codex already defines the durable auth file shape and store-mode behavior. | No upstream code change in v1; AIM treats these files as compatibility boundaries it must compile to. | AIM should target the native Codex contract, not invent a parallel one. | V1 explicitly targets managed ChatGPT file-backed auth and excludes keyring / `auto` from the managed path. | Manual smoke plus AIM adapter tests should reflect these upstream expectations. |

## 6.2 Migration notes

* Deprecated APIs (if any):
  * None required for v1. `aim apply` and `aim sync openclaw` stay exactly what they are today.
* Delete list (what must be removed; include legacy shims/parallel paths if any):
  * Do not add a reverse “read Codex auth.json back into AIM as truth” path.
  * Do not add a keychain or `auto`-managed Codex target path in v1.
  * Do not make Codex external `chatgptAuthTokens` the default v1 lane; that is an embedded-session alternative, not the standalone CLI contract.
  * Do not copy `pins.openclaw`, `openclawBrowserProfile`, or other host-local bindings into the portable authority-import contract.
  * Do not add a bespoke laptop <-> Mac Studio mirror daemon or bidirectional sync path.

## 6.3 Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope (include/defer/exclude) |
| ---- | ------------- | ---------------- | ---------------------- | ------------------------------------- |
| AIM operator status | `/Users/aelaguiz/workspace/aimgr/src/cli.js::buildStatusView`, `/Users/aelaguiz/workspace/aimgr/src/cli.js::buildWarningsFromState` | Report the three layers explicitly: authority/import provenance, consumer replica freshness, and downstream target state. | Without this, Codex target drift stays invisible even though AIM now owns the intended identity. | `include` |
| AIM host-local OpenClaw metadata | `/Users/aelaguiz/workspace/aimgr/src/cli.js::ensureCodexAccountConfig`, `/Users/aelaguiz/workspace/aimgr/src/cli.js::applyOpenclawFromState` | Move `openclawBrowserProfile` and OpenClaw pins out of portable shared truth into `targets.openclaw`. | Browser profile ids and agent ids are deployment-local and should not force imports to strip "accidental host baggage" after the fact. | `include` |
| Consumer import freshness | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/external-cli-sync.ts::syncExternalCliCredentialsForProvider` | Reuse freshness-gated ingest semantics for authority-to-consumer import. | This avoids silent overwrite by older remote state and keeps the import model consistent with existing in-repo patterns. | `include` |
| Downstream compiler discipline | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/pi-auth-json.ts::ensurePiAuthJsonFromAuthProfiles` | Keep Codex projection as a one-way compiler with semantic-diff writes. | This prevents churn and avoids reverse-sync drift. | `include` |
| Codex target determinism | `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth/storage.rs::create_auth_storage`, `/Users/aelaguiz/workspace/codex/codex-rs/core/src/config/mod.rs::config_defaults_to_file_cli_auth_store_mode` | Standardize AIM-managed Codex on an effective file-backed target. | `auto` and keychain can outrank the file AIM writes and would recreate hidden second truth. | `include` |
| Runtime cache boundary | `/Users/aelaguiz/workspace/aimgr/src/cli.js::resetSessionEntryToDefaults`, `/Users/aelaguiz/workspace/codex/codex-rs/core/src/auth.rs::AuthManager` | Make cache and restart boundaries explicit after AIM-driven applies. | Writing derived state alone is not enough when OpenClaw sessions and Codex processes cache identity. | `include` |
| OpenClaw external CLI ingest | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/external-cli-sync.ts::syncExternalCliCredentials`, `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts::readCodexCliCredentials` | Treat AIM as the only durable authority; ambient local CLI state may seed or validate, but should not become canonical store on every load. | Today local external CLI state can become durable OpenClaw truth implicitly, which blurs writer ownership and recreates hidden second authority. | `defer` |
| OpenClaw main-agent inheritance | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/store.ts::ensureAuthProfileStore`, `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/auth-profiles/oauth.ts::adoptNewerMainOAuthCredential` | Recast main-agent auth as explicit authority -> replica sync instead of silent copy-on-read fallback. | The current merge-and-fallback behavior is effective, but it blurs authority semantics and behaves closer to multi-writer state than the cleaner model this doc now uses. | `defer` |
| OpenClaw raw Codex import | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/cli-credentials.ts::readCodexCliCredentials` | If OpenClaw ever imports AIM-managed Codex, make it label-aware instead of scraping whichever local Codex identity is active. | The current reader has no label guard and could import the wrong GPT Pro account. | `defer` |
| OpenClaw OpenAI/Codex onboarding | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/commands/auth-choice.apply.openai.ts::applyAuthChoiceOpenAI` | Route new OpenAI/Codex onboarding through AIM-managed authority/consumer state instead of minting parallel local truth. | Otherwise the repo still has a second place that can create Codex auth outside AIM's model. | `defer` |
| OpenClaw auth labeling | `/Users/aelaguiz/workspace/repos/agents/agents/openclaw/src/agents/model-auth.ts` and neighboring auth-label surfaces | Surface AIM labels anywhere OpenClaw displays resolved auth identity. | Once many Codex identities exist, generic "OAuth" display is not enough to debug wrong-account issues. | `defer` |
| Codex external-token bridge | `/Users/aelaguiz/workspace/codex/codex-rs/app-server/src/message_processor.rs::ExternalAuthRefreshBridge` and `/Users/aelaguiz/workspace/codex/codex-rs/app-server/src/codex_message_processor.rs::login_chatgpt_auth_tokens` | Keep Codex's external-token bridge as an embedded-session alternative only. | It is elegant, but it is the wrong primary abstraction for standalone local CLI persistence on a consumer laptop. | `exclude` |
<!-- arch_skill:block:call_site_audit:end -->

---

<!-- arch_skill:block:phase_plan:start -->
# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: systematic build, foundational first; every phase has exit criteria + explicit verification plan. No fallbacks or runtime shims: the system must work correctly or fail loudly. Prefer programmatic checks per phase, keep manual verification as a short final checklist, and document new invariants only at the canonical boundary modules where they will prevent future drift.
>
> Implementation status as of 2026-03-08: phases 1 through 5 are materially implemented inline in `/Users/aelaguiz/workspace/aimgr/src/cli.js` and covered in `/Users/aelaguiz/workspace/aimgr/test/cli.test.js`. Phase 6 remains partial until real authority-SSH and consumer-machine Codex smoke verification is complete.

## Phase 1 — Split Portable AIM Truth From Machine-Local Target Metadata

* Goal: establish the state boundary that makes authority-to-consumer replication clean instead of treating host-local OpenClaw bindings as portable truth.
* Work:
  * Extract AIM state load/shape/migration helpers from `/Users/aelaguiz/workspace/aimgr/src/cli.js` into `/Users/aelaguiz/workspace/aimgr/src/state.js` only if it materially reduces implementation risk; if not, centralize the contract in place first and extract later.
  * Define the new state contract: portable shared truth stays in `accounts` and `credentials`; machine-local metadata moves under `targets.openclaw` and `targets.codexCli`; authority provenance lives under `imports.authority`.
  * Migrate legacy `pins.openclaw` and `accounts[label].openclawBrowserProfile` into `targets.openclaw`, while keeping reads backward-compatible during the migration window.
  * Update the current call sites that assume portable OpenClaw metadata: `ensureStateShape()`, `buildStatusView()`, `buildWarningsFromState()`, `ensureCodexAccountConfig()`, `planEvenLabelAssignments()`, `resolveAutopinPoolLabels()`, and the `pin` / `autopin` / `apply` / `sync` branches in `main()`.
* Verification (smallest signal):
  * Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` with state-shape and migration coverage.
  * Add a focused state test file if extraction happens, otherwise keep the contract tests in `cli.test.js`.
  * Confirm existing OpenClaw apply/session tests still pass with migrated state.
* Docs/comments (propagation; only if needed):
  * Add one short code comment at the canonical state boundary explaining “portable truth vs machine-local target metadata”.
* Exit criteria:
  * Legacy AIM state loads cleanly.
  * New writes place OpenClaw-specific metadata under `targets.openclaw`.
  * Existing OpenClaw operator behavior is unchanged.
* Rollback:
  * Keep the new boundary on paper only and revert the migration if compatibility risk appears before downstream code starts depending on it.

## Phase 2 — Preserve OpenClaw As A First-Class Sibling Target

* Goal: make the target abstraction real by moving OpenClaw onto the same target-local model before adding Codex.
* Work:
  * Update `applyOpenclawFromState()` and `syncOpenclawFromState()` to read OpenClaw pins and browser bindings from `targets.openclaw`.
  * Keep `pin`, `autopin openclaw`, `apply`, and `sync openclaw` as the same operator commands, with no UX expansion.
  * Extract `/Users/aelaguiz/workspace/aimgr/src/targets/openclaw.js` only if it reduces risk while preserving byte-for-byte behavior at the CLI boundary.
  * Preserve current `--home` semantics so dev/test runs remain isolated and model/session sync behavior does not change accidentally.
* Verification (smallest signal):
  * Re-run the current OpenClaw guards in `/Users/aelaguiz/workspace/aimgr/test/cli.test.js`, especially `apply writes OpenClaw auth-profiles.json with labeled profile ids` and `resetSessionEntryToDefaults clears runtime/override/authProfile fields`.
  * Add one pin/autopin non-regression test that proves the migrated metadata still drives the same derived OpenClaw output.
* Docs/comments (propagation; only if needed):
  * Add one short comment at the OpenClaw target boundary explaining that OpenClaw metadata is target-local and compiled from portable AIM truth.
* Exit criteria:
  * OpenClaw remains behaviorally identical from the operator’s perspective.
  * The target abstraction exists in code, not just in the doc.
* Rollback:
  * Keep the migrated state shape but leave OpenClaw logic in `cli.js` if extraction introduces unnecessary churn.

## Phase 3 — Add Explicit Authority-To-Consumer Import

* Goal: make a consumer machine able to ingest the authoritative `openai-codex` pool without inventing peer authority or dragging in OpenClaw assumptions.
* Work:
  * Add an explicit `importCodexFromAuthority({ from, state })` helper boundary in `/Users/aelaguiz/workspace/aimgr/src/cli.js`; extract it later only if the now-stable contract becomes awkward to maintain inline.
  * Support file-based import first, then SSH locator support if it is still the smallest path after implementation starts; do not build a daemon or background sync service.
  * Validate upstream schema, provider, label, `accountId`, expiry, and collision rules before writing any local state.
  * Strip host-local metadata during import and record provenance/freshness under `imports.authority`.
  * Add the CLI surface for `aim sync codex --from <locator>` without mutating OpenClaw as a side effect.
* Verification (smallest signal):
  * Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for schema validation, collision handling, provider filtering, field stripping, and bootstrap behavior.
  * Add one CLI-level test proving `aim sync codex --from <locator>` updates only the local AIM replica and does not touch OpenClaw target state.
* Docs/comments (propagation; only if needed):
  * Add one short comment at the import boundary explaining why imported credentials are replica/cache state, not peer authority.
* Exit criteria:
  * A consumer AIM state can import portable `openai-codex` labels from an authority source.
  * Import failure modes are loud and deterministic.
  * OpenClaw is unaffected unless the operator explicitly uses OpenClaw commands.
* Rollback:
  * Drop the CLI command and keep the replica contract internal until the import path is stable.

## Phase 4 — Add Deterministic Codex Target Activation

* Goal: let AIM activate one imported label as the local Codex identity with no browser step when AIM already holds fresh credentials.
* Work:
  * Add `buildCodexAuthDotJson()`, `applyCodexCliFromState()`, and `readCodexCliTargetStatus()` as an explicit helper boundary in `/Users/aelaguiz/workspace/aimgr/src/cli.js`; extract later only if the contract becomes awkward to maintain inline.
  * Enforce one verified file-backed managed target home in v1; fail loud on keychain or `auto` ambiguity instead of trying to paper over it.
  * Implement `aim codex use <label>` in `/Users/aelaguiz/workspace/aimgr/src/cli.js`.
  * On apply, compile `AuthDotJson`, perform semantic-diff writes to `auth.json`, read back the resulting state, and verify the expected account/workspace contract.
  * Record machine-local activation metadata under `targets.codexCli`.
* Verification (smallest signal):
  * Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` for payload shape, file-store validation, and readback mismatch detection.
  * Add one CLI integration test for `aim codex use <label>` against an isolated managed Codex home.
* Docs/comments (propagation; only if needed):
  * Add one short comment at the Codex target boundary explaining “file-backed only in v1” and “next process or explicit reload”.
* Exit criteria:
  * `aim codex use <label>` writes deterministic downstream auth for a managed Codex home.
  * Already-running Codex processes are explicitly treated as out of scope until restart or reload.
* Rollback:
  * Keep imported replica state but disable the CLI activation command if target validation proves too noisy until the managed-home contract is tightened.

## Phase 5 — Make Status And Warnings Match The Real Operator Loop

* Goal: turn `aim status` into the single debugging surface for authority provenance, consumer freshness, and downstream target drift.
* Work:
  * Treat the Developer UX Contract in this doc as normative and make the CLI/status output consistent with it.
  * Extend `buildStatusView()` and `renderStatusText()` to show authority/import provenance, Codex target home/store mode, active label, and drift or expiry warnings.
  * Preserve redaction guarantees in `sanitizeForStatus()`.
  * Add warnings for store-mode mismatch, missing managed home, account mismatch on readback, stale import provenance, and missing active label.
  * Keep the OpenClaw section intact, but sourced from `targets.openclaw`.
* Verification (smallest signal):
  * Extend `/Users/aelaguiz/workspace/aimgr/test/cli.test.js` with Codex-target status coverage and redaction non-regression.
  * Add one text-render regression test that proves the operator can see authority source, active Codex label, and warning state in one command.
* Docs/comments (propagation; only if needed):
  * None beyond the state/target boundary comments unless a warning category is non-obvious.
* Exit criteria:
  * An operator can inspect one status view and understand which authority the machine imported from, which Codex label is active locally, and why a target is unhealthy.
* Rollback:
  * Keep JSON status first and reduce text rendering scope if presentation churn blocks shipping.

## Phase 6 — Final Verification, Operator Docs, And Follow-Up Cuts

* Goal: close the loop with the smallest credible verification and record what is intentionally deferred so v1 does not sprawl.
* Work:
  * Replace the placeholder verification section with the exact checks this plan depends on: targeted AIM tests plus one real consumer-machine Codex smoke check.
  * Treat the first-time bootstrap flow and the steady-state laptop loop as ship-blocking UX contracts, not implementation details.
  * Fill in rollout/runbook sections for import, activation, and recovery from expired or mismatched credentials.
  * Update related AIM operator docs if they exist locally; if a referenced doc is missing, either create the minimal replacement or remove the stale reference.
  * Record deferred follow-ups explicitly: OpenClaw ambient external-CLI ingest, main-agent inheritance cleanup, OpenAI/Codex onboarding unification, and richer SSH/source ergonomics if file import ships first.
* Verification (smallest signal):
  * Test pass for the new AIM suites.
  * One manual checklist on a consumer machine: import authority pool, activate label A, run one auth-dependent Codex command, switch to label B, confirm no browser login, confirm loud failure for an expired or mismatched label.
* Docs/comments (propagation; only if needed):
  * Update this doc’s verification, rollout, and runbook sections.
* Exit criteria:
  * The implementation is ship-ready for Goal 1.
  * Deferred work is explicit instead of leaking into v1.
* Rollback:
  * Ship only through the last fully verified phase and leave later phases documented but unapplied.
<!-- arch_skill:block:phase_plan:end -->

---

# 8) Verification Strategy (common-sense; non-blocking)

> Principle: avoid verification bureaucracy. Prefer the smallest existing signal. If sim/video/screenshot capture is flaky or slow, rely on targeted instrumentation + a short manual QA checklist and keep moving.
> Default: 1–3 checks total. Do not invent new harnesses/frameworks/scripts unless they already exist in-repo and are the cheapest guardrail.
> Default: keep UI/manual verification as a finalization checklist (don’t gate implementation).
> Default: do NOT create “proof” tests that assert deletions, visual constants, or doc inventories. Prefer compile/typecheck + behavior-level assertions only when they buy confidence.
> Also: document any new tricky invariants/gotchas in code comments at the SSOT/contract boundary so future refactors don’t break the pattern.

## 8.1 Unit tests (contracts)

* What invariants are unit-locked:
  * State migration preserves portable `accounts` / `credentials` while lifting host-local OpenClaw metadata into `targets.openclaw`.
  * `aim sync codex --from agents@amirs-mac-studio` bootstraps local AIM state when the laptop has no prior `~/.aimgr/secrets.json`.
  * Remote import strips host-local metadata and records provenance under `imports.authority`.
  * `aim codex use <label>` refuses missing labels, expired credentials, wrong providers, missing `accountId`, and non-file-backed target homes.
  * Codex target apply is semantic-diff based and does not churn `auth.json` on no-op reapply.
  * `aim status` redacts secrets while still exposing authority source, active label, target home/store mode, and warning categories.
  * These checks currently live in `/Users/aelaguiz/workspace/aimgr/test/cli.test.js`; dedicated `state` / `remote-import` / `codex-cli.target` test files were not needed for v1.

## 8.2 Integration tests (flows)

* Critical flows:
  * First-time laptop bootstrap: no local AIM state -> `aim sync codex --from agents@amirs-mac-studio` -> replica created -> `aim codex use <label>` succeeds.
  * Steady-state refresh: existing imported replica -> `aim sync codex --from agents@amirs-mac-studio` updates freshness/provenance without mutating OpenClaw target state.
  * Label rotation: active label A -> `aim codex use <labelB>` rewrites only the managed Codex target and updates status accordingly.
  * Status visibility: one `aim status` call shows authority source, active label, target mode, and any drift/expiry warnings.
* Failure injection:
  * `aim codex use <label>` before any import fails with an explicit “sync from authority first” message.
  * Import of malformed upstream state fails with no partial activation.
  * Activation against a keychain or `auto`-ambiguous target home fails loud.
  * Activation with expired or account-mismatched credentials fails without changing the active local Codex target.

## 8.3 E2E / device tests (realistic)

* Scenarios:
  * On a real consumer laptop, run the initial pull from the authority host, activate label A, execute one auth-dependent `codex` command, switch to label B, and execute the same command again.
  * Confirm no browser login occurs on the laptop for already-imported fresh labels.
  * Confirm an already-running long-lived Codex process does not hot-swap implicitly, while a new process picks up the new label.
* Evidence / artifacts (optional; do not block):
  * CLI transcripts or short command/result notes are sufficient; do not build screenshots or bespoke capture harnesses for this.

---

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

* Flags / gradual rollout (only if needed; avoid long-lived dual paths):
  * No feature flag by default. Ship behind incomplete commands until the end-to-end contract is verified.
  * Prefer file-based authority import first if SSH/source ergonomics are not yet stable; keep the command surface the same and widen accepted locators later.
* Rollback plan (preferred over runtime shims):
  * Revert the new Codex-specific CLI paths or stop at the last fully verified phase.
  * Do not leave a half-working fallback path that silently reuses unmanaged Codex auth.

## 9.2 Telemetry changes

* New events: To be completed after North Star confirmation.
* New properties: To be completed after North Star confirmation.
* Dashboards / alerting: To be completed after North Star confirmation.

## 9.3 Operational runbook

* Debug checklist:
  * Run `aim status` first. Confirm the authority source, import freshness, active local Codex label, and target home/store mode.
  * If no replica is present, run `aim sync codex --from agents@amirs-mac-studio`; this is both the first-time bootstrap and the steady-state refresh path for the current setup.
  * If the wrong label is active, run `aim codex use <label>` and then start a new Codex process.
  * If activation fails, inspect whether the target home is effectively file-backed and whether the imported label is fresh, unexpired, and has an `accountId`.
  * If local state looks stale relative to the authority, re-run `aim sync codex --from agents@amirs-mac-studio` before debugging anything else.
* Common failure modes + fixes:
  * `aim codex use <label>` fails before any import:
    Fix: run `aim sync codex --from agents@amirs-mac-studio` to bootstrap the local replica.
  * Imported label is expired or missing:
    Fix: refresh or repair it on the authoritative AIM host, then pull again on the laptop.
  * Codex target is keychain or `auto`-ambiguous:
    Fix: point AIM at a verified file-backed managed Codex home; do not rely on ambient keychain state.
  * Wrong account still appears active after switching:
    Fix: start a new Codex process or explicitly reload; do not expect hot-swap of an already-running long-lived process.
  * `aim status` shows drift or account mismatch:
    Fix: re-import from the authority, re-apply the label, and confirm the managed target home is the one Codex is actually using.

---

# 10) Decision Log (append-only)

## 2026-03-07 — Start with Codex CLI, not generic downstream pooling

* Context: The immediate operator need is to keep local Codex CLI usable on Amir's laptop when the currently active OpenAI/Codex account hits five-hour or weekly usage limits by reusing the existing GPT Pro pool on Amir's Mac Studio and switching labels when limits hit.
* Options:
  - Plan a generic “all downstream tools” system first.
  - Plan Codex CLI as the next explicit downstream adapter under AIM.
* Decision: Start with Codex CLI as the next downstream target and keep the first plan scoped to `openai-codex` OAuth reuse for Codex CLI.
* Consequences:
  - The plan stays tied to an immediate operator win.
  - The resulting shape should still be a clean AIM extension that could support future downstream adapters without redesigning the SSOT model.
  - Anthropic/other CLI adapters are intentionally deferred.
* Follow-ups:
  - Confirm the North Star before deeper architecture work.

## 2026-03-08 — Reframe as authority-to-consumer AIM extension, not a machine-pair mirror

* Context: The immediate workflow is Amir's Mac Studio managing the shared account pool and Amir's laptop consuming that pool for local Codex CLI rotation, but the architecture should not hardcode that pair as a special system.
* Options:
  - Frame the plan as a bespoke laptop-to-Studio mirroring feature.
  - Frame the plan as a reusable authority-to-consumer AIM extension that happens to be motivated by the Studio-to-laptop workflow.
* Decision: Frame the architecture as a reusable authority-to-consumer AIM extension, with Mac Studio -> laptop as the initial operator story, while explicitly avoiding a generalized distributed sync platform.
* Consequences:
  - The current operator pain stays front and center.
  - The design remains extensible at the boundary level without committing to overbuilt infrastructure.
  - Local imported AIM state must be described as consumer replica/cache state, not as a peer authority.
* Follow-ups:
  - Tighten the deep dive around authority/replica semantics and exact local persistence rules.

## 2026-03-08 — Keep the v1 implementation inline and seed Codex `id_token` from the access JWT

* Context: The plan initially described optional extraction into `state.js`, `remote-import.js`, and `targets/codex-cli.js`, but the current AIM repo is a single-file CLI and the fastest low-risk path for Goal 1 was to land the new authority-import and Codex-target boundaries inline first. During implementation, the pinned `@mariozechner/pi-ai@0.55.1` contract also proved that AIM only receives `access`, `refresh`, `expires`, and `accountId` for OpenAI Codex, while Codex `auth.json` still requires a JWT-shaped `id_token`.
* Options:
  - Extract new AIM boundaries into new modules immediately and block activation work on that refactor.
  - Land the new boundaries as helper groups inside `src/cli.js`, keep the extraction optional, and explicitly document the one sharp edge around Codex `id_token`.
* Decision: Keep the v1 implementation inline in `/Users/aelaguiz/workspace/aimgr/src/cli.js` and seed Codex `auth.json.tokens.id_token` from the same access JWT claims carrier when AIM does not already hold an explicit `idToken`.
* Consequences:
  - The implementation stays smaller and easier to verify against the current repo shape.
  - The plan doc and call-site audit must describe the actual in-file helper boundaries instead of pretending new modules already exist.
  - Codex-target comments and tests need to make the `id_token` strategy explicit so future refactors do not treat it as accidental.
* Follow-ups:
  - If `src/cli.js` becomes the main source of change friction, extract the now-stable helper boundaries into dedicated files.
  - If the login library starts exposing a real OpenAI Codex `id_token`, store and project that directly instead of using the access JWT carrier.
