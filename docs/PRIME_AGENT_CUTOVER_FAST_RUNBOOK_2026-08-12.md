# Prime Agent fast cutover runbook

**Host:** `amir-m5` only
**Target:** current installed candidate bundle, without code changes or rebuild
**Expected interruption:** 10–15 minutes
**Operator rule:** do not prompt any restored agent; resume exact UUIDs only

## Success condition

The cutover is done when the successor daemon owns the same 25 root UUIDs, every coordinator-restored descendant is back under its original root, all 25 roots are accessible in Herdr, all workers are ready with zero diagnostics, and one Codex plus one Claude `/usage` canary succeeds.

Authoritative inputs:

- `docs/PRIME_AGENT_CUTOVER_PREFLIGHT_MANIFEST_2026-08-12.json`
- `docs/PRIME_AGENT_CUTOVER_PREFLIGHT_2026-08-12.md`
- current daemon socket: `/var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501/daemon.sock`
- candidate entry point: `/Users/aelaguiz/.local/bin/prime-agent`

## Time-boxed execution

### 0:00–1:00 — final live snapshot

1. Query the old daemon once.
2. Require 25 root UUIDs, unique session files, all workers ready, and zero diagnostics.
3. Save the final resident root/child count as the coordinator restore target.
4. Do not wait for roots or descendants to become idle.

If the 25-root UUID set differs from the preflight manifest, update the execution manifest before continuing. Natural descendant completion is allowed.

### 1:00–3:00 — disconnect clients, not workers

1. In parallel, exit the 20 old Prime TUIs currently attached through Herdr.
2. Leave the Logan shell alone; its Prime client is already gone.
3. Disconnect the one external disk-space client.
4. Require the old daemon to retain all 25 roots while attached-client count reaches zero.

Do not run `prime-agent stop`, `shutdown`, answer the incompatible-build `y` prompt, rotate credentials, or send agent prompts.

### 3:00–7:00 — one coordinated daemon handoff

Run exactly one coordinator:

```bash
restart_status="$HOME/.prime/agent/update-restarts/fast-cutover-20260812.json"

/Users/aelaguiz/.local/bin/prime-agent update \
  --internal-update-restart-coordinator \
  --daemon-socket /var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501/daemon.sock \
  --internal-update-restart-status "$restart_status"
```

Acceptance:

- phase `complete`
- `failed == 0`
- successor build identity is the candidate build
- restored/resumed dispositions equal the coordinator's prepared manifest
- the 25-root UUID set is unchanged

If preparation fails, the predecessor remains authoritative. Do not kill it; reconnect the old clients and stop the cutover. If failure occurs after checkpoint, rerun the same coordinator/status path rather than creating sessions manually.

### 7:00–12:00 — restore terminal access

Launch exact resumes in parallel waves of five:

1. Reuse the 21 existing Herdr panes from the preflight table, including the Logan shell.
2. Create a new default tab for state machines `019ff04c-47fe-7300-8508-d8d1c518a2d5`.
3. Create new tabs for staging-build `019ff153-c6e1-7122-9e14-606d20a75a37` and unnamed root `019ff618-525d-77ce-b971-85befe586070`.
4. Move disk-space root `019ff71f-c3c8-733c-b008-a3a34cee44b4` into a new Herdr tab.

Every launch uses:

```bash
aim prime resume <exact-root-uuid>
```

Do not use the session picker, title matching, `--rotate`, `--fork`, or a substantive prompt.

### 12:00–15:00 — minimum verification

1. Daemon: same 25 root UUIDs, every worker ready, zero diagnostics, zero duplicate session files.
2. Herdr: 25 accessible Prime roots; every footer shows the expected UUID.
3. Trees: restored busy descendants remain under their original roots.
4. Credentials: one existing Codex root and one existing Claude root return live `/usage` with the saved AIM account label.
5. Write the coordinator receipt and final root/child counts; then release the system for normal use.

## Deliberately deferred

- xAI catalog pricing cleanup
- generated-model commit/rebuild discussion
- new unit tests
- panel review
- home-server changes

None of these is on the cutover path.

## Execution receipt — completed 2026-08-12

The `amir-m5` cutover completed on the installed candidate without a rebuild or code change.

- Successor daemon: PID `19522`, build `bundle-v1:9a8c537ccbaab9d3ccf3e2ed8fbc49aa7b6a89b1e77d02c531ed1a601c8fcf4b`, executable `/Users/aelaguiz/workspace/prime-agent-deploy-20260812/prime-agent.sh`.
- Coordinator receipt: `/Users/aelaguiz/.prime/agent/update-restarts/fast-cutover-20260812T1901Z.json`; phase `complete`, 62 restored, 10 automatically resumed, 0 failed.
- Root restoration: all 25 expected UUIDs are resident, ready, attached in Herdr, and visible in their TUI footers. The repaired multiplayer pane is the new `rustai` tab `w1:p3`; the old `w1:p2` is left as a shell.
- Final verification snapshot: 198 ready resident sessions, zero diagnostics, no duplicate session IDs or files, and no missing expected root UUID. The resident count can continue to grow as restored work delegates. There are 26 attached roots because the user independently started new root `019ff75c-7ad5-755f-86c8-78c6172181b7` during verification; it is outside the frozen 25-root inventory and was not touched.
- Usage canaries: Codex root `019ff046-2ba1-71c1-9c7f-fa5e97da2eb3` returned AIM limits for `boss`; Claude root `019ff099-7cab-77c8-8657-3144816275de` returned AIM limits for `cfo`. Neither reported provider usage unavailable.

One recoverable preparation failure occurred before the successful coordinator run. Old idle eviction had left staging-build worker `9d51aa0b2bce` ready but disconnected. An old-build supervisor self-restart removed that stale tombstoned worker while preserving live workers; the subsequent coordinator completed normally. The failed receipt is `/Users/aelaguiz/.prime/agent/update-restarts/fast-cutover-20260812T1854Z.json`.
