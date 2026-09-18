---
title: "AI Manager Agent Skill (`aimgr`) - Mini Architecture Plan"
date: 2026-09-17
status: active
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: [skill-authoring]
doc_type: new_capability
related:
  - README.md
  - AGENTS.md
  - src/cli.js
  - src/status/claude-redis-view.js
  - src/targets/claude-cli.js
  - src/targets/codex-cli.js
  - ~/workspace/herdr/skills/herdr/SKILL.md (packaging precedent)
  - https://github.com/vercel-labs/skills (`npx skills`)
---

# TL;DR

- **Outcome:** This repo ships its own agent skill at `skills/aimgr/`, teaching an agent the three things it needs from AI Manager: launch a session, see which accounts are available, and pick an available one when the others are busy or limited. Installed globally with `npx skills add aelaguiz/aimgr -g -a '*'`.
- **Problem:** Amir tells agents "use AI Manager to launch Claude, Codex, Sol, Opus, Fable," and they don't know how. No skill on this machine shows a single `aim` command, so agents guess: bare `claude`/`codex`, or they grep this repo, or they ask.
- **Approach:** Prompt-only, packaged the canonical way. `npx skills` (Vercel Labs, v1.7.0, already in use on this machine) discovers `skills/<name>/SKILL.md` at a repo root, materializes it in the canonical store `~/.agents/skills/`, and symlinks it into every agent's directory. `~/workspace/herdr` already does exactly this — `herdrdev/herdr` is a live entry in this machine's `~/.agents/.skill-lock.json`. aimgr follows the same shape.
- **Plan:** Phase 1 authors `skills/aimgr/` (SKILL.md + two references). Phase 2 packages and installs: README section, local-path verification, push, global install from GitHub, trigger validation.
- **Non-negotiables:** Basics only — launch, availability, selection. No credential, enrollment, Redis-admin, routine, or Pi/Hermes/OpenClaw content. No scripts. Everything lands in this repo; `~/workspace/arch_skill` is reference for conventions only and is never written to.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
north_star_gate: pass 2026-09-17
research_grounding: done 2026-09-17 (live CLI probe, aimgr source anchors, npx skills probe, herdr precedent)
external_research_grounding: done 2026-09-17 (narrow: skill packaging standard)
current_and_target_architecture: done 2026-09-17
call_site_audit: done 2026-09-17
phase_plan: done 2026-09-17
scope_signoff: signed off 2026-09-17 at the ready verdict
recommended_flow: mini plan -> miniarch-step implement <DOC_PATH>
note: Planning-only. No skill files were written by this pass.
-->
<!-- arch_skill:block:planning_passes:end -->

# North Star

**Claim.** An agent told "use AI Manager to launch a Codex session" does it correctly on the first try, from the skill alone, without reading this repo.

**In scope.** Three operations and their failure shapes:

1. **Launch a session** on Codex, Claude, Prime, or Grok through `aim`.
2. **See what is available** — read `aim claude status`, `aim status --accounts`, `aim grok status`.
3. **Choose an available account** when the preferred one is busy, limited, or needs a human.

Plus the packaging and install path that makes it reachable on every machine.

**Out of scope.** Credential enrollment and capture, `aim login`, Redis administration, browser bindings, Sakana keys, `aim credential-helper`, routines and scheduling, Pi/Hermes/OpenClaw target management, `aim rebalance`.

**Definition of done.** `npx skills add aelaguiz/aimgr -g -a '*'` installs the skill; `~/.agents/skills/aimgr/` exists with `~/.claude/skills/aimgr` symlinked to it; `~/.agents/.skill-lock.json` records the source; three representative asks trigger it and produce a correct command without the agent reading this repo.

**Invariants.**

- **I1.** Account choice happens **before** launch, from a status read. The skill teaches the pre-flight, not a reaction to a failure.
- **I2.** Prompt-only. Zero scripts, zero wrappers, zero state files.
- **I3.** The skill never instructs an agent to run `aim login` or any credential, enrollment, or Redis-write command. Those are human actions.
- **I4.** The skill owns *how to run `aim`*. It never decides *whether* to spawn a worker.
- **I5.** Every file created or modified by this plan is inside `~/workspace/aimgr`.

