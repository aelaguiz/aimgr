---
title: Claude per-machine privacy and login
date: 2026-11-07
status: active
fallback_policy: forbidden
owners: [Codex]
reviewers: []
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

Use the existing native Claude credential storage and locks. Extend the existing private identity sidecar and its transaction with a local
owner record that binds the verified underlying account UUID, an administrator-
provisioned environment identifier, native home, and login generation. Provision
Claude's environment marker with its runtime; it must not require installation
of the Codex runtime. Reuse the established environment-binding pattern without
adding Codex's separate refresh implementation to Claude.

Keep `~/.aimgr/claude-homes/<label>/.claude` and existing histories. An alias of
one underlying account resolves to its already selected local owner/home; it
must not create a second competing credential store. Label rebinds cannot adopt
the previous account's login. Do not rename or bulk-relocate existing histories,
memory, project state or skills. A copied owner record from another environment
does not authorize its credential file.

Native Claude owns refresh. Preserve `.storage-write.lock`, its native refresh
locks and current app-state selection behavior. Use existing AIM assignment
locks for authority replacement; do not hold native storage locks across network
requests. Local invalid grants make this machine require login, not every other
machine. Do not add exclusive cross-machine account use: independently logged-in
machines can run concurrently.

### Login and replacement

The existing native staging login performs OAuth in the destination environment;
the original authorized local browser profile performs browser authorization.
No browser profile or primary credential file is copied to the destination.
Validate the returned account identity before committing the local grant and
owner record. Failed login, cancellation and wrong-account login preserve the
prior good local grant and unrelated MCP credentials. Reuse the existing native auth/app-state/identity transaction for this commit; publish the nonsecret local home locator last and recover committed ownership if publication was interrupted. Do not build a second transaction engine. Verify interruption boundaries rather than assuming two file writes
are atomic together.

Existing legacy/Redis grants do not enroll automatically. The first managed
Claude run without a valid local owner reports that this machine needs login.
Never silently read a pooled primary grant, stamp an ownership receipt onto it,
or use a legacy cache as an offline fallback. Logout invalidates only the local
owner/native grant and cannot be undone by Redis hydration. Native processes
already holding tokens must be handled through existing live-owner guards,
without automatically killing user sessions or claiming immediate provider
revocation that the client has not demonstrated.

### Shared metadata and separate credential authorities

Add a server-side allowlisted Claude metadata view, following the Codex metadata
reader. Managed Claude selection/status/maintenance must never download the
legacy primary bundle and redact it afterward. Share account identity, labels,
route assignment and useful availability/usage information, not bearer/refresh
tokens, native credential documents or local installation identifiers.

Keep Prime/Pi's explicitly separate legacy credential authority working. Its native maintenance must use a separate legacy destination: it currently resolves the same label home and could overwrite a local-primary grant. Never project a legacy token into a bound primary home. Their
`harness-access.js` and `credential-helper.js` callers must not obtain or export
the managed Claude local grant. Do not globally replace `loadRedisRuntime()`
with an overlay containing local credentials. This PR isolates managed Claude
primary login; it does not claim to migrate every Anthropic credential used by
other harnesses.

Claude's native `.credentials.json` mixes primary OAuth with third-party MCP/XAA
and package credentials. Never sync the entire file or overwrite it with only
the primary field. Preserve and classify third-party entries under native write
locks, including refreshes and unrelated fields. Current Claude shares MCP definitions, while mixed OAuth/XAA/package secrets remain per native home. Preserve that behavior and externally configured shared credential mechanisms; do not introduce cross-account secret replication. Same-account aliases use the chosen home and its native refresh state.

Capture/import/export, browser seed, OpenClaw compatibility, Redis import/export,
repair and generic maintenance must reject local-primary publication before
provenance disappears. Keep legacy-authority operations explicit. Synthetic
canaries test every reachable boundary without reading real pooled secrets.

## Privacy and working directories

Apply identity preparation, native file/host-identifier protections and managed
diagnostic settings independently of `egressProfile`. Preserve route setup and
missing/wrong-route refusal for assigned accounts. Offline local runs still
need verified account identity and the same privacy preparation.

Extend the existing root resolver with the agreed default and configured work
areas. Reuse Codex's OS-location logic only where it removes duplication without
changing Codex behavior. Canonicalize aliases and allow absent future work roots
without making missing optional folders a launch failure. Do not reinterpret
every historical trusted-project entry as permanent permission to unrelated
outside trees; retain current task roots and deliberately configured extra
work areas. Determine exact-file admission from the pinned native CLI rather
than pretending a directory flag grants only one file.

