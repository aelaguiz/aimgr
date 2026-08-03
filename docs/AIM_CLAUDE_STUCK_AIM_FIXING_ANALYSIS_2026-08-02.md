---
title: "Why six Claude accounts are stuck in AIM FIXING — root-cause and UX analysis"
date: 2026-08-02
status: analysis
owners: [aelaguiz]
reviewers: []
doc_type: investigation
related:
  - docs/AIM_CLAUDE_HUMAN_STATUS_MINI_ARCH_PLAN_2026-08-02.md
  - docs/AIMGR_SINGLE_OPERATOR_SIMPLIFICATION_MINI_ARCH_PLAN_2026-08-02_IMPLEMENTATION_LOG.md
  - docs/AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md
  - docs/bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md
  - docs/bugs/CLAUDE_STALE_ROTATION_PENDING_HIDDEN_FROM_STATUS_2026-07-28.md
---

# TL;DR

The six `AIM FIXING` rows are not being fixed. Nothing is retrying in any
sense that can succeed, and for five of the six the displayed promise "AIM
will retry" is structurally impossible to fulfill. Each account is
permanently wedged on a guard that only a human action on a specific machine
can clear, and the status UI — redesigned four hours before this analysis —
deliberately hides that.

Per account, verified against live Redis, both machines' local state, and the
maintainer log:

| label | actual defect | where the truth lives | only real fix |
|---|---|---|---|
| boss | Rotation fence owned by **this machine (M5)** since 2026-07-30; local files intact and matching | M5 | `aim claude run boss` **on M5** (recovers and clears the fence) |
| pro4 | Same pattern, fence since 2026-07-31 | M5 | `aim claude run pro4` on M5 |
| pro5 | Same pattern, fence since 2026-07-31 | M5 | `aim claude run pro5` on M5 |
| pro2 | Fence owned by **neither M5 nor M3** — a third machine or a dead installation | home/Studio? | run it on the owning machine, else `aim claude capture-native pro2` / `aim login pro2` |
| growth | No fence. M5 holds a complete bundle whose lineage **differs from Redis** (possible unpublished rotation) | M5 | `aim claude run growth` on M5; if it throws a lineage error, `capture-native`/`login` |
| qa | No fence. M5's local bundle matches Redis exactly; token simply expired today | M5 | `aim claude run qa` on M5 |

The auth maintainer — the "AIM" that "will retry" — runs only on M3, and M3
has **empty** managed credential directories for all six accounts. It has
failed every 60 seconds since each account became due (thousands of
consecutive identical failures; boss alone ≈ 5,000). Its own log proves it:

```text
provider=anthropic label=boss   outcome=retryable reason=local_state_conflict
provider=anthropic label=growth outcome=retryable reason=local_state_conflict
provider=anthropic label=pro2   outcome=retryable reason=local_state_conflict
provider=anthropic label=pro4   outcome=retryable reason=local_state_conflict
provider=anthropic label=pro5   outcome=retryable reason=local_state_conflict
provider=anthropic label=qa     outcome=retryable reason=local_state_conflict
refreshed=0 unchanged=0 reauth_required=0 retryable=7 skipped=34   (every run, exit 1)
```

No command was harmed gathering this: all diagnostics were read-only. Nothing
below required changing Redis, files, or running repairs.

# 1. What you are looking at

`aim claude status` (2026-08-02 19:42 CDT, M5):

```text
CLAUDE: 4 ready · 7 in use · 6 AIM fixing · 0 needs you · 0 unknown
```

All six "fixing" rows show `--` in every usage column and `AIM will retry` in
`next`. The live JSON for the same six rows:

- `credentialState: "credential_expired"` on all six (Redis access token past
  `expiresAt`, bundle otherwise complete). Expiry spans 2026-07-30 (boss) to
  2026-08-02 (growth, qa — expired *today*).
- `rotationPending: true` on boss, pro2, pro4, pro5 — a durable Redis key
  `aimgr:v1:fence:claude-rotation:<label>` exists, written with **no TTL**
  (`src/coordination/redis-claude-rotation-fence.js:103`). These fences were
  created 2026-07-30 → 2026-08-01, i.e. before the 2026-08-02 single-operator
  cutover, and are now 1.5–3.6 days old.
- `localProjection: missing` on M5 for all six — no projection receipts here.
- Usage `--` is deliberate: the collector never fetches usage for a credential
  it already knows is expired (`buildStaticAccount`,
  `src/status/claude-redis-view.js:509-523`, gate at :929-932). The blank
  columns mean "we refused to look," not "no usage exists."