# Scope and Simplicity Contract

**Human-authorized outcome.** Amir, 2026-09-17: *"they don't need to know how to do the most complex parts of AI Manager. They basically need to know how to use it to launch a session, how to get an available account, and how to choose an account that's available. If the others are rate-limited, that's it."* Then: *"this is not a rotation doctrine this is literally just a how to use arch aimgr skill, thats it."* Then: *"everything goes in AI Manager. Nothing goes in arch_skill. arch_skill is just for reference not for writing to... research what the best way is. There's probably an NPX skill installer... figure out what the most canonical way right now to build skill packaging is and plan to use that."*

**Authorization anchors.** The three verbatim asks above. "That's it" is a hard ceiling on scope, not a summary.

**Smallest sufficient solution.** One skill package at `skills/aimgr/` — `SKILL.md` plus two references — discovered and installed by `npx skills`, documented in one README section. No build step, no Makefile, no installer script.

**Initial minimal convergence closure.** `none`. Nothing in this repo currently teaches `aim` usage to agents, so there is no competing authority to converge. The skill is additive: `README.md` documents the CLI for humans and keeps doing so; the skill documents the three basics for agents. They are different audiences, not two owners of one contract.

**Scope sign-off.** Signed off at the ready verdict below, 2026-09-17.

**Enough proof.** (a) Every command in the package reproduced against the live CLI on this machine; (b) `npx skills add <local-path> -l` discovers the skill with correct name and description; (c) after install, `~/.claude/skills/aimgr` resolves and the lock file records the source; (d) three trigger probes answered correctly from the skill alone.

**Do-not-build boundary.** No script, runner, or wrapper. No enrollment, credential, Redis-admin, routine, or Pi/Hermes surface. No account-rotation or retry strategy — the skill shows how to read availability and launch; strategy is out of scope in both directions. No Makefile or custom install machinery, because `npx skills` already does it. No edits to `~/workspace/arch_skill` or any other repo.

**Accepted residual risk.** The skill documents a CLI that changes; a future `aim` flag rename makes a documented form stale. Accepted: the skill tells the agent to trust `aim --help` over the skill when they disagree, which fails loud and cheap. Second risk: `npx skills` installs from GitHub, so an unpushed local edit is not live until pushed. Accepted and made explicit in the README section.

<!-- arch_skill:block:research_grounding:start -->

# 1) Research Grounding

## A. The `aim` surface the skill teaches

| Source | What it established |
|---|---|
| `aim --help` (live, this machine) | The complete public command surface, verbatim. This is the authority the skill quotes. |
| `aim claude status` (live) | The human availability table: `READY` / `IN USE` / `NEEDS YOU` / `UNKNOWN`, a `next` column printing the literal next action, and a header count line (`10 ready · 15 in use · 3 needs you` at probe time). |
| `aim status --accounts` (live) | The Codex table: `st` (`ready`/`blocked`), `lock`, `wk_used`, `wk_in`, `resets`, and a `flags` column carrying `week_full`. 31 Codex accounts. |
| `aim status --compact` (live) | `redis=live accounts=59 codex=qa claude_last=coder` — the one-line health check. |
| `aim grok status` (live) | Per-seat `used/limit`, `allow`, `expires`. |
| `README.md` | Launch semantics: label-free Claude presets rank eligible accounts by usage; `aim codex run` selects then launches `codex -p yolo` in one command; `-- <args>` pass-through; the `c` / `cr` zsh shortcuts; Prime default models. |
| `src/status/claude-redis-view.js:1131-1155` (`describeClaudeOperatorState`) | The exact status derivation: `locked` -> `IN USE`; `reauth_required`/`auth_invalid`/`scope_blocked` -> `NEEDS YOU` + `aim login <label>`; unlocked and credential-ready -> `READY`. |
| `src/targets/claude-cli.js:386-410` | Claude selection blocks with `no_eligible_pool_account` plus per-label blocker reasons when nothing is eligible. |
| `src/targets/codex-cli.js:581,649` | Codex selection blocks with `no_alternate_pool_account` and `no_eligible_pool_account`; the current account is preserved on a block. |
| `src/cli/commands/claude.js:875,1065` | `aim claude run` preset parsing; `selectAutomaticClaudeAccount(..., { preset })` is the label-free path. |

