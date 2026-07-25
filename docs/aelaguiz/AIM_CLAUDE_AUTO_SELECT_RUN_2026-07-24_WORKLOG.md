---
title: "AIM Claude automatic run selection worklog"
date: 2026-07-24
status: complete
plan: ./AIM_CLAUDE_AUTO_SELECT_RUN_2026-07-24.md
---

# Worklog

## Iteration 1 — Scope and implementation

- Confirmed the existing Claude usage collector already owns fresh provider
  usage plus shared Redis lease state.
- Froze selection to usable, unlocked accounts ordered by five-hour usage and
  then label.
- Added label-free Opus/Fable preset parsing without changing explicit-label
  forms.
- Added one pure selector over the canonical usage result.
- Routed the selected label into the existing managed Claude run owner.
- Added no allocation state, retry loop, daemon, model-specific policy, or
  credential behavior.
- The first live selector smoke found that Anthropic marks current five-hour
  windows `active: false` when a different limit is presently binding. The
  selector now treats that flag correctly as limit priority rather than usage
  validity; the focused fixture covers the observed shape.

## Iteration 2 — Proof and local installation

- Focused parser, usage-view, and fake-Redis launch tests: 47/47 passed.
- Lint: passed.
- Full repository suite: 361/361 passed.
- Live read-only selector smoke: eight labels locked, five readable and
  unlocked; selected `claudalyst` at 0%; no Claude process launched.
- Installed the canonical local `aim` and `aimgr` wrappers from this checkout.
- Installed help confirms both `aim claude run (opus|fable) [--resume]` and the
  unchanged explicit-label form.
- Final self-check: implementation remained inside the frozen parser,
  selector, command routing, help, and test surfaces.

## Iteration 3 — Operator-approved model-specific amendment

- Human-approved rule: Fable ranks by Fable/Sonnet weekly-scoped usage; Opus
  preserves the shared five-hour ranking.
- Scope remains frozen to the existing preset parser, pure selector, command
  caller, help text, and focused tests.
- Missing Fable usage will be ineligible rather than treated as zero.
- No Redis, cache, provider-fetch, credential, lease, rotation, status, or
  explicit-label behavior changes are authorized.

## Iteration 4 — Amendment implementation and proof

- Preserved the automatic preset as `fable` or `opus` instead of collapsing
  both to one Boolean.
- Fable now ranks Fable/Sonnet usage, then five-hour usage and label. Opus
  preserves five-hour usage and label.
- Focused tests: 54/54 passed.
- Full suite: 362/362 passed. Lint and `git diff --check`: passed.
- Installed the canonical local wrappers; installed help exposes the exact
  preset-specific ranking rule.
- Scope self-check passed: no changes to provider fetches, Redis, cache,
  credentials, leases, rotation, status, explicit labels, or launch behavior.
