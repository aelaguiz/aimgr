---
title: "AIM managed Claude replaces the caller's developer environment"
date: 2026-07-24
status: resolved
owners:
  - aelaguiz
reviewers: []
related:
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md
  - ../NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md
  - ../aelaguiz/v2-proposal.md
---

# AIM managed Claude replaces the caller's developer environment

<!-- bugs:block:tldr:start -->

## TL;DR

- **Symptom:** A Claude session launched through `aim claude run <label>` can
  still find developer commands on `PATH`, but personal Claude skills, plugins,
  hooks, MCP servers, `gh` authentication, global Git configuration, Codex
  configuration/authentication, Rust toolchains, kubectl context, cloud
  profiles, shell dotfiles, and other user-scoped tooling disappear or fail.
- **Impact:** Managed Claude does not behave like Claude launched directly from
  the same terminal. Its child processes run as if they belonged to a mostly
  empty synthetic macOS user, and macOS descendants also inherit a blanket
  Keychain/trust-service prohibition. This can prevent Claude from using `gh`
  or orchestrating Codex at all.
- **Primary root cause:** AIM unconditionally replaces process-wide `HOME` with
  `~/.aimgr/claude-homes/<label>`. Tools that do not receive their own explicit
  home override therefore relocate all user state. AIM does not explicitly set
  `CODEX_HOME`; nested Codex defaults it to `$HOME/.codex`, which is why it
  selects an empty label-local Codex home.
- **Independent macOS root cause:** The outer Seatbelt profile denies Keychain
  databases, Security.framework services, the system `security` executable,
  Authorization Services, LaunchServices opening, Apple Events, and selected
  secure-key hardware interfaces for Claude's complete descendant process
  tree. This also blocks non-Claude tools. Restoring a config path does not
  restore a Keychain-backed credential or native certificate roots.
- **Design error:** Claude account isolation was implemented with two
  process-global mechanisms—`HOME` and an inherited OS sandbox—even though
  `CLAUDE_CONFIG_DIR` already provides the Claude-specific profile selector.
  The approved plan named the two Claude config variables, not a rewritten
  `HOME`; the implementation and its tests broadened the boundary.
- **Status:** Resolved locally. AIM now preserves the real `HOME`, retains the
  label-scoped Claude config variables, removes the inherited blanket
  Keychain/trust denials, and keeps the AIM `security` compatibility executable
  first on `PATH`. Under the patched production boundary, normal `gh`
  authentication succeeded and one real nested Codex turn completed without
  `CODEX_HOME` or certificate overrides, while Claude's known bare
  `security` credential call still resolved to the shim's exact item-absent
  result.

<!-- bugs:block:tldr:end -->

## Bug North Star

`aim claude run <label> -- <args>` must change the selected Claude account
without replacing the human's ordinary developer environment.

The selected Claude credential, account metadata, session history, and other
Claude profile state remain label-scoped. The caller's normal developer-tool
configuration and authentication—including Git, `gh`, Codex, user toolchains,
shell configuration, and user-installed reusable tooling—remain available to
Claude's child processes just as they are to a directly launched Claude.

Claude's own OAuth storage must continue using AIM's label-scoped file
projection rather than the macOS Keychain. Redis coordination, credential
rotation, arguments, working directory, terminal streams, exit status, signal
behavior, and label-scoped `--resume` behavior must not change.

## Reproduction

The production launch envelope is:

```text
normal terminal
  HOME=/Users/aelaguiz
  PATH=<caller's PATH>
  cwd=<caller's repository>
      |
      v
aim claude run <label>
  HOME=/Users/aelaguiz/.aimgr/claude-homes/<label>
  CLAUDE_CONFIG_DIR=<label-home>/.claude
  CLAUDE_SECURESTORAGE_CONFIG_DIR=<label-home>/.claude
  PATH=<AIM security adapter>:<caller's PATH>
      |
      v
macOS sandbox-exec -> official Claude -> Bash / gh / git / codex / MCP servers
                       ^ every descendant inherits the same HOME and sandbox
```

