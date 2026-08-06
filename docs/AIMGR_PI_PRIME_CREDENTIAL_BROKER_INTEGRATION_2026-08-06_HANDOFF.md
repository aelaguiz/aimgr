# AIMGR ↔ Pi / Prime Credential Broker  -  Full Handoff

**Updated:** 2026-08-06T02:52:33.025962+00:00
**Overall state:** Implementation is real and substantially working, but not complete or approved. Pi and a fresh-daemon Prime both passed real Codex calls through AIM. Anthropic credentials reach Anthropic but the tested accounts are blocked by Anthropic extra-usage policy. Prime's five accepted audit defects are reported repaired; permanent dirty-source daemon identity and fresh review are in progress.

> **Post-handoff correction:** Prime's earlier `No API key` canary was caused by attachment to a stale daemon whose dirty-source build ID did not change. A unique temporary daemon socket using the current source returned exact `PRIME_CODEX_OK` through real AIM label `pro3`. The permanent source-build identity fix is active. A broad shutdown used during cleanup disturbed unrelated Prime agents; broad Prime shutdown/restart/kill is now explicitly prohibited. See the implementation log for the append-only overnight record.

## 1. Goal

Make `aimgr` the credential authority for the canonical `openai-codex` and `anthropic` providers in both Pi (`pi-mono`) and Prime Agent, while preserving native transports, provider/model IDs, unmanaged auth, Prime CLI/team/private-model behavior, and exact root-tree account binding.

AIM alone owns refresh credentials, provider refreshes, leases, and Redis CAS publication. Pi and Prime receive short-lived access credentials through a bounded trusted subprocess protocol and must never persist bearer material.

## 2. Canonical artifacts

- Binding plan: `/Users/aelaguiz/workspace/aimgr/docs/AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06.md`
- Implementation log: `/Users/aelaguiz/workspace/aimgr/docs/AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06_IMPLEMENTATION_LOG.md`
- This handoff: `/Users/aelaguiz/workspace/aimgr/docs/AIMGR_PI_PRIME_CREDENTIAL_BROKER_INTEGRATION_2026-08-06_HANDOFF.md`
- External overbuild-review receipt: `/tmp/fresh-consult/aimgr-pi-prime-overbuild-20260806T003116Z-un1mp20y`

Baseline commits:

- AIMGR: `00d60ce0737f0f5c14d4293bcbecf813055737fc`
- Pi: `c8edb256b9dc20f6fba798e5b90ef304b9e85d10`
- Prime: `c98941a2a5cf40faecf9b4648ac3c304abf48fd3`

No commits have been made.

## 3. Frozen architecture and invariants

- Provider/model identity remains canonical: `openai-codex` and `anthropic`; labels never enter provider/model IDs.
- Managed auth is a typed `external` auth source in the existing `AuthStorage` / `ModelRegistry` seam.
- Exact trusted `aim credential-helper` child process, `shell:false`, one bounded JSON request on stdin and one bounded JSON response on stdout.
- AIM/Redis is the only managed refresh-token authority. Pi/Prime get access tokens only.
- Root session trees bind provider/source/exact label/opaque AIM identity fingerprint. Descendants inherit; concurrent roots can differ.
- Managed provider resolution is exclusive and fail-closed: no fallback to env, stored native auth, runtime keys, `models.json`, `/login`, another label, or another provider.
- Tokens cache in memory only until freshness skew. Concurrent resolves coalesce per provider/source/label.
- A structured 401/403 invalidates the exact rejected token value and permits at most one retry, only if the new access-token value fingerprint differs. A version-only change is terminal.
- `credentialVersion` is helper/client-private and must not enter Prime IPC, session JSONL, logs, errors, or receipts.
- AIM owns stable opaque provider-specific identity fingerprints. Consumers compare them opaquely.
- Target install preserves at most one displaced native entry per target/provider and restores it only if the current entry exactly matches AIM's last installed descriptor.
- Claude maintenance owns its process group, supports abort/deadline propagation, TERM → grace → KILL, and must release leases/reap descendants.
- No initial broker daemon, direct Redis client in Pi/Prime, synthetic providers, env/argv bearer transfer, permanent credential telemetry, or soak framework.

