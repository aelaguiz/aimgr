---
title: "Shared AI Manager Account Notes — Plan"
date: 2026-11-07
status: draft
fallback_policy: forbidden
doc_type: project_plan
---

# Shared account notes

## Outcome

Anyone using AI Manager can add, read, change, or clear a plain-language note on any managed account. Notes live in shared Redis, never in machine-local state or caches, and appear in `aim status`, account-specific status output, and the account selection and launch paths agents use. Notes are advice: they do not alter account eligibility, selection, leases, or launch behavior.

Example, with the provider specified because account labels can exist under more than one provider:

```text
aim note set iphone_se_1 "Reserved for the iPhone SE 1" --provider anthropic
aim note show iphone_se_1 --provider anthropic
aim note clear iphone_se_1 --provider anthropic
```

An `aim status` note section would include:

```text
ACCOUNT NOTES
anthropic / iphone_se_1: Reserved for the iPhone SE 1
```

The provider may be omitted when exactly one managed account has that label. If multiple providers have it, the command names the matches and asks for `--provider`; it does not guess. A missing account is an error. `set` replaces the one note for that account; `clear` removes it. No note is created as part of this planning task.

## Current behavior and design

- Shared managed accounts are Redis records identified by **provider plus label**, not label alone (`src/coordination/records.js`, `src/coordination/redis-store.js`). The same label can represent different providers.
- Existing account-record normalization keeps only known fields. Older installed AI Manager versions can rewrite those records without a new field. Storing notes inside the credential or policy record would therefore risk losing them during ordinary credential publication. Store notes in separate, indexed Redis records keyed by provider and label, with the existing Redis compare-and-swap pattern. This also keeps note edits independent of credential refreshes.
- `aim status` uses `src/status/redis-view.js` and `src/status/render.js`; its normal human view filters some blocked accounts and only renders Codex and Claude tables. Add an **Account notes** section drawn from all existing managed provider accounts, including accounts filtered out of the tables and xAI/Sakana accounts. Keep the existing tables' filtering and selection behavior unchanged.
- `aim status --compact` is the first command in `skills/aimgr/SKILL.md` and is also recommended to MCP callers. Keep its existing first line intact and append short, provider-qualified note lines when notes exist. `aim status --json` exposes the notes as structured account data, including notes for managed providers that do not otherwise appear in its account tables. Do not mix free text into JSON stdout.
- Provider views are separate: Claude status/inventory in `src/status/claude-redis-view.js`, Grok status/inventory in `src/status/xai-redis-view.js`, and Sakana list/show/use in `src/cli/commands/sakana.js`. Include the relevant account note in their human and JSON results. The existing Sakana credential `notes` field predates this feature; retain it as existing Sakana metadata and label the new shared account note distinctly, so adding this feature does not silently overwrite or lose existing content.
- Account commands in `src/cli/commands/claude.js`, `codex.js`, `prime.js`, `pi.js`, `grok.js`, and `sakana.js` have different output and launch contracts. For commands that select, switch, resume, or start an account, show its note to the invoking person or agent at selection or before the child starts, including noninteractive use. Include it in existing structured receipts when the command returns JSON; keep stdout parseable and avoid adding output to credential-helper or other machine-only protocols. For a picker, show notes before the choice. Do not inject notes into the launched agent's prompt or transcript.
- Update `skills/aimgr/SKILL.md` and its status reference to tell agents to read account notes when choosing or using an account and take them into account. The CLI still makes notes visible to callers that do not load the skill. Notes remain advisory and do not override the caller's instructions or create a new account-selection rule.
- The existing status cache projects an allowlist of safe fields (`src/status/redis-view.js`, `src/status/redis-cache.js`). Do not add notes to that cache or any other machine-local state, file, log, or persisted receipt. During a Redis outage, status must say account notes are unavailable, including when it can show cached account data. Note reads and mutations require live Redis; failure must never be presented as an empty note.
- Keep note records in Redis through the shared Redis service's backup and restore. Do not introduce a machine-local notes export, import, or synchronization path.

Notes are ordinary shared operational text visible to everyone with access to AI Manager. Rendering must preserve the note while safely handling terminal control characters and line breaks; human output must not let note text forge another account row. Do not put credentials in notes.

## Implementation plan

### 1. Shared storage and editing

Add a separate Redis note record and index for each provider/label pair. Reuse the existing bounded Redis connection and CAS write patterns. Validate that the account exists, resolve provider ambiguity, and implement `aim note set`, `show`, and `clear`, with help and JSON output. Treat absent notes as empty without migrating existing accounts. A concurrent note edit must either succeed against the version read or return a clear conflict; it must never overwrite a different edit or a credential. Preserve Sakana's existing credential notes.

**Exit:** A note written from one AI Manager instance is immediately readable from another using the same Redis, and changing or refreshing a credential does not change the note.

### 2. Show notes where accounts are encountered

Add notes to the full and compact status views, provider-specific status/inventory and relevant JSON, including accounts normally hidden from the main tables. Carry notes into account selection and launch output across Claude, Codex, Prime, Pi, Grok, and Sakana, respecting the existing text, JSON, and machine-protocol contracts and without persisting notes in local receipts. Update CLI help, README, and the distributed AI Manager skill with examples and the advisory behavior. Check the MCP command surface and output limits so notes returned through it reach the caller.

**Exit:** A person or an agent following the normal status-to-launch workflow sees the applicable note, while the same account remains selectable as before.

## Test plan

Use the existing Node test suite, fake Redis, and CLI helpers; avoid live credentials and real provider requests.

1. **Set, read, replace, clear:** Exercise each command against fake Redis, including quoted text, Unicode, multiline/control-character rendering, nonexistent accounts, and explicit provider. Two accounts with the same label under different providers keep independent notes; omission of an ambiguous provider fails with a useful list.
2. **Shared state and concurrency:** Use two independent CLI contexts connected to the same fake Redis. Confirm that an edit from one is visible to the other, a stale concurrent note write reports conflict, and credential refresh/publication and note edits do not overwrite each other. Confirm an older credential-record writer cannot erase the separate note.
3. **All status surfaces:** Test full and compact status, JSON, Claude status/inventory, Grok status/inventory, and Sakana list/show/use. Include a blocked or otherwise filtered account and a provider absent from the main status tables; the account's note must still be visible in `aim status`. No-note accounts retain usable existing output. Check provider/label association and safe display of multiline text.
4. **Selection and agent access:** With launchers stubbed, exercise automatic and explicitly named selections, resume/switch paths, and the Prime, Pi, Claude, Codex, Grok, and Sakana routes. The selected account's note appears before launch or in the relevant structured result, including noninteractive callers. An MCP call and the documented skill workflow see the same note. Compare selection outcomes with and without a note to prove it neither blocks nor changes eligibility or ranking. Verify JSON remains parseable and machine-only protocols stay unchanged.
5. **Outage and recovery:** During a Redis outage, status must say notes are unavailable, even if other status data is cached; `show`, `set`, and `clear` fail clearly. Inspect the status cache and local state/receipts/log output in the test fixture to confirm they contain no note text. After Redis returns, the note is visible again on both test machines. Preserve existing Sakana credential notes.
6. **Local checks:** Run the focused tests in `test/coordination`, `test/cli`, `test/status`, and `test/mcp` that cover the changed paths, plus the existing lint check. Run the full suite once when implementation is ready for review. No live account, login, or deployment is needed for this plan.

## Acceptance

The example note is visible on another machine using the same Redis and in the normal `aim status` and account-use workflow. The note can be edited and cleared without touching credentials. JSON and machine-only callers still work. A note never changes which accounts AI Manager permits or chooses.