A read-only probe reused an existing managed home, the exact production
environment transformation, the existing adapter, and the production
`native/claude/no-keychain.sb` profile. It substituted a value-free shell probe
for Claude so it made no Claude request, model request, Redis call, Keychain
call, browser action, remote connection, credential-helper call, or
authenticated service call.

The normal and managed environments produced:

| Probe | Normal | Managed |
|---|---:|---:|
| `git` command resolvable | yes | yes |
| `gh` command resolvable | yes | yes |
| `codex` command resolvable | yes | yes |
| `rustc`, `kubectl`, `aws`, `gcloud`, `docker` resolvable | yes | yes |
| Git global entries | 34 | 0 |
| Git repository-local entries | 17 | 17 |
| Default GH host config | present | absent |
| Default `.ssh/config` | present | absent |
| Default AWS, kube, Docker, and gcloud config | present | absent |
| Default Cargo/Rustup homes | present | absent |
| Normal Codex config | present | absent at the managed default |
| Normal Claude personal skills | 50+ | 0 in every managed label |
| Normal Claude user MCP definitions | 5 | 0 in every managed label |
| Normal enabled Claude plugins | 2 | 0 in every managed label |
| Normal Claude user hook groups | 3 | 0 in every managed label |

Additional direct observations:

- Normal `gh auth status --hostname github.com` succeeds.
- Under the managed envelope it fails because the default config root moved.
- Supplying the real `GH_CONFIG_DIR` makes `gh` rediscover the known account,
  but it still reports the stored token unusable under the production sandbox.
  The token itself was never printed or read.
- Normal Codex has a real `config.toml`, `auth.json`, and credential-store
  state under `/Users/aelaguiz/.codex`. The managed `qa` home contains only a
  tiny label-local `.codex/config.toml` and no `auth.json` or credential file.
- A nested Codex worker failed TLS with
  `invalid peer certificate: UnknownIssuer`. Supplying both
  `CODEX_HOME=/Users/aelaguiz/.codex` and
  `SSL_CERT_FILE=/etc/ssl/cert.pem` allowed that worker to start. This is a
  workaround proving two separate missing dependencies, not the intended
  architecture.

<!-- bugs:block:analysis:start -->

## Analysis

### The exact launch transformation

`buildContainedLaunchEnvironment` begins with a copy of the caller environment,
removes a fixed Anthropic/dynamic-loader list, and then sets:

```text
HOME=<label-home>
CLAUDE_CONFIG_DIR=<label-home>/.claude
CLAUDE_SECURESTORAGE_CONFIG_DIR=<label-home>/.claude
DISABLE_AUTOUPDATER=1
DISABLE_UPDATES=1
```

On macOS it prepends the AIM `security` adapter directory to the inherited
`PATH`; on Linux it preserves the inherited `PATH` exactly. The working
directory, arguments, terminal streams, and nearly all other environment
variables are preserved.

Source authority:

- `src/targets/claude-runner.js:31-53` defines the scrub list.
- `src/targets/claude-runner.js:496-508` replaces `HOME`, pins both Claude
  config variables, and constructs `PATH`.
- `src/targets/claude-runner.js:541-588` preserves cwd, arguments, and stdio.
- `native/claude/no-keychain.sb:1-59` defines the inherited macOS restrictions.

### `CODEX_HOME` is collateral, not explicitly changed

AIM does **not** set or delete `CODEX_HOME`. Codex documents:

```text
CODEX_HOME defaults to ~/.codex
```

It owns Codex config, auth, logs, sessions, skills, and package metadata. With
no explicit `CODEX_HOME`, the managed process evaluates the default against
AIM's substituted `HOME`:

```text
normal:
  HOME=/Users/aelaguiz
  CODEX_HOME default=/Users/aelaguiz/.codex

managed Claude label qa:
  HOME=/Users/aelaguiz/.aimgr/claude-homes/qa
  CODEX_HOME default=/Users/aelaguiz/.aimgr/claude-homes/qa/.codex
```

This explains both the empty Codex configuration and missing Codex
authentication. Setting `CODEX_HOME` manually repairs only that discovery
layer.

### The Codex TLS failure is a separate macOS sandbox effect

