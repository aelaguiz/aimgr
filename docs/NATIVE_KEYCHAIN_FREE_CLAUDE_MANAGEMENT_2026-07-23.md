---
title: "AIM - Native Keychain-Free Claude Management - Architecture Plan"
date: 2026-07-23
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: parity_plan
related:
  - docs/CONSOLIDATE_CLAUDE_CREDENTIALS_INTO_AIM_REDIS_2026-07-22.md
  - docs/CONSOLIDATE_CLAUDE_CREDENTIALS_INTO_AIM_REDIS_2026-07-22_CONDUCTOR_LOG.md
  - docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md
  - /Users/aelaguiz/workspace/claude-keychain-free-lab/CLAUDE_KEYCHAIN_FREE_LAB.md
  - /Users/aelaguiz/workspace/claude-keychain-free-lab/CLAUDE_KEYCHAIN_FREE_LAB_WORKLOG.md
  - /Users/aelaguiz/workspace/claude-keychain-free-lab/NATIVE_MACOS_ZERO_KEYCHAIN_STATIC_MAP.md
---

# TL;DR

## Binding requirements (human-authorized scope)

These are the requirements. They outrank every later section. Anything not
listed here is out of scope unless Amir explicitly approves it and this plan is
amended before implementation continues.

1. Run the official native macOS Claude client locally. No Linux, VM,
   container, Rosetta, remote host, or platform spoofing.
2. An AIM-managed Claude run or login must not touch the real macOS Keychain:
   no real `security` invocation, Security.framework credential access,
   SecurityAgent prompt, unlock, ACL change, Keychain read, or Keychain write.
3. Redis is the only canonical credential authority. A label-scoped
   `.credentials.json` may exist only as a private derived projection while an
   operation is active, or as the existing fenced recovery copy when
   publication is genuinely uncertain.
4. Preserve the useful account-management surface: Redis inventory/status,
   explicit account launch, official-client refresh with validated Redis
   publish-back, and command-line reauthentication.
5. Preserve the launch UX exactly:
   `aim claude run <label> -- <arbitrary Claude arguments>`. Everything after
   `--` is forwarded unchanged, including
   `--dangerously-skip-permissions --model opus --effort xhigh --resume`.
   Preserve the caller's cwd, real terminal, stdin/stdout/stderr, exit status,
   terminating signal, and label-scoped resume state.
6. Do not mutate the user's installed Claude binary, global `~/.claude`,
   `~/.claude.json`, Keychain, other AIM labels, or unrelated AIM state.
7. The official Claude client owns OAuth refresh and login. AIM must not
   implement Anthropic OAuth or call a private refresh API.
8. Reauthentication uses the existing `aim login <label>` command. Do not add a
   second public Claude reauth command.
9. Prove the real working path before refactoring or asking reviewers to assess
   it.
10. Keep implementation evidence in
    `docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md`.
11. **No additional scope.** Do not add adjacent cleanup, a new framework,
    generalized containment, another command, automatic selection, Tend,
    migration, remote work, a proxy, a Claude runtime distribution system, a
    broad status/panel/docs rewrite, or reviewer-generated obligations. If
    implementation appears to require anything beyond this document's two
    phases and named call sites, stop and ask Amir before changing plan or code.

## Outcome

AIM can launch and reauthenticate an explicitly selected Claude account on the
local native macOS machine without the managed process reaching the real
Keychain. Redis remains canonical, Claude temporarily consumes its ordinary
file-backed credential format, legitimate official-client rotation is
published back through AIM's existing continuity checks, and the command feels
like invoking `claude` directly.

## Problem

The branch already has Redis-backed Claude inventory/status and a conservative
run lifecycle with leases, rotation fences, identity checks, lineage checks,
and CAS publication. The remaining problem is narrow: managed run still
projects and reconciles a Keychain item, and generic `aim login <label>` rejects
Anthropic accounts.

The native lab already proved that the Darwin client ships the Linux-style
plaintext store as its fallback and can read, delete, and rotate that file. The
product has not yet routed AIM's real managed run or login through that path.

## Approach

Change the existing managed-run path in place:

1. Project the selected Redis credential only to the existing label-scoped
   Claude config directory.
2. Point both Claude config environment variables at that same directory.
3. Put the already-proven tiny `security` compatibility executable first on
   `PATH` so the official client observes "item not found" and selects its
   shipped file store.
4. Launch the installed, signed native Claude executable by verified absolute
   path under a small targeted macOS guard that blocks the real `security`
   executable, real Keychain services/files, global Claude credential paths,
   and other label credential paths. This is not a general application
   sandbox.
5. Reuse the existing identity, lineage, lease, fence, and CAS code to publish a
   legitimate successor, then delete the disposable credential projection.
6. After that works through `aim claude run`, route Anthropic
   `aim login <label>` through the same contained file-backed launch boundary.

Do not copy or redistribute Claude, create a runtime-manifest subsystem,
extract a new coordinator before proof, or add a network relay. The installed
client remains unmodified.

## Plan

1. Make `aim claude run <label> -- ...` work end to end with file-only native
   storage, exact CLI pass-through, a synthetic official-client refresh, and
   one authorized real local zero-model refresh canary.
2. Reuse that proven boundary for `aim login <anthropic-label>`, prove one fresh
   official login and Redis publication, then run the focused tests, existing
   full suite, and lint.

## Non-negotiables

- Requirements 1-11 above are the scope authority.
- No managed Keychain access and no fallback to the old Keychain path.
- No remote contact.
- No copied Claude binary, proxy/relay, general sandbox framework, new
  coordinator, broad convergence sweep, or pre-proof review phase.
- Existing Redis coordination is reused, not replaced.
- Legacy commands outside `run` and `login` are not redesigned or retired by
  this plan.
- A failing empirical proof stops the phase; it does not authorize extra
  machinery.
- New scope requires explicit human approval recorded in Section 10 before
  implementation resumes.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
research_pass_1: done 2026-07-23
deep_dive_pass_1: done 2026-07-23
phase_plan_pass_1: done 2026-07-23
scope_reduction_pass_1: done 2026-07-23 (user-approved)
recommended_flow: research -> deep dive -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

The plan succeeds when, on the local native macOS machine:

- `aim claude run <label> -- <args>` launches the official installed Claude
  client with the selected Redis identity from a label-scoped file and with no
  access to the real Keychain or global Claude credential state;
- arbitrary post-`--` Claude arguments, cwd, terminal streams, exit status,
  signal behavior, and same-label `--resume` behavior remain transparent;
- one official zero-model refresh writes a valid successor to the projected
  file and AIM advances only that label in Redis through the existing
  lease/fence/identity/lineage/CAS path;
- `aim login <anthropic-label>` completes the official Claude login flow inside
  the same boundary, validates the intended identity, publishes to Redis, and
  removes the local credential projection; and
- failure never falls back to Keychain, global Claude state, an AIM OAuth
  implementation, or a second credential authority.

