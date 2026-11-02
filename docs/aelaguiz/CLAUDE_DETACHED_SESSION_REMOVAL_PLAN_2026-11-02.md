---
title: Disable Claude detached sessions while preserving normal work
date: 2026-11-02
status: active
fallback_policy: forbidden
owners: [implementation agent]
reviewers: [cold reviewer]
doc_type: project_plan
---

# Disable Claude detached sessions while preserving normal work

Implement the narrow recommendation in the [background review](CLAUDE_BACKGROUND_PRIVACY_REVIEW_2026-11-02.md), verify it on the designated Linux VM and a rented Mac, obtain cold review, publish a PR and merge it. The user explicitly authorized this on November 2: “please put a plan together to implement that, test it as we have done with our other stuff and get a PR up and merged down”. No further permission is needed for that work. Existing personal sessions and daemons remain running; this PR does not perform their transition or change the personal machine's default launcher.

## Outcome and scope

Every new AIM Claude launch disables the supported detached-conversation system before vendor work can start or join a shared supervisor. A daemon-management command must never become a model prompt. Ordinary and protected accounts retain ordinary concurrency, background Bash, local subagents, skills, MCP, history, tools and AIM schedules.

The approved behavior changes are agent-view UI/prewarming, detached conversations and their supported creation/reattachment paths. `/fork` falls back to a local asynchronous subagent; CLI history fork remains. The built-in agent subtype `claude` disappears while `general-purpose` remains. These changes were explicit in the recommendation the user asked to implement. No new normal-session cap, broad background-task ban, malicious-tool defense, content redaction or service is authorized.

The [existing privacy plan](CLAUDE_PRIVACY_IMPLEMENTATION_PLAN_2026-11-01.md) continues to govern all other controls and accepted risks: optional per-account proxy use; fail-closed protected routes; exact Claude builds rather than OS releases; account-private identities; fixed harmless custom headers per session; new sessions for added outside directories; individual Pro/Max accounts; Remote Control and remote flags disabled for all accounts; ordinary telemetry scope unchanged. Independent destinations, normal task context and deliberate malicious tools remain accepted. This plan supersedes only the old requirement to preserve native detached jobs.

## Design and code anchors

- `src/privacy/claude-settings.js` owns the admitted flag settings and invocation grammar. Add the narrow boolean and environment pin here; compose both over caller values without changing unrelated settings. Reject supported detached CLI entry requests early with an actionable message. Preserve literal prompts and option values that happen to use the same words.
- `src/privacy/claude-managed-policy.js` rejects a higher-precedence machine policy that would undo either pin. Native isolated doctor validation still verifies that the complete overlay loads; no synthetic receipt replaces it.
- `native/claude/approved_launch_linux.c` and `approved_launch_macos.c` set the narrow environment value before vendor startup. The guarantee combines shared argument admission, the immutable flag snapshot and this startup pin. Raw native `--bg` and `daemon run` can reload user environment before the intended gate; the pin alone does not defeat hostile disk settings and is not a substitute for AIM admission. Deliberately bypassing AIM remains within the accepted malicious-tool risk. Tests must exercise actual AIM for the supported guarantee, including a fresh account/temporary namespace with a working enabled native control. Review the actual eager and ordinary parsers separately, including short clusters and subcommand boundaries. Native-created ordinary tools retain their existing behavior; do not set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
- Linux native directory grants include the exact granted directory as well as its contents. Testing exposed a pre-existing omission: the kernel denied shared personal-skills enumeration even though a policy query reported permission. Add only that exact root directory; keep parent/sibling private paths and update paths denied. A compiled-production-emitter test must perform real kernel opens, followed by the actual protected Claude skill workflow.
- Public CLI validation must happen before Redis/provider preflight for a rejected request. Shared runner/handoff validation remains the final common path for auth, maintenance, scheduled work and nested callers.
- `native/claude/runtime_inventory.py` and `src/privacy/claude-status.js` provide local, non-vendor inspection. Add conservative process roles, without publishing argv, environment, credentials or personal paths. Existing daemon cleanup is an explicit operator transition using verified PIDs and OS signals, not a new native-command bypass. No automatic signaling or deletion.
- Mac selector publication changes which immutable bundle future starts use; it need not stop unrelated sessions. Retain the existing per-account migration guards and Linux policy-reclamation transition. Reuse the previously prepared activation fix and its tests after review; never unload a live Linux policy.
- Update the canonical privacy documents, README installation/transition instructions and `skills/agent-upgrade-test`. Teach future reviewers to follow the actual request owner across reuse and upgrades, distinguish normal helpers from a shared supervisor, and investigate new automatic callers rather than only searching current flag names.

No vendor patch is involved. The native launcher change produces new exact artifact sets. Build and test them offsite, retain the entire bundles in restricted durable storage and verify fresh retrieval. Keep test-only authority distinct from normal-use approval; no personal installation is part of this PR.

## Verification contract

Use Claude Code 2.1.316 at the previously established exact vendor hashes. Test fixtures and native helpers are rebuilt from this branch. The Linux VM is `aimgr-privacy-dev`; Mac testing uses the existing rented dedicated host through AWS profile `agent-macos-test`, with a fresh disposable instance, encrypted disposable disk, outbound denial and bounded automatic cleanup. No physical Mac vendor execution. No new browser or copied browser profile. Only proxy5/proxy6 may be used if real-account regression checks are needed, through their assigned routes; stop all work on an actual human-verification challenge.

