# Claude detached-session implementation evidence

The implementation passes the scoped Linux and macOS acceptance tests. AIM refuses new detached conversations and daemon-management intent, including dispatch into an existing old-path supervisor. Ordinary tools, asynchronous general-purpose Agent, skills, MCP, concurrent sessions, history and scheduled work remain functional. This is the evidence for the [implementation plan](../../CLAUDE_DETACHED_SESSION_REMOVAL_PLAN_2026-11-02.md); the earlier background research was not used as a substitute for testing the implementation.

## Build and test boundary

Production/test source: `1e43725db6e4a6117a3df95c599eb7dc77bef243`. Both offsite checkouts matched all 297 files in the executable source/fixture scope: [source-match.json](source-match.json). Later commits add documentation and receipts only. The reviewed vendor is unmodified Claude Code **2.1.316**, commit `cd7ceb459c68`.

| Platform | Vendor SHA-256 | Final tested artifact set |
| --- | --- | --- |
| Linux x64, designated GCP VM | `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824` | `c04048c95eb289cbdda8f79a35d055ca036e9fd17251c16ca48c21942b0ca1c7` |
| macOS 26.7 arm64, disposable rented AWS Mac | `64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f` | `8b96ed47d1c11f3188306bd65d9ef63fa5a7e183d425ca15392c4a366c1449e6` |

The final C source rebuilt to the exact tested launcher bytes on each platform: [Linux](linux-rebuild.json), [Mac](mac-rebuild.json). Linux observations before the directory-grant correction identify the preceding artifact `67430530332b2a0ec10b106ca00bd767a1ed54de5331ba6b766720448d576038`; the replacement rows below identify which tests used the final artifact. The unchanged native settings validator and managed-policy matrix were also exercised before that directory-only correction.

All native execution occurred offsite. Synthetic accounts, credentials, requests and deterministic model/tool responses exercised the real unmodified vendor, AIM runner, kernel containment and installed route. Independent outbound denial prevented contact with real vendor services. Protected tests traversed the actual native route, with distinct loopback source addresses for synthetic accounts. Ordinary Linux tests used a private network/PID namespace. No personal Claude account, sacrificial real account, browser or physical Mac was needed for these tests.

These are native integration tests against a controlled server, not a claim of a fresh live Anthropic sign-in or production model conversation. Calendar tests used real OS timers and real Redis; their receipts identify the substituted Herdr UI and print-mode calendar worker. A separate actual interactive terminal run tested follow-up, restoration and native scheduled wakeup. Installer tests use synthetic bundles/processes to exercise privileged publication contracts without granting normal-use approval.

## Requirement-to-evidence map

The JSON files preserve initial failures alongside their passing replacements. Do not treat every historical row as a pass. All final acceptance rows named here exited zero and completed their asserted synthetic workflow.