### What matters

**AI Manager already does the choosing, and that is what makes this skill small.** `aim claude run fable` and `aim claude run opus` rank eligible unlocked accounts by usage and pick one. `aim codex run` selects and launches in one command. An agent that never types a label is *more* correct than one that picks. So the skill's default teaching is the label-free form, with explicit labels reserved for two cases: the user named an account, or you are continuing an exact session.

**The status output is self-documenting and should be quoted, not paraphrased.** `aim claude status` prints a `next` column containing the literal next action (`use now`, `session active`, `aim login amir_elaguizy`). Teaching "read the `next` column" is shorter, more durable, and more accurate than re-deriving eligibility rules that live in `describeClaudeOperatorState`.

**`NEEDS YOU` is a human wall.** Three accounts sat in `NEEDS YOU` at probe time. The correct behavior is to skip them and, if nothing else is available, stop and report — never to run the `aim login <label>` the column suggests, because that is interactive OAuth needing a browser and a person.

**Three failure shapes cover the whole error surface.** `no_eligible_pool_account`, `no_alternate_pool_account`, and Redis-unreachable. Each is a stop-and-report. Naming them with their exact strings makes the skill useful at the moment it matters.

## B. Canonical skill packaging (the researched question)

**Answer: `npx skills`, the Vercel Labs open agent skills tool.** Probed live at v1.7.0 on this machine.

| Probe | Result |
|---|---|
| `npx skills --help` | Commands: `add`, `use`, `remove`, `list`, `find`, `update`, `init`, `experimental_install`, `experimental_sync`. Flags that matter: `-g/--global`, `-a/--agent <agents>` (`'*'` for all), `-s/--skill`, `-l/--list`, `--copy`, `--json`, `-y`. |
| `npx skills check` | **Not a linter.** It is the update checker; it walked this machine's global sources and reported "All global skills are up to date". (arch_skill's `AGENTS.md` calls it validation; it is not.) There is no lint/validate command. |
| `cat ~/.agents/.skill-lock.json` | `version: 3`. Per-skill entries: `source`, `sourceType`, `sourceUrl`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`. |
| `ls -la ~/.claude/skills/herdr` | `herdr -> ../../.agents/skills/herdr` — a **symlink**. `~/.agents/skills/` is the canonical store; each agent directory links into it, so one update refreshes every agent. |
| `npx skills add /Users/aelaguiz/workspace/herdr -l` | "Local path validated. Found 4 skills." Discovery from a plain local repo path works and prints each skill's name and description. |
| `gh repo view aelaguiz/aimgr` | `PUBLIC`, default branch `main`. No auth friction for a GitHub-sourced install. |

### The precedent is already on this machine

`~/.agents/.skill-lock.json` contains:

```json
"herdr": {
  "source": "herdrdev/herdr",
  "sourceType": "github",
  "sourceUrl": "https://github.com/herdrdev/herdr.git",
  "skillPath": "skills/herdr/SKILL.md"
}
```

with the file at `~/workspace/herdr/skills/herdr/SKILL.md`. A tool's own repo hosts its own skill at `skills/<name>/SKILL.md` and is installed globally by `npx skills add <owner>/<repo> -g`. **aimgr copies this exactly.** Nothing needs to be invented.

### Frontmatter: what is actually required

Claude Code's own docs say every frontmatter field is optional and only `description` is recommended. **`npx skills` is stricter** and it is the binding constraint here: during the `skills list -g` probe it skipped dozens of files with `missing required frontmatter field(s): name, description`. So the package uses exactly what herdr uses:

```yaml
---
name: aimgr
description: "<trigger logic>"
---
```

No `metadata:` block. That is an arch_skill-local extension, not part of the standard, and this repo has no reason to carry it. Claude Code caps the listing text at 1,536 characters and recommends `SKILL.md` under 500 lines; both are comfortable.

### Directory layout the installer discovers

`npx skills` walks up to three levels deep and recognizes a root `SKILL.md`, a `skills/` subdirectory (flat `skills/<name>/SKILL.md` or one-to-two category levels), and agent dirs like `.claude/skills/`. `skills/aimgr/SKILL.md` is the flat form, matches herdr, and leaves room for a second aimgr skill later without restructuring.

## C. Capability-first analysis

The lever is instructional, so the question is whether anything here needs code. It does not:

- **No script.** Every operation is one existing `aim` command with human-readable output. A wrapper would add a second authority over a CLI that already fails loud.
- **No parser.** Both status tables are aligned text a model reads directly. `--json` already exists for the scripted case; the skill just names it.
- **No install machinery.** This is the finding that removes the most work: `npx skills` already handles global install, multi-agent fan-out, the canonical store, symlinks, the lock file, and updates. A Makefile or install script here would duplicate it and drift.
- **No state file.** Nothing here is stateful. The skill reads, launches, and reports.

## D. Constraints the environment already imposes

- Redis at `redis://amirs-mac-studio:6380` must be reachable for selection; `aim status --compact` shows `redis=live` and is the cheap precheck.
- `aim claude status` without `--fresh` reads the allowlisted cache in `~/.aimgr/redis-cache.json` — cheap and browserless. `--fresh` makes real provider calls.
- `aim claude inventory` makes **zero** provider requests and is the instant coverage view.
- Codex reads credentials at process start, so a selection change needs a new process; an already-running Codex does not pick it up.
- `AGENTS.md` rule 5: do not resume Amir's sessions unless asked; when asked, one at a time, by exact id, in the pane's own cwd.
- `npx skills` installs from the pushed GitHub state. A local edit is not live until committed and pushed.

