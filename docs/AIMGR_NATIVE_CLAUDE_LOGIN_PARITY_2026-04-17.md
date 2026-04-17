---
title: "aimgr - Native Claude Login Parity - Architecture Plan"
date: 2026-04-17
status: active
fallback_policy: forbidden
owners: [Amir Elaguizy]
reviewers: []
doc_type: architectural_change
related:
  - README.md
  - src/cli.js
  - test/cli.test.js
  - https://code.claude.com/docs/en/authentication
  - https://code.claude.com/docs/en/env-vars
  - https://code.claude.com/docs/en/remote-control
---

# TL;DR

Outcome
- `aim claude use` becomes a native Claude-account switcher: AIM selects the next eligible Claude label and projects the same local auth state regular Claude logins use, so the next `claude` process behaves like an ordinary Claude.ai login for that account.

Problem
- The current Claude path in AIM only writes `~/.claude/.credentials.json`, which is enough to look logged in but not enough to fully match a native Claude login. Native Claude identity metadata also lives in `~/.claude.json` under `oauthAccount`, and that surface is currently missing from AIM's Claude model and projection path.

Approach
- Treat Claude native login state as a first-class AIM-managed artifact. Capture and store the native Claude auth bundle per label, then make `aim claude use` project both `~/.claude/.credentials.json` and `~/.claude.json` `oauthAccount` into the active home, with hard cutover to the current native Claude contract and no legacy synthetic-only path.

Plan
- Foundational sequence: canonical bundle schema -> auth-time native bundle capture -> eligibility gating -> dual-file projection -> parity-aware status -> hard cutover cleanup and proof.

Non-negotiables
- `aim claude use` stays the operator UX.
- The projected auth state must be indistinguishable from a regular Claude.ai login for normal local Claude Code use.
- No env-token auth path stands in for a native login.
- No dual sources of truth between AIM's Claude label state and the projected native Claude auth surfaces.
- No legacy synthetic-only Claude projection path survives the cutover.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-04-17
recommended_flow: research -> deep dive -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

If AIM manages Claude labels as native Claude auth bundles instead of partial token projections, then `aim claude use` can switch local Claude Code accounts in a way that `claude auth status`, normal local `claude` sessions, and account identity reporting cannot distinguish from an ordinary Claude.ai login for the selected account.

## 0.2 In scope

- Keep `aim claude use` as the one-command operator path for local Claude account switching.
- Model the current native Claude login artifacts AIM must manage for parity:
  - `~/.claude/.credentials.json`
  - `~/.claude.json` `oauthAccount`
- Update Anthropic label maintenance so AIM can capture and store the native Claude login bundle per label.
- Update `aim claude use`, Claude readback, Claude status, Claude warnings, docs, and tests to use the native bundle model.
- Hard-cut current Claude support to the latest native auth behavior used by the locally installed Claude Code build on this machine.
- Preserve current pool-selection behavior and label-first AIM operating model.

## 0.3 Out of scope

- Parallel multi-account Claude sessions under one shared `HOME`.
- A general multi-home launcher or supervisor for concurrent Claude processes.
- Console/API-key/Bedrock/Vertex/Foundry auth redesign.
- Backward-compatible support for the current synthetic-only Claude projection once the native bundle path lands.
- Broader refactors outside the Claude auth and local activation surfaces needed for this cutover.

## 0.4 Definition of done (acceptance evidence)

- `aim claude use` projects the selected label into both `~/.claude/.credentials.json` and `~/.claude.json` `oauthAccount`.
- In an isolated `HOME`, the projected auth bundle causes `claude auth status --json` to report:
  - `loggedIn: true`
  - `authMethod: "claude.ai"`
  - the expected email, org, and subscription for the selected label
- On the real local machine, switching from one Claude label to another changes `claude auth status` identity without requiring a fresh browser login for an already-captured label.
- Repo tests cover native bundle capture, active-home projection, status/readback parity, and the hard cutover away from the synthetic-only Claude path.
- The README and operator guidance describe the native Claude behavior truthfully.

## 0.5 Key invariants (fix immediately if violated)

- `aim claude use` remains the public switching command.
- AIM remains the durable SSOT for labeled Claude account inventory.
- The active local Claude auth state must be projected from AIM, not maintained as a competing truth.
- A Claude label is not eligible for native switching if its stored bundle is incomplete for the current native contract.
- No env-token auth path (`CLAUDE_CODE_OAUTH_TOKEN`, `setup-token`) is treated as equivalent to a native Claude.ai login for steady-state switching.
- No legacy synthetic-only Claude projection survives the cutover.
- If the native bundle is incomplete or unreadable, AIM fails loudly instead of silently projecting half a login.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Native login parity for ordinary local Claude Code use.
2. Preserve the existing AIM operator model: labels are the SSOT; `aim claude use` is the switch.
3. Hard cutover to the current native Claude auth contract, not a compatibility museum.
4. Keep Claude-specific complexity local to the Claude auth path and avoid collateral churn in Codex, Pi, or Hermes flows.

## 1.2 Constraints

- The repo already has Claude pool-selection and local activation behavior wired through `src/cli.js`; this work should converge onto that path, not create a parallel Claude switcher.
- The current local Claude Code build is a native macOS install and exposes both `~/.claude/.credentials.json` and `~/.claude.json` as meaningful auth-bearing surfaces.
- `CLAUDE_CODE_OAUTH_TOKEN` is an automation auth surface, not a substitute for a native Claude.ai login.
- The user explicitly does not want legacy preservation here.

## 1.3 Architectural principles (rules we will enforce)

- Store Claude native auth truth as one AIM-managed bundle per label.
- Project the full native local auth surface or fail loudly.
- Reuse the existing AIM Claude selection path; do not add a second command or mode.
- Preserve behavior by changing the Claude owner path in place and deleting superseded logic.

## 1.4 Known tradeoffs (explicit)

- AIM will carry more Claude-native metadata than it does today.
- Native parity requires bootstrapping labels from a real Claude login artifact, not just raw access/refresh tokens.
- Full multi-account concurrency is a separate problem from one-active-account-at-a-time switching and is intentionally excluded from this cut.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

- AIM already has a Claude pool and a local activation command: `aim claude use`.
- The current Claude local read/write path is centered on `claudeAiOauth` inside `~/.claude/.credentials.json`.
- Claude readback and warnings are based on that file plus `claude auth status`.

## 2.2 What’s broken / missing (concrete)

- A projected `.credentials.json` alone is not enough to fully match a native Claude login.
- Native Claude account identity metadata lives separately in `~/.claude.json` `oauthAccount`, which AIM does not currently model or project.
- That leaves `claude auth status` partially degraded under projected auth: logged in, but missing email/org context.
- The current Anthropic label model is still token-centric rather than native-Claude-bundle-centric.

