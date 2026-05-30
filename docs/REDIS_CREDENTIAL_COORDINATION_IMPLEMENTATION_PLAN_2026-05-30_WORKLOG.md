# Redis Credential Coordination Worklog

## 2026-05-30T14:39:14Z — Mac Studio Redis Primary Setup

- Verified SSH target `studio` connects to `agents@amirs-mac-studio`.
- Verified Docker and Colima are installed on the Mac Studio.
- Verified Redis is running as Docker container `aimgr-redis` from image `redis:7-alpine`.
- Verified container storage is durable through Docker volume `aimgr-redis-data:/data`.
- Verified Redis is bound on the Mac Studio as `127.0.0.1:6380 -> 6379/tcp`.
- Updated the container restart policy to `unless-stopped`.
- Verified Redis persistence: `appendonly yes`, `appendfsync everysec`, `aof_enabled:1`, and last rewrite status `ok`.
- Verified Tailscale Serve exposes TCP `6380` to `tcp://127.0.0.1:6380` on `amirs-mac-studio`, `100.96.80.106`, and `amirs-mac-studio.fairy-salmon.ts.net`.

Verification:

- Remote container `redis-cli PING` returned `PONG`.
- Local raw Redis protocol ping returned `+PONG` for `100.96.80.106:6380`.
- Local raw Redis protocol ping returned `+PONG` for `amirs-mac-studio:6380`.
- Local raw Redis protocol ping returned `+PONG` for `amirs-mac-studio.fairy-salmon.ts.net:6380`.

Next:

- Configure AIM installs to use `redis://amirs-mac-studio:6380` with the agreed key prefix and primary host metadata.

## 2026-05-30T14:06:57Z — Backup Before Implementation

- Created local backup under `/Users/aelaguiz/.aimgr/backups/pre-redis-implementation-20260530T140657Z`.
- Created Mac Studio backup under `/Users/agents/.aimgr/backups/pre-redis-implementation-20260530T140657Z`.
- Mirrored the Mac Studio backup locally to `/Users/aelaguiz/.aimgr/backups/pre-redis-implementation-20260530T140657Z/remote-studio`.
- Verified SHA-256 checksums for local `credential-state.tgz`, remote `credential-state.tgz`, remote `aimgr-redis-data.tgz`, and mirrored remote archives.
- Backup intent: preserve existing AIM state and credential-bearing target files before any Redis migration/cutover work so existing logins are not lost.

## 2026-05-30T14:22:46Z — Phase 1 Redis Coordination Spine

- Added official `redis` npm dependency.
- Added AIM config support at `~/.aimgr/config.yaml` via `src/config/aimgr-config.js`.
- Added path helpers for config, machine id, Redis cache, Redis migration dir, and local adjunct state in `src/io/paths.js`.
- Added stable machine identity in `src/coordination/machine.js`.
- Added non-credential local adjunct state in `src/state/local-state.js`.
- Added Redis record normalization in `src/coordination/records.js`.
- Added Redis store boundary in `src/coordination/redis-store.js`, including key construction, snapshot reads, `registerMachine`, `publishLabel`, `publishSession`, `importSnapshot`, and `casPutJsonRecord`.
- Fixed the live Redis `WATCH` behavior discovered during smoke testing: node-redis throws `WatchError` for watched-key conflicts, so the store now translates that into stale-version behavior and retries machine registration.
- Added snapshot read helpers in `src/coordination/snapshot.js`.
- Added `aim redis configure`, `config`, `ping`, `snapshot`, `export`, and `import` in `src/cli/commands/redis.js`.
- Wired Redis CLI flags and help text.

Verification:

- `rtk npm run lint` passed.
- `rtk node --test test/coordination/redis-store.test.js test/cli/redis-command.test.js test/config/aimgr-config.test.js test/coordination/machine-local-state.test.js test/coordination/records.test.js` passed: 19 tests, 0 failures.
- `rtk env -u CODEX_HOME npm test` passed: 233 tests, 0 failures.
- Plain `rtk npm test` fails in this shell because `CODEX_HOME=/Users/aelaguiz/.codex` causes inherited Codex temp-home tests to target the real Codex home; this is preexisting environment sensitivity, not Redis behavior.
- Live Redis smoke against `redis://amirs-mac-studio:6380` passed using key prefix `aimgr:phase1-smoke:20260530T142220Z:`.
- Parallel `aim redis ping` and `aim redis snapshot` against that prefix succeeded after the `WatchError` fix.
- Smoke-test Redis keys were removed; remote scan returned `0`.

Next:

- Phase 2: build the non-lossy breaking migration pipeline before runtime cutover.

## 2026-05-30T14:30:41Z — Phase 2 Non-Lossy Breaking Migration Pipeline

- Added `src/migration/redis-migration.js`.
- Implemented read-only collection from:
  - legacy `~/.aimgr/secrets.json`
  - Codex `~/.codex/auth.json`
  - native Claude `.credentials.json` plus `.claude.json`
  - Hermes profile `auth.json` files
  - OpenClaw `auth-profiles.json` stores
- Enforced `collect --machine <id>` against the local `~/.aimgr/machine-id`.
- Added deterministic planning:
  - valid/fresh candidates beat invalid/expired candidates
  - dirty local authority metadata scores higher
  - provider/label identity conflicts block the label instead of merging
  - same-fingerprint candidates are treated as one lineage instead of independent sessions
  - expired refreshable candidates get a controlled refresh attempt before becoming re-login-required
- Added Redis migration apply:
  - refuses blocked or re-login-required plans
  - refuses non-empty Redis prefixes by default
  - writes meta, machines, labels, and per-machine sessions into Redis
  - marks the meta cutover as `breakingNonReverseCompatible: true`
- Added CLI:
  - `aim redis migrate collect --machine <id> --out <bundle.json>`
  - `aim redis migrate plan --from <bundle-dir> --out <plan.json>`
  - `aim redis migrate apply --plan <plan.json> --confirm-breaking-cutover`

Verification:

- `rtk npm run lint` passed.
- `rtk node --test test/migration/redis-migration.test.js test/cli/redis-migration-command.test.js` passed.
- `rtk env -u CODEX_HOME npm test` passed: 241 tests, 0 failures.
- Live Redis migration smoke against `redis://amirs-mac-studio:6380` passed using fake credentials and key prefix `aimgr:phase2-smoke:20260530T143000Z:`.
- The live smoke proved collect, plan, apply, snapshot, redaction, and empty-prefix apply behavior.
- Smoke-test Redis keys were removed; remote scan returned `0`.

Next:

- Phase 3: start moving runtime reads/status to Redis snapshots while keeping old state read-only for migration only.

## 2026-05-30T14:32:59Z — Phase 3 Redis Status And Read Model

- Added `src/status/redis-view.js`.
- Updated `aim status` routing so Redis-configured installs read Redis snapshots plus local adjunct state.
- Preserved the legacy status path only when no Redis URL is configured.
- Added Redis status fields:
  - `redis`
  - `redisMachines`
  - `redisSessionMatrix`
- Added diagnostic cache writes to `~/.aimgr/redis-cache.json` after successful Redis status reads.
- Added Redis-unavailable cache fallback for status only; this cache is not used for mutation or selection.
- Kept target projection readbacks local, so status can still report local drift while shared label/session truth comes from Redis.

Verification:

- `rtk npm run lint` passed.
- `rtk node --test test/status/redis-view.test.js test/cli/redis-command.test.js` passed.
- `rtk env -u CODEX_HOME npm test` passed: 243 tests, 0 failures.
- Live Redis status smoke against `redis://amirs-mac-studio:6380` passed using key prefix `aimgr:phase3-smoke:20260530T143400Z:`.
- The live smoke proved `aim status --json` read Redis labels/sessions, emitted `redisSessionMatrix`, wrote the status cache, and redacted token fields.
- Smoke-test Redis keys were removed; remote scan returned `0`.

