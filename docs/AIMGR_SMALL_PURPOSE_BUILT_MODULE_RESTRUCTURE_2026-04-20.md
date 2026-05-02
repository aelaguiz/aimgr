---
title: "aimgr - Small Purpose Built Module Restructure - Architecture Plan"
date: 2026-04-20
status: complete
fallback_policy: forbidden
owners: [aelaguiz]
reviewers: []
doc_type: phased_refactor
related:
  - README.md
  - package.json
  - src/cli.js
  - test/cli.test.js
  - https://nodejs.org/api/packages.html
  - https://nodejs.org/api/test.html
  - https://testing.googleblog.com/2010/12/test-sizes.html
  - https://martinfowler.com/bliki/OriginalStranglerFigApplication.html
---

# TL;DR

**Outcome**

Restructure `aimgr` into small, purpose-built, behavior-preserving modules where every authored runtime, script, and test file under `bin/`, `src/`, `scripts/`, and `test/` stays at or below 500 lines, `src/cli.js` becomes a thin facade over command wiring, and the existing CLI/state contracts still pass the current lint and test suite.

**Problem**

The project is currently centered on a 14,410-line `src/cli.js` and a 10,252-line `test/cli.test.js`, so unrelated concerns share one blast radius: argument parsing, state normalization, browser binding, provider auth, OpenClaw sync, Codex/Claude/Pi activation, Hermes rebalance/watch behavior, formatting, filesystem writes, and test fixtures all live in enormous files.

**Approach**

Preserve the current CLI and durable state behavior while extracting existing responsibilities into explicit ESM modules by domain and control boundary. Use external research on Node module boundaries, native `node:test`, incremental monolith extraction, and test sizing as grounding, but adapt it to this repo instead of adding generic architecture theater.

**Plan**

Use the Section 7 thirteen-phase plan as the authoritative execution order, starting with shared core/io/dependency/test-helper foundations and ending with CLI command cutover, test split, shared shell installer extraction, final proof, docs reality sync, and line-count closure.

**Non-negotiables**

- No user-visible command, JSON output, auth-store, state-schema, permission, backup, or failure-contract change unless the plan explicitly approves it.
- No runtime shims, duplicate writers, dual state sources, or long-lived bridge paths.
- No authored runtime, script, or test file under `bin/`, `src/`, `scripts/`, or `test/` above 500 lines at completion; generated/external dependency files are out of scope.
- No large rewrite that loses behavior evidence; refactors must move code behind behavior-preserving checks.
- Section 7 is the single authoritative execution checklist.

<!-- arch_skill:block:implementation_audit:start -->
# Implementation Audit (authoritative)
Date: 2026-04-20
Verdict (code): COMPLETE
Manual QA: n/a (non-blocking)

## Code blockers (why code is not done)
- None. Fresh audit checked the full approved Section 7 frontier and found no remaining code blocker.
- Evidence: `npm run lint` passed; `npm test` passed with 136 tests and no skips/todos; `node bin/aimgr.js --help` passed and emitted 4596 bytes; `node bin/aimgr.js status --json --home <temp>` passed; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0 for the installed/not-running service; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; `package-lock.json` is unchanged.
- Boundary/size evidence: `src/cli.js` is a one-line facade over `src/cli/main.js`; `test/cli.test.js` is absent; only `test/helpers/cli-runner.js` imports `../../src/cli.js`; no non-CLI owner imports `src/cli/*`; `src/io/prompts.js`, `src/io/streams.js`, and `src/core/watch-options.js` now own the prior prompt/stdio/sleep/watch-option seams; the largest authored in-scope file is `scripts/lib/watch-install.sh` at 491 lines.
- Scope-integrity check: no implementation-side rewrite weakened requirements, scope, acceptance criteria, or phase obligations to hide unfinished work.

## Reopened phases (false-complete fixes)
- None. Previously reopened Phases 1, 4, 8, 9, 10, and 13 are closed by the fresh audit evidence above.

## Missing items (code gaps; evidence-anchored; no tables)
- None.

## Non-blocking follow-ups (manual QA / screenshots / human verification)
- None.
<!-- arch_skill:block:implementation_audit:end -->

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-04-20
external_research_grounding: done 2026-04-20 (satisfied by Section 3 source-backed research pass under auto-plan)
deep_dive_pass_2: done 2026-04-20
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this refactor, `aimgr` is a modular Node.js CLI whose authored runtime, script, and test files under `bin/`, `src/`, `scripts/`, and `test/` are each at or below 500 lines, whose modules each have one clear reason to change, and whose observable behavior is preserved by `npm run lint`, `npm test`, targeted CLI smoke checks against temporary homes, and a final line-count/module-boundary audit.

This claim is false if any of these remain true at completion:

- `src/cli.js` still owns core domain logic instead of thin CLI dispatch and dependency wiring.
- Any authored file under `bin/`, `src/`, `scripts/`, or `test/` exceeds 500 lines without a user-approved exception recorded in the Decision Log.
- Tests pass only because behavior was narrowed, skipped, or moved behind a fallback.
- AIM has more than one durable credential/state source of truth.
- The current CLI commands, state file semantics, output shapes, auth-store projections, and fail-loud behavior drift without explicit approval.

## 0.2 In scope

Requested behavior scope:

- Keep the existing `aim` / `aimgr` CLI behavior intact while restructuring internals.
- Keep the documented AIM operating model intact: `~/.aimgr/secrets.json` remains the durable SSOT, downstream OpenClaw/Codex/Claude/Pi/Hermes stores remain derived outputs, and operators still work through labels.
- Preserve current command surfaces, including status, login/label maintenance, browser binding, OpenClaw rebalance/apply/sync, Codex sync/use/watch, Claude native flows, Hermes auth/rebalance/watch, and Pi use.
- Preserve current JSON output contracts and fail-loud behavior unless later research proves a current contract is internally inconsistent and the user approves a contract change.

Allowed architectural convergence scope:

- Split `src/cli.js` into domain modules with explicit ownership boundaries, imports, and dependency injection where IO/process spawning/current time/environment access needs test control.
- Split `test/cli.test.js` into smaller behavior-oriented test modules and shared fixtures/helpers.
- Extract shared constants, path resolution, filesystem JSON/backup operations, state schema/normalization, credential fingerprints, browser bindings, provider flows, target adapters, rebalance planners, watch loops, presentation formatting, and command controllers as separate units if repo evidence supports those boundaries.
- Update README or other touched live docs only where restructuring changes maintainer-facing source paths or command-development instructions.
- Delete superseded monolithic code paths as they are migrated; Git is the history.

Adjacent-surface scope:

- `package.json` scripts and bin wiring move only if necessary to keep the modular entrypoint idiomatic and testable.
- Shell watch installers are in scope for convergence because deep-dive found the Codex/Hermes installers are near-identical, already near the 500-line limit, and must share installer machinery while preserving behavior and package script names.
- `README.md` remains product/operator documentation; it should not become an architecture journal.
- `package-lock.json` should not change unless a dependency decision is explicitly approved.

Compatibility posture:

- External compatibility is preserved: command names, arguments, JSON shapes, state files, auth file locations, backup behavior, and nonzero/blocking semantics should remain stable.
- Internal compatibility uses a clean cutover: callers move to the new owner modules and the old monolithic definitions are deleted rather than bridged.
- Runtime fallbacks and compatibility shims are forbidden unless the user explicitly approves an exception, timebox, and removal plan.

External research requirement:

- The source-backed Section 3 research pass satisfies the required external research on current Node.js ESM package/module guidance, `node:test` organization/mocking guidance, test-size/hermetic testing guidance, and incremental monolith-refactor patterns.
- External findings must be adopted or rejected in the plan with reasons; no source may be cargo-culted into new tooling or process.

## 0.3 Out of scope

- New AIM product features, new commands, new account semantics, new auth providers, new watch policies, or new telemetry.
- A TypeScript migration, bundler/build-step migration, package-manager migration, framework migration, or public-library packaging change unless later research shows it is necessary and the user approves it.
- Changing durable AIM state schema semantics for cleanliness alone.
- Adding CI or repo-policing gates whose main job is enforcing file shape rather than protecting shipped behavior.
- Rewriting shell installers into JavaScript unless the deep dive proves a shared runtime boundary makes that necessary.
- Preserving the monolith as a compatibility layer after replacement.

## 0.4 Definition of done (acceptance evidence)

- `npm run lint` passes.
- `npm test` passes.
- A final line-count check shows every authored file under `bin/`, `src/`, `scripts/`, and `test/` is at or below 500 lines, or every exception has explicit user approval in Section 10.
- The CLI entrypoint remains executable through `bin/aimgr.js`, and representative smoke checks cover help/status plus at least one temp-home flow for each major target family touched by the refactor.
- The current behavior-preserving tests are split by domain without dropping coverage for the existing command families.
- The target architecture and phase plan cite both internal code evidence and external best-practice research.
- Superseded code paths, stale comments, and stale maintainer docs touched by the refactor are deleted or updated in the same implementation run.

## 0.5 Key invariants (fix immediately if violated)

- AIM has one durable credential/state SSOT.
- Downstream OpenClaw, Codex, Claude, Pi, and Hermes files remain derived targets.
- Command dispatch must stay thin; domain logic belongs in domain modules.
- IO, process spawning, time, environment, and filesystem writes cross explicit boundaries so behavior can be tested without global side effects.
- Modules are purpose-built, named for ownership, and small enough to read in one sitting.
- No authored runtime, script, or test file under `bin/`, `src/`, `scripts/`, or `test/` exceeds 500 lines at completion without explicit approval.
- No fallback shims, duplicate writers, shadow contracts, or soft-failure paths.
- No behavior drift during refactors without a Decision Log entry and user approval where user-visible contracts change.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Preserve observable behavior and operator trust.
2. Establish crisp module ownership so each file has one reason to change.
3. Keep modules small enough to understand, test, and review independently.
4. Make IO/process/time/environment dependencies explicit and injectable where tests need control.
5. Split tests along behavior boundaries without weakening regression coverage.
6. Prefer existing Node.js ESM and `node:test` primitives over adding architecture tooling.
7. Use external research to sharpen decisions, not to justify unnecessary framework churn.

## 1.2 Constraints

- The repo is an ESM Node.js package with `"type": "module"` and `node >=20`.
- The package is private and currently has no build step.
- `npm run lint` is `node --check` over `bin/aimgr.js` and `src/cli.js` today.
- `npm test` uses Node's native test runner.
- The CLI manages real local credential and auth-store files, so filesystem permissions, backups, and fail-loud boundaries matter.
- The refactor starts from a working monolith; behavior evidence must come before aesthetic module movement.

## 1.3 Architectural principles (rules we will enforce)

- Thin entrypoint: `bin/aimgr.js` and the future CLI root should parse, dispatch, and wire dependencies; they should not own domain rules.
- Domain ownership: state, credentials, browser binding, provider maintenance, target projection, rebalance planning, watch loops, command presentation, and filesystem primitives should live behind separate owner modules.
- Boundary injection: modules that read/write files, spawn processes, read env vars, use current time, or sleep should accept explicit dependencies where tests need control.
- Pure planners: selection, projection, reset, status derivation, and rebalance logic should stay pure where possible.
- Fail loud: invalid modes, unsupported auth-store policies, missing files, and unsafe overwrites should throw or return explicit blocked results, not silently fallback.
- Single source of truth: durable state normalization and write paths should have one owner.
- Small modules: if a file approaches 500 lines, split by responsibility instead of adding another section.

## 1.4 Known tradeoffs (explicit)

- More modules can make navigation worse if boundaries are arbitrary; phase planning must name owners from actual behavior, not from a generic folder taxonomy.
- Keeping Node native tests avoids framework churn, but test helpers must be extracted so split files do not duplicate enormous fixture setup.
- A hard 500-line ceiling is useful for this repo's readability goal, but enforcement should be evidence at completion, not a brittle CI shape-policing mechanism unless later approved.
- A clean internal cutover has less legacy drift than bridges, but it requires careful phase ordering and behavior-preservation checks.

# 2) Problem Statement (existing architecture + why change)

## 2.1 What exists today

- `README.md` describes `aimgr` as a small AI account manager whose durable SSOT is `~/.aimgr/secrets.json`, with OpenClaw, Codex CLI, Claude CLI, Pi CLI, and Hermes outputs derived from AIM state.
- `package.json` exposes `aimgr` and `aim` through `./bin/aimgr.js`, uses ESM, and defines `lint` and `test` scripts.
- `bin/aimgr.js` is a tiny executable wrapper.
- `src/cli.js` is 14,410 lines and contains constants, normalization helpers, path resolution, filesystem IO, provider credential logic, browser discovery/binding, OpenClaw model/session logic, state loading/normalization, target activation, rebalance/watch loops, formatting, prompts, and command dispatch.
- `test/cli.test.js` is 10,252 lines and imports many symbols directly from `src/cli.js`, with helper fixtures and tests for most command families in one file.
- The watch installer scripts are each 495 lines, close to the requested 500-line limit.

## 2.2 What’s broken / missing (concrete)

- The monolithic `src/cli.js` makes unrelated changes risky because a local edit can affect dispatch, state, IO, and target behavior in the same file.
- The enormous test file makes regression intent hard to scan and makes fixture/helper reuse implicit.
- Exported internals from `src/cli.js` act as an accidental API because tests need access to domain logic trapped inside the CLI file.
- Domain boundaries are discoverable only by reading thousands of lines instead of by imports, module names, and owner paths.
- The current shape blocks incremental elegance: new behavior naturally gets appended to the monolith instead of landing in a purpose-built owner.

## 2.3 Constraints implied by the problem