## 4. Repository state

### AIMGR  -  implementation plus accepted-audit repairs still being finished

Primary new owners:

- `src/credentials/harness-access.js`
- `src/cli/commands/credential-helper.js`
- `src/targets/harness-auth.js`
- `src/cli/commands/harness-target.js`
- `src/cli/commands/prime.js`
- `src/targets/prime-agent.js`
- `src/targets/claude-runner.js`
- `src/credentials/claude-maintenance.js`

Initial AIM proof was 329/329 with lint and diff-check, but that proof was invalidated by an independent audit. Six accepted findings were routed back:

1. Persist target `authPath` ownership across changed/absent env overrides.
2. Make backup/descriptor/receipt transitions crash-consistent, including multi-provider uninstall.
3. Derive identity fingerprints from immutable provider identity, not mutable/enrichable metadata.
4. Close Redis stores if `loadRedisRuntime()` fails after connecting.
5. Restore incomplete-Codex `oauth_reauth_required` maintenance behavior.
6. Restore the Codex file-backed/keyring limitation in live help.

Additional requested proof: `rejectedCredentialVersion` handling and abort/lease-release/descendant-reaping tests.

Current tree visibly contains the repair machinery, including pending target transitions, updated help, identity tests, and runtime-store cleanup. The AIM worker has not yet delivered its final repair report or fresh full test proof. Do not treat AIM as approved until that happens and a clean independent re-review passes.

### Pi (`pi-mono`)  -  nine findings repaired; re-review pending

Main new owners:

- `packages/coding-agent/src/core/external-credential-client.ts`
- `external-auth-session.ts`
- `external-auth-session-capability.ts`
- `external-auth-retry.ts`
- `request-auth-headers.ts`
- canonical `auth-storage.ts`, `model-registry.ts`, `agent-session.ts`, `session-manager.ts`, compaction/summary, SDK/CLI, provider error paths, and UI guards

The first Pi audit was **NOT APPROVED** with nine findings. The implementer reports all nine repaired:

1. Canonical `ModelRegistry.authStorage` ownership and true per-root isolation.
2. No public reset/seeding or mutable descriptor-reference side doors.
3. Bounded fingerprint→version rejection history and stale-generation rejection.
4. Retry coverage for streams, manual/auto compaction, and branch summaries.
5. Authentication failures are terminal to generic retry loops.
6. Managed credential-header override rejection while preserving unmanaged merge order.
7. Numeric HTTP/WebSocket 401/403 classification for Codex.
8. Guaranteed terminal failure for thrown/premature streams.
9. Fail-closed root reloads and real owner-level tests.

A persisted-fork bug was also fixed by retaining the mutated `SessionManager`.

Fresh repair proof reported:

- Focused suites: **165/165 passed**.
- Core Biome, `tsgo --noEmit`, and browser smoke: passed.
- `git diff --check`: passed.
- Root check still ends at the pre-existing unbuilt `packages/web-ui` declaration-resolution problem.

Pi still needs a new clean independent re-review; the implementer's report is not the acceptance gate.

### Prime Agent  -  implemented, independently rejected, five repairs active

Main work spans the same auth/session/client seam plus daemon/runtime/subagent/compaction/refinement integration. Before the audit:

- `npm run check`: passed.
- Coding-agent focused suites: 367 passed / 2 skipped.
- AI focused suites: 47 passed.
- `git diff --check`: passed.

The clean independent Phase 3 audit returned **NOT APPROVED** with high confidence:

