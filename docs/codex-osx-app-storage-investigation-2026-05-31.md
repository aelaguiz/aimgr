# Codex macOS App Storage Investigation

Date: 2026-05-31

Scope: `/Applications/Codex.app` on this Mac, the local Codex CLI source tree at
`~/workspace/codex`, and the current AIMgr Codex integration in this repo.

Secret-handling note: this investigation did not copy credential values into
this document. Paths, storage shapes, field names, process names, and redacted
metadata are recorded because AIMgr needs those contracts.

## Short Version

The Codex macOS app is not a totally separate runtime from the CLI. It is an
Electron/Chromium app that runs a bundled Rust `codex app-server`.

The GUI has its own Electron browser profile at:

- `~/Library/Application Support/Codex`

But the Rust Codex runtime still uses the shared Codex home:

- `~/.codex`

On this machine, the GUI's main app-server process had open handles to:

- `~/.codex/state_5.sqlite`
- `~/.codex/logs_2.sqlite`
- `~/.codex/goals_1.sqlite`
- `~/.codex/sessions/2026/05/30/rollout-*.jsonl`

That means GUI sessions are visible through the same session and state stores
that AIMgr already thinks of as "Codex CLI" state. The useful distinction is
not the directory. The distinction is metadata: GUI threads show
`originator: "Codex Desktop"` and commonly `source: "vscode"`.

Credential storage is more split. The CLI source supports file, keyring, auto,
and ephemeral auth storage. AIMgr currently supports only file-backed
`~/.codex/auth.json`. The GUI also has Electron safe storage and browser data,
but the live Rust app-server on this Mac is still pointed at `~/.codex`.

## Installed App

Observed app metadata:

- Bundle path: `/Applications/Codex.app`
- Bundle identifier: `com.openai.codex`
- Display name: `Codex`
- App version: `26.527.31326`
- Bundled Codex binary: `/Applications/Codex.app/Contents/Resources/codex`
- Bundled Codex version: `codex-cli 0.135.0-alpha.1`
- URL scheme in `Info.plist`: `codex`
- Signing identity: OpenAI developer certificate; app is notarized

The bundle is an Electron/Chromium app:

- `CFBundleExecutable` is `Codex`
- `CFBundleIconFile` is `electron.icns`
- `NSPrincipalClass` is `BrowserCrApplication`
- Chromium data uses `~/Library/Application Support/Codex`

The bundle also contains runtime tools:

- `app.asar`
- `codex`
- `node`
- `node_repl`
- `rg`
- `codex_chronicle`
- plugin/native helper assets

## Local App Data

Observed local app data directories:

- `~/Library/Application Support/Codex` was about `126M`
- `~/Library/Application Support/com.openai.codex` was about `4K`
- `~/Library/Application Support/OpenAI/Codex` was about `4K`

The important Electron profile appears to be:

- `~/Library/Application Support/Codex`

Notable files under that profile:

- `Cookies`
- `Local Storage/leveldb`
- `Session Storage`
- `Local State`
- `Preferences`
- `Network Persistent State`
- `Default/Cookies`
- `Default/Local Storage/leveldb`
- `Default/Preferences`
- `Default/Secure Preferences`

The small `~/Library/Application Support/com.openai.codex` tree was mainly
Crashpad data on this machine. `~/Library/Application Support/OpenAI/Codex`
contained native-messaging related data.

Cookie metadata was checked without reading cookie values. The root
`~/Library/Application Support/Codex/Cookies` database had only Cloudflare-style
cookie rows for ChatGPT/OpenAI hosts:

- `.chat.openai.com` / `__cf_bm`
- `.chatgpt.com` / `__cf_bm`
- `chat.openai.com` / `__cflb`
- `chatgpt.com` / `__cflb`

`~/Library/Application Support/Codex/Default/Cookies` had no OpenAI/ChatGPT rows
in that same query. This does not prove the GUI has no auth state in Electron;
it only means there was no obvious readable OpenAI login-cookie inventory in
the cookie tables that were checked.

## Keychain Findings

Two keychain concepts matter and they are easy to confuse.

Electron safe storage:

- Service: `Codex Safe Storage`
- Account: `Codex Key`
- Present on this Mac
- Purpose: Chromium/Electron encryption key for browser profile secrets

Rust Codex CLI keyring auth:

- Service: `Codex Auth`
- Account/key format: `cli|<first 16 hex chars of sha256(canonical CODEX_HOME)>`
- Not found on this Mac during this investigation

For the default Codex home on this machine:

- `CODEX_HOME`: `/Users/aelaguiz/.codex`
- Computed Rust keyring account: `cli|025e87a19a47c106`

Also computed for possible app profile locations:

- `/Users/aelaguiz/Library/Application Support/Codex` -> `cli|890fe5e037a27a02`
- `/Users/aelaguiz/Library/Application Support/com.openai.codex` -> `cli|d472693eac149744`

No `Codex Auth` item was present for the normal check. The active persistent
auth on this machine was the file-backed `~/.codex/auth.json`.

## CLI Credential Contract

The Codex CLI source defines the expected `$CODEX_HOME/auth.json` shape in:

- `~/workspace/codex/codex-rs/login/src/auth/storage.rs`

The Rust struct is `AuthDotJson` and its fields are:

- `auth_mode`
- `OPENAI_API_KEY`
- `tokens`
- `last_refresh`
- `agent_identity`

The file path is:

- `$CODEX_HOME/auth.json`

Token fields are defined in:

- `~/workspace/codex/codex-rs/login/src/token_data.rs`

`TokenData` fields:

- `id_token`
- `access_token`
- `refresh_token`
- `account_id`

`id_token` is stored in JSON as the raw JWT string. Rust deserializes it into
an `IdTokenInfo` struct with parsed claims, then serializes it back as the raw
JWT string. That means AIMgr's current string-shaped `tokens.id_token` is
compatible with Codex's current file format.

AIMgr currently builds this compatible file shape in:

- `src/targets/codex-store.js`

Current AIMgr output shape:

```json
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<jwt>",
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "account_id": "<chatgpt-account-id>"
  },
  "last_refresh": "<iso-timestamp>"
}
```

On this machine, the live `~/.codex/auth.json` had these top-level keys:

- `OPENAI_API_KEY`
- `tokens`
- `last_refresh`

And these token keys:

- `id_token`
- `access_token`
- `refresh_token`
- `account_id`

## CLI Auth Backends

Codex supports four CLI auth storage modes:

- `file`
- `keyring`
- `auto`
- `ephemeral`

These are created by `create_auth_storage` in:

- `~/workspace/codex/codex-rs/login/src/auth/storage.rs`

File mode:

- Reads and writes `$CODEX_HOME/auth.json`

Keyring mode:

- Uses keychain service `Codex Auth`
- Stores the serialized `AuthDotJson` JSON string as the keychain password
- Uses key `cli|<first 16 hex chars of sha256(canonical CODEX_HOME)>`
- Deletes the fallback `auth.json` after a successful keyring save

Auto mode:

- Loads keyring first
- Falls back to file if keyring load misses or fails
- Saves to keyring first
- Falls back to file if keyring save fails

Ephemeral mode:

- Process-global in-memory map
- Same computed store key as keyring mode
- No disk write

Important packaging detail:

- In local development builds, `keyring` and `auto` are resolved back to `file`.
- In packaged builds, the configured mode is honored.

That difference explains why packaged Codex.app can safely support keyring-like
behavior even if a dev CLI build behaves as file-backed by default.

## AIMgr's Current Credential Behavior

Relevant AIMgr files:

- `src/io/paths.js`
- `src/targets/codex-store.js`
- `src/targets/codex-cli.js`
- `src/cli/commands/codex.js`

Current behavior:

- `CODEX_HOME` overrides the Codex home.
- Otherwise AIMgr uses `~/.codex`.
- `aim codex use [label]` writes `~/.codex/auth.json`.
- The file mode check reads `~/.codex/config.toml`.
- If `cli_auth_credentials_store` is not `file`, AIMgr refuses to manage the
  target.
- `preserveLiveCodexAuthForActiveLabel` reads the live `auth.json` and imports
  refreshed token fields back into AIMgr state for the active label.

That means AIMgr currently does the correct thing only for file-backed Codex
homes. It does not yet support the official Codex keyring or auto storage
contracts.

## GUI Runtime Processes

Observed live GUI process shape:

- `/Applications/Codex.app/Contents/MacOS/Codex`
- child: `/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled`
- many plugin/tool child processes:
  - `/Applications/Codex.app/Contents/Resources/node_repl`
  - `/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://`

The GUI main app-server process had open files in `~/.codex`, including:

- `state_5.sqlite`
- `state_5.sqlite-wal`
- `logs_2.sqlite`
- `logs_2.sqlite-wal`
- `goals_1.sqlite`
- `goals_1.sqlite-wal`
- multiple `sessions/YYYY/MM/DD/rollout-*.jsonl` files

This is the strongest local evidence that GUI session state is represented in
the same Codex home as CLI session state.

Transport notes:

- App-server default listen URL is `stdio://`.
- The control socket helper path is
  `$CODEX_HOME/app-server-control/app-server-control.sock`.
- This Mac also had `~/.codex/app-server-control/app-server-control.sock`.

