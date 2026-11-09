# Manual callback login cleanup — issue #24

- [x] Read M3 Max secrets instructions and wrapper implementation.
- [x] File the cleanup issue and create a branch stacked on Claude privacy PR #22.
- [x] Remove competing login transports and browser-selection panels.
- [x] Preserve JSONL protocol and add plain-text Claude callback input.
- [x] Complete focused tests, full-suite check and diff review.
- [ ] Publish the stacked PR and update issue/worklist.

## Scope and evidence

Amir requested removal after confirmation that the real login workflow uses BrowserOS and manual callbacks. Verified November 9 in M3 Max `~/workspace/secrets/AGENTS.md`, `skills/aim-machine-login/SKILL.md`, and `bin/aim-logins` (`login_command`, `authorize`, `finish`). Both new commands receive `--manual-callback-stdio`. The BrowserOS agent verifies the intended profile, opens the supplied URL and returns the callback through the wrapper. No real login was started for this check.

Issue: https://github.com/aelaguiz/aimgr/issues/24. Branch `auth/manual-callback-only`, base `claude/privacy-per-machine` at `609a041`. Existing original checkout changes were left alone.

## Work log

- Removed generic Claude/Codex shared-grant enrollment, old Codex library OAuth, browser-opening helpers, and the guided browser-selection panel. Retired commands fail with the replacement instructions before reading credentials. Grok explicit device-code login remains.
- Claude now always uses its native manual URL and stdin bridge, with automatic browser opening suppressed. Human text and JSONL are presentations of the same flow. Existing Prime/Pi grants and refresh code remain; new shared-grant enrollment is retired.
- Updated help, README and privacy inventory to describe BrowserOS/operator ownership of browser/profile selection and the callback handoff.
- Existing focused callback/storage/refresh checks: 44 passed. New child-process bridge tests initially failed because the synthetic native credential fixture lacked required organization/subscription fields; corrected the fixture to match native storage requirements.

## Validation

Tests use synthetic credentials, isolated temporary homes and fake Redis; no model requests, real-account sign-ins or real-proxy tests.

- Mac: 44 existing callback/storage/refresh tests passed; 37 focused CLI, BrowserOS-handoff, Grok and documentation tests passed; two additional Codex command tests passed. The latter exercise plain text and JSONL with saved browser-managed policy and verify that shared credential records remain byte-for-byte unchanged.
- Home server full suite, excluding `codex-manual-login.test.js` (already passed on Mac; BrowserOS owns port 1455 on the server): 989 tests, 962 passed, three failed, five cancelled, 19 skipped. The first run used the server’s old dependency directory and failed on missing packages; reran after installing this branch’s lockfile into the isolated test copy.
- Both timestamp failures reproduced on unchanged base `609a041`: `claude-shared-memory.test.js` (fractional mtime precision) and `redis-usage-view.test.js` (one-millisecond timestamp comparison). All five Redis cancellations also reproduce on that base (`redis-store.test.js`, pending promise after event loop exits). The third full-suite failure, a synthetic HTTP timeout in `claude-optional-privacy.test.js`, passed on both the candidate and base when rerun in the four-file diagnostic set. No unrelated production code was changed to hide those results.
- `npm run lint` and `git diff --check` passed. The added Codex command test also passed `node --check` locally after the remote lint copy was made.
- Screenshots captured from actual xterm sessions on a temporary Xvfb display. The Claude demonstration uses the real AIM handler with a synthetic native process and callback; it does not claim a fresh vendor sign-in. All terminal/display processes were closed.
- Visual guide: https://share.fun.country/20261109-aim-manual-callback-login-a6a8ba2f3941/index.html. Published with the cf-share skill; all image bytes and HTTP responses verified.

The source inspection found no remaining `loginOpenAICodex`, automatic Claude login helper, or login panel imports in active source/scripts. Retained browser metadata readers serve old state; they cannot select or open a login browser.
