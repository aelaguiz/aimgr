# Prime Agent cutover preflight — inventory and code review

**Date:** 2026-08-12
**Host:** `amir-m5` only
**Status:** **NO-GO for the current candidate executable. No cutover has run.**

## Decision

Do not start the coordinated daemon handoff with the executable currently installed at `/Users/aelaguiz/.local/bin/prime-agent`.

The session side is recoverable and fully inventoried: the exact snapshot contains **196 resident sessions — 25 roots and 171 descendants — with 196/196 workers ready, zero diagnostics, unique UUIDs/session files, and every referenced JSONL present**.

The blocker is build provenance, not the restart coordinator. Candidate commit `3c6c129da0670197959e77c076bc1ae266926668` was bundled after `packages/ai/src/models.generated.ts` acquired an uncommitted 1,307-line regeneration. The resulting executable therefore does not correspond to the reviewed commit and has a real xAI catalog behavior difference described below.

## Immutable build identities

| Surface | Identity |
|---|---|
| Running daemon source | `/Users/aelaguiz/workspace/prime-agent-deploy-20260811` at `3c4f91d1f0c827ee2430ddd5a39deadbe3f6d5d0` |
| Running daemon | PID `94294`; `bundle-v1:a5e7b1b985aa6aea3a7f646ef6946af7536380e14fdb3d84b288c40320b3ed53` |
| Candidate source | `/Users/aelaguiz/workspace/prime-agent-deploy-20260812` at `3c6c129da0670197959e77c076bc1ae266926668` |
| Candidate bundle | `bundle-v1:9a8c537ccbaab9d3ccf3e2ed8fbc49aa7b6a89b1e77d02c531ed1a601c8fcf4b` |
| Candidate dirty catalog | tracked hash `5a9e7f88432d7df663961fadffb9bfa3d04612cdc619a7ff0e43bcdeae693349`; bundled working hash `44b032f7a72b2b6c9d4bb3ac572329705afabc9ba28b6b15be378e0b8363e527` |
| Protocol compatibility | both version `0.7.1`, protocol `7`, schema `protocol-7-schema-15-610272005198`; build identity intentionally differs |

The current daemon is the only live Prime daemon after preflight. A compatibility probe briefly caused the old CLI to launch an empty nondefault daemon on a dead development socket; its session count was verified as zero, it was shut down through that exact socket, and final status again shows only PID `94294`.

## Exhaustive session snapshot

Machine-readable manifest: `docs/PRIME_AGENT_CUTOVER_PREFLIGHT_MANIFEST_2026-08-12.json`

Captured at `2026-08-12T18:40:34.958Z`:

| Invariant | Result |
|---|---:|
| Resident sessions | 196 |
| Top-level roots / descendants | 25 / 171 |
| Ready workers / diagnostics | 196 / 0 |
| Attached / detached roots | 21 / 4 |
| Working roots / busy descendants | 8 / 8 |

An earlier read during the same preflight saw 201 residents and 176 descendants. Five finished descendants deregistered normally before the immutable manifest was written; all 25 root UUIDs remained constant. The cutover must therefore take one final atomic daemon snapshot immediately before checkpointing and use that exact count as its restore target.

### Root sessions and terminal restoration map

