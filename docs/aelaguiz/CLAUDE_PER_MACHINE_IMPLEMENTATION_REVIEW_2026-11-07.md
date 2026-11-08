# Claude per-machine implementation review disposition

An independent read-only review of `7d96da9..dc781c1` found two workflow breaks and several smaller issues. The dispositions below describe the subsequent changes; they are not final acceptance. The [acceptance record](CLAUDE_PER_MACHINE_ACCEPTANCE_2026-11-07.md) identifies the revisions and native tests actually run.

| Finding | Disposition |
| --- | --- |
| Missing settings directories or stale trusted-project entries could prevent direct sessions from launching. | [b5c599b](https://github.com/aelaguiz/aimgr/commit/b5c599b1b0d7bdfe0f892c569c8b5812860140fc) handles future additional directories and skips unusable historical trust entries while retaining the whole-home exclusions. Native pairs on Linux and Mac passed the missing settings, historical settings and trusted-project cases, while excluding an unselected private file. |
| First local enrollment could fail only after browser authorization if an old session was running. | b5c599b checks before authorization and tells the operator to stop the account's local sessions and background work; it checks again when saving. Same-owner relogin remains concurrent. The Mac native `3262b3ec` run refused a live owner before authorization and passed both same-owner refresh lock orders. |
| Prime/Pi's separate Anthropic grant no longer has scheduled maintenance. | Accepted: it refreshes on demand through the legacy helper. b5c599b removes the unreachable scheduled-maintenance branch and the plan records the decision. |
| Maintenance started lock helpers for labels without a local grant and bypassed the usual state guard. | [e69e3e0](https://github.com/aelaguiz/aimgr/commit/e69e3e044ea1b6bcaf2cec848dadc3acbfee7d3b) checks for a due local grant before locking and uses the state guard; b5c599b removes the skipped-login log line. |
| Status treated every label without a local login as needing attention. | b5c599b displays `NOT SIGNED IN` for a missing local login and retains `NEEDS YOU` for actual reauthentication. The updated focused status and README contract tests passed on Linux at b5c599b1. |
| Any absolute `BROWSER` file was included as a vendor input for every launch. | b5c599b limits that input to login staging. |
| Several messages named retired native credential transfer commands. | b5c599b points managed Claude to local login and Prime/Pi to its separate enrollment, updates help and the README contract, and documents the remote callback procedure. |
| The manual bridge did not recognize the pinned native client's authorization URL at the review head. | [8c1c4b0](https://github.com/aelaguiz/aimgr/commit/8c1c4b0) accepts that URL. The Linux native mock exchange passed at that revision. Mac native relogin and both refresh lock orders passed at `3262b3ec`, and two-host real grant independence passed at `b5c599b1`; the acceptance record preserves the earlier Mac failures and test scopes. |

The review also identified dead idle-stop code and a duplicate cache removal; b5c599b removes both. It recommended retaining the separate legacy home, offline metadata cache, refresh-lock wait and rejected-grant handling. The session-count sentinel and clone-provisioning option were minor optional cleanups, not acceptance conditions.

The native workflows, real two-host grant sequence and diagnostic lifecycle are recorded with their tested revisions in the acceptance record. Focused follow-ups for all five Mac full-suite failures passed; independent final review remains open; real Redis boundary tests passed on both hosts at `6ccfebdf`.

## Follow-up to the closure review

The later independent review found no privacy or workflow blocker and no material overbuild, but identified two callers and requested additional evidence. [6ccfebd](https://github.com/aelaguiz/aimgr/commit/6ccfebdf) corrects the offline general-status interpretation of direct metadata and restores external skill target discovery under settings-listed folders. On both hosts, status tests passed 12/12 and network tests passed 15/15; native stock/protected settings-linked skill pairs also passed. The [acceptance record](CLAUDE_PER_MACHINE_ACCEPTANCE_2026-11-07.md) preserves the Mac network retry and native fixture preflight.

The existing public CLI test exercises a direct online launch, repeat launch and offline resume with a synthetic executable. Earlier native assigned-route evidence covers an offline launch on the pinned client; the real two-host grant test separately used the assigned route. The inventory now distinguishes AIM's preserved launch environment from Claude's own removal of generic OTel variables from child processes. The reviewer has not yet assessed these final changes.