## 2.3 Constraints implied by the problem

- The fix must own both native local auth files, not just the token file.
- The selector UX should not change.
- The implementation should converge on the current Claude path, not add a "native Claude mode."
- The cutover should be explicit and fail loud when a label has not yet been upgraded to the native bundle shape.

<!-- arch_skill:block:research_grounding:start -->
# 3) Research Grounding (external + internal “ground truth”)

## 3.1 External anchors (papers, systems, prior art)

- Claude Code Authentication docs (`https://code.claude.com/docs/en/iam`) - adopt: subscription OAuth from `/login` is the default Claude.ai auth path for local CLI use; this is the parity target AIM should reproduce for account switching.
- Claude Code Environment Variables docs (`https://code.claude.com/docs/en/env-vars`) - adopt: `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over stored credentials and is an automation surface, not the native steady-state login path we want for `aim claude use`.
- Claude Code Remote Control docs (`https://code.claude.com/docs/en/remote-control`) - adopt: long-lived token auth and `CLAUDE_CODE_OAUTH_TOKEN` are inference-only and cannot establish Remote Control sessions; a full-scope Claude.ai login remains the stronger native contract.
- Claude Code Authentication docs storage-location note - reject as sole owner-path guidance for this feature on macOS. The docs emphasize keychain storage on macOS, but current local Claude Code runtime behavior on this machine still consumes projected home-directory auth files in isolated `HOME` probes, so local runtime truth has to govern the AIM cutover.
- Local runtime probe on this machine with Claude Code `2.1.97` - adopt: copying only `~/.claude/.credentials.json` into an isolated `HOME` yields `loggedIn: true`, `authMethod: "claude.ai"`, but `email` and `orgName` are `null`; copying both `.credentials.json` and `.claude.json` restores full identity metadata. That is the direct parity proof for this plan.
- Local runtime probe on this machine with Claude Code `2.1.97` - adopt: projecting only the auth-bearing pieces of the captured bundle into a temp `HOME` restores full identity, and removing only `oauthAccount` drops identity while unrelated `.claude.json` keys remain intact. That proves the bundle-shuffle model and the `oauthAccount` patch semantics directly.

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors (do not reinvent):
  - `src/cli.js` - `readClaudeAuthFile` currently reads only `~/.claude/.credentials.json` and extracts `claudeAiOauth`.
  - `src/cli.js` - `buildClaudeAuthDotJson` currently writes only the `claudeAiOauth` payload from normalized Anthropic credential fields.
  - `src/cli.js` - `applyClaudeCliFromState` is the canonical existing `aim claude use` activation path; it hydrates Anthropic state, writes `.credentials.json`, reads it back, and records `targets.claudeCli`.
  - `src/cli.js` - `readClaudeCliTargetStatus` and `buildWarningsFromClaudeTargetStatus` own Claude status and warning composition today, but only reason about `.credentials.json` plus `claude auth status`.
  - `src/cli.js` - `hydrateAnthropicCredentialForClaudeLocal` backfills subscription/rate-limit/scopes from the current local `.credentials.json` or usage snapshot. This is the current legacy bridge the user does not want to preserve.
  - `src/cli.js` - `clearManagedClaudeCliActivation` deletes only `.credentials.json`, so the second native auth-bearing surface is not managed today.
- Canonical path / owner to reuse:
  - `src/cli.js` - the existing Claude selection, activation, readback, warning, and receipt path should own the cutover in place. Do not add a second Claude switch command or parallel activation path.
- Adjacent surfaces tied to the same contract family:
  - `README.md` - current operator guidance still says Claude auth lives at `~/.claude/.credentials.json` and advertises bounded backfill from that file.
  - `test/cli.test.js` - the fake Claude CLI only reads `.credentials.json`, so the harness cannot currently model `.claude.json` parity or full identity metadata.
  - `test/cli.test.js` - current Claude activation/status tests assert `.credentials.json` only and therefore encode the legacy partial contract.
  - `src/cli.js` path helpers - the repo has `resolveManagedClaudeDir` and `resolveClaudeAuthFilePath`, but no helper for the top-level `~/.claude.json` surface.
- Compatibility posture (separate from `fallback_policy`):
  - Clean cutover - user-approved latest native auth behavior with no legacy preservation, and the current projection-field/backfill bridge would keep a token-centric shadow contract alive.
- Existing patterns to reuse:
  - `src/cli.js` target-status pattern (`read*TargetStatus` + `buildWarningsFrom*TargetStatus`) already gives AIM a fail-loud validation surface after projection.
  - `targets.claudeCli` is the existing state-backed receipt/status surface to extend rather than replace.
- Prompt surfaces / agent contract to reuse:
  - None. This is a local CLI auth/state projection change, not an agent-behavior design problem.
- Native model or agent capabilities to lean on:
  - Native Claude CLI runtime - `claude auth status --json` is the closest first-party probe for whether the projected bundle is treated like a normal Claude.ai login.
- Existing grounding / tool / file exposure:
  - Local `claude` binary is already installed and authenticated on this machine.
  - Isolated `HOME` runtime probes are available without changing repo code and give direct parity evidence.
- Duplicate or drifting paths relevant to this change:
  - `hydrateAnthropicCredentialForClaudeLocal` keeps the current projection-fields-only contract alive via local-file backfill and usage-based inference.
  - README backfill guidance advertises the same partial-contract bridge.
  - `CLAUDE_CODE_OAUTH_TOKEN` is a competing auth surface, but it should stay explicitly outside the steady-state native-switch path.
- Capability-first opportunities before new tooling:
  - Extend the existing `aim claude use` owner path to project both native auth files and read them back. No new command, daemon, launcher, or wrapper is needed.
- Behavior-preservation signals already available:
  - `claude auth status --json` after projection.
  - Existing Claude activation/status tests once expanded to assert both auth surfaces and full identity fields.
  - Isolated `HOME` runtime probes that distinguish `.credentials.json`-only projection from full native-bundle projection.

## 3.3 Decision gaps that must be resolved before implementation

- No blocker question remains at the research stage. Repo evidence plus approved intent already settle the major branches:
  - reuse `aim claude use`
  - treat the native Claude bundle as the AIM-managed SSOT for switching
  - hard-cut the legacy `.credentials.json`-only bridge
  - keep env-token auth outside the native steady-state path
- Deep-dive and phase-plan then resolve the remaining implementation-shape choices as:
  - one canonical stored `nativeClaudeBundle` plus a derived summary cache
  - auth-time native bundle capture followed by later file projection during switching
  - clean-cutover migration with fail-loud handling for incomplete existing Claude labels
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
# 4) Current Architecture (as-is)

