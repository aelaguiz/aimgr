# Claude 2.1.317 upgrade verification

Status: Linux and rented-Mac acceptance complete; independent final review approved the exact candidate. The reviewed 2.1.317 runtime and fixed AIM release are installed locally; ordinary, protected and automatic Opus local smoke checks all pass. Previous bundles and active sessions are preserved.

Amir requested: “after that get the latest binary tested and linked properly.” This authorizes installing the exact successfully tested and cold-reviewed candidate, with the existing privacy boundary and accepted workflow tradeoffs preserved. It does not authorize skipping a failing privacy check. Sam and Jordan's separate 2.1.316 enrollment is complete; their account records and original browsers are not upgrade fixtures.

## Privacy experiments and account identity

Amir clarified that the concern is testing behavior that could send dangerous or unexpected information to OpenAI or Anthropic, especially from a VM already associated with the proxy test accounts. The investigation must not expose or link his normal identity while discovering whether a privacy boundary works. Keep those experiments on the same sacrificial accounts and assigned proxies; a fresh home or an apparently harmless prompt does not erase the host's prior associations.

This candidate investigation uses established proxied accounts for real-service tests on the designated offsite hosts. Proxy5 was retired and its VM deleted; on November 3 Amir authorized proxy6 or any other existing proxied account. Live checks use proxy6, with distinct-account isolation/concurrency also tested against separate synthetic identities and routes. Ordinary-mode privacy experiments use synthetic credentials and mock services with external traffic blocked. Routine functionality checks of an already reviewed setup remain covered by existing permissions, including the previously authorized local ordinary-account check. The earlier blanket ban on all non-proxy testing was the agent's overinterpretation and is replaced by this clarification; it is not a user requirement.

## Candidate and baseline

Official release metadata was acquired through the established proxy6 route. Latest was 2.1.317, commit `3d3e7cb16b5577dccaee9520c8dc1189d02d61b7`, build time `2026-11-02T22:39:48Z`.

| Platform | Vendor SHA-256 | Bytes |
| --- | --- | --- |
| Linux x64 | `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0` | 331362672 |
| macOS arm64 | `09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9` | 312806400 |

Baseline is official 2.1.316 with the reviewed MCP executable-alias correction. Source starts at `119b9d5` on `claude-2-1-317-upgrade`. Candidate fixtures change only their fixed vendor version, commit and checksums initially; baseline fixtures remain in Git and in the retained offsite checkout. Both complete candidate bundles were built, tested, retained and freshly verified as recorded below. Final implementation source is `58ef2c04a906b302a9f69d5063d812efdbd316c5`; the retained Git archive SHA-256 is `9a888ffda2ecc8ec0e218d8154f07e68b4c127f0f57a6350e6e6a62d8aeefe17`. Native source is unchanged from the tested bundle build; the two later production fixes are in AIM JavaScript.

Execution uses the designated GCP Linux VM and an existing rented AWS Mac host reused after its scrub completed. Independent network denial precedes synthetic candidate execution. Real compatibility tests use authorized existing proxy accounts with their assigned routes, synthetic projects, separate test Redis, no TLS interception and no rental browser. Any actual human-verification challenge stops all work. No unapproved vendor execution occurs on a personal Mac.

## Agreement that the upgrade must preserve

The canonical [implementation plan](CLAUDE_PRIVACY_IMPLEMENTATION_PLAN_2026-11-01.md), [accepted decisions](AGENT_UPGRADE_TEST_SKILL_PLAN_2026-11-02.md) and later [detached-session decision](CLAUDE_DETACHED_SESSION_REMOVAL_PLAN_2026-11-02.md) remain authoritative. The target is automatic identifying collection and home-IP disclosure to Anthropic and its collectors. Normal task context, broad platform/architecture, existing browser footprint, malicious tools and independent third-party services are accepted. No redaction or new browser hardening is introduced.

Proxy routing remains optional per account and fails closed when configured. Ordinary accounts require no proxy. Exact Claude/helper approval remains mandatory; exact macOS releases are not gated. Remote Control, remote feature flags and updates remain disabled for all AIM Claude sessions; telemetry opt-out remains protected-account scoped. Custom headers are fixed at startup; extra folders outside initial grants need a new protected session. Individual Pro/Max accounts are the supported subscription types.

Keep skills, MCP including auth/package dependencies, native development, concurrent same/different-account work, history/resume/fork, trusted nested dispatch, ordinary background Bash and async local subagents, schedules and maintenance. Detached conversations/agent-view are disabled. Optional personal hooks/plugins, GUI/terminal extras and voice are not required.

## Evidence and acceptance tracking

Each row records retained evidence against the final composed artifact. Earlier-release receipts are baseline evidence, never candidate passes. Broken positive controls, timeouts and skipped native cases are not passes.

