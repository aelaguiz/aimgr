---
title: "AIMGR - Pi and Prime Credential Broker Integration - Architecture Plan"
date: 2026-08-06
status: implementing
fallback_policy: forbidden
owners: [Amir]
reviewers: [aimgr-architecture, pi-harness-architecture, prime-agent-architecture, integration-security-review, claude-fable-5-high]
doc_type: architectural_change
related:
  - ../README.md
  - REDIS_SHARED_CREDENTIAL_STORE_SIMPLIFIED_PLAN_2026-05-30.md
  - aelaguiz/v2-proposal.md
  - ../../pi-mono/packages/coding-agent/docs/providers.md
  - ../../prime-agent/packages/coding-agent/docs/providers.md
---

# TL;DR

- **Outcome:** Pi and Prime Agent can use AIM-managed `openai-codex` and `anthropic` subscription accounts while AIM/Redis remains the only refresh-token authority. An account is pinned by exact AIM label to a root session tree, may differ between concurrent trees, survives resume, and is never encoded into a model/provider ID.
- **Problem:** AIM's current Pi integration copies one Codex OAuth bundle into a global `auth.json`; it has no Anthropic or Prime target, races the harness's own refresh writer, cannot safely serve concurrent account selections, and can lose refresh-token rotations back to Redis.
- **Approach:** add a small provider-neutral `external` credential type to the Pi auth seam and port it to Prime. It invokes an exact trusted helper executable with `shell: false` and a bounded versioned JSON protocol. AIM implements that helper, returns only a fresh access token plus non-secret binding metadata, and alone refreshes/CAS-publishes OAuth credentials. Session files persist only source/provider/label/identity fingerprint.
- **Plan:** prove the contract with a fake helper in Pi; add the AIM helper and cut Pi over for both providers; port the seam to Prime's per-runtime daemon lifecycle; then finish owner-aware migration, rollback, redacted UX, and real-account canaries.
- **Non-negotiables:** no refresh tokens in Pi/Prime, no secrets in argv/env/session/logs, no shell `!command` integration, no direct Redis client in either harness, no shared-file account switching under live sessions, no silent fallback to native auth for a managed provider, and no loss of Prime-specific auth/team/stale-source behavior.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: completed 2026-08-06 (parallel AIM, Pi, Prime, and cross-repo security inspection)
external_research_grounding: completed 2026-08-06 (RFC 9700, OWASP secrets guidance, Node child_process contract)
deep_dive_pass_2: completed 2026-08-06 (parent synthesis and call-site verification)
recommended_flow: review gate -> approve/freeze scope -> implement in phase order
note: This block tracks stage order only. It never overrides readiness blockers or required user approval.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this plan is implemented, two concurrent Pi or Prime root session trees can be bound to different AIM labels for either `openai-codex` or `anthropic`; each tree continues using its pinned identity across turns, subagents, attach, and resume; normal token expiry refreshes through one AIM Redis lease/CAS owner; and inspection of harness auth files, session JSONL, daemon messages, logs, process argv, and inherited environment finds no AIM-managed access or refresh token. Removing the AIM integration restores an explicitly displaced non-AIM provider entry (or simply removes an AIM-owned legacy projection) without overwriting unrelated auth changes.

## 0.2 In scope

- Both built-in subscription providers in both harnesses:
  - `openai-codex` / `openai-codex-responses`.
  - `anthropic` / `anthropic-messages` using the existing `sk-ant-oat` behavior.
- A generic external credential-source contract in `pi-mono`, then a deliberate port to `prime-agent`.
- Exact-label, per-root-session-tree binding and safe persistence of non-secret binding metadata.
- AIM helper-side freshness, Codex refresh, Claude official-client maintenance, Redis lease/CAS publication, and typed errors.
- AIM Pi and Prime target selection, status, install/cutover, owner-aware uninstall, and rollback backups.
- Native `/login`, `/logout`, `--api-key`, env, fallback, model listing, and UI behavior when a provider is AIM-managed.
- Prime daemon/client/worker/catalog/subagent propagation while preserving Prime Inference and team credentials.
- Unit, integration, concurrency, migration, redaction, and opt-in real-account proof.

**Compatibility posture:** preserve all existing native auth behavior for providers without an `external` entry. For an AIM-managed provider, perform a clean, exclusive cutover: external resolution wins and failure is closed; native stored/env/fallback credentials do not run in parallel. The current secret-copying Pi projection is deleted at cutover rather than retained as a runtime bridge.

## 0.3 Out of scope

- Treating AIM as a security boundary against malicious model-generated code running as the same OS user. Pi/Prime and the helper share the user's authority; hostile-prompt containment requires a separate user/sandbox/network policy.
- Encrypting existing Redis credential payloads, redesigning Redis topology/ACLs/backups, or replacing Redis.
- An AIM daemon, Unix-socket broker, HTTP service, shared library package, or direct Redis access from Pi/Prime. A socket may be reconsidered only after measured helper latency warrants it.
- Provider/model aliases per account, automatic mid-turn account failover, quota-based model switching, billing policy, or provider transport rewrites.
- Synchronizing full Pi/Prime/Claude homes, settings, sessions, extensions, project trust, or hooks.
- Managing API-key providers, MCP credentials, Prime Inference credentials, or non-Codex OpenAI providers.
- Changing Anthropic/OpenAI OAuth login protocols or fabricating tokens outside existing AIM/provider flows.

## 0.4 Definition of done (acceptance evidence)

1. Fake-helper tests in both harnesses prove exact executable invocation, bounded protocol parsing, cache-until-expiry-skew, same-label invalidation/reacquire, typed failures, exclusivity, and absence of secrets in errors/status/session serialization.
2. AIM tests prove fresh reads are lock-free, due refresh is serialized by provider+label, refresh-token rotation is CAS-published exactly once, stale writers cannot win, and the helper never returns a refresh token or native Claude bundle.
3. Pi integration tests prove both built-in providers complete a faux request through the external source, account identity remains pinned on resume, and native auth is unchanged for all other providers.
4. Prime integration tests prove create/attach/resume/daemon restart and parent/subagent inheritance, plus two concurrent root workers on different labels, without changing Prime Inference/team precedence or auth-stale behavior.
5. Migration tests prove recognized legacy AIM Pi projections cut over automatically, unknown native entries require explicit replacement, uninstall restores only the displaced provider entries under a compare-and-swap guard, and unrelated providers survive.
6. An opt-in local canary performs one real Codex turn and one real Anthropic turn in each harness, exercises at least one near-expiry/refresh path in a disposable test label, and confirms Redis version/identity lineage and redacted logs.
7. Live docs/help describe the exact commands, next-session semantics, outage behavior, rollback, and same-UID threat boundary.

### Scope and Simplicity Contract
- **Human-authorized outcome:** use AIMGR to manage Codex and Claude accounts/credentials for both Pi and Prime Agent.
- **Authorization anchors:** the 2026-08-06 user request and the four read-only parallel repository investigations summarized in this document.
- **Smallest sufficient solution:** one provider-neutral external auth type at the existing `AuthStorage`/`ModelRegistry` seam plus one typed AIM CLI helper; reuse all current provider transports, models, Redis records, leases, CAS, and session machinery.
- **Initial minimal convergence closure:** replace AIM's secret-copying Pi owner path; add the missing Prime target; make managed `/login`/`logout` and native fallback unable to create split authority; port only the auth-source/stale behavior Prime needs without merging unrelated fork changes.
- **Scope freeze:** freeze this destination and change map when Amir approves this draft, before any implementation edit or worker dispatch.
- **Enough proof:** existing repo test suites plus focused helper/concurrency/migration tests and four opt-in provider canaries; no new test framework.
- **Do not build:** a broker daemon, whole-home isolation, synthetic providers/models, a Redis SDK dependency in either harness, a shell wrapper, or adversarial same-UID containment.
- **Residual risk accepted by this plan:** a process running as the same user can invoke AIM and obtain an allowed access token; Redis remains the existing plaintext-at-application-layer authority; cached unexpired access may continue during a short coordination outage.

## 0.5 Key invariants (fix immediately if violated)

