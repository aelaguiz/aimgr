# Actual-workload backtest results

**The workload backtest found and fixed three compatibility regressions: detached-job temporary files, native installed-skill edits, and linked installed skills. [Final affected native checks](#final-helper-verification) pass on isolated Linux and Mac.** The [cold audit and disposition](CODEX_ACTUAL_WORKLOAD_COLD_REVIEW_2026-11-05.md) track the findings and final review. The completed comparisons do not establish that all twelve workloads pass; the remaining evidence is listed below.

This records execution of the [history-based workload plan](CODEX_ACTUAL_WORKLOAD_BACKTEST_PLAN_2026-11-05.md), following the completed [working-directory acceptance](CODEX_WORKING_DIRECTORIES_ACCEPTANCE_2026-11-05.md). The first comparisons use runtime source `f36fd22510c880a44f74a07f9095cc5ec436f42d`, with plan-only commit `912c114`; tests use unchanged official Codex 0.166.0. Subsequent runtime corrections require their own recorded checks. The private execution records retain exact binary/source hashes, invocations, fixture outputs and setup failures under `~/.aimgr/audits/codex-workload-backtest-2026-11-05/execution/`.

## Corrections found by the cold audit

The initial background and skill-edit recipes missed two native behaviors. Both failures were then reproduced on the unchanged official client with the earlier AIM runtime: stock passed and protected failed on Linux and Mac.

| Trigger | Earlier protected runtime | Corrected runtime |
| --- | --- | --- |
| A detached job creates its first temp file after Codex exits | The invocation temp directory had been deleted. | Both platforms pass first temp-file and socket creation after parent exit, with caller `TMPDIR` preserved. |
| Native `apply_patch` updates a real installed `~/.agents/skills` file | The edit was refused. | Linux and Mac pairs pass; private siblings and native read-only writes remain denied. |
| Installed skills link to directories outside the work areas | Protected Codex omits their descriptions and refuses native edits; stock succeeds. | Linux and Mac pass discovery, native edits and repairs of linked user skills, while denying private neighbors and repository child-link reads. |

The earlier temp/real-directory correction comparisons use actual native edits, replacing the insufficient shell-only check. The passing fixtures are Linux `workload-12-MxzHiL` and Mac `workload-12-ekAKXr`. For that earlier correction, focused JavaScript checks passed on the isolated Linux host (12 of 12) and Mac (11 passed, one Linux-only skip). All 11 changed runtime/fixture/test files match the local worktree on both hosts. Corrected artifacts are Linux `41ae46ed582cb64bd5f1f7833354130559daa249ba704de488e7d5ca10c0c612` and Mac `703abded08315ca36c4002428900830978bde43305d36c0adb96b04ddd72d368`. These first two corrections leave official Codex and the Rust helpers byte-for-byte unchanged. The subsequent linked-skills correction carries native-selected skill roots into the existing filesystem-grant owner and requires an AIM helper rebuild; it does not change official Codex. Folder permissions do not depend on valid skill metadata.

The late-temp pairs pass as Linux `workload-8-NU8JAO` and Mac `workload-8-WZjdCc`. Affected native image/private-file checks also pass on the corrected runtime: Linux `workload-5-DOeos1` and Mac `workload-5-U4FROV`, with four and five generated images per side respectively and all four protected private controls denied. Linux's synthetic C boundary check passes (`tool-boundary-6uz6jo59`), retaining staging validation, private-ancestor denials, ordinary-tool access, nested reentry and background lifetime. Exact before/after temp values, source hashes and installation manifests are retained in `execution/late-temp/{linux,mac}-structured-before-after.json`.

## Final helper verification

Final checked source is `b2c7aa3f12e348204babce9643dcb7dbd0ccf5cb`; product source last changed in `e01baefd27f3c10c3be9b5ee960b8500e256e2c6`, followed by native-recipe corrections for `SKILL.md` identities and dedicated-writer canonical paths. Both isolated hosts match all 573 selected repository files. The checked-source inventory SHA-256 is `a6ffde3484323ac815b65005dcb55560e9bc82432bf93168cda439d1c6530966`.

Final installed artifacts are Linux `822c41e3ab4142fc3768f22696a8a2a6b27c560466de2048b95156b55770164d` and Mac `66c33f65df68c5dce5334fdbef8cc5ae29be4318ad23d032c261af6211c14300`. These artifact identities are separate from Git commits and source inventories. Mac retains the installation built from `7d539c5`: later JavaScript/test/recipe corrections leave its Rust/C/helper bytes unchanged; the final JavaScript bytes were checked independently. Official Codex bytes and environment identity stayed unchanged on both hosts. Cargo manifests and dependency lockfile are unchanged.

| Final affected check | Linux | Mac |
| --- | --- | --- |
| Real installed-skill native edit; private sibling and read-only denial | Passed `workload-12-hVCquR`. | Passed `workload-12-XFPAhH`. |
| Broken/broad optional aliases do not veto launch or grant private parents | All five paired phases passed, `workload-12-OOZK3C`. | All five paired phases passed, `workload-12-94dbvM`. |
| Linked/nested/broken/new skills; live enable/disable | Passed `workload-12-RE1dR0`; settings `settings-fCkEOw` / `settings-DvKKP8`. | Passed `workload-12-YeXiTo`; settings `settings-1N3lVR` / `settings-RUasdf`. |
| Worktrees and native images/private-file controls | Pairs passed, `workload-1-JRGy8A` / `workload-5-vxNrVE`. | Pairs passed, `workload-1-5RI4jt` / `workload-5-3UdStA`. |
| Protected native HTTP OAuth | Passed `mcp-77gRxD`: calls, five refreshes, contention, expired-grant refusal, logout and two no-revival restarts. | Passed `mcp-vRtxUJ` with the same checks; original Keychain default/search list restored. |
| Complete JavaScript suite | 1,004 passed, 19 skipped, one failed out of 1,024 tests. The unchanged failed file then passed all five tests. | 1,008 passed, 16 skipped, none failed out of 1,024 tests. |
| JavaScript lint and native-recipe syntax | 386 JavaScript files and 22 recipes passed. | 386 JavaScript files and 22 recipes passed. |

Both linked comparisons use 143 valid fictional installed skills and two repair folders. All six native edit cases pass, including disabled, malformed and new skills, as do their read-only negatives. Stock can read the private image through a repository child link; protected Codex denies it. The final Mac paired recipe took 1.62 seconds across four native invocations. The Linux base and linked recipes took 22.67 and 23.06 seconds, including an existing hostname-resolution delay inside the disposable namespace. These are fixture timings, not isolated production-launch measurements.

Linux's full-suite failure is the unchanged Claude diagnostic cleanup test at `test/privacy/claude-settings-validation-runner.test.js:101`: an immediate process-group existence check did not throw the expected error after pipe closure. The same five-test file then passed unchanged in the same namespace, with no new surviving Node processes. The original failure is retained; its cause is not established and Linux is not described as a clean full-suite pass. Linux's full suite ran before the two recipe-only corrections; product and test bytes were unchanged. Mac's suite ran against the final checked inventory. No full suite was repeated for recipe assertions.

The first linked stock fixture (`workload-12-8R5GGq`) exposed an invalid disabled-skill selector in its fictional config before protected comparison: native matching uses the `SKILL.md` file, not its directory. A second expectation (`settings-0cmFO0`) incorrectly required the old relative alias after the dedicated native writer chose the canonical external file. These recipe failures remain recorded. Corrected base and linked recipes pass on both platforms: initial and batch writes preserve authored relative paths, enable/disable changes stay live, and dedicated skill writes use native canonical identity. The implementation does not require absolute shared paths.

The final helper builds took 1,206.22 seconds on Linux with four jobs and 59.13 seconds on Mac with one job and its existing compiled cache. Both use Rust 1.95.0. Final source/artifact checks found no mismatches; owned native clients, listeners, private keyring services and build processes were closed. Detailed final integration and linked-skill receipts are retained privately under `execution/final-integration/` and `execution/browser-integrations/`.

## Current coverage

“Finite tool sequence” means the official client executed actual tools against a local scripted model endpoint. It proves those calls and observable outputs, not model judgment or a service/device step that did not run. Stock and protected runs use equivalent fresh synthetic inputs and retain their permission mode. Real-agent execution is recorded separately.

| Workload | Completed comparison | Remaining evidence |
| --- | --- | --- |
| 1. Worktrees and sibling repositories | Linux/Mac tool sequences; Linux real Terra pair | Sol is unavailable to the test account. |
| 2. Remote build and database recovery | Linux SSH and Mac `machines`, with real PostgreSQL | The build uses C; Rust is not tested. |
| 3. Phone control and restoration | Linux simulated SSH/SFTP route | No physical iPhone or Android run. |
| 4. Existing browser attachment | Linux BrowserOS and bundled MCP | Mac BrowserOS is absent. |
| 5. Downloaded/generated images | Linux/Mac native image reads; Linux real Terra pair | Corrected runtime also passes on both platforms. |
| 6. Artifact creation and upload | Linux image CLI/SDK, PPTX and workbook creation | Images endpoint is synthetic; Google upload is untested. |
| 7. MCP and ordinary CLI credentials | Linux/Mac stdio, CLI and native HTTP OAuth | Mac uses a fresh disposable Keychain; normal desktop authorization prompts are not exercised. |
| 8. Detached jobs and locks | Linux/Mac tool sequences; Linux real Terra pair | Late-first-temp regression now passes on both platforms. |
| 9. Read-only reviewers | Protected Linux/Mac; real Terra reviewer on Linux | No matched stock reviewer pair; mixed Claude-parent sequence untested. |
| 10. Reviewer history and continuations | Stock starts the real history helper | Quota prevents completion and both later continuations. |
| 11. Scheduling, crash and save | Protected Linux systemd/Redis routine | No new Mac or Claude coordinator crash/save run. |
| 12. Live settings, skills and scope | Native settings, skill edits and scope correction | Complete delegated-worker skill discovery not rerun. |

The worktree comparison includes a returned review correction, a deliberate failed test and repair, remote readback and tool-only credentials. Remote builds include missing build-identity refusal, a real database timeout/retry, interrupted SSH, same-thread inspection and returned files. The Mac uses the unchanged installed `machines` wrapper. The simulated phone route verifies quoting, actual wrong-PID refusal and exact restoration of three fictional files; it cannot establish device compatibility.

Linux BrowserOS attaches to an already-running browser with Chromium's sandbox enabled. It verifies a seeded login against an unauthenticated negative control, background-tab focus, actual inline PNG bytes, oversized output readback and preservation of the original tab. Local artifact tooling uses the installed image CLI/SDK, a reference image and cwd credential selection; the deck/workbook contain the exact returned image and a two-frame GIF. No external Images call or Google upload is claimed.

Ordinary integration tests cover on-demand stdio MCP, PATH/private-config CLI credentials, persisted refresh, same-thread continuation, service denial, expired grants and child cleanup. Neither writes a File fallback. Linux omits the D-Bus address for this ordinary-tool test; Mac has a synthetic default Keychain, so this is not proof of Keychain unavailability. Linux HTTP OAuth separately verifies native identity/denial calls, rotating refresh across restarts, required expired-grant failure before a model request, and logout without resurrection. Mac native HTTP OAuth now passes in stock (`mcp-g4x4yK`) and protected (`mcp-ARvUGF`) Codex using the existing fresh disposable-Keychain fixture. Both execute identity/denial calls, refresh, expired-grant refusal before model work, logout and two restart checks without credential revival. Protected execution also verifies contention across two homes. The fixture authorizes only its newly created synthetic item, then restores the original default Keychain and search list and removes its own Keychain. This does not exercise the normal desktop authorization prompt. Earlier attempts against the reused synthetic baseline failed at item creation with `CSSMERR_CSP_NO_USER_INTERACTION`, even after explicit unlock; those setup failures remain recorded and their required session state is unresolved.

Protected native reviewers consume stdin, JSON and a separate final file, read sibling evidence and installed skills, and encounter actual write denial. Their scripted defect check proves tool behavior; the real Terra reviewer independently finds the defect and completes two read-only continuations. Those continuations are not the unfinished full-access history-review case. Linux scheduling uses actual systemd and Redis with a synthetic model/terminal adapter; calendar/interval dispatch, overlap suppression, same-thread handoff, non-replay of a failed occurrence after restart and a later successful occurrence pass. Owned units are removed.

Native live settings pass later-request contents, model/effort/permission changes and propagation across two account homes on protected Linux and stock/protected Mac. Protected native edits preserve skill switches and relative-path writeback on both platforms. The new installed-skill comparison above replaces the original shell-only check. New outside path targets still take effect at the next invocation.

## Real-account limits and test corrections

The stock Linux login was authorized independently in the original local test browser profile. Its underlying test account matches the protected login, and their refresh grants differ. No primary authorization file or browser profile was copied between environments.

Both stock and protected Codex explicitly reject Sol 6.1 and Sol 6 for this sacrificial ChatGPT account before tool work. These are shared model-availability failures. Separately labeled companion pairs completed under the advertised supported model, Terra 5.6 at xhigh; they cannot count as Sol passes. Both independent grants subsequently reached the same upstream account usage limit, leaving the history-review case incomplete. No further model calls or account substitutions were made.

The Linux stock native read-only controls fail before shell work with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Kernel audit records show the host's `unprivileged_userns` AppArmor profile denying the required capabilities. The actual stock model also reports that it could not inspect the reviewer inputs. Protected read-only execution retains its mode and has completed the deterministic source/write-denial check. The failed stock comparison remains visible; the host policy and reviewer permissions were not loosened to manufacture a pass.

Setup failures remain in the private records. Corrections so far concern the fixtures: a detached worker that finished before its liveness assertion, recognizing read-only filesystem denial alongside permission denial, MCP namespace schemas, SFTP quoting, available disk space and exact loopback callback spelling. A failed stock fixture is not evidence against the candidate. Remaining transport/setup diagnoses must be resolved or explicitly reported before their cases can pass.

## Test-setup correction

The attempted Google upload setup reused the company desktop OAuth app registration in the sacrificial browser, unnecessarily associating that route with the app at Google. No Google user signed in and no user grant was issued. The owned VM registration and registration identifiers in the owned attempt logs were removed, the login process was stopped, and the original laptop config was left untouched. The Google workload remains unproven; no ordinary account was substituted.

## Review and completion

The original plan received its cold review before execution. The independent Claude Opus5.5 high auditor examined the full PR, found the compatibility defects, then reviewed the final source and receipts in the same session (`f03708a4-edbc-4435-89d5-bc4b707b7468`). Its final verdict is ready for review with no remaining code blocker or material overbuild, after publication of the evidence and correction of stale text. The continuing Gemini4 Argon medium reviewer separately checks scope, time and fidelity to the user's instructions.

One existing boundary limit is explicit: startup discovery can resolve a repository's `AGENTS.md` or root skill-folder link to an outside private target. Such selected inputs retain their grants to preserve shared instructions and skills. The new repository *child-link* denial does not cover that startup path. No malicious-repository containment or new user approval of that exposure is claimed. The normal private-file controls and other-account boundaries remain separate checks.

The Linux VM is restored to its original two-CPU size, with disk, build cache and evidence preserved. Owned test processes, tunnels, containers and private keyring services are closed; test-installed Docker services are stopped and disabled. The Mac's default Keychain/search list and temporary loopback aliases are restored, and its existing paid-window cleanup remains scheduled.

## Evidence and repeatable recipes

The recipes below run only on the isolated test installations and use fictional inputs. Their actual native argv, tool outputs, model requests, source/binary hashes and setup failures are retained privately. No raw personal histories, browser profiles or primary auth homes are committed.

| Recipe | Coverage | Completed fixture references |
| --- | --- | --- |
| `scripts/privacy-codex-workload.mjs --case=N` | Stock/protected worktrees (1), frames (5), detached work (8), scope edits (12) | Linux: `workload-1-bmzlaj`, `workload-5-Fqxp2S`, `workload-8-AFQAa6`, `workload-12-00Iz7A`. Mac: `workload-1-g3xwhn`, `workload-5-rl95Wp`, `workload-8-V72bM0`, `workload-12-8jRn8g`. |
| `scripts/privacy-codex-remote-device.mjs --case=N` | SSH build/database (2), synthetic file recovery (3); `--machines` exercises the unchanged installed wrapper from Mac | Linux: `remote-device-2-Jreq3E`, `remote-device-3-1kv6zT`. Mac `v6BYP1` under its short disposable home: three wrapper receipts and nine returned files per side. |
| `scripts/privacy-codex-workload-browser.mjs` | Actual Linux BrowserOS/MCP (4) | `workload-browser-n8vuVt`; actual returned image inspected by worker and parent. |
| `scripts/privacy-codex-workload-artifacts.mjs` | Local image CLI/SDK, deck/workbook construction (6) | `workload-artifacts-cguzZp`; Images response is synthetic, upload absent. |
| `scripts/privacy-codex-workload-tool-credentials.mjs` | Actual stdio MCP and ordinary credentialed CLI sequence (7) | Linux `workload-credentials-kMfTsI`; Mac `workload-credentials-WJFp8o`. |
| `scripts/privacy-codex-native-mcp.mjs --workload-calls` | Native OAuth calls, refresh and logout (7); `--stock-control` uses one ordinary home | Linux stock `mcp-HzGSZx`, protected `mcp-kccJBU` include the expired-grant negative. Mac stock `mcp-g4x4yK`, protected `mcp-ARvUGF` pass with `--standard-keychain`; earlier reused-Keychain import failures remain separate. |
| `scripts/privacy-codex-nested.mjs --reviewer-only --workload-reviewer` | Protected read-only tool sequence (9) | Linux `nested-azIpNr`; Mac `nested-YXqeuH`. |
| `scripts/privacy-codex-routine.mjs ROOT` | Actual protected Linux routine sequence (11) | `rt166-workload-routine-20261106-0052`; actual scheduler, synthetic model and terminal adapter. |
| Existing `scripts/privacy-codex-settings-native.mjs` | Native live settings and writes (12) | Linux protected `settings-EJUMzp`, edits `settings-2YaHUA`; Mac stock `settings-VEg68D`, protected `settings-Lgepef`, edits `settings-MS589v`. |

Linux fixture commands use the existing loopback-only network namespace. The nested HTTPS reviewer additionally uses the existing test host aliases and namespace-local low-port setting. On Mac, the same reviewer uses the existing socket wrapper to bind loopback443 and drop to the test user; temporary aliases were restored byte-for-byte with original owner and mode. These are test setup details, not new product requirements.

The exact private reports are `execution/linux/report.md`, `execution/mac/native-workloads.md`, `execution/real-agent/RESULTS.md`, `execution/browser-integrations/REPORT.md`, and `execution/remote-device/RESULTS.md`. The Linux runtime comparison verifies all 261 tracked `src/` and `native/` files against the candidate; a stale VM Git HEAD is not treated as source identity. The Mac was built from the recorded candidate archive. Prior full JavaScript suites describe the pre-correction runtime. The temp and installed-skills corrections add focused unit and native checks; earlier passes are not relabeled as runs of the corrected bytes.