| Canonical requirement | Candidate evidence required | Linux | Mac |
| --- | --- | --- | --- |
| T01 Ordinary and protected accounts | Ordinary startup without routing infrastructure; protected route selection and no downgrade | Synthetic ordinary/protected and live proxy6 pass | Synthetic ordinary/protected and live proxy6 pass |
| T02 Admission before execution | Correct inventory/authorization; wrong bytes, extra helper, expired/wrong-host authorization refuse; OS release not gated | Pass: 54 admission/status checks | Filesystem admission and status checks pass |
| T03 Replacement and update races | Replacement races and native updater direct/interpreter execution denied; immutable selection and installer rollback | Native updater, immutable admission/entry race and installer contracts pass | Native updater, immutable replacement, snapshot aliases and installer checks pass |
| T04 Identity separation and migration | Stable same-account IDs, distinct cross-account state, migration/relogin/rename/handoff/refresh continuity | Synthetic distinct-account continuity and real proxy6 refresh/resume pass | Synthetic distinct-account continuity and real proxy6 refresh/resume pass |
| T05 Files and alternate reads | Positive baseline and denied unrelated reads, aliases/descriptors, native capability and enforcement failures | Paired Read/alias/device paths, capability, descriptors and enforcement refusal pass | Paired native files/device reads, descriptor closure and entry negatives pass |
| T06 Actual device/API/request capture | Independent device/OS/terminal/home-ID inputs; default/startup/idle/model/helper captures and alternate APIs | Protected captures and paired Linux device/metadata reads pass | Native captures/API denials pass; Foundation residual separately reviewed below |
| T07 Environment and descriptors | Required tool/MCP variables preserved; unrelated auth/descriptors not inherited or automatically collected | Required tool variables pass; actual vendor FD closure passes | Required tool/MCP variables and final vendor descriptor closure pass |
| T08 Telemetry positive control | Default startup/work/idle/failure collector controls; native settings/precedence/live-header and subscription tests | Native/default-service checks pass | Telemetry/error controls and live critical-setting/header reload pass |
| T09 Remote-control lifecycle | Eligible enabled Remote Control baseline; policy-specific refusal through standalone/flag/toggle/saved/restart paths | Enabled controls and policy refusal pass | Enabled controls and policy-specific refusal pass |
| T10 Route completeness | Native assigned exit, IPv4/IPv6/DNS and every native/AIM request owner | Assigned real/synthetic routes and IPv4/IPv6/system hostname resolution pass | Native IPv4/IPv6/system hostname and model routing pass |
| T11 Proxy down before startup | Separate tunnel/SOCKS/adapter/helper startup failures for manual/cached/scheduled calls; no vendor execution when refused | Synthetic startup/schedule and real proxy6 tunnel-down refusal pass | Synthetic startup/scheduled refusal and live proxy6 tunnel-down refusal pass |
| T12 Failure during work | Mid-turn/routine outage, bounded active stop, healthy sibling progress, explicit recovery without replay | Model outage plus tunnel/adapter/monitor failure and healthy sibling tests pass | Native model/raw outages, sibling isolation, admission loss and explicit recovery pass |
| T13 Original-browser sign-in | Original browser/assigned route preserved; synthetic first navigation/callback/relogin/wrong-account/tunnel-loss | Synthetic OAuth pass; original proxy6 browser configuration/exit preserved | Original configuration/exit preserved; live CDP unavailable; no new authentication needed |
| T14 Skills and MCP | Actual personal/project/package skills, stdio/HTTP MCP tools/resources/auth/package execution and visible dependency failure | Actual native synthetic skills/MCP and live proxy6 model/tools pass | Native stdio/HTTP/auth/package/alias MCP and skills pass |
| T15 Native development and terminal | Startup folders, live edits/Git/settings/native builds/basic terminal; same/different-account nested dispatch | Native tools and nested dispatch pass | Native development, terminal, startup folder and nested dispatch pass |
| T16 Simultaneous sessions | A1/A2/B simultaneous progress with overlapping skill/MCP/routine and nested B; no new cap | A1/A2/B and overlapping work pass | A1/A2/B concurrency and overlapping work pass |
| T17 History and account continuity | Native history/resume/fork/memory/instructions and live shared configuration/account continuity | Native history/synthetic continuity and real proxy6 resumes pass | Native history/resume/fork, synthetic continuity and real proxy6 resumes pass |
| T18 Scheduled jobs end to end | Actual OS calendar and interval/in-session/maintenance work through AIM, duplicate suppression and leases | Synthetic and real proxy6 OS calendars; interactive routine pass | Synthetic and real proxy6 launchd calendars; interactive routine pass |
| T19 Unattended refusal/recovery | Scheduled proxy/build/policy/auth refusals; next distinct occurrence works without replay | Four refusal/recovery cases pass | Proxy/build/policy/auth scheduled refusal and explicit next occurrence pass |
| T20 Process lifetime | Later detached-session decision: enabled old-owner control then suppression; retained Bash/async-agent lifetimes and sibling survival | Detached suppression, retained background, hard-death and sibling progress pass | Detached suppression, retained background work and hard-death/siblings pass |
| T21 Real sacrificial accounts | Authorized proxy account real model/tools/overlap/refresh/usage/history/calendar on each platform; separate two-account synthetic isolation | Proxy6 live model/tools/3-session overlap/refresh/usage/resume/calendar/offline cache pass | Proxy6 live model/tools/3-session overlap/refresh/usage/resume/calendar/offline cache pass |
| T22 Exclusions and no extra machinery | No accepted risk silently tightened, extra machinery added or required feature removed | Final cold review: no required feature removed or accepted risk tightened | Final cold review: no extra workflow restriction |
| T23 Transition and rollback | Complete retained/retrieved bundle; staged activation/rollback/migration/offline-cache and existing-owner preservation | Installer, real offline cache and retrieved full Linux inventory pass | Installer, real offline cache and retrieved full Mac inventory pass |
| T24 Comments and independent review | New clean-context code/evidence review, novel-path investigation and comments; exact adoption authorization recorded | Final independent review approved exact source/bundles | Final independent review approved exact source/bundles |