<!-- arch_skill:block:research_grounding:end -->

<!-- arch_skill:block:current_architecture:start -->

# 2) Current Architecture

## What exists in this repo today

```
~/workspace/aimgr/
  README.md        <- 400+ lines of CLI documentation, written for Amir
  AGENTS.md        <- agent notes, but only for agents working INSIDE this repo,
                      and only about the Prime daemon
  src/, scripts/, test/, docs/
  (no skills/ directory, no agent-facing usage surface at all)
```

`README.md` documents `aim` thoroughly and correctly — for a human reading top to bottom. It is not a skill: it does not load into an agent's context anywhere, it is not triggered by intent, and it covers the whole surface including the credential and Redis-admin commands an agent must never touch.

`AGENTS.md` loads only for agents working in `~/workspace/aimgr`. The agents that need this are working in psmobile, puzzledb, and everywhere else.

## What exists on the machine

| Surface | State |
|---|---|
| `~/.agents/skills/` | Canonical store, 125 skills, populated by both `npx skills` and arch_skill's `make install` |
| `~/.agents/.skill-lock.json` | `npx skills` lock, v3, tracks 6 GitHub sources including `herdrdev/herdr` |
| `~/.claude/skills/`, `~/.codex/skills/`, `~/.gemini/skills/` | Agent dirs; `npx skills`-managed entries are symlinks into the canonical store |
| `~/workspace/arch_skill` | The skills repo. **Reference only.** Read for conventions; never written to by this plan. |

So the distribution mechanism already exists, already runs on this machine, and already has a working example of a tool repo shipping its own skill. The only thing missing is the aimgr skill itself.

## Why the alternatives are wrong

- **Put it in arch_skill.** Explicitly ruled out by Amir. It would also split aimgr's agent-facing contract from aimgr's code, so a CLI change here would silently stale a doc in another repo.
- **Point agents at `README.md`.** Wrong audience and wrong shape. It is human documentation of the full surface, including the commands an agent must not run, with no triggering and no context-loading.
- **Expand `AGENTS.md`.** Only reaches agents working inside this repo. Backwards: this repo's agents need Prime-daemon rules, and everyone else's agents need `aim` usage.
- **Write a Makefile or install script.** `npx skills` already does global install, multi-agent fan-out, symlinking, locking, and updates. Rebuilding it would be a second authority that drifts.

<!-- arch_skill:block:current_architecture:end -->

<!-- arch_skill:block:target_architecture:start -->

# 3) Target Architecture

