# Worklog

Plan doc:
`docs/NATIVE_KEYCHAIN_FREE_CLAUDE_MANAGEMENT_2026-07-23.md`

## Initial entry

- Run started: 2026-07-23.
- Current phase: Complete - Phase 1 managed run and Phase 2 reauthentication
  both proven locally.
- Starting branch: `redis-credential-coordination`.
- Starting commit: `2b394f0160de6fcd7baa3024d8a4d3a97f9010df`.
- Scope: local native macOS only; no remote contact; no real Keychain action;
  no live credential/provider mutation before focused proof and the explicit
  live-operation gate.
- Allowed implementation call sites:
  - `src/cli/commands/claude.js::handleRedisClaudeRun`
  - `src/credentials/claude-native-storage.js`
  - `src/targets/claude-cli.js`
  - `src/targets/claude-runner.js`
  - `src/targets/claude-supervisor.js` (preserve unchanged)
  - `src/credentials/claude-native.js::syncClaudeNativeBundleBackToLabel`
  - `src/cli/commands/login.js` (Phase 2 only)
  - `native/claude/security_shim.c`
  - `native/claude/no-keychain.sb`
  - Existing focused tests named in plan Section 6
- Pre-existing overlapping edits are present in
  `src/cli/commands/claude.js`,
  `src/credentials/claude-native-storage.js`,
  `src/targets/claude-cli.js`,
  `test/claude/native-storage.test.js`, and
  `test/cli/redis-projection-command.test.js`; they are preserved and treated
  as prior work, not this run's evidence.
- Self-check: on track; on scope; no drift detected.
- Next step: trace the current managed-run/storage/runner code and reuse the
  smallest proven native-lab artifacts before editing.

## Phase 1 implementation checkpoint 1

- Recorded at: 2026-07-23T14:07:13Z.
- Implemented only the frozen Phase 1 seam:
  - added the reviewed fixed-semantics `security` compatibility source;
  - added one static parameterized allow-default no-Keychain profile;
  - added installed-client qualification and content-addressed local adapter
    compilation to the existing runner before credential projection;
  - changed the managed descriptor, projection, successor readback, and normal
    cleanup to file-only storage;
  - preserved the existing lease, fence, identity, lineage, and Redis CAS
    lifecycle;
  - removed managed-run wrapper stdout and preserved exact nonzero/signal
    results after cleanup.
- No Phase 2 code, remote, live Redis, real credential, Keychain command/API,
  global Claude state, official Claude process, provider request, migration,
  panel/status/docs cleanup, new coordinator, proxy, runtime copy, or reviewer
  work occurred.
- Focused automated proof:
  `node --test test/claude/native-storage.test.js
  test/claude/claude-supervisor.test.js
  test/cli/redis-projection-command.test.js`
  passed 37/37.
- The focused proof includes:
  - fixed adapter semantics and private single-link cached topology;
  - selected-label file access with global Claude, Keychain decoy, real
    `security` bytes, and other-label access denied in both parent and child;
  - zero managed-run Keychain dependency calls;
  - file-only rotation publish-back and successful credential retirement;
  - fenced retention on uncertain nonclean exit;
  - exact argv, cwd, inherited stdio envelope, exit status, and signal
    propagation contracts.
- A credential-free real preflight qualified the installed native Darwin arm64
  Claude `2.1.218` digest/signing tuple, the local sandbox boundary, the
  compiled adapter, and the static profile. It confirmed that no credential
  had been projected. The official Claude process was not launched.
- Self-check: on track; on scope; no drift detected. Test work remained inside
  the existing focused files and did not add a framework or broaden the
  matrix.
- Next step: run the smallest synthetic official-client refresh through the
  actual AIM managed lifecycle. Stop before any real credential/provider
  action unless the explicit live-operation gate is opened.

## Phase 1 implementation checkpoint 2

- Recorded at: 2026-07-23T14:14:11Z.
- Result: PASS for the synthetic official-client product-path gate.
- Reused the completed native lab's non-forwarding synthetic OAuth fixture,
  but replaced its direct Claude invocation with AIM's actual
  `claude run` lifecycle backed by one in-process fake Redis label.
- Product path exercised:
  installed signed Claude `2.1.218` qualification -> content-addressed AIM
  compatibility executable -> targeted no-Keychain profile -> file-only label
  projection -> official client refresh -> exact file successor readback ->
  existing identity/lineage/fence/CAS publication -> fence clearance ->
  credential retirement.