| Requirement | Required evidence |
| --- | --- |
| Narrow policy is effective | Ordinary/protected composition, case-insensitive managed conflicts, explicit/user/project/app-state settings, environment and live reload cannot enable agent view; native schema validates final snapshot. |
| Disabled requests fail clearly and locally | `--bg`, `--background`, agent view, daemon-management and native detached-job management intent refuse before native/provider work; zero model requests. Argument-value/prompt controls prove normal text is preserved. |
| Automatic paths stay off | Persisted default-agent-view preference, `/background`, foreground handoff/exit options and existing same-account daemon do not start/join detached work. Runtime evidence plus exact source review covers UI-only paths. |
| Known owner-reuse gap is closed | Paired baseline starts an old-path supervisor; new disabled launch cannot dispatch to it. Existing owner survives, transcript/settings remain. |
| Local status and transition are safe | Status identifies verified daemon/worker/session roles without running Claude or contacting Redis; unknown role stays unknown; no process is signaled. Exact targeted manual cleanup is documented and tested only on disposable owners. |
| Ordinary coding is retained | Real native Read/Bash, normal background Bash, asynchronous general-purpose Agent, skills, instructions, memory, resume and CLI fork; local native development/package behavior. |
| MCP is retained | Actual stdio and HTTP MCP tools, resources, OAuth and package dependencies on both platforms. |
| Concurrency/nested work is retained | Actual A1/A2/B overlap, same/cross-account native and HTTP nested AIM dispatch; no added cap or serialization. |
| Schedules are retained | Actual OS calendar starts the AIM occurrence/worker, records completion and duplicate suppression; terminal remains usable; in-session wakeup fires. Both platforms. |
| Protected failures remain closed | Startup with tunnel/proxy down refuses loudly; live loss ends affected work, healthy sibling continues, no direct traffic, replay or automatic switchover. Ordinary account remains usable without proxy services. |
| Existing privacy controls stay effective | Exact-build/malformed settings/managed-source admission, Remote Control, telemetry scope, account identity, host metadata restrictions and custom-header pins; reuse current matrix and rerun affected paths. |
| Installation coexists with sessions | Mac selector publication preserves old ordinary processes/bundles; invalid publication preserves prior selector. Linux live-owner reclamation refuses. |
| No hidden feature removal | Cold reviewer checks implementation against requirements and accepted risks, including deliberate-tool exclusions and the two explicitly accepted `/fork`/subtype changes. |

A skipped native test, failed positive control, timeout, fake timer or substituted browser is not a pass for the corresponding native/real requirement. Record substitutions where fixtures use them. Ordinary-mode observations are not protected-account proof. Test sources may need a baseline lane because the current background fixture deliberately launches `--bg`; retain that control rather than weakening production admission for tests.

## Execution plan

1. **Plan and early cold review.** Review scope and entry points before code. Establish offsite resources and independent outbound denial. Exit: concrete test matrix and no unresolved design contradiction.
2. **Implementation and focused checks.** Add pins/refusals, managed-policy conflict checks, local process roles, Mac activation correction, comments and documentation. Run focused JS/Python checks locally or on the VM as appropriate. Exit: meaningful regression tests pass without changing accepted task semantics.
3. **Native verification and bundle retention.** Build new bundles on the two offsite platforms, exercise the matrix above with existing fixtures, fix demonstrated failures and rerun only affected tests. Run the repo suite once when ready. Preserve/retrieve/hash full bundles before rental cleanup. Exit: required native behavior and workflow evidence passes; exact scope and limitations recorded.
4. **Cold review, PR and merge.** Fresh reviewer examines the final code, tests, actual evidence and requirements. Resolve findings; run affected checks. Update plan with final evidence. Publish a PR with concrete before/after command behavior and user-visible tradeoffs, watch CI once, merge after review/checks pass, and verify the remote merge. Preserve the main checkout's unrelated uncommitted work.

Rollback means restoring a compatible previously approved source/bundle deliberately. It never means falling open, removing the build gate, unpinning Remote Control, deleting running bundles or silently switching to a direct route.

## Progress and evidence

Implementation and the required offsite Linux/Mac tests are complete at source `1e43725`. An independent read-only reviewer signed off with no remaining production or acceptance-test blocker. Publication and the user-authorized merge are the remaining delivery steps.

The [implementation evidence](evidence/claude-detached-2026-11-02/README.md) maps every requirement to its final passing receipt, identifies the exact vendor and artifact sets, and records substitutions and initial failures with their replacements. Both final source checkouts matched; rebuilding the final C sources reproduced the tested launchers. Complete bundles were retained and freshly retrieved with their inventories verified. They remain test-only, without personal activation.

The native eager-parser and argument-prefix findings, Mac process-inventory bound, and Linux personal-skills directory omission were corrected and passed their affected native tests. Existing and fresh supervisor tests, live settings, ordinary/protected workflows, actual calendar starts, terminal control, nested concurrency, MCP and loud fail-closed proxy behavior passed on the relevant platforms. The repository suite's initial checkout-setup failures were all resolved in affected-file reruns; the evidence does not mislabel that as one entirely green suite run.

See the [cold-review sign-off](evidence/claude-detached-2026-11-02/cold-review.md) and [resource-cleanup receipt](evidence/claude-detached-2026-11-02/cleanup.json). The earlier [research receipts](evidence/claude-background-review-2026-11-02/review.json) establish the mechanism; the new implementation receipts are the acceptance evidence. Existing personal sessions, default launcher and unrelated main-checkout edits were preserved.