Private raw evidence: designated GCP `/home/aimdev/verification/claude-upgrade-20261103/`; maintainer copy `~/.local/share/aimgr/claude-upgrades/20261103/`. Record exact commands, artifact digests, OS and observed results with each completed group. Public records contain no account credentials or private captures.

## Linux observations, 2026-11-03 UTC

Linux and Mac native/synthetic/live acceptance and bundle retention are complete. Final cold review and local adoption follow; earlier failed attempts below are preserved alongside their successful replacements.

The Linux test bundle is `0a47fdc1b52bcda8e9da7685f273aa6a52fdffe84ae8355166ad95acd9705ce7`. Its vendor is the exact official Linux binary above. The native launcher is unchanged from the reviewed enrollment source. AIM’s updater-root resolver now matches the vendor’s handling of empty XDG variables, closing the gap described below. The initial source archive is `a29ca262a1dcb8825f665b0df6e6b4192a92fd3e7c3e79f5b0c89273d97fc8d3`; subsequent changes include the XDG resolver fix, focused regression coverage and clarified documentation. The test host runs Linux `7.0.0-1014-gcp`. That release is evidence, not an admission requirement.

| What was exercised | Observed result | Private evidence |
| --- | --- | --- |
| Native settings and custom headers | The validator, header coercion and managed-policy cases pass. Live headers stay at their startup values; an unrelated live setting changes normally. | `linux-synthetic-commands.json`, `validator.stdout.private.txt`, `headers.stdout.private.txt`, `managed.stdout.private.txt`, `upgrade317-protected/observations.json` |
| Telemetry controls | The positive control sends two event batches and the opted-out control sends zero. The error-reporting control uploads the synthetic error; the protected client does not. Required independent user OTEL continues to work. | `upgrade317-baseline/observations.json`, `upgrade317-protected/observations.json` |
| Remote Control | Eligible standalone, flag, slash-command and saved-setting controls establish actual registrations or streams. The policy-only comparison prevents all four paths. | `upgrade317-rc-baseline/observations.json`, `upgrade317-rc-policy/observations.json` |
| Simultaneous work and identity | Two A sessions and one B session overlap, nested A/B work completes, each account keeps its own identity across restart, and skills/MCP/routine work completes while all three remain active. | `upgrade317-protected-redis-v2/observations.json` and per-case `concurrency.json` |
| Proxy failure | Both affected A sessions stop within 448 ms. B continues. A new launch refuses before a model request. Explicit recovery succeeds without replay. | `upgrade317-protected-redis-v2/protected-pro-concurrency-disabled/concurrency.json` |
| Actual calendar | A systemd calendar fires at 02:25:00.995 UTC against a 02:25:00 target. Native tool work completes, a duplicate occurrence is suppressed and the lease is released. The separate interactive routine accepts follow-up, restores the terminal and handles an in-session scheduled wakeup. | `upgrade317-protected-redis-v2/protected-pro-schedules-disabled/schedules.json` |
| Scheduled refusal and recovery | Proxy-down, unknown-build, missing-policy and auth-refreshing cases all fail before model submission. Each next distinct occurrence succeeds; none replays the failed occurrence. | `upgrade317-protected-redis-v2/protected-pro-schedules-refusals-disabled/schedules.json` |
| Files and nested access | Ordinary native Read reaches the synthetic unrelated file; protected Read is denied. Explicit tool reads remain possible. Snapshot writes/rename/unlink/hardlinks and updater writes fail. Nested A/B launches apply their own grants. | `linux-candidate-boundary-upgrade317/result.json` |
| Executable capabilities | The same synthetic ELF is admitted without file capabilities, refused with capabilities, and admitted after their removal. Its bytes and permissions remain unchanged. | `native-capability-check-upgrade317/result.json` |
| Admission and optional routing | All 54 admission/status tests pass, including the opt-in real filesystem cases with no skips. All eight optional-routing tests pass. | `admission.stdout.private.txt`, `optional-unit.stdout.private.txt` |
| Installer | All 21 Linux installer contracts pass using synthetic images that are never executed. Existing-owner refusal, immutable previous bundles and post-publication failure reporting are covered. | `installer-v4.stdout.private.txt` |

