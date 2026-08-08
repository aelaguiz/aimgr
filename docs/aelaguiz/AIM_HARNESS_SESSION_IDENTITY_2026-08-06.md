---
title: "AIM Harness Session Identity"
date: 2026-08-06
status: active
owners: [Amir]
reviewers: []
fallback_policy: none
related:
  - ../../README.md
  - ../../../prime-agent/packages/coding-agent/docs/extensions.md
  - ../../../prime-agent/packages/coding-agent/docs/session-format.md
---

# TL;DR

Turn the manually installed Pi/Prime `session-title-footer` into an AIM-owned,
automatically installed session-identity extension. Every unnamed session gets
a useful work-derived name without `/rename`, every new session receives a
visible color that is written into its own session log, and exact resumes or
work-continuation forks retain both identity fields.

Worklog:
[AIM_HARNESS_SESSION_IDENTITY_2026-08-06_WORKLOG.md](./AIM_HARNESS_SESSION_IDENTITY_2026-08-06_WORKLOG.md)

## North Star

### Claim

A user running many AIM-managed Pi or Prime agents can identify a session from
its persistent colored identity banner and useful automatic name, including
after detaching and resuming, without manually naming every thread.

### In scope

- Preserve the existing `title · account · branch · cwd` identity line.
- Automatically name an unnamed session from Prime's native persisted agent
  recap when available, with a compact first-user-request fallback for Pi and
  before the first Prime recap exists.
- Choose one readable banner color for a new session and persist it as
  extension-owned session metadata.
- Preserve a human `/rename`/`/name` override and never replace it later.
- Make the extension a reviewed AIM asset and project it into both managed
  harness homes on `aim pi use`, `aim prime use/run`, and Prime launch/resume.
- Validate pure naming/state/render behavior, safe installation, extension
  loading, and live new/resumed terminal behavior.

### Out of scope

- A cross-process color reservation service or guarantee that 12 simultaneous
  sessions never share a color.
- New Pi/Prime daemon protocol, Prime source changes, a settings UI, Redis
  session metadata, remote session aggregation, or a generic extension manager.
- Extra model calls solely to generate a title.
- Rewriting titles continuously as the task evolves.

### Definition of done

1. A new unnamed session shows the identity banner immediately and acquires a
   compact name from its first request without a rename command.
2. When Prime's existing AI recap becomes available, a still-unmodified
   fallback title may improve once; a human title always wins.
3. The session JSONL contains the chosen color and automatic-title metadata;
   reloading/resuming renders the same name and color.
4. Both Pi and daemon-backed Prime load the same managed extension, while an
   unrelated file at the managed destination is not silently overwritten.
5. Focused tests, lint, the full AIM suite, extension loader checks, and a live
   terminal new/resume proof pass.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: AIM owns one provider-neutral extension asset. The runtime package loader
  remains the extension authority; AIM only projects the asset into the normal
  global extension location.
- R2: The banner is always present. Before a request it says that it is waiting
  for the first prompt rather than hiding or requiring `/rename`.
- R3: Automatic title precedence is: existing human session name; latest
  non-empty Prime `agent_status` recap; compact first user request. The prompt
  fallback may upgrade once to the first usable recap only while the current
  name still exactly equals AIM's prior automatic title.
- R4: Automatic names are single-line, bounded, and stripped of command or
  conversational opener noise. Naming failures leave the session usable.
- R5: A color is selected from a fixed readable palette only when no valid
  AIM identity-state entry exists, then appended to the session as custom
  metadata. Resume/reload/fork restores that stored color.
- R6: The colored title pill plus account, branch, and cwd render through
  `setWidget(..., { placement: "belowEditor" })`, the path already proven to
  bridge daemon-backed Prime sessions. Terminal/tab title mirrors the name.
- R7: Prime prefers the session-pinned credential binding; both runtimes fall
  back to the configured AIM binding without exposing credential material.
- R8: The extension is installed atomically. AIM may adopt the exact legacy
  session-identity extension it previously created, but refuses to overwrite
  unrelated content at that path.
- R9: No extra title-generation model request, daemon service, Redis write, or
  compatibility shim is introduced.
- Deterministic extension code plus Prime's existing native recap capability is
  the correct lever; prompt changes to the working agent are not required.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: always-visible useful session titles and durable
  per-session colors for many parallel Pi/Prime agents, with implementation and
  proof rather than a completion claim based on inspection.
