# AI Manager × Prime Agent implementation worklog

**Authoritative architecture:** `docs/AI_MANAGER_PRIME_AGENT_ARCHITECTURE_PANEL_2026-08-10.md`

**Operating constraint:** This is a personal tool for one extremely high-volume operator. Every phase must choose the smallest complete behavior for that operator and reject generalization for other users, teams, fleets, or hypothetical providers.

## Pinned implementation roots

| Environment | Project | Worktree | Branch | Base |
|---|---|---|---|---|
| Local | AI Manager | `/Users/aelaguiz/workspace/aimgr-prime-session-handoff-20260810` | `feature/prime-session-handoff-20260810` | `98f8f40df647806835163d698556e7fcc59e9446` |
| Local | Prime Agent | `/Users/aelaguiz/workspace/prime-agent-session-handoff-20260810` | `aimgr-session-handoff-20260810` | `d1b072686d6b7b1b7d2ad773541e33aba1f578d9` |
| `home` staging | AI Manager | `/home/aelaguiz/workspace/aimgr-prime-session-handoff-20260810` | `staging/prime-session-handoff-20260811` | `98f8f40df647806835163d698556e7fcc59e9446` |
| `home` staging | Prime Agent | `/home/aelaguiz/workspace/prime-agent-session-handoff-20260810` | `staging/prime-session-handoff-20260811` | `d1b072686d6b7b1b7d2ad773541e33aba1f578d9` |

## 2026-08-11 — `home` staging cutover complete

- Stopped two managed legacy daemons, including one reporting 83 sessions, plus one detached interactive client. Preserved `~/.prime` sessions, AIM state, and all credentials.
- Installed AIM from the pinned staging worktree and installed the reviewed Prime dist launcher at both `~/.local/bin/prime-agent` and the NVM-global path that precedes it in interactive shells.
- Verified Prime static checks, 431 focused Prime tests, and 20 AIM Prime/README contract tests on Linux. The unrelated full AIM suite remains non-portable on this host because browser/Codex fixtures and Redis test lifecycle assumptions fail under Linux; the Prime integration slice is green.
- Ran real `aim prime run claude` and `aim prime run codex` sessions. Both bypassed the session picker, `/usage` reported the exact AIM binding and provider limits, and each provider returned `staging-ok`.
- Closed the smoke sessions and ran managed shutdown. Final `prime-agent status --json` is `[]`, no `prime-agent` process remains, and no Prime or forkserver socket is listening.

## 2026-08-11 — always-visible Prime session UUID installed

- Added the full canonical Prime session UUID as a dedicated second row of AIM's existing managed below-editor identity widget. The value comes directly from `ctx.sessionManager.getSessionId()` and is neither abbreviated nor persisted by AIM.
- Added focused proof for exact rendering, first-prompt and late-attachment visibility, same-suffix collision resistance, resume rendering, and byte-exact managed projection. Local verification passed 10/10 focused tests, 361/361 full AIM tests, lint, and diff checks. `home` passed 10/10 focused tests, source syntax, and diff checks.
- Installed the canonical extension atomically at `~/.prime/agent/extensions/session-title-footer.ts` locally and on `home`; both installed files match their source at SHA-256 `3dab154f8853bc6d778a0eaf18f36788d9f168ab3f58574d5d3d3bf2169fe0e2`.
- Did not restart, stop, duplicate, or replace any daemon or worker. No Prime source, protocol, schema, session state, credential binding, lock, cache, registry, or background process changed.

## Phase gate contract

At every boundary, independent revenue, product-journey, product-engineering, lean-architecture, and current-evidence judgment must review the actual diff and verification receipts. The parent integrates and verifies the panel's anchors. Work proceeds only when the panel certifies that the completed phase is valuable, causally sufficient, and overbuild-free, and approves a written scope for the next phase.

Panel approval is not inferred from green tests. Any unresolved material concern, speculative machinery, duplicate state, compatibility platform, framework, test matrix, or scope beyond this personal workflow keeps the gate closed.

## Phase status