- Redis/AIM is the only owner of managed refresh tokens and refresh publication.
- Pi/Prime receive access tokens only in process memory and never persist them.
- A managed provider has one exclusive source; failure never falls through to native auth, env, models config, another label, or another provider.
- Canonical provider and model IDs never contain account identity.
- Binding occurs to an exact label and identity fingerprint before the first provider request and never changes inside that root session tree; changing accounts requires a new root tree.
- Resume with a changed identity behind the same label fails `identity_conflict`; it never silently becomes a different account.
- 401/403 invalidates the exact credential version, reacquires the same label once, and retries at most once only if the access-token value fingerprint changed; record version alone is never sufficient.
- Provider quota/rate-limit errors do not trigger credential failover.
- Helper execution is direct (`shell: false`), bounded, owner-trusted, and protocol-versioned.
- Secrets are absent from argv, env, target descriptors, session JSONL, daemon messages/summaries, logs, receipts, and error strings.
- Prime's existing Prime CLI/team auth, private-model authorization, source fingerprints, and stale-source behavior remain intact.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Preserve refresh-token lineage and eliminate dual writers.
2. Keep account selection stable and isolated across concurrent/resumed session trees.
3. Avoid accidental secret persistence or disclosure.
4. Reuse native model/provider/session architecture instead of wrapping Codex or Claude CLIs.
5. Preserve non-managed providers and Prime fork behavior.
6. Make failures actionable and rollback deterministic.
7. Keep request latency bounded without introducing a daemon prematurely.

## 1.2 Constraints

- AIM is a Node 20+ operator CLI with no package `exports`, RPC server, or stable internal-library API. The installed executable is the integration boundary.
- AIM's Redis records and leases are asynchronous; Pi's current file backend and status probes include synchronous paths.
- Pi creates one `AuthStorage` per CLI process; Prime creates services per runtime/worker session tree while a detached supervisor and UI/catalog processes may outlive or differ from it.
- Pi/Prime auth currently stores one credential per provider; provider transports already understand access tokens and must not be duplicated.
- Existing `auth.json` `!command` values are shell-based and cached for a process; dynamic provider commands are uncached but still shell-based, lack a typed binding/expiry protocol, and are shadowed by stored auth.
- Anthropic refresh must remain in AIM's official-Claude maintenance path; Pi/Prime must not receive the native bundle or invent direct refresh semantics.
- Helper resolution can block on Redis/refresh. The harness client always has one 45-second outer process deadline because the response is atomic. Inside AIM, an ordinary Redis read/validation path has a 5-second deadline; if it discovers due credentials, the provider maintenance branch may use the remaining internal budget up to 40 seconds total. Fresh cached access is the normal no-process path.

## 1.3 Architectural principles (rules we will enforce)

- **Authority follows mutation:** AIM owns selection freshness and refresh; harnesses consume access only.
- **One narrow seam:** `AuthStorage` delegates managed provider resolution to `ExternalCredentialClient`; `ModelRegistry` and existing streams keep canonical provider behavior.
- **Async at the boundary, sync status:** `hasAuth()`/status inspect the non-secret descriptor without invoking AIM; actual resolution is async immediately before request/model authorization.
- **Exact binding, not mutable defaults:** target configuration chooses an exact label; session metadata records it; rerunning `aim ... use` affects new trees only.
- **Capability before machinery:** use the current in-process Anthropic/Codex transports and current Redis lease/CAS logic; deterministic helper code only bridges the missing credential boundary.
- **Fail loud and typed:** protocol, provider, identity, freshness, lease, Redis, and reauth failures are distinct and secret-free.
- **Owner-aware writes:** target install/uninstall changes only entries it can prove it owns; explicit native replacement gets one private per-provider backup and uninstall requires exact equality with AIM's last installed descriptor.

## 1.4 Known tradeoffs (explicit)

- A helper subprocess costs more than an in-process Redis client. In-memory caching to `expiresAt - skew` removes it from most requests while preserving authority. A daemon is explicitly deferred; the real canaries may time uncached resolution once, and any later daemon requires separate evidence and approval.
- Access tokens cross a local stdout pipe. This prevents persistent duplication and refresh-token exposure but not same-UID access; that is the accepted threat boundary.
- Pinned sessions do not automatically hop accounts on quota exhaustion. This protects identity/cache continuity and makes usage attribution understandable; the operator selects a new account for a new/rebound tree.
- Session JSONL contains non-secret AIM labels and fingerprints. That is necessary for deterministic resume and is disclosed in docs.
- A cached unexpired token may continue through a short Redis outage. New bindings and refresh-due requests fail closed.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

- AIM stores provider+label credential records in Redis and uses versioned WATCH/MULTI CAS plus provider+label leases. Local target files are projections.
- `src/targets/pi-cli.js` maps a Redis Codex record to a literal Pi OAuth entry and `aim pi use` usage-selects one account, writes `~/.pi/agent/auth.json`, and preserves unrelated provider keys.
- There is no Anthropic Pi projection and no Prime target.
- Pi and Prime both resolve `--api-key` -> stored auth/OAuth -> environment -> fallback and auto-refresh expired stored OAuth under a local file lock. Prime adds Prime CLI/team precedence and stale auth-source tokens.
- Both harnesses perform provider HTTP calls in-process. Anthropic recognizes `sk-ant-oat`; Codex extracts its account ID from the access JWT.
- Prime's daemon creates `AuthStorage`/`ModelRegistry` per runtime in `main.ts::prepareRuntimeServices`; subagents live under a root worker. Pi creates one process-wide storage in `main.ts` and supports SDK injection.

## 2.2 What’s broken / missing (concrete)

- AIM and Pi can write the same OAuth entry without sharing a lock or revision. Pi may rotate refresh credentials locally; AIM may later overwrite them from an older Redis record.
- A global file switch represents one account per provider and cannot describe session affinity. Rewriting it affects future storage loads and can cross-talk with long-lived workers or refresh logic.
- Copying refresh/native credentials into harness storage duplicates secrets and makes rollback/ownership ambiguous.
- Prime's default path is `PRIME_AGENT_CODING_AGENT_DIR` or `~/.prime/agent`, not Pi's path; relocating an entire agent dir would also relocate settings, sessions, extensions, harness state, and daemon-related behavior.
- Native `/login`, env values, provider config commands, and managed projections can silently shadow each other.
- The current command-backed secret mechanism has no exact account binding, expiry/version metadata, safe argv protocol, or reliable actionable errors.
- No persisted non-secret account binding exists for resume, fork, attach, or Prime subagents.

## 2.3 Constraints implied by the problem

A correct solution must cross repository boundaries without importing AIM internals, preserve the harnesses' built-in provider logic, keep refresh-token mutation centralized, make binding a session concept rather than a model identity, and explicitly close native auth side doors only for managed providers.

# 3) Research Grounding (external + internal “ground truth”)

## 3.1 External anchors (papers, systems, prior art)

