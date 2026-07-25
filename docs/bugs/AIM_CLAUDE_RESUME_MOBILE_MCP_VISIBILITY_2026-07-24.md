---
title: "AIM Claude resume appeared to omit Mobile MCP"
date: 2026-07-24
status: resolved
owners:
  - aelaguiz
reviewers: []
related:
  - ../aelaguiz/AIM_CLAUDE_AUTOMATIC_USER_CUSTOMIZATIONS_2026-07-24.md
---

# AIM Claude resume appeared to omit Mobile MCP

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** An existing Claude thread resumed through
  `aim claude run <label> opus --resume <session-id>` appeared not to have
  Mobile MCP.
- **Impact:** The operator could not tell whether resumed threads inherited
  newly registered user MCPs.
- **Cause:** No launch defect reproduced. The resumed project has enough
  project MCPs that `/mcp` initially shows only that section; Mobile MCP is
  farther down under **Built-in MCPs (always available)**.
- **Next action:** In `/mcp`, scroll past the project MCP section.
- **Status:** Resolved by exact live reproduction; no code change required.

<!-- bugs:block:tldr:end -->

## Bug North Star

Fresh and resumed AIM-managed Claude launches must load the current user MCP
overlay without sending a model request.

<!-- bugs:block:analysis:start -->

## Analysis

The selected label's generated user-MCP overlay already contained
`mobile-mcp`. AIM's launch builder adds that overlay with `--mcp-config` before
both fresh-launch and resume arguments.

The operator-provided account, working directory, and existing session were
then resumed exactly. Opening `/mcp` showed a large project MCP section and an
`11 more below` marker. Scrolling down showed:

```text
Built-in MCPs (always available)
mobile-mcp · connected · 23 tools
```

No model prompt was sent. The duplicate diagnostic resume exited cleanly, and
the selected account had no remaining lease.

<!-- bugs:block:analysis:end -->

## Scope contract

- **Human-authorized corrected behavior:** Resumed AIM Claude sessions expose
  Mobile MCP.
- **Smallest sufficient fix:** None; the requested behavior already works.
- **Initial minimal convergence closure:** None.
- **Scope freeze:** Do not change launch arguments, session storage, MCP
  merging, or the `/mcp` UI based on a disproved launch failure.
- **Enough proof:** Exact-session resume plus connected-tool evidence.
- **Do not build:** MCP duplication, resume-time migration, or an AIM-specific
  Mobile MCP path.
- **Accepted residual risk:** Claude's `/mcp` list requires scrolling when a
  project contributes many servers.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

No implementation is warranted. Preserve the existing shared launch path for
fresh and resumed sessions.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation and verification

No code changed. Exact live verification passed:

```text
resume: existing operator-provided thread
mobile-mcp: connected, 23 tools
model requests: 0
account lease after exit: none
```

<!-- bugs:block:implementation:end -->
