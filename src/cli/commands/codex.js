import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import lockfile from "proper-lockfile";
import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, loadRedisRuntime, publishCodexReconciliation, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { resolveAimgrStateDir, resolveManagedCodexHomeDir } from "../../io/paths.js";
import { activateCodexLabelSelection, reconcileCodexCliAuth } from "../../targets/codex-cli.js";
import { resolveBlobPolicy } from "../../targets/codex-thread-copy.js";
import { resolveCodexCommand } from "../../targets/codex-runner.js";
import {
  MAX_COPY_MB_DEFAULT,
  CodexThreadCopyError,
  analyticsDisabledInProfile,
  buildRewriteMap,
  carryThreadGoal,
  copyThreadRollout,
  ensureCodexProfileAnalyticsDisabled,
  planThreadCopy,
  scanThreadRollout,
  verifyCopiedRollout,
} from "../../targets/codex-thread-copy.js";
import { isCodexSessionId, listSpawnedSubagentIds, readMostRecentThreadIdForCwd } from "../../targets/codex-rollout.js";

async function activateCodexForContext(context) {
  const { positional, homeDir, env, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, connectRedisStoreImpl } = context;
  const lockPath = path.join(resolveAimgrStateDir({ homeDir }), "codex-selection.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, "\n", { mode: 0o600 });
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2_000, randomize: true },
    stale: 30_000,
  });
  try {
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      const reconciliation = reconcileCodexCliAuth({
        state: runtime.state,
        homeDir,
        env,
        observedAt: new Date().toISOString(),
      });
      await publishCodexReconciliation({ runtime, state: runtime.state, reconciliation });

      const subcmd = String(positional[1] ?? "").trim().toLowerCase();
      const requestedLabel = String(positional[2] ?? "").trim();
      const explicitLabel = requestedLabel
        && (subcmd === "use" || (subcmd === "run" && requestedLabel.toLowerCase() !== "resume"))
        ? normalizeLabel(requestedLabel)
        : null;
      const activated = explicitLabel
        ? activateCodexLabelSelection({ state: runtime.state, homeDir, env, label: explicitLabel })
        : await activateCodexPoolSelectionImpl({
            state: runtime.state,
            homeDir,
            env,
            probeUsageSnapshotsByProviderImpl,
            avoidCurrentLabel: true,
            selectLeastUsed: true,
          });
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      // The per-label Codex installation id is written inside applyCodexCliFromState, which is
      // the single place that writes auth.json (it covers `use`, `run`, `resume`, watch, and the
      // scheduled routines that call `aim codex use`).
      return { reconciliation, activated };
    } finally {
      await closeRedisRuntime(runtime);
    }
  } finally {
    await release();
  }
}

