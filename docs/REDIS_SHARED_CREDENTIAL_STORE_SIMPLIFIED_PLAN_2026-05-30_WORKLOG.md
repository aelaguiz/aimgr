# Redis Shared Credential Store Worklog

## 2026-05-30T17:03Z - Final fleet hard cutover verification

- Runtime code smoke commit:
  - Local repo: `3a36ca3` on `redis-credential-coordination`.
  - `home`: `3a36ca3`.
  - `amirs-m3-max-new`: `3a36ca3`.
  - `agents@amirs-mac-studio`: `3a36ca3`.
  - Later commits in this worklog section are audit-documentation updates only.
- Live Redis state:
  - credential records: 24.
  - legacy labels: 0.
  - legacy sessions: 0.
  - legacy machines: 0.
  - no local stale `aimgr.js codex run --tend` supervisor process is running.
- Redis connection config:
  - Local, `home`, and `amirs-m3-max-new`: `redis://amirs-mac-studio:6380`, key prefix `aimgr:v1:`, primary host `agents@amirs-mac-studio`, transport `tailscale`.
  - `agents@amirs-mac-studio`: `redis://127.0.0.1:6380`, key prefix `aimgr:v1:`, primary host `agents@amirs-mac-studio`, transport `tailscale`.
- Live smoke:
  - Local: `aim redis ping` returned `PONG`; `aim codex use pro10` activated `pro10`; `aim status --json` reported 24 accounts, 24 Redis credentials, active Codex label `pro10`, and `warnings: []`.
  - `home`: `aim redis ping` returned `PONG`; `aim codex use pro10` activated `pro10`; `aim status --json` reported 24 accounts, 24 Redis credentials, active Codex label `pro10`, and `warnings: []`.
  - `amirs-m3-max-new`: `aim redis ping` returned `PONG`; `aim codex use pro10` activated `pro10`; `aim status --json` reported 24 accounts, 24 Redis credentials, active Codex label `pro10`, and `warnings: []`.
  - `agents@amirs-mac-studio`: `aim redis ping` returned `PONG` over localhost; `aim codex use pro10` activated `pro10`; `aim status --json` reported 24 accounts, 24 Redis credentials, active Codex label `pro10`, and `warnings: []`.
  - `agents@amirs-mac-studio` resolves its shell `aim` through the Node global symlink, which points at `/Users/agents/workspace/agents/work/aimgr/repo/aimgr`; `/Users/agents/.local/bin/aim` also works and uses localhost Redis.
  - `pro10` was usable during smoke: allowed `true`, 5h used `23`, week used `69`.
  - Non-Codex projection smoke: `aim auth write hermes pro10 --auth-file <tmp>/auth.json` returned `ok: true` and wrote an `openai-codex` provider entry from the shared Redis credential.
- Verification:
  - `npm run lint`: passed.
  - `env -u CODEX_HOME node --test test/codex/codex-10.cases.js test/cli/redis-projection-command.test.js`: 35 passed, 0 failed.
  - `env -u CODEX_HOME npm test`: 233 passed, 0 failed.
- Composer 2.5 Fast fresh consult:
  - Runtime/model: Cursor Agent `composer-2.5-fast`.
  - Run directory: `/tmp/fresh-consult/redis-hard-cutover-composer-20260530TT5q8lm`.
  - Initial verdict: `pass-with-notes`, blocking `none`.
  - Notes addressed after the consult:
    - Added a two-home Redis projection test proving one AIM home can publish a Codex live-auth rotation and another AIM home reads the updated shared credential without creating `~/.aimgr/secrets.json`.
    - Updated README migration wording so this machine's bootstrap bundle is the import authority and old Redis `session:*`, `label:*`, and `machine:*` rows are cleanup-only.
    - Reran and recorded the four-install `aim redis ping`, `aim codex use pro10`, `aim status --json`, live Redis legacy-count, and Hermes auth projection smokes above.
  - Recheck run directory: `/tmp/fresh-consult/redis-hard-cutover-composer-recheck-20260530TLPehAX`.
  - Recheck verdict: `pass`, blocking `none`.
- Thermo-nuclear code-quality review:
  - Verdict: pass, no blocking structural regressions found.
  - Checked branch diff size, changed source file line counts, Redis runtime boundaries, migration shape, Codex Tend staging boundary, and legacy machine/session references.
  - `src/migration/redis-migration.js` is still under the 1k-line threshold at 983 lines.
  - `src/targets/codex-tender.js` remains under the 1k-line threshold at 975 lines.
  - Residual non-blocking debt: dormant non-Redis local `secrets.json` fallback paths still exist for unconfigured installs, but the four-install cutover fleet is Redis-configured and does not use them.