## 4.1 On-disk structure

- `src/cli.js` is the single code owner for Anthropic label maintenance, Claude pool selection, Claude local projection, readback, status, warnings, and receipts.
- Claude local path helpers currently model only one auth-bearing file:
  - `resolveManagedClaudeDir` -> `~/.claude`
  - `resolveClaudeAuthFilePath` -> `~/.claude/.credentials.json`
- There is no repo helper or state contract today for the top-level `~/.claude.json` file.
- AIM durable state is split across:
  - `accounts[label]` for provider and reauth/browser metadata
  - `credentials.anthropic[label]` for Anthropic token state plus optional Claude projection fields
  - `targets.claudeCli` for the active local Claude target snapshot
- Adjacent contract surfaces outside `src/cli.js` already encode the same partial story:
  - `README.md` documents Claude activation as a `.credentials.json` write plus bounded backfill from the current local file
  - `test/cli.test.js` fakes Claude status by reading only `.claude/.credentials.json`
- Local runtime truth on this machine matters because `~/.claude.json` is not a dedicated auth file. It is a mixed Claude app state file with many unrelated top-level keys, and `oauthAccount` is only one nested field inside it.

## 4.2 Control paths (runtime)

1. Label maintenance:
   - `aim <label>` dispatches by provider.
   - Anthropic labels use `refreshOrLoginAnthropic`.
   - That function refreshes or browser-authenticates, then immediately calls `hydrateAnthropicCredentialForClaudeLocal`.
   - `hydrateAnthropicCredentialForClaudeLocal` fills `subscriptionType`, `rateLimitTier`, and `scopes` by first checking existing stored state, then backfilling from the current local `~/.claude/.credentials.json`, then inferring from usage snapshot if needed.
   - The stored Anthropic credential remains token-centric rather than native-bundle-centric.
2. Pool eligibility and label panel readiness:
   - `collectAnthropicPoolStatus` and `derivePoolAccountStatus` treat a fresh Anthropic token tuple as the main readiness signal.
   - `buildLabelControlPanelState` reuses that same eligibility logic for the operator-facing label panel.
   - Bundle completeness is not part of readiness today.
3. Claude activation:
   - `aim claude use` runs `activateClaudePoolSelection`.
   - That ranks eligible Anthropic labels and calls `applyClaudeCliFromState`.
   - `applyClaudeCliFromState` asserts projection fields, writes only `~/.claude/.credentials.json` via `buildClaudeAuthDotJson`, reads it back, and records `targets.claudeCli`.
4. Claude readback and status:
   - `readClaudeCliTargetStatus` reads `~/.claude/.credentials.json` through `readClaudeAuthFile`.
   - It separately shells out to `claude auth status --json`.
   - `buildWarningsFromClaudeTargetStatus` only knows about the token file, subscription mismatch, label mismatch, and basic logged-in status.
5. Claude clear/block path:
   - `clearManagedClaudeCliActivation` deletes only `~/.claude/.credentials.json`.
   - No code currently removes or patches `oauthAccount` in `~/.claude.json`.

## 4.3 Object model + key abstractions

- `credentials.anthropic[label]` currently behaves like:
  - canonical enough for raw Anthropic token ownership: `access`, `refresh`, `expiresAt`
  - optional Claude projection garnish: `subscriptionType`, `rateLimitTier`, `scopes`
- `getAnthropicCredentialMatchLabel` matches labels by `access` or `refresh` token, not by a native Claude bundle object.
- `targets.claudeCli` currently stores:
  - `authPath`
  - `activeLabel`
  - `expectedSubscriptionType`
  - `lastAppliedAt`
  - `lastSelectionReceipt`
- Claude text status only renders one path (`auth_path`), because the second native auth-bearing surface is not modeled at all.

## 4.4 Observability + failure behavior today

- The repo can detect:
  - missing or unreadable `.credentials.json`
  - token-to-label mismatch after projection
  - `claude auth status` parse failures
  - basic logged-out state
- The repo cannot detect:
  - missing `oauthAccount` parity in `~/.claude.json`
  - env-token precedence (`CLAUDE_CODE_OAUTH_TOKEN`) silently overriding the projected native files
  - a label that looks fresh enough for pool selection but is missing the native Claude bundle required for parity
- The current fake Claude harness in `test/cli.test.js` models the same blind spot: it only reads `.credentials.json`, so existing tests cannot fail on missing `oauthAccount`.

## 4.5 UI surfaces (ASCII mockups, if UI work)

```text
$ aim <label>
refresh/login Anthropic tokens
-> backfill Claude projection fields from current local .credentials.json or usage
-> store token-centric Anthropic credential

$ aim claude use
select eligible label
-> write ~/.claude/.credentials.json only
-> next claude process sees a partially native login
```
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
# 5) Target Architecture (to-be)

## 5.1 On-disk structure (future)

- AIM durable SSOT per Claude label becomes one canonical native bundle stored inside `credentials.anthropic[label]`:
  - `nativeClaudeBundle.claudeAiOauth`
  - `nativeClaudeBundle.oauthAccount`
- The same credential record may still carry a normalized summary cache for low-churn selector/status logic, but that cache is derived only from `nativeClaudeBundle` and is never an independent source of truth:
  - `access`
  - `refresh`
  - `expiresAt`
  - `subscriptionType`
  - `rateLimitTier`
  - `scopes`
  - `emailAddress`
  - `organizationName`
  - `organizationUuid`
- Active local Claude projection owns two surfaces:
  - `~/.claude/.credentials.json` as the projected `claudeAiOauth` file
  - `~/.claude.json` as the projected `oauthAccount` patch target
- `~/.claude.json` stays Claude-owned except for the `oauthAccount` key. AIM patches that one nested field and preserves every unrelated top-level setting already in the file.
- `targets.claudeCli` becomes a projection receipt surface, not a second expectation store. It should carry:
  - `credentialsPath`
  - `appStatePath`
  - `activeLabel`
  - `lastAppliedAt`
  - `lastSelectionReceipt`
  - no separate expectation fields that can drift from the active label bundle

## 5.2 Control paths (future)

1. Claude label maintenance remains `aim <label>`:
   - AIM still owns the Claude label-auth workflow, but the capture contract is file-first rather than token-reconstruction-first.
   - Native Claude authentication for the label produces the auth-bearing files once.
   - AIM ingests the resulting `~/.claude/.credentials.json` and `~/.claude.json` `oauthAccount`, normalizes them into `nativeClaudeBundle`, derives the summary cache, and stores that record for the label.
   - Later switching does not ask Claude to rebuild those files from tokens; AIM reprojects the captured native bundle.
   - If auth completes but AIM cannot read a complete native bundle from the auth result, label maintenance fails loud and does not store a half-upgraded Claude label.