async function handleRedisCodexUse(context) {
  const { stdout, setExitCode } = context;
  const result = await activateCodexForContext(context);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: result.activated.status !== "blocked", ...result }), null, 2)}\n`);
  if (result.activated.status === "blocked") setExitCode(1);
}

function codexRunArgs({ positional, afterDoubleDash }) {
  const passthrough = Array.isArray(afterDoubleDash) ? afterDoubleDash : [];
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  const requestedResume = subcmd === "resume" || String(positional[2] ?? "").trim().toLowerCase() === "resume";
  if (subcmd === "run" && positional.length > 3 && !requestedResume) {
    throw new Error("`aim codex run` accepts one account label or `resume <id>`. Pass Codex arguments after `--`.");
  }
  if (requestedResume) {
    const sessionId = subcmd === "resume" ? positional[2] : positional[3];
    return ["-p", "yolo", "resume", ...(sessionId ? [String(sessionId)] : []), ...passthrough];
  }
  return passthrough.length > 0 ? passthrough : ["-p", "yolo"];
}

async function handleRedisCodexRun(context) {
  const { stdout, setExitCode, runCodexInteractiveImpl } = context;
  const args = codexRunArgs({
    positional: context.positional,
    afterDoubleDash: context.opts.afterDoubleDash,
  });
  const result = await activateCodexForContext(context);
  if (result.activated.status === "blocked") {
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, ...result }), null, 2)}\n`);
    setExitCode(1);
    return;
  }
  const { label, previousLabel } = result.activated.receipt;
  if (stdout.isTTY) {
    stdout.write(`[aim] Codex account: ${label}${previousLabel ? ` (previous: ${previousLabel})` : ""}\n`);
  }
  const resumedThread = args[2] === "resume" ? args[3] : null;
  if (resumedThread) {
    // Deliberate manual path. Same thread id under a different account links the accounts on
    // the Codex servers; `resume-fresh` is the default that avoids it (CLAUDE.md, rotation rule).
    stdout.write(`[aim] WARNING: thread ${resumedThread} will continue under account ${label}${previousLabel ? ` (was ${previousLabel})` : ""}. `
      + "Codex will send this thread id and session id under the new account, which links the two accounts. "
      + `Use \`aim codex resume-fresh ${resumedThread}\` to avoid that.\n`);
  }
  const launched = await runCodexInteractiveImpl({
    homeDir: context.homeDir,
    cwd: process.cwd(),
    env: context.env,
    args,
  });
  if (launched?.code !== 0) setExitCode(Number.isInteger(launched?.code) ? launched.code : 1);
}