For AIMgr, that means a future GUI-aware integration should treat the
Electron-owned stdio app-server as owned by the app. AIMgr should either read
the shared files, use a supported remote/control socket, or start its own
app-server. Attaching to the Electron child stdio directly is the wrong shape.

## Session Representation

Codex session files live under:

- `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`

The first JSONL record is a `session_meta` event. The useful metadata fields
seen locally include:

- `id`
- `timestamp`
- `cwd`
- `originator`
- `cli_version`
- `source`
- `thread_source`
- `model_provider`

Examples of local classification:

| Producer | `originator` | `source` | `thread_source` | `cli_version` |
| --- | --- | --- | --- | --- |
| Codex Desktop main thread | `Codex Desktop` | `vscode` | `user` | `0.135.0-alpha.1` |
| Codex Desktop subagent | `Codex Desktop` | object with `subagent.thread_spawn` | `subagent` | `0.135.0-alpha.1` |
| Codex CLI TUI | `codex-tui` | `cli` | `user` | varies |
| AIMgr-spawned CLI work | AIMgr-specific originator | `cli` | `user` | varies |

The SQLite state database is:

- `~/.codex/state_5.sqlite`

Tables observed:

- `_sqlx_migrations`
- `threads`
- `thread_spawn_edges`
- `thread_dynamic_tools`
- `agent_jobs`
- `agent_job_items`
- `backfill_state`
- `remote_control_enrollments`

Important `threads` columns:

- `id`
- `rollout_path`
- `created_at`
- `updated_at`
- `source`
- `model_provider`
- `cwd`
- `title`
- `sandbox_policy`
- `approval_mode`
- `tokens_used`
- `has_user_event`
- `archived`
- `git_sha`
- `git_branch`
- `git_origin_url`
- `cli_version`
- `first_user_message`
- `agent_nickname`
- `agent_role`
- `memory_mode`
- `model`
- `reasoning_effort`
- `agent_path`
- `created_at_ms`
- `updated_at_ms`
- `thread_source`
- `preview`

Important supporting tables:

- `thread_spawn_edges(parent_thread_id, child_thread_id, status)`
- `thread_dynamic_tools(thread_id, position, name, description, input_schema, defer_loading, namespace)`
- `remote_control_enrollments(websocket_url, account_id, app_server_client_name, server_id, environment_id, server_name, updated_at)`

The safe read model for AIMgr is:

- Use `state_5.sqlite` for fast listing, filtering, and metadata.
- Use JSONL `session_meta` as the canonical per-rollout metadata record.
- Use `originator == "Codex Desktop"` to identify GUI-created sessions.
- Avoid reading full JSONL histories unless the feature actually needs message
  content.

## GUI Auth Behavior

There are two auth paths to separate.

First, the Rust app-server has its normal managed Codex auth. That reads from
the configured Codex auth backend for `CODEX_HOME`, just like the CLI. On this
machine, that means `~/.codex/auth.json`.

Second, the app-server protocol also supports externally managed ChatGPT bearer
tokens. This is defined in:

- `~/workspace/codex/codex-rs/app-server-protocol/src/protocol/v2/account.rs`
- `~/workspace/codex/codex-rs/app-server/src/request_processors/account_processor.rs`
- `~/workspace/codex/codex-rs/app-server/src/message_processor.rs`
- `~/workspace/codex/codex-rs/login/src/auth/manager.rs`

Protocol shape:

- `account/login/start` type: `chatgptAuthTokens`
- Request fields:
  - `access_token`
  - `chatgpt_account_id`
  - `chatgpt_plan_type`
- Refresh server request:
  - method: `account/chatgptAuthTokens/refresh`
  - fields: `reason`, `previous_account_id`
- Refresh response:
  - `access_token`
  - `chatgpt_account_id`
  - `chatgpt_plan_type`

The source labels `chatgptAuthTokens` as unstable and for OpenAI internal use.
When used, Codex stores it in ephemeral auth storage, not in `auth.json`.

The app-server installs an `ExternalAuthRefreshBridge`. On a 401, it asks the
parent app for fresh tokens and waits up to 10 seconds. If AIMgr ever becomes
the external auth provider for an app-server, AIMgr must be able to answer that
refresh request.

Electron app code inside `app.asar` also contains app-side auth helpers. The
app can request/cached bearer tokens, set:

- `Authorization: Bearer <token>`
- `ChatGPT-Account-Id: <account-id-from-jwt>`
- Codex Desktop originator/user-agent headers

Interpretation:

- The GUI definitely owns some Electron auth/browser state.
- The GUI's Rust app-server definitely shares `~/.codex` session and state
  files.
- On this machine, no Rust `Codex Auth` keychain item was found and
  `~/.codex/auth.json` was present.