The installed Codex 0.146.0 alpha native executable contains Rustls,
`security-framework`, native-certificate loading, `SSL_CERT_FILE`, and explicit
trust-settings failure paths. The production Seatbelt profile denies:

- user and system Keychain database paths, including
  `/System/Library/Keychains`;
- SecurityServer and `securityd` Mach/XPC services;
- Authorization Services and selected secure-key clients.

That is consistent with Codex failing to build a usable native trust store and
Rustls rejecting an otherwise valid server chain with `UnknownIssuer`.
`SSL_CERT_FILE=/etc/ssl/cert.pem` bypasses native trust loading with an explicit
PEM root bundle. `HOME` substitution explains missing Codex state; the
Keychain/Security denial explains the TLS trust failure. Describing both as an
"empty Keychain caused by HOME" is imprecise.

The workaround memory written by the affected managed agent also incorrectly
concludes that the human should reauthenticate `gh`. Normal `gh` is already
authenticated; the managed boundary prevents it from retrieving the existing
credential.

### What is preserved and what is not

| Surface | Result | Mechanism |
|---|---|---|
| Installed commands | Preserved except real `security` | Caller `PATH` survives; AIM prepends one adapter executable |
| Working tree and repo-local config | Preserved | Caller cwd is unchanged; sandbox is allow-default |
| Ordinary environment variables | Mostly preserved | Runner copies the parent environment |
| Anthropic/provider overrides | Removed intentionally | Fixed `AUTH_ENV_KEYS` deletion |
| Global tool configuration | Default discovery lost | Process-wide `HOME` points to the label |
| Global tool authentication in files | Default discovery lost | Same |
| Keychain-backed tool authentication | Blocked on macOS | Inherited Keychain/Security service denial |
| Native macOS certificate trust for affected clients | Blocked or incomplete | System Keychain/trust services denied |
| Browser/app opening from descendants | Blocked on macOS | `lsopen` and Apple Events denied |
| Normal Claude global state | Explicitly inaccessible on macOS | Global `.claude` and `.claude.json` deny rules |
| Other AIM labels | Explicitly inaccessible on macOS | Whole nonselected AIM subtree denied |
| Selected Claude identity and sessions | Preserved per label | Claude config variables and managed projection |
| Project Claude settings/skills/MCP | Preserved if present | Resolved from unchanged repo cwd |

### Full observed and expected blast radius

#### GitHub CLI

The `gh` binary remains available. Its documented default configuration path is
`$HOME/.config/gh`, so AIM sends it to a nonexistent label-local path. The
normal GH configuration remains readable by absolute path through the sandbox,
but the stored token is in the macOS credential store. Restoring only
`GH_CONFIG_DIR` therefore rediscovers the account without restoring the token.

GitHub CLI officially stores a normal login in the system credential store and
falls back to plaintext only when secure storage is unavailable. AIM should not
copy, export, or reinject the token merely to compensate for an overbroad
process boundary.

#### Git

The Git binary and repository-local configuration survive. The default global
config moves from the real `~/.gitconfig` to the empty label home, so identity,
aliases, includes, signing configuration, and other personal settings can
disappear. The effective `osxkeychain` helper may remain named by other config,
but its credential backend is denied. `SSH_AUTH_SOCK` survives, so agent-backed
SSH can still work even while default `~/.ssh/config`, known hosts, and key
paths move.

#### Codex orchestration

Nested Codex loses:

- user config, model/defaults, MCP definitions, hooks, plugins, and local state
  because its default `CODEX_HOME` moves;
- file-backed authentication because the label-local Codex home has none;
- personal Codex skills under `$HOME/.agents/skills` because `$HOME` moves;
- native certificate trust under the macOS service denial;
- potentially more filesystem access when Codex's own sandbox is stacked
  inside AIM's outer sandbox.

The `CODEX_HOME` and `SSL_CERT_FILE` workaround proves the missing layers, but
making every skill or delegation remember those overrides is not a correct
product contract.

#### Claude personal tooling

Claude's own user scope is intentionally relocated by
`CLAUDE_CONFIG_DIR`. Current official scope locations include:

- settings, hooks, and plugin enablement in `~/.claude/settings.json`;
- personal skills in `~/.claude/skills`;
- personal agents in `~/.claude/agents`;
- personal `CLAUDE.md` and rules in `~/.claude`;
- user/local MCP registrations plus project trust and other mixed state in
  `~/.claude.json`.

The real profile contains meaningful versions of those surfaces; the managed
profiles do not. Project `.claude` and `.mcp.json` files would survive because
cwd is unchanged, but the inspected AIM repository contains no such fallback.

This is a distinct profile-sharing question after generic `HOME` is corrected:
preserving real `HOME` restores ordinary child tools, but Claude itself will
continue using its label config root by design. A later implementation must not
solve that by exposing or copying the entire mixed global Claude state.

#### Shells and language/toolchain managers

Child shells inherit the label home. Default `.zshrc`, `.zprofile`, Bash files,
and home-relative aliases/functions disappear unless an explicit `ZDOTDIR`,
`BASH_ENV`, or similar override was already set.

Toolchain managers and package tools likewise redirect:

- Cargo and Rustup defaults move, so an installed `rustc` shim can remain on
  `PATH` while its selected toolchain disappears.
- npm, pip/pipx, Go, and other caches/install state can be duplicated under
  each label.
- Existing managed homes already contain nested Codex, pipx, Claude, Node,
  and Go build/cache state. This proves that redirected writes are occurring,
  not merely that reads are missed.

#### Cloud and local infrastructure CLIs

AWS, kubectl, Docker, and gcloud commands remain installed but their normal
home-relative profiles, contexts, registry authentication, and caches move.
Explicit environment overrides such as `AWS_CONFIG_FILE`, `KUBECONFIG`,
`DOCKER_CONFIG`, and `XDG_CONFIG_HOME` survive if the caller happened to set
them; that makes behavior depend on shell preparation rather than AIM's
contract.

### Claude-specific profile map

Current local structural evidence, with no credential values inspected:

| Personal Claude surface | Real profile | Managed labels |
|---|---:|---:|
| Valid personal skills | 50+ | 0 |
| User MCP definitions | 5 | 0 |
| Enabled plugins | 2 | 0 |
| Installed plugins | 2 | 0 |
| User hook event groups | 3 | 0 |
| User `CLAUDE.md` | present | absent |
| User agents | 0 | 0 |
| Transcript files | 1,674 | 6 total |
| Auto-memory entries | 229 | 2 total |

The separation of transcript and memory state is consistent with the intended
label-scoped `--resume` contract. Loss of personal skills, MCPs, plugins,
hooks, and user instructions was not part of the user's expected direct-launch
experience.

### MacOS and Linux differ

The `HOME` and Claude config substitutions are common code, so generic
configuration loss and redirected writes occur on both platforms.

Linux launches directly under the supervisor and do not use the macOS adapter
or Seatbelt profile. On Linux, absolute paths into the real home remain
available under ordinary Unix permissions.

On macOS, global Claude state, Keychain/trust services, browser-opening
services, and other AIM labels are independently denied. This is why the same
`HOME` correction is necessary but not sufficient on macOS.

### Why the existing tests passed

The focused runner test asserts:

- the label home becomes `HOME`;
- both Claude config variables point at the label;
- cwd, stdio, and exact arguments are preserved;
- selected Anthropic variables are removed;
- one arbitrary project environment variable survives;
- the adapter is prepended to `PATH`.

The boundary test proves selected-label access and denial of a synthetic
Keychain path, global Claude state, another label, and real `security`, including
one ordinary child.

Those are valid assertions for the implemented mechanism, but they never test
the requirement the user actually experiences:

- normal `HOME`-relative developer configuration;
- authenticated `gh`;
- nested Codex config/auth/TLS;
- personal Claude skills/MCP/plugins/hooks;
- shell startup;
- language/toolchain state;
- cloud/kube/Docker contexts.

The test suite therefore converted an overbroad implementation choice into an
explicit expected value without proving environmental parity.

### Plan and implementation divergence

The binding native-management plan requires a direct-feeling launch and names
exactly two Claude profile variables:

```text
CLAUDE_CONFIG_DIR
CLAUDE_SECURESTORAGE_CONFIG_DIR
```

Its approach calls the Seatbelt profile a targeted Keychain/global-Claude
guard, not a general application sandbox. It does not require changing
process-wide `HOME`.

An earlier repository proposal had already empirically established that
`CLAUDE_CONFIG_DIR` relocates the whole Claude profile, including its sibling
app-state file, and explicitly flagged shared MCP configuration as a future
question. The production implementation nevertheless added `HOME=<label-home>`
and asserted it in tests.

The root failure is therefore not that per-label Claude profiles are wrong.
It is that the implementation conflated:

```text
Claude identity/profile namespace
```

with:

```text
the operating-system user's complete environment namespace
```

and then applied Claude's Keychain prohibition to every descendant.

### Ranked hypotheses

1. **Confirmed — process-wide `HOME` substitution hides or forks ordinary
   developer configuration.** Source, direct path checks, command resolution,
   global/local Git counts, and existing label-home residue all agree.
2. **Confirmed — Claude's personal skills/MCP/plugins/settings are separate
   label profiles.** Source, official scope documentation, and all inspected
   managed homes agree.
3. **Confirmed — macOS Keychain/Security denial independently breaks
   Keychain-backed tools and Codex native trust.** The profile is inherited;
   `GH_CONFIG_DIR` alone does not restore GH; the explicit PEM bundle restores
   nested Codex TLS.
4. **Disproved — commands were uninstalled or removed from `PATH`.** All
   representative binaries except real `security` remain resolvable.
5. **Disproved — the entire real home is filesystem-sandboxed.** Git, GH, SSH,
   Codex, and `.agents/skills` paths remain readable by absolute path; only
   named Claude/AIM/Keychain paths are denied.
6. **Disproved — the human's GH login is expired.** Normal GH authentication
   succeeds outside this boundary.
7. **Disproved — AIM explicitly chooses a different Codex profile.** It changes
   `HOME`; Codex computes its documented default from that value.

### Root cause

The account runner uses process-global isolation primitives for a
Claude-specific task:

```text
Claude account selection
  -> replace HOME for the whole process tree
  -> every child tool changes user namespace

Claude OAuth must avoid Keychain
  -> deny Keychain/trust/UI services for the whole process tree
  -> every child tool loses those services
```

The first mechanism was unnecessary given Claude's supported config-directory
selector. The second mechanism supplied a stronger structural guarantee than a
normal developer-agent process can coexist with: an inherited Seatbelt policy
cannot deny Security.framework to Claude while allowing the same service to a
`gh` or Codex child.

<!-- bugs:block:analysis:end -->

## Scope contract

### Correct behavior

- The real caller `HOME` reaches Claude and its descendants.
- `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` continue to select
  the exact label profile.
- The verified official Claude client continues using AIM's file-backed OAuth
  projection through the existing `security` compatibility semantics.
- Normal Git/GH/Codex/toolchain configuration resolves from the real home.
- Normal Keychain-backed GH auth and native certificate trust work for child
  tools on macOS.
- Existing Redis lease/fence/identity/lineage/CAS behavior, cleanup, arguments,
  cwd, terminal, signals, and resume state remain unchanged.

### Initial minimal convergence closure

- `src/targets/claude-runner.js` launch environment.
- `native/claude/no-keychain.sb` only where a rule blocks ordinary descendant
  trust/authentication required by the corrected behavior.
- Direct runner/boundary tests in `test/claude/native-storage.test.js`.
- One focused managed-environment compatibility probe.
- This bug document.

### Scope freeze before fix

The fix may not expand into a shared Claude tooling overlay, Redis changes,
credential-format changes, session migration, status/daemon work, fleet
deployment, generalized sandbox framework, or per-tool configuration
allowlist. If restoring descendant authentication requires a broker, copied
tokens, plaintext GH storage, or a growing list of tool-specific overrides,
the narrow fix has failed and must stop.

### Explicitly out of scope

- Copying dotfiles, tokens, Keychains, Codex homes, or caches into every Claude
  label.
