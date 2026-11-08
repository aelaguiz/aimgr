---
title: Claude per-machine privacy and login
date: 2026-11-07
status: active
fallback_policy: forbidden
owners: [Codex]
reviewers: ["Claude Opus 5.5 high, independent source review 311a8ccd-f9f2-4e68-88ff-022d38109175"]
doc_type: migration
related:
  - https://github.com/aelaguiz/aimgr/pull/14
  - https://github.com/aelaguiz/aimgr/issues/16
  - https://github.com/aelaguiz/aimgr/issues/17
---

# Claude per-machine privacy and login

Claude launched through AIM must use a primary login obtained on that machine,
keep its installation identity specific to the account and environment, and
apply the agreed privacy controls whether the account has a proxy or connects
directly. Existing working directories, histories, settings, skills, ordinary
tools and intended third-party MCP credential sharing must keep working.

This is the Claude implementation of the requirements in issues #16 and #17,
stacked on Codex privacy PR #14. The [Claude implementation issue #21](https://github.com/aelaguiz/aimgr/issues/21) owns
progress; this document owns the design and acceptance evidence. Proxy PR #15
stays parked. No merge is part of this task.

## Requirements and limits

The [allowed/disallowed list](AI_APP_PRIVACY_INVENTORY.md#allowed-and-disallowed-access)
is the behavioral contract. In particular:

1. Native Claude file tools and automatic reads can use the whole workspace,
   Downloads, configured screenshot directories, `/tmp` and its physical aliases,
   macOS user temp, and explicitly selected additional work areas. Files created
   later are included. Selecting an outside file grants that file, not its parent.
2. Native Claude does not receive the whole home or disk, unrelated application
   data or other accounts' primary credentials. Existing system/runtime and
   credential integration access remains necessary.
3. Shells, builds, debuggers, process inspection, background jobs, browsers, MCP,
   SSH, SDK credentials, native Keychain use and independent reviewers retain
   their ordinary operating-system permissions. Do not restore the removed
   blanket child-process sandbox. This boundary is not malicious-tool containment.
4. Primary Claude login tokens and AIM installation identifiers are not shared
   between machines. Shared settings, instructions, skills, history, account
   labels/availability and intended third-party credentials remain supported.
5. Optional provider and custom diagnostics are disabled, including after live
   settings changes and token refresh. Functional model/account/tool traffic
   continues. Existing remote-control and unattended self-update exclusions stay.
6. Assigned routes remain mandatory when present. Direct accounts receive the
   same privacy protections. This change adds no proxy routing architecture.

The same account is still identifiable to Anthropic. Task inputs and tool output
may contain real paths or machine information. Ordinary tools can access more
than the native boundary. Existing selected instruction/skill-root symlinks may
point outside work areas; retaining them is a disclosed compatibility limit,
not a promise to contain a malicious repository. Organization-owned policy is
the previously approved gap. Do not introduce a vendor fork, daemon, credential
broker, global process registry, tool allowlist or general secret scanner.

## Current architecture and source grounding

The reviewed base is `7d96da958c309103f1e45f71f3694aa58df2a18b`, the head of PR #14.

| Area | Current code and behavior | Required change |
| --- | --- | --- |
| Login and refresh | `src/cli/commands/login.js`, `src/targets/claude-preflight.js`, `src/credentials/claude-maintenance.js`: native staging login and refresh publish primary credentials to Redis; preflight treats Redis as canonical | Make native local primary state canonical for managed Claude; successful local login establishes ownership |
| Run, resume, fork, routines | `src/cli/commands/claude.js`, `src/routines/claude.js`: pooled token selection, projection and publication | Route every managed lifecycle path through local ownership/readiness; no cached legacy-token escape |
| Status and selection | `src/status/claude-redis-view.js`, `src/pool/usage.js` | Combine safe shared metadata with this machine's local login state; no local login means ineligible here |
| Coordination | `src/targets/claude-machine-lease.js` prevents machines racing one copied refresh token | Remove that exclusive cross-machine requirement for independent grants; preserve local locks and shared usage/account metadata |
| Native homes/history | `src/targets/claude-sessions.js`, `src/credentials/claude-native.js`: label-based homes and established history discovery | Keep existing paths and external history-reader compatibility; bind auth ownership in place |
| File/privacy launch | `src/targets/claude-runner.js`, `src/privacy/claude-native-invocation.js`: privacy keyed to `egressProfile` | Separate always-on privacy from optional route setup |
| Identity | `src/privacy/claude-identity.js`, `claude-state-migration.js`: account-bound identity, protected-only migration | Add environment binding and apply to direct accounts as well |
| Settings and exporters | `src/privacy/claude-settings.js`, `claude-managed-policy.js`, `claude-settings-handoff.js` | Preserve native origin/relative/live settings semantics; require all diagnostic exporters off |
| Ordinary tools | `native/claude/approved_launch_{linux,macos}.c`, `native/privacy/launch_linux.h` | Preserve existing broad ordinary-tool transitions and working process/debugger behavior |

Official [authentication documentation](https://code.claude.com/docs/en/authentication)
describes native account login. The [monitoring documentation](https://code.claude.com/docs/en/monitoring-usage)
separately configures telemetry and log/metric exporters. Those are design inputs;
the exact reviewed installed Claude version and actual collector captures decide
whether the implementation works. Record that version and its artifact hash in
the test results rather than silently upgrading during acceptance.

## Local primary authentication

### Ownership and storage

Use the existing native Claude credential storage and locks. Bind the local
owner to verified account UUID, organization UUID, environment and login
generation. Preserve the existing one-label/one-home model and duplicate-account
refusal, moving duplicate checking to safe metadata. Two organizations of one
account must never share a primary home. There is no alias registry, home
locator, whole-home symlink or history relocation.

Keep `~/.aimgr/claude-homes/<label>/.claude` and its existing histories. Provision
Claude's environment marker with its runtime independently of Codex installation.
The vendor-visible sidecar contains only an account/organization/environment
binding digest, never the raw cross-account environment identifier. A copied
owner from another environment is invalid; ordinary native refresh remains valid
without stamping a new owner on every token change.

Native Claude owns refresh. Preserve its refresh/storage/app-state locks and
app-state file selector. Normal work and same-account relogin remain concurrent.
Local invalid grants affect only that local generation, never another machine
or a newer successful login. Separate machines can run the account concurrently;
remove the old remote token lease, Redis-outage pause/reconnect credential fence
and routine behavior that stops idle sessions to obtain that lease. Preserve
safe offline metadata plus valid local auth where offline runs already work.

### Commands, remote login and replacement

`aim claude login <label>` and `aim claude logout <label>` own managed local
Claude auth. All managed readiness messages point to those commands.
`aim login <label> --provider anthropic` remains the explicitly separate legacy
Prime/Pi enrollment; it never enrolls a managed local Claude login. An ambiguous
Anthropic shorthand must direct the caller to the appropriate explicit command.

For a new proxied label, `aim claude login <label> --proxy <profileRef>` selects an
existing configured Claude route before authorization. Existing assigned labels
must retain their assignment; login cannot silently change it. Close the bounded
Redis connection before browser authorization and reconnect to revalidate the
environment, identity and route before committing. Each attempt has its own
private staging directory, so an interrupted attempt cannot block the next login.

`aim claude login <label> --manual-callback-stdio` supports an original browser on
another host. The destination runs official `auth login --claudeai` and owns its
state, PKCE and exchange. Reuse the existing offsite login URL/callback bridge
and native manual-code behavior, adapting it to the local-primary command and
macOS. The original browser host validates the selected existing profile/route
before opening the URL; only its one-use callback/code returns privately to the
originating native process. Validate native callback origin/path/state where
applicable. Never transfer browser state or primary tokens, spoof a browser
validation boolean, or add an arbitrary remote executor. Prove the exact native
manual/loopback handoff on Linux before dependent real-account acceptance.

Keep staged login and validate account plus organization before commit. Wrong
account, cancellation or failure preserves the prior grant and third-party
state. For same-account/organization/environment relogin with established private
identity, use native refresh/storage/app-state locks, reread and merge the full
current documents, then publish the local owner generation. Do not acquire a
stopped-owner EX guard or use the identity migration journal for routine relogin.
Native concurrency tests must prove stale processes cannot overwrite the new
grant; no copied-token publisher remains. A failed/interrupted enrollment must
never manufacture ownership of a legacy token.

First conversion, an account/organization rebind or an actual identity rotation
uses the existing stopped-owner transition and journal, because native processes
can retain and rewrite old identity/app state. Do not run new sessions under
unproven old IDs as an automatic fallback. Logout uses the existing local guard
to prevent active cached owners from continuing after a claimed local removal;
it preserves independent MCP credentials and does not claim provider-wide revoke.
No automatic session killing or new transaction engine is introduced.

### Onboarding

Each account used on a machine needs one native browser login there. Accounts
unused on that machine need no enrollment. Existing running sessions continue;
new managed launches require the local login. Install the reviewed runtime and
its environment marker on that host before enrollment. The first conversion
that rotates existing identity waits for that account's local sessions to finish;
other accounts and machines can continue. Subsequent same-identity relogins do
not impose that stop. This PR implements and tests the transition, not a fleet
shutdown or mass logout.

No legacy/Redis grant auto-enrolls. No pooled primary fetch, old token cache,
import or repair path can turn missing local login into a valid owner. Keep
existing transcript paths, memory, settings and external history readers intact.

### Shared metadata and separate credential authorities

Add a server-side allowlisted Claude metadata view, following the Codex metadata
reader. Managed Claude selection/status/maintenance must never download the
legacy primary bundle and redact it afterward. Share account identity (including organization), labels, route/browser/pool policy and useful usage information, not bearer/refresh tokens, native credential documents or local installation identifiers. Legacy-grant `reauth` and credential `health` are not account-wide metadata: exclude them so an expired Prime/Pi grant cannot disable a valid managed Claude login.

Keep Prime/Pi's explicitly separate legacy credential authority working. Its native maintenance must use a separate legacy destination: it currently resolves the same label home and could overwrite a local-primary grant. Never project a legacy token into a bound primary home. Their
`harness-access.js` and `credential-helper.js` callers must not obtain or export
the managed Claude local grant. Do not globally replace `loadRedisRuntime()`
with an overlay containing local credentials. This PR isolates managed Claude
primary login; it does not claim to migrate every Anthropic credential used by
other harnesses.

Claude's native `.credentials.json` mixes primary OAuth with third-party MCP/XAA
and package credentials. Never sync the entire file or overwrite it with only
the primary field. Preserve and classify third-party entries under native write
locks, including refreshes and unrelated fields. Current Claude shares MCP definitions, while mixed OAuth/XAA/package secrets remain per native home. Preserve that behavior and externally configured shared credential mechanisms; do not introduce cross-account secret replication.

Retire managed Claude capture/import/export as enrollment mechanisms; preserve any needed transfer only under explicit legacy authority. Keep local-primary credentials out of shared `state.credentials` by construction, including browser seed/OpenClaw compatibility, Redis import/export and repair. Do not add provenance machinery to every generic clone operation. Synthetic canaries verify the reachable boundaries. Legacy Prime/Pi Anthropic grants still circulate through their old Redis authority; this PR does not claim to make that separate harness authentication machine-local.

## Privacy and working directories

Apply identity preparation, native file/host-identifier protections and managed
diagnostic settings independently of `egressProfile`. Preserve route setup and
missing/wrong-route refusal for assigned accounts. Offline local runs still
need verified account identity and the same privacy preparation.

Extend the existing root resolver with the agreed default and configured work
areas. Reuse Codex's OS-location logic only where it removes duplication without
changing Codex behavior. Canonicalize aliases and allow absent future work roots
without making missing optional folders a launch failure. Preserve the existing
grants for project folders whose native trust dialog was accepted, with the
existing whole-home and ancestor exclusions. Those are user-selected work areas,
alongside current task roots and deliberately configured extras, including native
`permissions.additionalDirectories` and `--add-dir`. Removing their access would
be an additional restriction outside this migration.
The pinned CLI rejects files in `--add-dir`; `--file` downloads remote resources.
Use its existing literal `Read(//absolute/file)` allow-rule surface for explicit
outside-file selection, preserving the selected settings tier and origin. Grant
the file/canonical target only. Do not infer grants from prompt text or convert
wildcard permission patterns into guessed directory roots. Native comparison
must verify this mechanism before claiming exact-file support.

Broad temp access must work for browser screenshots, clipboard images,
drag-and-drop image paths, generated files, background processes and files
created after parent exit. Grant `/tmp` aliases and user temp plainly; do not add
new temp namespace denials or a path-complement engine. Files within these user-
approved work areas are readable, including source-adjacent settings snapshots.
Keep existing protection against mutating this invocation's immutable settings.
Managed primary secrets/owner records remain in their private account locations;
provider secret fields remain excluded from settings snapshots. Detached and
remote services stay disabled by their existing controls. Do not replace the
caller's temp directory or sandbox ordinary tools.

Bind identity schema to account plus environment. A legacy identity with no
environment provenance rotates once using the existing migration journal;
crash recovery reuses planned IDs rather than generating another identity.
Preserve optional lazy identity fields and current app-state file selection.

Keep Claude's existing settings layout. Source-adjacent flag snapshots preserve
relative paths; user/project contents and non-path switches remain live. New
outside path targets can take effect on the next invocation. Do not add Codex's
settings adapter or require all shared paths to become absolute.

Require disabled automatic telemetry/error reporting and custom diagnostics through supported Claude-specific controls: `CLAUDE_CODE_ENABLE_TELEMETRY=0`, `ENABLE_BETA_TRACING_DETAILED=0`, `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, subject to pinned-source and collector proof. The pinned 2.1.317 beta tracer checks its own enable flag before the ordinary telemetry gate, so it needs a separate positive-control collector case. Do not change generic `OTEL_*` exporter/SDK controls inherited by task tools. Managed
policy validation must compare typed expected values, including false/`none`,
rather than assuming all mandatory settings are truthy. Test native behavior
after settings reload and refresh; an environment-variable assertion alone is
not acceptance. Explicit feedback and automatic errors are distinct pipelines;
record what the actual controls disable rather than claiming one opt-out covers
both without evidence.

## Implementation sequence

1. Publish this plan and the integrated Claude issue; link the Claude portions
   of #16/#17 to it. A fresh independent code reader compares the plan with the
   source and user requirements before implementation. Resolve substantive
   findings in this document.
2. Implement local auth/metadata/caller migration and privacy/work-area changes
   in coordinated scopes. Keep tests beside the changed behavior. Source and
   synthetic fixtures can be edited locally; native experiments and runtime
   acceptance run on the isolated Linux VM and rented Mac.
3. Review product changes and their evidence; delegate mechanical test and
   documentation checks using model-routing. Run affected native tests on both
   platforms, then the full suite once the candidate is ready. Have a fresh
   cold reviewer audit the complete diff against requirements, compatibility,
   excess protection and scope creep. Fix findings and repeat affected checks.
4. Open the full tested PR against `codex/privacy-milestone-1`, with concrete
   evidence and limits. Update the implementation issue, worklist and inventory.

The paired Gemini 4 Argon medium reviewer continues across the task as a check
on drift. It supplements the independent plan and final code reviews.

## Test plan and completion criteria

Tests use synthetic data unless a provider grant is specifically required. Real
provider tests use only the established sacrificial account and assigned route,
with sign-in in its original browser profile. No ordinary user identity,
organization app registration, private configuration, history or browser state
is copied to isolated machines. Preserve sanitized command/version/commit and
result receipts; keep tokens and raw identity-bearing logs out of GitHub.

| Area | Required evidence on the candidate |
| --- | --- |
| Redis boundary | Real local test Redis holds canary primary secrets; managed metadata/status/selection/maintenance receive only allowlisted fields. No publish, hydrate, cache or import/export path transfers the local primary. Separate Prime/Pi synthetic authority remains functional. |
| Ownership | Fresh login records account/organization/environment; copied receipt, wrong identity, label rebind, duplicate same-organization labels and unowned legacy credentials are refused. Same person in different organizations stays separate. Same-identity relogin succeeds while native sessions run; interruption/cancellation preserves valid prior state and third-party entries. |
| Refresh/logout | Native refresh persists locally; concurrent same-account processes serialize through native locks. Invalid grant/logout stays local and cannot be resurrected from Redis. Demonstrate actual live-owner replacement behavior and tombstones. |
| Real independent grants | Independently authorize the same sacrificial account on Linux and Mac, alternate native refresh and normal authenticated requests, then verify local logout cannot resurrect Linux auth and leaves Mac usable. New authorization and alternating actual refreshes, not local logout, establish provider grant independence. Do not use copied tokens or source inspection as proof of issuer independence. |
| Native work files | Stock positive control and protected native Read/image/edit results in workspace, sibling repos, Downloads, screenshots, temp aliases, configured extra roots and future files. Exact outside file does not grant its sibling. Private-canary reads denied. Check actual tool content, not only process exit. |
| Temp/background | A late file/socket created after the launching parent has exited remains usable. Ordinary temp variables unchanged. No new temp namespace exclusions. Private-canary fixtures live outside the agreed work areas; the current immutable settings input stays protected against writes. |
| Skills/instructions | Existing label homes/histories and external readers find sessions; shared relative settings and live non-path edits work. Native discovery and actual skill edit/create/repair work for real directories and external directory links, malformed/new skill files and unused broken links. Preserve documented selected-root-link limit. |
| Identity | Different accounts/environments get distinct stable AIM identity; same owner stays stable across launches. Legacy rotation once; interrupted journal recovery uses the same planned values. Host identifier canaries remain inaccessible to native collection while task tools retain allowed behavior. |
| Diagnostics | Stock collectors demonstrably receive each supported provider/custom diagnostic stream (including a real stock trace positive control), then protected candidate collectors receive none during startup, model/tools, error, settings reload, native refresh and shutdown. Functional requests and ordinary tool exporter settings continue. Distinguish explicit feedback evidence from automatic errors. |
| Proxy independence | Direct and assigned-route launches have identical privacy controls; assigned missing/wrong route refuses without direct retry. Reuse existing route fixtures; restore only fixture-owned route changes. |
| Real workflows | Run the existing retained-workflow/integrated-continuity/policy recipes once for direct-account protection, covering shells/builds, process inspection/debugger, background service, nested reviewer, scheduled launch, browser artifact, MCP native login/refresh, SSH/SDK and Mac Keychain integration. Route cases separately verify route behavior, not a duplicate full tools matrix. No shell substitute for a claimed native file-tool pass. |
| Regression/review | Focused tests during development; lint and full suite once ready on supported isolated hosts. Record skips/failures honestly, fix candidate failures, final independent reviewer reports requirements coverage and any remaining blockers/overbuild. |

Existing recipes to extend: `scripts/privacy-claude-policy-probe.py`,
`scripts/privacy-claude-default-services-probe.py`,
`scripts/privacy-integrated-compatibility-check.mjs`,
`scripts/privacy-integrated-continuity-check.mjs`,
`test/privacy/claude-retained-workflows.mjs`, and
`test/privacy/claude-macos-tool-access.py`. Add focused missing cases rather than
building a general backtesting framework.

## Status and evidence

The independent Opus source review completed and identified corrections incorporated above: remove alias machinery, include organization identity, add remote/local command surfaces, separate legacy health/enrollment, preserve live same-account relogin and tool telemetry, and drop speculative temp restrictions. Implementation is committed for isolated testing, with focused tests and native acceptance in progress. The paired reviewer additionally caught connection-lifetime, interrupted-login and trusted-project compatibility corrections. The isolated Linux VM is available; the newly rented Mac passed its
clean reboot before product installation, with bounded automatic cleanup.
Implementation/test/review results replace this status as they arrive.
