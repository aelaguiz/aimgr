# Codex Tend PTY Supervisor Cutover Worklog

## 2026-05-30 - Implementation pass

Durable smoke receipt: the pre-implementation PTY smoke was already run before this implementation
pass and must not be rerun before code changes require a new runtime proof. The implementation uses
the repo-owned Python/POSIX PTY helper chosen by that smoke, not `node-pty`.

Implemented:

- Added `src/targets/codex-pty-helper.py`, a stdlib Python PTY helper using JSON lines, base64
  input/output frames, resize, terminate, ready, output, exit, and setup-error messages.
- Added `src/targets/codex-pty.js`, the Node PTY session wrapper with attached terminal relay,
  raw-mode restoration, resize forwarding, output snapshots, ready/exit waits, and `/goal` intent
  detection from user stdin.
- Added `src/targets/codex-rollout.js`, the complete-line JSONL rollout parser/resolver/tailer for
  top-level `source=="cli"` and `thread_source=="user"` goal sessions.
- Added `src/targets/codex-tend-lock.js`, a per-thread Tend owner lock with exclusive create,
  live-pid blocking, stale-lock reclaim, and best-effort release.
- Made `writeTextFileIfChanged`/`writeJsonFileIfChanged` replacement-based through a temp file and
  rename, preserving the existing Codex auth write call site.
- Rewrote `src/targets/codex-tender.js` to remove private app-server and tmux behavior, launch Codex
  through the PTY helper, bind new sessions by `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` rollout tags,
  resume explicit sessions by rollout lookup, rotate only on owned rollout `usageLimited`, and
  return PTY-shaped status fields.
- Updated CLI parsing/help/command wiring for `--bind-timeout-seconds`, obsolete `--tmux-session`,
  and PTY/rollout `--remote` rejection wording.
- Deleted `src/targets/codex-app-server.js` after confirming no non-Tend live imports.
- Replaced old tmux/app-server Tend tests with fake-PTY and temp-rollout tests covering start
  binding, explicit resume, prompt failure, duplicate lock, owned usage-limited rotation, Python
  helper spawn failure, goal bind timeout, generic pane/global rate-limit non-rotation, sub-agent
  filtering, atomic writes, and Redis Tend preservation boundaries.
- Updated README and historical docs so old tmux/app-server guidance is marked superseded or no
  longer presented as current live methodology.

Verification so far:

- `npm run lint` passes.
- `node --test test/codex/use-watch.test.js` passes: 58 tests, 58 pass.
- `npm test` passes: 235 tests, 235 pass.
- Post-implementation PTY smoke passed with `/Users/aelaguiz/.local/bin/codex` through
  `CodexPtySession`: helper ready, child pid `31267`, `/exit` sent, exit code `0`, output bytes
  `6383`, no helper errors, and `ps -p 31267` showed no remaining process.
- Live runtime search found no tmux/app-server/remote launch path in `codex-tender.js`,
  `codex-pty.js`, `codex-pty-helper.py`, or `src/cli/commands/codex.js`; only obsolete-option and
  user-pass-through rejection messages remain.
- Composer 2.5 Fast implementation review:
  `/tmp/fresh-consult/codex-tend-pty-impl-composer-20260530-0sS6ny/final.txt`
  returned `VERDICT: pass-with-notes`, `BLOCKING: none`, `CONFIDENCE: high`. One useful
  non-blocking note was lack of unit coverage for attach/raw/resize; focused tests were added for
  PTY helper protocol framing, output, resize, exit, attached stdin relay, `/goal` detection,
  raw-mode restore, and helper cleanup.
- Thermonuclear maintainability review found no structural blocker. Follow-up hardening completed:
  lock release now verifies the same run/thread before unlinking, stale-lock reclaim is tested,
  lock file descriptors close through `finally`, temp atomic writes clean up failed temp files, and
  PTY helper spawn errors now resolve exit waiters with a concrete error reason.

Remaining gates:

- Final repairs, commit, push, and global install.
