import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { rebalanceOpenclawPool } from "../../openclaw/rebalance.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleRebalance(context) {
  const {
    opts,
    positional,
    statePath,
    homeDir,
    env,
    stdout,
    setExitCode,
    probeUsageSnapshotsByProviderImpl,
    readOpenclawAgentsListFromConfigImpl,
    rebalanceHermesPoolImpl,
    connectRedisStoreImpl,
  } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing rebalance target. Usage: aim rebalance openclaw | aim rebalance hermes");
  }
  if (system === "openclaw") {
    if (isRedisConfigured({ homeDir })) {
      const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
      try {
        const rebalanced = await rebalanceOpenclawPool({ ...opts, homeDir, env }, runtime.state, {
          probeUsageSnapshotsByProviderImpl,
          readOpenclawAgentsListFromConfigImpl,
        });
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
        if (rebalanced.status === "blocked") {
          setExitCode(1);
        }
        return;
      } finally {
        await closeRedisRuntime(runtime);
      }
    }
    const state = loadAimgrState(statePath);
    const rebalanced = await rebalanceOpenclawPool({ ...opts, homeDir, env }, state, {
      probeUsageSnapshotsByProviderImpl,
      readOpenclawAgentsListFromConfigImpl,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
    if (rebalanced.status === "blocked") {
      setExitCode(1);
    }
    return;
  }
  if (system === "hermes") {
    if (isRedisConfigured({ homeDir })) {
      const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
      try {
        const rebalanced = await rebalanceHermesPoolImpl({ ...opts, homeDir, env }, runtime.state, {
          probeUsageSnapshotsByProviderImpl,
        });
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
        if (rebalanced.status === "blocked") {
          setExitCode(1);
        }
        return;
      } finally {
        await closeRedisRuntime(runtime);
      }
    }
    const state = loadAimgrState(statePath);
    const rebalanced = await rebalanceHermesPoolImpl({ ...opts, homeDir, env }, state, {
      probeUsageSnapshotsByProviderImpl,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
    if (rebalanced.status === "blocked") {
      setExitCode(1);
    }
    return;
  }
  throw new Error(`Unsupported rebalance target: ${system} (supported: openclaw, hermes).`);
}