| Phase | Status | Certification | Next-scope status |
|---|---|---|---|
| 0 — worktree and scope boundary | Complete | **OVERBUILD-FREE CERTIFIED** unanimously | Phase 1 frozen below |
| 1 — truthful execution identity | Complete | **OVERBUILD-FREE CERTIFIED** unanimously | Phase 2 frozen below |
| 2 — exact-dead state and tombstone cleanup | Complete | **OVERBUILD-FREE CERTIFIED** unanimously | Phase 3 frozen below |
| 3 — manual same-session handoff | Complete | **OVERBUILD-FREE CERTIFIED** unanimously | No next scope authorized |
| 4 — active-tree rollover and exact Codex automatic handoff | Source complete; cutover deferred | Mocked causal proof and repository checks pass; installed smoke still required | Do not restart the resident daemon while 207 sessions are registered |
| 5 — subtraction and cutover | Not started | Required for completion | Final audit required |

## 2026-08-10 — Phase 0 boundary opened

### State inspected

- AIM implementation worktree is clean at `98f8f40df647806835163d698556e7fcc59e9446`.
- Prime implementation worktree is clean and tracks freshly fetched `upstream/main` at `d1b072686d6b7b1b7d2ad773541e33aba1f578d9`.
- The original AIM worktree contains the untracked architecture and worklog documents plus pre-existing untracked tool directories.
- The original Prime worktree retains its pre-existing dirty credential-broker/routing changes and is not an implementation root.
- No implementation, daemon, credential, Redis, installed runtime, or external service has been mutated.

### Phase 0 panel decision

All three independent seats returned `APPROVE_WITH_NARROWING`, then unanimously certified the integrated scope below with no required changes.

The panel rejected the provisional installed lane, Node/npm metadata pin, AIM status parser, public lane/execution-ID field, generalized dependency/asset closure, manifest, build-scoped socket work, and any credential/session behavior. Current upstream has one fixed per-user daemon socket, not the build-scoped topology described by the earlier fork analysis. That source correction is binding for implementation.

The material disagreement was whether identity should remain diagnostic or fence daemon reuse. The integrated decision uses the existing `runtime.buildId` and existing hello/replacement paths as a real client→supervisor and supervisor→worker fence. This closes the demonstrated wrong-code reuse class without adding state, a wire shape, capability negotiation, or a compatibility platform.

### Frozen Phase 1 production scope

Phase 1 may touch at most these six production files/surfaces:

1. Prime `prime-agent.sh`: stop exporting launcher-authored `PRIME_AGENT_BUILD_ID`; retain exact source/dist entrypoint selection and launcher-path diagnostics.
2. Prime one small source-fingerprint helper: compute deterministic clean/dirty source identity from the entrypoint-derived repository root.
3. Prime `daemon-runtime-identity.ts`: compute and cache existing `buildId` from the actual process entrypoint. Domain-separate source and bundle identity. Bundle identity hashes sorted relative executable bundle/chunk paths plus their bytes. Environment identity, source adjacent to a bundle, maps, timestamps, dependencies, and assets cannot select or override it.
4. Prime `daemon-launch.ts`: require existing daemon hello `runtime.buildId` to match the client identity; reuse the current idle-replace/busy-refuse behavior for missing or mismatched identity.
5. Prime `daemon-supervisor.ts`: reject a worker whose existing hello identity differs from the supervisor before authentication, adoption, or recovery.
6. AIM `harness-target.js`: delete `inspectPrimeDefaultLauncherLane` and preserve the caller's explicit arguments exactly. AIM does not query status, parse an ID prefix, add/remove `--dist`, synthesize fallback, or add configuration.

There is no `installed` lane; an installed bundle is simply bundled execution. There is no new `lane`, `executionId`, command, field, capability, protocol/schema revision, socket namespace, registry, daemon resolver, persistent state, credential behavior, session behavior, runtime pin, dependency update, or manifest.

### Frozen Phase 1 proof and change budget

- Production files touched: maximum six; new production files: maximum one helper.
- Test files touched: maximum three; new test files: maximum one focused Prime identity test.
- Prime identity proof: stable input is cached/stable; tracked or untracked source change changes source identity; bundle/chunk change changes bundled identity; source and bundle are domain-separated; spoofed environment identity cannot win; required unreadable inputs fail loudly.
- Daemon fences: matching identity reuses; missing/mismatched identity is never current; idle mismatch follows existing replacement; busy mismatch refuses without killing or duplicating live work; worker mismatch is rejected before adoption/recovery.
- AIM proof: representative run/resume arguments preserve explicit `--dist`; no status subprocess or prefix inference can change launch intent; launcher failure remains visible.

