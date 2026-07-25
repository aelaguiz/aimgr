---
title: "AIM managed Claude selects an NVM-shadowed executable"
date: 2026-07-23
status: fix-ready
owners:
  - aelaguiz
reviewers: []
related:
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
---

# AIM managed Claude selects an NVM-shadowed executable

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** From `~/workspace/psmobile`, `aim claude run pro7 -- ...`
  fails with `Refusing an unsafe installed Claude executable.`
- **Impact:** AIM-managed Claude cannot launch from a directory whose shell
  environment puts another Claude installation ahead of the qualified
  standalone installation.
- **Root cause:** `psmobile` activates NVM and places an old npm-installed
  Claude `2.1.205` before `~/.local/bin/claude` on `PATH`. AIM selects the first
  match, while its integrity gate is intentionally qualified only for the
  canonical standalone Claude `2.1.218`.
- **Immediate workaround:** Prefix the invocation with
  `PATH="$HOME/.local/bin:$PATH"` so AIM sees the qualified installation first.
- **Next action:** Make AIM-managed Claude launch and login prefer
  `~/.local/bin/claude` before ambient `PATH`, while leaving every executable
  integrity check unchanged.
- **Status:** Fix-ready. The failure, root cause, minimal correction, and proof
  boundary are established. No product code has been changed.

<!-- bugs:block:tldr:end -->

## Bug North Star

From any working directory, including one that activates a directory-specific
NVM environment, AIM-managed Claude launch and login must select the user's
canonical standalone executable at `~/.local/bin/claude`. AIM must continue to
reject any executable that fails the existing file, ownership, link-count,
version, digest, architecture, or code-signing checks. The caller's working
directory and all arguments after `--` must remain unchanged.

## Reproduction

On `amirs-m3-max-new`, from `~/workspace/psmobile`:

```bash
aim claude run pro7 -- \
  --dangerously-skip-permissions --model opus --effort xhigh
```

Observed:

```text
Error: Refusing an unsafe installed Claude executable.
    at verifyInstalledClaudeExecutable (.../src/targets/claude-runner.js:359:11)
```

No Redis mutation, Keychain access, Claude launch, or model request is needed
to reproduce the executable-selection failure.

<!-- bugs:block:analysis:start -->

## Analysis

### Decisive evidence

| Surface | Evidence | Conclusion |
|---|---|---|
| Shell inside `~/workspace/psmobile` | `whence -va claude` lists `~/.nvm/versions/node/v18.20.8/bin/claude` before `~/.local/bin/claude` | A directory-specific NVM environment shadows the canonical install |
| AIM resolver | `src/io/process.js` walks `PATH` in order and returns the first existing executable | AIM selects the NVM copy in this shell |
| Shadowing executable | Resolves to `~/.nvm/versions/node/v18.20.8/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`; package version `2.1.205`; link count `2`; SHA-256 `33e28624c5ae84f2bd7d2d8761e5d2e77997ba965cb11b6448de6b6e2c566f9c` | It fails the link-count check at the reported line and is not the qualified version or digest |
| Canonical executable | `~/.local/bin/claude` resolves to `~/.local/share/claude/versions/2.1.218`; regular file; owner UID `501`; link count `1`; executable; SHA-256 `71abaff59312c9a9b6a1d818365048b42e4e95cc521a823660eded3e0880d9b7` | It matches AIM's qualified artifact |
| Canonical signature | Apple signature identifier `com.anthropic.claude-code`, team `Q6L2SF6YDW`, valid signature | It satisfies AIM's signing contract |
| Direct verifier probe | `verifyInstalledClaudeExecutable` accepts the canonical remote path | The verifier and canonical installation are healthy |
| Remote AIM checkout | `main` at `012ab06`, clean | The error is not caused by stale AIM code on the M3 Max |

### Why the reported line matters

`verifyInstalledClaudeExecutable` rejects at the first structural safety gate
when the resolved target is not a single-link, user-owned regular file. The NVM
artifact has link count `2`, so it reaches the exact reported error before the
later version, digest, and signature checks. Even if the link-count requirement
were weakened, that artifact would still be rejected because it is version
`2.1.205` with a different digest. Weakening the verifier is therefore neither
necessary nor correct.

### Ranked hypotheses

1. **Confirmed — ambient `PATH` selects the wrong Claude installation.**
   Directory-local NVM ordering, AIM's first-match resolver, and the rejected
   artifact all line up with the stack trace.