- Injecting `GH_TOKEN`, `CODEX_HOME`, `SSL_CERT_FILE`, or per-tool config
  variables as the permanent product architecture.
- Reauthenticating GitHub, Codex, Claude, or any other service.
- Sharing or merging Claude transcripts, memory, trust, or permission state.
- Implementing the separate shared-skills/MCP/plugins/settings overlay.
- Changing Redis coordination, credential rotation, maintenance, status
  rendering, account selection, or public CLI syntax.
- Adding a helper daemon, privileged broker, proxy, container, VM, or copied
  Claude runtime.
- Remote installation or deployment.

### Enough proof

Before declaring the fix complete:

1. The focused runner test proves `HOME` is preserved while both Claude config
   variables remain label-scoped.
2. The existing selected-label, other-label, global-Claude, and real
   `security` boundary checks retain their intended results, except for the
   precisely justified descendant trust-service rule.
3. Under the corrected production envelope:
   - default global Git identity/config is visible;
   - default GH config is visible and `gh auth status` succeeds without
     printing any token;
   - default Codex config/auth are selected;
   - nested Codex completes one minimal real worker request without
     `CODEX_HOME` or TLS overrides;
   - representative Rustup and kubectl discovery match the normal shell.
4. Claude's label credential/app-state paths remain inside the selected
   profile, another AIM label remains inaccessible, real global Claude
   credential state remains inaccessible on macOS, bare `security` resolves to
   AIM's compatibility executable, and ordinary descendants can use the real
   macOS credential and trust services.
5. Existing affected tests and lint pass.

<!-- bugs:block:fix_plan:start -->

## Candidate fix plan

### Phase 1 — prove the narrow boundary

1. Preserve the caller's real `HOME` in a contained probe while retaining both
   label-scoped Claude config variables.
2. Test the existing macOS denial groups independently to find the smallest
   rule change that restores:
   - the existing GH credential;
   - Codex native certificate trust.
3. Re-run the current Claude 2.1.219 static credential-store checks. The
   qualified binary must still show bare-`security` OAuth calls, no direct
   Security.framework linkage, no static `SecItem*`/`SecKeychain*` imports, and
   no `/usr/bin/security` literal.
4. Stop if a narrow rule change cannot satisfy both ordinary child tooling and
   the file-backed Claude path.

Phase 1 is complete:

- `gh auth status` failed whenever the profile denied the real
  `/usr/bin/security`, even when other Security services were available.
- It also requires its ordinary credential service/file access. Selectively
  restoring only its config directory is insufficient.
- With the blanket Keychain/trust denials removed, real `HOME` restored, and
  the AIM adapter still first on `PATH`, `gh auth status` exited `0`.
- In the same boundary, bare `security find-generic-password ...` resolved to
  the AIM adapter and returned its exact `44` no-item status.
- One real nested Codex 0.146.0-alpha.5 turn returned exactly `PROBE_OK` with
  `CODEX_HOME`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and
  `CODEX_CA_CERTIFICATE` all unset.
- Current official Claude 2.1.219 remains a signed native executable with no
  direct Security.framework linkage, no static `SecItem*`/`SecKeychain*`
  imports, no `/usr/bin/security` string, and the same bare-`security`
  plaintext-fallback implementation.

### Phase 2 — implement only the proven change

1. Remove the assignment that replaces `HOME`; leave the copied caller value
   untouched.
2. Retain both Claude config assignments, auth/dynamic-loader scrubbing, exact
   cwd/argv/stdio, adapter `PATH`, and update suppression.
3. Remove only the blanket Keychain/trust restrictions empirically shown to
   break ordinary descendants. Keep global Claude state and other AIM labels
   blocked. Keep AIM's compatibility executable first on `PATH` so the
   qualified Claude client's verified bare-`security` credential calls remain
   file-backed; do not pretend an inherited process sandbox can distinguish
   the same OS service when invoked by Claude versus one of its children.
4. Rewrite the negative test that currently treats label-scoped `HOME` as the
   contract and add focused behavioral assertions for real-home developer
   discovery and label-scoped Claude state.

### Phase 3 — verify the actual failures first

