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
