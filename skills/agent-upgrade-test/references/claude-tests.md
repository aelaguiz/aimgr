# Claude fixtures and evidence

Read this when preparing candidate fixtures or executing the upgrade comparison.
All paths below are relative to the verified aimgr checkout, not this installed
skill. These fixtures are instruments for answering questions and retaining
known guarantees. They do not enumerate everything a new vendor release can do.
Select or extend them from the behavior you need to explain; an unfamiliar path
may need a different experiment. The canonical implementation plan owns
T01–T24's exact setups and expected results; its section 11 identifies prior
receipts. Read it alongside the source.

## Establish access and prepare a new release

The private runtime notes are
`docs/aelaguiz/CLAUDE_PRIVACY_PROXY_RUNTIME_PRIVATE.md`; the private sacrificial
inventory is `docs/aelaguiz/2026-10-31-proxy-claude-accounts-proxy5-proxy6.md`.
They are intentionally not public checkout contents. Locate their established
private copies through the current maintainer installation. Never reconstruct
route credentials from public receipts or copy account inventories into fixtures.
`docs/aelaguiz/AWS_MACOS_TESTING.md` documents the nonroot testing profile,
private receipts, restricted access and bounded rental cleanup. Inspect live
availability/load and reuse a suitable existing rental before allocating another.

Every fixture is source to inspect, not a safe command to blindly paste. Read its
header, guards, argv/env inputs, paths, owner assumptions and cleanup before use.
Several assume the established `/opt/aimgr-state-audit` layout, a test-host marker,
test users and root-owned bounded `offsite-test.json` authorization. Bootstrap
only the disposable hosts. Do not create these markers on a physical user Mac.

Inspect fixed candidate pins narrowly, for example:

```sh
rg -n '2\.1\.316|cd7ceb459c68|sha256|expected|OFFSITE|artifactSet' \
  scripts/privacy-*-candidate-install.py \
  scripts/privacy-claude-default-services-probe.py \
  scripts/privacy-claude-policy-probe.py \
  scripts/privacy-candidate-validator-check.mjs
```

These are starting points, not an exhaustive list of possible pins. Follow their
imports and native policies. Baseline copies retain the prior exact release;
candidate copies use the newly obtained official hash/version/commit and rebuilt
helper/policy set. Review changes and validate that wrong hashes, unknown helpers,
absent/expired authorization and wrong hosts still refuse. Native response schema
changes require understanding and new assertions, not deletion of a failing check.

`scripts/privacy-linux-candidate-install.py` and
`scripts/privacy-macos-candidate-install.py` produce test-only candidates. Their
printed artifact digest must match the full inventory. Read
`src/privacy/claude-artifacts.js` for actual host/expiry authorization requirements.
Do not infer authorization from a marker or passing installer alone.

## Existing test surfaces

| Requirement group | Read and run the applicable existing fixtures on their intended hosts |
| --- | --- |
| T01–T03 optional mode, admission and updates | `test/network/claude-optional-privacy.test.js`; `test/privacy/claude-admission.test.js`; `claude-status.test.js`; `claude-installer-contract.py`; `scripts/privacy-version-boundary-check.py`; `privacy-integrated-launch-check.mjs` |
| T04–T07 identities, files, APIs, environment | `test/privacy/` state, transaction, instruction and launch-retention tests; `scripts/privacy-claude-default-services-probe.py`; `privacy-claude-policy-probe.py`; `privacy-*-candidate-probe.py`; platform metadata/descriptor/reentry/capability probes; `privacy-integrated-continuity-check.mjs` |
| T08–T09 telemetry, precedence and Remote Control | `scripts/privacy-claude-settings-validation-probe.py`; `privacy-candidate-validator-check.mjs`; `privacy-managed-native-matrix.py`; `privacy-managed-validator-check.mjs`; `privacy-header-settings-check.mjs`; default-services and policy probes above |
| T10–T13 routes, failures and original browser | `test/network/claude-native-route.test.js`; `claude-native-macos.test.js`; `claude-native-background.test.js`; `claude-chrome.test.js`; integrated concurrency/launch fixtures; original worklog's browser evidence and current binding checks |
| T14–T17 skills, MCP, native work, concurrency and continuity | `scripts/privacy-integrated-mcp-check.mjs`; `privacy-integrated-compatibility-check.mjs`; `privacy-integrated-concurrency-check.mjs`; `privacy-integrated-overlap-check.mjs`; `privacy-integrated-continuity-check.mjs`; `privacy-integrated-control-check.mjs`; native reentry probes |
| T18–T20 schedules, refusal and process lifetime | `scripts/privacy-integrated-control-check.mjs`; `privacy-integrated-schedule-refusals.mjs`; overlap/concurrency fixtures; native background tests; routine lifecycle and saved-job tests in `test/routines/` |
| T21 real service compatibility | `test/network/claude-real-accounts.test.js`; `scripts/privacy-real-routine-check.mjs`; only assigned proxy5/proxy6 routes after synthetic checks |
| T22–T24 exclusions, transition, comments and review | Full workflow comparison, installer/state/assignment tests, README installation sequence and cold code/evidence review |