- The refactor must be behavior-preserving first and architecture-improving second.
- The target module graph must be derived from current command families and data contracts.
- Tests must move with behavior, not after behavior, or the refactor will lose proof.
- The plan must explicitly decide whether near-limit shell scripts are split, retained with explanation, or rewritten; it cannot ignore them.

# 3) Research Grounding (external + internal “ground truth”)

<!-- arch_skill:block:research_grounding:start -->
## 3.1 External anchors (papers, systems, prior art)

- Node.js package/module docs — adopt the existing ESM package stance and keep explicit relative `.js` imports for internal modules. Node documents that `"type": "module"` makes `.js` files ESM in this package scope, and static ESM imports require fully specified relative paths without extension searching. Use `package.json` `exports`/`imports` only if the deep dive finds a real internal boundary problem; this private CLI does not need public-package encapsulation ceremony by default. Source: <https://nodejs.org/api/packages.html>
- Node.js ESM docs — adopt ESM-native replacements for CommonJS conveniences where needed, especially `import.meta.dirname` / `import.meta.filename` or URL-based path resolution. Reject CommonJS interop wrappers unless a specific dependency boundary requires them. Source: <https://nodejs.org/api/esm.html>
- Node.js native test runner docs — keep `node:test` as the test foundation. Adopt its built-in test-context mocks and stable mock timers where they reduce global side effects; be cautious with module mocking because ESM module mocks require the `--experimental-test-module-mocks` flag and do not affect references imported before mocking. This supports explicit dependency injection around file/process/time/env boundaries instead of broad module monkeypatching. Source: <https://nodejs.org/api/test.html>
- Google Testing Blog, "Test Sizes" — adopt the small/medium/large distinction as design guidance for the split test suite: pure planners and normalizers should have small isolated tests; filesystem and CLI temp-home flows are medium integration tests; large end-to-end checks should remain sparse. Also adopt the isolation rule that tests should run independently and in any order. Source: <https://testing.googleblog.com/2010/12/test-sizes.html>
- Fowler / Thoughtworks Strangler Fig examples and AWS Prescriptive Guidance — adopt incremental replacement as a risk-reduction pattern, but adapt it to an in-process CLI refactor: migrate one behavior owner at a time, route callers to the new owner, and delete the monolithic implementation once that slice is covered. Reject long-lived anti-corruption layers or feature flags because Section 0 forbids runtime shims and product behavior must not branch. Sources: <https://martinfowler.com/articles/strangler-fig-mobile-apps.html>, <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/strangler-fig.html>

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors (do not reinvent):
  - `README.md` — operator-facing contract: `~/.aimgr/secrets.json` is the durable SSOT; OpenClaw, Codex, Claude, Pi, and Hermes stores are derived; labels are the operator abstraction; `ready` / `reauth` / `blocked` are the account states; command surfaces such as `aim status`, `aim <label>`, `aim rebalance openclaw`, `aim rebalance hermes`, `aim codex use`, `aim codex watch`, `aim hermes watch`, `aim claude use [label]`, and `aim pi use` are documented contracts.
  - `package.json` — runtime/tooling contract: private ESM package, Node `>=20`, bin names `aimgr` and `aim`, no build step, native `node:test`, and lint currently checking only `bin/aimgr.js` plus `src/cli.js`.
  - `bin/aimgr.js` — executable boundary: imports `main` from `../src/cli.js` and awaits `main(process.argv.slice(2))`. This is already thin and should stay thin.
  - `src/cli.js` — current monolithic behavior source: 14,410 lines containing constants, parsing, normalization, path resolution, JSON backup writes, state schema migration, credential fingerprints, provider auth, browser discovery/binding, OpenClaw model/session operations, Codex/Claude/Pi/Hermes target projection, usage probes, rebalance planners, watch loops, status rendering, interactive panels, and command dispatch.
  - `test/cli.test.js` — current preservation surface: 10,252 lines covering status redaction and warnings, browser binding, label panel flows, OpenClaw apply/rebalance/session reset, authority sync/promote, Hermes auth/rebalance/watch, Codex use/watch, Claude native capture/use/sync/promote, Pi use, pool ranking, usage ledgers, weighted planning, and CLI failure behavior.
  - `scripts/install-codex-watch.sh` and `scripts/install-hermes-watch.sh` — scheduler installer surfaces: both are 495 lines and substantially parallel, with macOS launchd and Linux systemd install/status/uninstall behavior.
- Canonical path / owner to reuse:
  - Runtime entrypoint should remain `bin/aimgr.js` -> `src/cli.js` or a renamed thin CLI root; `main(argv, deps)` is the existing command boundary and should remain the single top-level programmatic entrypoint unless deep-dive proves a rename is cleaner.
  - State loading, normalization, and write-with-backup behavior currently live around `createEmptyState`, `normalizeLegacyStateV0`, `normalizeAimgrStateFromJsonValue`, `loadAimgrState`, `writeJsonFileWithBackup`, and `writeJsonFileWithBackupIfChanged` in `src/cli.js`; these should converge into the state/filesystem owner modules.
  - Pure planning/ranking functions already exist as extractable units: `rankPoolCandidates`, `pickNextBestPoolLabel`, `pickNextBestLocalCliPoolLabel`, `pickNextCodexUseRoundRobinLabel`, `planWeightedOpenclawRebalance`, `planWeightedHermesRebalance`, and `projectPoolCapacity`.
  - Test helper behavior already exists at the top of `test/cli.test.js`: temp-home builders, JSON writers, Chrome/OpenClaw/Hermes fixture writers, SQLite helpers, and CLI stdout/exit-code wrappers. These should become shared test fixtures rather than duplicated per split test file.
- Adjacent surfaces tied to the same contract family:
  - `package.json` scripts must move with source/test layout changes so `npm run lint` and `npm test` keep proving the shipped repo.
  - `README.md` should be updated only for maintainer-facing source layout or developer workflow changes; operator command docs should stay behavior-focused.
  - `package-lock.json` should remain untouched unless a dependency is explicitly added, which is not currently justified.
  - Shell installers are in the line-count scope and likely duplicate each other. They should be inspected in deep-dive for possible shared helper extraction, but they already meet the strict `< = 500` ceiling and should not be rewritten for aesthetics alone.
  - Exported functions from `src/cli.js` are an accidental test API today. The refactor must replace accidental exports with intentional module exports that tests import from the owning module.
- Compatibility posture (separate from `fallback_policy`):
  - Preserve external contracts: command names, args, JSON shapes, state file semantics, auth-store writes, backups, permission-sensitive behavior, blocked statuses, and nonzero exit semantics.
  - Use clean internal cutover: for each migrated slice, tests and command handlers should import the new owner module, then the old monolithic definition should be deleted.
  - No runtime bridge is approved. Short-lived test migration indirection is also disfavored and would need a Decision Log entry if phase planning finds it unavoidable.
- Existing patterns to reuse:
  - `main(argv, deps)` already supports dependency injection for tests; preserve and narrow this pattern instead of adopting broad module mocking.
  - Many domain planners are pure or near-pure functions; keep planners pure and place side effects in adapters/controllers.
  - Temp-home integration tests already protect real filesystem contracts without touching operator homes.
  - Fail-loud errors are already part of the behavior surface for unsupported subcommands, unsafe modes, missing bindings, non-file-backed Codex homes, dirty authority imports, and missing Hermes auth.
- Prompt surfaces / agent contract to reuse:
  - Not applicable. This repo manages local AI account/auth surfaces but does not contain LLM prompt execution or model-reasoning behavior. Do not add agent-specific prompt harnesses or deterministic model wrappers as part of this refactor.
- Native model or agent capabilities to lean on:
  - Not applicable for the same reason. The relevant native platform capabilities are Node ESM, `node:test`, temp filesystem tests, process spawning injection, and mock timers.
- Existing grounding / tool / file exposure:
  - Existing repo scripts `npm run lint` and `npm test` are the primary verification commands.
  - Existing test fixtures already construct temp AIM, OpenClaw, Codex, Claude, Pi, Hermes, Chrome, and SQLite surfaces.
  - Existing docs already describe safe temp-home manual testing and should remain the operator reference for smoke checks.
- Duplicate or drifting paths relevant to this change:
  - `src/cli.js` combines many unrelated owners and must be split.
  - `test/cli.test.js` combines many unrelated behavior families and must be split with shared fixtures.
  - `scripts/install-codex-watch.sh` and `scripts/install-hermes-watch.sh` appear parallel enough that deep-dive must decide whether shared shell/helper extraction is warranted without changing install behavior.
  - `src/cli.js` currently exports only the functions tests needed from the monolith; those exports should become intentional owner-module APIs.
- Capability-first opportunities before new tooling:
  - Use ESM module boundaries plus explicit injected dependencies before adding a DI framework.
  - Use `node:test` and test-context mocks/mock timers before adopting Jest/Vitest or module-loader tricks.
  - Use line-count evidence at acceptance time before adding repo-shape CI gates.
  - Use direct behavior tests around temp homes and pure planners before adding bespoke architecture validators.
- Behavior-preservation signals already available:
  - `npm run lint` — current syntax check; must expand or remain meaningful as files split.
  - `npm test` — current full regression suite.
  - Current tests cover the major command families and many pure planners; the split must preserve the same behavior assertions.
  - Final line-count audit — proves the user's size ceiling but does not replace behavior tests.

## 3.3 Decision gaps that must be resolved before implementation

- No user blocker at the research stage. Deep-dive pass 1 resolved the initial architecture defaults in Sections 5 and 6:
  - Module ownership map: split by real behavior families and enforce dependency direction through imports.
  - Test split strategy: shared fixture helpers plus behavior-oriented `*.test.js` files matching owner modules.
  - Watch installer disposition: include now by extracting shared installer machinery because the two 495-line scripts are near-identical and already at the file-size ceiling.
  - Mutable singleton / dependency seams: preserve `main(argv, deps)` and push `fs`, process spawning, env, clock, sleep, stdout, and prompts behind owner-level dependencies where tests need control.

No unresolved plan-shaping decisions remain in research grounding. The Section 3 source-backed research pass satisfies the external research requirement under auto-plan, deep-dive pass 2 hardened the architecture against those anchors, and Section 7 is now the authoritative implementation checklist.
<!-- arch_skill:block:research_grounding:end -->

# 4) Current Architecture (as-is)

<!-- arch_skill:block:current_architecture:start -->
## 4.1 On-disk structure

Current authored source layout:

```text
bin/aimgr.js                         5 lines   executable wrapper
src/cli.js                       14,410 lines  all runtime behavior + accidental internal API
test/cli.test.js                 10,252 lines  all fixtures + all behavior tests
scripts/install-codex-watch.sh      495 lines  codex scheduler installer
scripts/install-hermes-watch.sh     495 lines  hermes scheduler installer
scripts/install-local-bin.sh         27 lines  local wrapper installer
README.md                         1,071 lines  operator/product contract
package.json                         28 lines  bin/scripts/runtime contract
```

The runtime package is ESM (`"type": "module"`) and currently has no build step. The executable boundary is already ideal in size but points directly at the monolith:

```js
#!/usr/bin/env node
import { main } from "../src/cli.js";

await main(process.argv.slice(2));
```

`src/cli.js` exports many symbols only because tests need to reach behavior trapped inside the monolith. The exports are not a designed public API; they are the current accidental owner map.

Pass 2 line-range scan of `src/cli.js` shows the monolith already has implicit ownership bands that should become real modules:

| Range | Current ownership cluster | Target owner |
| --- | --- | --- |
| 9-611 | Constants, provider labels, argument parsing, help, path helpers, process basics | `core/*`, `cli/args.js`, `cli/help.js`, `io/paths.js`, `io/process.js` |
| 615-1150 | OpenClaw config model syncing, session model reset, gateway calls | `openclaw/models.js`, `openclaw/sessions.js`, `openclaw/config.js` |
| 1168-1785 | JSON reads/writes, backups, directory modes, state creation/normalization, credential fingerprints, authority metadata, redaction | `io/json-store.js`, `state/*`, `credentials/*`, `core/sanitize.js` |
| 1842-3163 | Browser launch, Chrome profile discovery, binding normalization, binding suggestions, setup wizard helpers | `browser/bindings.js`, `browser/discovery.js`, `browser/launch.js`, `browser/wizard.js` |
| 3200-6319 | State selectors, target path resolution, Codex/Claude/Pi/Hermes target status/writes, Claude native bundles, authority import/promote | `state/selectors.js`, `targets/*`, `credentials/authority.js`, `credentials/anthropic.js` |
| 6370-6940 | Provider account maintenance and login/update orchestration | `credentials/*`, `browser/*`, `panels/*`, `cli/commands/login.js` |
| 6951-10086 | Usage probes, status collection, pool eligibility, ranking, weighted demand/capacity planning | `pool/usage.js`, `pool/ranking.js`, `pool/weighted-planner.js`, `pool/capacity.js`, `status/view.js` |
| 10130-11862 | Status text rendering, warnings, label panel rendering/actions | `status/render.js`, `status/warnings.js`, `panels/*` |
| 11938-14410 | CLI subcommand branches, OpenClaw apply/sync, Codex/Hermes/Claude/Pi activation/watch/rebalance | `cli/commands/*`, `openclaw/*`, `pool/watch.js`, `targets/*` |

`test/cli.test.js` has the same accidental-collapse problem from the other side: it imports from `../src/cli.js`, centralizes stdout/exit-code patching in `runCli` helpers, and contains broad time-sensitive fixtures. The split must move test imports to owner modules while keeping only command-level integration helpers pointed at `main`.

## 4.2 Control paths (runtime)

Primary command flow today:

```text
bin/aimgr.js
  -> src/cli.js main(argv, deps)
     -> parseArgs(argv)
     -> resolveAimgrStatePath(opts), resolveHomeDir(opts.home)
     -> command branch
        status           -> load state -> buildStatusView -> render/sanitize output
        login/<label>    -> ensure shape -> optional TTY panel -> provider maintenance -> state write
        browser          -> show/set explicit browser binding -> state write for set
        internal         -> read stdin promotion payload -> apply authority payload -> optional state write
        pin/autopin      -> fail-loud removed-command errors
        rebalance        -> OpenClaw/Hermes rebalance -> state write -> JSON receipt
        apply            -> sync OpenClaw from stored state -> JSON receipt
        auth write       -> write derived Hermes auth file -> JSON receipt
        sync             -> OpenClaw/Codex/Claude sync/import -> state write as needed
        promote          -> Codex/Claude promotion to authority -> state write
        codex use/watch  -> local Codex target activation or watch loop -> state write/receipt
        hermes watch     -> Hermes pool watch loop -> state write/receipt
        claude use/native capture/export/import
        pi use           -> local Pi target activation -> state write/receipt
```

Side effects are mixed through the same file:

- `fs.*` reads/writes, backup creation, `fs.rmSync`, `fs.cpSync`, and directory permission management.
- `spawn` / `spawnSync` calls for `openclaw`, `sqlite3`, `ssh`, `agent-browser`, `osascript`, and provider/CLI probes.
- `process.env` reads for `HOME`, `PATH`, `WORKSPACE_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, Claude web cookie/session keys, and auth override detection.
- `process.stdout.write` and `process.exitCode` writes in both command dispatch and interactive panel helpers.
- `Date.now()` / `new Date()` timestamps across state writes, receipts, usage windows, history pruning, and status formatting.
- `fetch` for remote Codex and Claude usage probes.
- `setTimeout` for fetch timeout handling and `sleep` for watch loops.

The current `main(argv, deps)` provides a useful top-level test seam, but many lower-level functions still reach globals directly. The target must keep the top-level seam and move side effects behind smaller owner-level seams.

## 4.3 Object model + key abstractions

Current concepts already present in code and tests:

- AIM state: `schemaVersion`, `accounts`, `credentials`, `targets`, OpenClaw assignments/pins/exclusions, Codex/Claude authority import metadata, demand ledgers, receipts, and history.
- Accounts and labels: normalized non-`default` labels, provider ids, account readiness, reauth state, pool state, and provider-specific blockers.
- Credentials: OpenAI/Codex OAuth credentials, Anthropic/Claude native bundles, fingerprints, account identities, token expiry, dirty/promoted authority metadata, portable promotion payloads.
- Browser bindings: `aim-profile`, `chrome-profile`, `agent-browser`, `manual-callback`, Chrome Local State inspection, OpenClaw browser profile discovery, repo `agent-browser.json` discovery, binding wizards, and launchers.
- Provider maintenance: OpenAI/Codex browser or manual callback OAuth, token refresh, Anthropic native bundle capture/import/export/refresh, duplicate identity protection, and maintenance attempt/success/failure facts.
- Derived targets: OpenClaw auth/session/model config, Codex CLI auth/config, Claude CLI credentials/app state, Pi auth, Hermes auth JSON and pool entries.
- Authority sync/promotion: local/file/SSH authority locators, import conflict detection, dirty-label handling, internal apply payloads, and promotion receivers.
- Usage and capacity: Codex/Claude usage snapshots, Hermes/OpenClaw session token counters, demand ledgers, weighted supply/demand planning, pool ranking, round-robin local selection, exhaustion history, and capacity projection.
- Status/presentation: sanitized JSON views, compact/full text status, account tables, warnings, reset/expiry formatting, label panel rendering, menus, and interactive action flow.
- Command controllers: current command branches bind together state load/write, domain operations, receipts, rendering, and exit-code behavior.

## 4.4 Observability + failure behavior today

Observable behavior contracts:

- JSON output is sanitized through `sanitizeForStatus`; status tests assert access/refresh/id tokens do not leak.
- Many commands return receipts with `status`, `ok`, `warnings`, `blocked`, `activeLabel`, `assignments`, or domain-specific payloads.
- Commands set `process.exitCode = 1` for blocked activation/rebalance/watch receipts while still emitting JSON.
- Unsupported or removed commands fail loudly: `pin`, `autopin`, `sync hermes`, label-first `codex use`, label-first `pi use`, `codex watch <label>`, and `hermes watch <label>`.
- File writes use backup behavior for AIM state, and tests assert migration persists back to disk.
- Codex file-backed mode is enforced; unsupported `keyring` / `auto` modes fail loud.
- Dirty authority imports block destructive sync/promote behavior unless explicitly discarded.
- Claude native rotation sync preserves rotated live tokens before switching labels.
- Hermes/OpenClaw demand reads can block with truthful unreadable/missing-auth receipts.
- Interactive flows print menus and details; tests cover representative prompt-driven paths.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No product UI redesign is in scope. The relevant UI surfaces are CLI output contracts:

```text
aim status [--json|--compact|--accounts|--assignments]
aim <label>              # TTY label panel
aim browser show/set
aim rebalance openclaw|hermes
aim codex use|watch
aim hermes watch
aim claude use|capture-native|export-live|import-native
aim pi use
```

Prompt text, menu choices, JSON receipt shapes, blocked statuses, and nonzero behavior are compatibility surfaces. They should move into presentation/command modules but should not be redesigned during this refactor.
<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->
## 5.1 On-disk structure (future)

Target: one thin CLI entrypoint plus explicit owner modules. All authored runtime/test/script files stay at or below 500 lines.

```text
bin/
  aimgr.js

src/
  cli/
    main.js                 # main(argv, deps), dispatch wiring only
    args.js                 # parseArgs + option validation
    help.js                 # help text
    deps.js                 # default dependency factory
    commands/
      status.js
      login.js
      browser.js
      openclaw.js
      auth.js
      sync.js
      promote.js
      codex.js
      hermes.js
      claude.js
      pi.js
      internal.js
  core/
    constants.js
    labels.js
    providers.js
    time.js
    sanitize.js
    shell.js
  io/
    paths.js
    json-store.js
    process.js
    fetch.js
  state/
    empty.js
    normalize.js
    selectors.js
    metadata.js
    demand-ledgers.js
  credentials/
    codex.js
    anthropic.js
    fingerprints.js
    authority.js
  browser/
    bindings.js
    discovery.js
    launch.js
    wizard.js
  openclaw/
    config.js
    models.js
    sessions.js
    apply.js
    rebalance.js
  targets/
    codex-cli.js
    claude-cli.js
    pi-cli.js
    hermes-auth.js
    hermes-home.js
  pool/
    usage.js
    ranking.js
    weighted-planner.js
    hermes-rebalance.js
    capacity.js
    watch.js
  status/
    view.js
    render.js
    warnings.js
  panels/
    label-panel.js
    render.js

test/
  helpers/
    fs.js
    fixtures.js
    cli.js
    openclaw.js
    hermes.js
    claude.js
  status/status.test.js
  browser/browser.test.js
  panels/label-panel.test.js
  openclaw/apply-rebalance.test.js
  openclaw/sessions-models.test.js
  authority/codex-sync-promote.test.js
  authority/claude-sync-promote.test.js
  hermes/auth-rebalance-watch.test.js
  codex/use-watch.test.js
  claude/native-use-sync.test.js
  pi/use.test.js
  pool/planners.test.js
  cli/removed-commands.test.js

scripts/
  lib/watch-install.sh
  install-codex-watch.sh
  install-hermes-watch.sh
  install-local-bin.sh
```

This is the target owner map for implementation. Any later filename deviation is a plan change and must be recorded before implementation relies on it.

## 5.2 Control paths (future)

Future command flow:

```text
bin/aimgr.js
  -> src/cli.js facade
  -> src/cli/main.js main(argv, deps = createDefaultDeps())
     -> parseArgs(argv)
     -> command table dispatch
        -> command handler loads/writes state through state/io owners
        -> domain owner performs behavior
        -> presentation owner renders output
        -> handler sets blocked exit semantics consistently
