# Worklog — AI Manager Codex CLI OAuth Pooling + Remote Sync

> Superseded on 2026-03-21 by [DECOUPLE_AIM_ACCOUNT_POOL_FROM_AGENTS_2026-03-21.md](/Users/agents/workspace/agents/docs/DECOUPLE_AIM_ACCOUNT_POOL_FROM_AGENTS_2026-03-21.md).
> Keep this only as historical implementation context.

Plan doc: [MANAGE_CODEX_CLI_OAUTH_WITH_AIMGR_2026-03-07.md](/Users/aelaguiz/workspace/aimgr/docs/MANAGE_CODEX_CLI_OAUTH_WITH_AIMGR_2026-03-07.md)

## Phase 1 (State Boundaries + Worklog Bootstrap) Progress Update
- Work completed:
  - Created the worklog and linked it from the plan doc so implementation progress stays append-only and tied to the SSOT architecture doc.
  - Confirmed the implementation branch is `codex-cli-authority-consumer-impl`.
  - Confirmed the current AIM CLI is still OpenClaw-centric and that Codex CLI support requires new state, import, and target-activation paths.
  - Confirmed Codex `auth.json` requires `tokens.id_token`, `tokens.access_token`, `tokens.refresh_token`, and optional `last_refresh`, while current AIM state only persists access, refresh, expiry, and account id.
- Tests run + results:
  - None yet. This entry is setup + grounding only.
- Issues / deviations:
  - The pinned `@mariozechner/pi-ai@0.55.1` dependency is not installed locally in this checkout, so its contract was grounded from the published package instead of local `node_modules`.
  - The OpenAI Codex OAuth helper returns `access`, `refresh`, `expires`, and `accountId`, but not `id_token`, so Codex-target projection needs an explicit JWT strategy.
- Next steps:
  - Implement the state-shape migration for machine-local targets and authority import metadata.
  - Add the Codex target bootstrap/import/use/status paths and then lock them with tests.

## Phase 1-5 (State Boundary Through Status UX) Progress Update
- Work completed:
  - Migrated AIM state writes to the new boundary: portable truth remains in `accounts` and `credentials`, while machine-local metadata now lives under `targets.openclaw` and `targets.codexCli`, with authority provenance under `imports.authority.codex`.
  - Retargeted existing OpenClaw flows to the new target-local pin/browser-profile state without changing `aim login`, `aim pin`, `aim autopin openclaw`, `aim apply`, or `aim sync openclaw` operator semantics.
  - Added `aim sync codex --from <authority>` with file-path and SSH locator support, including first-time local-state bootstrap and host-local metadata stripping on import.
  - Added `aim codex use <label>` with explicit pre-import failure, file-backed store enforcement, deterministic `auth.json` projection, readback verification, and active-label bookkeeping.
  - Extended `aim status` to show authority provenance, managed Codex target details, and Codex-target warning categories while preserving secret redaction.
  - Recorded the implementation drift that v1 remains inline in `src/cli.js` and that Codex `id_token` is currently seeded from the access JWT because the pinned login helper does not expose a separate ID token.
- Tests run + results:
  - `npm run lint` — passed.
  - `npm test` — passed (`17/17`).
- Issues / deviations:
  - Local `npm test` initially failed because the pinned dependency `@mariozechner/pi-ai` was not installed in this checkout. Resolved with `npm install`.
  - Real consumer-machine SSH smoke verification and manual Codex process restart/reload verification are still outstanding.
- Next steps:
  - Run the real authority-to-consumer SSH flow against the Mac Studio/laptop path.
  - Do the manual Codex smoke checklist from Phase 6 and then reconcile any final doc/runbook gaps.

## Phase 5 (Developer UX Naming Refinement) Progress Update
- Work completed:
  - Updated the laptop-facing Codex sync UX to prefer `agents@amirs-mac-studio` as the memorable authority string in help text, failure guidance, and the normative developer workflow.
  - Extended CLI coverage so the short authority form and bare `ssh://agents@amirs-mac-studio` both resolve to the default remote AIM state path.
  - Added a regression test locking the help surface to the short authority example.
- Tests run + results:
  - `npm run lint` — passed.
  - `npm test` — passed (`19/19`).
- Issues / deviations:
  - This refines the human-facing authority name only; the real cross-machine smoke test is still the thing that will prove the transport works end to end.
- Next steps:
  - Keep the remaining work focused on real-machine verification rather than more naming churn.

## Phase 6 (Docs + Operator Readme) Progress Update
- Work completed:
  - Rewrote `README.md` to match the current two-mode product story: authority-host OpenClaw management and consumer-laptop Codex CLI switching.
  - Documented global install via `npm link` and fixed-snapshot install via `npm install -g .`.
  - Added the exact laptop operator loop, the `agents@amirs-mac-studio` authority alias, file-backed Codex home requirements, a safe temp-home smoke test, and the real-machine smoke checklist.
  - Updated the state-shape example to `schemaVersion: "0.2"` and documented `targets.openclaw`, `targets.codexCli`, and `imports.authority.codex`.
- Tests run + results:
  - `npm run lint` — passed.
  - `npm test` — passed (`19/19`).
- Issues / deviations:
  - README is now aligned with the implemented CLI, but the broader run still depends on a real laptop-to-Studio Codex smoke test before the feature itself can be called fully verified.
- Next steps:
  - Commit the branch state and open a draft PR with the outstanding real-machine verification called out explicitly.