2. Claude pool eligibility and panel readiness move to bundle-complete gating:
   - `derivePoolAccountStatus` for Anthropic labels requires both fresh tokens and a complete `nativeClaudeBundle`.
   - `collectAnthropicPoolStatus` and the label control panel inherit that same gate, so incomplete labels show as reauth-required before selection time.
3. `aim claude use` remains the one switching command:
   - selection logic stays in `activateClaudePoolSelection`
   - activation asserts bundle completeness
   - projection writes `.credentials.json` from `nativeClaudeBundle.claudeAiOauth`
   - projection patches only `oauthAccount` inside `~/.claude.json`
   - readback validates both files plus `claude auth status --json`
4. Claude status and warning surfaces become dual-source parity checks:
   - readback reads both projected files
   - runtime status must report `loggedIn: true` and `authMethod: "claude.ai"`
   - expected subscription/email/org are derived from the active label bundle and compared against runtime readback/status
   - env-token precedence is treated as a parity failure, not as an acceptable alternate auth path
5. Claude clear/block behavior becomes auth-surface-specific:
   - blocked/no-eligible selection clears `~/.claude/.credentials.json`
   - it removes `oauthAccount` from `~/.claude.json` while preserving unrelated Claude settings

## 5.3 Object model + abstractions (future)

- Canonical helpers to introduce or refactor toward:
  - a Claude app-state path helper for `~/.claude.json`
  - a bundle reader that reads both auth-bearing local surfaces together
  - a bundle writer that fully rewrites `.credentials.json`
  - an `oauthAccount` patcher/remover that preserves unrelated `~/.claude.json` keys
  - a native-bundle ingester that snapshots the auth-bearing files produced by native Claude authentication
  - a bundle normalizer that derives selector/status summary fields from the stored native bundle
- `assertAnthropicCredentialShape` gains a native-bundle completeness mode for Claude selection and projection.
- `getAnthropicCredentialMatchLabel` should match against the canonical Claude bundle token pair, with the normalized summary cache only reflecting the same values.
- `readClaudeCliTargetStatus` becomes a bundle-status reader rather than a single-file reader with a sidecar runtime probe.

## 5.4 Invariants and boundaries

- The only writable Claude SSOT in AIM is the stored native bundle for each label.
- Derived summary fields may exist for low-churn local logic, but they are regenerated from the bundle and never patched independently.
- No `.credentials.json`-only projection counts as native parity.
- No backfill from the currently active local Claude home survives the cutover.
- No usage-based inference survives the cutover for native Claude eligibility.
- No separate "native Claude mode" or extra switching command is added.
- `CLAUDE_CODE_OAUTH_TOKEN`, `setup-token`, or any other non-native override never count as equivalent steady-state success for `aim claude use`.
- AIM does not own any other `~/.claude.json` settings besides `oauthAccount`.
- Claude switching never depends on Claude regenerating native files from tokens after auth-time capture.
- If AIM cannot read a complete native bundle from the result of native Claude authentication for a label, Claude label maintenance stops and reports that blocker plainly instead of silently synthesizing missing identity fields.

## 5.5 UI surfaces (ASCII mockups, if UI work)

```text
$ aim <label>
native Claude auth for that label
-> capture the resulting native auth-bearing files
-> store complete AIM-managed nativeClaudeBundle

$ aim claude use
select eligible label
-> write ~/.claude/.credentials.json
-> patch ~/.claude.json.oauthAccount only
-> validate with claude auth status --json

$ aim status
shows active label, credentials path, app-state path, and parity warnings when runtime auth diverges
```
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
# 6) Call-Site Audit (exhaustive change inventory)

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| ---- | ---- | ------------------ | ---------------- | --------------- | --- | ------------------ | -------------- |
| Claude label maintenance | `src/cli.js` | `refreshOrLoginAnthropic`; account-maintenance provider branch around `aim <label>` | Refresh/login returns token-centric Anthropic credentials and rehydrates Claude projection fields from existing local file or usage snapshot | Capture the native auth-bearing files produced by the label's native Claude auth flow, then store `nativeClaudeBundle` plus derived summary fields | Native parity should come from the real native files we already have after auth, not from later reconstruction | `credentials.anthropic[label]` stores the captured native bundle as the only writable Claude SSOT | Anthropic login/refresh tests; Claude label maintenance tests |
| Claude projection-field bridge | `src/cli.js` | `buildClaudeProjectionFields`; `buildClaudeProjectionFieldsFromUsage`; `hasClaudeProjectionFields`; `hydrateAnthropicCredentialForClaudeLocal` | Synthesizes/backs-fills subscription fields from existing state, current local `.credentials.json`, or usage snapshot | Replace with bundle normalization and completeness checks; delete local-home backfill and usage-based inference for Claude parity | These helpers keep the old synthetic-only contract alive | Summary cache derives only from `nativeClaudeBundle` | Claude label-maintenance and eligibility tests |
| Anthropic eligibility and label panel | `src/cli.js` | `derivePoolAccountStatus`; `collectAnthropicPoolStatus`; `buildLabelControlPanelState` | Fresh token tuple is enough to mark a Claude label ready/eligible | Require complete native bundle in addition to fresh tokens; surface incomplete bundle as reauth-needed before selection time | Prevent late failure in `aim claude use` and operator confusion in the label panel | Claude readiness means fresh token + complete native bundle + usable usage snapshot | Pool-status tests; panel-state tests |
| Claude local path helpers and readback | `src/cli.js` | `resolveManagedClaudeDir`; `resolveClaudeAuthFilePath`; `readClaudeAuthFile` | Models only `~/.claude/.credentials.json` | Add top-level Claude app-state path helper and a dual-file bundle reader for `.credentials.json` + `.claude.json.oauthAccount` | Native parity spans two local surfaces | Claude readback contract becomes bundle-first | Claude readback/status tests |
| Claude local write/clear path | `src/cli.js` | `buildClaudeAuthDotJson`; `applyClaudeCliFromState`; `clearManagedClaudeCliActivation` | Writes and clears only `.credentials.json` | Fully rewrite `.credentials.json`, patch/remove only `oauthAccount` inside `~/.claude.json`, and record both projected paths | `~/.claude.json` is a mixed settings file and must be preserved outside `oauthAccount` | Claude projection mutates only auth-bearing keys and preserves unrelated app state | Claude activation/clear tests |
| Claude status, receipts, and warnings | `src/cli.js` | `readClaudeAuthStatus`; `readClaudeCliTargetStatus`; `buildWarningsFromClaudeTargetStatus`; status text rows | Knows one auth path and basic login/subscription state | Compare runtime status against the active label bundle, expose both projected paths, and warn on missing `oauthAccount`, email/org mismatch, subscription mismatch, or env-token override | Current status can still report success while parity is degraded or shadowed | Claude status is parity-aware, not just token-aware | Claude status/warning tests; text-status snapshot updates |
| Claude target metadata | `src/cli.js` | `targets.claudeCli`; `target.expectedSubscriptionType`; `getAnthropicCredentialMatchLabel` | Stores one auth path plus expected subscription snapshot; token matching is anchored on the top-level token record | Store both projected paths and derive expected identity from the active label bundle instead of a second target-level expectation snapshot | Reduce drift between target metadata and the label SSOT | `targets.claudeCli` is receipt-oriented only | Claude status/receipt tests |
| Fake Claude harness | `test/cli.test.js` | `installFakeClaude` | Reads only `.claude/.credentials.json`; returns null email/org by default | Teach the fake CLI to read `.claude.json.oauthAccount` as part of native Claude status | Tests must be able to fail on missing bundle parity | Fake Claude status contract matches the real parity story | Entire Claude test block |
| Claude docs | `README.md` | Claude activation section | Documents `.credentials.json`-only projection and bounded backfill from current local file | Rewrite docs around full native bundle projection, explicit reauth requirement for incomplete labels, and no legacy synthetic-only path | Operator docs must match shipped behavior | README becomes native-bundle-first | README review and doc assertions |