Evidence filenames beginning `upgrade317-`, `linux-candidate-` or `native-capability-` are under `/opt/aimgr-state-audit/claude-implementation/` on GCP. Other files in this table are under the dated private verification directory recorded above. Exact commands for the initial and supplemental batches are in `linux-synthetic-commands.json` and `linux-supplemental-commands.json`.

The Remote Control flag comparison exits 130 because the fixture deliberately sends SIGINT after observing the native `disableRemoteControl`/`--rc flag ignored` diagnostic. It records zero registrations, sessions, workers or streams. This is a policy-specific refusal observation, not a completed model-turn claim. The standalone path exits with its policy refusal; the slash and saved-setting paths also refuse. Enabled controls reach the corresponding transport.

The protected workflow group's raw aggregate reports two exact-kernel matches. Both belong to its embedded **ordinary-account** routine fixture, which deliberately passes no protected profile. The actual protected requests omit the exact kernel. Preserve this distinction when interpreting the group; do not call ordinary task traffic a protected pass or invent a new global telemetry restriction.

Initial scheduling/concurrency attempts failed because the synthetic Redis fixture on port 36379 was absent. Those failures remain recorded. After starting a task-owned synthetic Redis, all five affected cases passed. Installer preparation first failed because its runtime user could not traverse the private source directory, then because the separate readable source copy lacked native owner-check dependencies. The final copy includes unchanged production dependencies and all contracts pass; no production admission check was relaxed.

## Questions raised by the candidate comparison

The cold review identified changes worth investigating beyond the old matrix. Version 2.1.317 makes its typed environment getters lazy by default; the live-setting, header and detached-session probes exercise the resulting behavior. A new opt-in missing-config guard can preserve installation identifiers under a file lock. The normal concurrency and continuity probes pass; an additional synthetic run with the guard enabled passed concurrency and continuity across 28 model requests, with stable per-account wire identifiers and no cross-account overlap. AIM pre-seeds valid state, so this proves compatibility with the option enabled rather than forcing its missing-file recovery branch.

The candidate adds `program_use_case_id` behind a remote feature flag. That field is absent from the protected default-service captures checked so far. Remote flags remain disabled by the existing production policy. Source inspection also found a Gmail attachment-origin change, with no demonstrated automatic collection path. These observations remain subject to final code/evidence review.

The test response that produces a “reply came from a network proxy” settings error is not new in 2.1.317. Both 2.1.316 and 2.1.317 reject the fixture's deliberately invalid empty server-policy response. That stale-cache case establishes a fetch attempt only. Separate eligible Remote Control controls establish functional behavior and the policy-specific prevention.

## Additional Linux findings and verification

The cold reviewer found a concrete mismatch: the vendor treats an empty XDG data/cache/state variable as the current directory, while AIM previously fell back to the home directory. A native positive control demonstrated 15 successful accesses/executions from the three missed updater locations. The resolver now uses the vendor’s nullish semantics. The same ordinary and protected cases each pass all 17 assertions: writes and direct/interpreter/alias execution are denied, while ordinary scripts and native builds still work. The original alternate-XDG alias case also passes all seven assertions. Evidence: `upgrade317-xdg-before`, `upgrade317-xdg-ordinary-after`, `upgrade317-xdg-protected-after`, and `linux-xdg-boundary-commands.json`.

An earlier 20-path updater probe was paired with the wrong policy fixture and failed all its denial assertions. It created arbitrary temporary locations that the selected policy did not restrict. This is retained as an invalid experiment, not evidence of a production escape or a passing test. Source review confirms automatic installation checks the pinned update controls, immutable self-spawn uses the admitted executable, and the alternate-version fallback belongs to the disabled detached system. No broader package-directory ban or live-settings freeze was added.

Native parent-to-child reentry, settings-validator isolation and paired machine-ID checks pass. The machine-ID baseline reads the host ID and includes the exact kernel in automatic context; protected execution denies the read and sends only the accepted OS family. Explicit tool `uname` still works. Evidence: `upgrade317-native-reentry/result.json`, `upgrade317-validator-boundary/observations.json`, and the paired `machine-id-*.stdout.private.txt` receipts.

The full Linux JavaScript suite completed with 827 actual tests passing and 12 expected opt-in skips. Its sole discovery failure was an AppleDouble metadata file accidentally included by macOS tar, rather than a JavaScript source file. The original failed runner receipt is retained; the metadata is removed and the affected test file and clean discovery are checked separately. Future source archives disable AppleDouble packaging. Native opt-in acceptance checks are recorded separately above.