## 2026-05-30T16:55Z - Mac Studio localhost correction

- Durable connection rule added:
  - Remote clients use `redis://amirs-mac-studio:6380`.
  - `agents@amirs-mac-studio` is the Redis host and connects to its own Redis container with `redis://127.0.0.1:6380`.
  - `redis://100.96.80.106:6380` is only the direct Tailnet fallback.
- Corrected the `agents@amirs-mac-studio` AIM config to use localhost so the host does not depend on its own Tailscale hostname resolving locally.
- Current fleet smoke label is `pro10`, not `boss`; `boss` was imported but later returned a 401 and needs reauth separately.
- Killed stale one-shot watcher processes on `agents@amirs-mac-studio` that were still creating old Redis machine rows.
- Reran legacy cleanup:
  - credential records: 24
  - legacy labels: 0
  - legacy sessions: 0
  - legacy machines: 0
- Verification after the localhost/config-doc correction:
  - `npm run lint`: passed
  - `env -u CODEX_HOME npm test`: 230 passed, 0 failed

## 2026-05-30T17:45Z - Codex Tend Redis review

- Reviewed `aim codex run --tend` against the Redis shared credential cutover.
- Added regression coverage proving Redis-configured Tend:
  - reads through the Redis-backed state runtime,
  - publishes a live Codex auth refresh back to the shared Redis credential row,
  - does not recreate `~/.aimgr/secrets.json`,
  - does not publish a staged live-auth refresh if the Tend mutation fails after preservation.
- Fixed the Redis Tend commit boundary:
  - `stateRuntime.withMutableState` now stages Codex preserve publishes and commits them only after the mutation callback succeeds.
  - `aim codex watch --once` now publishes preserved live auth after the watch mutation finishes successfully, instead of before.
- Verification:
  - `env -u CODEX_HOME node --test test/codex/codex-10.cases.js test/cli/redis-projection-command.test.js`: 34 passed, 0 failed
  - `npm run lint`: passed
  - `env -u CODEX_HOME npm test`: 232 passed, 0 failed
  - Fresh `code-review` run directory: `/private/tmp/code-review/20260530_113734_774ab675_cca4fdc6`
  - Fresh review verdict: `approve`, no blocking findings, no non-blocking findings

## 2026-05-30T16:22Z - This-machine recovery cutover

- Corrected migration source-of-truth behavior:
  - `aim redis migrate collect` no longer reads old live Redis `session:*` rows as import candidates.
  - Local AIM snapshots such as `~/.aimgr/secrets.legacy-imported-redis-20260530T1521Z.json` are included as this-machine bootstrap inputs.
  - Anthropic/Claude rows are excluded from the migration import path for this Codex-focused cutover.
- Built plan from `/Users/aelaguiz/.aimgr/redis-migration/shared-credential-cutover-this-machine-20260530T161949Z/plan.json`.
  - candidates: 145
  - selected Codex credentials: 24
  - blocked: 0
  - re-login required: 0
  - source types: `codex-auth-json`, `legacy-state`
- Applied the plan to live Redis with `aim redis migrate apply --confirm-breaking-cutover --allow-non-empty`.
  - Redis config: `redis://amirs-mac-studio:6380`, prefix `aimgr:v1:`, primary host `agents@amirs-mac-studio`, transport `tailscale`
  - credential records after apply: 24
  - old legacy Redis rows intentionally still present pending fleet verification: 87 sessions, 24 labels, 4 machines
- Reinstalled this repo as the global AIM wrapper via `npm run install:local`.
  - `command -v aim`: `/Users/aelaguiz/.local/bin/aim`
- Local smoke:
  - `aim redis ping`: `PONG`
  - `aim status --json`: 24 accounts, Redis live, credentialCount 24
  - `aim codex use boss`: wrote `/Users/aelaguiz/.codex/auth.json` for `boss`
  - post-use status summary: active Codex label `boss`, account id `9b7c3781-4962-425f-8db1-60feee389091`, warnings `[]`

## Targeted tests already run

- `env -u CODEX_HOME node --test test/migration/redis-migration.test.js test/cli/redis-migration-command.test.js`
- `env -u CODEX_HOME node --test test/cli/redis-command.test.js test/cli/redis-migration-command.test.js test/migration/redis-migration.test.js`
- `env -u CODEX_HOME node --test test/cli/redis-migration-command.test.js test/cli/redis-projection-command.test.js test/migration/redis-migration.test.js`
- `npm run lint`
- `env -u CODEX_HOME npm test`: 229 passed, 0 failed
- `npm run lint`: passed after the full suite
