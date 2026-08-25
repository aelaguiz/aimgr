---
title: "aimgr MCP remote control — Phase 1 implementation plan"
date: 2026-08-25
status: approved-for-implementation
owners: [aelaguiz]
doc_type: implementation-plan
related:
  - AIMGR_MCP_REMOTE_CONTROL_PLAN_2026-08-25.md
---

# Scope

Implement **Phase 1 only** of `AIMGR_MCP_REMOTE_CONTROL_PLAN_2026-08-25.md`:
`aim mcp serve` (Streamable HTTP, no auth, tailnet bind, port 7337, optional `--stdio`)
with exactly 3 tools — `aim_exec`, `aim_machine_info`, `aim_log_tail` — plus the
LaunchAgent install script, help/README updates, and tests.

Out of scope, do not build: Phase 2 (login relay, fleet peers), herdr anything,
sessions/panes, auth/TLS, extra tools, MCP resources/prompts, express, event streams.

# Dependencies

- `@modelcontextprotocol/sdk` (latest 1.x) + its `zod` peer. These are the ONLY new
  runtime deps. Raw `node:http` for the HTTP server — no express.

# File-by-file

## `src/cli/main.js` + `src/cli/help.js`
- Register route `["mcp", …]` following the existing lazy-import command map pattern.
- Help: add usage lines `aim mcp serve [--port <n>] [--bind <ip>] [--stdio]` and one
  note line ("unauthenticated; tailnet-only by intent").

## `src/cli/commands/mcp.js`
- Parse `serve` subcommand + flags (`--port` default 7337, `--bind` default = Tailscale
  IPv4 if resolvable else `0.0.0.0`, `--stdio` mutually exclusive with port/bind).
- Unknown subcommand → CLI error matching repo error style.

## `src/mcp/exec.js`
- `runAimCommand(argv, { timeoutMs = 120_000, binPath, env })`: spawn
  `process.execPath <repo>/bin/aimgr.js <argv…>` (resolve bin from module URL;
  injectable for tests). Env: inherit + `NO_COLOR=1`, delete `FORCE_COLOR`.
- Kill on timeout: SIGTERM, then SIGKILL after 5s. Capture stdout/stderr separately,
  cap combined at 400_000 chars with `truncated: true` + a trailing notice (2026-08-25
  decision: `aim status --json` is ~211k chars and must return parseable).
- Returns `{ ok, exitCode, signal, durationMs, stdout, stderr, truncated }`.

## `src/mcp/policy.js`
- `validateAimArgv(argv)` → `{ ok } | { ok:false, reason }` (pure, unit-testable).
- Reject non-array / non-string / empty argv.
- First token must be in the known allowlist: `status redis label grok rebalance auth
  codex hermes claude pi prime routine sakana browser help` (`repair` dropped
  2026-08-25: not a real aim command). Unknown first token
  = the bare-label interactive panel → reject with "interactive label panel; not
  available over MCP".
- Interactive/hanging rejections (clear, actionable messages):
  - `login` (any form) — Phase 2 owns remote login.
  - `credential-helper` — machine stdio protocol, would hang.
  - `claude run|resume`, `prime run|resume` — interactive TUIs; out of scope.
  - `codex watch` / `hermes watch` without `--once` — infinite loop; tell caller to
    add `--once`.

## `src/mcp/logs.js`
- Named log map (exact paths):
  - `auth-maintainer` → `~/.aimgr/logs/auth-maintainer.{out,err}.log`
  - `codex-watch` → `/tmp/agents_host_aim_codex_watch.{out,err}.log`
  - `hermes-watch` → `/tmp/agents_host_aim_hermes_watch.{out,err}.log`
  - `mcp-serve` → `~/.aimgr/logs/mcp-serve.{out,err}.log`
- `tailLog({ name?, path?, lines = 200 })`: name returns both out+err tails; explicit
  absolute path returns that file. `lines` capped at 2000. Missing file →
  `{ present:false }`, not an error. Return bytes read + mtime + age.

## `src/mcp/machine-info.js`
- `collectMachineInfo(deps)` with injected deps (repo `deps.js` style) returning facts:
  - `hostname` (os), `tailscaleIp` (best effort: `tailscale ip -4` with 2s timeout,
    else first `100.64.0.0/10` address from `os.networkInterfaces()`, else null),
  - `aimgrRev` (`git rev-parse --short HEAD` in repo root, best effort),
  - `diskFree` for `$HOME` (`df -k`, parsed),
  - `redisPingMs` (spawn `aim redis ping` via exec.js, measure duration; report
    ok/fail + ms),
  - `logs`: for each named log above — present, sizeBytes, mtime, ageSeconds,
  - `routineReceipts`: newest receipt per routineId from
    `resolveAimgrRoutineRunsDir` (`src/io/paths.js`), each `{ routineId, fireKey,
    outcome, ageSeconds }`, tolerate empty/missing dir.