"Claude account-management parity" means inventory/status, explicit launch,
official rotation, and CLI reauth. It does not mean Tend, automatic selection,
automatic mid-session switching, migration, or remote deployment.

## 0.2 In scope

### Requested behavior

- Preserve current Redis Claude inventory and status behavior.
- Change only the managed Redis `aim claude run <label>` storage/launch path.
- Preserve exact post-`--` argument pass-through and direct-terminal behavior.
- Preserve label-scoped noncredential Claude state needed by `--resume`.
- Add Anthropic support to the existing `aim login <label>` front door.
- Use the official client for refresh and login.
- Save concise implementation evidence in the named worklog.

### Technical change

- A file-only managed storage descriptor for the selected label.
- One tiny, reviewed `security` compatibility executable using the semantics
  already proven by the native lab.
- Both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the
  selected label's Claude config root.
- The current installed official Claude executable resolved to an absolute
  path and checked for the qualified native version, digest, and signing
  identity before any credential projection. It is not copied.
- A static, narrow, allow-default macOS launch profile whose only job is to
  deny the real Keychain/security/global-credential escape paths. It is not a
  policy framework and is not configurable.
- Existing managed-run lease, fence, recovery, stable-identity, token-lineage,
  and CAS publication behavior retained in place.
- An empty label-scoped staging config for fresh login, followed by exact
  identity validation, Redis publication, and cleanup.

### Initial minimal convergence closure

Only the directly competing paths for these two operations move:

- the file-plus-Keychain branch called by
  `src/cli/commands/claude.js::handleRedisClaudeRun`;
- the managed projection/readback code that branch invokes;
- the runner environment/process envelope it invokes; and
- the explicit Anthropic rejection in
  `src/cli/commands/login.js`.

Legacy capture/import/use/export commands, panel actions, general status
rendering, README cleanup, migration, and unrelated Keychain helpers remain
outside this plan. They may continue to exist, but `aim claude run` and
Anthropic `aim login` must not call them.

### Compatibility posture

- Preserve `aim claude inventory`, `aim claude status|usage`, and current Redis
  record contracts.
- Preserve `aim claude run <label> -- <args>`.
- Extend `aim login <label>` to Anthropic labels.
- Keep plain `claude` and legacy explicit maintenance commands unchanged and
  outside this plan's guarantee.
- Make a clean cutover for managed `run` and Anthropic `login`: no Keychain
  compatibility bridge or runtime fallback.

## 0.3 Out of scope

- Copying, downloading, redistributing, or auto-updating a private Claude
  runtime.
- A runtime manifest subsystem or multi-version Claude manager.
- A general-purpose macOS sandbox, default-deny application profile,
  generalized Mach/XPC/IOKit allowlist, or configurable policy language.
- A CONNECT relay, SNI proxy, TLS interception, production fake provider,
  general model guard, or network policy subsystem.
- Extracting a new managed-operation coordinator before the working run proof.
- Retiring or redesigning `capture-native`, `import-native`, `export-live`,
  `aim claude use`, panels, general `aim status`, README, or historical docs.
- Broad call-site convergence, code cleanup, or refactoring unrelated to the
  two named operations.
- Reviewer waves, independent verification frameworks, or reviewer-created
  implementation work.
- Tend, watch, automatic account selection, automatic mid-session rotation, or
  cross-account session continuation.
- Bulk account migration, roster seeding, remote projection, SSH, rsync, or
  cleanup of existing remote residue.
- Linux, VMs, containers, platform spoofing, binary patching, or an AIM-owned
  Anthropic OAuth client.
- Supporting arbitrary future Claude/macOS tuples in this change.
- Protecting the temporary credential from arbitrary code the operator
  explicitly asks Claude to execute inside the same process boundary. The
  boundary blocks Keychain/global credential access; the unmodified Claude
  process must be able to read its own projected file.

## 0.4 Definition of done (acceptance evidence)

All of the following are required and sufficient:

1. A focused contained-launch probe, run before any real credential, proves
   bare `security` resolves to the compatibility executable while the real
   `/usr/bin/security`, real Keychain credential path, global Claude credential
   files, and another label's credential file are unavailable to the launched
   process and a child process.
2. A focused synthetic integration runs the official installed native Claude
   executable through AIM's actual managed-run path, reads a synthetic
   file-backed identity, performs the proven zero-model `/usage` refresh,
   writes the successor to the same private file, and publishes only the
   intended fake Redis label.
3. One explicitly authorized real local refresh canary through the product path
   advances only the selected Redis label with matching identity and lineage,
   clears its fence, removes the normal credential projection, and causes no
   Keychain prompt or model turn.
4. Focused process-contract evidence proves exact argv, cwd, stdin/stdout/
   stderr, exit status, and terminating-signal behavior. One
   operator-controlled smoke confirms the representative launch UX and
   same-label `--resume` behavior.
5. One explicitly authorized fresh official Claude login through
   `aim login <anthropic-label>` validates the intended stable identity,
   publishes it to Redis, removes staging credentials, and causes no Keychain
   prompt.
6. Existing affected tests, the existing full suite, and lint pass. No new
   general test framework, proxy harness, or broad review gate is required.

### Scope and Simplicity Contract

- **Human-authorized outcome:** Native local macOS Claude account management
  through AIM with Redis authority, explicit launch, official refresh,
  command-line reauth, and no managed access to the real Keychain.
- **Authorization anchors:** Amir's 2026-07-23 instructions to work locally,
  avoid Keychain, use a tight launch shim with arbitrary Claude arguments,
  test the working path before reviewers, keep findings in a worklog, simplify
  the architecture, and make "no additional scope" an explicit requirement.
- **Smallest sufficient solution:** Modify the existing managed run in place to
  use the official client's shipped file store via the proven tiny
  compatibility executable and targeted Keychain guard; reuse existing Redis
  continuity; then add one Anthropic branch to `aim login <label>`.
- **Initial minimal convergence closure:** The managed run's direct storage,
  projection, runner, and login-rejection call sites listed in Section 6.
  Nothing else.
- **Scope freeze:** Re-frozen by the user-approved 2026-07-23 scope reduction.
  Section 7's two phases are the entire implementation frontier. A worker,
  reviewer, test, or later plan note cannot add work.
- **Enough proof:** One no-secret containment probe, one synthetic official
  refresh through the real AIM path, one real local zero-model refresh, one
  representative CLI/resume smoke, one real fresh login, focused affected
  tests, the existing full suite, and lint.
- **Do not build:** A copied Claude runtime, runtime manifest system, general
  sandbox, proxy/relay, coordinator extraction before proof, broad cleanup,
  legacy-command retirement, status/panel/docs convergence, new command,
  Tend/selection/migration/remotes, exhaustive test matrix, or reviewer phase.
- **Residual risk accepted by this plan:** The installed Claude and macOS
  behavior are version-sensitive; an unknown tuple fails closed and may need a
  separately approved update. The targeted guard is intentionally not a
  general application sandbox. Label-scoped session state persists for
  `--resume`, while the credential file is normally disposable. The official
  client and its authorized descendants can read that file during the run.

