import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { watchCodexPoolSelectionLoop, watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activateCodexPoolSelection } from "../../targets/codex-cli.js";

export async function handleCodex(context) {
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, sleepImpl, watchLoopMaxIterations } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex watch");
  }
  if (subcmd === "watch") {
    if (String(positional[2] ?? "").trim()) {
      throw new Error("`aim codex watch <label>` is not supported. Use `aim codex watch` and let AIM decide when to rotate.");
    }
    const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
    if (opts.once) {
      const state = loadAimgrState(statePath);
      const watched = await watchCodexPoolSelectionOnce(
        {
          state,
          homeDir,
          env,
          thresholdPct,
        },
        {
          probeUsageSnapshotsByProviderImpl,
          activateCodexPoolSelectionImpl,
        },
      );
      writeJsonFileWithBackup(statePath, state);
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
      if (watched.status === "blocked") {
        setExitCode(1);
      }
      return;
    }

    await watchCodexPoolSelectionLoop(
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
        activateCodexPoolSelectionImpl,
        emitResultImpl: async (watched) => {
          stdout.write(
            `${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`,
          );
        },
      },
    );
    return;
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, watch).`);
  }
  const state = loadAimgrState(statePath);
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim codex use <label>` was removed. Use `aim codex use` for next-best selection or `aim <label>` if the account needs reauth.");
  }
  const activated = await activateCodexPoolSelectionImpl({ state, homeDir, env, probeUsageSnapshotsByProviderImpl });
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
  if (activated.status === "blocked") {
    setExitCode(1);
  }
  return;
}
