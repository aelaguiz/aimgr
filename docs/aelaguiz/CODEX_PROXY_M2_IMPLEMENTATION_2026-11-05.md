# Codex proxy support: implementation and acceptance

The optional proxy implementation and isolated Linux/macOS acceptance are complete. Cold source and scope review found no remaining actionable defect or overbuild. The privacy-only foundation is published as [Keep Codex logins local and isolate private machine data, PR 14](https://github.com/aelaguiz/aimgr/pull/14). This change stacks on that branch.

The governing design and complete test cases remain in [the approved privacy and proxy plan, section 5 and N01–N10](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md#5-milestone-2-implementation-design). This record tracks implementation evidence; it does not add requirements.

## What changed

An enrolled account uses its assigned route for AIM's HTTP requests and unchanged native Codex. Assignment stays attached to the underlying account and local environment. An active invocation holds its account lock through native exit and routine handoff; idle account A may change its assignment while account B keeps using their shared physical route.

The existing Linux cgroup/nftables and Mac GID/PF/sing-box services enforce native traffic. Their optional loopback HTTP inbound lets the unchanged Codex HTTP and WebSocket clients send destination hostnames to the assigned SOCKS route. Codex invocation settings disable system proxy discovery and fallback only for enrolled work. Shared settings, MCP settings and the M1 environment descriptor retain their existing owners.

`aim codex login --proxy` selects the route before a first authorization has an account ID. After token exchange identifies the account, the command locks it, rejects conflicting or newer remembered assignments, atomically creates matching routing metadata, and saves the local login. Original-host browser validation surrounds the existing private remote callback handoff. No browser or primary credential is copied.

Current service health is read separately from cached usage. A dead service cannot remain healthy merely because its last usage request succeeded. An origin 401, 429 or 503 remains an application response; route failures remain route failures.

## Compatibility decisions

- Existing physical `claudeProxyProfiles` are reusable, with optional per-name `codexProxyProfiles` overrides. Provider credential and binding keys remain separate.
- The browser host requires its existing SOCKS/CDP/profile configuration. The CLI host separately requires the native HTTP inbound.
- Initial M1-to-M2 enrollment follows completion of affected older invocations and replacement of their old launch sources. New invocations provide lifetime locking. No recurring process inventory or global assignment stop gate was added.
- Linux now preserves active sessions through transient connection loss, matching the existing Mac behavior. The 60-second retry window starts after the first failed probe. Detection and termination add time.
- No Codex fork, new routing daemon, HTTP worker, DNS service, browser service, credential service or machine-wide proxy was introduced.

## Completed isolated-machine evidence

All native execution below used the isolated Linux VM or rented Mac. All synthetic protocol tests used synthetic tokens; within those fixtures, only the assigned numeric TLS exit check could reach the existing external test route. The separately documented real authorizations contacted the provider through the authorized account route.

| Behavior | Linux | Mac |
| --- | --- | --- |
| Native route entry, vendor-held account lock, release at exit | Passed | Passed |
| Effective proxy settings despite conflicting CLI overrides | Passed | Passed |
| Live relative shared settings and MCP settings | Passed | Passed |
| Two active accounts on separate routes | Passed | Passed |
| 5-second and 30-second outages preserve active work; new admissions wait | Passed | Passed |
| Persistent outage terminates only affected work | 75.142 seconds | 75.858 seconds |
| Repair does not replay work during the next 15 seconds | Passed | Passed |
| Native model HTTP and WebSocket through SOCKS destination hostname | Passed | Passed |
| Proxy-owner death stops A, preserves B, refuses new A, repair never replays | 113 ms termination | 251 ms termination |
| Wrong exit stops A; matching authored/installed settings reach native admission and refuse new A | Passed | Passed |
| Native primary refresh, required MCP, ordinary tool private-file/OS access under routing | Passed | Passed |

The measured persistent-outage intervals exceed the plan author's former 75-second estimate. Cold review found that estimate omitted probe and termination overhead; the plan now describes the actual timer semantics. These two measurements do not establish a hard upper bound.

Focused command tests cover first and existing login, conflicting explicit assignment, busy account, metadata conflict, wrong identity, route loss, remembered newer binding, invalidation tombstone and an original browser configuration without an HTTP port. The real Redis test checks atomic assignment metadata and verifies that legacy primary credentials never cross the projection boundary.

Private native evidence roots:

- Linux native entry: `/opt/aimgr-state-audit/codex-m1-fixtures/native-bVXgrQ`.
- Mac native entry: `/opt/aimgr-state-audit/codex-m1-fixtures/native-5E3l4a`.
- Linux outage matrix: `/opt/aimgr-state-audit/codex-m1-fixtures/proxy-th8uuA`.
- Mac outage matrix: `/opt/aimgr-state-audit/codex-m1-fixtures/proxy-vHiqpa`.
- Linux model HTTP/WebSocket: `/opt/aimgr-state-audit/codex-m1-fixtures/proxy-NsMBI3`.
- Mac model HTTP/WebSocket: `/opt/aimgr-state-audit/codex-m1-fixtures/proxy-4k6iq3`.

The first protocol fixture kept exec stdin open; it was corrected to use the existing native exec fixture's closed stdin. Linux then rejected the synthetic CA certificate used as the server certificate. A separate signed server certificate fixed the fixture. Product TLS verification was not weakened.

## Review and publication

DNS/IPv6, both real logins, both scheduled-failure fixtures, current Claude regression on both platforms, actual reboot recovery, command captures and whole-source cold review are complete. This record accompanies the stacked proxy PR.

The independent paired reviewer uses Gemini 4 Argon at medium, conversation `10d4b670-a5fb-494f-9804-f79a1f4bdaa5`. Its corrections removed the VM-local Chrome dependency, first-login direct-route trap and physical-profile duplication. A separate cold reviewer checks final source, plan compliance and overbuilding.

Cold whole-source review found no overbuild or architecture blocker and two P2 status bugs: live status ignored a newer remembered assignment, and assignment contention could look like missing login. Both are corrected. Focused regression runs passed 13/13 on Linux (including real Redis) and 12/12 on Mac. Fatal owner evidence: Linux `proxy-KRWVfY`, Mac `proxy-hC9XLl`; each also proves explicit new launch after repair.

Native wrong-exit evidence superseding the earlier JS-mismatch-only admission check: Linux `proxy-zGtNKB`, Mac `proxy-VxLwdb`. Composition: Linux `proxy-4LhPxq`, Mac `proxy-0uePAN`; synthetic native OAuth refresh uses the assigned hostname route, required MCP initializes/lists tools, and ordinary shell reads its synthetic private file and actual OS release. Structured receipts on both hosts confirm raw IPv4 used the route. The first IPv6 request returned URLError and was not counted as enforcement evidence; the reachable direct controls and independent DNS captures described below supersede it. The composition fixture initially omitted chatgpt_user_id; stock Codex treats refresh of incomplete identity as an owner change, making application policy unavailable. Adding the normal synthetic identity field fixed the fixture, with no product or vendor-policy change.


The final JavaScript suite enumerated 1,036 tests per platform. Linux passed 991, skipped 19 and failed 26 because the copied test checkout had group-writable entry directories and native tests left a /tmp/.git placeholder. Correcting only the test checkout modes and running the four affected files with an isolated TMPDIR passed all 103 tests, covering all 26 prior failures. Thus 1,017 distinct enabled tests pass, with 19 skipped. Mac passed 1,010, skipped 16 and failed 10 because the SSH runner PATH omitted Node for child shebangs. Correcting that runner PATH and repeating the three affected files passed all 11 tests: all 1,020 distinct enabled tests pass, with 16 skipped. Unaffected passing tests were not rerun.

Fresh Mac remote authorization completed through the original local proxy6 Chrome profile; URL release and navigation both passed product browser validation, and only the Mac stored the resulting grant. Evidence: real-proxy6/m2-login-1793892383. Linux's old fixture contained generated skills/plugins directories created before M1 commit ed7ec87 linked every classified shared directory. Their contents were preserved by moving them into their empty shared destinations; prepareCodexAccountState then passed without changing product isolation.

Linux's strengthened real systemd failure fixture passed at /opt/aimgr-state-audit/rt166-m2-proxy-routine-1793893556. Both before-spawn and mid-turn failures retain byte-identical receipts after at least two actual post-restart scheduler firings and have no TUI handoff. The next distinct occurrence completes and opens its same-thread TUI. Cleanup tolerates only already-collected transient systemd units.


Fresh Linux authorization also passed: real-proxy6/m2-login-1793893827. No primary grant or auth.json was copied between hosts.

The strengthened scheduler fixture also passed on Mac at /opt/aimgr-state-audit/rt166-m2-proxy-routine-1793894171. The first Mac fixture had a launchd plist ownership/location error; the next calendar attempts used GMT while launchd retained its boot-time GMT-8 calendar behavior. Reusing the successful M1 fixture's timezone made actual calendar and interval firings pass. Product scheduling was unchanged.

Linux's reachable IPv6 positive control and independent packet capture passed at codex-m1-private/m2-dns-ipv6-1793893924 (native root proxy-eySCCv). An unprotected IPv6 request reaches the control listener; protected IPv4 and IPv6 requests instead reach the assigned SOCKS proof origin. Packet capture sees its synthetic DNS control and no model-a/model-b hostname lookup outside SOCKS during native refresh, MCP and tool execution.

The cold reviewer accepts composed independent-routine evidence: Codex scheduled failure/no replay plus Codex A/B route lifetime tests plus current Claude shared-scheduler concurrency. It closed both scheduler assertion findings and found no remaining production issue. The older Claude native-route.test.js fixture fails current artifact admission because it launches an arbitrary synthetic executable; it is not counted as passing. Current Claude regression uses the existing integrated, routed, protected default-services fixture with the approved real binary, preserving production privacy admission. Its referenced installer and SOCKS helper point to this exact M2 source during the run.

Mac reachable IPv6 and independent DNS capture also passed at `codex-m1-private/m2-dns-ipv6-1793894423` (native root `proxy-y6QXqM`). Both platforms demonstrate a reachable unprotected IPv6 control and assigned-route responses for protected IPv4 and IPv6.

The complete cold source review covered all 61 files in `f00918c..014d507`, including every new source, fixture and document. It found no remaining actionable source issue, no scope creep and no cut list. It identified outstanding Mac Claude and reboot acceptance as evidence gaps, not diagnosed product bugs.

Current Linux Claude regression passed using the approved native binary and actual route: workflows at `m2-current-1793894388`, and controls/concurrency/overlapping routine at `m2-current-1793894687`, under `/opt/aimgr-state-audit/claude-implementation`. These cover Bash, hooks, instructions, external imports, resume/fork, stdio MCP, personal skills, subagents, background work, same-account concurrency, independent accounts, route failure, no replay, explicit recovery, scheduled work, pause/resume, hard kill and terminal restoration. The first fixture attempts lacked Redis and pointed controls at a different executable path; correcting only the fixture prerequisites produced passing receipts.

Current Mac Claude concurrency passed at `m2-current-1793895469`, including real Redis, A1/A2/B overlap, nested native and HTTP work, same-account leases, route isolation, 130 ms affected-session termination, no replay and explicit recovery. Workflows passed at `m2-current-1793895544`, including ordinary Bash, hooks, instructions/imports, resume/fork, MCP, skills, subagents, background work and same-account concurrent tools. Overlap and controls passed at `m2-current-1793895612`: required MCP/skill and an actual routine alongside A1/A2/B, pause/resume, hard kill, preflight cancellation and terminal restoration. The first combined Mac run completed ordinary workflow turns, then stalled at concurrent launches and later cases failed. Its cause remains unknown. Individual reruns used unchanged product and probe behavior, with only timed thread-stack diagnostics added; successful stacks showed normal selector waits. The failed combined run is not counted as passing. Cold review accepts these receipts as closing N10 and requests no additional fixture or product protection.

Existing separate Chrome A/B binding, first request and redirects, cookie separation, wrong binding, tunnel loss, independent B, repair and owned-tab cleanup passed on Linux with `AIMGR_TEST_CHROME=1 AIMGR_TEST_CHROME_BROWSER_ONLY=1 node --test test/network/claude-chrome.test.js`. This explicitly selects the browser checks and excludes the old arbitrary-executable Claude login fixture, which fails current artifact admission. Real Codex authorization is separately proven on both hosts above.

Mac reboot recovery passed: the actual boot time changed, the installed assignment manifest and four saved login/routine files stayed byte-identical, the route service recovered after its external test forward was restored, and a fresh protected native `codex --version` succeeded using the existing local authorization. Evidence: `codex-m1-private/m2-reboot/{before,native-after}.json`.

Actual CLI before/after capture on isolated Linux uses synthetic account/usage and real service start/stop. M1 `f00918c` reports ready after the service stops; M2 `014d507` reports proxy_down with cached usage and rejects native entry with exit 125. Assignment set/show and active-account exclusion also passed. Private capture: `codex-m1-private/m2-pr-evidence-yjL8MH/cli-captures.json`; [public command walkthrough with synthetic account data](https://share.fun.country/20261105-codex-account-proxies-actual-cli-checks-f4d72cb0c476/index.html).

Linux recovery also passed. The normal shutdown hung in `google-shutdown-scripts.service/stop`; a Compute Engine reset of the same disposable VM completed the actual reboot. The new boot retained the manifest and eight login/owner/grant/routine files byte-for-byte. The enabled route had started before its external SSH tunnel and failed closed; native entry refused with exit 125. After restoring that tunnel and explicitly starting the existing service, a fresh protected native `codex --version` succeeded with the same local authorization. No failed occurrence replayed. Evidence: `codex-m1-private/m2-reboot/{before,after,native-after}.json`; the shutdown log is retained privately. This establishes recovery and native admission, not a post-reboot model request.

Final validation: `npm run lint`, browser-fixture syntax, and `git diff --check` pass. The browser-only fixture selection and acceptance record were cold reviewed. A final merge of main 93db27e preserves its account-plan display and Claude pool exclusions while retaining environment-local Codex status and proxy health/version checks. Focused integration tests pass 52/52 on each platform for M1 and 65/65 on each platform for M2. Cold review found no issue in either merge resolution; no native source changed. The old Mac host is confirmed released; the replacement guest termination and host-release schedules remain enabled.

Published stack: [privacy and local login PR 14](https://github.com/aelaguiz/aimgr/pull/14), then [account proxy PR 15](https://github.com/aelaguiz/aimgr/pull/15).
