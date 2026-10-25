---
title: AI Manager resource audit and fix plan
date: 2026-10-25
status: complete
fallback_policy: forbidden
doc_type: phased_refactor
---

# AI Manager's exact-ID resumes no longer read the Claude archive

The performance fixes are installed on this Mac. The clean main release passes
all 600 tests in 74 test files. The earlier live-checkout validation passed
609 tests, including nine tests from pre-existing local work. New AI Manager invocations load the updated source. Existing agent
processes were left running; already-loaded routine monitors and Prime/Pi
extensions adopt their changes on their next start or extension reload.

The main defect was selection in the wrong order: native Claude resume loaded
metadata from every managed transcript before checking the requested ID.
On October 25, this Mac held 7,009 top-level transcripts in 3,421 project
directories across 40 managed Claude homes: 79,530,414,694 bytes, or 79.5 GB.
Each concurrent launcher could repeat that work. One observed launcher grew
from about 2.1 GiB to 4.45 GiB resident while consuming a CPU core. Amir also
reported two launchers reading about 60 GB between 7:04 and 7:06 a.m. Central.

The corrected native ownership lookup for a real session took 31 ms with the
account supplied and read zero transcript bytes. Looking for that ID across
all accounts took 788 ms and also read zero transcript bytes. These measure
session lookup, not Redis connection time or Claude's own startup.

## How AI Manager spends resources

The installed `aim` wrapper runs Node against this repository. CLI commands
load lazily. Account selection reads Redis credential and policy records,
prepares local account files, resolves any requested session, and starts the
agent. Claude's parent process maintains credential ownership and rotation;
a small supervisor manages its terminal and signals. Codex uses a shared local
session store and streams a fresh-ID copy when continuing across accounts.
Prime resolves the selected transcript and its active-branch account/model
metadata, then uses the installed Prime launcher. Scheduled jobs add lifecycle
observers. The managed Prime/Pi extension supplies the session title and footer.

There are consequently several kinds of cost: one-time launch work, required
live ownership, observation repeated while waiting, and the agent runtime's own
work. The audit traced these separately. It does not attribute every process
or this Mac's entire load average to AI Manager.

## Findings and deployed changes

| Cost | Previous behavior | Installed behavior |
|---|---|---|
| Native Claude resume | Read every managed transcript before selecting an ID | Check filenames in the selected account first; search other accounts only if needed |
| Missing Claude UUID | Fall through into a full name search | Return the missing-ID result without reading unrelated transcripts |
| Claude metadata | Allocate the entire transcript, including files approaching 1 GB | Read 256 KiB chunks and retain one JSONL record at a time |
| Claude account switch | Hold source text, parsed records and rewritten output together | Validate and gather identifiers, then stream rewritten records in a second pass |
| Identifier replacement | Retry a greedy pattern at every character in long non-ID text | Match the start of an identifier once and preserve numeric prefixes |
| Claude idle discovery | Spawn two synchronous `ps` commands per live candidate | Take one process-table snapshot for the observation |
| Claude job monitor | Reread and parse the whole event log on each poll | Read newly appended complete records; unchanged polls read zero bytes |
| Prime job monitor | Reread the selected transcript every 250 ms while waiting | Cache the small observation result until file identity, size or timestamps change |
| Prime/Pi footer | Scan history and rebuild an unchanged display every second | Check the current leaf and replay the cached display when unchanged |
| Project consent | Read account configs after both approvals were already known | Stop as soon as both existing positive approvals are found |

Claude companion text files also stream record by record, preserving arbitrary
bytes and line endings. Account switching still generates fresh identifiers,
removes account-bound thinking, preserves tool references, detects ambiguous
ownership and validates source-file stability. Corrupt histories fail and
partial staged output is cleaned up. Stream memory still includes the largest
individual record and the identifier map; it is not a fixed memory ceiling.

The Prime observer keeps only the result of the current observation. It
invalidates on replacement and truncation and retries failed reads. It still
parses a changed transcript to follow its actual branch. The Prime transcript
reader now streams source records rather than allocating an additional
whole-file string. The parsed branch history remains in memory during a read.

The footer still sends its display to newly attached clients. The optimization
uses the host's constant-time leaf ID, which changes on messages, renames,
recaps and persisted credential bindings. Hosts without that API retain the
existing refresh behavior. Copies in both local managed extension directories
were updated without restarting workers.

