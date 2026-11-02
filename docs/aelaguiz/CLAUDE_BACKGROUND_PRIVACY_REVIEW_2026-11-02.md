# Claude background behavior: privacy review and recommendation

2026-11-02. **Recommendation: disable Claude's optional detached-conversation
system in new AI Manager launches. Keep ordinary terminal sessions, shell
background commands, subagents, skills, MCP and AI Manager schedules.**

There is a real admission gap: a newly checked launcher can give a job to an
existing daemon, which runs the job using its own executable and inherited
sandbox. The new launcher's approval does not approve that actual worker.
Removing the optional detached-conversation feature avoids maintaining a second
execution path with its own admission and upgrade rules.

This is a recommendation, not authorization to remove features. No installed
launcher, active selector, production setting or existing session was changed
for this review. The earlier default-installation work remains paused.

## Requirements and accepted risks

The [Claude implementation plan](CLAUDE_PRIVACY_IMPLEMENTATION_PLAN_2026-11-01.md)
owns the accepted privacy boundary. Its blanket requirement to preserve native
detached conversations is the specific requirement this review proposes changing.
The other background functionality in that plan remains required.

| Concern | Treatment |
| --- | --- |
| Automatic disclosure to Anthropic or its collectors | Prevent disclosure outside authorized task context. |
| Unreviewed Claude executables or privacy helpers | Keep exact-build admission; check the executable doing the work. |
| Protected accounts' IP, device identity and account state | Preserve account isolation, sandboxing and fail-closed routing. |
| Ordinary accounts without proxies | Keep normal local operation without proxy or Chrome dependencies. |
| Simultaneous sessions | Preserve same-account and different-account concurrency; no new cap. |
| Skills, MCP, ordinary subagents, history and AIM schedules | Preserve these workflows. |
| Normal prompts, code, paths, Git history and requested tool output | Accepted task context; no redaction system. |
| Independent services receiving intended requests | Outside this Anthropic privacy review. |
| Malicious tools, deliberate credential theft and root tampering | Accepted risks; do not build another defense system around them. |
| Broad OS family and CPU architecture | Accepted; Mac OS versions are not an approval gate. |
| Remote Control and remote feature flags | Keep the approved disabling for every AIM Claude account. |
| Optional telemetry | Preserve the existing scope; this review does not extend ordinary-account opt-outs. |
| Extra folders or changed custom headers | Keep the accepted new-session requirements. |

Only individual Pro/Max accounts are in scope. The proposal adds no browser,
network failover, identifier redaction, privileged service or distributed process
registry. It does not remove saved conversations or account configuration.

## What Claude actually runs

The reviewed unchanged vendor build is **Claude Code 2.1.316**. These similarly
named features have different lifetimes and privacy implications:

| Feature | What runs | Proposed treatment |
| --- | --- | --- |
| Ordinary terminal conversation | The foreground Claude process and its tools | Keep. |
| Background Bash command | A child shell/tool job associated with the session | Keep. |
| Normal `Agent` subagent | An in-process task, possibly asynchronous | Keep `general-purpose` and ordinary agent use. |
| MCP server | A tool server launched or contacted for the configured MCP | Keep, including authentication and package dependencies. |
| AI Manager routine | AIM selects an account and launches a normal Claude session | Keep. |
| In-session scheduled wakeup | A scheduled turn in the conversation | Keep. |
| Agent view / detached conversation | A shared supervisor plus separate Claude conversation workers | Disable new use. |
| Installed Claude daemon service | A supervisor started through an OS service manager | Do not enable; inventory any existing installation. |
| Remote Control | Claude's separate remote connection mechanism | Keep disabled by the existing policy. |

The detached-conversation supervisor is **persistent across terminal sessions**,
but it is not mandatory for ordinary coding. Its identity is based on
`CLAUDE_CONFIG_DIR`; AIM's separate account directories therefore create separate
supervisor namespaces. It is not one required machine-wide daemon for all accounts.

It starts on demand when a supported detached-session or agent-view path needs
it. Opening agent view can prewarm a worker before a task is submitted. A saved
`defaultToAgentsView` preference can make a plain interactive launch open that
view and start the supervisor automatically. Ordinary `Agent` subagent calls do
not use this supervisor, even when their tasks run asynchronously.

