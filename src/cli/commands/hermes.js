import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { watchHermesPoolSelectionLoop, watchHermesPoolSelectionOnce } from "../../pool/watch.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

async function runRedisHermesWatchOnce(context, { thresholdPct }) {
  const { homeDir, env, probeUsageSnapshotsByProviderImpl, rebalanceHermesPoolImpl, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const watched = await watchHermesPoolSelectionOnce(
      {
        state: runtime.state,
        homeDir,
        env,
        thresholdPct,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        rebalanceHermesPoolImpl,
      },
    );
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    return watched;
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleRedisHermesWatch(context) {
  const { opts, positional, stdout, setExitCode, sleepImpl, watchLoopMaxIterations } = context;
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim hermes watch <label>` is not supported. Use `aim hermes watch` and let AIM decide when to rebalance.");
  }
  const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
  if (opts.once) {
    const watched = await runRedisHermesWatchOnce(context, { thresholdPct });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
    if (watched.status === "blocked") {
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
    const watched = await runRedisHermesWatchOnce(context, { thresholdPct });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
    if (iteration + 1 >= maxIterations) break;
    await sleepImpl(intervalSeconds * 1000);
  }
}

export async function handleHermes(context) {
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, rebalanceHermesPoolImpl, sleepImpl, watchLoopMaxIterations } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing hermes subcommand. Usage: aim hermes watch");
  }
  if (subcmd !== "watch") {
    throw new Error(`Unsupported hermes subcommand: ${subcmd} (supported: watch).`);
  }
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim hermes watch <label>` is not supported. Use `aim hermes watch` and let AIM decide when to rebalance.");
  }
  if (isRedisConfigured({ homeDir })) {
    await handleRedisHermesWatch(context);
    return;
  }
  const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
  if (opts.once) {
    const state = loadAimgrState(statePath);
    const watched = await watchHermesPoolSelectionOnce(
      {
        state,
        homeDir,
        env,
        thresholdPct,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        rebalanceHermesPoolImpl,
      },
    );
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
    if (watched.status === "blocked") {
      setExitCode(1);
    }
    return;
  }

  await watchHermesPoolSelectionLoop(
    {
      statePath,
      homeDir,
      env,
      intervalSeconds: opts.intervalSeconds,
      thresholdPct,
      maxIterations: watchLoopMaxIterations,
    },
    {
      sleepImpl,
      probeUsageSnapshotsByProviderImpl,
      rebalanceHermesPoolImpl,
      emitResultImpl: async (watched) => {
        stdout.write(
          `${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`,
        );
      },
    },
  );
  return;
}
