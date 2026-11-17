# Codex 0.169.0 upgrade: source privacy review and fleet bundles

November 17, 2026. **Official Codex 0.169.0 replaces 0.166.0 across the fleet after a source-only privacy review that found no change our protections fail to cover.** Amir asked for this scope (November 17, 2026: "get me on the latest codex after doing a quick check for safety ... I don't want a full remote VM sandbox test I want you to check it for privacy etc iwth our requirements"; later: "just get it deployed to the fleet"). No vendor code ran during the review, and no offsite runtime capture was made, so the findings below come from reading source, not from observed traffic.

## Candidate and baseline

| | Approved before | Candidate |
| --- | --- | --- |
| Release | 0.166.0, tag `rust-v0.166.0`, commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` | 0.169.0, tag `rust-v0.169.0`, commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`, npm `latest` since November 13 |
| Mac package | `@openai/codex@0.166.0-darwin-arm64` | `@openai/codex@0.169.0-darwin-arm64`, integrity `sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==` (matches the registry) |
| `codex` | `39acf979…7db7c1` | `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002` |
| `codex-code-mode-host` | `fd37051b…41400a` | `10feae2abe764bcf2273e241ace67aecc360eb8c28a82a2988bf1d8498a9bacf` |
| Signature | Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2) | Same team; `codesign --verify --strict` passes on both images |
| Linux package | `@openai/codex@0.166.0-linux-x64` | `@openai/codex@0.169.0-linux-x64`, integrity `sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww==`; `codex` `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`, `codex-code-mode-host` `e9f2ef68671b2b6ac68902d19e8dafda3f5928e678ecf3f30c74b203a2c403ed` |
| Bundles | Mac `49ea95bb…66c641ec`, Linux `822c41e3…5770164d` | Recorded in each bundle's `approval.json` |

The 0.166 bundles' vendor images match the 0.166 npm packages byte for byte on both platforms, so the candidate came from the same source the approved one did. The package layout and file list are unchanged; the bundle again takes only `codex` and `codex-code-mode-host`.

## What was reviewed

Three reviewers each read the 590-commit, 190k-line diff for one area, through git only, against the [privacy inventory](../AI_APP_PRIVACY_INVENTORY.md) and section 4 of the [Codex privacy plan](CODEX_PRIVACY_PROXY_PLAN_2026-11-01.md): what the client sends about the person and machine; telemetry and diagnostics; and remote control, daemons, updaters and spawned helpers. AIM compatibility was checked separately.

| Area | Result in 0.169 | Our coverage |
| --- | --- | --- |
| User-Agent, terminal detection, request metadata, attestation, cookies, `/models` | Unchanged apart from a typed `context_window_id` (still UUIDv7) and a new terminal name (Rex) whose version comes only from `TERM_PROGRAM_VERSION` | Existing terminal-variable stripping and OS-version denials |
| Host identifiers (hostname, hardware UUID/serial, machine-id, OS release files, `sw_vers`/`ioreg`/`scutil` shell-outs) | No new reads or spawns in non-test source | Existing Seatbelt denials |
| `installation_id` | Moved to `runtime-agent-instance`; same random UUIDv4 per `CODEX_HOME`, new locking | Private account homes |
| New automatic request | TUI sends `GET {chatgpt_base_url}/wham/security-setup` on start, reconnect and account change, with the normal token, account header and User-Agent | No new identifier; same host as model traffic. No setting disables it |
| Analytics, Statsig metrics, OTel | New event fields (`turn_trigger`, turn timings) and metric names; same gates | `analytics.enabled=false`, exporters `none` |
| Feedback | `/feedback` now offers a local ZIP save when sending is disabled; upload still refused | `feedback.enabled=false`; save is user-started and local |
| Failed approval-review retention | Unchanged gate | `feedback.enabled=false` |
| Remote control, `--no-daemon`, updater | Same requirement key, flag name and position; updater code unchanged | Existing requirements and launch arguments |
| Spawned vendor helpers | `codex-code-mode-host` now starts with `--listen grpc+stdio://` by default | The Mac policy matches vendor images by exact path, not arguments, so the helper stays in the vendor sandbox |
| MCP OAuth store | Modes unchanged | Forced `file` |
| Off-by-default additions | Cloud conversation backend (`tui_multi_backend`), runtime agent registration (`runtime_agent_instances`), message board, guardian decisions scorer | Not enabled by any of Amir's settings; left at their defaults rather than pinned |
| Explicit-only additions | `codex git-credential`, `codex tcp-tunnel`, credential-export commands, `codex doctor` MCP probes | Deliberate use only |

Two functional gaps were noted, not fixed, because neither affects what is sent: the new `modelProvider/config/write` app-server call writes provider settings without AIM's relative-path translation, and AIM's argument parser does not know the new `git-credential` subcommand or exec `--trust` flag.

## AIM changes

- The config-state and worktree helpers are rebuilt from the official 0.169.0 source archive (`d9b6335151f66d1d4ae9123f55553164ff339f30b14f64a358ea78139c4c093e`) with upstream's 0.169 dependency lock and patches. ConfigToml and profile path fields are identical to 0.166, and skills discovery keeps the same bounds, so the settings adapter needs no change.
- Launch accepts a helper built from either reviewed revision, so sessions and machines still on the 0.166 bundle keep working.
- The helpers were built on the M3 Max (Mac) and the home server (Linux); both builds resolved the same dependency lock, committed here. The Linux helper needs the same glibc (2.39) as the 0.166 one.
- Other helpers (launcher, managed preferences, MCP keyring, process control, state IO, MCP maintenance) are byte-identical to the 0.166 bundles; their source has not changed since.

## Limits

- No traffic capture of 0.169 under the protection. Item-by-item coverage above is a source reading.
- The helpers' own test suite was not rerun; the first real launch on each platform is the check.
