---
title: "AIM Claude automatic user customizations worklog"
date: 2026-07-24
status: complete
plan: ./AIM_CLAUDE_AUTOMATIC_USER_CUSTOMIZATIONS_2026-07-24.md
---

# Worklog

## Iteration 1 — Grounding and scope freeze

- Confirmed normal Claude owns five user MCP definitions, including
  `browseros`, while all ten inspected AIM label profiles own none.
- Confirmed normal Claude owns five user hook commands across `SessionStart`,
  `PostToolUse`, and `Stop`.
- Confirmed Claude 2.1.219 exposes native additive `--mcp-config` and
  `--settings` options.
- Kept the existing personal-skills link and enabled-plugin discovery as their
  authoritative implementations.
- Confirmed the current model-fallback hook writes bounded heartbeat/state
  beside its globally configured script, so read-only access would falsely
  claim hook parity.
- Froze implementation to two field-only launch overlays plus exact Darwin
  access for referenced customization roots; protected profile state remains
  denied.

## Iteration 2 — Implementation and proof

- Added private, field-only user-MCP and user-hook overlays refreshed during
  each normal managed launch.
- Added Claude's native `--mcp-config` and `--settings` options beside the
  existing native plugin arguments.
- Added content-addressed Darwin profiles that admit only owned customization
  roots referenced by those exact definitions. Shared skills and plugin
  packages remain read-only; normal settings, credentials, sessions, other AIM
  labels, and unrelated state remain closed.
- Added deterministic add/update/remove, malformed-input, sensitive-field
  exclusion, exact-argv, Linux parity, login-staging, and Darwin boundary
  coverage.
- `claude mcp get` was not accepted as runtime proof because that management
  subcommand ignores session-only `--mcp-config`. A real interactive managed
  session was used instead.
- Live no-model proof in `pro6`: `/mcp` displayed `browseros` connected with 23
  tools, plus connected `code-review-graph`, `db`, and `gbrain`; `sentry` was
  inherited and required its existing authentication step.
- Focused managed-storage suite: 33/33 passed.
- Combined managed-storage/projection proof: 52/52 passed.
- Lint: passed.
- Full repository suite: 362/362 passed.
- Static and generated macOS sandbox profiles parsed and enforced the expected
  boundary.
- Canonical local wrappers were refreshed with `npm run install:local`.
- Final self-check: all implementation remains inside launch-time
  customization projection and its required boundary; no second configuration
  authority or background machinery was added.