- [RFC 9700, OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html), §4.14: refresh tokens require confidentiality and rotation/replay-aware handling. **Adopt:** keep refresh tokens in one authority and serialize/publish rotation. **Reject:** independently refreshing copied refresh tokens in each harness.
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html): centralize secret management, automate rotation, minimize exposure, and audit access without logging secret values. **Adopt:** access-only helper responses, redacted receipts, private rollback artifacts.
- [Node.js `child_process`](https://nodejs.org/api/child_process.html): `spawn()` with an executable/argv array avoids shell parsing. **Adopt:** exact executable plus argv and JSON stdin/stdout. **Reject:** `exec`, interpolated shell commands, or tokens in argv/env.

These anchors guide the boundary; they do not make the helper a sandbox or replace provider-specific OAuth rules.

## 3.2 Internal ground truth (code as spec)

Repository baselines inspected on 2026-08-06:

| Repository | Branch / commit | Pre-existing worktree state |
|---|---|---|
| `aimgr` | `main` / `00d60ce` | untracked `.antigravitycli/`, `.tmp/` |
| `pi-mono` | `main` / `c8edb256` | untracked `.arch_skill/`, `packages/coding-agent/docs/model-routing-plan.md` |
| `prime-agent` | `main` / `c98941a2` | clean |

No clone was needed because all three repositories were present. These untracked paths are outside this plan and must not be overwritten.

Authoritative anchors:

- AIM authority and mutation: `src/coordination/redis-store.js`, `records.js`, `redis-credential-lease.js`, `runtime.js`.
- AIM provider normalization/maintenance: `src/credentials/codex-login.js`, `claude-bundle.js`, `claude-native.js`, `claude-maintenance.js`; `src/cli/commands/auth.js`.
- Current Pi projection/target state: `src/targets/pi-cli.js`, `src/cli/commands/pi.js`, `src/io/paths.js`, `src/state/accounts.js`, `src/state/schema.js`.
- Pi seam: `packages/coding-agent/src/core/auth-storage.ts`, `model-registry.ts`, `agent-session-services.ts`, `sdk.ts`, `session-manager.ts`, `modes/interactive/interactive-mode.ts`, `core/resolve-config-value.ts`.
- Pi provider behavior: `packages/ai/src/providers/anthropic.ts`, `openai-codex-responses.ts`; OAuth utilities under `packages/ai/src/utils/oauth/`.
- Prime fork seam/lifecycle: corresponding core files plus `packages/coding-agent/src/main.ts::prepareRuntimeServices`, `core/agent-session-config.ts`, `core/agent-session-runtime.ts`, daemon supervisor/worker/catalog files, and recursion tests.
- Prime-only preservation: `auth-storage.ts` Prime CLI/team branches, `prime-inference-auth.ts`, `prime-inference-models.ts`, model-registry source fingerprints/stale handling/private authorization.

Canonical owner path: the harness `AuthStorage` owns source selection and delegates only the external access resolution; AIM owns label/identity validation, refresh, leases, CAS, and target configuration. `ModelRegistry.getApiKeyAndHeaders()` remains the last request-auth seam before existing provider streams.

## 3.3 Decision gaps that must be resolved before implementation

None. This plan fixes the threat model to accidental leakage/races under one trusted OS user, exact-label root-tree affinity, both providers in both harnesses, a generic upstreamable Pi seam, cached-token outage behavior, no automatic account failover, and no Redis encryption/daemon expansion. Implementation still requires explicit approval to freeze Section 0.

# 4) Current Architecture (as-is)

## 4.1 On-disk structure

```text
~/.aimgr/
  config.yaml                 # Redis connection configuration
  local-state.json            # non-secret target/session adjuncts
  redis-cache.json            # redacted diagnostic cache
  claude-homes/<label>/...    # native Claude projections

~/.pi/agent/
  auth.json                   # one stored credential per provider
  models.json, settings.json, sessions/...

~/.prime/agent/
  auth.json                   # plus Prime CLI/team interactions
  models.json, settings.json, sessions/..., logs/..., harness/...
```

AIM currently writes literal Codex OAuth material into Pi's `auth.json`. It does not know Prime's auth path.

## 4.2 Control paths (runtime)

```text
aim pi use
  -> load Redis view -> usage-rank Codex labels
  -> build {type:oauth, access, refresh, expires, accountId}
  -> rewrite Pi auth.json -> exit

Pi/Prime request
  -> AuthStorage.getApiKey(provider)
  -> stored OAuth refresh under local proper-lockfile if expired
  -> ModelRegistry.getApiKeyAndHeaders()
  -> existing Anthropic/Codex provider stream
```

Prime creates that stack for each runtime worker; the supervisor/catalog/UI are separate lifecycles. Pi creates it once per CLI process or SDK session services.

## 4.3 Object model + key abstractions

- AIM: provider+label Redis record with identity, credential, policy, provenance, version; credential lease with opaque owner; local target receipt with active label/account.
- Harness: `AuthCredential = ApiKeyCredential | OAuthCredential`; `AuthStorageBackend`; `AuthStorage`; `ModelRegistry`; `AgentSession`/`SessionManager`.
- Prime additionally tracks `AuthSourceToken`, stale sources, Prime team credential metadata, and private model authorization.

## 4.4 Observability + failure behavior today

- AIM sanitizes status receipts and has typed maintenance outcomes, but its machine JSON is not a versioned access-token protocol.
- Pi often turns failed command resolution into missing auth; command stderr is suppressed. Stored OAuth refresh errors are drained for UI.
- Prime has richer stale/auth diagnostics and structured provider failure handling, but none is account-label aware.
- File replacement does not notify already-loaded auth storage; the effect depends on runtime creation/reload.

## 4.5 UI surfaces (ASCII mockups, if UI work)

Today `/login` shows the native provider regardless of AIM ownership, and AIM status reports only its current Pi Codex projection. There is no managed-source label in either harness UI.

# 5) Target Architecture (to-be)

## 5.1 On-disk structure (future)

```text
~/.aimgr/
  backups/harness-auth/<target>-<provider>.json    # 0700 parent / 0600 file; one displaced native entry
  local-state.json                                 # target receipt, installed descriptor, labels, no token

<pi-agent-dir>/auth.json or <prime-agent-dir>/auth.json
  {
    "openai-codex": {
      "type": "external",
      "source": "aimgr",
      "protocol": "aimgr-credential-v1",
      "executable": "/absolute/owner-trusted/path/to/aim",
      "args": ["credential-helper"],
      "binding": "pro3",
      "expectedIdentityFingerprint": "..."
    },
    "anthropic": { ... "binding": "fable" ... },
    "other-provider": { ...unchanged... }
  }

<session>.jsonl
  {"type":"credential_binding","provider":"openai-codex","source":"aimgr",
   "binding":"pro3","identityFingerprint":"...","timestamp":"..."}
```

`external` entries and session records are non-secret. Access-token cache is memory-only inside the root session tree. The external descriptor is generic at the harness layer; `aimgr-credential-v1` is AIM's concrete helper protocol.

## 5.2 Control paths (future)

### New binding and first request

```text
aim pi|prime use [provider selections]
  -> select/validate exact Redis labels
  -> preserve one displaced native entry per target/provider when replacement is explicit
  -> atomically write external descriptors, mode 0600
  -> record the last installed non-secret descriptor + selection receipt

new root runtime
  -> AuthStorage loads external descriptor
  -> SessionManager loads prior credential_binding or uses descriptor binding
  -> first managed request calls ExternalCredentialClient.resolve()
     -> spawn exact aim executable, shell:false
     -> versioned JSON request on stdin
     -> AIM validates provider/label/identity
     -> if fresh: return access only
     -> if due: existing per-label lease -> provider maintenance -> Redis CAS publish -> return access
  -> harness validates response, caches only until expiresAt-skew
  -> persist non-secret exact binding once
  -> existing model/provider stream receives apiKey as today
```

### Refresh and auth rejection

```text
cache reaches expiresAt-skew
  -> resolve same exact binding again

provider returns 401/403
  -> mark the exact external source value fingerprint stale
  -> ExternalCredentialClient evicts it and resolves the same binding with its remembered rejectedCredentialVersion
  -> AIM returns newer material or performs one allowed maintenance action
  -> retry once only when the access-token value fingerprint changed (a newer record version may accompany it but never suffices)
  -> otherwise surface typed reauth/identity/coordination failure
```

### Selection semantics

- Bare `aim pi use` preserves its current meaning: select the next-best Codex label now, write an exact external binding, and leave Anthropic unchanged unless requested.
- `use` is the only online mutation and requires Redis. `status` always reports local descriptor/backup ownership and adds online record readiness when Redis is available. `uninstall` is deliberately local-only: it must restore a guarded backup during Redis outage and therefore dispatches before any Redis runtime is loaded.
- New explicit options: `aim pi use --codex <auto|label|off> --claude <fable|opus|label|off>` and the same `aim prime use ...`. Codex `auto` and Claude `fable`/`opus` are resolved with their existing usage-ranking owners to an exact label before writing; an omitted provider remains unchanged.
- Rerunning `use` changes the default for new root trees. Loaded trees retain their descriptor/binding; resumed trees prefer their persisted binding **only while the provider still has a compatible external descriptor**. The session entry pins an active external source; it does not reactivate one after guarded uninstall. In Pi, `/new` is an idle root-tree boundary: reload the descriptor, clear the old tree's access cache, and bind the new session to the current default. Ordinary `/reload`, model changes, and prompt turns are not boundaries.
- Prime subagents inherit the root tree's binding map through runtime options and persist the same non-secret binding. They do not reread a newly changed global default.
- `/reload`, model refresh, UI attach, and Prime's `AuthStorage.reload()` may refresh descriptor mechanics but must not replace a loaded/persisted exact binding. A changed source/protocol or incompatible expected identity fails `identity_conflict`; the operator must start a new root tree after updating the AIM target.

### Helper protocol

Request (stdin, one JSON object, maximum 8 KiB):

```json
{
  "schemaVersion": 1,
  "operation": "resolve",
  "provider": "openai-codex",
  "binding": "pro3",
  "expectedIdentityFingerprint": "opaque-stable-value",
  "rejectedCredentialVersion": 41
}
```

Success (stdout, exactly one JSON object, maximum 64 KiB):

```json
{
  "schemaVersion": 1,
  "ok": true,
  "provider": "openai-codex",
  "binding": "pro3",
  "identityFingerprint": "opaque-stable-value",
  "credentialVersion": 42,
  "accessToken": "<secret>",
  "expiresAt": 1786000000000
}
```

Failure uses `ok:false`, one fixed code, a bounded secret-free message/action, and nonzero exit. Codes: `helper_unavailable`, `helper_untrusted`, `helper_timeout`, `protocol_mismatch`, `unknown_label`, `provider_mismatch`, `credential_incomplete`, `credential_expired`, `reauth_required`, `lease_busy`, `coordination_unavailable`, `identity_conflict`, `no_eligible_account`. No record, refresh token, native bundle, email, account ID, provider response body, or stack trace crosses the protocol. `identityFingerprint` is an opaque, stable value owned and computed only by AIM from provider-stable account identity. Harnesses persist and compare it byte-for-byte but never compute or parse it. AIM keeps the provider-specific derivation private and version-stable across upgrades (or migrates installed/session expectations explicitly); raw identity fields never leave AIM. A record without stable identity is `credential_incomplete`, never a label-only fallback.

Core client rules:

- absolute executable; verify current-UID ownership and reject group/world-writable executable or parent path at install/preflight;
- `spawn(executable, args, {shell:false, stdio:[pipe,pipe,pipe]})` with an allowlist of `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, and locale; the helper reads `~/.aimgr/config.yaml` rather than receiving Redis/provider credentials in env, and the resolved token is never added to env;
- cap stdin/stdout/stderr sizes, parse bounded stdout as exactly one JSON object, apply one 45-second outer client deadline, and let AIM independently enforce its 5-second ordinary and 40-second total maintenance budgets;
- never include stdout/stderr/request payload in logs; map exit/protocol state to fixed errors;
- on the 45-second outer timeout, close pipes, send `SIGTERM`, wait a bounded grace, then `SIGKILL`; the AIM helper must propagate abort/termination into any Claude/Codex maintenance child so no refresh subprocess is orphaned;
- deduplicate concurrent resolves for the same provider/binding/version inside one runtime;
- AIM treats access inside the fixed five-minute freshness floor as due; the harness caches success in memory until `min(expiresAt - 5 minutes, now + configured maximum)` and never caches failures.

## 5.3 Object model + abstractions (future)

Harness types (names may follow local style, semantics are binding):

```ts
type ExternalCredentialDescriptor = {
  type: "external";
  source: string;
  protocol: string;
  executable: string;
  args: string[];
  binding: string;
  expectedIdentityFingerprint: string;
};

type CredentialBinding = {
  provider: string;
  source: string;
  binding: string;
  identityFingerprint: string;
};

type ResolvedExternalAccess = CredentialBinding & {
  accessToken: string;
  expiresAt: number;
  credentialVersion: number;
};

type AuthSourceToken = {
  provider: string;
  source: "external" | existing sources;
  identityFingerprint: string;
  valueFingerprint: string; // one-way; Prime already carries this shape ephemerally, never persisted/logged
};
```

- `ExternalCredentialClient`: protocol process, validation, coalescing, cache, invalidation. It has no provider refresh logic.
- `AuthStorage`: owns precedence. `external` is exclusive for that provider; otherwise current precedence remains byte-for-byte in behavior.
- `ModelRegistry`: returns request auth plus an `AuthSourceToken` (despite the name, only one-way source/value fingerprints, never a bearer token) and can invalidate the exact source after structured auth failure. This reuses Prime's existing non-bearer shape; Pi adds only the equivalent narrow metadata. The external client retains `credentialVersion` privately with its cache entry so invalidation can send `rejectedCredentialVersion`. Prime may carry its existing source token in the ephemeral `auth_stale` daemon event, but it is not persisted or logged.
- `SessionManager`: appends/loads `credential_binding` entries outside LLM context.
- AIM `resolveHarnessAccessCredential`: validates records and calls existing Codex/Claude maintenance owners; it does not duplicate Redis or provider mutation logic.
- AIM shared harness target builder: path adapter + provider entry merge, one-time displaced-native backup, last-installed-descriptor receipt, and guarded restore; Pi and Prime adapters supply only agent-dir env/default and target-state namespace.

## 5.4 Invariants and boundaries

- AIM helper is a machine API; it refuses TTY or missing-stdin invocation, its schema version and error codes are tested and documented, and internal AIM modules remain private.
- AIM target read/merge/write/restore operations acquire the same `proper-lockfile` lock on `auth.json` that Pi/Prime `FileAuthStorageBackend` uses, with bounded retry and no stale-lock stealing outside the library contract; this prevents losing an unrelated concurrent `/login` write.
- The helper returns access material only after exact provider, label, identity, completeness, version, and freshness checks.
- Refresh due paths use the current AIM per-label lease and CAS publication; concurrent callers observe the winning version or a typed busy outcome.
- Claude refresh uses the official-client maintenance owner and respects active rotation fences. It never calls the Pi/Prime Anthropic OAuth refresher.
- A valid cached access token may be used until skew during Redis outage. Once refresh is due, no stale/native fallback exists.
- Model enumeration/status never invokes the helper or prints secret material. Prime's authorized Codex model discovery may resolve managed access in the worker only and fingerprints it in memory as today.
- `AuthStorage.set`, `remove`, `logout`, and runtime override assignment reject replacement of an active/current external entry at the owner boundary; `/login` and `/logout` catch that typed conflict and show an AIM action. Trusted extensions/SDK callers cannot bypass exclusivity through the public mutation methods. Unmanaged provider behavior is unchanged.
- `--api-key` combined with an external entry for the selected provider is a startup error. Provider env and `models.json` keys remain ignored only for that managed provider.
- Account labels never alter provider models, API transport headers, pricing, model selection, session cache IDs, or provider names.

## 5.5 UI surfaces (ASCII mockups, if UI work)

Harness auth selector/status:

```text
Anthropic        managed by AIM · fable · ready
OpenAI Codex     managed by AIM · pro3  · ready
Prime Inference  Prime CLI · team fc                 # Prime only, unchanged

/login Anthropic
  Anthropic is managed by AIM for this session (fable).
  Change the default for new sessions: aim prime use --claude <label|fable|opus>
  Return to native login: aim prime uninstall --provider anthropic
```

AIM status/receipt:

```text
Prime Agent
  OpenAI Codex  pro3   external helper installed   new sessions
  Anthropic     fable  external helper installed   new sessions
  auth path     ~/.prime/agent/auth.json
  secrets copied to target: no
```

# 6) Call-Site Audit (exhaustive change inventory)

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
|---|---|---|---|---|---|---|---|
| Pi auth union/backend | `pi-mono/packages/coding-agent/src/core/auth-storage.ts` | `AuthCredential`, `getApiKey`, status/login/logout | API key/OAuth only; stored OAuth refreshes locally | Add external descriptor/client, exclusive precedence, source token, managed login/logout guard | Canonical consumption seam | `ExternalCredentialDescriptor`, external auth status | `auth-storage.test.ts`, auth flows |
| Pi process client | new `.../core/external-credential-client.ts` | new | none | Direct spawn, protocol validation, cache/coalescing/invalidate/redaction | Avoid shell/Redis coupling | `resolve`, `invalidate`, typed errors | new focused test file |
| Pi request auth | `.../core/model-registry.ts` | `getApiKeyAndHeaders`, auth status | returns key/headers; no external source identity | Carry `AuthSourceToken`, invalidate exact source, preserve provider overrides | 401 reacquire and honest UI | `ResolvedRequestAuth.sourceToken` | `model-registry.test.ts` |
| Pi structured auth failure | `pi-mono/packages/ai/src/providers/{anthropic,openai-codex-responses}.ts` and narrow shared util; `coding-agent/src/core/agent-session.ts` | provider error -> retry | auth failure not an external-source event | Surface 401/403 category; one same-source re-resolve/retry before generic retry | Recover rotation/revocation without label hop | structured auth failure kind | provider + retry tests |
| Pi session persistence | `.../core/session-manager.ts`, session types/docs | JSONL entry union/build context | provider/model only | Append/load non-context binding entries; preserve on fork/resume | Sticky identity | `credential_binding` entry | session tests |
| Pi service/SDK wiring | `.../core/agent-session-services.ts`, `sdk.ts`, `main.ts`, `agent-session.ts`, `agent-session-runtime.ts` session-switch paths | `main.ts` shares one `AuthStorage` across sequential runtimes and already calls a runtime factory at each switch | Keep the shared storage, but at new/switch runtime creation reload its backend, clear only external runtime cache/binding state, then seed/persist the selected session binding; reload/model changes inside one runtime retain it | Same new-tree contract with no factory ownership refactor | credential context + reset hook | service/SDK/session-switch tests |
| Pi UI | `.../modes/interactive/interactive-mode.ts` login/logout handlers and `components/login-dialog.ts` / OAuth selector components | native login/logout always offered | Render external source/label; block mutation with action | Close side door | `AuthStatus.source="external"` | auth-flow/UI tests |
| Pi docs | `docs/providers.md`, `docs/sdk.md`, `docs/session-format.md`, README/help as applicable | auth docs | native only | Explain external type contract, safe SDK injection, session metadata | Live truth | docs | none beyond build/link checks |
| Prime port | matching core files | same seams | fork has richer auth source tokens/stale logic | Port external branch without replacing Prime logic | Maintain fork parity | same descriptor/protocol | corresponding tests |
| Prime runtime config | `prime-agent/.../core/agent-session-config.ts`, `agent-session-runtime.ts`, `main.ts` | `prepareRuntimeServices`, runtime create/merge | per-runtime storage; no binding map | Load persisted bindings and propagate root map to subagents | Daemon/tree affinity | serializable non-secret binding map | daemon/recursion tests |
| Prime external auth retry | `.../core/agent-session.ts`; existing structured stream-failure path | native auth is marked stale only after generic retry exhaustion | For external auth-classified 401/403, invalidate/reacquire the exact source before generic retry, retry once only on a changed access-token value fingerprint, then emit terminal stale for external auth while preserving non-external behavior | Meet refresh/rejection contract without account hop | external auth retry branch | new `external-credential-retry.test.ts` + provider failure tests |
| Prime stale event IPC | `.../core/agent-session.ts`, `modes/agent-connection/types.ts`, `modes/interactive/interactive-mode.ts`, `cli/daemon-command.ts` | existing `auth_stale` carries one-way `AuthSourceToken[]` to client UI | Reuse the compatible non-bearer shape unchanged and prove external fingerprints never enter logs/session/daemon summaries | Avoid a new IPC contract while closing serialization ambiguity | no wire-shape change | existing forwarding + focused redaction test |
| Prime daemon/UI | daemon worker/client/catalog and interactive auth files | create/attach/resume/catalog | multiple lifecycles | Resolve only in worker; serialize no token; UI status from descriptor/binding | Prevent client/catalog secret path | secret-free summaries | daemon protocol tests |
| Prime-only auth | `auth-storage.ts`, `prime-inference-auth.ts`, `model-registry.ts` | Prime CLI/team/private models/stale sources | fork-specific precedence | Leave unchanged outside external branch; add regression proof | No fork regression | none | auth/private model tests |
| AIM helper command | new `aimgr/src/cli/commands/credential-helper.js` | none | Add versioned stdin/stdout machine command, no TTY prompting | Stable integration boundary | `aimgr-credential-v1` | new CLI tests |
| AIM CLI routing/options | `src/cli/args.js`, `src/cli/main.js`, `src/cli/help.js` | top-level dispatch and option parsing | Pi rejects labels; Prime/helper/status/uninstall absent | Parse/validate helper, `pi`/`prime` use/status/uninstall, `--codex`, `--claude`, `--provider`, and explicit replacement options; update help | Executable command surface | fixed CLI grammar/receipts | argument/help/removed-command tests |
| AIM resolution owner | new `src/credentials/harness-access.js` plus extraction from `cli/commands/auth.js` as needed | due/fresh resolution | maintenance lives in command paths | Reuse one provider-specific freshness owner for helper and maintenance | No duplicate refresh truth | `resolveHarnessAccessCredential` | credential/coordination tests |
| AIM Codex path | `src/credentials/codex-login.js`, maintenance owner | refresh exists | panel/maintain oriented | Exact-label due refresh under existing lease/CAS, same identity | helper freshness | shared maintainer result | existing + concurrency tests |
| AIM Claude path | `src/credentials/claude-maintenance.js` and Claude bundle/native modules | complete bundle + official maintenance | no access-only consumer; maintenance runner is sync underneath | Validate bundle, run maintenance only when due, thread absolute deadline/AbortSignal, return access view | no native bundle leak | access projection | existing + helper tests |
| AIM abortable Claude runner | `src/targets/claude-runner.js::runClaudeCliNoninteractive` | async wrapper calls `spawnSync`, so helper termination cannot cleanly abort child | Replace maintenance invocation with async bounded spawn/process-group ownership, TERM -> grace -> KILL, bounded output/result parity | Make 45-second outer timeout executable and orphan-free | abortable noninteractive runner | timeout/signal/child-reaping tests |
| AIM shared targets | new `src/targets/harness-auth.js`; `package.json` | new | Pi hand-builds secret document without the harness lock | Add compatible `proper-lockfile`; build external descriptor; locked atomic merge; one displaced-native backup; exact installed-descriptor restore guard | One race-free Pi/Prime owner without hash lineage | target adapter contract | target tests |
| AIM Pi target/selection | `src/targets/pi-cli.js`, `cli/commands/pi.js`, `status/claude-redis-view.js` existing fable/opus selector | Codex secret projection; bare auto only | Cut to external descriptors, add optional exact/Claude flags, reuse Codex ranking and Claude fable/opus selection, preserve bare behavior | Both providers/no copied secrets | new use receipt | existing Pi/Claude cases + migration |
| AIM Prime target | new `src/targets/prime-agent.js`, new/extended CLI command | absent | Resolve `PRIME_AGENT_CODING_AGENT_DIR`/`~/.prime/agent`, same target contract | Prime support | `aim prime use/status` | new target cases |
| AIM paths/state | `src/io/paths.js`, `state/accounts.js`, `state/schema.js` | Pi paths/target only | Add Prime path and a non-secret target receipt containing labels, backup path, and last installed descriptor | correct defaults/rollback | target state schema | path/state migration tests |
| AIM status/docs | status presenters, `README.md`, `cli/help.js` | Pi Codex projection terminology | Show external source/labels/next-session/rollback | Operability | redacted receipt | snapshot/help tests |

## 6.2 Migration notes

- The shared external client and session-entry contract is the Pi canonical implementation. Prime ports that small seam while retaining its package names, diagnostics, daemon wiring, Prime auth branches, and test conventions; do not wholesale-copy `auth-storage.ts` or `model-registry.ts` between forks.
- Recognize a current AIM Pi secret projection only when target state, provider/account ID, and credential fingerprint agree; replace that AIM-owned legacy entry automatically and do not preserve it as a rollback credential. Any unknown `openai-codex` or `anthropic` entry requires `--replace-native-auth` and a private backup.
- For each target/provider, preserve at most one displaced non-AIM entry in `~/.aimgr/backups/harness-auth/<target>-<provider>.json`; the first explicit replacement writes it with mode 0600 and later account switches never overwrite it. AIM local state stores only the backup path and the last installed non-secret descriptor, not hashes or credential copies. Providers uninstall independently.
- Uninstall re-reads the locked file and restores the backup (or removes the descriptor when no native backup exists) only when the current provider entry deep-equals AIM's last installed descriptor. Any edit or ownership conflict fails without writing and reports the backup path. A successful restore consumes the backup. Active Pi processes/Prime workers must stop before uninstall; after restart, the absence of an external descriptor makes old session binding entries historical and native auth resumes.
- Delete the current `buildPiAuthEntry` secret projection and unconditional `clearManagedPiCliActivation` behavior after migration tests pass. Do not retain an alternate legacy projection flag.
- Existing sessions without a binding entry bind the installed exact descriptor on their first managed request. Sessions with a binding resume it even if the global default later changes.
- Update live comments/docs that claim AIM writes Pi OAuth secrets or that Prime has no external auth source. Historical plans remain historical and should not be rewritten as current contracts.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

- Reuse `io/json-store.js` for atomic/private writes and backups; do not hand-roll file IO.
- Extract one AIM harness target merge/restore owner; Pi and Prime path adapters must not duplicate provider-entry or displaced-native backup logic.
- Reuse one AIM provider maintenance owner for `aim auth maintain` and the helper; no second refresh implementation.
- Use the Prime source-token/stale design as evidence for the Pi external branch, but port only the directly required contract rather than broad fork convergence.
- Do not reuse shell config-value commands: they are adjacent functionality with the wrong security, expiry, error, and binding contract.

# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: depth-first implementation protects the frozen destination while proving the path early. The destination map is the human-authorized outcome plus the initial minimal convergence closure recorded before implementation and any later explicit human approval. The expansion map only sequences that frozen breadth; workers and reviewers cannot add callers, variants, modes, guarantees, proof categories, or adjacent cleanup. Section 7 chooses the first working slice through the canonical owner path and highest-risk seam, then advances through already-authorized axes. Phase boundaries are proof gates, and phase count follows real dependency, proof, reversibility, migration, or user-review boundaries. `Work` is explanatory; `Checklist (must all be done)` and `Exit criteria (all required)` hold every required obligation. Refactors and consolidations preserve behavior with proportionate evidence. No fallback or runtime shim exists without explicit approval and removal work.

## Phase 1 - Prove the provider-neutral external auth seam in Pi

**Goal:** with a fake executable only, prove one real Pi request can obtain expiring access through the canonical seam, persist a non-secret binding, resume it, and reacquire once on auth rejection.

**Work:** implement the external descriptor/client, source token, session entry, and the smallest structured 401/403 path needed for one built-in provider; keep existing native auth untouched when no external descriptor exists.

**Checklist (must all be done):**

- [ ] Freeze `aimgr-credential-v1` request/response/error fixtures in this plan and test fixtures; do not create a cross-repo runtime package.
- [ ] Add `ExternalCredentialDescriptor` validation and a direct-spawn async client with bounds, timeout, cache, concurrent-call coalescing, invalidation, and value-free errors.
- [ ] Add exclusive external precedence and `AuthStatus.source="external"`; enforce the conflict in `AuthStorage.set/remove/logout` and runtime override methods, then render the managed `--api-key`/`/login`/`/logout` error in UI.
- [ ] Carry a source token through `ModelRegistry.getApiKeyAndHeaders()` and add the narrow structured provider-auth failure/retry path: same source/binding, one retry, changed material required.
- [ ] Add non-context `credential_binding` append/read behavior and seed it on resume/fork.
- [ ] Keep Pi's process-wide `AuthStorage`, but at the existing `createRuntime` boundary for `/new`/switch call backend reload plus an external-only cache/binding reset before seeding the session binding; keep runtime `--api-key` behavior and ordinary reload/model changes intact. Wire SDK/session callbacks so status/model listing does not invoke the helper but actual requests do.
- [ ] Prove unmanaged API key, OAuth, env, fallback, custom-provider, and SDK behavior is preserved.

**Verification (required proof):** from the Pi repo root run `npm run check`. From `packages/coding-agent`, run `npx tsx ../../node_modules/vitest/dist/cli.js --run test/auth-storage.test.ts test/model-registry.test.ts test/agent-session-retry.test.ts test/sdk-session-manager.test.ts test/agent-session-runtime-events.test.ts test/external-credential-client.test.ts test/external-credential-session.test.ts`. From `packages/ai`, run `npx tsx ../../node_modules/vitest/dist/cli.js --run test/openai-codex-stream.test.ts test/anthropic-oauth.test.ts test/stream.test.ts test/stream-failure.test.ts`. The two external-credential files and Pi `stream-failure.test.ts` are the focused new contract tests; do not run the forbidden `npm test`.

**Docs/comments (propagation; only if needed):** document the generic external descriptor/SPI and session entry in Pi provider/SDK/session-format docs; comment only the exclusive-source and token-cache invariants at their owners.

**Exit criteria (all required):**

- [ ] A fake-helper Anthropic or Codex request completes through the existing provider stream with no secret on disk.
- [ ] Expiry-skew and one changed-access-fingerprint retry are deterministic under fake time; a version-only update does not retry.
- [ ] Resume uses the exact stored binding; identity mismatch fails closed.
- [ ] No native auth test regresses and no token appears in captured logs/errors/session JSONL.

**Rollback:** revert the additive external type/client/session entry and structured retry changes. Native auth files and formats remain readable because unmanaged branches were not migrated.

## Phase 2 - Make AIM the access/refresh authority and cut Pi over for both providers

**Goal:** connect the Phase 1 client to real AIM machinery, replace the secret-copying Pi target, and prove Codex plus Anthropic end to end in Pi.

**Work:** add the helper command and one shared provider freshness owner; refactor existing maintain paths to it where required; build owner-aware external target documents and migration/rollback.

**Checklist (must all be done):**

- [ ] Implement the exact bounded helper command, reject TTY/missing stdin, and validate the schema defensively; success stdout is the only raw access-token output path.
- [ ] Implement exact-label/provider/identity/freshness validation and fixed errors without exposing record/native/provider bodies.
- [ ] Reuse/extract Codex due refresh under the current Redis lease/CAS; validate same identity and publish rotation once.
- [ ] Reuse Claude bundle validation and official-client maintenance; respect rotation fences and never return refresh/native fields.
- [ ] Refactor `runClaudeCliNoninteractive` away from `spawnSync` for the maintenance path: own an async child/process group, accept an absolute deadline plus `AbortSignal`, bound captured output, and perform TERM -> grace -> KILL. Thread that signal through `maintainRedisClaudeCredential` and the helper's SIGTERM handler; prove no child/grandchild remains.
- [ ] Add the one-time displaced-native backup/guarded-restore owner and external descriptor builder using an absolute owner-trusted AIM executable; take the harness-compatible `proper-lockfile` across each read/merge/write or restore transaction.
- [ ] Convert `aim pi use` to exact external bindings, preserve bare Codex auto-selection, add optional explicit Codex/Claude/off flags, and preserve unrelated providers.
- [ ] Add `aim pi status` and `aim pi uninstall [--provider ...]` receipts and managed-entry migration rules; route local-only uninstall before Redis initialization and make status degrade to local ownership when Redis is down. `aim pi use` is the explicit online install/update action; delete secret projection/unconditional clear code after tests.
- [ ] Wire both providers through Pi's existing transports and session binding.

**Verification (required proof):** in the AIM repo run `npm run lint` and `npm test`. Those suites must include helper/credential/coordination/target/CLI cases for 50 concurrent resolves, one due refresh winner, different-label parallelism, CAS conflict, Redis outage, active Claude fence, abort during Claude maintenance with no surviving child/grandchild, identity change, redaction, file permissions, a concurrent unrelated harness `/login` write under the shared lock, exact-descriptor restore refusal after a conflicting edit, and migration. Rerun the Phase 1 named Pi Vitest files for both provider fixtures, then run opt-in real Pi Codex and Anthropic canaries.

**Docs/comments (propagation; only if needed):** update AIM README/help/Pi operations and Pi providers docs; mark old Pi projection documentation historical or update it to current truth.

**Exit criteria (all required):**

- [ ] Pi auth target contains external descriptors and no AIM-managed access/refresh token.
- [ ] Both providers work through built-in transports; AIM record version/lineage is correct after a due refresh.
- [ ] Timeout or SIGTERM during Claude maintenance releases/lets expire the lease safely and leaves no helper, Claude, or descendant process running.
- [ ] Bare `aim pi use` remains operationally familiar and reports new-session semantics.
- [ ] Unknown native entries are never overwritten without explicit replacement and rollback is conflict-safe.
- [ ] No live secret-copying Pi target path remains.

**Rollback:** before provider cutover, revert code only. After opt-in cutover, `aim pi uninstall` restores the displaced native entry or removes AIM's exact descriptor; then revert builds. Re-enabling the old AIM secret projection, if truly required after code rollback, is a separate explicit action and must never overlap external mode.

## Phase 3 - Port the seam to Prime and prove daemon/session-tree isolation

**Goal:** Prime Agent supports the same managed providers while preserving all fork-specific auth and daemon behavior.

**Work:** port the reviewed Pi contract semantically, not file-for-file; wire persisted bindings through root worker creation, attach/resume, daemon restart, and RLM subagent creation; add the Prime AIM target.

**Checklist (must all be done):**

- [ ] Port external descriptor/client/cache/source-token branches into Prime's current `AuthStorage` and `ModelRegistry` without replacing Prime CLI/team/private-model/stale logic.
- [ ] In Prime `core/agent-session.ts`, intercept a structured external-auth 401/403 before generic retry exhaustion, invalidate/reacquire the exact binding, retry once only when the access-token value fingerprint changes, then surface the existing terminal stale event for that external source while leaving non-external retry behavior unchanged; cover changed access and unchanged access (including a newer record version) without adding version to `AuthSourceToken`.
- [ ] Resolve access only in the active worker runtime; client/UI/catalog/supervisor paths inspect descriptors/status only.
- [ ] Preserve Prime's existing `auth_stale` wire shape for compatibility, document `AuthSourceToken` as non-bearer metadata, and prove daemon forwarding/UI handling never persists or logs its external value/identity fingerprints.
- [ ] Add serializable non-secret binding maps to runtime config/merge/clone where needed and inherit the root map into subagents.
- [ ] Load session binding before model request; persist the first binding entry; restore through attach/resume/daemon restart; prove Prime trace/model/auth-flow reload call sites cannot replace a loaded external binding snapshot.
- [ ] Ensure two concurrent root workers can hold different exact labels and a global `aim prime use` update changes neither loaded tree.
- [ ] Add `aim prime use`, `aim prime status`, and local-only `aim prime uninstall [--provider ...]` using `PRIME_AGENT_CODING_AGENT_DIR` or `~/.prime/agent`; reuse the shared target owner and the same Redis-optional status contract.
- [ ] Preserve Codex authorized-model discovery, Anthropic OAuth headers, Prime Inference team selection, private authorization cache, and native auth for unmanaged providers.
- [ ] Block managed login/logout/api-key side doors in Prime UI with secret-free actions.

**Verification (required proof):** from the Prime repo root run `npm run check`. From `packages/coding-agent`, run `npx tsx ../../node_modules/vitest/dist/cli.js --run test/auth-storage.test.ts test/model-registry.test.ts test/auth-flows.test.ts test/agent-session-config.test.ts test/agent-session-services.test.ts test/agent-session-runtime-events.test.ts test/agent-session-recursion.test.ts test/agent-connection-daemon.test.ts test/daemon-protocol.test.ts test/daemon-mode.test.ts test/daemon-client.test.ts test/daemon-catalog-process.test.ts test/prime-inference-auth.test.ts test/external-credential-client.test.ts test/external-credential-session.test.ts test/external-credential-retry.test.ts`. From `packages/ai`, run `npx tsx ../../node_modules/vitest/dist/cli.js --run test/openai-codex-stream.test.ts test/anthropic-oauth.test.ts test/stream-failure.test.ts`. These focused files must cover concurrent roots on two labels, changed/unchanged 401 material, subagent inheritance, daemon restart/forwarding, UI/client no-resolve, and Prime team/private-model regressions; do not run the forbidden `npm test`. Then run opt-in real Prime Codex and Anthropic canaries.

**Docs/comments (propagation; only if needed):** update Prime providers, daemon, sessions, SDK/settings/README auth paths and the managed source UI wording.

**Exit criteria (all required):**

- [ ] Fresh, attach, resume, daemon restart, and parent/subagent flows retain exact non-secret bindings.
- [ ] Two root trees use different labels without file/env/model-ID cross-talk.
- [ ] Only worker runtimes invoke the helper and no daemon/session artifact carries an access or refresh token; existing ephemeral `auth_stale` events may carry only the non-secret `AuthSourceToken` fingerprints.
- [ ] Prime Inference/team/private model behavior and unmanaged auth precedence are unchanged.
- [ ] `aim prime` target rollback is owner-aware and uses the correct agent directory.

**Rollback:** uninstall Prime descriptors with the guarded restore, stop/restart affected workers to discard memory caches, and revert the port/target. Pi integration remains independently usable.

## Phase 4 - Operational hardening, rollout, and final convergence

**Goal:** prove the bounded failure behavior, finish the operator path, and close the cross-repo change map without adding permanent observability machinery.

**Work:** finish redacted status/runbook, validate installed binary/path security and enforced deadlines, run real canaries, and audit the frozen scope.

**Checklist (must all be done):**

- [ ] Add AIM integration preflight for executable ownership/mode, Redis reachability, record completeness/freshness, target conflict, and session effect wording.
- [ ] Document cached-token outage behavior, typed error actions, reauth, selection/new-tree rules, guarded uninstall, and daemon worker restart only when required.
- [ ] Run the focused failure matrix: missing binary, timeout, malformed/oversized stdout, Redis down, lease busy, stale CAS, expired access, revoked refresh, identity mismatch, 401 changed access, 401 unchanged access with newer version, quota error, corrupted auth/backup.
- [ ] Run the four real canaries plus the already-specified concurrent-root cases; sample uncached ordinary and due-maintenance latency during those canaries only. Do not add a permanent telemetry taxonomy or soak harness.
- [ ] Confirm a broker daemon remains unnecessary; adding one requires a new approved plan, not an implementation-time choice.
- [ ] Delete superseded live secret-projection code/comments.
- [ ] Run fresh implementation audit in each repository against every Section 6 row and Section 7 obligation.

**Verification (required proof):** rerun `npm run lint && npm test` in AIM, `npm run check` at each harness root, and every named Phase 1/Phase 3 Vitest file from its package root. Add focused cross-repo fixture compatibility, the four real canaries, manual inspection of target/session/log/process surfaces for secret absence, and a guarded uninstall/reinstall drill. Never use the harness repos' forbidden `npm test`.

**Docs/comments (propagation; only if needed):** final README/help/provider/daemon/session/runbook truth only; no extra point-in-time implementation doc.

**Exit criteria (all required):**

- [ ] Every acceptance item in Section 0.4 has current evidence.
- [ ] All failure classes have one actionable secret-free operator path.
- [ ] Cached requests add no subprocess; AIM enforces the 5-second ordinary and 40-second total maintenance bounds; the harness kills any helper still alive at the single 45-second outer deadline with a typed timeout.
- [ ] No competing managed credential owner, secret projection, or native fallback side door remains.
- [ ] Fresh cross-repo audit is clean and the plan can move to complete only after implementation truth is recorded.

**Rollback:** use per-target guarded uninstall, stop active managed workers to drop access caches, restore the last known-good builds, and keep Redis records untouched. Do not restore deprecated projection code as a hidden compatibility mode.


# 8) Verification Strategy (common-sense; evidence planning)

Use existing test runners and fixtures; do not create a cross-repo harness framework. Prefer behavior proof over file/keyword policing. Secret-absence checks inspect captured runtime values/artifacts in the focused tests and final canary, not repository text.

## 8.1 Unit tests (contracts)

- Protocol schema/version/size/deadline/extra-output/provider/binding/identity/expiry validation.
- Cache expiry-skew, coalescing, invalidation, changed-access-fingerprint guard, version-only no-retry, zero/failure caching.
- Auth precedence/exclusivity/status/login/logout/api-key conflicts.
- Session binding entry parse/append/latest/fork semantics and secret rejection.
- AIM record completeness, freshness, identity fingerprint, typed error mapping, Codex/Claude maintainer reuse.
- Target merge/private backup/exact-descriptor restore conflict/path rules.
- Prime-specific source-token/team/private authorization preservation.

## 8.2 Integration tests (flows)

- Pi fake helper -> ModelRegistry -> real built-in provider adapter with mocked HTTP, both providers.
- 401/403 -> exact source invalidation -> one retry only for a changed access-token value fingerprint; unchanged access stops even if the record version advanced.
- AIM fake Redis concurrent fresh/due resolves, lease/CAS winner, rotation fence, outage.
- Pi migration from recognized AIM OAuth projection and refusal on unknown native entry.
- Prime daemon create/attach/resume/restart, two workers/two labels, parent/subagent inheritance, UI/catalog no helper execution.
- Unmanaged provider matrix before/after external entries.

## 8.3 E2E / device tests (realistic)

- Opt-in, no-token-output canary commands for Pi Codex, Pi Anthropic, Prime Codex, Prime Anthropic using designated disposable labels.
- Near-expiry canary uses existing test/maintenance controls, not hand-edited live refresh tokens.
- Inspect process list, environment capture, target auth, session JSONL, daemon logs/summaries, AIM receipts, and rollback artifacts.
- One bounded concurrent-root check with two labels and child creation in Prime; no standalone soak harness.
- Manual UI check of managed status/login message and new-session selection wording.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

1. Land/release Pi generic seam disabled unless an `external` descriptor exists.
2. Land AIM helper and target code; run unit/concurrency tests without mutating live target files.
3. Opt in one disposable Pi agent dir and two disposable AIM labels; run canaries and rollback drill.
4. Install on the operator's normal Pi target, retaining any displaced-native backup for guarded uninstall.
5. Port/release Prime seam disabled by default; test disposable agent dir and isolated daemon socket/worker.
6. Opt in one Prime root tree, then concurrent trees/subagents, then the default target.
No production target mutation occurs merely by installing a new harness binary. Cutover requires the explicit AIM target `use` action and reports the exact providers/labels/path to be changed.

## 9.2 Operational runbook

This plan adds no permanent telemetry taxonomy. Existing diagnostic logs may emit only fixed outcomes and bounded timing, through their normal sanitizers; never record token/value fingerprints, refresh/native data, identity PII, response payloads, helper stdout/stderr, Redis URLs, or full executable arguments.

- **Select:** `aim pi use ...` or `aim prime use ...`; read receipt and remember it affects new root trees.
- **Verify:** `aim <target> status` runs descriptor/record/helper preflight without printing access.
- **Reauth:** follow the typed action (`aim login <label>` / existing Claude login path), then retry the same session; if AIM reports an identity change, update the target and start a new root tree.
- **Redis outage:** loaded trees may continue only while cached access is before skew. New/refresh-due work fails `coordination_unavailable`; restore Redis, do not install native fallback credentials.
- **Lease busy/fence:** wait for the owning AIM operation or inspect AIM status; do not force a second refresh writer.
- **Change account:** run `aim ... use` and start a new root tree. Do not mutate model IDs or auth files manually.
- **Rollback:** run guarded uninstall for the target/provider, stop managed workers to clear memory, verify the restored entry and unrelated providers, then revert binaries if needed.
- **Suspected leak:** stop affected harnesses, invalidate/relogin the AIM label, inspect sanitized diagnostics and affected artifacts, and rotate Redis/export protections under the existing incident process.

# 10) Decision Log (append-only)

## 2026-08-06 - Use a typed external credential helper, not file projection or direct Redis

**Context:** Pi/Prime need direct provider access tokens, while AIM is a CLI/Redis authority and current Pi projection duplicates refresh credentials.

**Options:** literal OAuth projection; whole-home wrapper; env/argv; shell `!command`; direct Redis/library import; custom provider proxy; typed external helper at `AuthStorage`.

**Decision:** add a provider-neutral external auth type/client and implement it with an exact AIM helper subprocess. Keep existing provider streams.

**Consequences:** small core work in both harnesses and a versioned machine protocol; no refresh-token duplication or Redis coupling; access crosses one local pipe under the accepted same-UID boundary.

**Follow-ups:** consider a socket only from measured performance evidence under a new plan.

## 2026-08-06 - Pin exact identity per root session tree

**Context:** global mutable defaults cannot support concurrent sessions or deterministic resume; rotating accounts mid-session harms identity and cache continuity.

**Options:** global provider account; per request; per turn; per individual agent; per root tree.

**Decision:** resolve Codex `auto` and Claude `fable`/`opus` to an exact label before runtime and persist source/provider/binding/identity for the root tree; Prime subagents inherit it.

**Consequences:** concurrent root trees can differ, resume is deterministic, and account changes are explicit/new-tree operations. Automatic quota failover is excluded.

**Follow-ups:** make status clearly distinguish the loaded session binding from the default for new trees.

## 2026-08-06 - Managed providers are exclusive and fail closed

**Context:** stored auth, env, models commands, `/login`, and `--api-key` could shadow AIM and recreate split ownership.

**Options:** preserve native precedence above AIM; AIM as fallback; AIM external entry as exclusive source.

**Decision:** an installed external entry is the sole source for that provider. Conflicting runtime key is an error; login/logout route to AIM guidance; helper failure does not fall through.

**Consequences:** predictable authority and failure behavior; operator must explicitly uninstall to return to native auth.

**Follow-ups:** migration/rollback keeps displaced entries private and conflict-guarded.

## 2026-08-06 - Preserve a bounded cached-access outage window

**Context:** requiring Redis on every request is fragile, but stale/refresh-token fallback would create a second authority.

**Options:** resolve every call; fail immediately on any Redis outage; use in-memory access until expiry-skew.

**Decision:** cache successful access only in the owning runtime until expiry-skew. New bindings and refresh-due calls require AIM/Redis and fail closed.

**Consequences:** normal turns avoid subprocess latency and short outages do not kill valid in-flight sessions; no token is persisted.

**Follow-ups:** measure cache/resolve latency and error outcomes during rollout.

## 2026-08-06 - Initial convergence closure (planning-derived): one auth owner across all managed call paths

**Changed contract:** the source and lifecycle of Codex/Anthropic credentials consumed by Pi/Prime.

**Competing live paths:** AIM Pi secret projection, harness stored OAuth refresh, env/runtime/model command precedence, native login/logout, and the missing Prime target.

**Minimal closure:** add the external owner seam; cut over and delete Pi secret projection; add Prime target; make managed native side doors non-operative; preserve every unmanaged branch.

**Why narrower is split authority:** leaving any managed OAuth copy or silent native fallback lets Pi/Prime rotate or select credentials outside Redis and can invalidate AIM's refresh lineage.

**Behavior-preservation proof:** existing unmanaged auth suites plus focused managed exclusivity/migration tests and built-in provider canaries.

**Scope effect:** these adjacent auth surfaces are part of the initial frozen destination; unrelated providers, Redis hardening, and daemon redesign remain excluded.


## 2026-08-06 - Apply independent Fable 5 high overbuild review selectively

**Context:** a clean external Claude Fable 5 high review found the core helper seam necessary but identified speculative cross-repo contracts, rollback lineage, telemetry ceremony, and a wider-than-needed Pi runtime refactor.

**Options:** keep the decision-complete draft unchanged; take every proposed deletion; or accept only subtractions that preserve authority, resume identity, retry correctness, rollback conflict safety, and enforceable deadlines.

**Decision:** make identity fingerprints opaque AIM-owned stable values; keep `credentialVersion` inside the helper/client rather than `AuthSourceToken`; replace backup hashes/timestamps with one displaced-native file plus exact installed-descriptor equality; keep Pi's shared `AuthStorage` and reset its external state at the existing runtime boundary; remove `requestId`, caller-selected validity, JSON-depth, buffer-zeroing, permanent telemetry, and soak machinery. Retain value fingerprints because Prime already uses that non-bearer stale-source contract and Pi needs to identify rejected material without passing bearer strings. Retain process-group TERM/grace/KILL and descendant-reaping proof because the currently synchronous Claude CLI launch makes the outer deadline otherwise unenforceable across wrapper/child boundaries.

**Consequences:** fewer protocol fields, no hash-lineage state, no telemetry taxonomy, a smaller Pi wiring change, and less proof ceremony, while preserving all security and concurrency invariants. The real canaries sample latency once; any daemon remains a separately approved design.

**Follow-ups:** implementation review must reject reintroduction of canonical fingerprint fixtures, target hash ledgers, persistent helper metrics, soak infrastructure, or per-runtime Pi storage construction unless new evidence changes the contract.


## 2026-08-06 - Scope approved for implementation with live-account safety boundary

**Context:** Amir approved implementation and testing of the frozen plan, with the explicit requirement that existing Codex and Claude accounts are not logged out.

**Decision:** implement the full frozen code scope and automated proof across AIMGR, Pi, and Prime. During implementation, do not invoke live login/logout, mutate the operator's `~/.aimgr`, `~/.pi`, or `~/.prime` auth state, contact live provider APIs, or run real-account canaries. Use fake helpers, temporary agent directories, mocked provider calls, and isolated coordination fixtures. The four real canaries remain an operator-approved post-implementation proof rather than an unattended test.

**Consequences:** automated completion can prove protocol, refresh coordination, session affinity, daemon isolation, migration, rollback, and secret absence without risking active sessions. Final completion must report the real-canary proof as intentionally deferred unless Amir separately authorizes it.