Two consequences the table does not tell you:

1. **All six are excluded from automatic selection**
   (`src/cli/commands/claude.js:268-273`, `src/status/redis-view.js:315`), and
   explicit runs of the fenced four throw in preflight
   (`src/cli/commands/claude.js:776-847`). Your 17-account pool is an
   11-account pool; the rows are not informational, they are quarantine.
2. **The renderer cannot escalate.** `NEEDS YOU` requires an explicit
   `reauth_required` fact (`claude-redis-view.js:1195-1203`), which the
   maintainer only sets for an incomplete bundle (`refresh_material_missing`)
   or provider-wiped files (`native_session_expired`)
   (`src/credentials/claude-maintenance.js:199-221`, :411-441). The failure
   classes these six accounts are in never reach that branch — so the one
   honest label is unreachable, and they wear the optimistic one forever.

# 2. How the machine works (as built)

Facts per account come from four sources, merged at render time
(`collectClaudeRedisAccountUsageStatus`, `claude-redis-view.js:818-1061`):

1. **Redis credential record** (`aimgr:v1:credential:anthropic:<label>`) —
   versioned, CAS-written authority holding the full OAuth bundle.
2. **Redis lease** — 30s online lock marking a live session.
3. **Redis rotation fence** — durable NX marker recording the *base* token
   lineage plus a `recoveryStorageId` =
   sha256(storage-contract + per-machine `installationId` + per-label
   configDir) (`src/targets/claude-cli.js:109-115`). It exists because
   Anthropic rotates the refresh token on every refresh: if a process dies
   after the official client rotated tokens but before AIM published the
   successor to Redis, the only valid refresh lineage lives in that machine's
   files, and the fence is what forces recovery to happen *there*.
4. **Local usage cache** — `~/.aimgr/redis-cache.json`.

The human label is a pure render-time projection over those facts
(`describeClaudeOperatorState`, `claude-redis-view.js:1189-1221`): IN USE →
NEEDS YOU → **AIM FIXING** (fence pending, refresh-in-progress, 401, or
expired-complete token) → READY → UNKNOWN. Four mechanically different states
share one label and one next-action string, "AIM will retry"
(hardcoded at `claude-redis-view.js:1210`).

The retry actor is the auth maintainer: a launchd job on **M3 only**
(`com.funcountry.aimgr.auth-maintainer`, every 60s,
`scripts/install-auth-maintainer.sh:88-91`; confirmed absent on M5). Per due
record it: takes a 60s lease → reads the fence and attempts recovery →
reconciles local files against Redis → refuses anything it cannot explain →
projects the Redis bundle into the per-label home → runs the real
`claude ... /usage` so the official client performs the OAuth refresh →
publishes the rotated tokens and clears the fence
(`src/credentials/claude-maintenance.js:154-483`).

The design's load-bearing assumption: **the machine running maintenance holds
(or can safely reconstruct) the account's local state.** That assumption is
false for all six accounts on M3.

# 3. What actually happened (evidence timeline)

- **2026-07-30 → 08-01**: boss, pro4, pro5, pro2 runs end with a fence left in
  Redis (crash, Ctrl-C, machine sleep, or network loss between fence-create
  and fence-clear — the exact 2026-07-23 failure mode in
  `docs/bugs/CLAUDE_CTRL_C_STRANDS_ROTATION_FENCE_2026-07-23.md`). For
  boss/pro4/pro5 the creating machine was **M5**; pro2's was a third machine.
- **2026-07-30 → 08-02**: the old maintainer fails these accounts every run —
  the M3 log's pre-cutover format shows `failed=5` on every one of 13,126
  logged runs. Nothing new happened this week; the failure is days old.
- **2026-08-02 ~13:10 CDT**: the single-operator simplification deploys
  (`1623176`, then status relabel `b8b9756`, `28f5b6f`). The implementation
  log already lists boss/pro2/pro4/pro5 as fenced blockers requiring
  "recovery from their owning storage or explicit reauthentication"
  (`..._IMPLEMENTATION_LOG.md:16,48,100`) — the cutover shipped with known
  stuck accounts.
- **2026-08-02 14:30 / 15:56 CDT**: growth's and qa's access tokens expire.
  Both records were last written at 19:30 UTC without an expiry change —
  consistent with the cutover's canonical-record rewrite, not a rotation. On
  their first due pass the new maintainer wedges them too.
