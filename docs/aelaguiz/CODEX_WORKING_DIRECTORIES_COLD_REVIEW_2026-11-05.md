# Codex privacy completion: independent cold audit

A clean-context Claude Opus 5.5 reviewer, at high effort, read the full PR #14 implementation, original human requirements, agreed allowed/disallowed policy, canonical plan and the new working-directory changes. It explicitly checked privacy compliance, workflow breakage, scope creep and unnecessary restrictions. Its initial review used two read-only native helpers. The implementation owner did not supply a preferred verdict.

The initial verdict was **not ready**, with concrete corrections. The same reviewer then inspected the corrections in a bounded follow-up and returned **“no blockers left in the changed code”**, subject to the outstanding native results. Those native boundary, work-directory and Mac Chrome checks subsequently passed on both isolated platforms. The [acceptance record](CODEX_WORKING_DIRECTORIES_ACCEPTANCE_2026-11-05.md) identifies the actual runs and distinguishes new executions from retained historical evidence.

## Findings and disposition

| Finding | Disposition |
| --- | --- |
| Linux/Mac native temp fixtures contradicted the newly approved `/tmp` access. | Fixed. They grant and test shared temp reads/listing. Private canaries remain outside approved work roots. Both native fixtures pass; Mac passes custom and standard Keychain variants. |
| Mac screenshot thumbnails use the OS user's temporary folder, which was still excluded. | Fixed. Discover `DARWIN_USER_TEMP_DIR` independently of AIM's scratch `TMPDIR`; actual official-client images and shell writes pass there, including files created after launch. |
| An unusable default folder could stop all sessions. | Fixed. Optional discovered roots that cannot resolve or would expose home/account parents are skipped. Explicit invalid settings still report an error. Mac reads just the screenshot-location plist value; unrelated plist types cannot break discovery. |
| The resume picker and passthrough resume missed the account-linking warning. | Fixed using parsed command semantics, with actual CLI routing tests for picker, passthrough, exec resume and ordinary prompt text. This gap already existed on main. |
| Deterministic per-label installation-ID writers remained as dead code. | Removed. Environment/account state continues to create random per-environment, per-account identities. |
| Reviewer initially suggested removing forced keyring storage on headless Linux. | Reviewer withdrew the finding after checking the approved contract. Such a fallback would lose shared MCP logins or create per-account token copies, both contrary to the plan. The README now states the native-keyring prerequisite and preservation of an unconverted File store. No fallback or credential service was added. |

The reviewer found the work-directory implementation proportionate to the request and no new restrictions on ordinary tools. It confirmed exact outside-file selection, future files, paths with spaces, native read-only permission modes, account/environment auth ownership, exporter disabling, retained identity controls and fresh rotating continuation identities.

The review mentioned possible Ubuntu snap compatibility as an **unconfirmed guess**, not a reproduced regression. No snap-policy expansion was added. It also noted a harmless redundant Linux daemon-directory rule; removing that unrelated compatibility entry was not needed to complete this request.

## Review provenance and limits

Review session: `d086a261-8fbe-4b11-bb5f-96e711dc2ebf`; actual provider model `claude-opus-5-5`. The reviewer changed no files. It independently ran focused checks: 35 passed, one Linux-only socket case skipped on Mac. The initial report did not claim the then-pending retained native/full-suite runs. The follow-up accepted the source corrections conditionally; final native outcomes were checked by the implementation owner and recorded separately, rather than attributed to a reviewer who had not run them.

This audit covers Codex privacy PR #14. Proxy PR #15 is parked. Claude right-sizing and primary-login migration stay in the existing cross-provider issues; they are not silently included or declared finished by this PR.