| Prime root UUID | Work | Current Herdr/UI location | Daemon state | Required post-cutover action |
|---|---|---|---|---|
| `019ff046-2ba1-71c1-9c7f-fa5e97da2eb3` | merge ready FTL | `default wB:p4` (tui_present_unclassified) | idle; attached 1; ready | Replace old client in default wB:p4; attach exact UUID; verify footer and state |
| `019ff0e9-e061-772f-b8d6-a9f11c7b8287` | issue 3538 | `bugs w2:p2` (recognized) | working; attached 1; ready | Replace old client in bugs w2:p2; attach exact UUID; verify footer and state |
| `019ff098-7fda-745a-8456-9c2b5085505a` | Okay yesterday I had us working through a plan to | `content w3:p3` (recognized) | idle; attached 1; ready | Replace old client in content w3:p3; attach exact UUID; verify footer and state |
| `019ff112-1dfa-70f9-b946-8d5630b57faa` | Okay I had a Prime Agent thread that was · b57faa | `content w1:p3` (tui_present_unclassified) | idle; attached 1; ready | Replace old client in content w1:p3; attach exact UUID; verify footer and state |
| `019ff0f2-b4ff-738b-9a6a-bd35fc32e9a0` | multiplayer refactor | `rustai w1:p2` (tui_present_unclassified) | idle; attached 1; ready | Replace old client in rustai w1:p2; attach exact UUID; verify footer and state |
| `019ff153-c6e1-7122-9e14-606d20a75a37` | Ramp up on this: @Ops cut a new staging build | no_herdr_pane | idle; attached 0; ready | Create a new content Herdr tab; attach exact UUID |
| `019ff049-6508-7607-a80c-2bd67b9d37de` | I had a prime agent thread going that was building | `default wJ:p2` (tui_present_unclassified) | idle; attached 1; ready | Replace old client in default wJ:p2; attach exact UUID; verify footer and state |
| `019ff04c-47fe-7300-8508-d8d1c518a2d5` | state machines | no_herdr_pane | working; attached 0; ready | Create a new default Herdr tab for state machines; attach exact UUID |
| `019ff226-cb44-762a-a857-db387efbcb93` | Ramp up on what I'm doing in ~/workspace/coaching I want | `default wC:p3` (recognized) | working; attached 1; ready | Replace old client in default wC:p3; attach exact UUID; verify footer and state |
| `019ff091-c6e2-754b-b6d0-89afb6c8db97` | next FTL flows | `default wB:p5` (recognized) | idle; attached 1; ready | Replace old client in default wB:p5; attach exact UUID; verify footer and state |
| `019ff099-7cab-77c8-8657-3144816275de` | Yesterday I had a prime agent session going where we | `content w4:p2` (recognized) | idle; attached 1; ready | Replace old client in content w4:p2; attach exact UUID; verify footer and state |
| `019ff174-34d8-74dc-b0f1-a9dabef0400b` | Ramp up on HEARING_2026-07-22/07_Live_Doc/14_Fee_Law_Master.md | `logan w1:p1` (shell_after_killed_client) | working; attached 0; ready | Launch candidate client in logan w1:p1; attach exact UUID; verify three live children |
| `019ff2dd-812c-739b-831f-2b13b815e6e3` | Ramp up on how we have this panel we created | `snap w1:p1` (recognized) | idle; attached 1; ready | Replace old client in snap w1:p1; attach exact UUID; verify footer and state |
| `019ff3c6-ee6d-7519-a2a2-d612bdc499fe` | So we launched 2.1.38 yesterday on Android and today on | `growth w3:p1` (tui_present_unclassified) | idle; attached 1; ready | Replace old client in growth w3:p1; attach exact UUID; verify footer and state |
| `019ff5b4-add0-7778-b504-f10fe3664080` | OK I want you to look through our March plans | `growth w1:p1` (recognized) | idle; attached 1; ready | Replace old client in growth w1:p1; attach exact UUID; verify footer and state |
| `019ff5da-aeec-7107-98cc-b186338e66f9` | I have another prime agent session that is looking into | `growth w6:p1` (recognized) | idle; attached 1; ready | Replace old client in growth w6:p1; attach exact UUID; verify footer and state |
| `019ff5dc-b3f7-7215-a232-ca42e9037c20` | I use the Codex desktop remote pairing so that I | `growth w7:p1` (recognized) | idle; attached 1; ready | Replace old client in growth w7:p1; attach exact UUID; verify footer and state |
| `019ff5f6-5ecf-743b-8e57-2a900e2b5fd5` | Review this prime agent session: | `growth w8:p1` (recognized) | idle; attached 1; ready | Replace old client in growth w8:p1; attach exact UUID; verify footer and state |
| `019ff5f8-ef97-74a3-b20c-271d896a3a4f` | Okay we've done several analyses for what makes lessons good | `content w8:p1` (recognized) | working; attached 1; ready | Replace old client in content w8:p1; attach exact UUID; verify footer and state |
| `019ff613-def3-77df-8151-49a1649dec97` | Root cause this CHECKOUT HEALTH RED \| 2026-08-11 \| instant | `growth w9:p1` (recognized) | idle; attached 1; ready | Replace old client in growth w9:p1; attach exact UUID; verify footer and state |
| `019ff618-525d-77ce-b971-85befe586070` | (unnamed) | no_herdr_pane | working; attached 0; ready | Create a new default Herdr tab; attach exact UUID and label it before prompting |
| `019ff619-395a-737f-8a4a-5823638c6482` | Ramp up on ENTITLEMENT VERSION DIAGNOSTIC \| app_store observed | `growth wB:p1` (recognized) | idle; attached 1; ready | Replace old client in growth wB:p1; attach exact UUID; verify footer and state |
| `019ff6f3-ec7b-716e-a8da-d34e30442baa` | Okay I want you to find the materials on our | `default wH:p2` (recognized) | working; attached 1; ready | Replace old client in default wH:p2; attach exact UUID; verify footer and state |
| `019ff70e-e707-75fb-baa5-b94681f4bb17` | When I, in the app, go into the Puzzle Archive | `bugs w8:p1` (recognized) | idle; attached 1; ready | Replace old client in bugs w8:p1; attach exact UUID; verify footer and state |
| `019ff71f-c3c8-733c-b008-a3a34cee44b4` | › Something is eating up my disk space | external_terminal_not_herdr | working; attached 1; ready | Create a new Herdr tab, attach exact UUID, then retire the external client |

