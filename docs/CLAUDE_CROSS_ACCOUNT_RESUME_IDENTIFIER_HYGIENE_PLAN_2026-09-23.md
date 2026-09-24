---
title: "Claude Cross Account Resume Identifier Hygiene — Plan"
date: 2026-09-23
status: complete
fallback_policy: forbidden
owners: [aimgr]
reviewers: []
doc_type: phased_refactor
related:
  - CLAUDE_ACCOUNT_SWITCH_IDENTIFIER_LINKAGE_AUDIT_2026-09-23.md
---

# TL;DR

- Outcome: A Claude conversation can resume under any managed destination account with its prior history available, while the destination launch and model request contain freshly generated Claude session, message, request, entry, prompt, and tool identifiers.
- Problem: The current account-switch fork copies the source transcript verbatim, and raw `--resume` can send the old session ID directly.
- Approach: Stage a private, rekeyed transcript in the destination home, fork from that copy, and route cross-account native resume arguments through the same staging path.
- Boundary: Verbatim conversation text and tool output remain available. Exact content can itself correlate accounts; full unlinkability is impossible while preserving full history. This plan removes explicit Claude-generated join keys and known caller-supplied request identifiers, not content fingerprints, IP address, provider telemetry, or unrelated application identifiers embedded in conversation text.

## North Star

> For every supported `aim claude` cross-account resume, the source transcript stays untouched, the new account can continue the full conversation, and a local request capture contains none of the source Claude-generated IDs.

### In scope

- `aim claude resume` when `--account`, `--switch-account`, or automatic fallback selects a different managed account label.
- `aim claude run <label> -- --resume <absolute transcript path>` and managed ID-based resumes that cross an account boundary.
- The destination fork title and managed launcher environment fields that can inject stable request identifiers.
- Synthetic integration tests using the installed Claude client and a localhost endpoint, with dummy credentials only.

### Out of scope

- Claude-backed Prime Agent handoff. It is a different client and transcript format; the preceding audit did not establish its provider request contents.
- Legacy non-Redis `aim claude use`. It changes the global Claude home rather than using managed destination homes and needs a separate migration that preserves bare `claude` behavior and existing local data.
- Rebinding an existing managed label to a different underlying account. Managed homes are currently keyed by label; migrating them to account identity requires its own storage migration.
- Redaction of arbitrary user text, tool output, project paths, or domain identifiers. Those are needed to continue an arbitrary session faithfully.

### Key invariants

- A user can choose any managed destination label and continue any readable Claude transcript; the command does not silently downgrade to a summary.
- Source transcript and companion files are read-only. A temporary destination copy is removed after launch, including on failure; the forked destination session remains.
- All generated IDs are mapped consistently across assistant tool-use blocks, user tool results, transcript metadata, and structured references.
- A session ID from the source must never be the destination `--resume` argument or active session ID.
- Unsupported or unsafe source files fail before native launch with a clear error; there is no leak-prone fallback.

## Problem Statement and Grounding

- [`src/cli/commands/claude.js`](../src/cli/commands/claude.js) selects a destination and supplies `--resume <sourceId> --fork-session`; the same command also forwards raw native arguments.
- [`src/targets/claude-sessions.js`](../src/targets/claude-sessions.js) currently copies the transcript and companion directory byte-for-byte, and names a fork using the source account label and session ID prefix.
- [`src/targets/claude-runner.js`](../src/targets/claude-runner.js) removes competing credentials but preserves `ANTHROPIC_CUSTOM_HEADERS` and `CLAUDE_CODE_EXTRA_BODY`, which Claude documents as request modifiers.
- The [identifier linkage audit](CLAUDE_ACCOUNT_SWITCH_IDENTIFIER_LINKAGE_AUDIT_2026-09-23.md) captured a source tool ID in the destination `/v1/messages` body and a source session ID in direct raw resume headers, using a synthetic localhost request.
- Sampled managed transcript schemas contain `sessionId`, `uuid`, `parentUuid`, `leafUuid`, `promptId`, `requestId`, `message.id`, tool-use/result IDs, and structured references such as `sourceToolUseID` and `wireToolInputs` keys.
- Claude's [CLI reference](https://code.claude.com/docs/en/cli-reference) documents `--fork-session` and absolute transcript-path resume. Its [environment reference](https://code.claude.com/docs/en/env-vars) documents `CLAUDE_CONFIG_DIR` and request override variables.

## Target Architecture and Call Sites

1. A single transcript staging function parses the source JSONL, generates a new temporary session UUID, remaps every recognized Claude-generated ID, rewrites structured references consistently, and stages the companion directory under the new UUID. It returns the staged absolute transcript path for the native `--resume` argument.
2. Both managed online and clean offline launch paths use the returned path and force `--fork-session` when the source account differs. Same-account resume keeps its current direct behavior.
3. Raw native `--resume` arguments are inspected before launch. Cross-account absolute paths and discoverable managed IDs use the same staging function; destination-owned paths retain native behavior. A recognized source ID used as `--session-id` is rejected with a resume instruction.
4. Generated fork names omit source label and source ID. Managed launch drops inherited request header/body override variables so they cannot carry a stable ID between labels.
5. Tests cover ID mapping, original-file immutability, cleanup, companion files, destination selection, raw bypasses, and one synthetic native request capture.

