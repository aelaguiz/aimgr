---
title: "AIM - Combined Claude and Codex OAuth Maintainer - Architecture Plan"
date: 2026-07-24
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: architectural_change
related:
  - docs/CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md
  - docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
---

# TL;DR

- **Outcome:** Dormant Claude and Codex accounts in AIM Redis refresh before
  ordinary access-token expiry. If refresh is conclusively impossible, `aim
  status` says reauthentication is required.
- **Problem:** Refresh currently happens only when an account is launched or
  manually logged in, so unused accounts age out.
- **Approach:** Add one short-lived `aim auth maintain` command. It reuses the
  existing managed Claude run and adds one small, browser-free Codex refresh
  function. A macOS LaunchAgent runs the command every minute on
  `amirs-m3-max-new`.
- **Plan:** First build and prove the one-shot locally. Then install one
  LaunchAgent on the M3 and verify two scheduled passes.
- **Non-negotiables:** Redis stays authoritative; no Keychain, browser, model
  call, direct Anthropic OAuth, resident daemon, configurable policy, generic
  scheduler, or unrelated cleanup.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
research: complete (2026-07-24)
deep_dive_pass_1: complete (2026-07-24)
phase_plan: complete (2026-07-24)
north_star_confirmation: confirmed (2026-07-24)
recommended_flow: confirm North Star -> implement -> audit implementation
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

When the M3 is awake and Redis is reachable, no complete, refreshable Claude or
Codex record should require manual login merely because it sat unused.

One `aim auth maintain` invocation must inspect every loaded Claude and Codex
record, refresh only due records, never open a browser or use Keychain, never
overwrite a newer Redis version, and leave a conclusive dead-refresh-token case
visible as `reauth_required`.

## 0.2 In scope

- One inherently one-shot command: `aim auth maintain`.
- Every loaded Claude and Codex credential record in Redis.
- Fixed due windows:
  - Claude: five minutes remaining, because that is the official client's
    native proactive-refresh window.
  - Codex: 48 hours remaining.
- Already-expired records remain eligible when refresh material is complete.
- Claude refresh through the existing contained, file-only official client
  path with the proven no-model `/usage` arguments.
- Codex refresh through one small headless token-refresh function with an
  eight-second HTTP timeout and no browser fallback. It returns a credential,
  throws one exact `invalid_grant` sentinel, or throws an ordinary transient
  error; there is no result taxonomy.
- Existing Redis leases/CAS and identity checks.
- One exact `oauth_reauth_required` marker in the existing reauth policy field,
  shown truthfully by `aim status` and cleared by successful manual login.
- One macOS LaunchAgent on `amirs-m3-max-new`, running every 60 seconds.
- Compatibility posture: the new command is additive. Existing `aim claude
  run`, `aim login`, `aim status`, and account-selection behavior remain
  unchanged except that status recognizes the new terminal marker.

## 0.3 Out of scope

- Direct Anthropic refresh-token code.
- Keychain access, browser automation, unattended login, CAPTCHA work, or
  automatic reauthentication.
- A resident Node daemon, queue, worker pool, service API, retry framework, or
  generalized scheduler/installer framework.
- New Redis keys or a credential-schema migration.
- Configuration for cadence, thresholds, concurrency, or providers.
- Parallel refresh, notifications, metrics infrastructure, or alerting.
- Linux/systemd, additional machines, fleet publication, or remote cleanup.
- Usage balancing, account selection, Tend, sessions, or status redesign.
- Refactoring the generic lease, fetch, Claude runner, or existing watch
  installer merely for architectural neatness.
- Tests for every hypothetical malformed response or lifecycle edge.

## 0.4 Definition of done (acceptance evidence)

- Two providers can be handled in one local one-shot using injected records:
  due Claude and Codex records refresh; fresh records do not call a provider.
- Claude maintenance invokes the existing managed lifecycle with the exact
  proven `/usage` arguments and a 30-second deadline.
- Codex maintenance performs no browser action, times out after eight seconds,
  validates the same account ID, and CAS-publishes only a complete successor.
- Missing refresh material or exact terminal evidence becomes
  `reauth_required`; network, timeout, 5xx, and unknown errors do not.
- A successful manual login clears the terminal marker.
- Focused tests, the existing full suite, and lint pass locally.
- The LaunchAgent installer validates its plist before loading; one manual run
  plus two distinct scheduled runs finish on the M3 and leave readable logs
  plus correct Redis/status state.