Verification is limited to the three affected test files, Prime `npm run check`, AIM `npm run lint`, and both repositories' `git diff --check`. No full suite, daemon farm, new harness, or provider credential is funded.

### Phase 0 gate receipt

**Status: approved — OVERBUILD-FREE CERTIFIED.** Revenue/operator, product-journey/current-evidence, and product-engineering/lean-architecture seats all certified the frozen scope above. Implementation may begin only within this boundary.

Reversal conditions: a required runtime input omitted from the fingerprint reproduces same-identity/different-code; a current AIM path actually launches a distinct installed form; or existing idle-replace/busy-refuse behavior cannot safely enforce identity. Any reversal closes the phase and returns it to the panel instead of expanding implementation ad hoc.

## 2026-08-10 — Phase 1 complete and certified

### Exact implementation

The first gate review reopened one underestimated proof boundary: five production files changed, no production file was added, four test files changed, and one focused test file was added. The fourth test file is the existing supervisor recovery test owner; it replaced a misleading pure-comparator assertion after the panel proved that the outer recovery path could relaunch an incompatible live worker. No new harness or process farm was added.

1. Prime now computes one cached `runtime.buildId` from the canonical actual process entrypoint. Source execution uses the entrypoint-derived Git root and a fixed executable-source pathspec: root runtime metadata/configuration, package manifests and `src` trees, and `prime-agent-runtime` metadata and `src`. It hashes sorted current path/byte pairs independently of Git staging, so adding, modifying, deleting, renaming, or staging the same worktree bytes has one identity while docs, tests, package example configuration, and other non-runtime churn cannot block a busy source daemon. Node bundles hash only sorted relative `.js` bundle/chunk paths and bytes; Bun's supported compiled executable hashes its own bytes in the same bundle domain; npm entrypoint symlinks resolve to the actual bundle. `source-v1:` and `bundle-v1:` are separate domains.
2. `prime-agent.sh` no longer authors or exports `PRIME_AGENT_BUILD_ID`. Its source/dist selection and `PRIME_AGENT_LAUNCHER_PATH` diagnostic are unchanged. A spoofed `PRIME_AGENT_BUILD_ID` is ignored by runtime identity.
3. Client reuse now requires the existing hello's protocol, schema, app version, and `runtime.buildId` to match. Local fingerprint failure propagates before connecting to, classifying, listing, or replacing a daemon. Missing or mismatched remote identity uses the pre-existing idle-replace/busy-refuse path; there is still one fixed per-user socket. Daemon spawning now uses Prime's existing Node/Bun-aware subprocess launch owner.
4. The supervisor compares a worker's existing hello identity with its own before sending worker authentication. Missing or mismatched worker identity is terminal through both adoption and direct recovery. The descriptor file remains in place and is persisted with `lifecycle: "failed"` and `lastError`; the original live process is neither killed nor relaunched. It is never authenticated or adopted by the incompatible supervisor.
5. AIM no longer runs Prime `status --json`, parses build prefixes, or guesses source/dist. It forwards the exact argument list selected by the caller. Plain run/resume retain their explicit `--dist`; rotating resume retains its pre-existing source argument list.

No protocol type, schema, capability, socket, registry, persistent state, credential path, session behavior, dependency, lockfile, runtime pin, or generated manifest changed.

### Environment receipt

- Both pinned worktrees installed from their committed lockfiles with `npm ci`; neither lockfile changed.
- AIM installed 227 packages and reported 10 pre-existing audit findings. Prime installed 354 packages and reported 6 pre-existing audit findings. No `npm audit fix` or dependency mutation was authorized or performed.
- The implementation and proof ran only in the two pinned worktrees; the original dirty Prime worktree and live daemon/runtime state were untouched.

### Verification receipt

| Check | Result |
|---|---|
| Prime identity + launch + existing supervisor-recovery tests | **PASS — 83/83** in 11.90 s |
| AIM `test/pi/prime-target.test.js` | **PASS — 18/18** in 342 ms |
| Prime `npm run check` | **PASS** — Biome checked 901 files with no final fixes; typecheck, installer render, and browser smoke passed |
| AIM `npm run lint` | **PASS** |
| Prime and AIM `git diff --check` | **PASS** |

