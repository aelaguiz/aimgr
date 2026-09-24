---
title: "Prime Agent — replace local fork with latest GitHub release — Plan"
date: 2026-09-18
status: complete
fallback_policy: forbidden
owners: [Amir]
reviewers: []
doc_type: migration
related:
  - docs/PRIME_AGENT_OPERATIONS_RUNBOOK.md
  - docs/PRIME_AGENT_CONTROL_PLANE_REFERENCE.md
  - https://github.com/PrimeIntellect-ai/prime-agent/releases
  - https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/index.md
---

# TL;DR

- Outcome: all running Prime Agent fork processes are stopped, the forked global install is removed, and the latest stable Prime Intellect GitHub release is installed globally.
- Problem: this Mac currently runs a locally built/forked 0.9.1 bundle from `~/.prime/installs/main-c8bc030` while the upstream GitHub release is newer.
- Approach: inventory and snapshot state, stop every Prime client/worker/supervisor, remove only forked executable artifacts, install the upstream release, restore/verify user configuration, and run one smoke test.
- Plan: preserve `~/.prime/agent` and `~/.prime/config.json`; shut down the daemon through the documented force path; remove the global fork and retired install directories; install the upstream stable release globally; prove version, launcher identity, custom model presence, key presence without printing secrets, and a non-interactive CLI invocation.
- Non-negotiables:
  - Never print, rotate, or overwrite API-key values.
  - Never delete `~/.prime/agent/sessions`, transcripts, model definitions, auth, settings, or custom extensions.
  - Stop all Prime clients before stopping the daemon so no survivor relaunches the fork.
  - Use the latest stable release on the official `PrimeIntellect-ai/prime-agent` GitHub releases page (v0.9.5 at plan time), not the repository fork or a beta build.

## North Star

### Claim
> If the fork is fully stopped and removed, then the global `prime-agent` command resolves to the latest upstream GitHub release while the pre-existing custom providers/models and credentials remain available, measured by launcher/version checks, config fingerprints, and a successful smoke invocation.

### In scope

- UX: the global `prime-agent` command remains available from the normal shell PATH.
- Technical: daemon/workers/TUIs, global npm/install artifacts, `/opt/homebrew/bin/prime-agent`, upstream release install, preserved `~/.prime/agent` and `~/.prime/config.json`, and one smoke test.

### Out of scope

- UX: resuming or restoring any prior agent session into Herdr.
- Technical: changing provider keys, rotating accounts, editing custom model definitions, changing MCP servers, deleting transcripts, or changing aimgr source code.

### Acceptance evidence

- Primary signal: `prime-agent --version` reports upstream v0.9.5 and the resolved executable/install is not the old `main-c8bc030` fork.
- Optional second signal: the smoke command exits successfully while loading the preserved custom OpenRouter/Sakana configuration.
- Metrics or thresholds: zero Prime supervisor/worker/client processes after shutdown; zero old fork install paths referenced by the active launcher; settings/config/extension fingerprints match; auth records remain semantically present after any upstream migration; custom model IDs and provider entries remain present; no secret values appear in logs or receipts.

### Key invariants

- No fallbacks without explicit approval.
- `~/.prime/agent` is the source of truth for Prime user state and is preserved.
- Credentials are validated by presence/fingerprint only; their values never enter the plan, command output, or receipt. Upstream-owned auth migration is allowed when it preserves credential records and provider behavior.
- The upstream release is installed globally using the project’s documented stable installer/release artifact path.

## Problem Statement

### What exists today

- `command -v prime-agent` resolves to `/opt/homebrew/bin/prime-agent`.
- That symlink points to `~/.prime/installs/main-c8bc030/lib/node_modules/prime-agent/dist/bundle/cli.js`.
- The active bundle reports version `0.9.1`; the state script identifies a live supervisor PID 90609 and many live workers/TUI clients.
- A second retired bundle exists at `~/.prime/installs/main-c8bc030-bundle-backup-202609151321`.
- A global npm package exists at `/opt/homebrew/lib/node_modules/prime-agent`.
- User state exists separately at `~/.prime/agent`, including `models.json`, `settings.json`, `auth.json`, sessions, kernel state, logs, and the custom `session-title-footer.ts` extension.
- `models.json` contains OpenRouter and Sakana provider entries and custom model arrays; `settings.json` selects OpenRouter and records recent models.
- `~/.prime/config.json` exists separately and must be retained.

### What is broken or missing

- Symptoms: the active executable is a local/forked 0.9.1 bundle rather than the current upstream GitHub release.
- Likely causes: prior immutable-install cutovers and global package installation left the fork as the active symlink and package.
- Why now: the requested end state is a clean global upstream install with the existing provider/model/key configuration intact.

