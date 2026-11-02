# Codex without the shared daemon: offsite workflow tests

2026-11-01. **The offsite Linux and Mac tests support removing Codex's shared daemon while retaining the tested skills, MCP, concurrent interactive sessions, subagents and history. Mac metadata restrictions also removed the actual OS version from captured model requests without breaking those workflows. Abrupt-owner cleanup failed on Mac: a background test command survived SIGKILL of its owning Codex process.** The implementation must address that cleanup, coordinate initial database migration and include the official code-mode helper in the approved package. None requires limiting active sessions. Linux scheduled-turn handoff and both baseline/restricted Mac interval-triggered native turns and handoffs passed. Mac calendar triggers did not fire in two baseline attempts, so calendar compatibility remains unverified.

This is the follow-up to the [feature decisions in the Codex privacy plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md#1-requirements-assumptions-and-exclusions) and the [native isolation investigation](PRIVACY_SANDBOX_FEASIBILITY_2026-11-01.md). It tests the revised workflow with official binaries. It does not implement the production privacy launcher, approve a build for ordinary use, or close the plan's relative-settings and secret-migration requirements.

## What ran

All client execution took place on the designated GCP test VM or the replacement rented AWS Mac. Linux used a fresh loopback-only network namespace. The Mac's externally verified egress policy allowed only SSH to the two established proxy destinations, with no provider HTTPS route; these tests used no tunnel. Both used synthetic homes and credentials, a local model endpoint, and local stdio/HTTP MCP servers. No physical Mac, real account, browser, home-IP sign-in or personal account store was used. No human-verification challenge occurred.

The official candidate was Codex **0.163.0-alpha.5**, using the current `gpt-6.1-sol` protocol against a mock model. The model fixture selected tools; the actual Codex binary loaded the skill, executed the tools, spawned its subagent, wrote its native history and rendered its terminal. No Codex source or binary was modified.

| Artifact | Linux SHA-256 | Mac SHA-256 |
| --- | --- | --- |
| `codex` | `1f389f19de064430a227a50af2bfa627699be4c600f1a37c114039fdd027b75b` | `956f2edd38050f8fa55fac9ecfc570dc37c85d48019800dacee4cfcf9c70e9d1` |
| `codex-code-mode-host` | `d01f7a656bd2a54b26fd99131f252c7371e2e890f3713c5dd977676b54bfb3bf` | `506223f47bf53603026ff6c15f887196a5daabccde036e555cdae4875e4871b0` |

Within each platform, both came from the same previously integrity-verified official npm package. The [research harness](../../scripts/privacy-codex-standalone-audit.py) checks exact candidate hashes before executing them. That fixture check is not the immutable production execution boundary required by the plan.

## Findings that change the implementation

**Simultaneous database creation needs coordination.** Two TUIs starting together in one fresh home raced in native SQLite migration 22. One exited with `duplicate column name: agent_path` and the native damaged-database error; the other session and the separate-home session continued. The failed test is retained in [the fresh-start evidence](evidence/privacy-standalone-2026-11-01/linux-fresh-concurrent-failure.json).

The paired experiment initialized each fresh database with the official `app-server --listen stdio://` process, waited for its initialize response, closed stdin and verified process exit. All three subsequent TUIs reached the model barrier together and completed their tools. No shared daemon remained. This establishes a compatible setup mechanism for this fresh-store case. The implementation still needs a bounded setup lock keyed to the effective shared database, migration/recovery tests, and integration with the approved-version transition. It must release that lock before normal session work. [Concurrent interactive evidence](evidence/privacy-standalone-2026-11-01/linux-interactive-concurrent.json)

A further case supplied one shared `CODEX_SQLITE_HOME` to the separate A/B homes. After finite native preparation, all three TUIs again completed concurrently while the homes retained distinct installation IDs. A read-only disk check found all three resulting thread IDs in that shared state database and no per-home state database fallback. This covers the proposed shared-database setting for fresh fixtures; it does not migrate existing history or credentials. [Shared-database evidence](evidence/privacy-standalone-2026-11-01/linux-shared-database.json)

**The main executable alone is an incomplete package.** Initial current-model tool calls failed because `codex-code-mode-host` was missing. Installing the matching official helper restored actual skill/MCP/shell execution. Version approval and containment must include that helper and any required vendor resources. An approved main binary with an unknown or missing helper must fail before a session begins. The plan now names this dependency explicitly.

**Mac owner death leaves background work alive.** Both the baseline and metadata-restricted Mac runs observed the test heartbeat still running and writing after an owner-only SIGKILL, with the PTY master deliberately kept open. Normal Ctrl-C exit stopped it. Linux stopped the same command in both cases. The fixture subsequently cleaned up its surviving processes; that cleanup is not a passing native-lifecycle result. Reuse the existing native lifecycle enforcement to close this gap, and test sibling sessions and owner-death races. A main-process `finally` or shell trap cannot handle SIGKILL. The plan records this as an implementation blocker, without reintroducing a persistent Codex daemon.

The Mac required-MCP failure also left three live processes in the immediate pre-cleanup sample: Git's `ls-remote` check of `https://github.com/openai/plugins.git` and its two HTTP helpers. This was an automatically started plugin-repository check, not the failed MCP server. Its persistence duration was not measured before fixture cleanup. No provider request or successful GitHub transfer is established by that process inventory. GitHub disclosure is outside the agreed provider-only scope, but these children must still be included in failed-start lifecycle tests. Inventory unnecessary automatic plugin checks separately from package loading required for skills/MCP; do not disable required packages to remove an optional check.

## Retained workflow results

| Behavior | Linux observation |
| --- | --- |
| Concurrent sessions | Two native interactive sessions shared one synthetic home while a third used another. All three reached the same model barrier and completed. |
| Skills | Codex inserted the project skill's full content into the first actual model request, before the fixture requested a shell read of that file. |
| MCP tools | Actual stdio and HTTP echo calls returned their expected results. The HTTP server required a synthetic bearer token in the authenticated cases. |
| MCP resources | The native resource-reading tool returned the fixture resource. |
| Required MCP failure | A configured required server returned HTTP 503. Codex exited nonzero with an MCP error before a model turn. |
| Subagents | The native collaboration tool spawned a child, waited, and delivered the child's final answer to the parent. |
| Resume | Reopening without a prompt displayed the saved result without a new inference turn. A subsequent prompted resume retained the same thread. |
| Fork | The fork received a new thread ID and retained the seed response in its first model request. |
| Basic terminal input | Three concurrent TUIs accepted bracketed multiline paste containing Unicode, received a resize, completed their tools and exited through Ctrl-C. This is not a visual reflow or full Herdr test. |
| Scheduled execution | A systemd timer ran the real AIM `startCodexRoutineTurn` adapter with native `codex exec --json`. The native result completed, and TUI handoff restored that exact thread without replaying the prompt. |
| Owner exit | The heartbeat command stopped after normal exit and owner-only SIGKILL while the PTY master remained open. The final sampled descendant inventory, taken after PTY closure and before cleanup, found no live descendants. |
| Daemon attachment | With the native protected-socket layout, ordinary Codex reached the fake endpoint. The paired `--no-daemon` invocation made no connection and completed its skill/MCP/tools. |

Evidence: [combined workflow](evidence/privacy-standalone-2026-11-01/linux-final.json), [interactive concurrency](evidence/privacy-standalone-2026-11-01/linux-interactive-concurrent.json), [required-server failure](evidence/privacy-standalone-2026-11-01/linux-required-mcp-failure.json), [OS-scheduled native adapter and handoff](evidence/privacy-standalone-2026-11-01/linux-scheduled-handoff.json), [owner-only lifetime observation](evidence/privacy-standalone-2026-11-01/linux-owner-lifetime.json), [native daemon-discovery control](evidence/privacy-standalone-2026-11-01/linux-daemon-control.json).

The daemon positive control used Codex's actual protected directory and hashed socket target, with the advertised rendezvous symlink. It established that the official daemon-enabled client could discover that endpoint. It did not simulate a fully functioning daemon. The negative result proves the tested standalone entry point bypassed eligible discovery; it is not coverage of every future reentry or updater path.

The lifecycle experiment observed a particular native background command and sampled descendants. It does not establish cleanup of arbitrary detached software, subagents killed mid-turn, actual Herdr closure, or healthy-sibling behavior during a failure. No claim is made that work continues after the owning process exits.

## Mac comparison

The same official candidate ran on the rented Apple-silicon Mac with macOS 26.7. The baseline and restricted cases both completed actual skills, stdio and authenticated HTTP MCP tools, MCP resources, subagents, native exec, interactive TUI, same-thread resume and new-thread fork. Three interactive sessions also completed concurrently with a shared database, Unicode bracketed paste and resize input. Normal exit passed; the SIGKILL cleanup failure above occurred in both cases.

The paired request capture changed the OS portion of the actual User-Agent from `Mac OS 26.7.0; arm64` to `Mac OS Unknown; arm64`. The actual OS product version was absent from the restricted captured model protocol. OS family, architecture, Codex version and the generic `xterm-256color` capability label remained. Both sets already omitted terminal-app/version environment inputs; this is not a claim that the remaining terminal label is anonymous or that all hardware-derived data is hidden.

The restriction is a native Seatbelt metadata policy applied before starting the official binary, with signing-identifier filters covering `codex` and `codex-code-mode-host`. The helper's actual OpenAI signature identifier was checked. The policy targets selected IOKit/sysctl/version-file/host-query paths. It is **not** a complete personal-file allowlist, arbitrary tool restriction or production launcher. Earlier synthetic device-read experiments supply the bounded API evidence; these new requests demonstrate the OS-version result during the retained workflow.

Mac launchd interval timers ran the real AIM native-turn adapter in both baseline and restricted cases. Each produced a successful native result, exited with status zero and reopened the exact thread without replaying its prompt. The restricted case applied the same policy to both the scheduled command and handoff. This covers the adapter/process boundary, not account selection, Redis receipts, duplicate suppression or the actual AIM GUI-domain calendar installer.

Two system-domain calendar fixtures registered but recorded zero executions. The second allowed 49 seconds before the intended minute, so increasing registration lead time did not resolve it. The cause is unestablished; neither calendar event launched a scheduled Codex turn; both fixtures used no privacy policy. Preserve these failed fixtures and leave calendar compatibility open. Do not change users' calendar schedules to intervals as a workaround.

Evidence: [Mac baseline](evidence/privacy-standalone-2026-11-01/mac-base.json), [restricted workflow](evidence/privacy-standalone-2026-11-01/mac-policy.json), [restricted interactive concurrency](evidence/privacy-standalone-2026-11-01/mac-policy-term.json), [captured request metadata](evidence/privacy-standalone-2026-11-01/mac-request-metadata.json), [exact metadata policy](evidence/privacy-standalone-2026-11-01/mac-subject-policy.sb), [baseline interval job](evidence/privacy-standalone-2026-11-01/mac-interval.json), [restricted interval job](evidence/privacy-standalone-2026-11-01/mac-policy-interval.json), [calendar repeat failure](evidence/privacy-standalone-2026-11-01/mac-calendar-retry-failure.json), [failed-start survivor classification](evidence/privacy-standalone-2026-11-01/mac-required.json).

The native daemon-discovery positive/negative pair and required-MCP failure also passed on Mac: daemon-enabled Codex reached the eligible fake socket, explicit standalone selection did not, and a required HTTP MCP returning 503 caused a clear nonzero exit before model work.

## What still needs testing or design

- Required package-supplied skills/MCP, OAuth refresh and existing encrypted/keychain credential migration. The bearer-token fixture proves ordinary HTTP authentication, not OAuth migration.
- Full AIM scheduling with account selection, ChatGPT credentials, Redis receipts, duplicate/restart suppression, proxy failure and recovery. The new test covers the real native adapter and OS launch/handoff, not that full path.
- The SQLite setup lock in the product, shared/custom database paths, approved-version migration, interrupted migration and preserved existing history.
- Relative shared-config semantics, the final native filesystem boundary, all retained helper identity reads, immutable exact-build admission and update prevention.
- Actual multiplexer/Herdr use, visual terminal behavior, and owner failure while healthy independent sessions keep working. The observed Mac SIGKILL survivor needs a working cleanup mechanism before product acceptance.
- Full Mac calendar scheduling: two baseline system-domain calendar jobs registered but recorded zero executions, including a repeat with 49 seconds before the scheduled minute. The test has not established the cause. A launchd interval trigger passed; that is not calendar parity or the actual AIM GUI-domain installation. Both baseline and restricted interval handoffs passed. The complete filesystem/identity boundary remains separate from the now-tested selected metadata restrictions.

The captured protocol includes setup/prewarm and title-generation requests as well as actual inference turns. The harness distinguishes them when checking prompt replay. This is not a claim of zero provider requests while opening a session, and a mock model does not certify real account behavior.

## Fixture corrections and review

Failed exploratory fixtures are retained offsite. Corrections included synthetic native auth storage for TUI onboarding, replacing an obsolete test model, handling current-model tool definitions and WebSocket reuse, installing the complete official package, parsing native subagent messages, and waiting for initialization before closing stdio. None required a browser or account sign-in.

The cold reviewer rejected weak tests that could count a generated response as success, use an ineligible fake daemon socket, or close the terminal before checking child survival. The harness now asserts actual tool results, first-request skill loading, exact file contents, rendered final output, expected exit status, thread/history behavior and the simultaneous-start barrier. It tests native daemon discovery with an official-client positive control and keeps the PTY open during the heartbeat observation. The independent reviewer approved these bounded Linux research conclusions after clarifying that the final overall descendant inventory follows PTY closure. They found no hidden workflow removal and explicitly withheld full product and Mac acceptance.


The final independent review approved the bounded Linux and Mac conclusions, including both interval-triggered native turns and handoffs, the captured OS-version reduction and the retained concurrency/skills/MCP behavior. It verified the shared-database disk proof and matching harness/policy hashes. It required retaining both calendar failures and the two distinct Mac cleanup findings, and found no hidden workflow removal. This is research signoff, not full-plan/product acceptance or normal-use build approval.

## Evidence retention and cleanup

Sanitized assertions are linked above. Raw Mac captures, exact fixture scripts and the policy are archived on the designated GCP VM at `/home/aimdev/verification/privacy-standalone-20261101/mac-standalone-raw-evidence.tar.gz`, SHA-256 `814f261088060bb7847f6854ad9f553cc72bbc950519931f3544b1ef4f41c35b`. Linux raw fixtures and immutable script snapshots remain under `/opt/aimgr-state-audit` on that VM. These contain synthetic accounts only; raw thread identifiers are deliberately omitted from public exports.

The final rental inventory found no remaining vendor/plugin-check processes and no audit launchd jobs after fixture cleanup. The failed rental is terminated. Termination of the working replacement has been requested after archiving; automatic dedicated-host release remains scheduled for both after AWS's minimum allocation period. Disposable SSH key material and the task-only GCP SSH rule have been removed. Private cloud receipts remain in `~/.aws/aimgr-macos-test/standalone-audit-2026-11-01.json` and `standalone-recovery-2026-11-01.json`; no personal machine configuration changed.
