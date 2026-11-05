# Codex overbuild removal: acceptance

The cuts in [remove unnecessary Codex privacy gates and recovery machinery (#18)](https://github.com/aelaguiz/aimgr/issues/18) are implemented and pass their affected checks on isolated Linux and macOS machines. The [cold auditor's follow-up](CODEX_OVERBUILD_REMOVAL_COLD_REVIEW_2026-11-05.md) covers the implementation, scope and evidence.

**The broader privacy milestone still has an unresolved workflow problem:** native image reads outside the admitted project/input paths remain restricted. That belongs to [adopt Codex privacy without breaking workflows (#16)](https://github.com/aelaguiz/aimgr/issues/16). These results establish the overbuild cuts; they do not establish that every workflow works under the remaining vendor file policy.

## What was removed

| Previous behavior | Current behavior |
| --- | --- |
| Merely having a legacy MCP credential file prevented launch. | An empty native JSON object allows launch. Nonempty, malformed or unreadable stores still require conversion. |
| Conversion-only tools had to pass every ordinary launch check. | The three conversion-only components are checked when conversion needs them. Actual runtime dependencies remain required. |
| Every displaced settings file remained in indefinite replay history. | Detected exchange races are reconciled once; successful settled files are retired. Conflicts and interrupted transactions remain recoverable. |
| Each artifact path repeated checks of the same ancestor directories. | One admission shares its completed ancestor checks; the next admission checks afresh. |
| The configuration helper had extra filesystem-write and process-memory restrictions. | Those integrity restrictions and the Linux Landlock prerequisite are removed. Its network, broker and process-execution restrictions remain. |
| Conversion refused sessions based on an installer environment fingerprint. | Only relevant native owners, wrappers and AIM launchers prevent conversion. Inventory no longer classifies installer shells from process environments, exports no environment fields and does not signal processes. |
| The finite `stdio-to-uds` command was banned. | It works with an exact read/write grant for its selected socket. Sibling paths are not granted. |
| Offsite authorization expired at an arbitrary seven-day maximum. | The explicit administrator-set expiry applies, with the existing host and build binding. Claude's existing behavior is unchanged. |

The [plan amendment](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md) records the smaller settings contract, including the deliberate removal of recovery for future writes through an already-settled displaced file descriptor. No broker, persistent service, process registry or extra compatibility mode was introduced.

## Isolated verification

All native experiments used unchanged official Codex 0.166.0 and the matching upstream source at `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. Native helpers were rebuilt remotely in release mode, then installed through the existing offsite candidate installer. Synthetic fixture credentials were created independently on each test machine. No personal authorization file or browser profile was transferred.

| Check | Linux | macOS |
| --- | --- | --- |
| Affected settings, invocation, arguments and maintenance JS files | 53 passed; one opt-in case skipped here | 53 passed; one opt-in case skipped here |
| Opt-in native maintenance admission | Passed separately with its gate enabled | Passed separately with its gate enabled |
| Actual protected artifact filesystem checks | 25/25 passed | 25/25 passed |
| Helper boundary probe | File writes and self-memory read allowed; network, Unix connection and exec denied | File writes allowed; network, Unix connection and exec denied |
| Native inputs | Read-only projection and seven native databases passed | Read-only projection and seven native databases passed |
| Stock/protected native utilities | All 18 observations passed | All 18 observations passed |
| Native settings edits | Native writes, atomic editor replacement, relative changes, second account and restart passed | Same checks passed |
| Native relative settings paths | All 24 manifest leaves matched stock/account views | Same checks passed |
| Process inventory | Real native owner identified; environment fields absent; no stop operation | Same checks passed |
| MCP conversion and recovery | Conversion, logout, conflicts and all seven SIGKILL boundaries passed | Same checks passed |

The utility checks include a real Unix-socket echo, actual native marketplace removal through the upstream in-place writer, sandbox child execution, MCP addition and exec-policy inputs. A neighboring unselected file remains denied. The final socket grant and native process inventory were explicitly retested after their last changes.

Settings tests retain source/view exchange races, same-key conflict preservation, seven interruption boundaries, authored relative-path writeback and permission recovery. Twelve alternating atomic and in-place saves now finish without retained replay entries or displaced files. These tests check the supported save/recovery contract rather than requiring the removed indefinite old-descriptor behavior.

The full macOS JavaScript run passed **1,000 of 1,016 cases**, with 16 skips and zero failures. The Linux full run passed 957 cases, failed 39 and skipped 19 out of 1,015: the launch tests overlapped the separate native credential-conversion fixture and correctly encountered its host-level pending-maintenance gate. After conversion completed and the gate was absent, the four affected test files passed **108/108**, including every failed case. The full Linux run is not reported as a zero-failure run. No product change was made to bypass the gate.

## Failures corrected during verification

- Linux initially rejected the restored socket utility because a read-only path grant does not permit connecting to that Unix socket. The final code grants exactly the selected socket read/write access; stock and protected echo then passed on both systems.
- The first Linux broad JS invocation selected Node 18 instead of the repository's Node 24 installation. The corrected runs use Node 24.22.2.
- The first macOS broad invocation lacked the test Node directory in child `PATH` and the loopback aliases used by existing proxy fixtures. The affected harness tests passed after correcting those prerequisites, followed by the zero-failure full run. Temporary loopback aliases were removed afterward.
- The first Linux native MCP invocation omitted the existing synthetic D-Bus fixture flag and stopped before conversion. Enabling that fixture produced the complete passing maintenance run.

Private test logs retain these attempts. They contain machine paths and are not copied into this public repository. The named test files and observations here provide the public verification record.

## Reproduction commands

Run only on the established isolated fixture machines with Node 24, the matching release helpers, an installed offsite candidate and synthetic accounts. Linux native client fixtures run in a network namespace with loopback only. Its MCP fixture additionally uses `AIMGR_SYNTHETIC_DBUS=1` inside a fresh `dbus-run-session`. Do not overlap that fixture with launch tests for the same OS user.

```sh
node --test --test-concurrency=2 \
  test/io/codex-settings.test.js test/io/codex-settings-rpc.test.js \
  test/privacy/codex-native-invocation.test.js test/privacy/codex-arguments.test.js \
  test/privacy/codex-mcp-maintenance.test.js test/privacy/codex-maintenance-admission.test.js
sudo env AIMGR_TEST_CODEX_ARTIFACT_FILESYSTEM=1 node --test test/privacy/codex-admission.test.js
AIMGR_TEST_CODEX_MAINTENANCE=1 node --test test/privacy/codex-maintenance-admission.test.js
python3 test/privacy/codex-config-boundary.py
node scripts/privacy-codex-native-inputs.mjs
node scripts/privacy-codex-passthrough.mjs
node scripts/privacy-codex-settings-native.mjs --edits
node scripts/privacy-codex-settings-native.mjs --paths
```

The process-inventory and MCP-maintenance Python fixtures receive the installed `processControl` helper returned by explicit maintenance admission. The MCP fixture also receives the absolute Node path. Their options are defined in [the inventory fixture](../../test/privacy/codex-native-inventory.py) and [the maintenance fixture](../../test/privacy/codex-mcp-maintenance.py).
