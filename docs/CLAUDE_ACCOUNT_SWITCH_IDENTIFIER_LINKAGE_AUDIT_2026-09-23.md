# Claude account-switch identifier linkage audit — 2026-09-23

## Conclusion

`aim claude resume` can switch an existing Claude Code conversation to another Anthropic account, either explicitly with `--account` / `--switch-account` or automatically when the source account is busy or needs login. The normal switch uses Claude Code's `--fork-session`, so the **active session ID is new**. It still replays the source conversation under the destination account. A synthetic request captured from installed Claude Code 2.1.280 included a source `tool_use.id` and its matching `tool_result.tool_use_id` in the destination account's `/v1/messages` body. Exact conversation text was also present. These are direct cross-account join keys; the new session ID alone does not make the continuation unlinkable.

No real Anthropic account was contacted for the request probe. This report distinguishes provider-visible request fields from identifiers retained only in local files, and from unverified adjacent paths.

## Scope and evidence

- Reviewed the current `aim claude run`, `resume`, account projection, managed storage, scheduled routine, legacy `use`, and Claude-backed Prime handoff paths. The working tree already had unrelated edits; this audit changed no runtime code.
- Used a synthetic three-message transcript, dummy API key, fresh temporary config, and an HTTP server bound to `127.0.0.1`. Claude Code 2.1.280 sent the resulting model request only to that local server. The server returned a synthetic 400 response; this proves request construction, not how Anthropic processes or retains the request. Nonessential traffic was disabled in the probe, so it says nothing about telemetry, feature flags, Remote Control, or other endpoints.
- Inspected only identifier **field names** in one 200-line sample of a managed transcript. It had `sessionId`, `uuid`, `parentUuid`, `promptId`, `requestId`, `message.id`, and `messageId` fields. No real identifier values or conversation content were saved to this report.
- Compared identity fields without printing values across the local managed Claude homes: 32 label directories, 30 readable `.claude.json` files. The 30 `userID` values were pairwise distinct; so were `machineID`, `firstStartTime`, and the recorded OAuth account UUIDs. Two label directories had no readable app-state file. This is a useful current-state check, not a guarantee for every machine or future label reuse.

Claude's [CLI reference](https://code.claude.com/docs/en/cli-reference) says `--fork-session` creates a new session ID when resuming; `--resume` also accepts an absolute transcript path, and `--session-id` can set a specific UUID. Its [environment reference](https://code.claude.com/docs/en/env-vars) says `CLAUDE_CONFIG_DIR` scopes settings and session history. The [monitoring reference](https://code.claude.com/docs/en/monitoring-usage) describes the client `user.id` as an installation-scoped identifier and documents session/account identity attributes.

## Findings, ordered by account-linkage risk

### 1. Managed cross-account fork sends source tool IDs and full history to the destination account — confirmed, high

**Entry points.** `aim claude resume <session> --account <other>`; `--switch-account fable|opus`; and plain `aim claude resume <session>` when the source account is busy or requires login.

