---
title: "AIM Claude automatic global plugins"
date: 2026-07-24
status: complete
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related: []
---

# TL;DR

Every normal, non-login-staging `aim claude run <label>` launch will
automatically load the user-scoped Claude plugins that are enabled in the
machine's normal `~/.claude` profile. AIM will read Claude's existing settings
and installed-plugin registry at launch time, pass each resolved package
through Claude's native repeatable `--plugin-dir`, and retain the existing
credential isolation.

There is no AIM plugin list, plugin installer, updater, or per-account plugin
state to maintain.

Worklog:
[AIM_CLAUDE_AUTOMATIC_GLOBAL_PLUGINS_2026-07-24_WORKLOG.md](./AIM_CLAUDE_AUTOMATIC_GLOBAL_PLUGINS_2026-07-24_WORKLOG.md)

## North Star

### Claim

A plugin enabled for normal Claude on a machine is present on the next
AIM-managed Claude launch on that machine, including its bundled hooks and
skills, without weakening account credential isolation.

### In scope

- Read normal Claude's `enabledPlugins` and user-scoped installed-plugin
  records once during each managed launch preflight.
- Pass those package directories to the official client with native
  `--plugin-dir` arguments.
- Permit read-only access to those package directories through AIM's macOS
  sandbox while keeping global Claude settings and credentials inaccessible to
  the child.
- Mirror the existing zero-byte `.i-have-adhd-always` preference into the
  selected managed profile when that plugin is enabled.
- Apply the same discovery and native arguments on macOS and Linux.

### Out of scope

- An AIM plugin allowlist, manifest, registry, command, UI, installer, updater,
  or per-account plugin copy.
- Copying or distributing plugins between machines.
- Inheriting global Claude settings, MCP configuration, credentials, or
  arbitrary plugin preference files.
- Changing plugin packages, marketplace state, or normal Claude's profile.
- Retrofitting an already-running Claude process; restart is required.

### Definition of done

- Enabling, disabling, installing, updating, or uninstalling a normal
  user-scoped Claude plugin changes the next AIM-managed launch without an AIM
  code or configuration change.
- Exact repeated `--plugin-dir` arguments reach the official client before the
  user's existing launch arguments.
- Disabled plugins, non-user installs, and stale registry records do not load.
- macOS sandbox proof shows enabled plugin packages are readable but not
  writable, while global settings and credentials remain unreadable.
- The ADHD plugin's real SessionStart hook emits its always-on context from an
  isolated AIM profile without touching the normal profile.
- Focused tests, lint, and the full suite pass before local installation.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: Normal Claude's `~/.claude/settings.json` `enabledPlugins` map and
  `~/.claude/plugins/installed_plugins.json` are the only plugin-selection
  authority. AIM owns no second list.
- R2: Only entries explicitly enabled with `true` and installed with
  `scope: "user"` load.
- R3: AIM uses Claude's native repeatable `--plugin-dir <installPath>` option.
- R4: Plugin paths must resolve to owned, non-symlinked directories inside the
  normal profile's `~/.claude/plugins/cache`; unsafe or contradictory enabled
  state fails before launch without printing filesystem contents.
- R5: Missing settings or registry files mean no inherited plugins. Malformed
  files or an enabled plugin without one unambiguous user install fail closed.
- R6: Discovery order is deterministic by plugin ID.
- R7: macOS grants the child read-only package-cache access only. Global
  settings, credentials, registry, and all global Claude writes stay blocked.
- R8: The global `.i-have-adhd-always` file is mirrored as an empty file inside
  the selected profile only while `i-have-adhd@i-have-adhd` is enabled.
- R9: Fresh login-staging launches remain plugin-free.
- R10: Existing sessions are unchanged; the next managed launch reflects the
  current normal-Claude plugin state.
- Deterministic local code is the correct lever; no daemon, model behavior, or
  Redis state is involved.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: automatically make normal Claude's installed and
  enabled marketplace plugins work in isolated AIM Claude profiles, implement
  and test it, then install locally, commit, and push.
- Smallest sufficient solution: resolve Claude's two existing local metadata
  files during preflight and add native `--plugin-dir` arguments.
- Initial minimal convergence closure: the existing personal-skills symlink
  remains unchanged; plugin packages and hooks have no current AIM owner.
- Scope freeze: the requirements and two phases below are frozen before the
  first implementation edit.
- Enough proof: deterministic metadata/argv tests, the existing macOS sandbox
  boundary test, and a contained execution of the real ADHD hook through its
  installed plugin package.
- Do not build: every item in North Star / Out of scope.
- Accepted residual risk: a plugin enabled by the user executes third-party
  code in managed sessions, exactly as it does in normal Claude; generic plugin
  preferences beyond the one requested ADHD marker are not inherited.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- Normal Claude 2.1.219 has repeatable `--plugin-dir <path>` support documented
  as session-only plugin loading.