## 0.5 Key invariants (fix immediately if violated)

- Redis is the sole canonical/shared credential authority.
- Managed `run` and Anthropic `login` never invoke or reach the real Keychain.
- The compatibility executable is the selected storage adapter, never a
  fallback to the real `security` command.
- Both Claude config variables identify the same selected label config root.
- The installed Claude executable is unmodified and verified before projection.
- The local credential file is private, label-scoped, and removed after safe
  publication except for the established fenced-recovery case.
- Stable identity, lineage, lease, fence, and CAS rules do not weaken.
- User Claude arguments are opaque to AIM and cannot disable the outer
  Keychain guard.
- Plain `claude` and unrelated AIM/Claude commands are not changed.
- No secret enters output, logs, docs, tests, or process arguments.
- Any newly discovered work outside Sections 6-7 is a hard stop requiring
  explicit user approval.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Make the native product path actually work without a Keychain prompt.
2. Preserve Redis identity and rotation continuity.
3. Keep the launch UX indistinguishable from direct Claude apart from the AIM
   account selector.
4. Reuse existing code and add the least possible machinery.
5. Prove the run path before adding login.
6. Stop when the required behavior works.

## 1.2 Constraints

- The native Claude build has no supported file-only switch.
- Its Darwin build already includes a plaintext fallback store and calls bare
  `security` early during startup.
- Exact item-not-found/write-failure semantics are required for the fallback.
- Both Claude config variables must point to the same directory.
- The current branch contains user-owned in-progress Redis/Claude changes that
  must not be reverted or overwritten.
- Real credential/provider operations require explicit operator authorization.
- On 2026-07-23, after authorizing the first `pro5` canary, the operator issued
  a standing execution directive: continue bounded operations inside these
  binding requirements without repeatedly asking for authorization. This
  satisfies later in-scope live gates; it does not authorize new scope.
- The no-additional-scope rule forbids converting implementation friction into
  a framework.

## 1.3 Architectural principles (rules we will enforce)

- Change the existing owner path before extracting anything.
- Use the official client's native storage capability; do not emulate Linux or
  implement OAuth.
- Keep containment targeted to the actual Keychain/global-state escape.
- Keep Redis continuity logic where it already works.
- Fail closed before projection when binary, adapter, path, or guard validation
  fails.
- Prefer deletion of a temporary credential over persistence of a second
  authority.
- Tests prove behavior; reviews do not define architecture or scope.

## 1.4 Known tradeoffs (explicit)

- A tiny executable named `security` is necessary because upstream exposes no
  file-store flag. It is a narrow compatibility adapter, not a general wrapper
  or fallback.
- Executing the verified installed Claude binary is simpler than copying it,
  but an upstream update can temporarily stop managed launch until the narrow
  tuple is revalidated.
- A targeted allow-default guard protects the actual Keychain/global-state
  requirement without attempting to sandbox every capability Claude may use.
- Label-scoped resume state is intentionally separate from the user's global
  Claude session history.
- Legacy explicit Keychain/global maintenance commands remain outside this
  plan; only managed `run` and Anthropic `login` gain the no-Keychain
  guarantee.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

- Redis Anthropic records, inventory, status, leases, rotation fences,
  identity/lineage validation, and CAS publication already exist.
- `handleRedisClaudeRun` already performs the entire managed credential
  lifecycle.
- The managed descriptor/projection/readback currently includes an isolated
  Keychain item.
- `aim login <label>` explicitly rejects Anthropic labels.
- The completed native lab proved file-backed native status, logout, and
  synthetic refresh using the official Darwin client without real Keychain
  access.

## 2.2 What's broken / missing (concrete)

- AIM's real managed run still touches Keychain.
- The proven file fallback is not wired into the product path.
- The real product path has not yet proven exact launch UX without Keychain.
- Fresh official native login has not been proven through AIM.
- The previous plan surrounded these gaps with unrelated runtime distribution,
  sandbox, proxy, refactor, cleanup, and review work.

## 2.3 Constraints implied by the problem

- The storage adapter and guard must be active before Claude starts.
- The first implementation slice must reach the official client and Redis
  publish-back; foundation-only refactors do not prove the requirement.
- Login should reuse the proven run boundary, not precede it.
- No-Keychain behavior must be structural enough that a prompt cannot be the
  expected failure mode.
- A test failure can block the phase, but it cannot silently expand scope.

# 3) Research Grounding (external + internal "ground truth")

<!-- arch_skill:block:research_grounding:start -->

## 3.1 External anchors (papers, systems, prior art)

The primary evidence is the completed native lab, not an inference from Linux:

- `/Users/aelaguiz/workspace/claude-keychain-free-lab/CLAUDE_KEYCHAIN_FREE_LAB.md`
  records successful native file-backed status, logout, and synthetic
  `/usage` refresh with zero model turns.
- `/Users/aelaguiz/workspace/claude-keychain-free-lab/NATIVE_MACOS_ZERO_KEYCHAIN_STATIC_MAP.md`
  establishes that the Darwin build creates a Keychain-primary/plaintext-
  fallback composite store, resolves the application storage calls through
  bare `security`, performs credential prefetch during startup, and does not
  switch stores when Linux-like platform environment variables are spoofed.
- `/Users/aelaguiz/workspace/claude-keychain-free-lab/native/src/security_shim.c`
  is the proven 97-line adapter: recognized reads return item-not-found
  (`44`) with no output, writes fail immediately, stdin is drained safely,
  deletes return item-not-found, and unknown operations fail closed.
- The lab proved the relevant file is an atomic, single-link, owner-only
  `0600` `.credentials.json` under the configured Claude directory.

Adopt those exact storage semantics. Reject the lab's larger experiment
harness, Linux/VM route, platform spoofing, broad process census, copied
runtime, and network-proxy ideas as product requirements.

## 3.2 Internal ground truth (code as spec)

- `src/cli/commands/claude.js::handleRedisClaudeRun` is the canonical current
  owner of Redis load, lease, fence recovery, projection, launch, successor
  validation, CAS publication, and cleanup. Phase 1 modifies it in place.
- `src/credentials/claude-native-storage.js` owns the managed descriptor,
  Keychain functions, file reads, and current file/Keychain aggregation. It
  needs a file-only managed mode; unrelated legacy callers remain untouched.
- `src/targets/claude-cli.js` owns transactional file projection plus the
  unwanted managed Keychain write/readback stage.
- `src/targets/claude-runner.js` and
  `src/targets/claude-supervisor.js` already direct-exec an absolute child with
  inherited stdio and signal handling. The runner is the narrow place for the
  config environment, adapter `PATH`, installed-binary verification, and
  targeted guard.
- `src/cli/args.js` already preserves everything after the first `--`.
- `src/cli/commands/login.js` is the existing generic login front door and
  contains the Anthropic rejection to replace in Phase 2.
- `src/credentials/claude-native.js::syncClaudeNativeBundleBackToLabel`
  currently reads the aggregate storage result; it must consume the exact
  file-only successor while preserving its identity and lineage checks.