**Code path.** [`handleClaude`](../src/cli/commands/claude.js#L982-L1059) first tries the recorded account, then chooses a different label and launches with `--resume <source-id> --fork-session --name <fork-name>`. [`stageManagedClaudeSessionFork`](../src/targets/claude-sessions.js#L331-L473) copies the complete source JSONL and companion directory byte-for-byte into the destination config before launch. [`handleRedisClaudeRun`](../src/cli/commands/claude.js#L731-L775) then projects the destination credential and starts Claude in that directory.

**Observed request.** With `--fork-session`, the local `/v1/messages?beta=true` capture had a *new* `x-claude-code-session-id` and a new `session_id` inside the JSON-encoded `metadata.user_id` string. The old full session UUID was absent from the captured headers and body. The body **did contain** the source `tool_use.id`, matching `tool_result.tool_use_id`, source user prompt, and source tool result. The source `message.id` was absent from that model request. The new local fork transcript retained the source entry UUID, `message.id`, tool ID, and fork name, while rewriting the `sessionId` field. Anthropic's [tool-use protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) requires the tool-use ID in the replayed assistant/tool-result message pair.

**Impact.** The provider can match a tool ID previously seen under account A to the same ID sent under account B. Even for source conversations with no tool calls, replaying exact text and tool outputs gives a strong content fingerprint. `--fork-session` solves session UUID reuse, but it does not remove these links.

**Fix direction.** Treat native transcript fork as an account-linked continuation. For a switch that must avoid prior identifiers, start a fresh Claude session and supply a deliberately reviewed summary. A transcript-preserving alternative would have to consistently rekey every replayed tool-use/result pair and other retained IDs; it would still replay linkable conversation content. Validate any implementation against actual outbound request bodies, because Claude's transcript format is internal and version-dependent.

### 2. Raw Claude passthrough can reuse the exact source session UUID under a different account — confirmed path, high

**Entry points.** `aim claude run <destination> -- --resume <absolute-source-transcript.jsonl>` and `aim claude run <destination> -- --session-id <source-uuid>`. The first is enough to reproduce this finding. An ID-only `--resume` ordinarily searches the destination config and may not find the source file; an absolute transcript path bypasses that practical boundary.

**Code path.** [`handleRedisClaudeRun`](../src/cli/commands/claude.js#L762-L775) passes `opts.afterDoubleDash` unchanged. [`buildClaudeArgs`](../src/targets/claude-runner.js#L550-L565) forwards those arguments to the native client. The managed launcher filters competing credential selectors but does not check `--resume`, `--continue`, `--session-id`, or transcript ownership. The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents both the absolute-path resume and explicit session-ID flags.

**Observed request.** A synthetic *direct* resume without `--fork-session` sent the old UUID in `x-claude-code-session-id` and as `session_id` inside the JSON-encoded `metadata.user_id` string to the local model endpoint. The old tool-use ID and conversation text also appeared. The same probe with `--fork-session` sent a new session UUID instead. No live account was used.

**Impact.** Anyone using the passthrough to resume a source transcript while selecting another managed label can hand Anthropic the exact old session UUID under the destination credential. This bypasses the safer UUID behavior of `aim claude resume`.

**Fix direction.** Enforce an account-origin check for native resume paths and reject a cross-label `--session-id` reuse before launch. If a manual override is retained, make the cross-account identifier disclosure explicit at the command boundary. The existing `aim claude resume` path should not be described as unlinkable, because finding 1 still applies.

### 3. Legacy non-Redis `aim claude use` rotates credentials in one shared Claude home — confirmed design, high when used

**Entry point.** `aim claude use <label>` only when AIM Redis is **not** configured. The current Redis-backed command rejects `use` at [`claude.js:1266`](../src/cli/commands/claude.js#L1263-L1275), so this is not the normal managed-home path on this machine.

**Code path.** [`applyClaudeCliFromState`](../src/targets/claude-cli.js#L270-L350) writes the selected account's OAuth bundle into the ordinary home. [`buildClaudeAppStatePayload`](../src/targets/claude-cli.js#L91-L103) merges only a new `oauthAccount` into the existing `.claude.json`, preserving other fields such as `userID` and `machineID`. Prior sessions in that same home also remain available. The legacy control-panel action reaches the same activation function at [`actions.js:61`](../src/panels/actions.js#L61-L71).

**Observed request.** In the local synthetic probe, two model requests from the **same** config directory using two different dummy API keys and different active session UUIDs produced the same `device_id` inside the JSON-encoded `metadata.user_id` string. The exact device-ID derivation was not established. A single global Claude home therefore exposes a stable provider-visible device marker across account rotations, even with fresh session UUIDs. The [monitoring reference](https://code.claude.com/docs/en/monitoring-usage) also describes `user.id` as persisted in `.claude.json`.

**Fix direction.** Retire this account-switch path or put each underlying account in its own config directory. Do not repoint a shared Claude app-state and session directory to a different identity.

### 4. The destination fork name encodes source account label and session prefix — confirmed local, external transmission unverified

[`buildManagedClaudeSessionForkName`](../src/targets/claude-sessions.js#L321-L329) constructs `[fork from <source-label>/<first-8-hex-of-source-uuid>] <title>` and [`handleClaude`](../src/cli/commands/claude.js#L1033-L1053) passes it as `--name` under the destination account. The local synthetic fork transcript retained this name. It was **absent** from the captured `/v1/messages` request body; the probe had nonessential traffic disabled and did not inspect telemetry or Remote Control. The [CLI reference](https://code.claude.com/docs/en/cli-reference) describes `--name` as a session display name.

This is an explicit local account-linkage marker and becomes an external disclosure if the title is later synced, exported, shared, or emitted by another client channel. A neutral destination title would avoid carrying the label and UUID prefix without affecting the new session ID.

### 5. Shared environment and customizations can add stable caller IDs to every account's requests — conditional

[`buildContainedLaunchEnvironment`](../src/targets/claude-runner.js#L18-L32) and [`claude-runner.js:535`](../src/targets/claude-runner.js#L535-L547) delete a short list of credential/backend selectors and preserve other inherited variables. The existing [runner test](../test/claude/claude-runner.test.js#L229-L312) specifically expects `ANTHROPIC_CUSTOM_HEADERS` to survive. Claude's [environment reference](https://code.claude.com/docs/en/env-vars) says `ANTHROPIC_CUSTOM_HEADERS` adds request headers and `CLAUDE_CODE_EXTRA_BODY` merges fields into every API request. A stable account, tenant, trace, or developer ID in either variable therefore crosses managed labels. Shared user hooks, MCP config, and plugins are also projected into each account by [`prepareClaudeCliLaunch`](../src/targets/claude-runner.js#L488-L532); those are possible third-party sinks, not proof of an Anthropic leak.

The audit process had no inherited `ANTHROPIC_*`, `CLAUDE_*`, or `OTEL_*` variable names set. Other shells, launchd jobs, project settings, and hooks were not exhaustively inspected. Filter known identity-bearing request overrides in the managed launcher or make them explicitly per-label. Keep unrelated developer environment variables available unless a specific leak path is established.

## Adjacent path: Claude-backed Prime `--rotate`

This is a separate client from Claude Code. [`aim prime resume <session> --rotate`](../src/cli/commands/harness-target.js#L524-L566) selects a different Anthropic credential, passes the **same** `profile.sessionId` plus the old and new binding/fingerprint to Prime's `__aim-handoff-credential`, then reattaches the same root. [`readPrimeSessionProfile`](../src/targets/prime-sessions.js#L155-L230) reads that ID and binding history from one transcript. The [README](../README.md#L390-L409) calls it a same-root live handoff.

This creates an exact local association between the two underlying accounts. This audit did not capture Prime's Anthropic request after handoff, so it does **not** establish that the Prime session ID or AIM fingerprints reach Anthropic. If the privacy requirement also covers Prime sessions, inspect that request path before treating `--rotate` as an unlinkable switch; a new Prime root is the conservative operational boundary.

## Current safeguards and limits

- The normal Redis-managed Claude launcher uses a per-label `CLAUDE_CONFIG_DIR`, projects the selected destination OAuth identity, and checks the label's expected email before launch: [`paths.js:98`](../src/io/paths.js#L98-L103), [`claude-runner.js:535`](../src/targets/claude-runner.js#L535-L547), [`claude.js:696`](../src/cli/commands/claude.js#L696-L745). The local 30 readable managed configs had distinct `userID`, `machineID`, and OAuth account UUID values. This reduces installation-ID reuse in ordinary fresh sessions.
- Scheduled Claude routine occurrences create a fresh UUID and pass it as `--session-id`, then keep one credential lease through the interactive process: [`run.js:848`](../src/routines/run.js#L848-L875), [`claude.js:55`](../src/routines/claude.js#L55-L75). No routine cross-account resume was found in this path.
- The local probe did not observe source account UUID, source full session UUID, source `message.id`, or fork name in the **forked model request**. It did observe a source tool ID and exact source content. This negative result is limited to Claude Code 2.1.280, the synthetic transcript, and `/v1/messages` with nonessential traffic disabled.
- No packet capture with real OAuth accounts was performed. This report cannot determine whether Anthropic associates accounts through network address, billing, browser identity, telemetry, feature flags, or content matching beyond the confirmed request fields.

## Recommended order

1. Decide whether cross-account Claude continuation must avoid **all prior history** or only explicit identifiers. Full native resume cannot meet the first requirement because it resends exact conversation content.
2. Make a fresh session with a reviewed summary the default account-switch behavior; label native fork as an account-linked continuation if retained.
3. Block cross-label raw `--resume` and reused `--session-id` at `aim claude run`, and remove the source label/UUID prefix from generated destination titles.
4. Close the legacy global-home switch path; check inherited request headers/body overrides when launching managed labels.
5. If Prime's Claude-backed `--rotate` is in the same privacy scope, capture one synthetic post-handoff request or inspect the Prime provider serializer before making a server-side claim.