## Research Grounding

<!-- project_flow:block:research_grounding:start -->
### Internal ground truth

- `scripts/prime-runtime-state.sh` — authoritative process, socket, registry, worker, and launcher inventory.
- `docs/PRIME_AGENT_OPERATIONS_RUNBOOK.md` — shutdown contract: freeze launchers, close/reap clients, use `prime-agent shutdown --force`, then verify no Prime processes/sockets remain.
- `docs/PRIME_AGENT_CONTROL_PLANE_REFERENCE.md` — daemon/worker ownership, lock semantics, and the rule that survivors can relaunch the daemon.
- `~/.prime/agent/models.json` — current custom provider/model source of truth; observed OpenRouter and Sakana entries.
- `~/.prime/agent/settings.json` and `~/.prime/config.json` — user settings and global Prime configuration to preserve.

### Existing patterns to reuse

- Run `bash scripts/prime-runtime-state.sh` before and after every daemon-affecting operation.
- Use `prime-agent shutdown --force` for a complete, transcript-preserving shutdown.
- Treat the immutable bundle path and the launcher symlink as executable artifacts; treat `~/.prime/agent` as durable user state.
- Use redacted structural checks/fingerprints rather than echoing secret-bearing JSON.

### Evidence-based open questions

- Which upstream installer path is selected by the official script on this Mac? Evidence needed: installer output and final resolved executable.
- Does the installer replace or preserve `~/.prime/agent`? Evidence needed: pre/post file fingerprints and a dry structural comparison.
<!-- project_flow:block:research_grounding:end -->

## External Research

<!-- project_flow:block:external_research:start -->