### Scope and Simplicity Contract

- **Human-authorized outcome:** Keep AIM-managed Claude and Codex OAuth
  credentials alive automatically; truthfully identify accounts that really
  need manual login.
- **Authorization anchors:** The 2026-07-24 request for combined refresh
  control and a daemon on the M3, followed by the explicit instruction to
  produce the simplest reliable Mini Arc Step plan and avoid NASA-grade work.
- **Smallest sufficient solution:** One one-shot command, one tiny Codex
  refresh helper, reuse of the existing Claude run, one existing-policy marker,
  and one focused LaunchAgent script.
- **Initial minimal convergence closure:** None. This is an additive scheduled
  owner; no existing refresh owner competes while accounts are dormant.
- **Scope freeze:** Confirmed by Amir on 2026-07-24 before the first code edit.
- **Enough proof:** Focused command/provider/marker tests, the existing full
  suite/lint, one contained Claude integration proof through the new command,
  and two real scheduled passes on the M3.
- **Do not build:** Generic lease/heartbeat extraction, shared cancellation
  framework, generalized watch installer, configurable policy, structured
  receipt subsystem, retry database, exhaustive error taxonomy, notification
  system, extra daemon, or second test harness.
- **Residual risk accepted by this plan:** Host sleep or network outage can
  temporarily cross an access expiry; the next available pass attempts the
  still-stored refresh lineage. A rare concurrent manual Codex login may lose
  its optimistic CAS and require one rerun, but cannot overwrite newer Redis
  credentials.

## 0.5 Key invariants (fix immediately if violated)

- Redis is the only credential source of truth.
- Refresh work is serial.
- Claude's existing lease/fence/publication lifecycle remains its sole owner.
- Codex refresh finishes inside one existing 30-second lease: eight-second
  HTTP timeout, identity validation, one final lease renewal, then CAS.
- No terminal marker is written from status code alone, error text, timeout,
  network failure, or 5xx response.
- No model inference, browser, or Keychain access occurs.
- A failure for one label does not stop later labels.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Prevent ordinary inactivity from expiring recoverable accounts.
2. Keep implementation and operations small enough to understand immediately.
3. Never corrupt or overwrite a rotating credential lineage.
4. Show the operator when manual login is genuinely required.

## 1.2 Constraints

- Claude 2.1.218 normally refreshes only at five minutes or less remaining.
  Therefore the scheduler must run more often than five minutes.
- Claude refresh must remain in the official client; AIM does not own
  Anthropic's OAuth protocol.
- The current Codex library hides useful refresh error details and can fall
  through to browser login, so the scheduled path needs a small separate
  refresh-only request.
- The M3 is the only deployment host in this plan.

## 1.3 Architectural principles (rules we will enforce)

- Reuse before abstracting.
- Bound provider calls with existing process/HTTP mechanisms.
- Validate identity and current Redis version immediately before publication.
- Treat only conclusive evidence as reauthentication work.
- Keep cadence and thresholds as constants; there is no configuration surface.

## 1.4 Known tradeoffs (explicit)

- The one-minute job may retry a transiently failing due record every minute.
  This is intentionally simpler than adding persistent backoff state.
- There is no notification system. The operator sees terminal state through
  the existing `aim status`.
- LaunchAgent logs are ordinary bounded command output, not a new receipt or
  telemetry format.
- Availability depends on the M3 being awake and connected.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

- `aim claude run <label>` safely projects a Redis Claude credential, runs the
  official client, and publishes a rotated successor under a Redis lease/fence.
- `aim login <label>` tries Codex refresh first and then falls through to
  interactive OAuth.
- Status passively reports credentials; it does not keep them alive.

## 2.2 What's broken / missing (concrete)

No process owns dormant OAuth lifetime. Claude access tokens last about eight
hours and Codex tokens about ten days, so unused Redis records cross access
expiry even while their refresh tokens may still work.

## 2.3 Constraints implied by the problem

The missing component is scheduling, not another credential system. The
solution must call the two existing provider authorities, publish back to the
same Redis records, and distinguish terminal refresh death from a temporary
provider failure.

# 3) Research Grounding (external + internal "ground truth")

<!-- arch_skill:block:research_grounding:start -->

## 3.1 External anchors (papers, systems, prior art)

No external architecture is needed. The relevant provider behavior was tested
directly:

- Two real expired Claude lineages (`boss`, `pro8`) refreshed and advanced
  independently.
