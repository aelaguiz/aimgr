# Codex privacy milestone 1: acceptance

**Milestone 1 still needs final verification of the approved Mac Keychain exception, the remaining macOS acceptance checks and final PR review.** Linux's release-helper build and bounded acceptance pass. The replacement Mac passes configuration, primary auth, diagnostics, Chrome, nested reviewers, CLI/TUI continuation and scheduled routines. The replacement Mac has not returned from the actual MCP reboot test; AWS recovery is in progress. Native MCP passed with the fixture-only permissions Amir has now approved; the final production implementation still needs verification. No PR has been published and milestone 2 implementation has not begun.

The [canonical plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md) defines P01–P26. The [worklog](CODEX_PRIVACY_M1_WORKLOG_2026-11-03.md) and [November 4 historical acceptance record](https://github.com/aelaguiz/aimgr/blob/8fe0a6c/docs/aelaguiz/CODEX_PRIVACY_M1_ACCEPTANCE_2026-11-04.md) retain the intermediate candidates, failures and corrections. A result here applies to its stated platform and fixture; a skipped case or an earlier exploratory Mac run does not establish final acceptance.

## What remains

The documented Linux distribution build uses `cargo build --locked --release`. Its one-job offline build completed in 7,467.3 seconds. The installed release bytes pass native inputs, saved inputs, worktree, first-use settings and collector reload. The paired startup measurement is recorded below. The reviewer carries forward the full JavaScript suite and unrelated auth/keyring/scheduler/browser matrices for this profile-only change.

1. Verify the approved selected-database Mac Keychain permissions and their neighboring-file boundary. Finish interoperability, unavailable-backend behavior, conversion/recovery and interrupted conversion across an actual reboot. Verify separately provisioned Mac environment isolation with synthetic grants.
2. Complete a separate sacrificial-account login on the Mac through the original local browser and assigned test route. Complete real model/MCP/shell work, concurrency, resume, refresh/usage and a calendar occurrence with interactive handoff. Never transfer the Linux primary login.
3. Record Mac startup cost, run the final Mac JavaScript suite, reconcile the complete evidence with the same cold reviewer, and publish the complete PR.

No additional Linux suite rerun is required unless code changes or a new failure justifies one. The final run after the Chrome correction passed **991 of 1,010 cases, with 19 platform/inapplicable skips and zero failures**, in 104.275 seconds. Its private log is `codex-m1-private/final-linux-js-scratch.log` on the isolated Linux VM.

## Current source and cold review

The latest committed source correction is `9feb079`, adding the approved Mac Keychain exception and preserving optional-path startup. Earlier `8e4ed25` preserves independent Linux policy loading and corrects Mac workflow fixtures. The release-helper Linux candidate was `2f42a05725b6db782bc3b8e1a2a1adebed5b3f87f77b3897597285253a78def3`; the bounded shared-lock correction is installed as `ed1830e20698ebf996f25ddfd09470ad0939fd49d497b946ed436bd821be6745`. The approved Mac Keychain implementation awaits native verification.

The fresh whole-code reviewer found two concrete first-use defects: absent shared directories could become conflicting account-private directories, and optional dangling skill/agent/config paths could reject a launch that stock Codex accepts. Both are corrected and reproduced before/after. The same reviewer approved the later bounded Chrome correction and found no further confirmed source or scope defect. This is source review, not final Mac or PR acceptance. The [cold review record](CODEX_PRIVACY_M1_COLD_REVIEW_2026-11-04.md) contains the findings and disposition.

The earlier scope audit removed MCP scheduler discovery, pause/restoration, updater attestation and process signaling. The affected production files and obsolete fixtures lost 555 net lines. Conversion retains affected-consumer refusal, AIM admission blocking, native credential locks, backup, import/readback and recovery. Idle settings fallback now checks metadata before running helpers. Repairing authored-file permissions works in the existing session. No new daemon, account-tier ban, tool allowlist, Codex patch or proxy dependency was added.

## Linux results against the exact official release

Fixture IDs identify private receipts on the isolated test VM. Synthetic fixtures have loopback-only network access; real-service results are listed separately. The plan's detailed cases remain the acceptance authority.

| Workflow | Latest accepted Linux observations | Evidence |
| --- | --- | --- |
| Configuration and database preparation | Read-only projection, native MCP precedence, concurrent cold initialization, warm reopen, lazy-history repair and redacted errors pass with release helpers. Interrupted migration and physical-root aliases recover. | `aimgr-inputs-BbzWkd`; earlier `drkezkn8` |
| Saved state and worktrees | Release helpers pass saved roots/current permissions and destination inputs/worktree ownership. Earlier saved-worktree and OSS cases remain accepted. Database identity comparison is independent of enumeration order. | `aimgr-saved-inputs-pK6ef0`, `aimgr-worktree-qCmPpe`; earlier `IBvjuE`, `y0LjZ7`, `Hqz7L8`, `Mw6Fa0` |
| Built-in model transport and primary auth | HTTP, WebSocket and native refresh retain the selected account. Native/AIM commit orders, re-login/logout fencing and actual kernel-lock contention pass. Custom settings origins use the canonical auth-lock inode. | `exec-8Bw731`, `exec-VBJVLk`, `exec-ajmymY` |
| Account and environment isolation | Holding A across B selection, logout and background operations preserves A's request identity. Two separately provisioned environments use distinct grants for the same account; B leaves A unchanged. | `exec-fsfhWN`, `exec-jk9cPL`, `exec-65K5k0` |
| Shared settings and native writes | Relative paths, live toggles, repeated native saves, atomic authored-file replacement, conflicts, lost replies and restart pass. More than 300 exact grants work. | `native-cRCOEX`, `native-JBa8qj`, `settings-awax0i`, `settings-VNV2Ls` |
| Typed settings and repair | All 24 tested path leaves match the stock/client account views. Project/CLI precedence, explicit home aliases, named profiles, malformed/deleted/unreadable sources and in-session permission repair pass. | `settings-WLzO9s`, `settings-CNYRdd`, `settings-uzBUCJ`, `settings-zkKEKH`, `settings-pI3uvz` |
| Native UI and selected content | Native model/effort/permission changes are followed by actual tool work. Consecutive sessions persist valid native tables. Selected instruction/skill edits affect subsequent turns. | `tui-settings-166c`, `tui2166`, `settings-Q30yYp`, stock `settings-pjvRp9` |
| First-use shared inputs | Release helpers install system skills in the shared tree. First-added instructions reach existing A/B owners; override/removal and optional dangling-input fallback preserve subsequent launches. | `settings-DFvgJ3`; 16 focused account/input cases |
| MCP keyring interoperability | Native reads, five refreshes, expiry/reactive contention, single-use token lineage, logout and two nonresurrecting restarts pass. Backend death fails required startup visibly while a held sibling completes. | `mcp-ZqO3xU`, `mcp-vG4ZIB` |
| MCP conversion and recovery | Existing consumers are refused without signaling; conversion, native logout, pending/committed SIGKILL recovery and conflict preservation pass after excess scheduler controls were removed. The Linux actual-reboot fixture passes. | `ail9cpm5`; reboot receipt in the worklog |
| Actual CLI, concurrency and continuation | A1/A2/B overlap, PTY, skill/MCP/resource/subagent work, same-account resume/fork, fresh rotating continuation and warned manual rotation pass. Required-MCP failure preserves a healthy sibling. After removing the exclusive policy-load lock, all three actual CLI sessions still complete skill, stdio/HTTP MCP and shell work through the simultaneous barrier. | `cli-shared-lock-166`; earlier `cli-a166`, `rot5166`, `fail166` |
| Actual scheduled occurrences | Systemd calendar and interval jobs execute the production worker. Overlap is suppressed; failure is not replayed after interval firings/restart, and the next distinct occurrence succeeds. | `rt166-e` |
| Diagnostics and remote control | Working baseline analytics, Statsig, feedback, log/trace collectors and remote enrollment are observed. Protected model/tools, compaction, error and token refresh continue without collector/enrollment/relay traffic. Release-helper live-edit/refresh rerun has zero diagnostic requests. | `services-P68F58`, `collector-reload-nRtXiE` |
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

Paired empty-home Linux `--version` measurements use the same official 0.166 binary and release helpers. Matching ordinary interactive/routine callers by omitting an explicit executable selection, stock took 24.9 ms on the first run and 14.9–15.9 ms on three subsequent runs. Protected preparation, execution and cleanup took 4.51 seconds on the first run and 4.25–4.34 seconds on three subsequent runs (`startup-tBldeU`). Warm preparation took 1.77–1.96 seconds and native process work took 2.19–2.46 seconds. These are version-command samples, not interactive-startup percentiles. The earlier explicit-copy selection sample (`startup-o7mgOd`) also hashes the selected external executable; its protected 5.02–5.27-second warm results include that additional branch.

Earlier development-helper attribution measured 3.17 seconds for complete-artifact admission, 0.16 seconds for native configuration/database preparation and 2.67 seconds for native launcher/process work including AppArmor compilation (`startup-MQIdYu`). Release configuration/worktree helpers are now 61,597,928 and 8,397,568 bytes, respectively. Their SHA-256 values are `cb643bdac2f6b6ccd1620a4dac0e9e32b2cc3e177ba0eb11a06b6359164de042` and `99879cbece105dd0939187c778b8baba39f0cc12afd479e84b1ab0771f094e79`. This material launch regression remains in final review. No cache, persistent service or weaker admission was added to hide it. The 1,000-session history-capacity experiment remains valid and does not need repetition for the release alignment. Mac startup measurements are pending.

## Mac infrastructure and outstanding evidence

The replacement Mac's release configuration/worktree build completed in 1,504.91 seconds with two jobs; the keyring build took 9.86 seconds. Original Codex and code-mode-host signatures pass strict verification, without re-signing. The installed candidate after the two bounded Mac path corrections is `f2189923475b6decac230db6dfc5cadff5f35c471a35a923ef4c941059ae870a`.

| Mac workflow | Observed result | Private fixture |
| --- | --- | --- |
| Native inputs, saved state and worktrees | Effective inputs, seven-database initialization, saved inputs/worktrees, OSS selection and interrupted state writes pass. | `aimgr-inputs-ABMVFH`, `aimgr-saved-inputs-P7lxOh`, `aimgr-saved-worktree-Y3pbUt`, `aimgr-worktree-7ejcsl`, `aimgr-oss-inputs-nGv549`, `aimgr-state-crash-t294v80_` |
| Shared settings | 323 roots, path types, precedence, profiles, native edits, races, read-only startup and permission repair pass. | `native-RxmrDl`; `mac-settings-batch.json`; `settings-wuIkjv`, `settings-YMxwWz`, `settings-fGLvcF` |
| Live permissions and first use | Read-only/workspace-write/read-only tool execution, model/effort and selected-content edits pass. Optional shared links preserve first use and instruction fallback. | `settings-Rxumcq`, `settings-kKfqtA` |
| Primary auth and ordinary tools | HTTP/WebSocket, selected identity, both refresh commit orders, re-login/logout fencing, kernel lock and custom-home lock pass. | `exec-Z7YVA5`, `exec-B0UEZd`, `exec-L2azu7` |
| Diagnostics | Positive baseline collectors work; protected model/tool/compaction/error and token refresh continue with zero diagnostic traffic. Live settings/refresh reloader also passes. | `services-DWC5mX`, `collector-reload-HKVYZ4` |
| Chrome | Both ordinary/protected Claude transitions and stock/protected official Codex render and exit zero with Chrome's own sandbox enabled. | `mac-chrome-common-home.log`, `exec-rTGMfh` |
| Protected nesting and reviewers | Both protected parent directions, six child sessions and three unchanged read-only reviewers complete actual model/tool work. | `nested-sa9xTy`; earlier `nested-Gk6Kji` |
| CLI, TUI and continuation | Concurrent A1/A2/B, ordinary TUI, skill/MCP/resource/subagent work, resume/fork, live selected-content/settings edits, concurrent TUI and fresh/warned rotation pass. Required-MCP failure preserves a healthy sibling. | `mac-cli-166a` individual receipts; `mac-tui-edits-166a`, `mac-tui-settings-166a`, `mac-concurrent-tui-166a`, `mac-rotation-166a`, `mfail166` |
| Owner lifetime | Normal exit, abrupt owner death and the expected surviving ordinary background process pass. The surviving vendor retains its admitted digest and privacy denial; a sibling completes. | `mac-life-166b` |
| Actual scheduled occurrences | Launchd calendar and interval jobs execute the production worker. Same-thread handoff, overlap suppression, no replay of a failed occurrence after restart and a distinct later successful occurrence pass. | `rt166-mac-c` |
| MCP conversion and recovery | Existing native consumer refusal, complete File-to-Direct conversion, unchanged native logout, seven SIGKILL boundaries and conflicting destination preservation pass with custom settings and canonical locks. Actual reboot remains pending. | `aimgr-mcp-maintenance-lol7nu1t` |

Native MCP remains a confirmed compatibility failure in the ordinary candidate. With the actual disposable OS user's HOME, stock Codex recognizes the synthetic credential while the metadata-only protected candidate reports unknown auth (`mcp-DoSPgz`, `mcp-KCrfa0`). Apple Security.framework reads the default Keychain database itself. The synthetic API control succeeds only when database data reads are allowed; metadata access alone is insufficient. A fixture-only official-client control then recognizes the credential under both protected accounts but fails the first refresh while writing the database lock (`mcp-wDfG9r`). Allowing that exact lock exposes the next required operation: creating an atomic replacement with the database's `.sb-` filename prefix (`mcp-R1F0Jv`).

The completed fixture-only control permits data reads and updates to the selected disposable database, its exact SHA-1-derived lock and that database's atomic replacement filenames; it keeps database extended-attribute denial and grants no whole directory. Native interoperability passes (`mcp-FJSppa`): three reads, two protected account homes, five refreshes, both contention modes, logout and two nonresurrecting restarts. Locked-Keychain behavior also passes (`mcp-rSoV8A`): required startup fails before a model request, while the held healthy sibling completes and remains protected. The control proves unrelated synthetic account and service names are readable in the raw database bytes; the synthetic password is not present in plaintext. Existing item permissions and encryption are distinct from whole-database filesystem access. Both ordinary candidate selectors and source were restored after every control. Amir subsequently approved the exception explicitly: “Yes—allow the Keychain exception.” The canonical plan now records whole-database read/write exposure, retained encryption/item permissions and the exact filesystem scope. Final production-candidate verification remains open.

Three Mac observer scripts required the fixed ctypes argument types for the variadic `sandbox_check` call on arm64. The prior untyped call falsely reported denial of an ordinary allowed tool and caused a synthetic service error. The corrected paired check reports allowed access; nested and owner-lifetime reruns pass. The first routine attempt also required root-owned mode-0644 launchd plists. A subsequent fixture used a root outside the driver's existing `rt166-` prefix and was corrected without product changes. Failed attempts are retained and excluded from acceptance.

The official Mac read-only sandbox canonicalizes `/tmp` to `/private/tmp` while locating its daemon directory. Its metadata was incorrectly denied. The launcher now grants that literal directory's metadata, while explicitly denying data/listing and extended-attribute values. Actual read-only shell work passes; the native boundary probe separately checks private siblings and ordinary tools.

Mac also needs to inspect an authored dangling shared entry before observing native NotFound. The inventory retains only the exact classified shared entry, and the native exception requires its canonical parent and matching account-home link. Required configured paths and deny paths keep strict validation. Whole first-use testing passes, including dangling HOME/project skills, shared agents and instruction override. The cold reviewer found no source correctness or scope blocker in either correction.

Chrome's synthetic-HOME control rendered but failed shutdown waiting for Keychain authorization; the identical stock command succeeded with the disposable OS user's actual HOME. The cold reviewer approved correcting only this fixture environment to match production, which preserves caller HOME. Fresh profiles, dead loopback proxy, signed browser, sandbox flags and inherited AIM TMPDIR remain unchanged. No product Chrome or Keychain workaround was introduced.

The original rental still cannot reach SSH after the approved same-instance root-disk replacement completed at 21:46:39 UTC on November 4. System/EBS checks pass but guest reachability fails. Its original encrypted disk and interrupted synthetic transaction remain retained. No successful boot or recovery is claimed.

Amir approved one replacement at $15.60 minimum plus storage. One distinct physical host was allocated at 22:13 UTC. Alternative supported zones had definite capacity failures; allocation succeeded in the original zone. The first guest terminated with `Server.InsufficientInstanceCapacity`, and the host was subsequently observed in `pending` with no guest. Its pre-launch state was not captured, so that later state is not an established cause. At 00:09 UTC on November 5, the host became available and one guest was launched on it; no further rental is authorized.

Both rentals' termination and bounded host-release schedules are enabled. The replacement passed a clean macOS reboot before AIM installation at 00:25 UTC on November 5: SSH recovered with a distinct boot identity and AIM was absent before and after. AWS made the host available after its preparation interval; the guest now passes its health checks. The initial SSH timeout was the GCP control firewall retaining only the original Mac address. Adding the replacement's exact /32 to the existing SSH-only rule restored access. Public code, official binaries, toolchains and package caches are now being transferred; no account home, primary grant or browser profile is included.

The default-service baseline passed with exact local-policy backup/restoration. The interrupted-conversion fixture must keep the same helper bytes, transaction and Keychain across its actual reboot. Preserve the original failed rental's evidence independently.

## Exact release

Use official **0.166.0**, source commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The previous alpha.5 binary and November 1 development source were different revisions. Earlier native observations remain exploratory; they do not certify this pair.

| File | SHA-256 |
| --- | --- |
| Official source archive | `718c86dcd7104919f2820aa79db0fa0083b5f240aa16da704f43e4acf7b544e5` |
| Linux Codex | `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8` |
| Linux code-mode host | `657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630` |
| macOS Codex | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` |
| macOS code-mode host | `fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a` |

All four published binary archives and the pinned source archive were downloaded through the isolated VM's assigned route and verified. Original Mac signatures pass strict verification on the replacement Mac. Record the installed artifact set, helper digests, source revision, fixture digest, command and private evidence directory for each accepted run. Several fixtures use debug helper paths; both test hosts now place the exact release helper bytes there.

## Evidence requirements for final review

Record each run's platform, actual official/helper/policy hashes, source revision, fixture digest, command, private evidence directory and observed outcome. Some fixture paths say `target/debug`; on the replacement Mac those paths will contain copies of the exact release-built helper bytes, and their hashes must match.

Use only the established sacrificial accounts and routes. Real sign-in stays in the original local browser. Synthetic positive controls must work before their protected absence is accepted. A native keyring failure, skipped Chrome run, interval-only schedule or source inspection cannot substitute for its required integration result.

The two approved privacy exceptions remain organization-owned policy and same-user Linux mount information. Disabling all optional diagnostic exporters, including custom collectors, is explicitly approved. Relative shared paths remain supported, with path-target changes allowed to wait for a new session. The official client remains unchanged.
