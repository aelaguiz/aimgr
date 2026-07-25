---
title: "AIM Claude automatic user customizations"
date: 2026-07-24
status: complete
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related:
  - ./AIM_CLAUDE_AUTOMATIC_GLOBAL_PLUGINS_2026-07-24.md
  - ../bugs/AIM_MANAGED_CLAUDE_REPLACES_DEVELOPER_ENVIRONMENT_2026-07-24.md
---

# TL;DR

Every normal `aim claude run` launch must automatically receive the normal
Claude profile's complete user customization surface:

- all user MCP server definitions;
- all user skills;
- all enabled user plugins, including their bundled hooks;
- all user hooks from `~/.claude/settings.json`.

AIM continues isolating each account's credentials, sessions, app state,
project trust, and unrelated settings.

Worklog:
[AIM_CLAUDE_AUTOMATIC_USER_CUSTOMIZATIONS_2026-07-24_WORKLOG.md](./AIM_CLAUDE_AUTOMATIC_USER_CUSTOMIZATIONS_2026-07-24_WORKLOG.md)

## North Star

### Claim

Anything Amir installs or enables as a normal user-level Claude MCP, skill,
plugin, or hook is present on the next AIM-managed Claude launch without a
second AIM list, installation, or per-account configuration step.

### In scope

- Preserve the existing live personal-skills link.
- Preserve the existing launch-time enabled-user-plugin discovery and native
  `--plugin-dir` loading.
- Read all normal user MCP definitions at launch and provide them through
  Claude's native `--mcp-config`.
- Read all normal user hooks at launch and provide them through Claude's native
  `--settings`.
- Permit access to user customization roots explicitly referenced by those
  inherited definitions through the macOS boundary, including hook-owned state
  writes required by the normal hook contract.
- Reflect additions, edits, and removals on the next launch.

### Out of scope

- Sharing Claude credentials, account identity, sessions, transcripts, memory,
  app state, project trust, permissions, theme, model defaults, or arbitrary
  settings.
- An AIM MCP/plugin/hook registry, allowlist, installer, updater, daemon,
  Redis schema, fleet synchronization, or per-account copy command.
- Retrofitting already-running Claude processes.
- Changing project-local MCP, skill, plugin, or hook discovery.
- Changing MCP server authentication protocols or the no-Keychain credential
  design.

### Definition of done

- A managed launch receives every normal user MCP definition and user hook.
- Existing personal skills and enabled plugins remain automatic.
- The bridge contains no normal Claude OAuth, app-state, or unrelated settings.
- Removing the global MCPs or hooks removes the corresponding launch argument
  on the next run.
- Current `browseros` is visible through the generated managed MCP overlay.
- Current normal user hooks can execute through the macOS boundary.
- Focused tests, lint, and the full suite pass before local installation.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: `~/.claude.json` remains Claude's only user-MCP authority. AIM extracts
  its complete `mcpServers` object once per normal managed launch.
- R2: `~/.claude/settings.json` remains Claude's only user-hook authority. AIM
  extracts its complete `hooks` object once per normal managed launch.
- R3: AIM writes private, sanitized overlay files inside the selected managed
  config directory and passes their paths through Claude's native
  `--mcp-config` and `--settings` options. Raw JSON is never placed in argv.
- R4: Empty or absent source objects remove stale overlays and add no native
  option. Malformed source objects fail before launch.
- R5: Only customization fields enter overlays. OAuth/account state and
  unrelated settings never do.
- R6: The existing skills link and enabled-plugin `--plugin-dir` owner remain
  unchanged and are not reimplemented.
- R7: Login-staging remains customization-free.
- R8: On macOS, exact owned customization roots referenced by inherited hooks
  or MCP definitions receive normal access so stateful user hooks still work.
  Protected credential/session roots, the rest of normal Claude state, and
  every other AIM label remain closed. Existing shared skills and plugin
  packages retain their stricter read-only treatment.
- R9: Project and local configuration continue loading through Claude's native
  discovery. No `--strict-mcp-config` is used.
- R10: Every launch recomputes the bridge; no watcher or background refresh is
  added.
- Deterministic launch code and Claude's native options are the correct levers;
  no agent prompt behavior is involved.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: automatically pull all user MCPs, skills, plugins,
  and hooks into every AIM Claude instance.
- Smallest sufficient solution: extend the existing one launch preflight with
  two sanitized native-option overlays; retain the existing skills and plugin
  paths.
- Initial minimal convergence closure: the macOS boundary must admit only
  customization roots referenced by these overlays, because inheriting a hook
  or stdio MCP whose executable or required state is still blocked would create
  a false bridge.
- Scope freeze: the requirements and two phases below are frozen before the
  first implementation edit.
- Enough proof: overlay content/lifecycle tests, exact native argv tests, one
  macOS read/write boundary proof, current-profile BrowserOS/hook smoke, lint,
  and the full suite.
