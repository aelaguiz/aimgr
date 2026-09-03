# aimgr agent notes

`aim` coordinates AI account credentials (Redis on the Mac Studio) and launches Prime Agent, Claude, Codex and Grok sessions. `README.md` covers the credential side.

## Prime Agent daemon, sessions, and Herdr restores

Read these before touching the Prime daemon, its locks, or any Herdr pane that hosts a Prime session:

- `docs/PRIME_AGENT_OPERATIONS_RUNBOOK.md`: shut down, start up, restart the supervisor without losing workers, restore sessions into Herdr panes, unwedge held locks, and the tested gotchas (section 7 covers the 2026-09-02 mass restore and the shell and Herdr scripting traps).
- `docs/PRIME_AGENT_PERFORMANCE_AUDIT_2026-09-02.md`: where Prime wastes CPU and disk at scale (per-command `ps` spawns, heartbeat fan-out, `realpathSync` storm in the agents view, empty `agent_status` appends every 25 s), split by supervisor, worker, TUI, with a ranked fix list.
- `docs/PRIME_AGENT_CONTROL_PLANE_REFERENCE.md`: process topology, every lock and guard with its reclaim rule, who can spawn a supervisor, version guards, failure catalogue.
- `docs/PRIME_AGENT_GOALS_AND_HEARTBEATS.md`: how the goal continuation loop works (no cap, no interval, no default budget, prose-blind completion), why the 2026-09-02 Codex session spun for $668 without finishing, the rules agents must follow with `/goal` and `rlm_heartbeat`, and the fork changes that would make spinning impossible. Same text is installed in psagentspace, rustai and psmobile.

Start every Prime incident with:

```bash
bash scripts/prime-runtime-state.sh
```

Then follow the runbook's section 0 table. Helpers: `scripts/prime-daemon-start.mjs` (cold start), `scripts/prime-daemon-wire.mjs` (hello, list, worker-preserving restart, shutdown), `scripts/prime-restore-sessions.py` (plan-driven pane restore).

Rules that are not obvious from the code:

1. Inventory the whole machine before signalling anything; a lock held by a live pid is never auto-reclaimed, and every surviving client or worker relaunches the supervisor within seconds.
2. Never hand-run `prime-agent --mode daemon`; the registry refuses it. Use the start script or let a client start it.
3. In a Herdr pane, run `aim prime resume` as a child, never with `exec`, and pass the absolute transcript path, not the uuid.
4. `ps` hides Prime argv; roles come from `~/.prime/supervisor-owners` and `~/.prime/agent/daemon-workers`.
5. Do not resume Amir's sessions unless asked; when asked, one at a time, by exact id, in the pane's own cwd.
