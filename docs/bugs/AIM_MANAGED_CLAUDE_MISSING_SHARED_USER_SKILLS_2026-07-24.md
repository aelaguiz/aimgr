---
title: "AIM-managed Claude profiles do not discover shared user skills"
date: 2026-07-24
status: resolved-local
owners:
  - aelaguiz
reviewers: []
related:
  - ./AIM_MANAGED_CLAUDE_REPLACES_DEVELOPER_ENVIRONMENT_2026-07-24.md
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
---

# AIM-managed Claude profiles do not discover shared user skills

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** `/skills` differs between Claude sessions. Plain Claude sees
  personal skills such as `conductor`; an AIM-managed `qa` session in
  `psmobile` lists no skills; AIM sessions in projects with project skills see
  only those project skills.
- **Impact:** Switching Claude accounts through AIM also removes the human's
  reusable Claude skill catalog. Agents can read a skill file manually, but
  `Skill(conductor)` fails because Claude never registered that skill.
- **Cause:** AIM correctly keeps
  `CLAUDE_CONFIG_DIR=~/.aimgr/claude-homes/<label>/.claude` to isolate account
  identity and sessions. Claude treats that value as the replacement for every
  personal `~/.claude` path, including `skills/`. Preserving the real process
  `HOME` fixed ordinary developer tools but does not change Claude's own
  configuration root.
- **Next action:** Share only the real `~/.claude/skills` directory into each
  managed profile and allow read-only access to that exact directory through
  the macOS sandbox. Do not share the rest of global `.claude`.
- **Status:** Implemented, verified, and installed locally. A disposable
  managed profile loaded every valid personal skill plus a project-local skill
  through the read-only sandbox boundary without a model request. The real
  local `qa` profile now has the exact shared-skills link for operator testing.

<!-- bugs:block:tldr:end -->

## Bug North Star

Every `aim claude run <label>` launch should discover the same personal Claude
skills as a normal `claude` launch, while account credentials, app state,
sessions, memory, trust, settings, plugins, hooks, and other Claude profile
state remain label-scoped.

Project skills must continue following Claude's normal project discovery
rules. The fix must not copy skill packages per label or expose the rest of the
real global Claude profile.

<!-- bugs:block:analysis:start -->

## Analysis

### First-party reproduction

The real user catalog on Amir M5 currently has 51 skill directories and
contains all three paths discussed in the report:

```text
~/.claude/skills/conductor
~/.claude/skills/agent-delegate
~/.claude/skills/_shared
```

The global `conductor` package matches the corresponding
`~/.agents/skills/conductor` package. The same global Claude and cross-agent
`conductor` directories exist on every inspected fleet machine:

```text
Amir M5
Amirs-M3-Max-2
amirs-mac-studio
home
claw
```

No inspected AIM label on any of those machines has a
`<label>/.claude/skills` directory.

### Active launch evidence

The active `qa` launch on Amir M5 began after the developer-environment fix and
has:

```text
HOME=/Users/aelaguiz
CLAUDE_CONFIG_DIR=/Users/aelaguiz/.aimgr/claude-homes/qa/.claude
CLAUDE_SECURESTORAGE_CONFIG_DIR=/Users/aelaguiz/.aimgr/claude-homes/qa/.claude
cwd=/Users/aelaguiz/workspace/psmobile
```

That label has no personal skills directory and `psmobile` has no project
`.claude/skills`. The operator's observed result—an empty `/skills` list—is
therefore exact, not a stale UI artifact.

Other current sessions explain the apparently inconsistent results:

| Launch | Skill sources present | Expected `/skills` result |
|---|---|---|
| Plain global Claude | Real `~/.claude/skills` | Personal catalog, including `conductor` |
| AIM `qa` in `psmobile` | No label skills; no project skills | Empty |
| AIM labels in `psagentspace` | No label skills; three project skills | Project skills only |
| AIM `boss` in `puzzledb` | No label skills; project `_shared` only | Project `_shared` only |

Several older AIM processes started before commit `b781c36` still carry the old
label-specific `HOME`. Those processes resolve the shell spelling
`~/.claude/skills` to the label profile itself. New processes resolve `~` to
the real home, but Claude still discovers personal skills from
`CLAUDE_CONFIG_DIR`. Those two facts make agent-written diagnostics look
contradictory even though Claude's behavior is consistent.

### MCP startup is independent evidence

