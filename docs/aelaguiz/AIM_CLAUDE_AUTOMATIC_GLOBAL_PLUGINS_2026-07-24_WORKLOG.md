---
title: "AIM Claude automatic global plugins worklog"
date: 2026-07-24
status: complete
plan: ./AIM_CLAUDE_AUTOMATIC_GLOBAL_PLUGINS_2026-07-24.md
---

# Worklog

## Iteration 1 — Scope frozen

- Confirmed normal Claude's canonical user plugin state:
  `settings.json` enables plugin IDs and the version-2 installed-plugin
  registry maps them to user-scoped package directories.
- Confirmed the official 2.1.219 client supports repeatable
  `--plugin-dir <path>` arguments.
- Confirmed AIM isolates `CLAUDE_CONFIG_DIR`, shares only personal skills, and
  blocks the global plugin cache in the macOS sandbox.
- Confirmed the ADHD plugin's real SessionStart hook additionally requires an
  empty `.i-have-adhd-always` marker in the selected config directory.
- Froze the smallest design: launch-time discovery, native plugin arguments,
  one read-only sandbox exception, and the requested ADHD marker mirror.
- No implementation files changed in this iteration.

## Iteration 2 — Minimal bridge implemented

- Added launch-time resolution of exact enabled, user-scoped plugin packages
  from normal Claude's existing settings and installed-plugin registry.
- Added deterministic native `--plugin-dir` arguments to the existing Darwin
  and Linux runner paths.
- Added the package-cache read exception to the existing macOS sandbox; global
  Claude writes and metadata reads remain denied.
- Added the exact ADHD always-on preference mirror to the selected managed
  profile. Login staging remains plugin-free.
- Self-check: implementation stayed inside the three frozen call sites and did
  not add a list, configuration surface, daemon, Redis state, or per-account
  plugin install.

## Iteration 3 — Proof and local install

- Focused native-storage and sandbox tests: 32/32 passed.
- Lint: passed.
- Full repository suite: 359/359 passed.
- Contained real-client proof: official Claude loaded two globally enabled
  package directories through the AIM sandbox and reported the real ADHD skill
  plus SessionStart hook; the managed marker existed; exit status was 0; no
  model request was made.
- Installed the repository's canonical `aim` and `aimgr` wrappers locally.
- Repeated the contained real-client proof through the installed checkout with
  the same result and removed the disposable profile.
- A clean post-proof review found no correctness/security blocker and no
  overbuilding relative to the frozen goal.