## Linux follow-up acceptance evidence

The final native Linux checks use the same artifact set above. The independent
reviewer found no further production privacy defect: at that point the demonstrated empty-XDG
resolver mismatch was the only production fix. The later Mac investigation also
reproduced the pre-existing noninteractive cleanup defect described below.

| Check | Observed result | Private receipt |
| --- | --- | --- |
| Final vendor descriptors | An observer matches the actual vendor executable at each request. Inherited FD 200 is open for both baseline requests, and closed for every ordinary/protected native-entry request. | `upgrade317_fd/result.json` |
| Alternate native reads | Six working ordinary controls become protected denials: relative path, symlink, kernel version, kernel release, hostname and D-Bus machine ID. DMI UUID is already unreadable in the baseline and is not counted as a sandbox pass. | `upgrade317_reads/result.json` |
| Admission/entry replacement | After real admission, changing the mutable selected link does not change the immutable executable actually entered. Runtime-user replacement of the selector/bundle/launcher/policy/approval/ancestors is denied; fresh admission rejects the changed link. Ordinary and protected native model requests complete from the admitted bytes. | `upgrade317_race/result.json` |
| Native entry negatives | Eighteen malformed-path/count/mode/descriptor inputs refuse with exit 125; two valid native controls complete. | `upgrade317_entry_negatives/result.json` |
| Enforcement unavailable | The actual helper refuses ordinary and protected entry with exit 125 and zero model requests when a private mount namespace exposes AppArmor mode `complain`. The host remains in `enforce`; no global protection was disabled. | `upgrade317_enforcement_negative/result.json` |
| Live critical settings | An unrelated setting reloads, while all five update/telemetry/remote-flag values remain pinned to `1`. Seven model requests retain their original custom headers. | `upgrade317-critical-reload/observations.json` |
| Hard death and dependency failure | Parent/supervisor death ends the affected vendor. Same-account A2 and different-account B each continue model work on their assigned route. An MCP process actually starts and exits 23, producing a visible dependency failure. | `upgrade317-lifetimes/observations.json` |
| Kernel profile retirement | Five native cases cover surviving tools/threads, unreadable ownership, stopped-owner reclamation, unrelated profile preservation and harmless repetition. | Dated verification directory: `profile-retirement.stdout` |

The replacement test composes actual admission with actual native entry; it does
not pause the whole CLI runner. Static review confirms the runner consumes the
already-admitted immutable paths without resolving the user's selected link again.
The lifetime receipt includes one request after a kill was sent but before vendor
exit was confirmed; it used the assigned route and does not show a surviving
unprotected owner.

Raw transport controls independently exercise distinct IPv4, IPv6 and hostname
requests with conflicting proxy environment variables. The hostname is supplied
through `/etc/hosts`, so this proves system hostname resolution, not DNS query
capture. Tunnel exit, tunnel hang, adapter hang and monitor death stop both A
sessions, reject another startup and preserve B progress. Requests already handed
to a paused transport can arrive when it drains; that is separate from an
application restarting or replaying failed work. The strengthened receipt records
unique request IDs and issue/arrival times and checks the old role does not resume
after explicit repair and a new launch. Earlier raw receipts are retained rather
than overwritten.

### Live proxy6 compatibility

Only proxy6 performs live provider work. The retired proxy5 test-Redis record is
terminally fenced before maintenance, so maintenance cannot accidentally refresh
it. Its old record is backed up privately. Production Redis is not used.

Three native proxy6 sessions progress concurrently for 32 seconds with actual
model and Bash work. Two existing sessions resume with their previous markers
and session IDs. OAuth access and refresh tokens rotate, expiry renews and the
account identity/route remain stable; usage refresh returns current data. An
actual systemd calendar invokes the public AIM routine worker, performs native
tool work through proxy6, suppresses a duplicate and releases its lease.

With the VM's assigned proxy6 tunnel stopped, startup refuses within 5.801 seconds
before a native owner exists. The diagnostic is: “assigned proxy is unavailable.
Claude cannot start or continue. Repair the proxy/tunnel, then explicitly retry
or resume (proxy6).” The original VM tunnel is restored; the local Chrome/tunnel
is untouched. With only the test config's Redis URL temporarily pointed at a
closed loopback port, an actual cached proxy6 launch completes a model turn and
Bash tool call through its assigned exit. The original config bytes are restored.
The reviewer independently confirmed the Bash call and successful tool result in
the retained transcript. No human-verification challenge occurred.

Receipts in the dated private directory: `real-startup-proxy6.stdout`,
`real-model-proxy6.stdout`, `real-calendar-proxy6.stdout`, `offline-proxy6.json`,
and their private subprocess/transcript references. Live coverage is deliberately
same-account; separate A/B identity and failure isolation are actual native tests
against synthetic services and separate routes, not two live provider accounts.

### Linux bundle retention