The report that MCP servers came online after restart does not prove that the
global Claude profile loaded. The active projects contain project-scoped
`.mcp.json` and `.claude/settings*` files. Project configuration remains
discoverable because AIM preserves the working directory. MCP startup and
personal-skill discovery therefore have separate sources.

### Claude's documented discovery contract

Claude documents `CLAUDE_CONFIG_DIR` as replacing the default `~/.claude`
configuration directory. Its `.claude` directory documentation is explicit
that, when the variable is set, every personal `~/.claude` path described
there lives below the alternate directory. Skills are discovered from:

- `<configuration-directory>/skills` for personal skills;
- `.claude/skills` in the current project and its normal project hierarchy;
- enabled plugins and managed enterprise sources.

Preserving process `HOME` is therefore necessary for child developer tools but
cannot make Claude merge a second personal configuration root.

References:

- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/slash-commands

### The proposed symlink alone does not work on macOS

The current profile denies the complete real `~/.claude` subtree. A contained
probe tested the real `conductor/SKILL.md` both directly and through a
temporary symlink:

```text
direct_global_skill_status=1
symlinked_global_skill_status=1
```

Seatbelt resolves the target authority, so linking selected packages—or the
whole skills directory—into a label does not bypass the deny rule.

A second contained profile probe added a read/test exception for only
`~/.claude/skills`, while retaining the enclosing global-Claude deny:

```text
skill_read_status=0
settings_read_status=1
skills_write_status=1
```

This proves the narrow policy shape:

- global personal skills can be readable;
- global settings remain inaccessible;
- global skills remain non-writable from the managed process.

### Pre-implementation real-client proof

A disposable profile and project were created entirely under
`/tmp/aimgr-skill-discovery-proof.3lfhfJ`:

```text
profile/skills
  -> /Users/aelaguiz/.claude/skills

project/.claude/skills/aim-project-proof/SKILL.md
```

The experiment used:

- the installed signed Claude Code 2.1.219 binary;
- real `HOME`;
- the disposable directory as both Claude config variables;
- the production Seatbelt profile plus only the proposed read/test exception
  for real global skills;
- normal Claude mode with nonessential traffic and updates disabled;
- a fake API key, no OAuth credential, no model prompt, and no provider turn.

The source catalog contains 52 valid top-level `SKILL.md` packages when its two
symlinked entries are followed. Claude's own debug registry reported:

```text
Loaded 53 unique skills
  managed: 0
  user: 52
  project: 1
  additional: 0
  legacy commands: 0

getSkills returning:
  53 skill dir commands
```

The actual interactive `/skills` UI independently displayed:

```text
53 skills
aim-project-proof · project
agent-definition-auditor · user
agent-delegate · user
...
42 more below
```

The equality is decisive: every one of the 52 valid personal source packages
entered Claude's user registry, including `conductor`, and the independent
project marker entered the project registry. There were no extra managed,
additional, plugin, or legacy-command sources that could make the counts
coincide accidentally.

A filesystem probe inside the same proposed boundary also returned:

```text
readable_user_skill_files=52
project_skill_readable=yes
global_settings_read_status=1
global_skills_write_status=1
```

Status `1` is the expected denial for global settings reads and global skills
writes. The client log recorded
`[Bootstrap] Skipped: Nonessential traffic disabled`; no prompt was submitted,
so this proof consumed no model inference.

One rejected test technique is worth preserving: `--bare` logs
`[reduced mode] Skipping skill dir discovery` and reports zero skill-directory
commands. Bare mode may resolve an explicitly named skill lazily, but it cannot
prove the normal `/skills` catalog and was not used for the accepted result.

### Root cause

The managed profile currently has one intentional Claude configuration root:

```text
CLAUDE_CONFIG_DIR=<label>/.claude
```

That root correctly owns identity and sessions, but AIM provides no explicit
shared personal-skill source inside it. The macOS boundary independently
blocks the real global source. Project skills sometimes hide the problem by
populating `/skills`, while projects without skills expose it directly.

### Ranked hypotheses

1. **Confirmed:** `CLAUDE_CONFIG_DIR` redirects personal skill discovery to the
   label profile.
2. **Confirmed:** Labels have no personal skill directory, so only project or
   plugin skills can appear.
3. **Confirmed:** The macOS sandbox prevents a plain symlink to global skills
   from working.
4. **Confirmed:** MCP recovery is project configuration and does not imply
   personal skills recovered.
