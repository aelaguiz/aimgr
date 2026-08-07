# Codex Desktop Stable Identity — Implementation Log (branch: codex-desktop-stable-identity)

Plan: `docs/CODEX_DESKTOP_STABLE_IDENTITY_MINI_ARCH_PLAN_2026-08-07.md` (Phase 1 only; Phase 2 live cutover deliberately pending).

## Status

- [x] Foundation: split home resolvers, collision guard, fake-redis WATCH semantics (e8ce6d4)
- [x] Reservation core: raw record scan, reserved-ID index, catalog lease, fenced CAS (`src/coordination/codex-identity.js`)
- [x] Target routing: all AIM codex mutations -> `~/.aimgr/codex-cli`; native `~/.codex` read-only; `aim sakana use` env targets the managed home under the run lock
- [x] Delete `aim codex use/watch` + watch installer + docs/help/package scripts (hermes watch retained)
- [x] `aim codex run [label] -- args` + owner-directory lock (manager/child PID metadata, atomic-rename reclamation, fail-closed ambiguous liveness)
- [x] `aim codex desktop pin/unpin` + credential retirement + `native_owned` health round-trip
- [x] Publisher gates: runtime/login-publish/browser-policy/maintenance/import/rebind publish codex records through the guarded fenced path; login has no direct publish side door
- [x] Consumer gates: harness helper (`desktop_reserved`), Pi/Prime binding, OpenClaw/Hermes materialization + rebalance, uninstall restore (fail-closed incl. unconfigured Redis)
- [x] Identity-targeted drain cleanup (`aim codex desktop drain <label> (--dry-run|--confirm)`): OpenClaw stores/backups, Hermes profiles, managed-home auth.json, displaced Pi/Prime backups; no replacement secret backup
- [x] Status split: safe `codexDesktop` + `codexCli` projections (booleans, labels, lock facts, fixed reasons; no raw IDs)
- [x] Tests: two-home isolation, reservation round-trip/alias/race, lock lifecycle + recovery matrix, drifted-alias gates, helper rejection, drain exactness/idempotence, redaction
- [x] Full `env -u CODEX_HOME npm test` (388 pass / 0 fail) + `npm run lint` clean

## Commits

- `e8ce6d4` feat: split Codex homes, add identity reservation core, replace use/watch with run/pin/unpin
- `698c343` feat: reservation gates, drain cleanup, safe status split, and isolated proof suite
- (this commit) fix: close adversarial-review findings (drifted-alias gates, pre-write projection gate, lock reclamation race, drain managed-home sweep, honest status reasons)

## Changed ownership surfaces

- Native `~/.codex`: Desktop-owned; AIM reads it only in `readCodexDesktopStatus` and pin verification.
- `~/.aimgr/codex-cli`: the one AIM rotating home; single writer `aim codex run` (plus `aim sakana use` .env, serialized behind the same owner lock).
- Redis codex records: identity-bearing writes go through the provider-wide catalog lease + live-token fenced CAS; the Desktop-reserved record is identity/policy-only (`credential: {}`, `native_owned`).
- Reservation gates consult BOTH `identity.accountId` and `credential.accountId` (drifted-alias defense) at: run selection, managed-home projection (`applyCodexCliFromState`, zero-write), maintenance, credential helper, auth maintain scan, hermes/openclaw materializers + rebalancers, Pi/Prime binding, uninstall restore, import, rebind, browser policy round-trip.

## Exact proof commands

- `env -u CODEX_HOME npm test` → 388 pass / 0 fail (isolated temp homes + in-memory fake Redis with real WATCH/MULTI + expiry-abort semantics)
- `npm run lint` → clean

## Adversarial findings and dispositions

Three clean read-only critics (plan-backed audit, concurrency/credential safety, regression/CLI/test quality) returned pass-with-findings, no blockers. Dispositions:

- MAJOR drifted-alias `??` gate hole (identity vs credential accountId): fixed via `assertCodexRecordUseAllowed` (both IDs) at every record-shaped gate + a zero-write state-level gate inside `applyCodexCliFromState`; regression tests cover drifted aliases at run/helper/maintenance.
- MAJOR pool-selection gate ran post-write: fixed — fresh snapshot refresh + pre-write projection gate; residual post-selection re-check now rolls back the managed auth.json before throwing.
- MAJOR run-lock reclamation steal race (classify→rm→mkdir non-atomic): fixed with single-winner atomic rename to a tombstone + post-write owner nonce verification; `recordChildPid` contention now SIGTERMs the child and fails the run.
- Drain gap: managed rotating home auth.json now drained; `removed` counters honest under `--dry-run`; mutating drain requires `--confirm`.
- Pin noop now re-arms host-local desktop metadata (crash between fenced commit and local write is recoverable).
- Fence EXEC-aborts are diagnosed as `fence_lost` vs `stale_version`; fake redis lease scripts bump WATCH versions; Redis >= 6.0.9 requirement documented.
- `codexDesktop` status reports `reservation_unverified` (not `ok`) when Redis is unavailable; pin refresh-failure blocker carries a fixed reason only (no raw error text).
- README documents drain; README-parity test now covers it; pin/unpin redis dumps include index sets.
- Accepted-as-noted (comments/log): pin's discarded provider-side refresh rotation on blocked exits; OpenClaw apply's pre-change .bak ordering vs drain (cutover step ordering note in code); hostname-equality unpin owner check (cooperative fleet); unattributable backup entries pass the restore gate (no identity to compare — cutover step 2 operator note); legacy non-Redis login lane is reservation-blind by construction (no reservation authority exists there); `aim redis snapshot/export` remains a raw-dump admin surface (pre-existing).

## Proof deliberately NOT run (Phase 2 / live)

- No mutation of real `~/.codex`, the installed Desktop app, Remote Control enrollment, live AIM Redis, or OpenClaw/Hermes/Pi/Prime auth stores.
- Plan DoD item 7 (real machine: Desktop on `amir_cratejoy_personal`, Remote Control reconnect across a real refresh/restart cycle), fleet quiescence, real pin, per-host inventory receipts, and multi-host deployment remain pending until this branch is reviewed, merged, and deployed everywhere.