- Value-free proof:
  - fake Redis label advanced from v1 to v2;
  - both synthetic access and rotating refresh lineage advanced;
  - request sequence was exactly token -> bootstrap -> usage;
  - route counts: token 1, bootstrap 1, usage 1, model 0, invalid 0,
    unexpected 0;
  - Claude result reported zero turns, zero API-duration model work, and zero
    cost;
  - provider traffic was impossible because the fixture's CONNECT endpoint
    was non-forwarding;
  - managed Keychain dependency calls: zero;
  - shared rotation fence absent after publication;
  - AIM credential projection absent after publication;
  - label-scoped noncredential app state remained.
- Independent fixture receipt:
  `/Users/aelaguiz/workspace/claude-keychain-free-lab/native/receipts/native-synthetic-refresh-v1-20260723T141314Z-15c09e7a.json`.
- The temporary AIM-to-fixture glue under
  `/tmp/aimgr-claude-synthetic-product-proof-20260723` was deleted after the
  proof; it did not become repository code or a new harness.
- No real credential, live Redis record, provider endpoint, Keychain
  command/API, global Claude state, remote, migration, Phase 2 path, or
  reviewer was touched.
- Self-check: on track; on scope; no drift detected. Phase 1 is now blocked
  only on the plan's explicitly authorized real local refresh canary and
  operator-controlled representative launch/resume smoke.

## Phase 1 authorized real-canary gate

- Recorded at: 2026-07-23T14:19:08Z.
- Operator authorization: one local, real, zero-model refresh canary for
  `pro5`; no Keychain, remote, Phase 2, broad testing, or model-bearing smoke
  was authorized.
- A value-free inventory preflight reported exactly one Anthropic account,
  `pro5`, from Redis; identity policy matched, state was
  `credential_expired`, and inventory provider request count was zero.
- Correction: the inventory view does not expose shared rotation-fence state.
  The conductor initially inferred that no fence existed, then corrected that
  statement as soon as the direct post-failure Redis read showed the
  pre-existing fence.
- A first shell capture setup failed before Node/AIM/Claude execution because
  this machine has `mkdir` at `/bin/mkdir`, not `/usr/bin/mkdir`. It produced
  no product or credential side effect and was not counted as a canary run.
- The one product canary attempt invoked the local source checkout with the
  proven zero-model arguments:
  `claude run pro5 -- --safe-mode --strict-mcp-config
  --no-session-persistence --print --output-format json /usage`.
- Result: BLOCKED before credential projection and before Claude launch.
  AIM's pre-run recovery check found a shared rotation fence owned by a
  different recovery storage identity and failed closed with the existing
  cross-machine recovery error.
- Follow-up metadata comparison proved the error wording was broader than the
  actual cause: the fence's recovery hash exactly matches this Mac's prior
  composite file-plus-Keychain storage contract and does not match the new
  file-only contract. It is therefore residue from the interrupted local
  overnight probe, not a remote-machine fence.
- Direct value-free Redis evidence:
  - the fence was created at `2026-07-23T02:42:15.650Z`, long before this
    authorized attempt;
  - its base credential version is v2;
  - the `pro5` credential remains v2 with its prior
    `2026-07-23T01:38:52.404Z` update;
  - no rotation-successor provenance was added;
  - the pre-existing fence remains intact;
  - no local pending-rotation marker was created.
- Side-effect evidence:
  - official Claude stdout was empty and no Claude result was produced;
  - no projected `pro5/.credentials.json` or label `.claude.json` exists;
  - global `~/.claude/.credentials.json` remains absent;
  - global `~/.claude.json` metadata was unchanged;
  - `login.keychain-db` metadata was unchanged;
  - no `SecurityAgent` or `security` process appeared;
  - captured output contained no bearer-, OAuth-token-, or JWT-like material.
- Per the frozen Phase 1 rule, the failed live proof was not retried and no
  code, recovery mechanism, fence deletion, test expansion, reviewer, or
  Phase 2 work followed.
- Self-check: on track; on scope; no drift detected. The implementation itself
  was not exercised by this live attempt because the older shared fence
  correctly stopped it first.
- Next decision: the operator must explicitly choose how to reconcile the
  pre-existing fence. Until then Phase 1 stays blocked and the representative
  launch/resume smoke and Phase 2 remain closed.

## Phase 1 real-canary recovery and credential verdict

- Recorded at: 2026-07-23T14:36:55Z.
- Operator standing directive: stop requesting repeated authorization and
  continue bounded execution inside the frozen requirements. This supersedes
  the prior “next decision” pause but does not expand scope.
- Correction to the prior side-effect evidence: the legacy projection lived
  at the actual managed config path
  `~/.aimgr/claude-homes/pro5/.claude/.credentials.json`; the earlier check
  looked one directory too high. The file was private, single-link, identity
  exact, and contained the same token lineage as Redis v2.