- Do not build: every item in North Star / Out of scope.
- Accepted residual risk: inherited MCPs and hooks execute user-trusted code
  and explicitly referenced hook roots can retain their normal state, exactly
  as normal Claude does; already-running sessions need a restart.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- Claude Code 2.1.219 natively supports `--mcp-config <configs...>` and
  `--settings <file-or-json>` as additive launch options.
- Normal `~/.claude.json` currently contains five user MCP definitions,
  including `browseros`; all ten inspected managed label app-state files
  contain zero user MCP definitions.
- Normal `~/.claude/settings.json` currently contains five user hook commands
  across `SessionStart`, `PostToolUse`, and `Stop`.
- `prepareClaudeCliLaunch` already links normal personal skills, resolves every
  enabled user plugin, and passes plugin directories to Claude.
- AIM sets `CLAUDE_CONFIG_DIR` to the selected label, so normal user MCPs and
  hooks do not otherwise fall through.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`prepareClaudeCliLaunch` owns the managed profile boundary. It shares personal
skills and enabled plugin packages, but deliberately leaves normal user MCPs
and settings behind. The per-label `.claude.json` therefore has no `browseros`,
and the per-label settings contain no normal user hooks.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

The same preflight reads the two normal Claude authorities and materializes
minimal per-label overlay files containing only `mcpServers` and `hooks`.
`runClaudeCli` prepends the native overlay options beside existing
`--plugin-dir` options. The Darwin sandbox profile is materialized with exact
exceptions for owned customization roots referenced by those definitions;
protected profile state remains denied. Linux uses the same overlays without a
sandbox branch.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `src/targets/claude-runner.js` — extract/materialize overlays, resolve
  referenced customization roots, and add native launch arguments.
- `native/claude/no-keychain.sb` — provide template insertion points for exact
  customization roots while retaining protected global state as denied.
- `test/claude/native-storage.test.js` — prove content isolation, lifecycle,
  argv, Linux parity, login-staging exclusion, and Darwin boundary behavior.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Implementation Plan

### Phase 1 — Complete the launch bridge

- Materialize sanitized MCP and hook overlays on each normal preflight.
- Add native overlay arguments beside the existing plugin arguments.
- Extend the Darwin boundary only for referenced owned customization roots.

### Phase 2 — Prove and install

- Prove overlay add/update/remove, sensitive-field exclusion, exact argv,
  Linux parity, login-staging exclusion, and exact Darwin boundary behavior.
- Run a current-profile BrowserOS/hook smoke, focused tests, lint, and the full
  suite.
- Install the proven CLI locally.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

PASS. The requested behavior is implemented at the existing sole managed
launch owner using Claude's native configuration options. The design adds no
second customization registry, installer, watcher, daemon, Redis state, or
general settings merge. Skills and plugins retain their current owners.
Sensitive profile state stays outside the two field-only overlays. The only
adjacent change is the exact read boundary required for inherited hook/MCP
code to function. Scope is frozen.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

PASS.

- R1–R2: every normal launch reads normal Claude's current `mcpServers` and
  `hooks` authorities. The generated files contain only `{mcpServers}` and
  `{hooks}`.
- R3–R5: the overlays are private `0600` files inside the selected label and
  reach Claude through native `--mcp-config` and `--settings`. Tests prove
  OAuth account state, projects, enabled plugins, theme, and other settings do
  not enter either overlay.
- R4: empty source objects remove stale overlays and malformed objects fail
  before launch.
- R6–R7: personal skills and enabled user plugins retain their existing
  implementations; login staging receives none of the four customization
  surfaces.
- R8: Darwin uses a content-addressed sandbox profile whose exact referenced
  customization roots retain normal access. Synthetic parent/child boundary
  proof showed the named root readable and writable while global credentials,
  settings, plugin registry, other labels, and shared skills/plugin packages
  retained their previous isolation.
- R9–R10: no strict MCP mode, watcher, or persistent AIM registry was added;
  project/local native discovery remains intact and every launch recomputes the
  field-only bridge.
- Focused proof: the managed-storage suite passed 33/33; the combined
  managed-storage/projection proof passed 52/52; lint passed.
- Repository proof: the full suite passed 362/362 and `git diff --check`
  passed.
- Live official-client proof: a real managed `pro6` session started without a
  model prompt and `/mcp` displayed `browseros` connected with 23 tools,
  alongside connected `code-review-graph`, `db`, and `gbrain`; `sentry` was
  inherited and truthfully reported that it needs authentication.
- The same live launch received both enabled user plugins, the personal-skills
  link, all five MCP definitions, and all three configured hook event groups.
  It exited cleanly and released the shared account lease.
- Local installation proof: `npm run install:local` refreshed the canonical
  `aim` and `aimgr` wrappers against this checkout.
- Final scope audit: no customization registry, allowlist, installer, updater,
  daemon, Redis state, fleet behavior, general settings merge, credential
  sharing, or session sharing was added.
<!-- arch_skill:block:implementation_audit:end -->
