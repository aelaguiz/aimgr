---
title: "AIM Claude recent sessions"
date: 2026-07-24
status: complete
owners:
  - aelaguiz
reviewers: []
fallback_policy: none
related: []
---

# TL;DR

Add exactly two local commands:

```text
aim claude list
aim claude resume <row-or-thread-id>
```

`list` shows the ten most recently used sessions across AIM-managed Claude
account homes. It shows a thread name when Claude persisted one, otherwise the
thread ID, plus the working directory and account label. `resume` reuses the
recorded account and working directory and launches the exact thread with the
existing Opus preset behavior.

Worklog:
[AIM_CLAUDE_RECENT_SESSIONS_2026-07-24_WORKLOG.md](./AIM_CLAUDE_RECENT_SESSIONS_2026-07-24_WORKLOG.md)

## North Star

### Claim

Amir can see and resume his ten newest locally managed Claude sessions without
remembering which AIM account or working directory created them.

### In scope

- List ten recent top-level Claude sessions from local AIM-managed homes.
- Show last-used age, account, thread name-or-ID, and working directory.
- Keep the underlying thread ID in JSON even when a name is displayed.
- Resume by current row number or exact thread ID.
- Resume with the recorded account and directory through the existing managed
  Claude run/lease/rotation path.

### Out of scope

- Cross-machine aggregation or copying sessions between machines.
- A session database, index, daemon, watcher, Redis session records, or cache.
- Rename, delete, search, pagination, configurable limits, model selection, or
  arbitrary resume flags.
- Plain/global `~/.claude` sessions or Claude subagent transcripts.

### Definition of done

- `aim claude list` prints at most ten newest local managed sessions.
- Named threads display the persisted custom or AI title; unnamed threads
  display the exact UUID.
- `aim claude list --json` includes both `threadName` and `threadId`.
- `aim claude resume 1` and `aim claude resume <uuid>` launch the selected
  session from its recorded directory with its recorded account.
- Focused tests prove discovery, ordering, title fallback, row/ID resolution,
  launch wiring, malformed-line tolerance, and failure on missing directories.

<!-- lilarch:block:requirements:start -->
## Requirements and Defaults

- R1: The default list size is exactly ten and has no configuration surface.
- R2: Recency is the newest valid persisted event timestamp, with file mtime
  only as a fallback.
- R3: Thread display precedence is the latest non-empty custom title, then the
  latest non-empty AI title, then the thread UUID.
- R4: The account is the AIM label whose managed home owns the transcript.
- R5: Only top-level `projects/<project>/<uuid>.jsonl` transcripts count.
- R6: Row numbers resolve against a fresh list at invocation time; exact UUIDs
  may resolve an older local session outside the newest ten.
- R7: Resume defaults to the existing Opus shortcut:
  `--dangerously-skip-permissions --model opus --effort max --resume <uuid>`.
- R8: Resume must fail before Redis or Claude launch if the recorded working
  directory no longer exists.
- R9: Listing is local and read-only and does not require Redis.
- Deterministic local code is the correct lever; no model or prompt behavior is
  involved.

Defaults needing no further question were explicitly approved in the preceding
UX mock plus the operator's 2026-07-24 limit amendment: command names, ten rows,
row-or-ID resume, name-or-ID display, account
and directory columns, and Opus resume expansion.
<!-- lilarch:block:requirements:end -->

## Scope and Simplicity Contract

- Human-authorized outcome: the two accepted UX mocks and the instruction to
  make the smallest plan, implement it, and test it.
- Smallest sufficient solution: read Claude's existing per-label JSONL files on
  demand, render ten rows, and route one selected record into the existing run
  function.
- Initial minimal convergence closure: none. No competing AIM session-list or
  Claude-resume owner exists.
- Scope freeze: the requirements and two phases below are frozen before the
  first implementation edit.
- Enough proof: synthetic filesystem discovery tests plus one CLI launch-wiring
  test through the existing fake Claude/Redis boundary.
- Do not build: all items in North Star / Out of scope.
- Accepted residual risk: row numbers can change if a newer session is written
  between `list` and `resume`; exact thread ID is the stable alternative.

