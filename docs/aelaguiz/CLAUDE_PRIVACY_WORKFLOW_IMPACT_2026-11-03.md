# Where the Claude privacy rollout disrupted normal work

The privacy implementation broke ordinary agent work before the November 3 Mac
crash. Its largest mistake was making programs launched by Claude inherit
Claude's operating-system restrictions. That prevented nested Claude launches,
broke Chrome startup, and is the likely cause of the recorded Codex reviewer
sandbox failures. A separate cleanup check then blocked session recovery after
the crash.

The Mac correction is installed as of **November 3, 7:12 a.m. CST**. New launches
and resumes let ordinary tools run with their normal host access. The earlier
resume-cleanup and updater-path fixes are installed too. The histories show
workflow changes beyond the errors Amir reported: lesson playtests moved to
another agent's session, a phone run changed models, translation checks pasted
files into prompts, and a code reviewer was restarted without its own sandbox.

Times below are Chicago local time. The incident review covers November 2
through the November 3 morning recovery; the original requirements come from
October 31–November 2. This is an analysis of observed disruptions, not a count
of every error string or an estimate of total time lost.

## What Amir actually asked for

The original conversation explicitly limited this work:

- October 31, 1:46 p.m.: **“My goal is to avoid changes to my workflow.”**
- October 31, 1:54 p.m.: **“We're only worried about leaking data to Anthropic.”**
- October 31, 1:56 p.m.: **“I accept malicious tools as my risk. That's not something you're concerned about either.”**

Those instructions did not authorize restricting every browser, shell command,
reviewer, or child agent. Protecting Claude's automatic collection was the
purpose. Extending that protection to ordinary tool execution contradicted the
accepted tool risk. The later implementation plan and its exclusions cannot
substitute for those user instructions. [Original requirements conversation][scope]

## The work that broke

| Normal workflow | What the history shows | What happened next |
| --- | --- | --- |
| Lesson agents launch simulated players | November 2, 6:55 p.m.: launches on three account labels failed before a player could start. | The coordinator ran the player commands from its older, unaffected session. |
| Coaching agent resumes its phone tester | November 3, about 6:45–6:49 a.m.: Claude startup failed while the other Codex jobs continued. | The phone run moved to GPT-6.1 Terra. A Claude test launch worked after the updater-path repair. |
| SEO agent delegates its morning deck | November 3, 6:48 a.m.: the deck builder failed with the same updater-path error. | The parent inspected AIM code, then used Claude's built-in Agent tool. |
| CFO agent starts its warm-up Chromes | November 3, about 6:59–7:03 a.m.: repeated launch attempts produced no working control ports; a direct probe reported a sandbox initialization failure. | Browser recovery stopped while the agent looked for a different launcher. |
| Codex reviews files from a Claude session | November 2: website translation checks and a PS Mobile plan reviewer could not start their sandboxed shell commands. | The translation workflow pasted files into prompts; the app reviewer was rerun with `danger-full-access`. |
| Sessions resume after reboot | November 3: the influencer resume and the 6:30 a.m. merge-watch launch hit the launch-file cleanup error. | Recovery waited for an AIM fix even though the existing session data remained present. |

### Child agents could not start because AIM denied its own preflight reads

The lesson playtest for **Raise or Fold Over a Limp** failed on November 2,
hours before the crash. The simulated-player agent tried `pro1`, `pro12`, and
`boss`; each failed with `a native update location could not be resolved`.
Changing updater-related environment paths did not solve it. At 6:59 p.m. the
coordinator confirmed that the same launch worked from its older session and
took over executing the player's command files. The round eventually ran;
the privacy change forced the extra coordination. [Lesson playtest history][lessons]

The cause was circular: Claude's inherited policy denied access to its updater
folders, then nested AIM required those folders to be inspectable before it
would start another Claude. Protecting the vendor's updater became a prohibition
on an unrelated, normal operation: delegating work.

The same failure reappeared after recovery in the **Coach Max milestone 5 phone
run** and the **SEO morning deck**. Coaching moved the phone run to Terra; SEO
switched delegation methods after inspecting AIM's source. Coaching's
6:56 a.m. message confirms that a nested Claude launch started and answered after
the repair. It sensibly left the already-running Terra phone job alone.
[Coaching failure and recovery][coaching] · [SEO deck launch][seo]