- The legacy fence matched this Mac's old composite-storage recovery identity
  exactly. Under the existing Anthropic/`pro5` Redis lease, the conductor:
  - re-read and matched the exact fence, v2 record, and base lineage;
  - proved the contained file had unchanged tokens and no successor;
  - atomically cleared the exact fence;
  - removed only the unchanged credential projection;
  - preserved label-scoped application/session state.
- One file-only real canary then reached the official Claude client using:
  `claude run pro5 -- --safe-mode --strict-mcp-config
  --no-session-persistence --print --output-format json /usage`.
- Official-client result:
  - subtype `success`, `is_error=false`;
  - zero turns, zero API/model duration, zero cost, and no model usage;
  - no permission denials;
  - result confirmed that the Claude subscription powers Claude Code usage;
  - no SecurityAgent or `security` process appeared.
- AIM correctly failed closed after the client exited because the official
  client replaced both projected token strings with empty strings. The file
  retained the expected static OAuth metadata and exact account identity but
  was intentionally rejected as `file_bundle_incomplete`; Redis therefore
  remained v2 with no successor provenance.
- The new file-only fence and empty invalidated projection were re-read under
  the lease, matched to the exact run and unchanged Redis base, then retired
  using guarded fence deletion plus the normal safe credential-retirement
  primitive. Redis remains canonical at v2 and no credential projection or
  fence remains.
- Global-state timestamps are not a clean per-run sentinel on this machine
  because multiple unrelated native `claude` processes are active. The
  Keychain timestamp observed after the run predated the run fence, no
  SecurityAgent/security process appeared, and the static/dynamic containment
  proofs remain green. No global value or Keychain item was read.
- Captured canary output was value-safe and deleted after classification.
- Verdict: the file-only product path reaches the official zero-model command,
  but the pre-existing Redis v2 refresh lineage is no longer usable. A fresh
  official login is required before a real rotation successor can be proven.
- Sequencing amendment: begin only the already-planned Phase 2 generic-login
  branch now, use it to replace `pro5`, then return immediately to the Phase 1
  real refresh and representative UX gates.
- Self-check: on track; on scope; no drift detected. No new test, harness,
  recovery command, Keychain path, remote work, reviewer, or adjacent feature
  was added in response to the credential failure.

## Phase 2 contained Anthropic login implementation and live gate

- Recorded at: 2026-07-23T15:06:02Z.
- Added one Anthropic branch to the existing `aim login <label>` command. It
  launches the installed official client with `claude auth login --claudeai`
  inside the same native file-only runner used by managed run.
- Fresh login uses only the deterministic label-scoped staging root
  `~/.aimgr/claude-homes/<label>/.login-staging/.claude`. The runner accepts
  that exact topology in addition to the normal label config root; it does not
  accept a broader arbitrary config path.
- The branch reuses the existing Redis lease, heartbeat, rotation fence,
  stable-identity validation, duplicate-account rules, and CAS publication.
  Cancellation and identity rejection remove the exact staging directory and
  clear the matching fence. A true post-grant Redis publication uncertainty
  retains both for deterministic recovery.
- The existing generic login front door remains the only public command.
  Anthropic remains unavailable from the shorthand panel, and no AIM-owned
  OAuth client, provider refresh call, coordinator, second reauth command, or
  general staging framework was added.
- Focused proof:
  - Anthropic login tests: 8/8 pass, including success, exact official-client
    arguments, no real Keychain command, wrong-identity cleanup, cancellation
    cleanup, publication-uncertainty retention, and closed panel behavior.
  - Affected native/login/projection slice: 45/45 pass.
  - `node --check`, `git diff --check`, and a credential-free launch preflight
    against installed Claude 2.1.218 pass.
- Live `pro5` reauthentication reached the real Anthropic consent page in a
  newly opened BrowserOS `Profile 17` window. Same-target proof showed the
  on-disk profile path ending in `Profile 17`, Google identity
  `pro5@fun.country`, and the consent page identity `pro5@fun.country`.
- Two pre-consent test-harness restarts were cancelled cleanly. The first
  private terminal-link extractor concatenated the hidden and visible ANSI
  hyperlink copies; Anthropic kept Authorize disabled and no grant occurred.
  The corrected extractor now proves one value for every OAuth request
  parameter before navigation.
- The current exact request is paused before consent because Anthropic
  presented a visible hCaptcha. No OAuth grant or Redis publication has
  occurred yet. The label staging directory was absent after each cancelled
  attempt, and no `SecurityAgent`, real `security`, remote, global Claude
  credential, or other label was touched.