## Measurements

All measurements were made on October 25 on this Mac. Transcript byte counts
are application reads, which may be served from the OS cache; they are not
claims about physical disk traffic.

| Operation | Input | Result |
|---|---|---|
| Native ownership lookup, known account | Real session in `pro27` | 31 ms, 0 transcript bytes, 59 MiB process peak RSS |
| Native ownership lookup, all accounts | Same real session | 788 ms, 0 transcript bytes, 70 MiB peak RSS |
| Managed metadata lookup | Same selected session | 1,116 ms, 106.4 MB read, 164 MiB peak RSS |
| Old account-switch rekey | Synthetic 33.6 MB JSONL, 256 records | 2,747 ms, 318 MiB peak RSS |
| Streaming account-switch rekey | Same synthetic input in a fresh process | 1,570 ms, 81 MiB peak RSS |
| Existing shared-memory discovery | Real managed homes, read-only instrumentation | 507 ms, 167 directory reads, 3,424 `lstat` calls, 0 content bytes |

The copy benchmark reduces peak process memory by 237 MiB, about 75%, and
elapsed time by 1.18 seconds, about 43%. It is one controlled synthetic
comparison, not a prediction for every transcript. The old 79.5 GB archive
scan was established from the code and file inventory; it was not replayed
for a benchmark on the shared machine.

A later process snapshot found 45 Claude supervisors using 934.5 MiB total
and 33 Claude launcher parents using 2,039.8 MiB total, all reporting 0% CPU at
that instant. This is evidence that idle wrappers have a standing memory cost,
not a before/after measurement. Removing those processes would require moving
credential ownership and terminal lifecycle responsibilities elsewhere. This
change does not introduce a new central daemon to do that.

## Costs retained and the next optimization threshold

1. **Global title search still inspects session metadata.** Exact UUIDs and
   native ownership checks now take the cheap path. A search by an arbitrary
   title may still visit all transcripts, although reads stream. Recent-session
   listing already limits candidate parsing. If title searches remain a real
   load source, the next change is a stat-validated metadata cache populated
   during selected-session reads, followed by an explicitly bounded initial
   index. Do not put an unbounded archive rebuild back into resume.
2. **Old account-specific memories still need discovery.** The measured
   half-second walk found no pending memory content and read no transcript
   bodies. Older running Claude builds can still write memories into account
   homes, so removing the sweep could hide those memories. If this becomes a
   measured bottleneck, coalesce concurrent discovery under the existing lock
   before considering a cache or a longer migration interval.
3. **Prime reads changed branch history.** Unchanged polling now does no
   transcript I/O. If long active Prime sessions remain expensive, build a
   branch-aware append observer that invalidates on rewrites. A tail-only read
   would be incorrect after branching. That larger change belongs with evidence
   of cost in the Prime workload, not in the Claude emergency fix.

These are explicit remaining costs, not claims that all runtime work has been
eliminated. The deployed plan removes the confirmed multiplicative work from
exact-ID resumes and unchanged polling without adding persistent services.

## Other paths checked

| Area | Audit conclusion |
|---|---|
| CLI initialization | Command handlers already load lazily |
| Claude preparation | Prepared launch state already passes to the runner; no second full preflight was added |
| Redis | Credential snapshots use batched reads; lease renewal and rotation checks remain because they protect ownership |
| Status | Provider-specific indexes, cached observations and coordinated refreshes already bound repeated provider work |
| Codex resume | SQLite/filename discovery and a bounded header read already select the rollout |
| Codex account switching | Chunked scan/copy/verification already exists; its extra passes protect fresh-thread identifier rules |
| Prime resolution | Exact path/ID selection precedes reading that transcript; no Claude-style all-transcript body scan |
| Prime launch | PATH resolution delegates execution to the installed launcher |
| Grok | Status/inventory commands read credential metadata and usage; no transcript traversal |
| Hermes | Watch loops sleep between observations and close Redis connections |
| MCP execution | Commands use bounded subprocess execution; this audit did not identify an archive-reading polling loop there |
| Recovery/status hooks | Small local state checks and bounded transcript-tail fallback; no full archive reads |

The historical September Prime daemon audit remains separate. This work did
not restart a supervisor, reclaim a live lock or restore any user session.

## Implementation plan and completion

