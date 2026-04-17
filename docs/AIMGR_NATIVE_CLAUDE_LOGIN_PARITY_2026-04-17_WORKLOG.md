# Worklog

Plan doc: docs/AIMGR_NATIVE_CLAUDE_LOGIN_PARITY_2026-04-17.md

## Initial entry
- Run started.
- Current phase: Phase 1 - Canonical Claude bundle schema and helper boundaries.

## Phase 1-5 Progress Update
- Work completed:
  - Replaced the legacy Claude projection-field model with a canonical `nativeClaudeBundle` plus derived summary fields.
  - Cut label maintenance over to bundle capture from Claude's real auth-bearing files and fail-loud completeness checks.
  - Cut `aim claude use` over to dual-file projection and readback for `~/.claude/.credentials.json` plus `~/.claude.json`.
  - Updated Claude readiness, status, warnings, receipts, and the fake Claude harness to the native-bundle-first contract.
  - Rewrote the README Claude guidance to match the shipped native bundle behavior.
- Tests run + results:
  - `npm run lint` - passed.
  - `npm test` - passed (`111` tests).
  - `node --test test/cli.test.js --test-name-pattern 'anthropic label maintenance|derivePoolAccountStatus requires a complete native Claude bundle|claude use|claude status warns when an oauth-token env override shadows projected native auth'` - passed.
- Issues / deviations:
  - None inside the code path; implementation reached the planned Phase 5 frontier cleanly.
- Next steps:
  - Run isolated-home native Claude parity smokes against the installed Claude CLI.
  - Attempt a real selector smoke and record any live-runtime blocker truthfully.

## Phase 6 Progress Update
- Work completed:
  - Proved with the installed Claude CLI that `.credentials.json` alone produces `loggedIn: true` but leaves `email` and `orgName` empty.
  - Proved with the installed Claude CLI that full-bundle projection restores `authMethod: "claude.ai"`, `email`, `orgName`, and `subscriptionType` in an isolated `HOME`.
  - Proved AIM's own Claude target readback sees the projected label, email, org, subscription, and both projected file paths with no warnings.
  - Confirmed the live selector receipt now reports `usage_unavailable` instead of the earlier misleading blocker story when Claude usage probing cannot establish an eligible label.
- Tests run + results:
  - Isolated-home direct projection smoke via temporary exported `applyClaudeCliFromState` plus real `claude auth status --json` - passed.
  - Temp-home comparison of `.credentials.json`-only vs full-bundle projection with real `claude auth status --json` - passed.
  - Temp-home `aim claude use --home <tmp>` selector smoke - blocked with truthful receipt reason `usage_unavailable`.
  - `~/.aimgr/secrets.json` inventory check - one Anthropic label (`claudalyst`), no stored `nativeClaudeBundle`.
- Issues / deviations:
  - A real operator-state label-switch smoke could not run in this environment because there is only one live Anthropic label and it has not yet been re-captured under the new native-bundle contract.
  - The live selector path still depends on a successful Claude usage probe before activation, and the current local probe path is returning `usage_unavailable`.
- Next steps:
  - Leave the implement-loop state armed.
  - Let fresh `audit-implementation` validate Phases 1-5 as complete and Phase 6 as blocked on live operator-state proof.