- Self-check: on track; on scope; no drift detected. Broader tests, reviewers,
  migration, cleanup, and unrelated product surfaces remain closed until the
  real contained login works.

## Phase 2 OAuth foreground behavior and long-wait lease correction

- Recorded at: 2026-07-23T16:59:24Z.
- Correction to the prior live-gate classification: Anthropic did not present
  a visible CAPTCHA. Its hCaptcha challenge iframe remained parked offscreen at
  `y=-9999` with `visibility:hidden`; treating its nonzero dimensions as a
  visible manual challenge was incorrect.
- Reproduced UI behavior: when the OAuth page is backgrounded, Authorize remains
  disabled. One real click on a non-actionable part of the foreground consent
  canvas enables Authorize immediately; a fresh snapshot then exposes the
  enabled button. The correct BrowserOS sequence is therefore: bind and verify
  the exact profile/page, foreground it only for this proved constraint, click
  the blank consent canvas once, verify Authorize enabled, then click Authorize.
  There is no CAPTCHA interaction or bypass.
- Anthropic required a recent sign-in after the first consent. The same
  `Profile 17` target opened the Google reauthentication popup, showed only
  `pro5@fun.country` as the selected account, completed Google Continue, and
  returned to the same enabled Anthropic consent page.
- The resulting OAuth code reached the official contained client, but the
  approximately two-hour operator/browser pause exposed a real coordination
  defect: the generic login held a 30-second Redis lease across the entire
  human interaction and treated one missed renewal as terminal. AIM failed
  closed before publication. Redis remained at `pro5` v2; the exact v2 fence
  remained; staging contained only incomplete app state and no file-backed
  credential; no Keychain or global Claude credential was touched.
- Minimal architecture correction: the durable rotation fence now spans the
  human browser wait. AIM holds one short lease to reconcile/create that fence,
  releases it before opening the official login, then acquires a fresh lease
  and re-reads the exact fence, Redis version, and token lineage before any
  publish or cleanup. No heartbeat, longer crash TTL, new coordinator, or
  relaxed continuity check was added.
- A new fast regression advances fake time beyond the original lease during
  official login. It failed on the old implementation and now passes. Generic
  login tests are 9/9; the full affected native/login/projection slice is
  46/46; syntax and diff checks are clean.
- Self-check: on track; on scope; no drift detected. This fixes only the live
  Phase 2 failure and preserves the existing fence/lease/CAS authorities.

## Phase 2 real login completion

- Recorded at: 2026-07-23T17:00:53Z.
- Reran `aim login pro5` through the contained official native client after the
  long-wait lease correction. The official client reported login success; AIM
  validated the intended stable identity and published only `pro5`, advancing
  its Redis credential from v2 to v3 with `login-maintenance` provenance.
- Successful publication removes a stale label-local
  `rotationPublicationPendingByLabel` marker as well as the durable login fence
  and staging directory. The success regression now seeds that stale marker
  and proves it is absent after publication.
- Post-login value-free evidence:
  - inventory was complete with one credential-ready `pro5` record and zero
    provider requests;
  - Redis v3 held a complete, identity-bound credential with no shared fence;
  - login staging, the disposable managed credential projection, and global
    `~/.claude/.credentials.json` were absent;
  - no `SecurityAgent`, real `/usr/bin/security`, or `claude auth login`
    process remained.
- No AIM OAuth implementation, private refresh call, Keychain access, global
  Claude mutation, second public command, remote action, or adjacent product
  work was added.

## Phase 1 return gate and representative launch

- Ran the actual managed product path:
  `aim claude run pro5 -- --safe-mode --strict-mcp-config
  --no-session-persistence --print --output-format json /usage`.
  The official native client returned success with zero API duration, zero
  model turns, zero tokens, zero cost, and no permission denials while reporting
  the real subscription-usage view.
- The fresh v3 token lineage did not rotate during `/usage`. AIM therefore
  exercised the unchanged-token success path: Redis stayed at v3 and normal
  cleanup removed the disposable credential projection and fence. The focused
  official-client synthetic fixture separately proves that a genuine rotated
  same-identity successor is captured and published through the same fence,
  lineage, and CAS path. This distinction is intentional; no live rotation is
  claimed when the provider did not issue one.
- Launched the operator's representative command shape unchanged:
  `aim claude run pro5 -- --dangerously-skip-permissions --model opus
  --effort xhigh --resume`. It reached the real Claude resume UI without
  issuing a model turn, proving the required arbitrary-argument UX and
  same-label resume surface.
