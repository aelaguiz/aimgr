# Prime Agent Herdr Upgrade Restoration — Verified After-State

Date: 2026-08-11
Host: `amir-m5` only
Status: complete

## Outcome

The reviewed Prime Agent and AIM builds are installed locally, the single local Prime daemon was replaced through the coordinated checkpoint/restart path, and all 20 inventoried Prime root sessions are open in Herdr on their original UUIDs.

Final daemon invariants:

- 20 top-level Prime roots found; expected set matched exactly with zero missing and zero extra UUIDs.
- 20 workers report `ready`.
- 20 roots have exactly one attached client each.
- 20 UUIDs are unique and every Herdr footer displays the expected UUID.
- All root diagnostics arrays are empty.
- Provider usage was exercised in a restored Anthropic pane and returned live Claude and Codex quota data.

## Installed builds

| Component | Verified value |
|---|---|
| Prime source commit | `3c4f91d1f0c827ee2430ddd5a39deadbe3f6d5d0` |
| Prime clean deployment | `/Users/aelaguiz/workspace/prime-agent-deploy-20260811` |
| Prime bundled CLI SHA-256 | `d8a8bd03b5c490bf74543887413fe59b3392bea7f5aed1902c431a7f3dfe3965` |
| Prime installed entry point | `/Users/aelaguiz/.local/bin/prime-agent` |
| AIM source commit | `bb73bb24ca6b710c07558a131a0e9ebaff482f29` |
| AIM deployment | `/Users/aelaguiz/workspace/aimgr-prime-session-handoff-20260810` |
| AIM helper SHA-256 | `41d8e15abd90fbd865a0a3f94cd3e28b2d0ff9c0e5feef462d03d47b0a3da900` |

The Prime source worktree's unrelated user edit at `packages/ai/src/models.generated.ts` remains untouched and uncommitted.

## Coordinated daemon handoff

Receipt: `/Users/aelaguiz/.prime/agent/update-restarts/herdr-20260811T200200-final-0500.json`

| Field | Result |
|---|---|
| Phase | `complete` |
| Predecessor | PID `55692`, generation `f6088c9b-a323-49ff-86a9-e5f929aca8cb` |
| Successor | PID `94294`, generation `8aa1869c-e219-4c62-ab0a-603c517caeb0` |
| Checkpoint dispositions | 13 |
| Restored | 13 |
| Interrupted operations resumed by coordinator | 2 |
| Failed | 0 |

Three earlier preparation attempts failed closed without stopping the predecessor. The underlying old workers could answer ordinary list calls while one or more checkpoint channels were stale. The recovery path was:

1. Stop only the 20 inventoried Prime clients, leaving their workers and journals resident.
2. Take a fresh quiesced snapshot.
3. Rebuild each of the 12 resident worker connections under the predecessor, preserving every root UUID.
4. Run the coordinated handoff once all 12 reported `ready` with zero attached legacy clients.

The successful handoff then checkpointed, stopped the predecessor, started the reviewed successor, restored all dispositions, and reported zero failures.

## Herdr session map

