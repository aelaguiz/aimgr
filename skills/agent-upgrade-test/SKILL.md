---
name: agent-upgrade-test
description: "Test a new official Claude Code version against AI Manager's agreed privacy and workflow requirements, using offsite sandboxes, exact artifacts, retained evidence and a cold code review. Use when explicitly asked to audit or sandbox-test a Claude upgrade before approving it for use. Claude only for now; Codex testing is not implemented. Not for launching an existing session (aimgr), simply repairing a missing installation, or general skill authoring (skill-authoring)."
---

# Test an agent upgrade

Help Amir adopt a new Claude release without giving Anthropic identifying
information he chose to protect or making him change how he works. You are
investigating what this release actually does. The existing implementation,
test matrix and earlier reviewers can all have missed something. Your job
includes discovering that, explaining its consequence and testing a remedy.

A useful result explains why the protections hold, where the evidence ends,
and whether the candidate still supports his work. Green tests alone cannot
answer that. This skill implements **Claude only**; Codex needs its own
investigation and implementation, not Claude evidence under a different name.

## Understand the privacy boundary

The distinction that matters is between information Amir deliberately gives
Claude to do his work and information the software collects about the person
or machine doing it. A project path in a requested build result is accepted
task context. The same bytes collected by an idle diagnostic can have a
different purpose and cross a protected boundary. Judge the source, trigger,
recipient and use, rather than deciding from a field name or whether it looks
like personal data.

Protected accounts hide home IP from Anthropic and its collectors, including
browser sign-in, and prevent unwanted automatic collection of unrelated files,
identifying device/OS/terminal details and shared installation identity. A
collector acting for Anthropic is part of that boundary even on another domain.
Independent services receiving their normal data are an accepted risk. Tools
retain their normal power under the accepted malicious-tool risk; that does
not permit Claude to automatically upload inherited tool credentials.

Preserving the workflow is part of success. Removing MCP or serializing sessions
can make a privacy test pass by removing the work Amir needs to do. Conversely,
reopening an accepted browser fingerprint or task-content risk consumes effort
without delivering the privacy he asked for. The decision record below tells
you where he drew these lines; do not extend an acceptance to a different
mechanism just because both are called telemetry or fingerprinting.

## Form an explanation you can test

Build your understanding from the candidate, not from yesterday's list of
endpoints and identifiers. Follow how information enters the process, what
persists or is transformed, which process can send it, and what the recipient
could learn or link. Include the wrapper, vendor process and any helpers that
inherit access or survive it. A privacy boundary exists only if it covers the
actual route the information takes. Changing a filename, an encoding or the
process that transmits it does not change the consequence for Amir.

A newly checked client can hand work to an older process that actually sends
requests. Follow that owner through startup, reuse, detach and upgrade: whose
executable, settings, account and route does it use, and how long do they survive?
A background shell build is intentional tool work; a supervisor accepting future
conversations after the checked client exits is a different lifetime boundary.
Today's daemon flag is evidence of one implementation, not a complete list of
future ways to cross it. Test an enabled old-owner control before concluding a
new launch cannot reuse it, without weakening the production entry for tests.

Let unfamiliar behavior change the investigation. Static differences suggest
places to look; runtime observations can contradict the apparent source path.
A new helper, unexplained state or request field deserves a causal explanation,
not an automatic failure or a pass because the matrix never mentioned it.
Choose experiments that distinguish plausible explanations. Vary synthetic
inputs independently and compare lifecycle/account boundaries where the
explanations predict different behavior. Follow a finding into a new probe
when the existing instruments cannot answer it. This is authorized investigation
within the test boundaries, not a reason to ask Amir to design the experiment.

For example, a stable opaque value might come from the account, a machine
identifier, a copied test fixture or a functional session token. Its stability
alone does not establish which. Separate those causes before deciding whether
it links accounts through the device. If it turns out to be an account-private
functional ID, indiscriminately removing it can break authentication without
improving the protection Amir chose. If it follows the device across accounts,
the absence of a readable hostname does not make it harmless.

Separate what you observed from what you infer: a read establishes access; an
outbound value may establish disclosure; a denied connection may show an attempt
but not its contents. Ask what your instruments miss. A mock model endpoint can
hide the default startup or failure path; an unexercised baseline cannot show a
protection working. Use controls that make the competing explanation visible.
If a finding cannot yet be resolved, say what would resolve it and pursue that
work. Neither speculation nor a blind instrument supports a safety claim.