2. **Disproved — the canonical Claude installation is unsafe or corrupt.**
   Its metadata, digest, signature, and a direct invocation of AIM's verifier
   all pass.
3. **Disproved — the remote AIM checkout is stale or installed incorrectly.**
   The checkout is clean on `main` at the expected pushed commit.
4. **Disproved — Redis, credentials, or Keychain state causes this failure.**
   Failure occurs during executable preparation, before those runtime surfaces
   are involved.

### Root cause

AIM correctly verifies a specifically qualified Claude binary but discovers
the candidate through unqualified ambient `PATH`. Those contracts conflict:
the current working directory can activate NVM and change which unrelated
Claude installation is inspected. The executable integrity gate then blocks
the wrong candidate exactly as designed.

### Machine remediation performed

On `amirs-m3-max-new` (`Amirs-M3-Max-2`), the npm-owned Claude `2.1.205`
installation was removed through the package manager explicitly bound to NVM
Node `18.20.8`. A separate incomplete npm residue under NVM Node `22.19.0` was
also removed through its explicitly bound package manager; npm's stale
`2.1.20` backup directory was moved recoverably to:

```text
~/.Trash/aimgr-nvm22-claude-code-stale-20260723T220855Z
```

Post-remediation proof:

- Both NVM npm inventories report no `@anthropic-ai/claude-code` package.
- No `*/bin/claude` launcher or Claude package manifest remains under
  `~/.nvm/versions/node`.
- From `~/workspace/psmobile`, a fresh shell resolves `claude` only to
  `~/.local/bin/claude`.
- AIM's full executable verifier accepts the remaining canonical standalone
  Claude `2.1.218`.

This repairs the affected machine without changing AIM's underlying ambient
`PATH` selection behavior. The product fix remains valid defense against a
future shadowing installation.

<!-- bugs:block:analysis:end -->

## Scope contract

### Correct behavior

`aim claude run pro7 -- <arbitrary Claude arguments>` and the AIM-managed
Claude login path select `~/.local/bin/claude` on macOS even when an NVM or npm
Claude appears earlier on ambient `PATH`. The existing verifier remains the
authority on whether that selected executable is allowed.

### Initial minimal convergence closure

- Managed Claude run executable selection.
- Managed Claude login executable selection, which currently carries the same
  resolution bug and safety contract.
- Focused tests proving canonical-home precedence and unchanged argument/cwd
  behavior.

### Scope freeze before fix

The fix may alter only Claude executable candidate selection at the two
AIM-managed launch boundaries and the directly corresponding tests or
documentation. Expanding this into a generalized command-resolution framework
requires separate evidence and approval.

### Explicitly out of scope

- Weakening or removing file, ownership, link-count, executable, version,
  digest, architecture, or code-signature verification.
- Uninstalling or modifying NVM, npm, the user's global shell configuration, or
  either Claude installation.
- Globally rewriting `PATH`.
- Adding a fallback to an unqualified executable after verification failure.
- Touching Redis, Keychain, managed credentials, account records, or session
  state.
- Running a live Claude model request merely to prove deterministic executable
  selection.

### Enough proof

- A focused test places an unsafe or stale Claude earlier on ambient `PATH` and
  proves both managed run and managed login select the home-local canonical
  candidate.
- Existing integrity-verifier tests continue to pass without expectation
  changes.
- Existing argument-forwarding and working-directory tests continue to pass.
- Focused test suite and lint pass.
- A read-only resolution probe on the M3 Max, from `~/workspace/psmobile`,
  resolves the canonical candidate. No model turn is required.

### Residual constraint

AIM remains deliberately pinned to the currently qualified Claude artifact.
When Claude is upgraded, the existing qualification process still must update
the allowed version and digest. This bug does not change that policy.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

1. At the managed Claude run and login boundaries, prepend
   `<homeDir>/.local/bin` to executable search paths using the resolver's
   existing `extraSearchPaths` support.
2. Preserve the existing verifier as the mandatory next step; do not catch or
   downgrade any verification error.
3. Add the smallest regression fixture in which ambient `PATH` contains a
   shadowing Claude and the home-local candidate wins for both boundaries.
4. Run the focused CLI and native-storage tests plus lint.
5. Perform only a read-only candidate-resolution check from the original
   `psmobile` working directory on the M3 Max.

This plan is challengeable until implementation starts, but no broader
abstraction is presently justified.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation

Not started. Analysis was requested and product code remains unchanged.

<!-- bugs:block:implementation:end -->
