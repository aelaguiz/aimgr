# AIM worklist

Open development work is tracked in [GitHub Issues](https://github.com/aelaguiz/aimgr/issues). This worklist is the repository's index across privacy and future development. Each linked issue owns its scope, discussion, acceptance criteria and current status.

## Current work

- **[Show account status across the AIM cluster — #29](https://github.com/aelaguiz/aimgr/issues/29).** Add a per-machine cluster status view; see the [plan](docs/AIM_CLUSTER_ACCOUNT_STATUS_2026-11-10.md).

- **[Use only manual callbacks for Claude and Codex login — #24](https://github.com/aelaguiz/aimgr/issues/24).** Remove competing enrollment and browser automation paths; preserve the BrowserOS/secrets wrapper protocol. Implemented in [PR #25](https://github.com/aelaguiz/aimgr/pull/25), stacked on PR #22.

1. **[Implement per-machine Claude login and right-sized privacy — #21](https://github.com/aelaguiz/aimgr/issues/21).** Owns the Claude implementation portions of #16 and #17, with the [plan](docs/CLAUDE_PER_MACHINE_PRIVACY_AND_LOGIN_2026-11-07.md). The implementation, native acceptance and independent cold review are complete in [PR #22](https://github.com/aelaguiz/aimgr/pull/22), stacked on Codex privacy PR #14.

2. **[Right-size Claude and Codex privacy around the agreed working directories — #16](https://github.com/aelaguiz/aimgr/issues/16).** The issue compares both providers against the [allowed/disallowed list](docs/AI_APP_PRIVACY_INVENTORY.md#allowed-and-disallowed-access). It owns broad workspace, `/tmp`, Downloads and screenshot access, Claude's privacy baseline independent of proxies, and compatibility tests that preserve ordinary tools and reviewers. Claude implementation and acceptance are in #21; completed overbuild cuts stay in #18.
3. **[Remove unnecessary Codex privacy gates and recovery machinery — #18](https://github.com/aelaguiz/aimgr/issues/18).** Remove the launch vetoes, repeated checks, helper integrity restrictions and indefinite settings replay identified by the cold audit. Validate the cuts on isolated Linux and Mac machines and have the cold auditor check the resulting implementation.
4. **[Use per-machine primary authentication for Codex and Claude — #17](https://github.com/aelaguiz/aimgr/issues/17).** Track per-machine primary login for Codex and Claude; the Claude implementation and acceptance are in #21.

## Tracking work

Check [existing issues](https://github.com/aelaguiz/aimgr/issues) before creating another for the same work. Add new work here with a link to its issue, and update this index when work is completed or its scope changes. The [open-issue list](https://github.com/aelaguiz/aimgr/issues?q=is%3Aissue%20is%3Aopen) holds the current state; this document does not duplicate issue status or task checklists.

The [Claude and Codex privacy inventory](docs/AI_APP_PRIVACY_INVENTORY.md) holds the privacy findings, source evidence and accepted workflow exceptions. Privacy follow-ups are tracked here and in their GitHub issues alongside other development work.