| Herdr session | Pane after restoration | Prime root UUID | Working directory |
|---|---|---|---|
| `default` | `wB:p4` | `019ff046-2ba1-71c1-9c7f-fa5e97da2eb3` | `~/workspace/psagentspace` |
| `default` | `wB:p5` | `019ff091-c6e2-754b-b6d0-89afb6c8db97` | `~/workspace/psagentspace` |
| `default` | `wC:p3` | `019ff226-cb44-762a-a857-db387efbcb93` | `~/workspace/psagentspace` |
| `default` | `wH:p1` | `019ff04c-47fe-7300-8508-d8d1c518a2d5` | `~/workspace/psagentspace` |
| `default` | `wJ:p2` | `019ff049-6508-7607-a80c-2bd67b9d37de` | `~/workspace/psagentspace` |
| `default` | `wX:p1` | `019ff1e1-8ac6-737e-8ff6-88b645cae558` | `~/workspace/psagentspace` |
| `default` | `wY:p1` | `019ff250-54fb-714b-8ec9-3d0c6eea527e` | `~/workspace/psagentspace` |
| `default` | `wZ:p1` | `019ff2c6-ec77-716b-8a7e-fe9ee9c33997` | `~/workspace/psagentspace` |
| `bugs` | `w2:p2` | `019ff0e9-e061-772f-b8d6-a9f11c7b8287` | `~/workspace/psagentspace` |
| `bugs` | `w4:p3` | `019ff0cc-bbcd-778a-ba7d-52331b1dd347` | `~/workspace/psagentspace` |
| `bugs` | `w6:p1` | `019ff146-58bd-7426-8d57-7e74f88be413` | `~/workspace/psagentspace` |
| `bugs` | `w7:p1` | `019ff2f1-3f92-7592-9d12-aca9c3288fb6` | `~/workspace/psagentspace` |
| `content` | `w1:p3` | `019ff112-1dfa-70f9-b946-8d5630b57faa` | `~/workspace/psagentspace` |
| `content` | `w3:p3` | `019ff098-7fda-745a-8456-9c2b5085505a` | `~/workspace/lessons_studio` |
| `content` | `w4:p2` | `019ff099-7cab-77c8-8657-3144816275de` | `~/workspace/psagentspace` |
| `content` | `w7:p1` | `019ff153-c6e1-7122-9e14-606d20a75a37` | `~/workspace/psagentspace` |
| `logan` | `w1:p1` | `019ff174-34d8-74dc-b0f1-a9dabef0400b` | `~/workspace/logan` |
| `logan` | `w2:p1` | `019ff2f7-4ea9-7792-942b-f6d8716e430f` | `~/workspace/logan` |
| `rustai` | `w1:p2` | `019ff0f2-b4ff-738b-9a6a-bd35fc32e9a0` | `~/workspace/psagentspace` |
| `snap` | `w1:p1` | `019ff2dd-812c-739b-831f-2b13b815e6e3` | `~/workspace/snap` |

The old `content w5:p1` pane had launched Prime with `exec`, so exiting the old client also closed that Herdr workspace. It was recreated as `content w7:p1`; its Prime UUID, working directory, and journal did not change.

## Credential and usage verification

`aim prime status --json` reports Redis coordination available and both managed projections healthy:

- `openai-codex`: installed, ready, binding `pro10`.
- `anthropic`: installed, ready, binding `office`.
- No secrets are copied into the Prime target.

One restored session, `019ff112-1dfa-70f9-b946-8d5630b57faa`, was bound to `cfo`, whose refresh lease is legitimately held by a separate long-running `aim claude run opus` process. Its manual handoff moved the same Prime UUID to ready binding `coder`. A subsequent real tool call completed and the root returned to active thinking.

The `/usage` canary in `content w3:p3` returned live values for Claude account `product_growth` and Codex account `qa`; it no longer reports provider usage as unavailable.

## Recovery snapshots

- `/Users/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-upgrade-20260811T192353-0500`
- `/Users/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-delta-20260811T193648-0500`
- `/Users/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-final-pre-restart-20260811T194500-0500`
- `/Users/aelaguiz/.prime/agent/recovery-snapshots/prime-herdr-quiesced-20260811T195800-0500`

The quiesced snapshot contains all 20 exact root JSONL files plus the local session artifacts and worker recovery journals. Every copied root JSONL parsed successfully line by line.

## Verification performed

- Prime full `npm run check`: pass.
- Prime focused suite: 562 passed, 2 skipped.
- Prime OpenAI Codex stream suite: 20 passed.
- AIM full suite: 365 passed.
- AIM focused helper tests: 40 passed.
- AIM lint: pass.
- Coordinated live restart: 13 restored, 2 resumed, 0 failed.
- Final live inventory: 20 expected roots, 20 ready, 20 attached once, 20 unique, 0 diagnostics.
- Final UI inventory: all 20 panes show their exact `session-id` footer.
- Final provider canary: live Claude and Codex usage returned.

Some panes retain an old scrollback line saying `Cannot list heartbeats while session worker is starting`. Those messages were emitted during the initial attachment race. They are historical only: the final daemon inventory reports every corresponding worker `ready` with an empty diagnostics array.

## Scope boundary

Only `amir-m5` was activated. No home-server Prime daemon, worker, session, pane, installed wrapper, or runtime was stopped or replaced. Before the scope correction, inert deployment directories and recovery artifacts were created on home; they were never activated and are outside this receipt.
