---
title: Bare aim codex use reselects the active account
date: 2026-09-04
status: resolved
owners: [Codex]
reviewers: []
related: []
---

<!-- bugs:block:tldr:start -->
## TL;DR

`aim codex use` now chooses a different eligible account on every successful
invocation. It previously chose the lowest-usage label without excluding the
active label, so repeated calls selected the same account. The command now
enables the selector's existing `avoidCurrentLabel` option.
<!-- bugs:block:tldr:end -->

<!-- bugs:block:analysis:start -->
## Analysis

- User report: “each time I type aim codex use it'll just pick same one as last
  time. It has to always rotate. Fix it”.
- Root cause: `handleRedisCodexUse` in `src/cli/commands/codex.js` passes
  `selectLeastUsed: true` without `avoidCurrentLabel`. The latter defaults to
  false in `activateCodexPoolSelection` in `src/targets/codex-cli.js`.
- Existing proof: `test/codex/use-watch.test.js` explicitly expects repeated
  automatic calls to choose `writer` twice and return a successful `noop` on the
  second call. Its equal-usage test also expects the same label twice.
- The selector already reads the actual Codex auth target, excludes its label
  when requested, ranks eligible alternatives by five-hour usage, and returns
  `no_alternate_pool_account` without rewriting auth when no alternative exists.

### Scope contract

User outcome: bare `aim codex use` rotates on success; an unavailable alternate
produces an explicit failure instead of successful reselection.

Smallest fix: add the existing option at the automatic command call. Update the
two old-contract tests, cover persisted rotation and unavailable alternatives,
and describe this behavior in CLI help and README.

Initial closure: command dispatch, the existing selector behavior, focused
command tests, and command documentation. No shared selector rewrite is needed.

Pre-fix scope signoff: Codex, 2026-09-04. The user's instruction authorizes this
bounded behavior change. Analysis is sufficient to proceed.

Enough proof: reproduce the old behavior with failing command tests, then pass
Codex command/reconciliation tests and Redis projection/CLI documentation
regressions; verify the installed `aim` resolves to this checkout.

Boundaries: explicit `aim codex use <label>` still honors the label; `codex watch`
keeps its threshold behavior. No live account changes, credential creation,
Prime process changes, or unrelated repository cleanup are needed.

Residual risk: rotation needs another eligible label. Cached usage remains
subject to existing freshness rules; this fix changes selection, not telemetry.
<!-- bugs:block:analysis:end -->

<!-- bugs:block:fix_plan:start -->
## Fix plan

1. Reproduce repeated selection and unavailable-alternate behavior in CLI tests.
2. Enable `avoidCurrentLabel` for bare `codex use`; update command documentation.
3. Run focused regression checks and verify the installed launcher target.
<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->
## Implementation

Completed 2026-09-04. The automatic command passes `avoidCurrentLabel: true`
alongside `selectLeastUsed: true`. Help and README describe rotation and the
no-alternative failure. No shared selector implementation changed.

Before the fix, `node --test test/codex/use-watch.test.js` reproduced all five
new/updated behavioral cases: repeated selection, equal usage, selection among
three accounts, a single-account pool, and an exhausted alternate. Node reported
7 passing and 6 failing tests (including the failed parent of two subtests).

After the fix, this focused command passes all 28 tests:

```bash
node --test --test-name-pattern='[Cc]odex|README' test/codex/use-watch.test.js test/codex/reconciliation.test.js test/cli/redis-projection-command.test.js test/cli/readme-contract.test.js
```

The repeated-call regression verifies actual projected account IDs switch
`acct_2 → acct_1 → acct_2`, while the fresh usage cache requires only one probe.
Single-account and exhausted-alternate cases return exit code 1 with
`no_alternate_pool_account` and byte-identical auth content. Existing explicit
selection and watch regressions pass.

The unfiltered four-file run reports 55 passing and 2 failing tests. Both
failures are outside this change: the automatic Fable run test (line 1154) and
Claude resume-by-name test (line 1451) expect `claude-fable-5`, while the unchanged
`src/core/constants.js:26` sets `DEFAULT_CLAUDE_FABLE_MODEL` to
`claude-fable-5-1`. The Claude source, constant, and projection test file have no
diff. These failures do not block this Codex command fix.

`node --check` passes for both changed source files and the changed test file;
`git diff --check` passes. `/Users/aelaguiz/.local/bin/aim` invokes this checkout's
`bin/aimgr.js` directly, and installed `aim --help` shows the updated rotation
description. No build, reinstall, or service restart is required.

Validation used temporary homes and fake Redis/account fixtures. Live accounts
were not selected during verification. No independent review was requested.
<!-- bugs:block:implementation:end -->