The canonical tests preserve known promises. Use them alongside this inquiry;
they are not the boundary of what you may discover. Add focused regression
coverage for a demonstrated mechanism. Do not turn every observation into a
permanent ban or build a framework merely to classify findings. Completion
means the required workflows are demonstrated and consequential observations
have a supported explanation or an explicit unresolved limit. It does not mean
an arbitrary number of experiments, nor an impossible proof against every
accepted risk. A cold reviewer should be able to challenge your explanation.

## Establish the actual candidate and agreement

Locate the aimgr checkout from the working context or the installed AIM wrapper.
Verify its identity and revision before reading or changing it. The skill may
be installed outside the repo. Do not search the whole home/workspace or assume
the live launcher should follow your development branch. Preserve unrelated
edits; use an isolated checkout for candidate fixture/code changes.
If that checkout predates the sources below, use its Git worktree/branch metadata
to locate the reviewed checkout that contains them. Keep that source identity
explicit; do not update a live launcher's checkout merely to load this skill.

Read these paths **in that checkout**:

- `docs/aelaguiz/CLAUDE_PRIVACY_IMPLEMENTATION_PLAN_2026-11-01.md`: current
  target list and scope in sections 1–2, native design in section 4, acceptance
  matrix T01–T24 in section 6, offsite operation and upgrade playbook in 7–9.
- `docs/aelaguiz/AGENT_UPGRADE_TEST_SKILL_PLAN_2026-11-02.md`, section 2:
  audited accepted decisions. Later explicit user decisions take precedence.
- `docs/aelaguiz/CLAUDE_DETACHED_SESSION_REMOVAL_PLAN_2026-11-02.md`: the later
  approved detached-session scope and retained-background test contract.
- `README.md`, “Installing a reviewed Claude runtime”: exact bundle retention,
  fixed-release installation and the earlier missing-bundle failure.

Read complete relevant sections in bounded chunks; these documents have long
table rows. A truncated response is not a completed read. Read the remaining
implementation/evidence sections when comparing the candidate with its baseline.

Read selected/approved/running identities with `aim claude privacy status --json`
or the new checkout's `node /absolute/path/bin/aimgr.js claude privacy status --json`
if the installed launcher predates that command. Neither executes Claude. Inspect
the candidate's official provenance, bytes, version, package/helper inventory,
policy and native enforcement. The lock protects against unreviewed Claude code;
it must not force disruptive OS upgrades or synchronized OS versions across
Amir's machines. Record the test OS as evidence, without an exact-release gate.
A different OS release alone is not a launch failure; inability to apply the
sandbox still is. Never execute an unapproved candidate for `--version`. An
installation filename is a hint, not a verified version or approval.

Keep current approved sessions and the selector intact while testing. Record
the exact candidate and source hashes, test authorization, platform/OS and test
hosts in a dated run document under `docs/aelaguiz/`. Approval of another version
or a matching display version does not approve changed bytes.

## Apply the decisions already made

Routing fails closed at startup and during work, with clear failure and no
fallback, automatic switchover or replay. Ordinary accounts need no proxy/CDP
infrastructure. All AIM Claude sessions still require exact-build admission and
disabled Remote Control/remote flags; ordinary telemetry is not globally opted out.

Prompts, source, paths, Git, history, memory and requested tool output are
accepted context. Broad OS
family/architecture and the existing browser footprint are accepted; exact OS
version, host/hardware IDs, terminal versions and shared device IDs are not.

Keep skills, MCP and its auth/packages, concurrent same/different-account sessions,
native development, basic terminal, live admitted-path edits, history/resume/fork,
trusted nested AIM dispatch, ordinary background Bash/local subagents, maintenance
and schedules.
Optional personal hooks/plugins, terminal extras, voice/realtime and GUI extras
need not be preserved; infrastructure used by required skills/MCP and AIM routine
hooks does. Claude's optional detached-conversation/agent-view system is now
excluded by explicit user decision. Keep its narrow startup/settings suppression;
this is not a ban on ordinary background tasks. `/fork` may use an asynchronous
local subagent; CLI history fork and `general-purpose` must remain.

Already accepted: individual Pro/Max only; telemetry/remote-flag feature losses;
custom provider-header edits in a new session; a new protected session for folders
outside its initial grants, with startup `--add-dir` still working. Other settings
remain live. Reuse the agreed transition and offline-cache rules. No new session
cap, redaction, credential broker, browser hardening or daily user steps.

## Run the offsite comparison

