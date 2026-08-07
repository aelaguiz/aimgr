# Codex Desktop Stable Identity — Implementation Log (branch: codex-desktop-stable-identity)

Plan: `docs/CODEX_DESKTOP_STABLE_IDENTITY_MINI_ARCH_PLAN_2026-08-07.md` (Phase 1 only; Phase 2 live cutover deliberately pending).

## Status

- [ ] Foundation: split home resolvers, collision guard, fake-redis WATCH semantics
- [ ] Reservation core: raw record scan, reserved-ID index, catalog lease, fenced CAS
- [ ] Target routing: all AIM codex mutations -> `~/.aimgr/codex-cli`; native `~/.codex` read-only
- [ ] Delete `aim codex use/watch` + watch installer + docs/help/package scripts
- [ ] `aim codex run [label] -- args` + owner-directory lock (manager/child PID, fail-closed recovery)
- [ ] `aim codex desktop pin/unpin` + credential retirement + `native_owned` health
- [ ] Publisher gates: login/OAuth publish, reconcile promotion, maintenance, rebind, import
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