1. Run the value-safe normal-versus-managed environment probe.
2. Run value-safe GH auth status under the corrected boundary.
3. Run one minimal nested Codex worker with no workaround variables.
4. Run the focused Claude storage/runner tests, then the existing affected CLI
   tests and lint.

<!-- bugs:block:fix_plan:end -->

<!-- bugs:block:implementation:start -->

## Implementation and verification

The implementation changed only the three surfaces admitted by the scope
contract:

| Surface | Narrow change |
|---|---|
| `src/targets/claude-runner.js` | Preserve `preparedLaunch.userHomeDir` as `HOME`; continue setting both Claude config variables to the selected managed profile. |
| `native/claude/no-keychain.sb` | Remove the process-tree-wide macOS credential/trust/UI denials; retain denial of global Claude state and every nonselected AIM label. |
| `test/claude/native-storage.test.js` | Assert the real user home and ordinary user services survive while selected-label access remains open and global/other-label Claude state remains closed. |

Nothing changed in Redis coordination, credential formats, rotation/fence
logic, CLI syntax, process supervision, account selection, deployment, or
Claude profile sharing.

### Production-boundary proof

A probe used the checked-in Seatbelt profile and the same parameters and
environment construction as a real managed launch. It made no Claude model
request and printed no credential:

| Check | Result |
|---|---|
| `gh auth status --hostname github.com` | exit `0` |
| Git, Rust, and kubectl normal user discovery | pass |
| Real `~/.codex/config.toml` discovery | pass |
| Selected label app-state access | allowed |
| Another AIM label | blocked |
| Real global Claude settings | blocked |
| `/usr/bin/security` for ordinary descendants | available |
| Bare `security` lookup used by qualified Claude | AIM shim, exact exit `44` |

A real nested Codex request then ran under that production profile with
`CODEX_HOME`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and
`CODEX_CA_CERTIFICATE` explicitly unset. It returned exactly `POSTFIX_OK` and
exited `0`. This proves both default Codex-home discovery and native TLS trust
without the workaround that affected agents had been carrying.

The qualified Claude 2.1.219 binary was also checked before the patch: it uses
the bare `security` command for this storage path, contains no
`/usr/bin/security` literal, has no direct Security.framework linkage, and has
no static `SecItem*` or `SecKeychain*` imports. That is why the PATH shim
remains sufficient for Claude while native OS services can be restored for its
children.

### Automated verification

All verification passed:

```text
node --test test/claude/native-storage.test.js
  27/27 pass

node --test \
  test/claude/native-storage.test.js \
  test/cli/redis-projection-command.test.js \
  test/cli/redis-login-command.test.js \
  test/cli/auth-maintain-command.test.js
  59/59 pass

npm run lint
  pass

npm test
  347/347 pass

git diff --check
  pass
```

### Deliberate remaining limitation

This fix restores ordinary developer tooling and Codex's personal
configuration, authentication, MCPs, and skills through the real `HOME`.
Claude's own personal user profile remains label-scoped because
`CLAUDE_CONFIG_DIR` is the mechanism that selects the managed account.
Therefore real-home Claude skills, MCP registrations, plugins, hooks, and
settings are not automatically shared into every managed label. Designing a
safe shared Claude-tooling overlay is a separate requirement and was
explicitly excluded from this narrow fix.

The fix is present only in the local working tree at the time of this record;
it has not been committed, pushed, or deployed.

<!-- bugs:block:implementation:end -->

## Primary references

- Current runner:
  `src/targets/claude-runner.js`
- Current macOS profile:
  `native/claude/no-keychain.sb`
- Current focused tests:
  `test/claude/native-storage.test.js`
- Original native plan:
  `docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md`
- Earlier profile proposal:
  `docs/aelaguiz/v2-proposal.md`
- [Claude Code settings and scope documentation](https://code.claude.com/docs/en/settings)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [GitHub CLI environment documentation](https://cli.github.com/manual/gh_help_environment)
- [GitHub CLI authentication documentation](https://cli.github.com/manual/gh_auth_login)
- [Codex configuration, authentication, and TLS manual](https://developers.openai.com/codex/)
