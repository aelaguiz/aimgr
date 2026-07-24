# Claude and Codex OAuth Continuity Investigation

Status: complete; implementation not started

Started: 2026-07-24

Evidence host for the reported failure: `amirs-m3-max-new`

Investigation and documentation host: `Amir-M5`

## Executive Conclusion

Yes, both providers can be maintained without waiting for manual re-login:

- Two independent, already-expired Claude records (`boss` and `pro8`) were
  refreshed through the contained official Claude client. Each produced a new
  access token, rotating refresh token, and eight-hour expiry; each advanced
  only its own Redis record from v2 to v3; each used `/usage` with zero model
  turns, zero model tokens, zero cost, and no Keychain access.
- Two additional independent, still-valid synthetic Claude lineages were
  refreshed at T-4 minutes through the exact installed official-client
  `/usage` operation inside the existing no-Keychain, non-forwarding native
  lab. Each made exactly one synthetic token request followed by bootstrap and
  usage, with zero model traffic and no possible real-provider traffic.
- Two independent, still-valid Codex records (`growth` and `lessons`) were
  proactively refreshed through AIM's existing refresh-token path. Each
  advanced from Redis v8 to v9, received a new ten-day access expiry, and
  opened no browser.

The Claude fleet did not disconnect overnight. Its eight-hour access tokens
aged past `expiresAt` because AIM has no dormant-account refresh owner.
`credential_expired` means "access token expired and refresh has not been
tried," not "refresh token is dead." Status is intentionally passive, and the
only refresh owner today is an explicit managed Claude run.

The missing product is one combined, scheduler-safe OAuth maintenance one-shot
for Claude and Codex, invoked periodically by launchd on
`amirs-m3-max-new`. It should use the existing provider-specific refresh
owners, Redis leases/fences/CAS, and existing reauth policy state. It should
not be a new credential authority, a long-running process, a browser driver,
or a direct Anthropic OAuth implementation.

The decisive scheduling correction is that Claude 2.1.218 normally refreshes
only at five minutes or less remaining. A 30-minute scheduler can miss that
entire window. The correct fixed cadence is one minute.

## North Star

Every loaded Claude and Codex OAuth account in AIM Redis remains usable across
ordinary access-token expiry. AIM refreshes recoverable lineages before they
age out, publishes complete rotating successors atomically, and marks an
account `reauth_required` only when refresh material is missing or the provider
returns explicit terminal invalid/revoked/reused evidence. Normal passage of
time and transient failure must not themselves create manual re-login work.

## Operator Requirements

- Root-cause why nearly the entire Claude fleet becomes
  `credential_expired` overnight.
- Prove automatic refresh against more than one independent Claude lineage.
- Prove the exact official Claude operation refreshes more than one
  still-valid lineage before expiry.
- Prove proactive refresh against more than one independent Codex lineage.
- Produce a minimal combined OAuth-maintainer plan for launchd on
  `amirs-m3-max-new`.
- Save all findings and evidence in this document.
- Work locally on `Amir-M5`.
- Treat `amirs-m3-max-new` as the evidence host; inspect it only with a
  specific, read-only log question if local code and Redis evidence cannot
  settle that question.
- Diagnose before implementing.

## Scope

In scope:

- Claude OAuth credential expiry, refresh, projection, managed launch,
  rotation publish-back, Redis versioning, and status classification.
- Codex refresh-token maintenance, Redis publication, and reauth-state
  classification where they share the same product requirement.
- The difference between the sole fresh account (`pro7`) and the thirteen
  expired loaded accounts.
- Existing tests and prior live-proof claims that bear directly on continuous
  credential usability.

Out of scope:

- Browser reauthentication or changing account identity.
- Browser OAuth, billing, subscription changes, or account provisioning.
- Keychain reads or writes.
- Model inference or provider requests merely to generate activity.
- Code changes or architecture expansion during this diagnostic pass.
- Remote mutation, fleet publication, or cleanup.

## Non-Negotiables

- Never print, log, hash into a public artifact, or otherwise expose raw access
  tokens, refresh tokens, cookies, OAuth callback URLs, or credential bundles.
- Do not run a real mutating proof until read-only chronology and code tracing
  establish the exact experiment. After that gate, use only the operator-
  requested bounded refresh proofs named in this document.