1. **P0  -  native OAuth refresh can overwrite a newly installed AIM descriptor.** `auth-storage.ts` serializes a stale root snapshot over raw locked disk truth. Repair must use raw locked disk as persistence base, reject same-provider refresh if disk is now external, merge only the refreshed native provider, and apply root snapshot only in memory. Add same- and other-provider concurrent install/update tests.
2. **P1  -  overlapping helper calls can recache rejected material.** Port Pi's per-key `getOrStartResolution` / `resolveAfterRejection` arbitration or equivalent epoch logic; test expired-fresh versus 401 reacquire overlap.
3. **P1  -  daemon `get_session_tree` leaks raw `credential_binding` entries.** Create one canonical sanitizer for snapshot, in-process, and daemon paths, including parent relinking, so v7 wire shape remains unchanged.
4. **P1  -  compaction/review/refinement/summary resolve auth twice.** Preserve unmanaged command-backed key/header semantics by resolving exactly once and threading the full resolved auth into retry completion (or removing the pre-resolve).
5. **P2  -  defensive descriptor ownership is incomplete.** Deep clone/freeze ingest and all public reads, including `getAll()` and nested `args`, matching repaired Pi.

The critic found no bearer or helper-private credential version persisted in reviewed session/log/snapshot code. The Prime implementer is actively repairing all five findings and has been asked to rerun check and focused suites. A new independent re-review is required afterward.

## 5. Real-credential canary performed on 2026-08-06

The user explicitly authorized selecting one real Codex account and one real Anthropic account and accepted normal AIM rotation.

### Isolation used

- Read live AIM status to select currently usable records.
- Created a temporary HOME and copied only the live AIM Redis config into it.
- Used separate temporary Pi and Prime agent directories.
- Used `--no-env`, `--no-session`, no tools, no extensions, no skills, no context files, and one tiny prompt.
- Did not invoke login/logout.
- Did not write `~/.pi`, `~/.prime`, or the default AIM target metadata.
- Bearer tokens were not printed or persisted in target auth files.

Selected records:

- Codex: `openai-codex/pro3` (fresh AIM record).
- Anthropic first: `anthropic/pro9` (free and credential-ready).
- Anthropic second diagnostic: `anthropic/claudalyst` (free and credential-ready).

Both temporary target installs returned `installed` for their selected providers, and the written `auth.json` files contained only external descriptors, not bearer or refresh tokens.

### Canary outcomes

#### Pi → Codex: **PASS**

Source Pi was launched with native env keys removed and the temporary external descriptor. Real `openai-codex/gpt-5.4` returned exactly:

```text
CANARY_CODEX_OK
```

This is a real end-to-end success through Pi → AIM helper → live AIM/Redis credential → native Codex transport.

#### Pi → Anthropic: **credential/broker path reached provider, but no successful model response**

With `pro9`, Anthropic returned HTTP 400:

```text
Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.
```

With `claudalyst`, Anthropic returned HTTP 400:

```text
You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
```

These were provider `invalid_request_error` responses, not missing-key or 401/403 auth failures. This is strong evidence that the helper delivered a valid credential and Pi's Anthropic request reached the real provider, but it does **not** prove a successful Claude completion. A label with Anthropic extra usage enabled/funded is needed for the final green canary.

#### Prime → Codex: **FAIL before provider request**

The temporary AIM Prime target install reported success and its `auth.json` visibly contained the `openai-codex/pro3` external descriptor. Source Prime launched with the expected temporary `PRIME_AGENT_CODING_AGENT_DIR` nevertheless exited with:

```text
No API key for provider: openai-codex
```

This is an unresolved Prime root-boundary/discovery bug or canary configuration mismatch. It occurred before a provider call. Diagnose it after/alongside the five accepted Prime repairs; inspect `getAgentDir()`, `AuthStorage` construction, external-session initialization, and whether source CLI root creation claims the same storage instance/path.

#### Prime → Anthropic: **not run**

It was not useful to spend another provider call after Prime failed to discover the Codex descriptor and the selected Anthropic accounts were already proven blocked by extra-usage policy.

### Temporary canary artifacts

The ephemeral tree was `/tmp/aimgr-real-canary-rxc98xpd`. It temporarily contained a copied Redis configuration and has now been deleted. The handoff records all non-secret evidence needed to recreate the canary safely.