## 6.2 Migration notes

- Canonical owner path / shared code path:
  - keep the change in the existing Anthropic + Claude path inside `src/cli.js`
  - do not add a second Claude switcher, a separate native-mode command, or a sidecar migration tool as the steady-state path
- Deprecated APIs (if any):
  - `buildClaudeProjectionFields`
  - `buildClaudeProjectionFieldsFromUsage`
  - `hasClaudeProjectionFields`
  - `hydrateAnthropicCredentialForClaudeLocal` in its current backfill/inference role
  - `target.expectedSubscriptionType` as Claude target SSOT
- Delete list (what must be removed; include superseded shims/parallel paths if any):
  - local-home backfill from the current `~/.claude/.credentials.json`
  - usage-based inference for Claude projection fields
  - `.credentials.json`-only clear path
  - README language that advertises the partial-contract bridge
  - tests that encode `.credentials.json` as the full native contract
- Adjacent surfaces tied to the same contract family:
  - Anthropic label maintenance
  - Anthropic pool eligibility
  - label control panel readiness
  - Claude local readback
  - Claude local projection and clear
  - Claude status, warnings, and receipts
  - README
  - fake Claude harness and Claude tests
- Compatibility posture / cutover plan:
  - clean cutover
  - existing Anthropic labels without a complete native bundle become ineligible and must be reauthed via `aim <label>`
  - do not auto-ingest from the current live `~/.claude` home as a hidden migration bridge
- Capability-replacing harnesses to delete or justify:
  - reject a hand-built `oauthAccount` synthesizer as the primary architecture when native auth already gives AIM the real files to store
  - no extra daemon, launcher, or wrapper is justified for steady-state switching
- Live docs/comments/instructions to update or delete:
  - `README.md`
  - high-leverage comments around the Claude bundle boundary and `~/.claude.json` patch semantics if implementation adds non-obvious invariants
- Behavior-preservation signals for refactors:
  - existing label ranking logic still chooses among the same eligible Claude labels
  - `aim claude use` still remains the public switching command
  - `claude auth status --json` stays the first-party runtime proof for native parity
  - Codex, Pi, and Hermes surfaces remain unchanged

## 6.3 Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope (include/defer/exclude/blocker question) |
| ---- | ------------- | ---------------- | ---------------------- | ------------------------------------- |
| Anthropic maintenance | `src/cli.js` / `refreshOrLoginAnthropic` plus account-maintenance branch | Native Claude bundle capture from auth-time files | Prevents token-only state from surviving as a hidden Claude contract and avoids unnecessary post-auth reconstruction | include |
| Claude local IO | `src/cli.js` / Claude path helpers, readback, write, clear | Dual-file bundle read/write with `oauthAccount` patch semantics | Keeps `.credentials.json` and `.claude.json` in one honest contract family | include |
| Claude eligibility | `src/cli.js` / `derivePoolAccountStatus`, `collectAnthropicPoolStatus`, label panel | Bundle completeness gate for Claude readiness | Prevents eligible/ready drift between panel, pool, and activation | include |
| Claude status | `src/cli.js` / status rows, warnings, receipts | Parity-aware runtime validation including env-token override detection | Prevents false-green Claude status when native files are shadowed or incomplete | include |
| Docs and tests | `README.md`; `test/cli.test.js` | Native-bundle-first contract | Prevents stale operator guidance and blind tests | include |
| Other providers | Codex, Pi, Hermes surfaces | No Claude-native bundle adoption | Different providers and runtime contracts; avoid product creep | exclude |
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: systematic build, foundational first; split Section 7 into the best sequence of coherent self-contained units, optimizing for phases that are fully understood, credibly testable, compliance-complete, and safe to build on later. If two decompositions are both valid, bias toward more phases than fewer. `Work` explains the unit and is explanatory only for modern docs. `Checklist (must all be done)` is the authoritative must-do list inside the phase. `Exit criteria (all required)` names the exhaustive concrete done conditions the audit must validate. Resolve adjacent-surface dispositions and compatibility posture before writing the checklist. Before a phase is valid, run an obligation sweep and move every required promise from architecture, call-site audit, migration notes, delete lists, verification commitments, docs/comments propagation, approved bridges, and required helper follow-through into `Checklist` or `Exit criteria`. The authoritative checklist must name the actual chosen work, not unresolved branches or "if needed" placeholders. Refactors, consolidations, and shared-path extractions must preserve existing behavior with credible evidence proportional to the risk. For agent-backed systems, prefer prompt, grounding, and native-capability changes before new harnesses or scripts. No fallbacks/runtime shims - the system must work correctly or fail loudly (delete superseded paths). If a bridge is explicitly approved, timebox it and include removal work; otherwise plan either clean cutover or preservation work directly. Prefer programmatic checks per phase; defer manual/UI verification to finalization. Avoid negative-value tests and heuristic gates (deletion checks, visual constants, doc-driven gates, keyword or absence gates, repo-shape policing). Also: document new patterns/gotchas in code comments at the canonical boundary (high leverage, not comment spam).

## Phase 1 - Canonical Claude bundle schema and helper boundaries

Status: COMPLETE