```

Dependency direction:

```text
cli/commands -> domain owners -> core/io/state primitives
status/render -> status/view -> domain read models
tests -> owning module public exports + helpers
domain owners must not import cli/commands
domain owners must not write stdout or process.exitCode
pure planners must not import fs/spawn/fetch/process
```

The canonical programmatic entrypoint remains `main(argv, deps)`. It is exported through the thin `src/cli.js` facade during and after cutover. By completion, no domain behavior may live in `src/cli.js`.

## 5.3 Object model + abstractions (future)

Target owner contracts:

- `state/*`: owns schema version, empty state, legacy normalization, shape enforcement, state selectors, authority import metadata, demand-ledger pruning, and AIM state read/write orchestration with `io/json-store`.
- `io/json-store.js`: owns JSON parse/stringify, backup timestamps, write-if-changed, directory creation, and permission preservation. No domain module should hand-roll JSON file writes.
- `io/process.js`: owns executable resolution and process spawn adapters. Domain modules receive specific adapters where needed.
- `credentials/*`: owns provider credential shape assertions, fingerprints, identity matching, portable credential payloads, and provider-specific native bundle transforms.
- `browser/*`: owns binding normalization, discovery, facts, launch, and setup wizard logic. Browser modules can depend on `io/process` and `io/paths`; they should not know command receipt formatting.
- `openclaw/*`: owns OpenClaw config reads/writes, model/session reset planning and application, assignment materialization, OpenClaw demand import, and OpenClaw rebalance orchestration.
- `targets/*`: owns derived local target auth/config writes for Codex, Claude, Pi, and Hermes. These modules write derived outputs only and must never become durable credential SSOTs.
- `pool/*`: owns pure ranking/weighted assignment/capacity planning, Hermes rebalance orchestration, and watch-loop orchestration. Usage probes are explicit dependencies.
- `status/*`: owns status view assembly, warnings, redaction/sanitization, and text rendering.
- `panels/*`: owns TTY label control panel state/actions/rendering and prompt orchestration.
- `cli/commands/*`: owns command-specific orchestration only: parse subcommand intent, call domain owner, write AIM state when required, emit sanitized output, and set exit code for blocked receipts.
- `scripts/lib/watch-install.sh`: owns shared launchd/systemd install/status/uninstall rendering. Target scripts supply service labels, command target (`codex watch` vs `hermes watch`), descriptions, and log names.

## 5.4 Invariants and boundaries

Hard target invariants:

- `~/.aimgr/secrets.json` remains the only durable credential/account SSOT.
- Derived target writers never read from or write to each other's target stores as truth.
- Command modules do not contain provider/token/state-normalization rules.
- Domain modules do not write stdout or mutate `process.exitCode`.
- Pure planners do not import `fs`, `child_process`, `process`, `fetch`, or timers.
- Side-effect modules are small and injectable where tests need control.
- Every module has one clear reason to change and remains at or below 500 lines.
- Removed monolithic definitions are deleted after migration; no parallel owners.
- Internal cutover is clean. No runtime bridge/shim is approved.
- External behavior is preserved: command surface, JSON shape, state semantics, auth-store paths, backups, blocked/nonzero behavior, and fail-loud errors.

## 5.5 UI surfaces (ASCII mockups, if UI work)

No UI redesign. Target presentation ownership:

```text
status/view.js       -> JSON-safe status object
status/render.js     -> compact/full text rendering
panels/render.js     -> label-panel menu text
cli/commands/*.js    -> output emission and exit-code semantics
```

Prompt/menu text and JSON receipts stay stable unless a later user-approved decision changes them.

## 5.6 Pass 2 sharpened contracts

These contracts are binding for phase planning:

- CLI facade: by completion, `src/cli.js` remains as a thin under-500-line facade that re-exports `main` from `src/cli/main.js`. Because `bin/aimgr.js` already imports `../src/cli.js`, keep `src/cli.js` as that facade and drain all domain behavior out of it.
- Import policy: use explicit relative `.js` imports between owner modules. Do not add barrel indexes, `package.json` import maps, or public-package export ceremony unless a phase records a concrete boundary problem those mechanisms solve.
- Command handler contract: command modules receive a parsed, dependency-bearing context and return or emit through command-owned helpers. A representative shape is `runXCommand(ctx)`, where `ctx` contains parsed options/positionals, `homeDir`, `statePath`, injected deps, output helpers, and exit-code helpers. Domain modules should return data or receipts; command handlers decide stdout and blocked exit semantics.
- Dependency contract: `src/cli/deps.js` owns the default dependency factory for filesystem, spawn/spawnSync, fetch, env, clock, sleep, stdio, stdin, and prompt hooks. Owner modules accept only the dependencies they need. Split tests should prefer narrow fake deps over global monkeypatching; CLI integration helpers may still capture stdout/exitCode around `main`.
- Receipt contract: domain modules produce stable receipt/data objects and never call `process.stdout.write` or mutate `process.exitCode`. Redaction/sanitization remains centralized before command output.
- Test split contract: tests import pure/domain owner exports directly; only CLI integration helpers import `main`. Shared test helpers under `test/helpers/*` must also respect the 500-line ceiling and must not become a new monolith.
- Shell installer contract: `scripts/install-codex-watch.sh` and `scripts/install-hermes-watch.sh` become small target config wrappers over `scripts/lib/watch-install.sh`. The shared library owns launchd/systemd install, status, uninstall, path resolution, and print-only rendering; target wrappers own labels, command target, descriptions, and log names.
<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->
## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CLI wrapper | `bin/aimgr.js` | import `../src/cli.js`; await `main` | Thin executable wrapper | Preserve wrapper import and make `src/cli.js` a thin facade over `src/cli/main.js` | Keep bin contract stable | `aim` and `aimgr` still execute same CLI | CLI smoke, help tests |
| CLI root | `src/cli.js` | `main(argv, deps)` | Entrypoint plus all domain behavior | Replace with thin facade re-exporting `main` from `src/cli/main.js`; domain logic moves out | Preserve programmatic entry while deleting monolith | `main(argv, deps)` remains canonical top-level API | All command tests |
| Import boundary / accidental test API | `test/cli.test.js`, `src/cli.js` | `import { ... } from "../src/cli.js"` | Tests depend on monolith exports as an accidental internal API | Replace with imports from owner modules; only CLI integration helpers import `main` | Prevent `src/cli.js` from surviving as a dumping-ground API | Intentional owner exports only | entire split suite |
| Argument/help parsing | `src/cli.js` | `parseArgs`, option parsers, `printHelp` | Mixed into monolith and writes stdout | Move to `src/cli/args.js` and `src/cli/help.js`; command root owns emission | Separate syntax from behavior | Parsed `{opts, positional}` contract | help, command errors, watch thresholds |
| Constants/providers | `src/cli.js` | provider ids, modes, thresholds, model refs | Shared constants hidden at top of monolith | Move to `src/core/constants.js` / `providers.js` | Prevent duplicated literals after split | Named ESM exports | broad compile/test coverage |
| Paths/filesystem | `src/cli.js` | `resolve*Path`, `readJsonFile`, write-with-backup helpers | Path and JSON IO mixed with domain behavior | Move to `src/io/paths.js` and `src/io/json-store.js` | One owner for backups and path semantics | File IO adapters + path helpers | state migration, auth writes, target writes |
| Process/network/time | `src/cli.js` | `spawnQuiet`, `fetchJsonWithTimeout`, `sleep`, env reads, `Date.now()` | Side effects scattered across domain helpers | Move to `src/io/process.js`, `src/io/fetch.js`, `src/core/time.js`; inject into owners | Smaller tests, less global patching | Explicit deps for spawn/fetch/clock/sleep | watch, usage, OpenClaw, SSH, Claude status |
| State schema | `src/cli.js` | `createEmptyState`, `normalizeLegacyStateV0`, `ensureStateShape`, state selectors | AIM state schema/normalization in monolith | Move to `src/state/*` | One durable state contract owner | Normalized AIM state API | status migration, sync/promote, all command temp-home tests |
| Credential identity | `src/cli.js` | fingerprints, credential assertions, Claude native bundle transforms | Provider credential logic mixed with targets and commands | Move to `src/credentials/*` | Separate durable credentials from target projections | Provider credential APIs | token redaction, Claude native, dirty imports |
| Browser binding | `src/cli.js` | discovery, binding normalize/set/show, launch, wizard | Browser binding and prompt flows mixed together | Split into `browser/bindings.js`, `browser/discovery.js`, `browser/launch.js`, `browser/wizard.js` | Clear ownership and test seams | Binding model + launch/discovery contracts | browser tests, label panel tests, login tests |
| OpenClaw models/sessions | `src/cli.js` | model sync ops, session reset, gateway calls | OpenClaw config/session behavior in monolith | Move to `src/openclaw/models.js`, `sessions.js`, `config.js` | Keep OpenClaw contract together | OpenClaw adapter + pure reset planners | model/session tests, apply/rebalance tests |
| OpenClaw apply/rebalance | `src/cli.js` | `applyOpenclawFromState`, `rebalanceOpenclawPool`, demand ledger | Assignment materialization and planning mixed with CLI | Move to `src/openclaw/apply.js`, `rebalance.js`, `pool/weighted-planner.js` | Separate orchestration from pure planning | Rebalance receipt contract | OpenClaw apply/rebalance tests |
| Authority sync/promote | `src/cli.js` | authority locator, import/promote payloads, SSH receiver | Codex and Claude authority logic in monolith | Move to `src/credentials/authority.js` plus provider-specific modules | Keep authority conflict semantics single-source | Authority import/promote APIs | sync/promote tests, internal apply tests |
| Target writers | `src/cli.js` | Codex/Claude/Pi/Hermes auth writes and clears | Derived target file logic mixed with selection | Move to `src/targets/*` | Enforce derived-target boundary | Target activation/write APIs | codex use, claude use, pi use, auth write hermes |
| Usage probes | `src/cli.js` | Codex/Claude fetch, Hermes/OpenClaw SQLite/session reads | Probe logic mixed with planners and status | Move to `src/pool/usage.js` plus target adapters | Keep IO separate from ranking | Usage snapshot/read APIs | watch tests, status usage tests, ledger tests |
| Ranking/planning/capacity | `src/cli.js` | `rankPoolCandidates`, `planWeighted*`, `projectPoolCapacity` | Mostly pure planners in monolith | Move to `src/pool/ranking.js`, `weighted-planner.js`, `capacity.js` | Pure modules with direct unit tests | Side-effect-free planner APIs | pool/planner tests |
| Hermes rebalance orchestration | `src/cli.js` | `rebalanceHermesPool`, Hermes home status and assignment orchestration | Hermes fleet planning and target writes mixed with CLI | Move orchestration to `src/pool/hermes-rebalance.js` using `src/pool/weighted-planner.js` and `src/targets/hermes-*` | Gives Hermes rebalance a canonical non-command owner | Hermes rebalance receipt API | Hermes rebalance/watch tests |
| Watch loops | `src/cli.js` | Codex/Hermes watch once/loop | Looping mixes sleep, probes, activation/rebalance, output | Move to `src/pool/watch.js` and command wrappers | Test loop behavior with injected sleep/probes | Watch once/loop APIs | codex watch, hermes watch tests |
| Status view/render | `src/cli.js` | `buildStatusView`, warning builders, renderers | Status read model and rendering in monolith | Move to `src/status/view.js`, `warnings.js`, `render.js` | Preserve output while making status navigable | JSON view + text render APIs | status tests |
| Label panel | `src/cli.js` | panel state, render, actions, prompts | Interactive UI mixed with login/browser/provider logic | Move to `src/panels/*` with domain calls injected | Preserve prompt UX and isolate presentation | Panel state/action APIs | label panel tests |
| Command handlers | `src/cli.js` | large `if (cmd === ...)` chain | Dispatch, domain logic, writes, output, exit codes in one function | Move to `src/cli/commands/*.js`; `main` uses command table | One handler per command family | `runXCommand(ctx)` style APIs | command integration tests |
| Command context and deps | `src/cli.js`, `test/cli.test.js` | `main(argv, deps)`, `runCli`, global stdout/exit/time patching | Top-level deps exist, but lower-level code still reaches globals | Introduce default dep factory and narrow owner-level deps; retain CLI integration capture only in helpers | Makes split tests smaller and avoids ESM module-mocking ceremony | `createDefaultDeps()` plus per-owner injected adapters | CLI integration, watch, usage, target writes |
| Test helpers | `test/cli.test.js` | `mkTempHome`, fixture writers, `runCli`, stdout/exit patching | Fixtures and all tests in one 10k-line file | Move to `test/helpers/*`; tests import helper contracts | Avoid duplicate fixtures after split | Shared fixture modules under 500 lines | entire split suite |
| Test behavior groups | `test/cli.test.js` | all `test("...")` cases | One huge behavior file | Split into owner-aligned `*.test.js` files | Maintains coverage and reviewability | Behavior test files by domain | all existing assertions |
| Watch installers | `scripts/install-codex-watch.sh`, `scripts/install-hermes-watch.sh` | launchd/systemd install/status/uninstall | Two 495-line near-identical scripts; a unified diff is only 122 lines and differs mainly labels/command strings | Extract shared `scripts/lib/watch-install.sh`; target scripts supply config | Removes duplicated shell truth and prevents future line-limit breach | Shared shell library + small target wrappers | installer `--print-only`, `--status` if practical |
| Local bin installer | `scripts/install-local-bin.sh` | wrapper install | Already small and purpose-built | Preserve unless path changes require update | No convergence need | Same script | install smoke if touched |
| Package scripts | `package.json` | `lint`, `test`, watch install scripts | Lint checks only two JS files | Update lint to cover all authored JS runtime/test files after split; keep script names stable | Verification must follow moved files | Same npm script names | `npm run lint`, `npm test` |
| Line-count acceptance | `bin/`, `src/`, `scripts/`, `test/` | authored files | Two JS files massively exceed 500; shell watch scripts are just under the ceiling | Audit final authored files and split any file above 500, including helpers | Directly satisfies user requirement without adding brittle shape CI by default | Completion evidence report; exceptions only by user-approved Decision Log entry | final audit |
| README | `README.md` | operator docs and temp-home guidance | Product/operator truth, not architecture journal | Update only source layout/developer workflow references if stale after refactor | Avoid stale live docs | Operator behavior unchanged | manual doc skim |

## 6.2 Migration notes

* Canonical owner path / shared code path:
  * `main(argv, deps)` remains the top-level CLI API.
  * `src/state/*` owns AIM state schema/normalization/selectors.
  * `src/io/json-store.js` owns backup writes and JSON file mechanics.
  * `src/targets/*` owns derived target writes only.
  * `src/pool/*` owns ranking, weighted planning, usage abstraction, capacity, and watch orchestration.
  * `src/pool/hermes-rebalance.js` owns Hermes rebalance orchestration.
  * `scripts/lib/watch-install.sh` owns shared scheduler install logic for Codex/Hermes watch scripts.
* Deprecated APIs (if any):
  * The only deprecated internal API is the accidental "import everything from `src/cli.js`" test API. It must be replaced by intentional owner-module exports.
  * No external CLI API is deprecated by this refactor.
* Delete list (what must be removed; include superseded shims/parallel paths if any):
  * Domain logic in `src/cli.js` after each owner migration.
  * Duplicate fixture/helper definitions left in split test files.
  * Duplicated scheduler install functions in per-target watch scripts after shared shell extraction.
  * Stale source-layout comments or README maintainer references if touched by implementation.
* Adjacent surfaces tied to the same contract family:
  * `package.json` lint/test scripts move with source layout.
  * Tests move with owner modules and must retain current assertions.
  * README changes only if developer/source-layout guidance becomes stale.
  * Shell watch scripts move together because they are near-identical sibling surfaces.
* Compatibility posture / cutover plan:
  * Preserve external contracts.
  * Clean internal cutover per slice.
  * No runtime bridge. No long-lived compatibility shim.
  * During implementation, a thin `src/cli.js` re-export is acceptable only as the final CLI-root facade if it stays under 500 lines and contains no domain rules.
* Capability-replacing harnesses to delete or justify:
  * Not applicable; this is not an agent-backed behavior refactor.
  * Avoid adding module-loader/mocking harnesses. Prefer owner modules and explicit dependencies.
* Live docs/comments/instructions to update or delete:
  * `README.md` only if source layout, lint/test instructions, or script names change.
  * Code comments should be added sparingly at new SSOT boundaries: state schema, backup writes, target-writer derived-output rule, and weighted planner invariants.
* Behavior-preservation signals for refactors:
  * `npm run lint`
  * `npm test`
  * Split test files preserving current assertions by behavior family.
  * CLI smoke checks for `--help`, `status --json --home <temp>`, and representative target activation/rebalance/watch temp-home flows where current tests already support safe fixtures.
  * Final line-count audit over authored files under `bin/`, `src/`, `scripts/`, and `test/`.
* Required ordering constraints:
  * Establish `core/*`, `io/*`, `state/*`, and shared test helpers first so later extractions have stable primitives.
  * Move pure planners, status view construction, sanitization, and rendering before draining command handlers where practical.
  * Move credential identity, authority sync/promote, and derived target writers with temp-home preservation tests because they own durable/derived store boundaries.
  * Drain CLI command branches only after their domain owners exist; `src/cli.js` should shrink monotonically toward the facade.
  * Split the watch installer shell scripts as an independent convergence slice; keep target wrappers behavior-identical to the current scripts.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope (include/defer/exclude/blocker question) |
| ---- | ------------- | ---------------- | ---------------------- | ------------------------------------- |
| State SSOT | `src/cli.js` state helpers | Single `state/*` owner | Prevent command modules and target writers from inventing state shapes | include |
| Derived target writes | Codex/Claude/Pi/Hermes write helpers | `targets/*` derived-output modules | Keeps AIM state as SSOT and target stores as projections | include |
| JSON writes/backups | `writeJsonFileWithBackup*`, `writeJsonFileIfChanged` | `io/json-store.js` | Prevents backup/permissions drift during split | include |
| Side-effect injection | `main(argv, deps)`, direct `fs/spawn/fetch/Date/process` use | Owner-level deps plus default dep factory | Avoids global patching and over-mocking in split tests | include |
| Accidental import API | `test/cli.test.js` -> `src/cli.js` | Owner-module imports plus CLI-only `main` helper | Prevents the monolith facade from becoming a new barrel module | include |
| Pure planners | ranking, weighted rebalance, capacity | Side-effect-free `pool/*` modules | Makes core allocation behavior independently testable | include |
| CLI output/exit semantics | `main` command branches | Command handlers own emission; domain returns receipts | Prevents domain modules from writing stdout/exitCode | include |
| File-size ceiling | authored runtime/test/script files | Split by responsibility before 500 lines | Keeps the user-requested readability constraint real without repo-shape theater | include as final evidence, not default CI |
| Browser setup | binding/discovery/wizard/launch helpers | `browser/*` modules by responsibility | Prevents prompt flow, discovery, and launch behavior from drifting | include |
| OpenClaw session/model policy | model sync and session reset helpers | `openclaw/models.js` + `sessions.js` | Keeps model enforcement and session reset behavior together | include |
| Watch installers | two 495-line shell scripts | shared `scripts/lib/watch-install.sh` + tiny target config wrappers | Removes duplicated launchd/systemd logic and future line-limit pressure | include |
| README product truth | `README.md` | Update only stale maintainer/source-layout truth | Avoids turning product docs into architecture notes | defer unless touched by implementation |
<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->
> Rule: systematic build, foundational first; split Section 7 into the best sequence of coherent self-contained units, optimizing for phases that are fully understood, credibly testable, compliance-complete, and safe to build on later. If two decompositions are both valid, bias toward more phases than fewer. `Work` explains the unit and is explanatory only for modern docs. `Checklist (must all be done)` is the authoritative must-do list inside the phase. `Exit criteria (all required)` names the exhaustive concrete done conditions the audit must validate. Resolve adjacent-surface dispositions and compatibility posture before writing the checklist. Before a phase is valid, run an obligation sweep and move every required promise from architecture, call-site audit, migration notes, delete lists, verification commitments, docs/comments propagation, approved bridges, and required helper follow-through into `Checklist` or `Exit criteria`. Refactors, consolidations, and shared-path extractions must preserve existing behavior with credible evidence proportional to the risk. For agent-backed systems, prefer prompt, grounding, and native-capability changes before new harnesses or scripts. No fallbacks/runtime shims - the system must work correctly or fail loudly (delete superseded paths). If a bridge is explicitly approved, timebox it and include removal work; otherwise plan either clean cutover or preservation work directly. Prefer programmatic checks per phase; defer manual/UI verification to finalization. Avoid negative-value tests and heuristic gates (deletion checks, visual constants, doc-driven gates, keyword or absence gates, repo-shape policing). Also: document new patterns/gotchas in code comments at the canonical boundary (high leverage, not comment spam).

Implementation frontier starts at Phase 1 and proceeds in order. A later phase can be worked only after all earlier phase exit criteria are true, except for harmless local edits required to keep the repo compiling while finishing the current phase. For every phase, the listed `Verification (required proof)` commands are part of that phase's exit criteria: the phase is incomplete until those commands have run and their outcomes are recorded in the implementation summary or worklog.

## Phase 1 — Core, IO, Dependency, and Test-Helper Foundation

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Added neutral prompt, stream, and watch-option owners in `src/io/prompts.js`, `src/io/streams.js`, and `src/core/watch-options.js` so domain owners no longer import CLI process-boundary helpers.
- Wired `src/cli/deps.js` to provide the default prompt, required-prompt, sleep, stdio, stdin, env, clock, spawn, filesystem, and fetch hooks used by command contexts.
- Cleaned `src/pool/watch.js` to use neutral core/io helpers and injected dependencies instead of importing `src/cli/args.js` or `src/cli/streams.js`.
- Reconciled the approved foundation owner paths: `src/core/labels.js`, `src/core/providers.js`, `src/core/time.js`, `src/core/sanitize.js`, `src/core/shell.js`, `src/io/fetch.js`, `test/helpers/fs.js`, `test/helpers/fixtures.js`, and `test/helpers/cli.js` now exist.
- Moved fetch timeout ownership to `src/io/fetch.js`, routed CLI defaults through `src/cli/deps.js`, and removed test-side `globalThis.fetch` / `Date.now` monkeypatching from the split suite.
- Kept the command test helper write/exit capture dependency-routed instead of patching process globals.
- Made the reopened owner paths real: `src/core/time.js`, `src/core/sanitize.js`, `src/core/shell.js`, `src/core/labels.js`, `src/core/providers.js`, and `src/state/empty.js` now own their foundational implementations instead of re-exporting from higher-level domain files.
- Added the CLI `env` dependency seam in `src/cli/deps.js` and routed it through paths, status, usage probes, Claude/Codex/Pi target status, watch, and rebalance call sites; remaining direct `process.env` reads are isolated to the CLI/process IO boundaries.

* Goal:
  Establish the small shared primitives that every later extraction can depend on without inventing parallel helpers.
* Work:
  This phase extracts the low-level substrate from the top of `src/cli.js` and the top of `test/cli.test.js`: constants, labels, time, sanitization, paths, JSON writes/backups, process/fetch adapters, default dependencies, and shared test helpers. It also makes lint follow the new multi-file reality as soon as new JS modules exist.
* Checklist (must all be done):
  * Create the foundational owner directories under `src/core/`, `src/io/`, `src/cli/`, and `test/helpers/`.
  * Move provider constants, provider normalization, label normalization, agent/home id normalization, timestamp helpers, time parsing helpers, and status sanitization into purpose-built `src/core/*` modules.
  * Move path resolution, home expansion, AIM state path resolution, OpenClaw/Hermes path helpers, JSON read/write helpers, write-with-backup behavior, write-if-changed behavior, text write helpers, and directory mode helpers into `src/io/*` modules.
  * Create `src/cli/deps.js` as the default dependency factory for filesystem, spawn/spawnSync, fetch, env, clock, sleep, stdio/stdin, and prompt hooks.
  * Update `src/cli.js` to import the moved core/io/deps helpers instead of defining duplicate helpers locally.
  * Move CLI capture helpers, temp-home helpers, fixture writers, and shared JSON/file helpers from `test/cli.test.js` into `test/helpers/*`.
  * Update existing tests to use the shared test-helper imports while preserving current assertions.
  * Update `package.json` `lint` so it syntax-checks all authored JS files under `bin/`, `src/`, and `test/` with Node tooling.
  * Keep every new authored JS helper/module in this phase at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add concise comments only at `io/json-store.js` and `cli/deps.js` where they clarify backup/permission ownership or dependency-injection boundaries.
* Exit criteria (all required):
  * `src/cli.js` no longer defines the moved core/io/deps/test-helper responsibilities.
  * Existing CLI behavior and tests still pass through the current command path.
  * `package.json` lint covers newly split JS files.
  * No foundational module or test helper created in this phase exceeds 500 lines.
  * No new dependency, build step, import map, barrel module, runtime shim, or fallback path was introduced.
* Rollback:
  Revert the imports and moved files from this phase as one unit, restoring the original monolith definitions and original test helper definitions.

## Phase 2 — AIM State SSOT and State Tests

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Reconciled the state owner map through concrete source owners: `src/state/empty.js`, `src/state/schema.js`, `src/state/accounts.js`, `src/state/authority-codex.js`, `src/state/authority-anthropic.js`, `src/state/authority-metadata.js`, and `src/state/demand.js`.
- Preserved the extracted state schema, selectors, metadata, demand-ledger, and migration behavior under the split test suite; later proof-surface audit removed unused barrel shims that were not reached by the CLI or tests.

* Goal:
  Make AIM state schema, normalization, loading, selector, metadata, and demand-ledger behavior a single owned contract outside the CLI monolith.
* Work:
  This phase drains state-specific behavior into `src/state/*` and gives state behavior direct tests so command modules can later use state APIs instead of reaching into `src/cli.js`.
* Checklist (must all be done):
  * Move `createEmptyState`, legacy migration, state shape enforcement, normalization from JSON values, state load orchestration, state selectors, target-state selectors, authority import metadata normalization, demand-weight normalization, demand-ledger pruning, and history pruning into `src/state/*`.
  * Wire state loading and write orchestration through `src/io/json-store.js`.
  * Update `src/cli.js` call sites to import state APIs from `src/state/*`.
  * Place state-focused tests in owner-aligned state test files.
  * Preserve current migration persistence, backup behavior, schema version behavior, empty-state defaults, demand-ledger pruning, and selector behavior.
  * Keep all new state modules and state tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run the state-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add one short boundary comment near the state normalization entrypoint explaining that durable AIM state shape is owned by `src/state/*`.
* Exit criteria (all required):
  * `src/cli.js` no longer owns AIM state schema, migration, normalization, selectors, metadata normalization, or demand-ledger pruning.
  * State tests import `src/state/*` APIs directly.
  * Command-level temp-home behavior still passes.
  * No duplicate AIM state writer, duplicate state schema owner, or alternate durable state source exists.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore the state definitions to `src/cli.js`, remove the extracted state modules and direct state tests, and restore prior CLI imports.

## Phase 3 — Credential Identity and Authority Boundaries

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Added `src/credentials/authority.js` as the explicit authority boundary while keeping the provider-specific import/promotion/portable files as purpose-built shards under that owner so no file exceeds the line ceiling.
- Updated source and tests to import authority behavior through owner modules instead of the `src/cli.js` facade.
- Kept credential fingerprint builders in the concrete provider modules where they are used; later proof-surface audit removed the unused fingerprint barrel shim.

* Goal:
  Separate durable credential identity, fingerprints, Anthropic native bundles, and authority import/promote behavior from command dispatch and derived target writers.
* Work:
  This phase creates the credential owner modules needed before target writers and command handlers can be made small.
* Checklist (must all be done):
  * Move Codex credential shape assertions, Codex fingerprint building, Codex authority metadata, Codex import, Codex promotion, and internal Codex promotion payload handling into `src/credentials/codex.js` and `src/credentials/authority.js`.
  * Move Anthropic credential shape assertions, Claude native bundle parsing/building, Anthropic identity matching, Anthropic fingerprints, Anthropic authority metadata, Anthropic import, Anthropic promotion, native bundle import/export/capture transforms, and rotation-preservation helpers into `src/credentials/anthropic.js` and `src/credentials/authority.js`.
  * Preserve dirty authority conflict detection, duplicate identity protection, discard-dirty behavior, portable promotion payload shape, and rotation-sync behavior.
  * Update `src/cli.js` call sites to import credential and authority APIs from owner modules.
  * Move authority and credential tests into `test/authority/*` and credential-focused test files while keeping current assertions.
  * Keep all new credential/authority modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run credential/authority-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add a concise comment at the authority boundary explaining durable AIM credentials versus portable promotion payloads.
* Exit criteria (all required):
  * `src/cli.js` no longer owns credential fingerprints, native bundle transforms, authority metadata, import, promote, or internal promotion application logic.
  * Codex and Claude authority tests import owner modules directly for pure/domain behavior and use CLI helpers only for command-level flows.
  * Dirty import, discard-dirty, duplicate identity, promotion, and rotated Claude credential behavior remain covered and passing.
  * No derived target module becomes a durable credential SSOT.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore credential and authority functions to `src/cli.js`, remove the extracted modules, and return tests to the previous import surface.

## Phase 4 — Browser Binding and Provider Maintenance

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Moved browser, credential, and panel prompt/write defaults to neutral `src/io/prompts.js` and `src/io/streams.js` imports instead of `src/cli/*` utilities.
- Kept browser/provider/panel command-facing APIs injectable and routed CLI-created prompt/write dependencies through command and panel contexts.
- Threaded command/panel-owned `writeImpl` callbacks through provider login, OAuth, and browser-profile seeding flows.
- Verified `src/credentials/*` and `src/browser/*` no longer write directly to `process.stdout` / `console` for user-facing output.
- Reconciled browser and panel owners through concrete modules such as `src/browser/openclaw.js`, `src/browser/chrome.js`, `src/browser/agent-browser.js`, `src/browser/wizard.js`, and `src/panels/*`; later proof-surface audit removed unused discovery and label-panel barrel shims.
- Moved the browser setup wizard implementation into `src/browser/wizard.js` and deleted the panel prompt owner shim, so browser setup choices/discovery prompts now live under the approved browser owner.

* Goal:
  Give browser binding, discovery, launch, setup wizard, provider maintenance, and label-panel interaction their own owner modules before command handling is split.
* Work:
  This phase separates browser facts, provider account maintenance, and the label control panel from CLI command branches while preserving the current prompt and binding behavior.
* Checklist (must all be done):
  * Move browser binding normalization, explicit binding set/show behavior, Chrome Local State inspection, Chrome profile choice labeling, AIM browser profile paths, OpenClaw browser profile discovery, repo `agent-browser.json` discovery, launch helpers, and browser setup wizard helpers into `src/browser/*`.
  * Move provider maintenance attempt/success/failure recording and provider login/update orchestration into credential/browser owner modules with command-facing APIs.
  * Move label-panel state, action construction, action execution, prompt orchestration, and rendering into `src/panels/*`.
  * Update `src/cli.js` browser, login, and label-panel call sites to use the new owner APIs.
  * Move browser, provider-maintenance, and label-panel owner tests into `test/browser/*`, `test/panels/*`, and login/provider test files while preserving current prompt and JSON assertions.
  * Preserve `aim browser show/set`, browser-mode validation, manual-callback handling, agent-browser activation, Chrome profile detection, and fail-loud invalid option behavior.
  * Preserve label-panel menu rendering, prompt flow, selected actions, and action receipts.
  * Keep all new browser/provider/panel modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run browser/provider/login-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * No README update is required in this phase because operator behavior and commands remain unchanged.
* Exit criteria (all required):
  * `src/cli.js` no longer owns browser binding/discovery/launch/wizard logic or provider maintenance rules.
  * `src/cli.js` no longer owns label-panel state/action/render/prompt logic.
  * Browser/provider/panel tests import owner APIs for non-command behavior.
  * Current browser binding, login, label-panel, and invalid-option behavior passes unchanged.
  * No new browser mode, provider mode, or OAuth flow is introduced.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore browser/provider/panel functions to `src/cli.js`, remove the extracted modules, and restore previous imports/tests.

## Phase 5 — Derived Target Adapters

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Reconciled target owner paths so Codex and Claude CLI ownership lives under `src/targets/codex-cli.js` and `src/targets/claude-cli.js`, with Pi/Hermes ownership already under the approved target modules.
- Verified stale owner names such as `codex-activation`, `codex-status`, and `claude-auth` are no longer referenced by source or tests.

* Goal:
  Make Codex CLI, Claude CLI, Pi CLI, and Hermes auth stores explicit derived-output targets, not hidden subroutines inside CLI dispatch.
* Work:
  This phase builds the target-writer boundary that enforces AIM state as the only durable SSOT and prepares later activation/watch command extraction.
* Checklist (must all be done):
  * Move Codex target state/status reads, file-backed auth-store enforcement, Codex auth/config writes, warnings, and target clears into `src/targets/codex-cli.js`.
  * Move Claude target state/status reads, credentials/app-state writes, warnings, live credential preservation, and target clears into `src/targets/claude-cli.js`.
  * Move Pi target state/status reads, Pi auth writes, warnings, and target clears into `src/targets/pi-cli.js`.
  * Move Hermes auth JSON rendering, Hermes profile/home path resolution consumers, Hermes auth writes, Hermes home status reads, and Hermes target warnings/blockers into `src/targets/hermes-auth.js` and `src/targets/hermes-home.js`.
  * Update `src/cli.js` call sites to import target APIs from `src/targets/*`.
  * Move target-writer tests into owner-aligned target test files while preserving temp-home file assertions.
  * Preserve auth-store paths, file permissions, backup/write-if-changed behavior, JSON shapes, blocked status semantics, and warning strings.
  * Keep all new target modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run target-writer tests for Codex, Claude, Pi, and Hermes.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add one concise boundary comment in target modules that derived stores are projections from AIM state and not durable truth.
* Exit criteria (all required):
  * `src/cli.js` no longer owns derived Codex, Claude, Pi, or Hermes target file writes/status logic.
  * Target modules do not read from each other's stores as truth.
  * AIM state remains the only durable credential/account SSOT.
  * Existing temp-home target activation/status tests pass unchanged.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore target writer/status functions to `src/cli.js`, remove extracted target modules, and restore tests to previous imports.

## Phase 6 — Pool Planning, Usage Probes, and Status Presentation

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Reconciled pool owner paths so usage probes live in `src/pool/usage.js` and shared watch orchestration lives in `src/pool/watch.js`.
- Added `test/status/status.test.js` for owner-aligned status redaction coverage and wired status usage probing through the existing CLI dependency seam.
- Routed usage probes through the planned `src/io/fetch.js` seam and passed fetch/time dependencies through CLI command context for status, use, watch, and rebalance paths.
- Added the approved `test/pool/planners.test.js` entrypoint over the split planner cases.
- Moved reusable duration/age/reset formatting into `src/core/time.js` and routed status render/table modules to that owner.
- Kept `src/pool/usage.js` focused on Codex/Claude usage snapshot fetching and data summaries with explicit `fetchJsonWithTimeoutImpl` and `env` dependencies.

* Goal:
  Separate pure pool decisions and status presentation from IO-heavy command orchestration.
* Work:
  This phase extracts the pure planners and the status read/render model so allocation behavior can be tested independently and command handlers stay thin.
* Checklist (must all be done):
  * Move pool ranking, local CLI selection, Codex round-robin selection, weighted OpenClaw planning, weighted Hermes planning, and capacity projection into `src/pool/ranking.js`, `src/pool/weighted-planner.js`, and `src/pool/capacity.js`.
  * Move Codex/Claude usage snapshot fetching, Hermes/OpenClaw demand reads, demand-ledger refresh, and probe adapters into `src/pool/usage.js` with explicit fetch/spawn/sqlite dependencies.
  * Move status view assembly, sanitized JSON view construction, warning construction, reset/expiry formatting, account table data, compact/full renderers, and status text rendering into `src/status/*`.
  * Update `src/cli.js` status, rebalance, watch, and activation call sites to use `src/pool/*` and `src/status/*`.
  * Move planner tests into `test/pool/*` and status tests into `test/status/*` while preserving current assertions.
  * Preserve JSON redaction, warning content, ranking order, weighted assignment behavior, capacity projection, usage blocker receipts, and text/compact status output.
  * Keep all new pool/status modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run pool planner tests.
  * Run status tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add concise comments only for weighted-planner invariants that are not obvious from tests.
* Exit criteria (all required):
  * Pure planner modules do not import filesystem, process, fetch, timers, stdio, or command modules.
  * Status modules own status view/rendering and redaction; command modules own only emission.
  * Planner/status tests import owner modules directly.
  * Current status and pool-planning behavior passes unchanged.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore planner/status functions to `src/cli.js`, remove extracted modules, and restore previous tests/imports.

## Phase 7 — OpenClaw Domain Modules

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Added `src/openclaw/config.js` as the approved OpenClaw config IO owner and moved config-list/binding/model-sync application helpers behind that boundary.
- Kept model and session planners in their existing purpose-built OpenClaw modules under the 500-line ceiling.

* Goal:
  Isolate OpenClaw config, model enforcement, session reset, auth-store apply, and rebalance orchestration behind OpenClaw owners.
* Work:
  This phase uses the earlier state, credentials, target, and pool modules to extract OpenClaw behavior without changing assignment or session semantics.
* Checklist (must all be done):
  * Move OpenClaw config reads/writes, configured agent discovery, binding reads, model sync operations, and model sync application into `src/openclaw/config.js` and `src/openclaw/models.js`.
  * Move session model-ref parsing, session reset planning, gateway reset calls, disk reset scanning, and disk reset application into `src/openclaw/sessions.js`.
  * Move OpenClaw auth-store projection from AIM state into `src/openclaw/apply.js`.
  * Move OpenClaw rebalance orchestration into `src/openclaw/rebalance.js`, using `src/pool/*` for pure planning and `src/targets/*` only for derived target boundaries.
  * Update `src/cli.js` apply, sync, status, and rebalance call sites to use `src/openclaw/*`.
  * Move OpenClaw apply/rebalance/model/session tests into `test/openclaw/*`.
  * Preserve model enforcement, managed/stale pin behavior, gateway restart behavior, disk reset behavior, auth profile projection, warnings, blocked receipts, and nonzero semantics.
  * Keep all new OpenClaw modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run OpenClaw-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Add concise comments at the OpenClaw session/model boundary when the reset logic depends on non-obvious external OpenClaw store shapes.
* Exit criteria (all required):
  * `src/cli.js` no longer owns OpenClaw config/model/session/apply/rebalance logic.
  * OpenClaw tests import owner modules for pure/domain behavior.
  * OpenClaw auth-store projection remains derived from AIM state.
  * Current OpenClaw apply, sync, model/session, and rebalance tests pass unchanged.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore OpenClaw functions to `src/cli.js`, remove `src/openclaw/*`, and restore previous tests/imports.

## Phase 8 — Hermes Fleet and Watch Modules

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Moved watch interval and threshold normalization into `src/core/watch-options.js`, and moved default sleep to `src/io/streams.js`, so the shared watch owner no longer imports CLI argument parsing or CLI stream modules.
- Routed Hermes watch calls through command-provided env, normalized threshold, and sleep dependencies while preserving existing watch receipt and status behavior.
- Consolidated Codex and Hermes watch orchestration into the approved shared `src/pool/watch.js` owner.
- Verified Hermes auth/rebalance/watch coverage passes through the split test suite and representative target-family test run.

* Goal:
  Isolate Hermes home discovery, auth projection, rebalance, and watch behavior without changing current fleet receipts.
* Work:
  This phase extracts Hermes-specific orchestration after the shared target and pool boundaries exist.
* Checklist (must all be done):
  * Move Hermes profile discovery, home discovery, state DB path handling, Hermes home status reads, Hermes assignment construction, Hermes home blockers, and Hermes warnings into `src/targets/hermes-home.js`.
  * Move Hermes auth write and home sync behavior to the target/Hermes owner modules.
  * Move Hermes rebalance orchestration into `src/pool/hermes-rebalance.js`, using `src/pool/weighted-planner.js` and `src/targets/hermes-*`.
  * Move Hermes watch once/loop behavior into `src/pool/watch.js` with injected probe/sleep dependencies.
  * Update `src/cli.js` Hermes command call sites to use the new owner APIs.
  * Move Hermes auth/rebalance/watch tests into `test/hermes/*`.
  * Preserve Hermes JSON receipt shape, unreadable/missing-auth blockers, threshold behavior, nonzero blocked receipts, assignment status, demand ledgers, and watch loop iteration behavior.
  * Keep all new Hermes/watch modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run Hermes-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * No README update is required in this phase because Hermes command surfaces remain unchanged.
* Exit criteria (all required):
  * `src/cli.js` no longer owns Hermes home discovery/status/auth/rebalance/watch logic.
  * `src/pool/hermes-rebalance.js` owns Hermes rebalance orchestration.
  * Hermes watch logic accepts injected time/sleep/probe dependencies and does not rely on global timers in tests.
  * Hermes target stores remain derived outputs from AIM state.
  * Current Hermes auth, rebalance, watch, and status behavior passes unchanged.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore Hermes functions to `src/cli.js`, remove extracted Hermes/watch modules, and restore previous tests/imports.

## Phase 9 — Local CLI Activation and Claude Native Flows

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Routed Codex watch helpers through the cleaned shared `src/pool/watch.js` owner, with watch option normalization in `src/core/watch-options.js` and default sleep supplied from neutral IO/dependency wiring rather than CLI parsing or stream utilities.
- Reconciled activation ownership with `src/targets/codex-cli.js`, `src/targets/claude-cli.js`, `src/targets/pi-cli.js`, and shared watch orchestration in `src/pool/watch.js`.
- Verified representative Codex, Claude, and Pi target-family tests pass.

* Goal:
  Extract Codex, Claude, and Pi activation plus Claude native capture/import/export flows from CLI dispatch into domain owners.
* Work:
  This phase drains the remaining local target activation workflows after credential, target, usage, and pool modules are available.
* Checklist (must all be done):
  * Move Codex pool activation, Codex label selection, Codex warning/blocker classification, and Codex watch helpers into `src/targets/codex-cli.js` and `src/pool/watch.js`.
  * Move Claude pool activation, explicit Claude label activation, Claude native capture/import/export command-domain helpers, Claude activation error classification, and rotated live token preservation into `src/credentials/anthropic.js`, `src/targets/claude-cli.js`, and `src/pool/watch.js`.
  * Move Pi pool activation and Pi warning/blocker behavior into `src/targets/pi-cli.js` and `src/pool/watch.js`.
  * Update `src/cli.js` Codex, Claude, and Pi command branches to call owner APIs.
  * Move Codex use/watch, Claude native/use/sync, and Pi use tests into owner-aligned test files.
  * Preserve removed-command fail-loud behavior for label-first Codex/Pi forms, blocked/nonzero receipts, JSON shapes, round-robin behavior, usage-threshold behavior, and temp-home target file effects.
  * Keep all new activation/native-flow modules and tests at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run Codex-focused tests.
  * Run Claude-focused tests.
  * Run Pi-focused tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * No README update is required in this phase because external command behavior remains unchanged.
* Exit criteria (all required):
  * `src/cli.js` no longer owns Codex, Claude, or Pi activation/native-flow domain logic.
  * Codex, Claude, and Pi tests import owner modules for non-command behavior.
  * Current Codex, Claude, and Pi use/watch/native behavior passes unchanged.
  * No new command, provider, mode, auth policy, or telemetry surface is introduced.
  * Every touched authored file outside the legacy monolith remains at or below 500 lines.
* Rollback:
  Restore activation/native-flow functions to `src/cli.js`, remove extracted modules, and restore previous tests/imports.

## Phase 10 — CLI Commands, Main Wiring, and Thin Facade

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Deleted the old CLI prompt/stream utility modules and moved reusable prompt, stream, and sleep primitives to neutral `src/io/*` owners.
- Moved reusable watch option normalization out of `src/cli/args.js` into `src/core/watch-options.js`, leaving command handlers to parse CLI intent and pass normalized values down.
- Verified non-CLI owner imports no longer reach into `src/cli/*` for prompts, streams, sleep, or watch argument normalization.
- Kept `src/cli.js` as a one-line facade over `src/cli/main.js`; command modules own dispatch and output emission.
- Updated status output to use the command-provided `stdout` boundary and verified provider/browser domain modules no longer bypass command/presentation callbacks.
- Kept OpenClaw command behavior in the concrete `apply` and `rebalance` command modules; later proof-surface audit removed the unused OpenClaw command barrel shim.
- Routed help output and blocked exit-code behavior through injected `stdout` / `setExitCode` boundaries; default process prompt/stream access is isolated to neutral IO primitives and CLI dependency creation, while command handlers still own emission.

* Goal:
  Turn `src/cli.js` from the behavior monolith into the chosen thin facade over `src/cli/main.js`.
* Work:
  This phase performs the clean internal cutover for command dispatch after domain owners exist.
* Checklist (must all be done):
  * Move argument parsing and option validation into `src/cli/args.js`.
  * Move help text construction into `src/cli/help.js`.
  * Create `src/cli/main.js` as the canonical `main(argv, deps = createDefaultDeps())` implementation.
  * Create command modules under `src/cli/commands/*` for status, login/label shorthand, browser, internal, removed commands, apply, auth, sync, promote, rebalance, Codex, Hermes, Claude, and Pi.
  * Use a command table for explicit dispatch in `src/cli/main.js`.
  * Ensure command handlers own output emission, JSON sanitization before output, and blocked exit-code semantics.
  * Ensure domain modules return receipts/data and do not write stdout or mutate `process.exitCode`.
  * Keep `bin/aimgr.js` behavior stable through `../src/cli.js`.
  * Replace `src/cli.js` with an under-500-line facade that re-exports `main` from `src/cli/main.js` and contains no domain behavior.
  * Delete migrated command/domain definitions from the old monolith instead of leaving parallel paths.
  * Keep all CLI command modules and command tests touched in this phase at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run CLI command integration tests.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * Review README developer-facing source layout and script references, and update stale references in this phase.
* Exit criteria (all required):
  * `src/cli.js` is under 500 lines and contains no domain rules.
  * `bin/aimgr.js` still imports `../src/cli.js` and both `aim` and `aimgr` resolve to the same behavior.
  * Command modules do not contain provider/token/state-normalization rules.
  * Domain modules do not write stdout or mutate `process.exitCode`.
  * All old monolithic command/domain definitions migrated in earlier phases are deleted from `src/cli.js`.
  * Current command behavior, JSON output, blocked/nonzero semantics, and fail-loud removed-command behavior pass unchanged.
* Rollback:
  Restore `src/cli.js` as the direct command owner, remove `src/cli/main.js` and command modules, and restore prior bin/test imports.

## Phase 11 — Test Suite Split and Accidental API Removal

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Added the approved `test/status/status.test.js` and `test/cli/removed-commands.test.js` placements.
- Confirmed `test/cli.test.js` is deleted, split tests pass, and all test files/helpers are under the 500-line ceiling.
- Added the approved owner-aligned test entrypoints for browser, panels, OpenClaw, authority, Hermes, Codex, Claude, Pi, and pool planners while keeping numbered `.cases.js` shards as small imported behavior files.
- Updated CLI integration helpers to capture stdout and exit code through injected dependencies, including partial TTY stdout fakes, without patching global process state.

* Goal:
  Retire the 10,252-line test monolith and the accidental `src/cli.js` import API.
* Work:
  This phase completes the test-side cutover after source owners and CLI command modules exist.
* Checklist (must all be done):
  * Split `test/cli.test.js` into owner-aligned behavior test files matching Section 5 target areas: status, browser, panels, OpenClaw, authority, Hermes, Codex, Claude, Pi, pool planners, CLI removed commands, and shared helpers.
  * Keep label panel state/render/action tests in `test/panels/*` against the `src/panels/*` owner modules created in Phase 4.
  * Replace broad imports from `../src/cli.js` with direct imports from owner modules.
  * Keep only CLI integration helpers importing `main` through the thin `src/cli.js` facade.
  * Delete duplicate fixture/helper definitions left behind by the split.
  * Preserve all current behavior assertions; do not drop, skip, weaken, or convert tests into structure-only checks.
  * Keep every authored test file and helper under `test/` at or below 500 lines.
* Verification (required proof):
  * Run `npm run lint`.
  * Run `npm test`.
* Docs/comments (propagation; only if needed):
  * No README update is required in this phase because user/operator behavior is unchanged.
* Exit criteria (all required):
  * `test/cli.test.js` is deleted; CLI integration tests live in owner-aligned files under `test/cli/`.
  * No test file imports many unrelated internals from `../src/cli.js`.
  * Shared test helpers are purpose-built and under 500 lines each.
  * The split suite still covers the existing command families and pure planner/domain behavior.
  * No behavior assertion was intentionally removed without a user-approved Decision Log entry.
* Rollback:
  Restore the prior monolithic test file and imports, remove split test files, and restore helper definitions.

## Phase 12 — Watch Installer Shell Library

Status: COMPLETE (fresh audit 2026-04-20)

* Goal:
  Remove duplicated scheduler-installer shell truth while preserving the Codex and Hermes watch installer surfaces.
* Work:
  This phase extracts the two near-identical 495-line shell installers into one shared shell library and small target wrappers.
* Checklist (must all be done):
  * Create `scripts/lib/watch-install.sh` for shared argument parsing, usage rendering, OS detection, launchd rendering, systemd service/timer rendering, install, status, uninstall, print-only, path resolution, user/home/workdir handling, and error behavior.
  * Rewrite `scripts/install-codex-watch.sh` as a small config wrapper that sets Codex service labels, command target, descriptions, log names, and default values before sourcing the shared library.
  * Rewrite `scripts/install-hermes-watch.sh` as a small config wrapper that sets Hermes service labels, command target, descriptions, log names, and default values before sourcing the shared library.
  * Preserve `--print-only`, `--status`, `--uninstall`, `--user`, `--interval-seconds`, `--workspace`, `--home`, generated launchd plist content, generated systemd service/timer content, and package script entrypoints.
  * Keep `scripts/install-local-bin.sh` unchanged.
  * Keep every authored shell file at or below 500 lines.
* Verification (required proof):
  * Run `bash scripts/install-codex-watch.sh --print-only`.
  * Run `bash scripts/install-hermes-watch.sh --print-only`.
  * Run read-only status checks through `npm run codex-watch:status` and `npm run hermes-watch:status`, record each output and exit code, and treat the current not-installed nonzero result as acceptable proof of the not-installed path.
* Docs/comments (propagation; only if needed):
  * Update README only if any maintainer-facing script invocation text changes; package script names must stay unchanged.
* Exit criteria (all required):
  * Both watch installer wrappers are small target config files.
  * Shared launchd/systemd install/status/uninstall logic exists only in `scripts/lib/watch-install.sh`.
  * Codex and Hermes rendered service definitions preserve their target command, labels, descriptions, paths, and log names.
  * Existing npm watch install/status/uninstall script names still work.
  * Both `--print-only` commands and both npm status checks were run read-only, with outputs and exit codes recorded; current not-installed nonzero status is accepted only as proof of the not-installed status path.
  * No service is installed, uninstalled, loaded, or stopped by the verification commands.
* Rollback:
  Restore the two original full installer scripts and remove `scripts/lib/watch-install.sh`.

## Phase 13 — Final Proof, Docs Reality Sync, and Line-Count Closure

Status: COMPLETE (fresh audit 2026-04-20; no phase-local code blocker found)
Completed work:
- Reran final proof after the watch/prompt/stdio/sleep dependency-direction cleanup: `npm run lint` passed; `npm test` passed with 136 tests; `node bin/aimgr.js --help` passed; injected-stdout help captured 4594 bytes; `node bin/aimgr.js status --json --home <temp>` produced the expected temp state path; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; final line-count audit passed with the largest in-scope file at 491 lines; `package-lock.json` is unchanged; non-CLI owner imports no longer reach into `src/cli/*`.
- Reran final proof after owner-map, test-placement, dependency, and output-boundary cleanup: `npm run lint` passed; `npm test` passed with 136 tests; representative browser/panel/OpenClaw/Hermes target-family tests passed with 53 tests; `node bin/aimgr.js --help` passed; an injected-stdout help probe captured 4594 bytes; `node bin/aimgr.js status --json --home <temp>` produced the expected temp state path; final line-count audit passed; `package-lock.json` is unchanged.
- Reran watch installer proof: both `--print-only` commands passed, `npm run codex-watch:status` returned 0 for the installed/not-running service, and `npm run hermes-watch:status` returned 1 for the accepted not-installed path.
- Reran final proof after the reopened owner-boundary/env/status cleanup: `npm run lint` passed; `npm test` passed with 136 tests; `node bin/aimgr.js --help` passed; injected-stdout help captured 4594 bytes; `node bin/aimgr.js status --json --home <temp>` produced the expected temp state path; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; final line-count audit passed with the largest in-scope file at 491 lines; `package-lock.json` is unchanged.

* Goal:
  Prove the refactor satisfies the behavior-preservation and small-module requirements, then update only live docs that would otherwise be stale.
* Work:
  This phase performs the final audit-style closeout after all source/test/script migrations are complete.
* Checklist (must all be done):
  * Run `npm run lint`.
  * Run `npm test`.
  * Run representative CLI smoke checks through `bin/aimgr.js` for help and `status --json --home <temp>`.
  * Run representative temp-home smoke checks for the major target families touched by the refactor: Codex use/watch once, Hermes auth/rebalance/watch once, OpenClaw apply/rebalance, Claude native/use, and Pi use, using existing safe fixtures or temp-home setup only.
  * Run a final line-count audit over authored files under `bin/`, `src/`, `scripts/`, and `test/`, excluding generated/external dependency files.
  * Split or further extract every authored file above 500 lines.
  * Confirm `src/cli.js` is an under-500-line facade and `test/cli.test.js` no longer exists as a monolith.
  * Confirm `package-lock.json` is unchanged.
  * Update README only for maintainer-facing source layout, lint/test instructions, or script invocation truth that changed during implementation.
  * Remove stale comments left by the monolith extraction and keep only high-leverage comments at current SSOT boundaries.
* Verification (required proof):
  * `npm run lint` passes.
  * `npm test` passes.
  * CLI smoke checks pass against temporary homes.
  * Final line-count audit reports every authored file under `bin/`, `src/`, `scripts/`, and `test/` at or below 500 lines.
* Docs/comments (propagation; only if needed):
  * README and code comments are updated only where live maintainer truth changed; operator behavior docs remain behavior-focused.
* Exit criteria (all required):
  * All authored runtime, test, and script files in scope are at or below 500 lines with no unapproved exception.
  * External command names, arguments, JSON shapes, state semantics, auth-store paths, backup behavior, permissions-sensitive behavior, blocked/nonzero behavior, and fail-loud errors remain preserved.
  * No runtime shim, duplicate writer, duplicate durable SSOT, fallback path, broad barrel module, or accidental `src/cli.js` API remains.
  * `npm run lint`, `npm test`, final line-count audit, and representative CLI smoke checks have been run and recorded in the final implementation summary.
  * README and touched comments reflect current source truth without becoming an architecture journal.
* Rollback:
  Revert the final proof/doc/comment edits while preserving already-completed behavior-preserving code phases; if final proof exposes a behavior regression, reopen the earliest phase that owns the failing behavior.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; non-blocking)

Avoid verification bureaucracy. Prefer existing credible signals that genuinely prove the claim. For this refactor, behavior preservation matters more than proving that deleted code stayed deleted. Do not add custom harnesses, framework migrations, visual constants, doc inventories, keyword greps, or repo-shape CI gates unless later plan evidence shows they are the cheapest real guardrail.

## 8.1 Unit tests (contracts)

- Keep Node's native `node:test` runner unless external research and repo evidence justify otherwise.
- As modules are extracted, move tests to the matching behavior owner and keep pure planners covered with direct unit tests.
- Use explicit dependency injection for file/process/time/env boundaries instead of global monkeypatching where possible.

## 8.2 Integration tests (flows)

- Preserve command-level tests that exercise temp homes and real file outputs for state, auth-store projection, rebalance, sync, and watch behaviors.
- Keep JSON output and failure/blocked semantics covered where they are current public contracts.
- Run `npm test` at phase boundaries that move meaningful behavior.

## 8.3 E2E / device tests (realistic)

- No device or browser UI automation is required by default.
- Use representative CLI smoke checks after the full cutover: help, status with a temp home, and one temp-home flow per touched target family where current tests make that practical.
- Run a final line-count audit as acceptance evidence for the user-requested module ceiling, not as a substitute for behavior tests.

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

This is a private local CLI refactor, so rollout should be a behavior-preserving repo change rather than a staged production deployment. The implementation should proceed by small internal cutovers with tests after each coherent extraction, then one final full-suite verification.

## 9.2 Telemetry changes

No telemetry changes are planned. Existing status and receipt output should remain stable.

## 9.3 Operational runbook

- Before implementation, confirm the North Star, complete research/deep-dive/phase-plan, complete consistency-pass with `Decision: proceed to implement? yes`, and resolve any consistency-pass findings.
- During implementation, avoid touching real operator homes except through existing temp-home tests or explicit manual smoke commands.
- After implementation, run `npm run lint`, `npm test`, final line-count audit, and targeted CLI smoke checks.
- If a behavior-preserving extraction exposes a current ambiguous contract, stop and record the decision instead of silently changing behavior.

<!-- arch_skill:block:consistency_pass:start -->
## Consistency Pass
- Reviewers: explorer 1, explorer 2, self-integrator
- Scope checked:
  - Frontmatter, TL;DR, North Star, design considerations, problem statement, phase plan, verification, rollout, Decision Log, and helper-block drift.
  - Research grounding, current architecture, target architecture, call-site audit, canonical owner paths, adjacent surfaces, required deletes, and phase obligations.
- Findings summary:
  - TL;DR line-count scope was narrower than Sections 0, 6, and 7.
  - External research bookkeeping said `not started` even though Section 3 already contained source-backed external research used to lock the target architecture.
  - Label-panel source ownership was stranded after the CLI facade cutover.
  - Hermes rebalance lacked a canonical owner path.
  - Required verification commands needed to be explicit phase-exit obligations.
  - Section 0 shell-installer scope and Section 9 runbook lagged behind later plan decisions.
- Integrated repairs:
  - Expanded TL;DR and North Star line-count scope to authored runtime, script, and test files under `bin/`, `src/`, `scripts/`, and `test/`.
  - Marked `external_research_grounding` done with the source-backed Section 3 research pass and updated Section 0 plus Section 3.3 to make that truth explicit.
  - Moved label-panel source extraction into Phase 4 and left Phase 11 as test-suite/API cleanup.
  - Added `src/pool/hermes-rebalance.js` as the canonical Hermes rebalance owner and propagated it through Sections 5, 6, and 7.
  - Made every phase's verification commands part of phase exit criteria and strengthened Phase 12 status/print-only proof requirements.
  - Updated shell-installer convergence scope and the pre-implementation consistency-pass runbook gate.
- Remaining inconsistencies:
  - none
- Unresolved decisions:
  - none
- Unauthorized scope cuts:
  - none
- Decision-complete:
  - yes
- Decision: proceed to implement? yes
<!-- arch_skill:block:consistency_pass:end -->

# 10) Decision Log (append-only)

## 2026-04-20 - Bootstrap full-arch plan for small-module restructure

Context

The user asked for a whole-project restructure into small, elegant, purpose-built modules with no single module above 500 lines, grounded in external best practices.

Options

- Start coding immediately from the monolith.
- Create a canonical architecture artifact first, confirm the North Star, then research and phase the work.

Decision

Create this full-arch plan as the single source of truth and stop for North Star confirmation before deeper planning or code edits.

Consequences

Implementation is intentionally blocked until the user confirms or edits TL;DR plus Section 0. External research is required before locking target architecture.

Follow-ups

After confirmation, run `$arch-step research docs/AIMGR_SMALL_PURPOSE_BUILT_MODULE_RESTRUCTURE_2026-04-20.md`, then `$arch-step deep-dive`, `$arch-step external-research`, another `$arch-step deep-dive`, and `$arch-step phase-plan`.

## 2026-04-20 - North Star confirmed

Context

The initial TL;DR and Section 0 North Star were drafted from the user's request to restructure the whole project into small, elegant, purpose-built modules with no authored module above 500 lines, externally researched best practices, and behavior-preserving implementation discipline.

Options

- Keep the plan in draft and ask for edits.
- Mark the North Star active and proceed to research on the next explicit command.

Decision

The user confirmed the drafted North Star with `yes`, so the plan status is now `active`.

Consequences

Later `arch-step` commands should treat this doc as the default canonical full-arch artifact for the small-module restructure. The workflow remains gated at the post-confirmation boundary; the next explicit command should be `research`.

Follow-ups

Run `$arch-step research docs/AIMGR_SMALL_PURPOSE_BUILT_MODULE_RESTRUCTURE_2026-04-20.md`.

## 2026-04-20 - Intent-derived: keep internal ESM imports simple by default

Blocker: The draft research section listed whether `package.json` should expose internal package imports for repo-local modules or keep purely relative ESM imports as a decision gap.

Consulted: Section 0 compatibility posture, Section 0 out-of-scope build/package migration constraints, TL;DR non-negotiables, and external Node package/module documentation.

Intent says: This is a private Node ESM CLI refactor with no package-public API goal, no build-step migration, no framework churn, and a strong bias toward behavior-preserving simplicity.

Decision: Use explicit relative `.js` ESM imports for internal modules by default. Do not add `package.json` `exports` / `imports` for internal structure unless the deep dive finds a concrete repo-local boundary problem that relative imports fail to solve.

Consequences: `package.json` remains focused on bin/script/runtime contracts during planning. Any later package-import map proposal must justify itself against this default.

## 2026-04-20 - Auto-plan armed and research pass completed

Context

The user invoked `$arch-step auto-plan` after confirming the North Star. The Stop hook was verified for Codex, and the active session id was available as `019dab99-6271-7ef2-af51-b5fdf50adc22`.

Options

- Fail loud if runtime continuation support was unavailable.
- Arm the session-scoped controller state and run only the parent-allowed `research` stage.

Decision

Armed `.codex/auto-plan-state.019dab99-6271-7ef2-af51-b5fdf50adc22.json` for this plan and completed the research pass in Section 3.

Consequences

The parent `auto-plan` pass must now stop naturally. The installed Stop hook owns continuation to deep-dive pass 1, deep-dive pass 2, phase-plan, and consistency-pass.

Follow-ups

Let the Stop hook continue with `$arch-step deep-dive docs/AIMGR_SMALL_PURPOSE_BUILT_MODULE_RESTRUCTURE_2026-04-20.md`.

## 2026-04-20 - Deep-dive pass 1 target architecture set

Context

Deep-dive pass 1 mapped the current monolith, command dispatch, side-effect surfaces, exported accidental test API, large test file, package/bin contracts, and duplicated watch installer scripts.

Options

- Keep the target architecture generic until phase planning.
- Resolve a concrete owner map now so external research and deep-dive pass 2 can critique a real design.

Decision

Set the pass-1 target architecture around a thin `main(argv, deps)` entrypoint, owner modules for state, IO, credentials, browser, OpenClaw, target writers, pool planning/watch behavior, status/presentation, panels, and command handlers, plus split behavior tests and a shared shell watch-installer library.

Consequences

The plan now treats `src/cli.js` as a temporary monolith to drain, not a domain owner. The duplicated Codex/Hermes watch installers are included in convergence scope because they are near-identical and already sit at the 500-line ceiling. Deep-dive pass 2 may refine this map after external research, but it should preserve the Section 0 constraints unless a new Decision Log entry records a reasoned change.

Follow-ups

Let the Stop hook continue with deep-dive pass 2 under the auto-plan controller.

## 2026-04-20 - Deep-dive pass 2 hardened migration contracts

Context

Deep-dive pass 2 rechecked the monolith's function ranges, the test file's dependency on `../src/cli.js`, the current stdout/exit-code and time patching helpers, package script behavior, and the Codex/Hermes watch installer duplication.

Options

- Leave the pass-1 owner map as a broad folder taxonomy and let implementation invent contracts.
- Lock concrete migration contracts now so `phase-plan` can sequence real cutovers without adding shims or new tooling.

Decision

Keep the pass-1 owner map, but harden it with binding contracts: `src/cli.js` should become an under-500-line facade over `src/cli/main.js`; owner modules should use explicit relative `.js` imports; command handlers receive a dependency-bearing context and own stdout/exit semantics; domain modules return receipts/data only; tests import owner modules directly except for CLI integration helpers; and the watch installers converge through `scripts/lib/watch-install.sh`.

Consequences

Phase planning must treat the accidental `src/cli.js` test API as a migration target, not a compatibility promise. Implementation should shrink `src/cli.js` monotonically, avoid barrel modules/import maps unless a recorded boundary problem appears, and prove the 500-line ceiling with final evidence rather than defaulting to brittle shape-policing CI.

Follow-ups

Let the Stop hook continue with `$arch-step phase-plan docs/AIMGR_SMALL_PURPOSE_BUILT_MODULE_RESTRUCTURE_2026-04-20.md` under the armed auto-plan state.

## 2026-04-20 - Phase plan locked for implementation sequencing

Context

The target architecture and call-site audit were strong enough to convert into the authoritative Section 7 checklist. The plan needed an execution order that preserves behavior, prevents a new facade or test-helper monolith, and carries every required delete, test split, docs/comment propagation, shell extraction, and line-count proof into phase exit criteria.

Options

- Use a small number of broad phases and let implementation discover the detailed ordering.
- Use granular foundational-first phases that make ownership boundaries, proof, cleanup, and line-count obligations auditable before implementation begins.

Decision

Use thirteen phases: foundation, state SSOT, credentials/authority, browser/provider maintenance, target adapters, pool/status, OpenClaw, Hermes, local activation/native flows, CLI command/facade cutover, test-suite split, watch-installer shell library, and final proof/docs/line-count closure.

Consequences

Implementation must start at Phase 1 and proceed in order. Each phase is incomplete until every checklist item and every exit criterion in that phase is satisfied. Later implementation may not treat `Work`, migration prose, or verification notes as substitutes for the authoritative checklist and exit criteria.

Follow-ups

Let the Stop hook continue with the auto-plan consistency pass for this document.

## 2026-04-20 - Consistency pass repaired readiness drift

Context

The required auto-plan consistency pass ran with two cold-reader explorer reviews plus parent integration. Both cold readers found real cross-section drift before implementation: line-count scope was narrower in the TL;DR than in the body, external research bookkeeping contradicted the source-backed research already used, label-panel ownership was stranded after the CLI cutover, Hermes rebalance lacked a named owner, verification proof was not explicitly part of phase exit, and the rollout runbook omitted the consistency gate.

Options

- Leave these as consistency-pass notes and proceed.
- Repair the main artifact so Section 7 can be implemented without hidden decisions or orphan obligations.

Decision

Repair the main artifact in place. Treat the Section 3 source-backed research pass as satisfying the external research requirement under auto-plan; keep `src/cli.js` as the thin facade path; move label-panel source ownership into Phase 4; name `src/pool/hermes-rebalance.js` as the Hermes rebalance owner; make phase verification commands phase-exit obligations; and record `Decision: proceed to implement? yes` in the consistency-pass block.

Consequences

The plan is now decision-complete for implementation. Implementation must start at Phase 1 and cannot complete any phase until its checklist, verification, and exit criteria are satisfied and recorded.

Follow-ups

The next command should be `$arch-step implement-loop docs/AIMGR_SMALL_PURPOSE_BUILT_MODULE_RESTRUCTURE_2026-04-20.md` when the user wants automated implementation to begin.

## 2026-04-20 - Implementation pass reconciled audit blockers

Context

The fresh implement-loop audit reopened Phases 3-11 and 13 for owner-map deviations, provider/browser stdout boundary violations, missing approved status/CLI test placements, and stale final proof.

Options

- Reopen planning to approve alternate filenames and scattered test placement.
- Reconcile the implementation to the already approved Section 5 owner map and rerun the proof set.

Decision

Reconciled the code to the approved map: added the explicit `credentials/authority.js`, `targets/codex-cli.js`, `targets/claude-cli.js`, `pool/usage.js`, `pool/watch.js`, `openclaw/config.js`, `test/status/status.test.js`, and `test/cli/removed-commands.test.js` paths; moved provider/browser user-facing writes behind command/panel-owned callbacks; kept `src/cli.js` as the one-line facade.

Consequences

The implementation side now has proof for the reopened frontier: `npm run lint` passed, `npm test` passed with 136 tests, representative target-family tests passed, CLI help/status smokes passed, watch installer print/status checks ran, the line-count audit passed, stale owner-name references are gone, provider/browser direct stdout writes are gone, and `package-lock.json` is unchanged. The next fresh implementation audit remains authoritative for the final code verdict.

## 2026-04-20 - Implementation pass resolved reopened owner-map and boundary gaps

Context

The next fresh implement-loop audit reopened Phases 1, 2, 3, 4, 6, 10, 11, and 13. It found that the previous proof was strong but still non-terminal because approved owner paths were missing, split tests did not expose the approved owner-aligned entrypoints, usage probes still leaked global fetch/time behavior, help and command failures bypassed injected output/exit boundaries, and final proof had to be rerun after those fixes.

Options

- Reopen planning to bless alternate paths.
- Complete the approved owner map and dependency/output seams without changing product behavior.

Decision

Completed the approved map and boundary cleanup in code: added the missing source owner files, approved test/helper entrypoints, fetch/time seams, injected stdout/exit paths, and command-to-domain dependency routing for status, use, watch, OpenClaw rebalance, and Hermes rebalance.

Consequences

Section 7 now records the reopened phases as implementation-complete pending the next fresh audit. Proof rerun after the fixes: `npm run lint` passed; `npm test` passed with 136 tests; representative browser/panel/OpenClaw/Hermes tests passed with 53 tests; `node bin/aimgr.js --help` passed; an injected-stdout help probe captured output through the fake stream; `node bin/aimgr.js status --json --home <temp>` passed; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0 for the installed/not-running service; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; no in-scope authored file exceeds 500 lines; `package-lock.json` is unchanged. The authoritative Implementation Audit block remains owned by the fresh child audit.

## 2026-04-20 - Implementation pass resolved final owner-boundary and env/status audit gaps

Context

The fresh implement-loop audit reopened Phases 1, 4, 6, and 13. It found that several approved owner files were still veneers or had inverted imports, browser wizard behavior lived behind a panel prompt shim, env reads bypassed the dependency seam in path/usage/Claude status paths, and final proof had to run after those boundary fixes.

Options

- Reopen planning to approve the veneer/facade shape.
- Complete the approved owner-map and dependency seams in code without changing product behavior.

Decision

Completed the approved boundary cleanup in code: moved core time/sanitize/shell, label/provider, empty-state, and browser wizard implementations into their owner modules; deleted the stale status/panel prompt shims; routed `env` through CLI deps into paths, usage probes, status view, target status, watch, and rebalance flows; moved reusable status time formatting out of pool usage and into `core/time.js`.

Consequences

Section 7 now records Phases 1, 4, 6, and 13 as implementation-complete pending the next fresh audit. Proof rerun after these fixes: `npm run lint` passed; `npm test` passed with 136 tests; `node bin/aimgr.js --help` passed; an injected-stdout help probe captured 4594 bytes; `node bin/aimgr.js status --json --home <temp>` passed; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; no in-scope authored file exceeds 500 lines, with the largest at 491 lines; `package-lock.json` is unchanged. The authoritative Implementation Audit block remains owned by the fresh child audit.

## 2026-04-20 - Implementation pass resolved dependency-direction audit gaps

Context

The fresh implement-loop audit reopened Phases 1, 4, 8, 9, 10, and 13. It found that the proof set was strong but still non-terminal because `src/pool/watch.js` imported CLI argument and stream utilities, while browser, credential, and panel owners imported CLI prompt/stdio utilities as their default interaction path.

Options

- Reopen planning to approve CLI utility imports from owner modules.
- Complete the approved command-to-domain dependency direction by moving reusable primitives to neutral owners and rerunning proof.

Decision

Completed the dependency-direction cleanup in code: moved prompt, required-prompt, menu-prompt, stream, stdin-read, and sleep primitives to `src/io/prompts.js` and `src/io/streams.js`; moved watch interval/threshold normalization to `src/core/watch-options.js`; wired default prompt/sleep hooks through `src/cli/deps.js`; updated browser, credential, panel, Codex, Hermes, and watch owners to consume neutral primitives or injected command deps; and deleted the obsolete `src/cli/prompts.js` and `src/cli/streams.js` modules.

Consequences

Section 7 now records Phases 1, 4, 8, 9, 10, and 13 as implementation-complete pending the next fresh audit. Proof rerun after these fixes: `npm run lint` passed; `npm test` passed with 136 tests; `node bin/aimgr.js --help` passed; an injected-stdout help probe captured 4594 bytes; `node bin/aimgr.js status --json --home <temp>` produced the expected temp state path; both watch installer `--print-only` commands passed; `npm run codex-watch:status` returned 0; `npm run hermes-watch:status` returned 1 for the accepted not-installed path; the final line-count audit passed with the largest in-scope file at 491 lines; `package-lock.json` is unchanged; and non-CLI owner imports no longer reach into `src/cli/*`. The authoritative Implementation Audit block remains owned by the fresh child audit.
