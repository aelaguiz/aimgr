---
title: Codex Desktop Stable Identity
date: 2026-08-07
status: ready
review_verdict: pass
fallback_policy: fail_closed
owners:
  - aimgr
reviewers:
  - fresh-native-adversarial-review
doc_type: mini-architecture-plan
related:
  - docs/codex-osx-app-storage-investigation-2026-05-31.md
  - docs/aelaguiz/v2-proposal.md
  - https://learn.chatgpt.com/docs/remote-connections
---

# TL;DR

Reserve the native default Codex home, `~/.codex`, for the ChatGPT/Codex desktop
app and its one stable account. On this machine that account is AIM label
`amir_cratejoy_personal`, matching the user's “Amir Cratejoy personal” account.
Move AIM's rotating local Codex projection to one locked dedicated home,
`~/.aimgr/codex-cli`, route all terminal Codex work through `aim codex run`, and
reserve the personal account by retiring its Redis credential so Desktop—not
AIM maintenance, helpers, or copied consumer stores—is its only token owner.

This is the smallest reliable fix because Codex stores both authentication and
remote-control enrollment under `CODEX_HOME`. A single home cannot
simultaneously mean “Desktop is always personal” and “AIM may rotate this
identity.” The plan does **not** edit Electron cookies, use Codex's unstable
external-token protocol, or expand into per-label homes.

# North Star

**Claim.** AI Manager operations may rotate pooled Codex CLI work without ever
changing, deleting, reconciling, or adopting the desktop app's credential. The
desktop app remains signed into `amir_cratejoy_personal`, so Remote Control can
consistently resolve the enrollment for that same ChatGPT account and workspace.

**In scope.** Split the native Desktop home from the locked AIM rotating home;
reserve and retire the personal Redis credential; fence every helper,
materializer, and refresh path; add the launcher and quiescent fleet migration;
update safe status, docs, and tests.

**Out of scope.** Per-label Codex homes, Electron profile mutation, keyring/auto
backend support, a custom Remote Control implementation, remote app-server
transport, Pi/Prime redesign, pool-policy redesign, and hot-swapping the account
inside a running Codex process.

**Definition of done.**

1. The unsafe process-independent `aim codex use/watch` projection surface is
   removed; `aim codex run` is the only AIM-owned local Codex mutator and can
   target only `~/.aimgr/codex-cli`.
2. Managed runs leave `~/.codex/auth.json` and the Desktop enrollment rows
   unchanged.
3. `amir_cratejoy_personal` is reserved exclusively for native Desktop use:
   its immutable account ID is protected across every label; raw material is
   retired; and AIM publishers, consumers, helpers, login, maintenance, or
   restore paths cannot select, refresh, alias, or rematerialize it.
4. All terminal Codex work uses `aim codex run [label] -- [args...]`; raw
   `codex` against `~/.codex` is outside the supported stable-identity contract.
5. One non-time-stealable managed-home owner lock serializes each run from
   selection until its launched child exits; concurrent runs fail closed.
6. `aim status` independently reports only safe Desktop label/match/reservation
   booleans and rotating CLI label state—never raw identity or enrollment data.
7. On the real machine, Desktop is signed into `amir_cratejoy_personal`, Remote
   Control is enabled for that account, and a remote client on the same account
   and workspace can reconnect after a full access-token refresh/restart cycle.

**Invariants.**

- Redis remains the credential authority for AIM-managed pool labels; the
  Desktop-reserved record keeps identity/policy metadata but no AIM-usable
  credential material.
- The desktop app is the sole credential writer and refresh owner for the
  reserved `amir_cratejoy_personal` identity and its native `~/.codex` file.
- AIM never refreshes the reserved identity, copies a pooled credential into the
  Desktop home, or exposes its raw stable ID in status.
- Identity checks use immutable Codex `accountId` internally and an opaque
  fingerprint in reservation metadata; labels are only human names and a label
  rebind is an identity conflict.
- Secrets, raw identity IDs, WebSocket URLs, server IDs, and environment IDs
  never enter status output, tests, receipts, or this document.

## Scope and Simplicity Contract