Broad temp access must work for browser screenshots, images, generated files,
background processes and files created after parent exit. Protect only known
private AIM/Claude credential/settings/control artifacts, where needed; never
deny `/tmp` wholesale or replace the caller's temp directory. Prefer the existing
private account locations where moving an AIM-owned artifact preserves native
path semantics. Native Claude's account-specific control socket and inline
settings origin require explicit source/test evidence, not a speculative set
of new OS restrictions.

Bind identity schema to account plus environment. A legacy identity with no
environment provenance rotates once using the existing migration journal;
crash recovery reuses planned IDs rather than generating another identity.
Preserve optional lazy identity fields and current app-state file selection.

Keep Claude's existing settings layout. Source-adjacent flag snapshots preserve
relative paths; user/project contents and non-path switches remain live. New
outside path targets can take effect on the next invocation. Do not add Codex's
settings adapter or require all shared paths to become absolute.

Require disabled automatic telemetry/error reporting and disabled custom log,
metric and trace exporters in the exact supported native controls. Managed
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
3. Integrate and directly read every changed line. Run affected native tests on
   both platforms, then the full suite once the candidate is ready. Have a fresh
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
| Ownership | Fresh login records correct environment/account; copied receipt, wrong account, label rebind and unowned legacy credentials are refused. Aliases converge on one native owner and lock. Cancellation/interrupted commit preserves prior valid login and third-party entries. |
| Refresh/logout | Native refresh persists locally; concurrent same-account processes serialize through native locks. Invalid grant/logout stays local and cannot be resurrected from Redis. Demonstrate actual live-owner replacement behavior and tombstones. |
| Real independent grants | Independently authorize the same sacrificial account on Linux and Mac, alternate native refresh and normal authenticated requests, then test one grant's logout/revocation without invalidating the other. Do not use copied tokens or source inspection as proof of issuer independence. |
| Native work files | Stock positive control and protected native Read/image/edit results in workspace, sibling repos, Downloads, screenshots, temp aliases, configured extra roots and future files. Exact outside file does not grant its sibling. Private-canary reads denied. Check actual tool content, not only process exit. |
| Temp/background | A late file/socket created after the launching parent has exited remains usable. Ordinary temp variables unchanged. Own control socket works; another account's known private control/settings artifacts remain outside native access. |
| Skills/instructions | Existing histories and external readers find sessions; shared relative settings and live non-path edits work. Native discovery and actual skill edit/create/repair work for real directories and external directory links, malformed/new skill files and unused broken links. Preserve documented selected-root-link limit. |
| Identity | Different accounts/environments get distinct stable AIM identity; same owner stays stable across launches. Legacy rotation once; interrupted journal recovery uses the same planned values. Host identifier canaries remain inaccessible to native collection while task tools retain allowed behavior. |
| Diagnostics | Stock collectors demonstrably receive each supported provider/custom diagnostic stream, then protected candidate collectors receive none during startup, model/tools, error, settings reload, native refresh and shutdown. Functional requests continue. Distinguish explicit feedback evidence from automatic errors. |
| Proxy independence | Direct and assigned-route launches have identical privacy controls; assigned missing/wrong route refuses without direct retry. Reuse existing route fixtures; restore only fixture-owned route changes. |
| Real workflows | Existing retained-workflow/integrated-continuity/policy recipes cover shells/builds, process inspection/debugger, background service, nested reviewer, scheduled launch, browser artifact, MCP native login/refresh, SSH/SDK and Mac Keychain integration. No shell substitute for a claimed native file-tool pass. |
| Regression/review | Focused tests during development; lint and full suite once ready on supported isolated hosts. Record skips/failures honestly, fix candidate failures, final independent reviewer reports requirements coverage and any remaining blockers/overbuild. |

Existing recipes to extend: `scripts/privacy-claude-policy-probe.py`,
`scripts/privacy-claude-default-services-probe.py`,
`scripts/privacy-integrated-compatibility-check.mjs`,
`scripts/privacy-integrated-continuity-check.mjs`,
`test/privacy/claude-retained-workflows.mjs`, and
`test/privacy/claude-macos-tool-access.py`. Add focused missing cases rather than
building a general backtesting framework.

## Status and evidence

Plan written; independent code review pending. Product implementation has not
started. The isolated Linux VM is available; the newly rented Mac passed its
clean reboot before product installation, with bounded automatic cleanup.
Implementation/test/review results replace this status as they arrive.
