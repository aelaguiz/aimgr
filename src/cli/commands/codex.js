import { resolveCodexWatchThresholdPct } from "../../core/watch-options.js";
import { resolveCodexWatchIntervalSeconds } from "../../core/watch-options.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, publishCodexPreserveResult, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { watchCodexPoolSelectionLoop, watchCodexPoolSelectionOnce } from "../../pool/watch.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { normalizeLabel } from "../../core/normalize.js";
import { activateCodexLabelSelection, activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel } from "../../targets/codex-cli.js";

async function handleRedisCodexUse(context) {
  const { opts, positional, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const preserved = {
      status: "skipped",
      reason: "codex_use_projects_from_redis",
    };

    const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
    const activated = explicitLabel
      ? activateCodexLabelSelection({ state: runtime.state, homeDir, env, label: explicitLabel })
      : await activateCodexPoolSelectionImpl({
          state: runtime.state,
          homeDir,
          env,
          probeUsageSnapshotsByProviderImpl,
        });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", preserved, activated }), null, 2)}\n`);
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
    const preserved = preserveLiveCodexAuthForActiveLabel({
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
    await publishCodexPreserveResult({ runtime, state: runtime.state, preserved });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    return { preserved, watched };
  } finally {
    await closeRedisRuntime(runtime);
  }
}

function createRedisCodexStateRuntime({ homeDir, connectRedisStoreImpl }) {
  return {
    async withReadOnlyState(fn) {
      const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
      try {
        return await fn(runtime.state, { runtime });
      } finally {
        await closeRedisRuntime(runtime);
      }
    },
    async withMutableState(fn) {
      const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
      const stagedCodexPreserves = [];
      try {
        const result = await fn(runtime.state, {
          runtime,
          publishCodexPreserveResult: async (preserved) => {
            if (preserved?.status === "updated" && preserved.label) {
              stagedCodexPreserves.push(preserved);
              return { status: "staged", label: preserved.label };
            }
            return null;
          },
        });
        for (const preserved of stagedCodexPreserves) {
          await publishCodexPreserveResult({ runtime, state: runtime.state, preserved });
        }
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        return result;
      } finally {
        await closeRedisRuntime(runtime);
      }
    },
  };
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
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl, runCodexTenderImpl, sleepImpl, watchLoopMaxIterations, connectRedisStoreImpl } = context;
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
    if (opts.tmuxSession) {
      throw new Error("`--tmux-session` is obsolete for `aim codex run --tend`; Tend now uses an AIMGR-owned PTY supervisor.");
    }
    const tended = await runCodexTenderImpl(
      {
        statePath,
        ...(isRedisConfigured({ homeDir })
          ? { stateRuntime: createRedisCodexStateRuntime({ homeDir, connectRedisStoreImpl }) }
          : {}),
        homeDir,
        env,
        cwd: opts.workdir,
        codexBin: opts.codexBin,
        codexProfile: opts.codexProfile ?? opts.profile,
        resumeSessionId: opts.resumeSessionId,
        codexArgs: opts.afterDoubleDash,
        attach: !opts.noAttach,
        thresholdPct: opts.rotateBelow5hRemainingPct,
        pollSeconds: opts.pollSeconds,
        promptTimeoutSeconds: opts.promptTimeoutSeconds,
        bindTimeoutSeconds: opts.bindTimeoutSeconds,
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
    if (isRedisConfigured({ homeDir })) {
      await handleRedisCodexWatch(context);
      return;
    }
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
  if (isRedisConfigured({ homeDir })) {
    await handleRedisCodexUse(context);
    return;
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