Read [Claude fixtures and evidence](references/claude-tests.md) before preparing
or running tests. It points to executable fixtures and their actual prerequisites.

Vendor execution belongs only on the designated GCP Linux VM and rented test Mac,
using synthetic homes/projects/keychains and separate test Redis. Private host
and sacrificial-account notes are accessed privately; their absence blocks the
dependent live tests, not safe source work. Do not run vendor binaries on Amir's
physical Macs, copy personal state, or use production Redis. Establish externally
verified outbound denial before candidate execution; mock services are local.
Test authority must bind the exact artifact set to its offsite host and expiry.

Existing fixtures deliberately pin a specific release. Inspect their fixed
version/hash/commit and assertions, retain the original baseline, and prepare
candidate copies with the independently verified new identities. Review that
diff before execution. Keep integrity, host, routing and authorization checks;
never make a wildcard or bypass so the new version passes an old fixture.

Map every T01–T24 item to pass, fail or not-run, with commands, final artifact,
source/OS identity and evidence. Repeat candidate admission/update/settings,
Remote Control, telemetry, ordinary/protected operation, routing/failures,
concurrency, skills/MCP, tools, history and actual scheduling for each platform
being approved. Native/policy changes require both platforms. Test changed paths
and discovered alternatives. Investigate the default service paths under
outbound denial as well as mock model traffic, across startup, idle, work and
failure; telemetry opt-out says nothing by itself about functional requests.
A timeout,
skipped native test or broken positive control is not a pass.

After synthetic gates pass, use **only proxy5 and proxy6** and their assigned
routes for real model/tool overlap, refresh/usage, history and calendar execution.
Any necessary real browser sign-in uses the **original local account Chrome/CDP
and tunnel**, preserving cookies/profile/host. Never create a rental browser or
copy the profile. Stop **all work immediately** on an actual human-verification
challenge; report the action, account/browser and challenge, and wait for Amir.
A merely loaded CAPTCHA library is not itself a challenge. Do not retry or change
the browser to get around it.

Repair regressions and rerun affected checks until the candidate meets the agreed
requirements. Missing infrastructure or an unresolved compatibility conflict stays
explicitly unverified. Continue independent work, but do not promote partial
evidence into approval or remove required functionality to obtain a pass.

## Review, retain and make adoption possible

Obtain a cold code review in a new clean context. Read the shared orchestration
policy supplied with the installed `skill-authoring` skill
(`../_shared/agent-orchestration-policy.md` relative to that skill's directory)
and model-routing guidance for dispatch. These installed authoring dependencies
are separate from the aimgr checkout and this package's location.
Give the reviewer the user decisions, candidate/code/fixture diffs, complete
matrix, raw evidence location and sanitized findings. Ask it to assess the
explanation of how privacy is preserved and look for something the investigation
missed, including places where the old tests give false confidence. Let it
reject your theory, choose other evidence and identify a different mechanism;
agreement with your checklist is not an independent review. Its assessment
must also cover evidence quality and required functionality. The reviewer is read-only: no vendor
execution on its host, account/browser use, cloud mutations or external agents.
Check the workspace diff afterward; resolve findings and recheck affected evidence.

Before rental cleanup, preserve the **entire exact tested bundle** in durable
restricted storage: vendor, native launcher, credential adapter/helpers, policy
and manifest. Record source and digest; retrieve into a fresh directory and verify
the complete inventory. A source archive or report cannot replace missing native
bytes. New helper/policy bytes are a new artifact set, even with the same Claude.

Tests and cold review establish readiness; explicit human normal-use approval
authorizes the named artifact set. Reuse an existing specific approval only when
it actually covers those bytes and scope. Prepare the concrete installation and
reviewable evidence before asking for a missing decision. A test-only record may
not be relabeled as normal-use approval, and the temporary old-launcher recovery
from November 2 is not permission for another bypass.

When installation is authorized, use the README's fixed-release sequence and
file-only installer. Stage first, coordinate affected owners/schedules, activate,
verify ordinary/protected modes as applicable and preserve compatible rollback.
Do not kill unrelated sessions or point a live wrapper at a branch that will move.
Keep failed occurrences failed; do not automatically replay or resume work.

Return what Amir can act on: tested candidate/version/platforms; required outcomes
and unresolved limits; cold-review result; retrievable bundle location/digest;
normal-use approval and installation state. Keep private identifiers, credentials,
cloud/browser bindings and raw account traces out of public evidence. Finish
task-owned processes and temporary rules; verify instance termination and host
release separately, retaining bounded cleanup until release is confirmed.
