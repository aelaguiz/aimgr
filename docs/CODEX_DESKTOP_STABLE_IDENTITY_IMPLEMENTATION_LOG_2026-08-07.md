# Codex Desktop Stable Identity — Implementation Log (branch: codex-desktop-stable-identity)

Plan: `docs/CODEX_DESKTOP_STABLE_IDENTITY_MINI_ARCH_PLAN_2026-08-07.md` (Phase 1 only; Phase 2 live cutover deliberately pending).

## Status

- [x] Foundation: split home resolvers, collision guard, fake-redis WATCH semantics (e8ce6d4)
- [x] Reservation core: raw record scan, reserved-ID index, catalog lease, fenced CAS (src/coordination/codex-identity.js, e8ce6d4)
- [x] Target routing: all AIM codex mutations -> `~/.aimgr/codex-cli`; native `~/.codex` read-only; `aim sakana use` env now targets the managed home
- [x] Delete `aim codex use/watch` + watch installer + docs/help/package scripts (hermes watch retained)
- [x] `aim codex run [label] -- args` + owner-directory lock (manager/child PID, fail-closed recovery)
- [x] `aim codex desktop pin/unpin` + credential retirement + `native_owned` health
- [x] Publisher gates: runtime/login-publish/browser-policy/maintenance guarded; `aim redis import` and `aim label rebind` publish codex records through the guarded fenced path; login has no direct publish side door. Reserved credential-empty records keep `native_owned` health through normalization.
- [ ] Consumer gates: harness helper, Pi/Prime binding, OpenClaw/Hermes materialization, uninstall restore
- [ ] Identity-targeted active/backup drain cleanup (no replacement secret backup)
- [ ] Status split: safe `codexDesktop` + `codexCli` projections (no raw IDs)
- [ ] Tests: two-home isolation, reservation round-trip/alias/race, lock concurrency, redaction
- [ ] Full `env -u CODEX_HOME npm test` + `npm run lint` green

## Commits

(pending)

## Proof deliberately NOT run (Phase 2 / live)

- No mutation of real `~/.codex`, installed Desktop app, Remote Control enrollment, live AIM Redis, or OpenClaw/Hermes/Pi/Prime auth stores.
- Real multi-host cutover + same-account Remote Control smoke remains pending until merge/deploy.

## Adversarial findings and dispositions

(pending)