- Two still-valid synthetic Claude lineages rotated through the official
  client at T-4 minutes.
- Two real still-valid Codex lineages (`growth`, `lessons`) refreshed without a
  browser.

Full evidence is in
`docs/CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md`.

## 3.2 Internal ground truth (code as spec)

- `src/cli/commands/claude.js`: canonical Claude lease, fence, projection,
  official-client run, rotation publication, and cleanup.
- `src/targets/claude-runner.js`: already accepts an abort signal and kills the
  supervised client; it does not need a new maintenance API.
- `src/cli/commands/auth.js`: existing namespace for the new one-shot.
- `src/credentials/codex-login.js`: canonical Codex OAuth behavior and the
  narrow home for a refresh-only helper.
- `src/credentials/jwt.js`: existing Codex account-ID extraction.
- `src/io/fetch.js`: existing eight-second bounded JSON fetch injected into CLI
  handlers.
- `src/coordination/redis-credential-lease.js` and
  `src/coordination/login-publish.js`: existing lease and CAS publication.
- `src/pool/account-status.js` and `src/status/claude-redis-view.js`: existing
  status owners that must recognize the terminal marker.

Canonical owner paths:

- Claude refresh remains `handleRedisClaudeRun`.
- Codex interactive login remains `refreshOrLoginCodex`.
- Scheduled Codex refresh is a small refresh-only sibling in the same module;
  it does not change interactive OAuth.

## 3.3 Decision gaps that must be resolved before implementation

None in the architecture. Implementation is gated only on Amir confirming the
draft North Star and Scope and Simplicity Contract.

<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->

## 4.1 On-disk structure

The relevant code already lives in CLI command, credential, Redis coordination,
status, and script modules. There is no OAuth-maintenance command or scheduler
artifact today.

## 4.2 Control paths (runtime)

```text
Claude: explicit aim claude run -> official client -> Redis publish
Codex:  explicit aim login      -> refresh -> browser fallback -> Redis publish
Dormant account                 -> no owner -> access token expires
```

## 4.3 Object model + key abstractions

Redis credential records already contain provider, label, credential,
identity, version, and reauth policy. No new model is needed.

## 4.4 Observability + failure behavior today

Status shows expiry, but expiry alone cannot say whether the stored refresh
lineage still works. There is no scheduled attempt or terminal refresh marker.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No new UI. The existing status table gains one truthful state:

```text
account  state
pro8     reauth_required
```

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->

## 5.1 On-disk structure (future)

- Modify the existing auth, Claude, Codex-login, credential-publication, and
  status modules.
- Add one Mac-only `scripts/install-auth-maintainer.sh`.
- Add focused tests beside the existing CLI/status tests.
- Do not add a daemon module, generic scheduler, new Redis module, or new
  provider abstraction.

## 5.2 Control paths (future)

```text
LaunchAgent every 60s
  -> aim auth maintain
     -> load Redis roster once
     -> due labels, sorted by expiry then provider/label
     -> process serially

        Claude:
          call existing managed run with fixed /usage arguments
          abort after 30s through its existing signal path
          existing lease/fence/CAS owns publication and cleanup

        Codex:
          acquire existing 30s credential lease
          reload/recheck record
          POST refresh grant through existing 8s bounded fetch
          validate complete tokens and same accountId
          renew once, CAS-publish, release

     -> print a short counts summary and exit
```

## 5.3 Object model + abstractions (future)

- No new schema or Redis key.
- Terminal marker:
  `policy.reauth.blockedReason = "oauth_reauth_required"`.
- Terminal evidence:
  - missing/incomplete refresh material;
  - Codex JSON response with exact `error: "invalid_grant"`;
  - Claude's exact post-run missing-token shape only after a verified complete
    pre-run bundle and a clean official-client exit.
- Everything else remains retryable and does not set the marker.

## 5.4 Invariants and boundaries

- Fresh, policy-only, and terminally marked records make no provider request.
- One label is attempted at most once per invocation.
- A busy lease is skipped, not treated as failure.
- Codex does not need a heartbeat because its eight-second request deadline is
  well inside the existing 30-second lease; it renews once before publication.
- Successful manual login clears only the exact terminal marker.
- Normal interactive commands retain their existing behavior.

## 5.5 UI surfaces (ASCII mockups, if UI work)

```text
$ aim auth maintain
refreshed=2 unchanged=0 reauth_required=1 failed=0 skipped=11
```