- The normal GUI login path should be treated cautiously: the source supports
  both managed auth and parent-managed external token auth, but this
  investigation did not prove which one every GUI login path uses by default.

## Differences From `codex-cli`

Runtime packaging:

- CLI installed from npm/homebrew-style paths uses its own installed Codex
  binary.
- GUI uses `/Applications/Codex.app/Contents/Resources/codex`.
- On this Mac, GUI bundled `codex-cli 0.135.0-alpha.1` while local CLI processes
  included newer `0.136.0-alpha.1` builds.

Process model:

- CLI/TUI can run directly, start app-server on WebSocket, or use a daemon.
- GUI owns an Electron process and a child Rust app-server.
- GUI plugin/tool work can spawn additional `node_repl` and `codex app-server
  --listen stdio://` children.

Session storage:

- Both use `~/.codex/sessions` and `~/.codex/state_5.sqlite` when they share
  the same `CODEX_HOME`.
- GUI sessions are distinguished by metadata, especially
  `originator: "Codex Desktop"`.

Credential storage:

- CLI source supports `file`, `keyring`, `auto`, and `ephemeral`.
- AIMgr currently supports only file mode.
- GUI additionally has Electron profile storage and `Codex Safe Storage` in
  Keychain.
- On this Mac, Rust `Codex Auth` keyring storage was not present, but Electron
  safe storage was present.

Live auth switching:

- File-backed `auth.json` changes affect new Codex auth reads in both CLI and
  GUI app-server processes that use the same `CODEX_HOME`.
- A running app-server may cache auth. Live GUI switching may require a reload,
  app restart, app-server reload, logout/login protocol call, or an explicit
  external-token update.
- Editing Electron cookies or LevelDB is the wrong first approach.

## AIMgr Recommendations

Add a GUI-aware Codex session reader:

- Treat `~/.codex` as the default shared Codex home.
- Read `state_5.sqlite` for thread inventory.
- Read only the first JSONL line for `session_meta` when possible.
- Mark GUI sessions with `originator == "Codex Desktop"`.
- Preserve `source`, `thread_source`, `cli_version`, `cwd`, `rollout_path`, and
  subagent metadata.

Add support for official Codex auth backends:

- Keep current `file` behavior.
- Add `keyring` support using service `Codex Auth`.
- Add `auto` support with the same load/save order as Codex:
  - load keyring, then file
  - save keyring, then file fallback
- Compute the keyring account exactly as Codex does:
  - canonicalize `CODEX_HOME`
  - sha256 the canonical path string
  - take first 16 lowercase hex chars
  - prefix with `cli|`

Do not manage GUI credentials by editing Electron storage:

- Do not write `~/Library/Application Support/Codex/Cookies`.
- Do not write `~/Library/Application Support/Codex/Local Storage/leveldb`.
- Do not write `Codex Safe Storage` directly.

For live GUI auth switching, prefer app-server protocol work:

- Managed auth path:
  - Use supported account login/logout methods where possible.
  - Expect app-server cache/reload behavior.
- External auth path:
  - Only use `chatgptAuthTokens` if AIMgr is prepared to own refresh.
  - AIMgr would need to answer `account/chatgptAuthTokens/refresh`.
  - The protocol is marked internal/unstable upstream, so this should be behind
    a capability check or explicit experimental path.

Keep `aim codex use` compatible:

- Existing file-backed `aim codex use [label]` remains useful because this Mac's
  GUI app-server shares `~/.codex`.
- The next expansion should be `aim codex use` plus `keyring`/`auto`, not a
  separate Electron-cookie writer.

Add diagnostics before writes:

- Codex app version
- Bundled Codex version
- `CODEX_HOME`
- `cli_auth_credentials_store`
- Whether `Codex Auth` keyring item exists for the computed account
- Whether `~/.codex/auth.json` exists
- Whether a running `/Applications/Codex.app` app-server has open handles under
  that `CODEX_HOME`

## Open Questions

The normal GUI login path still needs one more targeted check if AIMgr is going
to modify live auth while the GUI is running:

- Does Codex Desktop call `account/login/start` with managed `chatgpt`, managed
  `chatgptDeviceCode`, or internal `chatgptAuthTokens` for the common login
  path on this install?
- When `~/.codex/auth.json` changes underneath a running GUI app-server, does
  the GUI reload it automatically, only on 401, only on account UI refresh, or
  only after restart?
- If `cli_auth_credentials_store = "keyring"` is set in the packaged app's
  shared `~/.codex/config.toml`, does the GUI app-server migrate/save to
  `Codex Auth` exactly like the packaged CLI?

Those questions are runtime-behavior questions. The storage contracts above are
clear enough to start AIMgr support for GUI session discovery and keyring/auto
credential projection.