1. **Select before reading. Complete and deployed first.** Filter exact IDs
   and accounts before transcript reads; cover known IDs, absent IDs, native
   resume arguments and cross-account ownership.
2. **Stream selected history. Complete and deployed next.** Replace full-file
   metadata and fork staging with one shared line reader; preserve validation,
   fresh IDs, companion bytes and cleanup. Fix the quadratic identifier pattern.
3. **Stop repeat observation work. Complete and deployed incrementally.** Use
   one process snapshot, incremental Claude events, stat-validated Prime
   observations, cached idle footer output and early consent completion.
4. **Verify and install. Complete.** Run focused regressions, one final complete
   passing suite with two test workers, syntax checks, controlled benchmarks,
   installed-path checks and deployment hashes. Preserve unrelated live edits.

## Verification and the test-isolation incident

The final suite passes **609/609 tests in 75 files**, with no failures or skips,
in 16.9 seconds using two test workers. `npm run lint`, checks of the final
Prime/footer edits, and `git diff --check` pass. Regressions assert zero unrelated
transcript opens for exact/missing IDs, zero transcript reads for native
ownership, valid fresh-ID forks, preserved binary companion bytes, malformed
history rejection, source-integrity cleanup, one `ps` call, incremental event
reads, Prime cache invalidation and manual footer renames.

The first full run exposed an existing test-helper leak: CLI tests inherited
this Codex session's real `CODEX_HOME`, wrote synthetic credentials to the
local managed auth file and failed to find them in their temporary homes.
The live selected account was restored from Redis under the selection lock,
with its original account identity verified. Redis credentials were not
replaced. The test helper now clears inherited agent-directory overrides;
tests that need an override supply it explicitly. A regression protects an
outside auth file, and the real auth file's digest was unchanged across the
final suite. The help assertion now matches the existing Redis migration, and the Pi
fixture now supplies its intended environment override explicitly.

## Deployment, review and rollback

The installed wrapper points to
`/Users/aelaguiz/workspace/aimgr/bin/aimgr.js`. Verified source is installed in
that checkout; both managed Prime/Pi extension copies match the new source.
Running processes keep their loaded modules until their normal next start or
reload. No existing agent session was terminated or resumed by this work.

The live checkout contained unrelated unfinished work. The isolated worktree
at `/Users/aelaguiz/workspace/aimgr/.tmp/performance-20261025` preserves the exact
starting state in local baseline commit `7d68a47`. Each deployed destination
was hash-checked against that baseline or this task's preceding deployment
before atomic replacement. Backups are in that worktree's `.deployment-backup`
and the deployed-file hashes are in `.deployed-sha256.json`. Do not publish the
baseline or use a whole-checkout reset: it contains other work. Restore only a
task file whose live hash still matches this deployment if rollback is needed.

Test logs and synthetic benchmark results are retained with the audit evidence
in the isolated worktree. The benchmark copied no user conversation content.

<!-- project_flow:block:implementation_audit:start -->
## Implementation audit

Date: 2026-10-25. Code verdict: COMPLETE for the deployed plan. Runtime lookup
and installation checks: complete. Existing sessions were not relaunched.

The final call-site audit confirms both native and managed exact-ID routes
filter before opening bodies; routine loops use their new readers; fork staging
uses the streaming rekey function; the old pure string rekey helper remains
only as a compatibility/testing API. Global title-search callers remain
explicit and are recorded in the remaining-cost section. No new daemon,
background indexer or parallel credential writer was introduced.

No code blockers remain for this deployment. The three remaining optimization
conditions are recorded above with their correctness constraints.
<!-- project_flow:block:implementation_audit:end -->

## Main release and fleet rollout

The release is based directly on `3239219`, the current upstream main commit,
with only this task's performance changes applied. The earlier baseline snapshot
`7d68a47` is not published. Existing Redis migration and session-recovery edits
remain local and must survive deployment. The Redis-specific help-test change
is excluded from this release because its corresponding migration is not in
main. The clean release passes 600 tests with two workers in 15.5 seconds.

The [fleet inventory](FLEET.md) consists of the M5, home server, Mac Studio,
M3 Max and M3 36 GB. All five are updated and verified. Amir retired the old
M1 on October 25; it is not an outstanding rollout target. Deployment updates AI Manager source and installed
wrappers/extensions, preserves existing local changes, and leaves running
agent processes intact. Per-host completion is verified from the installed
command and source hashes.
