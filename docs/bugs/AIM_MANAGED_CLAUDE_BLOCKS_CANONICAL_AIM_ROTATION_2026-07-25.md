---
title: "AIM-managed Claude blocks canonical AIM Codex rotation"
date: 2026-07-25
status: resolved
owners:
  - aelaguiz
reviewers: []
related:
  - ../MANAGED_CLAUDE_REPLACES_DEVELOPER_ENVIRONMENT_2026-07-24.md
---

# AIM-managed Claude blocks canonical AIM Codex rotation

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** Inside an `aim claude run ...` session, normal
  `aim codex use <label>` cannot read the existing AIM Redis configuration or
  local state. Agents worked around it with a second temporary AIM home and a
  redundant explicit Codex home.
- **Confirmed root cause:** The macOS managed-Claude sandbox denies every path
  under `~/.aimgr` except the selected Claude label home and AIM's adapter
  runtime. That also denies the canonical, non-secret `config.yaml` and
  `local-state.json` that nested AIM commands require.
- **Decisive reproduction:** Under the exact currently materialized pro4
  sandbox profile, read checks return `EPERM` for
  `~/.aimgr/config.yaml` and `~/.aimgr/local-state.json`, while
  `~/.codex/auth.json` is readable.
- **Historical confirmation:** Claude session
  `5e118385-d517-48e4-8714-86c4c74c4543` recorded the successful workaround as
  `CODEX_HOME=/Users/aelaguiz/.codex aim --home /tmp/aim-home codex use
  <label>`, after separately configuring Redis in `/tmp/aim-home`.
- **Status:** Resolved. Managed Claude can use canonical AIM config/local state
  while legacy secrets, other Claude labels, and unrelated AIM paths remain
  denied.

<!-- bugs:block:tldr:end -->

## Bug North Star

An AIM-managed Claude session on macOS can run ordinary
`aim codex use <label>` against the user's canonical AIM configuration and
local state, without `--home`, one-time Redis reconfiguration, or
`CODEX_HOME`.

Other Claude labels, legacy credential state, and unrelated files below
`~/.aimgr` remain inaccessible.

## Reproduction

1. Launch Claude through `aim claude run ...` on macOS.
2. From that Claude process tree, test the canonical AIM files or run
   `aim codex use <label>`.
3. Observe `EPERM` while AIM inspects `~/.aimgr`, followed by missing Redis-pool
   behavior because the real configuration could not be read.
4. Observe that relocating AIM to `/tmp/aim-home`, configuring Redis there,
   and pointing Codex at the real `~/.codex` makes rotation work.

<!-- bugs:block:analysis:start -->

## Analysis

### Exact denial

`native/claude/no-keychain.sb` has an allow-default policy plus a targeted
deny for all access below the `AIMGR_ROOT` parameter. Its only exceptions are:

- `SELECTED_LABEL_HOME`
- `ADAPTER_RUNTIME_ROOT`

`src/targets/claude-runner.js` supplies `AIMGR_ROOT` as the user's
`~/.aimgr`. Consequently, the rule correctly isolates other Claude label
homes, but also unintentionally blocks AIM's own canonical coordination files.

### Paths required by `aim codex use`

The Redis-backed command follows this local path:

1. `readAimgrConfig()` reads `~/.aimgr/config.yaml`.
2. `loadRedisRuntime()` reads `~/.aimgr/local-state.json`.
3. Codex activation writes the real `~/.codex/auth.json`, which is already
   outside the AIM deny and is reachable.
4. `writeRedisLocalStateFromView()` updates `local-state.json` and may create a
   `local-state.json.bak.*` sibling.

No access to `~/.aimgr/secrets.json`, another label home, the Claude global
profile, or the entire AIM root is required.

### Why both workaround flags appeared

`--home /tmp/aim-home` was necessary because it moved AIM config/state outside
the denied root. It also created a disposable configuration that had to be
rebuilt after `/tmp` was cleared.