- The test harness then terminated the AIM root process by exact PID because
  Claude's raw terminal UI consumed injected control bytes. That artificial
  parent crash correctly left the existing uncertainty fence and disposable
  recovery projection. A guarded abandonment verified exact installation,
  storage, identity, Redis-v3 lineage, and unchanged tokens before clearing
  that fence and removing only the projection. The root-kill also left one
  local `pro5` publication-pending marker; a final guarded cleanup removed only
  that marker after re-verifying Redis v3, complete identity/credential, no
  fence, no projection, and no staging. Normal child signal propagation and
  cleanup remain covered by the focused supervisor/managed-run tests.
- Final value-free live state:
  - Redis `pro5` v3 is complete, ready, and sourced from the successful
    official login;
  - inventory is complete with `requestCount: 0`;
  - shared fence and local publication-pending marker are absent;
  - managed projection, login staging, and global Claude credentials are
    absent;
  - no Claude supervisor, `SecurityAgent`, real `security`, or login process
    remains.

## Final verification and browser cleanup

- Fresh affected native/login/projection rerun: 41/41 pass.
- Existing full repository suite: 320/320 pass.
- `npm run lint` and `git diff --check` pass.
- BrowserOS cleanup closed only task-created resources after the OAuth code had
  been consumed: temporary Claude settings pages 443 and 444 and the dedicated
  Profile 17 callback window/page 447. A post-cleanup inventory found none of
  those pages; pre-existing browser windows and tabs were untouched.
- No reviewers were dispatched. The working product path, live canaries, and
  repository proof gates were completed first as required.
- Final self-check: on track; on scope; no drift detected. The implementation
  stayed inside the two named phases: local native managed run, existing
  generic login command, contained file-backed storage, and directly affected
  tests only. Tend, automatic selection, migration, remotes, global cleanup,
  new commands, and new frameworks remain out of scope.

## Post-completion deployment on Amirs-M3-Max-2

- Recorded at: 2026-07-23.
- The operator explicitly reopened the remote gate for commit/push, deployment,
  and bounded verification. The implementation was committed as `208c965`,
  fast-forwarded to `main`, and pushed. The remote's prior 37 tracked
  modifications and 17 untracked files were preserved before update in
  `stash@{0}` (`eb3baa520889c87c316fdd5c2d79567423ef7783`,
  `pre-main-deploy-2026-07-23-aimgr`).
- `~/workspace/aimgr` on the M3 Max was switched to pushed `main`; `npm ci` and
  the existing local-wrapper installer completed. The remote full suite passed
  320/320 and lint passed before the live attempt.
- The first live attempt failed closed before credential projection because
  the runner pinned `/usr/bin/sandbox-exec` to Amir-M5's macOS 26.5.2 hash,
  while the M3 Max has Apple's different macOS 26.4 build. Redis remained v3;
  no fence/pending marker appeared; no real `security`/SecurityAgent ran; and
  global Claude and Keychain metadata were unchanged.
- Replaced only that release-specific hash with a stable authority check:
  root-owned and non-writable `/usr/bin/sandbox-exec`, strict Apple
  `codesign --verify`, and exact designated requirement
  `identifier "com.apple.sandbox-exec" and anchor apple`. A regression first
  failed on the old implementation; valid-Apple and invalid-non-Apple cases now
  pass. Local full suite is 322/322 plus lint; remote focused native suite is
  22/22 plus lint. Fix commit: `fdcda05`.
- The deployed official native command then passed twice:
  `aim claude run pro5 -- --safe-mode --strict-mcp-config
  --no-session-persistence --print --output-format json /usage`.
  It returned success with zero model turns, API duration, tokens, and cost.
- Final remote evidence:
  - concurrent monitoring observed no real `/usr/bin/security` or
    `SecurityAgent`;
  - global `~/.claude/.credentials.json`, `~/.claude.json`, and login-Keychain
    metadata were unchanged across the run;
  - Redis `pro5` stayed complete, ready, identity-bound v3 with
    `login-maintenance` provenance;
  - inventory remained complete with `requestCount: 0`;
  - shared fence, local pending marker, disposable projection, and login
    staging were absent after the run;
  - the old pre-A2 file projection was therefore retired safely;
  - the inert isolated pre-A1 Keychain item was not touched, and the unrelated
    stopped Claude process in `~/workspace/secrets` was left alone.
- Honest residual: the fresh provider credential remained unchanged during the
  remote `/usage`, so no provider-issued rotation advance is claimed. The
  cross-machine runtime, identity continuity, cleanup, and no-Keychain
  guarantees are proven; the synthetic official-client fixture remains the
  rotation-publication proof.
- Deployment self-check: on track and on scope. The only added code after the
  completed local plan is the directly encountered macOS-build qualification
  fix and its two focused regressions.