The focused proof demonstrates staging-independent executable-source identity across modifications, additions, deletions, and renames; tracked and untracked runtime-source sensitivity; docs/test/example-config churn exclusion; canonical npm symlink resolution; path-independent Node bundle and compiled-Bun identity; bundle/chunk/binary sensitivity; source/bundle domain separation; non-executable map exclusion; environment-spoof refusal; loud local/missing-input failure before daemon classification; matching client reuse; missing/mismatched client refusal; idle mismatch shutdown before successor launch; busy mismatch refusal without shutdown; pre-auth worker mismatch refusal; terminal no-kill/no-relaunch recovery behavior; and exact AIM argument forwarding for plain run/resume and the transitional rotate branch.

### Combined-journey cutover warning

Phase 1 is a provenance prerequisite, not a deployable cutover of the combined AIM/Prime rotation journey.

- Plain `aim prime run` and plain `aim prime resume` explicitly select the bundle and are proven against the pinned upstream integration branch.
- Current `aim prime resume … --rotate` selects a new global AIM descriptor, then launches Prime source with `--fork … --reset-credential-binding`. Pinned upstream does not implement `--reset-credential-binding`, and the source launch can conflict with a busy resident bundle under the truthful build fence.
- Therefore the current fork-based rotate command must not be used against this pinned integration branch. Phase 3 replaces it with manual same-session handoff before any combined cutover. Phase 1 does not restore or extend the obsolete fork/reset mechanism.

### First gate review and correction receipt

The first Phase 1 panel did not certify. It required deletion of redundant AIM tests, terminal supervisor recovery ordering, fail-closed local identity ordering, supported Bun/npm-symlink handling, and removal of repository-wide source false churn. Those corrections are now in the same frozen production surfaces. The redundant deleted-seam and unchanged launcher-error assertions were removed; the only budget increase is the existing supervisor recovery test file required to prove the newly discovered causal owner.

### Phase 1 gate receipt

**Status: approved — OVERBUILD-FREE CERTIFIED.** All three panel seats independently inspected the exact corrected bytes and receipts and certified with no remaining change. Phase 1 is closed.

The panel unanimously rejected cross-daemon routing and build-scoped sockets for the pinned topology. Current evidence proves dead persistent state, not a live non-default owner. Adding concurrent daemon residency now would recreate the operator's accumulation problem and force a resolver, ownership policy, and more cleanup behavior without a demonstrated need.

## 2026-08-10 — Frozen Phase 2 scope

Phase 2 is **dead persistent-state truth and tombstone cleanup only**. Production changes belong in existing `daemon-ps.ts`; `daemon-ps-format.ts` may change only if the existing output cannot express the derived result. Proof belongs in existing `daemon-ps.test.ts`; its formatter test may change only if formatting changes. No new file or status enum is funded.

### Liveness and discovery contract

- **Live:** PID exists and stored and observed process-start IDs exist and match.
- **Exact-dead:** PID does not exist, or both process-start IDs exist and differ. It does not count toward tracked workers, session count, or an unreachable live-daemon row.
- **Uncertain:** PID exists but either process-start ID is unavailable. It remains conservatively tracked and is never automatically cleaned. `EPERM` means the PID exists.
- A stale physical supervisor socket may still be reported independently as an orphan file; descriptor presence alone cannot claim a daemon is live.

### Explicit repair contract

Only explicit `doctor --fix`/reap may clean a tombstone. Immediately before deletion it must re-read and reclassify the descriptor, confirm the worker socket is still unconnectable, and confirm every orphan-journal process identity is non-current. A live, changed, or unverifiable identity makes cleanup ineligible.

Eligible cleanup is exact-dead plus `stopRequestedAt`; it may remove only that worker socket, descriptor, recovery journal, and orphan-process journal. It sends no signal, launches no process, and never deletes session transcripts or saved-session data. Exact-dead non-tombstones stop presenting as live evidence but retain their descriptor and journals for the existing recovery path.

### Phase 2 exclusions and reversal gate

Phase 2 adds no routing, daemon selection, build-scoped socket, registry, protocol field, supervisor or launcher change, AIM change, credential/session behavior, janitor, or recovery state machine. Routing may reopen only after exact evidence of a currently live non-default owner that ordinary commands cannot access, or repeated real busy-build mismatches that require deliberate concurrent-version residency. Historical fork topology is not sufficient evidence.

## 2026-08-10 — Phase 2 complete and certified

### Exact implementation

