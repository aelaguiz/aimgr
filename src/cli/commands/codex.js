import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { watchCodexPoolSelectionLoop, watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { activateCodexLabelSelection, activateCodexPoolSelection } from "../../targets/codex-cli.js";

export async function handleCodex(context) {
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, runCodexTenderImpl, sleepImpl, watchLoopMaxIterations } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex watch | aim codex run --tend");
  }
  if (subcmd === "run") {
    if (!opts.tend) {
      throw new Error("`aim codex run` currently requires --tend.");
    }
    if (String(positional[2] ?? "").trim()) {
      throw new Error("Unexpected positional argument for `aim codex run`. Put Codex arguments after `--`.");
    }
    const tended = await runCodexTenderImpl(
      {
        statePath,
        homeDir,
        env,
        cwd: opts.workdir,
        codexBin: opts.codexBin,
        codexProfile: opts.codexProfile ?? opts.profile,
        codexArgs: opts.afterDoubleDash,
        sessionName: opts.tmuxSession,
        attach: !opts.noAttach,
        thresholdPct: opts.rotateBelow5hRemainingPct,
        pollSeconds: opts.pollSeconds,
        promptTimeoutSeconds: opts.promptTimeoutSeconds,
        maxRestarts: opts.maxRestarts,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
      },
    );
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: !["blocked", "max_restarts_reached"].includes(tended.status), tended }), null, 2)}\n`);
    if (["blocked", "max_restarts_reached"].includes(tended.status)) {
      setExitCode(1);
    }
    return;
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
    throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, watch, run).`);
  }
  const state = loadAimgrState(statePath);
  const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
  const activated = explicitLabel
    ? activateCodexLabelSelection({ state, homeDir, env, label: explicitLabel })
    : await activateCodexPoolSelectionImpl({ state, homeDir, env, probeUsageSnapshotsByProviderImpl });
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
  if (activated.status === "blocked") {
    setExitCode(1);
  }
  return;
}