`aim status` remains the primary detailed view.

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
|---|---|---|---|---|---|---|---|
| Orchestration | `src/cli/commands/auth.js` | `handleAuth` | Only `auth write hermes` | Add `auth maintain`: due selection, serial dispatch, summary, continue after label failure | Missing scheduled owner | `aim auth maintain` | Focused auth command tests |
| Claude | `src/cli/commands/claude.js` | `handleRedisClaudeRun` | Interactive args, no maintenance deadline, and signal/exit propagation appropriate to an interactive parent | Expose a narrow internal call with fixed `/usage` args and a 30s abort timer; return a bounded outcome instead of setting the process exit or re-signaling the maintainer | Reuse the proven owner without terminating later-label work | Internal maintenance options only | Existing Claude run tests plus one focused maintenance case |
| Codex | `src/credentials/codex-login.js` | New refresh-only helper | Existing helper can open a browser and hides terminal detail | Add one bounded refresh-grant function using injected bounded fetch and existing JWT identity extraction | Headless scheduled refresh | Credential success; exact `invalid_grant` sentinel; all other errors throw transiently | Three focused result cases |
| Publication | `src/cli/commands/auth.js` | Codex provider branch | None | Lease, reload, same-account validation, renew, existing CAS publish, release | Prevent stale overwrite | Existing lease and publication APIs | Auth command integration test |
| Marker clearing | `src/coordination/login-publish.js` | `publishMaintainedCredential` | Successful publication copies existing reauth policy unchanged | Remove only the exact terminal marker when publishing a complete credential | Every successful repair path must restore ready state | Existing publication API | Publication test |
| Status | `src/pool/account-status.js`; `src/status/claude-redis-view.js` | terminal-state derivation | Generic expiry/blocking only | Map exact marker to `reauth_required` before generic expiry/blocking | Truthful operator action | Existing policy field | One status test per provider view |
| Scheduling | `scripts/install-auth-maintainer.sh` | New focused script | No job | Install or uninstall one user LaunchAgent with a fixed 60s command; validate the rendered plist before loading | Operate on M3 without generalizing watch installer | `com.funcountry.aimgr.auth-maintainer` | `bash -n`; real `plutil`/launchctl proof on M3 |
| UX truth | `src/cli/help.js` | auth/help section | Command absent | Document the one-shot command | Discoverability | No behavioral API | Existing help test if affected |

Explicit non-call-sites: `src/coordination/redis-credential-lease.js`,
`src/io/fetch.js`, `src/targets/claude-runner.js`,
`src/targets/claude-supervisor.js`, and `scripts/lib/watch-install.sh` stay
unchanged.

## 6.2 Migration notes

- Additive command and marker interpretation; no credential migration.
- No delete list.
- Existing records become eligible automatically.
- Existing interactive commands preserve their contracts.
- Exact marker clearing lives at the existing successful publication boundary,
  not in provider-specific login code.
- The old, unapproved generalized-plan machinery was removed from this plan;
  it is not deferred work.

<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: depth-first implementation protects the frozen destination while proving the path early. The destination map is the human-authorized outcome plus the initial minimal convergence closure recorded before implementation and any later explicit human approval. The expansion map only sequences that frozen breadth; workers and reviewers cannot add callers, variants, modes, guarantees, proof categories, or adjacent cleanup. Section 7 chooses the first working slice through the canonical owner path and highest-risk seam, then advances through already-authorized axes. Phase boundaries are proof gates, and phase count follows real dependency, proof, reversibility, migration, or user-review boundaries. `Work` is explanatory; `Checklist (must all be done)` and `Exit criteria (all required)` hold every required obligation. Refactors and consolidations preserve behavior with proportionate evidence. Prefer prompt, grounding, and native capability before new agent tooling. No fallback or runtime shim exists without explicit approval and removal work. Prefer focused programmatic checks, defer manual/UI verification to finalization, and avoid deletion proofs, visual constants, doc gates, keyword/absence gates, and repo-shape policing.

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 - Build and prove the one-shot locally

**Status:** COMPLETE

### Goal

Produce one real `aim auth maintain` invocation that safely handles the full
Redis roster without adding a background framework.

### Work

Add the command, reuse Claude's existing lifecycle, add the bounded Codex
refresh-only helper, converge the terminal marker, and create the focused
LaunchAgent installer.

### Checklist (must all be done)

