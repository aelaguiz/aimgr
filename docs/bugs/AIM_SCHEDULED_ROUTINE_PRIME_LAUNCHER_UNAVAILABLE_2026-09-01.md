---
title: AIM scheduled routine blocked by Prime launcher publication gap and path-resume timeout
date: 2026-09-01
status: resolved
owners:
  - Amir
reviewers: []
related:
  - routine:community-sweep
  - fire:community-sweep--2026-09-01T17-00-0500
---

# TL;DR

<!-- bugs:block:tldr:start -->

- Symptom: the 2026-09-01 17:00 CDT `community-sweep` worker first stopped because no Prime launcher was installed. After the launcher returned, a live smoke completed its credential pin but `prime-agent --resume <absolute-session-path>` exited on a 3-second daemon `get_state` timeout before admitting the real prompt.
- Impact: resolved on this machine. AIM can again create the scheduled Herdr Space, verify the selected account, resume the exact saved-session path, admit the configured prompt, and observe the initial turn settle.
- Most likely cause: the launcher publication gap caused the historical 17:00 failure; the remaining reproducible blocker is the known Prime path-resume regression already fixed by commit `ab9ffefc2` on the older `fix/path-resume-probe-timeout` branch but absent from current main and the installed 0.9.1 bundle.
- Fix: installed immutable Prime client bundle `bundle-v1:9712691683125c47e3a6d541799ac3d6450354b96642b8fdab10ade68ee567aa` and atomically repointed only `/opt/homebrew/bin/prime-agent`.
- Status: resolved on 2026-09-02; the post-fix no-tools smoke completed with exit code 0 and exact reply `AIM_SCHEDULE_SMOKE_OK` while the live daemon remained PID `9790` on its original build.

<!-- bugs:block:tldr:end -->

# Bug North Star

Prove that AIM scheduled workers can resolve the installed Prime compatibility entrypoint and resume their exact saved-session path without a short daemon probe timeout, completing a harmless scheduled prompt without changing credentials, stopping shared Prime services, or adding a second launcher authority.

# Bug summary

The scheduled parent successfully claimed the 17:00 occurrence, created `growth` Space `w50`, and queued the private worker. That worker selected account `pro6`, then failed at `resolvePrimeLauncher()` before starting its print pin or configured prompt. Current machine state differs from that failure window: Prime 0.9.1 is installed, its canonical link resolves and is executable, and Prime doctor reports the default protocol-7 daemon as current.

The 21:20 manual smoke then crossed the launcher and pin boundaries. It created session `01a05feb-61a3-742f-a22d-f8953d954d36`, received exact `AIM_ROUTINE_PIN_OK`, and verified the expected account/model/thinking tuple. Its interactive `--resume <absolute-session-path>` process queried the busy daemon with `get_state(path)` using a 3-second timeout and exited before prompt admission. This exactly matches the older Prime regression doc and fix commit that current main lost during later upstream integration.

# Evidence

<!-- bugs:block:analysis:start -->

- Exact terminal receipt: `/Users/aelaguiz/.aimgr/routine-runs/community-sweep--2026-09-01T17-00-0500.json` records `outcome: failed_before_prompt`, `prompt.admittedAt: null`, and the exact launcher error.
- Last known success: the same routine completed at 07:00 CDT on 2026-09-01. Its 17:00 occurrence is the first observed launcher-resolution failure.
- Resolver anchor: `src/targets/prime-launcher.js` accepts only an executable `prime-agent` found through `PATH` and deliberately ignores the retired `PRIME_AGENT_LAUNCHER_PATH` override.
- Scheduled PATH: the installed LaunchAgent includes `/Users/aelaguiz/.local/bin`, `/opt/homebrew/bin`, and the normal system paths. The long-running `growth` Herdr server's own environment also includes `/opt/homebrew/bin`.
- Launcher during diagnosis: `/opt/homebrew/bin/prime-agent` resolved to the executable installed bundle under `/Users/aelaguiz/.prime/installs/lock-free-reads-20260901-1805/`; the install directory was created at 18:08 and the link at 18:09 CDT, after the failed occurrence.
- Current Prime health: `prime-agent --version` reports `0.9.1`; `prime-agent doctor --json` reports the default daemon as `current`, protocol 7, with the installed compatibility entrypoint.
- Live smoke receipt: `test-schedule-smoke--2026-09-01T21-20-0500--manual-a2fa67d8-bebd-4656-be3b-75bcc33d1c60.json` records a successful pin/profile verification followed by `Prime interactive TUI exited during prompt admission with code 1`, with `prompt.admittedAt: null`.
- Exact Prime error: the smoke pane reports `Could not look up active agent '<session-path>': ... Timed out after 3000ms waiting for ... get_state` on the default daemon.
- Exact code anchor: current Prime main and the installed 0.9.1 bundle send every selector, including absolute paths, through `get_state(..., 3000)` before falling back to `list`.
- Existing proven fix: Prime commit `ab9ffefc2` routes absolute-path selectors directly through the existing daemon `list` response and records passing focused routing, cross-daemon process, and repository checks. The commit is not an ancestor of current main `918d049ad`.

## Investigation

Ranked hypotheses:

1. **Prime path resume enters the short `get_state` lane — directly reproduced.** The current client sends the absolute session path as `activeSessionId` with a 3-second budget; the live default daemon exceeded that budget while refreshing/serving its large worker fleet.
2. **Launcher publication gap during the Prime install/cutover — supported for the historical 17:00 failure and already cleared.** The error is the resolver's exact no-candidate result, the only current install was created after the failed occurrence, and both relevant PATHs already contained the directory where the launcher was later published.
3. **launchd or Herdr omitted Homebrew from PATH — contradicted.** Both the installed plist and the running `growth` server contain `/opt/homebrew/bin`.