- [Prime Agent documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/index.md) documents the stable install command and states that public releases use versioned release artifacts.
- [Prime Agent GitHub releases](https://github.com/PrimeIntellect-ai/prime-agent/releases) lists v0.9.5 as the latest stable release (released 2026-09-16) and provides the macOS arm64 artifact/checksum; a beta is listed separately and is excluded by this plan.
- The upstream development documentation requires Node.js 22.8.0 or newer; this machine has Node 26.6.0 available.
- [Prime Agent provider documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/providers.md) and [custom-model documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/models.md) document environment-variable resolution for custom `apiKey` fields and the `~/.prime/agent/models.json` location.
<!-- project_flow:block:external_research:end -->

## Current Architecture

<!-- project_flow:block:current_architecture:start -->
### On-disk structure

```text
/opt/homebrew/bin/prime-agent -> ~/.prime/installs/main-c8bc030/.../cli.js
/opt/homebrew/lib/node_modules/prime-agent/       # global package
~/.prime/installs/main-c8bc030/                  # active fork bundle
~/.prime/installs/main-c8bc030-bundle-backup-*    # retired fork bundle
~/.prime/agent/                                   # durable user state
  auth.json
  models.json
  settings.json
  sessions/
  extensions/
~/.prime/config.json                              # global Prime config
```

### Runtime/control paths

- A Prime client/TUI can launch or relaunch the daemon.
- The supervisor owns the daemon socket and adopts worker descriptors.
- Workers own active sessions and kernels; shutdown archives session state and preserves transcripts.
- The global launcher selects the bundle; the bundle reads durable configuration from `~/.prime/agent`.

### Key abstractions and boundaries

- Executable boundary: global launcher/symlink and install directories.
- Runtime boundary: supervisor, workers, TUI clients, kernels, sockets, and registry/lock files.
- Durable state boundary: user config, credentials, custom models, settings, extensions, sessions, and transcripts.

### Failure behavior today

- Any surviving client/worker can relaunch the old bundle after a partial stop.
- Killing only the supervisor leaves workers alive and allows re-election.
- A force shutdown archives active sessions and may discard only zero-message sessions; transcripts remain for non-empty sessions.
<!-- project_flow:block:current_architecture:end -->

## Target Architecture

<!-- project_flow:block:target_architecture:start -->
### Future structure

```text
~/.local/bin/prime-agent -> ~/.local/share/prime-agent/bin/prime-agent
~/.local/share/prime-agent/releases/0.9.5-darwin-arm64-<sha>/  # upstream native release
~/.prime/agent/                                   # retained user state
~/.prime/config.json                              # retained global config
```

### Future control paths

- No Prime process is running during replacement.
- The new upstream launcher starts only when the smoke test invokes it.
- The new CLI reads the pre-existing model/provider/settings/auth files; an upstream first-start auth-format migration is allowed only when credential records and provider behavior remain intact.

### Contracts and invariants

- Single executable source: the globally resolved upstream launcher.
- Single user-state source: the existing `~/.prime/agent` and `~/.prime/config.json` files.
- Fail-loud boundaries: installer/version/launcher mismatch or unexpected config drift fails verification rather than silently falling back; the documented upstream auth migration is accepted only with redacted structural and provider checks.
- Determinism boundary: install the pinned latest stable release observed during planning (v0.9.5), and record the resulting version/path/checksum.
<!-- project_flow:block:target_architecture:end -->

## Call-Site Audit

<!-- project_flow:block:call_site_audit:start -->
| Area | File / path | Symbol / call site | Current behavior | Required change | Why | Tests impacted |
| ---- | ----------- | ----------------- | ---------------- | -------------- | --- | -------------- |
| Launcher | `/opt/homebrew/bin/prime-agent` | symlink | points to fork bundle | repoint/recreate via upstream install | global command must be upstream | version/path smoke check |
| Package | `~/.local/share/prime-agent` | official native global install | absent before cutover; old fork was Node/bundle-based | install upstream v0.9.5 release artifact | use the official stable GitHub release lane | version/path/checksum check |
| Bundle | `~/.prime/installs/main-c8bc030*` | immutable installs | active and backup fork bundles | remove after all processes are stopped | user asked to uninstall fork | filesystem absence check |
| User state | `~/.prime/agent/models.json` | provider/model registry | contains OpenRouter/Sakana custom entries | preserve all model IDs/definitions; update only custom-provider key-resolution fields | retain models and working key lookup | structural/model-ID check |
| User state | `~/.prime/agent/auth.json`, `~/.prime/config.json` | credentials/config | existing credential/config state | preserve credential records and config semantics; allow upstream auth-format migration | keep API keys working | redacted structural/provider check |

### Delete / cleanup list

- Active fork bundle `~/.prime/installs/main-c8bc030/`.
- Retired fork backup `~/.prime/installs/main-c8bc030-bundle-backup-202609151321/`.
- Fork-era global package contents replaced by the upstream global install.
- Stale launcher symlink only as part of a verified upstream replacement.

The following are explicitly retained: `~/.prime/agent/**`, `~/.prime/config.json`, session transcripts, kernel snapshots, custom extensions, and all credential/model/settings files.
<!-- project_flow:block:call_site_audit:end -->

<!-- project_flow:block:phase_plan:start -->
## Depth-First Phase Plan

### Phase 1 — Snapshot and freeze

Status: COMPLETE

- Goal: capture a recoverable, secret-safe baseline and prevent new Prime launches.
- Work:
  - Run the runtime-state inventory and record process/launcher/install facts.
  - Fingerprint preserved files (`settings.json`, `config.json`, and the custom extension) without printing values; separately record redacted auth structure and model/provider identity because upstream may migrate `auth.json` and key-resolution fields.
  - Close/stop Prime TUI clients and ensure scheduled launchers cannot relaunch Prime during the cutover.
- Verification:
  - Baseline receipt exists on disk with paths, hashes, and counts only.
  - No new Prime client launch occurs during the change window.
- Exit criteria:
  - Preservation manifest is written and all live Prime PIDs are known.
- Rollback: n/a (read-only snapshot/freeze).

### Phase 2 — Stop and remove the fork

Status: COMPLETE

- Goal: leave no fork process or executable artifact running.
- Work:
  - Run the documented `prime-agent shutdown --force` from the current fork.
  - Verify the supervisor, workers, kernels, clients, sockets, and locks are gone; terminate leftover Prime clients only after identifying them from the inventory.
  - Remove the global fork package and both `main-c8bc030*` immutable install directories; keep the preservation manifest and user state.
- Verification:
  - Runtime-state output shows zero live Prime supervisor/worker/client processes and no active daemon socket.
  - `command -v prime-agent` is absent or points only to the staged upstream installer target before installation.
- Exit criteria:
  - Fork executable paths are absent and no process can relaunch them.
- Rollback: restore the recorded launcher/package/install artifacts from the staged backup only if the upstream install fails before smoke testing; never restore while a stale Prime process is live.

### Phase 3 — Install upstream latest stable globally

Status: COMPLETE

- Goal: install the latest stable release from Prime Intellect’s GitHub release channel.
- Work:
  - Run the official stable installer/release path for macOS arm64, capturing version, artifact, and checksum.
  - Ensure the global launcher is on PATH and resolves to the upstream install.
  - Do not modify user-state files; if the installer creates defaults, merge only missing non-secret defaults after comparing the manifest.
- Verification:
  - `prime-agent --version` reports v0.9.5 and the resolved native release carries the verified `fc74d38ac4450a495678333e63a88b2a726c3ad5a30c2e45b122c8095729e5f6` archive checksum.
  - Launcher target/repository metadata identifies `PrimeIntellect-ai/prime-agent`, not the old fork path.
- Exit criteria:
  - A clean global upstream CLI is available from a new shell lookup.
- Rollback: uninstall the new global package/launcher and restore the staged fork artifacts only if explicitly needed; preserve user state throughout.

### Phase 4 — Restore configuration and smoke-test

Status: COMPLETE

- Goal: prove custom models and API-key-backed providers still load without exposing secrets.
- Work:
  - Compare post-install fingerprints to the Phase 1 manifest.
  - Normalize only the custom-provider `apiKey` fields in `models.json` to the existing `OPENROUTER_API_KEY` and `SAKANA_API_KEY` environment-variable references; preserve all model arrays and settings.
  - Verify OpenRouter and Sakana provider/model entries, default/recent model settings, auth/config presence, and extension presence.
  - Run one non-interactive CLI smoke invocation that loads configuration and exits successfully without starting a durable session or making a paid model request.
- Verification:
  - Structural/model checks pass; settings/config/extension fingerprints match; expected auth migration and provider probes pass.
  - `prime-agent --offline model list fugu` exits 0 and lists both custom Sakana models; targeted model queries list the OpenRouter custom models.
  - No-cost authenticated `GET /models` probes return HTTP 200 for OpenRouter and Sakana using the configured environment keys.
  - A final runtime-state inventory shows no unexpected daemon/process left running.
- Exit criteria:
  - Latest upstream Prime is globally installed, fork is stopped/uninstalled, and custom configuration is intact and usable.
- Rollback: stop any smoke-test daemon, retain receipts, and restore only the launcher/package if the upstream binary fails; never delete user-state files.
<!-- project_flow:block:phase_plan:end -->

<!-- project_flow:block:implementation_audit:start -->
## Implementation Audit

Date: 2026-09-18
Verdict (code): COMPLETE
Manual QA: complete for install/configuration smoke; interactive session restore intentionally not run

### Evidence

- Baseline: active fork launcher reported 0.9.1; state inventory found 18 Prime TUIs, 29 workers, 72 kernels, and one supervisor.
- Shutdown: after removing one empty malformed runtime mirror directory, `prime-agent shutdown --force` stopped the supervisor and all workers; `prime-agent doctor --fix` removed six exact-dead worker tombstones. Final pre-install inventory had zero Prime processes and zero daemon/worker sockets.
- Removal: the old global npm package, `/opt/homebrew/bin/prime-agent` fork symlink, `~/.prime/installs/main-c8bc030`, `~/.prime/installs/main-c8bc030-bundle-backup-202609151321`, and the fork's `~/.local/share/prime-agent/compat` tree are absent. Temporary quarantine copies were deleted after verification.
- Install: the official stable installer installed native macOS arm64 Prime Agent v0.9.5 at `~/.local/share/prime-agent`; the release archive passed SHA-256 verification against `fc74d38ac4450a495678333e63a88b2a726c3ad5a30c2e45b122c8095729e5f6`.
- Configuration: `settings.json`, `config.json`, and the custom extension fingerprints match the baseline. The upstream first-start path rewrote `auth.json` into its current format during the cutover; its credential records remain present, and the Sakana record matches the already-configured `SAKANA_API_KEY`. `models.json` retains 1 Anthropic, 3 OpenRouter, and 2 Sakana custom models; only its two custom-provider key fields now reference the already-configured environment variables. The original file is retained as `models.json.bak-prime-reinstall-20260918`.
- Provider checks: OpenRouter and Sakana authenticated model-list probes each returned HTTP 200. The upstream CLI lists `fugu-max`, `fugu-ultra-v2.0`, `stealth/union-alpha`, `z-ai/glm-5.3`, and DeepSeek custom entries.
- Final runtime: no Prime supervisor, worker, kernel, or client is running; the daemon socket and worker socket count are zero. The aim MCP server remains running and was not touched.

### Code blockers

- None. This was a host-level installation migration; no repository source code was changed by this task. Pre-existing worktree edits remain untouched.

### Non-blocking follow-ups

- A live generation canary against `stealth/union-alpha` was attempted once but did not complete because the provider returned 404/guardrail availability errors; the Prime process was stopped and cleaned. The no-cost CLI model smoke and authenticated provider probes pass. A paid Fugu generation canary is intentionally not run automatically.
- Resuming prior sessions is intentionally deferred and requires a separate explicit request.
<!-- project_flow:block:implementation_audit:end -->
