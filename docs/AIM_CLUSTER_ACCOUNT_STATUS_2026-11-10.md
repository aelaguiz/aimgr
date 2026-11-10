---
title: "AIM cluster account status — plan"
date: 2026-11-10
status: complete
owners: [aimgr]
doc_type: project_plan
related: [https://github.com/aelaguiz/aimgr/issues/29]
---

# Outcome

`aim cluster status` shows the existing AIM status table for every active AIM machine, including accounts that cannot run there. Each device reads its own login; no credentials leave it. A failed machine is named and makes the command fail while the other results remain visible.

## Grounding

- `src/status/redis-view.js` combines shared account metadata with local Claude and Codex credentials. `src/status/render.js` renders the existing tables but hides blocked accounts by default.
- AIM is installed by devcluster; `~/.devcluster/machine` identifies the local device. The cluster's SSH targets are in devcluster's `fixer.toml`. The active AIM machines are M5, home, the two M3s, both Minis and Studio. The Air is personal and the old M1 is explicitly retired from AIM fleet checks.
- `aim status` already uses cached readings and may refresh usage as needed. Cluster status invokes the same operation once per machine, with no additional polling service.

## Plan

1. Add an all-accounts option to the existing status renderer and `aim cluster status` to collect the existing text view from each machine, running locally on the caller and using noninteractive, bounded SSH elsewhere. Retain the existing status format within each labeled section; expose errors and a nonzero exit on partial failure.
2. Cover blocked accounts, local/remote selection, command failure and timeout, and preserve existing status behavior. Document the command and correct the AIM fleet inventory.
3. Run focused tests and the full local suite once; review the implementation against this plan; publish and verify the installed command on each active machine through the existing devcluster deployment path.

## Constraints

No primary credentials in shared state or output. No probing the Air or retired old M1. Do not change account selection, login, or scheduling.

## Implementation audit — 2026-11-10

The existing status renderer now accepts blocked accounts, and the cluster command collects that view locally or over noninteractive SSH from the seven documented AIM machines. Errors leave other machine results visible and produce a failing exit code. Account credentials remain local. Existing plain status behavior is covered by its unchanged tests.

Focused status tests and lint pass. The full suite on M5 ran 1,024 tests: 1,002 passed, 17 skipped and five proxy-fixture tests failed because this Mac has no 127.0.0.2 loopback address (`EADDRNOTAVAIL`). The affected proxy test files pass all 15 tests on the home server at the same base commit, where those loopback addresses work. AIM commit `67779f1` installed on all seven machines and passed the installer checks. Cluster status returned seven live tables from both M5 and home. All 42 directed SSH paths were checked; missing host keys were added only after matching the destination machines’ own public keys.
