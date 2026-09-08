import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, loadRedisRuntime, publishCodexReconciliation, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { resolveAimgrStateDir } from "../../io/paths.js";
import { activateCodexLabelSelection, reconcileCodexCliAuth } from "../../targets/codex-cli.js";

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

export async function handleCodex(context) {
  const { positional } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex run | aim codex resume | aim codex watch");
  }
  if (subcmd === "watch") {
    await handleRedisCodexWatch(context);
    return;
  }
  if (subcmd === "run" || subcmd === "resume") {
    await handleRedisCodexRun(context);
    return;
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, run, resume, watch).`);
  }
  await handleRedisCodexUse(context);
}