The existing Prime fix uses the normal 30-second `list` request for path selectors, whose response already carries session paths and avoids the wrong `get_state(path)` supervisor lane. It changes no protocol shape and does not inflate the short ID lookup timeout. AIM behaved fail-closed in both failures and did not submit either configured prompt twice.

## Scope and simplicity contract

- Human-authorized corrected behavior: restore AIM/Prime scheduled execution on this machine after the reported launcher failure.
- Smallest sufficient fix: port the already-proven `ab9ffefc2` path-selector routing onto current Prime main, package it as a new immutable 0.9.1 client install, atomically repoint the one canonical launcher, and rerun the configured no-tools smoke.
- Initial minimal convergence closure: current Prime `findActiveDaemonSessionSummary()` plus its focused regression test and the single installed `/opt/homebrew/bin/prime-agent` client entrypoint move together. AIM retains normal PATH resolution; no competing runtime path changes.
- Scope sign-off: re-signed before the current-main port. The user's request names both AIMGR and Prime scheduled execution, the older Prime bug contract records explicit human authorization for this exact path-resume fix and push, and Amir explicitly authorized this client-only build/install on 2026-09-02 after confirming the no-session-mutation boundary.
- Enough proof: direct resolver succeeds under the exact LaunchAgent PATH; the focused current-main routing test and full repository check pass; the installed client reports the expected version and bundle ID; Prime doctor stays current with the same daemon PID and build; and a new smoke receipt reaches `completed` with the exact prompt hash, reply, and provider/model/thinking tuple.
- Do not build: no launcher fallback, hard-coded source path, `PRIME_AGENT_LAUNCHER_PATH` revival, daemon shutdown/restart/replacement, worker recycling, account rotation, credential change, prompt edit, or cleanup of unrelated sessions/workspaces.
- Accepted residual risk: AIM cannot explain the external publisher's historical absence; the 12 pre-fix resident workers may remain slow until independently recycled, but the client-side path resume must tolerate that load.

<!-- bugs:block:analysis:end -->

# Fix plan

<!-- bugs:block:fix_plan:start -->

1. Port the existing absolute-path `list` routing and focused regression onto a clean worktree from current Prime main.
2. Run the focused routing and cross-daemon process tests, then the repository-mandated check.
3. Package and install an immutable client bundle without restarting or replacing the live daemon, then atomically repoint the canonical launcher.
4. Run another manual `test-schedule-smoke` and verify its authoritative terminal receipt.
5. Keep both failed receipts intact as evidence and make no AIM source change.

<!-- bugs:block:fix_plan:end -->

# Implementation and verification

<!-- bugs:block:implementation:start -->

- The first live smoke cleared launcher resolution and verified the selected account/profile, then reproduced the known Prime path-resume timeout before configured prompt admission. No configured smoke prompt was persisted.
- Created clean worktree `/Users/aelaguiz/workspace/prime-agent-worktrees/path-resume-probe-timeout-v091` at current main `918d049ad` on branch `fix/path-resume-probe-timeout-v091`.
- Ported the existing fix into current `packages/coding-agent/src/main.ts`: absolute-path selectors now use the daemon session list directly; ID, saved-ID, name, and suffix selectors keep the existing `get_state`-first behavior.
- Added the focused routing regression and `packages/coding-agent/.changes/path-resume-probe-timeout-v091.md`.
- Focused routing test passed: `main-interactive-routing.test.ts` completed with 61/61 tests.
- Repository check passed: Biome checked 996 files with no fixes; TypeScript, installer render, and browser smoke checks passed.
- The current-main cross-daemon process test is not runnable on this source checkout: both unchanged main and the fix worktree fail before routing when the isolated supervisor reports `Daemon supervisor launch requires an exact process identity capability`. The focused test covers the changed decision directly; the final installed AIM smoke remains the required process proof.
- Amir supplied the explicit client-only build/install authorization on 2026-09-02. The final build produced `bundle-v1:9712691683125c47e3a6d541799ac3d6450354b96642b8fdab10ade68ee567aa`; the root package artifact SHA-256 is `cf67deaddea71610c6cb0093943121e973b5c3ba30a859a6da6880159fa22d87`.
- Installed the package at `/Users/aelaguiz/.prime/installs/path-resume-fix-20260902/` and atomically repointed `/opt/homebrew/bin/prime-agent` from the retained `lock-free-reads-20260901-1805` install to the new bundle. `prime-agent --version` reports `0.9.1`.
- Prime doctor before and after the launcher cutover reported the same daemon PID `9790`, protocol 7, schema `protocol-7-schema-26-fac530c4c6dd`, and daemon build `bundle-v1:6d9f6fc3d993a622a5d8ce7e68bcc2c4d0f378653c276b550ad7d9bab317438e`. No daemon restart, replacement, worker recycle, credential change, or existing-session mutation occurred.
- Post-fix receipt `/Users/aelaguiz/.aimgr/routine-runs/test-schedule-smoke--2026-09-02T08-23-0500--manual-e9471206-55e5-40d6-8dea-8caf2c4a9b32.json` records `outcome: completed`, `exitCode: 0`, `needsAttention: false`, provider `anthropic`, model `claude-sonnet-5`, thinking `low`, and matching effective/persisted prompt hashes.
- The new smoke session `01a0624a-1969-7781-a802-59fbbadf1a39` persisted the exact assistant reply `AIM_SCHEDULE_SMOKE_OK`; its initial turn settled `idle` with stop reason `stop`. This intentionally added one new session and Herdr workspace only; all pre-existing sessions were left alone.

<!-- bugs:block:implementation:end -->
