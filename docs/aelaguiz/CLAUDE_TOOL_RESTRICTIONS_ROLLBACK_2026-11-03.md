# Remove unintended restrictions on macOS tools

Amir's original requirements were “My goal is to avoid changes to my workflow”
and “I accept malicious tools as my risk” (October 31, session
`01a192f6-96f9-7503-9fa4-d35ee2999f9d`). On November 3 he requested a rapid review,
removal of excess protection, and installation so he could resume work.

The implementation was overbuilt at the vendor/tool boundary. The macOS native
launcher applied settings, ancestor-directory, managed-policy and updater-file
restrictions to every descendant, while exempting only itself, ps and sudo.
That tried to defend against tool tampering that Amir had accepted. It also
prevented Chrome helpers from installing their own sandbox and blocked nested
AIM access to updater folders. GUI feature exclusions did not authorize this.

| Piece reviewed | Decision | Reason |
| --- | --- | --- |
| macOS inherited tool sandbox and ps/sudo exceptions | Remove | Ordinary programs leave Claude's sandbox on exec; no growing application allowlist. |
| Claude's own file/device restrictions on protected accounts | Keep | Explicit automatic-collection requirement; direct self-spawns remain restricted. |
| Account-specific identities and proxy routing, including outage refusal | Keep | Explicitly requested. Tool sandbox removal does not change routing GIDs or network enforcement. |
| Exact Claude build admission and disabled automatic updates | Keep | Explicitly requested; unchanged vendor bytes and vendor updater restrictions. |
| Remote Control, remote feature flags, detached conversation disabling | Keep | Each has an explicit user decision in the original session, including the November 2 detached-session decision. |
| Fixed session headers and startup folder grants | Keep | Both workflow tradeoffs were explicitly accepted November 1. |
| Launch-file cleanup blocking resumes after disk-number changes | Already corrected | Unverifiable old files are preserved without blocking sessions. |

The production native change replaces three executable exceptions with one
ordinary-tool transition, reducing rather than adding policy. No browser flags
that disable Chrome's sandbox, new broker, helper service, daily command or
account migration is introduced. This rollout changes the Mac launcher; Linux
runtime artifacts are not changed or activated by this repair.

Verification uses the production native launcher compiled with warnings as
errors, a synthetic vendor image and no account credentials. The old launcher
fails the ordinary-tool access regression. The corrected launcher passes in
ordinary and protected modes: vendor settings/updater access is still denied,
direct vendor self-spawns retain the policy, direct tools and shell children are
unsandboxed, and real Chrome renders a local page with its own sandbox enabled.
The empty Chrome profiles use a dead loopback proxy, and all test processes and
temporary runtime files are removed. Run `python3 test/privacy/claude-macos-tool-access.py`.

Running Claude processes retain their existing macOS policy until resumed into
a new process. Installation changes subsequent launches and resumes without
terminating user work.
