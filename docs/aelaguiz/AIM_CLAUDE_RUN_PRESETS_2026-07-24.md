---
title: "AIM Claude run presets"
date: 2026-07-24
status: complete
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related:
  - ../bugs/AIM_MANAGED_CLAUDE_MISSING_SHARED_USER_SKILLS_2026-07-24.md
---

# TL;DR

Make the common managed-Claude launch a one-liner:

```text
aim claude run <label> opus [--resume]
aim claude run <label> fable [--resume]
```

`opus` means `--dangerously-skip-permissions --model opus --effort max`.
`fable` means `--dangerously-skip-permissions --model claude-fable-5 --effort
xhigh`. This is local-only publication; no remote or fleet work.

Worklog: [AIM_CLAUDE_RUN_PRESETS_2026-07-24_WORKLOG.md](./AIM_CLAUDE_RUN_PRESETS_2026-07-24_WORKLOG.md)

## North Star

### Claim

The two common managed-Claude configurations launch through memorable preset
names without weakening AIM's existing account, containment, rotation, or
argument-boundary behavior.

### In scope

- Parse `opus` or `fable` immediately after the Claude account label.
- Expand the preset into the exact Claude arguments above.
- Accept an optional trailing `--resume` through the same one-line form.
- Preserve the existing explicit `-- <claude args...>` form.
- Add focused CLI coverage and install the result locally.

### Out of scope

- More presets, user-defined presets, configuration files, aliases, shell
  functions, model discovery, interactive selection, remote rollout, fleet
  publication, commit, or push.

### Definition of done

- Both one-line forms reach the existing managed runner with exact argv.
- Optional `--resume` is preserved.
- Existing explicit passthrough remains valid.
- Focused tests, full tests, and lint pass.
- The canonical local `aim` installation uses the change.

<!-- lilarch:block:requirements:start -->

## Requirements

- `opus` expands to:
  `--dangerously-skip-permissions --model opus --effort max`.
- `fable` expands to:
  `--dangerously-skip-permissions --model claude-fable-5 --effort xhigh`.
- A trailing `--resume` is passed to Claude after the preset expansion.
- Unsupported preset words fail clearly before Redis or launch work.
- No behavior changes for callers using `aim claude run <label> -- ...`.

### Defaults and non-requirements

- Preset names are exact lowercase literals.
- The preset owns model and effort; this feature does not add override or merge
  rules.
- No compatibility fallback or generic preset framework is authorized.

### Scope and Simplicity Contract

- **Human-authorized outcome:** the one-line `opus`/`fable` launch syntax,
  optional `--resume`, tests, and local publication requested on 2026-07-24.
- **Smallest sufficient solution:** one parser normalization at the existing
  Claude-run argument boundary plus focused tests/help only if that surface is
  already authoritative.
- **Initial minimal convergence closure:** none. The existing explicit
  passthrough remains the sole launch-argument owner.
- **Scope freeze:** frozen before implementation on 2026-07-24.
- **Enough proof:** exact argv assertions for both presets, resume, and legacy
  passthrough; repository checks; installed local command.
- **Do not build:** configuration, extra aliases, dynamic presets, new runner
  layers, remote deployment, or unrelated cleanup.
- **Accepted residual risk:** future Claude model aliases may require changing
  these two literals.

<!-- lilarch:block:requirements:end -->

## Clarifying questions

None. The requested spellings, expansions, optional flag, and publication
boundary are explicit.

<!-- arch_skill:block:research_grounding:start -->

## Research grounding

- `src/cli/args.js::parseArgs` is the one raw-argv parser. It already converts
  everything after `--` into `opts.afterDoubleDash`.
- `src/cli/commands/claude.js::handleRedisClaudeRun` passes that array unchanged
  to `runClaudeCliImpl`.
- `src/cli/help.js` and the README target-projection block are the existing
  human command references.
- `test/claude/claude-01.cases.js` covers help/CLI behavior, while
  `test/cli/redis-projection-command.test.js` already proves explicit Claude
  passthrough reaches the runner unchanged.

<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->

## Current architecture

`parseArgs` treats ordinary words as positional arguments and only recognizes
Claude child arguments after an explicit `--`. Therefore `opus` is currently
an ignored fourth positional, while bare `--resume` is interpreted as AIM's
Codex resume option and requires a session UUID.

<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->

## Target architecture

Before generic parsing, recognize only the exact raw prefix
`claude run <label> opus|fable`. Rewrite it to the existing explicit
passthrough representation with the fixed preset argv followed by the remaining
raw arguments. The rest of parsing and the entire managed-Claude runtime stay
unchanged. Reject any unrecognized fourth positional on `claude run` so a typo
cannot silently launch the wrong configuration.

<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->

## Call-site audit

- `src/cli/args.js::parseArgs`: add the two-literal normalization.
- `src/cli/commands/claude.js::handleClaude`: fail loudly on an unrecognized
  fourth positional before Redis or launch work.
- `src/cli/help.js` and `README.md`: show the two one-line forms while retaining
  the explicit passthrough form.
- `test/claude/claude-01.cases.js`: assert exact expansions, resume preservation,
  typo rejection, and help.
- No changes to `handleRedisClaudeRun`, `runClaudeCli`, credentials, Redis,
  fences, containment, maintenance, login, or fleet tooling.

<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->

## Phase plan

### Phase 1 — CLI normalization and contract

- Add the two fixed expansions at the existing parser boundary.
- Reject unknown fourth positionals for Claude run.
- Update the existing help and README command surfaces.
- Add focused parser/help/error tests.

### Phase 2 — Proof and local publication

- Run the focused Claude CLI tests, lint, and full suite.
- Self-audit the diff against the frozen scope.
- Run `npm run install:local` and smoke-check the installed `aim` help.

<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->

## Plan audit

**PASS.** Every phase item maps directly to the requested one-line UX, optional
resume behavior, testing, or local publication. Reusing `afterDoubleDash`
preserves one launch-argument owner and requires no convergence work. A map,
configuration layer, new command object, shell alias, runner wrapper, or fleet
change would be unauthorized overbuilding. Scope is frozen.

<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->

## Implementation audit

**PASS — complete and locally installed.**

- `parseArgs` recognizes only the exact `opus` and `fable` positions and
  rewrites them into the existing `afterDoubleDash` owner.
- `handleClaude` rejects an unrecognized fourth positional before Redis access.
- No runner, credential, Redis, rotation, containment, login, or remote code
  changed.
- Focused CLI/Redis/README checks: 34 tests, 34 pass.
- Full suite: 350 tests, 350 pass.
- Lint and `git diff --check`: pass.
- `npm run install:local`: pass; `/Users/aelaguiz/.local/bin/aim` shows both the
  preset and explicit forms.
- Scope audit: no generic preset framework, config, extra aliases, fleet
  publication, commit, or push was added.

<!-- arch_skill:block:implementation_audit:end -->