- **2026-08-02 18:11 CDT**: the human-status relabel deploys fleet-wide. The
  four-day-old quarantine is now rendered as `AIM FIXING / AIM will retry`.
- **2026-08-02 19:33 CDT**: maintainer run #~13,100+ logs the same
  `retryable=7`, exit 1. (The 7th is a Codex account, `amir_personal`
  `maintenance_failed` — same daemon, same invisible stall, different table.)

Live fence facts (read-only dump, script in `.tmp/m3-diag.mjs`):

```text
label  fence.createdAt              fence.storageId   M5 match  M3 match  Redis lineage == fence base  local files
boss   2026-07-30T11:16:59Z        sha256:708ac…     YES       no        yes (v19, dd210…)            M5: complete, matches Redis
pro4   2026-07-31T13:36:09Z        sha256:51821…     YES       no        yes (v22, 6b2e1…)            M5: complete, matches Redis
pro5   2026-07-31T20:58:34Z        sha256:d401b…     YES       no        yes (v21, 40690…)            M5: complete, matches Redis
pro2   2026-08-01T12:40:03Z        sha256:b0c26…     no        no        yes (v26, 9e5a5…)            M5: empty; M3: empty
growth (none)                      —                 —         —         n/a                          M5: complete, lineage ≠ Redis
qa     (none)                      —                 —         —         n/a                          M5: complete, matches Redis
```

All six managed dirs on M3: `.credentials.json` **missing**
(`native_storage_empty`). No projection receipts for any of the six on M3.

# 4. Why it does this (root causes, ranked)

## 4.1 The retry actor cannot reach the problem