- `src/coordination/redis-credential-lease.js`,
  `src/coordination/redis-claude-rotation-fence.js`,
  `src/coordination/login-publish.js`, and
  `src/coordination/runtime.js` remain unchanged as the continuity/publication
  owners.
- `src/status/claude-redis-view.js` already owns Redis Claude status and is
  preserved without redesign.

Canonical owner path:

```text
aim claude run / aim login
  -> existing command lifecycle
  -> existing Redis lease/fence/identity/lineage/CAS
  -> file-only label projection
  -> existing runner with tiny adapter + targeted guard
  -> verified installed official Claude
  -> file-only successor readback
  -> existing Redis publication
```

## 3.3 Decision gaps that must be resolved before implementation

None. The selected minimal decisions are:

- Use the installed signed native Claude executable by verified absolute path;
  do not copy it.
- Reuse the proven C adapter source and build one tiny local helper in an
  AIM-owned contained directory; do not create a native runtime subsystem.
- Use one static targeted allow-default launch profile; do not build a general
  sandbox or dynamic policy generator.
- Use the network normally. Do not add a relay, proxy, TLS interception, or
  provider simulator beyond the already-existing minimal synthetic proof.
- Modify `handleRedisClaudeRun` in place. Refactor only after a working proof
  and only if the Phase 2 login branch cannot reuse the path without direct
  duplication.
- Leave legacy commands and broad product surfaces alone.
- Empirical failure at the containment, refresh, CLI, or login proof gate stops
  work and returns to Amir; it does not authorize a bigger design.

<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->

## 4.1 On-disk structure

```text
installed official Claude
  ~/.local/bin/claude -> installed native version

managed label
  ~/.aimgr/claude-homes/<label>/.claude/.credentials.json
  ~/.aimgr/claude-homes/<label>/.claude/.claude.json
  isolated managed Keychain item

Redis
  versioned Anthropic label record
  optional rotation fence
```

The label directory is already the correct contained namespace. The unwanted
part is the additional Keychain authority in managed run.

## 4.2 Control paths (runtime)

Current managed run:

```text
Redis record
  -> lease + snapshot reload
  -> recover/reconcile file and Keychain
  -> project file and Keychain
  -> launch official Claude
  -> read freshest file/Keychain candidate
  -> validate identity + lineage
  -> CAS publish
  -> clear or retain fence
```

Current generic login rejects Anthropic and points the user toward legacy
capture/import behavior.

## 4.3 Object model + key abstractions

- Redis versioned credential record: canonical shared state.
- Label-scoped managed descriptor: currently file plus Keychain.
- Rotation fence: preserves uncertainty when provider rotation may have
  occurred without safe publication.
- Native Claude bundle and stable identity: already provider-specific and
  reusable.
- Runner/supervisor: already the process envelope and direct-exec path.

## 4.4 Observability + failure behavior today

- Redis inventory/status are value-free and usable.
- Managed run reports Keychain projection and can trigger SecurityAgent.
- Continuity failures retain the fence conservatively.
- The outer CLI can currently add wrapper output or normalize process results;
  Phase 1 must preserve the direct-Claude contract.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No UI or panel work is in scope. The only command surfaces are:

```text
aim claude run <label> -- <claude args>
aim login <anthropic-label>
```

<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->

## 5.1 On-disk structure (future)

```text
installed official Claude (unchanged)
  verified absolute native executable

AIM-owned helper (not Claude)
  ~/.aimgr/runtime/claude-file-store/<source-sha>/security
  native/claude/no-keychain.sb (repo-owned, narrowly parameterized)

managed label
  ~/.aimgr/claude-homes/<label>/.claude/
    .credentials.json   # disposable credential projection
    .claude.json        # retained noncredential app/session state
    other native session state allowed for same-label --resume

fresh-login staging
  owner-only temporary config beneath the selected label namespace
  removed after success or safe failure

Redis
  unchanged canonical versioned record + existing fence
```

There is no copied Claude binary and no runtime-manifest subsystem.

## 5.2 Control paths (future)

Managed run:

```text
handleRedisClaudeRun
  -> existing Redis lease/recovery
  -> exact file-only projection for selected label
  -> create existing rotation fence
  -> runClaudeCli
       - verify installed official binary
       - set both Claude config variables
       - prepend tiny security adapter
       - apply targeted Keychain/global-path guard
       - direct-exec exact user argv in caller cwd/terminal
  -> read exact file successor
  -> existing identity/lineage/CAS publication
  -> clear fence and delete credential projection
  -> reproduce exact child result
```

Anthropic login:

```text
aim login <label>
  -> existing provider/label lookup + lease
  -> empty label-scoped staging config
  -> same contained runner, official Claude login command
  -> read exact resulting file
  -> validate stable identity / duplicate-account rules
  -> existing CAS publication
  -> delete staging credential/config
```

## 5.3 Object model + abstractions (future)

No new coordinator or framework is planned.

- **File-only managed descriptor:** the selected label root, exact credential
  path, app/session path, expected identity, and storage mode. It contains no
  Keychain service.
- **Contained launch options:** existing runner inputs plus explicit config
  root, cwd, operation kind, and exact argv.
- **Compatibility executable:** the proven fixed `security` behavior only.
- **Targeted profile:** one repo-owned, narrowly parameterized deny policy for
  real `security` execution, Keychain files/services, global Claude credential
  paths, AIM credential internals, and other label credential files.
  Everything unrelated remains allowed; there is no user-configurable policy
  layer.
- **Existing continuity objects:** lease, fence, identity, lineage, and Redis
  CAS remain unchanged.

Phase 2 reuses the runner and storage functions established in Phase 1
directly. No coordinator or additional abstraction is authorized.

## 5.4 Invariants and boundaries

- Adapter and targeted guard are installed before the official process starts.
- Bare `security` reaches only the adapter; absolute real `security` is denied.
- Both Claude config variables resolve to the same safe label config root.
- Only the selected label's projection is readable.
- The credential file is owner-only, regular, single-link, bounded, and
  `0600`.
- No local successor publishes without exact identity, lineage, lease, fence,
  and CAS validation.
- Successful publication retires the credential projection.
- Publication uncertainty uses only the existing fenced-recovery contract.
- User argv, cwd, stdio, result, and signal are preserved.
- No runtime fallback reaches Keychain or global Claude state.

## 5.5 UI surfaces (ASCII mockups, if UI work)

No new UI.

```text
$ aim claude run pro5 -- --dangerously-skip-permissions --model opus --effort xhigh --resume
[official Claude owns the terminal]

$ aim login pro5
[official Claude login flow]
```

<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->

## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
|---|---|---|---|---|---|---|---|
| Managed lifecycle | `src/cli/commands/claude.js` | `handleRedisClaudeRun` | Inline Redis lifecycle projects/reconciles file plus Keychain and emits wrapper result | Modify in place to select file-only managed storage, call contained runner, publish file successor, retire projection, and preserve exact child result | This is the existing canonical owner and fastest real slice | No new public API | `test/cli/redis-projection-command.test.js` |
| Managed storage | `src/credentials/claude-native-storage.js` | descriptor + exact file reader | Descriptor requires Keychain service and aggregate file/Keychain read | Add file-only managed descriptor/read contract for run/login; legacy explicit readers remain outside scope | Prevent managed Keychain access without redesigning legacy commands | Internal storage mode only | `test/claude/native-storage.test.js` |
| Managed projection | `src/targets/claude-cli.js` | `projectClaudeNativeBundleToManagedConfig` and readback | Writes/verifies files and Keychain | For the managed file-only mode, keep file transaction/app-state merge and omit all Keychain work | Reuse working projection code | Internal mode/entry point only | native storage + Redis projection tests |
| Native launch | `src/targets/claude-runner.js` | `runClaudeCli` | Sets config env and executes via supervisor without file-store adapter or Keychain guard | Before projection, atomically compile/cache the adapter by source hash; verify installed Claude; set exact config roots; prepend adapter; apply the targeted profile; pass exact cwd/argv/stdio | One narrow process boundary before startup prefetch | Extend existing internal options only | Existing runner/supervisor tests plus one focused contained probe |
| Process supervision | `src/targets/claude-supervisor.js` | existing direct child contract | Direct exec, inherited stdio, signal forwarding | Preserve unchanged; exact final-result propagation is repaired in the owning CLI lifecycle | No speculative supervisor rewrite | Existing result contract | Existing supervisor tests |
| CLI parsing | `src/cli/args.js` | first `--` capture | Already preserves remaining argv | Preserve unchanged | It already meets the UX contract | None | Existing CLI parser tests |
| Reauth dispatch | `src/cli/commands/login.js` | Anthropic branch in generic login | Rejects Anthropic | After Phase 1, dispatch Anthropic to the same proven file-only launch/storage boundary | Required CLI reauth with no second command | Existing `aim login <label>` | `test/cli/redis-login-command.test.js` |
| Successor validation | `src/credentials/claude-native.js` | `syncClaudeNativeBundleBackToLabel` | Consumes aggregate file/Keychain storage | Feed it the exact file-only successor while preserving identity, duplicate-account, and lineage behavior | Reuse the current validator without Keychain | Existing bundle contract | Existing native/Redis projection tests |
| Redis continuity | `src/coordination/redis-credential-lease.js`, `src/coordination/redis-claude-rotation-fence.js`, `src/coordination/login-publish.js`, `src/coordination/runtime.js` | lease/fence/CAS | Already conservative and provider-scoped | Preserve unchanged | Avoid a parallel coordinator | Existing contracts | Existing focused continuity tests |
| Adapter source | `native/claude/security_shim.c` | fixed compatibility executable | Exists only in the completed lab | Add the already-proven tiny source; the runner compiles it before credential projection into `~/.aimgr/runtime/claude-file-store/<source-sha>/security` | Official client exposes no file-only switch | Exact fixed exit semantics | One small semantic test |
| Targeted guard | `native/claude/no-keychain.sb` | parameterized Seatbelt profile | Exists only as broader lab evidence | Add one allow-default profile parameterized only with the selected config/AIM roots and adapter path; deny real Keychain/security/global/other-label credential paths | Prevent the real Keychain path without building a general sandbox | Fixed internal launch contract | Focused contained probe |
| Evidence | `docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md` | append-only phase entries | Does not exist yet | Create when implementation begins; record value-free checks and stop conditions | User explicitly requested a worklog | Evidence only, not a second plan | None |

## 6.2 Migration notes

- Canonical owner: `handleRedisClaudeRun` remains the lifecycle owner in
  Phase 1. Do not extract a coordinator first.
- Cutover: managed `run` and Anthropic `login` use file-only storage with no
  fallback. Legacy explicit commands retain their current behavior and are
  outside the guarantee.
- Delete only the managed Keychain calls/receipt fields made unreachable by
  this cutover. Do not launch a general legacy cleanup.
- Preserve current dirty provider-scoping and continuity changes.
- Update only directly false help/error text encountered in the two changed
  command paths. README, panel, general status, and historical docs are not a
  convergence obligation.
- No file or symbol outside this table enters scope merely because a test,
  reviewer, or adjacent search finds it. A genuinely necessary new call site
  is `new-scope-needs-human` and stops implementation.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

- `capture-native`, `import-native`, `export-live`, `aim claude use`, panels,
  general status, Tend, migration, and remotes were inspected.
- None is required to make managed `run` or Anthropic `login` file-only.
- Their disposition is explicitly out of scope, not deferred implementation.
- No additional consolidation is authorized.

<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

> Rule: depth-first implementation protects the frozen destination while proving the path early. The destination map is the human-authorized outcome plus the initial minimal convergence closure recorded before implementation and any later explicit human approval. The expansion map only sequences that frozen breadth; workers and reviewers cannot add callers, variants, modes, guarantees, proof categories, or adjacent cleanup. Section 7 chooses the first working slice through the canonical owner path and highest-risk seam, then advances through already-authorized axes. Phase boundaries are proof gates, and phase count follows real dependency, proof, reversibility, migration, or user-review boundaries. `Work` is explanatory; `Checklist (must all be done)` and `Exit criteria (all required)` hold every required obligation. Refactors and consolidations preserve behavior with proportionate evidence. No fallback exists without explicit approval. Prefer focused programmatic checks, defer manual verification to the phase's final gate, and do not invent verification machinery.

<!-- arch_skill:block:phase_plan:start -->

## Phase 1 - Make the existing managed run work file-only

Status: COMPLETE — the official native client now runs through AIM's contained
file-only path with Redis v3, zero Keychain/global credential access, disposable
projection cleanup, and exact arbitrary-argument forwarding. A real `/usage`
run completed with zero model/API work and unchanged fresh tokens; the focused
official-client fixture proves the rotated-successor publication branch. The
representative launch command reached the real resume UI without a model turn.

* Goal:

  Prove the smallest real product slice: a local native
  `aim claude run <label> -- ...` that uses Redis, the official installed
  Claude client, its file store, and the existing publication lifecycle without
  touching the real Keychain.

* Work:

  Modify the current managed run in place. Add only the proven tiny adapter and
  targeted guard needed before startup, then prove the complete path before any
  architecture refactor or login work.