- [x] Add fixed due selection and deterministic serial processing to
  `handleAuth`; continue after a per-label failure.
- [x] Add the narrow Claude maintenance entry using the exact proven arguments
  and a 30-second abort timer; return an outcome instead of propagating a child
  signal/exit to the maintainer; preserve ordinary `aim claude run`.
- [x] Add the eight-second, browser-free Codex refresh helper: credential on
  success, exact `invalid_grant` sentinel, and ordinary transient throw for
  every other failure.
- [x] Publish Codex under the existing 30-second lease and existing CAS; skip a
  busy label.
- [x] Set the exact terminal marker only for the three terminal cases in
  Section 5.3; leave other failures retryable.
- [x] Clear only the exact marker in `publishMaintainedCredential` and render
  `reauth_required` in both existing status views.
- [x] Add the focused Mac LaunchAgent script without touching the generic watch
  installer; support only install and `--uninstall`.
- [x] Add only the focused proofs in Section 8; reuse existing fixtures and the
  existing Claude native lab.
- [x] Remove any implementation change that touches an explicit non-call-site
  from Section 6 or adds a new concept outside Section 0.

### Verification (required proof)

- Focused command, Codex result, marker/status, and installer tests pass.
- One contained Claude T-4-minute fixture runs through `aim auth maintain`
  using the existing native lab.
- `npm test`, `npm run lint`, and `git diff --check` pass.

### Docs/comments (propagation; only if needed)

Update CLI help with the one-shot command. Do not add another design doc or
broaden the README.

### Exit criteria (all required)

- [x] One local invocation handles due Claude and Codex records serially.
- [x] Fresh and terminal records make no provider request.
- [x] Claude uses no Keychain/model/browser and leaves no fence/projection
  residue after a conclusive result.
- [x] Codex cannot open a browser and cannot publish after lease/CAS loss.
- [x] Status distinguishes terminal reauth from transient failure.
- [x] Existing interactive command tests and the full suite remain green.
- [x] No M3 mutation has occurred.

### Rollback

Revert the additive command, helper, marker rendering, and installer script.
Existing interactive paths remain the unchanged fallback during development.

## Phase 2 - Install the one LaunchAgent on M3

**Status:** COMPLETE

### Goal

Run the proven one-shot every minute on `amirs-m3-max-new`.

### Work

Deploy the exact reviewed main commit, run one manual pass, install the
LaunchAgent, and verify two distinct scheduled passes.

### Checklist (must all be done)

- [x] Commit and push the Phase 1 implementation to main.
- [x] Update `/Users/aelaguiz/workspace/aimgr` on
  `amirs-m3-max-new` to that exact commit.
- [x] Verify canonical `aim`, Node, Redis connectivity, and writable
  `~/.aimgr/logs`.
- [x] Run `aim auth maintain` once manually and inspect Redis/status outcomes.
- [x] Install `com.funcountry.aimgr.auth-maintainer` as the logged-in user with
  `StartInterval=60`.
- [x] Verify `launchctl` status and two distinct subsequent scheduled log
  entries.
- [x] Confirm no browser, Keychain prompt, model turn, cross-label write, or
  stuck process occurred.

### Verification (required proof)

- The manual run and two distinct scheduled runs finish.
- The later scheduled runs skip newly fresh labels.
- `aim status` shows ready, transient, or `reauth_required` truthfully.
- `launchctl print gui/$UID/com.funcountry.aimgr.auth-maintainer` shows the
  loaded job.

### Docs/comments (propagation; only if needed)

Record only the exact installed command and uninstall command in README.

### Exit criteria (all required)

- [x] Exactly one auth-maintainer LaunchAgent is loaded on the M3.
- [x] The job runs every minute and exits; no resident AIM process remains.
- [x] Redis contains only expected per-label successor writes.
- [x] Manual reauthentication remains the existing `aim login <label>` UX.

### Rollback

Run the installer's `--uninstall`. This stops recurrence without changing
credentials or removing the manual `aim auth maintain` command.

<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; evidence planning)

Keep the proof set lean: prove the demonstrated failure, the successful path,
and the one important publication boundary. Do not build another harness.

## 8.1 Unit tests (contracts)

1. Due selection: fresh records skip; due Claude and Codex records dispatch
   once in deterministic serial order.
2. Codex classification: success produces a same-account credential;
   `invalid_grant` is terminal; one representative network failure is not.
3. Marker/status: terminal marker renders `reauth_required` and successful
   login clears it.