This also caused unnecessary permission questions. At 7:05 a.m., the lesson
coordinator was still asking Amir whether it could launch the reader and writer
from a Herdr pane, although those launches would still use `aim claude run` and
the approved build. The session had diagnosed the earlier failure and had not
demonstrated another failure after the fix. A runtime bug had become another
decision handed back to Amir. [Lesson coordinator's request][coordinator]

**Correction:** [The updater-path fix][updater-fix] handles the denied parent
view while retaining the final native path validation. [The tool correction][tool-fix]
then removes the inherited restriction from ordinary tool execution altogether.

### Chrome inherited a policy that prevented its own helpers from starting

The CFO session was restoring its warm-up browsers and timer after the crash.
Its normal browser script repeatedly left ports 9351, 9352, and 9356 closed.
A direct Chrome launch at 7:02 a.m. recorded `Failed to initialize sandbox`,
followed by GPU-process exit code 6 and Chrome termination. This was a local
process-startup failure; a browser could not get far enough to do the task.
[Browser recovery history][chrome]

The native launcher had exceptions allowing only itself, `ps`, and `sudo` to
leave its sandbox. Everything else inherited it. That was unnecessary machinery
for the tool risk Amir had accepted, and adding a special Chrome exception
would have left the next ordinary program vulnerable to the same problem.

**Correction:** ordinary executable tools now leave Claude's sandbox. The actual
vendor image and direct vendor self-spawns retain their policy. The production
launcher regression passes in ordinary and protected account modes, including
real Chrome rendering a local page with Chrome's own sandbox enabled. The old
launcher fails the ordinary-tool regression. This repair does not disable
Chrome's sandbox or change proxy routing. [Change and verification][rollback]

### Reviewers worked around the restrictions by changing how they reviewed

On November 2 at 1:56 p.m., the website's **five-language fact-sheet review**
could not use the intended Codex file-reading workflow. The Spanish and German
results shown in the parent history explicitly report
`sandbox-exec: sandbox_apply: Operation not permitted`. The parent then rebuilt
the prompts for Spanish, German, Japanese, Italian, and Korean with the source,
translation, and glossary files pasted in full. The translation checks did
complete, but only after changing the review workflow. [Translation history][translations]

At 9:02 p.m., the **PS Mobile report-card plan reviewer** could not read the plan
or source. Its result said: “Even `/bin/pwd` fails” with the same sandbox error.
An MCP fallback was also refused by the reviewer's approval configuration. The
parent restarted Codex using `-s danger-full-access` while instructing it to
remain read-only; the next recorded file read succeeded. [App review history][app-review]

These histories prove the failures and the workarounds. The shared error and
Claude parent process make inherited AIM restrictions the likely cause; I have
not replayed those exact Codex sessions to isolate every layer. Today's change
removes the AIM sandbox from newly launched Codex tool processes, and the Chrome
regression proves that an ordinary child can establish its own sandbox. It is
not evidence that every historic Codex error had this cause.

The practical result was backwards: extra protection pushed an agent to remove
the reviewer's own sandbox just to read a file.

### Optional cleanup prevented recovery across accounts

After reboot, recorded device numbers no longer matched the mounted disk:
`16777230` became `16777233`, while the reported inode numbers still matched.
The old cleanup code treated that mismatch as a reason to refuse a new Claude
launch: `previous Claude launch files could not be retired safely`.

A read-only replay against **338 launch receipts across 28 inspected accounts**
found **335 receipts with mismatched identities**. The previous code rejected
**17 of those 28 accounts**; the corrected code rejected **0** for this check.
Other accounts took existing preservation paths, so stale receipts did not mean
every account actually failed. This corrects the recovery agent's earlier
statement that any affected account would be blocked. The replay intercepted
all deletion operations and deleted nothing. [Replay results][retention-evidence]

The influencer resume failed in the recovery history. Amir also supplied the
6:30 a.m. `pm-merge-watch` launch with the same error. The crash killed work;
AIM's cleanup rule separately prevented that work from being resumed.
[Recovery history][recovery]

**Correction:** [Preserve unverifiable old launch files and continue][retention-fix].
Not knowing whether a file can be deleted safely justifies retaining it. It does
not justify refusing an unrelated new session.

## Other rollout mistakes and limits that still matter

### The default picker selected accounts the runtime would reject

On November 2 at 1:24 p.m., Amir's normal `aim claude run opus` failed with
`requires a verified individual Claude Pro or Max OAuth account`. The account
selector was still ranking accounts that the new runtime would not admit.
[Original failure and investigation][account-selection]

[The selector repair][selector-fix] stopped automatically choosing unsupported
accounts. Explicit resumes still encountered the restriction: at 6:53 a.m. on
November 3, the Cratejoy **Order Sync app-review session** failed that check. The
recovery agent then resumed it on `pro27`; the following trace shows the session
running. It is not still blocked in that recovery trace. [Cratejoy recovery][cratejoy]

Amir had answered “only individual Pro/Max accounts” during requirements
gathering. That explains the implementation's assumption; it does not establish
that removing access to existing Team-account sessions was an understood
tradeoff. The inventory and the assumption disagreed. The account-type limit
remains, and today's ordinary-tool correction does not change it.

### The selected Claude binary moved away from the approved build

The installation record says the mutable `~/.local/bin/claude` link pointed at
unapproved 2.1.317 at 7:48 p.m. on November 2, blocking new launches. The approved
2.1.316 link was restored at 7:53 p.m.; 2.1.317 was subsequently reviewed and
installed. The record does not identify which process changed the link, so
attributing it to a particular updater would be speculation. [Installation record][installation]

Checking the exact vendor build was requested. Letting the normal command's
selected binary drift away from the installed approved runtime was the rollout
failure. The current installation points to approved 2.1.317.

### Claude's own file tools still have a narrower view than shell tools

At 5:21 a.m. on November 3, the influencer agent's native Read tool received
`EPERM` opening its reviewer's `run-35/final.md` under psbrain's `.local-sources`.
It then used the shell to read the file. Its continuation notes also record
using shell/Python writes where Write failed outside the current directory.
[Influencer history][influencer]

This is a recorded workflow mismatch, but it is not enough to label every such
denial an unauthorized protection. Amir explicitly accepted starting a new
session to add folders outside the initial grant. The question to resolve in
each case is whether a required task file was omitted at launch or a new folder
was introduced later. Today's fix restores ordinary tools; Claude's own native
Read/Write restrictions remain. The file-grant cases have not been proved fixed.

## Why the work went beyond the request

1. **An accepted risk was treated as a problem to solve.** Restrictions intended
   for the vendor process spread to tool descendants, despite the explicit
   acceptance of tool risk. A sequence of executable exceptions hid that scope
   error instead of removing it.
2. **Checks were made prerequisites for unrelated work.** A cleanup identity
   mismatch and an inaccessible updater path both became reasons to refuse an
   otherwise valid session.
3. **The release checks missed normal combinations.** The installation evidence
   covered Read, Bash, Skill, MCP, and resume. It did not establish that a newly
   restricted parent could launch another Claude, a sandboxed Codex reviewer,
   or Chrome. Passing individual tools did not establish ordinary workflows.
4. **Agents absorbed failures into their workflow.** They relayed commands
   through older sessions, changed models, pasted source into prompts, and
   requested more permission. Those adaptations kept some work moving while
   making the regression look like a permanent operational rule.

The immediate correction removes the broad tool restriction instead of adding
more application exceptions. Future changes to this runtime should be checked
against these actual workflows, including a resume after a disk identity
change. No new approval service, launcher, or per-application permission list is
needed to learn that lesson.

## What this review does not call overreach

Amir explicitly accepted stopping a session when its assigned proxy fails,
telemetry opt-out feature losses, fixed headers until the next session, and a
new session for additional folders. He also approved the detached-conversation
change. Those decisions should not be silently reversed as part of this repair.
The canceled proxy-restart request was not acted on.

The crash's lost temporary files, stopped jobs, and lost in-session timers are
separate from AIM refusing their recovery. Codex's ordinary read-only write
denials, Android device permission logs, and unrelated application failures were
excluded unless the trace connected them to this rollout. There is no supported
total for lost hours or missed business output.

## Evidence and current installation

The review used the agent-history reader across local Claude and Codex account
homes, including Claude sidechains, followed by reads of the relevant parent
conversations. Repeated copies, summaries, and search hits were not counted as
independent incidents. Full histories remain local; only this analysis is added
to the repository. Evidence links below open the local readable extracts or the
original requirements transcript.

The Mac native change is [committed and pushed][tool-fix]. Its
[installation receipt][installed] records activation at 7:12:33 a.m. CST, passed
ordinary/protected tool regressions, real Chrome, and the installed native
doctor. Existing processes were not signaled and retain their old policy until
resumed. This repair changed the Mac runtime; it did not deploy Linux artifacts.

[scope]: /Users/aelaguiz/.aimgr/codex-cli/sessions/2026/10/31/rollout-2026-10-31T12-16-36-01a192f6-96f9-7503-9fa4-d35ee2999f9d.jsonl
[lessons]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131532Z-read-53e57a5c-3/transcript.md
[coaching]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131320Z-read-53e57a5c-2/transcript.md
[seo]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131605Z-read-53e57a5c-2/transcript.md
[coordinator]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131533Z-read-53e57a5c/transcript.md
[chrome]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131320Z-read-53e57a5c/transcript.md
[translations]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131532Z-read-53e57a5c-2/transcript.md
[app-review]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131532Z-read-53e57a5c/transcript.md
[retention-evidence]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-launch-retention-reboot/retained-records.json
[recovery]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131608Z-read-53e57a5c/transcript.md
[account-selection]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131410Z-read-44ca167f/transcript.md
[cratejoy]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131608Z-read-53e57a5c/transcript.md
[installation]: /Users/aelaguiz/.local/share/aimgr/INSTALLATION.md
[influencer]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-workflow-history-audit/20261103T131605Z-read-53e57a5c-3/transcript.md
[installed]: /Users/aelaguiz/.local/share/aimgr/local-verification/20261103-tool-sandbox-rollback/installation.json
[rollback]: CLAUDE_TOOL_RESTRICTIONS_ROLLBACK_2026-11-03.md
[tool-fix]: https://github.com/aelaguiz/aimgr/commit/3db922842e1732360c2cddb5106d5fdddc8b2145
[updater-fix]: https://github.com/aelaguiz/aimgr/commit/191e41427e8848ac210eb6ed673bcd9ecbe4e439
[retention-fix]: https://github.com/aelaguiz/aimgr/commit/b2c3d567b0d380cd5401c645a050a61b032fca0c
[selector-fix]: https://github.com/aelaguiz/aimgr/commit/3e6c5ed04e065fe136d2ec9bb5ab90b2ba5615a9