## Shape

```
~/workspace/aimgr/
  skills/
    aimgr/
      SKILL.md                          (~140 body lines, always read)
        mission: launch | see availability | choose an account
        the default recipe (4 steps)
        the boundaries  <- I3, I4 live HERE, never in a reference
        reference map
      references/
        commands.md                     read when: you need the exact form
        status-and-limits.md            read when: choosing, or something failed
  README.md                             + one "Agent skill" section
```

installed by:

```bash
npx skills add aelaguiz/aimgr -g -a '*'
```

which produces:

```
~/.agents/skills/aimgr/            <- canonical store (materialized copy)
~/.claude/skills/aimgr  -> ../../.agents/skills/aimgr
~/.codex/skills/aimgr   -> ...                              (and every other agent dir)
~/.agents/.skill-lock.json         <- { source: "aelaguiz/aimgr",
                                        sourceType: "github",
                                        skillPath: "skills/aimgr/SKILL.md" }
```

Updates on any machine: `npx skills update aimgr`, or `npx skills check` to see whether one is pending.

## Frontmatter

```yaml
---
name: aimgr
description: "<what it does, when to use it, when not to>"
---
```

Two fields, matching `~/workspace/herdr/skills/herdr/SKILL.md`. `npx skills` requires both. The `description` is the runtime trigger, not marketing copy: it must fire on *AI Manager*, *aimgr*, *`aim`*, and on "launch Claude / Codex / Sol / Opus / Fable / Prime / Grok", and it must carry the negative boundary — not for developing this codebase, not for credential enrollment or Redis administration.

## What `SKILL.md` owns (always read)

**The default recipe.**

1. `aim status --compact` — confirm `redis=live`. If Redis is down, stop; selection cannot happen.
2. Read availability for the provider you want: `aim claude status`, or `aim status --accounts` for Codex.
3. Launch. Prefer the label-free form and let AIM choose: `aim claude run fable`, `aim claude run opus`, `aim codex run`, `aim prime run codex|claude|grok`. Name a label only when the user named one, or when continuing an exact session.
4. Report which account it landed on. The launchers print it.

**The boundaries (in the body, never behind a reference).**

- `NEEDS YOU` is a human wall. Skip that account. Never run `aim login`; it is interactive OAuth needing a browser and a person. If every account is `NEEDS YOU`, stop and say so. *(I3)*
- Never run credential, enrollment, or Redis-admin commands: `aim login`, `capture-native`, `import-native`, `export-live`, `aim redis import/export/configure`, `aim label rebind`, `aim browser set`, `aim credential-helper`. *(I3)*
- A blocked selection (`no_eligible_pool_account`, `no_alternate_pool_account`) is a stop-and-report, not a retry loop. Name the provider and the code.
- Do not resume a session you did not start unless the user asked. When asked: one at a time, by exact id, in that pane's own cwd.
- This skill says *how to run `aim`*. Whether to spawn a worker at all is not its call. *(I4)*
- If `aim --help` and this skill disagree, `aim --help` wins; say so.

## What `references/commands.md` owns (read for an exact form)

The launch/resume matrix, transcribed from live `aim --help` and `README.md`:

| Provider | Launch (let AIM choose) | Launch (exact label) | Resume |
|---|---|---|---|
| Claude | `aim claude run fable` / `aim claude run opus` | `aim claude run <label> fable\|opus`, `aim claude run <label> -- <claude args>` | `aim claude resume` (interactive picker), `aim claude resume <row\|id\|name> [--account <label>]` |
| Codex | `aim codex run` | `aim codex run <label> -- <codex args>` | `aim codex resume [<session-id>]` |
| Prime | `aim prime run codex [model]` / `claude` / `grok` | — | `aim prime resume <path-or-id>` |
| Grok | `aim prime run grok` | — | — |

Plus: `fable` = Fable-scoped usage ranking, `opus` = shared 5h ranking; Codex models (`gpt-6-astra` default at `xhigh`, `gpt-5.6-sol`); `aim codex run` defaults to `codex -p yolo`; `-- <args>` pass-through; the `c` / `cr` zsh shortcuts; Prime defaults (`gpt-5.6-sol`, `claude-fable-5-1`, `grok-4.6`).

