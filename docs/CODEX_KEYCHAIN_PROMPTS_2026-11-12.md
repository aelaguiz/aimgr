# Codex keychain password dialogs on the AIM fleet

Date: 2026-11-12. Machines checked over SSH: M5, M3 Max, M3 36 GB, Mac Studio, Mini 1, Mini 2, old M1, home server. Mini 3, Mini 4 and Mini 5 did not answer.

## Answer

Codex does not need the macOS keychain. Every machine's `~/.codex/config.toml` already sets `mcp_oauth_credentials_store = "file"`, and AIM already keeps Codex logins in `auth.json`.

AIM brings the keychain back. The Codex privacy release, live on every machine as release `9e6cd79`, does two things:

1. It adds `-c mcp_oauth_credentials_store="keyring"` to every Codex launch, overriding the file setting.
2. On 2026-11-09, `aim codex mcp-migrate` copied the MCP sign-ins (Figma, Linear, Sentry and others) from `.credentials.json` into the keychain.

The copy was made by AIM's own helper program, which OpenAI did not sign. macOS lets a program read a keychain item silently only if the item's creator allowed that program's signer. Codex is signed by OpenAI, so each read of those items asks for the login password. Every AIM Codex session and routine reads them at startup. Nobody is at the remote machines to type the password, so the dialogs stay open.

**Fix it in AIM, not Codex.** I recommend option A below: stop forcing keychain mode and let Codex use the file store its config already asks for. That needs one decision from you, about where the file lives.

## Which machines are affected

| Machine | Who created the Codex MCP keychain items | Keychain dialog process (SecurityAgent) | State |
| --- | --- | --- | --- |
| M3 36 GB | AIM helper, 2026-11-09 18:28:48–49 CST (`linear`, `sentry`, `figma`) | Started 18:28:50, one second later, and still running. It logged 468 lines in the last 6 hours, so its window is in active use. | **Prompting now** |
| Mini 1 | AIM helper, 2026-11-09 around 18:18 CST (9 items: granola, linear, figma, fly, circleci, sentry, customerio, posthog, firecrawl) | Started 2026-11-10 01:03 local time, still running | **Prompting** (dialog open) |
| Mac Studio | Codex itself, 2026-04-01 (`figma`) | Started 2026-11-09 17:55, during the migration. Quiet in the last 6 hours. | One leftover dialog |
| M3 Max | Codex itself, 2025-11 (`figma`, `linear`, `sentry`) | None | Fine |
| Mini 2 | None (nothing to migrate) | None | Fine |
| M5 | None. `.credentials.json` was set aside by hand on 2026-11-09 at 19:07; there was no migration. | None | Fine, but see side findings |
| old M1, home server | None | None | Fine |

The M3 Max and the M3 36 GB run the same release, config and Codex build, and hold the same three keychain entries. The only difference is who created the items. The M3 Max's items were written by Codex and nothing prompts. The M3 36 GB's items were written by AIM's helper and the dialog has been open since that minute.

## How it happens

