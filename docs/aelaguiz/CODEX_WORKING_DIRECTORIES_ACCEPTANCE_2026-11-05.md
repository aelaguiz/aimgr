# Codex working directories: implementation and acceptance

The official Codex client opens work images throughout the workspace, `/tmp`, Downloads, screenshot folders and explicitly configured working folders, including new files and directories created after startup. Mac screenshot thumbnails also work through the OS user's temporary folder. Ordinary tools keep their OS permissions. Native reads of unrelated private files and other accounts' state remain denied.

The governing requirements are the [November 5 completion plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md#current-completion-plan--november-5-2026) and [right-sizing issue #16](https://github.com/aelaguiz/aimgr/issues/16). Proxy PR #15 is closed and preserved for possible later work. This completes the Codex working-directory part of #16; Claude implementation remains separate. The [independent cold audit](CODEX_WORKING_DIRECTORIES_COLD_REVIEW_2026-11-05.md) found no remaining code blocker after the corrections below.

## Implementation

The existing invocation owner adds recursive work-directory grants. Defaults are `~/workspace`, `/tmp`, Downloads and the platform screenshot directory. Mac reads only the screenshot-location preference and separately asks `getconf DARWIN_USER_TEMP_DIR` for temporary screenshots. Linux respects XDG Downloads/Pictures and includes Pictures/Screenshots. `codexWorkingDirectories` in the existing local AIM config adds other working folders. No directory is created merely to establish a grant.

Unavailable optional defaults are skipped. Explicitly configured invalid roots report errors. Whole-home, whole-disk and account-parent grants are refused, including aliases. An explicitly selected outside file grants that file alone. A workspace symlink does not expose its private target. Native Codex permission modes still apply; a read-only reviewer is not upgraded to write access.

The conflicting Mac temp-data denial and redundant Linux mask-directory rules are removed. Primary-auth ownership, installation identities, optional-exporter shutdown, remote-control/update controls, targeted metadata restrictions and accepted mount/Keychain exceptions remain. Unused label-derived identity writers were deleted. The existing manual cross-account resume warning now also covers the picker and passthrough resume commands.

New files inside approved work folders need no restart. Adding a new outside root or selecting a new outside startup file uses a new invocation. The existing process's kernel policy is fixed; this change adds no policy service, broker or vendor fork.

## Final isolated verification

Both machines use unchanged official Codex 0.166.0, matching source `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, and the existing test-only installer. Linux native comparisons run with loopback-only networking. Mac uses the established isolated test host and local synthetic model/collector endpoints. Primary test credentials are independently created; no personal login or browser profile is transferred.

| Check | Linux | macOS |
| --- | --- | --- |
| Final focused audit-fix tests | 36 passed, zero failures | 35 passed, one Linux-only socket skip, zero failures |
| Actual stock/protected built-in images | Six reads allowed: five work areas plus selected outside file | Seven allowed: those six plus the Mac temporary screenshot |
| Native private-file boundary | Four private reads succeed stock and are denied protected | Same four denials |
| New files after native startup | Five work directories/images created after first model request, all readable | Six, including Mac temporary screenshots |
| Ordinary shell edits | Five written files verified for each launch | Six written files verified for each launch |
| Native tool/boundary probe | Sudo, build, bubblewrap, nested vendor reentry and surviving background tool pass | Temp aliases, ancestor/private-input boundaries and selected Keychain read/write pass with custom and standard Keychain locations |
| Stock Chrome, sandbox enabled | Actual shell launches and renders the synthetic page | Actual shell launches a persistent CDP browser and reads the rendered page title |
| Optional exporters after token refresh/settings reload | Passed | Passed |
| Read-only native reviewer | Passed with original permission mode | Passed with original permission mode |
| Native settings/live edits and relative paths | Passed | Passed |
| Native utility comparison | Passed | Passed |
| Final complete JavaScript suite | 1,002 passed, 19 skipped, zero failures out of 1,021 | 1,005 passed, 16 skipped, zero failures out of 1,021 |
| Lint | Passed | Passed |

The [image comparison](../../scripts/privacy-codex-working-directories.mjs) checks image payloads and permission errors, and verifies written file contents. A zero client exit code alone is insufficient. Shell edits are recorded separately from built-in reads; the test does not claim ordinary tools are confined. [Captured results and visual comparison](https://share.fun.country/20261105-codex-working-directory-checks-c97aa6263105/index.html) contain only synthetic outcomes.

### Reproducible evidence

Private receipts remain on their respective isolated machines. The following names identify actual runs, not proposed tests:

| Observation | Linux receipt | Mac receipt |
| --- | --- | --- |
| Final stock/protected work folders | `work-directories-fwssOe` | `work-directories-uT9xVo` |
| Native boundaries | `tool-boundary-21rf6y0a` | `aim-temp-metadata-btz6lhgw` (custom Keychain), `aim-temp-metadata-17ik9z6y` (standard) |
| Final Chrome comparison | `right-sizing-native-tools-chrome.log` | `exec-RbPCL9`, `right-sizing-audit-native-tools-chrome.log` |
| Exporter refresh/reload | `right-sizing-native-collector-reload.log` | Same filename on Mac |
| Reviewer, settings edits/paths, utilities | `right-sizing-native-readonly-reviewer.log`, `right-sizing-native-settings-edits.log`, `right-sizing-native-relative-paths.log`, `right-sizing-native-utilities.log` | Same filenames on Mac |
| Final suite | `right-sizing-final-suite.log` | `right-sizing-final-suite-corrected.log` |
| Lint | `right-sizing-audit-lint.log` | Same filename on Mac |

Final test-only runtime artifacts: Linux `6fa3055a7f4b1258ac8ae0d4f328a2760f28c49736789ea80166bbc34483b729`; Mac `d1a456c55aba7daf79443cebe183a6e49e4cdb0f04bde3699e827b47978081fe`. The installer did not approve personal-machine use or transfer authorization.

### Failures and corrections

The cold review caught the missing Mac per-user temp grant, default-folder startup refusals and two native fixtures that still expected the old private `/tmp`. These were corrected and rerun. The Mac private-canary fixture moved outside `/tmp` so the now-public work root does not invalidate its unrelated-private-file assertions.

Earlier fixture attempts used the wrong Linux Node path, let a greedy image argument consume the prompt, requested a patch tool not present in the synthetic model, or omitted the existing low-port reviewer wrapper. Corrected tests retain the original client and permission mode.

The newly downloaded stock Mac Chrome crashes during `--dump-dom` shutdown even outside Codex; the independent stock reproduction rendered its page and then exited with signal 11. The final comparison exercises a normal persistent CDP browser, verifies the actual synthetic page title, and closes only its own browser process group. Chrome's sandbox stays enabled. This is a test correction, not a product change to Chrome or its permissions.

One final Mac suite invocation omitted the two loopback aliases required by existing Claude transport fixtures: 1,000 passed, five network cases failed, and 16 skipped. The corrected invocation restored the established fixture setup and passed all 1,005 runnable cases; no product fix was made for those failures. Earlier complete runs before the audit corrections also passed on both platforms (1,020 tests each).

## Scope and existing acceptance

The earlier [M1 acceptance](CODEX_PRIVACY_M1_ACCEPTANCE_2026-11-04.md) and [overbuild-removal acceptance](CODEX_OVERBUILD_REMOVAL_ACCEPTANCE_2026-11-05.md) retain their named observations for independently authorized accounts, MCP import/refresh/logout/interruption recovery, schedules, history, first-use skills and nested/concurrent sessions. Those unchanged matrices were not all rerun for this directory change. Affected native boundaries and the retained probes above were rerun.

OAuth MCP still requires a usable native keyring in the actual execution context, as the approved plan requires. A host without it cannot convert an existing File store; the original store is preserved and AIM refuses that unconverted setup. Empty/no-MCP setups work without a running keyring. No plaintext fallback or per-account MCP token duplication was introduced. Mac's native Keychain authorization and each machine's fresh primary Codex login remain the previously approved adoption steps.
