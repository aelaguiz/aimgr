import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { watchHermesPoolSelectionLoop, watchHermesPoolSelectionOnce } from "../../pool/watch.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

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
