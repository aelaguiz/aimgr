import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, loadRedisRuntime, publishCodexReconciliation, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { activateCodexLabelSelection, reconcileCodexCliAuth } from "../../targets/codex-cli.js";

async function handleRedisCodexUse(context) {
  const { opts, positional, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const reconciliation = reconcileCodexCliAuth({
      state: runtime.state,
      homeDir,
      env,
      observedAt: new Date().toISOString(),
    });
    await publishCodexReconciliation({ runtime, state: runtime.state, reconciliation });

    const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
    const activated = explicitLabel
      ? activateCodexLabelSelection({ state: runtime.state, homeDir, env, label: explicitLabel })
      : await activateCodexPoolSelectionImpl({
          state: runtime.state,
          homeDir,
          env,
          probeUsageSnapshotsByProviderImpl,
          selectLeastUsed: true,
        });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", reconciliation, activated }), null, 2)}\n`);
    if (activated.status === "blocked") {
      setExitCode(1);
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
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
  const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
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
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex watch");
  }
  if (subcmd === "watch") {
    await handleRedisCodexWatch(context);
    return;
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, watch).`);
  }
  await handleRedisCodexUse(context);
}
