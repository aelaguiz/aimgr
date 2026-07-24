# Worklog

Plan doc:
`docs/AIM_COMBINED_OAUTH_MAINTAINER_2026-07-24.md`

## Initial entry

- Run started: 2026-07-24.
- Current phase: Phase 1 - build and prove the one-shot locally.
- Starting branch: `main`.
- Starting commit: `32ad1d9aac4442b707c163809d1c532dedf4d193`.
- Implementation branch: `feature/oauth-maintainer`.
- Scope: the frozen plan only—one `aim auth maintain` command, the bounded
  Codex refresh-only request, reuse of Claude's managed run, one existing-policy
  terminal marker, status rendering, CLI help, and one macOS LaunchAgent
  installer.
- Explicit exclusions: no Keychain, browser, model inference, direct Anthropic
  OAuth, new Redis key/schema, generic scheduler/daemon framework, Linux
  service, metrics, notifications, configurable policy, unrelated cleanup, or
  remote contact before local proof passes.
- Pre-existing unrelated untracked files are preserved and excluded from this
  implementation.
- Self-check: on track; on scope; no drift detected.
- Next step: map the existing command, credential, publication, status, and
  test seams, then implement the smallest Phase 1 slice.

## Phase 1 implementation and local proof

- Recorded at: 2026-07-24T14:48Z.
- Result: PASS.
- Implemented the frozen architecture only:
  - one inherently one-shot `aim auth maintain` roster pass;
  - the existing managed Claude lease/fence/projection/publication owner with
    the fixed zero-model `/usage` vector and a 30-second abort;
  - one eight-second, browser-free Codex refresh grant under the existing
    provider/label lease and CAS boundary;
  - the exact existing-policy terminal marker
    `oauth_reauth_required`, successful-publication clearing, and both existing
    status renderings;
  - one focused macOS install/uninstall script for
    `com.funcountry.aimgr.auth-maintainer`.
- Focused verification:
  - combined command/provider/publication/status suite: 105/105 passed;
  - final post-edit command and Codex refresh subset: 5/5 passed;
  - installer `bash -n`: passed;
  - `git diff --check`: passed.
- Preservation verification:
  - full repository suite: 345/345 passed;
  - lint: passed.
- Actual product-path proof:
  - ran the signed native Claude 2.1.218 client through the new
    `aim auth maintain` command;
  - used one T-4-minute synthetic OAuth lineage and an in-process fake Redis,
    so no real Redis record or credential was reachable;
  - Redis advanced only the synthetic label from v1 to v2;
  - access, refresh, and expiry advanced;
  - the observed request sequence was token first, followed by one bootstrap
    and one usage request;
  - model, invalid, and unexpected route counts were all zero;
  - the exact command summary was
    `refreshed=1 unchanged=0 reauth_required=0 failed=0 skipped=0`;
  - the shared rotation fence and credential projection were absent afterward;
  - no SecurityAgent, Keychain process, or Claude process baseline changed.
- Retained value-free receipt:
  `/Users/aelaguiz/workspace/claude-keychain-free-lab/native/receipts/aimgr-auth-maintain-synthetic-20260724T144813Z-78021c74.json`.
- Harness note: macOS rejects nesting an independent outer Seatbelt around
  AIM's production Seatbelt. The successful retained proof therefore used
  AIM's actual managed-client boundary, synthetic credentials, and the
  non-forwarding loopback fixture. Temporary AIM-to-fixture drivers were
  deleted after the receipt was written and did not become product code or a
  second test harness.
- Remote gate: no M3 contact or mutation occurred before this local proof
  passed.
- Self-check: on track; on scope; no drift detected. Production edits remain
  exactly inside the frozen call-site inventory. No scheduler framework,
  configuration, metrics, notifications, Linux service, direct Anthropic
  OAuth, Keychain path, browser path, or unrelated cleanup was added.
- Next step: commit and push the proven Phase 1 implementation, then deploy
  that exact main commit to `amirs-m3-max-new`.

## Phase 2 deployment and scheduled proof

- Recorded at: 2026-07-24T15:10Z.
- Result: PASS.
- Published implementation:
  - commit `f1064ff3167c117da43d01334791e31c72e42a48`;
  - fast-forwarded local and origin `main`;
  - fast-forwarded the clean M3 checkout to the same commit;
  - ran `npm ci` and `npm run install:local`;
  - confirmed canonical `aim`, Node 22.19.0, Claude 2.1.218, and Redis `PONG`.
- Manual M3 proof:
  - `aim auth maintain` exited zero in 22.8 seconds;
  - refreshed exactly ten due Claude labels and reported
    `refreshed=10 unchanged=0 reauth_required=0 failed=0 skipped=28`;
  - the ten expected Redis records advanced to version 3;
  - 24 fresh Codex records and three fresh Claude records were skipped;
  - the official Claude results reported zero model turns, zero API-duration
    model work, zero cost, and empty model usage;
  - no browser, SecurityAgent, Keychain prompt, unexpected label write, or
    leftover maintainer process was observed.
- Concurrency note:
  - `pro5` was skipped under its existing shared rotation lease;
  - the lease belongs to a live managed `aim claude run pro5` session on the
    Ubuntu host and was actively heartbeating;
  - the maintainer did not interrupt, clear, or race that session;
  - the existing `pro7` projection/fence also predated the maintainer run and
    was not created or changed by it.
- LaunchAgent proof:
  - installed exactly one
    `gui/501/com.funcountry.aimgr.auth-maintainer` job;
  - exact entry point is the canonical local Node binary plus
    `bin/aimgr.js auth maintain --home /Users/aelaguiz`;
  - `RunAtLoad=true`, `StartInterval=60`, plist mode 600, log directory mode
    700, and the installed plist passes `plutil -lint`;
  - two distinct scheduled passes at
    `2026-07-24T10:08:39-0500` and
    `2026-07-24T10:09:39-0500` each reported
    `refreshed=0 unchanged=0 reauth_required=0 failed=0 skipped=38`;
  - `launchctl` reported two completed runs, last exit code zero, and the
    one-shot was not resident between runs;
  - stderr remained empty and no SecurityAgent process appeared.
- Existing dependency-audit warnings printed by `npm ci` were not changed;
  dependency remediation is unrelated to this plan.
- Post-working read-only scope audit: PASS. The implementation matches the
  frozen one-shot plus one LaunchAgent architecture, introduces no unnecessary
  framework, and uses proportionate tests.
- Self-check: on track; on scope; no drift detected. Phase 2 is complete.
