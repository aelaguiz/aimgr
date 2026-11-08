# Claude per-machine implementation review disposition

An independent read-only review of `7d96da9..dc781c1` found two workflow breaks and several smaller issues. The dispositions below describe the subsequent changes; they are not final acceptance. The [acceptance record](CLAUDE_PER_MACHINE_ACCEPTANCE_2026-11-07.md) identifies the revisions and native tests actually run.

| Finding | Disposition |
| --- | --- |
| Missing settings directories or stale trusted-project entries could prevent direct sessions from launching. | [b5c599b](https://github.com/aelaguiz/aimgr/commit/b5c599b1b0d7bdfe0f892c569c8b5812860140fc) handles future additional directories and skips unusable historical trust entries while retaining the whole-home exclusions. Native validation of the changed cases remains pending. |
| First local enrollment could fail only after browser authorization if an old session was running. | b5c599b checks before authorization and tells the operator to stop the account's local sessions and background work; it checks again when saving. Same-owner relogin remains concurrent. Native validation of this change remains pending. |
| Prime/Pi's separate Anthropic grant no longer has scheduled maintenance. | Accepted: it refreshes on demand through the legacy helper. b5c599b removes the unreachable scheduled-maintenance branch and the plan records the decision. |
| Maintenance started lock helpers for labels without a local grant and bypassed the usual state guard. | [e69e3e0](https://github.com/aelaguiz/aimgr/commit/e69e3e044ea1b6bcaf2cec848dadc3acbfee7d3b) checks for a due local grant before locking and uses the state guard; b5c599b removes the skipped-login log line. |
| Status treated every label without a local login as needing attention. | b5c599b displays `NOT SIGNED IN` for a missing local login and retains `NEEDS YOU` for actual reauthentication. The updated focused status and README contract tests passed on Linux at b5c599b1. |
| Any absolute `BROWSER` file was included as a vendor input for every launch. | b5c599b limits that input to login staging. |
| Several messages named retired native credential transfer commands. | b5c599b points managed Claude to local login and Prime/Pi to its separate enrollment, updates help and the README contract, and documents the remote callback procedure. |
| The manual bridge did not recognize the pinned native client's authorization URL at the review head. | [8c1c4b0](https://github.com/aelaguiz/aimgr/commit/8c1c4b0) accepts that URL. The Linux native mock exchange passed at that revision; the Mac overlap assertion and real two-host grant independence remain open in the acceptance record. |

The review also identified dead idle-stop code and a duplicate cache removal; b5c599b removes both. It recommended retaining the separate legacy home, offline metadata cache, refresh-lock wait and rejected-grant handling. The session-count sentinel and clone-provisioning option were minor optional cleanups, not acceptance conditions.

The review's test limitations remain in force until the recorded gaps are closed: native retained workflows and lock behavior on both hosts, independent sacrificial-account sign-ins and refreshes, collector coverage beyond the model-turn tests, final-head Redis and regression checks, and independent final review.
