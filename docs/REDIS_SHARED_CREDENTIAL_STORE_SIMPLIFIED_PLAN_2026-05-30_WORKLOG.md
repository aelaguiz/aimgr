# Redis Shared Credential Store Worklog

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

## Remaining before final hard cutover

- Run the full local test suite once more after the latest source-of-truth correction.
- Commit and push the build.
- Pull/reinstall/smoke on `home`, `agents@amirs-mac-studio`, and `amirs-m3-max-new`.
- After fleet smoke passes, delete old Redis machine/session keys with `aim redis migrate cleanup-legacy --confirm-breaking-cutover`.
- Run Composer 2.5 Fast fresh consult and thermo-nuclear code-quality review.
