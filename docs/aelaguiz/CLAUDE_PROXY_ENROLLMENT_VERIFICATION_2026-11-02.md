# Claude proxy-account enrollment verification

## Current outcome

The two requested individual Max accounts are now in the shared pool with
proxy-only assignments. Both passed staged acceptance, production Opus/tool/MCP
launches and actual production calendar jobs. The original local Chrome instances,
profiles and proxy assignments were retained. No human-verification challenge
occurred. Private account bindings and receipts are in the local enrollment
plan; they are intentionally absent from this tracked report.

Testing found two implementation defects that affected normal use: the Mac
route monitor could time out while Python was still importing, and the protected
Claude process could not start an MCP executable through a Homebrew-style
symlink. The fixes preserve the existing routing and file privacy boundaries.

## Implementation and boundaries

- `d193b92` adds proxy assignments to status and skips accounts whose assigned
  profile is not configured locally, before making a provider request. Status
  says “don't have a route to this account.” A configured but failed route stays
  fatal; missing remembered protection cannot become ordinary access.
- `6e4ecea` safely publishes root-owned route state and permits the loopback
  SYN+ACK needed for the existing local OAuth callback. External fail-closed
  routing is unchanged.
- `e952611` replaces the periodic Python-import-dependent HTTP probe with fixed
  native curl after dropping to the assigned user/routing group. It retains
  the eight-second outer deadline, exact expected exit, TLS validation, no
  inherited proxy settings, and explicit recovery after a failure.
- `d20c990` inventories configured MCP executable files and their symlink
  spellings. The Mac helper grants exact executable data and alias metadata;
  it does not grant the surrounding bin directory, rewrite commands, or run MCP
  as root. Updater paths cannot gain alias metadata. Old admitted helpers retain
  their previous behavior; ordinary accounts do not receive these extra reads.

Claude remains the official, unmodified **2.1.316** binary, SHA-256
`64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f`.
The tested replacement Mac helper/policy bundle is
`3b93114dd0f34733e1e2a07841f5bd3e7bfbe36afee7ef5ca99df003e23a876c`.
The user authorized installing this reviewed repair, and its normal-use bundle
is installed. Original test-only evidence remains retained separately.
The test Mac ran arm64 macOS 26.7; this is evidence, not an OS-version gate.

## Acceptance evidence

| Check | Result and scope |
| --- | --- |
| Managed sign-in | Both existing local Chrome/CDP instances; assigned exits only; both Max identities confirmed |
| Real Opus and required tools | Four overlapping sessions, two per account; Read, Bash, file output, Skill and real stdio MCP all passed |
| Same-account resume | Both original session IDs retained fixture context |
| Usage | Both live usage requests succeeded on their assigned routes |
| Token refresh | Both actual access tokens changed; expiry renewed; account identity and proxy assignment preserved |
| Calendar execution | Actual launchd calendar to AIM to approved runtime succeeded once per account |
| Runtime outage | Stopping one new adapter ended its owned session in 0.333 seconds; the other account's session completed |
| Startup/scheduled outage | Both refused on the stopped route with the account, proxy and repair/retry instruction; no ordinary fallback |
| Explicit recovery | Restart and exit verification followed by a fresh model request passed; failed work was not replayed |
| Monitor stability | Both profiles held active credential-free owners for 180 seconds without the former false timeout |
| Rented-Mac MCP compatibility | Full native routed Claude invoked direct, directory/multihop and shebang aliases; real correlated tool results, ordinary UID and assigned routing GID verified |
| Private-file negative | The same existing neighbor file was readable with an intentional folder grant, then denied in a new alias-enabled session without that grant |
| Native version lock | Updater writes and direct/interpreter execution were denied; ordinary project scripts and a newly compiled C program worked |
| Focused Mac regression | 34 tests passed plus the installed native managed-settings validator |
| Linux regression | 838 tests: initial 799 pass, 27 fail, 12 skip. Missing README and group-writable archive extraction caused 26 failures; one new fixture assumed `/bin/sh` was canonical. Corrected the test copy and canonical fixture, then all 105 tests in the six affected files passed. Native opt-in skips are not claimed as execution |
| Fleet route/status | Four existing consumers received the narrow backport; all 48 focused checks passed on each, and installed status JSON succeeded |

Initial real-account tests used the previous approved bundle. The replacement
helper passed the original Homebrew command on both real accounts in staging
and again in production. Rented-Mac collection tests used only synthetic
credentials behind independent outbound denial.

## Installed result and independent review

Cold review completed against `d20c990` and `e952611`: no remaining code finding
or functionality cut. The reviewer independently checked native MCP/private-file
results, local workflow receipts, regression logs and all four retained bundle
payloads. The complete bundle was retrieved and verified against its manifest;
archive SHA-256 is
`ae2d9abe66d9bec450758f3dc37997d04e331576fa5f0e2c56c8ce17504ba0e8`.

The user subsequently explicitly instructed completion of the repair. The
normal-use manifest records that instruction, the reviewed revision and evidence.
Fixed release `d20c990-claude-proxy-mcp`, with its own dependencies, is now the
local default. The new immutable helper was staged and activated without
signalling existing sessions or removing older bundles.

Both account homes were copied separately under assignment/credential ownership.
Their private installation identifiers and sidecars matched before and after
production launches. Proxy-only policies were published before credentials;
credentials used the leased native import path. No ordinary credential interval,
account reauthentication or identity rotation was introduced.

Both production Opus launches passed Read, Bash, Skill and the unchanged
Homebrew MCP command. Both actual production calendar jobs completed once and
the owned jobs were unloaded. Ordinary non-proxy and automatic pool launches
also completed. The production selector confirms both new accounts are eligible
for Opus. All four other fleet machines show both as `no_route`, ineligible, with
“don't have a route to this account.” The M5's `aim status` shows each assigned
proxy and `READY` / `use now`.

During completion, the user reported new launches failing. The local executable
link had moved to unapproved 2.1.317 at 19:48 Chicago time on November2, after
these 2.1.316 tests. Restoring the hash-verified 2.1.316 link cleared admission,
and real ordinary/protected launches passed. The link evidence establishes
what changed, not which process changed it. Existing sessions were preserved.
The user separately requested testing and adopting the latest release; that is
follow-up upgrade work and does not relabel 2.1.316 evidence as 2.1.317 approval.

Staging is inactive, with private audit receipts retained. Rental termination was
requested after complete artifact retrieval, the temporary GCP SSH rule removed,
and dedicated host-release schedules retained. Later upgrade work may reuse an
available test host under its own instance/cleanup receipt.

No workflow removal was introduced: skills, MCP, same/different-account
concurrency, resume, scheduled work and ordinary accounts remain requirements.
Accepted task context, tool trust and broad platform details remain accepted;
the fixes do not add a redaction system, default-browser login, automatic
failover or an OS-update requirement.