- **No health/verdict fields.** Facts only; every collector is best-effort with
  per-field `error` strings rather than throwing.

## `src/mcp/server.js`
- `buildMcpServer(deps)`: `McpServer` from the SDK; `registerTool` × 3 with zod input
  schemas and rich descriptions (aim_exec description lists the common invocations:
  `["status","--json"]`, `["claude","status","--json"]`, `["grok","status","--json"]`,
  `["claude","list","--json"]`, `["codex","use"]`, `["auth","maintain"]`,
  `["routine","run","<id>","--manual"]`, and says `["help"]` prints the full surface).
- Every tool returns one `text` content block containing the JSON envelope
  (`JSON.stringify(result, null, 1)`); policy rejections and failures return
  `isError: true` with the actionable reason.
- `startHttpServer({ port, bind })`: raw `node:http`; per-request stateless
  `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per SDK stateless
  pattern; POST `/mcp` handled, GET/DELETE `/mcp` → 405 JSON-RPC error; anything else
  404. Log one line per tool call (tool, args summary, ms, ok) to stdout.
- `startStdio()`: `StdioServerTransport`.

## `scripts/install-mcp-server.sh`
- Mirror `install-auth-maintainer.sh` structure: label
  `com.funcountry.agents_host.aim_mcp_serve`, ProgramArguments
  `[node, <repo>/bin/aimgr.js, mcp, serve]`, `RunAtLoad` + `KeepAlive` true, logs to
  `~/.aimgr/logs/mcp-serve.{out,err}.log`, flags `--status` and `--uninstall`.

## `README.md`
- Short "MCP server" section: what it is, `aim mcp serve`, install script, port 7337,
  the three tools, explicit "unauthenticated — tailnet trust" sentence.

# Tests (node:test, mirror existing repo style; no network, no real Redis)

1. `test/mcp/policy.test.js` — accept/reject table: every allowlist token accepted;
   `login`, `credential-helper`, `claude run`, `claude resume`, `prime run`,
   `prime resume`, unknown label, `codex watch` (no `--once`), `hermes watch`
   (no `--once`) rejected with the specified reasons; `codex watch --once` accepted;
   malformed argv (non-array, empty, non-string members) rejected.
2. `test/mcp/exec.test.js` — with `binPath` pointed at a small fixture script: capture
   of stdout/stderr/exit code; timeout kill path; truncation at cap; env has
   `NO_COLOR` and no `FORCE_COLOR`.
3. `test/mcp/logs.test.js` — temp-dir log map injection: tail line counts, lines cap,
   missing file → `present:false`, mtime/age present.
4. `test/mcp/machine-info.test.js` — injected fakes for every collector; asserts facts
   shape, best-effort per-field errors, and absence of any verdict/health field.
5. `test/mcp/server.test.js` — integration: start HTTP server on an ephemeral port;
   raw JSON-RPC over fetch: `initialize` → `tools/list` (exactly 3 tools) →
   `tools/call aim_exec {"argv":["help"]}` (help is static, offline-safe) → verify
   envelope; `tools/call aim_exec {"argv":["prime","run","codex"]}` → `isError` with
   policy reason; clean shutdown.

Gates: `npm run lint` and full `npm test` green.

# Working agreement

- Branch `mcp-remote-control` off current `main`; small logical commits; do not push.
- Follow repo conventions: ESM, small purpose-built modules, dependency injection via
  simple `deps` objects, `node --check`-clean, no new abstractions beyond the files
  above, no drive-by refactors, do not touch credential flows.
- If an SDK reality contradicts this plan (API rename, stateless pattern change),
  adapt minimally and record the deviation in the final report; do not redesign.

# Definition of done

1. `aim mcp serve` runs; `curl` JSON-RPC initialize/tools-list works on 127.0.0.1:7337.
2. The 5 test files pass; full `npm test` and `npm run lint` green.
3. `aim_exec ["status","--json"]` returns live pool JSON through the MCP envelope on
   this machine; `["prime","run","codex"]` is rejected with the policy message.
4. Install script `--status` and `--uninstall` behave; plist points at the repo bin.
5. Report: files changed + LOC, test output tail, deviations list, exact commands to
   smoke from an MCP client.