Completed work:
- Replaced the token-plus-projection-field model with a canonical `nativeClaudeBundle` plus derived summary fields and bundle-completeness helpers.
- Added explicit helpers for `~/.claude/.credentials.json`, `~/.claude.json`, bundle cloning/normalization, and receipt-only `targets.claudeCli` metadata.
- Removed the target-level subscription snapshot as Claude SSOT.

Goal
- Establish one unambiguous Claude SSOT inside AIM and the helper contracts every later phase will use.

Work
- Replace the projection-field mental model with a canonical stored native bundle plus a derived summary cache and receipt-only target metadata.

Checklist (must all be done)
- Define `credentials.anthropic[label].nativeClaudeBundle` with required `claudeAiOauth` and `oauthAccount` members.
- Define the derived summary fields regenerated from the bundle and make them explicitly non-authoritative:
  - `access`
  - `refresh`
  - `expiresAt`
  - `subscriptionType`
  - `rateLimitTier`
  - `scopes`
  - `emailAddress`
  - `organizationName`
  - `organizationUuid`
- Add or refactor helper boundaries for:
  - `~/.claude/.credentials.json`
  - `~/.claude.json`
  - bundle normalization
  - bundle completeness assertion
- Redefine `targets.claudeCli` as a projection receipt surface carrying `credentialsPath`, `appStatePath`, `activeLabel`, `lastAppliedAt`, and `lastSelectionReceipt`.
- Remove the plan-level dependency on `target.expectedSubscriptionType` as a second Claude expectation store.

Verification (required proof)
- Targeted unit tests for bundle normalization, bundle completeness checks, and Claude path helper behavior.

Docs/comments (propagation; only if needed)
- None in this phase beyond code comments only if a helper contract is non-obvious.

Exit criteria (all required)
- Later phases can consume one concrete stored bundle shape, one concrete summary-cache rule, and one concrete target metadata shape without guessing.
- No planned Claude behavior still depends on a token-only credential record or target-level subscription expectation snapshot as SSOT.

Rollback
- Restore the previous state-file schema usage from backup if the foundational migration logic miswrites local AIM state during implementation.

## Phase 2 - Auth-time native bundle capture on `aim <label>`

Status: COMPLETE

Completed work:
- Replaced local-home backfill and usage-based inference with native-bundle capture from Claude's real auth-bearing files.
- Made label maintenance fail loud when auth finishes without a complete native Claude bundle or when the captured bundle does not match the newly authed token pair.
- Added coverage for successful capture, incomplete-bundle rejection, and stale-label reauth behavior.

Goal
- Make Claude label maintenance store a real native Claude bundle rather than inferred projection fields.

Work
- Keep AIM in charge of Claude label authentication, then capture the native auth-bearing files produced by that auth flow.

Checklist (must all be done)
- Update the Claude account-maintenance path so successful native auth is followed by bundle capture from the auth result files, not by token-only storage.
- Read the auth result's `~/.claude/.credentials.json` and `~/.claude.json` `oauthAccount`, normalize them into `nativeClaudeBundle`, and derive the summary cache from that bundle.
- Prove the captured bundle belongs to the intended label before storing it, using the captured bundle token pair plus readable identity metadata rather than local-home heuristics.
- Fail loud and leave the previously stored Claude bundle untouched when native auth finishes but bundle capture or bundle completeness validation fails.
- Delete local-home backfill from the current `~/.claude/.credentials.json` from the Claude maintenance path.
- Delete usage-based inference for Claude projection fields from the maintenance path.
- Add targeted tests for successful bundle capture, auth-success-but-incomplete-bundle failure, and stale/incomplete-label reauth during account maintenance.

Verification (required proof)
- Targeted integration tests with temporary homes and a controlled Claude auth-file surface that prove AIM stores a complete native bundle or rejects the write.

Docs/comments (propagation; only if needed)
- Add one high-leverage comment at the bundle-capture boundary explaining why AIM stores the native auth files produced at auth time instead of reconstructing them later.

Exit criteria (all required)
- `aim <label>` stores a complete AIM-managed native Claude bundle or fails loudly without partially upgrading the label.
- No Claude account-maintenance path still depends on backfill from the currently active local Claude home or on usage-based inference.

Rollback
- Restore the previous stored Claude bundle from the state backup if bundle capture regresses after a refresh/login attempt.

## Phase 3 - Claude eligibility and operator-readiness cutover

Status: COMPLETE

Completed work:
- Made Claude readiness require a complete `nativeClaudeBundle` in `derivePoolAccountStatus`, Anthropic pool status, and label-panel truth.
- Surfaced incomplete-bundle and usage-based blockers in the no-eligible-label receipt path instead of allowing silent late activation failure.
- Added tests for ready vs incomplete Claude labels and blocked Claude selection.

Goal
- Make every Claude readiness surface agree that incomplete native bundles are not eligible for switching.

Work
- Push bundle-completeness gating into Anthropic pool status and operator-facing panel logic before activation time.

Checklist (must all be done)
- Update `derivePoolAccountStatus` for Anthropic labels so Claude readiness requires both fresh token state and a complete native bundle.
- Update `collectAnthropicPoolStatus` so incomplete Claude bundles are not eligible candidates.
- Update the label control panel path so incomplete Claude bundles show reauth-required truth instead of ready truth.
- Ensure the no-eligible-label path and related receipts surface incomplete Claude bundles as the reason selection cannot proceed.
- Add targeted tests for:
  - eligible Claude label with complete bundle
  - fresh-token Claude label with incomplete bundle
  - label panel rendering for incomplete bundle
  - no-eligible-label selection when all Claude bundles are incomplete

Verification (required proof)
- Targeted pool-status and panel-state tests that prove incomplete bundles are blocked before `aim claude use` selection.

Docs/comments (propagation; only if needed)
- None unless panel logic ends up needing one sharp edge comment for Claude-specific readiness rules.

Exit criteria (all required)
- A Claude label with fresh tokens but no complete native bundle cannot be shown as ready, cannot be selected, and cannot silently fail later in activation.
- Operator-facing readiness surfaces and pool-selection surfaces agree on the same Claude eligibility rule.

Rollback
- Restore the previous readiness logic only together with the corresponding code rollback if gating proves overly restrictive before merge.

## Phase 4 - Dual-file Claude projection, readback, and clear path

Status: COMPLETE

Completed work:
- Cut `aim claude use` over to projecting both `~/.claude/.credentials.json` and `~/.claude.json` `oauthAccount`, with dual-file readback.
- Updated the clear/block path to remove only Claude auth-bearing state while preserving unrelated `~/.claude.json` settings.
- Added tests for dual-file projection, key preservation, and clear behavior.

Goal
- Make `aim claude use` own both Claude auth-bearing local surfaces and preserve unrelated Claude app state.

Work
- Cut over activation from token-file projection to full dual-file native bundle projection plus bundle-aware readback.

