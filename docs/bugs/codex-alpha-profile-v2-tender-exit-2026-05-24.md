---
title: "Codex alpha exits immediately under AIMGR tender with legacy yolo profile"
date: "2026-05-24"
status: "resolved"
owners: []
reviewers: []
related:
  - "/home/aelaguiz/.codex/config.toml"
  - "/home/aelaguiz/workspace/codex"
  - "src/targets/codex-tender.js"
---

<!-- bugs:block:tldr -->
## TL;DR

- Symptom: `aim codex run --tend -p yolo` starts a tmux session, immediately shows `[exited]`, and AIMGR reports `ended_without_thread`.
- Impact: AIMGR never discovers a Codex thread, so tendering cannot start.
- Most likely cause: `codex-cli 0.134.0-alpha.3` treats `-p yolo` as profile-v2, which loads `$CODEX_HOME/yolo.config.toml`; it now rejects a matching legacy `[profiles.yolo]` table in `~/.codex/config.toml`.
- Next action: none for the local config migration; consider improving AIMGR startup-error reporting later.
- Status: resolved.

<!-- bugs:block:analysis -->
## Bug North Star

Make `aim codex run --tend -p yolo` launch Codex long enough for AIMGR to discover or use a Codex thread, without hiding real Codex startup errors.

## Bug Summary

The AIMGR tender command is functioning up to tmux launch. It runs Codex as:

```text
codex --no-alt-screen -p yolo
```

After updating Codex alpha, that command exits before creating a thread. AIMGR then has no live tmux pane and no app-server thread, so it reports `ended_without_thread`.

## Evidence

User-visible AIMGR output:

```text
"status": "ended_without_thread"
"threadId": null
"pane_rate_limit_scan_failed": "tmux capture-pane failed with exit 1: no server running on /tmp/tmux-1000/default"
```

Installed Codex version:

```text
codex-cli 0.134.0-alpha.3
```

The local `codex` binary on `PATH`:

```text
/home/aelaguiz/.local/bin/codex
```

That file is a wrapper to the Node v22 npm install:

```text
/home/aelaguiz/.nvm/versions/node/v22.18.0/lib/node_modules/@openai/codex/bin/codex.js
```

`codex doctor` reports the install as consistent with `codex-cli 0.134.0-alpha.3`; the duplicate `PATH` entries are not the cause of this failure.

The local Codex checkout was pulled to:

```text
7d47056ea4 fix: plugin bundle archive handling for upload and install (#23983)
```

Direct tmux repro preserving the pane after Codex exit produced:

```text
Error loading config.toml: --profile `yolo` cannot be used while /home/aelaguiz/.codex/config.toml contains legacy `profile = "yolo"` or `[profiles.yolo]` config; move those settings into /home/aelaguiz/.codex/yolo.config.toml and remove the legacy profile selector/table. See https://developers.openai.com/codex/config-advanced#profiles for more information.

EXIT:1
```

Local `~/.codex/config.toml` contains:

```text
[profiles.yolo]
...
[profiles.yolo.features]
...
```

Codex source anchor:

```text
/home/aelaguiz/workspace/codex/codex-rs/config/src/loader/mod.rs: profile-v2 rejects matching legacy profile selector/table.
```

## Investigation

Ranked hypotheses:

1. Codex alpha rejects legacy `~/.codex/config.toml` profile tables when using profile-v2 `-p yolo`. Confirmed by direct tmux repro and Codex source.
2. AIMGR passes a removed or renamed `--no-alt-screen` option. Rejected: `codex --help` still lists `--no-alt-screen`.
3. AIMGR is invoking an older or wrong `codex` binary. Unlikely for this failure: the active binary reports `codex-cli 0.134.0-alpha.3`, and the error comes from the new profile-v2 loader.

## Repro Notes

The plain help path does not reproduce the error because `codex -p yolo --help` prints help without loading the profile config. The interactive startup path does load config and fails.

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Operator config fix: move the contents of `~/.codex/config.toml` `[profiles.yolo]` and `[profiles.yolo.features]` into `~/.codex/yolo.config.toml`.
2. Remove the legacy `yolo` profile tables from `~/.codex/config.toml`.
3. Re-run the exact tmux startup or `aim codex run --tend -p yolo --no-attach`.
4. Optional AIMGR improvement: preserve and report early Codex startup output so `ended_without_thread` includes the actual config error.

<!-- bugs:block:implementation -->
## Implementation

Created a backup before editing:

```text
/home/aelaguiz/.codex/config.toml.bak-2026-05-24-profile-v2-migration
```

Created the new profile-v2 file:

```text
/home/aelaguiz/.codex/yolo.config.toml
```

Moved the previous `[profiles.yolo]` values to top-level keys in `yolo.config.toml`, and moved `[profiles.yolo.features]` to `[features]`.

Removed the legacy `[profiles.yolo]` and `[profiles.yolo.features]` tables from:

```text
/home/aelaguiz/.codex/config.toml
```

## Verification Plan

- Run a direct startup check for `codex --no-alt-screen -p yolo` in tmux and confirm it stays alive or reaches the TUI instead of exiting with config error.
- Run `aim codex run --tend -p yolo --no-attach --max-restarts 0` and confirm status is not `ended_without_thread` from immediate startup failure.

## Verification Result

Confirmed the legacy profile tables are gone:

```text
rg '^\\[profiles\\.yolo\\]|^\\[profiles\\.yolo\\.features\\]' /home/aelaguiz/.codex/config.toml
# no matches
```

Confirmed the new profile file exists with the migrated settings:

```text
/home/aelaguiz/.codex/yolo.config.toml
```

Ran a direct tmux startup check:

```text
codex --no-alt-screen -p yolo
```

The Codex TUI now starts instead of exiting with the config error. Captured pane showed:

```text
OpenAI Codex (v0.134.0-alpha.3)
model:       gpt-5.5 xhigh   fast
permissions: YOLO mode
```

The temporary verification tmux session `aimgr-debug-codex-profilev2` was killed after capture.

## Risks

- Moving profile settings into `yolo.config.toml` changes how Codex layers config. Base settings should remain in `config.toml`; only profile-specific overrides should move.
- AIMGR currently loses early process output when the tmux server exits before pane capture, so similar startup failures may still look like `ended_without_thread`.