Phase 2 changed two Prime production owners and one existing test owner. Reopening `orphan-process-journal.ts` was required to keep one authoritative journal parser: duplicating its record schema and latest-generation fold in `daemon-ps.ts` would have created two cleanup truths.

1. `daemon-ps.ts` now classifies tracked workers as `live`, `exact-dead`, or `uncertain` using PID existence plus stored/observed process-start identity. Exact-dead descriptors no longer contribute tracked-worker or unreachable-live evidence. Uncertain descriptors remain conservatively visible.
2. Explicit reap considers only exact-dead stop tombstones. Immediately before removal it re-reads the descriptor, re-probes PID/start identity and socket reachability, and rechecks every orphan identity. It sends no signal and launches no process.
3. Cleanup requires the exact supervisor/worker-derived descriptor, recovery-journal, orphan-journal, and worker-socket paths. Missing paths, foreign paths, malformed or unverifiable orphan records, live/uncertain identities, and a canonical socket path occupied by a non-socket all fail closed.
4. Eligible cleanup removes only those four runtime artifacts. Session JSONL and unrelated files are outside the operation. Exact-dead descriptors without `stopRequestedAt` remain on disk for recovery even though they stop presenting as live state.

No routing, daemon selection, build socket, registry, protocol, launcher, supervisor, AIM, credential, session, janitor, dependency, lockfile, or environment behavior changed.

### Verification receipt

| Check | Result |
|---|---|
| Prime daemon-state + orphan-journal tests | **PASS — 25/25** in 1.02 s |
| Prime `npm run check` | **PASS** — Biome checked 901 files; typecheck, installer render, and browser smoke passed |
| Prime `git diff --check` | **PASS** |

The focused proof covers all three liveness states, `EPERM`-conservative PID handling, non-tombstone retention, missing/noncanonical artifact refusal, missing-start and foreign-owner orphan refusal, canonical regular-file socket refusal, current-PID start mismatch, unrelated-file preservation, and final four-artifact removal.

Exact certified hashes:

- `daemon-ps.ts`: `776100e995fac48396198c6b849c96f431be9789`
- `orphan-process-journal.ts`: `44932e7cccae3c9259bed6591a253fa38bb01cdf`
- `daemon-ps.test.ts`: `4db3ec730e355fab39dbad1ef652e7faf3ac3532`

### Phase 2 gate receipt

**Status: approved — OVERBUILD-FREE CERTIFIED.** All three panel seats independently inspected the final bytes and receipts. The panel accepted the bounded canonical-socket `lstat`→`unlink` race rather than funding a new lock, because cleanup is explicit, same-user, path-constrained, signal-free, and fail-closed everywhere identity is uncertain.

Phase 2 is closed. Phase 3 may begin only after the panel unanimously freezes the live-root handoff trigger, ownership contract, deletion list, and proof budget.

## 2026-08-10 — Frozen Phase 3 scope

All three panel seats returned **CERTIFY SCOPE — OVERBUILD-FREE**. The existing operator journey remains:

```text
aim prime resume <session> --rotate
```

### AIM selection and request contract

1. AIM folds the selected session's active branch to obtain the current provider, model, binding, and identity fingerprint. It reuses only the existing pure same-provider selection logic, excludes the current label, and requires a genuinely different eligible account.
2. Selection is read-only. The rotate path cannot call `handleUse`, install or back up a target descriptor, take the target `auth.json` lock, mutate local/Redis selection history, or edit the session file.
3. AIM invokes one private Prime daemon client operation carrying only the selector, expected provider/model, expected binding/fingerprint, and requested binding/fingerprint. The existing supervisor selector route resolves the exact live `activeSessionId`; no AIM status parser or routing layer is added.
4. On success AIM invokes the ordinary `--dist --resume <selector>` attach path. On any refusal or compatibility failure it exits visibly. It never falls back to fork, reset, source launch, global auth mutation, or a second worker.

### Prime live-root commit contract

