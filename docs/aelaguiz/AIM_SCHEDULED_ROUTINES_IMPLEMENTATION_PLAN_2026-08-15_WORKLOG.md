# AIM Scheduled Routines Implementation Worklog

**Plan:** [AIM_SCHEDULED_ROUTINES_IMPLEMENTATION_PLAN_2026-08-15.md](./AIM_SCHEDULED_ROUTINES_IMPLEMENTATION_PLAN_2026-08-15.md)
**Started:** 2026-08-15
**Status:** active

## Scope intake

- Frozen contract: R1-R15 and the two plan phases.
- Authorized: AIM code/config, prompt copies, local routine state, Herdr/Prime harmless proof, and AIM LaunchAgent rendering/install after Amir's Desktop-off confirmation.
- Frozen convergence: shared Prime session profile reader; preserve routine config through existing config writes.
- Explicit boundary: do not open, inspect, edit, enable, or disable Claude Desktop scheduler state.
- Pre-existing repository state: only untracked artifacts; no tracked code changes at start.

## Progress

- [x] Re-read and accepted the frozen plan.
- [x] Phase 1 repaired: daemon-compatible live interactive TUI and same-session follow-up proven manually with Sonnet 5/low.
- [x] Phase 2: natural-time interactive proof passed; Amir confirmed all Desktop counterparts off; all three production LaunchAgents are installed and loaded; manual community-sweep fire is live.
- [x] Interactive implementation audit passed for code plus manual/natural acceptance; production activation is a separate human gate.

## Log

### 2026-08-15 — implementation intake

The requested feature still fits the two-phase lilarch plan. No new scope was added. Implementation begins with deterministic config/session parsing and fake-process tests before any live Herdr or Prime action.

### 2026-08-15 — Phase 1 implemented and proven

Implemented the fixed routine config reader, daily slot calculation, DST-offset fire keys, unique manual fire keys, atomic receipts, per-routine ownership directories, a bounded shared `proper-lockfile` bootstrap mutex acquired inside the pane worker, strict Herdr response checks, Prime session-profile extraction, and fail-closed prompt admission.

Proof completed:

- Targeted routine/config/Prime tests pass.
- A harmless Fable occurrence completed through the public `aim routine run` path with `anthropic` / `claude-fable-5` / `xhigh`, exact cwd, a non-focused Space in `growth`, matching account fingerprint, and matching effective/persisted prompt hashes.
- A harmless Sol occurrence completed through the same path with `openai-codex` / `gpt-5.6-sol` / `xhigh` and the same exact checks.
- Latest Fable receipt: `/Users/aelaguiz/.aimgr/routine-runs/probe-fable--2026-08-15T10-06-0500--manual-f2cabf92-8d79-4dab-97d8-4be11eaa7ddb.json`.
- Latest Sol receipt: `/Users/aelaguiz/.aimgr/routine-runs/probe-sol--2026-08-15T10-07-0500--manual-eedbfb6a-0368-419a-954f-8125cc9713f8.json`.
- The latest proofs exercised account selection and the bounded shared lock inside the pane worker. Temporary probe config and prompt files were removed afterward; the proof receipts and retained `growth` Spaces remain as evidence.

A first Fable attempt correctly failed before prompt admission because Prime's shared interactive daemon was a busy different build. The worker now uses Prime's existing process-owned print frontend, avoiding any attempt to replace that daemon; the subsequent Fable and Sol proofs passed.

### 2026-08-15 — Phase 2 prepared at the human gate

- Copied the three existing prompt files byte-for-byte into `~/.aimgr/routines/prompts/`; all source SHA-256 fingerprints match the frozen investigation.
- Added the three required routine records to `~/.aimgr/config.yaml` without changing Redis settings.
- Installed the current AIM wrapper locally.
- Implemented and tested static plist rendering plus `scripts/install-routines.mjs` prepare/install/uninstall paths.
- Live install now requires exactly one routine ID and an explicit `--desktop-off-confirmed` acknowledgement; an unconfirmed invocation exits before any `launchctl` call.
- Rendered and `plutil -lint` validated all three `com.funcountry.aimgr.routine.<id>` plists under `~/.aimgr/routines/launchagents/`, mode `0600`, with logs under `~/.aimgr/logs/`.
- Confirmed none of the matching plists exist under `~/Library/LaunchAgents` and none of the labels are loaded.
- Did not open, inspect, or mutate Claude Desktop scheduler state.

Phase 2 is intentionally stopped before live bootstrap. Amir must disable and confirm one matching Desktop task before the first draft-only AIM canary is activated.

### 2026-08-15 — final read-only audit repairs