- Prefer sanitized AIM views, exact code tracing, existing tests, and
  contained fakes.
- Keep measured facts separate from assumptions.
- One highest-information test at a time.

## Scoreboard

Reported `aim claude status` result on `amirs-m3-max-new`:

| Measure | Observed |
|---|---:|
| Loaded Claude accounts | 14 |
| `credential_expired` | 13 |
| `usage_readable` | 1 (`pro7`) |
| Fleet readable fraction | 1/14 = 7.1% |
| Fleet expired fraction | 13/14 = 92.9% |
| Fresh account source | `live` |
| Expired account source | `redis` |

Success for this investigation means:

1. identify the exact owner and trigger for Claude OAuth refresh;
2. prove that more than one expired Claude refresh lineage can recover;
3. prove that more than one unexpired Codex lineage can refresh proactively;
4. explain why `pro7` alone remained fresh;
5. separate proven cause from remaining account-specific uncertainty; and
6. name the smallest correct combined repair boundary without implementing it.

## Ground-Truth Anchors

- The reported failure occurred on `amirs-m3-max-new`, not on the local
  investigation host.
- The result is fleet-shaped rather than account-shaped: thirteen independent
  records share one failure state while the actively used account is fresh.
- AIM Redis is the shared credential source of truth.
- Current help and README describe `aim claude run <label>` as projecting one
  Redis credential into an AIM-owned per-label home and publishing newer native
  token rotations back after the run.
- Status is intended to be read-only; it must not silently import or rotate
  native credentials.

## Quant Model and Sanity Checks

Measured:

- 92.9% of loaded records were expired at the observation.
- 100% of the readable records were represented by one actively used label.

Subsequently measured:

- Claude issued an eight-hour access lifetime in both real refresh proofs.
- Codex issued a ten-day access lifetime in both proactive refresh proofs.
- At the read-only chronology snapshot, thirteen Claude records were complete
  v2 lineages whose access expiries had passed. `pro7` alone was a recently
  updated v3 `native-claude-rotation` record with a future expiry.
- Current code and regression coverage explicitly permit an expired but
  complete Claude bundle through managed projection.
- Two real expired Claude bundles reached the official client, rotated, and
  published cleanly. No M3-specific evidence was needed to settle the primary
  cause.

Sanity rule:

- If all dormant records age out at their stored `expiresAt` and no periodic or
  pre-launch refresh owner exists, the observed 13/14 pattern is expected
  behavior from the current architecture, not thirteen coincidental provider
  failures.
- If launch preflight rejects an expired but complete credential before the
  official client starts, the system has a bootstrap deadlock: the only
  component allowed to refresh never receives the credential it must refresh.

## Ranked Hypotheses

### H1 — Refresh is activity-bound, with no dormant-account refresh owner

Verdict: confirmed.

AIM does not refresh Claude credentials during status. The official Claude
client refreshes only while a label is launched, and AIM publishes the rotated
pair only from the managed run's post-run synchronization. Consequently, the
one recently used account remains fresh while dormant accounts expire in Redis.

Falsifier: find a real periodic, status-time, or pre-expiry refresh path that
operates on every loaded Claude label and publishes to Redis.

### H2 — Expired Redis credentials are rejected before Claude can refresh them

Verdict: disproved.

`aim claude run` deliberately projects an expired access token when its refresh
lineage and identity are complete. The current regression suite covers that
case, and the live `boss` and `pro8` proofs both started from expired v2
records, reached the official client, refreshed, and published v3 successors.

Evidence: `src/targets/claude-cli.js` passes
`allowExpiredCandidate: true`; `test/claude/native-storage.test.js` covers the
expired projection; the live proofs below close the real-provider branch.

### H3 — Rotations can remain newer only in a managed local home

Verdict: confirmed as a secondary gap, not the overnight fleet cause.

Claude may refresh successfully during a run, but AIM publishes only on a
particular clean or recoverable exit path. An interruption or machine-local run
could leave a newer complete pair in the M3 per-label home while Redis remains
expired.

Publication occurs after the official client exits. A long-running process may
therefore hold a newer local pair while Redis remains stale. Interruptions are
protected by a durable fence and recovery projection, but there is no
mid-session publisher. The thirteen dormant v2 records had no evidence of
active sessions; their synchronized age pattern is explained by H1.