1. Only the canonical live top-level root may hand off. Prime rejects an inactive selector, unsupported provider, provider/model mismatch, same binding, stale expected tuple, existing handoff, or any busy root tree. Busy includes streaming, retry, compaction, bash, refinement, queued/accepted work, and an active descendant. It does not wait, interrupt, cancel, or replay.
2. Prime acquires a non-waiting root transition guard and pauses new queued-work admission across the current root tree. It verifies the expected tuple and root-tree idleness, resolves the requested exact label/fingerprint with the existing owner-trusted `aimgr-credential-v1` helper, then rechecks the tuple, tree membership, and idleness.
3. Prime appends and synchronously flushes one `aimgr_credential_binding_v1` custom entry to the same session JSONL before publishing memory. The entry contains only provider, source, binding, and identity fingerprint. Secrets never enter the daemon request/response, JSONL, argv, environment, logs, descriptors, or receipts.
4. After the durable append, Prime synchronously publishes the resolved binding/access token through the root-shared `AuthStorage` and closes the old session-scoped Codex WebSocket/continuation. Anthropic has no persistent transport to close. The memory publish is a non-failing swap.
5. The operation preserves the worker PID/start identity, worker ID, `activeSessionId`, runtime object, session/kernel object, session ID/file, transcript, goal, queue, heartbeat, daemon, and current descendants. New descendants inherit the same root `AuthStorage`. A later ordinary restart folds the latest transition and helper-resolves it again.

Crash authority is one-way: before the append, the old binding remains authoritative; after the append, the new binding is authoritative on restart. There is no pending-transition record, rollback entry, generation ledger, or two-phase-commit framework.

### Frozen implementation and deletion budget

- Prime may add one small production file for strict AIM descriptor/helper execution and root binding state. Existing causal owners are limited to `auth-storage.ts`, `agent-session-runtime.ts`, `main.ts`, `daemon-protocol.ts`, `daemon-mode.ts`, and `daemon-command.ts`. `packages/ai/src/index.ts` may change only if the existing Codex close function is not already importable.
- AIM production is limited to `harness-target.js` plus existing help/README wording. Delete the rotate-only `handleUse`/global-install/history branch, `--provider`/`--model`/`--fork`/`--reset-credential-binding` launch, agent-dir override, stale-dist comment, and their obsolete behavior assertions. General `aim prime use`, ordinary resume, and Prime's intentional generic fork remain.
- `daemon-supervisor.ts`, worker framing, `session-manager.ts`, helper v2, stopped-session hydration, slash extensions, automatic 429 logic, wait/queue behavior, provider switching, routing/resolver work, and independent descendant bindings are excluded.
- No new daemon, socket, registry, broker, background worker, Redis state/schema/lease, state file, dependency, lockfile entry, environment variable, compatibility platform, fixture framework, or provider matrix is authorized.

### Frozen proof budget

Use existing test owners wherever possible; add no fixture framework. Permanent proof is limited to:

1. AIM Codex/Claude selection and request construction: exact alternate same-provider tuple, no target/history mutation on success or failure, no fork/reset arguments, and ordinary attach only after success.
2. Prime refusal table: inactive, busy tree, unsupported/wrong provider or model, same/stale tuple, concurrent request, helper failure, and append failure leave journal, binding, transport, worker, and session unchanged.
3. Prime success/restart: exact helper resolution; durable secret-free append before memory publish; next mocked Codex/Anthropic request uses the requested binding; Codex continuation closes once; restart folds the new binding; root/worker/session/kernel/descendant/queue identities are unchanged.
4. Protocol compatibility: the optional handoff command is capability-gated and older daemons fail visibly without fallback. Existing new-client/old-daemon and old-client/new-daemon compatibility proofs remain sufficient if their table-driven coverage includes the new command.

Verification is the affected AIM and Prime test owners, AIM lint, Prime `npm run check`, both `git diff --check`, and one bounded composed source/dist live-root smoke only after the mocked proof is green. No paid provider request or real credential is used during implementation tests.

### Phase 3 gate receipt

**Status: scope approved unanimously — OVERBUILD-FREE.** The panel rejected `daemon prompt` plus `/handoff`: that client attaches, admits user input, and waits for turn/session completion, so it would add public slash UX and transcript semantics while still requiring the same CAS machinery. One typed one-response mutation through the existing selector route is smaller and preserves the current operator command.

## 2026-08-10 — Phase 3 complete and certified

### Exact final implementation