| Requirement | Linux acceptance | Mac acceptance |
| --- | --- | --- |
| Existing old-path daemon cannot receive a new AIM detached job; fresh daemon cannot start through AIM | `detached-owner-v8` | `detached-owner-v8` |
| Disabled default agent view and `/background` stay disabled through live settings/app-state edits; unrelated live setting applies | `detached-live-ordinary-v2`; `detached-directory-fixed-v1` protected terminal case | `detached-live-ordinary-v1`; `detached-schedules-v3` protected terminal case |
| Read/Bash, ordinary background Bash, asynchronous general-purpose Agent, skills, instructions, memory, history/resume/CLI fork, stdio MCP and overlapping sessions | `detached-ordinary-v1`; `detached-directory-fixed-v1` protected workflow | `detached-ordinary-v1`; `detached-protected-v1` protected workflow |
| Actual calendar start, completion, duplicate suppression, Redis lease release; interactive follow-up and native wakeup | `detached-final-regressions-v1` schedules | `detached-schedules-v3` schedules |
| Scheduled proxy-down, unknown build, missing policy and auth-refresh refusals, no replay, next occurrence works | `detached-final-regressions-v1` schedule refusals | `detached-protected-v1` schedule refusals |
| A1/A2/B overlap, native/HTTP nested AIM, account identities and routes, live outage affects only failed route, startup fails loudly, explicit repair | `detached-final-regressions-v1` concurrency | `detached-protected-v1` concurrency |
| HTTP MCP tools/resources, OAuth initial callback/refresh, package dependencies and native development | `detached-final-regressions-v1` HTTP MCP and compatibility | `detached-protected-v1` HTTP MCP and compatibility |
| Actual vendor pause/resume/forced exit, terminal restored while AIM still alive, cancellation before vendor startup | `detached-final-regressions-v1` controls | `detached-controls-v2` |
| Remote-policy cache expiry and ordinary update boundary | `detached-ordinary-v1` | `detached-ordinary-v1` |
| Native schema validation and conflicting managed settings, including environment-key case | `linux-components.json` | `mac-components.json` |
| Safe selector publication and account/session transition contracts | 21 installer cases; shared five portable activation tests | 19 installer cases; shared five portable activation tests |
| Exact granted Linux directory is readable; parent, sibling and update directory/files remain denied | Six actual kernel-open assertions in `local-checks.json`, then protected native skills workflow | Not applicable |

Full observations: [Linux native](linux-native.json), [Mac native](mac-native.json), [Linux component checks](linux-components.json), [Mac component checks](mac-components.json), [local/focused checks](local-checks.json).

The owner test deliberately contains **enabled raw-vendor positive controls**. Its aggregate request counts, telemetry and exact-kernel observations include those controls; they do not describe the protected AIM negative cases. The per-step assertions establish that refused AIM calls add zero model requests and leave the pre-existing owner alive. The fresh-namespace control first proves a supervisor can start, stops that exact disposable process, then tests both real AIM runner APIs with conflicting user settings. This prevents “a daemon already existed” from masquerading as proof that a new daemon could not start.

Native-source review covers UI-only automatic callers: default view, prewarming, foreground exit/handoff, left-arrow navigation, `/background`, `/fork`, and existing detached-session resume. These paths consult the admitted agent-view flag after the immutable snapshot loads. The CLI eager parser is different: its original arguments must be checked before AIM prefixes hook/settings arguments. Focused tests preserve literal prompts and option values such as `-p daemon`; they reject actual native intent, short clusters and subcommand-boundary cases.

## Findings resolved during implementation

1. **Original arguments could lose their native meaning after AIM prepended settings.** Admission now runs on the original interactive and noninteractive runner arguments, as well as the final composed launch. Exact eager-parser cases were checked in both vendor binaries. The final 49 settings/runner/handoff tests pass, and both owner-v8 native tests exercise hook-prefixed interactive calls.
2. **Linux shared personal skills were blocked by the exact directory permission.** A policy query claimed access while the kernel rejected enumeration of the directory itself. The production emitter now grants the selected root directory plus its contents; parent/sibling and update paths remain denied. The real kernel check and the full protected native workflow pass with the final Linux artifact.
3. **Mac process roles were unreadable with an oversized sysctl buffer.** `KERN_PROCARGS2` requires a buffer no larger than the OS argument limit. The bounded OS-sized buffer now recognizes real supervisors/workers in the native positive control; uncertain roles remain unknown.
4. **The native environment pin is not an independent defense against deliberately bypassing AIM.** Raw `--bg`/`daemon run` can reload disk environment before the pin is consulted. The implemented guarantee combines supported AIM argument admission, the immutable flag snapshot and the startup environment. Failed raw-pin-only experiments were rejected as a basis for approval. No new malicious-tool defense was added to the user's accepted scope.
5. **Two fixtures made platform assumptions.** The controls test assumed the vendor was a direct Mac child; it now verifies the actual kernel executable inside the supervised tree on either OS. The rented Mac initially had Node in UTC while launchd retained Pacific; aligning the disposable host's timezone made the real calendar fire. The scheduler implementation was unchanged. Final Linux calendar start was 17:09:01.744 UTC for 17:09:00; the Mac replacement fired at 16:30:01.087 UTC for 16:30:00.
6. **Test setup and receipt reading needed correction.** Initial suite failures came from an omitted README and a group-writable test checkout; all 26 failing tests passed in affected-file reruns after setup correction. A JSONL reader now waits for complete appended lines, without suppressing malformed complete records. Early fresh-owner experiments used the wrong managed-home fixture; final owner-v8 uses a real fresh managed account and temporary namespace with a working positive control. One intermediate diagnostic workflow failed closed on noncanonical-path admission; it was not counted as acceptance, and the subsequent full workflow passes are retained.