Enumerate the actual fixture options and subcases in the run record. This table
does not make a partial fixture equal to its whole requirement. Keep actual native
evidence separate from mocked child processes and file-only contract tests.

Pure local diagnostic tests execute synthetic marker files only if a bug exists;
the test asserts none run. They are suitable on the editing machine:

```sh
node --test test/privacy/claude-status.test.js test/privacy/claude-admission.test.js
```

The opt-in administrator-owned filesystem cases in that admission file must run
on an offsite host with `AIMGR_TEST_CLAUDE_ARTIFACT_FILESYSTEM=1` under the documented
fixture user/root setup. A default skipped result is not native evidence. Run
focused checks during changes; lint and the full repo suite once ready when code
changes require it, on suitable offsite compute. CI is not the test runner.

For every fixture record exact setup, command/environment names without secrets,
source/hash/OS, expected and observed result, timestamps and receipt location.
Native tests must use the final composed policy. Repeated green runs of an earlier
artifact do not validate changed final bytes.

## Evidence that cannot be replaced by a convenient proxy

Demonstrate collection or access in the paired synthetic baseline before claiming
it is prevented. Remote Control needs an eligible baseline and a policy-specific
refusal; missing credentials, denied network or a disabled feature is insufficient.
Actual request captures must include startup/idle/default services and failure,
not only one model call against an alternate endpoint. Compare transformed and
opaque identifiers while retaining accepted account/protocol/task fields.

Prove A1/A2/B overlap with all sessions progressing. Invoke actual MCP tools and
resources with required OAuth/auth storage; seeing a configured server is not
proof. Exercise real native edits/builds, history and nested same/different-account
dispatch. A calendar must actually fire through AIM and its OS scheduler; an
interval fixture is a different case. Proxy-down startup must fail clearly before
vendor execution where preflight refuses it. Mid-run failure must remain closed,
stop/report within the canonical bound and preserve healthy siblings. Repair
allows a new occurrence/explicit launch, never replay of the failed occurrence.

Capture synthetic plaintext only at local mock services. Real accounts use route,
process and service-result evidence without TLS interception. Store raw evidence
privately; publish sanitized assertions and nonpersonal artifact hashes.

## Bundle retention and installation acceptance

Keep a complete bundle containing exactly the manifest's files plus approval.
Verify every file's digest/size/mode/role and the complete set's digest. Archive
it outside the ephemeral rental in restricted durable storage, retrieve a fresh
copy and verify again. Retain private storage coordinates with the maintainer's
installation records, and nonsecret digest/source/review references in the run doc.

Exercise `test/privacy/claude-installer-contract.py` and the production
`scripts/install-claude-runtime.py` in a disposable native environment, including
partial/corrupt bundles, test-only approval, writable paths, staging while owners
exist, activation refusal, selector preservation and rollback. Verify
`scripts/install-local-bin.sh --claude-runtime-bundle ...` leaves old wrappers
intact when runtime activation fails; inspect its companion shortcut effects.

Prepare exact dependencies in a fixed AIM release, never via a shared
`node_modules` symlink. The file-only runtime installer stages by default;
`--activate` needs the accepted stopped-owner transition. No-argument wrapper
installation omits runtime validation and is not a missing-bundle repair.
Check target OS compatibility explicitly; broad-platform acceptance does not
approve a policy for an untested kernel. Keep the prior working launcher until
the replacement's prerequisites and relevant smoke checks are satisfied.