### H4 — The stored refresh tokens are independently dead

Verdict: possible per account, disproved as a necessary explanation for the
fleet symptom.

Anthropic rotates refresh tokens. A stale write or a refresh outside AIM could
invalidate Redis's refresh token for individual labels. This can happen, but
thirteen dormant labels expiring together while the active label stays fresh is
less consistent with independent refresh-token invalidation than with missing
refresh ownership.

The `boss` and `pro8` refresh tokens were accepted after their access tokens
expired. This does not prove every remaining lineage is alive; the maintainer
must attempt each due account and mark only failed/unrecoverable labels for
reauthentication.

### H5 — M3-specific installation or environment drift

Verdict: not needed to explain the incident.

The issue could be caused by an old M3 build or different launch environment.

The failure followed shared Redis `expiresAt` state, and the decisive refresh
proofs succeeded locally through the same canonical code. M3 remains the
requested deployment host for the future scheduler, not the cause of the
expiry pattern.

## Completed Investigation Sequence

1. **Credential chronology oracle (local, read-only).** Read sanitized Redis
   inventory/status metadata and compare `expiresAt`, credential versions, and
   update provenance for `pro7` versus several expired labels.
   - Decision rule: a recent `pro7` generation plus old dormant generations
     strongly supports H1.
2. **Preflight-order brutal test (code and contained tests).** Traced whether
   projection accepts an expired-but-complete bundle and whether
   `aim claude run` reaches the official client.
   - Result: H2 disproved; expired complete bundles are launchable.
3. **Publish-back ownership trace.** Enumerated every path that writes a rotated
   Claude pair to Redis and every child-exit/fence recovery path.
   - Result: H1 confirmed and H3 retained as a secondary process-exit gap.
4. **Two-account Claude live proof.** Refreshed two expired lineages through
   the official zero-model contained path and verified exact Redis successors.
5. **Two-account Codex live proof.** Refreshed two still-valid lineages through
   the existing refresh-token path with stdin closed and verified exact Redis
   successors.
6. **M3 inspection.** Not needed. No SSH or remote mutation was performed for
   this investigation.

## Authoritative Worklog

### Iteration 1 — Bootstrap and symptom normalization

What changed:

- Created this investigation controller and evidence log.
- Normalized the operator's pasted status into a fleet-level scoreboard.

Evidence:

- Fourteen loaded Claude labels were present.
- Thirteen were `credential_expired`, all sourced from Redis.
- `pro7` alone was `usage_readable`, sourced live.
- The average row therefore reflects only `pro7`; it is not evidence that the
  fleet average is healthy.

Initial conclusion:

- The distribution made missing fleet/dormant refresh ownership the leading
  theory. A possible pre-launch expired-token rejection was retained only as a
  falsifiable secondary hypothesis; Iterations 2 and 3 later disproved it.

Next highest-information bet:

- Read sanitized Redis chronology locally, then trace the exact expired-bundle
  projection gate.

### Iteration 2 — Read-only chronology and code-path audit

Observed at 2026-07-24 12:21 UTC from sanitized Redis metadata:

| Claude label | Version | Access expiry (UTC) | Provenance/state |
|---|---:|---|---|
| `pro8` | 2 | 06:29 | expired, `login-maintenance` |
| `pro9` | 2 | 06:34 | expired, `login-maintenance` |
| `pro10` | 2 | 06:37 | expired, `login-maintenance` |
| `pro11` | 2 | 06:40 | expired, `login-maintenance` |
| `coder` | 2 | 06:43 | expired, `login-maintenance` |
| `qa` | 2 | 06:47 | expired, `login-maintenance` |
| `claudalyst` | 2 | 06:50 | expired, `login-maintenance` |
| `pro3` | 2 | 06:53 | expired, `login-maintenance` |
| `pro4` | 2 | 06:56 | expired, `login-maintenance` |
| `pro6` | 2 | 07:27 | expired, `login-maintenance` |
| `boss` | 2 | 07:33 | expired, `login-maintenance` |
| `pro2` | 2 | 07:38 | expired, `login-maintenance` |
| `pro5` | 2 | 01:00 | expired |
| `pro7` | 3 | 19:54 | fresh, `native-claude-rotation` |

