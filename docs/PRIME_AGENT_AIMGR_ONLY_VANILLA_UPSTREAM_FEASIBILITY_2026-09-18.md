# AI Manager can keep Prime Agent vanilla for Claude and Codex, with two boundaries

As of 2026-09-18, AI Manager can launch the upstream Prime Agent and use its existing credential interfaces for scheduled Claude and OpenAI Codex jobs without changing Prime Agent source. The fork-only behavior that cannot be reproduced by AI Manager configuration alone is a live Prime session carrying an AIM binding and automatically advancing to another account inside that same session after a provider limit.

This document answers one narrow question: what must change in [AI Manager](/Users/aelaguiz/workspace/aimgr) so the upstream [Prime Agent commit `ff40ea24e129e69b09b553f801dda6699d820424`](https://github.com/PrimeIntellect-ai/prime-agent/tree/ff40ea24e129e69b09b553f801dda6699d820424) remains unmodified while AI Manager owns Claude and Codex account selection, refresh, rotation, and scheduled launches.

## Decision

Use an AI Manager-only vanilla bridge for process and job boundaries, while keeping daemon-backed Prime launches in one canonical Prime state domain. The bridge should expose a selected AIM credential through Prime's supported provider configuration without changing Prime Agent source. A private `PRIME_AGENT_CODING_AGENT_DIR` is allowed only for an explicitly standalone, non-attached process with its own socket/lifecycle contract.

Keep the stronger fork contract out of this first implementation. The upstream process does not understand AIM's `type: "external"` credential descriptor, does not receive an AIM binding or identity fingerprint, and does not have an external `advance` operation for quota failover.

## Centralized daemon constraint

The earlier per-launch agent-directory overlay is not safe as the default path for Prime sessions. In upstream Prime, the agent directory is part of the daemon state identity: supervisor ownership records, worker descriptors, cron jobs, session ledgers, settings, `auth.json`, and `models.json` are all scoped from that directory. See [the upstream daemon state root](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/modes/daemon/daemon-state-root.ts#L7-L52) and [the supervisor ownership records](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/modes/daemon/daemon-supervisor-ownership.ts#L535-L577).

The default daemon socket is separate from the agent directory and is shared per user/TMPDIR. Two launches that use different agent directories but the default socket do not automatically become two clean, independent daemons: they can contend with the socket and the supervisor that owns it. See [the upstream default socket](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/modes/daemon/daemon-socket.ts#L70-L75) and [the upstream state-root rule](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/modes/daemon/daemon-state-root.ts#L41-L52).

Therefore the AIM design has two explicit lanes:

1. **Central daemon lane:** use the canonical `~/.prime/agent` and the existing default daemon. AIM may select, refresh, and project Claude/Codex credentials through supported upstream auth/configuration at that same root, but it must not set a new agent directory per account or job. Rotation happens at a new job/session boundary.
2. **Standalone lane:** use a private agent directory only when AIM deliberately starts a process that must not attach to the normal daemon. That lane also needs an explicit private socket/domain and lifecycle cleanup. It must not invoke ordinary daemon-attached `prime-agent --resume` behavior against the default socket.

Mixing these lanes is the failure mode that recreates the previous multiple-domain mess. In particular, do not pair a per-account `PRIME_AGENT_CODING_AGENT_DIR` with the default daemon socket, and do not place a session in one agent directory while expecting the supervisor, worker registry, cron store, and locks from another directory to govern it.

## What the upstream Prime Agent already supports

| Capability | Upstream behavior | Consequence for AI Manager |
|---|---|---|
| Per-launch state | `PRIME_AGENT_CODING_AGENT_DIR` selects the agent directory. Prime reads `auth.json` and `models.json` from that directory. The implementation is in [upstream `config.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/config.ts#L500-L532) and [upstream `agent-session-services.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/core/agent-session-services.ts#L151-L160). | AI Manager can give a standalone Prime process a private credential view. This is not a safe default for a client expected to attach to the centralized daemon. |
| API-key resolution | `auth.json` accepts `type: "api_key"`. The key can be a literal, an environment-variable name, or a shell command beginning with `!`. The upstream provider guide documents this at [providers.md](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/docs/providers.md#auth-file). | AI Manager can expose an access token through a trusted local command without placing the token in a persistent Prime descriptor. |
| Dynamic provider keys | `models.json` provider configuration accepts `apiKey` and stores it as a request-auth source. The request path resolves command-backed keys with `resolveConfigValueOrThrow`, which uses the uncached command resolver. The relevant code is [upstream `model-registry.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/core/model-registry.ts#L1498-L1523). | AI Manager can fetch current credential material at request time for a managed provider, subject to the session and transport limits below. |
| Anthropic subscription token | The upstream Anthropic provider recognizes `sk-ant-oat` OAuth tokens and sends them as `authToken` with the Claude subscription headers. See [upstream `anthropic.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/ai/src/providers/anthropic.ts#L854-L965). | An AIM Claude access token can be supplied to vanilla Prime without Prime-specific code. |
| OpenAI Codex subscription token | The upstream Codex provider accepts the access JWT, extracts `chatgpt_account_id`, and sends both the bearer token and `chatgpt-account-id`. See [upstream `openai-codex-responses.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/ai/src/providers/openai-codex-responses.ts#L89-L135) and [the account-id extraction](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/ai/src/providers/openai-codex-responses.ts#L1248-L1258). | An AIM Codex access token is sufficient for the vanilla Codex transport. No Prime fork hook is required to derive the account header. |
| Built-in models | A built-in provider can be overridden in `models.json` without replacing its model list. The upstream registry stores provider request configuration and applies only the supplied base URL or compatibility override when no custom model list is present. See [upstream `model-registry.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/core/model-registry.ts#L595-L618) and [the provider override path](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/core/model-registry.ts#L673-L692). | AI Manager can add an auth command for `anthropic` and `openai-codex` while retaining the upstream model catalog. |

## Why the current AIM Prime projection cannot work with vanilla Prime

AI Manager currently writes an external descriptor through [the harness auth adapter](/Users/aelaguiz/workspace/aimgr/src/targets/harness-auth.js:98). The descriptor has `type: "external"`, `source: "aimgr"`, `protocol: "aimgr-credential-v1"`, an absolute helper executable, and `args: ["credential-helper"]`.

The upstream `AuthStorage` accepts API-key, OAuth, and MCP static-token credential shapes. It has no `external` credential type and no `aimgr-credential-v1` resolver. The current descriptor therefore depends on the fork-only Prime code in the inventory document [Prime Agent fork change inventory](/Users/aelaguiz/workspace/aimgr/docs/PRIME_AGENT_FORK_CHANGE_INVENTORY_2026-09-18.md).

The current scheduled Prime path has the same dependency. [AI Manager's routine launcher](/Users/aelaguiz/workspace/aimgr/src/routines/run.js:279) runs `aim prime use`, then requires the selected Prime `auth.json` entry to be an AIM external descriptor at [the descriptor check](/Users/aelaguiz/workspace/aimgr/src/routines/run.js:306). The upstream Prime process cannot consume that entry, so the existing routine implementation is not vanilla-compatible even though its launcher already resolves the upstream `prime-agent` executable.

## Feasibility by requested behavior

| Requested behavior | AI Manager-only result | Exact boundary |
|---|---|---|
| Launch the unchanged upstream Prime Agent | Works. | [The Prime launcher](/Users/aelaguiz/workspace/aimgr/src/targets/prime-launcher.js:5) already resolves `prime-agent` from `PATH` and rejects the fork's `--dist` lane. |
| Select one AIM Claude or Codex account for a new Prime process | Works with a vanilla bridge, subject to the daemon lane chosen. | AI Manager selects the Redis record, refreshes it when due, and exposes only the selected access token through supported provider configuration in the canonical daemon root or through a fully standalone Prime domain. |
| Refresh a selected credential before a job starts | Works. | [The existing harness resolver](/Users/aelaguiz/workspace/aimgr/src/credentials/harness-access.js:340) already validates the identity, runs provider maintenance when due, reloads Redis state, and returns an access token without returning refresh material. |
| Run scheduled Prime jobs through AIM | Works after changing the AIM projection and routine verifier. | A daemon-backed job must stay in the canonical agent directory; a standalone job must use its own socket/domain. In either lane, verify the AIM launch receipt instead of requiring the fork-only `external` descriptor. |
| Rotate accounts between scheduled jobs | Works. | Each new occurrence selects a fresh eligible account and starts a new Prime process or isolated job configuration. |
| Fetch a current credential for a new request in a running session | Partly works for Anthropic and for non-continuation requests. | A `models.json` provider command is resolved on the request path, but vanilla Prime receives no binding or rotation reason. Codex WebSocket continuation is tied to the connection and account, so account changes require a new process or a transport reset. |
| Fail over from one Codex account to another after a usage limit inside the same Prime session | Does not work as the fork did. | Upstream Codex reports usage exhaustion as a quota-style provider failure. Upstream recovery waits or retries; it does not call an AIM `advance` operation with the rejected account. |
| Preserve the account binding and identity in the Prime transcript | Does not work natively. | Vanilla Prime records provider and model, not an AIM label or identity fingerprint. AIM can keep that information in its own receipt or sidecar. |
| Keep the normal Prime custom models and unrelated keys | Works with a canonical-root merge or a standalone overlay copy. | The bridge must add only the Claude and Codex provider auth entries, preserve the existing custom model definitions, and never make a daemon-backed launch use a second agent directory. |

## Smallest AI Manager-only design

1. Add a vanilla Prime projection mode to [the AIM harness target](/Users/aelaguiz/workspace/aimgr/src/cli/commands/harness-target.js). It must stop writing `type: "external"` for Prime. For daemon-backed launches, keep the canonical Prime agent directory and project only supported Claude/Codex provider configuration there; do not create a per-account Prime daemon domain. If a temporary private projection is needed for a standalone job, copy the user's custom `models.json` providers into that private directory and remove only conflicting managed-provider overrides.

2. Add a constrained AIM token command for Prime. The command should accept a provider, binding, and expected identity fingerprint from the private launch metadata, call [the existing access resolver](/Users/aelaguiz/workspace/aimgr/src/credentials/harness-access.js:340), and print exactly one access token to stdout. It must print diagnostics to stderr and never print refresh tokens, Redis records, or JSON protocol envelopes to stdout.

3. Render the managed provider entries with the upstream built-in base URLs and the token command as `apiKey`. In the canonical daemon lane, merge those entries into the canonical configuration without replacing the built-in model list. In the standalone lane, render the same entries in the private copy. The provider command is the supported upstream extension point; Prime itself remains the stock binary.

4. Do not set `PRIME_AGENT_CODING_AGENT_DIR` for daemon-backed managed launches. Keep the canonical agent and session directories so all clients, workers, locks, cron jobs, and transcripts remain in one Prime domain. Set the variable only for the explicitly standalone lane, together with a private socket/domain and an isolated lifecycle. [The upstream configuration contract](https://github.com/PrimeIntellect-ai/prime-agent/blob/ff40ea24e129e69b09b553f801dda6699d820424/packages/coding-agent/src/config.ts#L500-L532) makes the standalone choice possible, but it is not a safe default for a centralized daemon.

5. Change [the Prime routine worker](/Users/aelaguiz/workspace/aimgr/src/routines/run.js:279) to verify the AIM launch receipt and the upstream session's provider, model, thinking level, and working directory. The worker should no longer require a fork-only `credential_binding` or `external` entry in Prime's transcript or auth file.

6. Define rotation at the job boundary first. On every scheduled occurrence, AI Manager selects and refreshes an eligible account. If a job exits with a provider limit, AI Manager can record the failure and start a bounded retry with another account. That retry is a new Prime process, which keeps Codex account and WebSocket state coherent.

## What this deliberately does not promise

- Vanilla Prime will not understand `aimgr-credential-v1` or any other new external-auth schema.
- Vanilla Prime will not know which AIM label supplied a token unless AI Manager records that fact separately.
- A running Codex session cannot safely switch accounts while preserving a connection-scoped continuation. Account rotation must start a new process or use an AI Manager proxy that owns the Codex transport.
- Vanilla Prime's built-in retry loop will not receive the fork's `advance` reason or account identity. AI Manager must own retry and relaunch at the scheduled-job boundary if automatic failover is required.
- The bridge should not add xAI, MCP, TUI, performance, daemon, model-catalog, or other fork features. The requested implementation surface is Claude and OpenAI Codex only.

## Recommended implementation boundary

The clean boundary is **AIM selects and materializes credentials; vanilla Prime sends requests using its documented provider interfaces; AIM restarts or relaunches the process when account rotation is needed**. For the normal Prime experience, those operations stay inside one canonical daemon domain. A private agent directory is a separate standalone lane, not an account-selection overlay for the shared daemon.

That boundary satisfies the requested scheduled-job path without forking Prime Agent if the scheduled jobs use the canonical daemon lane or an explicitly isolated standalone lane. It preserves the user's existing Prime custom models by changing only supported provider configuration in the canonical root, or by copying them into a standalone overlay without attaching that overlay to the shared daemon. Reproducing the fork's stronger in-session binding, identity checks, and Codex `advance` behavior would require either a Prime upstream feature that accepts external credential providers or a substantial AIM-side proxy. Neither is needed for the limited scheduled Claude and Codex path.

## Evidence and scope

The inspection covered the upstream Prime Agent source at commit [`ff40ea24e129e69b09b553f801dda6699d820424`](https://github.com/PrimeIntellect-ai/prime-agent/tree/ff40ea24e129e69b09b553f801dda6699d820424), the upstream provider and model configuration documents, and the current AI Manager implementation in [the aimgr workspace](/Users/aelaguiz/workspace/aimgr).

The AI Manager facts come from [the credential helper](/Users/aelaguiz/workspace/aimgr/src/cli/commands/credential-helper.js:1), [the harness access resolver](/Users/aelaguiz/workspace/aimgr/src/credentials/harness-access.js:340), [the Prime projection adapter](/Users/aelaguiz/workspace/aimgr/src/targets/harness-auth.js:98), [the Prime routine worker](/Users/aelaguiz/workspace/aimgr/src/routines/run.js:279), and [the routine definition contract](/Users/aelaguiz/workspace/aimgr/src/routines/config.js:54).
