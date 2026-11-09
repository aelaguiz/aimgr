import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import lockfile from "proper-lockfile";
import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { resolveAimgrStateDir } from "../../io/paths.js";
import { activateCodexLabelSelection } from "../../targets/codex-cli.js";
import { accountNoteFor, formatAccountNote } from "../../status/account-notes.js";
import { resolveBlobPolicy } from "../../targets/codex-thread-copy.js";
import { loadCodexRuntime } from "../../coordination/codex-runtime.js";
import { ensureCodexAccountMetadata } from "../../coordination/codex-metadata.js";
import { loginCodexManually } from "../../credentials/codex-manual-login.js";
import { saveLocalCodexLogin, logoutLocalCodexCredential } from "../../credentials/codex-local.js";
import { createManualCallbackStdioProtocol, readNonEmptyLineFromStdin, parseManualCallbackStdioInput, writeJsonLine } from "../manual-callback-stdio.js";
import { OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { readCodexEnvironment } from "../../privacy/codex-environment.js";
import { codexArguments } from "../../privacy/codex-arguments.js";
import { codexSharedHome } from "../../privacy/codex-account-state.js";
import { maintainCodexMcp } from "../../credentials/codex-mcp-maintenance.js";
import { assertCodexMaintenanceClear } from "../../privacy/codex-maintenance.js";
import { inspectCodexPrivacyStatus, formatCodexPrivacyStatus } from "../../privacy/codex-status.js";
import {
  MAX_COPY_MB_DEFAULT,
  CodexThreadCopyError,
  buildRewriteMap,
  carryThreadGoal,
  copyThreadRollout,
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
    const runtime = await loadCodexRuntime({ ...context, maintain: true });
    try {
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
      const label = activated.receipt?.label;
      const accountNote = label ? accountNoteFor(runtime.accountNotes, OPENAI_CODEX_PROVIDER, label) : null;
      return { activated, accountNote, accountNotesAvailable: runtime.accountNotes !== null };
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

// Keep the selected account's prepared home through launch and handoff.
function codexLaunchEnv(context, prepared) {
  if (!prepared?.codexHome) throw new Error("Codex launch has no prepared account home.");
  return {
    ...(context.env ?? {}),
    CODEX_HOME: prepared.codexHome,
  };
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
  const noteOutput = args.includes("--json") ? context.stderr : stdout;
  if (result.accountNote) noteOutput.write(`[aim] ${formatAccountNote({ provider: OPENAI_CODEX_PROVIDER, label, note: result.accountNote })}\n`);
  else if (!result.accountNotesAvailable) noteOutput.write("[aim] Account notes unavailable.\n");
  if (stdout.isTTY) {
    stdout.write(`[aim] Codex account: ${label}${previousLabel ? ` (previous: ${previousLabel})` : ""}\n`);
  }
  const parsed = codexArguments(args);
  const resuming = parsed.command === "resume" || (["exec", "e"].includes(parsed.command) && parsed.execSubcommand === "resume");
  const resumedThread = parsed.positionals[parsed.command === "resume" ? 0 : 1];
  if (resuming && !parsed.inspection) {
    // Deliberate manual path. Same thread id under a different account links the accounts on
    // the Codex servers; `resume-fresh` is the default that avoids it (CLAUDE.md, rotation rule).
    stdout.write(`[aim] WARNING: ${resumedThread ? `thread ${resumedThread}` : "the selected thread"} will continue under account ${label}${previousLabel ? ` (was ${previousLabel})` : ""}. `
      + "Codex will send this thread id and session id under the new account, which links the two accounts. "
      + `Use \`aim codex resume-fresh ${resumedThread ?? "<thread-id>"}\` to avoid that.\n`);
  }
  const launched = await runCodexInteractiveImpl({
    homeDir: context.homeDir,
    cwd: process.cwd(),
    env: codexLaunchEnv(context, result.activated.prepared),
    prepared: result.activated.prepared,
    args,
  });
  if (launched?.code !== 0) setExitCode(Number.isInteger(launched?.code) ? launched.code : 1);
}

async function runRedisCodexWatchOnce(context, { thresholdPct }) {
  const { homeDir, env, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, connectRedisStoreImpl } = context;
  const runtime = await loadCodexRuntime({ ...context, maintain: true });
  try {
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
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    return { watched };
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

function resumeFreshPlanSummary({ plan, scan, disk, policy, profileName }) {
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
  const codexHome = codexSharedHome({ homeDir, env, environment: (context.readCodexEnvironmentImpl ?? readCodexEnvironment)() });
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
      profileName,
    });
    if (stdout.isTTY) {
      stdout.write(`[aim] dry run: no account rotation, no copy, no launch\n`);
      stdout.write(`[aim] source thread ${plan.sourceId} (${scan.lineCount} lines, ${formatBytes(plan.sourceBytes)}, ${plan.historyMode}${scan.compactedLines > 0 ? `, ${scan.compactedLines} compacted` : ""})\n`);
      stdout.write(`[aim] would create ${plan.newId} at ${plan.targetPath}\n`);
      stdout.write(`[aim] would retire ${scan.ids.length} identifier(s) (${scan.childThreadIds.length} child thread id(s)) and ${scan.createTimes} create_time value(s)\n`);
      stdout.write(`[aim] blobs: ${describeBlobPolicy({ scan, policy })}\n`);
      stdout.write(`[aim] disk free ${formatBytes(disk.freeBytes ?? 0)}\n`);
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

  // Native launch admission enforces administrator-owned privacy settings.
  // Copy, then prove the copy carries no retired identifier.
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
  const { label, previousLabel } = activation.activated.receipt;
  const noteOutput = args.includes("--json") ? context.stderr : stdout;
  if (activation.accountNote) noteOutput.write(`[aim] ${formatAccountNote({ provider: OPENAI_CODEX_PROVIDER, label, note: activation.accountNote })}\n`);
  else if (!activation.accountNotesAvailable) noteOutput.write("[aim] Account notes unavailable.\n");
  if (stdout.isTTY) {
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
  }
  // An AIM invocation started from another Codex inherits that thread's ID.
  // This is a new thread on a rotated account; do not carry the old identity
  // into Codex or into Herdr's session-start hook.
  const freshLaunchEnv = codexLaunchEnv(context, activation.activated.prepared);
  delete freshLaunchEnv.CODEX_THREAD_ID;
  const launched = await runCodexInteractiveImpl({
    homeDir,
    cwd: process.cwd(),
    env: freshLaunchEnv,
    prepared: activation.activated.prepared,
    args,
  });
  if (archiveSource) {
    try {
      const archived = await runCodexInteractiveImpl({ homeDir, cwd: process.cwd(),
        env: freshLaunchEnv, prepared: activation.activated.prepared, args: ["archive", plan.sourceId] });
      if (archived?.code !== 0 && stdout.isTTY) {
        stdout.write(`[aim] could not archive source thread ${plan.sourceId}\n`);
      }
    } catch {
      if (stdout.isTTY) stdout.write(`[aim] could not archive source thread ${plan.sourceId}\n`);
    }
  }
  if (launched?.code !== 0) setExitCode(Number.isInteger(launched?.code) ? launched.code : 1);
}

async function handleCodexLocalLogin(context) {
  const label = normalizeLabel(context.positional[2]);
  let runtime = await loadCodexRuntime(context);
  try {
    const existing = runtime.snapshot.credentials.find(record => record.label === label);
    const environment = runtime.environment;
    // Browser authorization can take minutes; the bounded Redis connection
    // must not idle through it or its expired socket will discard a good login.
    await closeRedisRuntime(runtime);
    runtime = null;
    const handoff = context.opts.manualCallbackStdio
      ? createManualCallbackStdioProtocol({ stdin: context.stdin, stdout: context.stdout, label, provider: OPENAI_CODEX_PROVIDER })
      : { emitAuthUrl: ({ url }) => context.stdout.write(`Open this URL in the account's existing browser, then paste the full callback URL here:\n${url}\n`),
          readCallbackUrl: async options => parseManualCallbackStdioInput(await readNonEmptyLineFromStdin(context.stdin, options)) };
    const credential = await loginCodexManually({ ...handoff,
      expectedAccountId: existing?.identity?.accountId,
      fetchJsonWithTimeoutImpl: context.fetchJsonWithTimeoutImpl, signal: context.signal });
    runtime = await loadCodexRuntime(context);
    if (runtime.environment.binding !== environment.binding) throw new Error("The local Codex environment changed during login. Sign in again on this machine.");
    await ensureCodexAccountMetadata(runtime.store, { label, accountId: credential.accountId });
    saveLocalCodexLogin({ homeDir: context.homeDir, env: context.env, environment: runtime.environment, label, accountId: credential.accountId }, credential);
    const result = { type: "result", ok: true, label, provider: OPENAI_CODEX_PROVIDER, authority: "environment-local" };
    if (context.opts.manualCallbackStdio || context.opts.json) writeJsonLine(context.stdout, result);
    else context.stdout.write(`Codex ${label} is signed in on this machine.\n`);
  } catch (error) {
    if (!context.opts.manualCallbackStdio) throw error;
    writeJsonLine(context.stdout, { type: "error", ok: false, label, error: error.message });
    context.setExitCode(1);
  } finally { await closeRedisRuntime(runtime); }
}

async function handleCodexLocalLogout(context) {
  const label = normalizeLabel(context.positional[2]);
  const runtime = await loadCodexRuntime(context);
  try {
    const record = runtime.snapshot.credentials.find(item => item.label === label);
    if (!record?.identity?.accountId) throw new Error(`Unknown Codex label: ${label}.`);
    const result = logoutLocalCodexCredential({ homeDir: context.homeDir, env: context.env, environment: runtime.environment, accountId: record.identity.accountId });
    if (!result.committed) throw new Error("Codex login changed while signing out. Retry the command.");
    context.stdout.write(`Codex ${label} is signed out on this machine.\n`);
  } finally { await closeRedisRuntime(runtime); }
}

export async function handleCodex(context) {
  const { positional } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (subcmd === "privacy") {
    if (positional[2] !== "status" || positional.length !== 3) throw new Error("Usage: aim codex privacy status [--json]");
    const status = inspectCodexPrivacyStatus({ pinnedArtifactSet: context.env.AIMGR_CODEX_ARTIFACT_SET });
    context.stdout.write(context.opts.json ? JSON.stringify(status, null, 2) + "\n" : formatCodexPrivacyStatus(status));
    if (!status.ready) context.setExitCode(1);
    return;
  }
  if (subcmd === "mcp-migrate" || subcmd === "mcp-recover") {
    if (positional.length !== 2) throw new Error("Use aim codex mcp-migrate or aim codex mcp-recover in the selected CODEX_HOME environment.");
    context.stdout.write("MCP maintenance requires existing Codex sessions to finish first and blocks new AIM Codex launches during conversion.\n");
    if (process.platform === "darwin") context.stdout.write("macOS may ask to let Codex read imported MCP credentials. Choose Always Allow so future sessions and schedules can read them unattended. AIM does not receive your Keychain password.\n");
    await maintainCodexMcp({ operation: subcmd === "mcp-migrate" ? "start" : "recover", homeDir: context.homeDir, env: context.env });
    context.stdout.write("MCP credentials use the shared native keyring. AIM Codex launches are available again.\n");
    return;
  }
  if (!subcmd) {
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex run | aim codex resume | aim codex resume-fresh | aim codex watch");
  }
  if (subcmd === "login") return handleCodexLocalLogin(context);
  if (subcmd === "logout") return handleCodexLocalLogout(context);
  assertCodexMaintenanceClear();
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
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: login, logout, use, run, resume, resume-fresh, watch).`);
  }
  await handleRedisCodexUse(context);
}