* Checklist (must all be done):

  - Create the named worklog and record the starting commit, dirty files,
    selected local-only scope, and exact allowed call-site table.
  - Add the proven tiny `security` adapter source. Before any credential
    projection, the runner atomically compiles it with `/usr/bin/clang` into
    `~/.aimgr/runtime/claude-file-store/<source-sha>/security`, validates the
    fixed semantics/topology, and reuses that content-addressed helper. Do not
    copy Claude or create a runtime/manifest system.
  - Add `native/claude/no-keychain.sb` as the single narrowly parameterized
    allow-default profile at the existing runner boundary. It must deny real
    `security`, real Keychain credential access, global Claude credential
    paths, AIM credential internals, and other label credential files while
    leaving ordinary Claude/project capabilities alone.
  - Make `runClaudeCli` verify and execute the installed official native Claude
    by absolute path, set both Claude config variables to the selected label
    config root, prepend the adapter directory, preserve the caller environment
    except credential/config bypass variables, and keep exact argv/cwd/stdio.
  - Add a file-only managed storage descriptor and projection/readback mode.
    Preserve unrelated app/session state and omit every Keychain action from
    the managed run.
  - Modify `handleRedisClaudeRun` in place to use that mode while preserving the
    existing lease, fence recovery, identity, lineage, CAS publication, and
    uncertainty rules.
  - Make normal successful cleanup remove the projected credential while
    preserving label-scoped noncredential resume state. Retain a credential
    only under the existing publication-uncertainty fence contract.
  - Preserve exact child stdout/stderr, exit status, and terminating signal;
    remove wrapper output only where it violates this direct-Claude contract.
  - Extend only existing focused tests to cover adapter semantics, targeted
    denial, file-only successor capture, exact argv/cwd/process result, and
    unchanged Redis continuity. Do not add a test framework or broad matrix.
  - Run a no-real-credential containment probe before the synthetic or live
    proof.
  - Run the official installed client through AIM's actual managed path with
    synthetic credentials and the already-proven zero-model refresh fixture.
  - After those pass and only with explicit operator authorization, run one
    real local zero-model refresh canary for one label and verify value-free
    Redis, fence, request-count, projection-cleanup, Keychain/global-state, and
    prompt results.
  - Run one operator-controlled representative launch/resume smoke only after
    the refresh canary works.
  - Append each proof or blocker to the worklog. Do not dispatch reviewers and
    do not begin Phase 2 until every exit criterion passes.

* Verification (required proof):

  - Existing affected unit/integration tests.
  - One focused child-process containment probe.
  - One synthetic official-client refresh through the product path.
  - One explicitly authorized real local zero-model refresh.
  - One representative CLI/resume smoke.

* Docs/comments (propagation; only if needed):

  - Add only security-critical comments beside the adapter semantics, targeted
    denial, and disposable/fenced credential rule.
  - Keep the worklog current. No help, README, or broad docs sweep.

* Exit criteria (all required):

  - `aim claude run <label> -- <args>` reaches the official installed native
    Claude client through the file-only contained path.
  - The real Keychain and global/other-label credential paths are unavailable
    before Claude startup and no SecurityAgent prompt occurs.
  - Exact post-`--` argv, cwd, terminal streams, exit status, signal, and
    same-label resume behavior have direct evidence.
  - Synthetic and real refresh proofs publish only the intended identity and
    legitimate successor through the existing Redis lifecycle.
  - Successful cleanup removes the credential projection; uncertainty retains
    only the existing fenced recovery copy.
  - The selected label's real canary shows zero model turns and unchanged
    unrelated Redis/global/Keychain state.
  - No copied Claude runtime, proxy, coordinator extraction, broad cleanup,
    remote action, migration, or review work was added.
  - A failed proof stops the phase and is reported to Amir without adding
    machinery.

* Rollback:

  Disable the new managed run path while preserving Redis and any legitimate
  existing fence/recovery state. Do not restore Keychain as a fallback.

## Phase 2 - Add Claude reauth through the existing login command

Status: COMPLETE — `aim login pro5` completed the official contained native
login, validated the intended stable identity, advanced only `pro5` from Redis
v2 to v3, and removed its login staging, fence, and stale local publication
marker without touching the Keychain or global Claude credential path.

* Goal:

  Make `aim login <anthropic-label>` perform official native Claude login
  through the Phase 1 file-only boundary and publish the validated identity to
  Redis.

* Work:

  Add one provider branch to the existing generic login command. Reuse the
  proven runner, adapter, targeted guard, storage mode, and Redis continuity.
  Do not broaden panels, add a command, or extract a general coordinator.

* Checklist (must all be done):

  - Replace the Anthropic rejection in the direct generic login path with a
    call to the proven Phase 1 launch/storage boundary.
  - Start fresh login in an empty owner-only staging config beneath the
    selected label namespace, with both Claude config variables pointed there
    and no inherited Claude/Anthropic credential override.
  - Invoke the official native Claude login flow; AIM must not implement OAuth,
    parse tokens from terminal output, or call a private refresh endpoint.
  - Read the exact resulting file, validate stable identity and
    duplicate-account rules, publish through the existing lease/version/CAS
    path, and remove staging credentials.
  - On cancellation, wrong identity, containment failure, or safe
    prepublication failure, remove staging and leave Redis unchanged. On true
    post-grant publication uncertainty, use only the existing fenced-recovery
    behavior.
  - Add focused cases to the existing login tests for successful dispatch,
    wrong identity, cancellation, Redis failure, cleanup, and no Keychain
    fallback. Do not add panel work or a new harness.
  - After focused tests pass and only with explicit operator authorization,
    complete one real local fresh-login canary for the intended label and
    verify value-free identity/publication/cleanup/prompt evidence.
  - Run all directly affected tests, the repository's existing full suite,
    lint, and `git diff --check`.
  - Append final evidence and any accepted residuals to the worklog. Do not run
    a reviewer phase as an implementation requirement.

* Verification (required proof):

  - Existing focused generic-login and Redis continuity tests.
  - One explicitly authorized real native fresh-login canary.
  - Existing full suite, lint, and diff check.

* Docs/comments (propagation; only if needed):

  - The provider-rejection error disappears with the changed dispatch; no
    separate help or documentation rewrite is planned.
  - Keep the worklog current. No panel, README, general status, or historical
    documentation sweep.

* Exit criteria (all required):

  - `aim login <anthropic-label>` uses the official client through the same
    no-Keychain file-only boundary as managed run.
  - The intended stable identity is validated and published to Redis.
  - Staging credentials are absent after success and safe failure; uncertainty
    follows only the existing fence contract.
  - No Keychain prompt/access, global Claude mutation, AIM OAuth
    implementation, new public command, panel work, or extra framework exists.
  - Phase 1 remains green.
  - Focused tests, full suite, lint, and diff check pass.
  - The worklog contains the final value-free proof trail.

* Rollback:

  Restore only the Anthropic rejection in generic login while leaving the
  proven Phase 1 managed-run path intact. Do not offer Keychain/capture as an
  automatic fallback.

<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; evidence planning)

Use the smallest evidence set that proves the real failure is fixed, the
successful path works, and Redis continuity does not regress. The product path
must work before any review is useful.

## 8.1 Unit tests (contracts)

- Extend existing storage tests for file-only descriptor, private topology,
  exact readback, app/session preservation, normal retirement, and fenced
  retention.
- Extend existing runner/supervisor tests only for the required adapter/guard
  environment and exact argv/cwd/result contract.
- Preserve existing identity, lineage, lease, fence, and CAS tests.
- Add no deletion tests, repo-shape tests, broad malformed-input matrix,
  manifest framework, or general sandbox tests.