1. AIM folds the selected JSONL's active branch, extracts the canonical session-header UUID, requires a complete current AIM tuple, selects a different same-provider account through a leased Redis runtime, and sends only expected/requested non-secret tuples through `--dist __aim-handoff-credential`. It attaches through ordinary `--dist --resume` only after acknowledgement.
2. Historical sessions without a complete AIM binding now refuse before selection, target/global auth mutation, or launch. The rotate path no longer calls `handleUse`, writes rotation history, forks, resets, or adopts an inactive root.
3. Prime's handoff bridge is hidden from registry/help and delegates to the existing capability/schema-gated daemon command. The canonical live top-level runtime owns the non-waiting guard, tree admission pause, initial/repeated CAS checks, exact helper resolution, append-before-publish transition, root-shared memory update, and Codex transport close.
4. `appendCustomEntryWithRollback` is the only flush owner. The daemon returns only `{ok:true}`. No pending record, rollback event, generation ledger, duplicate flush, global install, stopped-session hydration, or public handoff UX exists.
5. The separately authorized `/usage` maintenance slice publishes only provider/source/binding from the live connection snapshot, renders no whole-pool fallback, acknowledges slow work immediately, and queries provider usage through the same executable-trust/safe-environment boundary with fixed argv, byte bounds, hard deadline, and secret-free parsing.
6. The first-pass deleted-working-directory supervisor repair and force-shutdown recommendation were removed. Busy mismatched daemons remain preserved with default-No guidance.

### Verification receipt

| Check | Result |
|---|---|
| AIM full suite and lint | **PASS — 360/360**; lint pass |
| AIM focused Redis/Prime owners | **PASS — 23/23** |
| Prime focused slice | **PASS — 139/139** |
| Prime `/usage` UI scope | **PASS — 3/3** |
| Prime hidden daemon handoff | **PASS — 3/3** |
| Prime type/check/build | **PASS** — `tsgo`, Biome 904 files, installer render, browser smoke, package build, and dist bundle |
| Diff hygiene | **PASS** in both worktrees |
| Installed help | **PASS** — local dist installed; no public `handoff` command |

No active daemon was restarted or stopped. A current-build live smoke remains deferred until natural idleness so the proof cannot destroy valuable sessions. No clean full Prime suite receipt is claimed; the accepted proof budget is the causal owner suites plus type/check/build, with one unrelated daemon-start test timeout recorded in the architecture document.

### Final acceptance

Revenue, product journey, product engineering, lean architecture, and current external evidence all returned **APPROVE** on the corrected bytes. A fresh independent skeptical review also returned **APPROVE** and found no remaining hack, duplicated owner, unjustified abstraction, test framework, provider matrix, daemon topology, or overbuild blocker.

**Status: Phase 3 closed — OVERBUILD-FREE CERTIFIED.** No Phase 4 implementation is authorized by this gate. Automatic handoff may reopen only with a stable structured rate-limit signal and separately approved provider/account policy.

## 2026-08-11 — Section 13 implementation intake

**Active scope:** architecture panel section 13, authorized by the user's 2026-08-11 instruction to implement it.

**Stop boundary:** implement and verify manual active-tree credential-generation rollover, Codex credential-aware transport, exact Codex automatic recovery capability with policy-gated enablement, the four focused proofs, and one safe installed smoke if mocked proof is green. Do not deploy to `home`, mutate live credentials, stop or replace a resident daemon, or enable automatic consumer-pool failover without applicable provider permission.

**Scope status:** frozen. Section 13 is the source of truth and supersedes Phase 3 only where it removes whole-tree idleness and reopens the exact Codex capability.

### Resume snapshot

- Current state: implementation has started in the two pinned local worktrees; both contain the reviewed uncommitted Phase 0–3 changes that must be preserved.
- Next useful move: land the three non-overlapping owner slices, integrate the exact Codex recovery path, then run only the focused tests required by section 13 before repository checks.
- Do not redo unless stale: section 13 source tracing, real Codex fixture classification, provider-policy review, or Phase 3 acceptance proof.
- Known blockers: no equivalent Claude exhaustion fixture; automatic cross-account enablement remains a release-policy gate.
- Audit log: none specific to this plan. Panel sections 11 and 13 contain the acceptance and implementation-review findings.

### Scope ledger

| Item | Plan anchor | Scope disposition | Status | Proof |
|---|---|---|---|---|
| Remove whole-tree-idle handoff and add generation admission | §13.4 | authorized | Complete in source | Request-generation race + durable single-flight tests pass |
| Make Codex transport and continuation generation-aware | §13.4 | authorized | Complete in source | Transport-affinity test passes |
| Preserve exact Codex exhaustion and add one gated retry | §13.5 | authorized | Complete in source; default-denied in live policy | Exact automatic refusal/race table passes |
| Extend AIM's existing trusted helper/selection seam only as required | §13.4–13.5 | frozen-convergence-required | Complete in source | AIM focused selection/helper tests pass |
| Daemon, watcher, broker, tree drain, call counter, per-child binding, provider framework | §13.8 | out-of-scope | Rejected | No proof funded |

