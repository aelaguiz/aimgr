# Claude upgrade testing skill: plan and accepted-risk audit

2026-11-02. Scope: a reusable, explicitly invoked skill for reviewing a new
official Claude Code build through AI Manager. Codex is a future extension;
this work does not implement or certify Codex. **Cold plan review passed before
implementation**; the reviewer found and resolved the candidate-fixture pinning
gap. **The skill is implemented, installed, behaviorally tested and cleared by
final cold review**, including the requested intuition-building revision.
Runtime bundle recovery is complete; local activation remains unfinished for
the prerequisites recorded in section 7.

## 1. What Amir requested

Exact request, 2026-11-02 at 06:27 Central:

> Get us on `main` first of all. Review all of our work on Claude and make sure I didn't miss anything that I already explicitly accepted as a risk factor.
>
> What I want you to do is develop a plan to build a skill-authoring-based skill. That will eventually do both Codex and Claude but for now just does Claude, which is the skill I invoke to do sandbox testing of a new version of Claude and make sure that it's fully safe. Put that plan together, have a code reviewer review it, and then implement and test the new skill.

Subsequent requests: improve runtime errors to identify selected and approved
versions; install the approved bundle so coding works; document installation
mistakes. Amir specifically authorized temporarily restoring the previous
launcher while the missing bundle is rebuilt and verified. That recovery is
not a standing exception to exact-build admission.

Amir subsequently asked that the skill teach understanding and review through
`intuition-building`, so an agent can discover risks nobody listed. The skill
must explain the privacy goal, causal investigation, evidence limits and the
cost of removing workflows. Existing tests retain known guarantees; they do not
define the permissible investigation or establish safety by themselves.