The repository suite ran once: 812 total, initially 775 passed, 26 failed from the two checkout setup errors, 11 skipped. Corrected affected-file reruns passed 98 tests, covering all initial failures. Final changed settings/runner/handoff checks passed 49 tests; final status/activation checks passed 13. This is not represented as a single all-green suite invocation. The skipped suite tests are not substituted for the required native tests above.

## Reproduction

On a prepared offsite host, use the installed test-only artifact and the repository's `scripts/privacy-claude-default-services-probe.py`. Its CLI accepts `--root <new-disposable-directory> --claude <artifact>/claude --integrated-aim --node <node> --privacy-mode ordinary|protected --case <case>`. Protected cases additionally require `--routed-aim`; ordinary Linux cases run inside the private network/PID namespace with loopback enabled. The existing test-host authorization and independent outbound denial are prerequisites, not optional flags. Do not run enabled baseline cases on a personal machine or against real credentials.

The cases are `ordinary-pro-detached-disabled`, `ordinary-pro-detached-terminal-disabled`, `ordinary-pro-workflows-disabled`, `ordinary-pro-stale-cached-policy-disabled`, `ordinary-pro-update-boundary-disabled`, and their listed protected counterparts. The protected-only matrix adds `protected-pro-schedules-disabled`, `protected-pro-schedules-refusals-disabled`, `protected-pro-compatibility-disabled`, `protected-pro-concurrency-disabled`, `protected-pro-controls-disabled`, and `protected-pro-http-mcp-disabled`.

For a direct before/after of ownership, `scripts/privacy-claude-detached-check.mjs` uses the same reviewed 2.1.316 bytes at a copied old pathname: start `daemon run`, dispatch `--bg` from both old and candidate vendor paths, and observe old-image daemon children making the requests. With source `1e43725`, the actual interactive/noninteractive AIM calls refuse the corresponding detached/management arguments with no additional model request. A literal `-p daemon` remains an ordinary successful prompt. The native enabled control is explicit; it is not presented as a screenshot of a historical AIM build.

For the Linux directory regression, `scripts/privacy-linux-directory-check.py` compiles the production emitter and loads a disposable profile. The previous emitter (`674305...` artifact) denied the granted directory's enumeration; the final emitter (`c04048...`) permits it and its file while denying the parent, private sibling and update directory/file. The protected native skills test supplies the user-workflow confirmation.

## Retention, review and cleanup

Both complete artifact archives were retained on the persistent offsite VM and freshly retrieved to restricted local bundle storage. Every inventory file's size, mode and digest and the complete artifact digest were checked after retrieval: [bundle-retrieval.json](bundle-retrieval.json). This addresses the earlier missing-bundle installation failure. These are test-only bundles; evidence is not normal-use approval or personal activation.

Independent final review and resource-cleanup receipts are recorded alongside this report. No personal session was signaled or resumed, and the personal machine's default launcher was not changed. The [visual guide](https://share.fun.country/20261102-ai-manager-claude-detached-session-checks-63658cbba206/index.html) contains actual CLI screenshots and clearly labeled native-test/installer receipts, with synthetic state only.