- Authorization anchors: the user's request in this thread and the existing
  manually installed `~/.pi/agent/extensions/session-title-footer.ts` and
  `~/.prime/agent/extensions/session-title-footer.ts`.
- Smallest sufficient solution: one AIM-managed extension asset, one atomic
  projection helper, and existing harness launch/use call sites.
- Initial minimal convergence closure: replace the two manually maintained
  copies with the same repo-owned projection so the exact identity contract has
  one source. No Prime/Pi source fork is needed.
- Scope freeze: R1-R9 and the two phases below are frozen before implementation.
- Enough proof: pure behavior tests, installer conflict/idempotence tests,
  current Pi and Prime loader validation, full AIM checks, and a controlled live
  terminal showing the same persisted identity before and after resume.
- Do not build: every item in North Star / Out of scope.
- Accepted residual risk: palette collisions remain possible; prompt-derived
  names are intentionally compact rather than semantically perfect when Prime
  has no usable native recap.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- The existing global extensions were created in an earlier AIM session to show
  `title`, AIM account, git branch, and cwd. Prime had to move from `setFooter`
  to `setWidget` because the daemon bridge intentionally does not carry custom
  footer factories.
- Both extension APIs expose `pi.appendEntry`, `pi.setSessionName`,
  `pi.getSessionName`, the `input`/session lifecycle events, and the below-editor
  widget surface.
- Session names persist as `session_info` entries. Extension state persists as
  `custom` entries and is explicitly excluded from model context.
- Prime already persists cheap AI-generated `agent_status.summary` recaps. That
  native output is a better title source than adding a second model call.
- Prime `forkFrom` copies ordinary session history, so extension identity state
  naturally follows continuity forks; exact resume reads the same JSONL.
- AIM's `handleUse` already resolves the exact Pi/Prime agent directory, and
  every AIM Prime run/resume crosses the existing `runPrimeLauncher` boundary.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

The identity feature exists only as two mutable home-directory files. Prime's
copy polls a plain below-editor widget; Pi's copy replaces the footer. Both show
`untitled` until a person names the session. Neither color nor title policy is
stored as extension state, and no AIM command repairs or installs the files on
another machine.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

`native/harness/session-title-footer.js` is the single extension source and is
valid JavaScript when installed with the existing `.ts` filename. It restores
or appends one versioned identity record, applies the title precedence rules,
renders an ANSI-colored title pill through the shared widget surface, and keeps
account/branch/cwd current. `src/targets/harness-session-identity.js` atomically
projects that asset into the resolved target home and protects unrelated files.
Harness use and Prime launcher paths call that owner before the target starts.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `native/harness/session-title-footer.js` — canonical runtime behavior.
- `src/targets/harness-session-identity.js` — safe idempotent projection.
- `src/cli/commands/harness-target.js` — install after selection is known and
  before provider projection; ensure again at the Prime launch boundary.
- `test/pi/session-identity-extension.test.js` — naming, state, rendering,
  event, and projection proof for Pi and Prime-shaped contexts.
- `test/pi/prime-target.test.js` — command-boundary projection assertions.
- `README.md` — document automatic identity behavior and persistence boundary.
- The manually installed home-directory files are deployment outputs, not a
  second source and not committed.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Implementation Plan

### Phase 1 — Make session identity automatic and persistent

- Add the provider-neutral extension with bounded title derivation, native recap
  adoption, manual-override detection, versioned color/title state, colored
  widget rendering, terminal title updates, and existing account/branch/cwd.
- Add atomic managed projection with legacy adoption and unmanaged-conflict
  refusal; connect it to Pi/Prime use and Prime launch/resume.

### Phase 2 — Prove behavior and deploy locally

- Add pure and command-boundary regression tests, including different random
  colors, stored-color restoration, prompt-to-recap upgrade, manual override,
  idempotent install, legacy adoption, and conflict refusal.
- Run focused tests, lint, the full suite, both installed runtime loaders, and a
  controlled live terminal new/resume proof; only then install the proven asset
  into the real Pi/Prime homes and record exact receipts.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

PASS. Every phase item maps to R1-R9 or the pre-freeze convergence closure. The
plan reuses Prime's native persisted recap and both runtimes' native extension
state/name APIs instead of inventing a model call, daemon, or external state
owner. One asset removes the current split ownership. The proof includes the
actual daemon-widget and resume path, not only mocked rendering. Scope is
frozen; no post-freeze reviewer may add product behavior.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

Pending implementation and proof.
<!-- arch_skill:block:implementation_audit:end -->
