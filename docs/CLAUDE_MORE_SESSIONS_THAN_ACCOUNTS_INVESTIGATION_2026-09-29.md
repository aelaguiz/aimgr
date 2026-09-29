---
title: "Claude: run more sessions than accounts"
date: 2026-09-29
status: phase-1-implemented
owners: [aimgr]
related:
  - src/coordination/redis-credential-lease.js
  - src/cli/commands/claude.js
  - src/targets/claude-cli.js
  - src/credentials/claude-maintenance.js
  - src/credentials/harness-access.js
  - src/status/claude-redis-view.js
  - bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md
  - bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md
  - CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md
  - three-machine-credential-coordination-investigation-2026-05-30.md
---

# Claude: run more sessions than accounts

## Implementation status (2026-09-29)

Phase 1 is on `main`:

1. **One lease per machine.** `src/targets/claude-machine-lease.js` keeps a holder file per account in `~/.aimgr/runtime/claude-leases/`. The first session takes the Redis lease, later sessions join it with the same token (`joinRedisCredentialLease`), and the last one out releases it.
2. **A sibling's refresh is normal.** The launch-time login write keeps a local file that is as new as Redis or newer (`preserveNewerLocal`). Recovery after an outage accepts the local file's lineage. The 30-second copy to Redis reloads Redis before comparing.
3. **Selection shares.** `selectClaudeAccountForSession` ranks by usage left per session and treats this machine's held accounts as candidates.

**Live test on the M5 with `pro4`:**
- The second session joined instead of failing as busy.
- A forced renewal wrote the login file once, and both sessions kept working.
- Redis received the new login once (version 179).
- The first exit kept the lease; the last exit released it.

**Transition:** sessions started before this change hold their accounts alone until they exit. The old code keeps its lease token in memory, so new sessions cannot join them.

## TL;DR