## 6. Active agent roster at handoff

- `aim-credential-helper-implementer`  -  session `019fd48b-33ef-767e-b18f-7ac00c4a28c0`, child `sub-82308c49`, **running**. Owns AIM six-finding repair and fresh proof. It appeared slow/stuck around lifecycle/help tests; inspect or resume explicitly before assuming completion.
- `pi-external-auth-implementer`  -  session `019fd48b-08b4-771e-a341-8825a4998db6`, **idle/available**. Nine Pi repairs completed; asked to stand by for real-canary repair evidence.
- `prime-external-auth-implementer`  -  session `019fd4a2-4e23-720e-b02f-1b3f5a76b6e5`, **running**. Repairing the five binding Prime audit findings.
- `prime-phase3-critic`  -  session `019fd4d4-bd05-774e-b9ce-aeb34cfe0d7c`, **idle**. Completed the NOT APPROVED audit; do not use it as the independent re-review after repair - start a new clean critic.

## 7. Safety boundary and unrelated work

Preserve unrelated pre-existing files:

- AIMGR: `.antigravitycli/`, `.tmp/`
- Pi: `.arch_skill/`, `packages/coding-agent/docs/model-routing-plan.md`

Until the explicit live-canary authorization above, all proof used fake helpers, temporary homes/agent dirs, mocked HTTP/WebSockets, fake Redis, and fake children. The real canary authorization covered normal AIM access/rotation only; do not infer permission for login/logout, destructive account operations, or writing default target homes.

Pi/Prime validation rule remains: use `npm run check` plus explicitly named Vitest files; never run root `npm test`. AIM may run `npm run lint` and `npm test`.

## 8. Exact next actions

1. **Secure cleanup:** completed for `/tmp/aimgr-real-canary-rxc98xpd`; recreate a fresh temp HOME/config copy for future canaries.
2. **AIM:** recover/resume the AIM worker, inspect its diff, run `npm run lint && npm test`, `git diff --check`, and verify fault-injection/abort/lease proof. Then run a new clean AIM audit over IMP-AIM-001..006.
3. **Pi:** start a new clean Pi critic focused on IMP-PI-001..009 and current code, including per-root isolation, concurrent rejection arbitration, headers, and compaction/summary retry.
4. **Prime:** let the exact implementer finish the five accepted findings. Run `npm run check`, named focused suites, and diff-check. Start a new clean Prime critic afterward.
5. **Prime live discovery:** reproduce `No API key for provider: openai-codex` in a new temp HOME/agent dir. Add an owner-level regression that uses the exact CLI/root construction path and actual target-style descriptor. Repair before rerunning live calls.
6. **Anthropic live completion:** select a free AIM Anthropic label with extra usage enabled/funded, or enable a minimal extra-usage budget, then rerun one Pi and one Prime canary. Current 400s prove provider reachability but not successful completion.
7. **Cross-repository proof:** run shared protocol fixtures and the non-live failure/concurrency matrix only after the three repository audits pass.
8. **Finalize docs:** update plan checkboxes/status, implementation log proof freshness, accepted-finding dispositions, side-door/delete ledger, and explicit deferred canaries. Do not mark complete from focused tests alone.
9. **Commit only if explicitly requested.** No commits currently exist.

## 9. Current bottom line

- The architecture is approved and overbuild review passed after simplification.
- Pi's managed Codex path works with a real AIM credential.
- Pi's managed Anthropic path reaches Anthropic with real AIM credentials, but tested accounts cannot spend extra usage.
- Pi's nine audit repairs are implemented and locally green, awaiting clean re-approval.
- AIM's six audit repairs appear in the tree but need a final report, full proof, and clean re-approval.
- Prime is not approved: five audit defects are actively being repaired, and its first real source canary failed to discover the installed descriptor.
- No default Pi/Prime auth homes were changed, no login/logout occurred, and no bearer token was written to target auth/session artifacts.