Next:

- Phase 4: move login, label policy, and repair writes to Redis.

## 2026-05-30T15:05:06Z — Runtime Redis Cutover Implementation

- Added Redis-backed runtime loading for daily command paths through `src/coordination/runtime.js`.
- Moved login/manual callback maintenance to publish Redis label/session records and write only `~/.aimgr/local-state.json`.
- Moved TTY shorthand `aim <label>` panel persistence onto Redis:
  - shared browser policy is stored on Redis labels;
  - machine-specific browser paths/sessions are stored only in local adjunct state;
  - panel-maintained credentials publish this machine's Redis session;
  - label identity mismatches fail before overwriting Redis.
- Added Redis-backed projection for:
  - `aim codex use [label]`
  - `aim codex watch`
  - `aim codex run --tend`
  - `aim pi use`
  - `aim auth write hermes`
  - `aim rebalance openclaw`
  - `aim rebalance hermes`
  - `aim hermes watch`
  - `aim browser show/set`
  - `aim claude capture-native`
  - `aim claude import-native`
- Added Redis-era `aim claude run <label> [-- <claude args...>]`, projecting into `~/.aimgr/claude-homes/<label>`, launching Claude from that HOME, and publishing post-run native Claude token rotations back to Redis.
- Retired Redis-era `aim claude use`; Redis-configured installs now fail loud with `aim claude run <label>` guidance.
- Hard-disabled old live coordination commands:
  - `aim apply`
  - `aim sync *`
  - `aim promote *`
  - `aim internal apply-codex-promotion`
  - `aim internal apply-claude-promotion`
- Removed unused file/SSH authority import/promotion source modules and removed remote internal promotion command construction from the authority locator.
- Updated README/help/readme-contract tests to describe Redis as the shared source of truth and `secrets.json` as migration input only.

Verification:

- `rtk npm run lint` passed.
- `rtk env -u CODEX_HOME npm test` passed: 232 tests, 0 failures.
- Live Redis runtime smoke against `redis://amirs-mac-studio:6380` passed using throwaway prefix `aimgr:runtime-smoke:20260530T150506Z:`.
- The live smoke proved `aim redis configure`, `aim redis ping`, `aim redis import`, `aim status --json`, and `aim codex use boss` against the Mac Studio primary.
- The live smoke verified no `~/.aimgr/secrets.json` write and no refresh-token leak into `~/.aimgr/local-state.json`.
- Smoke-test Redis keys were removed; remote scan returned `0`.

Next:

- Run external Fresh Consult review and thermonuclear code-quality review, then fix any blocking findings before commit/push.

## 2026-05-30T15:10:53Z — External Review, Hardening, And Final Verification

- Ran Fresh Consult with Composer 2.5 Fast against the Redis cutover implementation.
- Fresh Consult verdict: `pass-with-notes`; no blocking findings.
- Addressed follow-up notes before commit:
  - added removed-command coverage for `sync claude`, `sync openclaw`, and internal `apply-*` receivers;
  - deleted stale orphaned old-authority `.cases.js` files;
  - scrubbed leftover authority/promote wording from user-facing paths;
  - removed unused dirty-import sync helpers from Codex portable credential code.
- Ran thermonuclear code-quality review.
- Fixed the meaningful issue found during that review:
  - `persistRedisPanelState` now publishes maintained label sessions atomically when a credential is present;
  - label policy is no longer written first as a separate partial update in that path.
- Final verification passed:
  - `rtk node --test test/cli/redis-login-command.test.js test/cli/redis-projection-command.test.js`
  - `rtk npm run lint`
  - `rtk env -u CODEX_HOME npm test`
- Final full test result: 232 tests, 0 failures.

Next:

- Commit and push the Redis credential coordination cutover.