The complete test bundle was archived, copied off the VM, freshly extracted and
verified file by file and against its inventory digest. Archive SHA-256:
`c6fcfb8e172ad7483cace7477ee5f07561a2dd956041aafa1a666caba8f04162`.
The private retained archive is `linux-tested-bundle.tgz` under the maintainer
upgrade directory; `linux-retention.json` records verification. It remains a
test-only approval until final review and the final source identity are recorded.

## Rented Mac progress

The existing AWS host was reused after scrubbing; no additional dedicated host
was allocated for this upgrade. The instance initially reported failed/unknown
boot checks, then became healthy. A separately discovered SSH control rule had
been attached to the default VPC rather than the test VM's VPC; that task-owned
rule was removed and replaced with a rule permitting only TCP 22 to the rental.
The rental's security group still has no outbound rules and allows SSH only from
the GCP test VM. Bootstrap uses copied offline inputs, synthetic homes and the
same reviewed source; no browser or personal state is copied.

The prepared source archive is
`35a3f2d60e361cc3aca0aeaafc96e05a8dc3ed340ed3c432fbc6911785af00c6`.
Its source starts at `b4c15b3` plus the retained candidate diff, including the
empty-XDG fix. The rental runs macOS 26.7 build 25G229, kernel 25.6.0, arm64;
those are test observations, not an admission gate. Its candidate artifact set is
`dab7c698e3477a31375a3b18557eea6bef83ea95941f159d8fe7af16b674fac1`.

Candidate validation, 13 header checks, the managed-settings matrix (including
Mac preferences), final native file/nested/snapshot/updater boundaries and the
constructor/reentry controls pass. Six ordinary cases complete actual native
work: stale policy, retained workflows, detached CLI suppression, detached
terminal suppression, seven updater-alias assertions and 17 empty-XDG assertions.
Telemetry/error controls and the four eligible Remote Control transports work;
the corresponding policy cases make no Remote Control transport requests. An
invalid unwrapped stale-policy response still refuses, and is not a functional
pass. Private receipts are the named case directories and matrix command records.

The interrupted batch does not establish passes for its protected stale-policy,
refresh or retained-workflow cases. The first two captured no model requests;
the workflow captured four but stopped at its stdio MCP turn with Node's
unsettled-top-level-await diagnostic and no workflow completion receipt. An
earlier progress message overstated that case as complete. All three required fresh
completion evidence. The following protected interactive terminal case did not start model work and
did not finish: its PTY owner, supervisor, vendor and caffeinate child remained
in Darwin's exiting state after SIGKILL, while the fixture blocked in waitpid.
All 108 captured requests for this case were route health checks. No model
request, human-verification challenge or successful terminal proof occurred.
The exact task controller was stopped and the rented instance rebooted, retaining
its volume and the original evidence. The original stall is retained as an unexplained failure; the isolated successful rerun is recorded below. It did not justify disabling retained background or terminal work.
The fixture now retains terminal output incrementally and bounds child reaping;
a failure remains a failure. Receipts: `terminal-kernel-exit-stall.json`,
`terminal-stall-observations.json`, the private process/sample records and
`upgrade317-protected/requests.private.jsonl`.

After reboot, the isolated terminal case passes with six model requests on the
assigned route, actual Bash work, an applied unrelated live setting, a refused
`/background` command, complete process inventory with no detached owner, and
normal exit. No production binary or policy changed between attempts. The first
kernel-exit stall remains unexplained, not relabeled as a successful run.
Receipt: `upgrade317-terminal-after-reboot/observations.json`.

### Foundation hostname observation

A synthetic Objective-C probe using the unchanged production policy construction
denies paired hostname/exact-version sysctls, gethostname, gethostuuid, Mach kernel
version, SystemVersion.plist and direct/bulk IOKit identifiers. Foundation still
returns a nonempty hostname. The original paired observation differed from its baseline. The original
receipt failed an extra assertion requiring that fallback to spell `localhost`;
that spelling is not an agreed requirement. The failed receipt is retained.

The cold reviewer found the same readable API in earlier Mac research. Inspection
of the exact 2.1.317 binary traces reviewed hostname consumers to `os.hostname`
and native gethostname, whose inspected error path returns `unknown`. No reviewed
automatic collection path to Foundation's hostname API was found. This is a
residual readable API, not a demonstrated new collection defect; the origin of
the fallback within Apple APIs remains unproven. The revised fixture reports
the residual separately from enforced denials. The later request-capture comparison below found no recovered hostname values in protected traffic. No broader native
restriction or accepted-tool limitation follows from this observation.

### Original proxy6 browser

The original local Chrome profile retains its fixed SOCKS proxy, empty bypass
list and assigned proxy6 exit. The exit check passed, but CDP port 9356 had no
listener, so live browser readiness is unverified. No browser was launched,
copied or signed in. Working tokens do not require a new authentication ceremony
for this upgrade. Synthetic auth regressions and unchanged browser routing code
cover the applicable upgrade checks; any necessary future sign-in still requires
checking that original browser's live binding first.