The coordinator restores every descendant with its owning root. Descendants do not get separate terminal tabs. These descendants were actively running at manifest time:

| Child UUID | Name | Root UUID | State |
|---|---|---|---|
| `019ff5f0-9552-738c-bab9-7e36f37d9da5` | 3538-original-scope-product | `019ff0e9-e061-772f-b8d6-a9f11c7b8287` | depth 1; working; streaming |
| `019ff712-2bc2-71aa-abd5-8da612254867` | merge-and-unblock-opus | `019ff112-1dfa-70f9-b946-8d5630b57faa` | depth 1; working; streaming |
| `019ff717-3f65-7763-bd8f-50e694ea0044` | cut-3867 | `019ff049-6508-7607-a80c-2bd67b9d37de` | depth 1; working; streaming |
| `019ff09c-e70e-74d8-bddf-8a8a40e9bed5` | repair-pr-3825 | `019ff04c-47fe-7300-8508-d8d1c518a2d5` | depth 1; working; streaming |
| `019ff648-8a65-7388-a774-5c7e37e89453` | panel4-fees | `019ff174-34d8-74dc-b0f1-a9dabef0400b` | depth 1; working; streaming |
| `019ff648-8b35-72e1-a9b1-b864a5df6066` | panel4-merits | `019ff174-34d8-74dc-b0f1-a9dabef0400b` | depth 1; working; streaming |
| `019ff648-8bf4-74d2-a038-9415e5512d43` | panel4-court | `019ff174-34d8-74dc-b0f1-a9dabef0400b` | depth 1; working; streaming |
| `019ff630-d87f-713f-811e-7aeb360db756` | seat-engineer | `019ff5f8-ef97-74a3-b20c-271d896a3a4f` | depth 1; working; streaming |

## Herdr reconciliation

The inventory inspected all eight running local Herdr sessions: `default`, `bugs`, `content`, `growth`, `logan`, `planning`, `rustai`, and `snap`.