- **Human-authorized outcome:** keep the Codex desktop app permanently on the
  user's `amir_cratejoy_personal` identity while AI Manager rotates other Codex
  consumers; preserve Remote Control connectivity; save a code-grounded plan
  and subject it to adversarial review.
- **Smallest sufficient solution:** two homes, one launcher, one managed-home
  lock, and one exclusive Desktop reservation that retires the Redis credential.
  Native Desktop owns `~/.codex` and the personal refresh-token lineage; AIM owns
  one rotating home at `~/.aimgr/codex-cli`.
- **Initial minimal convergence closure:** delete process-independent local
  `codex use/watch`; add one locked `aim codex run`; use a provider-wide identity
  catalog lease plus the existing credential lease to reserve the Desktop
  account across labels; gate every publisher/helper/materializer/restore from
  the raw record set; and drain/delete active and backup copies before transfer.
- **Scope freeze:** frozen at this plan's ready verdict. A later request for
  per-label homes, shared cross-home session history, keyring support, or live
  app-server switching requires human approval.
- **Enough proof:** two-home mutation-isolation tests, launcher/service routing
  tests, separate status tests, and one real same-account Remote Control smoke
  test.
- **Do not build:** no cookie/LevelDB writer, no `Codex Safe Storage` edits, no
  internal `chatgptAuthTokens` bridge, no state-DB copying or symlinking, and no
  generalized multi-product home framework.
- **Accepted residual risk:** Desktop and rotating CLI histories become separate
  because authentication, sessions, plugins, and SQLite state share the same
  native `CODEX_HOME` boundary. Raw `codex` against the native home is not a
  supported co-owner; all terminal work must use `aim codex run`.

<!-- arch_skill:block:planning_passes:start -->
# Planning Passes

- Repository trace: AIM credential authority, Codex target mutation paths,
  reconciliation, selection, watch, status, CLI dispatch, and tests.
- Local runtime trace: installed app/binary metadata, current AIM target status,
  auth identity mapping, watch installation, and redacted Remote Control rows.
- Upstream trace: current local Codex source for home resolution and account-
  scoped enrollment behavior.
- Official product trace: OpenAI's Remote Connections documentation.
- Independent adversarial review: recorded below after a clean read-only review.
<!-- arch_skill:block:planning_passes:end -->

<!-- arch_skill:block:research_grounding:start -->
# Research Grounding

## Confirmed current behavior

1. **AIM and Desktop share the same authentication file today.**
   `resolveManagedCodexHomeDir()` uses ambient `CODEX_HOME` or defaults to
   `~/.codex` (`src/io/paths.js:109-115`). `applyCodexCliFromState()` writes the
   selected Redis credential to that home's `auth.json`, reads the account back,
   and records one `targets.codexCli` selection (`src/targets/codex-cli.js:24-87`).
   `aim codex use` and `aim codex watch` both call this path
   (`src/cli/commands/codex.js:9-95`).

2. **AIM has destructive authority over the shared file.** If no pooled account
   is eligible, selection can delete the managed `auth.json`
   (`src/targets/codex-cli.js:590-655`, `src/targets/codex-store.js:91-103`).
   Reconciliation can also overwrite a locally older credential from Redis
   (`src/targets/codex-cli.js:239-377`). Atomic writes prevent torn JSON, but
   they do not give AIM and Desktop different ownership.

3. **The installed Desktop app is the current ChatGPT/Codex bundle.** On
   2026-08-07 this Mac has `/Applications/ChatGPT.app`, bundle identifier
   `com.openai.codex`, app version `26.803.41515`, and bundled
   `codex-cli 0.147.0-alpha.6.5`. The older repo investigation used the former
   `/Applications/Codex.app` name, but its important storage conclusion still
   matches the live machine: Desktop's Rust app server uses the default
   `~/.codex` home while Electron browser data is separate
   (`docs/codex-osx-app-storage-investigation-2026-05-31.md:14-40,280-313`).

4. **Remote Control is explicitly account-scoped.** Current Codex source looks
   up persisted enrollments by `websocket_url`, `account_id`, and
   `app_server_client_name`
   (`~/workspace/codex/codex-rs/state/src/runtime/remote_control.rs:29-65`).
   If the active auth account changes, the transport clears its in-memory
   enrollment and can disable Remote Control
   (`~/workspace/codex/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs:1432-1483`).