A detached conversation can continue after its initiating terminal exits. In the
inspected build, a transient supervisor exits after its live handles and leases
reach zero: five seconds after it has hosted work, or about fifty seconds if it
never receives work. Those conditions can remain nonzero while workers exist.
The installed-service and explicit foreground-supervisor modes do not use that
transient idle-exit rule. The documented worker-idle retirement interval is a
separate mechanism, so neither closing a terminal nor waiting five seconds is a
reliable shutdown procedure. [Anthropic's supervisor and storage description](https://code.claude.com/docs/en/agent-view#the-supervisor-process).

Read-only inventory of this Mac found **18 saved background-job records in 14 of
44 managed account directories**, dated August 2 through October 29, and **two
live Claude supervisors**. Kernel executable and argument checks confirmed those
two were Claude daemons rather than reused PIDs. This proves prior use, not who
started it. Conversation bodies, credentials and account labels were excluded
from this report. No process was stopped. None of the 42 readable managed app-state records
currently sets `defaultToAgentsView` to true. No standard user/system Claude
daemon-service plist or default-home daemon roster was present. These observations
do not establish how the historical jobs were started.

## Findings that matter to the agreed privacy boundary

| Finding | Evidence and consequence | Address it? |
| --- | --- | --- |
| A checked dispatcher can reuse a pre-existing daemon | Reproduced with identical vendor bytes at another pathname. Source confirms the worker uses its owner's executable. | **Yes.** Disable new detached work, or fully admit the reused owner if this feature is retained. |
| New per-session sandbox settings do not replace an existing daemon's inherited sandbox | Confirmed architecture; newly spawned workers inherit the daemon's process restrictions. | **Yes, through the same removal.** Do not claim a new foreground admission resandboxes an old owner. |
| Existing daemons survive the new disabling flag | The flag affects new processes; old workers can finish or respawn under their existing owner. | **Yes, at the agreed transition.** New-launch gating can start while existing work finishes; do not stop owners automatically. |
| Agent view can start a supervisor without a new explicit `--bg` command | Saved default-view preference and UI prewarming are native startup paths. | **Yes.** Gate agent view as well as the background CLI flag. |
| Later jobs' settings files are not covered by the first launch's exact file-write denial | Native workers still load/pin their supplied flag settings; native persistence explicitly skips the flag-settings tier. No automatic mutation or disclosure was found. | **No additional mechanism.** Deliberate tool mutation is an accepted risk. |
| Hidden worker flags or a tool speaking the private daemon protocol can bypass a UI feature switch | Internal helpers trust their normal parents; they are not standalone security boundaries. | **No new hostile-tool project.** Recheck automatic callers on upgrades. |
| Ordinary background tools can read data the task explicitly asks for | This is intended tool access under the existing threat model. | **No blanket tool ban.** |
| A background job has account identifiers and sends model requests | Those requests require the same account, identity and route protections as foreground work. Persistence alone does not prove another identifier leak. | Keep existing controls; no new identifier service. |

The daemon handoff is a gap in admission, not evidence that a vendor received
private data during this review. The reproduction used synthetic data and a
copy of the **same reviewed vendor bytes at a different pathname**. The old
pathname identifies which owner executed the work; it does not stand in as proof
that a different release was executed. All model/service traffic terminated at
the fixture inside an offsite network namespace with no external interface.

The enabled-background portion also produced two synthetic quota prompts and
four task-status-summary prompts beyond the main task turns. Their contents were
normal task context; this does not establish an additional identifier leak. The
capture alone does not identify which individual process sent each auxiliary
request. It does reinforce that detached execution includes automatic work
beyond the dispatching terminal's single request.

The same-approved-build settings concern should not be promoted into a new
requirement merely because a deliberately malicious Bash command could exploit
it. Exact shipped-code inspection found that native settings writes return
without writing when the destination is the CLI flag-settings tier. The worker
loads the supplied snapshot at launch. This review found no automatic writer
that invalidates those protections.

## A separate daemon-command problem

The experiment also found that passing `daemon run` through AIM's normal launch
runner produced an ordinary synthetic model/tool turn for the prompt `daemon`. It did **not** exercise
the daemon command. Native Claude recognizes `daemon` at the front of its argument
list, while AIM inserts `--settings <snapshot>` first. This ordering also affects
the other daemon-management verbs in that fast path.

Do not use generic AIM passthrough to inspect or stop an existing supervisor.
The implementation should handle these requests locally and clearly, and retain
a specific safe inspection/cleanup path using the exact approved native command.
A disabled feature must not turn into an unintended model prompt.

Direct native `daemon status`, `daemon stop` and `daemon uninstall` remain allowed
by the native disabling gate. Detached-job commands such as `logs`, `stop`, `kill`
and `rm` encounter the disabled agent-view gate. Therefore usable cleanup cannot
be assumed from the flag alone. No production cleanup was attempted in this review.

## The narrow change and its tradeoffs

Use Claude's supported **`disableAgentView: true`** setting and
**`CLAUDE_CODE_DISABLE_AGENT_VIEW=1`** in AIM's enforced launch policy. Pin both at
the appropriate startup stages: setting a shell variable manually is not the
proposed production implementation. Lower-precedence settings, inherited values
and live reload must not silently restore the feature.

Do **not** use `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. That broader switch removes
ordinary background-tool/subagent functionality that is unrelated to the shared
supervisor. Disabling agent view also does not replace `disableRemoteControl`.
[Anthropic's supported agent-view setting](https://code.claude.com/docs/en/agent-view#turn-off-agent-view).

| User-visible behavior | Effect of the narrow switch |
| --- | --- |
| `claude agents`, agent view as the default screen | Agent-view UI is disabled, including its worker prewarming. |
| `--bg` / `--background`, `/background`, left-arrow handoff | New detached conversations are disabled. |
| Background choice when exiting a foreground session | That choice is removed; normal exit remains. |
| Detached-session attach, respawn and related new-worker paths | Native agent-view gates prevent their normal use. |
| `/fork` slash command | Falls back to an ordinary asynchronous subagent instead of a new detached conversation. |
| `--resume … --fork-session` | Saved-conversation fork remains; verified offsite. |
| Built-in `Agent` subtype named `claude` | That subtype disappears. `general-purpose` remains and was verified. |
| Normal shell jobs, ordinary subagents, skills and MCP | Retained; the background-task system stays enabled. |
| Several ordinary sessions at once | Retained; this proposal introduces no session limit. |
| AI Manager calendar routines and in-session wakeups | Remain required; they are separate from agent view. |
| Existing detached jobs, logs and transcripts | The switch does not stop or delete them. |

The built-in subtype difference and `/fork` behavior are real compatibility
changes; they must not be hidden behind a claim that “all agent behavior is
unchanged.” A custom prompt or skill that explicitly asks for subtype `claude`
needs review before rollout. The normal `Agent` tool itself remains available.

The source checks also distinguish Ctrl-Z: in an ordinary foreground REPL it
suspends the Unix process group. In an attached detached session it detaches that
attachment. Neither action creates a new shared daemon. There was no unconditional
“background this conversation on every exit” path in the inspected build.

## Experiments and remaining implementation acceptance

Testing uses the existing GCP development VM, fresh synthetic homes and fake
OAuth values. A private network namespace contains only loopback; a temporary
TLS fixture answers the vendor's normal URLs without forwarding. A private PID
namespace and exact synthetic-config ownership checks contain cleanup. No real
Claude account, browser login or personal project was used.

The actual AIM runner, exact-build gate, native launcher and unchanged vendor
binary run in the integrated cases. These are Linux behavior experiments, not a
new Mac sandbox certification. The Mac executable was inspected separately for
the same native entry paths.

| Check | Result |
| --- | --- |
| Foreground native model turn without a resident shared daemon | Passed. |
| Detached worker and supervisor survive dispatcher exit | Passed. |
| Newly admitted AIM dispatcher reuses prior executable pathname | Passed. |
| Disabled `--bg` refuses while an old daemon is still present | Passed; no request for the rejected job. |
| Disabled interactive agent-view UI and direct native daemon start | Passed; no fresh supervisor, roster or model request. |
| Skills, stdio MCP, Bash, instructions and imports | Passed with the narrow switch. |
| Saved history resume and CLI conversation fork | Passed with the narrow switch. |
| `general-purpose` subagent | Passed; native result records asynchronous execution. |
| Ordinary background Bash, overlapping same-account tools and an AIM routine occurrence | Passed; the routine used substituted Redis, Herdr UI and clock. |
| Protected routes, new Mac launch behavior, HTTP/OAuth MCP and real OS calendar under the proposed new policy | Must pass before implementation rollout. Existing evidence is not relabeled as a test of this new switch. |

A future implementation should add the narrow policy, clear local handling of
daemon-management commands, and the necessary upgrade checks. It should test:

1. Both ordinary and protected starts enforce the gate despite user/project/CLI
   settings and live-reload attempts to undo it. Proxy failures remain loud and
   fail closed; ordinary accounts still need no proxy helper.
2. Supported explicit and automatic entry paths cannot start or reuse a detached
   worker, including a saved default-agent-view preference and an already-running
   same-account supervisor. Safe status and cleanup must remain usable through an
   explicit supported path, without generic prompt forwarding.
3. Skills, stdio/HTTP/OAuth MCP, normal Agent tasks, Bash background tools,
   same/different-account concurrency, resume/CLI fork, nested AIM dispatch,
   actual OS-scheduled AIM routines and in-session wakeups pass on Linux and the
   rented Mac. No physical-Mac experiments or real accounts are needed for the
   synthetic feature tests.
4. Existing ordinary sessions survive installation. Inventory existing detached
   owners separately; preserve their transcripts and stop them only at the agreed
   transition. Do not reinstate a blanket “close every Claude process” gate.
5. The Claude upgrade skill re-examines new automatic daemon entry points,
   settings precedence, hidden helper callers and feature coupling in the new
   exact build. It should investigate unfamiliar paths, not only grep for these
   current flag names. Keep Claude build approval independent of Mac OS versions.

If detached conversations are wanted later, their return requires admission of
the actual reused supervisor and its policy, plus per-job settings, scratch,
route, identity and lifetime tests. That engineering is unnecessary if the
feature is not used. The [Codex standalone decision](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md)
has a similar motivation, but does not justify banning Claude's ordinary child
processes.

## Evidence and review

The new experiment driver is
[`privacy-claude-background-review.mjs`](../../scripts/privacy-claude-background-review.mjs).
It uses the [default-services fixture](../../scripts/privacy-claude-default-services-probe.py)
and the [retained-workflow driver](../../scripts/privacy-integrated-launch-check.mjs).
The fixture's historical `*-disabled` case name means remote feature flags were
disabled; the new receipt's `disableAgentView` field states whether the narrow
background switch was enabled.

Native identities inspected:

- Linux vendor SHA-256: `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824`.
- Mac vendor SHA-256: `64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f`.
- Linux offsite-test artifact set: `4ee0d0923848444dc73897d026ad110ff2bac5a9842129230ccf4c9257a26d9b`.

The static review traced the configuration-derived daemon namespace, supervisor
`doSpawn` / `pinToCurrentBinary` path, native agent-view gates, service entry
points, local Agent execution, settings persistence and transient exit timer.
An independent cold reviewer checked those paths and the accepted-risk boundary.
The reviewer signed off on the corrected report and sanitized receipts, with no
unresolved findings within this review's scope. That sign-off approves the
analysis; it does not approve a production implementation that has not been made.

- [Daemon reuse and native disabling experiment](evidence/claude-background-review-2026-11-02/handoff.json): completed on the offsite Linux VM. The derived command-dispatch analysis distinguishes the ordinary prompt from the direct native daemon probe.
- [Retained-workflow experiment](evidence/claude-background-review-2026-11-02/workflows.json): completed with the narrow switch, including asynchronous Agent, background Bash, two same-account tools synchronized across live sessions, and an AIM routine occurrence.
- [Static review and local inventory](evidence/claude-background-review-2026-11-02/review.json): exact-build scope, source findings, limits and resource cleanup.

The two completed synthetic cases made 16 and 23 model requests respectively,
all to the local fixture. Ordinary-mode receipts intentionally retain ordinary
policy; their exact-kernel observations are not protected-account privacy tests.
Earlier harness attempts exposed a host `/sys` mount mistaken for namespace
interfaces, a missing synthetic permission-consent setting, a non-TTY UI check,
and the daemon-command fallthrough. The final checks use actual namespace
interfaces, a disposable consent setting, a real PTY, and a separate direct
native daemon probe. No failure was attributed to the vendor when the harness
was testing the wrong behavior.

Before sharing the evidence, only summary observations were copied. Raw request
bodies and synthetic credential files remain offsite. The temporary test-only build authorization was revoked. Cleanup confirmed zero
remaining synthetic Claude owners and removed four duplicate research binaries.
No production approval was created.