All thirteen expired records still contained complete access/refresh pairs,
and their top-level/native expiries matched. `aim claude inventory --json`
independently reported `total=14`, `credentialReady=1`,
`credentialExpired=13`, and `requestCount=0`.

Code findings:

- `src/status/claude-redis-view.js` maps `expiresAt <= now` directly to
  `credential_expired`, then excludes that row before provider I/O.
- `--fresh` bypasses only the five-minute usage cache. It does not refresh
  OAuth.
- `src/credentials/anthropic-maintenance.js` explicitly retires direct Claude
  refresh and directs maintenance through `aim claude run <label>`.
- `src/targets/claude-cli.js` passes `allowExpiredCandidate: true`; an expired
  complete bundle is allowed to reach the official client.
- `src/cli/commands/claude.js` publishes a rotated successor only after the
  official client returns.
- No Claude watch or scheduler exists. Existing Codex/Hermes watch commands
  manage account selection/projection, not OAuth lifetime.

Conclusion:

- `pro7` stayed fresh because activity rotated it. The dormant records merely
  crossed their eight-hour access-token expiries.
- H1 was confirmed. H2 was disproved. H3 remains a secondary long-session
  visibility gap.

### Iteration 3 — Two real expired Claude refresh proofs

Preflight:

- Chose `boss` and `pro8`, two independent expired v2 records with complete
  native bundles, exact identity policy, no rotation fence, no pending
  publication, and no local credential projection.
- Verified locally that `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` was unset.
  This matters because Claude 2.1.218 short-circuits `/usage` before OAuth
  refresh when that variable is set. The current runner does not yet scrub it.

Commands:

```text
aim claude run boss -- --safe-mode --strict-mcp-config \
  --no-session-persistence --print --output-format json /usage

aim claude run pro8 -- --safe-mode --strict-mcp-config \
  --no-session-persistence --print --output-format json /usage
```

Both commands completed successfully in approximately two seconds. Each
reported:

- `is_error=false`;
- `duration_api_ms=0`;
- `num_turns=0`;
- `total_cost_usd=0`;
- zero input/output/cache tokens; and
- empty model usage.

Value-safe postconditions:

| Label | Redis version | New expiry (UTC) | Result |
|---|---|---|---|
| `boss` | v2 -> v3 | 2026-07-24 20:25:05 | complete rotated pair, `native-claude-rotation` |
| `pro8` | v2 -> v3 | 2026-07-24 20:25:20 | complete rotated pair, `native-claude-rotation` |

For both labels:

- only that label advanced;
- the access and refresh lineages changed together;
- the new access lifetime was approximately eight hours;
- no fence or pending marker remained;
- no credential projection remained; and
- the real Keychain was not used.

Conclusion:

- The production AIM path can recover real expired Claude access tokens when
  the stored refresh lineage remains valid.
- This closes the historical gap where only a synthetic expired rotation had
  been proven. It does not assert that every remaining lineage is valid; each
  must be attempted independently.
- A final read-only inventory after all proof work reported three ready Claude
  labels (`boss`, `pro7`, `pro8`), eleven still-expired labels, and zero
  provider requests. The investigation deliberately did not bulk-refresh the
  remaining cohort.

### Iteration 4 — Two proactive Codex refresh proofs

Read-only preflight at 2026-07-24 12:25 UTC:

- Redis held 24 Codex records.
- All 24 were healthy, had complete refresh tokens, and had future access
  expiries.
- The earliest cohort expired on 2026-07-30; no expired Codex canary was
  available.
- A Codex refresh issues an access lifetime of approximately ten days.

The relevant code path in `src/credentials/codex-login.js` always tries the
existing refresh token before browser OAuth, regardless of whether the current
access token is still valid. Therefore the decisive available proof was
proactive refresh of two still-valid independent lineages:

```text
aim login growth < /dev/null
aim login lessons < /dev/null
```

Both completed without a browser and returned successful Redis maintenance:

| Label | Redis version | New expiry (UTC) | Result |
|---|---|---|---|
| `growth` | v8 -> v9 | 2026-08-03 12:25:55 | complete pair, ready |
| `lessons` | v8 -> v9 | 2026-08-03 12:26:07 | complete pair, ready |

Conclusion:

- Codex already has a working silent refresh primitive.
- The interactive `aim login` owner currently falls back to browser OAuth on
  refresh failure. A background maintainer must call a refresh-only seam and
  must never open a browser.