The main checkout is on merged `main`. Work proceeds in an isolated worktree,
preserving unrelated local edits and the fixed previous launcher. The original
test suite and cold review passed, but the complete Mac runtime was not retained
before rental cleanup. Installation is therefore unfinished, not a successful
delivery inferred from test reports. See the [installation notes](../../README.md#installing-a-reviewed-claude-runtime-without-interrupting-coding).

## 2. Audit of decisions already made

Authority: the exact user turns in this session, including the answer together
with the question for each explicit decision; the [implementation plan](CLAUDE_PRIVACY_IMPLEMENTATION_PLAN_2026-11-01.md)
sections 1–2; and the [original worklog](CLAUDE_PRIVACY_PROXY_WORKLOG_2026-10-30.md)
section 1. Earlier experimental gaps are historical, not new requirements.

| Accepted decision | Effect on future reviews | Boundary still required |
| --- | --- | --- |
| Independent Figma/GitHub/Redis/registries receive ordinary data; incidental routing changes are okay | No universal third-party firewall, DNS privacy or traffic prohibition | Anthropic and collectors acting for it stay in scope |
| Malicious tools, deliberate credential theft and privileged tampering | No hostile-tool sandbox, credential broker or replacement credential store | Claude's automatic collection and ordinary routing failures remain covered |
| Normal prompts, source, directories, Git, memory, history and intentionally requested tool output | No redaction, project copies or content-correlation prevention | Unrelated automatic device/file collection is not task context |
| Original local Chrome, cookies and existing fingerprint; no extra hostile-browser hardening | No VM sign-in browser, profile copy, spoofing, Chrome firewall or adversarial extension project | Browser home-IP exposure is expressly rejected, including first navigation and tunnel loss |
| OS releases may differ across machines and change independently of Claude | No exact OS-version gate, OS allowlist or synchronized-update requirement; tested OS is informational | Exact Claude/helper/policy hashes, platform/architecture and successful native enforcement still required; automatic exact-OS disclosure remains protected |
| Broad OS family and CPU architecture | `MacOS`, `darwin`, `arm64` are acceptable | Exact OS version, hostname, hardware UUID/serial, terminal version and cross-account installation IDs are protected |
| Telemetry opt-out losses; remote feature flags disabled for all Claude accounts | Experimental-feature losses caused by those switches need no new permission | Required skills/MCP, concurrency and schedules must still work; ordinary Claude telemetry is not globally opted out by the separate Codex decision |
| Individual Pro/Max only | Team/Enterprise functionality is not required | Actual credential eligibility must be established; unknown eligibility refuses |
| Custom provider HTTP headers fixed within a session | Header edits apply to a new session | Unrelated live settings remain live |
| New session for folders outside initial grants | In-session `/add-dir` expansion need not work for protected sessions | Startup `--add-dir`, admitted-path live edits and native development remain required |
| Optional personal hooks/plugins, terminal extras, realtime/voice, GUI and extra integrations not needed | Do not preserve those optional surfaces merely because they exist | Preserve skill/MCP dependencies, basic terminal and AIM routine hooks; no blanket Claude background ban inferred from the Codex daemon discussion |
| Fail closed and debug the failure where it occurs | No automatic failover, fallback, replay or switchover | Clear startup and mid-run failure; healthy sibling sessions continue |
| Scheduled stopped transition and previously validated offline assignment cache | Reuse existing coordination, no distributed revocation/controller | No session cap, permanent stop-all workflow or silently ordinary launch after protection failure |
| Specific temporary restoration of the previous launcher on 2026-11-02 | Coding can continue under the explicitly accepted earlier protections during recovery | Does not approve another downgrade, unreviewed candidate or permanent removal of the sandbox/build lock |

No accepted risk above needs to be reopened merely because a test demonstrates
it. A new automatic fingerprint, changed route or required feature loss is a
different decision and cannot be silently added to this table.

One important distinction in the existing implementation: required inherited
tool/MCP environment variables remain readable by the vendor. Retained tool
functionality is accepted; arbitrary automatic upload of their contents is not.
Future reviews must observe those automatic paths and record the actual limit,
not invent an acceptance of secret telemetry. Likewise, account IDs, protocol
version and account-private functional IDs are not machine anonymity promises.

## 3. Package and ownership

Create `skills/agent-upgrade-test/SKILL.md` with a provider-neutral name and an
explicit Claude-only implementation boundary. Add `agents/openai.yaml` to make
invocation explicit and give the user a discoverable display name. A single
conditional reference, `references/claude-tests.md`, maps test phases to the
existing AIM fixtures and the canonical plan. No new runner, controller,
approval service, daemon or test framework.

The entry owns the decision process, evidence bar, accepted-risk boundary and
review/approval separation. The reference owns executable test discovery and
the retention/installation checks. Detailed requirements remain in the
canonical Claude implementation plan. The skill locates a verified aimgr
checkout from the working context or known installation and does not assume
its installed directory is inside that checkout. Missing private test-host or
route notes block dependent live tests, not safe source/synthetic work.

Use skill-authoring with prompt-authoring and intuition-building. The entry
teaches how to trace a disclosure from its origin to its recipient, investigate
competing explanations, recognize the limits of an instrument and distinguish
an accepted exposure from a new mechanism. Concrete examples illustrate where
the answer changes rather than defining a lookup table. Fixed rules remain for
actual user decisions, authorization and test-host safety. The investigative
method remains open to unexpected behavior and different experiments.

## 4. Behavior on an upgrade

1. Inspect current, selected and candidate artifacts without running an unknown
   binary, even for `--version`. Preserve existing approved owners and selector.
   Record version, official provenance, hashes, AIM revision, platform/OS,
   policy/helper inventory and test authorization. A version name is not approval.
2. Use only the designated offsite Linux VM and rented Mac, synthetic homes and
   separate test Redis. Establish externally enforced outbound denial before
   executing a candidate. Real tests use only proxy5/proxy6 through their
   assigned routes. Actual browser auth stays in the original local Chrome/CDP.
   Stop all work on an actual human-verification challenge and report its trigger.
3. Compare baseline/candidate automatic reads, persistent state, environment,
   descriptors, OS APIs, request fields/destinations, settings precedence,
   remote control, updater/self-spawns and process lifetimes. Test default
   service paths under outbound denial as well as mock endpoints. Use paired
   synthetic positive controls and vary identifying inputs to find transformed
   or new opaque IDs. Never intercept real provider TLS.
   Existing candidate installers/probes deliberately pin 2.1.316 and its hashes;
   they cannot be run unchanged against a later release. In the upgrade's isolated
   source checkout, inventory these fixture pins, preserve the old fixtures for
   the paired baseline, and update the candidate copies to the exact independently
   acquired vendor bytes/version/commit and complete newly built helper/policy
   set. Keep host, route, artifact integrity and bounded test-authorization checks.
   Review the fixture diff before execution; never replace a fixed hash with a
   wildcard, environment bypass or an approval inferred from the candidate itself.
   Candidate policy is new evidence, not a relabeled old receipt. No generic
   runner is needed to make these deliberate, reviewed fixture changes.
4. Carry every canonical T01–T24 acceptance item into a dated run record with
   pass/fail/not-run, commands, artifact/source/OS identities, evidence and
   unresolved limits. Every upgrade repeats common admission, updater, settings,
   Remote Control, telemetry, routing/failure, concurrency, skills/MCP, tools,
   history and actual scheduling tests on each platform being approved. Platform
   policy/native changes require both Linux and Mac; changed paths get their
   additional negatives. Old evidence is a comparison baseline, not candidate proof.
5. After synthetic gates pass, exercise real sacrificial model/tool overlap,
   refresh/usage, history and a calendar occurrence through assigned routes.
   Preserve A1/A2/B concurrency, ordinary no-proxy operation, required MCP OAuth,
   nested same/different-account dispatch and background/saved jobs. A skipped
   native test, inaccessible browser, baseline failure or interval-only test
   cannot be marked as full acceptance.
6. Repair implementation regressions without silently enlarging acceptance or
   removing required behavior; rerun affected evidence. Request a cold code
   reviewer in a new context to inspect changes, actual evidence, the complete
   matrix and accepted exclusions. Give authoritative inputs, not a preferred
   verdict. Review is read-only; no vendor launch on the reviewer host.
7. Retain the complete exact tested bundle in durable restricted storage and
   prove fresh retrieval and complete hash verification before rental cleanup.
   Exercise clean staging, failed activation retaining old wrappers, dependency
   installation and compatible rollback offsite. Then prepare the concrete
   exact-artifact normal-use approval and installation. Existing explicit
   approval applies to its named bytes, never automatically to a new hash.
8. Stage/install only within authorized normal-use scope, using a fixed release,
   administrator ownership and the agreed transition. Keep saved state and
   schedules, no unsolicited resume/replay. Verify selected/approved versions,
   applicable OS compatibility and relevant smoke tests before switching users.
   Preserve cleanup receipts and remove only task-owned processes/resources.

The result is a bounded privacy/compatibility assessment, installable artifacts
and a cold review. It is never a guarantee against the accepted content, tool,
browser or privileged-tampering risks. If a required test cannot run, state the
unverified item; continue independent useful work without claiming completion.

## 5. Runtime repair and installation work in this change

- Finish diagnostics showing selected version without executing it, approved
  version for the launch, exact refusal and actionable repair. Filename-derived
  versions are explicitly unverified; invalid/missing approval is never trusted.
- Recover the exact original Mac bundle, or rebuild it offsite and compare its
  full digest. Changed helper/policy bytes need new verification and review;
  preserve the new bundle before cleanup. Do not claim original evidence proves
  different bytes. No new vendor version is needed merely to fix missing files.
- Prepare a fixed release with exact dependencies. Local administrator access
  and the installer's stopped-owner condition are real activation prerequisites;
  leave the explicitly accepted working launcher intact until they are met.
  Do not kill the user's existing sessions to make an installer pass.
- README records what failed and the sequence preventing recurrence. Link this
  skill from the upgrade playbook and document invocation and local installation.

## 6. Tests and completion evidence for the skill itself

| Check | Required evidence |
| --- | --- |
| Cold plan review before implementation | Fresh reviewer examines this plan, exact decisions, canonical requirements and actual source/test availability; resolve material omissions before writing the skill |
| Package/loading | Valid YAML/name/description within 1,024 characters, explicit invocation metadata, real reference links, entire entry delivered, measured body size and selective reading cost |
| Trigger discrimination | Fresh agent gets a real request, a paraphrase and nearest lookalikes (launch normal Claude, repair a missing runtime, Codex upgrade); only task inputs, no expected answers |
| Execution | Fresh dry-run on known candidate evidence; agent discovers test host prerequisites, maps canonical tests, distinguishes accepted details from new automatic exposure and separates test/review/normal-use approval |
| Judgment beyond known tests | An independent author supplies an unfamiliar synthetic investigation without giving the operator the answer. A fresh operator loads the final skill and chooses how to investigate; evaluate its reasoning, distinguishing experiments, evidence limits and preservation of accepted risks/workflows. Include a situation where an alarming observation has an accepted explanation. Do not amend the skill with the scenario's answer just to make it pass |
| New-release fixture preparation | Dry-run a newer version against the existing pinned fixtures: identify actual fixed vendor hashes/version/commit and assertions, prepare the explicit candidate changes and paired baseline, and show that a wrong hash and absent/expired test authorization still refuse. A successful prior 2.1.316 run cannot substitute for this preparation |
| Failure paths | Independent scenarios for missing Mac evidence/bundle, false Remote Control baseline, proxy-down startup, human challenge and required workflow regression; validator chooses response without supplied target conclusions |
| Installation discovery | Load a copy outside aimgr, resolve the verified checkout, read required sources; no secret `/tmp` helper or hidden transcript dependency |
| Runtime diagnostic regression | Focused status/admission tests cover missing bundle, selected versus approved versions, forged filename, corrupted/missing approval, no vendor execution and no diagnostic approval bypass |
| Final review | New cold reviewer inspects implementation versus plan, behavioral evidence and changed code; findings fixed and relevant checks rerun before PR |

Keep behavioral receipts in `docs/aelaguiz/evidence/agent-upgrade-test-2026-11-02/`.
Publish no credentials, personal identifiers, cloud IDs, browser endpoints or raw
private logs. A text-only skill change does not require repeating the original
full native matrix; testing this skill is distinct from approving a new Claude
runtime. Recovery tests are recorded separately for their actual artifacts.

Completion: reviewed plan, implemented and locally installed skill, fresh-load
and behavior tests, runtime diagnostic tests, accepted-risk audit, installable
retained bundle/recovery result, final cold review, commit/push and reviewable PR.
Do not merge the new change without authorization. Any local activation still
waiting for administrator authorization or an agreed owner transition is stated
as unfinished, with the previous authorized working launcher preserved.

## 7. Completed work and remaining installation prerequisites

The [installed skill](../../skills/agent-upgrade-test/SKILL.md) teaches causal
investigation and evidence limits before introducing the existing fixtures.
It preserves the accepted decisions in section 2. The package contains no
script, runner or new service. Its complete entry, reference and metadata match
the local installation and external-loading copy; [package checks](evidence/agent-upgrade-test-2026-11-02/package-check.json)
record the delivered size and exact file hashes.

[Discovery](evidence/agent-upgrade-test-2026-11-02/discovery-review.json),
[initial behavior](evidence/agent-upgrade-test-2026-11-02/behavior-review.json)
and [concrete candidate preparation/proxy failure](evidence/agent-upgrade-test-2026-11-02/supplemental-behavior-review.json)
cover the planned invocation and failure cases. The concrete preparation is
explicitly synthetic and was not applied or executed; the recorded native tests
separately demonstrate the existing admission guards.

An independent author then supplied an [unfamiliar transport case](evidence/agent-upgrade-test-2026-11-02/novel-case.md)
after the skill was written. A fresh operator received observations without the
author's evaluation rationale. It investigated TLS-state ownership beyond the
existing request-body tests, identified confounded controls, proposed experiments
that distinguish causes, and retained the accepted browser and workflow behavior.
Both the case author and cold reviewer accepted this [judgment test](evidence/agent-upgrade-test-2026-11-02/novel-behavior-review.json).
It establishes useful reasoning in one unseen case, not an actual Claude leak
or a guarantee that an agent will discover everything.

The diagnostic change is committed as `ca7f013`; selected-version hints never
authorize execution. [Validation](evidence/agent-upgrade-test-2026-11-02/validation.json)
records local focused checks, Linux/Mac native admission, Mac installer contracts,
lint and the full-suite run with the affected-file rerun after correcting test
checkout permissions. No real vendor or account request was used in this recovery.
The [final cold review](evidence/agent-upgrade-test-2026-11-02/final-review.json)
found no remaining material defect, risk expansion or required-workflow removal.

The complete original Mac artifact set was rebuilt with the identical full digest,
retained in restricted durable storage, and freshly retrieved/verified on the
test VM and local machine. The original test-only archive remains separate from
the normal-use manifest recording the user's specific installation request for
those same bytes. A fixed AIM release with its own locked dependencies is prepared.
The [recovery record](evidence/agent-upgrade-test-2026-11-02/runtime-recovery.json)
states installation progress at the time of staging. Activation still requires
the accepted stopped-owner transition. The user corrected the exact OS-release
gate on 2026-11-02: the requested lock is on Claude and reviewed runtime artifacts,
not macOS or Linux updates. That gate and its misleading compatibility status
are removed; the recovered bundle's recorded test OS remains historical evidence.
An actual failure to apply native protection still refuses execution.
The previously authorized launcher remains selected and existing sessions remain
untouched. Skill/PR readiness is not a claim that local activation is finished.

The [OS-release correction](evidence/agent-upgrade-test-2026-11-02/os-release-correction.json)
passed 17 focused synthetic tests on each of the local Mac and GCP Linux VM,
with the existing administrator-only admission group skipped in both nonroot
runs. A fresh cold reviewer found no material issues and confirmed actual native
enforcement still precedes vendor execution. The updated installed skill matches
the corrected source; historical package and staging receipts retain their
original observations. No vendor/helper/policy bytes or live launchers changed.
