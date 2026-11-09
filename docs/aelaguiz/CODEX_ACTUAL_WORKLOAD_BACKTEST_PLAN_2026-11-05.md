# Backtest Codex privacy against actual agent work

**[Backtest results](CODEX_ACTUAL_WORKLOAD_BACKTEST_RESULTS_2026-11-05.md) record the completed comparisons, regression fixes and missing workload evidence.** PR #14 already has isolated native-client, privacy-boundary and unit-test evidence. This appendix adds the missing question: can the protected client complete the tool sequences used in Amir's actual work, without changing their permissions, moving their files or replacing their tools?

This is the validation appendix to the [canonical privacy plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md#current-completion-plan--november-5-2026), tracked in [working-directory and workflow compatibility issue #16](https://github.com/aelaguiz/aimgr/issues/16). It adds tests, not new privacy requirements. Proxy development remains parked. Claude histories inform required workflows and mixed Claude/Codex operation; this does not turn Codex into Claude or add Claude-only features to Codex.

## What the history review changes

The replay must preserve more than access to `/tmp` or the ability to start a shell:

- An agent attaches to an already-running browser and reads oversized browser output through a shell. Starting a fresh browser alone does not test this.
- Video frames and downloaded images appear after the conversation starts and are then opened through native image tools. Reading their bytes in Python does not prove image viewing works.
- Remote builds need environment variables, sibling worktrees, generated files returned to the caller, and recovery when SSH drops. A local compiler invocation misses those dependencies.
- Phone work uses SSH, `devicectl`, ADB and LAN WebDriverAgent calls, as well as recordings and screenshots. An MCP-only smoke test misses actual routes.
- Reviewers are launched with stdin briefs, JSON events and separate result files, then resumed. Some have full access and some are genuinely read-only. Preserve that distinction.
- Background jobs use locks outside the workspace, survive intended parent exits, and leave durable output. Crash recovery inspects surviving work before recreating timers or launching replacements.
- Workbooks, decks and other outputs require credentials in ordinary tools, real upload/readback and correct artifact contents. A successful command exit is insufficient.

These are dependencies to test, not newly confirmed candidate failures. Ordinary shell/MCP executables retain normal OS permissions in the current implementation. A historical shell read under `~/.browseros` or a lock under `~/Library/Application Support` does not justify granting those whole trees to native Codex.

## Evidence and sampling

Three Sol 6.1 researchers inspected workflow sequences in **27 distinct sessions: 17 Codex and 10 Claude, dated October 30 through November 5**. Their assignments covered development, browser/file, and agent operations. They read ordered prompts, calls and results, including corrections and incomplete outcomes. Large sessions were inspected at the relevant sequences, not every unrelated task. Titles and compaction summaries were leads, not proof of completed work.

The discovery window was October 22 through November 5, 2026, Central time. The complete local Codex metadata index contains 3,299 distinct thread IDs. Claude discovery retained the newest 3,000 matching sessions and was capped; its retained dates start November 1. This is a purposive sample of locally available histories, not a frequency estimate or an inventory of every machine. Continuation pairs and coordinators with their reviewers are related work, not independent workload counts.

Private source records, original transcript line numbers, ordered helper entries and fuller findings are retained under `~/.aimgr/audits/codex-workload-backtest-2026-11-05/`, in `development`, `browser-files` and `agent-operations`; `provenance.json` lists the 27 unique sources. Keep that provenance local. Published examples contain task mechanics, not transcript payloads, account labels, private endpoints, document IDs or tokens.

| Historical work | Observed dependencies or limits | Planned case |
| --- | --- | --- |
| Go test repair and website implementation | Sibling files, isolated worktrees, injected tool identity, review changes on the same branch | 1, 12 |
| Rust journal repair and its continuation | Remote source without `.git`, explicit build identity, lost SSH and missing returned files | 2 |
| Staging build and Rust/protobuf change | Long readiness waits, remote toolchains, generated outputs and paired repositories | 2 |
| iPhone QA and Android recovery | Signed install, LAN/SSH control, recording, checksummed restoration; some product timing claims remained unproven | 3 |
| Browser research and connector setup | Existing browser attachment, evaluate/CDP, tool-output spill, consent interaction and later service failures | 4, 7 |
| Video/GIF deck preparation | Download to temporary storage, frame generation, native image read, upload and independent readback | 5, 6 |
| Workbook refresh | Detached Python process, external lock directory, generated files and publish/readback | 6, 8 |
| Coordinator and paired reviewer | External Codex dispatch, saved thread ID, incremental history and durable reviewer notes | 9, 10 |
| Crashed coordinator and successor | Inspect surviving timers/workers, recreate only missing work, explicit save with intentional survivors | 8, 11 |
| Cleanup and skill revision | Scope changes mid-session, process inspection, remote tools and installed skill edits | 12 |

Historical failures stay visible. An SSH timeout, missing test database, expired service authorization, partial device proof or rate limit is not evidence that privacy caused a failure. An agent's summary is weaker evidence than the corresponding stored tool result. The private records distinguish these.

## Comparison and evidence rules

1. **Freeze the inputs.** Start with AIM `f36fd22510c880a44f74a07f9095cc5ec436f42d`, unchanged official Codex 0.166.0 and its admitted artifact. Record candidate commit, native hashes, OS, tool versions, effective settings, permission mode, directory topology and test-data revision. If code changes, retest affected cases on the new commit and state which earlier results remain applicable.
2. **Run a stock/protected pair.** Use the same official client build, semantic settings, model and effort, tools, synthetic task, permissions and initial files. Give each run its own fresh or equivalently seeded test state. The stock control uses normal Codex homes; the candidate uses AIM's account homes. Do not share primary authorization files to achieve apparent equivalence. Use independent synthetic credentials for offline runs and independently established local authorization for any service run.
3. **Replay the sequence, not a claim about it.** Include startup, actual calls, generated files, a later turn, failure/recovery when relevant, and final readback. Preserve cwd changes, output paths, stdin/JSON handling and background lifetime. Use existing fixtures to drive exact tool calls against local endpoints first. Then use a small real-agent task for orchestration and service-specific checks where scripted calls cannot establish compatibility.
4. **Preserve the historical route.** Shell reads stay shell reads; native images stay native images; BrowserOS attachment stays attachment; CLI and MCP authentication remain separate cases. Full-access histories retain their selected mode. A read-only reviewer must not gain bypass flags. Keep Chrome's own sandbox enabled. Do not pre-start a dependency that the original agent started itself.
5. **Separate causes.** If stock succeeds and protected fails, record a candidate regression. If both fail, investigate the shared dependency or upstream version before attributing the failure. If the historical client differs materially, use a historical-version control only to settle that difference; do not add a third run to every case. No silent model, tool, permission or path substitution may convert a failure to a pass.
6. **Assert observable work.** Save actual tool results, file hashes/contents, rendered images, service readback, child exit/signal information and cleanup state. An exit code of zero or an assistant saying “done” does not pass a case. Compare task correctness and ability to continue; do not require identical prose or wall-clock timing from models.

Each result records: case and platform, stock outcome, protected outcome, observed difference, evidence paths, historical route preserved, synthetic substitutions, remaining real-service dependency, and `passed`, `regression`, `shared failure`, `not run` or `not applicable` with its reason. No case is silently skipped.

## The twelve backtests

### 1. Work across repositories and worktrees

Use a small existing development fixture in one workspace repository, its linked worktree, a sibling brief/assets repository and a shell environment helper. Start in the worktree; read the brief, edit source, run a targeted test, create output in the sibling tree, and commit to a disposable local remote. Include a path with spaces and Git common metadata outside the checkout. Deliver a returned review finding and correct the same branch.

Pass when all selected inputs are read, the targeted test and deliberate failing mutation behave as expected, restored source matches its prior bytes, only intended files change, and the second revision retains the branch and worktree. A generated credential canary must reach the intended local tool endpoint without being printed or copied into native Codex state. Do not require GitHub publication or rebuild an entire product to prove this.

### 2. Remote build, database and interrupted connection

Use the normal `machines`/SSH path with a disposable remote checkout and a small existing build/test target. Preserve a source copy without `.git`, explicit `GIT_COMMIT`, selected toolchain, a real disposable PostgreSQL container, a non-immediate test, generated output and the wrapper's returned-files receipt. Perform a bounded connection interruption and continue from the worktree/logs in a second session. Also preserve an already-progressing process when its first readiness wait expires.

Pass when the remote command receives its required environment, the expected tests execute, output returns, and continuation discovers the actual remote state before retrying. It must neither silently lose artifacts nor duplicate a surviving build/container. Verify cleanup and an honest result for a deliberately missing dependency. The historical poker algorithms, complete release pipeline, store publication and full Rust suite are not this test's acceptance criteria. Rust builds run on remote capacity, never the laptop.

### 3. Phone control and artifact recovery

First prove SSH/SCP, quoting, process ownership and checksummed restore against a disposable remote directory/recording process. Then run a bounded real-device workflow using the existing reservation and device tooling: install or launch an approved test build, navigate one screen, take a screenshot/short recording, return it, inspect it and release owned resources. Preserve both observed routes: iPhone `devicectl` plus LAN WDA through the device host, and Android ADB/package-data recovery. Native Mobile MCP, if used, is additional route coverage rather than a replacement.

Pass when the intended device receives the action, returned media shows that action, a normal subsequent action works, and original test settings/data are restored with checksums. A simulated device establishes transport only. The real-device step remains `not run` until actually performed on a reserved test device; do not infer it from a mocked screenshot. Leave existing parent holds and unrelated processes intact.

### 4. Attach to a running browser and consume its outputs

Start a fresh test-only browser profile on its original host, with a synthetic page and a second tab that the test must preserve. Before Codex starts, seed a disposable session cookie in that profile; the page shows a fictional test identity only when the cookie is present. From Codex use the installed BrowserOS/MCP route to attach to the existing instance, inspect tabs, open one background tab, evaluate page state and capture a screenshot. Produce oversized output through the normal spill mechanism and consume it through the same shell-read route shown in history. Include one focus-dependent interaction and close only the owned tab.

Pass when attachment, tab identity, evaluation, screenshot content and spilled text all agree, and the pre-existing tab survives. The background tab must show the seeded test identity; an unauthenticated browser context must fail that identity check. Repeat the screenshot-as-tool-image route separately from native local-file opening. A direct CDP script is a useful transport control, not proof that BrowserOS tool discovery, attachment and image delivery work. Do not transfer an existing personal browser profile or replace attachment with a new browser launch to obtain a pass.

### 5. Download, generate and open images during a session

Download a synthetic video to `/tmp` through its physical alias, create frames with the actual media CLI after Codex starts, and open a frame with the native image tool. Repeat new image creation in a sibling workspace folder, Downloads, configured screenshots and the Mac user's real temporary directory. Include one explicitly selected outside image and an unrelated sibling/private canary.

Pass when native image payloads show the generated test pattern in every approved location without restart or relocation. The selected outside file opens; its unrelated sibling, another account file and a symlink into unrelated private storage remain denied. An arbitrary new outside path requires the documented new invocation. The existing working-directory fixture already covers these primitives; add the realistic download/frame sequence rather than writing another directory-policy implementation.

### 6. Produce a deck or workbook, upload it and read it back

Use existing artifact tooling with fictional content and disposable destination documents. Create a small deck with a generated image/animated asset and a small workbook with values, formulas and formatting. Preserve local work files outside the initial cwd, upload through the original CLI/connector, then download or query the actual destination. Include the installed image-generation CLI with reference images and its credential-selection cwd; an ordinary crop is not proof that the image service works. Preserve hidden-directory behavior where a publishing tool historically skipped it; do not mistake that pre-existing tool limit for a new privacy denial.

Pass when destination readback contains the intended values/formulas and visible media, and the animated asset retains multiple frames where required. Local mock endpoints establish path and credential propagation only. The actual connector's independently authorized test account must complete at least one upload/readback pair before claiming that connector works. No writes to existing business documents, email recipients or public production destinations belong to the replay.

### 7. Start and authenticate ordinary integrations

Exercise a locally started stdio MCP server, an HTTP OAuth MCP server using native credential storage, and a separately credentialed CLI/SDK call. Preserve ordinary shell PATH/config, on-demand server startup, harmless environment canaries and a tool credential stored outside native vendor-readable work roots. Include refresh, a later invocation, a deliberate service denial and an expired mock grant. Use existing native MCP/conversion fixtures for File-store migration and keyring availability.

Pass when the proper integration receives its test authorization, returns the expected result, refresh persists through its intended store, and denial is reported truthfully. Empty/no-MCP launch must still work without an active keyring. Existing nonempty File credentials must survive a failed conversion unchanged. Headless launch must test the actual service/session context, not an interactive shell that happens to have a different keyring. No plaintext fallback or per-account duplication of shared MCP tokens is permitted. CLI and MCP success are separate observations.

### 8. Background work, locks and intentional survivors

Reproduce the workbook runner's detached Python process, ordinary home-level application-support lock directory, PID/process-group record, generated files and final readback. Launch a second contender to verify the existing lock behavior. In one run, let the parent finish while an intentionally detached child completes and writes output; in another, stop an owned failed worker and retry through the ordinary tool path.

Pass when one intended job performs the write, its files and logs survive the parent, the next session can inspect them, and no unrelated process is stopped. Preserve the caller's `TMPDIR`, including its absence. Test both socket creation while the parent lives and a detached job's first temporary-file/socket creation after the native parent and invocation cleanup finish; an already-created socket can hide premature directory deletion. Private environment-descriptor staging is separate from tool temporary files. Use a disposable lock namespace and synthetic outputs; do not build a new lock manager or process registry. The helper's normal tool access, not a new native grant for all Application Support, should support this workflow.

### 9. Launch helpers and an actual read-only reviewer

Launch Codex through the existing delegation path with a stdin brief, explicit cwd, JSON events, stderr and a separate final-output file. Use a sibling evidence repository and installed skills. Run a full-access worker and a reviewer with native read-only permissions. In mixed-runtime operation, retain the Claude parent and launch the protected Codex child. The existing nested-Codex fixture can additionally exercise grandchild launch; that exact topology is an existing regression test, not a claim about the sampled parent histories.

Pass when the parent receives usable results, the worker makes its intended edit, and the reviewer identifies a planted defect across the source folders. A deliberate reviewer write must be denied while supported result output remains available. Record actual child argv, effective mode and account binding. Do not flatten the reviewer into the parent, upgrade its permissions or prewrite its answer.

### 10. Resume a reviewer with history and notes

Seed synthetic Codex/Claude history in separate test homes, including an earlier source session, continuation and overlapping material. Use the installed history helper through ordinary tools. Launch a reviewer, save its event-reported thread ID and notes, append progress to the source, then resume it twice with new findings to assess. Preserve the same underlying test account for same-thread resume; the historical command selected the same named account, without independently proving its backend identity across every invocation.

Pass when one reviewer thread retains its own notes, reads new source progress and produces a fresh finding, with each invocation's output separately recoverable. Add the existing rotation requirement as a distinct check: `resume-fresh` creates new conversation identities when accounts change, and manual same-thread alternatives show their warning. Do not send a source thread ID under a different account to test convenience. Account rotation success was not established by this history sample.

### 11. Scheduled launch, crash recovery and save

Use the existing AIM routine/scheduler fixture for an unattended Codex launch, one completed occurrence, overlap and interactive handoff. Separately preserve the observed Claude coordinator when testing its session-only timers and protected Codex children. Interrupt the disposable parent after one output is durable while another owned worker is still running. Restore it, inspect real scheduler/process state, recreate only a missing one-shot, and then perform an explicit save that cancels future owned work while recording an intentional survivor.

Pass when completed work is consumed once, live children are recognized, no duplicate recurring task or claim appears, and the saved output/note supports continuation. Use short actual delays and bounded test processes; do not wait days or crash a shared machine. Claude `CronCreate`/`CronList` is not a Codex API. If the equivalent parent integration cannot run in the test environment, report that part untested rather than replacing it with an unrelated Codex feature.

### 12. Change instructions, settings and task scope while working

Start with shared relative settings, existing instruction/skill files and a task that writes a report in another approved work folder. Change file contents and non-path enable switches during the session, deliver a scope correction, and launch a helper that must use the revised skill. Use the existing native settings fixture for path-target changes and reconciliation. Exercise actual native `apply_patch` against a real `~/.agents/skills` directory outside the workspace, alongside ordinary shell access, without copying the real skill's private content. Assert an unrelated `.agents` sibling stays denied and native read-only mode still refuses skill writes. A shell edit alone is not proof of native-edit compatibility. Include installed directory links whose targets are outside the work areas: `.agents` and shared `.codex` roots, a nested collection, an initially disabled skill, malformed metadata and a new skill folder. Native discovery and edits must follow the selected user-skill targets without granting private neighbors. Repository child links must not expand native reads into private folders. Broken or overly broad optional aliases must not veto unrelated launches. Check live enable/disable on existing owners and distinguish authored relative batch paths from the dedicated writer’s canonical skill identity.

The audit also found historical native report creation under `~/disk-cleanup-…`, outside the agreed work areas. Preserve this as a known location mismatch: the original unselected path is denied; an approved work folder or the existing explicit root selection is required. Do not count relocating the report or silently substituting a shell edit as an unchanged historical-route pass, and do not grant the whole home.

Pass when the ongoing work honors the new instruction/content and live non-path setting, the next helper sees the revised skill, and settings write back without dropping unrelated entries or losing relative-path semantics. A newly selected outside path takes effect at the accepted new-session boundary. The test must not demand live kernel-grant expansion or silently freeze enable/disable switches with paths. Scope correction should alter the requested work, not require a launcher restart.

## Execute in this order

1. **Prepare the finite recipes.** Use the private provenance to select the shortest real sequence for each case. Create synthetic payloads with the same path relationships, env-variable names, file types, call order and permission modes. Mark fixture substitutions and service-dependent steps explicitly. Do not send raw histories to an offsite machine or a vendor.
2. **Run the cheap native comparisons first.** Reuse the existing isolated Linux VM and a boot-verified isolated Mac. The previous test Mac has been shut down; provision a new one under the standing authorization only when Mac execution is ready. Start with images, shell/environment, browser attachment, background lifetime, nested reviewer and settings. Run one resource-heavy workload per host at a time after checking capacity.
3. **Run remote and integration sequences.** Use fresh test-only SSH identities and disposable targets, then independently authorized sacrificial service accounts and reserved test devices where the local fixture cannot prove the real route. Keep sign-in in the original test profile and its assigned route. Inspect setup logs for private host information before any vendor-backed run. Existing proxy routing is test infrastructure; this does not reopen proxy implementation.
4. **Fix demonstrated regressions narrowly.** Reduce a failing pair to the actual launch/configuration/tool dependency. Do not respond by broadening to the whole disk, reinstating blanket child restrictions, introducing a broker, copying authorization, replacing the tool, or redesigning the workload. After three failed fixes, revisit the uncertain assumption instead of extending the mechanism.
5. **Review the final evidence.** Have the cold reviewer compare the changed code, actual paired outcomes, source mechanics and approved requirements. It must check for overbuild and for false passes caused by weaker tests. Update issue #16 and the acceptance document with the exact candidate and any remaining untested workflow. Repeat focused tests after fixes; a complete suite runs once when the resulting code is ready, not after documentation edits.

Use [native exec](../../scripts/privacy-codex-native-exec.mjs), [working directories](../../scripts/privacy-codex-working-directories.mjs), [nested agents](../../scripts/privacy-codex-nested.mjs), [native MCP](../../scripts/privacy-codex-native-mcp.mjs), [settings](../../scripts/privacy-codex-settings-native.mjs), [routines](../../scripts/privacy-codex-routine.mjs), [saved inputs](../../scripts/privacy-codex-saved-inputs.mjs) and [worktrees](../../scripts/privacy-codex-worktree.mjs). Extend those owners or use short case-specific scripts. A general transcript-replay engine, copied production dataset, simulated cloud platform or new long-running test service is unnecessary. Do not restore removed Orca or code-review-graph hooks merely because an old transcript mentions them.

## Completion means demonstrated compatibility

The [existing acceptance](CODEX_WORKING_DIRECTORIES_ACCEPTANCE_2026-11-05.md) already records native image/work-folder checks, shell edits, stock Chrome, read-only review, selected settings and privacy checks on both platforms. Earlier acceptance records cover named MCP, scheduling and concurrency runs. They are useful foundations, not twelve completed workload replays.

For each applicable case, a stock/protected pair must achieve the stated observable result without an extra permission, path relocation, tool replacement or lost continuation. Run cross-platform launcher/tool cases on Linux and Mac; platform-specific device and native-keyring operations run on their actual supported host. Carry forward retained privacy assertions on the final code: private/account canaries stay denied natively, optional exporters remain off across reload/refresh, and primary authentication and installation identities remain environment/account-local.

Readiness requires zero unresolved candidate-caused workflow regressions, no silently omitted required service/device step, and a cold review that agrees the fixes remain within the approved privacy scope. A shared service outage is a shared failure, not a pass. An unavailable real integration remains a visible missing result. The sample does not prove every possible workload: PDF authoring, Prime daemon behavior, native Codex goal loops and broad Cratejoy development are not established here. Do not add implementations for those gaps or claim them tested.

At plan publication, no new replay result was claimed and no additional privacy restriction was proposed. Execution outcomes belong in the linked results document.

## Cold review of this plan

A fresh Sol 6.1 reviewer at high effort compared this appendix with the approved requirements, candidate source, existing acceptance and all three history findings. It found no material scope, attribution, privacy or executability blocker after finite recipe preparation. It identified the missing authenticated-browser-context assertion in case 4; the cookie and unauthenticated-context checks above address it. The private review is retained beside the provenance. This reviews the plan only; final implementation and actual backtest results still require the cold audit described above.