1. **Why one session per account:** every Claude Code session that AIM starts holds the account's refresh token and refreshes it itself, about every 8 hours. A refresh makes the old refresh token useless. If two holders refresh from the same token, the second one gets "Login expired" and Claude wipes its tokens. AIM prevents that with a Redis lock, the *lease*, that allows one Claude process per account across all machines.
2. **The lock is stricter than the danger.** Claude Code already coordinates refreshes between processes that share one account folder on one machine. Anthropic's docs say so ("Parallel sessions on one machine share a saved login and coordinate its renewal"), and the 2.1.284 binary shows how: a lock file, a re-read before refreshing, and a compare-and-swap save. The real dangers are two *machines* holding the same refresh token, and AIM's own launch step overwriting a live credential file.
3. **What it costs today** (2026-09-29): 28 accounts. 22 are held, 20 of them by one session each on this Mac. 2 need a login. The 4 "ready" accounts are all at 100% of their weekly limit. A new `aim claude run` fails, while held accounts such as `cfo`, `office`, `product_growth` and `coder` sit at 0–9% usage.
4. **Recommendation, phase 1 (about 1 day):** make the lease belong to a machine instead of a process. Any number of sessions on one machine share one account's folder and login. Accounts stay exclusive between machines. Selection picks the account with the most headroom per session. This removes the limit for the way sessions run today, almost all on this Mac, and relies on behavior Anthropic documents. Before turning it on, run `claude update` once on Studio (2.1.202) and `amir-m3-36gb` (2.1.259).
5. **Phase 2, only if you need more sessions than accounts across machines:** a separate login per machine for the accounts you want there, or a one-year `claude setup-token` per account. The second loses claude.ai connectors and Remote Control. See [Phase 2](#phase-2-sharing-one-account-across-machines).

## What happens today

1. **The lease.** `aim claude run` sets the Redis key `…lease:credential:anthropic:<label>` only if nobody holds it (`SET NX`, 30 s expiry, random token) (`src/coordination/redis-credential-lease.js:121-145`). It renews the key every 10 s for the whole interactive session (`src/cli/commands/claude.js:79-80, 248-339`).
2. **A second session on the same account is refused.** The error reads `Claude account "<label>" is busy: another AIM process or machine is using or refreshing it` (`claude.js:374-381`).
3. **Losing the lease stops Claude.** If another owner holds the key at renewal, AIM terminates Claude (`claude.js:261-270`). If Redis is unreachable, AIM pauses Claude with `SIGSTOP` until ownership is confirmed again (`claude.js:271-303, 906-936`).
4. **Selection skips held accounts.** `aim claude run opus|fable|sonnet` picks the lowest five-hour usage among accounts whose lease is free, excluding exhausted ones (`src/status/claude-redis-view.js:1019-1068`). Status shows a held account as `IN USE`.
5. **Everything else follows from the lease.**
   - `aim claude resume` forks the conversation onto another account when its own account is held (`claude.js:1267-1343`).
   - Scheduled jobs stop your least recently used idle session to free an account (`claude.js:1122-1167`, `src/targets/claude-idle-stop.js`).
   - The token maintainer skips held accounts (`src/credentials/claude-maintenance.js:363-371`).

### How the login reaches Claude

1. At every launch, AIM writes the account's full login from Redis, access token and refresh token, into `~/.aimgr/claude-homes/<label>/.claude/.credentials.json` (`claude.js:987-992` → `src/targets/claude-cli.js:191-256`). The write is unconditional: it passes `currentBundle: null`, so it overwrites whatever the file holds (`claude-cli.js:208-214`).
2. A small `security` replacement placed first on `PATH` blocks the macOS Keychain for Claude's own entries. Claude therefore falls back to that plain 0600 file (`native/claude/security_shim.c`, `src/targets/claude-runner.js:548-553`).
3. **Claude refreshes the token itself** when fewer than 5 minutes remain, or right away after an HTTP 401. It writes the new tokens back into the file (`docs/CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md:443-460`). Access tokens last about 8 hours (same doc, lines 30, 152).
4. AIM copies a newer file back to Redis every 30 s and at exit, with a compare-and-swap write (`claude.js:483-576, 1046-1070`).
5. For accounts nobody is using, `aim auth maintain` runs every 60 s on the M3. When a token has 5 minutes or less left, it takes a 60 s lease, writes the Redis login into the account folder, runs `claude --print /usage` so Claude refreshes, and publishes the result (`claude-maintenance.js:30-44, 443-524`).

## Why the lease exists

The chain of reasons, each with its evidence:

1. **Refresh tokens are single-use.** Each refresh returns a new refresh token, and the old one stops working.
   - Observed on real accounts: "the access and refresh lineages changed together" (`CLAUDE_REDIS_OVERNIGHT_EXPIRY_INVESTIGATION_2026-07-24.md:380-381`).
   - Observed in production on 2026-09-23. A stale session tried to refresh with a token another AIM writer had already used, and Claude wrote empty tokens with `expiresAt: 0` and showed `Login expired` (`bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md:16-20, 36-41`).
2. **AIM does not refresh Anthropic tokens itself, by rule.** "The official Claude client owns OAuth refresh and login. AIM must not implement Anthropic OAuth or call a private refresh API" (`NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md:46-47`). AIM's old direct refresh throws "Direct Claude token refresh is retired" (`src/credentials/anthropic-maintenance.js:15-19`). So every refresh happens inside some Claude process.
3. **So every session holds the refresh token.** The live Claude process is the only thing that can refresh during a session. It therefore needs the full login.
4. **Nothing coordinates refreshes across machines.** Claude's own OAuth lock lives in the account folder on one machine. Two machines with copies of the same refresh token enter the same 5-minute window. The first refresh wins and the second gets `Login expired`.
5. **So AIM allows one holder per account, fleet-wide.** The design docs say it directly:
   - "One online per-label lease because official OAuth refresh tokens rotate and concurrent refresh can clobber lineage" (`AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md:68`).
   - "concurrent official-client refresh can invalidate the account" (`AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02.md:179-181`).
   - The lease came in on 2026-07-22 (commit `2b394f0`). It reversed a May plan that used no leases and accepted that "concurrent refreshes race on one key" (`REDIS_SHARED_CREDENTIAL_STORE_SIMPLIFIED_PLAN_2026-05-30.md:237-238, 277`).

**There is also an account-safety reason.** Codex accounts share refresh tokens between long-lived processes and the maintainer. That produced "refresh token revoked" errors and 401 storms of up to 303 a day. The audit notes that "repeated use of revoked tokens from several hosts is a classic account-compromise signal" (`CODEX_ACCOUNT_DEACTIVATION_AUDIT_2026-09-16.md:793, 830`). Any sharing design for Claude must make refresh-token reuse impossible, not merely recoverable.

### What the lease does *not* protect

1. **Stale Redis writes.** Compare-and-swap already rejects them (`AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md:67`).
2. **Account identity.** A separate check verifies it (`docs/aelaguiz/AIM_CLAUDE_REDIS_AUTHORITY_SIMPLIFICATION_2026-08-03.md:95`).
3. **Load spreading.** Selection spreads sessions only because it skips held accounts; the lease was not designed for it.

The 2026-08-02 overbuild review already said the lease is too broad: it "treats a short Redis lease as permission for the *entire Claude process to execute*, rather than as coordination for account selection and credential publication". It named "a same-home process lock" as the narrow answer (`bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md:21-23, 118`).

## Where the danger really is

| Situation | Safe? | Why |
|---|---|---|
| Several Claude processes, one Mac, one account folder | **Claude's side is safe** (high confidence). AIM's side is not, see the next section | Anthropic documents it, and the 2.1.284 binary implements it; details below. |
| Two machines, copies of one refresh token | **No.** Fails at the next refresh, within about 8 h | Each machine's lock is local. Both refresh from the same token and the loser gets `Login expired`. This is the 2026-09-23 incident: 10 of 13 running sessions had lost their lease (`bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md:43-45`). Anthropic's docs suggest the reuse can also revoke the winner's new login. |
| Maintainer running while a session holds the account | **No** | The maintainer would write the Redis login into the live folder and refresh from it. A 30-second-old unpublished rotation then reads as an empty file, and the maintainer publishes `oauth_reauth_required`, which shows as NEEDS YOU (`claude-maintenance.js:553-581`). |

### How Claude Code shares one login on one machine

**Anthropic's statement.** The official [troubleshooting page](https://code.claude.com/docs/en/troubleshoot-install), under "Not logged in or token expired", says:

> Parallel sessions on one machine share a saved login and coordinate its renewal so that only one process refreshes the token at a time. Before v2.1.211, waking the machine from sleep could cause two sessions to renew with the same token, which revoked the saved login and prompted every open session to log in again at once.

What the 2.1.284 binary (`~/.local/share/claude/versions/2.1.284`) does, from static inspection with no requests sent:

1. **Re-read first.** Before refreshing, Claude clears its cache and re-reads the stored login. If another process already replaced the access token, it adopts that token and stops. It logs this as `tengu_oauth_token_refresh_race_resolved`.
2. **Lock.** Claude takes a `proper-lockfile` lock at `<dir>/.oauth_refresh.lock` (stale after 60 s, retried 5 times), re-reads under the lock, and only then refreshes.
3. **Compare-and-swap save.** Claude writes the new tokens only if the stored refresh token is still the one it sent. Otherwise it adopts the sibling's tokens (`adopted_sibling`).
4. **Failure.** On `invalid_grant`, Claude re-reads again and adopts a sibling's tokens if they appeared. Only if the dead token is still stored does it blank the login and show `Login expired`.
5. **Shared location.** `<dir>` is `CLAUDE_SECURESTORAGE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`. AIM sets both to the label folder (`claude-runner.js:546-547`). So every AIM session for one label on one machine already shares one login file and one lock.

**Claude version.** The coordination exists only in newer builds. The docs name 2.1.211 as the fix for two sessions renewing with the same token after sleep, and the [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) fixed a related logout in 2.1.277. Two machines are older than that; run `claude update` on them once before turning sharing on. AIM needs no version logic.

| Machine | Claude Code | Action |
|---|---|---|
| M5 | 2.1.284 installed; running sessions are 2.1.282 to 2.1.284 | None |
| `laptop` (M3), `home` | 2.1.284 | None |
| `amir-m3-36gb` | 2.1.259 | `claude update` once |
| `studio` | 2.1.202 | `claude update` once |

## What breaks if the lease is simply removed

On one machine, Claude copes, but these AIM behaviors break:

1. **The launch write can bring back a used refresh token.** Suppose a running sibling refreshes between the new launch's pre-run read and its projection write. The write puts the old token back into the shared file. The new Claude refreshes with it, gets `invalid_grant`, and blanks the file for every sibling (`claude-preflight.js:92-97` then `claude.js:988-992`). Claude's compare-and-swap cannot catch this, because AIM replaced the whole file. Going by Anthropic's docs, the reuse may also revoke the sibling's new login.
2. **`.claude.json` gets unlocked read-modify-write edits** from the projection merge and the project-consent copy at every launch. Either can erase a running sibling's changes (`claude-cli.js:91-103, 157-171`; `claude-project-consent.js:45-94`).
3. **Overlay files change under running siblings.** `.aimgr-user-hooks.json` and `.aimgr-user-mcp.json` are rewritten at each launch, and deleted when you remove all your hooks or MCP servers. Running siblings still point at them (`claude-runner.js:77-123, 557-569`).
4. **Publishers compare against a stale Redis version.** Each session's publisher works from the Redis snapshot it loaded at launch. After a sibling publishes, the others retry a failing compare-and-swap every 30 s and print `degraded … local_candidate=retained` at exit even though Redis is correct (`src/coordination/runtime.js:154-229`; `claude.js:1066-1070`).
5. **Pause recovery kills siblings.** After a Redis outage, "the credential changed while paused" terminates the session (`claude.js:917-930`). A sibling's normal refresh would trigger it.

Across machines, it is fatal: every holder except the first refresher dies at each 8-hour refresh.

## Options

Ranked by value for risk.

| # | Option | Sessions per account | Rests on | Gives up | Cost |
|---|---|---|---|---|---|
| 1 | **Per-machine lease** (recommended) | Unlimited on one machine; one machine per account at a time | Claude's documented same-machine coordination | Nothing | About 1 day |
| 2 | A separate login per machine | Unlimited on every machine with its own login | Anthropic allowing several logins per account at once; normal multi-device use, no documented cap, untested here | One browser login per account per extra machine | Phase 1 plus about 1–2 days |
| 3 | One-year `claude setup-token` per account | Unlimited on every machine | Documented: subscription billing, never refreshes | claude.ai connectors, Remote Control, probably profile and usage views; manual yearly renewal | One browser login per account plus about 2 days |
| 4 | Access-token-only sessions fed by one refresher (the Pi/Prime model) | Unlimited on every machine | Untested: that a refresh leaves older access tokens valid, and that followers never need their own refresh | A session whose token runs out dies | About 4–5 days plus experiments on real accounts |
| 5 | Rejected: remove the lease; `apiKeyHelper` | — | `apiKeyHelper` output is sent as an API key and turns subscriber mode off | Accounts at every refresh | — |

**Precedent for sharing.** Pi and Prime sessions already share accounts: "separate roots may choose the same least-used label" (`PRIME_ANTHROPIC_BALANCED_ROTATION_MINI_ARCH_PLAN_2026-09-02.md:84-85`). They receive only an access token from `aim credential-helper`, and refreshes run one at a time under a short lease (`src/credentials/harness-access.js:336-339`). As the routines analysis put it: "Refresh leases protect refresh-token mutation, not account allocation" (`AI_MANAGER_SCHEDULED_ROUTINES_HERDR_ANALYSIS_2026-08-12.md:296`).

## Recommended design: phase 1, a per-machine lease

**New rule:** at most one machine holds an account at a time. Any number of AIM-managed Claude sessions on that machine share the account's single folder, `~/.aimgr/claude-homes/<label>/.claude`, and its single login file. They already do: the folder path depends only on the label (`resolveManagedClaudeDir`).

**Why it is safe:** within one machine, Claude's own lock makes sure exactly one process refreshes and the rest adopt the new token. Between machines, the lease still guarantees one holder of the refresh token. Nothing ever reuses a refresh token, which also avoids the compromise pattern from the Codex audit.

### Three changes

1. **One lease per machine.** The first session on an account takes the lease and saves its token in a small local file. Later sessions on the same machine reuse that token and keep renewing it. The renew script only compares the token, so it works unchanged (`redis-credential-lease.js:12-33`). The last session to exit releases the lease.
2. **Treat a sibling's refresh as normal.** Three spots currently assume no other session exists:
   - At launch, skip rewriting the login file from Redis when other sessions on that account are running; their file is newer (`claude.js:988-992`).
   - After a Redis outage, don't stop a session because the login changed. A sibling refreshed it (`claude.js:917-930`).
   - The 30-second copy to Redis reloads Redis before comparing (`claude.js:483-576`).
3. **Selection allows sharing.** Accounts held by this machine become candidates. Pick the account with the most usage left per session:

   ```text
   score = min(100 - fiveHourUsed%, 100 - weeklyUsed%) / (sessionsOnThisMachine + 1)
   ```

   A launch fails only when every account is exhausted, needs a login, or is held by another machine.

**What follows without extra work:**
- `aim claude resume` rejoins its own account, because the account is no longer "busy".
- Scheduled jobs get an account without stopping idle sessions.
- The maintainer and the Pi/Prime helper still skip held accounts, as today.

**One-time step:** run `claude update` on Studio and `amir-m3-36gb`.

**One test before switching everyone over (about 30 min):** run two sessions on one account on this Mac. Move `expiresAt` in its login file to 4 minutes ahead, then send a prompt in each session. Pass: no `Login expired`, and Redis gets the new login once.

**Estimate:** about 1 day.

## Phase 2: sharing one account across machines

You need this only to run more sessions than accounts on a machine other than the M5, or to use one account on two machines at once. Today 20 of the 22 held accounts are held from this Mac.

**The constraint:** a refresh token can live in only one machine's login file, because only a local lock coordinates refreshes. So sharing across machines needs a separate refresh token per machine, a token that never refreshes, or sessions that never hold a refresh token.

1. **A separate login per machine** (recommended if needed).
   - This is the preferred flow from the May three-machine investigation: "Each machine logs into the same label independently … Do not clone one refresh token and let two machines keep using it concurrently" (`three-machine-credential-coordination-investigation-2026-05-30.md:147-157`). It was dropped for simplicity, not for an OAuth reason.
   - Redis keeps one credential record per label and machine. The lease key includes the machine, so each machine's lease is effectively local. Phase 1 then applies unchanged on every machine.
   - Cost: one `aim login <label>` browser flow per account per extra machine. Log in only the accounts you want there.
   - Unknown: whether Anthropic caps concurrent logins per account (test 1 below).
2. **A one-year `claude setup-token` per account.**
   - The [authentication docs](https://code.claude.com/docs/en/authentication) describe a "one-year OAuth token" that "authenticates with your Claude subscription" and "can only make model requests". The binary requests `inferenceOnly` with a 31,536,000-second lifetime. It never refreshes, so any number of sessions on any machine can use it without a lease.
   - It gives up claude.ai connectors (such as the Claude Docs connector), Remote Control, and probably in-session profile and usage views. Each token needs renewing by hand every year, and a leaked one-year token is worth more than an 8-hour one.
   - Delivery: AIM strips `CLAUDE_CODE_OAUTH_TOKEN` today (`claude-runner.js:22-35`). It would pass the token through the `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` variant instead, which keeps AIM's rule that tokens never sit in the environment or argv.
   - An unverified community report says running `claude setup-token` may revoke the account's existing login ([#48786](https://github.com/anthropics/claude-code/issues/48786)). Test on a spare account first (test 2 below).
   - Best fit: overflow sessions that don't need connectors.
3. **Access-token-only sessions fed by one refresher.** Not recommended.
   - A token passed in `CLAUDE_CODE_OAUTH_TOKEN` is fixed when the session starts. On a 401 Claude keeps it and tells you to restart, so an interactive session dies at the roughly 8-hour expiry.
   - A variant keeps a login file with no refresh token and has AIM update it from Redis; Claude's "re-read first" step would adopt each new token. It needs all of these:
     - a keeper that refreshes on the holder machine before expiry;
     - a push to every follower inside the 5-minute window;
     - proof that a refresh leaves older access tokens valid.

     Any miss blanks that follower's login.
4. **Rejected.**
   - `apiKeyHelper`: Claude sends its output as an API key and turns subscriber mode off. A setup-token sent that way gets `401 … API key is invalid` ([#97350](https://github.com/anthropics/claude-code/issues/97350)).
   - Removing the lease.

### Tests, only if phase 2 goes ahead

1. **Test 1:** give one account a second login on another machine. Pass: both logins refresh independently for 24 hours and the first login survives.
2. **Test 2:** run `claude setup-token` on a spare account. Pass: the normal login survives and sessions bill to the subscription. Also record which features are missing.

## Open questions

1. **Does reusing a used refresh token also revoke the new login?**
   - For: Anthropic's docs say two renewals with the same token "revoked the saved login and prompted every open session to log in again".
   - Weakly against: on 2026-09-23 the new Redis credential still worked at 13:52 (`bugs/AIM_MANAGED_CLAUDE_LOGIN_EXPIRED_AFTER_SLEEP_2026-09-23.md:41`).
   - Either way, phase 1 never reuses a token.
2. **Does a refresh invalidate the previous *access* token right away?** This matters only for option 4.
3. **How many logins can one account hold at once?** This matters only for option 2.
4. **What killed `pro5`'s refresh token on 2026-07-23?** The docs never found out (`NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23_WORKLOG.md:203-221`).

## Separate findings

These turned up during the investigation. None of them blocks phase 1.

1. **Status says `use now` for exhausted accounts.** `coder2`, `pro10`, `pro4` and `pro9` show `READY … use now` at 100% weekly usage. Selection correctly skips them.
2. **The credential helper can report a false failure.** A Pi/Prime caller that gets the lease just after another caller finished refreshing ends at `skipped/not_due`, which maps to `coordination_unavailable` instead of returning the fresh token (`harness-access.js:325-334`; `claude-maintenance.js:465-466`).
3. **`~/.aimgr/local-state.json` is rewritten whole** from each process's copy, which already races across accounts (`runtime.js:63-82`).
4. **A cited doc is missing.** `CLAUDE_CODE_OAUTH_LIFECYCLE_AND_KEEPALIVE_2026-07-24.md` is referenced by `bugs/AIM_MANAGED_CLAUDE_DIES_ACROSS_MACOS_SLEEP_2026-07-25.md:10` but is not in the repo.
