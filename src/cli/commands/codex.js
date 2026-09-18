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
import { assertCompactionPolicy } from "../../targets/codex-thread-copy.js";
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
import { countSpawnedSubagents, isCodexSessionId, readMostRecentThreadIdForCwd } from "../../targets/codex-rollout.js";

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
  if (stdout.isTTY) {
    const { label, previousLabel } = result.activated.receipt;
    stdout.write(`[aim] Codex account: ${label}${previousLabel ? ` (previous: ${previousLabel})` : ""}\n`);
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

const SUBAGENT_ITEM_TYPES = new Set(["CollabAgentToolCall", "SubAgentActivity", "collab_agent_tool_call", "sub_agent_activity"]);

function subagentEvidence({ scan, spawnedChildren }) {
  const evidence = [];
  if (Number(spawnedChildren) > 0) evidence.push(`${spawnedChildren} thread_spawn_edges row(s)`);
  const itemTypes = (scan.agentItemTypes ?? []).filter((type) => SUBAGENT_ITEM_TYPES.has(type));
  if (itemTypes.length > 0) evidence.push(`item types ${itemTypes.join(", ")}`);
  if (Number(scan.subagentSpawnCount) > 0) evidence.push(`${scan.subagentSpawnCount} sub_agent event(s)`);
  return evidence;
}

function resumeFreshPlanSummary({ plan, scan, disk, dropServerBlobs, allowContextLoss, analyticsSummary, profileName }) {
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
    },
    target: { id: plan.newId, path: plan.targetPath },
    scan: {
      ids: scan.ids.length,
      createTimes: scan.createTimes,
      droppedItemLines: scan.droppedItemLines,
      encryptedBlobs: scan.encryptedBlobs,
    },
    scrub: {
      dropServerBlobs,
      allowContextLoss,
      maxCopyMb: plan.maxCopyMb,
    },
    disk,
    analytics: { profile: profileName, disabled: analyticsSummary.disabled },
  };
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
  const keepServerBlobs = Boolean(opts.codexResumeFreshKeepServerBlobs);
  const allowContextLoss = Boolean(opts.codexResumeFreshAllowContextLoss);
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
  const dropServerBlobs = !keepServerBlobs;

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
  const scan = scanThreadRollout({ plan, fsImpl });
  assertCompactionPolicy({ scan, dropServerBlobs, allowContextLoss });
  const spawnedChildren = countSpawnedSubagents({ codexHome, threadId: plan.sourceId, spawnSyncImpl, homeDir, fsImpl });
  const spawnEvidence = subagentEvidence({ scan, spawnedChildren });
  if (spawnEvidence.length > 0) {
    throw new CodexThreadCopyError(
      `Source thread spawned subagents (${spawnEvidence.join("; ")}); refusing to carry a thread whose children still name it`,
      { code: "source_spawned_subagents", details: { spawnEvidence } },
    );
  }
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
      dropServerBlobs,
      allowContextLoss,
      analyticsSummary: { disabled: analyticsDisabledInProfile({ codexHome, profile: profileName, fsImpl }) },
      profileName,
    });
    if (stdout.isTTY) {
      stdout.write(`[aim] dry run: no account rotation, no copy, no launch\n`);
      stdout.write(`[aim] source thread ${plan.sourceId} (${scan.lineCount} lines, ${formatBytes(plan.sourceBytes)}, ${plan.historyMode}${scan.compactedLines > 0 ? `, ${scan.compactedLines} compacted` : ""})\n`);
      stdout.write(`[aim] would create ${plan.newId} at ${plan.targetPath}\n`);
      stdout.write(`[aim] would retire ${scan.ids.length} identifier(s) and ${scan.createTimes} create_time value(s); scrub ${dropServerBlobs ? "on" : "off (--keep-server-blobs)"}\n`);
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
    dropServerBlobs,
    randomBytesImpl,
  });
  const verification = verifyCopiedRollout({ plan, scan, fsImpl, dropServerBlobs });
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
    if (!dropServerBlobs) {
      stdout.write(`[aim] --keep-server-blobs: encrypted reasoning/compaction blobs and their ids stay in the copy; the server can link the two sessions by them\n`);
    }
    if (allowContextLoss && scan.compactedLines > 0) {
      stdout.write(`[aim] --allow-context-loss: the pre-compaction memory was dropped (${scan.compactedLines} compacted record(s))\n`);
    }
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
