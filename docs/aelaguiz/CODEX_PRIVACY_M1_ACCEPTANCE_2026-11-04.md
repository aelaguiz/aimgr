# Codex privacy milestone 1: acceptance

**Milestone 1 still needs exact-release macOS acceptance and final PR review.** The Linux workflow checks and final JavaScript suite pass. The replacement Mac has not reached boot. No PR has been published and milestone 2 implementation has not begun.

The [canonical plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md) defines P01–P26. The [worklog](CODEX_PRIVACY_M1_WORKLOG_2026-11-03.md) and [November 4 historical acceptance record](https://github.com/aelaguiz/aimgr/blob/8fe0a6c/docs/aelaguiz/CODEX_PRIVACY_M1_ACCEPTANCE_2026-11-04.md) retain the intermediate candidates, failures and corrections. A result here applies to its stated platform and fixture; a skipped case or an earlier exploratory Mac run does not establish final acceptance.

## What remains

1. Prove a clean reboot on the replacement Mac before installing AIM. Build the pinned helpers there, verify the unchanged official signatures, and install the candidate.
2. Execute the applicable native matrix on that Mac, including Chrome, both protected Claude/Codex parent directions, the unchanged read-only reviewer, real launchd calendar/interval jobs and the interrupted MCP conversion across an actual reboot.
3. Authorize a separate sacrificial-account login on the Mac through the original local browser and assigned test route. Complete real model/MCP/shell work, concurrency, resume, refresh/usage and a calendar occurrence with interactive handoff. Never transfer the Linux primary login.
4. Record Mac release-build size, time and startup cost. Run the final Mac JavaScript suite, reconcile the complete evidence with the same cold reviewer, and publish the complete PR.

No additional Linux suite rerun is required unless code changes or a new failure justifies one. The final run after the Chrome correction passed **991 of 1,010 cases, with 19 platform/inapplicable skips and zero failures**, in 104.275 seconds. Its private log is `codex-m1-private/final-linux-js-scratch.log` on the isolated Linux VM.

## Current source and cold review

The latest tested source correction is [short private temporary paths for Chrome](https://github.com/aelaguiz/aimgr/commit/8fe0a6c). The installed Linux candidate is `30d2ec496480262395cddffda32f895065a7d6a60f087b383c0527f09a5be41c`. Its helper bytes retain the preceding first-use/optional-input correction; its native launchers and invocation scratch handling contain the Chrome correction.

The fresh whole-code reviewer found two concrete first-use defects: absent shared directories could become conflicting account-private directories, and optional dangling skill/agent/config paths could reject a launch that stock Codex accepts. Both are corrected and reproduced before/after. The same reviewer approved the later bounded Chrome correction and found no further confirmed source or scope defect. This is source review, not final Mac or PR acceptance. The [cold review record](CODEX_PRIVACY_M1_COLD_REVIEW_2026-11-04.md) contains the findings and disposition.

The earlier scope audit removed MCP scheduler discovery, pause/restoration, updater attestation and process signaling. The affected production files and obsolete fixtures lost 555 net lines. Conversion retains affected-consumer refusal, AIM admission blocking, native credential locks, backup, import/readback and recovery. Idle settings fallback now checks metadata before running helpers. Repairing authored-file permissions works in the existing session. No new daemon, account-tier ban, tool allowlist, Codex patch or proxy dependency was added.

## Linux results against the exact official release

Fixture IDs identify private receipts on the isolated test VM. Synthetic fixtures have loopback-only network access; real-service results are listed separately. The plan's detailed cases remain the acceptance authority.

| Workflow | Latest accepted Linux observations | Evidence |
| --- | --- | --- |
| Configuration and database preparation | Read-only projection, native MCP precedence, concurrent cold initialization, warm reopen, lazy-history repair and redacted errors pass. Interrupted migration and physical-root aliases recover. | `aimgr-inputs-wg2kIy`, `drkezkn8` |
| Saved state and worktrees | Destination inputs, worktree ownership, saved permissions/context and OSS selection pass. Database identity comparison is independent of enumeration order. | `IBvjuE`, `y0LjZ7`, `Hqz7L8`, `Mw6Fa0` |
| Built-in model transport and primary auth | HTTP, WebSocket and native refresh retain the selected account. Native/AIM commit orders, re-login/logout fencing and actual kernel-lock contention pass. Custom settings origins use the canonical auth-lock inode. | `exec-8Bw731`, `exec-VBJVLk`, `exec-ajmymY` |
| Account and environment isolation | Holding A across B selection, logout and background operations preserves A's request identity. Two separately provisioned environments use distinct grants for the same account; B leaves A unchanged. | `exec-fsfhWN`, `exec-jk9cPL`, `exec-65K5k0` |
| Shared settings and native writes | Relative paths, live toggles, repeated native saves, atomic authored-file replacement, conflicts, lost replies and restart pass. More than 300 exact grants work. | `native-cRCOEX`, `native-JBa8qj`, `settings-awax0i`, `settings-VNV2Ls` |
| Typed settings and repair | All 24 tested path leaves match the stock/client account views. Project/CLI precedence, explicit home aliases, named profiles, malformed/deleted/unreadable sources and in-session permission repair pass. | `settings-WLzO9s`, `settings-CNYRdd`, `settings-uzBUCJ`, `settings-zkKEKH`, `settings-pI3uvz` |
| Native UI and selected content | Native model/effort/permission changes are followed by actual tool work. Consecutive sessions persist valid native tables. Selected instruction/skill edits affect subsequent turns. | `tui-settings-166c`, `tui2166`, `settings-Q30yYp`, stock `settings-pjvRp9` |
| First-use shared inputs | System skills install in the shared tree. First-added instructions reach existing A/B owners; override/removal and optional dangling-input fallback preserve subsequent launches. | `settings-n1bl9q`; 16 focused account/input cases |
| MCP keyring interoperability | Native reads, five refreshes, expiry/reactive contention, single-use token lineage, logout and two nonresurrecting restarts pass. Backend death fails required startup visibly while a held sibling completes. | `mcp-ZqO3xU`, `mcp-vG4ZIB` |
| MCP conversion and recovery | Existing consumers are refused without signaling; conversion, native logout, pending/committed SIGKILL recovery and conflict preservation pass after excess scheduler controls were removed. The Linux actual-reboot fixture passes. | `ail9cpm5`; reboot receipt in the worklog |
| Actual CLI, concurrency and continuation | A1/A2/B overlap, PTY, skill/MCP/resource/subagent work, same-account resume/fork, fresh rotating continuation and warned manual rotation pass. Required-MCP failure preserves a healthy sibling. | `cli-a166`, `rot5166`, `fail166` |
| Actual scheduled occurrences | Systemd calendar and interval jobs execute the production worker. Overlap is suppressed; failure is not replayed after interval firings/restart, and the next distinct occurrence succeeds. | `rt166-e` |
| Diagnostics and remote control | Working baseline analytics, Statsig, feedback, log/trace collectors and remote enrollment are observed. Protected model/tools, compaction, error and token refresh continue without collector/enrollment/relay traffic. Installed-policy live-edit/refresh rerun has zero diagnostic requests. | `services-P68F58`, `collector-reload-2XVJSA` |
| Native vendor/tool boundary | Vendor reentry under `no_new_privs`, compound-profile orderings, file/uname denial, normal tools, sudo, build and bubblewrap pass. Exact temporary-directory grants reject unsafe paths, owners, modes and symlinks. | `tool-boundary-00ot4nq5` |
| Protected nesting and read-only review | Actual model/tool turns cover protected Codex to Claude and same/different Codex accounts. The protected Claude parent runs the original unchanged read-only Codex reviewer. | `nested-gjVnwX`, `nested-IWLKJP` |
| Actual Chrome | Stock and protected official clients launch ordinary Chrome with its own sandbox enabled. SDK keys, normal files and ordinary uname continue working. | `exec-Yoq6Tf` |
| Owner lifetime | Normal exit, abrupt owner death, surviving ordinary background tools and a held healthy sibling pass. Surviving vendor images match the admitted digest and enforcing profile before cleanup. | `life-scratch-dxo7xb2v` |

The exact configuration helper's seven Rust unit tests passed in one offline single-job build (18m01s). Component tests also cover copied grants/provenance, environment provisioning, local versus Prime/Pi legacy authority, descriptor/alias boundaries, manual OAuth invalid inputs, admission sentinels and cleanup. They remain distinct from the actual-client observations in the table.

## Real-service Linux compatibility

The sacrificial proxy6 account completed independent manual authorization through its original local Chrome profile and assigned route. Only the one-time callback returned to the originating VM. The local grant was never copied to another machine or published to the shared pool.

Model/MCP/shell work, same-account resume, two simultaneous sessions with held shell tools, fresh status/usage and actual AIM refresh pass. Refresh changes only the local generation and retains the account/environment binding. This account's native catalog does not offer Sol; real functional checks use its advertised `gpt-6-chat-thinking` at medium effort. The unchanged read-only reviewer is verified separately.

The actual calendar run `real-codex-routine-OqMbYw` passes production CLI/worker selection, model/MCP/shell work, duplicate suppression and same-thread interactive handoff with normal terminal exit. Herdr window operations use a test UI stand-in. The external assigned-route wrapper is part of the offsite test boundary, not an M1 runtime dependency. The one-authorized-account fixture clears its prior active selection; production rotation is unchanged.

The real login exposed an idle Redis connection across human browser interaction. AIM now closes it before the handoff, reconnects afterward, rechecks the environment and registers metadata before saving the grant. The compressed real-Redis regression failed before that correction; two Redis cases and 16 manual-protocol cases pass afterward.

## Reproduced workflow corrections

The actual-client Chrome check `exec-UXYYLf` showed a successful stock control and `Socket path too long` under AIM. The account-root `TMPDIR` exceeded Chrome's Unix-socket limit. Invocation scratch now uses a short, caller-owned mode-0700 direct child of physical `/tmp`. The native validator checks the fixed parent, UID prefix, actual directory ownership, mode and ACL. Only that subtree is granted; the shared temp root and siblings remain unreadable. Nonempty scratch is retained for ordinary background tools. The actual-client, boundary, real Unix-socket and lifetime regressions pass after the correction.

Native settings testing also reproduced two serialization races: a newly added inline `tui` object became invalid on the next native save, and independent additions to an absent table produced a false conflict. New objects retain native-editable block-table form, and concurrent table creation merges independent children while preserving same-key conflicts. Consecutive native sessions and the focused exchange-race regression pass.

The unchanged Linux read-only reviewer required its fixed UID daemon directory and owner-qualified process mount information. After the explicit approval, the policy grants the directory itself and `owner /proc/[0-9]*/mountinfo r`. Native sandbox reexec retains both tool and vendor profile components; identifier mediation recognizes either ordering. The original reviewer now completes actual model/tool work. No vendor executable or reviewer command was changed.

## Operational cost

Paired empty-home Linux `--version` measurements use the same official 0.166 binary. Stock took 169 ms cold and 17–37 ms across three warm runs. Protected preparation, process execution and cleanup took 7.75 seconds cold and 5.57–6.46 seconds warm (`startup-v2EcmL`). These are version-command samples, not interactive-startup percentiles.

Warm attribution measured 3.17 seconds for complete-artifact admission, 0.16 seconds for native configuration/database preparation and 2.67 seconds for native launcher/process work including AppArmor compilation (`startup-MQIdYu`). The admitted bundle is approximately 556 MB, including stripped development helpers of 129 MB and 24 MB. This material launch regression remains in the PR opening and final review. No cache, persistent service or weaker admission was added to hide it. The 1,000-session history-capacity experiment remains valid and does not need repetition for the release alignment. Exact-release Mac build/distribution/startup measurements are pending.

## Mac infrastructure and outstanding evidence

The original rental still cannot reach SSH after the approved same-instance root-disk replacement completed at 21:46:39 UTC on November 4. System/EBS checks pass but guest reachability fails. Its original encrypted disk and interrupted synthetic transaction remain retained. No successful boot or recovery is claimed.

Amir approved one replacement at $15.60 minimum plus storage. One distinct physical host was allocated at 22:13 UTC. Alternative supported zones had definite capacity failures; allocation succeeded in the original zone. The first guest terminated with `Server.InsufficientInstanceCapacity`, and the host was subsequently observed in `pending` with no guest. Its pre-launch state was not captured, so that later state is not an established cause. The same-host waiter may launch one guest only after the host becomes available; no further rental is authorized.

Both rentals' termination and bounded host-release schedules are enabled. The replacement's first check is a clean macOS reboot before AIM installation. Public code, official binaries, toolchains and package caches are prepared for transfer; no account home, primary grant or browser profile is included.

The existing fixtures have Mac branches for disposable-Keychain interoperability/unavailability, native parent-boundary observations, launchd calendar/interval occurrences and default-service controls. Their syntax checks pass remotely; Mac execution is pending. The default-service baseline temporarily uses empty local policy with exact backup/restoration and must run exclusively. The interrupted-conversion fixture must keep the same helper bytes, transaction and Keychain across its actual reboot. Preserve the original failed rental's evidence independently.

## Exact release

Use official **0.166.0**, source commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The previous alpha.5 binary and November 1 development source were different revisions. Earlier native observations remain exploratory; they do not certify this pair.

| File | SHA-256 |
| --- | --- |
| Official source archive | `718c86dcd7104919f2820aa79db0fa0083b5f240aa16da704f43e4acf7b544e5` |
| Linux Codex | `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8` |
| Linux code-mode host | `657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630` |
| macOS Codex | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` |
| macOS code-mode host | `fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a` |

All four published binary archives and the pinned source archive were downloaded through the isolated VM's assigned route and verified. Mac signatures still require verification on the recovered Mac. Record the installed artifact set, helper digests, source revision, fixture digest, command and private evidence directory for each accepted run. Several fixtures use debug helper paths; verify the actual files, not merely the source checkout.

## Evidence requirements for final review

Record each run's platform, actual official/helper/policy hashes, source revision, fixture digest, command, private evidence directory and observed outcome. Some fixture paths say `target/debug`; on the replacement Mac those paths will contain copies of the exact release-built helper bytes, and their hashes must match.

Use only the established sacrificial accounts and routes. Real sign-in stays in the original local browser. Synthetic positive controls must work before their protected absence is accepted. A native keyring failure, skipped Chrome run, interval-only schedule or source inspection cannot substitute for its required integration result.

The two approved privacy exceptions remain organization-owned policy and same-user Linux mount information. Disabling all optional diagnostic exporters, including custom collectors, is explicitly approved. Relative shared paths remain supported, with path-target changes allowed to wait for a new session. The official client remains unchanged.