### Code read ledger

| Area | Files/symbols | Why relevant |
|---|---|---|
| Prime root handoff | `agent-session-runtime.ts`, `auth-storage.ts`, `aim-external-auth.ts` | Shared binding owner, durable transition, and async credential resolution |
| Provider admission | `sdk.ts`, direct provider-call constructors in `agent-session.ts` | Generation linearization boundary and side-door coverage |
| Codex transport/failure | `openai-codex-responses.ts`, `stream-failure.ts` | Nested error fidelity and credential-bound WebSocket continuation |
| AIM selection | `harness-target.js`, `prime-target.test.js` | Existing alternate selection, hidden handoff, and attach order |

### Side doors and deletes

| Surface | Expected state | Status |
|---|---|---|
| Whole-tree activity rejection and exact-membership recheck | Deleted | Complete |
| Per-runtime queued-work pause collection | Deleted from credential transition | Complete |
| Root-only Codex socket close | Replaced by credential-aware transport affinity | Complete |
| Generic `429` rotation and repeated cross-binding retry | Absent | Complete |

## 2026-08-11 — Section 13 source implementation complete

### Exact behavior now implemented

1. Manual `aim prime resume <session> --rotate` no longer pauses or drains the root tree. One provider-scoped handoff Promise serializes the durable binding transition; admitted A requests keep immutable A credentials, while unresolved/new requests recheck and start on B.
2. Every inference constructor now crosses the same request-generation admission boundary, including normal turns, both compaction paths, branch summarization, refinement planning/review, and daemon status summarization. No active-call counter, child credential owner, daemon, watcher, lease, or pending-transition record was added.
3. Codex WebSocket and continuation reuse is keyed by the admitted credential identity. A request on B cannot reuse A's authenticated socket or `previous_response_id`; session cleanup still closes all compound-key entries.
4. The automatic path recognizes only nested `usage_limit_reached` with status 429 before content or tool output. It asks AIM for one different policy-approved credential, appends the secret-free tuple before publishing it, retries once, and stops. Generic 429, `rate_limit_exceeded`, output-bearing failures, helper refusal, and a second exhaustion do not rotate or loop.
5. AIM's new `advance` helper operation is read-only and default-deny. Both current and candidate Redis records must have `policy.pool.automaticFailoverApproved === true`; absent/false stays disabled. No command, dashboard, configuration framework, or live policy mutation was added.

### Verification receipt

| Check | Result |
|---|---|
| AIM credential helper + harness + Prime target tests | **PASS — 35/35** |
| AIM lint and diff hygiene | **PASS** |
| Prime Codex parser/transport suite | **PASS — 20/20** |
| Prime composed owner suites | **PASS — 331 passed, 2 skipped** across eight focused files |
| Prime additional side-door caller characterization | **PASS — 103/103** across compaction and serialized-refinement suites |
| Prime `npm run check` | **PASS** — Biome checked 905 files; typecheck, installer render, and browser smoke passed |
| Prime diff hygiene | **PASS** |

The composed automatic proof demonstrates one `resolve`, one `advance`, A then B access tokens, one secret-free A/B journal sequence, successful retry on B, refusal of generic/post-output rotation, and no generic retry after the one cross-binding retry is spent.

### Cutover boundary

- AIM is already installed from the pinned worktree, so its helper source is current.
- Prime's installed launcher still selects the previous reviewed dist bundle. The default daemon reports build `bundle-v1:63cef4024c92b3648f1f63a0668924a0be06cb619fb3113c186dacb5917ecffc` with 207 registered sessions.
- The repository forbids an ad hoc build, and replacing/restarting that live daemon would interrupt valuable work. No wrapper, bundle, daemon, worker, session, credential, Redis policy, or provider state was changed during this cutover check.
- Phase 4 remains open only for a sanctioned bundle/install plus the bounded same-root smoke when the resident daemon can be coordinated safely. Automatic consumer-pool failover remains disabled unless applicable provider permission is documented and the exact records are explicitly approved.