async function runRedisCodexWatchOnce(context, { thresholdPct }) {
  const { homeDir, env, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const reconciliation = reconcileCodexCliAuth({
      state: runtime.state,
      homeDir,
      env,
      observedAt: new Date().toISOString(),
    });
    const watched = await watchCodexPoolSelectionOnce(
      {
        state: runtime.state,
        homeDir,
        env,
        thresholdPct,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
      },
    );
    await publishCodexReconciliation({ runtime, state: runtime.state, reconciliation });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    return { reconciliation, watched };
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleRedisCodexWatch(context) {
  const { opts, positional, stdout, setExitCode, sleepImpl, watchLoopMaxIterations } = context;
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim codex watch <label>` is not supported. Use `aim codex watch` and let AIM decide when to rotate.");
  }
  const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelowWeeklyRemainingPct);
  if (opts.once) {
    const result = await runRedisCodexWatchOnce(context, { thresholdPct });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: result.watched.status !== "blocked", ...result }), null, 2)}\n`);
    if (result.watched.status === "blocked") {
      setExitCode(1);
    }
    return;
  }

  const intervalSeconds = resolveCodexWatchIntervalSeconds(opts.intervalSeconds);
  const maxIterations =
    Number.isFinite(Number(watchLoopMaxIterations)) && Number(watchLoopMaxIterations) > 0
      ? Math.floor(Number(watchLoopMaxIterations))
      : Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const result = await runRedisCodexWatchOnce(context, { thresholdPct });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: result.watched.status !== "blocked", ...result }), null, 2)}\n`);
    if (iteration + 1 >= maxIterations) break;
    await sleepImpl(intervalSeconds * 1000);
  }
}


function resumeFreshPassthrough(context) {
  return Array.isArray(context.opts?.afterDoubleDash) ? context.opts.afterDoubleDash : [];
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "unknown";
  const value = Number(bytes);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function assertCopyDiskSpace({ dir, requiredBytes, fsImpl }) {
  if (typeof fsImpl.statfsSync !== "function") return { checked: false, requiredBytes };
  let stat = null;
  try {
    stat = fsImpl.statfsSync(dir);
  } catch {
    return { checked: false, requiredBytes };
  }
  const freeBytes = Number(stat.bsize) * Number(stat.bavail);
  if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
    throw new CodexThreadCopyError(
      `Not enough free disk space in ${dir}: the copy needs about ${formatBytes(requiredBytes)} and ${formatBytes(freeBytes)} is free`,
      { code: "insufficient_disk", details: { freeBytes, requiredBytes } },
    );
  }
  return { checked: true, freeBytes, requiredBytes };
}

function resumeFreshPlanSummary({ plan, scan, disk, policy, analyticsSummary, profileName }) {
  return {
    ok: true,
    dryRun: true,
    rotated: false,
    source: {
      id: plan.sourceId,
      path: plan.sourcePath,
      bytes: plan.sourceBytes,
      historyMode: plan.historyMode,
      lines: scan.lineCount,
      compactedLines: scan.compactedLines,
      childThreads: scan.childThreadIds.length,
    },
    target: { id: plan.newId, path: plan.targetPath },
    scan: {
      ids: scan.ids.length,
      createTimes: scan.createTimes,
      reasoningItems: scan.reasoningItems,
      compactionItems: scan.compactionItems,
      encryptedBlobs: scan.encryptedBlobs,
    },
    scrub: {
      dropReasoning: policy.dropReasoning,
      dropCompaction: policy.dropCompaction,
      dropServerBlobs: policy.dropReasoning && policy.dropCompaction,
      maxCopyMb: plan.maxCopyMb,
    },
    disk,
    analytics: { profile: profileName, disabled: analyticsSummary.disabled },
  };
}

function describeBlobPolicy({ scan, policy, copy }) {
  const parts = [];
  const reasoning = copy ? copy.droppedReasoning : scan.reasoningItems;
  const compactions = copy ? copy.keptCompactions : scan.compactedLines;
  parts.push(policy.dropReasoning
    ? `${reasoning} reasoning blob(s) dropped (--keep-reasoning keeps them)`
    : `${scan.reasoningItems} reasoning blob(s) kept (--keep-reasoning)`);
  if (scan.compactedLines > 0) {
    parts.push(policy.dropCompaction
      ? `${scan.compactedLines} compaction blob(s) DROPPED: pre-compaction memory is lost (--drop-compaction)`
      : `${compactions} compaction blob(s) kept so the pre-compaction memory survives (--drop-compaction removes them)`);
  }
  return parts.join("; ");
}

async function handleRedisCodexResumeFresh(context) {
  const {
    positional,
    opts,
    stdout,
    setExitCode,
    homeDir,
    env,
    runCodexInteractiveImpl,
    spawnSyncImpl,
    fsImpl = fs,
    randomBytesImpl,
    nowMs = Date.now(),
  } = context;
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  const lastRequested = Boolean(opts.codexResumeFreshLast);
  const dryRun = Boolean(opts.codexResumeFreshDryRun);
  const archiveSource = Boolean(opts.codexResumeFreshArchiveSource);
  const skipGoal = Boolean(opts.codexResumeFreshNoGoal);
  const policy = resolveBlobPolicy({
    keepReasoning: Boolean(opts.codexResumeFreshKeepReasoning),
    dropCompaction: Boolean(opts.codexResumeFreshDropCompaction),
  });
  const maxCopyMb = opts.codexResumeFreshMaxCopyMb;
  const profileName = "yolo";
  const requested = String(positional[2] ?? "").trim();
  if (requested && !isCodexSessionId(requested)) {
    throw new Error(`\`aim codex resume-fresh\` needs a Codex thread id, got: ${requested || "<empty>"}`);
  }
  if (requested && lastRequested) {
    throw new Error("`aim codex resume-fresh` accepts a session id or --last, not both.");
  }
  if (!requested && !lastRequested) {
    throw new Error("Usage: aim codex resume-fresh <session-id> | aim codex resume-fresh --last [-- <codex args...>]");
  }
  const passthrough = resumeFreshPassthrough(context);

  // 1. Resolve and scan the source first: read-only, so --dry-run is side-effect free and a bad
  //    source fails before anything is rotated or written.
  const sourceId = requested || readMostRecentThreadIdForCwd({
    codexHome,
    cwd: process.cwd(),
    spawnSyncImpl,
    homeDir,
    fsImpl,
  });
  if (!sourceId) {
    throw new CodexThreadCopyError(
      "No recent Codex thread found for this working directory; pass an explicit session id",
      { code: "no_recent_thread" },
    );
  }
  const plan = planThreadCopy({
    codexHome,
    sourceId,
    nowMs,
    maxCopyMb: maxCopyMb ?? MAX_COPY_MB_DEFAULT,
    randomBytesImpl,
    spawnSyncImpl,
    homeDir,
    fsImpl,
  });
  // Child thread ids (state DB spawn edges plus every agent_thread_id in the file) are retired
  // with everything else; the children themselves stay under the old account and are never resumed.
  const childIds = listSpawnedSubagentIds({ codexHome, threadId: plan.sourceId, spawnSyncImpl, homeDir, fsImpl });
  const scan = scanThreadRollout({ plan, fsImpl, extraIds: childIds });
  const disk = assertCopyDiskSpace({
    dir: plan.targetDir,
    requiredBytes: plan.sourceBytes * 2 + 64 * 1024 * 1024,
    fsImpl,
  });

  if (dryRun) {
    const summary = resumeFreshPlanSummary({
      plan,
      scan,
      disk,
      policy,
      analyticsSummary: { disabled: analyticsDisabledInProfile({ codexHome, profile: profileName, fsImpl }) },
      profileName,
    });
    if (stdout.isTTY) {
      stdout.write(`[aim] dry run: no account rotation, no copy, no launch\n`);
      stdout.write(`[aim] source thread ${plan.sourceId} (${scan.lineCount} lines, ${formatBytes(plan.sourceBytes)}, ${plan.historyMode}${scan.compactedLines > 0 ? `, ${scan.compactedLines} compacted` : ""})\n`);
      stdout.write(`[aim] would create ${plan.newId} at ${plan.targetPath}\n`);
      stdout.write(`[aim] would retire ${scan.ids.length} identifier(s) (${scan.childThreadIds.length} child thread id(s)) and ${scan.createTimes} create_time value(s)\n`);
      stdout.write(`[aim] blobs: ${describeBlobPolicy({ scan, policy })}\n`);
      stdout.write(`[aim] analytics ${summary.analytics.disabled ? "disabled" : "ENABLED"}; disk free ${formatBytes(disk.freeBytes ?? 0)}\n`);
    } else {
      stdout.write(`${JSON.stringify(sanitizeForStatus(summary), null, 2)}\n`);
    }
    return;
  }

  // 2. Rotate: a blocked pool must not leave a stray thread behind.
  const activation = await activateCodexForContext(context);
  if (activation.activated.status === "blocked") {
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, ...activation }), null, 2)}\n`);
    setExitCode(1);
    return;
  }

  // 3. Make sure the profile Codex will read has analytics disabled.
  const analytics = ensureCodexProfileAnalyticsDisabled({ codexHome, profile: profileName, fsImpl });

  // 4. Copy, then prove the copy carries no retired identifier.
  const map = buildRewriteMap({ scan, newId: plan.newId, nowMs, randomBytesImpl });
  const copy = copyThreadRollout({
    plan,
    scan,
    map,
    nowMs,
    fsImpl,
    policy,
    randomBytesImpl,
    onProgress: stdout.isTTY
      ? ({ bytesSeen, bytesTotal }) => stdout.write(`[aim] copying ${formatBytes(bytesSeen)} of ${formatBytes(bytesTotal)}\n`)
      : undefined,
  });
  const verification = verifyCopiedRollout({ plan, scan, fsImpl, policy });
  if (!verification.ok) {
    try {
      fsImpl.rmSync(plan.targetPath, { force: true });
    } catch {
      // Best effort: the failure below is the real signal.
    }
    throw new CodexThreadCopyError(
      `Residue check failed for the copied thread; nothing was launched (${verification.failures
        .slice(0, 5)
        .map((failure) => `${failure.check}@${failure.path}`)
        .join(", ")})`,
      { code: "residue", details: { failures: verification.failures } },
    );
  }

  // 5. Carry the goal (fresh goal id) so /goal continuity survives the rotation.
  const goal = skipGoal
    ? { carried: false, reason: "disabled" }
    : carryThreadGoal({
        codexHome,
        sourceId: plan.sourceId,
        newId: plan.newId,
        nowMs,
        spawnSyncImpl,
        homeDir,
        randomBytesImpl,
        fsImpl,
      });

  // 6. Launch the new thread on the rotated account.
  const args = ["-p", profileName, "resume", plan.newId, ...passthrough];
  if (stdout.isTTY) {
    const { label, previousLabel } = activation.activated.receipt;
    stdout.write(`[aim] Codex account: ${label}${previousLabel ? ` (previous: ${previousLabel})` : ""}\n`);
    stdout.write(`[aim] new thread ${plan.newId} from ${plan.sourceId} (${copy.lines} lines, ${formatBytes(copy.bytes)}${copy.dropped > 0 ? `, dropped ${copy.dropped}` : ""})\n`);
    stdout.write(`[aim] source thread untouched${goal.carried ? "; goal carried with a fresh goal id" : goal.reason === "no_goal" ? "" : `; goal not carried (${goal.reason})`}\n`);
    if (copy.sourceGrew) {
      stdout.write(`[aim] source was live: copied the snapshot up to ${formatBytes(copy.sourceBytesCopied)} of ${formatBytes(copy.sourceBytesNow)} (later turns are not in the copy)\n`);
    }
    stdout.write(`[aim] blobs: ${describeBlobPolicy({ scan, policy, copy })}\n`);
    if (scan.childThreadIds.length > 0) {
      stdout.write(`[aim] ${scan.childThreadIds.length} child thread id(s) retired; the subagent threads stay under the old account and are not carried\n`);
    }
    stdout.write(`[aim] still shared with the old account by design: repo remote and HEAD, cwd, client version, egress IP, timing, and the transcript text\n`);
    if (verification.blobMentions.length > 0) {
      stdout.write(`[aim] note: ${verification.blobMentions.length} old id(s) kept inside blob-bearing items by design\n`);
    }
    if (verification.contentMentions.length > 0) {
      stdout.write(`[aim] note: the copied transcript still mentions a retired id ${verification.contentMentions.length} time(s) inside conversation content\n`);
    }
    stdout.write(`[aim] analytics ${analytics.changed ? "disabled in the yolo profile" : "already disabled"}\n`);
  }
  const launched = await runCodexInteractiveImpl({
    homeDir,
    cwd: process.cwd(),
    env,
    args,
  });
  if (archiveSource) {
    try {
      const command = resolveCodexCommand({ homeDir, spawnImpl: spawnSyncImpl ?? spawnSync });
      const run = spawnSyncImpl ?? spawnSync;
      const archived = run(command, ["archive", plan.sourceId], { encoding: "utf8" });
      if (archived?.status !== 0 && stdout.isTTY) {
        stdout.write(`[aim] could not archive source thread ${plan.sourceId}\n`);
      }
    } catch {
      if (stdout.isTTY) stdout.write(`[aim] could not archive source thread ${plan.sourceId}\n`);
    }
  }
  if (launched?.code !== 0) setExitCode(Number.isInteger(launched?.code) ? launched.code : 1);
}

export async function handleCodex(context) {
  const { positional } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex run | aim codex resume | aim codex resume-fresh | aim codex watch");
  }
  if (subcmd === "watch") {
    await handleRedisCodexWatch(context);
    return;
  }
  if (subcmd === "run" || subcmd === "resume") {
    await handleRedisCodexRun(context);
    return;
  }
  if (subcmd === "resume-fresh") {
    await handleRedisCodexResumeFresh(context);
    return;
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, run, resume, resume-fresh, watch).`);
  }
  await handleRedisCodexUse(context);
}
