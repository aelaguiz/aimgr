# Instruction scan: what tells agents to switch accounts, retry through limits, and fan out

Scope: psmobile, lessons_studio, puzzledb, psagentspace, agentspace, arch_skill (the skills repo; its `skills/` tree is what is installed to `~/.agents/skills`, `~/.claude/skills`, the per-repo `.agents/skills` and `.claude/skills` copies, and the Hermes profile skill roots), plus `~/.codex/skills`, the aimgr routine prompts, and the aimgr shell shortcuts the repos reference. Method: ripgrep over instruction files (AGENTS.md, CLAUDE.md, SKILL.md and skill references, prompts, runbooks, docs, goal prompts) and over code that invokes `aim` directly; excluded `_artifacts` except the capacity-watch runbook, worktrees, `runs/`, `research/`, node_modules, tests. Written 2026-09-16 11:20 CDT. Companion to `CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md`.

Quoted lines are verbatim. Paths are repo-relative unless absolute.

## 1. Summary

The account-hopping behavior is not an accident of one prompt. It is doctrine, written into the shared skill layer and repeated in five of the six repos, and it is also automated in code in two places (puzzledb's batch runner and the aimgr `c`/`cr` shortcuts). Every instruction below says some version of: when Codex hits a usage limit or capacity error, switch to another aimgr account and resume the same session. Nothing anywhere says the opposite (wait for the window, cap the burn, keep personal accounts out). The reset-credit acceptance was never written as an instruction in any repo; it arrived through the "press Enter on the resume menu" rule, which also accepts the "Yes, use reset" prompt when that is what is on screen.

Ranked by how directly each source produces the behaviors in the audit (Part D2 of the companion doc):

1. `~/.config/aimgr/codex-shortcuts.zsh` (installed by aimgr; referenced by the psagentspace runbook): `c` and `cr` "select a different eligible AIM account before launching". Every launch and every resume rotates. This is why long sessions like `01a08768` sit on 15 windows in 8 days.
2. `psagentspace/_artifacts/herdr-capacity-watch-runbook.md`: the watcher's brief. Every 5 minutes, any pane at capacity or usage limit gets `/status`, `/quit`, `cr <uuid>` (rotates), Enter on the resume menu, and a varied "continue". Thirteen panes.
3. `arch_skill/skills/_shared/aim-rotation.md` and the skills that point at it (agent-delegate, conductor, codex-babysit, plan-interview doctrine, epic-to-prs, issue-to-pr, stepwise): "A 429, usage_limit_reached, or empty completion gets one rotation and same-session retry. Do not wait out limits."
4. `psmobile/AGENTS.md:486` (copied into psagentspace cloud-testing inputs): "If Codex rate-limits while running agents, run `aim codex use` and retry (resume is fine)."
5. `puzzledb/puzzledb/batch_runner/__init__.py`: code, not prose. On a usage-limit halt of a Codex `sol_author` lane it runs `aim codex use` (auto-pick) and relaunches a replacement worker on the new account, resuming the same thread when possible.
6. `arch_skill/skills/chatgpt-web/references/accounts-and-conversations.md` and the Pro-consult rules in issue-to-pr, epic-to-prs, unblocker: when Pro is capped in the browser, switch to the next numbered Pro profile.
7. Fan-out contracts: author-puzzle-batch and the batch runner (`INTAKE_LIMIT = 4`, six simultaneous reviewers), conductor and epic-to-prs fleets, psmobile "parallelism when it safely accelerates the work".

## 2. Findings by behavior

### A. Rotate to another account when limited or at capacity

**aimgr shell shortcuts** (`~/.config/aimgr/codex-shortcuts.zsh`, installed by `aimgr/scripts/install-codex-shortcuts.sh`):

```
# Both commands select a different eligible AIM account before launching.
c()  { command aim codex run "$@"; }
cr() { command aim codex resume "$@"; }
```

The psagentspace runbook states the consequence: "`cr` is a zsh function: `aim codex resume "$@"`. It rotates AIMgr accounts, so it is the real fix for a capacity constraint." Any human or agent typing `cr <id>` moves that session to whichever account aimgr ranks next.

**psagentspace/_artifacts/herdr-capacity-watch-runbook.md** (the Opus watcher's standing brief; Amir's words quoted in the file):

- "If they get to a capacity constraint, do the CR command like you did, like I told you before, and that'll rotate the accounts."
- "If it does that you should try getting the session id ('/status') and then in the terminal do cr <session id> and when it starts back up tell it to continue from where it left off"
- "oh if it asks to resume goal select 1 and that will work instead of a prompt it'll auto prompt btw"
- Procedure step 3: "AT CAPACITY -> run the CR recovery immediately. It rotates the account; a plain nudge does not." Steps a to g: `/status`, parse UUID, `/quit`, `cr <session-uuid>`, "Shows `Resume paused goal?` -> `herdr pane send-keys <pane> enter`", else prompt a random continue phrase.
- "Amir addendum: usage limit counts as a capacity constraint ... Treat both strings as a capacity constraint and run the same CR RECOVERY (step 3). `cr` rotates to a different AIMgr account, which clears it."
- Watched spaces table: 13 panes across bugs, organic, rustai, content, cratejoy, growth sessions (API tracking, POC embed, subgame solver, learn screen, planning tracking, fees, puzzlegen, appsflyer RC double check, rustai SNG training, organizing morning work, loops, angry play store, money strategy).
- Rule 3b: stalled or paused goal and idle pane -> `herdr agent prompt <pane> "/goal resume"`.

**arch_skill/skills/_shared/aim-rotation.md** (installed everywhere; linked from psagentspace/AGENTS.md:84 to 85 "External Codex/Claude sessions use AIMgr with explicit account selection; read [AIMgr rotation] before launch"):

- Title line: "Shared mechanics for continuing Codex work across hard usage limits by rotating the active `aim` account and resuming the exact same session."
- "Before every external Codex launch, use `aim status --accounts`, choose a ready label with low five-hour and weekly usage (skip `5h_full` or roughly over 60% weekly), run `aim codex use <label>`, and confirm `aim status --compact`. Launch through AIMgr, never a bare coding CLI."
- "`aim`'s `5h_full` / 100% is a *leading* flag, not a hard block; codex commonly keeps working past it. Rotate on the runtime's real usage-limit signal, not on the percentage."
- Core rotation sequence step 5: "A 429, `usage_limit_reached`, or empty completion gets one rotation and same-session retry. Do not wait out limits or substitute a different model."
- Pool-pressure caveat: "In Prime only, children inherit one root AIMgr binding and cannot rotate independently; move that root with `aim prime resume <session> --rotate`."
- Mitigations in the same file: "Confirm the limit is real. A hard usage-limit signal or a dead process — never a lone transient reconnect"; "AIMgr accounts are single-lane in practice ... do not hammer the account ... wait several minutes before one controlled retry"; a required per-run `aimgr-usage.md` ledger.

**arch_skill/skills/_shared/agent-orchestration-policy.md:70 to 74**: "External Codex and Claude execution sessions launch through AIMgr; follow `aim-rotation.md`. Only a parent running inside Prime shares its single AIMgr binding with native children: avoid long model-pinned Codex work there and rotate the root with `aim prime resume <session> --rotate`."

**arch_skill/skills/agent-delegate/references/model-and-invocation.md:698 to 720** "Codex Usage-Limit Continuity": "A Codex worker that dies on a hard usage limit is recoverable without losing its session ... 1. Rotate per `../../_shared/aim-rotation.md`: pick a healthy account, `aim codex use <label>`, verify the switch took. 2. Continue the **same worker** through the normal `resume` mode with the captured `session_id.txt` — a new process on the new account, appending to the same session."

**arch_skill/skills/conductor/SKILL.md:241 to 245**: "An external Codex worker that dies on a hard usage limit is continued, not replaced: rotate accounts and resume the exact captured session per `$agent-delegate`'s usage-limit continuity and `../_shared/aim-rotation.md`. Rotation is not a send-back, respawn, or failed run for cap purposes."

**arch_skill/skills/codex-babysit/SKILL.md** and `references/signals-and-runbook.md`: a watchdog skill whose purpose is this behavior. "rotates the aim account when codex hits a real usage limit, restarts and resumes the *same* session"; trigger phrases include "keep it going when it gets rate limited", "restart and resume it if it hits a usage limit"; runbook: "Pick a fresh account — `aim status --accounts`; choose a `ready` account with low 5h and low weekly. `aim codex use <label>`", kill the pane's codex child, `tmux send-keys ... 'codex -p yolo resume <SESSION_ID>' Enter`, then "If a 'Resume paused goal?' menu appears (option 1 'Resume goal' preselected): `tmux send-keys -t <target> Enter`", else `/goal resume`. Mitigations: "Rotate only on a real usage limit or process death. Never rotate on a transient `Reconnecting...`".

**arch_skill/skills/plan-interview/references/standing-doctrine.md:47, 64**: "| Usage limits | `aim codex use` rotation + exact-session resume, never a model swap |" and "Interruptions and rate limits are resume events, not stops: rotate, ...". Source quote in `arch_skill/docs/plan-interview/30-session-evidence-standard-recipe.md:186`: "if you hit rate limits with codex just use 'aim codex use' to rotate". Also `docs/plan-interview/PLAN.md:180`, `40-session-evidence-failures.md:231`.

**psmobile/AGENTS.md:486 to 487**: "If Codex rate-limits while running agents, run `aim codex use` and retry (resume is fine)." Same sentence in `psagentspace/cloud-testing/plans/2026-09-12-patrol-platform-completion/inputs/REPO_BOUNDARIES.md:547`.

**puzzledb** (doctrine and code):

- `docs/GOAL_V4_UPGRADE_2026-06-11.md:47`: "Rate limits: Codex workers rotate via `aim codex use` (parent-side) on limit errors."
- `puzzledb/batch_runner/__init__.py`: `USAGE_LIMIT_SIGNATURE = "You've hit your usage limit"` (line 39); `_handle_usage_limit` (6336) for `sol_author` Codex lanes; `_prepare_usage_limit_rotation` (6273) builds a replacement worker (`worker_id:rotation-N`, `session_mode` resume when the thread is still current); `_run_aim_codex_use` (6488) executes `["aim", "codex", "use"]` with no label, that is aimgr's automatic next-best pick; `_launch_usage_rotation` (2794) starts the replacement; halt categories `usage_limit_rotation_exhausted`, `usage_limit_recovery_ambiguous`, `usage_limit_paused` (177 to 180). This runs unattended inside `uv run puzzledb batch-run`.
- `skills/author-puzzle-batch/prompts/refs/{batch_loop_contract,delegation_contract,batch_report_contract}.prompt` reference the rotation states.

**lessons_studio/docs/LESSON_LOOPS_ARCHITECTURE_PROPOSAL_2026-07-02.md:213**: "**Session resilience:** worker sessions are resumable by handle (agent-delegate fresh-resumable); on usage limits, rotate accounts and resume the same session; usage-limit failures don't count toward stop-and-fix strikes." (Proposal doc; lessons_studio has no `aim codex` calls in code.)

**arch_skill/docs/CONDUCTOR_UNIFICATION_PROPOSAL_2026-07-22.md:17, 150**: "accounts with `aim codex use` and keep going. Sometimes swap the fleet to ..."; "account low on both 5h and weekly, `aim codex use <label>` rewrites ...".

**arch_skill/docs/PRIME_AGENT_VIA_AIM_DISPATCH_SUPPORT_FOR_AGENT_SKILLS_2026-08-11.md:81, 95, 207 to 407**: `aim prime use` "picks the next-best pooled Codex label"; `aim prime resume --rotate` "implements rate-limit" handoff for live sessions.

**Practice records** (evidence the doctrine was followed): `psagentspace/docs/WEEKLY_GROWTH_BOARD_2026-07-27_CONDUCTOR_LOG.md:108` "both PC-006 workers died on a Codex hard limit; rotated via `aim codex use` and resumed the exact sessions per doctrine"; `arch_skill/docs/readable-reports/60-rewrite-rounds.md:21` "Account: `qa` (chosen through `aim codex use qa`, 1% weekly use)".

### B. Treat capacity errors as a rotation trigger, and retry or nudge loops

- The capacity-watch runbook (above) is the only file that instructs a 5-minute loop with rotation on "Selected model is at capacity". It also lists ten "continue" phrasings to vary, and the `/goal resume` rule.
- `arch_skill/skills/codex-babysit`: same loop shape for tmux panes ("No-tight-loop poll pattern" section; rotate only on real limit).
- `psagentspace/plans/drafts/2026-09-14-daily-refill-goal-prompt.md:28`: "Retry transient rate limits, model-capacity errors, SSO/session failures, and shared-import mismatches with the documented environment or read-only overlay." Mitigated on the same line: "Wait five minutes between external status checks; do not poll in a tight loop."
- `arch_skill/skills/agent-watcher/references/recognition.md:131`: "Retry and continue through a rate limit or transient error." (a recognition line inside the watcher skill's catalogue of agent behaviors).
- `psagentspace/docs/PRIME_AGENT_GOALS_AND_HEARTBEATS.md:7`: "A goal continuation is automatic, immediate, and unbounded. After every turn that ends without an error, the engine injects `<goal_context>` again with no delay, no cap, and no backoff." The doc is a warning, but it documents the mechanism under every Prime goal loop; combined with A it means a capped goal re-fires until rotated.
- `arch_skill/skills/check-my-agents/SKILL.md:49, 75`: "At most one nudge to a stalled-but-alive worker" (mitigating).

### C. Accepting reset-credit prompts

No repo file instructs accepting a rate-limit reset. `rg 'use reset|reset credit|free rate-limit|rate-limit-reset'` over the six repos and the skill trees returns nothing relevant. The instruction exists only inside the running Opus watcher session (Prime `01a0892c`), added to its own heartbeat text on 2026-09-13 01:04Z after it discovered the prompt: "A free rate-limit-reset prompt ('Use this reset?' / 'Press enter to confirm') is not capacity: accept option 1 with send-keys enter." The path that produced it is the written rule "Shows `Resume paused goal?` -> send-keys enter" (runbook step 3f; codex-babysit runbook step 5): the same keystroke accepts whichever menu Codex is showing. The watcher's note on Sep 13: "Codex can present a free rate-limit reset offer that fully stalls the pane but matches NEITHER capacity string." Two resets were consumed this way (coder2, product_growth; companion doc A12). The other 18 resets in the audit window, including both on amir.elaguizy@fun.country, were keyboard actions.

### D. Switching ChatGPT Pro accounts in the browser

- `arch_skill/skills/chatgpt-web/references/accounts-and-conversations.md:14 to 33, 96 to 113`: "The account pool contains only the numbered Pro profiles configured on this machine: for example, `Pro One`, `Pro 1`, `Pro2`, `Pro3`, `Pro4`, and `Pro5`"; "## Switch accounts ... suggests a temporary account limit; an explicit usage-cap message confirms it ... 1. Record the current account's observed condition and time. Prefer another recently verified working Pro account; otherwise check the next configured numbered Pro account not yet examined. Never include `Work` in this search. Do not repeatedly retry the capped account."
- `arch_skill/skills/chatgpt-web/SKILL.md:10 to 13, 49 to 54`: "Use only the existing numbered Pro profiles"; "Switch to another Pro account".
- `arch_skill/skills/issue-to-pr/SKILL.md:123 to 129`, `epic-to-prs/SKILL.md:127 to 140`, `unblocker/SKILL.md:85 to 92`, `unblocker/references/charter-template.md:51 to 54`: "Missing Pro probably means a temporary account rate limit. Under `$chatgpt-web` and `$browseros`, use only the already-open numbered Pro profiles ... Never use the user's `Work` profile ... Only after eligible Pro accounts are exhausted, report their observed conditions and pause the blocked Pro ..."
- `arch_skill/skills/issue-to-pr/references/dispatch-evidence.md:75 to 82` and `epic-to-prs/references/epic-dispatch-evidence.md:65 to 72`, the owner's standing instruction recorded verbatim: "if you get rate limited 'You've hit your rate limit. Please try again later' by pro clear the goal for now until pro un rate limits i'll let you know when." and "If one is limited they should use the other one." and "there is no substitute for Pro. If they can't get Pro, they can't use xhigh."
- `psagentspace/plans/drafts/2026-09-14-daily-refill-goal-prompt.md:28`: "Browser automation uses BrowserOS only: ChatGPT may use Pro2 or Pro3, and GTO Wizard uses the Work profile."
- `arch_skill/skills/browseros/SKILL.md:31`, `references/profiles-and-focus.md:125`: Work profile "reserved for their personal ChatGPT use and rate-limit capacity".
- Observed in practice (companion doc A7): the missions orchestrator recorded `profile: 'Work (explicit Amir exception)'` for its Pro consults; Amir's Sep 9 instruction in `01a08204`: "you have to use the Pro2 browseros window right now for chatgpt, pro1 is rate limited".

### E. Fan-out and parallelism

- `puzzledb/AGENTS.md:339` and `arch_skill/skills/author-puzzle-batch/SKILL.md`: "`/author-puzzle-batch` is a batch orchestrator. `uv run puzzledb batch-run` owns the normal production dispatch path: non-copy work uses Codex `gpt-5.6-sol` low, independent answer audits use fresh ..."; batch runner constants `INTAKE_LIMIT = 4`, `CONSULT_LIMIT = 1`, `STALL_SECONDS = 6 * 60`, `DEFAULT_SESSION_TOKEN_CEILING = 8_000_000`.
- `psagentspace/roadmaps/product/missions_quests_achievements_v1/pro-heuristic-2026-09-11/NATIVE_V1_2_EVALUATION_EXECUTION.md:15`: "Each reviewer is a new native collaboration.spawn_agent child ... Respect global slots and use at most six simultaneous reviewers." (This is the Sep 12 `evaluation_repair` burst: 1,144 children.)
- `psmobile/AGENTS.md:478`: "parallelism with it when it safely accelerates the work. That request is not permission for skill-backed or external harnesses".
- `arch_skill/skills/conductor/SKILL.md`, `epic-to-prs/SKILL.md`, `delegated-implementation/SKILL.md`, `stepwise/SKILL.md`: worker fleets by design; `agent-delegate/SKILL.md:141` "In parallel groups, tell each child it is not alone in the codebase".
- `arch_skill/skills/codex-review-yolo/SKILL.md:47, 105`, `agent-delegate/references/model-and-invocation.md:363 to 425`, `fresh-consult`, `model-consensus`, `stepwise/references/session-resume.md`: `codex exec` lane recipes (the scripted lanes in the companion doc B7).
- Mitigation: `agent-orchestration-policy.md` "Independent same-provider Codex processes can be materially more expensive than native Codex children ... may contend on Codex's shared SQLite/WAL state; on some hosts this has caused system-wide stalls ... It is not a prohibition, approval gate, or fixed process-count limit".

### F. Account sharing and concurrency

- `aim-rotation.md`: "AIMgr accounts are single-lane in practice: a second process on the same label is rejected while the first is running or refreshing. If the caller permits sharing, record the other active worker or run directory, but do not hammer the account."
- `psagentspace/plans/drafts/2026-09-14-daily-refill-goal-prompt.md:29`: "Treat each AIMgr account as one active lane while it is running or refreshing. When a worker reaches a terminal result or a real usage limit, cancel automatic continuation, stop its owned supervisor and descendants, verify the cleanup, and record the exact account ... After a busy-account rejection or cleanup, wait several minutes before one controlled retry; never hammer the account."
- Session instruction, not a file (`01a08204`, 2026-09-15 13:38Z then 13:59Z): "you don't have to only use one aimgr account per thing, multiple things can use same aimgr account" then "yeah it turns out it does block concurrent usage, my mistake."
- Nothing in any repo addresses the same account being driven from two machines at once; the two-machine overlap in the audit (M5 and `home`) comes from `c`/`cr` on both hosts picking the same next-best label.

### G. Third-party harness exposure

- `arch_skill/README.md:108 to 111, 154 to 157, 200 to 204`: the skill installer mirrors the whole skill surface "into every existing Hermes skill root (`~/.hermes/skills/` and each `~/.hermes/profiles/<name>/skills/`)", so the rotation doctrine above is also present inside the Hermes agents' skill trees. Hermes account assignment itself is aimgr (`aim rebalance hermes`, `aim auth write hermes`), outside the six repos.
- `psagentspace/docs/proposed/2026-09-08-hermes-ops-staging-build-audit-plan.md` and `2026-09-08-openai-agent-instructions-gpt-5-6-sol-guidance.md`: plans to grow the Hermes Ops agent's instructions (no account rules in them).
- No OpenClaw instructions in the six repos.

### H. What is absent

No instruction in any of the six repos or the skill trees says any of: do not move a live session onto a fresh account; do not accept a rate-limit reset while a workload is running; stop dispatching when an account passes a usage threshold; keep named personal accounts out of rotation; do not drive one account from two machines; treat "at capacity" as a wait, not a rotation trigger. The closest are the mitigations quoted in A, B and F (confirm the limit is real, one rotation per event, do not hammer, five-minute polls, one nudge), all of which presuppose that rotation is the correct response.

## 3. Per-repo summary

| repo | account-rotation instructions | capacity/retry loops | Pro browser switching | fan-out | notes |
|---|---|---|---|---|---|
| psmobile | AGENTS.md:486 "run `aim codex use` and retry" | AGENTS.md:482 to 485 intervene on rate-limits | none | AGENTS.md:478 parallelism | 608-line AGENTS.md; nothing on resets or concurrency |
| lessons_studio | docs proposal :213 (rotate and resume) | none | none | AGENTS.md:22 parallel human/agent work note | no `aim` calls in code; lessons generation docs discuss per-account rate limits for Claude |
| puzzledb | docs/GOAL_V4_UPGRADE:47; batch_runner code auto-rotates (`_run_aim_codex_use`) | batch_runner halt/retry categories, one-retry cap for infra halts | none | AGENTS.md:339 batch-run lanes; INTAKE_LIMIT 4 | the only repo where rotation is code |
| psagentspace | AGENTS.md:84 to 85 (read aim-rotation before launch); `_artifacts/herdr-capacity-watch-runbook.md` (full CR procedure); cloud-testing REPO_BOUNDARIES:547 | runbook 5-minute loop; PRIME_AGENT_GOALS_AND_HEARTBEATS mechanism; daily-refill goal prompt retry line | daily-refill goal prompt "Pro2 or Pro3"; issue-to-pr/epic-to-prs via installed skills | NATIVE_V1_2 "at most six simultaneous reviewers"; `.agents/skills` copy of everything | the watcher runbook is the single most consequential file |
| agentspace | none in AGENTS.md (credentials and MCP rules only) | none | none | none | sessions there consumed pool accounts through the shared skills, not repo rules |
| arch_skill | `_shared/aim-rotation.md`; agent-orchestration-policy:73; agent-delegate; conductor:241; codex-babysit; plan-interview doctrine:47,64; docs (CONDUCTOR_UNIFICATION, PRIME_AGENT_VIA_AIM, plan-interview recipe:186) | codex-babysit loop; check-my-agents one-nudge | chatgpt-web accounts reference; issue-to-pr, epic-to-prs, unblocker Pro-switch rules; browseros Work-profile rule | conductor, epic-to-prs, delegated-implementation, stepwise, author-puzzle-batch, codex exec recipes | the source of the doctrine; installed into every other repo and into Hermes profiles |
| aimgr (referenced, not in scope) | `c`/`cr` shortcuts rotate on every launch/resume; `aim codex run/resume` rotate by default; credential-helper `advance`; `aim rebalance hermes` | | | | |

## 4. Mapping to the audit's observed behaviors

| observed behavior (companion doc) | instruction that produces it |
|---|---|
| sessions on 15+ windows in 8 days; `01a09fa4` hopping cfo, fun_country | `c`/`cr` rotate on every launch and resume; aim-rotation "one rotation and same-session retry"; psmobile AGENTS.md:486 |
| watcher rotating rustai and content panes onto pro12, pro14, pro15, office, boss on Sep 10 to 14 | herdr-capacity-watch-runbook.md steps 3a to 3g and the usage-limit addendum |
| 815 to 965 capacity sightings a day with immediate CR recovery | runbook "AT CAPACITY -> run the CR recovery immediately" |
| two reset credits accepted by automation | runbook 3f and codex-babysit step 5 (Enter on the resume menu) plus the watcher's self-written rule |
| `home` box burst: 14 launches in 5 minutes on Sep 14 | `cr` per attempt; no instruction limits attempts (aim-rotation's "one controlled retry" applies to busy-account rejections, not capacity) |
| scripted `codex exec` lanes on lessons, pro17, pro4, office, qa, cfo, growth | puzzledb batch runner (auto `aim codex use`), agent-delegate and codex-review-yolo recipes; each lane takes whatever auth.json holds at launch |
| Pro consults through Chrome under amir@fun.country, pro4, pro1 | chatgpt-web accounts reference; issue-to-pr / epic-to-prs / unblocker Pro-switch rules; owner's standing "if one is limited use the other one" |
| 3 to 8 concurrent subagents per account | conductor, epic-to-prs, author-puzzle-batch, NATIVE_V1_2 "six simultaneous reviewers", user prompts ("batches of four sol agents") |
| same account driven from M5 and `home` simultaneously | no instruction prevents it; both hosts' `c`/`cr` pick next-best from the shared pool |

## 5. Files scanned

Instruction files under: psmobile, lessons_studio, puzzledb, psagentspace, agentspace, arch_skill (including `skills/**` and `docs/**`), `~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills` (identical to arch_skill/skills except two extra local dirs), `~/.aimgr/routines/prompts/*.md`, `psagentspace/scripts/workbook_refresh/routine/daily-sheet-maintainer.md`, `~/.config/aimgr/codex-shortcuts.zsh`. Code grep for `aim codex` / `["aim","codex"]` in *.py, *.sh, *.ts, *.js, *.mjs, *.zsh across the six repos: only puzzledb's batch runner invokes it. The routine prompts contain no account or limit directives beyond "retry at most once" for a Slack send.