1. **AIM forces keychain mode on every launch.** [`src/privacy/codex-native-invocation.js:37`](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/src/privacy/codex-native-invocation.js#L37) prepends `-c mcp_oauth_credentials_store="keyring"`. [Line 75](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/src/privacy/codex-native-invocation.js#L75) refuses to start Codex if anything sets otherwise. `aim codex` launches (`src/targets/codex-runner.js`) and routines (`src/routines/run.js`) both go through this path. Added in `be24f9e` on 2026-11-04.
2. **AIM refuses to start until the tokens are migrated.** [Lines 44–49](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/src/privacy/codex-native-invocation.js#L44-L49) block every launch while `~/.codex/.credentials.json` holds anything, and tell you to run `aim codex mcp-migrate`. That is why each machine got the migration on 2026-11-09. The agent's own working folder is still there: `~/.aimgr/audits/mcp-migration-20261109/` on the M3 Max, M3 36 GB, Mini 1 and Studio.
3. **The migration helper wrote the items under its own signature.** The helper is `/opt/aimgr-codex-runtime/artifacts/<set>/mcp-keyring`, built from [`native/codex/mcp-keyring`](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/native/codex/mcp-keyring/src/main.rs). On the M3 36 GB, `codesign` reports it as `Signature=adhoc`, `TeamIdentifier=not set`. [`native_access.c:17-25`](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/native/codex/mcp-keyring/native_access.c#L17-L25) creates each item with an access list that names the helper and the Codex binary. Since macOS 10.12, the access list alone does not decide this. Each item also carries a "partition list" of allowed signers, which is set from the creating program's signature, here the helper's ad-hoc one. Codex is signed by OpenAI (Team ID `2DC432GLL2`), which is not on that list, so macOS asks for the keychain password. Changing the partition list later also needs the password.
4. **Codex reads the items at every session start.** In keychain mode, Codex looks up stored tokens for each enabled HTTP MCP server when it connects. A lookup for a missing item fails quietly. A lookup for one of the helper's items opens the dialog. Token refreshes and writes to those items would prompt too.
5. **The helper also prompts when it reads items Codex created.** The helper reads each existing item before inserting ([`main.rs:86`](https://github.com/aelaguiz/aimgr/blob/9e6cd7962987cc42bd567cb704dcd85ef609e420/native/codex/mcp-keyring/src/main.rs#L86)). That is the likely source of the one dialog on the Studio, whose only item was created by Codex in April. The helper runs only for `aim codex mcp-migrate` and `mcp-recover`, so this happens once per migration, not every day.

I could not read the items' access lists directly, because `security dump-keychain -a` prints none over SSH without the keychain password. The partition-list explanation in step 3 is inferred from the code, the signatures and the M3 Max versus M3 36 GB comparison. It is not read from the items.

## Where Codex can keep credentials

Source: Codex [`config/src/types.rs`](https://github.com/openai/codex/blob/54201ea65a3501d09a87c776376a0c16aa39db70/codex-rs/config/src/types.rs) and [`rmcp-client/src/oauth/resolved_store.rs`](https://github.com/openai/codex/blob/54201ea65a3501d09a87c776376a0c16aa39db70/codex-rs/rmcp-client/src/oauth/resolved_store.rs). The installed `codex-cli 0.163.0-alpha.5` contains the same storage code; I checked by searching the binary's strings.

| What | Setting | Codex default | Fleet config | Effective under AIM |
| --- | --- | --- | --- | --- |
| ChatGPT login | `cli_auth_credentials_store` | `file` (`auth.json`) | file | file. AIM enforces it. |
| MCP server OAuth tokens | `mcp_oauth_credentials_store` | `auto` (keychain first, service "Codex MCP Credentials") | `file` | **keyring**, forced by AIM |
| Model-provider gateway OAuth | per provider | keychain (service `codex`) | not used by any configured provider | not used |

In `file` mode, Codex never reads the keychain when it loads or saves MCP tokens. The one exception is `codex mcp logout <server>`: it deletes from the keychain and the file regardless of mode ([`oauth.rs` delete path](https://github.com/openai/codex/blob/54201ea65a3501d09a87c776376a0c16aa39db70/codex-rs/rmcp-client/src/oauth.rs#L667)). Don't run it for servers that still have AIM-created items, or it will prompt.

The "Codex Safe Storage" item on the M5 and the M3 Max belongs to the Codex desktop app. AIM does not touch it, and no machine showed a dialog for it.

## Resolution

Amir chose option A on 2026-11-12 ("I don't want it to use the Mac OS keychain"). Tracked in [#33](https://github.com/aelaguiz/aimgr/issues/33).

- AIM launches Codex with `mcp_oauth_credentials_store="file"` and refuses any other effective mode ([`codex-native-invocation.js`](../src/privacy/codex-native-invocation.js)).
- Each account home hard-links the shared `~/.codex/.credentials.json`, so one sign-in per machine serves every account ([`linkCodexMcpCredentials`](../src/privacy/codex-account-state.js)). Codex writes that file in place and never replaces it, and the account homes already share `mcp-oauth-locks/`, so refreshes stay serialized. When no store exists yet, AIM creates it as `{}`, Codex's empty store, so the first sign-in in any home reaches every account.
- The launch refusal that demanded `aim codex mcp-migrate` is gone. `mcp-migrate` and `mcp-recover` print that there is nothing to do, and the migration owner, the keychain audit harness and their tests are removed. The reviewed native runtime bundle is unchanged, so no new bundle approval is needed.
- Tested on the M5 through the real native sandbox with a throwaway shared home and a copy of the backed-up tokens:
  - `codex mcp list` read Figma and CircleCI as signed in.
  - `codex mcp logout fly` rewrote the shared file in place: same inode, 2 links.
  - A real `codex exec` session answered and connected to Figma and CircleCI.
  - No SecurityAgent process started at any point.
  - The full suite matched `origin/main`: the same 5 SOCKS/proxy tests fail on both.

### Rollout, 2026-11-12

- **Installed:** devcluster installed `ca7c9d4` and its post-install check passed on the M5, M3 Max, M3 36 GB, Mac Studio, home server and Mini 1–5. The old M1 was mid-sync and installs on its own timer; it has no Codex keychain items and never prompted.
- **Sign-ins restored:** `~/.codex/.credentials.json` was restored from `.credentials.json.before-privacy` on the M5 (9 servers), M3 Max (4), M3 36 GB (3), Mini 1 (9) and Studio (1). The restore writes in place, so homes already linked keep the same file. On the M5, the `pro3` home linked to it, and Figma and CircleCI read as signed in.
- **Dialogs dismissed:** the stuck SecurityAgent processes on the M3 36 GB, Mini 1 and Studio ignored SIGTERM, so they were ended with SIGKILL, which macOS treats as Cancel. None came back in six fleet-wide checks from 15:40 to 15:45 CST.

Still true afterwards:

- The AIM-created keychain items stay where they are, unused: 3 on the M3 36 GB, 9 on Mini 1. Deleting them needs the login password, and nothing reads them now. Don't run `codex mcp logout` for those servers on those machines, because logout touches the keychain even in file mode. `codex mcp login` and token refreshes write only the file.
- Three `codex exec` workers on Mini 1 were started by the old release in keychain mode. They keep that mode until they exit; new launches use the file store.
- Fly's saved token expired on 2026-11-06 and has no refresh token, so Fly needs a fresh `codex mcp login fly` on any machine that uses it.
- The M3 36 GB's restored Figma, Linear and Sentry tokens had expired weeks to months before the migration (Figma around 2026-10-15), so `codex mcp list` shows them as not signed in. Its first session tries their refresh tokens; run `codex mcp login <server>` for any that fail. On Mini 1, a real `aim codex run pro6 -- mcp list` showed Figma and CircleCI signed in with no dialog.

## Options considered

### A. Stop forcing the keychain (chosen)

Change AIM:

- Remove the forced `mcp_oauth_credentials_store="keyring"` (line 37) and the keyring requirement (line 75).
- Remove the launch refusal while `.credentials.json` exists (lines 44–49).
- Retire `aim codex mcp-migrate`, `mcp-recover` and the `mcp-keyring` helper.

Codex then uses the file store each machine's config already names, and touches no keychain.

The decision for you: where the file lives. In file mode, Codex keeps MCP tokens in `$CODEX_HOME/.credentials.json`. Under the privacy layout, `CODEX_HOME` is a private home per Codex account (`~/.aimgr/accounts/openai-codex/<hash>/homes/<hash>`). Codex refuses to write through a symlinked `.credentials.json`; upstream has a test, `fallback_file_write_does_not_follow_symlinks`, that checks exactly this. One shared file for all accounts therefore doesn't work without an upstream change. Each Codex account on a machine keeps its own file and signs in to each OAuth MCP server once. In today's config, judging by which servers have saved tokens, those are Figma, Fly and CircleCI. Copy one token set into one account home at most. Some servers rotate the refresh token on refresh, so several copies of the same token break each other.

Existing tokens can come back without a password from the `.credentials.json.before-privacy` backups. They exist on the M3 Max, M3 36 GB, Mini 1, Studio and M5. On the M3 36 GB and Mini 1, Codex never managed to read the migrated items, so the backups have probably not been refreshed past. On the M3 Max and Studio, Codex may have refreshed since 2026-11-09, so expect to sign in again there.

This reverses a recorded privacy decision ("M1 converts File MCP to native Direct keyring" in the [privacy inventory](AI_APP_PRIVACY_INVENTORY.md)). If you choose it, update the inventory.

### B. Keep the keychain and give Codex silent access

On each machine with helper-created items (M3 36 GB, Mini 1), type the login password once in a terminal over SSH, not in the GUI dialog, for each item:

```bash
security set-generic-password-partition-list \
  -S "teamid:2DC432GLL2,apple-tool:,apple:" \
  -s "Codex MCP Credentials" -a "<server|hash>" \
  ~/Library/Keychains/login.keychain-db
```

Then change `mcp-migrate` so the ad-hoc helper never creates items. Otherwise Mini 3, 4 and 5, or any new machine, gets the same problem on its first migration. Items that Codex itself creates stay silent across Codex upgrades, because OpenAI's Team ID doesn't change; the M3 Max shows this. I have not run this command; it is untested here.

### C. Stopgap with no code change and no password

Disable the OAuth MCP servers that have AIM-created items in `~/.codex/config.toml` on the M3 36 GB and Mini 1: `figma` on the M3 36 GB, and `figma`, `fly` and `circleci` on Mini 1. Codex then never opens those items. Those tools already can't sign in on those machines, so nothing working is lost. Two caveats: every machine's `config.toml` was modified within a few minutes of each other today (14:48 to 14:55 CST), so something syncs it, and a local edit may be overwritten. Disabling a server also hides it on that machine everywhere.

## Dialogs already on screen

The SecurityAgent windows on the M3 36 GB, Mini 1 and Studio stay open until someone dismisses them. Cancel needs no password, and Screen Sharing works. After option A or B, nothing reopens them.

## Side findings

- **The M5 has no Codex MCP sign-ins.** Its `.credentials.json` was moved to `.credentials.json.set-aside-20261109-1907` rather than migrated. `~/.aimgr/codex-cli/.credentials.json` is now a symlink to a file that doesn't exist. Any OAuth MCP server will need a fresh sign-in there.
- **Mini 3, Mini 4 and Mini 5 were unreachable,** both from `aim cluster status` and over SSH. If they have a `.credentials.json` with entries, their first AIM Codex launch will demand `aim codex mcp-migrate` and reproduce this.
- **This checkout is behind.** `main` here is `93db27e`; the fleet and `origin/main` run `9e6cd79`. Code references above point at `9e6cd79`.

## Method

All checks were read-only. I printed no secret values.

- Codex source at [`54201ea65a`](https://github.com/openai/codex/tree/54201ea65a3501d09a87c776376a0c16aa39db70): `config/src/types.rs`, `rmcp-client/src/oauth.rs`, `rmcp-client/src/oauth/resolved_store.rs`, `login/src/auth/storage.rs`, `login/src/oauth_session_storage.rs`, `secrets/src/`.
- AIM at `9e6cd79`: `src/privacy/codex-native-invocation.js`, `src/privacy/codex-account-state.js`, `native/codex/mcp-keyring/`, `native/codex/approved_launch_macos.c`.
- Per machine over SSH:
  - Codex binaries, versions and signatures
  - every `config.toml` store setting
  - Codex keychain item names and creation times, from `security dump-keychain` and `security find-generic-password` without `-g`
  - running SecurityAgent processes, and SecurityAgent activity from `log show`
  - the signatures of AIM's runtime artifacts in `/opt/aimgr-codex-runtime/artifacts/`
- Not possible: the unified log for 2026-11-09 18:28 on the M3 36 GB had already rotated out. Accessibility access is denied over SSH, so I could not read the dialog's text.