## What `references/status-and-limits.md` owns (read when choosing or after a failure)

- **`aim claude status`** — quoted live sample, then: the `status` column (`READY` use it / `IN USE` someone is on it / `NEEDS YOU` human wall / `UNKNOWN` retry), the `next` column is the literal next action, `5h` and `week` are percentages *used*, `Fable` is the Fable-scoped window. `--fresh` makes real provider calls; default to the cached read.
- **`aim status --accounts`** — the Codex table: `st` `ready`/`blocked`, `wk_used`, and `flags` where `week_full` marks a spent weekly window. Prefer `ready` with low `wk_used` and no `week_full`.
- **`aim grok status`** — `used/limit` and `allow`.
- **`aim claude inventory`** — instant coverage, zero provider calls.
- **`--json`** on any of them for scripted reads.
- **The failure shapes, verbatim, each a stop-and-report:** `no_eligible_pool_account`; `no_alternate_pool_account` (Codex found no *different* eligible label; current account preserved); Redis unreachable (`aim status --compact` shows it, selection fails closed); `reauth_required` / `NEEDS YOU` (human action, report the label).

## What deliberately does not exist

No `scripts/` in the package. No Makefile, no install script, no build step — `npx skills` is the mechanism. No enrollment, credential, routine, Pi, Hermes, or OpenClaw content. No account-rotation or retry strategy. The `SKILL.md` "When not to use" section names these so a reader knows the omissions are decisions.

<!-- arch_skill:block:target_architecture:end -->

<!-- arch_skill:block:call_site_audit:start -->

# 4) Call-Site Audit

## New files (3)

| Path | Size target | Notes |
|---|---|---|
| `skills/aimgr/SKILL.md` | ~140 body lines | Mission, 3 operations, default recipe, boundaries, when-not-to-use, reference map. Under Claude Code's 500-line guideline. |
| `skills/aimgr/references/commands.md` | ~90 lines | Launch/resume matrix, models, pass-through, shortcuts. |
| `skills/aimgr/references/status-and-limits.md` | ~100 lines | Table reading with quoted live samples, failure codes. |

## Modified files (1)

| Path | Change | Authority |
|---|---|---|
| `README.md` | One new "Agent skill" section: what `skills/aimgr` is, the `npx skills add aelaguiz/aimgr -g -a '*'` install line, `npx skills update aimgr` for refresh, and the note that installs come from pushed GitHub state. | Human outcome ("install it globally") — Amir needs the command on other machines. |

## Deletions

None.

## Not touched, deliberately

| Path | Why |
|---|---|
| `AGENTS.md` | Its audience is agents working inside this repo on the Prime daemon. Adding skill-usage notes there would put the same content in two places for two audiences. Candidate follow-up, not ship-blocking. |
| `Makefile`, `scripts/install-*.sh` | `npx skills` owns distribution. Adding an installer here would be a second authority. |
| `~/workspace/arch_skill/**` | Reference only. Read for conventions, never written. *(I5)* |
| `~/.claude/skills/`, `~/.agents/skills/` | Written by `npx skills` during Phase 2, never by hand. |

## Prior-art files read but not modified

`~/workspace/herdr/skills/herdr/SKILL.md` (layout and frontmatter precedent), `~/workspace/arch_skill/skills/cf-share/SKILL.md` and `skills/browseros/SKILL.md` (tool-skill section shape), `~/.agents/.skill-lock.json` (install contract).

<!-- arch_skill:block:call_site_audit:end -->

<!-- arch_skill:block:phase_plan:start -->

# 5) Phase Plan

## Phase 1 — Author the package

**Goal.** `skills/aimgr/` exists in this repo and is correct against the live CLI.

**Work.**

1. Create `skills/aimgr/`. Optionally scaffold with `npx skills init aimgr`; the result is a bare `SKILL.md`, so hand-authoring is equivalent.
2. Apply `$skill-authoring` discipline (the installed skill; reference only, nothing written back to arch_skill). Lock the three canonical asks before writing a line:
   - "Launch a Codex session with AI Manager."
   - "Which Claude account is free right now?"
   - "Start a Fable session on a healthy account."