The maintainer's fence recovery hard-stops when the fence's
`recoveryStorageId` doesn't match the machine computing it
(`src/targets/claude-cli.js:324-328`: *"unresolved rotation on another
machine; recover there or replace it"*). That check is working exactly as
designed — boss/pro4/pro5 belong to M5, pro2 to a third machine — but the
fleet runs its only maintainer on M3. The daemon retries hourly-forever a
recovery it is architecturally forbidden to perform, on empty directories,
while the accounts' actual files sit healthy on M5 with no daemon there.

Even for unfenced growth/qa, M3's path is: project the (expired) Redis bundle
into an empty dir, run `claude /usage`, and reconcile. The probe exits
without producing a rotation, and the post-run reconciliation falls into the
catch-all `retryable/local_state_conflict`
(`claude-maintenance.js:458-466`). The underlying sync sub-reason is **not
logged anywhere** — the log carries only the bucket, so the precise cause is
not knowable from any existing output (itself a defect). Meanwhile M5 holds
qa's exact matching lineage and a divergent growth lineage that only M5 can
publish or replace.

## 4.2 Fences have no liveness story

A rotation fence is `SET NX` with **no TTL** (redis-claude-rotation-fence.js:103),
nothing inspects `createdAt`, no reaper exists, and recovery only runs as a
side effect of (a) an explicit run of that exact label on the owning machine
or (b) a maintenance pass that reaches the label — which the owning machine
never performs because it has no maintainer. Automatic selection quarantines
fenced labels, so the organic "next run heals it" path is also closed. The
only automatic expiry in the entire mechanism is the 60s lease — which guards
a different thing. A fence therefore lives until a human performs one exact
command on one exact machine, and no surface tells the human either fact.

## 4.3 "Retryable" never escalates, and poisons everything it touches

Every guard disagreement — orphaned fence, lineage conflict, unreadable
state, a `claude` probe that soft-fails — lands in the same outcome bucket:
`retryable`, retried every 60s forever, with no counter, no backoff, no
age-based escalation to `reauth_required`, and no surfaced cause
(`claude-maintenance.js:58-97`). One stuck label forces the whole run's exit
code to 1 (`src/cli/commands/auth.js:291`), so "the maintainer is failing"
carries zero information — it has exited 1 continuously for days. Status
mirrors the same design: `result.ok = false` (and exit 1) whenever *any* of
17 accounts is non-healthy (`claude-redis-view.js:676-680`,
`claude.js:1263-1265`).

## 4.4 The relabel painted over a known-broken state

The human-status plan was explicitly presentation-only: "It does not change
credentials, refresh, recovery, selection, Redis, caches, the maintainer"
(plan §0.3), with a frozen scope forbidding runtime fixes. Its done bar —
"expired complete access maps to AIM FIXING, never NEEDS YOU" — encodes the
assumption that expiry is always transient and always being repaired. The
assumption was already false for four known accounts when the label shipped,
and the plan's accepted-residual-risk clause ("it will say UNKNOWN rather
than infer a cause") does not cover the opposite failure it created:
asserting repair activity that does not exist. Four hours later the pool
presented six permanently-stuck rows as a transient, handled condition.

# 5. Why the UX is confusing and obnoxious (itemized)

1. **"AIM will retry" is a static string, not a live claim.** It is rendered
   for a fenced account whose owning machine has no maintainer, and for
   accounts whose daemon fails 1,440 times a day. There is no retry count, no
   last-error, no "since" timestamp anywhere in the UI.
2. **One label, four unrelated causes.** Fence-pending, in-progress refresh,
   401, and expired-complete all render identically, with identical
   next-action text — but their fixes differ radically (wait one minute vs.
   run it on another machine vs. re-login). The label erases the only
   information that matters: *what do I do and where*.
3. **The honest state is unreachable.** NEEDS YOU with `aim login <label>`
   exists but these failure classes can't trigger it (§1). The classification
   can promote a dead account to "fixing" but never a stuck repair to
   "yours."
4. **The rows hide the accounts' data.** All usage columns go `--` for
   expired credentials even though cached usage exists — the row tells you
   nothing except the label.
5. **Diagnostics are gated and misnamed.** `--verbose` restores technical
   columns but still not *why*; `missing_accounts=boss,growth,…` sounds like
   enrollment loss — it actually means "accounts without healthy usage"
   (`claude-redis-view.js:676-678`). The real per-label failure reason lives
   only in `~/.aimgr/logs/auth-maintainer.out.log` **on M3**, a file no
   command points you to, and even that file carries only the bucket.
6. **Machine blindness.** Recovery is machine-bound (fence ownership, local
   lineage), but the table renders one apparent truth on every machine. There
   is no "owned by M5" hint — you have to dump Redis fences and hash storage
   ids to learn it.
7. **Exit-code noise.** Both `aim claude status` and the maintainer exit 1
   whenever anything is unhealthy, so scripts and launchd can't distinguish
   "one account wedged for four days" from "everything is down."
8. **Silent pool shrinkage.** Six quarantined accounts still count as pool
   members in the summary, while selection silently never picks them — the
   17→11 reduction is nowhere stated.
9. **It obeys its own spec.** The plan's invariants ("unknown evidence is
   never promoted to READY") were written to prevent false optimism in one
   direction while institutionalizing it in the other. The renderer passed
   41/41 tests asserting exactly the behavior you find obnoxious.

# 6. Is it overbuilt? Yes — and precisely where

The simplification (`1623176`, +6,138/−13,958) removed the genuinely
dangerous overbuild (process-freezing SIGSTOP supervision, ephemeral
credentials, telemetry-as-authorization). What remains is still a **fleet
control plane operated by one person**:

- CAS-versioned credential records, 30s online leases with Lua-guarded
  renew-or-reacquire, NX rotation fences with successor-provenance proofs and
  per-machine storage bindings, projection receipts with lineage
  fingerprints, a mid-run publication publisher, a 60s daemon, and a
  five-state render projection over four merged fact sources — to let one
  human run `claude` from five machines.
- The protection the fence provides is real (refresh-token lineage loss is
  the one unrecoverable hazard), but the mechanism has *protection without
  liveness*: no TTL, no reaper, no escalation, no repair command, no
  visibility. A guard that cannot recover itself becomes the outage — today
  the fence subsystem is the single largest source of dead accounts.
- Two near-identical pre-run guard pipelines are maintained in parallel
  (maintainer `claude-maintenance.js:232-361` vs. run path
  `claude.js:743-882`, with duplicate SAFE-reason sets), so the wedge logic
  is duplicated too.
- The daemon can fix exactly one thing — a happy-path token refresh on its
  own machine — and everything else it classifies as "retry later," which
  for unrecoverable states means "alarm silently, forever."
- The deepest structural mismatch: the runtime is single-operator but
  **multi-machine**, and every operability surface (status, labels, logs,
  runbook) is written as if machine identity didn't matter, while every
  recovery mechanism is bound to it. The friction review's "six-way rotation
  recovery" finding (`AIMGR_SINGLE_OPERATOR_FRICTION_ARCHITECTURE_REVIEW_2026-08-02.md:28`)
  was never actually resolved — this incident is it, recurring.

# 7. What would fix it

## 7.1 Unstick the pool now (operator runbook — all safe, in-band)

On **M5** (this machine), where the files actually live:

```bash
aim claude run boss    # recovers + clears its fence; claude refreshes the expired token inline
aim claude run pro4    # same
aim claude run pro5    # same
aim claude run qa      # no fence; local matches Redis; refreshes inline
aim claude run growth  # publishes or replaces the divergent local lineage
```

For **pro2**: run `aim claude run pro2` on the machine that last used it
(home or Studio — whichever has a non-empty
`~/.aimgr/claude-homes/pro2/.claude/`). If no machine has it, or any of the
above throws a lineage error: re-authenticate in place with
`aim claude capture-native <label>` (account already logged into Claude
natively) or `aim login <label>` (full browser OAuth). Both are designed to
supersede a fenced/conflicted lineage and clear the fence
(`claude.js:390-501`, `login.js:284-579`).

Do **not** hand-delete fence keys unless a label's managed dir is empty on
every machine — the fence is the only record that an unpublished rotation may
exist.

## 7.2 Make the label tell the truth (smallest code changes)

1. **Escalate**: after N consecutive identical `retryable` outcomes (or a
   fence older than a bound), set `reauth_required` / render NEEDS YOU with
   the concrete action. One counter in existing local state; no new storage.
2. **Distinguish ownership**: show fenced rows as `NEEDS YOU (on M5)` —
   the fence record already carries everything needed to compute which
   machine owns it.
3. **Log the cause**: include the underlying sync/guard sub-reason in the
   maintainer's per-label line and in `--verbose`; rename `missing_accounts`
   to what it measures.
4. **Fence liveness**: add a TTL or a reaper that clears fences whose
   protected local files no longer exist anywhere reachable — a fence
   protecting nothing should not quarantine an account.
5. **Exit codes**: stop failing the whole run/command over per-account
   retryables; report a summary and exit 0 unless the command itself failed.

## 7.3 The bigger question (your call, not this doc's scope)

Whether the Redis coordination core — leases, fences, receipts, CAS — still
pays for itself in single-operator mode, or whether a local-first authority
with Redis as an optional mirror would delete this entire failure class. The
friction review and `docs/bugs/AIM_MANAGED_CLAUDE_NETWORK_COORDINATION_OVERBUILD_2026-08-02.md`
already circled this; today's six rows are the recurring cost of not
deciding it.

# 8. Evidence appendix

All read-only. Live facts captured 2026-08-02 ~19:30–19:45 CDT.

- `node bin/aimgr.js claude status --json` (M5): per-account
  `credentialState`/`rotationPending`/`localProjection`/`credentialExpiresAt`;
  exit code 1. (Repo `bin/aim` is a dangling symlink into a legacy npm-global
  layout — use `bin/aimgr.js`; minor but confusing.)
- M3 maintainer log: `~/.aimgr/logs/auth-maintainer.out.log` — 13,126 runs;
  pre-cutover runs uniformly `failed=5`; post-cutover runs uniformly
  `retryable=7` with per-label `local_state_conflict` for all six Claude
  labels and `maintenance_failed` for Codex `amir_personal`. err.log empty.
- M3 service state: `launchctl print gui/501/com.funcountry.aimgr.auth-maintainer`
  installed, `StartInterval=60`. Absent on M5 (no plist, no logs).
- Fence/record/bundle dump: `.tmp/m3-diag.mjs` (machine-agnostic; run from a
  repo checkout) — produced the table in §3, including storage-id matches and
  the lineage comparisons, on both M5 and M3.
- Key code: state precedence `src/status/claude-redis-view.js:1189-1221`;
  static "AIM will retry" string `:1210`; `--` usage gate `:929-932`;
  `missing_accounts` `:676-678`; maintainer pipeline
  `src/credentials/claude-maintenance.js:154-483`; retry-bucket taxonomy
  `:52-97`; catch-all `:458-466`; exit-1 rule `src/cli/commands/auth.js:291`;
  fence recovery + foreign-machine throw `src/targets/claude-cli.js:295-361`,
  storage-id hash `:109-115`; unfenced-projection assert `:136-172`; empty-
  storage sync pass `src/credentials/claude-native.js:410-413`; fence write
  (NX, no TTL) `src/coordination/redis-claude-rotation-fence.js:82-110`;
  selection quarantine `src/cli/commands/claude.js:268-273`.