The manifest distinguishes three cases that Herdr's agent list alone would miss:

1. Five panes still contain valid Prime TUIs but Herdr no longer classifies their occupant: `default wB:p4`, `default wJ:p2`, `content w1:p3`, `growth w3:p1`, and `rustai w1:p2`.
2. The Logan pane is now a shell after its old Prime client was killed, although its root and three children remain resident in the daemon.
3. State machines, the staging-build root, and the unnamed root have no current Herdr pane; the disk-space root has an attached client outside Herdr.
4. Internal Codex panes, ordinary shells, the RustAI `ssh home` pane, and the snapshot Python process are excluded.
5. No home-server process, pane, daemon, install, or session was inspected or changed.

## Code review

### P1 blocker — the candidate bundle contains unreviewed generated behavior

The candidate worktree has only one dirty file: `packages/ai/src/models.generated.ts`, with 854 added and 453 removed lines. Its modification timestamp is 13:06:22 and the bundle timestamp is 13:06:25, and the bundle contains the regenerated catalog byte-for-behavior.

This is not merely a reproducibility label:

- The committed xAI implementation defines a zero-cost subscription-specific `grok-4.6`.
- It injects that object only when the input catalog does not already contain `xai/grok-4.6`.
- The dirty regenerated catalog now contains an API-priced `xai/grok-4.6` with input/output prices 2/6.
- The remapper therefore keeps the regenerated model and skips the subscription-specific object. The new test constructs a catalog without `grok-4.6`, so it does not cover the bundled case.

Cutting over to this bundle would not lose Codex/Claude sessions, but it would deploy code that cannot be reconstructed from the commit and whose new xAI behavior differs from its stated subscription contract.

### Reviewed and preserved

The committed delta from the running source is one linear commit: 18 files, +1,076/-21. It adds xAI device OAuth, request-rail rebinding after an auth-source change, and actionable OAuth refresh errors.

The cutover-critical findings are clean:

- The daemon update/restart coordinator, supervisor, package-manager restart path, and protocol wire shapes have no old-to-new diff.
- AIM-managed Codex and Claude remain separate from native xAI OAuth; model modification runs only when stored OAuth is the active source.
- Live model rebinding keeps the same provider/model ID and does not append session history or replace a root.
- Startup/catalog sequencing fetches the catalog before the state snapshot, so an auth-driven rail change is represented in the TUI.
- No credential, token, or secret was created, read, copied into this document, or changed.

### Validation run

| Check | Result |
|---|---|
| Biome, read-only (`--error-on-warnings`, no write) | PASS — 909 files |
| TypeScript `tsgo --noEmit` | PASS |
| Installer render check | PASS |
| Browser smoke check | PASS |
| Worktree preservation | PASS — the same one dirty generated file remains; no source file was edited |

The repository's normal `npm run check` was not invoked because it includes `biome check --write`; the equivalent non-writing stages were run individually. No feature test was run because the current exact bundle already fails the provenance/behavior review gate and the repository instruction permits tests only on an explicit test request.

## Minimal safe route to cutover

1. Preserve the dirty generated catalog as a named artifact; do not discard or silently commit it.
2. Create a fresh deployment worktree pinned at `3c6c129da0670197959e77c076bc1ae266926668` and build the bundle from the tracked catalog, without fetching a new models.dev snapshot.
3. Add one regression covering an input catalog that already contains `xai/grok-4.6`, then run the xAI OAuth, model-registry, AIM-noninterference, session-rebind, and restart-coordinator focused tests plus the full static check.
4. Recompute the candidate build ID, update this manifest with the final live daemon snapshot, and run the existing coordinated checkpoint/restart path.
5. Restore all 25 roots, replace or create the terminal clients listed above, and require exact UUID, worker-ready, attached-client, diagnostics, child-count, and provider-usage canaries before declaring completion.

Until steps 1–3 are complete, the correct decision is **NO-GO**.