The final implementation review found three in-scope gaps. All were repaired: live activation now requires the explicit Desktop-off acknowledgement, the shared bootstrap mutex now uses bounded `proper-lockfile` serialization inside the worker from account selection through pin verification, and LaunchAgent labels/paths now match the frozen `com.funcountry.aimgr.routine.<id>` contract. A Sol regression fixture was also added. A bounded follow-up read-only verifier returned PASS with no remaining actionable defect in those repairs. The activation/natural-time proof remains correctly human-gated.

### 2026-08-15 — cheap natural-time schedule smoke

Per Amir's correction, no production routine was used as a schedule test. Added the inert reusable `test-schedule-smoke` definition with `anthropic` / `claude-sonnet-5` / `low` and a no-tools exact-token prompt. Its temporary LaunchAgent fired naturally at 10:22 CDT, created retained `growth` Space `w15`, selected and verified account `pro13`, matched the configured/observed execution tuple, persisted the exact effective prompt hash, and replied exactly `AIM_SCHEDULE_SMOKE_OK`.

- Receipt: `/Users/aelaguiz/.aimgr/routine-runs/test-schedule-smoke--2026-08-15T10-22-0500.json`.
- Result: `completed`, exit `0`, no external action.
- Cleanup: the live plist/job was booted out and removed immediately; no test or production LaunchAgent is currently loaded.
- Reuse: the owner-only test prompt, config record, and staged plist remain so future schedule tests do not spend Fable/Sol production-test calls.
- Installer safety: `--no-desktop-counterpart` works only for `test-*` IDs; production IDs still require `--desktop-off-confirmed`.

### 2026-08-15 — interactive-session requirement correction and research

Amir corrected a fundamental product misunderstanding: each scheduled Space must contain a live interactive Prime TUI after the routine's initial answer so he can continue the same conversation. Print/JSON output plus a resumable saved session is insufficient. No implementation edit was authorized in this research turn; the canonical plan was reopened and rewritten before further code work.

Source-grounded result:

- Prime exact resume opens the specified session (`prime-agent/packages/coding-agent/src/main.ts:474-481`).
- Interactive mode requires TTY stdin and no print/JSON flags (`src/main.ts:173-189`; `src/cli/owned-session-worker.ts:74-90`).
- Prime's interactive mode admits startup prompts and then stays in `getUserInput()` (`src/modes/interactive/interactive-mode.ts:1506-1554,1639-1655`).
- Prime's built-in Herdr reporter exposes `prime-agent` plus the exact session path/ID (`src/core/extensions/builtin/herdr-agent-state.ts:124-137,191-229,351-371`).
- Herdr can verify that exact foreground agent and submit/wait on one prompt without stopping it (`herdr/src/cli/agent.rs:645-714`; `src/api/wait.rs:177-245`; `src/app/api/agents.rs:63-110`).
- Implementation research correction: `interactive_ready` is only true for Herdr-managed `agent start` launches (`src/terminal/state.rs:1820-1828`). This pane-run worker instead verifies the reporter's exact `prime-agent` session, while `agent prompt` itself rejects a process that is no longer foreground. This is a frozen-convergence correction, not added scope.

Plan decision: keep the proven print pin, then spawn exact resume as a foreground inherited-TTY child with no prompt, verify Herdr reports the exact live session, submit the prompt once through `herdr agent prompt --wait`, release bootstrap ownership when the persisted user hash proves admission, release occurrence ownership when the initial turn settles, and leave the worker waiting on the live TUI. Manual and natural proofs use only Sonnet 5/low and must verify a next turn in the same session.

The prior implementation PASS is withdrawn. The 10:22 smoke proved scheduling but not interactivity. No LaunchAgent is currently loaded, and production activation remains blocked.

### 2026-08-15 — live-TUI runner implemented; proof stopped at busy-daemon gate

Implemented the repaired lifecycle in `src/routines/run.js`: the pin remains no-tools print/JSON; the real session is resumed as an inherited-TTY foreground child with no prompt; AIM verifies the exact Herdr reporter/session, submits one argv prompt through `herdr agent prompt --wait`, separates initial-turn settlement from TUI lifetime, releases occurrence ownership while the TUI remains live, and never retries uncertain admission. `src/routines/launchd.js` and `scripts/install-routines.mjs` now preserve the existing absolute `PRIME_AGENT_LAUNCHER_PATH` into the LaunchAgent and pane worker so Prime's compatibility wrapper cannot silently substitute an old client. Focused tests cover missing-then-present reporter metadata, long-lived TUI ownership, same-session follow-up, exact session mismatch, ambiguous admission, and no replay.

Manual Sonnet 5/low proof stopped after three fail-closed attempts, all before the real smoke prompt:

1. `w16`: Herdr foreground detection arrived before session metadata; AIM initially treated the absent path as a mismatch. Repaired to keep polling when absent and still reject a different path.
2. `w17`: the pane used Prime's compatibility wrapper rather than the current launcher. Repaired by carrying `PRIME_AGENT_LAUNCHER_PATH` into the worker and plist.
3. `w18`: the current launcher displayed the expected fail-closed gate: `A background service from a different Prime Agent version is running with 7 busy sessions. Stopping it will terminate them. Stop it and continue? [y/N]`. AIM did not answer, did not admit the prompt, timed out, and terminated only its new client.

Per the three-failure stop rule, that forced-current-launcher approach stopped here. The likely wrong assumption was that the new reporter path was required. This blocker and implementation were subsequently superseded by the non-disruptive compatibility path below; no daemon restart was needed.

### 2026-08-15 — non-disruptive compatibility path proven

Amir clarified the operational invariant: existing Prime sessions must continue uninterrupted while scheduled jobs create additional live sessions. Restarting or replacing the daemon is not an acceptable prerequisite.

The runner was simplified accordingly. It no longer forces `PRIME_AGENT_LAUNCHER_PATH`, requires the newer Herdr reporter, or submits through Herdr. After the exact print pin, it calls the installed compatibility entrypoint with the exact resume path and one post-`--` startup prompt argv under inherited TTY. The compatibility wrapper selects the client matching the already-running daemon. AIM proves admission and terminal assistant settlement from the exact pinned session journal, releases occurrence ownership, and keeps awaiting the live TUI. If startup admission is unproven, it terminates only that new client and never replays.

Acceptance evidence:

- Focused routine/LaunchAgent tests: 12/12 pass; lint passes.
- Manual proof: Space `w19`, session `01a00645-ab7a-733c-bc68-1c3f9f15c14c`, Sonnet 5/low, initial `AIM_SCHEDULE_SMOKE_OK`, then `AIM_SCHEDULE_FOLLOWUP_OK` as the next turn in the same live TUI.
- Natural `launchd` proof at 11:37 CDT: Space `w1B`, session `01a00648-c273-74db-b018-4aba33ea5937`, same exact initial and follow-up results in the same live TUI.
- The temporary smoke LaunchAgent was uninstalled immediately after proof and its config calendar restored to 10:22. Amir closed the completed test Spaces; future `test-*` Spaces are closed by the operator after proof so they do not accumulate. No routine LaunchAgent remains loaded.
- Other Prime sessions remained running throughout. No daemon restart, takeover answer, or unrelated-session termination occurred.

The product behavior is now proven. Only the separate per-production-routine Desktop-off confirmations block activation.

### 2026-08-15 — production activation and top-of-list placement

Amir confirmed all three matching Claude Desktop tasks are off. Activated `rpokerskill`, `community-sweep`, then `morning-report` last with `--desktop-off-confirmed`. All three owner-only plists are loaded with the configured schedules: 15:00, 07:00/17:00, and 06:00 respectively.

The requested manual community-sweep fire created production Space `w1D`, exact Fable/xhigh session `01a0064f-752f-70ae-9f59-810d45d31cce`, admitted the production prompt once, and remained a live interactive TUI. Amir confirmed the routine was working.

For new scheduled Spaces, Herdr's native `workspace.move` API accepts the new workspace ID with `insert_index: 0` and preserves focus. Moved `w1D` to position 1 as live proof. AIM now performs the same bounded socket request immediately after Space creation, verifies the returned list, records ordering evidence, and continues the routine with a visible warning if ordering alone fails. Focused runner tests pass 11/11 and lint passes.

### 2026-08-15 — production thinking-level adjustment

At Amir's request, changed only `community-sweep` and `rpokerskill` from Fable `xhigh` to Fable `medium` in `~/.aimgr/config.yaml`. `morning-report` remains Fable `xhigh`. AIM's config reader validated all three definitions, and all three existing LaunchAgents remain loaded with unchanged calendars. The new thinking levels apply to future occurrences; the already-running community-sweep session remains pinned to its original xhigh launch.

### Verification

- Final daemon-compatible interactive code path: focused routine/LaunchAgent suite passes 12/12 and `npm run lint` passes.
- Manual and natural-time Sonnet 5/low interactive contracts pass, including exact same-session follow-ups while both TUIs remain live.
- The three earlier forced-launcher attempts remained pre-prompt and are superseded evidence only; no smoke prompt was replayed.
- Feature/Prime/config test set: 37/37 pass, including Fable and Sol fixtures, config drift, bounded bootstrap contention, confirmation-gated install, and exact LaunchAgent identity.
- Harmless live Fable and Sol probes: pass.
- Full `npm test`: 388/390 pass. The two deterministic failures are pre-existing, unrelated expectation drift in `test/claude/native-storage.test.js` (new empty `xai` bucket) and `test/cli/redis-login-command.test.js` (provider prompt now has three choices). This implementation does not touch those source or test paths, so they remain out of frozen scope.