- The current normal profile enables
  `i-have-adhd@i-have-adhd` and
  `rust-analyzer-lsp@claude-plugins-official`; their user-scoped package paths
  are recorded in Claude's version-2 installed-plugin registry.
- AIM preserves the real user `HOME` but sets `CLAUDE_CONFIG_DIR` and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` to one managed label profile.
- AIM's macOS sandbox currently exposes only normal Claude's personal skills
  directory and blocks the rest of `~/.claude`.
- The ADHD plugin's SessionStart hook reads
  `$CLAUDE_CONFIG_DIR/.i-have-adhd-always`, so package loading alone is
  insufficient for the requested always-on behavior.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`prepareClaudeCliLaunch` validates the installed client and managed label
topology and links personal skills. `runClaudeCli` then launches through one
supervisor and, on macOS, one sandbox profile. The isolated profile sees neither
normal Claude's enabled-plugin settings nor its package cache, so marketplace
plugins and their hooks disappear.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

The existing launch preflight becomes the sole plugin bridge: it resolves
enabled user plugin package directories, synchronizes the one requested ADHD
preference, and returns immutable launch metadata. The existing runner prepends
native `--plugin-dir` pairs. The sandbox exposes only the package cache as a
read-only code source. Claude remains the plugin loader; AIM adds no plugin
subsystem.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `src/targets/claude-runner.js` — discover enabled user plugins, validate
  package paths, synchronize the ADHD marker, and add native launch arguments.
- `native/claude/no-keychain.sb` — add the exact read-only package-cache
  exception.
- `test/claude/native-storage.test.js` — metadata, preference, argv, Linux, and
  macOS sandbox boundary proof.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Implementation Plan

### Phase 1 — Bridge normal plugins into managed launches

- Add strict launch-time discovery of enabled user-scoped packages.
- Add repeated native `--plugin-dir` arguments for normal managed launches.
- Mirror the ADHD always-on marker and expose only package-cache reads on
  macOS.

### Phase 2 — Prove and publish

- Prove discovery, launch arguments, login-staging exclusion, marker lifecycle,
  Linux behavior, and macOS read/write isolation.
- Run focused tests, lint, the full suite, and a contained real-plugin hook
  smoke.
- Install the proven repository CLI locally, commit only intended AIM changes,
  and push `main`.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

PASS. The plan adds one launch-time adapter around Claude's existing metadata
and native plugin loader. It introduces no new state owner, list, installer,
updater, daemon, Redis record, remote behavior, or generalized preference
framework. The only plugin-specific behavior is the exact always-on marker
required by the reported ADHD plugin. Scope is frozen.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

PASS.

- R1–R6: `resolveEnabledClaudeUserPlugins` reads only normal Claude's enabled
  map and installed-plugin registry, filters exact user scope, validates
  canonical cache-contained directories, and sorts by plugin ID. It owns no
  plugin list or state.
- R7: the macOS sandbox exposes the global plugin cache for reads while its
  existing global-Claude write denial remains intact. The real boundary test
  proves the package is readable and not writable while settings, the plugin
  registry, and credentials remain unreadable.
- R8: the exact ADHD always-on marker is mirrored as a private empty file in
  the selected profile and removed when the global preference or plugin is not
  active.
- R9–R10: login staging returns no plugin directories or preference projection;
  every normal preflight resolves current state again. Both Darwin and Linux
  runners prepend the same repeatable native arguments.
- Focused proof: `test/claude/native-storage.test.js` passed 32/32, including
  discovery/filtering, unsafe-state rejection, marker lifecycle, exact Darwin
  and Linux argv, login-staging exclusion, and the real macOS read/write
  boundary.
- Repository proof: lint passed and the full suite passed 359/359.
- Real-client proof: the installed official Claude client ran inside AIM's
  sandbox from a disposable managed profile, automatically received both
  globally enabled plugin directories, reported `i-have-adhd` v0.1.0 with one
  skill and one SessionStart hook, observed the isolated always-on marker, and
  exited 0 without a model request.
- Local deployment proof: `npm run install:local` installed `aim` and `aimgr`
  wrappers targeting this checkout; the post-install real-client smoke repeated
  successfully and removed its disposable profile.
- Post-proof scope review: PASS with no correctness/security blockers and no
  concrete overbuilding.
- Final scope audit: no plugin manifest, allowlist, installer, updater, daemon,
  Redis state, settings inheritance, per-account plugin copy, remote operation,
  or generic preference framework was added.
<!-- arch_skill:block:implementation_audit:end -->