- Codex Redis maintenance currently lacks the Claude-style per-label lease;
  the combined maintainer and interactive Codex refresh must converge on the
  existing generic credential lease to prevent concurrent rotating-token use.

### Iteration 5 — Determine Claude's real pre-expiry window

The first plan draft guessed a two-hour Claude threshold and 30-minute launchd
cadence. An independent plan audit correctly rejected that guarantee because
the two real Claude canaries had recovered after expiry, not before it.

Static proof from installed Claude 2.1.218:

```text
function VRe(expiresAt) {
  if (expiresAt === null) return false
  let refreshWindowMs = 300000
  return Date.now() + refreshWindowMs >= expiresAt
}
```

The predicate begins at byte 227,390,319 in the installed signed binary. The
normal refresh function at byte 227,430,976 checks it both before and after the
OAuth lock; the HTTP-401 recovery call at byte 227,429,653 is the observed
force bypass.

The main refresh function checks this predicate before and after taking its
OAuth lock and returns `not_needed` above the window. Normal proactive callers
do not force; the explicit force path is reserved for HTTP 401 recovery.

Contained behavioral proof:

- Reused the existing signed-binary, file-only, no-Keychain native lab.
- Seeded two isolated synthetic lineages with four minutes of access lifetime
  remaining.
- Ran the same `--safe-mode --strict-mcp-config
  --no-session-persistence --print --output-format json /usage` vector.
- Both runs rotated access and refresh once.
- Both observed exactly `token -> bootstrap -> usage`.
- Both had zero model turns/traffic and no path to a real provider.
- The isolated run IDs were
  `20260724T125959Z-72a4b74f` and
  `20260724T130001Z-dbd86271`.

One useful testing artifact was also resolved: an initial modified harness put
the config directory under `/private/tmp`, outside the outer Seatbelt profile's
write allowlist. The client could read the credential but could not create its
OAuth lock or persist the successor, so tokens remained unchanged. Repeating
inside the intended `native/runtime` containment passed. This was a harness
boundary, not a client refresh failure.

Conclusion:

- The official client's actual proactive window is five minutes.
- The exact zero-model operation works before expiry on more than one lineage.
- A 30-minute job is invalid; a fixed 60-second cadence provides multiple
  opportunities inside the native window.

### Iteration 6 — Correct minimal repair boundary

The smallest correct architecture is:

1. One inherently one-shot `aim auth maintain` command reads Redis and
   processes due Claude and Codex labels serially. launchd owns recurrence.
2. Claude is due at five minutes or less, including complete expired records.
   Use the exact official contained `/usage` operation in its existing writable
   AIM-owned file-only home.
3. Codex is due at 48 hours or less. Use a bounded, abortable form of the
   existing refresh grant with no browser fallback.
4. The roster owns no lease. Each provider operation acquires, reloads,
   rechecks, renews, asserts, publishes, and releases its own single
   provider/label lease. Claude retains its fence.
5. `reauth_required` is written only for missing/incomplete refresh material or
   explicit terminal OAuth evidence. Network, timeout, process, provider,
   storage, and unclassified failures remain retryable or blocked, even after
   access expiry. Terminal labels are not repeatedly retried.
6. A successful Claude run with unchanged usable tokens is
   `healthy_unchanged`: no Redis write or marker, clean fence/projection, retry
   on the next eligible pass.
7. Both provider operations are headless and deadline-bounded. Official/provider
   stdout and bodies never reach the single sanitized AIM receipt.
8. One launchd job on `amirs-m3-max-new` runs every 60 seconds. It creates and
   uses a private `~/.aimgr/logs` directory.

Current-code verification:

- 58/58 focused native-storage, Redis projection, Redis login, and scheduler
  installer tests passed locally after the investigation and plan were
  written.
- The installed Claude binary's static five-minute predicate and two contained
  T-4-minute behavioral proofs agree.
- No secret-pattern or whitespace finding was present in either new document.

The implementation plan is:

- `docs/AIM_COMBINED_OAUTH_MAINTAINER_2026-07-24.md`

No daemon code, installer, M3 contact, or remote deployment was performed in
this planning pass. The only live mutations were the four explicitly bounded
refresh proofs: real Claude `boss`/`pro8` and real Codex
`growth`/`lessons`.