The explicit `CODEX_HOME=/Users/aelaguiz/.codex` is not required by the current
launcher: managed Claude now retains `HOME=/Users/aelaguiz`, and the exact
sandbox probe confirms `~/.codex/auth.json` is readable. Keeping the regression
proof ensures the normal command continues to select that canonical Codex
home.

### Root cause

The sandbox grouped two different classes of state under one deny:
credential-bearing per-label Claude homes and non-secret AIM coordination
files. The label isolation is correct; the blanket classification of
`config.yaml` and `local-state.json` is not.

<!-- bugs:block:analysis:end -->

## Scope contract

### Correct behavior

- Read canonical `~/.aimgr/config.yaml`.
- Read and write canonical `~/.aimgr/local-state.json`, including its backup
  sibling.
- Read and write canonical `~/.codex` through the already-preserved user home.
- Keep every other path below `~/.aimgr` denied unless it was already an
  approved selected-label or adapter-runtime exception.

### Explicitly out of scope

- Allowing the whole `~/.aimgr` tree.
- Moving AIM state to another directory or auto-configuring a temporary home.
- Changing Redis configuration, account-selection policy, Codex credentials,
  Claude credentials, or Keychain behavior.
- Adding a special rotation command, wrapper, daemon, or environment recipe.
- Expanding the fix to status-cache files unless a separate reproduction shows
  they block the requested rotation command.

### Enough proof

- A real macOS sandbox probe can read config and read/write local state.
- The same probe still cannot read another label or `secrets.json`.
- The managed launch environment resolves Codex to the user's real
  `~/.codex` without an explicit `CODEX_HOME`.
- Focused native-storage and Codex command tests pass.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

1. Split the AIM sandbox rule into read and write boundaries.
2. Add read-only access for `config.yaml`.
3. Add read/write access for the `local-state.json` prefix so its existing
   backup behavior remains intact.
4. Extend the real sandbox test with positive AIM coordination checks and
   negative `secrets.json`/other-label checks.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation

- `native/claude/no-keychain.sb` now treats AIM coordination files separately
  from credential-bearing state:
  - `config.yaml` is read-only.
  - `local-state.json` and its exact backup-name prefix are readable/writable.
  - the AIM root is visible only for the parent-exists check.
- `src/io/json-store.js` no longer issues a redundant recursive `mkdir` against
  an already-existing parent before writing a backed-up JSON file.
- The real macOS sandbox test executes both parent and descendant probes,
  exercises the production backup writer, and keeps `secrets.json` plus another
  Claude label unreadable and unwritable.
- No launcher environment or CLI command path changed. The existing preserved
  user `HOME` continues to resolve the canonical `~/.codex` without an explicit
  `CODEX_HOME`.

<!-- bugs:block:implementation:end -->

<!-- bugs:block:reviews:start -->

## Reviews

Not requested. Product proof comes before optional review.

<!-- bugs:block:reviews:end -->

<!-- bugs:block:verification:start -->

## Verification

Current verdict: `PASS`.

- Focused Claude lifecycle, lease, and macOS boundary suites: `62/62`.
- Full AIM suite: `365/365`.
- Lint and `git diff --check`: clean.
- A read-only probe using the production macOS profile returned:
  `config=readable`, `local=readable`, `legacy=EPERM`, `other=EPERM`, and
  `codex=readable`.
- The existing fake-Redis command test proves `aim codex use` projects Codex
  auth and writes only local adjunct state.
- A live end-to-end run used the installed canonical `aim` executable inside
  the exact production sandbox profile emitted by `prepareClaudeCliLaunch`.
  With `CODEX_HOME` explicitly absent and no `--home` argument, it rotated
  Codex from `pro11` to `pro4`; AIM returned
  `status=activated auth_written=true`, and active-label, inferred-label, and
  account readback all matched `pro4`.
- The same managed sandbox then restored `pro11`; AIM again returned
  `status=activated auth_written=true`, and all three readbacks matched
  `pro11`. Final state is the original `pro11` account.

The live proof changed the Codex credential only for the two intentional
rotation operations and restored the original account. It made no model or
provider request, changed no Claude credential, and disturbed no running
managed Claude process.

<!-- bugs:block:verification:end -->