5. **Disproved:** The global `conductor` skill is missing from the machine.
6. **Disproved:** The post-fix `qa` process still has the old synthetic
   process-wide `HOME`.
7. **Disproved:** Restarting alone makes Claude merge real-home and alternate
   personal configuration roots.

<!-- bugs:block:analysis:end -->

## Scope contract

### Human-authorized corrected behavior

AIM account switching must not make the human's globally installed Claude
skills disappear. `conductor` and the rest of the real personal skill catalog
should be available in every newly launched managed label.

### Smallest sufficient fix

1. Make `<label>/.claude/skills` an exact live link to the real
   `~/.claude/skills` directory when the source exists.
2. On macOS, permit read and existence checks for exactly the real
   `~/.claude/skills` subtree and its data-volume alias while retaining the
   existing write denial and all other global-Claude denials.
3. Treat an unexpected pre-existing label `skills` path as a loud conflict;
   never replace or merge it silently.

### Initial minimal convergence closure

The closure is limited to managed Claude launch preparation, the one macOS
profile exception, and their focused tests. There is no second live owner of
managed personal-skill projection to migrate or delete.

### Scope freeze before fix

Do not share or merge:

- global settings, hooks, plugins, commands, agents, `CLAUDE.md`, rules, MCP
  registration, trust, permissions, history, memory, caches, or credentials;
- label histories or sessions with one another;
- the complete global `.claude` directory.

Do not add `--add-dir $HOME`, generate a plugin, copy packages per label,
maintain a per-skill link farm, modify the skills repository, or introduce a
general configuration-overlay framework.

### Enough proof

1. A focused filesystem test proves missing source, exact existing link, new
   exact link, and conflicting destination behavior.
2. The macOS boundary permits read/test of global skills through the managed
   link, denies writes there, and still denies global settings and credentials.
3. Linux uses the same shared link without adding a sandbox mechanism.
4. A fresh `qa` canary in `psmobile` lists `conductor` despite having no project
   skills.
5. A project with project skills lists both personal and project sources.
6. Resume state remains under the same label config directory.
7. Focused tests, full tests, and lint pass.

### Accepted residual risk

- Existing sessions whose top-level personal skills directory was absent when
  they started may require one restart; Claude documents that case.
- Every managed account can invoke the same human-installed skills. That is
  the intended behavior and gives those skills the same trust status they have
  in a normal Claude launch.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

1. Add one narrow launch-preparation helper that validates the real personal
   skills source and reconciles the selected label's `skills` link.
2. Add the read-only global-skills exception to the macOS profile without
   weakening any other global-Claude rule.
3. Extend the existing native-storage boundary tests for exact link behavior,
   read-only skill access, and continued settings/credential denial.
4. Run the two real `/skills` canaries, then the existing focused and full
   suites.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation and verification

Implemented the smallest proven boundary:

- `prepareClaudeCliLaunch` now reconciles exactly
  `<label>/.claude/skills -> ~/.claude/skills` for normal managed label
  launches. A missing personal skills source is a no-op. The exact link is
  idempotent; a directory or wrong symlink at the destination fails loudly.
  Transient login-staging profiles remain unchanged.
- The macOS sandbox permits read and existence checks only beneath the real
  personal skills directory and its data-volume alias. Writes remain denied
  through both the global path and the label-side symlink. All other global
  `.claude` state remains denied.
- No settings, hooks, plugins, commands, agents, rules, MCP configuration,
  credentials, sessions, memory, history, or caches were shared.

Verification:

```text
node --test test/claude/native-storage.test.js
28 tests, 28 pass

npm run lint
pass

npm test
348 tests, 348 pass

npm run install:local
installed aim and aimgr into /Users/aelaguiz/.local/bin
```

The focused coverage proves source-missing behavior, exact-link creation,
idempotence, regular-path and wrong-link conflicts, Linux link creation,
personal-skill reads through the Darwin sandbox, denied writes through both
paths, and continued denial of global settings and credentials.

Local deployment proof:

```text
~/.aimgr/claude-homes/qa/.claude/skills
  -> /Users/aelaguiz/.claude/skills

conductorReadable=true
globalSettingsReadable=false
```

No Claude process, model request, credential operation, Redis mutation, remote
contact, commit, push, or fleet deployment was performed. Existing Claude
sessions must be restarted because Claude discovers a newly added top-level
skills directory at startup.

<!-- bugs:block:implementation:end -->
