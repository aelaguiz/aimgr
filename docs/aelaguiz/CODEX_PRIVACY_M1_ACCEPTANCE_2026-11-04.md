# Codex privacy milestone 1: remaining acceptance

The implementation is not ready for its final PR verdict. The canonical requirements remain in [the privacy plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md); historical component results are in [the worklog](CODEX_PRIVACY_M1_WORKLOG_2026-11-03.md). This ledger records the exact-release correction and the cold review's remaining evidence requirements. It does not replace or weaken P01–P26.

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

## Native reruns

| Existing fixture | Required evidence | Current exact-pair result |
| --- | --- | --- |
| `privacy-codex-native-inputs.mjs` | Read-only inputs; three cold initializers; warm reopen; lazy-history repair; native MCP precedence; redacted errors | Pending both platforms |
| `privacy-codex-state-crash.py` | Physical-root aliases, held child locks, interrupted native migration/retry | Pending both platforms |
| `privacy-codex-worktree.mjs`, `privacy-codex-saved-inputs.mjs`, `privacy-codex-saved-worktree.mjs`, `privacy-codex-oss-inputs.mjs` | Committed destination inputs; ownership; saved contexts and permissions; OSS selection | Pending both platforms |
| `privacy-codex-native-exec.mjs` | Baseline/protected headers and PATH aliases; built-in HTTP/WebSocket; native primary refresh; ordinary SDK keys and tools | Pending both platforms |
| `privacy-codex-native-exec.mjs --auth-races` | Actual native/AIM commit orders with native same-login semantics, new-login/logout fencing and shared lock exclusion | Linux `exec-VBJVLk` passed both reply orders, re-login/logout fencing and an observed native kernel-lock waiter; Mac pending |
| `privacy-codex-native-smoke.mjs --many-roots` | Relative skill edits, live nonpath changes, mixed native writes/reload, rejected version, more than 300 exact grants | Pending both platforms |
| `privacy-codex-native-mcp.mjs` | Native keyring read, expiry and reactive-refresh contention, latest single-use lineage, logout/restart | Pending Linux; Mac backend adaptation still needed |
| `codex-mcp-maintenance.py --custom-settings` | Original and canonical lock roots; conversion; conflict/source preservation; pending/committed recovery | Earlier package passed Linux; exact pair pending |
| `privacy-codex-standalone-audit.py --aim-cli --phase all --terminal-input --mcp-auth` plus `required-failure` | Actual AIM entrypoint, A1/A2/B model barrier, PTY, skill/MCP/resource/subagent, same-account resume/fork, required integration failure | Pending both platforms; standalone 0.166 feature baseline passed Linux (`base-f166`, 5.57 seconds) |
| `privacy-macos-doctor-audit.py --aim-root … --node …` | Positive desktop ID observations; protected diagnostics under overlapping cwd grants and HOME alias | Fixture extended; pending Mac |
| `codex-installer-contract.py` | Actual platform installation contract with synthetic nonexecuted images | Existing Linux pass retained; Mac pending |

The review found no reason to repeat unrelated unit tests or the 1,000-session capacity experiment solely because of this release change. Run focused checks after relevant changes, then the full suite once at final readiness.

## Additional required observations

1. **Account/environment isolation:** extend the built-in recorder for selection/projection-before-spawn barriers, existing A sessions while B selection/watch/status/usage/maintenance/logout executes, both HTTP and WebSocket, and two environments with distinct grants for the same underlying account. Preserve the existing copied-state/clone and Prime/Pi legacy-authority component tests. Actual native commit races need real native writes, not a JavaScript replacement labeled native.
2. **Continuation:** the current CLI driver always calls `aim codex run`. Add real `resume-fresh` and warned cross-account manual resume, asserting captured account/thread/session identities and carried history. Existing native same-account resume/fork is not this evidence.
3. **Routines:** the standalone `routine` phase bypasses AIM selection and is explicitly incompatible with `--aim-cli`. Exercise actual calendar/interval occurrences through worker, selection, receipt and handoff, including failure, overlap, restart and no replay. Do not run the old Claude-only `privacy-real-routine-check.mjs` unchanged: it still references retired proxy5.
4. **Collectors/metadata/remote control:** obtain working native collector positives and matching protected trigger/flush/shutdown/reload runs, plus a working independent configured collector. Current fixtures mostly disable collectors themselves. Add compaction/error/idle/exit/default-service metadata observations. Existing remote-control RPC refusals lack saved enabled rows and a successful mock enrollment/relay positive. Organization-cloud policy remains the approved gap.
5. **Native settings:** reuse the owned app-server driver with A/B views and a shared-home baseline for typed path families/precedence, TUI model/effort/permissions writes, malformed/deleted/read-only repair, and native edit/conflict/recovery. Existing synthetic grammar/crash tests remain useful; avoid duplicating them without new native observations.
6. **Nested workflows/lifetime:** exercise official protected Codex→Claude and Claude→Codex model/tool turns, the original sandboxed reviewer, same/different-account nesting and stock Chrome on both platforms. Synthetic image transitions and actual Linux Chrome already passed, but are not the entire official-client regression. The standalone lifetime phase records survivors; its exit code does not certify their approval/confinement. Judge vendor/helper owners separately from ordinary background tools and check a healthy sibling.
7. **Mac recovery and real service:** preserve the retained preboot helper/hash/backend until its pending synthetic transaction is resolved. Finish the corrected actual reboot fixture. After synthetic controls pass, use only the authorized sacrificial account, its existing route and original Chrome manual callback for real model/tool/MCP, refresh/usage, concurrency, resume and actual routine on each platform. No copied primary grants, normal accounts, replacement browser identity or challenge bypass.

The cold whole-branch source review is complete. Final acceptance review, PR publication and milestone 2 remain pending.

## Exact-pair Linux results after auth corrections

Candidate `d026f3e0fc847954196cf0731c8110d2629afe7b28325170cfc5edeb1d584156` contains the matched official 0.166 images, corrected database identity comparison and canonical native auth lock. `exec-8Bw731` passed built-in HTTP, WebSocket and one actual native refresh. `exec-VBJVLk` passed native-first/AIM-first successful responses, intermediate AIM persistence, old native refresh refusal after same-account re-login and logout, and an actual blocked FLOCK waiter on the canonical auth inode. The native response retains ordinary same-login semantics; AIM's stale byte CAS is separately observed.

Saved-worktree `Hqz7L8` and OSS inputs `Mw6Fa0` passed after removing order-dependence from the AIM database-identity comparison. Earlier exact-pair input/state/worktree/saved-input runs passed (`drkezkn8`, `IBvjuE`, `y0LjZ7`; input fixture ID retained in private component log). Small native settings `native-V83Pyq` passed relative paths, live toggles, native writes/reload and rejected-version preservation. The >300-root run timed out before initialization twice; it remains unaccepted while launch duration is measured separately. These are partial results, not final milestone readiness.