3. Write the frontmatter as exactly `name` + `description`, with the description as trigger logic carrying both the positive triggers and the negative boundary.
4. Write `SKILL.md` with the boundaries in the body, never behind a reference.
5. Write both references, transcribing commands from live `aim --help` output rather than from memory or from `README.md` prose.
6. Re-probe every command form named in the package. Read-only commands may be run; launch commands are verified by `aim --help` syntax only — **do not start real sessions or consume account capacity to test a doc.**

**Verification.**

- `npx skills add /Users/aelaguiz/workspace/aimgr -l` lists `aimgr` with the intended description and does not warn about frontmatter.
- Every command string in the package appears in live `aim --help` output.
- `SKILL.md` body under 500 lines.
- A cold reader given only `SKILL.md` answers all three canonical asks correctly.

**Done bar.** The package is written and self-contained, and the installer can discover it. Nothing installed yet.

## Phase 2 — Package, install, validate

**Goal.** The skill is installed globally from this repo and triggers correctly.

**Work.**

1. Add the README "Agent skill" section with the install and update commands.
2. Local install to prove the package end to end:
   ```bash
   npx skills add /Users/aelaguiz/workspace/aimgr -s aimgr -g -a '*' -y
   ```
3. Confirm the install landed: `~/.agents/skills/aimgr/` exists, `~/.claude/skills/aimgr` is a symlink into it, and `~/.agents/.skill-lock.json` has an `aimgr` entry.
4. Trigger validation in a fresh session on the three canonical asks, without naming the skill, confirming it fires and produces a correct command. Negative check: "fix the bug in aimgr's Redis view" must **not** fire it.
5. Commit and push to `aelaguiz/aimgr` `main`.
6. Re-install from the canonical GitHub source so the lock records `sourceType: github` rather than a local path:
   ```bash
   npx skills remove aimgr -g -y
   npx skills add aelaguiz/aimgr -g -a '*' -y
   ```
7. Re-confirm step 3 against the GitHub-sourced install.

**Verification.**

- `npx skills list -g` shows `aimgr`.
- `~/.agents/.skill-lock.json` records `"source": "aelaguiz/aimgr"`, `"sourceType": "github"`, `"skillPath": "skills/aimgr/SKILL.md"`.
- `readlink ~/.claude/skills/aimgr` resolves into `~/.agents/skills/aimgr`.
- 3/3 positive triggers, 0/1 negative trigger.

**Done bar.** Installed from GitHub, verified, triggering. Amir can tell an agent "use AI Manager to launch a Codex session" and it works from the skill alone, and the same one-liner installs it on any other machine.

## Follow-ups (not ship-blocking, not authorized here)

- Install on the rest of the fleet: the same `npx skills add aelaguiz/aimgr -g -a '*'` on each machine, or via `scripts/sync-fleet.sh` if that turns out to be the better carrier. Needs a decision from Amir.
- Consider a one-line pointer in `AGENTS.md` for agents working inside this repo.

<!-- arch_skill:block:phase_plan:end -->

# 6) Ready Verdict

**Ready to implement.**

The packaging question Amir asked to research is answered and proven on this machine, not guessed: `npx skills` v1.7.0, layout `skills/aimgr/SKILL.md`, frontmatter `name` + `description`, install `npx skills add aelaguiz/aimgr -g -a '*'`, canonical store `~/.agents/skills/` with per-agent symlinks, lock at `~/.agents/.skill-lock.json`. `herdrdev/herdr` is the working precedent already installed here. The repo is public on `main`, so the GitHub-sourced install has no auth friction.

The implementer does not need to invent architecture: the package shape, the file list, the content ownership per file, the one README edit, and the verification commands are fixed.

**Scope contract signed off 2026-09-17.** Convergence closure is `none`. Every ship-blocking item maps to Amir's verbatim outcome: the three operations, packaged the canonical way, installed globally, entirely inside this repo.

**Next move.**

```
miniarch-step implement /Users/aelaguiz/workspace/aimgr/docs/AIMGR_SKILL_MINI_ARCH_PLAN_2026-09-17.md
```