<!-- arch_skill:block:research_grounding:start -->
## Research Grounding

- AIM homes are canonically rooted at
  `~/.aimgr/claude-homes/<label>` by `resolveAimgrClaudeLabelHomeDir`.
- Current local Claude 2.1.218 transcripts exist at
  `<label>/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- Empirical files contain `sessionId`, `cwd`, and timestamps. Named sessions
  persist `custom-title`/`customTitle`; automatic titles persist
  `ai-title`/`aiTitle`.
- Installed `claude --help` confirms `--resume [value]` accepts a session ID.
- `handleRedisClaudeRun` already owns account leasing, credential projection,
  exact-client launch, rotation publication, and cleanup.
<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->
## Current Architecture

`aim claude run <label>` computes the label home, captures `process.cwd()`, and
launches Claude through the managed Redis credential path. Claude itself writes
session JSONL under that label's `.claude/projects` tree. AIM currently neither
reads those transcripts nor exposes a resume command.
<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->
## Target Architecture

One small read-only session module owns transcript discovery, metadata parsing,
ordering, rendering, and row/UUID resolution. The Claude command handler owns
the two new subcommands. Resume supplies the resolved directory and existing
Opus arguments to `handleRedisClaudeRun`; all account and credential behavior
remains with the existing run owner.
<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->
## Call-Site Audit

- `src/targets/claude-sessions.js` — new sole local session metadata reader.
- `src/cli/commands/claude.js` — `list`, `resume`, and a narrow launch-directory
  parameter on the existing run path.
- `src/cli/help.js`, `README.md` — advertise the two commands.
- `test/claude/claude-sessions.test.js` — discovery/render/resolution contract.
- `test/cli/redis-projection-command.test.js` — resume reaches the existing
  managed launcher with exact account, directory, and arguments.
<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->
## Implementation Plan

### Phase 1 — Read and resume

- Add the bounded local scanner and table/JSON projection.
- Add `aim claude list` and `aim claude resume <row-or-thread-id>`.
- Reuse the existing managed Claude run path with a validated directory
  override and the fixed Opus resume arguments.

### Phase 2 — Prove and expose

- Add focused filesystem and CLI launch-wiring tests.
- Update help and README.
- Run focused tests, lint, full suite, and a read-only live `aim claude list`.
<!-- arch_skill:block:phase_plan:end -->

<!-- lilarch:block:plan_audit:start -->
## Plan Audit

PASS. The plan has two phases and every item maps directly to the approved UX.
It reuses Claude's native transcript and resume capabilities plus AIM's existing
run owner. It adds no persistence, background process, remote behavior, generic
session framework, or new credential path. The only residual race is explicitly
covered by stable UUID resume. Scope is frozen.
<!-- lilarch:block:plan_audit:end -->

<!-- arch_skill:block:implementation_audit:start -->
## Implementation Audit

PASS.

- R1–R6: `src/targets/claude-sessions.js` reads only top-level managed Claude
  transcripts, derives recency/name/account/directory directly from them,
  returns ten rows, and resolves a fresh row or any exact UUID.
- R7–R9: `src/cli/commands/claude.js` keeps list local and Redis-free, validates
  the selected directory before Redis, then calls the existing managed run path
  with the recorded account/cwd and exact Opus resume arguments.
- Focused proof: 22/22 tests passed, including malformed-line tolerance,
  custom/AI/UUID title precedence, row and older-UUID resolution, JSON fields,
  exact launcher wiring, and pre-Redis failure for a missing directory.
- Repository proof: lint passed; full suite passed 355/355.
- Live read-only proof: the repository CLI returned all nine real local
  managed sessions currently discoverable, exceeding the prior five-row cap
  and remaining below the new ten-row ceiling; its JSON returned nine valid
  records with both `threadName` and `threadId`.
- Final scope audit: no database, index, cache, daemon, watcher, Redis session
  state, remote access, cross-machine aggregation, search, pagination, rename,
  delete, or generalized session manager was added.
<!-- arch_skill:block:implementation_audit:end -->