## 8.2 Integration tests (flows)

- One command test with fake Redis proves serial continuation and CAS refusal.
- One existing native-lab Claude fixture proves the command uses the exact
  no-model `/usage` vector and publishes the rotation.
- Run `bash -n` on the focused installer locally; the installer itself runs
  `plutil -lint` on the rendered plist before loading it on the M3.
- Run the existing full suite and lint for preservation.

## 8.3 E2E / device tests (realistic)

On the M3 only after Phase 1 passes:

- one manual invocation;
- two distinct scheduled invocations;
- read-only Redis and `aim status` verification;
- `launchctl` process/status verification.

No browser, Keychain, model, Linux VM, or extra account migration enters this
proof.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

Local code and proof first; exact main commit on M3 second; manual pass before
install; two scheduled passes before handoff.

## 9.2 Telemetry changes

No telemetry system. The command prints counts, LaunchAgent captures stdout and
stderr under `~/.aimgr/logs`, and `aim status` owns operator truth.

## 9.3 Operational runbook

```text
aim auth maintain
bash scripts/install-auth-maintainer.sh
launchctl print gui/$UID/com.funcountry.aimgr.auth-maintainer
bash scripts/install-auth-maintainer.sh --uninstall
aim login <label>              # only when status says reauth_required
```

If Redis or the network is down, restore it and let the next minute retry. Do
not manually delete credentials or markers.

# 10) Decision Log (append-only)

## 2026-07-24 - North Star confirmed; implementation authorized

- **Context:** Amir reviewed the minimized plan and instructed: "Great,
  implement it, test it, then get it deployed onto the laptop."
- **Decision:** Freeze Sections 0, 5, 6, 7, and 8 as the implementation
  boundary. Complete local implementation and proof before any M3 contact.
- **Consequences:** Testing may prove the frozen behavior but may not add
  architecture, production surfaces, provider variants, or adjacent cleanup.
- **Follow-ups:** Deploy the exact tested main commit to `amirs-m3-max-new`
  only after Phase 1 passes.

## 2026-07-24 - M3 deployment accepted

- **Context:** The exact tested implementation commit was installed on
  `amirs-m3-max-new` after the local proof gate passed.
- **Decision:** Accept the rollout after one manual pass refreshed ten due
  Claude labels with zero failures and two scheduled passes exited cleanly
  without additional writes.
- **Consequences:** `com.funcountry.aimgr.auth-maintainer` is the sole
  recurrence owner and runs the one-shot every 60 seconds. An active `pro5`
  session on the Ubuntu host remains the owner of its existing rotation lease;
  the maintainer correctly skips it rather than racing it.
- **Follow-ups:** Use the existing `aim login <label>` only when status
  conclusively reports `reauth_required`.

## 2026-07-24 - Use a launchd one-shot, not a resident daemon

- **Context:** The work is periodic and finite.
- **Options:** Resident Node daemon, generalized scheduler, or launchd one-shot.
- **Decision:** `aim auth maintain` exits after one roster pass; launchd owns
  recurrence.
- **Consequences:** Smaller lifecycle and no second in-process loop.
- **Follow-ups:** None.

## 2026-07-24 - Reuse Claude; add only a Codex refresh-only helper

- **Context:** Claude already has a safe official-client publication path;
  Codex's current path can fall through to a browser.
- **Options:** New shared OAuth framework, direct refresh for both, or reuse
  Claude and add one Codex helper.
- **Decision:** Reuse Claude unchanged at its canonical owner; add only the
  missing Codex headless request.
- **Consequences:** No direct Anthropic OAuth and no provider framework.
- **Follow-ups:** None.

## 2026-07-24 - User-directed simplification of the implementation plan

- **Context:** The first draft generalized lease heartbeats, fetch cancellation,
  and the existing watch installer and specified a broad result/test matrix.
- **Options:** Keep the defensive design or reduce it to the demonstrated
  lifetime-maintenance need.
- **Decision:** Use the existing Claude lifecycle; fit Codex's eight-second
  request inside its existing 30-second lease; add one install/uninstall
  LaunchAgent script; keep only focused command/provider/marker proof.
- **Consequences:** The generic lease, fetch, runner/supervisor, and watch
  installer remain unchanged. Rare manual-login CAS contention is accepted
  instead of building coordination machinery around it.
- **Follow-ups:** None. Removed machinery is not deferred scope.