### Mac bundle retention

The complete test bundle was copied off the rental, freshly extracted and all
four inventory files verified by digest, size, executable mode and combined
inventory digest. Archive SHA-256:
`df443383abea22c854c63dce23462f597f2fe995b86fffa462bd8250275bd590`.
Private retained files: `mac-tested-bundle.tgz`, `mac-retrieved/` and
`mac-retention.json`. This preserves the test-only bundle; final acceptance and
normal-use authorization remain separate.

### Completed Mac workflows and caller cleanup fix

The replacement initial cases complete: stale policy makes one model request;
refresh rotates the synthetic credential and stores fresh Max/profile metadata;
retained workflows complete 23 model requests and all workflow assertions.
Exactly 21 requests use the protected route. Two belong to the deliberately
ordinary embedded routine, and only those two include the exact kernel. The
cold reviewer independently checked that attribution. Evidence:
`upgrade317-protected-initial-after-reboot/observations.json` and its
`workflows.json` and private capture.

All 15 cases in `upgrade317-protected-remaining/observations.json` complete with
exit 0 and actual model work. They cover error telemetry versus independent
user OTEL, launchd calendar and interactive/in-session schedules, four scheduled
refusals and their next occurrences, startup folders, live settings and headers,
native tools/MCP packages/auth/aliases, concurrent accounts, identity continuity,
hard-death lifetimes, overlapping skill/MCP/routine work, startup controls,
empty-XDG updater locations, HTTP MCP and basic terminal behavior.

The actual launchd calendar fires at 04:09:01.093 UTC against a 04:09:00 target.
It runs as the ordinary test user from a system LaunchDaemon, completes native
tool work, suppresses the duplicate and releases its lease. No GUI activation is
claimed. The optional-routing unit matrix initially lacked Darwin's required
127.0.0.2 loopback alias; seven tests passed and the mixed ordinary/protected
transport test failed to connect. That same failing case passes when the test
alias is present. No production transport code changed for that setup issue.

Cold review identified a separate production defect in noninteractive caller
cleanup: the close handler deliberately waits for its grace timer to kill group
descendants, but that timer was unreferenced. A standalone caller could therefore
exit before KILL with Node's unsettled-top-level-await status 13. A synthetic
standalone regression reproduces the failure using a direct child that exits on
TERM and a descendant that ignores TERM. Keeping only that grace timer referenced
makes the caller send TERM then KILL and resolve its timeout result. Both this
case and the earlier stubborn-tree regression pass after the fix. This explains
the caller's warning mechanism, not the original MCP stall or Darwin kernel-exit
state. Normal completion still clears the timer; no feature or timeout changes.
The complete runner unit file passes on both GCP and the rented Mac after syncing
this change. Actual native descriptor/entry/race checks then also complete with
that final runner source.

The Mac native policy-failure component also passes: a separate compiled copy of
the production entry injects failure only at the sandbox application call, reaches
the actual policy-error branch and exits 125 in ordinary/protected modes without
running its synthetic payload. A direct payload positive control works. The
admitted helper and global host enforcement are unchanged. This is component
fault-injection evidence alongside real-kernel positive tests, not a claim to
have disabled Seatbelt on the rental. Receipt: `upgrade317_policy_failure/result.json`.

The hostname reviewer scanned a 1,030-request snapshot, including 601 rows from
protected test roots and 91 model requests, with no matches for the recovered
baseline/diagnostic Foundation value or current kernel hostname. All 7,276
encoded event fields in the controls decoded successfully and had no matches.
The unwrapped Remote Control control sends the current kernel hostname once in
`body.machine_name`, providing a real consumer positive control. Later paired
Foundation API observations returned equal baseline/protected values: no reliable
hostname denial is claimed for that residual API. The original protected digest
could not be reconstructed, so its historical value is not claimed as searched.


### Final Linux suite and Mac route supplement

The complete Linux suite on the final runner source passes: 840 tests, 828 passes,
12 expected opt-in skips and zero failures across 109 test files. The skipped
offsite/platform cases are exercised separately in this record. Runtime was
81.182 seconds at concurrency two. Receipts: `full-final.json`,
`full-final.stdout` and empty `full-final.stderr`.

Mac raw native routing passes for IPv4, IPv6 and system hostname resolution via
the test hosts file. Both loopback callback families work; conflicting inherited
proxy settings do not change the assigned exit. Default routes and resolver
configuration remain unchanged. This proves system hostname resolution, not a
packet-level DNS capture. The ordinary direct control also works against the
synthetic service. No vendor binary is executed by this transport supplement.