## 8.2 Integration tests (flows)

- Reuse the smallest existing native synthetic refresh fixture through AIM's
  actual managed run; do not port the lab's archive/census framework.
- Before credentials, prove the adapter and targeted denial with one harmless
  child probe.
- Prove wrong identity or invalid lineage as the single most important
  publication regression.
- Test Anthropic generic-login dispatch and cleanup through existing test
  surfaces.

## 8.3 E2E / device tests (realistic)

- One authorized local real zero-model refresh canary.
- One operator-controlled representative launch/resume smoke.
- One authorized local real fresh-login canary.
- Record only value-free outcomes in the worklog.
- Run the existing full suite and lint after the two working product flows.
- No reviewer gate, remote test, bulk cohort test, proxy test, or generalized
  containment qualification is part of done.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

- Implement and prove Phase 1 locally.
- Stop if any Keychain prompt or real Keychain access is observed.
- Implement Phase 2 only after Phase 1 passes.
- Keep remotes, migration, and every other account outside the canaries closed
  until separately authorized.

## 9.2 Telemetry changes

- Add no telemetry subsystem and no general status redesign.
- Reuse existing value-free Redis/fence/result evidence.
- Put phase proof details in the worklog, never secrets or credential paths.

## 9.3 Operational runbook

- Managed launch:
  `aim claude run <label> -- <arbitrary Claude args>`.
- Representative launch:
  `aim claude run pro5 -- --dangerously-skip-permissions --model opus --effort xhigh --resume`.
- Reauth:
  `aim login <anthropic-label>`.
- Plain `claude` and legacy explicit maintenance commands are outside the
  no-Keychain guarantee.
- Binary/adapter/guard drift fails closed before projection.
- A pending rotation fence blocks relaunch until existing recovery succeeds.
- No remote machine may be contacted under this plan.

# 10) Decision Log (append-only)

## 2026-07-23 - North Star confirmed

**Context:** The canonical draft presented native macOS, Redis authority,
managed Keychain exclusion, a transparent `aim claude run <label> -- <args>`
boundary, generic `aim login <label>` reauth, explicit account selection, and
the exclusion of Tend, remotes, and bulk migration.

**Options:** Revise the North Star before planning or authorize the documented
scope for research, deep dive, and phase planning.

**Decision:** The operator responded “yeah go,” confirming the documented
North Star and authorizing the planning arc. This confirms the narrowly scoped
launcher-owned `security` compatibility adapter as an internal implementation
boundary; it is never a user-facing command or a fallback to Keychain.

**Consequences:** The artifact is active. Planning may establish the smallest
directly competing managed-Keychain convergence closure, but code,
credentials, Keychain, Redis, Claude processes, and remote machines remain
untouched until a later implementation command and its explicit live gates.

**Follow-ups:** Complete research, one deep-dive pass, the call-site audit, and
the authoritative phase plan before freezing implementation scope.

## 2026-07-23 - Native macOS, Keychain-free managed runtime

**Context:** The operator rejected Linux/VM execution and any managed flow that
touches the Mac Keychain. The native lab proved the official Darwin client can
use its shipped file store when the Keychain primary is made structurally
unavailable with exact semantics.

**Options:** Keep isolated Keychain projection; run Claude in Linux; spoof the
host platform; patch the binary; or run the unmodified native binary behind an
AIM-owned contained launcher.

**Decision:** Plan the contained native launcher as the only managed Claude
process boundary.

**Consequences:** Direct `claude` remains unmanaged, AIM fails closed on
containment drift, and no Keychain fallback is allowed.

**Follow-ups:** Confirm this North Star, then complete research, deep-dive, and
phase planning before code work.

## 2026-07-23 - Reuse the generic login front door

**Context:** The requested product behavior is the same command-line account
maintenance experience AIM provides for Codex, while current Redis login
rejects Anthropic labels.

**Options:** Add `aim claude reauth`; keep import/capture only; or extend the
existing `aim login <label>` provider branch.

**Decision:** Extend `aim login <label>` and its guided label path to Claude;
do not add a second public reauth command.

**Consequences:** Provider-specific official OAuth execution lives behind one
user-facing maintenance contract, while storage and identity details remain
provider-owned internally.

**Follow-ups:** Deep-dive must map the exact generic maintenance adoption
points and preserved Codex behavior tests.

## 2026-07-23 - Tend is not a parity target

**Context:** Earlier comparisons treated Codex Tend as a working capability.
The operator corrected that Tend is broken and dead.

**Options:** Repair Tend, design Claude Tend, or exclude tending from this
architecture.

**Decision:** Exclude Codex Tend repair and every Claude Tend/watch/session
continuation surface.

**Consequences:** This plan's parity boundary is Redis authority, status,
explicit account selection, official credential rotation, and command-line
reauth.

**Follow-ups:** None inside this plan.

## 2026-07-23 - Transparent Claude CLI and label-scoped resume

**Context:** The operator normally launches Claude with varying native
arguments, for example
`claude --dangerously-skip-permissions --model opus --effort xhigh --resume`,
and requires the contained path to remain comparably tight.

**Options:** Teach AIM a subset of Claude flags; install a shell-level global
wrapper; add another public launcher command; or preserve the existing
`aim claude run <label> -- <args>` contract as a transparent process boundary.

**Decision:** Keep one managed launch shape:
`aim claude run <label> -- <arbitrary Claude arguments>`. AIM forwards the
post-`--` argument vector unchanged and preserves cwd, interactive stdio,
signals, and exit status. The outer containment boundary remains authoritative
even when Claude receives `--dangerously-skip-permissions`.

**Consequences:** Noncredential native session state persists in the
label-scoped AIM home so `--resume` works across launches for that label. The
credential file remains a disposable Redis projection, and global Claude
session history is not silently merged into managed homes.

**Follow-ups:** The deep-dive must map current supervisor/PTY behavior and the
phase plan must include transparent-forwarding integration proof plus one
operator-controlled local resume smoke.

## 2026-07-23 - Qualified copied client and locally built shim

**Context:** The current AIM runner executes a mutable installed PATH target,
while the native proof used a digest-pinned official binary and reviewed
`security` shim. The operator asked for a contained native version that does
not disturb the global installation.

**Options:** Execute the installed target directly; commit or download an
official binary; ship a precompiled shim; compile on every launch; or copy the
qualified installed client and compile the reviewed shim once into an
AIM-owned immutable runtime.

**Decision:** Before any credential projection, AIM verifies the installed
Darwin arm64 `2.1.218` client, atomically byte-copies it into a versioned
AIM-owned runtime, revalidates its digest/signature/team/identifier, and
disables managed auto-update. AIM commits the small C shim source and compiles/
qualifies it once during runtime materialization. No public prepare command or
download path is added.

**Consequences:** The global install remains untouched; launch-time updater and
symlink drift cannot change the qualified artifact; another client/OS tuple
fails closed until explicitly requalified. Runtime materialization may fail
before a managed operation, but never after credential projection.

