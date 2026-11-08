# Claude per-machine login and privacy: acceptance in progress

The candidate has not completed acceptance. The [implementation plan](../CLAUDE_PER_MACHINE_PRIVACY_AND_LOGIN_2026-11-07.md#test-plan-and-completion-criteria) owns the full test matrix. Results below identify the revision actually tested; an earlier revision is not proof of the final head.

## Evidence recorded

| Check | Result |
| --- | --- |
| Isolated hosts | The existing Linux VM was available, and the rented Mac passed a clean reboot before installation. The offsite installation receipt records separate environment anchors and no copied primary credentials. |
| Linux synthetic status, `dc781c17` | The CLI command test passed with a synthetic label and fake Redis: an account without a local login displayed `NEEDS YOU` and `aim claude login coder`, without a provider request. |
| Linux native diagnostic collectors, `73e3a9c` | With Claude 2.1.317 and a loopback-only network namespace, both stock and protected model requests completed. The enhanced stock run sent 3 log, 2 metric and 1 trace requests; the protected run sent 0 of each. A separate beta-tracing stock run sent 1 log, 0 metric and 1 trace request; the protected run sent 0 of each. Stock event logging sent 6 and 2 requests respectively; both protected runs sent 0. This establishes those startup/model cases for the tested revision, not settings reload, refresh or final-head acceptance. |

The sanitized Linux collector counts are in the private receipt `privacy-native-linux-diagnostics-73e3a9c.json` under `~/.aimgr/audits/claude-per-machine-2026-11-07/`. The reviewed Linux Claude executable has SHA-256 `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0`; the admitted artifact set has SHA-256 `c5e89ac5b37d89c020195b9d6d02c71f10756e3a4a6fda3f743583ca254ee613`.

## Acceptance still required

- Record current-head Linux and Mac authentication and Redis-boundary results, including the native manual callback bridge and first-label proxy enrollment.
- Independently authorize the established sacrificial account on both hosts, alternate actual native refreshes and requests, and check that local logout does not remove or resurrect the other host's grant.
- Complete native direct-account workflow and file/image checks, assigned-route refusal checks, and collector tests through settings reload, error, refresh and shutdown on the required platforms.
- Run the required local regression and full-suite checks on the candidate, complete the independent code and overbuild review, and resolve findings. Preserve any failures and skips with their causes.