5. **Official OpenAI documentation requires the same account and workspace.**
   Remote setup requires the host desktop app and controlling device to be
   signed into the same ChatGPT account and workspace. Signing out turns Remote
   Control off but retains pairings; the user must turn it back on after signing
   in. Source: [OpenAI Remote Connections documentation](https://learn.chatgpt.com/docs/remote-connections).

6. **The live machine already demonstrates identity churn.** A redacted
   2026-08-07 read found:

   - AIM's local `codexCli` receipt expected `pro5`.
   - The shared native `~/.codex/auth.json` actually mapped to `cfo`.
   - `state_5.sqlite` contained two enabled `Codex Desktop` Remote Control
     enrollments for the same host: one mapped to `cfo`, and an older one mapped
     to `amir_cratejoy_personal`.
   - The latest enrollment matched the current native auth (`cfo`), not AIM's
     recorded `pro5`.
   - No AIM Codex watch LaunchAgent is currently installed on this Mac.

   This proves a shared-home, competing-writer problem; it does not prove a
   background AIM watcher caused the latest switch. AIM last wrote one identity
   and Desktop later held another. Either side can make the other side's state
   stale.

7. **A supported isolation boundary already exists.** Codex resolves
   `CODEX_HOME` from the process environment and otherwise uses `~/.codex`
   (`~/workspace/codex/codex-rs/core/src/config/mod.rs:4510-4519`). That boundary
   moves auth, config, sessions, SQLite state, plugins, and Remote Control state
   together. Current source even documents that a single `CODEX_HOME` is assumed
   to belong to one product
   (`~/workspace/codex/codex-rs/core-plugins/src/manager.rs:493-500`).

8. **Pi and Prime are already isolated from this file.** Their AIM integration
   installs non-secret external descriptors and resolves access tokens in
   memory; it does not project pooled credentials into `~/.codex/auth.json`
   (`README.md`, “Pi and Prime managed credentials”; `src/targets/harness-auth.js`).
   Their auth transport does not need redesign, but both automatic and explicit
   binding must honor the Desktop-exclusive reservation.

9. **Home separation alone does not separate refresh-token ownership.**
   `aim auth maintain` scans due Codex records independently of pool eligibility,
   and `resolveHarnessAccessCredential()` can refresh an exact label for a
   pre-existing Pi/Prime descriptor after a fresh Redis read
   (`src/cli/commands/auth.js`, `src/credentials/harness-access.js`). Desktop can
   also refresh its native credential. Stable Desktop identity therefore needs
   an exact reservation predicate at those fresh-read boundaries and must
   retire the AIM credential material after quiescence; merely setting
   `pool.enabled=false` is insufficient.

10. **Materialized raw credentials outlive Redis policy.** OpenClaw and Hermes
    write access/refresh material into consumer-owned files
    (`src/openclaw/apply.js`, `src/targets/hermes-auth.js`). A reservation CAS
    cannot revoke those copies or fence a command that loaded state earlier.
    Cutover must stop the fleet, remove/reassign those copies, wait out in-memory
    helper access caches, and use the existing per-credential Redis lease plus a
    fresh reservation read before every new projection/refresh.

11. **Both homes need single-writer process rules.** Upstream Codex auth refresh
    locking is process-local, not a cross-process file lock. Desktop therefore
    cannot safely share `~/.codex` with a raw CLI process. A rotating home also
    cannot support independent `use/watch` writers and an exact run. The target
    contract reserves native home for Desktop, deletes those projection
    commands, and holds one managed-home owner lock from selection through child
    exit.

12. **Current collision checks go blind after credential retirement.** The
    normalized coordination snapshot excludes an identity-only record whose
    `credential` is empty, so label-local checks cannot prevent the same account
    from being logged in or imported under a new label. Reservation enforcement
    must scan the raw Codex record set, including policy-only records, under one
    provider-wide identity-catalog lease.

13. **An ordinary TTL lease does not fence a stale scan.** Existing credential
    leases can expire and transparently reacquire while target CAS watches only
    one label key. A sleeping publisher could therefore scan before pin and
    commit an alias afterward. Identity writes need an atomic live-token fence;
    lease loss invalidates the scan rather than resuming it.

## Existing proof worth reusing

- Explicit and automatic Codex selection:
  `test/codex/use-watch.test.js:73-156`.
- Watch threshold rotation and failure behavior:
  `test/codex/use-watch.test.js:172-222`.
- Same-identity reconciliation and true no-op behavior:
  `test/codex/reconciliation.test.js:58-141`.
- Projection and local-state receipts:
  `test/cli/redis-projection-command.test.js`.
- Watch installation command/environment:
  `scripts/lib/watch-install.sh`, `test/scripts/watch-install.test.js`.

## Decision from the evidence

Do not try to make two identities coexist inside one home. Keep the native home
boring and stable; move the rotating consumer. This uses Codex's supported
process boundary and removes AIM/Desktop write contention instead of adding
coordination around it.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
# Current Architecture

```text
Redis credential records
        |
        | aim codex use/watch + reconcile
        v
~/.codex/auth.json  <----> Desktop app refresh/account changes
        |
        +--> direct Codex CLI
        +--> Desktop Rust app-server
        +--> ~/.codex/state_5.sqlite
                +--> Remote Control enrollment keyed by account_id
```

There is one path resolver, one native auth file, one local
`targets.codexCli.activeLabel`, and multiple processes with independent caches
and refresh behavior. AIM assumes the file is its rotating projection. Desktop
assumes the same home is its persistent product state. The latest file writer
wins, while the Remote Control lookup changes with the resulting account ID.
Independently, AIM maintenance and Desktop can rotate the same provider refresh
token, so merely changing one file path would leave a delayed invalid-token
failure.

The Electron profile is not the correct isolation seam. It stores app/browser
state, but the Rust app-server's authentication, session, and enrollment logic
still depends on the Codex home. Editing Electron storage would create another
unsupported credential authority without removing the existing race.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
# Target Architecture

```text
                         NATIVE / STABLE
Desktop app only -----------------------------> ~/.codex
                                                   auth + refresh: personal
                                                   Desktop sessions + SQLite
                                                   Remote enrollment: personal

                         AIM / ROTATING
Redis pool --> locked aim codex run ----------> ~/.aimgr/codex-cli
                    |                              auth: selected pool label
                    +--> child -------------------> pooled CLI sessions + SQLite
                         owner lock held until both parent and child exit

Reserved Redis record: identity + policy only; no credential material
```

## Ownership rules

### Native Desktop home: `~/.codex`

- Owned exclusively by the installed Desktop app and its native login/refresh.
  Raw `codex` against this home is not a supported co-owner because upstream
  refresh locking is process-local.
- The expected account is AIM label `amir_cratejoy_personal`, verified internally
  by immutable account ID and represented in policy/status with an opaque
  fingerprint and match boolean.
- `aim codex desktop pin <label>` never writes native auth. With Desktop already
  on the desired account and the fleet quiesced, it acquires the existing
  per-credential Redis lease, refreshes the exact record, verifies native and
  Redis identities match, then performs one CAS that reserves the identity and
  retires its Redis credential material.
- Exact normalized record shape after pin:

```yaml
identity:
  accountId: <internal-only immutable ID>
credential: {}
policy:
  expect:
    codexDesktop:
      reserved: true
      ownerHost: Amir-M5
      identityFingerprint: <opaque fingerprint>
      reservedAt: <ISO timestamp>
  pool:
    enabled: false
    disabledReason: codex_desktop_reserved
health:
  status: native_owned
  reason: codex_desktop_reserved
```

- `policy.expect.codexDesktop` is the one canonical reservation location because
  existing normalization preserves arbitrary `expect`. Add
  `listRawCodexIdentityRecords()` that includes credential-empty records and
  `buildReservedCodexIdentityIndex()` keyed internally by immutable account ID.
  Never derive this index from `state.credentials` or the normalized snapshot.
  Every record writer round-trips the policy and verifies its fingerprint still
  matches `identity.accountId`.
- Add a provider-wide Redis identity-catalog lease with a unique opaque token
  for each acquisition. Pin acquires catalog then per-label credential lease,
  fresh-scans all raw records, and rejects same-ID aliases. Its commit uses a
  new `WATCH`/`MULTI` boundary that watches both the catalog-lease key and
  target-record key, verifies live token plus expected version, and writes the
  reserved/cleared record only if `EXEC` succeeds.
  Lease loss terminates that scan; transparent reacquisition is forbidden. A
  retry gets a new token and restarts the raw scan and expected-version reads.
- Login/OAuth publish, import, rebind, reconciliation, portable promotion,
  unpin, and every other identity-changing write use that same fenced CAS.
  Consumers/helpers/materializers/restores compare against the fresh global
  reserved-ID index, not merely local policy. Fixed lock order is catalog then
  credential; unpin is the only reservation removal path.
- Clearing the Redis credential is deliberate defense in depth: old automatic
  clients see a missing credential even if they do not understand the policy.
  Cutover also removes the matching identity from AIM-created OpenClaw/Hermes
  file backups and displaced Pi/Prime auth backups. Reserved-entry removal must
  not create a new secret-bearing backup; unrelated entries are preserved in a
  sanitized backup. The identity record remains for mapping and status.

### AIM rotating CLI home: `~/.aimgr/codex-cli`

- The sole target for reconciliation, selection, projection, and terminal Codex
  work. Delete `aim codex use`, `aim codex watch`, and the local watch installer;
  each run performs the necessary fresh reconciliation/selection itself. The
  resolver never inherits ambient `CODEX_HOME`, and aliasing with `~/.codex` is
  a hard blocker.
- `aim codex run <label>` selects that exact non-reserved label under the lock.
  Unlabeled `aim codex run` performs the existing automatic selection at run
  start. There is no durable preselection or hot-swap contract.
- The long-lived lock is an AIM-owned atomic directory with owner metadata
  `{managerPid, childPid, nonce, createdAt}`—not a time-stale
  `proper-lockfile`. It is held from fresh Redis read through child exit.
  Recovery may remove it only when both recorded processes are proven dead;
  age, missed heartbeats, or macOS sleep never authorize stealing. Ambiguous PID
  reuse/liveness fails closed for operator cleanup. Concurrent runs are blocked.
- Before any provider refresh or credential side effect, the consumer acquires
  the required lease, reloads the exact raw record plus global reserved-identity
  index, and rejects either a marked record or same-ID alias. This includes
  `resolveHarnessAccessCredential()` and harness uninstall restore for
  already-installed Pi/Prime descriptors.

### Status and proof data

- `codexDesktop` status exposes only home, expected label, inferred label,
  readable/match/reserved booleans, and safe fixed reason codes.
- `codexCli` status exposes only managed home, selected/inferred labels,
  lock state, receipts, and blockers.
- Raw account IDs, fingerprints, auth JSON, WebSocket URLs, server IDs, and
  environment IDs are never projected into status. AIM does not add an
  enrollment-DB reader; the official same-account/workspace Remote smoke is the
  proof of usability.

## Quiescent migration

1. Deploy the reservation predicate, fresh-read gates, managed-home resolver,
   owner lock, and `use/watch` deletion to every AIM machine. Uninstall any
   legacy Codex watch service and pause OAuth maintenance, Hermes watchers,
   OpenClaw/Hermes workers, raw Codex processes, and relevant Pi/Prime roots.
2. Move every assignment off `amir_cratejoy_personal` and resolve any Codex
   label whose raw record has the same immutable account ID; pin will not hide
   or merge an alias. Remove the matching identity from active OpenClaw/Hermes
   stores, timestamped backups, and displaced Pi/Prime backups without creating
   another secret-bearing backup. Wait out helper caches and record per-host
   active-and-backup inventory receipts.
3. Create/seed `~/.aimgr/codex-cli` with a different eligible label. Prove all
   AIM mutation paths target it and the native home hash remains unchanged.
4. Through the official Desktop UI, switch/login to
   `amir_cratejoy_personal` while AIM refreshers remain paused. Re-enable Remote
   if the login flow turns it off.
5. Run `aim codex desktop pin amir_cratejoy_personal`. Label↔identity, native
   actual↔expected, or same-ID alias conflict blocks with zero writes. On
   success the catalog+credential leases, raw scan, and live-token fenced CAS
   write the reservation and clear the Redis credential.
6. Restart current AIM services. Confirm every automatic/explicit consumer and
   the credential helper refuses the reservation, then run all CLI work through
   `aim codex run`.
7. Reconnect Remote from a device on the same ChatGPT account and workspace.
   Reuse the existing account-scoped enrollment if Codex does so naturally;
   otherwise pair again. No enrollment row is copied or edited by AIM.

## Rollback

- Stop Desktop and all AIM consumers before changing ownership.
- Unpin acquires the same per-credential lease, verifies host and identity
  fingerprint, and removes the reservation metadata. It does not restore the
  retired credential.
- A fresh `aim login <label>` is required before the account can re-enter AIM;
  never reuse a pre-pin refresh token or copied credential file.
- Do not merge or symlink live SQLite/WAL/session data between homes. Reverting
  to one shared home requires explicit acceptance of the original race.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
# Call-Site Audit

| Surface | Current role | Required change |
| --- | --- | --- |
| `src/io/paths.js` | Generic Codex home resolver, ambient env or `~/.codex` | Split native and AIM home resolvers; reject canonical collision |
| `src/targets/codex-store.js`, `src/targets/codex-cli.js` | Read/write/reconcile/select/cleanup one home | Route every mutation to locked AIM home; native inspection is read-only |
| `src/cli/commands/codex.js`, `src/pool/watch.js` | `use/watch` can rewrite target independently | Delete local `use/watch`; add run/pin/unpin and owner-PID lock |
| `src/coordination/records.js`, `snapshot.js`, `runtime.js`, `login-publish.js` | Normalized snapshot omits credential-empty records | Preserve `expect`; add raw-record list and global reserved-ID index including identity-only records |
| `src/coordination/redis-store.js`, Redis leases | TTL lease can reacquire; CAS watches target only | Add unique catalog token and `WATCH` both lease+target before `MULTI/EXEC`; lease loss invalidates scan; catalog→credential order |
| Codex reconcile/portable promotion | Can publish identity from local auth | Acquire catalog lease and reject reserved ID under any label |
| `src/cli/commands/auth.js`, `src/cli/commands/login.js`, OAuth publish | Maintain/login exact labels | Reject global reserved-ID aliases; represent credential-free `native_owned` health |
| `src/credentials/harness-access.js`, credential helper | Fresh-read exact label and may force refresh for Pi/Prime | Gate before cache/refresh/token return, including pre-existing descriptors |
| `src/targets/harness-auth.js`, AIM harness backups | Uninstall can restore displaced raw auth | Gate restore after fresh reservation read; delete matching backup at cutover |
| `src/openclaw/apply.js`, `src/io/json-store.js`, rebalance paths | Materialize raw credentials and timestamped backups | Reject reservation; reserved-entry removal writes no secret-bearing backup; retire old matching backups |
| `src/targets/hermes-auth.js`, Hermes rebalance/write | Materialize raw access/refresh copies | Reject reservation and remove copied profile before pin |
| Pi/Prime explicit and automatic binding commands | May persist exact label descriptors | Reject reservation; stop/wait existing roots during migration |
| `src/cli/commands/redis.js`, label rebind, browser/policy writers | Can introduce/rebuild identity | Under catalog lease reject incoming reserved ID across labels; preserve policy; unpin-only removal |
| `src/status/redis-view.js`, table/render/sanitize | One `codexCli` view; sanitizer does not redact IDs | Project safe label/boolean views only; no enrollment DB reader or raw IDs |
| Local state/schema | One local `codexCli` target | Add safe `codexDesktop` expected-label/fingerprint metadata and managed lock/receipts |
| `scripts/install-codex-watch.sh`, `scripts/lib/watch-install.sh` | Install process-independent local watch | Remove Codex watch installer/commands/docs; Hermes watch remains |
| CLI args/help/README | Teach `use/watch` against implicit target | Make `aim codex run` the only supported terminal lane; document quiescent pin/unpin |
| Tests | Single home, no reservation/lock | Add paired-home, policy round-trip, helper, drain, concurrency, redaction, and no-write cases |

## Side doors to close

- No rotating caller may fall back to `~/.codex`, and no cleanup path may delete
  native auth.
- No reservation-blind refresh remains in maintenance, login, credential helper,
  imported snapshots, or already-loaded target state.
- No writer may drop `policy.expect.codexDesktop` or publish its immutable ID
  under another label; credential-empty records remain globally visible, and no
  expired/reacquired catalog lease may commit from an earlier scan.
- No OpenClaw/Hermes raw credential copy, AIM-created secret backup, displaced
  harness backup, or live Pi/Prime helper cache remains at ownership transfer;
  uninstall cannot restore one later.
- No managed-home writer exists outside `run`; lock age/heartbeat never proves
  death, and recovery cannot steal from a sleeping live owner or child.
- No raw native `codex` flow is documented as supported while Desktop owns the
  home.
- No status/error/receipt projects raw identity or enrollment columns.

## Explicit non-changes

- Redis remains the shared authority for AIM-managed credentials; the reserved
  record is intentionally identity/policy-only rather than an AIM credential.
- Existing consumers keep their launch transports; they only gain reservation
  gates and cutover cleanup for the exact account.
- No AIM Remote Control implementation or enrollment reader is added.
- `docs/aelaguiz/v2-proposal.md` remains a broad strawman; this plan does not
  adopt per-label homes.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
# Phase Plan

## Phase 1 — Build the hard ownership boundaries

**Goal:** make native-home mutation, reservation loss, stale credential use, and
managed-home races impossible before changing the live account.

**Work:**

1. Split native/AIM home resolvers and make `aim codex run` the only local
   rotating mutation into `~/.aimgr/codex-cli`; delete `use/watch` and their
   installer/docs; reject canonical collision and ambient fallback.
2. Add the atomic owner-directory lock with manager/child PID metadata. Define
   exact/unlabeled run, signal/exit behavior, proven-dead recovery, and
   fail-closed ambiguous liveness; hold it through child exit.
3. Normalize `policy.expect.codexDesktop`, credential-free `native_owned`, and
   round-trip preservation. Add the unique-token catalog lease, fixed catalog→
   credential order, and live-token+target-version fenced CAS for every identity
   write; lease loss aborts and retry restarts the scan.
4. Build the reserved-ID index from all raw Codex records, including empty
   credentials. Gate login/OAuth publish, import, rebind, reconcile/promotion,
   maintenance, helper, binding/materialization, and restore across labels. Add
   identity-targeted active/backup cleanup with no replacement secret backup.
5. Split status into safe label/boolean projections; do not read enrollment rows
   or rely on the generic sanitizer for identity privacy.
6. Update docs/help so all CLI use enters through `aim codex run`; raw native
   CLI is outside the Desktop stability guarantee.

**Verification:**

- Two-home tests prove native auth/session/enrollment sentinels are unchanged by
  exact/automatic run, helper, maintenance, no-eligible handling, and failures.
- Reservation round-trips through browser/policy publications. A pre-pin
  duplicate alias blocks pin; post-pin login, OAuth publish, reconcile, portable
  promotion, rebind, and generic import under another label reject the same ID,
  including while the canonical credential is empty. Race proof pauses publisher
  A after its scan until its lease expires, lets pin B reserve/release, and proves
  A's stale cross-label fenced commit fails; a retry must rescan under a new token.
- No raw identifiers appear in JSON/text/error receipts.
- Pre-existing Pi/Prime descriptors, forced helper refresh, uninstall restore,
  explicit consumers, and only-reserved/no-alternate cases reject with zero
  writes; active and AIM-backup scans find no matching raw material after pin.
- Concurrency tests cover exact run vs another run from selection through spawn
  and exit, signal forwarding, macOS sleep/overdue heartbeat, live manager/dead
  child, dead manager/live child, both-dead recovery, and ambiguous PID reuse.
- Targeted tests plus `env -u CODEX_HOME npm test` and `npm run lint` pass.

**Done bar:** current code can enforce the new boundary on every machine without
an implementer inventing policy, lock, redaction, or launcher semantics.

## Phase 2 — Quiescent fleet cutover and Remote proof

**Goal:** transfer the personal credential lineage to Desktop only, remove old
copies, and prove the desired remote workflow across refresh/restart.

**Work:**

1. Deploy Phase 1 to all participating machines; stop maintainers, watchers,
   OpenClaw/Hermes workers, raw Codex processes, and relevant Pi/Prime roots.
2. Reassign the personal label everywhere; remove matching active raw entries,
   timestamped OpenClaw/Hermes backups, and displaced harness backups without
   creating new secret copies; wait out helper caches; capture a safe receipt
   per host.
3. Seed the managed home with a different label and prove it is the only AIM
   mutation target.
4. Switch Desktop through the official UI to `amir_cratejoy_personal`, then run
   pin. Pin requires Redis identity and native actual identity to match, retires
   the Redis credential, and leaves native auth untouched.
5. Restart current services and prove every automatic/explicit/helper path still
   rejects the reservation. Enable/re-pair Remote on the same account/workspace.
6. Rotate the managed CLI repeatedly, run scheduled maintenance, fully restart
   Desktop, and cross a real Desktop-owned access-token refresh/401 boundary.

**Verification:**

- Desktop identity, Desktop thread resume, enrollment behavior, and Remote
  connection remain stable across pool rotations, maintenance, refresh, and
  restart.
- `aim codex run <label>` proves exact identity; a concurrent run is refused;
  unlabeled run proves automatic-at-start semantics.
- Receipts contain labels, booleans, fixed reasons, versions, hosts, and
  timestamps only.
- Rollback drill proves unpin requires Desktop/consumers stopped and a fresh AIM
  login; no retired refresh token or copied credential is reused.

**Done bar:** Remote reconnects after a real refresh/restart, Desktop is the only
holder of usable personal credential lineage, and rotating CLI work remains
fully operational through the locked AIM home.
<!-- arch_skill:block:phase_plan:end -->

# Risks and Failure Modes

| Risk | Mitigation |
| --- | --- |
| Raw `codex` is run against the native home | Unsupported under the strong guarantee; stop it and use locked `aim codex run` |
| App account switch turns Remote off | Follow official UI flow, then re-enable/re-pair on the same account/workspace |
| Managed/native paths alias through a symlink | Compare canonical paths before mutation/launch and fail closed |
| Same account is published under another label | Raw reserved-ID index plus unique-token catalog lease and atomically fenced identity CAS; expired scans cannot commit |
| Reservation is dropped by another writer/import | Canonical `expect` schema, round-trip tests, and unpin-only removal |
| Stale process, active store, or AIM backup retains personal refresh token | Fleet quiescence, lease/fresh read, identity-targeted active+backup cleanup, cache wait, then Redis credential retirement |
| Pi/Prime helper or uninstall restores exact label | Gate helper and restore after fresh read; delete matching displaced backup at cutover |
| Sleeping run loses a time-stale lock | Owner/child liveness, never age, controls recovery; uncertainty fails closed |
| Status leaks identity/enrollment data | Explicit safe projection; no enrollment reader; no raw IDs in sanitizer input |
| Separate homes split session/plugin state | Accept split; never symlink live SQLite/session state |
| Desktop login changes outside AIM | Safe pin mismatch becomes loud; AIM never auto-repairs native auth |
| Old app/storage research drifts | Record current app/binary versions in live proof and fail closed on backend change |

# Adversarial Review

A clean read-only reviewer audited the plan against the named source paths and
returned **pass** after five bounded rounds. The review forced closure of:

- exact durable reservation schema, helper/maintenance gates, Desktop-only
  native ownership, run serialization, pin mismatch semantics, and safe status;
- active and backup credential remanence plus harness uninstall restore;
- deletion of `use/watch` and sleep-safe manager/child run ownership;
- cross-label aliases of the same immutable account via a raw global index; and
- stale catalog scans via unique acquisition tokens and lease+target fenced
  Redis commits.

Final verdict: `pass`; failure reasons: none; confidence: high.

# Ready Verdict

**Ready for implementation with `miniarch-step implement`.** The architecture
is intentionally narrower than the repo's v2 per-label-home proposal: it creates
exactly one Desktop-only native home and one locked AIM rotating home, closes
the current credential, alias, restore, concurrency, and status side doors, and
adds only the launcher and proof surfaces needed to operate the split.