**Follow-ups:** Phase 1 implements and proves the materializer, semantic shim
matrix, manifest, and drift failures.

## 2026-07-23 - Separate strict and interactive containment policies

**Context:** The lab's strict default-deny profile proves Keychain-free
maintenance but intentionally blocks arbitrary project tools and networking.
An allow-default credential-service blacklist would improve compatibility by
discarding the strongest proof.

**Options:** Reuse the strict profile for every operation; weaken to an
allow-default blacklist; proxy all interactive traffic; or keep one launcher
with two qualified operation policies.

**Decision:** Use one launcher with a strict maintenance/login policy and a
separately qualified interactive policy. Both default-deny Mach/XPC and IOKit
authority and inherit to descendants. Interactive mode deliberately opens
ordinary project/process/network capability while retaining exact Keychain,
global Claude/AIM credential, real-`security`, other-label, and forbidden
authorization denials.

**Consequences:** Interactive qualification is an empirical Phase 1 gate and
must stop rather than weaken if normal native UX cannot coexist with the
required denial boundary. The unmodified client and its authorized descendants
can read the live projected credential; the accepted residual limit is
recorded in Section 0.4.

**Follow-ups:** Prove representative project/tool/TTY behavior with the
production boundary sentinel, then prove the real operator-controlled run in
Phase 4.

## 2026-07-23 - Non-MITM maintenance relay and manual native login

**Context:** Zero-model refresh needs provider access without granting arbitrary
outbound traffic. Exact HTTPS path inspection would require production TLS
interception, and child-driven browser opening would widen the strict profile.

**Options:** Permit direct provider networking; deploy a production MITM;
allow GUI/browser escape; implement OAuth in AIM; or use a host-allowlisted
CONNECT relay plus model guard and the official manual login flow.

**Decision:** Strict operations can reach only AIM-owned loopback ports. A
non-MITM CONNECT/SNI relay forwards qualified provider hosts end-to-end, while
`ANTHROPIC_BASE_URL` targets a loopback guard that rejects every model request.
Fresh login uses the official client's manual URL/code terminal flow and no AIM
OAuth implementation.

**Consequences:** The pinned client plus model guard, not decrypted path
inspection, enforces zero-model maintenance. Native fresh login and a real
non-MITM refresh remain mandatory product canaries, with explicit stop
conditions already encoded in the phases.

**Follow-ups:** Phase 1 proves the compact synthetic relay/guard; Phases 2–3
prove the real refresh and fresh login.

## 2026-07-23 - Clean managed-authority cutover

**Context:** Keeping Redis `capture-native`, legacy local capture/import, global
`aim claude use`, or guided capture/use actions would preserve active
Keychain/global credential authorities beside the contained launcher.

**Options:** Keep them as compatibility fallbacks, hide them from docs, or
retire the competing managed paths when run cuts over.

**Decision:** Retire Redis and non-Redis capture, every-mode Claude use, and
non-Redis import in the run cutover. Keep Redis import only as a leased one-way
migration input. Keep `export-live` only as an explicit legacy operator export
outside managed runtime/reauth and remove it from the guided panel. The first
implementation action disables the old Keychain/global managed entries before
new native proof work; there is no callable bridge to the old behavior.

**Consequences:** Managed Claude has one launcher, one file authority, one
coordinator, and Redis as the only shared credential authority. Rollback means
disabling managed run/login while preserving Redis/fence state, never
reactivating Keychain/global fallback.

**Follow-ups:** The exact callers/tests/docs are frozen in Section 6 and
sequenced in Phases 1–4.

## 2026-07-23 - Working proofs precede broad review

**Context:** The operator explicitly directed the implementation to focus on
testing first because reviewer feedback is not useful until the native path
works.

**Options:** Review each foundation layer; run reviewer waves before live
proof; or defer broad review until the synthetic, real refresh, fresh login,
and interactive slices work.

**Decision:** No broad implementation reviewer is dispatched in Phases 1–3.
Phase 4 begins review only after the decisive working proofs and full automated
checks pass.

**Consequences:** Review cannot substitute for execution evidence or expand the
frozen scope. Accepted findings rerun only the affected working proof.

**Follow-ups:** Section 7 is the sole execution checklist.

## 2026-07-23 - Planning arc complete and scope frozen

**Context:** Research and deep-dive mapped the current branch, native lab,
official-client behavior, process/storage boundaries, competing callers,
compatibility posture, and proof gaps. The phase plan now has explicit
qualification stop conditions rather than unresolved architecture branches.

**Options:** Leave implementation choices to workers or freeze the selected
runtime, shim, relay, profile, storage, coordinator, cutover, login, status, and
verification contracts.

**Decision:** Freeze the initial convergence closure and four-phase execution
plan in Sections 0, 5, 6, and 7. The plan is decision-complete for
implementation. Empirical failures stop their phase; they do not authorize a
weaker fallback.

**Consequences:** Implementation may start only on a later explicit command.
Workers and reviewers cannot add Tend, automatic selection, remote work, bulk
migration, new public commands, general sandboxing, direct OAuth, or broader
client/OS support.

**Follow-ups:** The next authorized action is Phase 1 implementation. Until
then, do not execute Claude, touch Keychain/Redis/credentials, modify the
global installation, or contact remote machines.
## 2026-07-23 - Scope cut (user-approved): Reduce to the smallest working native path

**Cut:** Removed the private copied-Claude runtime and manifest, general
default-deny sandbox/allowlist work, CONNECT relay and model-guard subsystem,
pre-proof coordinator extraction, broad legacy-command retirement, panel and
general-status convergence, README/error sweep, generalized test machinery,
and the dedicated reviewer phase. Reduced the implementation frontier from
four phases to two: make managed run work, then add generic login.

**Why it looked necessary:** The prior plan generalized the problem into
runtime distribution, application sandboxing, networking, broad convergence,
and review orchestration. Those systems were not necessary to satisfy the
actual requirement: local native Claude, Redis authority, file-backed
managed run/refresh, CLI reauth, transparent launch UX, and no real Keychain
access.

**Intent evidence checked:** The binding requirements now at the top of this
document; Section 0's confirmed native/local/no-Keychain outcome; the user's
explicit launch example and requirement to test before review; and the
2026-07-23 instruction to scope the document down and make "no additional
scope" a requirement.

**User approval:** On 2026-07-23 Amir said, "Yeah, put those requirements at
the top of the document and scope it down and make one of my other requirements
is no additional scope." This followed the explicit requirements-alignment
discussion and approves this narrowing.

**Consequences:** Sections TL;DR and 0-9 were rewritten around the minimal
existing-owner path and re-frozen. The earlier Decision Log entries titled
"Qualified copied client and locally built shim," "Separate strict and
interactive containment policies," "Non-MITM maintenance relay and manual
native login," "Clean managed-authority cutover," and "Planning arc complete
and scope frozen" remain historical but are superseded wherever they conflict
with this entry. No implementation phase was marked complete. Any later
expansion requires a new explicit human approval and re-freeze before code
changes.