Tunnel exit, tunnel hang, adapter hang and monitor death stop both affected
sessions with exit 125 in 104, 11,132, 10,786 and 122 ms respectively. The other
account keeps progressing. New launches refuse; explicit service repair permits
new work without replaying old requests. Request identifiers and issue/arrival
times distinguish buffered delivery from replay. Losing the tunnel during
admission never executes the pending payload and stops the active session
without waiting for its probe. IPv4/IPv6 callbacks and the unaffected account
remain usable. Receipt: `mac-route-completeness-v3.json` and its private events
and request records.

The first two transport attempts had incomplete fixture readiness waits: a live
SOCKS listener did not establish that the native service had finished activation.
Those failures are retained. The final fixture waits for the production
`current_ready` check and the previous native owners to exit. Production routing
code was not changed to make the test pass.


### Real proxy6 acceptance on the rented Mac

All live provider checks use proxy6 and its established assigned exit. The Mac
has no outbound security-group rule; direct traffic fails independently.
Separate GCP-owned reverse SSH forwards carry only the test Redis connection
and the existing proxy6 SOCKS route. No browser, key, normal account state or
production Redis was copied to the rental. Provider TLS remains end to end.

Three actual native model sessions overlap for about 15.5 seconds. Each completes
a Bash tool call and reports the assigned exit. Two sessions resume their own
history, recall the prior marker without receiving it in the new prompt, and
complete another Bash call. Both access and refresh tokens rotate, expiry renews,
identity/assignment remain stable and fresh usage succeeds. The test credential
version advances from 7 to 9; this is separate test Redis only.

Stopping only the rental's task-owned SOCKS forward makes a new explicit proxy6
launch refuse with the assigned-proxy repair message and no native account
owner. The test Redis forward remains available. The exact SOCKS forward and
native service are then repaired explicitly. Separately, making test Redis
unreachable proves actual cached native model/Bash work still uses the assigned
route; the original config bytes are restored afterward.

A real launchd calendar runs the public routine CLI and its exact generated
worker command in a real PTY. The real proxy6 model executes the synthetic tool
and finishes the job. The terminal remains available, duplicate execution is
suppressed, the worker exits normally and its lease is released. The fixture
uses a Herdr UI stand-in; it does not claim graphical Mac integration. Both final
commands exit 0, and no human-verification challenge occurs.

Receipts: `real-model-proxy6.stdout`, `real-startup-proxy6.json`,
`offline-proxy6.json`, `real-calendar-proxy6.stdout`, `real-final-commands.json`
and their private transcript/result paths. Live coverage is one real account
with overlapping sessions; distinct-account coverage uses actual native A/B
sessions against synthetic services and routes.


## Final review, retention and adoption

The independent reviewer approved both exact bundles with AIM source
`58ef2c04a906b302a9f69d5063d812efdbd316c5` after checking T01–T24, accepted
risks and functionality. The reviewer independently checked actual live model
and tool transcripts, source equality, complete retained inventories and the
final Linux suite. No additional approval question, native lifecycle rerun or
new workflow restriction was required. The complete private review is retained
as `cold-review-final.md`.

The final Mac evidence archive was retrieved and verified before rental cleanup:
`mac-evidence-final.tgz`, 155,193,162 bytes, SHA-256
`55d5b3bdeead03f040f4486471a83df6049a35afb6640b70bcc78e1ceb139c56`.
It retains 4,955 entries, including original failed attempts, successful
replacements and the sacrificial-account transcripts. The Linux evidence remains
on the designated persistent test VM; both complete tested bundles and the final
source archive are also retained locally.

Amir's instruction to get the latest binary tested and linked properly authorizes
adoption after these checks. Separate normal-use installation copies record
that instruction, exact source and review. The original test manifests and every
tested payload byte remain unchanged. The immutable policy's offsite scope text
records its original build/testing provenance; the separate administrator-owned
approval record supplies the subsequent normal-use authorization.

The fixed local release is `58ef2c0-claude-2.1.317`, with its own exact dependencies.
The file-only installer staged and activated the retained Mac bundle; the Claude
link now selects that immutable bundle's vendor image. Privacy status confirms
normal-use approval, version 2.1.317 and an exact selected/approved hash match.
No existing session was signalled and previous bundles remain available.


Local post-installation smoke completed successfully for an existing ordinary
account, an existing protected account and the exact automatic command
`aim claude run opus`. Each returns its requested marker from a real model turn
and exits 0; no human-verification challenge occurs. These are routine checks
after review/approval, under the existing local-use permission. Unknown-behavior
privacy experiments remained offsite with proxy6. Receipt:
`local-reviewed-smoke/results.json` and private outputs.


The rented instance was terminated after evidence retrieval; AWS no longer
returns it and its dedicated host has no instances. The host is available, not
yet released: the existing bounded release schedule remains enabled for
00:48–08:46 UTC on November 4, after its minimum rental. The temporary GCP-to-Mac
SSH firewall rule was removed. Task-owned Mac forwarding processes and synthetic
Redis are stopped; the established proxy6 route and older unrelated test services
are preserved. Private cleanup receipts: `rental-cleanup.json` locally and
`task-cleanup.json` on GCP.
