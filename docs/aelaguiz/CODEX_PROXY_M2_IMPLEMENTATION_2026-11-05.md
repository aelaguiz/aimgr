# Codex proxy support: implementation and acceptance

The optional proxy implementation is under final native acceptance and cold review. The privacy-only foundation is published as [Keep Codex logins local and isolate private machine data, PR 14](https://github.com/aelaguiz/aimgr/pull/14). This change stacks on that branch.

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

All native execution below used the isolated Linux VM or rented Mac. All synthetic protocol tests used synthetic tokens. Only the assigned numeric TLS exit check could reach the existing external test route.

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

## Remaining acceptance before publication

Complete independently observed DNS and reachable IPv6 controls, Mac scheduled failure/no replay, route restart/reboot and Claude regressions. Finish Linux original-browser login after preserving pre-final-M1 fixture directories. Record the cold whole-change review, apply confirmed fixes, then publish the stacked PR with real command examples.

The independent paired reviewer uses Gemini 4 Argon at medium, conversation `10d4b670-a5fb-494f-9804-f79a1f4bdaa5`. Its corrections removed the VM-local Chrome dependency, first-login direct-route trap and physical-profile duplication. A separate cold reviewer checks final source, plan compliance and overbuilding.

Cold whole-source review found no overbuild or architecture blocker and two P2 status bugs: live status ignored a newer remembered assignment, and assignment contention could look like missing login. Both are corrected. Focused regression runs passed 13/13 on Linux (including real Redis) and 12/12 on Mac. Fatal owner evidence: Linux `proxy-KRWVfY`, Mac `proxy-hC9XLl`; each also proves explicit new launch after repair.

Native wrong-exit evidence superseding the earlier JS-mismatch-only admission check: Linux `proxy-zGtNKB`, Mac `proxy-VxLwdb`. Composition: Linux `proxy-4LhPxq`, Mac `proxy-0uePAN`; synthetic native OAuth refresh uses the assigned hostname route, required MCP initializes/lists tools, and ordinary shell reads its synthetic private file and actual OS release. Structured receipts on both hosts confirm raw IPv4 used the route. The first IPv6 request returned URLError; that does not establish enforcement because the host had no route. A reachable direct-control fixture is being added. Independent DNS observation remains outstanding. The composition fixture initially omitted chatgpt_user_id; stock Codex treats refresh of incomplete identity as an owner change, making application policy unavailable. Adding the normal synthetic identity field fixed the fixture, with no product or vendor-policy change.


The final JavaScript suite enumerated 1,036 tests per platform. Linux passed 991, skipped 19 and failed 26 because the copied test checkout had group-writable entry directories and native tests left a /tmp/.git placeholder. Correcting only the test checkout modes and running the four affected files with an isolated TMPDIR passed all 103 tests, covering all 26 prior failures. Thus 1,017 distinct enabled tests pass, with 19 skipped. Mac passed 1,010, skipped 16 and failed 10 because the SSH runner PATH omitted Node for child shebangs. Correcting that runner PATH and repeating the three affected files passed all 11 tests: all 1,020 distinct enabled tests pass, with 16 skipped. Unaffected passing tests were not rerun.

Fresh Mac remote authorization completed through the original local proxy6 Chrome profile; URL release and navigation both passed product browser validation, and only the Mac stored the resulting grant. Evidence: real-proxy6/m2-login-1793892383. Linux's old fixture contained generated skills/plugins directories created before M1 commit ed7ec87 linked every classified shared directory. Their contents were preserved by moving them into their empty shared destinations; prepareCodexAccountState then passed without changing product isolation.

Linux's strengthened real systemd failure fixture passed at /opt/aimgr-state-audit/rt166-m2-proxy-routine-1793893556. Both before-spawn and mid-turn failures retain byte-identical receipts after at least two actual post-restart scheduler firings and have no TUI handoff. The next distinct occurrence completes and opens its same-thread TUI. Cleanup tolerates only already-collected transient systemd units.


Fresh Linux authorization also passed: real-proxy6/m2-login-1793893827. No primary grant or auth.json was copied between hosts.

The strengthened scheduler fixture also passed on Mac at /opt/aimgr-state-audit/rt166-m2-proxy-routine-1793894171. The first Mac fixture had a launchd plist ownership/location error; the next calendar attempts used GMT while launchd retained its boot-time GMT-8 calendar behavior. Reusing the successful M1 fixture's timezone made actual calendar and interval firings pass. Product scheduling was unchanged.

Linux's reachable IPv6 positive control and independent packet capture passed at codex-m1-private/m2-dns-ipv6-1793893924 (native root proxy-eySCCv). An unprotected IPv6 request reaches the control listener; protected IPv4 and IPv6 requests instead reach the assigned SOCKS proof origin. Packet capture sees its synthetic DNS control and no model-a/model-b hostname lookup outside SOCKS during native refresh, MCP and tool execution.

The cold reviewer accepts composed independent-routine evidence: Codex scheduled failure/no replay plus Codex A/B route lifetime tests plus current Claude shared-scheduler concurrency. It closed both scheduler assertion findings and found no remaining production issue. The older Claude native-route.test.js fixture fails current artifact admission because it launches an arbitrary synthetic executable; it is not counted as passing. Current Claude regression uses the existing integrated, routed, protected default-services fixture with the approved real binary, preserving production privacy admission. Its referenced installer and SOCKS helper point to this exact M2 source during the run.