Checklist (must all be done)
- Add a dual-file local bundle reader that reads both `.credentials.json` and `.claude.json.oauthAccount`.
- Add a writer for `.credentials.json` from `nativeClaudeBundle.claudeAiOauth`.
- Add an `oauthAccount` patcher for `~/.claude.json` that preserves unrelated top-level Claude settings.
- Add an `oauthAccount` remover for `~/.claude.json` so clear/block behavior removes only the auth-bearing key.
- Update `applyClaudeCliFromState` to:
  - assert bundle completeness
  - write `.credentials.json`
  - patch `oauthAccount`
  - read back both files
  - record `credentialsPath` and `appStatePath`
- Update `clearManagedClaudeCliActivation` to delete `.credentials.json` and remove only `oauthAccount` from `~/.claude.json`.
- Update `getAnthropicCredentialMatchLabel` and related readback matching to use the canonical bundle token pair.
- Add targeted tests for:
  - successful dual-file projection
  - clear behavior
  - preservation of unrelated `~/.claude.json` keys
  - readback mismatch or missing-surface failure

Verification (required proof)
- Isolated-home integration tests proving `aim claude use` writes both auth surfaces, preserves unrelated app-state keys, and clears only the Claude auth-bearing keys when blocked or reset.

Docs/comments (propagation; only if needed)
- Add concise comments at the `~/.claude.json` patch/remove boundary if the preservation rule is not obvious from the code.

Exit criteria (all required)
- `aim claude use` projects a complete native Claude login across both local auth surfaces or fails loudly.
- The clear/block path removes Claude auth state without clobbering unrelated `~/.claude.json` settings.
- Readback can no longer claim success from `.credentials.json` alone.

Rollback
- Reproject the previously stored known-good Claude bundle for the active label and restore the prior app-state snapshot if the dual-file write path regresses during testing.

## Phase 5 - Parity-aware status, warnings, receipts, and test harness

Status: COMPLETE

Completed work:
- Updated Claude target status, warnings, receipts, and CLI rendering to reason about both local auth files and the active label bundle rather than a stored subscription snapshot.
- Added env-token-shadowing detection and warnings for missing or mismatched native Claude identity surfaces.
- Expanded the fake Claude harness to model `.claude.json` and auth-method overrides so tests can fail the same way the real CLI does.

Goal
- Make Claude status surfaces report real native parity instead of token-only success.

Work
- Align runtime status parsing, local readback, receipts, warnings, CLI text output, and the fake Claude harness to the full native bundle contract.

Checklist (must all be done)
- Update `readClaudeAuthStatus`, `readClaudeCliTargetStatus`, and `buildWarningsFromClaudeTargetStatus` to compare runtime status against the active label bundle rather than against a target-level subscription snapshot.
- Expose both projected paths in Claude target status and CLI text output.
- Add warnings for:
  - missing `oauthAccount`
  - email mismatch
  - organization mismatch
  - subscription mismatch
  - unreadable local auth surfaces
  - env-token override or other non-native auth precedence shadowing the projected native files
- Remove dependence on `target.expectedSubscriptionType` from status truth.
- Update the fake Claude harness in `test/cli.test.js` to read `.claude.json.oauthAccount` and simulate parity-degraded or shadowed-auth states needed by tests.
- Add targeted tests for clean native parity, missing `oauthAccount`, identity mismatch, and env-token shadowing.

Verification (required proof)
- Targeted status and warning tests plus isolated-home status checks that prove Claude status cannot stay green when native parity is broken or shadowed.

Docs/comments (propagation; only if needed)
- None unless one compact comment is needed to explain why env-token precedence is treated as a parity failure for `aim claude use`.

Exit criteria (all required)
- Claude status, receipts, and warnings cannot report clean native parity when runtime auth is incomplete, mismatched, or shadowed by env-token auth.
- Fake-Claude tests can fail for the same parity gaps the real CLI exhibits.

Rollback
- Revert the parity-aware status layer only together with the same code rollback if it proves incorrect before merge; do not keep the new projection path with an old false-green status layer.

## Phase 6 - Hard cutover cleanup, docs, and end-to-end parity proof

Status: BLOCKED

Completed work:
- Deleted the legacy projection-field bridge, rewrote the README around native bundle capture plus dual-file projection, and updated Claude tests to the native-bundle-first contract.
- Verified `npm run lint` and `npm test` both pass after the cutover.
- Ran isolated-home parity smokes with the installed Claude CLI: `.credentials.json` alone leaves `claude auth status --json` with `email: null` and `orgName: null`, while full-bundle projection restores `email`, `orgName`, and `subscriptionType`.
- Ran a real local projection smoke with the installed Claude CLI: projected temp-home auth reports `loggedIn: true`, `authMethod: "claude.ai"`, `email: "aelaguiz@gmail.com"`, `orgName: "Amir Elaguizy"`, and `subscriptionType: "max"`.
- Confirmed the live selector receipt now reports `usage_unavailable` truthfully when Claude usage probing cannot establish an eligible label.

Blocked on:
- A real operator-state label-switch smoke is not yet possible on this machine: `~/.aimgr/secrets.json` currently contains one Anthropic label (`claudalyst`), and it does not yet have a stored `nativeClaudeBundle` under the new contract.
- The live `aim claude use` selector still requires a successful Claude usage probe before it will activate a label, and the current local probe path returns `usage_unavailable`.

Goal
- Delete the synthetic-only Claude story, sync live docs, and prove the final native cutover works end to end.

Work
- Finish the clean cutover by removing obsolete bridge logic, updating operator docs, and running the final proof set.

Checklist (must all be done)
- Delete the legacy projection-field bridge helpers and any remaining code paths that rely on:
  - local-home backfill
  - usage-based inference
  - `.credentials.json`-only parity assumptions
  - `target.expectedSubscriptionType` as Claude SSOT
- Rewrite the README Claude activation guidance around:
  - native Claude bundle capture on `aim <label>`
  - dual-file projection on `aim claude use`
  - explicit reauth requirement for incomplete Claude labels
  - no equivalence between env-token auth and native Claude login parity
- Update Claude tests to assert the native-bundle-first contract end to end.
- Run the targeted Claude test suite covering maintenance, eligibility, projection, clear behavior, status, warnings, and docs-adjacent expectations.
- Run isolated-home parity smoke checks that demonstrate the difference between `.credentials.json`-only projection and full-bundle projection.
- Run a real local label-switch smoke check on this machine with `claude auth status --json`.
- Confirm Codex, Pi, and Hermes flows remain unaffected by the Claude-only cutover.
- Add any final high-leverage Claude-boundary comments required for long-term readability.