## Depth-First Phase Plan

### Phase 1 — Safe staging foundation

Status: complete.

- Goal: Produce a fully rekeyed, structurally valid temporary transcript and companion copy.
- Work: Implement consistent ID remapping and validate source format and path. Preserve full message content and tool relationships. Use new staging paths and a neutral title.
- Verification: Unit tests assert old generated IDs are absent from staged JSONL and new tool-use/result links still match; source files are identical after cleanup.
- Exit criteria: Staging returns a new path and cannot silently copy old IDs into the destination.
- Rollback: Revert the implementation; never fall back to a verbatim cross-account copy at runtime.

### Phase 2 — Route every managed cross-account resume

Status: complete.

- Goal: Keep all supported destination selection and history-resume capabilities while making the safe staging path mandatory at account boundaries.
- Work: Update online/offline launch argument construction; inspect raw `--resume` and `--session-id`; remove inherited request modifier variables.
- Verification: Existing CLI tests plus new cases for explicit, automatic, absolute-path, and ID-based cross-account resume.
- Exit criteria: No supported cross-account `aim claude` launch sends a known source session ID as its resume argument or active ID.
- Rollback: Revert the implementation; never bypass staging automatically.

### Phase 3 — Native request proof and completeness audit

Status: complete.

- Goal: Check the actual installed Claude client request shape and plan compliance.
- Work: Run a dummy-key localhost request probe with a synthetic transcript, targeted test suites, and a call-site search; record remaining limits and exact test results here.
- Verification: Captured destination request lacks the source session, message, request, prompt, entry, and tool IDs while retaining prior conversation content and valid tool pairing.
- Exit criteria: The implementation audit below reports complete or lists an explicit blocker.
- Rollback: n/a.

<!-- project_flow:block:implementation_audit:start -->
## Implementation Audit

Date: 2026-09-23  
Verdict (code): COMPLETE  
Manual QA: n/a; the native request check used dummy credentials and a localhost endpoint.

### Implemented

- [`claude-transcript-rekey.js`](../src/targets/claude-transcript-rekey.js) rekeys the source session UUID and observed Claude protocol IDs consistently, including tool-use/result pairs and structured references. It preserves unrelated IDs inside tool inputs and results. An incomplete final JSONL record is dropped; malformed earlier records fail before launch.
- [`claude-sessions.js`](../src/targets/claude-sessions.js) stages the rekeyed JSONL and companion directory under a new UUID, removes previous fork provenance from generated titles, checks that the source file did not change while staging, and cleans the temporary destination copy after the native process exits.
- [`claude.js`](../src/cli/commands/claude.js) sends the staged absolute path to native Claude with `--fork-session` for explicit and automatic account switches, raw absolute-path and managed ID resumes, and clean offline-cache launches. Destination-owned resumes remain direct. A known cross-account `--session-id` collision and a conflicting explicit session ID on a cross-account resume fail before native launch.
- Cross-account launches omit inherited `ANTHROPIC_CUSTOM_HEADERS` and `CLAUDE_CODE_EXTRA_BODY`; ordinary same-account launches retain their existing environment behavior. The [README](../README.md) describes the new behavior and the content-linkage limit.

### Verification

- `npm test`: 527 passed, 0 failed. `npm run lint` and `git diff --check`: passed.
- Unit and CLI tests cover coherent ID mapping, protocol tool pairing, domain-ID fidelity, source immutability, companion cleanup, explicit and automatic destination selection, raw path and ID selectors, `--resume=` and `-r`, the offline cache path, and conflicting `--session-id` handling.
- The installed Claude Code 2.1.280 sent one synthetic `/v1/messages` request to `127.0.0.1` using a dummy API key. Its active session ID was fresh; source session, entry, message, request, and tool IDs were absent from captured headers and body. The new tool ID appeared in both tool-use and tool-result blocks, and prior prompt/tool text remained. The local server deliberately returned 400, so this checks request construction rather than provider acceptance or retention.
- A read-only dry run rekeyed 50 existing local transcripts (about 738 MB total) with no parser failures. The largest sampled transcript was 118 MB and completed in about 12 seconds, reaching about 1 GB process RSS. This is a material memory cost for larger future sessions.

### Code blockers

None within the managed Claude Code scope above.

### Remaining limits

- Full resumed history still sends exact prior text and tool output to the destination account. A provider can correlate accounts from that content, network context, or telemetry even when explicit transcript IDs are changed. Eliminating those signals would require a fresh session with a reduced or reviewed summary, which would not preserve full native resume behavior.
- Claude transcript format is internal and can change. The request probe covers Claude Code 2.1.280 and one synthetic conversation shape. Real OAuth accounts were not contacted.
- Rebinding a managed label to a different underlying account can reuse that label's local Claude installation identity and history. This change covers switches to another managed label; account-identity keyed homes would be needed to cover label reuse safely.
- Legacy non-Redis `aim claude use` and Claude-backed Prime Agent handoff remain outside this plan's scope as stated above; they retain the risks documented in the [identifier linkage audit](CLAUDE_ACCOUNT_SWITCH_IDENTIFIER_LINKAGE_AUDIT_2026-09-23.md).
<!-- project_flow:block:implementation_audit:end -->