Verification (required proof)
- Targeted Claude test suite updates, isolated-home parity smoke checks, and a real local `claude auth status --json` label-switch smoke check.

Docs/comments (propagation; only if needed)
- Update `README.md`.

Exit criteria (all required)
- The shipped Claude path contains no synthetic-only parity bridge and no `.credentials.json`-only success path.
- Operator docs match the shipped native Claude behavior exactly enough to operate the feature without folklore.
- The proof set is strong enough to claim native parity for ordinary local Claude Code use.
- Non-Claude provider flows remain unaffected.

Rollback
- Reproject the previously stored known-good Claude bundle for the active label and roll the code/docs back before merge if the final proof set fails.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

## 8.1 Unit tests (contracts)

- Claude bundle normalization and completeness validation.
- Claude app-state patch/remove helpers that preserve unrelated `~/.claude.json` keys.
- Anthropic eligibility and label-panel gating for incomplete Claude bundles.
- Claude target warning behavior for missing `oauthAccount`, identity mismatch, subscription mismatch, and env-token shadowing.

## 8.2 Integration tests (flows)

- `aim <label>` native bundle capture and ingest from auth-time files.
- `aim claude use` projection and clear behavior inside an isolated `HOME`.
- `aim status` / Claude status surfaces after projection and under shadowed-auth conditions.

## 8.3 E2E / device tests (realistic)

- Real local `claude auth status --json` smoke after switching labels on this machine.
- One real Claude-label auth capture on this machine if needed to prove AIM can ingest the native auth files the installed Claude build produces.
- Optional manual Remote Control parity spot-check on one eligible label if the account supports it; not blocking for the cutover if the core native parity proof is already strong.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

- Ship as a hard cutover for the Claude path in this repo.
- Existing Claude labels that do not yet have a complete native bundle must be re-captured before they can be switched natively.

## 9.2 Telemetry changes

- No new telemetry system is required.
- Claude receipts and status should carry enough local truth to explain why a label is eligible, ineligible, or parity-degraded.

## 9.3 Operational runbook

- Maintain a Claude label through `aim <label>`.
- Switch the active local Claude account through `aim claude use`.
- Verify the active local identity with `claude auth status --json`.
- If a label is incomplete, fail loud and re-capture its native bundle instead of projecting partial auth.

# 10) Decision Log (append-only)

## 2026-04-17 - Do not rely on Claude CLI refresh-token provisioning to recreate native bundle state

Context
- On this machine, `claude auth login --claudeai` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and the current native scopes returns HTTP 400 instead of materializing a fresh native login bundle.
- `CLAUDE_CODE_OAUTH_TOKEN` authenticates the CLI, but `claude auth status --json` reports `authMethod: "oauth_token"`, which is explicitly not the native Claude parity target for `aim claude use`.

Options
- Ask Claude CLI to regenerate native auth files later from a stored refresh token.
- Treat env-token auth as equivalent to native Claude login for switching.
- Store and reproject the native files AIM actually captured from a real Claude login, and treat env-token auth as shadowing or testing-only.

Decision
- AIM stores and reprojects native Claude login files directly. It does not depend on Claude CLI refresh-token provisioning or env-token auth to recreate native parity later.

Consequences
- First-time native bundle capture requires real local Claude auth files for the intended label.
- Env-token auth must stay a warning or parity-failure surface for `aim claude use`, not a success path.
- The switching path remains a file shuffle, not a token-to-native regeneration flow.

## 2026-04-17 - File-first bundle capture supersedes post-auth regeneration

Context
- Native Claude authentication already gives AIM the two auth-bearing surfaces it actually needs to switch later.
- Runtime probes proved that projecting those captured surfaces directly restores full identity, and patching only `oauthAccount` preserves unrelated `.claude.json` settings.
- Asking Claude to regenerate native files later from tokens adds an unnecessary reconstruction path that the switching flow does not need.

Options
- Hand-synthesize `oauthAccount` from Claude-side API calls and local heuristics.
- Auto-ingest from the current live `~/.claude` home as a hidden migration bridge.
- Capture the native auth-bearing files at auth time, store that bundle in AIM, and later reproject it during switching.

Decision
- Capture the native auth-bearing files at auth time, store them as the Claude label bundle, and use later switching only to reproject that bundle.

Consequences
- AIM's stored Claude truth is tied directly to the real native Claude files that auth already produced.
- Existing partial Claude labels must be reauthed instead of silently upgraded from the live home.
- Claude switching stays simple: AIM shuffles the stored native bundle rather than rebuilding it later.

## 2026-04-17 - Native Claude parity is the target contract

Context
- The repo already has `aim claude use`, but the current local Claude projection only owns `~/.claude/.credentials.json`.
- Local runtime probes showed that full native identity parity also depends on `~/.claude.json` `oauthAccount`.

Options
- Keep the current synthetic-only projection and accept degraded native parity.
- Add a second Claude command or mode for "native" switching.
- Cut over the existing Claude path to a native-Claude-bundle model and make `aim claude use` the one switching command.

Decision
- Cut over the existing Claude path to a native-Claude-bundle model and keep `aim claude use` as the one operator command.

Consequences
- AIM must store more Claude-native metadata than it does today.
- Existing Claude labels may need a one-time native bundle capture before they can be switched under the new contract.
- The repo can delete the synthetic-only Claude parity story instead of preserving it.

Follow-ups
- Confirm this North Star before deeper planning.
- During research and deep-dive, settle the precise AIM state shape and label-capture mechanics.

<!-- arch_skill:block:implementation_audit:start -->
# Implementation Audit (authoritative)
Date: 2026-04-17
Verdict (code): COMPLETE
Manual QA: pending (non-blocking)

## Code blockers (why code is not done)
- None.

## Reopened phases (false-complete fixes)
- None.

## Missing items (code gaps; evidence-anchored; no tables)
- No code gaps found in the approved frontier.
  - Evidence anchors:
    - `src/cli.js:3714`
    - `src/cli.js:3778`
    - `src/cli.js:4139`
    - `src/cli.js:4213`
    - `src/cli.js:6129`
    - `src/cli.js:8129`
    - `src/cli.js:8377`
    - `src/cli.js:8593`
    - `test/cli.test.js:6560`
    - `test/cli.test.js:6693`
    - `test/cli.test.js:6863`
    - `test/cli.test.js:6953`
    - `README.md:360`

## Non-blocking follow-ups (manual QA / screenshots / human verification)
- Run the real local Claude label-switch smoke on a machine with at least two live Claude labels and confirm `claude auth status --json` flips identity without a fresh browser login.
- If you want an end-to-end host receipt set, recapture a second Claude label under the native bundle contract and rerun the live smoke there.
<!-- arch_skill:block:implementation_audit:end -->
